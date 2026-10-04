import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createAnalyticsStore } from '../server/analytics.mjs';
import { createPaymentAnalytics } from '../server/analytics-payments.mjs';
import { createApiRuntime } from '../server/membership-runtime.mjs';

// Direct handler requests only: synthetic temporary SQLite, generated fixture
// secrets and committed fixture events; no real env, providers or network calls.
const ORIGIN = 'https://better-life.analytics-runtime.test';
const DAY = 86400000;
const today = () => Math.floor(Date.now() / DAY) * DAY;
const date = value => new Date(value).toISOString().slice(0, 10);
const secret = () => randomBytes(48).toString('base64url');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-analytics-runtime-test-'));
  const filename = join(directory, 'synthetic.sqlite'), runtimes = new Set(), privateValues = [filename, directory, 'synthetic-private'];
  const env = { NODE_ENV: 'test', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_APP_ORIGIN: ORIGIN, MEMBERSHIP_AUTH_SECRET: secret(), OPERATIONS_ENABLED: 'true', OPERATIONS_SECRET: secret() };
  privateValues.push(env.MEMBERSHIP_AUTH_SECRET, env.OPERATIONS_SECRET);
  t.after(() => {
    for (const runtime of runtimes) runtime.close();
    const absolute = resolve(directory), temporary = resolve(tmpdir());
    assert.equal(dirname(absolute), temporary); assert.ok(absolute.startsWith(join(temporary, 'better-life-analytics-runtime-test-')));
    rmSync(absolute, { recursive: true, force: true });
  });
  function database(callback, { readOnly = true } = {}) {
    const db = new DatabaseSync(filename, { readOnly });
    try { return callback(db); } finally { db.close(); }
  }
  function seed(entries) {
    let clock = today() - 3 * DAY + 12 * 3600000;
    const store = createMembershipStore({ filename, now: () => clock }), orders = [];
    try {
      for (const entry of entries) {
        clock = entry.at ?? clock;
        const id = randomUUID(), email = `synthetic-private-${id}@example.test`;
        store.db.prepare('INSERT INTO users(id,email,created_at,auth_kind,label) VALUES(?,?,?,?,?)').run(id, email, clock, 'email', 'synthetic-private-label');
        const order = store.createOrder({ id }, { id: entry.plan ?? 'member-month', name: '合成测试套餐', amountFen: 1900, currency: 'CNY', durationDays: 30 }, randomUUID(), 'synthetic-merchant').order;
        let committed = order;
        const transactionId = `synthetic_${randomUUID()}`;
        for (const type of entry.state === 'refunded' ? ['paid', 'refunded'] : entry.state === 'pending' ? [] : ['paid']) {
          committed = store.acceptPaymentEvent({ eventKey: randomBytes(32).toString('hex'), merchantId: 'synthetic-merchant', providerOrderId: order.provider_order_id,
            transactionId, type, amountFen: 1900, currency: 'CNY', occurredAt: clock });
        }
        privateValues.push(id, email, order.id, order.provider_order_id, transactionId); orders.push(committed);
      }
      return orders;
    } finally { store.close(); }
  }
  const financial = () => database(db => JSON.stringify(['orders', 'payment_events', 'entitlements', 'users'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())));
  const state = () => database(db => ({ daily: db.prepare('SELECT * FROM analytics_daily ORDER BY day,name,dimensions').all(), stamps: db.prepare('SELECT * FROM analytics_payment_dedup').all(), scan: db.prepare('SELECT * FROM analytics_payment_scan').get() }));
  const rearm = () => database(db => db.prepare('UPDATE analytics_payment_scan SET last_scan_at=0').run(), { readOnly: false });
  function open(options = {}) {
    const runtime = createApiRuntime({ env: { ...env, ANALYTICS_ENABLED: 'true', ...options }, getCorpus: () => { throw new Error('Synthetic corpus must not be accessed'); } });
    const originalClose = runtime.close; runtime.close = () => { if (runtimes.delete(runtime)) originalClose(); }; runtimes.add(runtime); return runtime;
  }
  const request = (runtime, path, headers = {}) => runtime.handler(new Request(`${ORIGIN}${path}`, { headers }));
  const report = (runtime, query = '') => request(runtime, `/api/operations/analytics${query}`, { authorization: `Bearer ${env.OPERATIONS_SECRET}` });
  function assertPrivateFree(body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    for (const value of [...privateValues, 'paid_at', 'checkout_url', 'event_hash', 'cursor_rowid', 'facts_cipher', 'content_cipher', 'user_id', 'provider_order_id', 'transaction_id', 'reconcile', 'synthetic-error']) assert.ok(!text.includes(value), value);
  }
  return { env, filename, database, seed, financial, state, rearm, open, request, report, assertPrivateFree };
}
const eventCount = state => state.daily.filter(row => row.name === 'payment_confirmed').reduce((total, row) => total + row.event_count, 0);

test('analytics runtime startup backfills committed payments on paid_at day, excludes future/expired/pending facts and is restart-idempotent', async t => {
  const h = fixture(t), paidAt = today() - 3 * DAY + 12 * 3600000;
  h.seed([{ at: paidAt }, { at: paidAt, plan: 'member-year', state: 'refunded' }, { at: today() + 2 * DAY }, { at: today() - 91 * DAY }, { at: paidAt, state: 'pending' }]);
  const before = h.financial(), runtime = h.open(), initial = h.state();
  assert.equal(eventCount(initial), 2); assert.equal(initial.stamps.length, 2); assert.equal(initial.scan.cursor_rowid, 5);
  assert.ok(initial.daily.every(row => row.day === date(paidAt) && row.source === 'server'));
  const response = await h.report(runtime, `?from=${date(paidAt)}&to=${date(paidAt)}`); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.configured, true); assert.deepEqual(body.items.map(row => [row.day, row.dimensions.plan, row.event_count]), [[date(paidAt), 'member-month', 1], [date(paidAt), 'member-year', 1]]);
  h.assertPrivateFree(body); assert.equal(h.financial(), before); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
  runtime.close(); h.rearm(); const restarted = h.open(); assert.equal(eventCount(h.state()), 2); assert.equal(h.state().stamps.length, 2);
  assert.equal((await h.request(restarted, '/api/health')).status, 200); assert.equal(eventCount(h.state()), 2); assert.equal(h.financial(), before);
});

test('analytics runtime disabled mode never collects through startup, health, browser events or staff report', async t => {
  const h = fixture(t); h.seed([{}, { at: today() + 2 * DAY }]); const before = h.financial(), runtime = h.open({ ANALYTICS_ENABLED: 'false' });
  const initial = h.state(); assert.equal(initial.daily.length, 0); assert.equal(initial.stamps.length, 0); assert.equal(initial.scan.last_scan_at, null);
  const health = await h.request(runtime, '/api/health'); assert.equal(health.status, 200); h.assertPrivateFree(await health.json());
  const browser = await runtime.handler(new Request(`${ORIGIN}/api/analytics/events`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, name: 'page_view', sessionId: randomBytes(16).toString('hex'), dimensions: { view: 'home' } }) })); assert.equal(browser.status, 204);
  const staff = await h.report(runtime); assert.equal(staff.status, 200); assert.deepEqual(await staff.json(), { configured: false, items: [] });
  assert.deepEqual(h.state(), initial); assert.equal(h.financial(), before);
});

test('analytics runtime health resumes one bounded batch without exposing data or bypassing persistent throttle', async t => {
  const h = fixture(t), paidAt = today() - 2 * DAY + 12 * 3600000;
  h.seed(Array.from({ length: 101 }, (_, index) => ({ at: paidAt, state: index === 0 || index === 100 ? 'paid' : 'pending' })));
  const before = h.financial(), runtime = h.open(), first = h.state();
  assert.equal(first.scan.cursor_rowid, 100); assert.equal(first.scan.cycle_high_water, 101); assert.equal(eventCount(first), 1);
  const throttled = await h.request(runtime, '/api/health'); assert.equal(throttled.status, 200); assert.deepEqual(h.state(), first);
  h.rearm(); const healthy = await h.request(runtime, '/api/health'); assert.equal(healthy.status, 200);
  assert.equal(healthy.headers.get('cache-control'), 'no-store'); assert.equal(healthy.headers.get('set-cookie'), null);
  const body = await healthy.json(); h.assertPrivateFree(body);
  assert.deepEqual(body, { status: 'ready', application: 'better-life', metering: false, localDemo: false, login: { emailConfigured: false, phoneConfigured: false }, payments: { creationEnabled: false } });
  assert.equal(h.state().scan.cursor_rowid, 101); assert.equal(eventCount(h.state()), 2); assert.equal(h.financial(), before);
});

test('analytics runtime staff-only report callback reconciles; membership secrets/cookies/URL tokens cannot trigger collection', async t => {
  const h = fixture(t); h.seed([{}]); const runtime = h.open(), paidAt = today() - 6 * DAY + 12 * 3600000;
  h.seed([{ at: paidAt, plan: 'member-year' }]); h.rearm(); const before = h.financial(), initial = h.state();
  for (const [path, headers] of [
    ['/api/operations/analytics', {}],
    ['/api/operations/analytics', { authorization: `Bearer ${h.env.MEMBERSHIP_AUTH_SECRET}` }],
    ['/api/operations/analytics', { cookie: `better_life_session=${randomBytes(32).toString('base64url')}` }],
    [`/api/operations/analytics?token=${h.env.OPERATIONS_SECRET}`, {}],
  ]) {
    const denied = await h.request(runtime, path, headers); assert.equal(denied.status, 401); h.assertPrivateFree(await denied.json()); assert.deepEqual(h.state(), initial);
  }
  const malformed = await h.report(runtime, '?from=2026-02-30'); assert.equal(malformed.status, 400); assert.deepEqual(h.state(), initial);
  const staff = await h.report(runtime, `?from=${date(paidAt)}&to=${date(paidAt)}`); assert.equal(staff.status, 200);
  const body = await staff.json(); assert.deepEqual(body, { configured: true, items: [{ day: date(paidAt), name: 'payment_confirmed', dimensions: { plan: 'member-year' }, source: 'server', event_count: 1, session_count: 0 }] });
  h.assertPrivateFree(body); assert.equal(eventCount(h.state()), 2); assert.equal(h.financial(), before);
});

test('analytics runtime future-only payment cannot be reported as a payment on startup or retry day', async t => {
  const h = fixture(t); h.seed([{ at: today() + 2 * DAY }]); const before = h.financial(), runtime = h.open();
  assert.equal(eventCount(h.state()), 0); assert.equal(h.state().stamps.length, 0);
  h.rearm(); const healthy = await h.request(runtime, '/api/health'); assert.equal(healthy.status, 200); h.assertPrivateFree(await healthy.json());
  h.rearm(); const report = await h.report(runtime); assert.equal(report.status, 200); assert.deepEqual(await report.json(), { configured: true, items: [] });
  assert.equal(h.state().stamps.length, 0); assert.equal(h.financial(), before);
});

test('analytics runtime aggregation or scan errors cannot prevent startup/health and repair after recovery', async t => {
  for (const failure of ['aggregation', 'checkpoint']) await t.test(failure, async sub => {
    const h = fixture(sub); const paid = h.seed([{}])[0];
    h.database(db => {
      createPaymentAnalytics({ db, store: createAnalyticsStore({ db }) });
      if (failure === 'aggregation') db.exec("CREATE TRIGGER synthetic_stats_failure BEFORE INSERT ON analytics_daily BEGIN SELECT RAISE(ABORT,'synthetic-error-private'); END;");
      else db.exec("CREATE TRIGGER synthetic_stats_failure BEFORE UPDATE ON analytics_payment_scan BEGIN SELECT RAISE(ABORT,'synthetic-error-private'); END;");
    }, { readOnly: false });
    // The checkpoint trigger is created after its table exists, without an open
    // runtime. Its UPDATE failure is caught by the runtime's reconcile wrapper.
    const before = h.financial(), runtime = h.open(); assert.equal(h.state().stamps.length, 0);
    const healthy = await h.request(runtime, '/api/health'); assert.equal(healthy.status, 200); h.assertPrivateFree(await healthy.json());
    const empty = await h.report(runtime); assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), { configured: true, items: [] }); assert.equal(h.financial(), before);
    h.database(db => db.exec('DROP TRIGGER synthetic_stats_failure'), { readOnly: false }); h.rearm();
    const repaired = await h.report(runtime); assert.equal(repaired.status, 200); const body = await repaired.json();
    assert.equal(body.items.length, 1); assert.equal(body.items[0].day, date(paid.paid_at)); assert.equal(body.items[0].event_count, 1); h.assertPrivateFree(body);
    assert.equal(h.state().stamps.length, 1); assert.equal(h.financial(), before);
  });
});
