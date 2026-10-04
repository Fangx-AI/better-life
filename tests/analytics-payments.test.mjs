import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createAnalyticsStore } from '../server/analytics.mjs';
import { createPaymentAnalytics } from '../server/analytics-payments.mjs';

// All financial rows are synthetic and created through the committed order/event
// API. No live credentials, providers, private databases or network calls exist.
const DAY = 86400000;
const START = Date.UTC(2026, 9, 4, 12);
function harness(t, { filename, time = START, retentionDays = 90, closeOnFinish = true } = {}) {
  let clock = time;
  const now = () => clock, store = createMembershipStore({ ...(filename ? { filename } : {}), now });
  if (closeOnFinish) t.after(() => store.close());
  const stats = createAnalyticsStore({ db: store.db, now, retentionDays });
  const recorder = options => createPaymentAnalytics({ db: store.db, store: stats, now, enabled: true, minScanIntervalMs: 0, ...options });
  function order(planId = 'member-month') {
    const id = randomUUID();
    store.db.prepare('INSERT INTO users(id,email,created_at,auth_kind,label) VALUES(?,?,?,?,?)').run(id, `synthetic-${id}@example.test`, now(), 'email', 'synthetic-private-label');
    return store.createOrder({ id }, { id: planId, name: '合成套餐', amountFen: 1900, currency: 'CNY', durationDays: 30 }, randomUUID(), 'synthetic-merchant').order;
  }
  function event(order, type = 'paid') {
    const current = store.db.prepare('SELECT transaction_id FROM orders WHERE id=?').get(order.id);
    return store.acceptPaymentEvent({ eventKey: randomBytes(32).toString('hex'), merchantId: 'synthetic-merchant', providerOrderId: order.provider_order_id,
      transactionId: current.transaction_id || `synthetic_${randomUUID()}`, type, amountFen: 1900, currency: 'CNY', occurredAt: now() });
  }
  const paid = planId => event(order(planId));
  const financial = () => JSON.stringify(['orders', 'payment_events', 'entitlements', 'users'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  return { store, stats, recorder, now, order, event, paid, financial, tick: ms => { clock += ms; } };
}
const count = stats => stats.report().filter(row => row.name === 'payment_confirmed').reduce((total, row) => total + row.event_count, 0);
const stamps = h => h.store.db.prepare('SELECT * FROM analytics_payment_dedup').all();
const checkpoint = h => h.store.db.prepare('SELECT * FROM analytics_payment_scan').get();

test('payment analytics reads committed metadata, deduplicates and never mutates financial facts', t => {
  const h = harness(t), record = h.recorder(), pending = h.order(), paid = h.paid(), before = h.financial();
  assert.equal(record({ id: 'synthetic-noncommitted', status: 'paid', plan_id: 'member-month', paid_at: h.now() }), false);
  assert.equal(record({ ...pending, status: 'paid', paid_at: h.now() }), false);
  assert.equal(record({ id: paid.id, status: 'pending', plan_id: 'member-year', paid_at: 0 }), true, 'callback hints cannot override persisted facts');
  assert.equal(record(paid), false); assert.equal(record(null), false);
  assert.equal(count(h.stats), 1); assert.equal(h.stats.report()[0].dimensions.plan, 'member-month'); assert.equal(h.financial(), before);
  const metadata = JSON.stringify([...stamps(h), checkpoint(h)]);
  for (const value of [paid.id, pending.id, 'synthetic-private', 'checkout_url', 'user_id', 'provider_order_id', 'transaction_id']) assert.ok(!metadata.includes(value), value);
  assert.match(stamps(h)[0].event_hash, /^[a-f0-9]{64}$/);
});

test('disabled analytics neither counts nor scans authoritative orders', t => {
  const h = harness(t), paid = h.paid(), record = h.recorder({ enabled: false }), before = JSON.stringify(checkpoint(h));
  assert.equal(record(paid), false);
  assert.deepEqual(record.reconcile(), { enabled: false, scanned: 0, recorded: 0, skipped: 0, failed: 0, complete: false, throttled: false });
  assert.equal(JSON.stringify(checkpoint(h)), before); assert.equal(count(h.stats), 0); assert.equal(stamps(h).length, 0);
});

test('aggregation throw or rejection rolls back the stamp and a bounded reconcile safely repairs it', t => {
  for (const mode of ['throw', 'false']) {
    const h = harness(t), paid = h.paid(), before = h.financial();
    const record = h.recorder({ store: { recordServer() { if (mode === 'throw') throw new Error('synthetic-private-failure'); return false; } } });
    assert.throws(() => record(paid)); assert.equal(stamps(h).length, 0);
    const failure = record.reconcile(); assert.equal(failure.failed, 1); assert.equal(failure.recorded, 0); assert.equal(checkpoint(h).cursor_rowid, 0);
    assert.ok(!JSON.stringify(failure).includes('synthetic-private'));
    const repaired = h.recorder().reconcile(); assert.equal(repaired.recorded, 1); assert.equal(repaired.complete, true);
    assert.equal(h.recorder().reconcile().recorded, 0); assert.equal(stamps(h).length, 1); assert.equal(count(h.stats), 1); assert.equal(h.financial(), before);
  }
});

test('payment recovery uses paid_at UTC day, never the later retry or refund day', t => {
  const h = harness(t), paid = h.paid('member-year'), paidDay = new Date(h.now()).toISOString().slice(0, 10);
  h.tick(3 * DAY); const refunded = h.event(paid, 'refunded'), before = h.financial();
  assert.equal(h.recorder().reconcile().recorded, 1); assert.equal(h.recorder()(refunded), false);
  assert.deepEqual(h.stats.report(), [{ day: paidDay, name: 'payment_confirmed', dimensions: { plan: 'member-year' }, source: 'server', event_count: 1, session_count: 0 }]);
  assert.equal(h.financial(), before);
});

test('refund arriving before paid has no paid_at and cannot fabricate a confirmed payment', t => {
  const h = harness(t), refunded = h.event(h.order(), 'refunded'), record = h.recorder();
  assert.equal(refunded.paid_at, null); assert.equal(record(refunded), false);
  assert.equal(record.reconcile().recorded, 0); assert.equal(count(h.stats), 0); assert.equal(stamps(h).length, 0);
});

test('expired history does not reappear on retry day; retained boundary still backfills', t => {
  const h = harness(t), old = h.paid(); h.tick(DAY); const boundary = h.paid(); h.tick(89 * DAY);
  const record = h.recorder(); assert.equal(record(old), false); assert.equal(record(boundary), true);
  assert.equal(record.reconcile().recorded, 0); assert.equal(count(h.stats), 1);
  assert.equal(h.stats.report()[0].day, new Date(boundary.paid_at).toISOString().slice(0, 10));
  h.tick(DAY); assert.deepEqual(h.stats.report({ from: '2000-01-01' }), []);
  assert.equal(record.reconcile().recorded, 0); assert.deepEqual(h.stats.report(), []);
});

test('server occurrence interface rejects future, invalid and out-of-retention timestamps without changing browser schema', t => {
  const h = harness(t, { retentionDays: 7 });
  for (const time of [h.now() + 1, -1, NaN, Infinity, 1.5, String(h.now()), null, h.now() - 7 * DAY]) assert.equal(h.stats.recordServer('payment_confirmed', { plan: 'member-month' }, time), false);
  assert.equal(h.stats.recordServer('payment_confirmed', { plan: 'member-month' }, h.now() - 6 * DAY), true);
  assert.equal(h.stats.recordServer('payment_confirmed', { plan: 'member-year' }), true);
  const record = h.recorder(); assert.equal(record.reconcile().scanned, 0); assert.equal(count(h.stats), 2);
  assert.equal(h.stats.record({ version: 1, name: 'payment_confirmed', sessionId: 'ab'.repeat(16), dimensions: { plan: 'member-month' } }), false);
});

test('default recovery is bounded to 100 metadata rows and checkpoint resumes subsequent batches', t => {
  const h = harness(t); for (let i = 0; i < 101; i++) h.paid();
  const record = h.recorder(), before = h.financial(), first = record.reconcile();
  assert.equal(first.scanned, 100); assert.equal(first.recorded, 100); assert.equal(first.complete, false); assert.equal(checkpoint(h).cursor_rowid, 100);
  const second = record.reconcile(); assert.equal(second.scanned, 1); assert.equal(second.recorded, 1); assert.equal(second.complete, true);
  assert.equal(count(h.stats), 101); assert.equal(h.financial(), before);
});

test('frozen cycle high water revisits old rows despite continuing new orders', t => {
  const h = harness(t), oldPending = h.order(); h.paid(); h.paid();
  const record = h.recorder({ batchSize: 1 }); assert.equal(record.reconcile().skipped, 1); const fixedHighWater = checkpoint(h).cycle_high_water;
  h.event(oldPending); h.paid(); assert.equal(record.reconcile().recorded, 1); assert.equal(checkpoint(h).cycle_high_water, fixedHighWater);
  h.paid(); const complete = record.reconcile(); assert.equal(complete.complete, true); assert.equal(count(h.stats), 2);
  h.paid(); const nextCycle = record.reconcile(); assert.equal(nextCycle.recorded, 1, 'old missed paid row is revisited before new rows');
  assert.equal(count(h.stats), 3); assert.ok(checkpoint(h).cycle_high_water > fixedHighWater);
});

test('persistent checkpoint and throttle survive restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-payment-analytics-test-'));
  let h, reopened, originalClosed = false;
  t.after(() => {
    reopened?.close(); if (h && !originalClosed) h.store.close();
    assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(directory.startsWith(join(tmpdir(), 'better-life-payment-analytics-test-'))); rmSync(directory, { recursive: true, force: true });
  });
  const filename = join(directory, 'synthetic.sqlite'); h = harness(t, { filename, closeOnFinish: false }); h.paid(); h.paid(); h.paid();
  const first = h.recorder({ batchSize: 1, minScanIntervalMs: 5000 }); assert.equal(first.reconcile().recorded, 1);
  h.store.close(); originalClosed = true;
  // Reopen after the original process closed: no financial calls are retried.
  reopened = createMembershipStore({ filename, now: h.now });
  const stats = createAnalyticsStore({ db: reopened.db, now: h.now });
  const record = createPaymentAnalytics({ db: reopened.db, store: stats, now: h.now, enabled: true, batchSize: 1 });
  assert.equal(record.reconcile().throttled, true); assert.equal(count(stats), 1);
  const position = () => reopened.db.prepare('SELECT cursor_rowid FROM analytics_payment_scan').get().cursor_rowid;
  h.tick(5000); assert.equal(record.reconcile().recorded, 1); assert.equal(position(), 2);
  h.tick(5000); assert.equal(record.reconcile().recorded, 1); assert.equal(count(stats), 3); assert.equal(position(), 3);
});

test('checkpoint never skips a failed row and atomic stamp+aggregate recovers exactly once', t => {
  const h = harness(t); h.paid(); h.paid(); h.paid(); let calls = 0;
  const record = h.recorder({ store: { retentionDays: 90, recordServer(...args) { if (++calls === 2) throw new Error('synthetic-failure'); return h.stats.recordServer(...args); } } });
  const first = record.reconcile(); assert.equal(first.recorded, 1); assert.equal(first.failed, 1); assert.equal(checkpoint(h).cursor_rowid, 1);
  assert.equal(stamps(h).length, 1); const second = record.reconcile(); assert.equal(second.recorded, 2); assert.equal(second.complete, true);
  assert.equal(stamps(h).length, 3); assert.equal(count(h.stats), 3); assert.equal(record.reconcile().recorded, 0);
});

test('a crash after durable aggregation but before checkpoint advancement replays safely', t => {
  const h = harness(t); h.paid(); h.paid(); const record = h.recorder(), before = h.financial();
  h.store.db.exec(`CREATE TEMP TRIGGER synthetic_checkpoint_crash BEFORE UPDATE OF cursor_rowid ON analytics_payment_scan
    WHEN NEW.cursor_rowid>0 BEGIN SELECT RAISE(ABORT,'synthetic interrupted checkpoint'); END;`);
  assert.throws(() => record.reconcile(), /synthetic interrupted/);
  assert.equal(checkpoint(h).cursor_rowid, 0); assert.equal(count(h.stats), 1); assert.equal(stamps(h).length, 1);
  h.store.db.exec('DROP TRIGGER synthetic_checkpoint_crash');
  const resumed = h.recorder().reconcile(); assert.equal(resumed.recorded, 1); assert.equal(resumed.skipped, 1); assert.equal(resumed.complete, true);
  assert.equal(count(h.stats), 2); assert.equal(stamps(h).length, 2); assert.equal(h.financial(), before);
});

test('bounded recovery configuration rejects unbounded scans and unsafe intervals', t => {
  const h = harness(t);
  for (const batchSize of [0, -1, 1.5, 1001, Infinity, '100']) assert.throws(() => h.recorder({ batchSize }), /批次配置/);
  for (const minScanIntervalMs of [-1, 1.5, 3600001, Infinity, '0']) assert.throws(() => h.recorder({ minScanIntervalMs }), /批次配置/);
  assert.equal(h.recorder({ batchSize: 1000 }).reconcile().complete, true);
});
