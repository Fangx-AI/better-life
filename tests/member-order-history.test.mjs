import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createMembershipStore, hash } from '../server/membership-store.mjs';
import { createMembershipHandler } from '../server/membership.mjs';
import { createOperationsStore } from '../server/operations.mjs';
import { validateOrderHistory } from '../src/lib/membership-api.mjs';

// 合成账号、内存数据库、注入支付事实；不读取真实配置、不收码、不联网、不付款。
function harness(t) {
  let clock = Date.UTC(2026, 9, 5);
  const now = () => clock, store = createMembershipStore({ now });
  t.after(() => store.close());
  const operationsStore = createOperationsStore({ membershipStore: store, now });
  let providerCalls = 0;
  const base = 'https://better-life.fixture.test';
  const handler = createMembershipHandler({ store, operationsStore, now, env: { MEMBERSHIP_AUTH_SECRET: 'synthetic-history-auth-secret-never-production', MEMBERSHIP_APP_ORIGIN: base }, sender: async () => {}, paymentProvider: { merchantId: 'fixture-merchant', createCheckout: async () => { providerCalls++; throw new Error('never_call'); }, verifyPayment: async () => { providerCalls++; throw new Error('never_call'); } } });
  const request = (path, { cookie, method = 'GET', origin = base, headers = {}, body } = {}) => handler(new Request(`${base}${path}`, { method, headers: { ...(origin === null ? {} : { origin }), ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  function user() {
    const id = randomUUID(), session = randomBytes(32).toString('base64url');
    store.db.prepare("INSERT INTO users(id,email,created_at,auth_kind) VALUES(?,?,?,'email')").run(id, `${id}@fixture.test`, now());
    store.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(session), id, now() + 365 * 86400000);
    return { id, auth_kind: 'email', created_at: now(), cookie: `better_life_session=${session}`, session };
  }
  function order(owner, { paid = false, sameTime = null } = {}) {
    clock += 3600001; // 跨窗口构造历史，不放宽实际创建频率限制。
    const result = store.createOrder(owner, { id: 'member-month', name: '月付会员', amountFen: 1900, currency: 'CNY', durationDays: 30 }, randomUUID(), 'fixture-merchant');
    if (paid) store.confirmPaid(result.order, { orderId: result.order.id, merchantId: 'fixture-merchant', transactionId: `fixture-${randomUUID()}`, amountFen: 1900, currency: 'CNY', status: 'paid' });
    if (sameTime !== null) store.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(sameTime, result.order.id);
    return store.ownedOrder(owner, result.order.id);
  }
  const financial = () => JSON.stringify(Object.fromEntries(['orders', 'entitlements', 'payment_events', 'quota_periods', 'quota_ledger'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  return { store, user, order, request, financial, providerCalls: () => providerCalls, tick: value => { clock += value; } };
}

test('member order history: oldest paid order remains available behind 31 unpaid orders and refund request never changes money', async t => {
  const h = harness(t), alice = h.user(), paid = h.order(alice, { paid: true });
  for (let index = 0; index < 31; index++) h.order(alice);
  const me = await (await h.request('/api/me', { cookie: alice.cookie })).json();
  assert.equal(me.orders.length, 30); assert.ok(!me.orders.some(order => order.id === paid.id), 'recent summary cannot be refund source');
  const before = h.financial(), response = await h.request('/api/orders?status=paid&limit=20', { cookie: alice.cookie });
  const plan = h.store.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM orders WHERE user_id=? AND status='paid' ORDER BY created_at DESC,id DESC LIMIT 21").all(alice.id);
  assert.ok(plan.some(row => row.detail.includes('order_user_status_history')), 'paid lookup does not scan all newer unpaid orders');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const page = await response.json(); assert.deepEqual(page.items.map(order => order.id), [paid.id]); assert.equal(page.ownerId, alice.id); assert.equal(page.nextCursor, null);
  assert.equal(validateOrderHistory(page, alice.id, { status: 'paid' }), page);
  const ticket = await h.request('/api/refund-requests', { method: 'POST', cookie: alice.cookie, body: { orderId: paid.id, reason: 'service_issue' } });
  assert.equal(ticket.status, 201); assert.equal((await ticket.json()).ticket.orderId, paid.id);
  assert.equal(h.financial(), before); assert.equal(h.providerCalls(), 0, 'history and refund registration never query/pay/refund gateway');
});

test('member order history: bounded keyset pages are complete with identical timestamps and isolate owners', async t => {
  const h = harness(t), alice = h.user(), bob = h.user(), timestamp = Date.UTC(2026, 9, 5);
  const own = Array.from({ length: 9 }, () => h.order(alice, { paid: true, sameTime: timestamp }).id);
  const foreign = h.order(bob, { paid: true, sameTime: timestamp }).id;
  const before = h.financial(), seen = []; let cursor = null;
  do {
    const response = await h.request(`/api/orders?status=paid&limit=2${cursor ? `&cursor=${cursor}` : ''}`, { cookie: alice.cookie });
    assert.equal(response.status, 200); const page = await response.json();
    validateOrderHistory(page, alice.id, { status: 'paid', limit: 2 }); assert.ok(page.items.length <= 2);
    seen.push(...page.items.map(order => order.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, own.sort().reverse()); assert.equal(new Set(seen).size, own.length); assert.ok(!seen.includes(foreign));
  assert.equal((await h.request(`/api/orders?cursor=${foreign}`, { cookie: alice.cookie })).status, 400);
  assert.equal((await h.request(`/api/orders?cursor=${seen[0]}`, { cookie: bob.cookie })).status, 400);
  assert.equal((await h.request(`/api/orders/${foreign}`, { cookie: alice.cookie })).status, 404);
  assert.equal(h.financial(), before); assert.equal(h.providerCalls(), 0);
});

test('member order history: invalid page parameters fail closed, 50-item bound and paid/all filters work', async t => {
  const h = harness(t), owner = h.user(), unpaid = h.order(owner), paid = h.order(owner, { paid: true });
  for (const query of ['limit=0', 'limit=51', 'limit=-1', 'limit=1.2', 'limit=01', 'limit=', 'limit=1e1', 'limit=9007199254740992', 'limit=1&limit=2', 'status=paid&status=all', 'cursor=', 'cursor=garbage', 'cursor=../../x', 'status=refunded', 'status=', `userId=${owner.id}`, 'includePrivate=true', `status=paid&cursor=${unpaid.id}`]) {
    assert.equal((await h.request(`/api/orders?${query}`, { cookie: owner.cookie })).status, 400, query);
  }
  const all = await (await h.request('/api/orders?limit=50', { cookie: owner.cookie })).json(); assert.deepEqual(all.items.map(order => order.id), [paid.id, unpaid.id]); assert.equal(all.nextCursor, null);
  const afterLast = await (await h.request(`/api/orders?cursor=${unpaid.id}`, { cookie: owner.cookie })).json(); assert.deepEqual(afterLast.items, []); assert.equal(afterLast.nextCursor, null);
  for (const parameters of [{ limit: 51 }, { limit: 0 }, { limit: NaN }, { limit: '20' }, { status: 'anything' }, { cursor: '' }, { cursor: { id: paid.id } }]) assert.throws(() => h.store.orderHistory(owner, parameters), value => value.status === 400);
  const text = JSON.stringify(all); for (const field of ['transactionId', 'merchantId', 'providerOrderId', 'requestId', 'email', 'phone', 'token_hash', 'user_id']) assert.ok(!text.includes(field), field);
});

test('member order history: session required, revoked/expired/deleted sessions and cross-site origins cannot read', async t => {
  const h = harness(t), owner = h.user(); h.order(owner, { paid: true });
  assert.equal((await h.request('/api/orders')).status, 401);
  assert.equal((await h.request('/api/orders', { cookie: 'better_life_session=invalid' })).status, 401);
  assert.equal((await h.request('/api/orders', { cookie: owner.cookie, origin: 'https://attacker.fixture.test' })).status, 403);
  assert.equal((await h.request('/api/orders', { cookie: owner.cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await h.request('/api/orders', { cookie: owner.cookie, origin: null })).status, 200, 'same-origin GET may omit Origin');
  const revoked = h.user(); h.store.revokeSession(hash(revoked.session)); assert.equal((await h.request('/api/orders', { cookie: revoked.cookie })).status, 401);
  const expired = h.user(); h.store.db.prepare('UPDATE sessions SET expires_at=0 WHERE token_hash=?').run(hash(expired.session)); assert.equal((await h.request('/api/orders', { cookie: expired.cookie })).status, 401);
  h.store.db.prepare("UPDATE users SET auth_kind='deleted' WHERE id=?").run(owner.id); assert.equal((await h.request('/api/orders', { cookie: owner.cookie })).status, 401); assert.throws(() => h.store.orderHistory(owner), value => value.status === 401);
  assert.equal(h.providerCalls(), 0);
});

test('member order history: client rejects foreign/malformed/oversized pages and validates pagination cursor', () => {
  const ownerId = randomUUID(), id = randomUUID(), item = { id, planName: '月付会员', amountFen: 1900, currency: 'CNY', status: 'paid', createdAt: '2026-10-05T00:00:00.000Z' };
  const page = { ownerId, items: [item], nextCursor: null }; assert.equal(validateOrderHistory(page, ownerId, { status: 'paid' }), page);
  for (const value of [null, {}, { ...page, ownerId: randomUUID() }, { ...page, items: [{ ...item, status: 'pending' }] }, { ...page, items: [{ ...item, amountFen: -1 }] }, { ...page, items: [{ ...item, currency: 'USD' }] }, { ...page, items: [{ ...item, createdAt: 'bad' }] }, { ...page, items: [item, item] }, { ...page, nextCursor: randomUUID() }, { ...page, nextCursor: id }, { ...page, items: Array.from({ length: 21 }, (_, index) => ({ ...item, id: `order-fixture-${index}` })) }]) assert.throws(() => validateOrderHistory(value, ownerId, { status: 'paid' }), /订单记录/);
  const cursorPage = { ...page, nextCursor: id }; assert.equal(validateOrderHistory(cursorPage, ownerId, { status: 'paid', limit: 1 }), cursorPage);
});
