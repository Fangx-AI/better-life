import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMembershipStore, DAY } from '../server/membership-store.mjs';
import { createMembershipHandler, createResendSender } from '../server/membership.mjs';

const BASE = 'http://127.0.0.1:4199';
const SECRET = 'test-only-private-membership-secret-32-characters';
const entry = { id: '2-13', chapter: 2, number: 13, title: '保持规律作息', summary: '规律作息。', cost: '少', benefit: '好', sources: '原书引用', notes: '研究有局限。' };
const corpus = { source: { snapshotDate: '2026-10-03', repository: 'https://github.com/eternity4719/HowToLiveBetter', revision: 'test-revision' }, chapters: [{ id: 2, title: '睡眠', file: '02-睡眠.md', entries: [entry] }] };
const answered = { status: 'answered', question: '怎样睡得更好', answer: { intro: '先保持规律。', steps: [{ title: '作息', detail: '先稳定起床时间。', entryIds: ['2-13'] }], caveat: '研究有局限。' }, sources: [entry], model: 'DeepSeek', snapshotDate: '2026-10-03' };
const asResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function harness(t, options = {}) {
  let clock = Date.UTC(2026, 9, 3), now = () => clock;
  const store = options.store ?? createMembershipStore({ filename: options.filename, now });
  t.after(() => { try { store.close(); } catch {} });
  const sent = [];
  const handler = createMembershipHandler({ env: { MEMBERSHIP_AUTH_SECRET: SECRET, MEMBERSHIP_APP_ORIGIN: BASE, ...options.env }, store, now, sender: async value => sent.push(value), getCorpus: () => corpus, qaHandler: async () => asResponse(answered), ...options.handler });
  const request = (path, { method = 'GET', body, cookie, origin = BASE, signal, headers = {} } = {}) => handler(new Request(`${BASE}${path}`, { method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) }));
  const login = async (email = 'alice@example.test') => {
    const codeResponse = await request('/api/auth/code', { method: 'POST', body: { email } }); assert.equal(codeResponse.status, 200);
    const response = await request('/api/auth/verify', { method: 'POST', body: { email, code: sent.at(-1).code } }); assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], data: await response.json() };
  };
  return { store, request, login, sent, handler, now, tick: value => { clock += value; } };
}
const guideInput = (overrides = {}) => ({ title: '我的睡眠指南', topic: '健康', content: '只在我确认后修改自己的计划。', sourceIds: ['2-13'], factIds: [], tasks: [{ id: 'wake-up', title: '稳定起床时间', done: false }], ...overrides });
const createGuide = async (h, cookie, overrides) => { const response = await h.request('/api/guides', { method: 'POST', cookie, body: guideInput(overrides) }); assert.equal(response.status, 201); return (await response.json()).guide; };
const data = async response => response.json();

test('membership: public preview has no fake auth/payment and no private user data', async t => {
  const h = harness(t, { env: { MEMBERSHIP_AUTH_SECRET: '' }, handler: { sender: null } });
  const status = await data(await h.request('/api/membership'));
  assert.equal(status.loginAvailable, false); assert.equal(status.checkoutAvailable, false); assert.equal(status.enforced, false);
  assert.deepEqual(status.plans.map(plan => plan.guideLimit), [5, 100, 100]);
  assert.ok(status.plans.every(plan => !plan.purchasable));
  assert.equal((await data(await h.request('/api/me'))).user, null);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { email: 'one@example.test' } })).status, 503);
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { email: 'one@example.test', code: '123456' } })).status, 503);
  assert.equal((await h.request('/api/orders/paid')).status, 503);
  assert.equal((await h.request('/api/admin/paid', { method: 'POST', body: {} })).status, 404);
});

test('membership: OTP is hashed, expires, cooldown persists, failed send never creates usable code', async t => {
  const h = harness(t), email = 'otp@example.test';
  const result = await h.request('/api/auth/code', { method: 'POST', body: { email: email.toUpperCase() } });
  assert.deepEqual(await result.json(), { sent: true, expiresIn: 300, retryAfter: 60 });
  const row = h.store.db.prepare('SELECT * FROM codes WHERE email=?').get(email);
  assert.notEqual(row.digest, h.sent[0].code); assert.equal(row.digest.length, 64); assert.equal(row.salt.length, 32);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { email } })).status, 429);
  h.tick(300001);
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { email, code: h.sent[0].code } })).status, 400);
  const failed = harness(t, { handler: { sender: async () => { throw new Error('private email credential'); } } });
  const response = await failed.request('/api/auth/code', { method: 'POST', body: { email } });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private email'));
  assert.equal(failed.store.db.prepare('SELECT COUNT(*) AS count FROM codes').get().count, 0);
});

test('membership: successful verification cannot reset the send-code cooldown', async t => {
  const h = harness(t); await h.login('cooldown@example.test');
  const immediately = await h.request('/api/auth/code', { method: 'POST', body: { email: 'cooldown@example.test' } });
  assert.equal(immediately.status, 429); assert.equal((await immediately.json()).error.code, 'code_cooldown');
  h.tick(60000);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { email: 'cooldown@example.test' } })).status, 200);
});

test('membership: Resend injection keeps token server-side and validates unavailable transport', async () => {
  assert.equal(createResendSender({ env: {} }), null);
  let options;
  const sender = createResendSender({ env: { RESEND_API_KEY: 'test-only', MEMBERSHIP_EMAIL_FROM: 'Guide <guide@example.test>' }, fetchImpl: async (url, value) => { assert.equal(url, 'https://api.resend.com/emails'); options = value; return Response.json({ id: 'test-email-id' }); } });
  await sender({ email: 'recipient@example.test', code: '123456' });
  assert.equal(options.headers.authorization, 'Bearer test-only');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body).to, ['recipient@example.test']);
  assert.match(JSON.parse(options.body).text, /123456/);
  const failing = createResendSender({ env: { RESEND_API_KEY: 'test-only', MEMBERSHIP_EMAIL_FROM: 'guide@example.test' }, fetchImpl: async () => new Response('do not expose', { status: 503 }) });
  await assert.rejects(() => failing({ email: 'r@example.test', code: '123456' }));
});

test('membership: missing secret fails private writes closed even if an old session still exists', async t => {
  const h = harness(t), user = await h.login(), guide = await createGuide(h, user.cookie);
  const changed = createMembershipHandler({ store: h.store, env: { MEMBERSHIP_AUTH_SECRET: '', MEMBERSHIP_APP_ORIGIN: BASE }, sender: null, getCorpus: () => corpus });
  const response = await changed(new Request(`${BASE}/api/guides/${guide.id}`, { method: 'PATCH', headers: { cookie: user.cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, content: '不能用空秘密写入' }) }));
  assert.equal(response.status, 503);
  const me = await changed(new Request(`${BASE}/api/me`, { headers: { cookie: user.cookie, origin: BASE } }));
  assert.equal((await me.json()).user, null);
  const existing = createMembershipHandler({ store: h.store, env: { MEMBERSHIP_AUTH_SECRET: SECRET, MEMBERSHIP_APP_ORIGIN: BASE }, sender: null, getCorpus: () => corpus });
  const read = await existing(new Request(`${BASE}/api/guides/${guide.id}`, { headers: { cookie: user.cookie, origin: BASE } }));
  assert.equal(read.status, 200); assert.equal((await read.json()).guide.revision, 1);
});

test('membership: guides CRUD is private and content/facts/tasks only change on explicit writes', async t => {
  let modelCalls = 0;
  const h = harness(t, { handler: { personalQaHandler: async (_request, context) => { modelCalls++; return asResponse({ ...answered, draft: { title: context.guide.title, content: '待确认的新版内容', sourceIds: ['2-13'], tasks: context.guide.tasks } }); } } });
  const alice = await h.login(), bob = await h.login('bob@example.test');
  const guide = await createGuide(h, alice.cookie);
  assert.equal(guide.revision, 1);
  for (const path of [`/api/guides/${guide.id}`, `/api/guides/${guide.id}/versions`, `/api/guides/${guide.id}/export`]) assert.equal((await h.request(path, { cookie: bob.cookie })).status, 404);
  assert.equal((await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: bob.cookie, body: { revision: 1, content: 'attack' } })).status, 404);
  assert.equal((await h.request(`/api/guides/${guide.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);
  const asked = await h.request(`/api/guides/${guide.id}/ask`, { method: 'POST', cookie: alice.cookie, body: { question: '怎样睡得更好', requestId: 'personal-request-01' } });
  assert.equal(asked.status, 200); assert.equal(modelCalls, 1);
  const afterAsk = (await data(await h.request(`/api/guides/${guide.id}`, { cookie: alice.cookie }))).guide;
  assert.deepEqual(afterAsk, guide); assert.equal(afterAsk.tasks[0].done, false);
  const updated = await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: alice.cookie, body: { revision: 1, content: '我主动确认的新计划', tasks: [{ ...guide.tasks[0], done: true }] } });
  assert.equal(updated.status, 200); const next = (await updated.json()).guide;
  assert.equal(next.revision, 2); assert.equal(next.tasks[0].done, true);
  const conflict = await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: alice.cookie, body: { revision: 1, content: '旧页面覆盖' } });
  assert.equal(conflict.status, 409);
  assert.equal((await data(await h.request(`/api/guides/${guide.id}`, { cookie: alice.cookie }))).guide.content, '我主动确认的新计划');
  const raw = h.store.db.prepare('SELECT content_cipher FROM guides WHERE id=?').get(guide.id).content_cipher;
  assert.ok(!raw.includes('新计划'));
});

test('membership: guide versions can be viewed/restored, restore is a new revision and delete removes history', async t => {
  const h = harness(t), user = await h.login(), guide = await createGuide(h, user.cookie);
  await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: user.cookie, body: { revision: 1, content: '第二版', tasks: [{ ...guide.tasks[0], done: true }] } });
  const versions = (await data(await h.request(`/api/guides/${guide.id}/versions`, { cookie: user.cookie }))).versions;
  assert.deepEqual(versions.map(version => version.revision), [2, 1]);
  const old = (await data(await h.request(`/api/guides/${guide.id}/versions/${versions[1].id}`, { cookie: user.cookie }))).version;
  assert.equal(old.content, guide.content); assert.equal(old.tasks[0].done, false);
  assert.equal((await h.request(`/api/guides/${guide.id}/restore`, { method: 'POST', cookie: user.cookie, body: { revision: 1, versionId: versions[1].id } })).status, 409);
  const response = await h.request(`/api/guides/${guide.id}/restore`, { method: 'POST', cookie: user.cookie, body: { revision: 2, versionId: versions[1].id } });
  const restored = (await response.json()).guide; assert.equal(restored.revision, 3); assert.equal(restored.content, guide.content); assert.equal(restored.tasks[0].done, false);
  const exported = await h.request(`/api/guides/${guide.id}/export`, { cookie: user.cookie });
  assert.match(exported.headers.get('content-type'), /text\/markdown/); assert.match(exported.headers.get('content-disposition'), /attachment/);
  const markdown = await exported.text(); assert.match(markdown, /# 我的睡眠指南/); assert.match(markdown, /\[ \] 稳定起床时间/); assert.match(markdown, /2-13/);
  assert.equal((await h.request(`/api/guides/${guide.id}`, { method: 'DELETE', cookie: user.cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.request(`/api/guides/${guide.id}`, { method: 'DELETE', cookie: user.cookie })).status, 200);
  assert.equal((await h.request(`/api/guides/${guide.id}/export`, { cookie: user.cookie })).status, 404);
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM guide_versions WHERE guide_id=?').get(guide.id).count, 0);
});

test('membership: confirmed profile is separate, revision-controlled, caller timestamps ignored and only selected facts sent', async t => {
  let received;
  const h = harness(t, { handler: { personalQaHandler: async (_request, context) => { received = context; return asResponse(answered); } } });
  const alice = await h.login(), bob = await h.login('bob@example.test');
  const profile = await data(await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 0, facts: [{ id: 'schedule', label: '作息', value: '轮班', confirmedAt: 'forged' }, { id: 'private', label: '不相关资料', value: '不应被发送' }] } }));
  assert.equal(profile.revision, 1); assert.notEqual(profile.facts[0].confirmedAt, 'forged');
  assert.deepEqual(await data(await h.request('/api/profile', { cookie: bob.cookie })), { facts: [], revision: 0 });
  const guide = await createGuide(h, alice.cookie, { factIds: ['schedule'] });
  const asked = await h.request(`/api/guides/${guide.id}/ask`, { method: 'POST', cookie: alice.cookie, body: { question: '怎样睡得更好', requestId: 'profile-request-01', factIds: ['schedule'], context: { facts: ['evil'] } } });
  assert.equal(asked.status, 200); assert.deepEqual(received.profileFacts.map(fact => fact.id), ['schedule']);
  assert.ok(!JSON.stringify(received).includes('不应被发送'));
  assert.equal((await h.request(`/api/guides/${guide.id}/ask`, { method: 'POST', cookie: alice.cookie, body: { question: '怎样睡得更好', requestId: 'profile-request-02', factIds: ['unknown'] } })).status, 400);
  assert.equal((await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 0, facts: [] } })).status, 409);
  const repeated = await data(await h.request('/api/profile', { method: 'PATCH', cookie: alice.cookie, body: { revision: 1, facts: profile.facts } }));
  assert.equal(repeated.facts[0].confirmedAt, profile.facts[0].confirmedAt);
  assert.equal(h.store.me(h.store.sessionUser('bad-hash')).user, null);
});

test('membership: sources/facts/tasks are validated; five free guides are enforced, old guides remain editable', async t => {
  const h = harness(t), user = await h.login();
  for (const body of [guideInput({ sourceIds: ['999-999'] }), guideInput({ factIds: ['unconfirmed'] }), guideInput({ tasks: [{ id: 'task', title: 'x', done: 'true' }] })]) assert.equal((await h.request('/api/guides', { method: 'POST', cookie: user.cookie, body })).status, 400);
  const guides = [];
  for (let i = 0; i < 5; i++) guides.push(await createGuide(h, user.cookie, { title: `指南 ${i + 1}` }));
  const full = await h.request('/api/guides', { method: 'POST', cookie: user.cookie, body: guideInput() }); assert.equal(full.status, 409); assert.equal((await full.json()).error.code, 'guide_limit');
  const list = await data(await h.request('/api/guides', { cookie: user.cookie })); assert.equal(list.limit, 5); assert.equal(list.remaining, 0);
  h.tick(365 * DAY);
  // 登录会话到期后重新登录，档案不是跟着会员或 session 一起删除。
  const again = await h.login();
  assert.equal((await h.request(`/api/guides/${guides[0].id}`, { method: 'PATCH', cookie: again.cookie, body: { revision: 1, content: '到期后仍可编辑' } })).status, 200);
});

test('membership: removed facts do not block editing, original source snapshots survive later corpus updates', async t => {
  let current = structuredClone(corpus);
  const h = harness(t, { handler: { getCorpus: () => current } }), user = await h.login();
  await h.request('/api/profile', { method: 'PATCH', cookie: user.cookie, body: { revision: 0, facts: [{ id: 'old-fact', label: '作息', value: '轮班' }] } });
  const guide = await createGuide(h, user.cookie, { factIds: ['old-fact'], sourceSnapshots: { '2-13': { snapshotDate: 'forged' } } });
  assert.equal(guide.snapshotDate, '2026-10-03'); assert.equal(guide.sourceSnapshots['2-13'].snapshotDate, '2026-10-03');
  await h.request('/api/profile', { method: 'PATCH', cookie: user.cookie, body: { revision: 1, facts: [] } });
  current.source.snapshotDate = '2026-10-04'; current.source.revision = 'new-revision'; current.chapters[0].entries.push({ ...entry, id: '2-14', number: 14, title: '另一条建议' });
  const edited = await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: user.cookie, body: { revision: 1, content: '仍然可以修改', sourceIds: ['2-13', '2-14'] } });
  assert.equal(edited.status, 200); const next = (await edited.json()).guide;
  assert.deepEqual(next.factIds, []); assert.equal(next.sourceSnapshots['2-13'].snapshotDate, '2026-10-03'); assert.equal(next.sourceSnapshots['2-14'].snapshotDate, '2026-10-04');
  const exported = await (await h.request(`/api/guides/${guide.id}/export`, { cookie: user.cookie })).text(); assert.match(exported, /2026-10-03/); assert.match(exported, /2026-10-04/); assert.match(exported, /test-revision/); assert.match(exported, /new-revision/);
  const versions = (await data(await h.request(`/api/guides/${guide.id}/versions`, { cookie: user.cookie }))).versions;
  const old = (await data(await h.request(`/api/guides/${guide.id}/versions/${versions[1].id}`, { cookie: user.cookie }))).version; assert.equal(old.sourceSnapshots['2-13'].snapshotDate, '2026-10-03');
});

test('membership: verified provider opens one entitlement, renewals schedule and annual tail retains a quota period', async t => {
  let payment, calls = 0;
  const provider = { merchantId: 'test-merchant', createCheckout: async () => { calls++; return { checkoutUrl: 'https://pay.example.test/order' }; }, verifyPayment: async () => payment };
  const h = harness(t, { env: { MEMBERSHIP_ANNUAL_ENABLED: 'true' }, handler: { paymentProvider: provider } }), user = await h.login();
  const buy = async (planId, requestId) => (await data(await h.request('/api/orders', { method: 'POST', cookie: user.cookie, body: { planId, requestId, amountFen: 1, status: 'paid', userId: 'attacker' } }))).order;
  const month = await buy('member-month', 'monthly-order-01'); const repeated = await buy('member-month', 'monthly-order-01'); assert.equal(month.id, repeated.id); assert.equal(calls, 1); assert.equal(month.amountFen, 1900);
  payment = { status: 'paid', merchantId: 'wrong-merchant', orderId: month.id, amountFen: 1900, currency: 'CNY', transactionId: 'txn-month' };
  assert.equal((await h.request(`/api/orders/${month.id}`, { cookie: user.cookie })).status, 502);
  payment.merchantId = provider.merchantId;
  const paid = await data(await h.request(`/api/orders/${month.id}`, { cookie: user.cookie })); assert.equal(paid.order.status, 'paid'); assert.equal(paid.membership.planId, 'member-month'); assert.equal(paid.quota.limit, 200);
  await h.request(`/api/orders/${month.id}`, { cookie: user.cookie });
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM entitlements').get().count, 1);
  const year = await buy('member-year', 'annual-order-01'); assert.equal(year.amountFen, 12900);
  payment = { ...payment, orderId: year.id, amountFen: 12900, transactionId: 'txn-year' };
  await h.request(`/api/orders/${year.id}`, { cookie: user.cookie });
  const entitlements = h.store.db.prepare('SELECT * FROM entitlements ORDER BY starts_at').all(); assert.equal(entitlements[1].starts_at, entitlements[0].ends_at); assert.equal(entitlements[1].ends_at - entitlements[1].starts_at, 365 * DAY);
  h.tick(30 * DAY + 361 * DAY);
  const relogin = await h.login(); const tail = await data(await h.request('/api/me', { cookie: relogin.cookie }));
  assert.equal(tail.membership.planId, 'member-year'); assert.equal(tail.quota.limit, 200); assert.equal(tail.quota.resetsAt, tail.membership.expiresAt);
  assert.equal((await data(await h.request('/api/guides', { cookie: relogin.cookie }))).limit, 100);
});

test('membership: same-user concurrency cannot overspend and cancelled request releases reservation', async t => {
  let complete, calls = 0;
  const h = harness(t, { env: { MEMBERSHIP_ENFORCE: 'true' }, handler: { qaHandler: async () => { calls++; await new Promise(resolve => { complete = resolve; }); return asResponse(answered); } } });
  const user = await h.login(), controller = new AbortController();
  const first = h.request('/api/ask', { method: 'POST', cookie: user.cookie, signal: controller.signal, body: { question: '怎样睡得更好', requestId: 'pending-request-01' } });
  while (!complete) await new Promise(resolve => setTimeout(resolve, 1));
  const repeat = await h.request('/api/ask', { method: 'POST', cookie: user.cookie, body: { question: '怎样睡得更好', requestId: 'pending-request-01' } }); assert.equal(repeat.status, 409);
  const another = await h.request('/api/ask', { method: 'POST', cookie: user.cookie, body: { question: '怎样睡得更好', requestId: 'pending-request-02' } }); assert.equal(another.status, 429); assert.equal(calls, 1);
  controller.abort(); complete();
  assert.equal((await first).status, 499);
  const me = await data(await h.request('/api/me', { cookie: user.cookie })); assert.equal(me.quota.used, 0); assert.equal(me.quota.remaining, 10);
  assert.equal(h.store.db.prepare('SELECT reserved FROM quota_periods').get().reserved, 0);
});

test('membership: private asks have contextual idempotency and no auto profile/guide changes', async t => {
  let calls = 0;
  const h = harness(t, { handler: { personalQaHandler: async () => { calls++; return asResponse({ ...answered, draft: { title: '更新草稿', content: '仍待确认', sourceIds: ['2-13'], tasks: [] } }); } } }), user = await h.login(), guide = await createGuide(h, user.cookie);
  const ask = () => h.request(`/api/guides/${guide.id}/ask`, { method: 'POST', cookie: user.cookie, body: { question: '怎样睡得更好', requestId: 'context-request-01' } });
  assert.equal((await ask()).status, 200); const reused = await data(await ask()); assert.equal(reused.reused, true); assert.equal(calls, 1);
  await h.request(`/api/guides/${guide.id}`, { method: 'PATCH', cookie: user.cookie, body: { revision: 1, content: '我的上下文已变更' } });
  const conflict = await ask(); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'request_id_conflict');
  assert.deepEqual(await data(await h.request('/api/profile', { cookie: user.cookie })), { facts: [], revision: 0 });
  const raw = h.store.db.prepare('SELECT * FROM generations').get(); assert.ok(!raw.result_cipher.includes('待确认')); assert.ok(!Object.values(raw).includes('怎样睡得更好'));
});

test('membership: persistent restart keeps sessions, guides, encrypted profile and versions; hanging quota is recovered', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'better-life-membership-test-')), filename = join(dir, 'membership.sqlite');
  t.after(() => { for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) if (existsSync(path)) unlinkSync(path); rmdirSync(dir); });
  const h = harness(t, { filename }), user = await h.login(), guide = await createGuide(h, user.cookie);
  await h.request('/api/profile', { method: 'PATCH', cookie: user.cookie, body: { revision: 0, facts: [{ id: 'private', label: '个人资料', value: '我的私人情况' }] } });
  const logged = h.store.db.prepare('SELECT * FROM users').get(); h.store.reserve(logged, 'hanging-request-01', 'question-hash-only');
  h.store.close();
  let clock = h.now() + 120001;
  const restarted = createMembershipStore({ filename, now: () => clock }); t.after(() => { try { restarted.close(); } catch {} });
  const handle = createMembershipHandler({ store: restarted, env: { MEMBERSHIP_AUTH_SECRET: SECRET, MEMBERSHIP_APP_ORIGIN: BASE }, now: () => clock, sender: async () => {}, getCorpus: () => corpus });
  const response = await handle(new Request(`${BASE}/api/guides/${guide.id}`, { headers: { origin: BASE, cookie: user.cookie } })); assert.equal(response.status, 200); assert.equal((await response.json()).guide.title, guide.title);
  assert.equal(restarted.db.prepare('SELECT reserved FROM quota_periods').get().reserved, 0);
  assert.equal(restarted.db.prepare('SELECT status FROM generations').get().status, 'released');
  const profile = await handle(new Request(`${BASE}/api/profile`, { headers: { origin: BASE, cookie: user.cookie } })); assert.equal((await profile.json()).facts[0].value, '我的私人情况');
  assert.equal(restarted.guideVersions(logged, guide.id).length, 1);
  assert.ok(!restarted.db.prepare('SELECT facts_cipher FROM profiles').get().facts_cipher.includes('私人情况'));
  restarted.close();
});

test('membership: saved responses are user-provided, sources are canonical and other users cannot read/delete them', async t => {
  const h = harness(t), alice = await h.login(), bob = await h.login('bob@example.test');
  const result = { ...answered, sources: [{ id: '2-13', title: 'fake title', sourceUrl: 'https://attacker.test' }] };
  const response = await h.request('/api/saved-answers', { method: 'POST', cookie: alice.cookie, body: { result } }); assert.equal(response.status, 201);
  const saved = (await response.json()).answer; assert.equal(saved.result.provenance, 'user-provided'); assert.equal(saved.result.model, '用户保存'); assert.equal(saved.result.sources[0].title, entry.title); assert.ok(!JSON.stringify(saved).includes('attacker.test'));
  assert.deepEqual((await data(await h.request('/api/saved-answers', { cookie: bob.cookie }))).answers, []);
  assert.equal((await h.request(`/api/saved-answers/${saved.id}`, { method: 'DELETE', cookie: bob.cookie })).status, 404);
  assert.equal((await h.request(`/api/saved-answers/${saved.id}`, { method: 'DELETE', cookie: alice.cookie })).status, 200);
});
