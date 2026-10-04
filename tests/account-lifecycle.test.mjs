import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMembershipStore, DAY, PERIOD } from '../server/membership-store.mjs';
import { createOperationsStore } from '../server/operations.mjs';
import { createAccountLifecycle, AccountLifecycleError, FRESH_AUTHENTICATION_MS } from '../server/account-lifecycle.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function harness(t, { filename } = {}) {
  let clock = Date.UTC(2026, 9, 4); const now = () => clock;
  const store = createMembershipStore({ filename, now }), operations = createOperationsStore({ membershipStore: store, now }), lifecycle = createAccountLifecycle({ store, now });
  t.after(() => store.close());
  function user({ kind = 'email', contact = `synthetic-${randomUUID()}@example.test` } = {}) {
    const id = randomUUID(); store.db.prepare('INSERT INTO users(id,email,created_at,auth_kind,label) VALUES(?,?,?,?,?)').run(id, contact, now(), kind, 'synthetic-private-label');
    if (kind !== 'local-demo') store.db.prepare('INSERT INTO account_identities(channel,identifier,user_id,created_at) VALUES(?,?,?,?)').run('email', contact, id, now());
    return { id, email: contact, auth_kind: kind, created_at: now() };
  }
  function session(owner, { fresh = true, expiresAt = now() + PERIOD } = {}) {
    const tokenHash = hash(randomBytes(32)); store.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash, owner.id, expiresAt);
    if (fresh) lifecycle.markAuthenticated(tokenHash); return tokenHash;
  }
  function order(owner, { paid = true } = {}) {
    const initial = store.createOrder(owner, { id: 'member-month', name: '月付会员', amountFen: 1900, currency: 'CNY', durationDays: 30 }, randomUUID(), 'fixture-merchant').order;
    if (paid) store.acceptPaymentEvent({ eventKey: randomBytes(32).toString('hex'), merchantId: 'fixture-merchant', providerOrderId: initial.provider_order_id, transactionId: `fixture_${randomUUID()}`, type: 'paid', amountFen: 1900, currency: 'CNY', occurredAt: now() });
    return store.ownedOrder(owner, initial.id);
  }
  function privateData(owner) {
    const guide = store.createGuide(owner, 'synthetic-private-guide-cipher'); store.updateGuide(owner, guide.id, 1, 'synthetic-private-version-cipher');
    store.updateProfile(owner, 0, 'synthetic-private-facts-cipher'); store.saveAnswer(owner, 'synthetic-private-answer-cipher');
    store.reserve(owner, 'synthetic-generation-request', hash('synthetic-private-question')); store.finish(owner.id, 'synthetic-generation-request', true, 'synthetic-private-result-cipher');
  }
  const remove = (owner, tokenHash, confirmation = '删除我的账号') => lifecycle.deleteAccount(owner, { tokenHash, confirmation });
  return { store, operations, lifecycle, user, session, order, privateData, remove, now, tick: ms => { clock += ms; } };
}
function errorCode(fn, code, status) { assert.throws(fn, error => error instanceof AccountLifecycleError && error.code === code && (status === undefined || error.status === status)); }

test('account lifecycle: persistent session and exact confirmation required; old sessions do not acquire freshness automatically', t => {
  const h = harness(t), owner = h.user(), old = h.session(owner, { fresh: false });
  assert.deepEqual(h.lifecycle.freshnessStatus(owner, { tokenHash: old }), { freshAuthentication: false, reauthenticationRequired: true, authenticatedAt: null, expiresAt: null });
  errorCode(() => h.remove(owner, old), 'reauthentication_required', 403);
  errorCode(() => h.remove(owner, 'invalid-token'), 'login_required', 401);
  const fresh = h.session(owner), other = h.user(), otherToken = h.session(other);
  errorCode(() => h.remove(owner, otherToken), 'login_required', 401);
  for (const confirmation of [undefined, '', '删除我的账号 ', ' 删除我的账号', '删除账号']) errorCode(() => h.lifecycle.deleteAccount(owner, { tokenHash: fresh, confirmation }), 'confirmation_required', 400);
  assert.equal(h.lifecycle.accountStatus(owner, { tokenHash: fresh }).canDelete, true);
  assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(owner.id).auth_kind, 'email');
});

test('account lifecycle: freshness expires at exactly ten minutes and cannot be borrowed from another device/session', t => {
  const h = harness(t), owner = h.user(), fresh = h.session(owner), oldDevice = h.session(owner, { fresh: false });
  assert.equal(h.lifecycle.freshnessStatus(owner, { tokenHash: fresh }).freshAuthentication, true);
  errorCode(() => h.remove(owner, oldDevice), 'reauthentication_required');
  h.tick(FRESH_AUTHENTICATION_MS - 1); assert.equal(h.lifecycle.freshnessStatus(owner, { tokenHash: fresh }).freshAuthentication, true);
  h.tick(1); assert.equal(h.lifecycle.freshnessStatus(owner, { tokenHash: fresh }).freshAuthentication, false); errorCode(() => h.remove(owner, fresh), 'reauthentication_required');
  h.lifecycle.markAuthenticated(fresh); assert.equal(h.lifecycle.freshnessStatus(owner, { tokenHash: fresh }).freshAuthentication, true);
  h.store.db.prepare('UPDATE account_session_freshness SET authenticated_at=? WHERE token_hash=?').run(h.now() + 1, fresh); errorCode(() => h.remove(owner, fresh), 'reauthentication_required');
});

test('account lifecycle: rejects demo, expired/deleted/nonexistent sessions and forged input user kind', t => {
  const h = harness(t), demo = h.user({ kind: 'local-demo' }), demoToken = h.session(demo, { fresh: false });
  errorCode(() => h.lifecycle.markAuthenticated(demoToken), 'demo_account_forbidden', 403); errorCode(() => h.remove({ ...demo, auth_kind: 'email' }, demoToken), 'demo_account_forbidden', 403);
  const owner = h.user(), expired = h.session(owner, { fresh: false, expiresAt: h.now() }); errorCode(() => h.lifecycle.markAuthenticated(expired), 'login_required');
  const missing = hash('synthetic-missing-session'); errorCode(() => h.lifecycle.markAuthenticated(missing), 'login_required');
  const token = h.session(owner); h.store.db.prepare("UPDATE users SET auth_kind='deleted' WHERE id=?").run(owner.id); errorCode(() => h.remove(owner, token), 'login_required');
});

test('account lifecycle: all financial and in-flight blockers stop deletion without removing anything', async t => {
  const cases = [
    ['active_membership', h => { h.order(h.owner); }],
    ['active_membership', h => { const order = h.order(h.owner); h.store.db.prepare('UPDATE entitlements SET starts_at=?,ends_at=? WHERE order_id=?').run(h.now() + 31 * DAY, h.now() + 61 * DAY, order.id); }],
    ['unsettled_orders', h => { h.order(h.owner, { paid: false }); }],
    ['unsettled_orders', h => { const order = h.order(h.owner, { paid: false }); h.store.pendingOrder(order.id, 'https://fixture.test/checkout'); h.tick(DAY); }],
    ['refund_pending', h => { const order = h.order(h.owner); h.tick(31 * DAY); h.store.db.prepare("UPDATE orders SET refund_state='refund_pending' WHERE id=?").run(order.id); }],
    ['open_refund_request', h => { const order = h.order(h.owner); h.operations.submitRefundRequest(h.owner, { orderId: order.id, reason: 'other' }); h.tick(31 * DAY); }],
    ['generation_in_progress', h => { h.store.reserve(h.owner, 'synthetic-active-generation', hash('synthetic-private-question')); }],
  ];
  for (let i = 0; i < cases.length; i++) await t.test(`${cases[i][0]} fixture ${i}`, sub => {
    const h = harness(sub); h.owner = h.user(); const untouched = h.user(); h.privateData(h.owner); h.privateData(untouched); cases[i][1](h); const token = h.session(h.owner);
    const before = JSON.stringify(h.store.db.prepare('SELECT * FROM users').all()), counts = h.store.db.prepare('SELECT COUNT(*) AS n FROM guides').get().n;
    errorCode(() => h.remove(h.owner, token), cases[i][0], 409); assert.equal(JSON.stringify(h.store.db.prepare('SELECT * FROM users').all()), before); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guides').get().n, counts); assert.ok(h.store.sessionUser(token));
    assert.ok(h.lifecycle.accountStatus(h.owner, { tokenHash: token }).deletionBlockers.includes(cases[i][0]));
  });
});

test('account lifecycle: failed/expired local orders cannot create deleted tombstones before a late verified payment', async t => {
  for (const status of ['failed', 'expired']) await t.test(status, sub => {
    const h = harness(sub), owner = h.user(), order = h.order(owner, { paid: false }); h.privateData(owner);
    if (status === 'failed') h.store.failOrder(order.id);
    else { h.tick(1800001); h.store.expireOrder(order.id); }
    assert.equal(h.store.ownedOrder(owner, order.id).status, status);
    const token = h.session(owner), before = JSON.stringify(h.store.db.prepare('SELECT * FROM users WHERE id=?').get(owner.id));
    assert.ok(h.lifecycle.accountStatus(owner, { tokenHash: token }).deletionBlockers.includes('unsettled_orders'));
    errorCode(() => h.remove(owner, token), 'unsettled_orders', 409);
    assert.equal(JSON.stringify(h.store.db.prepare('SELECT * FROM users WHERE id=?').get(owner.id)), before);
    assert.equal(h.store.sessionUser(token).id, owner.id); assert.equal(h.store.guides(owner).length, 1);
    // 合成受信已验支付事实，不调用真实网关。迟到付款仍归属可登录的原用户。
    const paid = h.store.acceptPaymentEvent({ eventKey: randomBytes(32).toString('hex'), merchantId: 'fixture-merchant', providerOrderId: order.provider_order_id,
      transactionId: `fixture_late_${randomUUID()}`, type: 'paid', amountFen: 1900, currency: 'CNY', occurredAt: h.now() });
    assert.equal(paid.status, 'paid'); assert.equal(paid.user_id, owner.id); assert.equal(h.store.sessionUser(token).id, owner.id);
    assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(owner.id).auth_kind, 'email');
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements WHERE user_id=?').get(owner.id).n, 1);
    errorCode(() => h.remove(owner, token), 'active_membership', 409);
  });
});

test('account lifecycle: deletes all private material and all sessions, retains unchanged financial records and a pseudonymous tombstone', t => {
  const h = harness(t), owner = h.user(), other = h.user(), paid = h.order(owner); h.tick(31 * DAY); h.privateData(owner); h.privateData(other);
  h.store.db.prepare('INSERT INTO account_identities(channel,identifier,user_id,created_at) VALUES(?,?,?,?)').run('phone', '+8613800000000', owner.id, h.now());
  h.store.issueCode({ channel: 'email', identifier: owner.email }, 'synthetic-digest', 'synthetic-salt', 'synthetic-client');
  h.store.issueCode({ channel: 'phone', identifier: '+8613800000000' }, 'synthetic-digest', 'synthetic-salt', 'synthetic-client');
  h.store.db.prepare('INSERT INTO codes(email,digest,salt,expires_at,created_at,channel,purpose,target_user_id,identifier) VALUES(?,?,?,?,?,?,?,?,?)').run(`auth:email:link:${owner.id}:synthetic-pending@example.test`, 'synthetic-digest', 'synthetic-salt', h.now() + DAY, h.now(), 'email', 'link', owner.id, 'synthetic-pending@example.test');
  h.store.issueCode({ channel: 'email', identifier: other.email }, 'synthetic-other-digest', 'synthetic-salt', 'synthetic-client');
  const first = h.session(owner), second = h.session(owner), otherSession = h.session(other);
  const financial = JSON.stringify({ orders: h.store.db.prepare('SELECT * FROM orders').all(), events: h.store.db.prepare('SELECT * FROM payment_events').all(), ledger: h.store.db.prepare('SELECT * FROM quota_ledger').all() });
  assert.deepEqual(h.remove(owner, first), { deleted: true, sessionsRevoked: true, privateContentDeleted: true, financialRecordsRetained: true });
  const tombstone = h.store.db.prepare('SELECT * FROM users WHERE id=?').get(owner.id); assert.equal(tombstone.email, `deleted-${owner.id}@local.invalid`); assert.equal(tombstone.auth_kind, 'deleted'); assert.equal(tombstone.label, null);
  for (const table of ['guides', 'profiles', 'saved_answers', 'generations', 'quota_periods', 'account_identities', 'sessions', 'entitlements']) assert.equal(h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(owner.id).n, 0, table);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guide_versions').get().n, 2, 'other account versions survive');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM codes').get().n, 1); assert.equal(h.store.db.prepare('SELECT identifier FROM codes').get().identifier, other.email);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM account_session_freshness').get().n, 1); assert.equal(h.store.sessionUser(first), null); assert.equal(h.store.sessionUser(second), null); assert.equal(h.store.sessionUser(otherSession).id, other.id);
  assert.equal(JSON.stringify({ orders: h.store.db.prepare('SELECT * FROM orders').all(), events: h.store.db.prepare('SELECT * FROM payment_events').all(), ledger: h.store.db.prepare('SELECT * FROM quota_ledger').all() }), financial);
  assert.equal(h.store.ownedOrder(owner, paid.id).status, 'paid'); assert.equal(h.operations.listUsers({ authentication: 'deleted' }).items[0].id, owner.id); assert.equal(h.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('account lifecycle: closed refunds and expired reservations allow deletion; no old entitlement is revived', t => {
  const h = harness(t), owner = h.user(), order = h.order(owner); let ticket = h.operations.submitRefundRequest(owner, { orderId: order.id, reason: 'other' }).ticket;
  ticket = h.operations.updateRefundTicket(ticket.id, { revision: ticket.revision, state: 'cancelled' }); h.tick(31 * DAY);
  h.store.reserve(owner, 'synthetic-expiring-generation', hash('synthetic-private-question')); h.tick(120001); const token = h.session(owner); h.remove(owner, token);
  assert.equal(h.operations.listRefundTickets().items[0].state, 'cancelled'); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM generations WHERE user_id=?').get(owner.id).n, 0); assert.equal(h.store.ownedOrder(owner, order.id).status, 'paid');
});

test('account lifecycle: original identity becomes a new account on next synthetic login while old sessions stay revoked', t => {
  const h = harness(t), owner = h.user(), oldToken = h.session(owner); h.remove(owner, oldToken);
  assert.equal(h.store.identityOwner({ channel: 'email', identifier: owner.email }), null);
  // 合成验证码散列/验证回调，仅验证 store 的身份生命周期；无发送、真实 OTP 或网络。
  h.store.issueCode(owner.email, 'synthetic-login-digest', 'synthetic-login-salt', 'synthetic-client'); const newToken = hash('synthetic-new-token');
  const newUser = h.store.verifyCode(owner.email, () => true, 'synthetic-client', newToken);
  assert.notEqual(newUser.id, owner.id); assert.equal(h.store.sessionUser(oldToken), null); assert.equal(h.store.sessionUser(newToken).id, newUser.id); assert.equal(h.store.me(newUser).membership.planId, 'free'); assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(owner.id).auth_kind, 'deleted');
});

test('account lifecycle: unexpected DB failure rolls back all deletion and never leaks the underlying error', t => {
  const h = harness(t), owner = h.user(); h.privateData(owner); const token = h.session(owner);
  const before = JSON.stringify({ user: h.store.db.prepare('SELECT * FROM users').all(), guides: h.store.db.prepare('SELECT * FROM guides').all(), versions: h.store.db.prepare('SELECT * FROM guide_versions').all(), sessions: h.store.db.prepare('SELECT * FROM sessions').all() });
  h.store.db.exec("CREATE TRIGGER fixture_delete_failure BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT,'synthetic-private-deletion-error'); END;");
  assert.throws(() => h.remove(owner, token), error => error instanceof AccountLifecycleError && error.status === 503 && !error.message.includes('synthetic-private'));
  assert.equal(JSON.stringify({ user: h.store.db.prepare('SELECT * FROM users').all(), guides: h.store.db.prepare('SELECT * FROM guides').all(), versions: h.store.db.prepare('SELECT * FROM guide_versions').all(), sessions: h.store.db.prepare('SELECT * FROM sessions').all() }), before);
  assert.equal(h.lifecycle.freshnessStatus(owner, { tokenHash: token }).freshAuthentication, true);
});

test('account lifecycle: freshness is persistent, session FK cascade works, wrong application DB stays untouched', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-account-lifecycle-test-'));
  t.after(() => { assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(directory.startsWith(join(tmpdir(), 'better-life-account-lifecycle-test-'))); rmSync(directory, { recursive: true, force: true }); });
  const filename = join(directory, 'fixture.sqlite'), timestamp = Date.UTC(2026, 9, 4), tokenHash = hash('synthetic-persistent-token'), id = randomUUID();
  const first = createMembershipStore({ filename, now: () => timestamp }); first.db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(id, 'synthetic-persist@example.test', timestamp); first.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash, id, timestamp + DAY); createAccountLifecycle({ store: first, now: () => timestamp }).markAuthenticated(tokenHash); first.close();
  const second = createMembershipStore({ filename, now: () => timestamp }); try { const life = createAccountLifecycle({ store: second, now: () => timestamp + 1000 }); assert.equal(life.freshnessStatus({ id }, { tokenHash }).freshAuthentication, true); second.revokeSession(tokenHash); assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM account_session_freshness').get().n, 0); assert.equal(second.db.prepare('PRAGMA foreign_key_check').all().length, 0); } finally { second.close(); }
  const unrelated = new DatabaseSync(':memory:'); try { unrelated.exec('CREATE TABLE other_app(id INTEGER)'); assert.throws(() => createAccountLifecycle({ store: { db: unrelated } }), /已验证/); assert.equal(unrelated.prepare("SELECT name FROM sqlite_schema WHERE name='account_session_freshness'").get(), undefined); } finally { unrelated.close(); }
});
