import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { MEMBERSHIP_DATABASE_APPLICATION_ID, assertDirectoryAncestors, privateStoragePath } from './production-config.mjs';
import { UsageBudgetError, usageBudgetConfig, usageBudgetConfigurationError as configurationError } from '../shared/usage-budget-config.mjs';
export { UsageBudgetError, usageBudgetConfig } from '../shared/usage-budget-config.mjs';

export const USAGE_BUDGET_DATABASE_APPLICATION_ID = 0x424c5542;
const SCALE = 1_000_000;
const MAX_TOKENS = 10_000_000;
const unavailable = () => new UsageBudgetError(503, 'budget_unavailable', '问答成本账本暂不可用，请稍后重试。');
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS;
function cost(input, output, inputRate, outputRate) {
  const numerator = BigInt(input) * BigInt(inputRate) + BigInt(output) * BigInt(outputRate);
  const amount = Number((numerator + BigInt(SCALE) - 1n) / BigInt(SCALE));
  if (!Number.isSafeInteger(amount)) throw configurationError();
  return amount;
}
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
function periods(timestamp) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}` };
}
function validUsage(usage) {
  return usage && typeof usage === 'object' && tokenCount(usage.prompt_tokens) && tokenCount(usage.completion_tokens)
    && (usage.total_tokens === undefined || usage.total_tokens === usage.prompt_tokens + usage.completion_tokens);
}

// Aggregate cost guardrail, not a replacement for per-account quota or gateway/IP rate limits.
// All rows are content-free; the IDs below are generated on the server and never contain identity or text.
export function createUsageBudget({ db: suppliedDb, filename = ':memory:', env = {}, now = Date.now, reservationTtlMs = 120_000 } = {}) {
  const config = usageBudgetConfig(env);
  if (!config.configured) return { reserve: () => null, markDispatched: () => false, settle: () => false, fail: () => false, cleanup: () => 0,
    snapshot: () => ({ configured: false, currency: 'CNY', timezone: 'Asia/Shanghai', alertThreshold: 0.8 }), close: () => {} };
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 60_000 || reservationTtlMs > 600_000) throw configurationError();
  const owned = !suppliedDb;
  if (owned && filename !== ':memory:') {
    if (!privateStoragePath(filename, { allowTemporary: true })) throw configurationError();
    try {
      assertDirectoryAncestors(dirname(filename), { requireExisting: false });
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      let descriptor;
      try { descriptor = openSync(filename, 'wx', 0o600); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
      const info = lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && info.mode & 0o077) throw configurationError();
    } catch { throw configurationError(); }
  }
  const db = suppliedDb || new DatabaseSync(filename);
  try {
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (owned ? applicationId !== USAGE_BUDGET_DATABASE_APPLICATION_ID && (applicationId !== 0 || tables.length) : applicationId !== MEMBERSHIP_DATABASE_APPLICATION_ID) throw configurationError();
    if (owned && applicationId === 0) db.exec(`PRAGMA application_id=${USAGE_BUDGET_DATABASE_APPLICATION_ID}`);
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS usage_budget_requests(
        id TEXT PRIMARY KEY, day_key TEXT NOT NULL, month_key TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN('reserved','dispatched','settled','conservative','released')),
        input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL,
        input_rate INTEGER NOT NULL, output_rate INTEGER NOT NULL,
        reserved_micro INTEGER NOT NULL, charged_micro INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER, completion_tokens INTEGER,
        reason TEXT, overrun INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS usage_budget_daily ON usage_budget_requests(day_key,state);
      CREATE INDEX IF NOT EXISTS usage_budget_monthly ON usage_budget_requests(month_key,state);`);
    if (owned) db.exec('PRAGMA journal_mode=WAL');
  } catch (error) { if (owned) db.close(); throw error instanceof UsageBudgetError ? error : unavailable(); }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function tx(fn) {
    let started = false;
    try { db.exec('BEGIN IMMEDIATE'); started = true; const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { if (started) { try { db.exec('ROLLBACK'); } catch {} } throw error instanceof UsageBudgetError ? error : unavailable(); }
  }
  function recover(timestamp) {
    // An expired, never-dispatched reservation can be released. After dispatch, vendor cost
    // is unknown: retain the worst-case estimate even across crashes/restarts, never reset it.
    const released = run("UPDATE usage_budget_requests SET state='released',reason='expired_before_dispatch' WHERE state='reserved' AND expires_at<=?", timestamp).changes;
    const charged = run("UPDATE usage_budget_requests SET state='conservative',charged_micro=reserved_micro,reason='expired_after_dispatch' WHERE state='dispatched' AND expires_at<=?", timestamp).changes;
    return Number(released) + Number(charged);
  }
  function summary(field, key, limit) {
    const row = get(`SELECT COALESCE(SUM(CASE WHEN state IN('reserved','dispatched') THEN reserved_micro ELSE 0 END),0) AS reserved,
      COALESCE(SUM(charged_micro),0) AS charged,
      COALESCE(SUM(CASE WHEN state='conservative' THEN charged_micro ELSE 0 END),0) AS uncertain,
      COALESCE(SUM(CASE WHEN state='conservative' THEN 1 ELSE 0 END),0) AS uncertain_count,
      COALESCE(SUM(overrun),0) AS overruns FROM usage_budget_requests WHERE ${field}=?`, key);
    const total = row.reserved + row.charged;
    return { period: key, limitMicroCny: limit, reservedMicroCny: row.reserved, chargedMicroCny: row.charged, committedMicroCny: total,
      conservativeMicroCny: row.uncertain, conservativeRequests: row.uncertain_count, overrunRequests: row.overruns,
      remainingMicroCny: Math.max(0, limit - total), fraction: total / limit, alert: total >= limit * 0.8, blocked: total >= limit };
  }
  function assertRoom(keys, amount) {
    if (summary('day_key', keys.day, config.dailyLimit).committedMicroCny + amount > config.dailyLimit
      || summary('month_key', keys.month, config.monthlyLimit).committedMicroCny + amount > config.monthlyLimit)
      throw new UsageBudgetError(503, 'budget_exhausted', '今日或本月问答预算已用完，请稍后再试或先查看原文。');
  }
  function reserve({ inputTokens, maxOutputTokens } = {}) {
    if (!tokenCount(inputTokens) || !tokenCount(maxOutputTokens) || !maxOutputTokens) throw configurationError();
    const timestamp = now(), keys = periods(timestamp), amount = cost(inputTokens, maxOutputTokens, config.inputRate, config.outputRate);
    return tx(() => {
      recover(timestamp); assertRoom(keys, amount); const id = randomUUID();
      run("INSERT INTO usage_budget_requests(id,day_key,month_key,created_at,expires_at,state,input_bound,output_bound,input_rate,output_rate,reserved_micro) VALUES(?,?,?,?,?,'reserved',?,?,?,?,?)",
        id, keys.day, keys.month, timestamp, timestamp + reservationTtlMs, inputTokens, maxOutputTokens, config.inputRate, config.outputRate, amount);
      return { id, reservedMicroCny: amount };
    });
  }
  function markDispatched(id) {
    return tx(() => {
      const timestamp = now(); recover(timestamp); const row = get('SELECT * FROM usage_budget_requests WHERE id=?', id);
      if (!row || row.state !== 'reserved') return false;
      const keys = periods(timestamp);
      if (row.day_key !== keys.day || row.month_key !== keys.month) {
        // Reservation crossing local midnight must also fit the new day's budget before send.
        run("UPDATE usage_budget_requests SET state='released' WHERE id=?", id); assertRoom(keys, row.reserved_micro);
      }
      run("UPDATE usage_budget_requests SET state='dispatched',day_key=?,month_key=?,expires_at=? WHERE id=?", keys.day, keys.month, timestamp + reservationTtlMs, id);
      return true;
    });
  }
  function settle(id, { usage } = {}) {
    return tx(() => {
      recover(now()); const row = get('SELECT * FROM usage_budget_requests WHERE id=?', id);
      if (!row || !['dispatched', 'conservative'].includes(row.state)) return false;
      if (!validUsage(usage)) {
        run("UPDATE usage_budget_requests SET state='conservative',charged_micro=reserved_micro,reason=? WHERE id=?", usage ? 'invalid_usage' : 'missing_usage', id);
        return { settled: true, conservative: true, chargedMicroCny: row.reserved_micro };
      }
      const amount = cost(usage.prompt_tokens, usage.completion_tokens, row.input_rate, row.output_rate);
      const overrun = usage.prompt_tokens > row.input_bound || usage.completion_tokens > row.output_bound || amount > row.reserved_micro;
      run("UPDATE usage_budget_requests SET state='settled',charged_micro=?,prompt_tokens=?,completion_tokens=?,reason='reported_usage',overrun=? WHERE id=?", amount, usage.prompt_tokens, usage.completion_tokens, overrun ? 1 : 0, id);
      return { settled: true, conservative: false, chargedMicroCny: amount, overrun };
    });
  }
  function fail(id) {
    return tx(() => {
      recover(now()); const row = get('SELECT * FROM usage_budget_requests WHERE id=?', id);
      if (!row || !['reserved', 'dispatched'].includes(row.state)) return false;
      const sent = row.state === 'dispatched';
      run('UPDATE usage_budget_requests SET state=?,charged_micro=?,reason=? WHERE id=?', sent ? 'conservative' : 'released', sent ? row.reserved_micro : 0, sent ? 'failed_after_dispatch' : 'failed_before_dispatch', id);
      return { released: !sent, conservative: sent, chargedMicroCny: sent ? row.reserved_micro : 0 };
    });
  }
  function snapshot() {
    return tx(() => {
      const timestamp = now(), keys = periods(timestamp); recover(timestamp);
      const day = summary('day_key', keys.day, config.dailyLimit), month = summary('month_key', keys.month, config.monthlyLimit);
      return { configured: true, currency: 'CNY', timezone: config.timezone, amountScale: SCALE, alertThreshold: 0.8,
        accounting: 'configured-rate-estimate-not-provider-invoice', day, month,
        state: day.blocked || month.blocked ? 'blocked' : day.alert || month.alert ? 'warning' : 'normal' };
    });
  }
  // Caller owns lifecycle when sharing the membership DB; snapshot is for authenticated admin only.
  return { reserve, markDispatched, settle, fail, cleanup: () => tx(() => recover(now())), snapshot, close: () => { if (owned) db.close(); } };
}
