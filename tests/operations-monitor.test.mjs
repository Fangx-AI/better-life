import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, linkSync, chmodSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { MEMBERSHIP_DATABASE_APPLICATION_ID } from '../server/production-config.mjs';
import { operationsAlert } from '../scripts/operations-alert.mjs';
import { OperationsMonitorError, operationsMonitor, readOperationsBudget } from '../scripts/operations-monitor.mjs';

const timestamp = Date.parse('2026-10-31T16:05:00.000Z'); // Beijing November 1.
const budgetEnv = { QA_BUDGET_DAILY_CNY: '10', QA_BUDGET_MONTHLY_CNY: '100', QA_PRICE_INPUT_CNY_PER_MILLION: '2', QA_PRICE_OUTPUT_CNY_PER_MILLION: '8' };
const healthy = async () => ({ status: 'healthy', problems: [], warnings: [], privateBody: 'must-never-report' });
const eventScope = (event, scope) => scope || (event.startsWith('BUDGET_') ? 'budget' : 'health');
const successfulAlert = async ({ event, scope }) => ({ event, scope: eventScope(event, scope), status: 'deduplicated', reason: 'NO_PENDING_NOTIFICATION', configured: true, sent: false, pending: 0, exitCode: 0 });
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t, rows = [], { applicationId = MEMBERSHIP_DATABASE_APPLICATION_ID, table = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-monitor-')), privateDir = join(directory, 'private'), backupDir = join(directory, 'backups');
  mkdirSync(privateDir, { mode: 0o700 }); mkdirSync(backupDir, { mode: 0o700 });
  const filename = join(privateDir, 'membership.sqlite'), setup = new DatabaseSync(filename);
  setup.exec(`PRAGMA application_id=${applicationId}; CREATE TABLE synthetic_private_bodies(body TEXT); INSERT INTO synthetic_private_bodies VALUES('never-read-private-question');`);
  if (table) {
    setup.exec('CREATE TABLE usage_budget_requests(id TEXT PRIMARY KEY,day_key TEXT,month_key TEXT,state TEXT,reserved_micro INTEGER,charged_micro INTEGER,expires_at INTEGER)');
    const insert = setup.prepare('INSERT INTO usage_budget_requests VALUES(?,?,?,?,?,?,?)');
    rows.forEach((row, index) => insert.run(`synthetic-${index}`, row.day || '2026-11-01', row.month || '2026-11', row.state || 'settled', row.reserved ?? 0, row.charged ?? 0, row.expires ?? 0));
  }
  setup.close(); chmodSync(filename, 0o600);
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(basename(directory), /^better-life-monitor-/);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, privateDir, filename, backupDir, stateDirectory: join(directory, 'alerts'),
    env: { ...budgetEnv, MEMBERSHIP_APP_ORIGIN: 'https://better-life.fixture.test', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_BACKUP_DIR: backupDir },
    options: { now: () => timestamp, allowTemporary: true, healthImpl: healthy, alertImpl: successfulAlert } };
}
const rejectsCode = code => error => error instanceof OperationsMonitorError && error.code === code && error.message === 'Better Life 巡检未完成。';
function readonlySpy(aggregates, sqlCalls = []) {
  return {
    prepare(sql) {
      sqlCalls.push(sql);
      assert.ok(sql === 'PRAGMA application_id' || /^SELECT\b/.test(sql));
      assert.doesNotMatch(sql, /SELECT\s+\*|synthetic_private_bodies|\b(?:users|orders|guides|profiles|saved_answers|payment_events)\b/i);
      return { get: (...args) => sql === 'PRAGMA application_id' ? { application_id: MEMBERSHIP_DATABASE_APPLICATION_ID } : typeof aggregates === 'function' ? aggregates(args) : aggregates };
    },
    exec() { assert.fail('monitor must not execute SQL or transactions'); },
    close() { assert.fail('injected DB is caller-owned'); },
  };
}
const totals = values => ({ day_reserved: 0, day_charged: 0, month_reserved: 0, month_charged: 0, invalid_rows: 0, ...values });

test('monitor: only read-only DB aggregates are opened; reservations, expired dispatches and charged costs count without recovery or private reads', t => {
  const h = fixture(t, [
    { state: 'reserved', reserved: 3_000_000, expires: timestamp - 1000 },
    { state: 'dispatched', reserved: 2_000_000, expires: timestamp - 1000 },
    { state: 'conservative', charged: 3_000_000 }, { state: 'released', reserved: 9_000_000 },
    { day: '2026-10-31', month: '2026-10', state: 'settled', charged: 50_000_000 },
  ]);
  const before = digest(h.filename), files = readdirSync(h.privateDir), calls = [];
  const value = readOperationsBudget({ env: h.env, ...h.options, openDatabase: (filename, options) => {
    assert.equal(filename, h.filename); assert.deepEqual(options, { readOnly: true });
    const db = new DatabaseSync(filename, options);
    return { prepare: sql => { calls.push(sql); assert.ok(sql === 'PRAGMA application_id' || /^SELECT\b/.test(sql)); return db.prepare(sql); }, close: () => db.close() };
  } });
  assert.equal(value.day, 'warning'); assert.equal(value.month, 'normal'); assert.equal(value.state, 'warning'); assert.equal(value.readOnly, true);
  assert.equal(value.accounting, 'configured-rate-estimate-not-provider-invoice');
  assert.equal(calls.length, 2); assert.doesNotMatch(calls.join(' '), /expires_at|\bid\b|SELECT\s+\*|synthetic_private_bodies|UPDATE|INSERT|CREATE|BEGIN|COMMIT/i);
  assert.equal(digest(h.filename), before); assert.deepEqual(readdirSync(h.privateDir), files);
  assert.doesNotMatch(JSON.stringify(value), /never-read-private-question|synthetic-|\d{4}-\d{2}-\d{2}/);
});

test('monitor: exact 80%/100% thresholds and either Beijing period control fixed budget events', async t => {
  const h = fixture(t), calls = [];
  for (const [rows, expected, event, code] of [
    [totals({ day_charged: 7_999_999 }), 'normal', 'RECOVERED', 0],
    [totals({ day_charged: 8_000_000 }), 'warning', 'BUDGET_WARNING', 0],
    [totals({ day_charged: 10_000_000 }), 'blocked', 'BUDGET_EXHAUSTED', 1],
    [totals({ month_reserved: 80_000_000 }), 'warning', 'BUDGET_WARNING', 0],
    [totals({ month_charged: 100_000_000 }), 'blocked', 'BUDGET_EXHAUSTED', 1],
  ]) {
    const result = await operationsMonitor({ ...h.options, env: h.env, db: readonlySpy(rows), alertImpl: async args => { calls.push([args.event, eventScope(args.event, args.scope)]); return successfulAlert(args); } });
    assert.equal(result.budget, expected); assert.equal(result.exitCode, code);
    assert.deepEqual(calls.splice(0), [['RECOVERED', 'health'], [event, 'budget']]);
  }
});

test('monitor: one atomic query uses Beijing date/month, not UTC, and never imports the writing snapshot', t => {
  const h = fixture(t), sqlCalls = [], argsCalls = [];
  const read = now => readOperationsBudget({ env: h.env, ...h.options, now: () => now, db: readonlySpy(args => { argsCalls.push(args); return totals(); }, sqlCalls) });
  assert.equal(read(Date.parse('2026-10-31T15:59:00Z')).state, 'normal');
  assert.equal(read(Date.parse('2026-10-31T16:00:00Z')).state, 'normal');
  assert.deepEqual(argsCalls, [
    ['2026-10-31', '2026-10-31', '2026-10', '2026-10', '2026-10', '2026-10-31'],
    ['2026-11-01', '2026-11-01', '2026-11', '2026-11', '2026-11', '2026-11-01'],
  ]);
  const source = readFileSync(new URL('../scripts/operations-monitor.mjs', import.meta.url), 'utf8');
  assert.match(source, /shared\/usage-budget-config\.mjs/);
  assert.doesNotMatch(source, /from ['"][^'"]*\/usage-budget\.mjs|\.snapshot\s*\(|\.exec\s*\(|\.run\s*\(|UPDATE\s|INSERT\s|DELETE\s|CREATE\s/i);
  assert.equal(sqlCalls.filter(sql => sql.startsWith('SELECT')).length, 2);
});

test('monitor: missing/partial/invalid budget config and unreadable DB are nonzero health failures, never genuine exhaustion or budget recovery', async t => {
  const h = fixture(t);
  for (const env of [
    { ...h.env, ...Object.fromEntries(Object.keys(budgetEnv).map(key => [key, ''])) },
    { ...h.env, QA_PRICE_OUTPUT_CNY_PER_MILLION: '' }, { ...h.env, QA_BUDGET_DAILY_CNY: '-10' },
    { ...h.env, MEMBERSHIP_DB_PATH: join(h.privateDir, 'missing.sqlite') },
  ]) {
    const calls = [], result = await operationsMonitor({ ...h.options, env, alertImpl: async args => { calls.push(args.event); return successfulAlert(args); } });
    assert.equal(result.health, 'unavailable'); assert.equal(result.budget, 'unavailable'); assert.equal(result.exitCode, 1);
    assert.deepEqual(calls, ['HEALTH_UNAVAILABLE']); assert.equal(result.codes.includes('BUDGET_EXHAUSTED'), false);
    assert.equal(result.notifications.some(item => item.scope === 'budget'), false);
  }
  assert.equal(readdirSync(h.privateDir).some(name => name === 'missing.sqlite'), false);
});

test('monitor: wrong DB brand, absent table, negative/fractional/unsafe money and unsafe aggregate sums fail closed', t => {
  const badBrand = fixture(t, [], { applicationId: 0x424c5542 }), missingTable = fixture(t, [], { table: false });
  for (const h of [badBrand, missingTable]) assert.throws(() => readOperationsBudget({ env: h.env, ...h.options }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  for (const row of [{ reserved: -1, state: 'reserved' }, { charged: 0.5 }, { reserved: 9007199254740992n, state: 'reserved' }, { state: 'unknown', charged: 1 }, { day: 'invalid', charged: 1 }, { day: '2026-11-31', charged: 1 }, { day: '2026-10-31', month: '2026-11', charged: 1 }]) {
    const h = fixture(t, [row]); assert.throws(() => readOperationsBudget({ env: h.env, ...h.options }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  }
  const h = fixture(t);
  for (const row of [totals({ day_reserved: maximum(), day_charged: 1 }), totals({ month_charged: NaN }), totals({ day_reserved: -1 }), totals({ invalid_rows: 1 })]) {
    assert.throws(() => readOperationsBudget({ env: h.env, ...h.options, db: readonlySpy(row) }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  }
});
function maximum() { return Number.MAX_SAFE_INTEGER; }

test('monitor: public/source/foreign/temp paths, linked ancestors and hardlinked database files are rejected before any DB read', t => {
  const h = fixture(t); let opened = false;
  const options = { env: h.env, ...h.options, openDatabase: () => { opened = true; assert.fail('unsafe path must not open'); } };
  for (const name of ['public', 'dist', 'Image_2', 'image2-shared', 'www', 'releases', 'better-life-current', 'better-life-releases']) assert.throws(() => readOperationsBudget({ ...options, env: { ...h.env, MEMBERSHIP_DB_PATH: join(h.directory, name, 'membership.sqlite') } }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  assert.throws(() => readOperationsBudget({ ...options, projectRoot: h.directory }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  assert.throws(() => readOperationsBudget({ ...options, allowTemporary: false }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  const link = join(h.directory, 'linked-private'); symlinkSync(h.privateDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readOperationsBudget({ ...options, env: { ...h.env, MEMBERSHIP_DB_PATH: join(link, 'membership.sqlite') } }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  linkSync(h.filename, join(h.privateDir, 'alias.sqlite'));
  assert.throws(() => readOperationsBudget(options), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  assert.equal(opened, false);
});

test('monitor: broad Unix permissions are rejected; Windows tests do not claim Linux permission validation', { skip: process.platform === 'win32' }, t => {
  const h = fixture(t); chmodSync(h.filename, 0o644);
  assert.throws(() => readOperationsBudget({ env: h.env, ...h.options }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
  chmodSync(h.filename, 0o600); chmodSync(h.privateDir, 0o755);
  assert.throws(() => readOperationsBudget({ env: h.env, ...h.options }), rejectsCode('BUDGET_DATABASE_UNAVAILABLE'));
});

test('monitor: injected health/alert failures and arbitrary payloads never leak free text, credentials, paths or private data', async t => {
  const h = fixture(t), privateValue = 'synthetic-private-token-and-question', received = [];
  const result = await operationsMonitor({ ...h.options, env: { ...h.env, MEMBERSHIP_AUTH_SECRET: privateValue, DEEPSEEK_API_KEY: privateValue, OPERATIONS_ALERT_WEBHOOK_URL: `https://alerts.example.com/${privateValue}` },
    healthImpl: async options => { received.push(options.env); throw new Error(privateValue); },
    alertImpl: async options => { received.push(options.env); throw new Error(privateValue); },
    db: readonlySpy(totals()),
  });
  assert.equal(result.exitCode, 1); assert.equal(result.status, 'unavailable'); assert.ok(result.codes.includes('HEALTH_CHECK_FAILED')); assert.ok(result.codes.includes('ALERT_UNAVAILABLE'));
  const report = JSON.stringify(result);
  for (const value of [privateValue, h.filename, h.directory, h.env.MEMBERSHIP_APP_ORIGIN, 'never-read-private-question']) assert.equal(report.includes(value), false);
  assert.deepEqual(Object.keys(received[0]).sort(), ['MEMBERSHIP_APP_ORIGIN', 'MEMBERSHIP_DB_PATH', 'MEMBERSHIP_BACKUP_DIR'].sort());
  assert.equal(received.slice(1).some(env => Object.hasOwn(env, 'MEMBERSHIP_AUTH_SECRET') || Object.hasOwn(env, 'DEEPSEEK_API_KEY')), false);
  const invalid = await operationsMonitor({ ...h.options, env: h.env, db: readonlySpy(totals()), healthImpl: async () => ({ status: 'healthy', problems: [], warnings: [privateValue] }),
    alertImpl: async args => ({ ...(await successfulAlert(args)), reason: privateValue }) });
  assert.equal(JSON.stringify(invalid).includes(privateValue), false); assert.equal(invalid.exitCode, 1);
  assert.equal(new OperationsMonitorError(privateValue).code, 'MONITOR_CONFIGURATION_UNAVAILABLE');
});

test('monitor: missing webhook keeps budget warning durably pending and nonzero without any network or fake receipts', async t => {
  const h = fixture(t), before = digest(h.filename); let network = 0;
  const options = { ...h.options, env: { ...h.env, OPERATIONS_ALERT_STATE_DIR: h.stateDirectory }, db: readonlySpy(totals({ day_charged: 8_000_000 })),
    alertImpl: operationsAlert, alertOptions: { fetchImpl: async () => { network++; assert.fail('no webhook must not send'); } } };
  for (let i = 0; i < 2; i++) {
    const result = await operationsMonitor(options);
    assert.equal(result.status, 'pending'); assert.equal(result.budget, 'warning'); assert.equal(result.exitCode, 2);
    assert.ok(result.notifications.every(item => item.sent === false));
    assert.ok(result.notifications.some(item => item.event === 'BUDGET_WARNING' && item.pending && !item.configured));
  }
  const state = JSON.parse(readFileSync(join(h.stateDirectory, 'alerts-state.json'), 'utf8'));
  assert.equal(state.scopes.budget.queue.length, 1); assert.equal(state.scopes.budget.receipts.length, 0); assert.equal(network, 0);
  assert.equal(digest(h.filename), before); assert.deepEqual(readdirSync(h.privateDir), ['membership.sqlite']);
});

test('monitor: delivered incidents recover per scope and fixed webhook payload contains no DB details', async t => {
  const h = fixture(t), sent = [], sql = [];
  let current = totals({ day_charged: 8_000_000 });
  const options = { ...h.options, env: { ...h.env, OPERATIONS_ALERT_STATE_DIR: h.stateDirectory,
    OPERATIONS_ALERT_WEBHOOK_URL: 'https://alerts.example.com/synthetic-hook', OPERATIONS_ALERT_WEBHOOK_HOST: 'alerts.example.com' },
    db: readonlySpy(() => current, sql), alertImpl: operationsAlert,
    alertOptions: { fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 204 }; } } };
  const warning = await operationsMonitor(options); assert.equal(warning.exitCode, 0); assert.equal(warning.status, 'degraded');
  current = totals(); const normal = await operationsMonitor(options); assert.equal(normal.exitCode, 0); assert.equal(normal.status, 'healthy');
  assert.deepEqual(sent.map(value => [value.event, value.status]), [['BUDGET_WARNING', 'budget_warning'], ['RECOVERED', 'budget_recovered']]);
  for (const payload of sent) assert.deepEqual(Object.keys(payload).sort(), ['application', 'event', 'status', 'time', 'version']);
  assert.doesNotMatch(JSON.stringify(sent), /synthetic-hook|membership\.sqlite|never-read-private-question|day_charged|8000000/);
  const state = JSON.parse(readFileSync(join(h.stateDirectory, 'alerts-state.json'), 'utf8'));
  assert.deepEqual(state.scopes.budget.active, []); assert.equal(state.scopes.budget.receipts.length, 2);
});

test('monitor: five-minute oneshot templates read dedicated envs and grant writes only to alerts; no recursive/fake-health OnFailure', () => {
  const service = readFileSync(new URL('../deploy/better-life-health.service', import.meta.url), 'utf8');
  const timer = readFileSync(new URL('../deploy/better-life-health.timer', import.meta.url), 'utf8');
  const directives = service.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).join('\n');
  assert.match(directives, /EnvironmentFile=\/etc\/better-life\/monitor\.env/);
  assert.match(directives, /EnvironmentFile=-\/etc\/better-life\/alerts\.env/);
  assert.doesNotMatch(directives, /production\.env|backup\.env|OnFailure=|Restart=|SuccessExitStatus=/);
  assert.match(directives, /Type=oneshot/); assert.match(directives, /ProtectSystem=strict/);
  assert.equal((directives.match(/ReadWritePaths=/g) || []).length, 1);
  assert.match(directives, /^ReadWritePaths=\/var\/lib\/better-life\/alerts$/m);
  assert.match(directives, /ExecStart=\/usr\/bin\/node scripts\/operations-monitor\.mjs/);
  assert.match(timer, /OnBootSec=5min/); assert.match(timer, /OnUnitActiveSec=5min/); assert.match(timer, /Unit=better-life-health\.service/);
  const doc = readFileSync(new URL('../docs/OPERATIONS-MONITOR.md', import.meta.url), 'utf8');
  for (const text of ['未生产启用', '只放以下 **7 项**', '没有 health OnFailure', '脚本启动前崩溃', '不证明负责人已读', '不对 Pages 静态站', 'readOnly:true']) assert.ok(doc.includes(text));
});
