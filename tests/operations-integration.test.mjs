import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createMembershipStore, DAY, hash } from '../server/membership-store.mjs';
import { createMembershipHandler } from '../server/membership.mjs';
import { createApiRuntime } from '../server/membership-runtime.mjs';
import { createOperationsStore } from '../server/operations.mjs';

// 测试只用内存/临时合成数据库和注入 fake transport，不读取 env/真实私库，
// 不发送真实 OTP、调用模型、访问外部网络、收款或退款。
const BASE = 'https://better-life.integration.test';
const freshSecret = () => randomBytes(48).toString('base64url');
const entry = { id: '2-13', chapter: 2, number: 13, title: '保持规律作息', summary: '规律作息。', cost: '少', benefit: '好', sources: '合成原书引用', notes: '合成测试内容。' };
const corpus = { source: { snapshotDate: '2026-10-03', repository: 'https://github.com/eternity4719/HowToLiveBetter', revision: 'synthetic-revision' }, chapters: [{ id: 2, title: '睡眠', file: '02-睡眠.md', entries: [entry] }] };
function harness(t, options = {}) {
  let clock = Date.UTC(2026, 9, 4); const now = () => clock, sent = [];
  const store = createMembershipStore({ now }), operationsStore = createOperationsStore({ membershipStore: store, now });
  t.after(() => store.close());
  const handler = createMembershipHandler({ env: { NODE_ENV: 'test', MEMBERSHIP_AUTH_SECRET: freshSecret(), MEMBERSHIP_APP_ORIGIN: BASE }, store, now, operationsStore,
    sender: async value => { sent.push({ channel: 'email', ...value }); }, phoneSender: async value => { sent.push({ channel: 'phone', ...value }); }, getCorpus: options.getCorpus || (() => corpus), paymentProvider: options.paymentProvider || null, getClientId: () => 'synthetic-integration-client' });
  const request = (path, { method = 'GET', body, cookie, origin = BASE, headers = {} } = {}) => handler(new Request(`${BASE}${path}`, { method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  async function login(email = `synthetic-${randomUUID()}@example.test`, cookie) {
    const code = await request('/api/auth/code', { method: 'POST', body: { email } }); assert.equal(code.status, 200);
    const response = await request('/api/auth/verify', { method: 'POST', cookie, body: { email, code: sent.at(-1).code } }); assert.equal(response.status, 200);
    const nextCookie = response.headers.get('set-cookie').split(';')[0], data = await response.json();
    return { email, cookie: nextCookie, tokenHash: hash(nextCookie.split('=')[1]), data, user: store.db.prepare('SELECT * FROM users WHERE id=?').get(data.user.id) };
  }
  function paidOrder(owner) {
    const order = store.createOrder(owner.user, { id: 'member-month', name: '月付会员', amountFen: 1900, currency: 'CNY', durationDays: 30 }, randomUUID(), 'synthetic-merchant').order;
    store.acceptPaymentEvent({ eventKey: randomBytes(32).toString('hex'), merchantId: 'synthetic-merchant', providerOrderId: order.provider_order_id, transactionId: `synthetic_${randomUUID()}`, type: 'paid', amountFen: 1900, currency: 'CNY', occurredAt: now() });
    return store.ownedOrder(owner.user, order.id);
  }
  const remove = (cookie, body = { confirmation: '删除我的账号' }, options = {}) => request('/api/account', { method: 'DELETE', cookie, body, ...options });
  return { store, operationsStore, sent, handler, request, login, paidOrder, remove, now, tick: ms => { clock += ms; } };
}
function deferred() { let resolve; const promise = new Promise(complete => { resolve = complete; }); return { promise, resolve }; }
function delayedBody(t, h, path, { method, cookie, body }) {
  const started = deferred(), blocked = deferred(), abort = new AbortController(); let controller, resumed = false;
  const stream = new ReadableStream({ start(value) { controller = value; }, pull() { started.resolve(); return blocked.promise; }, cancel() { blocked.resolve(); } });
  const response = h.handler(new Request(`${BASE}${path}`, { method, headers: { origin: BASE, cookie, 'content-type': 'application/json' }, body: stream, duplex: 'half', signal: abort.signal }));
  t.after(() => { abort.abort(); blocked.resolve(); });
  const resume = () => { if (resumed) return; resumed = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); blocked.resolve(); };
  return { started: started.promise, response, resume };
}
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-operations-integration-test-'));
  t.after(() => { assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(directory.startsWith(join(tmpdir(), 'better-life-operations-integration-test-'))); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test('operations integration: successful synthetic OTP login records fresh auth; existing old session and missing/forged cookies cannot delete', async t => {
  const h = harness(t), account = await h.login();
  const status = await h.request('/api/account/status', { cookie: account.cookie }); assert.equal(status.status, 200);
  const view = await status.json(); assert.equal(view.freshAuthentication, true); assert.equal(view.reauthenticationRequired, false); assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM account_session_freshness WHERE token_hash=?').get(account.tokenHash).n, 1);
  h.store.db.prepare('DELETE FROM account_session_freshness WHERE token_hash=?').run(account.tokenHash);
  const denied = await h.remove(account.cookie); assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'reauthentication_required');
  const old = await (await h.request('/api/account/status', { cookie: account.cookie })).json(); assert.equal(old.freshAuthentication, false);
  for (const cookie of [undefined, `better_life_session=${randomBytes(32).toString('base64url')}`]) assert.equal((await h.remove(cookie)).status, 401);
  assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(account.user.id).auth_kind, 'email');
});

test('operations integration: exact confirmation, target injection and unknown fields reject; successful deletion clears cookie and all sessions', async t => {
  const h = harness(t), alice = await h.login(), bob = await h.login();
  const privateProfile = await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 0, facts: [{ id: 'synthetic-fact', label: '合成情况', value: 'synthetic-private-fact-value' }] } }); assert.equal(privateProfile.status, 200);
  const guide = await h.request('/api/guides', { method: 'POST', cookie: alice.cookie, body: { title: '合成指南', topic: '健康', content: 'synthetic-private-guide-body', sourceIds: ['2-13'], factIds: [], tasks: [] } }); assert.equal(guide.status, 201);
  for (const confirmation of ['', '删除我的账号 ', '删除账号']) assert.equal((await h.remove(alice.cookie, { confirmation })).status, 400);
  assert.equal((await h.remove(bob.cookie, { confirmation: '删除我的账号', userId: alice.user.id })).status, 400, 'another user cannot target Alice');
  assert.equal((await h.remove(alice.cookie, { confirmation: '删除我的账号', paid: true })).status, 400);
  h.tick(60000); const secondDevice = await h.login(alice.email); assert.equal(secondDevice.user.id, alice.user.id);
  const response = await h.remove(secondDevice.cookie); assert.equal(response.status, 200); assert.equal((await response.json()).deleted, true);
  const cleared = response.headers.get('set-cookie'); assert.match(cleared, /^better_life_session=;/); assert.match(cleared, /Max-Age=0/); assert.match(cleared, /HttpOnly/);
  for (const cookie of [alice.cookie, secondDevice.cookie]) assert.equal((await h.request('/api/account/status', { cookie })).status, 401);
  assert.equal((await (await h.request('/api/me', { cookie: alice.cookie })).json()).user, null);
  assert.equal((await h.request('/api/profile', { cookie: alice.cookie })).status, 401);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guides WHERE user_id=?').get(alice.user.id).n, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id=?').get(alice.user.id).n, 0);
  assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(alice.user.id).auth_kind, 'deleted'); assert.equal((await (await h.request('/api/me', { cookie: bob.cookie })).json()).user.id, bob.user.id);
  const returning = await h.login(alice.email); assert.notEqual(returning.user.id, alice.user.id); assert.equal(returning.data.membership.planId, 'free'); assert.equal(h.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('operations integration: fresh auth expires through API and cannot be refreshed by status reads', async t => {
  const h = harness(t), account = await h.login(); h.tick(600000);
  const status = await (await h.request('/api/account/status', { cookie: account.cookie })).json(); assert.equal(status.freshAuthentication, false); assert.equal(status.reauthenticationRequired, true);
  assert.equal((await h.remove(account.cookie)).status, 403); assert.equal((await h.remove(account.cookie)).status, 403);
  const fresh = await h.login(account.email, account.cookie); assert.equal((await (await h.request('/api/account/status', { cookie: fresh.cookie })).json()).freshAuthentication, true);
  assert.equal((await h.request('/api/account/status', { cookie: account.cookie })).status, 401, 'normal login rotates old session');
});

test('operations integration: old-cookie binding attacks fail, original identity reauth permits binding, and binding never grants deletion freshness', async t => {
  const h = harness(t), account = await h.login(); h.store.db.prepare('DELETE FROM account_session_freshness WHERE token_hash=?').run(account.tokenHash);
  const phone = '13800138000';
  for (const [path, body] of [['auth/link/code', { phone }], ['auth/link/verify', { phone, code: '123456' }]]) {
    const rejected = await h.request(`/api/${path}`, { method: 'POST', cookie: account.cookie, body }); assert.equal(rejected.status, 403); assert.equal((await rejected.json()).error.code, 'reauthentication_required');
  }
  assert.equal(h.sent.filter(item => item.channel === 'phone').length, 0, 'stolen old cookie cannot send attacker-channel OTP');
  assert.equal(h.store.identityOwner({ channel: 'phone', identifier: '+8613800138000' }), null); assert.equal((await h.remove(account.cookie)).status, 403);
  h.tick(60000); const reauthenticated = await h.login(account.email, account.cookie); assert.equal(reauthenticated.user.id, account.user.id);
  assert.equal((await (await h.request('/api/account/status', { cookie: reauthenticated.cookie })).json()).freshAuthentication, true);
  const sent = await h.request('/api/auth/link/code', { method: 'POST', cookie: reauthenticated.cookie, body: { phone } }); assert.equal(sent.status, 200); assert.equal(h.sent.at(-1).channel, 'phone');
  const linked = await h.request('/api/auth/link/verify', { method: 'POST', cookie: reauthenticated.cookie, body: { phone, code: h.sent.at(-1).code } }); assert.equal(linked.status, 200);
  const cookie = linked.headers.get('set-cookie').split(';')[0]; assert.equal((await linked.json()).user.id, account.user.id);
  const status = await (await h.request('/api/account/status', { cookie })).json(); assert.equal(status.freshAuthentication, false); assert.equal(status.reauthenticationRequired, true);
  const denied = await h.remove(cookie); assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'reauthentication_required');
  assert.equal((await h.request('/api/account/status', { cookie: account.cookie })).status, 401); assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(account.user.id).auth_kind, 'email');
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: account.cookie, body: { phone } })).status, 401); assert.equal((await h.remove(account.cookie)).status, 401);
  h.tick(60000); const normal = await h.login(account.email, cookie); assert.equal(normal.user.id, account.user.id); assert.equal((await (await h.request('/api/account/status', { cookie: normal.cookie })).json()).freshAuthentication, true);
  assert.equal((await h.request('/api/account/status', { cookie })).status, 401);
});

test('operations integration: profile body arriving after concurrent account deletion is rejected and cannot recreate private rows', async t => {
  const h = harness(t), account = await h.login();
  const late = delayedBody(t, h, '/api/profile', { method: 'PATCH', cookie: account.cookie, body: { revision: 0, facts: [{ id: 'synthetic-late-fact', label: '合成情况', value: 'synthetic-private-late-profile' }] } });
  await late.started; assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id=?').get(account.user.id).n, 0);
  assert.equal((await h.remove(account.cookie)).status, 200); late.resume(); const response = await late.response; assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'login_required');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id=?').get(account.user.id).n, 0); assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(account.user.id).auth_kind, 'deleted'); assert.equal(h.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('operations integration: guide corpus validation delayed across account deletion cannot recreate a guide or version', async t => {
  const entered = deferred(), release = deferred(), h = harness(t, { getCorpus: () => { entered.resolve(); return release.promise; } }), account = await h.login();
  t.after(() => release.resolve(corpus));
  const late = h.request('/api/guides', { method: 'POST', cookie: account.cookie, body: { title: '合成迟到指南', topic: '健康', content: 'synthetic-private-late-guide', sourceIds: ['2-13'], factIds: [], tasks: [] } });
  await entered.promise; assert.equal((await h.remove(account.cookie)).status, 200); release.resolve(corpus);
  const response = await late; assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'login_required');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guides WHERE user_id=?').get(account.user.id).n, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guide_versions').get().n, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id=?').get(account.user.id).n, 0);
});

test('operations integration: order request body delayed until after deletion creates no order and never calls mock checkout', async t => {
  let checkoutCalls = 0;
  const paymentProvider = { merchantId: 'synthetic-late-merchant', creationEnabled: true, createCheckout: async () => { checkoutCalls++; return { checkoutUrl: 'https://checkout.synthetic.test/fixture' }; }, verifyPayment: async () => ({ status: 'pending' }) };
  const h = harness(t, { paymentProvider }), account = await h.login();
  const late = delayedBody(t, h, '/api/orders', { method: 'POST', cookie: account.cookie, body: { planId: 'member-month', requestId: 'synthetic-late-order-request' } });
  await late.started; assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  assert.equal((await h.remove(account.cookie)).status, 200); late.resume(); const response = await late.response; assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'login_required');
  assert.equal(checkoutCalls, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0); assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(account.user.id).auth_kind, 'deleted');
});

test('operations integration: logout or normal session rotation blocks delayed private writes without deleting the active account', async t => {
  for (const mode of ['logout', 'normal-login-rotation']) await t.test(mode, async sub => {
    const h = harness(sub), account = await h.login(), late = delayedBody(sub, h, '/api/profile', { method: 'PATCH', cookie: account.cookie, body: { revision: 0, facts: [{ id: 'synthetic-revoked-fact', label: '合成情况', value: 'synthetic-private-revoked-write' }] } });
    await late.started; let next = null;
    if (mode === 'logout') assert.equal((await h.request('/api/auth/logout', { method: 'POST', cookie: account.cookie })).status, 200);
    else { h.tick(60000); next = await h.login(account.email, account.cookie); assert.equal(next.user.id, account.user.id); }
    late.resume(); const response = await late.response; assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'login_required');
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id=?').get(account.user.id).n, 0); assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(account.user.id).auth_kind, 'email'); assert.equal(h.store.sessionUser(account.tokenHash), null);
    if (next) { assert.equal(h.store.sessionUser(next.tokenHash).id, account.user.id); assert.equal((await (await h.request('/api/profile', { cookie: next.cookie })).json()).facts.length, 0); }
  });
});

test('operations integration: cross-origin/missing Origin/cross-site cannot submit refunds or delete accounts', async t => {
  const h = harness(t), account = await h.login(), order = h.paidOrder(account);
  for (const options of [{ origin: null }, { origin: 'https://untrusted.integration.test' }, { headers: { 'sec-fetch-site': 'cross-site' } }]) {
    assert.equal((await h.request('/api/refund-requests', { method: 'POST', cookie: account.cookie, body: { orderId: order.id, reason: 'other' }, ...options })).status, 403);
    assert.equal((await h.remove(account.cookie, { confirmation: '删除我的账号' }, options)).status, 403);
  }
  assert.equal(h.operationsStore.listRefundTickets().items.length, 0); assert.equal(h.store.ownedOrder(account.user, order.id).status, 'paid');
});

test('operations integration: user refund requests are idempotent, owner-only, enum-only, and never change financial facts', async t => {
  const h = harness(t), alice = await h.login(), bob = await h.login(), order = h.paidOrder(alice), before = JSON.stringify(h.store.db.prepare('SELECT * FROM orders').all());
  const first = await h.request('/api/refund-requests', { method: 'POST', cookie: alice.cookie, body: { orderId: order.id, reason: 'other' } }); assert.equal(first.status, 201); const ticket = (await first.json()).ticket;
  const repeated = await h.request('/api/refund-requests', { method: 'POST', cookie: alice.cookie, body: { orderId: order.id, reason: 'other' } }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).ticket.id, ticket.id);
  assert.equal((await (await h.request('/api/refund-requests', { cookie: alice.cookie })).json()).items.length, 1); assert.equal((await (await h.request('/api/refund-requests', { cookie: bob.cookie })).json()).items.length, 0);
  assert.equal((await h.request('/api/refund-requests', { method: 'POST', cookie: bob.cookie, body: { orderId: order.id, reason: 'other' } })).status, 404);
  for (const body of [{ orderId: order.id, reason: 'other', userId: bob.user.id }, { orderId: order.id, reason: 'other', amountFen: 1 }, { orderId: order.id, reason: 'synthetic-private-contact@example.test' }]) assert.equal((await h.request('/api/refund-requests', { method: 'POST', cookie: alice.cookie, body })).status, 400);
  assert.equal((await h.request('/api/refund-requests', { cookie: undefined })).status, 401); assert.equal(JSON.stringify(h.store.db.prepare('SELECT * FROM orders').all()), before);
});

test('operations integration: active paid entitlement and unresolved refund ticket prevent account deletion', async t => {
  const h = harness(t), account = await h.login(), order = h.paidOrder(account);
  const memberBlocked = await h.remove(account.cookie); assert.equal(memberBlocked.status, 409); assert.equal((await memberBlocked.json()).error.code, 'active_membership');
  const requested = await h.request('/api/refund-requests', { method: 'POST', cookie: account.cookie, body: { orderId: order.id, reason: 'other' } }); assert.equal(requested.status, 201);
  h.tick(31 * DAY); const relogged = await h.login(account.email), before = JSON.stringify(h.store.db.prepare('SELECT * FROM orders').all());
  const ticketBlocked = await h.remove(relogged.cookie); assert.equal(ticketBlocked.status, 409); assert.equal((await ticketBlocked.json()).error.code, 'open_refund_request');
  assert.equal(h.store.db.prepare('SELECT auth_kind FROM users WHERE id=?').get(account.user.id).auth_kind, 'email'); assert.equal(JSON.stringify(h.store.db.prepare('SELECT * FROM orders').all()), before); assert.equal(h.store.sessionUser(relogged.tokenHash).id, account.user.id);
});

test('operations integration runtime: staff routes default closed; enabled staff reads are bearer-only and redact private fields', async t => {
  const directory = temporary(t), filename = join(directory, 'fixture.sqlite'), id = randomUUID(), secret = freshSecret(), authSecret = freshSecret();
  const seed = createMembershipStore({ filename }); seed.db.prepare('INSERT INTO users(id,email,created_at,auth_kind,label) VALUES(?,?,?,?,?)').run(id, 'synthetic-runtime-private@example.test', Date.now(), 'email', 'synthetic-runtime-private-label');
  seed.db.prepare('INSERT INTO guides(id,user_id,content_cipher,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(randomUUID(), id, 'synthetic-runtime-private-guide', Date.now(), Date.now());
  seed.db.prepare('INSERT INTO profiles(user_id,facts_cipher,revision,updated_at) VALUES(?,?,1,?)').run(id, 'synthetic-runtime-private-facts', Date.now()); seed.close();
  const env = { NODE_ENV: 'test', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_APP_ORIGIN: BASE, MEMBERSHIP_AUTH_SECRET: authSecret };
  const closed = createApiRuntime({ env, getCorpus: () => corpus });
  try { assert.equal((await closed.handler(new Request(`${BASE}/api/operations/users`))).status, 503); assert.equal((await (await closed.handler(new Request(`${BASE}/api/operations/status`))).json()).available, false); } finally { closed.close(); }
  const open = createApiRuntime({ env: { ...env, OPERATIONS_ENABLED: 'true', OPERATIONS_SECRET: secret }, getCorpus: () => corpus });
  try {
    assert.equal((await open.handler(new Request(`${BASE}/api/operations/users`))).status, 401);
    assert.equal((await open.handler(new Request(`${BASE}/api/operations/users`, { headers: { authorization: `Bearer ${authSecret}` } }))).status, 401, 'membership secret is not staff secret');
    const headers = { authorization: `Bearer ${secret}`, origin: BASE };
    const users = await open.handler(new Request(`${BASE}/api/operations/users`, { headers })); assert.equal(users.status, 200); const body = await users.json(); assert.equal(body.items[0].id, id); assert.equal(body.items[0].guideCount, 1); assert.equal(body.items[0].hasProfile, true);
    const summary = await open.handler(new Request(`${BASE}/api/operations/summary`, { headers })); assert.equal(summary.status, 200); assert.equal((await summary.json()).users, 1);
    const text = JSON.stringify(body); for (const value of ['synthetic-runtime-private', secret, authSecret, filename, '"email":', '"phone":', 'facts_cipher', 'content_cipher']) assert.ok(!text.includes(value), value);
    assert.equal(users.headers.get('cache-control'), 'no-store'); assert.equal(users.headers.get('set-cookie'), null);
  } finally { open.close(); }
});

test('operations integration runtime: invalid enabled staff config fails before creating a database', t => {
  const directory = temporary(t), filename = join(directory, 'never-created.sqlite');
  assert.throws(() => createApiRuntime({ env: { NODE_ENV: 'test', MEMBERSHIP_DB_PATH: filename, OPERATIONS_ENABLED: 'true', OPERATIONS_SECRET: 'not-valid' }, getCorpus: () => corpus }), /OPERATIONS_SECRET/); assert.equal(existsSync(filename), false);
});

test('operations integration runtime: analytics default disabled, opt-in accepts whitelist only and staff report remains protected', async t => {
  const directory = temporary(t), filename = join(directory, 'analytics-fixture.sqlite'), secret = freshSecret();
  const env = { NODE_ENV: 'test', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_APP_ORIGIN: BASE, MEMBERSHIP_AUTH_SECRET: freshSecret(), OPERATIONS_ENABLED: 'true', OPERATIONS_SECRET: secret };
  const payload = { version: 1, name: 'page_view', sessionId: randomBytes(16).toString('hex'), dimensions: { view: 'home' } };
  const event = (runtime, body = payload, headers = {}) => runtime.handler(new Request(`${BASE}/api/analytics/events`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  const report = runtime => runtime.handler(new Request(`${BASE}/api/operations/analytics`, { headers: { authorization: `Bearer ${secret}` } }));
  const closed = createApiRuntime({ env, getCorpus: () => corpus }); try { assert.equal((await event(closed)).status, 204); assert.deepEqual(await (await report(closed)).json(), { configured: false, items: [] }); } finally { closed.close(); }
  const open = createApiRuntime({ env: { ...env, ANALYTICS_ENABLED: 'true' }, getCorpus: () => corpus });
  try {
    assert.equal((await event(open)).status, 204);
    assert.equal((await event(open, { ...payload, name: 'payment_confirmed', dimensions: { plan: 'member-month' } })).status, 400);
    assert.equal((await event(open, { ...payload, email: 'synthetic-private@example.test' })).status, 400);
    assert.equal((await event(open, { ...payload, dimensions: { view: 'home', question: 'synthetic-private-question' } })).status, 400);
    assert.equal((await event(open, payload, { origin: 'https://untrusted.integration.test' })).status, 403);
    assert.equal((await event(open, { ...payload, sessionId: randomBytes(16).toString('hex') }, { dnt: '1' })).status, 204);
    assert.equal((await open.handler(new Request(`${BASE}/api/operations/analytics`))).status, 401);
    const response = await report(open); assert.equal(response.status, 200); const view = await response.json(); assert.equal(view.configured, true); assert.equal(view.items.length, 1); assert.equal(view.items[0].name, 'page_view'); assert.equal(view.items[0].event_count, 1);
    const text = JSON.stringify(view); for (const value of ['synthetic-private', payload.sessionId, secret, filename, '"email":', '"phone":', '"userId":']) assert.ok(!text.includes(value), value);
  } finally { open.close(); }
});
