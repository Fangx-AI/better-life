import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAnalyticsClient, analyticsEndpoint, analyticsPrivacyBlocked } from '../src/lib/analytics.mjs';
import { createAnalyticsStore, createAnalyticsHandler } from '../server/analytics.mjs';
import { ANALYTICS_SESSION_MS, analyticsDimensions, validateAnalyticsPayload } from '../shared/analytics-schema.mjs';

const origin = 'https://better-life.example.test';
const payload = (extra = {}) => ({ version: 1, name: 'page_view', sessionId: 'ab'.repeat(16), dimensions: { view: 'home' }, ...extra });
const request = (body = payload(), headers = {}) => new Request(`${origin}/api/analytics/events`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
function setup(t, options = {}) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); return { db, store: createAnalyticsStore({ db, ...options }) }; }

test('analytics schema: only product-state enums survive; account/question/URL data cannot pass', () => {
  assert.deepEqual(analyticsDimensions('qa_result', { kind: 'public', outcome: 'success', question: 'private-question', answer: 'private-answer', email: 'private@example.test', phone: '13800138000', url: 'https://private.test/?q=private' }), { kind: 'public', outcome: 'success' });
  assert.equal(analyticsDimensions('unknown', {}), null);
  assert.equal(validateAnalyticsPayload(payload({ email: 'private@example.test' })), null);
  assert.equal(validateAnalyticsPayload(payload({ dimensions: { view: 'home', question: 'private-question' } })), null);
  assert.equal(validateAnalyticsPayload(payload({ dimensions: { view: 'private-secret-value' } })), null);
  for (const sessionId of ['person@example.test', '13800138000', 'account-123', 'A'.repeat(32)]) assert.equal(validateAnalyticsPayload(payload({ sessionId })), null);
  assert.equal(validateAnalyticsPayload(payload({ name: 'payment_confirmed', dimensions: { plan: 'member-month' } })), null);
  assert.deepEqual(validateAnalyticsPayload(payload()), payload());
});

test('analytics endpoint: first-party fixed path only, with no query/hash/credential escape', () => {
  assert.equal(analyticsEndpoint({ origin, basePath: '/better-life/' }), `${origin}/better-life/api/analytics/events`);
  for (const endpoint of ['https://third-party.test/api/analytics/events', '/api/analytics/events?email=private', '/api/analytics/events#private', 'https://user:secret@better-life.example.test/api/analytics/events', '/anything-else']) assert.equal(analyticsEndpoint({ origin, endpoint }), null);
  for (const bad of ['/../', '//bad/', '/no-trailing-slash', null]) assert.equal(analyticsEndpoint({ origin, basePath: bad }), null);
});

test('analytics client: disabled/DNT/GPC never allocates identifiers or sends network traffic', async () => {
  let network = 0, random = 0, writes = 0;
  for (const preferences of [{ enabled: false }, { enabled: true, navigator: { doNotTrack: '1' } }, { enabled: true, navigator: { globalPrivacyControl: true } }, { enabled: true, window: { doNotTrack: 'yes' } }]) {
    const client = createAnalyticsClient({ origin, fetchImpl: async () => { network++; return { ok: true }; }, crypto: { getRandomValues: bytes => { random++; return bytes; } }, storage: { getItem: () => null, setItem: () => writes++ }, ...preferences });
    assert.equal(await client.track('page_view', { view: 'home' }), false);
  }
  assert.equal(network + random + writes, 0);
  assert.equal(analyticsPrivacyBlocked({ navigator: { doNotTrack: '0' }, window: {} }), false);
});

test('analytics client: short random tab session, strict-mode duplicate suppression and safe fetch options', async () => {
  let time = 1700000000000, stored = null, random = 0;
  const calls = [], navigator = {};
  const client = createAnalyticsClient({ enabled: true, origin, now: () => time, navigator, window: {},
    storage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } },
    crypto: { getRandomValues: bytes => { bytes.fill(++random); return bytes; } },
    fetchImpl: async (...args) => { calls.push(args); return { ok: true }; } });
  const privateInput = { view: 'home', accountId: 'private-user', question: 'private-question', email: 'private@example.test', phone: '13800138000', referrer: 'https://private.test/' };
  assert.equal(await client.track('page_view', privateInput), true);
  assert.equal(await client.track('page_view', privateInput), false);
  time += 1001; assert.equal(await client.track('page_view', privateInput), true);
  const first = JSON.parse(calls[0][1].body), second = JSON.parse(calls[1][1].body);
  assert.equal(first.sessionId, second.sessionId); assert.match(first.sessionId, /^[a-f0-9]{32}$/);
  assert.deepEqual(first.dimensions, { view: 'home' });
  assert.equal(calls[0][1].credentials, 'omit'); assert.equal(calls[0][1].referrerPolicy, 'no-referrer'); assert.equal(calls[0][1].keepalive, true);
  for (const secret of ['private-user', 'private-question', 'private@example.test', '13800138000', 'private.test']) assert.ok(!JSON.stringify(calls).includes(secret));
  time += ANALYTICS_SESSION_MS; assert.equal(await client.track('page_view', privateInput), true);
  assert.notEqual(JSON.parse(calls[2][1].body).sessionId, first.sessionId);
  navigator.doNotTrack = '1'; time += 1001;
  assert.equal(await client.track('page_view', privateInput), false); assert.equal(calls.length, 3);
  assert.equal(await client.track('payment_confirmed', { plan: 'member-year' }), false);
});

test('analytics client: denied storage, missing crypto and failing/timed-out transport never break product use', async () => {
  const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const working = createAnalyticsClient({ enabled: true, origin, storage: denied, navigator: {}, window: {}, fetchImpl: async () => ({ ok: true }) });
  assert.equal(await working.track('reader_open', { source: 'scene' }), true);
  const noRandom = createAnalyticsClient({ enabled: true, origin, crypto: {}, navigator: {}, window: {}, fetchImpl: async () => { throw new Error('must not send'); } });
  assert.equal(await noRandom.track('page_view', { view: 'home' }), false);
  const timeout = createAnalyticsClient({ enabled: true, origin, navigator: {}, window: {}, timeoutMs: 5, fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
  assert.equal(await timeout.track('page_view', { view: 'home' }), false);
  const offline = createAnalyticsClient({ enabled: true, origin, navigator: {}, window: {}, fetchImpl: async () => { throw new Error('offline-private-detail'); } });
  assert.equal(await offline.track('qa_submit', { kind: 'public' }), false);
});

test('analytics store: anonymous aggregate persists, sessions expire and rows never join membership', t => {
  let time = 1700000000000;
  const { db, store } = setup(t, { now: () => time, retentionDays: 7 });
  assert.equal(store.record(payload()), true); assert.equal(store.record(payload()), false);
  time += 1001; assert.equal(store.record(payload()), true);
  let rows = store.report(); assert.equal(rows[0].event_count, 2); assert.equal(rows[0].session_count, 1); assert.equal(rows[0].source, 'client');
  assert.equal(store.record(payload({ dimensions: { view: 'home', question: 'private-question' } })), false);
  assert.equal(store.recordServer('payment_confirmed', { plan: 'member-year' }), true);
  assert.equal(store.recordServer('payment_confirmed', { plan: 'member-year', userId: 'private-user' }), false);
  assert.equal(store.recordServer('page_view', { view: 'home' }), false);
  assert.equal(store.report().find(row => row.name === 'payment_confirmed').source, 'server');
  time += ANALYTICS_SESSION_MS - 2000;
  assert.equal(store.record(payload({ name: 'qa_submit', dimensions: { kind: 'public' } })), true);
  const expiries = db.prepare('SELECT DISTINCT expires_at FROM analytics_session_events').all();
  assert.equal(expiries.length, 1, 'later events must not extend the original session lifetime');
  time += 2000; store.cleanup();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_session_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_session_limits').get().n, 0);
  assert.equal(store.report().find(row => row.name === 'page_view').event_count, 2);
  const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name LIKE 'analytics_%'").all().map(row => row.sql).join('\n');
  assert.ok(!/email|phone|question|answer|user_id|ip_address|referrer/i.test(schema));
  time += 8 * 86400000; assert.deepEqual(store.report(), []);
  assert.throws(() => store.report({ from: 'private-question' }), /统计日期/);
});

test('analytics store: 60-event session cap cannot grow count indefinitely', t => {
  let time = 1700000000000; const { store } = setup(t, { now: () => time });
  for (let index = 0; index < 65; index++) { assert.equal(store.record(payload()), index < 60); time += 1001; }
  assert.equal(store.report()[0].event_count, 60);
});

test('analytics handler: same-origin bounded whitelist input only; disabled/privacy requests do not record', async t => {
  const { store } = setup(t); const handler = createAnalyticsHandler({ store, enabled: true, allowedOrigin: origin });
  assert.equal(await handler(new Request(`${origin}/api/other`)), null);
  assert.equal((await handler(request())).status, 204);
  assert.equal((await handler(request(payload(), { origin: 'https://external.test' }))).status, 403);
  assert.equal((await handler(request(payload(), { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await handler(request(payload(), { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await handler(request('x'.repeat(2049)))).status, 400);
  assert.equal((await handler(request(payload(), { 'content-length': '2049' }))).status, 400);
  assert.equal((await handler(request(payload({ question: 'private-question' })))).status, 400);
  const rejected = await handler(request(payload({ name: 'payment_confirmed', dimensions: { plan: 'member-month' } })));
  assert.equal(rejected.status, 400); assert.ok(!(await rejected.text()).includes('member-month'));
  assert.equal((await handler(request('{"private-secret":'))).status, 400);
  const before = store.report()[0].event_count;
  for (const header of [{ dnt: '1' }, { 'sec-gpc': '1' }]) assert.equal((await handler(request(payload(), header))).status, 204);
  assert.equal((await createAnalyticsHandler({ store, allowedOrigin: origin })(request())).status, 204);
  assert.equal(store.report()[0].event_count, before);
});

test('analytics handler: streamed body timeout, global rate cap, and generic storage failures', async t => {
  const { store } = setup(t); const handler = createAnalyticsHandler({ store, enabled: true, allowedOrigin: origin, bodyTimeoutMs: 5 });
  let cancelled = false;
  const stream = new ReadableStream({ start() {}, cancel() { cancelled = true; } });
  const slow = new Request(`${origin}/api/analytics/events`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: stream, duplex: 'half' });
  assert.equal((await handler(slow)).status, 408); assert.equal(cancelled, true);
  const limited = createAnalyticsHandler({ store, enabled: true, allowedOrigin: origin, now: () => 0 });
  for (let index = 0; index < 600; index++) assert.equal((await limited(request())).status, 204);
  assert.equal((await limited(request())).status, 429);
  const broken = createAnalyticsHandler({ enabled: true, allowedOrigin: origin, store: { record() { throw new Error('private-key-user-value'); } } });
  const result = await broken(request()); assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('private-key'));
});
