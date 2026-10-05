import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHupijiaoPaymentProvider, signPaymentParams, yuanToFen } from '../server/payment-hupijiao.mjs';
import { paymentOrderId } from '../server/payment-order-id.mjs';
import { createMembershipStore, hash } from '../server/membership-store.mjs';
import { createMembershipHandler } from '../server/membership.mjs';
import { membershipPlan } from '../shared/membership-plans.mjs';

const ORIGIN = 'https://better-life.fixture.test', clock = Date.UTC(2026, 9, 3), now = () => clock;
const env = { MEMBERSHIP_PAYMENT_PROVIDER: 'hupijiao', MEMBERSHIP_HUPIJIAO_APPID: 'fixture-merchant', MEMBERSHIP_HUPIJIAO_APPSECRET: 'fixture-only-private-pay-secret', MEMBERSHIP_APP_ORIGIN: ORIGIN, MEMBERSHIP_PAYMENT_CREATE_ENABLED: 'true' };
// Independent document-algorithm implementation; not the verifier under test.
const signatureWith = (params, secret) => createHash('md5').update(Object.keys(params).filter(key => key !== 'hash' && params[key] != null && params[key] !== '').sort().map(key => `${key}=${params[key]}`).join('&') + secret).digest('hex');
const signature = params => signatureWith(params, env.MEMBERSHIP_HUPIJIAO_APPSECRET);
const signedResponse = data => Response.json({ ...data, hash: signature(data) });
const fields = (id, status = 'OD', changes = {}) => ({ appid: env.MEMBERSHIP_HUPIJIAO_APPID, trade_order_id: paymentOrderId(id), total_fee: '19.00', transaction_id: 'fixture-transaction', status, time: String(clock / 1000), nonce_str: 'fixture-nonce', ...changes });
const notification = (values, extra = {}) => { const body = new URLSearchParams({ ...values, hash: signature(values) }).toString(); return new Request(`${ORIGIN}/api/payments/hupijiao/notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra.headers }, body: extra.body ?? body }); };
function harness(t, overrideEnv = {}, options = {}) {
  const readTime = options.now || now;
  const store = createMembershipStore({ now: readTime }); t.after(() => store.close()); const sent = [];
  const provider = createHupijiaoPaymentProvider({ env: { ...env, ...overrideEnv }, now: readTime, fetchImpl: options.fetchImpl || (async url => { assert.equal(url, 'https://api.xunhupay.com/payment/query.html'); return signedResponse({ errcode: 0, errmsg: 'success' }); }) });
  const handler = createMembershipHandler({ env: { MEMBERSHIP_AUTH_SECRET: 'fixture-private-login-secret-1234567890abcd', MEMBERSHIP_APP_ORIGIN: ORIGIN }, store, now: readTime, sender: async value => sent.push(value), paymentProvider: provider });
  const request = (path, options = {}) => handler(new Request(`${ORIGIN}${path}`, { method: options.method || 'GET', headers: { origin: ORIGIN, ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) }));
  async function login(email = 'fixture@example.test') {
    assert.equal((await request('/api/auth/code', { method: 'POST', body: { email } })).status, 200);
    const response = await request('/api/auth/verify', { method: 'POST', body: { email, code: sent.at(-1).code } }); const cookie = response.headers.get('set-cookie').split(';')[0];
    return { cookie, user: store.sessionUser(hash(cookie.split('=')[1])) };
  }
  return { store, provider, handler, request, login };
}
test('payment: default/unknown/missing config closes live checkout, disabled creation retains authenticated callbacks', () => {
  for (const value of [{}, { ...env, MEMBERSHIP_PAYMENT_PROVIDER: 'unknown' }, { ...env, MEMBERSHIP_HUPIJIAO_APPSECRET: '' }, { ...env, MEMBERSHIP_APP_ORIGIN: 'http://public.test' }]) assert.equal(createHupijiaoPaymentProvider({ env: value }), null);
  const disabled = createHupijiaoPaymentProvider({ env: { ...env, MEMBERSHIP_PAYMENT_CREATE_ENABLED: 'false' } });
  assert.equal(disabled.creationEnabled, false); assert.equal(typeof disabled.verifyNotification, 'function');
});
test('payment: decimal-to-fen conversion is exact and rejects negative, scientific and excessive precision inputs', () => {
  assert.equal(yuanToFen('19'), 1900); assert.equal(yuanToFen('19.00'), 1900); assert.equal(yuanToFen('0.01'), 1);
  for (const value of [19, '19.001', '-19', '+19', '1e2', '19.00junk', '0', '019.00', 'NaN', 'Infinity']) assert.equal(yuanToFen(value), null);
  assert.equal(signPaymentParams({ b: '二', a: '1', empty: '', hash: 'ignored' }, env.MEMBERSHIP_HUPIJIAO_APPSECRET), signature({ b: '二', a: '1', empty: '' }));
});
test('payment: checkout is signed, namespace-isolated, server-priced and uses only Better Life callback URLs', async () => {
  let posted;
  const provider = createHupijiaoPaymentProvider({ env, now, fetchImpl: async (url, options) => { assert.equal(url, 'https://api.xunhupay.com/payment/do.html'); assert.equal(options.redirect, 'error'); posted = Object.fromEntries(new URLSearchParams(options.body)); return signedResponse({ errcode: 0, url: 'https://api.xunhupay.com/payment/fixture' }); } });
  const id = 'fixture-order-123';
  assert.deepEqual(await provider.createCheckout({ id, amountFen: 1900, currency: 'CNY', description: '月度会员' }), { checkoutUrl: 'https://api.xunhupay.com/payment/fixture' });
  assert.equal(posted.hash, signature(posted)); assert.match(posted.trade_order_id, /^bl_[a-f0-9]{29}$/); assert.equal(posted.total_fee, '19.00');
  assert.equal(posted.notify_url, `${ORIGIN}/api/payments/hupijiao/notify`); assert.equal(posted.return_url, `${ORIGIN}/?paymentOrder=${id}`); assert.equal(posted.plugins, 'better-life');
  assert.ok(!JSON.stringify(posted).includes('image2'));
});
test('payment: unsigned/malicious/nested create responses cannot open a payment URL, private transport errors are suppressed', async () => {
  for (const data of [{ errcode: 0, url: 'https://attacker.test/pay' }, { errcode: 0, url: 'https://user:password@api.xunhupay.com/pay' }, { errcode: 0, url: 'http://api.xunhupay.com/pay' }, { errcode: 0, url: 'https://api.xunhupay.com.evil.test/pay' }, { errcode: 0, url: 'https://api.xunhupay.com/pay', data: { paid: true } }]) {
    const provider = createHupijiaoPaymentProvider({ env, now, fetchImpl: async () => signedResponse(data) });
    await assert.rejects(() => provider.createCheckout({ id: 'fixture-order-123', amountFen: 1900, currency: 'CNY' }), /payment_unavailable/);
  }
  const provider = createHupijiaoPaymentProvider({ env, fetchImpl: async () => { throw new Error('private-merchant-secret'); } });
  await assert.rejects(() => provider.createCheckout({ id: 'fixture-order-123', amountFen: 1900, currency: 'CNY' }), error => error.message === 'payment_unavailable');
});
test('payment: query data is advisory even if an attacker changes nested paid/refund/amount fields', async () => {
  const envelope = { errcode: 0, errmsg: 'success' };
  for (const status of ['OD', 'CD', 'WP']) {
    const provider = createHupijiaoPaymentProvider({ env, now, fetchImpl: async () => Response.json({ ...envelope, data: { status, total_fee: '0.01', open_order_id: 'attacker' }, hash: signature(envelope) }) });
    const result = await provider.verifyPayment({ id: 'fixture-order-123' }); assert.equal(result.status, 'pending'); assert.equal(result.advisoryOnly, true); assert.equal(result.queryAccepted, true);
    assert.equal(result.amountFen, undefined); assert.equal(result.transactionId, undefined);
  }
});
test('payment: signed webhook rejects tampering, duplicate fields, future time, wrong merchant and foreign order namespace', async () => {
  const provider = createHupijiaoPaymentProvider({ env, now }); const valid = fields('fixture-order-123');
  assert.equal((await provider.verifyNotification(notification(valid))).amountFen, 1900);
  const raw = new URLSearchParams({ ...valid, hash: signature(valid) }).toString();
  await assert.rejects(() => provider.verifyNotification(notification(valid, { body: raw.replace('total_fee=19.00', 'total_fee=0.01') })), error => error.status === 403);
  await assert.rejects(() => provider.verifyNotification(notification(valid, { body: `${raw}&total_fee=19.00` })), error => error.status === 400);
  for (const changes of [{ appid: 'other-merchant' }, { time: String(clock / 1000 + 400) }, { trade_order_id: 'image2-order-123' }, { total_fee: '19.000' }, { transaction_id: '' }, { status: 'WP' }]) await assert.rejects(() => provider.verifyNotification(notification({ ...valid, ...changes })));
  const json = new Request(`${ORIGIN}/api/payments/hupijiao/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mock: true, paid: true }) });
  await assert.rejects(() => provider.verifyNotification(json), error => error.status === 415);
});
test('payment: atomic callback grants one entitlement, duplicate replay is harmless, forged GET never grants', async t => {
  const h = harness(t), { user, cookie } = await h.login(), order = h.store.createOrder(user, membershipPlan('member-month'), 'fixture-request-123', env.MEMBERSHIP_HUPIJIAO_APPID).order;
  assert.equal((await h.request(`/api/orders/${order.id}?status=paid`, { cookie })).status, 200); assert.equal(h.store.me(user).membership.planId, 'free');
  for (let index = 0; index < 3; index++) { const response = await h.handler(notification(fields(order.id))); assert.equal(response.status, 200); assert.equal(await response.text(), 'success'); }
  assert.equal(h.store.me(user).membership.planId, 'member-month'); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 1); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n, 1);
  assert.equal((await h.handler(notification(fields(order.id, 'OD', { total_fee: '0.01' })))).status, 502);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 1);
});
test('payment: another user cannot read/check an order and one payment transaction cannot fund two accounts', async t => {
  const h = harness(t), alice = await h.login(), bob = await h.login('bob@example.test');
  const first = h.store.createOrder(alice.user, membershipPlan('member-month'), 'fixture-request-1', env.MEMBERSHIP_HUPIJIAO_APPID).order;
  const second = h.store.createOrder(bob.user, membershipPlan('member-month'), 'fixture-request-2', env.MEMBERSHIP_HUPIJIAO_APPID).order;
  assert.equal((await h.request(`/api/orders/${first.id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await h.handler(notification(fields(first.id)))).status, 200);
  assert.equal((await h.handler(notification(fields(second.id)))).status, 502); assert.equal(h.store.me(bob.user).membership.planId, 'free');
});
test('payment: confirmed full refund revokes only its own entitlement and delayed paid cannot resurrect it', async t => {
  const h = harness(t), { user } = await h.login();
  const first = h.store.createOrder(user, membershipPlan('member-month'), 'fixture-request-1', env.MEMBERSHIP_HUPIJIAO_APPID).order, second = h.store.createOrder(user, membershipPlan('member-month'), 'fixture-request-2', env.MEMBERSHIP_HUPIJIAO_APPID).order;
  assert.equal((await h.handler(notification(fields(first.id)))).status, 200);
  assert.equal((await h.handler(notification(fields(second.id, 'OD', { transaction_id: 'fixture-second' })))).status, 200);
  const renewal = h.store.db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(second.id);
  for (const status of ['RD', 'UD']) { assert.equal((await h.handler(notification(fields(first.id, status)))).status, 200); assert.equal(h.store.me(user).membership.planId, 'member-month'); }
  assert.equal((await h.handler(notification(fields(first.id, 'CD')))).status, 200);
  assert.equal(h.store.me(user).membership.planId, 'free'); assert.equal(h.store.ownedOrder(user, first.id).status, 'refunded');
  assert.deepEqual(h.store.db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(second.id), renewal);
  assert.equal((await h.handler(notification(fields(first.id)))).status, 200); assert.equal(h.store.me(user).membership.planId, 'free'); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 1);
});
test('payment: refund-before-paid stays refunded; disable new orders does not disable verified refund callback', async t => {
  const h = harness(t, { MEMBERSHIP_PAYMENT_CREATE_ENABLED: 'false' }), { user, cookie } = await h.login();
  const order = h.store.createOrder(user, membershipPlan('member-month'), 'fixture-request-1', env.MEMBERSHIP_HUPIJIAO_APPID).order;
  const status = await (await h.request('/api/membership')).json(); assert.equal(status.checkoutAvailable, false);
  assert.equal((await h.request('/api/orders', { method: 'POST', cookie, body: { planId: 'member-month', requestId: 'fixture-request-2' } })).status, 503);
  assert.equal((await h.handler(notification(fields(order.id, 'CD')))).status, 200); assert.equal((await h.handler(notification(fields(order.id)))).status, 200);
  assert.equal(h.store.me(user).membership.planId, 'free'); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0);
});
test('payment: unknown/mismatched callback is not acknowledged and does not persist a partial financial state', async t => {
  const h = harness(t), { user } = await h.login(), order = h.store.createOrder(user, membershipPlan('member-month'), 'fixture-request-1', env.MEMBERSHIP_HUPIJIAO_APPID).order;
  assert.equal((await h.handler(notification(fields('unknown-order-123')))).status, 404);
  assert.equal((await h.handler(notification(fields(order.id, 'OD', { total_fee: '129.00' })))).status, 502);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0); assert.equal(h.store.ownedOrder(user, order.id).status, 'created');
});

test('payment: actual signed mock checkout binds merchant; switching credentials cannot settle or reuse another merchant order', async t => {
  const h = harness(t, {}, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.xunhupay.com/payment/do.html');
    const request = Object.fromEntries(new URLSearchParams(options.body)); assert.equal(request.appid, env.MEMBERSHIP_HUPIJIAO_APPID); assert.equal(request.hash, signature(request));
    return signedResponse({ errcode: 0, url: 'https://api.xunhupay.com/payment/mock-order' });
  } });
  const { user, cookie } = await h.login();
  const created = await h.request('/api/orders', { method: 'POST', cookie, body: { planId: 'member-month', requestId: 'fixture-api-order-1', amountFen: 1 } });
  assert.equal(created.status, 201); const order = (await created.json()).order;
  assert.equal(h.store.ownedOrder(user, order.id).merchant_id, env.MEMBERSHIP_HUPIJIAO_APPID); assert.equal(order.amountFen, 1900);
  const switched = { ...env, MEMBERSHIP_HUPIJIAO_APPID: 'other-fixture-merchant', MEMBERSHIP_HUPIJIAO_APPSECRET: 'other-fixture-private-pay-secret' };
  const other = createHupijiaoPaymentProvider({ env: switched, now, fetchImpl: async () => { throw new Error('must-not-create'); } });
  const bHandler = createMembershipHandler({ env: { MEMBERSHIP_AUTH_SECRET: 'fixture-private-login-secret-1234567890abcd', MEMBERSHIP_APP_ORIGIN: ORIGIN }, store: h.store, now, paymentProvider: other });
  const values = fields(order.id, 'OD', { appid: switched.MEMBERSHIP_HUPIJIAO_APPID });
  const notify = new Request(`${ORIGIN}/api/payments/hupijiao/notify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...values, hash: signatureWith(values, switched.MEMBERSHIP_HUPIJIAO_APPSECRET) }) });
  assert.equal((await bHandler(notify)).status, 502);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n, 0); assert.equal(h.store.me(user).membership.planId, 'free');
  assert.throws(() => h.store.createOrder(user, membershipPlan('member-month'), 'fixture-api-order-1', other.merchantId), error => error.status === 409);
  assert.throws(() => h.store.assertPaymentMerchant(other.merchantId), error => error.status === 503); assert.doesNotThrow(() => h.store.assertPaymentMerchant(h.provider.merchantId));
  assert.equal((await h.handler(notification(fields(order.id)))).status, 200); assert.equal(h.store.me(user).membership.planId, 'member-month');
});

test('payment: legacy unbound orders fail closed without inventing merchant ownership or changing existing entitlements', async t => {
  const h = harness(t), { user } = await h.login(), order = h.store.createOrder(user, membershipPlan('member-month'), 'fixture-legacy-order-1', h.provider.merchantId).order;
  h.store.db.prepare('UPDATE orders SET merchant_id=NULL WHERE id=?').run(order.id);
  assert.equal((await h.handler(notification(fields(order.id)))).status, 502);
  assert.throws(() => h.store.assertPaymentMerchant(h.provider.merchantId), error => error.status === 503);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0); assert.equal(h.store.ownedOrder(user, order.id).merchant_id, null);
});

test('payment: refund notifications are monotonic under reversed/time-tied delivery; terminal refund cannot revive', async t => {
  const h = harness(t), { user } = await h.login(), order = h.store.createOrder(user, membershipPlan('member-month'), 'fixture-refund-order-1', h.provider.merchantId).order;
  const notify = (status, seconds) => h.handler(notification(fields(order.id, status, { time: String(clock / 1000 + seconds) })));
  assert.equal((await notify('OD', -90)).status, 200);
  assert.equal((await notify('UD', -30)).status, 200);
  for (const seconds of [-60, -30]) { assert.equal((await notify('RD', seconds)).status, 200); assert.equal(h.store.ownedOrder(user, order.id).refund_state, 'refund_failed'); }
  assert.equal((await notify('RD', 0)).status, 200); assert.equal(h.store.ownedOrder(user, order.id).refund_state, 'refund_pending');
  assert.equal((await notify('CD', 30)).status, 200); const refunded = h.store.ownedOrder(user, order.id);
  for (const [status, seconds] of [['OD', 60], ['UD', 60], ['RD', 60], ['CD', -60]]) assert.equal((await notify(status, seconds)).status, 200);
  const final = h.store.ownedOrder(user, order.id); assert.equal(final.status, 'refunded'); assert.equal(final.refund_state, 'refunded'); assert.equal(final.refunded_at, refunded.refunded_at);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0); assert.equal(h.store.me(user).membership.planId, 'free');
});

test('payment: genuine signed late payment honors immutable original price/duration after UI expiry; fake browser status does not', async t => {
  let time = clock; const h = harness(t, {}, { now: () => time }), { user, cookie } = await h.login();
  const plan = membershipPlan('member-month'), order = h.store.createOrder(user, plan, 'fixture-expired-order-1', h.provider.merchantId).order;
  time += 31 * 60000; h.store.expireOrder(order.id); assert.equal(h.store.ownedOrder(user, order.id).status, 'expired');
  assert.equal((await h.request(`/api/orders/${order.id}?status=paid&amountFen=1`, { cookie })).status, 200); assert.equal(h.store.me(user).membership.planId, 'free');
  assert.equal((await h.handler(notification(fields(order.id, 'OD', { time: String(time / 1000), total_fee: '0.01' })))).status, 502);
  assert.equal((await h.handler(notification(fields(order.id, 'OD', { time: String(time / 1000) })))).status, 200);
  const entitlement = h.store.db.prepare('SELECT * FROM entitlements WHERE order_id=?').get(order.id);
  assert.equal(entitlement.ends_at - entitlement.starts_at, plan.durationDays * 86400000); assert.equal(entitlement.starts_at, time); assert.equal(h.store.ownedOrder(user, order.id).amount_fen, order.amount_fen);
  assert.equal(h.store.me(user).membership.planId, 'member-month');
});
