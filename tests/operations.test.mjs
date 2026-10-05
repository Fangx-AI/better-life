import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createOperationsStore, createOperationsHandler, operationsConfiguration, assertOperationsConfig, validOperationsSecret } from '../server/operations.mjs';

const BASE = 'https://better-life.fixture.test';
const fixtureSecret = () => randomBytes(48).toString('base64url');
function harness(t, options = {}) {
  let clock = Date.UTC(2026, 9, 4);
  const now = () => clock, membership = createMembershipStore({ now, filename: options.filename });
  t.after(() => membership.close());
  const store = createOperationsStore({ membershipStore: membership, now });
  const secret = fixtureSecret(), env = { OPERATIONS_ENABLED: 'true', OPERATIONS_SECRET: secret, OPERATIONS_OPERATOR_ID: 'fixture-operator', MEMBERSHIP_APP_ORIGIN: BASE, ...options.env };
  const handler = createOperationsHandler({ env, store, now, getClientId: () => 'fixture-client-ip', ...options.handler });
  const request = (path, { method = 'GET', body, authenticated = true, headers = {} } = {}) => handler(new Request(`${BASE}${path}`, { method, headers: { ...(authenticated ? { authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  function user(contact = 'synthetic-private-alice@example.test') {
    const id = randomUUID(); membership.db.prepare('INSERT INTO users(id,email,created_at,auth_kind,label) VALUES(?,?,?,?,?)').run(id, contact, now(), 'email', 'synthetic-private-user-label');
    membership.db.prepare('INSERT INTO account_identities(channel,identifier,user_id,created_at) VALUES(?,?,?,?)').run('email', contact, id, now());
    return { id, auth_kind: 'email', created_at: now() };
  }
  function order(owner, { paid = true, requestId = randomUUID(), amountFen = 1900 } = {}) {
    const result = membership.createOrder(owner, { id: 'member-month', name: '月付会员', amountFen, currency: 'CNY', durationDays: 30 }, requestId, 'fixture-merchant');
    // 只为测试注入受信支付查单结果，不发网络请求、不触发真实付款。
    if (paid) membership.confirmPaid(result.order, { orderId: result.order.id, merchantId: 'fixture-merchant', transactionId: `fixture_${randomUUID()}`, amountFen, currency: 'CNY', status: 'paid' });
    return membership.ownedOrder(owner, result.order.id);
  }
  const createTicket = async orderId => {
    const response = await request('/api/operations/refund-tickets', { method: 'POST', body: { orderId, requestId: randomUUID(), reasonCode: 'service_issue' } });
    assert.equal(response.status, 201); return (await response.json()).ticket;
  };
  return { now, tick: value => { clock += value; }, membership, store, secret, env, request, user, order, createTicket };
}

test('operations: opt-in strong independent secret, status contains no secret or private configuration', async t => {
  const secret = fixtureSecret(); assert.equal(validOperationsSecret(secret), true);
  for (const value of ['', 'a'.repeat(64), 'replace-with-example-secret-01234567890123456789012345678901234567', randomBytes(32).toString('base64url')]) assert.equal(validOperationsSecret(value), false);
  for (const key of ['MEMBERSHIP_AUTH_SECRET', 'MEMBERSHIP_BACKUP_ENCRYPTION_KEY', 'MEMBERSHIP_HUPIJIAO_APPSECRET']) assert.equal(validOperationsSecret(secret, { [key]: secret }), false);
  assert.deepEqual(operationsConfiguration({}), { enabled: false, configured: false, available: false });
  assert.throws(() => assertOperationsConfig({ OPERATIONS_ENABLED: 'true' }), /OPERATIONS_SECRET/);
  assert.doesNotThrow(() => assertOperationsConfig({ OPERATIONS_ENABLED: 'false', OPERATIONS_SECRET: 'bad' }));
  assert.throws(() => assertOperationsConfig({ OPERATIONS_ENABLED: 'true', OPERATIONS_SECRET: secret, OPERATIONS_OPERATOR_ID: 'contact@example.test' }), /OPERATIONS_OPERATOR_ID/);
  const h = harness(t, { env: { OPERATIONS_ENABLED: 'false' } });
  const response = await h.request('/api/operations/status', { authenticated: false }), text = await response.text();
  assert.equal(response.status, 200); assert.equal(JSON.parse(text).available, false); assert.ok(!text.includes(h.secret)); assert.ok(!text.includes(BASE));
  assert.equal((await h.request('/api/operations/users')).status, 503);
  assert.equal((await h.request('/api/operations/status', { method: 'POST', body: {} })).status, 405);
});

test('operations: bearer only, cross-site denied, denied audit never stores token/IP/body/contact', async t => {
  const h = harness(t), sentinel = 'synthetic-private-token-contact@example.test';
  for (const headers of [{}, { cookie: `better_life_session=${h.secret}` }, { authorization: `Bearer ${sentinel}` }, { authorization: `Bearer ${h.secret} extra` }]) {
    assert.equal((await h.request('/api/operations/users', { authenticated: false, headers })).status, 401);
  }
  assert.equal((await h.request(`/api/operations/users?token=${h.secret}`, { authenticated: false })).status, 401);
  assert.equal((await h.request('/api/operations/users', { headers: { origin: 'https://untrusted.fixture.test' } })).status, 403);
  assert.equal((await h.request('/api/operations/users', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const response = await h.request('/api/operations/users', { headers: { origin: BASE } }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('access-control-allow-origin'), null); assert.equal(response.headers.get('set-cookie'), null);
  const audit = JSON.stringify(h.membership.db.prepare('SELECT * FROM operations_audit').all());
  for (const value of [sentinel, h.secret, BASE, 'fixture-client-ip', 'better_life_session']) assert.ok(!audit.includes(value), value);
  assert.equal(h.membership.db.prepare("SELECT COUNT(*) AS n FROM operations_audit WHERE action='auth_denied'").get().n, 1);
});

test('operations: private data excluded, summary/read-only orders and same-timestamp keyset pagination work', async t => {
  const h = harness(t), alice = h.user(), bob = h.user('synthetic-private-bob@example.test'); h.order(alice); h.order(bob, { paid: false }); h.order(alice);
  h.membership.db.prepare('INSERT INTO guides(id,user_id,content_cipher,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(randomUUID(), alice.id, 'synthetic-private-guide-content', h.now(), h.now());
  h.membership.db.prepare('INSERT INTO profiles(user_id,facts_cipher,revision,updated_at) VALUES(?,?,1,?)').run(alice.id, 'synthetic-private-health-facts', h.now());
  h.membership.db.prepare('INSERT INTO saved_answers(id,user_id,result_cipher,created_at) VALUES(?,?,?,?)').run(randomUUID(), alice.id, 'synthetic-private-question-answer', h.now());
  const users = await (await h.request('/api/operations/users')).json(); assert.equal(users.items.length, 2);
  const view = users.items.find(row => row.id === alice.id); assert.equal(view.guideCount, 1); assert.equal(view.savedAnswerCount, 1); assert.equal(view.hasProfile, true); assert.equal(view.membership.planId, 'member-month');
  const pages = [], ids = []; let cursor = null;
  do { const value = await (await h.request(`/api/operations/orders?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json(); pages.push(value); ids.push(...value.items.map(row => row.id)); cursor = value.nextCursor; } while (cursor);
  assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
  const paid = await (await h.request('/api/operations/orders?status=paid')).json(); assert.equal(paid.items.length, 2);
  const summary = await (await h.request('/api/operations/summary')).json(); assert.equal(summary.users, 2); assert.equal(summary.orderAmounts[0].amountFen, 3800);
  const output = JSON.stringify({ users, pages, summary });
  for (const value of ['synthetic-private', 'checkoutUrl', 'transactionId', 'merchantId', 'requestId', '"email":', '"phone":']) assert.ok(!output.includes(value), value);
  assert.equal(h.membership.db.prepare('SELECT COUNT(*) AS n FROM quota_periods').get().n, 0, 'read does not materialize quota periods');
  for (const path of ['/api/operations/users?includePrivate=true', '/api/operations/orders?status=anything', '/api/operations/orders?limit=101', '/api/operations/orders?limit=1&limit=2', '/api/operations/orders?cursor=invalid']) assert.equal((await h.request(path)).status, 400, path);
  assert.equal((await h.request(`/api/operations/users?cursor=${pages[0].nextCursor}`)).status, 400, 'cursor is route-specific');
});

test('operations: refund workflow is audited and idempotent but never changes money or membership', async t => {
  const h = harness(t), owner = h.user(), order = h.order(owner), before = JSON.stringify(h.membership.db.prepare('SELECT * FROM orders').all()), entitlement = JSON.stringify(h.membership.db.prepare('SELECT * FROM entitlements').all());
  const body = { orderId: order.id, requestId: 'fixture-refund-request', reasonCode: 'service_issue' };
  const created = await h.request('/api/operations/refund-tickets', { method: 'POST', body }); assert.equal(created.status, 201); let ticket = (await created.json()).ticket;
  const duplicate = await h.request('/api/operations/refund-tickets', { method: 'POST', body }); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).ticket.id, ticket.id);
  assert.equal((await h.request('/api/operations/refund-tickets', { method: 'POST', body: { ...body, reasonCode: 'other' } })).status, 409);
  assert.equal((await h.request('/api/operations/refund-tickets', { method: 'POST', body: { ...body, requestId: randomUUID() } })).status, 409);
  assert.equal((await h.request(`/api/operations/refund-tickets/${ticket.id}`, { method: 'PATCH', body: { revision: 1, state: 'approved' } })).status, 409);
  for (const state of ['reviewing', 'approved', 'awaiting_provider']) {
    const response = await h.request(`/api/operations/refund-tickets/${ticket.id}`, { method: 'PATCH', body: { revision: ticket.revision, state } }); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.gatewayCalled, false); assert.equal(result.paymentChanged, false); ticket = result.ticket;
  }
  assert.equal((await h.request(`/api/operations/refund-tickets/${ticket.id}`, { method: 'PATCH', body: { revision: 1, state: 'cancelled' } })).status, 409);
  const unverified = await h.request(`/api/operations/refund-tickets/${ticket.id}`, { method: 'PATCH', body: { revision: ticket.revision, state: 'resolved' } }); assert.equal(unverified.status, 409); assert.equal((await unverified.json()).error.code, 'refund_not_verified');
  assert.equal(JSON.stringify(h.membership.db.prepare('SELECT * FROM orders').all()), before); assert.equal(JSON.stringify(h.membership.db.prepare('SELECT * FROM entitlements').all()), entitlement);
  for (const path of ['/api/operations/paid', '/api/operations/refunded', '/api/operations/membership']) assert.equal((await h.request(path, { method: 'POST', body: {} })).status, 404);
  for (const body of [{ orderId: order.id, requestId: randomUUID(), reasonCode: 'other', paid: true }, { orderId: order.id, requestId: randomUUID(), reasonCode: 'synthetic-private-contact@example.test' }]) assert.equal((await h.request('/api/operations/refund-tickets', { method: 'POST', body })).status, 400);
  const actions = h.membership.db.prepare('SELECT action FROM operations_audit').all().map(row => row.action); assert.ok(actions.includes('refund_ticket_created')); assert.equal(actions.filter(action => action === 'refund_ticket_updated').length, 3);
  assert.throws(() => h.membership.db.prepare('DELETE FROM operations_audit').run(), /append_only/); assert.throws(() => h.membership.db.prepare("UPDATE operations_audit SET actor='modified'").run(), /append_only/);
});

test('operations: only verified provider refund facts permit resolved, rejected/cancelled are terminal', async t => {
  const h = harness(t), owner = h.user(), order = h.order(owner); let ticket = await h.createTicket(order.id);
  for (const state of ['reviewing', 'approved', 'awaiting_provider']) ticket = h.store.updateRefundTicket(ticket.id, { revision: ticket.revision, state });
  h.membership.acceptPaymentEvent({ eventKey: randomBytes(32).toString('hex'), merchantId: order.merchant_id, providerOrderId: order.provider_order_id, transactionId: order.transaction_id, type: 'refunded', amountFen: order.amount_fen, currency: order.currency, occurredAt: h.now() });
  ticket = h.store.updateRefundTicket(ticket.id, { revision: ticket.revision, state: 'resolved' }); assert.equal(ticket.state, 'resolved'); assert.throws(() => h.store.updateRefundTicket(ticket.id, { revision: ticket.revision, state: 'reviewing' }), /不允许/);
  assert.equal(h.membership.ownedOrder(owner, order.id).status, 'refunded');
  const second = h.order(owner); let other = await h.createTicket(second.id); other = h.store.updateRefundTicket(other.id, { revision: other.revision, state: 'cancelled' }); assert.throws(() => h.store.updateRefundTicket(other.id, { revision: other.revision, state: 'reviewing' }), /不允许/);
  assert.equal((await h.request('/api/operations/refund-tickets', { method: 'POST', body: { orderId: order.id, requestId: randomUUID(), reasonCode: 'other' } })).status, 409);
});

test('operations: user requests remain owner scoped, no free text, duplicate open requests are idempotent', t => {
  const h = harness(t), alice = h.user(), bob = h.user('synthetic-private-bob@example.test'), order = h.order(alice), pending = h.order(alice, { paid: false });
  assert.throws(() => h.store.submitRefundRequest(bob, { orderId: order.id, reason: 'other' }), /未找到/);
  assert.throws(() => h.store.submitRefundRequest(alice, { orderId: pending.id, reason: 'other' }), /已核验支付/);
  assert.throws(() => h.store.submitRefundRequest(alice, { orderId: order.id, reason: 'synthetic-private-medical-details' }), /不接收自由文本/);
  const first = h.store.submitRefundRequest(alice, { orderId: order.id, reason: 'other' }), repeated = h.store.submitRefundRequest(alice, { orderId: order.id, reason: 'service_issue' });
  assert.equal(first.created, true); assert.equal(repeated.created, false); assert.equal(first.ticket.id, repeated.ticket.id);
  assert.equal(h.store.listUserRefundRequests(alice).items.length, 1); assert.equal(h.store.listUserRefundRequests(bob).items.length, 0);
  h.membership.db.prepare('DELETE FROM account_identities WHERE user_id=?').run(alice.id); h.membership.db.prepare("UPDATE users SET email=?,auth_kind='deleted',label=NULL WHERE id=?").run(`deleted-${alice.id}@local.invalid`, alice.id);
  assert.equal(h.store.listRefundTickets().items.length, 1, 'soft deletion preserves financial support ticket'); assert.equal(h.store.listUsers({ authentication: 'deleted' }).items.length, 1);
});

test('operations: audit failure rolls back work-order writes and response failure never echoes DB details', async t => {
  const h = harness(t), owner = h.user(), order = h.order(owner);
  h.membership.db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON operations_audit BEGIN SELECT RAISE(ABORT,'synthetic-private-db-error'); END;");
  const response = await h.request('/api/operations/refund-tickets', { method: 'POST', body: { orderId: order.id, requestId: randomUUID(), reasonCode: 'other' } });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('synthetic-private')); assert.equal(h.membership.db.prepare('SELECT COUNT(*) AS n FROM operations_refund_tickets').get().n, 0);
});

test('operations: request sizes, strict revision, content type and abuse rate are bounded', async t => {
  const h = harness(t), owner = h.user(), order = h.order(owner);
  assert.equal((await h.request('/api/operations/refund-tickets', { method: 'POST', body: { orderId: order.id, requestId: randomUUID(), reasonCode: 'other' }, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await h.request('/api/operations/refund-tickets', { method: 'POST', body: { extra: 'x'.repeat(5000) } })).status, 413);
  const ticket = await h.createTicket(order.id); assert.equal((await h.request(`/api/operations/refund-tickets/${ticket.id}`, { method: 'PATCH', body: { revision: '1', state: 'reviewing' } })).status, 400);
  let response; for (let i = 0; i < 121; i++) response = await h.request('/api/operations/users', { authenticated: false }); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60');
  h.tick(60000); assert.equal((await h.request('/api/operations/users')).status, 200);
});

test('operations: budget snapshot is authenticated and only an injected aggregate is used', async t => {
  let calls = 0; const h = harness(t, { handler: { getUsageBudgetSnapshot: () => { calls++; return { configured: true, state: 'normal', currency: 'CNY' }; } } });
  assert.equal((await h.request('/api/operations/usage-budget', { authenticated: false })).status, 401); assert.equal(calls, 0);
  const response = await h.request('/api/operations/usage-budget'); assert.equal(response.status, 200); assert.equal((await response.json()).state, 'normal'); assert.equal(calls, 1);
  assert.equal(h.membership.db.prepare("SELECT COUNT(*) AS n FROM operations_audit WHERE action='usage_budget_viewed'").get().n, 1);
});

test('operations: analytics report is staff-only and validates real date ranges without forwarding extra fields', async t => {
  const inputs = [], h = harness(t, { handler: { getAnalyticsReport: options => { inputs.push(options); return [{ day: '2026-10-04', name: 'guide_opened', dimensions: {}, source: 'client', event_count: 2, session_count: 1 }]; } } });
  assert.equal((await h.request('/api/operations/analytics', { authenticated: false })).status, 401); assert.equal(inputs.length, 0);
  const response = await h.request('/api/operations/analytics?from=2026-10-01&to=2026-10-04'); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.configured, true); assert.equal(data.items[0].event_count, 2); assert.deepEqual(inputs, [{ from: '2026-10-01', to: '2026-10-04' }]);
  for (const path of ['/api/operations/analytics?from=2026-02-30', '/api/operations/analytics?from=invalid', '/api/operations/analytics?from=2026-10-05&to=2026-10-01', '/api/operations/analytics?userId=synthetic-private-id']) assert.equal((await h.request(path)).status, 400);
  assert.equal(inputs.length, 1); assert.equal(h.membership.db.prepare("SELECT COUNT(*) AS n FROM operations_audit WHERE action='analytics_viewed'").get().n, 1);
  const disabled = harness(t); assert.deepEqual(await (await disabled.request('/api/operations/analytics')).json(), { configured: false, items: [] });
});

test('operations: persistent ticket/audit survive reopen, unbranded database stays untouched', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-operations-test-'));
  t.after(() => { assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(directory.startsWith(join(tmpdir(), 'better-life-operations-test-'))); rmSync(directory, { recursive: true, force: true }); });
  const filename = join(directory, 'fixture.sqlite'), first = createMembershipStore({ filename }), id = randomUUID();
  first.db.prepare('INSERT INTO users(id,email,created_at) VALUES(?,?,?)').run(id, 'synthetic-persist@example.test', Date.now());
  const order = first.createOrder({ id, auth_kind: 'email' }, { id: 'member-month', name: '月付会员', amountFen: 1900, currency: 'CNY', durationDays: 30 }, 'fixture-persist-request', 'fixture-merchant').order;
  first.confirmPaid(order, { orderId: order.id, merchantId: 'fixture-merchant', transactionId: 'fixture-persist-transaction', amountFen: 1900, currency: 'CNY', status: 'paid' });
  const operations = createOperationsStore({ membershipStore: first }); operations.submitRefundRequest({ id }, { orderId: order.id, reason: 'other' }); first.close();
  const second = createMembershipStore({ filename }); try { const reopened = createOperationsStore({ membershipStore: second }); assert.equal(reopened.listRefundTickets().items.length, 1); assert.equal(reopened.listAudit().items.length, 1); assert.equal(second.db.prepare('PRAGMA foreign_key_check').all().length, 0); } finally { second.close(); }
  const unrelated = new DatabaseSync(':memory:'); try { unrelated.exec('CREATE TABLE other_app(id INTEGER)'); assert.throws(() => createOperationsStore({ membershipStore: { db: unrelated } }), /已验证/); assert.equal(unrelated.prepare("SELECT name FROM sqlite_schema WHERE name='operations_audit'").get(), undefined); } finally { unrelated.close(); }
});
