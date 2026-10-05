import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createMembershipHandler } from '../server/membership.mjs';
import { prepareLocalDemoEnv } from '../server/membership-runtime.mjs';

const LOCAL = 'http://127.0.0.1:4190';
const env = { MEMBERSHIP_AUTH_SECRET: 'test-only-local-demo-key-never-use-in-production', MEMBERSHIP_LOCAL_DEMO: 'true' };
const corpus = { source: { snapshotDate: '2026-10-03' }, chapters: [{ id: 2, file: '02.md', entries: [{ id: '2-13', title: '规律作息' }] }] };
function harness(t, options = {}) {
  const store = options.store ?? createMembershipStore(); t.after(() => { try { store.close(); } catch {} });
  const handler = createMembershipHandler({ store, env: { ...env, ...options.env }, sender: null, getClientId: () => options.ip ?? '127.0.0.1', getCorpus: () => corpus, ...options.handler });
  const request = (path, { method = 'GET', body, cookie, origin = options.base ?? LOCAL } = {}) => handler(new Request(`${options.base ?? LOCAL}${path}`, { method, headers: { ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const login = async () => { const response = await request('/api/auth/local-demo', { method: 'POST' }); assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], result: await response.json() }; };
  return { store, request, login, handler };
}

test('local demo: explicit loopback mode creates real free session without pretending email verification', async t => {
  const h = harness(t), status = await (await h.request('/api/membership')).json();
  assert.equal(status.localDemoAvailable, true); assert.equal(status.loginAvailable, false); assert.equal(status.checkoutAvailable, false);
  const { cookie, result } = await h.login();
  assert.equal(result.user.authentication, 'local-demo'); assert.equal(result.user.email, null); assert.equal(result.user.label, '本机体验账号');
  assert.equal(result.membership.planId, 'free'); assert.equal(result.quota.limit, 10); assert.equal((await (await h.request('/api/guides', { cookie })).json()).limit, 5);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { email: 'user@example.test' } })).status, 503);
  const created = await h.request('/api/guides', { method: 'POST', cookie, body: { title: '本机私人指南', topic: '', content: '', sourceIds: ['2-13'], tasks: [] } });
  assert.equal(created.status, 201);
  assert.equal((await h.request('/api/auth/logout', { method: 'POST', cookie })).status, 200);
  assert.equal((await (await h.request('/api/me', { cookie })).json()).user, null);
});

test('local demo: default-off, production, HTTPS, non-loopback URL/client and hostile Origin fail closed', async t => {
  for (const options of [{ env: { MEMBERSHIP_LOCAL_DEMO: 'false' } }, { env: { NODE_ENV: 'production', MEMBERSHIP_APP_ORIGIN: 'https://example.test' } }, { base: 'https://127.0.0.1:4190' }, { base: 'http://example.test:4190' }, { ip: '203.0.113.1' }, { ip: 'shared' }]) {
    const h = harness(t, options), response = await h.request('/api/auth/local-demo', { method: 'POST' });
    assert.ok([403, 503].includes(response.status)); assert.equal(response.headers.get('set-cookie'), null); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  }
  const h = harness(t);
  for (const origin of [null, 'https://attacker.test', 'http://localhost:4190']) assert.equal((await h.request('/api/auth/local-demo', { method: 'POST', origin })).status, 403);
  const proxied = await h.handler(new Request(`${LOCAL}/api/auth/local-demo`, { method: 'POST', headers: { origin: LOCAL, 'x-better-life-proxy-present': 'true' } }));
  assert.equal(proxied.status, 403);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('local demo: even injected paid provider cannot charge or grant entitlement, copied session fails remotely', async t => {
  let paymentCalls = 0;
  const h = harness(t, { handler: { sender: async () => {}, paymentProvider: { merchantId: 'fixture', createCheckout: async () => { paymentCalls++; return { checkoutUrl: 'https://payment.test' }; }, verifyPayment: async () => { paymentCalls++; return { status: 'paid' }; } } } });
  const { cookie } = await h.login(), status = await (await h.request('/api/membership')).json();
  assert.equal(status.checkoutAvailable, false); assert.ok(status.plans.every(plan => !plan.purchasable));
  const attempt = await h.request('/api/orders', { method: 'POST', cookie, body: { planId: 'member-month', requestId: 'fake-paid-order', paid: true, amountFen: 0 } });
  assert.equal(attempt.status, 503); assert.equal(paymentCalls, 0); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0);
  const remote = createMembershipHandler({ store: h.store, env, sender: null, getClientId: () => '203.0.113.1', getCorpus: () => corpus });
  const copied = await remote(new Request(`${LOCAL}/api/guides`, { headers: { origin: LOCAL, cookie } })); assert.equal(copied.status, 401);
  const disabled = createMembershipHandler({ store: h.store, env: { ...env, MEMBERSHIP_LOCAL_DEMO: 'false' }, sender: null, getClientId: () => '127.0.0.1', getCorpus: () => corpus });
  assert.equal((await disabled(new Request(`${LOCAL}/api/guides`, { headers: { origin: LOCAL, cookie } }))).status, 401);
});

test('local demo: private key and session survive restart; key is not created outside explicit development mode', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-local-demo-')), filename = join(directory, 'private.sqlite'), keyPath = join(directory, 'local-demo.key');
  t.after(() => { for (const path of [filename, `${filename}-wal`, `${filename}-shm`, keyPath]) if (existsSync(path)) unlinkSync(path); rmdirSync(directory); });
  assert.equal(prepareLocalDemoEnv({}, { keyPath }).MEMBERSHIP_AUTH_SECRET, undefined); assert.equal(existsSync(keyPath), false);
  assert.equal(prepareLocalDemoEnv({ MEMBERSHIP_LOCAL_DEMO: 'true', NODE_ENV: 'production' }, { keyPath }).MEMBERSHIP_AUTH_SECRET, undefined); assert.equal(existsSync(keyPath), false);
  const prepared = prepareLocalDemoEnv({ MEMBERSHIP_LOCAL_DEMO: 'true' }, { keyPath }); assert.ok(prepared.MEMBERSHIP_AUTH_SECRET.length >= 32);
  const store = createMembershipStore({ filename }), h = harness(t, { store, env: prepared }), { cookie, result } = await h.login();
  const created = await h.request('/api/guides', { method: 'POST', cookie, body: { title: '重启保留', topic: '工作', content: '真实存储的本机笔记', sourceIds: ['2-13'], tasks: [] } }); assert.equal(created.status, 201);
  const guide = (await created.json()).guide; store.close();
  const again = prepareLocalDemoEnv({ MEMBERSHIP_LOCAL_DEMO: 'true' }, { keyPath }); assert.ok(prepared.MEMBERSHIP_AUTH_SECRET === again.MEMBERSHIP_AUTH_SECRET);
  const second = createMembershipStore({ filename }); t.after(() => { try { second.close(); } catch {} });
  const next = createMembershipHandler({ store: second, env: again, sender: null, getClientId: () => '::ffff:127.0.0.1', getCorpus: () => corpus });
  const read = await next(new Request(`${LOCAL}/api/guides/${guide.id}`, { headers: { origin: LOCAL, cookie } })); assert.equal(read.status, 200); assert.equal((await read.json()).guide.content, '真实存储的本机笔记');
  const relogged = await next(new Request(`${LOCAL}/api/auth/local-demo`, { method: 'POST', headers: { origin: LOCAL } })); assert.equal((await relogged.json()).user.id, result.user.id);
  second.close();
});
