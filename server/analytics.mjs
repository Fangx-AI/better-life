import { ANALYTICS_SESSION_MS, SERVER_ANALYTICS_EVENTS, analyticsDimensions, validateAnalyticsPayload } from '../shared/analytics-schema.mjs';

const BODY_LIMIT = 2048;
const BODY_TIMEOUT = Symbol('body-timeout');
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const failure = status => Response.json({ error: { code: 'ANALYTICS_REJECTED', message: '统计请求未接收。' } }, { status, headers });
const empty = () => new Response(null, { status: 204, headers });

// The caller owns/backs up/closes db. This module does not open another database,
// join membership tables, retain account/IP/UA/referrer data, or log payloads.
export function createAnalyticsStore({ db, now = Date.now, retentionDays = 90 } = {}) {
  if (!db?.prepare || !db?.exec) throw new Error('统计需要已准备的本站数据库。');
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 366) throw new Error('统计保留天数无效。');
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_daily(day TEXT NOT NULL,name TEXT NOT NULL,dimensions TEXT NOT NULL,source TEXT NOT NULL,event_count INTEGER NOT NULL DEFAULT 0,session_count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,name,dimensions,source));
    CREATE TABLE IF NOT EXISTS analytics_session_events(session_id TEXT NOT NULL,event_key TEXT NOT NULL,expires_at INTEGER NOT NULL,last_recorded_at INTEGER NOT NULL,PRIMARY KEY(session_id,event_key));
    CREATE TABLE IF NOT EXISTS analytics_session_limits(session_id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,event_count INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS analytics_session_expiry ON analytics_session_events(expires_at);`);
  const day = time => new Date(time).toISOString().slice(0, 10);
  function cleanup() {
    const time = now();
    db.prepare('DELETE FROM analytics_session_events WHERE expires_at<=?').run(time);
    db.prepare('DELETE FROM analytics_session_limits WHERE expires_at<=?').run(time);
    db.prepare('DELETE FROM analytics_daily WHERE day<?').run(day(time - (retentionDays - 1) * 86400000));
  }
  function aggregate(name, dimensions, source, sessionCount, occurredAt = now()) {
    db.prepare(`INSERT INTO analytics_daily(day,name,dimensions,source,event_count,session_count) VALUES(?,?,?,?,1,?)
      ON CONFLICT(day,name,dimensions,source) DO UPDATE SET event_count=event_count+1,session_count=session_count+excluded.session_count`).run(day(occurredAt), name, JSON.stringify(dimensions), source, sessionCount);
  }
  function record(input) {
    const payload = validateAnalyticsPayload(input);
    if (!payload) return false;
    cleanup();
    const time = now(), eventKey = JSON.stringify([day(time), payload.name, payload.dimensions]);
    const seen = db.prepare('SELECT last_recorded_at FROM analytics_session_events WHERE session_id=? AND event_key=?').get(payload.sessionId, eventKey);
    if (seen && time - seen.last_recorded_at < 1000) return false;
    const limit = db.prepare('SELECT event_count,expires_at FROM analytics_session_limits WHERE session_id=?').get(payload.sessionId);
    if (limit?.event_count >= 60) return false;
    const expiresAt = limit?.expires_at || time + ANALYTICS_SESSION_MS;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO analytics_session_limits(session_id,expires_at,event_count) VALUES(?,?,1)
        ON CONFLICT(session_id) DO UPDATE SET event_count=event_count+1`).run(payload.sessionId, expiresAt);
      db.prepare(`INSERT INTO analytics_session_events(session_id,event_key,expires_at,last_recorded_at) VALUES(?,?,?,?)
        ON CONFLICT(session_id,event_key) DO UPDATE SET last_recorded_at=excluded.last_recorded_at`).run(payload.sessionId, eventKey, expiresAt, time);
      aggregate(payload.name, payload.dimensions, 'client', seen ? 0 : 1);
      db.exec('COMMIT');
      return true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function recordServer(name, input = {}, occurredAt = now()) {
    if (!SERVER_ANALYTICS_EVENTS.includes(name)) return false;
    const dimensions = analyticsDimensions(name, input);
    if (!dimensions || Object.keys(input).length !== Object.keys(dimensions).length) return false;
    // Backfilled server facts use their authoritative occurrence date, not the
    // retry date. Neither future nor already-expired facts enter a new bucket.
    const time = now();
    if (!Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > time || day(occurredAt) < day(time - (retentionDays - 1) * 86400000)) return false;
    cleanup(); aggregate(name, dimensions, 'server', 0, occurredAt); return true;
  }
  function report({ from, to } = {}) {
    cleanup();
    const end = day(now()), start = day(now() - (retentionDays - 1) * 86400000);
    if ([from, to].some(value => value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value))) throw new Error('统计日期必须是 YYYY-MM-DD。');
    return db.prepare('SELECT day,name,dimensions,source,event_count,session_count FROM analytics_daily WHERE day>=? AND day<=? ORDER BY day,name,dimensions,source').all(from || start, to || end).map(row => ({ ...row, dimensions: JSON.parse(row.dimensions) }));
  }
  return Object.freeze({ record, recordServer, cleanup, report, retentionDays });
}

async function boundedJson(request, timeoutMs) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = []; let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, timeoutMs);
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > BODY_LIMIT) { void reader.cancel().catch(() => {}); return null; } chunks.push(value); }
    if (timedOut) return BODY_TIMEOUT;
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return timedOut ? BODY_TIMEOUT : null; } finally { clearTimeout(timeout); reader.releaseLock(); }
}

export function createAnalyticsHandler({ store, enabled = false, allowedOrigin, now = Date.now, bodyTimeoutMs = 5000 } = {}) {
  if (!store?.record) throw new Error('统计存储尚未准备。');
  if (!Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 10000) throw new Error('统计请求超时配置无效。');
  let windowStart = now(), windowCount = 0;
  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/analytics/events') return null;
    if (!enabled || request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1') return empty();
    if (request.method !== 'POST') return failure(405);
    if (url.search || !allowedOrigin || request.headers.get('origin') !== allowedOrigin || !['same-origin', null].includes(request.headers.get('sec-fetch-site'))) return failure(403);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) return failure(415);
    const time = now(); if (time - windowStart >= 60000) { windowStart = time; windowCount = 0; }
    if (++windowCount > 600) return failure(429); // In-process abuse cap without IP/UA storage.
    const body = await boundedJson(request, bodyTimeoutMs);
    if (body === BODY_TIMEOUT) return failure(408);
    const payload = validateAnalyticsPayload(body);
    if (!payload) return failure(400);
    try { store.record(payload); return empty(); } catch { return failure(503); }
  };
}
