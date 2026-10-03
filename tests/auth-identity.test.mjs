import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMembershipStore, DAY, hash } from '../server/membership-store.mjs';
import { createMembershipHandler, createResendSender } from '../server/membership.mjs';

// 传输和问答全部注入 mock；不发真实邮件/短信、不消费真实模型或支付。
const BASE = 'http://127.0.0.1:4218';
const SECRET = 'test-only-dual-identity-auth-secret-long-enough';
function harness(t, options = {}) {
  let clock = Date.UTC(2026, 9, 3), client = '127.0.0.1';
  const now = () => clock, sent = [], store = createMembershipStore({ filename: options.filename, now });
  t.after(() => { try { store.close(); } catch {} });
  const handler = createMembershipHandler({
    env: { MEMBERSHIP_AUTH_SECRET: SECRET, MEMBERSHIP_APP_ORIGIN: BASE, ...options.env }, store, now,
    sender: async value => { sent.push({ channel: 'email', ...value }); },
    phoneSender: async value => { sent.push({ channel: 'phone', ...value }); },
    getClientId: () => client, ...options.handler,
  });
  const request = (path, { method = 'GET', body, cookie, origin = BASE, headers = {} } = {}) => handler(new Request(`${BASE}${path}`, {
    method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const login = async identity => {
    assert.equal((await request('/api/auth/code', { method: 'POST', body: identity })).status, 200);
    const code = sent.at(-1).code, response = await request('/api/auth/verify', { method: 'POST', body: { ...identity, code } });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], data: await response.json(), code };
  };
  return { request, login, sent, store, tick: ms => { clock += ms; }, client: value => { client = value; } };
}
const body = response => response.json();
function removeTestDatabase(directory, stores) {
  for (const store of stores) { try { store?.close(); } catch {} }
  for (const name of ['member.sqlite', 'member.sqlite-wal', 'member.sqlite-shm']) { const path = join(directory, name); if (existsSync(path)) unlinkSync(path); }
  rmdirSync(directory);
}

test('auth identity: mainland phone login normalizes, rotates sessions and grants real free quota', async t => {
  const h = harness(t), account = await h.login({ phone: '13800138000' });
  assert.equal(h.sent[0].phone, '+8613800138000');
  assert.equal(account.data.user.email, null);
  assert.equal(account.data.user.phone, '+8613800138000');
  assert.equal(account.data.user.authentication, 'phone');
  assert.equal(account.data.quota.limit, 10); assert.equal(account.data.quota.remaining, 10);
  assert.ok(!JSON.stringify(account.data).includes('@local.invalid'));
  const cookie = (await h.request('/api/me', { cookie: account.cookie }));
  assert.equal((await body(cookie)).user.id, account.data.user.id);
  h.tick(60000);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { phone: '+8613800138000' } })).status, 200);
  const next = await h.request('/api/auth/verify', { method: 'POST', cookie: account.cookie, body: { phone: '13800138000', code: h.sent.at(-1).code } });
  assert.equal(next.status, 200); assert.equal((await body(next)).user.id, account.data.user.id);
  assert.equal((await body(await h.request('/api/me', { cookie: account.cookie }))).user, null);
  const newCookie = next.headers.get('set-cookie').split(';')[0];
  assert.equal((await h.request('/api/auth/logout', { method: 'POST', cookie: newCookie })).status, 200);
  assert.equal((await body(await h.request('/api/me', { cookie: newCookie }))).user, null);
});

test('auth identity: identity inputs are exactly one valid email or mainland phone, never reserved synthetic email', async t => {
  const h = harness(t);
  for (const value of [{}, { email: 'a@example.test', phone: '13800138000' }, { email: '', phone: '13800138000' }, { phone: 13800138000 }, { phone: '12800138000' }, { phone: '+14155551234' }, { phone: '1380013800' }, { email: 'phone-unknown@local.invalid' }]) {
    assert.equal((await h.request('/api/auth/code', { method: 'POST', body: value })).status, 400);
  }
  assert.equal(h.sent.length, 0);
});

test('auth identity: per-channel readiness does not claim a missing transport is available', async t => {
  const phone = harness(t, { handler: { sender: null } });
  const status = await body(await phone.request('/api/membership'));
  assert.equal(status.loginAvailable, true); assert.equal(status.phoneLoginAvailable, true); assert.equal(status.emailLoginAvailable, false);
  assert.equal((await phone.request('/api/auth/code', { method: 'POST', body: { email: 'a@example.test' } })).status, 503);
  await phone.login({ phone: '13800138000' });
  const email = harness(t, { handler: { phoneSender: null } });
  const emailStatus = await body(await email.request('/api/membership'));
  assert.equal(emailStatus.emailLoginAvailable, true); assert.equal(emailStatus.phoneLoginAvailable, false);
  assert.equal((await email.request('/api/auth/code', { method: 'POST', body: { phone: '13800138000' } })).status, 503);
  const missingSecret = harness(t, { env: { MEMBERSHIP_AUTH_SECRET: '' } });
  const unavailable = await body(await missingSecret.request('/api/membership'));
  assert.equal(unavailable.loginAvailable, false); assert.equal(unavailable.emailLoginAvailable, false); assert.equal(unavailable.phoneLoginAvailable, false);
  assert.equal((await missingSecret.request('/api/auth/verify', { method: 'POST', body: { phone: '13800138000', code: '123456' } })).status, 503);
});

test('auth identity: login and link mutations reject missing/foreign Origin and cross-site requests', async t => {
  const h = harness(t), account = await h.login({ email: 'csrf@example.test' });
  for (const path of ['/api/auth/code', '/api/auth/verify', '/api/auth/link/code', '/api/auth/link/verify']) {
    for (const origin of [null, 'https://attacker.example']) {
      assert.equal((await h.request(path, { method: 'POST', cookie: account.cookie, origin, body: { phone: '13800138000', code: '123456' } })).status, 403);
    }
    assert.equal((await h.request(path, { method: 'POST', cookie: account.cookie, headers: { 'sec-fetch-site': 'cross-site' }, body: { phone: '13800138000', code: '123456' } })).status, 403);
  }
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', body: { phone: '13800138000' } })).status, 401);
  assert.equal((await h.request('/api/auth/link/verify', { method: 'POST', body: { phone: '13800138000', code: '123456' } })).status, 401);
});

test('auth identity: verified email binding reuses phone account, quotas and paid membership without implicit merge', async t => {
  const h = harness(t), phone = await h.login({ phone: '13800138000' });
  const user = h.store.db.prepare('SELECT * FROM users WHERE id=?').get(phone.data.user.id);
  h.store.reserve(user, 'same-account-request', 'question-hash'); h.store.finish(user.id, 'same-account-request', true, 'encrypted-mock-answer');
  const oldQuota = h.store.me(user).quota;
  const linkedEmail = { email: 'bound@example.test' };
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: phone.cookie, body: linkedEmail })).status, 200);
  assert.equal(h.sent.at(-1).purpose, 'link');
  const verified = await h.request('/api/auth/link/verify', { method: 'POST', cookie: phone.cookie, body: { ...linkedEmail, code: h.sent.at(-1).code } });
  assert.equal(verified.status, 200);
  const linked = await body(verified); assert.equal(linked.user.id, phone.data.user.id); assert.equal(linked.user.email, linkedEmail.email); assert.equal(linked.user.phone, '+8613800138000');
  assert.deepEqual(linked.quota, oldQuota);
  assert.equal((await body(await h.request('/api/me', { cookie: phone.cookie }))).user, null);
  h.tick(60000);
  const email = await h.login(linkedEmail); assert.equal(email.data.user.id, phone.data.user.id); assert.equal(email.data.quota.used, 1);
  // 模拟已验签支付的存储层；不调用真实收款，权益以 user.id 为唯一账户键。
  const plan = { id: 'member-month', name: '月度会员', amountFen: 1900, currency: 'CNY', durationDays: 30 };
  const order = h.store.createOrder(user, plan, 'mock-paid-order-01', 'mock-auth-merchant').order;
  h.store.confirmPaid(order, { status: 'paid', merchantId: 'mock-auth-merchant', orderId: order.id, transactionId: 'mock-payment-01', amountFen: 1900, currency: 'CNY' });
  h.tick(60000);
  const phoneAgain = await h.login({ phone: '+8613800138000' });
  assert.equal(phoneAgain.data.user.id, email.data.user.id); assert.equal(phoneAgain.data.membership.planId, 'member-month'); assert.equal(phoneAgain.data.quota.limit, 200);
});

test('auth identity: email account binds phone only with OTP and both channels then use the same user.id', async t => {
  const h = harness(t), account = await h.login({ email: 'email-first@example.test' });
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: account.cookie, body: { phone: '13900139000' } })).status, 200);
  const sent = h.sent.at(-1);
  assert.equal((await h.request('/api/auth/link/verify', { method: 'POST', cookie: account.cookie, body: { phone: '13900139000', code: 'invalid' } })).status, 400);
  const linked = await h.request('/api/auth/link/verify', { method: 'POST', cookie: account.cookie, body: { phone: '13900139000', code: sent.code } });
  assert.equal(linked.status, 200); assert.equal((await body(linked)).user.id, account.data.user.id);
  h.tick(60000);
  const phone = await h.login({ phone: '+8613900139000' }); assert.equal(phone.data.user.id, account.data.user.id);
});

test('auth identity: occupied identities do not merge accounts or change either entitlement', async t => {
  const h = harness(t), phone = await h.login({ phone: '13800138000' }), email = await h.login({ email: 'separate@example.test' });
  assert.notEqual(phone.data.user.id, email.data.user.id);
  const sentCount = h.sent.length;
  const occupied = await h.request('/api/auth/link/code', { method: 'POST', cookie: phone.cookie, body: { email: 'separate@example.test' } });
  assert.equal(occupied.status, 409); assert.equal((await body(occupied)).error.code, 'identity_in_use'); assert.equal(h.sent.length, sentCount);
  assert.equal((await body(await h.request('/api/me', { cookie: phone.cookie }))).user.email, null);
  assert.equal((await body(await h.request('/api/me', { cookie: email.cookie }))).user.phone, null);
  h.tick(60000);
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: email.cookie, body: { email: 'replace@example.test' } })).status, 409);
});

test('auth identity: ownership race between delivery and link verification consumes OTP without merging', async t => {
  const h = harness(t), first = await h.login({ email: 'first@example.test' });
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: first.cookie, body: { phone: '13800138000' } })).status, 200);
  const linkCode = h.sent.at(-1).code;
  h.tick(60000);
  const second = await h.login({ phone: '13800138000' });
  const response = await h.request('/api/auth/link/verify', { method: 'POST', cookie: first.cookie, body: { phone: '13800138000', code: linkCode } });
  assert.equal(response.status, 409); assert.equal((await body(response)).error.code, 'identity_in_use');
  assert.equal((await h.request('/api/auth/link/verify', { method: 'POST', cookie: first.cookie, body: { phone: '13800138000', code: linkCode } })).status, 400);
  assert.notEqual(first.data.user.id, second.data.user.id);
});

test('auth identity: channel, login/link purpose and target user OTP scopes cannot be confused', async t => {
  const h = harness(t), alice = await h.login({ email: 'alice@example.test' }), bob = await h.login({ email: 'bob@example.test' });
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: alice.cookie, body: { phone: '13800138000' } })).status, 200);
  const code = h.sent.at(-1).code;
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { phone: '13800138000', code } })).status, 400);
  assert.equal((await h.request('/api/auth/link/verify', { method: 'POST', cookie: bob.cookie, body: { phone: '13800138000', code } })).status, 400);
  assert.equal((await h.request('/api/auth/link/verify', { method: 'POST', cookie: alice.cookie, body: { email: '13800138000@example.test', code } })).status, 400);
  assert.equal((await h.request('/api/auth/link/verify', { method: 'POST', cookie: alice.cookie, body: { phone: '13800138000', code } })).status, 200);
  assert.equal((await h.request('/api/auth/link/verify', { method: 'POST', cookie: alice.cookie, body: { phone: '13800138000', code } })).status, 401);
});

test('auth identity: untrusted target identifiers cannot redirect a binding to another account', async t => {
  const h = harness(t), alice = await h.login({ email: 'real-owner@example.test' }), bob = await h.login({ email: 'requested-owner@example.test' });
  const identity = { phone: '13800138000', userId: bob.data.user.id, accountId: bob.data.user.id, targetUserId: bob.data.user.id };
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: alice.cookie, body: identity })).status, 200);
  const row = h.store.db.prepare("SELECT * FROM codes WHERE purpose='link'").get();
  assert.equal(row.target_user_id, alice.data.user.id);
  const verified = await h.request('/api/auth/link/verify', { method: 'POST', cookie: alice.cookie, body: { ...identity, code: h.sent.at(-1).code } });
  assert.equal(verified.status, 200); assert.equal((await body(verified)).user.id, alice.data.user.id);
  assert.equal((await body(await h.request('/api/me', { cookie: bob.cookie }))).user.phone, null);
});

test('auth identity: phone OTP is hashed, single-use, expires, persists failed attempts and invalidates old resend code', async t => {
  const h = harness(t), identity = { phone: '13800138000' };
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: identity })).status, 200);
  const first = h.sent.at(-1).code, row = h.store.db.prepare("SELECT * FROM codes WHERE channel='phone'").get();
  assert.equal(row.digest.length, 64); assert.notEqual(row.digest, first);
  const wrong = first === '000000' ? '999999' : '000000';
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { ...identity, code: wrong } })).status, 400);
  assert.equal(h.store.db.prepare("SELECT attempts FROM codes WHERE channel='phone'").get().attempts, 5);
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { ...identity, code: first } })).status, 400);
  h.tick(60000);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: identity })).status, 200);
  const next = h.sent.at(-1).code;
  if (next !== first) assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { ...identity, code: first } })).status, 400);
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { ...identity, code: next } })).status, 200);
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { ...identity, code: next } })).status, 400);
  h.tick(60000);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: identity })).status, 200);
  const expired = h.sent.at(-1).code; h.tick(300001);
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { ...identity, code: expired } })).status, 400);
});

test('auth identity: failed SMS delivery revokes OTP and never leaks provider credentials', async t => {
  let deliveredCode;
  const h = harness(t, { handler: { phoneSender: async ({ code }) => { deliveredCode = code; throw new Error('private-provider-credential-response'); } } });
  const response = await h.request('/api/auth/code', { method: 'POST', body: { phone: '13800138000' } });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('private-provider'));
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM codes').get().count, 0);
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { phone: '13800138000', code: deliveredCode } })).status, 400);
});

test('auth identity: phone OTP attempts and logged-in account identity survive an actual SQLite reopen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-auth-restart-'));
  const filename = join(directory, 'member.sqlite'), h = harness(t, { filename });
  let restartedStore;
  t.after(() => removeTestDatabase(directory, [h.store, restartedStore]));
  const identity = { phone: '13800138000' };
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: identity })).status, 200);
  const code = h.sent.at(-1).code, wrong = code === '000000' ? '999999' : '000000';
  assert.equal((await h.request('/api/auth/verify', { method: 'POST', body: { ...identity, code: wrong } })).status, 400);
  h.store.close();
  restartedStore = createMembershipStore({ filename, now: () => Date.UTC(2026, 9, 3) });
  assert.equal(restartedStore.db.prepare("SELECT attempts FROM codes WHERE channel='phone'").get().attempts, 1);
  const handler = createMembershipHandler({ store: restartedStore, env: { MEMBERSHIP_AUTH_SECRET: SECRET, MEMBERSHIP_APP_ORIGIN: BASE }, phoneSender: async () => assert.fail('no resend needed'), sender: null });
  const request = (path, value, cookie) => handler(new Request(`${BASE}${path}`, { method: value ? 'POST' : 'GET', headers: { origin: BASE, ...(value ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }));
  const response = await request('/api/auth/verify', { ...identity, code }); assert.equal(response.status, 200);
  const user = (await body(response)).user, cookie = response.headers.get('set-cookie').split(';')[0];
  restartedStore.close();
  restartedStore = createMembershipStore({ filename, now: () => Date.UTC(2026, 9, 3) });
  const reloaded = createMembershipHandler({ store: restartedStore, env: { MEMBERSHIP_AUTH_SECRET: SECRET, MEMBERSHIP_APP_ORIGIN: BASE }, sender: null, phoneSender: null });
  const me = await body(await reloaded(new Request(`${BASE}/api/me`, { headers: { origin: BASE, cookie } })));
  assert.equal(me.user.id, user.id); assert.equal(me.user.phone, '+8613800138000'); assert.equal(me.user.email, null);
  assert.equal(me.quota.remaining, 10);
});

test('auth identity: per-identity cooldown is shared across purpose and global SMS daily budget is persistent', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-auth-budget-'));
  const filename = join(directory, 'member.sqlite'), h = harness(t, { filename, env: { MEMBERSHIP_SMS_DAILY_LIMIT: '2' } });
  let restartedStore;
  t.after(() => removeTestDatabase(directory, [h.store, restartedStore]));
  const alice = await h.login({ email: 'budget@example.test' });
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { phone: '13800138000' } })).status, 200);
  assert.equal((await h.request('/api/auth/link/code', { method: 'POST', cookie: alice.cookie, body: { phone: '13800138000' } })).status, 429);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { phone: '13900139000' } })).status, 200);
  restartedStore = createMembershipStore({ filename, now: () => Date.UTC(2026, 9, 3) });
  const handler = createMembershipHandler({ store: restartedStore, env: { MEMBERSHIP_AUTH_SECRET: SECRET, MEMBERSHIP_APP_ORIGIN: BASE, MEMBERSHIP_SMS_DAILY_LIMIT: '2' }, sender: null, phoneSender: async () => assert.fail('budget must stop provider') });
  const response = await handler(new Request(`${BASE}/api/auth/code`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ phone: '13700137000' }) }));
  assert.equal(response.status, 429); assert.equal((await body(response)).error.code, 'rate_limited');
  h.tick(DAY);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { phone: '13700137000' } })).status, 200);
});

test('auth identity: local demo cannot bind formal credentials or become a paid identity', async t => {
  const h = harness(t, { env: { MEMBERSHIP_LOCAL_DEMO: 'true' } });
  const response = await h.request('/api/auth/local-demo', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0], account = await body(response);
  assert.equal(account.user.email, null); assert.equal(account.user.phone, null);
  for (const path of ['/api/auth/link/code', '/api/auth/link/verify']) assert.equal((await h.request(path, { method: 'POST', cookie, body: { email: 'formal@example.test', code: '123456' } })).status, 403);
  assert.equal(h.sent.length, 0);
  assert.equal((await body(await h.request('/api/me', { cookie }))).user.authentication, 'local-demo');
  const formal = await h.login({ email: 'formal@example.test' }); assert.notEqual(formal.data.user.id, account.user.id);
});

test('auth identity: old email SQLite users/sessions/guides/quotas migrate without changing owner IDs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-auth-migration-'));
  const filename = join(directory, 'member.sqlite'), legacy = new DatabaseSync(filename), timestamp = Date.UTC(2026, 9, 3);
  const oldToken = 'x'.repeat(43), oldPeriod = hash(`old-account-id:free:${timestamp}`);
  legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
    CREATE TABLE codes(email TEXT PRIMARY KEY,digest TEXT NOT NULL,salt TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE code_delivery(email_hash TEXT PRIMARY KEY,last_sent_at INTEGER NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE guides(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),content_cipher TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE quota_periods(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,limit_count INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users(id,email,created_at) VALUES('old-account-id','old@example.test',${timestamp});
    INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('${hash(oldToken)}','old-account-id',${timestamp + DAY});
    INSERT INTO code_delivery(email_hash,last_sent_at) VALUES('${hash('old@example.test')}',${timestamp});
    INSERT INTO guides(id,user_id,content_cipher,revision,created_at,updated_at) VALUES('old-guide-id','old-account-id','old-cipher-not-personal-data',3,${timestamp},${timestamp});
    INSERT INTO quota_periods(id,user_id,starts_at,ends_at,limit_count,used,reserved) VALUES('${oldPeriod}','old-account-id',${timestamp},${timestamp + 30 * DAY},10,1,0);`);
  legacy.close();
  const h = harness(t, { filename });
  t.after(() => removeTestDatabase(directory, [h.store]));
  assert.equal(h.store.db.prepare('SELECT user_id FROM account_identities WHERE identifier=?').get('old@example.test').user_id, 'old-account-id');
  const user = h.store.db.prepare('SELECT * FROM users WHERE id=?').get('old-account-id');
  const oldMe = await body(await h.request('/api/me', { cookie: `better_life_session=${oldToken}` }));
  assert.equal(oldMe.user.id, 'old-account-id'); assert.equal(oldMe.user.email, 'old@example.test'); assert.equal(oldMe.quota.used, 1);
  assert.equal((await h.request('/api/auth/code', { method: 'POST', body: { email: 'old@example.test' } })).status, 429);
  h.tick(60000);
  const loggedIn = await h.login({ email: 'old@example.test' });
  assert.equal(loggedIn.data.user.id, 'old-account-id'); assert.equal(loggedIn.data.quota.used, 1);
  assert.equal(h.store.ownedGuide(user, 'old-guide-id').content_cipher, 'old-cipher-not-personal-data');
  assert.equal(h.store.ownedGuide(user, 'old-guide-id').revision, 3);
});

test('auth identity: Resend accepts only official non-redirected requests and a non-empty accepted message ID', async () => {
  let options;
  const sender = createResendSender({ env: { RESEND_API_KEY: 'fake-test-token', MEMBERSHIP_EMAIL_FROM: 'guide@example.test' }, fetchImpl: async (url, value) => {
    assert.equal(url, 'https://api.resend.com/emails'); options = value;
    return Response.json({ id: 'test-accepted-message-id' });
  } });
  await sender({ email: 'recipient@example.test', code: '123456', purpose: 'link' });
  assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, 'Bearer fake-test-token');
  assert.match(JSON.parse(options.body).subject, /绑定邮箱验证码/);
  assert.ok(!/已送达|成功送达/.test(JSON.parse(options.body).text));
});

test('auth identity: Resend rejects empty IDs, malformed JSON, denied response and network error without leaking credentials/recipient', async () => {
  const cases = [
    () => Response.json({}), () => Response.json({ id: '' }), () => Response.json({ id: '  ' }),
    () => Response.json({ id: 123 }), () => Response.json({ id: null }),
    () => new Response('not-json private-test-token recipient@example.test'),
    () => Response.json({ error: 'private-test-token recipient@example.test' }, { status: 403 }),
    () => { throw new Error('private-test-token recipient@example.test network failure'); },
    () => new Response('', { status: 302, headers: { location: 'https://untrusted.example' } }),
  ];
  for (const fetchImpl of cases) {
    const sender = createResendSender({ env: { RESEND_API_KEY: 'private-test-token', MEMBERSHIP_EMAIL_FROM: 'guide@example.test' }, fetchImpl });
    await assert.rejects(() => sender({ email: 'recipient@example.test', code: '123456' }), value => {
      assert.equal(value.message, 'email_unavailable'); assert.ok(!value.stack.includes('private-test-token')); assert.ok(!value.stack.includes('recipient@example.test')); return true;
    });
  }
});

test('auth identity: Resend bad acceptance response revokes issued email OTP instead of claiming sent', async t => {
  const h = harness(t, { handler: { sender: createResendSender({ env: { RESEND_API_KEY: 'private-test-token', MEMBERSHIP_EMAIL_FROM: 'guide@example.test' }, fetchImpl: async () => Response.json({}) }) } });
  const response = await h.request('/api/auth/code', { method: 'POST', body: { email: 'recipient@example.test' } });
  assert.equal(response.status, 503); assert.equal((await body(response)).error.code, 'email_unavailable');
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS count FROM codes').get().count, 0);
});
