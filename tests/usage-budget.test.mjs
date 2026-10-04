import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createUsageBudget, usageBudgetConfig } from '../server/usage-budget.mjs';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createEncryptedBackup, checkEncryptedBackup } from '../scripts/membership-backup.mjs';
import { randomBytes } from 'node:crypto';

// Synthetic rates are arithmetic fixtures, not current DeepSeek prices.
const env = { QA_BUDGET_DAILY_CNY: '1', QA_BUDGET_MONTHLY_CNY: '10', QA_PRICE_INPUT_CNY_PER_MILLION: '1', QA_PRICE_OUTPUT_CNY_PER_MILLION: '2' };
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-cost-test-'));
  const budget = createUsageBudget({ env, filename: join(directory, 'budget.sqlite'), ...options });
  t.after(() => { budget.close(); rmSync(directory, { recursive: true, force: true }); });
  return budget;
}

test('cost budget: absent prices do not invent real cost, partial or unsafe configuration fails closed', () => {
  assert.deepEqual(usageBudgetConfig({}), { configured: false, currency: 'CNY', timezone: 'Asia/Shanghai' });
  const disabled = createUsageBudget(); assert.equal(disabled.reserve({ inputTokens: 10, maxOutputTokens: 10 }), null); assert.equal(disabled.snapshot().configured, false);
  for (const value of ['', '0', '-1', 'NaN', '1e2', '1.1234567', ' 1', '1000000000', 'example-secret']) assert.throws(() => usageBudgetConfig({ ...env, QA_BUDGET_DAILY_CNY: value }), /预算配置/);
  assert.throws(() => usageBudgetConfig({ QA_BUDGET_DAILY_CNY: '1' }), /预算配置/);
  assert.throws(() => usageBudgetConfig({ ...env, QA_BUDGET_MONTHLY_CNY: '0.5' }), /预算配置/);
});

test('cost budget: reserves worst case, charges reported usage, returns room, and settlement is idempotent', t => {
  const budget = fixture(t), reservation = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 200_000 });
  assert.equal(reservation.reservedMicroCny, 500_000);
  assert.equal(budget.snapshot().day.reservedMicroCny, 500_000);
  assert.equal(budget.markDispatched(reservation.id), true);
  assert.deepEqual(budget.settle(reservation.id, { usage: { prompt_tokens: 10_000, completion_tokens: 20_000, total_tokens: 30_000 } }), { settled: true, conservative: false, chargedMicroCny: 50_000, overrun: false });
  assert.equal(budget.settle(reservation.id, { usage: { prompt_tokens: 1, completion_tokens: 1 } }), false);
  assert.equal(budget.fail(reservation.id), false);
  const state = budget.snapshot(); assert.equal(state.day.reservedMicroCny, 0); assert.equal(state.day.chargedMicroCny, 50_000); assert.equal(state.day.remainingMicroCny, 950_000);
});

test('cost budget: atomic global/day/month ceilings and 80% admin warnings count outstanding reservations', t => {
  const budget = fixture(t);
  const reservation = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 350_000 });
  assert.equal(budget.snapshot().state, 'warning');
  assert.equal(budget.snapshot().day.alert, true);
  assert.throws(() => budget.reserve({ inputTokens: 100_000, maxOutputTokens: 51_000 }), error => error.code === 'budget_exhausted');
  const final = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 50_000 });
  assert.equal(budget.snapshot().state, 'blocked');
  assert.throws(() => budget.reserve({ inputTokens: 1, maxOutputTokens: 1 }), error => error.code === 'budget_exhausted');
  assert.equal(budget.fail(reservation.id).released, true); assert.equal(budget.fail(final.id).released, true); assert.equal(budget.snapshot().state, 'normal');
});

test('cost budget: multiple connections cannot reserve past the same persistent ceiling', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-budget-shared-')), filename = join(directory, 'budget.sqlite');
  const first = createUsageBudget({ env, filename }), second = createUsageBudget({ env, filename });
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  first.reserve({ inputTokens: 100_000, maxOutputTokens: 250_000 });
  assert.throws(() => second.reserve({ inputTokens: 100_000, maxOutputTokens: 200_000 }), error => error.code === 'budget_exhausted');
  assert.equal(second.snapshot().day.reservedMicroCny, 600_000);
});

test('cost budget: pre-dispatch errors release, timeout/cancellation/network/invalid usage after dispatch conservatively charge', t => {
  const budget = fixture(t);
  const before = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 100_000 });
  assert.deepEqual(budget.fail(before.id), { released: true, conservative: false, chargedMicroCny: 0 });
  assert.equal(budget.markDispatched(before.id), false);
  const after = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 100_000 }); budget.markDispatched(after.id);
  assert.equal(budget.fail(after.id).chargedMicroCny, 300_000); assert.equal(budget.fail(after.id), false);
  const missing = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 100_000 }); budget.markDispatched(missing.id);
  assert.equal(budget.settle(missing.id).conservative, true);
  const invalid = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 100_000 }); budget.markDispatched(invalid.id);
  assert.equal(budget.settle(invalid.id, { usage: { prompt_tokens: 1, completion_tokens: -1 } }).conservative, true);
  assert.equal(budget.snapshot().day.conservativeRequests, 3); assert.equal(budget.snapshot().day.chargedMicroCny, 900_000);
  // A late verified usage result can replace, but not silently delete, uncertain accounting.
  budget.settle(after.id, { usage: { prompt_tokens: 1, completion_tokens: 1 } }); assert.equal(budget.snapshot().day.conservativeRequests, 2);
});

test('cost budget: restart keeps pending charges, expires unsent requests but retains dispatched worst-case cost', t => {
  let timestamp = Date.parse('2026-10-04T00:00:00Z');
  const directory = mkdtempSync(join(tmpdir(), 'better-life-budget-restart-')), filename = join(directory, 'budget.sqlite');
  let budget = createUsageBudget({ env, filename, now: () => timestamp });
  t.after(() => { budget.close(); rmSync(directory, { recursive: true, force: true }); });
  const sent = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 100_000 }); budget.markDispatched(sent.id);
  budget.reserve({ inputTokens: 100_000, maxOutputTokens: 100_000 }); budget.close();
  budget = createUsageBudget({ env, filename, now: () => timestamp }); assert.equal(budget.snapshot().day.reservedMicroCny, 600_000);
  timestamp += 120_001; assert.equal(budget.cleanup(), 2);
  const state = budget.snapshot(); assert.equal(state.day.reservedMicroCny, 0); assert.equal(state.day.chargedMicroCny, 300_000); assert.equal(state.day.conservativeRequests, 1);
});

test('cost budget: Beijing calendar rollover preserves month total and rechecks a midnight dispatch', t => {
  let timestamp = Date.parse('2026-10-04T15:59:50Z');
  const budget = fixture(t, { now: () => timestamp, env: { ...env, QA_BUDGET_MONTHLY_CNY: '1' } });
  const first = budget.reserve({ inputTokens: 100_000, maxOutputTokens: 350_000 }); budget.markDispatched(first.id); budget.settle(first.id, { usage: { prompt_tokens: 100_000, completion_tokens: 350_000 } });
  const crossing = budget.reserve({ inputTokens: 0, maxOutputTokens: 50_000 });
  timestamp = Date.parse('2026-10-04T16:00:01Z'); assert.equal(budget.markDispatched(crossing.id), true);
  assert.equal(budget.snapshot().day.period, '2026-10-05'); assert.equal(budget.snapshot().day.reservedMicroCny, 100_000); assert.equal(budget.snapshot().month.committedMicroCny, 900_000);
  assert.throws(() => budget.reserve({ inputTokens: 1, maxOutputTokens: 50_000 }), error => error.code === 'budget_exhausted');
});

test('cost budget: usage above declared bounds is charged, flagged, and not capped to hide incurred cost', t => {
  const budget = fixture(t), reservation = budget.reserve({ inputTokens: 1, maxOutputTokens: 1 }); budget.markDispatched(reservation.id);
  assert.equal(budget.settle(reservation.id, { usage: { prompt_tokens: 400_000, completion_tokens: 400_000 } }).overrun, true);
  assert.equal(budget.snapshot().day.chargedMicroCny, 1_200_000); assert.equal(budget.snapshot().day.overrunRequests, 1); assert.equal(budget.snapshot().state, 'blocked');
});

test('cost budget: fractional rates round up per request and invalid token counts fail before persistence', t => {
  const budget = fixture(t, { env: { ...env, QA_PRICE_INPUT_CNY_PER_MILLION: '0.000001', QA_PRICE_OUTPUT_CNY_PER_MILLION: '0.000001' } });
  assert.equal(budget.reserve({ inputTokens: 1, maxOutputTokens: 1 }).reservedMicroCny, 1);
  for (const inputTokens of [-1, 1.5, Infinity, 10_000_001]) assert.throws(() => budget.reserve({ inputTokens, maxOutputTokens: 1 }), /预算配置/);
});

test('cost budget: unrelated databases are rejected without mutation or leaking filenames/configuration', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-budget-brand-')), filename = join(directory, 'unrelated.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(filename); db.exec('CREATE TABLE other_app(id INTEGER); INSERT INTO other_app VALUES(7)'); db.close();
  assert.throws(() => createUsageBudget({ env, filename }), error => !error.message.includes(filename));
  const read = new DatabaseSync(filename, { readOnly: true }); try { assert.equal(read.prepare('SELECT id FROM other_app').get().id, 7); assert.equal(read.prepare("SELECT name FROM sqlite_schema WHERE name='usage_budget_requests'").get(), undefined); } finally { read.close(); }
});

test('cost budget: shared membership DB lifecycle and encrypted backup include content-free ledger', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-budget-backup-')), filename = join(directory, 'membership.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createMembershipStore({ filename });
  const budget = createUsageBudget({ db: store.db, env }); const reservation = budget.reserve({ inputTokens: 10_000, maxOutputTokens: 10_000 }); budget.markDispatched(reservation.id); budget.settle(reservation.id, { usage: { prompt_tokens: 1_000, completion_tokens: 1_000 } });
  budget.close(); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM usage_budget_requests').get().n, 1);
  const columns = store.db.prepare('PRAGMA table_info(usage_budget_requests)').all().map(column => column.name);
  assert.equal(columns.some(column => /question|answer|secret|user|email|phone/i.test(column)), false);
  const authSecret = randomBytes(48).toString('base64url'), encryptionKey = randomBytes(32).toString('base64url'), destination = join(directory, 'snapshot.blbk'), restored = join(directory, 'restored.sqlite');
  try {
    await createEncryptedBackup({ filename, destination, authSecret, encryptionKey });
    await checkEncryptedBackup({ filename: destination, workDirectory: directory, restoreDestination: restored, authSecret, encryptionKey });
    const read = new DatabaseSync(restored, { readOnly: true }); try { assert.equal(read.prepare('SELECT charged_micro FROM usage_budget_requests').get().charged_micro, 3_000); } finally { read.close(); }
    assert.ok(!readFileSync(destination).includes(Buffer.from(reservation.id)));
  } finally { store.close(); }
});
