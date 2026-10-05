import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MEMBERSHIP_DATABASE_APPLICATION_ID, assertDirectoryAncestors, privateStoragePath } from '../server/production-config.mjs';
import { USAGE_BUDGET_FIELDS, usageBudgetConfig } from '../shared/usage-budget-config.mjs';
import { operationsHealth } from './operations-health.mjs';
import { operationsAlert } from './operations-alert.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const maximum = Number.MAX_SAFE_INTEGER;
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const healthProblems = new Set(['API_ORIGIN_CONFIGURATION', 'API_HEALTH_UNAVAILABLE', 'PRODUCTION_METERING_OR_DEMO', 'LOGIN_PROVIDER_NOT_CONFIGURED',
  'PRIVATE_DATABASE_METADATA_UNAVAILABLE', 'BACKUP_MISSING', 'BACKUP_STALE', 'BACKUP_DIRECTORY_UNAVAILABLE', 'DISK_SPACE_LOW', 'DISK_METADATA_UNAVAILABLE']);
const healthWarnings = new Set(['PAYMENT_CREATION_DISABLED', 'BACKUP_CLOCK_SKEW']);
const alertStatuses = new Set(['delivered', 'deduplicated', 'pending', 'unconfigured']);
const alertReasons = new Set(['NOT_CONFIGURED', 'CONFIGURATION_REJECTED', 'NO_PENDING_NOTIFICATION', 'RETRY_NOT_DUE', 'DELIVERY_FAILED', 'PENDING_BATCH_REMAINS', 'RECEIPT_RECORDED']);
const monitorErrorCodes = new Set(['BUDGET_CONFIGURATION_UNAVAILABLE', 'BUDGET_DATABASE_UNAVAILABLE', 'MONITOR_CONFIGURATION_UNAVAILABLE']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestampValid = value => integer(value) && value <= 8_640_000_000_000_000;
const selected = (env, fields) => Object.fromEntries(fields.map(key => [key, env[key]]));

export class OperationsMonitorError extends Error {
  constructor(code) { super('Better Life 巡检未完成。'); this.name = 'OperationsMonitorError'; this.code = monitorErrorCodes.has(code) ? code : 'MONITOR_CONFIGURATION_UNAVAILABLE'; }
}
const fail = code => { throw new OperationsMonitorError(code); };

function privateMetadata(path, { projectRoot, allowTemporary }) {
  if (!privateStoragePath(path, { projectRoot, allowTemporary }) || !/\.(?:sqlite|db)$/.test(path)
    || /(?:^|[/\\])(?:www|releases?|better-life-(?:current|releases))(?:[/\\]|$)/i.test(path)) fail('BUDGET_DATABASE_UNAVAILABLE');
  try {
    const directory = dirname(path); assertDirectoryAncestors(directory);
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && (parent.mode & 0o077 || parent.uid !== process.getuid())) throw new Error();
    const check = (filename, optional = false) => {
      let info;
      try { info = lstatSync(filename); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !integer(info.size) || !optional && !info.size
        || process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid())) throw new Error();
      return info;
    };
    const info = check(path); check(`${path}-wal`, true); check(`${path}-shm`, true); return info;
  } catch { fail('BUDGET_DATABASE_UNAVAILABLE'); }
}

// One atomic SELECT: no IDs, account fields, private bodies, expiry recovery or
// billing writes. Expired reserved/dispatched rows remain conservatively counted.
const budgetSql = `SELECT
  COALESCE(SUM(CASE WHEN day_key=? AND state IN('reserved','dispatched') THEN reserved_micro ELSE 0 END),0) AS day_reserved,
  COALESCE(SUM(CASE WHEN day_key=? THEN charged_micro ELSE 0 END),0) AS day_charged,
  COALESCE(SUM(CASE WHEN month_key=? AND state IN('reserved','dispatched') THEN reserved_micro ELSE 0 END),0) AS month_reserved,
  COALESCE(SUM(CASE WHEN month_key=? THEN charged_micro ELSE 0 END),0) AS month_charged,
  COALESCE(SUM(CASE WHEN typeof(reserved_micro)<>'integer' OR reserved_micro<0 OR reserved_micro>${maximum}
    OR typeof(charged_micro)<>'integer' OR charged_micro<0 OR charged_micro>${maximum}
    OR typeof(state)<>'text' OR state NOT IN('reserved','dispatched','settled','conservative','released')
    OR typeof(day_key)<>'text' OR day_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR typeof(month_key)<>'text' OR month_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    OR substr(day_key,1,7)<>month_key OR day_key<(month_key||'-01')
    OR day_key>date(month_key||'-01','+1 month','-1 day') THEN 1 ELSE 0 END),0) AS invalid_rows
  FROM usage_budget_requests WHERE month_key=? OR day_key=?`;
const periodState = (reserved, charged, limit) => {
  if (!integer(reserved) || !integer(charged) || !integer(reserved + charged)) fail('BUDGET_DATABASE_UNAVAILABLE');
  const committed = BigInt(reserved + charged);
  return committed >= BigInt(limit) ? 'blocked' : committed * 5n >= BigInt(limit) * 4n ? 'warning' : 'normal';
};

export function readOperationsBudget({ env = {}, now = Date.now, db: suppliedDb,
  openDatabase = (filename, options) => new DatabaseSync(filename, options), projectRoot = project, allowTemporary = false } = {}) {
  let config;
  try { config = usageBudgetConfig(selected(env, USAGE_BUDGET_FIELDS)); }
  catch { fail('BUDGET_CONFIGURATION_UNAVAILABLE'); }
  if (!config.configured) fail('BUDGET_CONFIGURATION_UNAVAILABLE');
  const timestamp = now(); if (!timestampValid(timestamp)) fail('MONITOR_CONFIGURATION_UNAVAILABLE');
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  const dayKey = `${parts.year}-${parts.month}-${parts.day}`, monthKey = `${parts.year}-${parts.month}`;
  const before = privateMetadata(env.MEMBERSHIP_DB_PATH, { projectRoot, allowTemporary });
  let db;
  try {
    db = suppliedDb || openDatabase(env.MEMBERSHIP_DB_PATH, { readOnly: true });
    const after = privateMetadata(env.MEMBERSHIP_DB_PATH, { projectRoot, allowTemporary });
    if (before.dev !== after.dev || before.ino !== after.ino) fail('BUDGET_DATABASE_UNAVAILABLE');
    if (db.prepare('PRAGMA application_id').get().application_id !== MEMBERSHIP_DATABASE_APPLICATION_ID) fail('BUDGET_DATABASE_UNAVAILABLE');
    const row = db.prepare(budgetSql).get(dayKey, dayKey, monthKey, monthKey, monthKey, dayKey);
    if (!row || !integer(row.invalid_rows) || row.invalid_rows !== 0) fail('BUDGET_DATABASE_UNAVAILABLE');
    const day = periodState(row.day_reserved, row.day_charged, config.dailyLimit);
    const month = periodState(row.month_reserved, row.month_charged, config.monthlyLimit);
    return { configured: true, readOnly: true, timezone: 'Asia/Shanghai', currency: 'CNY',
      day, month, state: [day, month].includes('blocked') ? 'blocked' : [day, month].includes('warning') ? 'warning' : 'normal',
      accounting: 'configured-rate-estimate-not-provider-invoice' };
  } catch { fail('BUDGET_DATABASE_UNAVAILABLE'); }
  finally { if (db && !suppliedDb) { try { db.close(); } catch {} } }
}

function sanitizedHealth(value) {
  if (!value || !['healthy', 'degraded', 'unavailable'].includes(value.status) || !Array.isArray(value.problems) || !Array.isArray(value.warnings)
    || value.problems.some(code => !healthProblems.has(code)) || value.warnings.some(code => !healthWarnings.has(code))) throw new Error();
  if (value.status === 'healthy' && (value.problems.length || value.warnings.length) || value.status === 'degraded' && value.problems.length) throw new Error();
  return { status: value.status, problems: [...new Set(value.problems)], warnings: [...new Set(value.warnings)] };
}

function sanitizedAlert(value, event, scope) {
  if (!value || !alertStatuses.has(value.status) || !alertReasons.has(value.reason) || typeof value.configured !== 'boolean' || typeof value.sent !== 'boolean'
    || !integer(value.pending) || ![0, 1, 2].includes(value.exitCode) || value.event !== event || value.scope !== scope) throw new Error();
  if (['delivered', 'deduplicated'].includes(value.status) && (!value.configured || value.pending || value.exitCode !== 0)
    || value.status === 'delivered' && !value.sent || value.status === 'pending' && (!value.pending || value.exitCode === 0)
    || !value.configured && (value.sent || value.exitCode !== 2)) throw new Error();
  return { event, scope, status: value.status, reason: value.reason, configured: value.configured, sent: value.sent, pending: value.pending > 0, exitCode: value.exitCode };
}

export async function operationsMonitor({ env = {}, now = Date.now, projectRoot = project, allowTemporary = false,
  healthImpl = operationsHealth, alertImpl = operationsAlert, healthOptions = {}, alertOptions = {}, db, openDatabase } = {}) {
  const problems = [], warnings = [], notifications = [];
  let health = { status: 'unavailable', problems: ['HEALTH_CHECK_FAILED'], warnings: [] }, budget = { state: 'unavailable', readOnly: true };
  if (typeof healthImpl !== 'function' || typeof alertImpl !== 'function' || typeof now !== 'function') {
    return { application: 'better-life', version: 1, status: 'unavailable', health: 'unavailable', budget: 'unavailable', budgetReadOnly: true,
      codes: ['MONITOR_CONFIGURATION_UNAVAILABLE'], notifications: [], liveDeliveryVerified: false, livePaymentVerified: false, backupRestorationVerified: false, exitCode: 1 };
  }
  try {
    health = sanitizedHealth(await healthImpl({ ...healthOptions,
      env: selected(env, ['MEMBERSHIP_APP_ORIGIN', 'MEMBERSHIP_DB_PATH', 'MEMBERSHIP_BACKUP_DIR']), now, projectRoot, allowTemporary }));
  } catch {}
  problems.push(...health.problems); warnings.push(...health.warnings);
  if (health.status === 'unavailable' && !problems.length) problems.push('HEALTH_CHECK_FAILED');
  try { budget = readOperationsBudget({ env, now, projectRoot, allowTemporary, db, openDatabase }); }
  catch (error) { problems.push(error instanceof OperationsMonitorError ? error.code : 'BUDGET_DATABASE_UNAVAILABLE'); }
  if (budget.state === 'warning') warnings.push('BUDGET_WARNING');
  if (budget.state === 'blocked') problems.push('BUDGET_EXHAUSTED');
  const healthUnavailable = health.status === 'unavailable' || health.problems.length > 0 || budget.state === 'unavailable';
  const alertEnv = selected(env, ['OPERATIONS_ALERT_WEBHOOK_URL', 'OPERATIONS_ALERT_WEBHOOK_HOST', 'OPERATIONS_ALERT_STATE_DIR']);
  const notify = async (event, scope) => {
    try {
      const value = await alertImpl({ ...alertOptions, event, ...(event === 'RECOVERED' ? { scope } : {}), env: alertEnv, now, projectRoot, allowTemporary });
      notifications.push(sanitizedAlert(value, event, scope));
    } catch { notifications.push({ event, scope, status: 'unavailable', reason: 'ALERT_FAILED', configured: false, sent: false, pending: false, exitCode: 1 }); }
  };
  await notify(healthUnavailable ? 'HEALTH_UNAVAILABLE' : 'RECOVERED', 'health');
  if (budget.state !== 'unavailable') await notify(budget.state === 'blocked' ? 'BUDGET_EXHAUSTED' : budget.state === 'warning' ? 'BUDGET_WARNING' : 'RECOVERED', 'budget');
  const notificationFailure = notifications.some(item => item.exitCode !== 0);
  if (notificationFailure) problems.push(notifications.some(item => item.status === 'unavailable') ? 'ALERT_UNAVAILABLE' : 'ALERT_NOTIFICATION_PENDING');
  const exitCode = healthUnavailable || budget.state === 'blocked' ? 1 : notificationFailure ? notifications.some(item => item.exitCode === 2) ? 2 : 1 : 0;
  return { application: 'better-life', version: 1,
    status: healthUnavailable || budget.state === 'blocked' ? 'unavailable' : notificationFailure ? 'pending' : warnings.length ? 'degraded' : 'healthy',
    health: healthUnavailable ? 'unavailable' : health.status, budget: budget.state, budgetReadOnly: true,
    codes: [...new Set([...problems, ...warnings])], notifications,
    liveDeliveryVerified: false, livePaymentVerified: false, backupRestorationVerified: false, exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) fail('MONITOR_CONFIGURATION_UNAVAILABLE');
    const result = await operationsMonitor({ env: process.env }); console.log(JSON.stringify(result)); process.exitCode = result.exitCode;
  } catch {
    console.error(JSON.stringify({ application: 'better-life', version: 1, status: 'unavailable', code: 'MONITOR_FAILED', exitCode: 1 })); process.exitCode = 1;
  }
}
