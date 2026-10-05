import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createMembershipHandler } from '../server/membership.mjs';
import { qaMiddleware } from '../server/node-adapter.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// 独立回归：只用内存数据库和注入适配器，不发送邮件、模型请求或真实付款。
function harness(t, options = {}) {
  let timestamp = Date.UTC(2026, 9, 3);
  const now = () => timestamp;
  const store = createMembershipStore({ now });
  t.after(() => store.close());
  const codes = new Map();
  const base = options.base ?? 'http://127.0.0.1';
  const env = { MEMBERSHIP_AUTH_SECRET: 'test-only-regression-secret-not-for-production', MEMBERSHIP_APP_ORIGIN: base, ...options.env };
  const handler = createMembershipHandler({ store, now, env, sender: async ({ email, code }) => codes.set(email, code), getClientId: () => 'regression-local', ...options.handler });
  const request = (path, { method = 'GET', body, cookie, origin = base, headers = {} } = {}) => handler(new Request(`${base}${path}`, {
    method, headers: { ...(origin == null ? {} : { origin }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const login = async email => {
    const sent = await request('/api/auth/code', { method: 'POST', body: { email } });
    assert.equal(sent.status, 200);
    const verified = await request('/api/auth/verify', { method: 'POST', body: { email, code: codes.get(email) } });
    assert.equal(verified.status, 200);
    return { cookie: verified.headers.get('set-cookie').split(';')[0], setCookie: verified.headers.get('set-cookie'), data: await verified.json() };
  };
  return { store, handler, request, login, codes, tick: value => { timestamp += value; } };
}
const errorCode = async response => (await response.json()).error?.code;
const guideCorpus = { source: { snapshotDate: '2026-10-03' }, chapters: [{ title: '睡眠', file: '02.md', entries: [{ id: '2-13', title: '固定作息' }] }] };
const guideBody = { title: '我的私人睡眠指南', topic: '睡眠', content: 'PRIVATE-GUIDE-TEXT 先保持作息规律。', sourceIds: ['2-13'], factIds: [], tasks: [{ id: 'task1', title: '记下入睡时间', done: false }] };

test('regression: OTP wrong attempts persist, correct code cannot revive locked code', async t => {
  const h = harness(t), email = 'locked@example.test';
  await h.request('/api/auth/code', { method: 'POST', body: { email } });
  const code = h.codes.get(email), wrong = code === '000000' ? '999999' : '000000';
  for (let i = 0; i < 5; i++) {
    const response = await h.request('/api/auth/verify', { method: 'POST', body: { email, code: wrong } });
    assert.equal(response.status, 400);
    assert.equal(await errorCode(response), 'invalid_code');
  }
  const response = await h.request('/api/auth/verify', { method: 'POST', body: { email, code } });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(h.store.db.prepare('SELECT attempts FROM codes WHERE email=?').get(email).attempts, 5);
});

test('regression: OTP is single-use, relogin rotates current session, logout revokes it', async t => {
  const h = harness(t), email = 'session@example.test';
  const first = await h.login(email), oldCode = h.codes.get(email);
  assert.match(first.setCookie, /HttpOnly/);
  assert.match(first.setCookie, /SameSite=Lax/);
  assert.doesNotMatch(first.setCookie, /Domain=/);
  const replay = await h.request('/api/auth/verify', { method: 'POST', body: { email, code: oldCode } });
  assert.equal(replay.status, 400);
  h.tick(61000);
  await h.request('/api/auth/code', { method: 'POST', body: { email } });
  const relogin = await h.request('/api/auth/verify', { method: 'POST', cookie: first.cookie, body: { email, code: h.codes.get(email) } });
  assert.equal(relogin.status, 200);
  const nextCookie = relogin.headers.get('set-cookie').split(';')[0];
  assert.notEqual(nextCookie, first.cookie);
  assert.equal((await (await h.request('/api/me', { cookie: first.cookie })).json()).user, null);
  const logout = await h.request('/api/auth/logout', { method: 'POST', cookie: nextCookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await (await h.request('/api/me', { cookie: nextCookie })).json()).user, null);
});

test('regression: auth rejects missing/hostile Origin and cross-site request hints', async t => {
  const h = harness(t);
  for (const [origin, headers] of [[null, {}], ['https://attacker.test', {}], ['http://127.0.0.1', { 'sec-fetch-site': 'cross-site' }]]) {
    const response = await h.request('/api/auth/code', { method: 'POST', origin, headers, body: { email: 'csrf@example.test' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(h.codes.size, 0);
});

test('regression: production HTTPS sessions are Secure and bad production origin fails closed', async t => {
  const secure = harness(t, { base: 'https://better-life.test', env: { NODE_ENV: 'production' } });
  assert.match((await secure.login('secure@example.test')).setCookie, /; Secure/);
  const missing = harness(t, { env: { NODE_ENV: 'production', MEMBERSHIP_APP_ORIGIN: '' } });
  const response = await missing.request('/api/auth/code', { method: 'POST', body: { email: 'bad@example.test' } });
  assert.equal(response.status, 503);
  assert.equal(await errorCode(response), 'https_required');
});

test('regression: default membership does not block the already connected QA handler', async t => {
  let calls = 0;
  const h = harness(t, { env: { MEMBERSHIP_AUTH_SECRET: '' }, handler: { sender: null, qaHandler: async () => { calls++; return new Response('{"status":"existing-handler"}', { headers: { 'content-type': 'application/json' } }); } } });
  const response = await h.request('/api/ask', { method: 'POST', body: { question: '离职之前准备什么？' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'existing-handler');
  assert.equal(calls, 1);
  const membership = await (await h.request('/api/membership')).json();
  assert.equal(membership.loginAvailable, false);
  assert.equal(membership.checkoutAvailable, false);
  assert.ok(membership.plans.filter(plan => plan.amountFen > 0).every(plan => !plan.purchasable));
});

test('regression: no configured payment adapter means no order, no charge, no entitlement', async t => {
  const h = harness(t), user = await h.login('preview@example.test');
  const response = await h.request('/api/orders', { method: 'POST', cookie: user.cookie, body: { planId: 'member-month', requestId: 'preview-order-01', paid: true, amountFen: 1 } });
  assert.equal(response.status, 503);
  assert.equal(await errorCode(response), 'checkout_not_configured');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0);
});

test('regression: prices are server-authoritative and other account cannot access an order', async t => {
  let created, verification = { status: 'pending' };
  const provider = { merchantId: 'trusted-merchant-test', createCheckout: async order => { created = order; return { checkoutUrl: 'https://payments.example.test/checkout' }; }, verifyPayment: async () => verification };
  const h = harness(t, { handler: { paymentProvider: provider } });
  const alice = await h.login('alice@example.test'), bob = await h.login('bob@example.test');
  const response = await h.request('/api/orders', { method: 'POST', cookie: alice.cookie, body: { planId: 'member-month', requestId: 'pricing-order-01', amountFen: 1, durationDays: 9999, paid: true } });
  assert.equal(response.status, 201);
  const { order } = await response.json();
  assert.equal(created.amountFen, 1900);
  assert.equal(order.amountFen, 1900);
  assert.equal(order.status, 'pending');
  const foreign = await h.request(`/api/orders/${order.id}`, { cookie: bob.cookie });
  assert.equal(foreign.status, 404);
  const fakeJump = await h.request(`/api/orders/${order.id}?paid=true&status=paid`, { cookie: alice.cookie });
  assert.equal((await fakeJump.json()).order.status, 'pending');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0);
  verification = { status: 'paid', merchantId: 'trusted-merchant-test', orderId: order.id, amountFen: 1, currency: 'CNY', transactionId: 'underpaid-test-01' };
  const underpaid = await h.request(`/api/orders/${order.id}`, { cookie: alice.cookie });
  assert.equal(underpaid.status, 502);
  assert.equal(await errorCode(underpaid), 'payment_mismatch');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0);
});

test('regression: failed and insufficient QA release quota, identical retry never double consumes', async t => {
  let calls = 0, mode = 'failed';
  const h = harness(t, { env: { MEMBERSHIP_ENFORCE: 'true' }, handler: { qaHandler: async () => {
    calls++;
    if (mode === 'failed') return new Response('{"error":{"code":"test_failure","message":"fixture only"}}', { status: 502 });
    return new Response(JSON.stringify({ status: mode, question: '怎么更好睡觉？', answer: { intro: '固定作息。', steps: mode === 'answered' ? [{ title: '作息', detail: '先保持规律。', entryIds: ['2-13'] }] : [], caveat: '' }, sources: mode === 'answered' ? [{ id: '2-13' }] : [], snapshotDate: '2026-10-03', model: 'DeepSeek' }));
  } } });
  const user = await h.login('quota@example.test');
  const ask = requestId => h.request('/api/ask', { method: 'POST', cookie: user.cookie, body: { question: '怎么更好睡觉？', requestId } });
  assert.equal((await ask('failure-request-01')).status, 502);
  mode = 'insufficient';
  assert.equal((await ask('insufficient-request-01')).status, 200);
  assert.equal((await (await h.request('/api/me', { cookie: user.cookie })).json()).quota.used, 0);
  mode = 'answered';
  const answered = await ask('answered-request-01');
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).quota.used, 1);
  const repeat = await ask('answered-request-01');
  assert.equal(repeat.status, 200);
  const reused = await repeat.json();
  assert.equal(reused.reused, true);
  assert.equal(reused.quota.used, 1);
  assert.equal(calls, 3);
  const actions = h.store.db.prepare('SELECT action FROM quota_ledger ORDER BY id').all().map(row => row.action);
  assert.deepEqual(actions, ['reserve', 'release', 'reserve', 'release', 'reserve', 'consume']);
});

test('regression: private guide ownership covers read/edit/version/restore/export/ask/delete', async t => {
  let calls = 0;
  const h = harness(t, { handler: { getCorpus: () => guideCorpus, personalQaHandler: async () => { calls++; return new Response('{}'); } } });
  const alice = await h.login('guide-alice@example.test'), bob = await h.login('guide-bob@example.test');
  const created = await h.request('/api/guides', { method: 'POST', cookie: alice.cookie, body: guideBody });
  assert.equal(created.status, 201);
  const guide = (await created.json()).guide;
  const versions = (await (await h.request(`/api/guides/${guide.id}/versions`, { cookie: alice.cookie })).json()).versions;
  assert.equal(versions.length, 1);
  assert.equal((await (await h.request('/api/guides', { cookie: bob.cookie })).json()).guides.length, 0);
  for (const [suffix, method, body] of [
    ['', 'GET'], ['', 'PATCH', { revision: 1, content: 'foreign overwrite' }], ['', 'DELETE'],
    ['/versions', 'GET'], [`/versions/${versions[0].id}`, 'GET'], ['/restore', 'POST', { revision: 1, versionId: versions[0].id }],
    ['/export', 'GET'], ['/ask', 'POST', { question: '怎么改善睡眠？', requestId: 'foreign-ask-01' }],
  ]) {
    const response = await h.request(`/api/guides/${guide.id}${suffix}`, { method, body, cookie: bob.cookie });
    assert.equal(response.status, 404, `${method} ${suffix}`);
  }
  assert.equal(calls, 0);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM generations').get().n, 0);
  const raw = h.store.db.prepare('SELECT content_cipher FROM guides WHERE id=?').get(guide.id).content_cipher;
  assert.ok(!raw.includes('PRIVATE-GUIDE-TEXT'));
  const markdown = await (await h.request(`/api/guides/${guide.id}/export`, { cookie: alice.cookie })).text();
  assert.ok(markdown.includes(guideBody.content));
  assert.ok(markdown.includes('- [ ] 记下入睡时间'));
  const deleted = await h.request(`/api/guides/${guide.id}`, { method: 'DELETE', cookie: alice.cookie });
  assert.equal(deleted.status, 200);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guide_versions WHERE guide_id=?').get(guide.id).n, 0);
});

test('regression: concurrent guide edits conflict, restore creates a new revision without rewriting history', async t => {
  const h = harness(t, { handler: { getCorpus: () => guideCorpus } }), alice = await h.login('revision@example.test');
  const original = (await (await h.request('/api/guides', { method: 'POST', cookie: alice.cookie, body: guideBody })).json()).guide;
  const patch = content => h.request(`/api/guides/${original.id}`, { method: 'PATCH', cookie: alice.cookie, body: { revision: 1, content, tasks: [{ ...guideBody.tasks[0], done: true }] } });
  const responses = await Promise.all([patch('first edit'), patch('competing edit')]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const current = (await (await h.request(`/api/guides/${original.id}`, { cookie: alice.cookie })).json()).guide;
  assert.equal(current.revision, 2);
  assert.equal(current.tasks[0].done, true);
  const versions = (await (await h.request(`/api/guides/${original.id}/versions`, { cookie: alice.cookie })).json()).versions;
  assert.deepEqual(versions.map(version => version.revision), [2, 1]);
  const version1 = versions.find(version => version.revision === 1);
  const restored = await h.request(`/api/guides/${original.id}/restore`, { method: 'POST', cookie: alice.cookie, body: { revision: 2, versionId: version1.id } });
  assert.equal(restored.status, 200);
  const result = (await restored.json()).guide;
  assert.equal(result.revision, 3);
  assert.equal(result.content, original.content);
  assert.equal(result.tasks[0].done, false);
  const history = (await (await h.request(`/api/guides/${original.id}/versions/${version1.id}`, { cookie: alice.cookie })).json()).version;
  assert.equal(history.revision, 1);
  assert.equal(history.content, original.content);
});

test('regression: only selected confirmed facts reach personal QA and no draft changes profile/guide/tasks', async t => {
  let selected;
  const h = harness(t, { handler: { getCorpus: () => guideCorpus, personalQaHandler: async (_request, context) => {
    selected = structuredClone(context);
    return new Response(JSON.stringify({ status: 'answered', question: '怎么改善睡眠？', answer: { intro: '调整作息。', steps: [{ title: '记录', detail: '记录作息。', entryIds: ['2-13'] }], caveat: '' }, sources: [{ id: '2-13' }], draft: { content: 'AI draft not saved', tasks: [{ id: 'task1', done: true }] } }));
  } } });
  const alice = await h.login('facts-alice@example.test'), bob = await h.login('facts-bob@example.test');
  const profile = await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 0, facts: [{ id: 'fact1', label: '作息', value: '晚上十二点入睡 PRIVATE-FACT-TEXT' }, { id: 'fact2', label: '工作', value: '白天上班' }] } });
  assert.equal(profile.status, 200);
  const profileState = await profile.json();
  assert.equal(profileState.revision, 1);
  assert.ok(profileState.facts.every(fact => !!fact.confirmedAt));
  assert.deepEqual((await (await h.request('/api/profile', { cookie: bob.cookie })).json()).facts, []);
  assert.ok(!h.store.db.prepare('SELECT facts_cipher FROM profiles WHERE user_id=?').get(alice.data.user.id).facts_cipher.includes('PRIVATE-FACT-TEXT'));
  const created = (await (await h.request('/api/guides', { method: 'POST', cookie: alice.cookie, body: { ...guideBody, factIds: ['fact1'] } })).json()).guide;
  const ask = await h.request(`/api/guides/${created.id}/ask`, { method: 'POST', cookie: alice.cookie, body: { question: '怎么改善睡眠？', factIds: ['fact2'], requestId: 'selected-facts-01' } });
  assert.equal(ask.status, 200);
  assert.deepEqual(selected.profileFacts.map(fact => fact.id), ['fact2']);
  assert.equal(selected.guide.id, created.id);
  const current = (await (await h.request(`/api/guides/${created.id}`, { cookie: alice.cookie })).json()).guide;
  assert.deepEqual(current, created);
  assert.deepEqual(await (await h.request('/api/profile', { cookie: alice.cookie })).json(), profileState);
  const wrongFacts = await h.request(`/api/guides/${created.id}/ask`, { method: 'POST', cookie: alice.cookie, body: { question: '怎么改善睡眠？', factIds: ['guessed-fact'], requestId: 'guessed-facts-01' } });
  assert.equal(wrongFacts.status, 400);
  assert.equal(await errorCode(wrongFacts), 'unconfirmed_facts');
  const conflict = await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 0, facts: [] } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await (await h.request('/api/profile', { cookie: alice.cookie })).json(), profileState);
});

test('regression: restoring old guide does not recreate a deleted personal fact', async t => {
  const h = harness(t, { handler: { getCorpus: () => guideCorpus } }), alice = await h.login('deleted-fact@example.test');
  await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 0, facts: [{ id: 'old-fact', label: '生活情况', value: '之前租房' }] } });
  const guide = (await (await h.request('/api/guides', { method: 'POST', cookie: alice.cookie, body: { ...guideBody, factIds: ['old-fact'] } })).json()).guide;
  const version = (await (await h.request(`/api/guides/${guide.id}/versions`, { cookie: alice.cookie })).json()).versions[0];
  await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 1, facts: [] } });
  const edit = await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: alice.cookie, body: { revision: 1, content: '删除情况之后仍能正常改正文' } });
  assert.equal(edit.status, 200);
  assert.deepEqual((await edit.json()).guide.factIds, []);
  const restored = await h.request(`/api/guides/${guide.id}/restore`, { method: 'POST', cookie: alice.cookie, body: { revision: 2, versionId: version.id } });
  assert.equal(restored.status, 200);
  assert.deepEqual((await restored.json()).guide.factIds, []);
  assert.deepEqual((await (await h.request('/api/profile', { cookie: alice.cookie })).json()).facts, []);
});

test('regression: valid existing session cannot write private data with missing encryption secret', async t => {
  const h = harness(t), alice = await h.login('missing-secret@example.test');
  const handler = createMembershipHandler({ store: h.store, env: { MEMBERSHIP_APP_ORIGIN: 'http://127.0.0.1', MEMBERSHIP_AUTH_SECRET: '' }, sender: async () => {} });
  const response = await handler(new Request('http://127.0.0.1/api/profile', { method: 'PATCH', headers: { origin: 'http://127.0.0.1', cookie: alice.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, facts: [{ label: '工作', value: '不应写到弱加密 key' }] }) }));
  assert.equal(response.status, 503);
  assert.equal(await errorCode(response), 'membership_not_configured');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 0);
});

test('regression: storage errors return generic no-store JSON without private data or secret leakage', async t => {
  const h = harness(t);
  h.store.cleanup = () => { throw new Error('sqlite PRIVATE-REVIEW-TOKEN PRIVATE-QUESTION-CONTENT'); };
  const response = await h.request('/api/membership');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.ok(!body.includes('PRIVATE-REVIEW-TOKEN'));
  assert.ok(!body.includes('PRIVATE-QUESTION-CONTENT'));
  assert.equal(JSON.parse(body).error.code, 'membership_unavailable');
});

test('regression: each guide source retains its original snapshot through later edits and export', async t => {
  let corpus = structuredClone(guideCorpus);
  const h = harness(t, { handler: { getCorpus: () => corpus } }), alice = await h.login('snapshot@example.test');
  const guide = (await (await h.request('/api/guides', { method: 'POST', cookie: alice.cookie, body: guideBody })).json()).guide;
  assert.equal(guide.snapshotDate, '2026-10-03');
  assert.equal(guide.sourceSnapshots['2-13'].snapshotDate, '2026-10-03');
  corpus = { ...corpus, source: { snapshotDate: '2026-10-04' }, chapters: [{ ...corpus.chapters[0], entries: [...corpus.chapters[0].entries, { id: '2-14', title: '另一条建议' }] }] };
  const response = await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: alice.cookie, body: { revision: 1, sourceIds: ['2-13', '2-14'] } });
  assert.equal(response.status, 200);
  const edited = (await response.json()).guide;
  assert.equal(edited.snapshotDate, '2026-10-03');
  assert.equal(edited.sourceSnapshots['2-13'].snapshotDate, '2026-10-03');
  assert.equal(edited.sourceSnapshots['2-14'].snapshotDate, '2026-10-04');
  const exported = await (await h.request(`/api/guides/${guide.id}/export`, { cookie: alice.cookie })).text();
  assert.ok(exported.includes('首次资料快照：2026-10-03'));
  assert.ok(exported.includes('书本快照：2026-10-03'));
  assert.ok(exported.includes('书本快照：2026-10-04'));
});

test('regression: local demo requires explicit development, matching loopback URL and trusted client', async t => {
  const cases = [
    {},
    { env: { MEMBERSHIP_LOCAL_DEMO: 'false' } },
    { env: { MEMBERSHIP_LOCAL_DEMO: 'TRUE' } },
    { base: 'https://127.0.0.1', env: { MEMBERSHIP_LOCAL_DEMO: 'true' } },
    { base: 'https://better-life.test', env: { MEMBERSHIP_LOCAL_DEMO: 'true', NODE_ENV: 'production' } },
    { env: { MEMBERSHIP_LOCAL_DEMO: 'true' }, handler: { getClientId: () => '203.0.113.5' } },
    { env: { MEMBERSHIP_LOCAL_DEMO: 'true' }, handler: { getClientId: () => 'shared' } },
    { base: 'https://attacker.test', env: { MEMBERSHIP_LOCAL_DEMO: 'true', MEMBERSHIP_APP_ORIGIN: 'http://127.0.0.1' }, requestOrigin: 'http://127.0.0.1' },
  ];
  for (const options of cases) {
    const h = harness(t, { ...options, handler: { sender: null, getClientId: () => '127.0.0.1', ...options.handler } });
    const response = await h.request('/api/auth/local-demo', { method: 'POST', ...(options.requestOrigin ? { origin: options.requestOrigin } : {}) });
    assert.ok([403, 503].includes(response.status));
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  }
});

test('regression: even local socket cannot use local demo via missing/hostile/cross-site Origin', async t => {
  const h = harness(t, { env: { MEMBERSHIP_LOCAL_DEMO: 'true' }, handler: { sender: null, getClientId: () => '::ffff:127.0.0.1' } });
  for (const [origin, headers] of [[null, {}], ['http://localhost', {}], ['https://attacker.test', {}], ['http://127.0.0.1', { 'sec-fetch-site': 'cross-site' }]]) {
    const response = await h.request('/api/auth/local-demo', { method: 'POST', origin, headers });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('regression: adapter overwrites spoofed loopback/proxy headers before demo auth', async t => {
  const h = harness(t, { env: { MEMBERSHIP_LOCAL_DEMO: 'true' }, handler: { sender: null, getClientId: request => request.headers.get('x-better-life-client-ip') } });
  const req = Readable.from([], { objectMode: false });
  Object.assign(req, { method: 'POST', url: '/api/auth/local-demo', headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', 'x-better-life-client-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1' }, socket: { remoteAddress: '203.0.113.5' } });
  const res = new EventEmitter();
  Object.assign(res, { writableEnded: false, destroyed: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = Buffer.from(value).toString(); this.writableEnded = true; } });
  await qaMiddleware(h.handler)(req, res, () => assert.fail('API must not fall through'));
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'local_demo_forbidden');
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('regression: demo session is labelled, payment disabled, copied cookie cannot be used remotely or after disabling', async t => {
  let payments = 0;
  const provider = { merchantId: 'demo-test-provider', createCheckout: async () => { payments++; return { checkoutUrl: 'https://payment.example.test' }; }, verifyPayment: async () => { payments++; return { status: 'paid' }; } };
  const h = harness(t, { env: { MEMBERSHIP_LOCAL_DEMO: 'true' }, handler: { getClientId: () => '::1', paymentProvider: provider } });
  const response = await h.request('/api/auth/local-demo', { method: 'POST' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0], me = await response.json();
  assert.equal(me.user.authentication, 'local-demo');
  assert.equal(me.user.email, null);
  assert.equal(me.user.label, '本机体验账号');
  assert.equal(me.membership.planId, 'free');
  const status = await (await h.request('/api/membership')).json();
  assert.equal(status.localDemoAvailable, true);
  assert.equal(status.checkoutAvailable, false);
  assert.ok(status.plans.every(plan => !plan.purchasable));
  const payment = await h.request('/api/orders', { method: 'POST', cookie, body: { planId: 'member-month', requestId: 'demo-fake-order-01', status: 'paid' } });
  assert.equal(payment.status, 503);
  assert.equal(payments, 0);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, 0);
  for (const options of [{ env: { MEMBERSHIP_LOCAL_DEMO: 'true' }, getClientId: () => '203.0.113.5' }, { env: {}, getClientId: () => '127.0.0.1' }, { env: { MEMBERSHIP_LOCAL_DEMO: 'true', NODE_ENV: 'production' }, getClientId: () => '127.0.0.1' }]) {
    const base = options.env.NODE_ENV === 'production' ? 'https://better-life.test' : 'http://127.0.0.1';
    const handler = createMembershipHandler({ store: h.store, env: { MEMBERSHIP_AUTH_SECRET: 'test-only-regression-secret-not-for-production', MEMBERSHIP_APP_ORIGIN: base, ...options.env }, getClientId: options.getClientId, sender: null });
    const denied = await handler(new Request(`${base}/api/guides`, { headers: { origin: base, cookie } }));
    assert.equal(denied.status, 401);
    const anonymous = await handler(new Request(`${base}/api/me`, { headers: { origin: base, cookie } }));
    assert.equal((await anonymous.json()).user, null);
  }
});
