import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authIdentity, authRetrySeconds, maskPhone, memberIdentityLabel, validateMembershipStatus, validateMember, membershipRequest } from '../src/lib/membership-api.mjs';
import { MEMBERSHIP_PLANS } from '../shared/membership-plans.mjs';

const catalog = (extra = {}) => ({ plans: MEMBERSHIP_PLANS, loginAvailable: true, checkoutAvailable: false, ...extra });
const member = (user) => ({ user, membership: { planId: 'free' }, quota: { used: 0, remaining: 10, limit: 10 }, orders: [] });

test('auth UI: login contains only verification controls and optional checkout return', () => {
  const source = readFileSync(new URL('../src/components/membership/account-dialog.jsx', import.meta.url), 'utf8');
  const login = source.split('function LoginForm() {')[1].split('function LinkedIdentities() {')[0];
  assert.match(login, /<VerificationForm channels=\{\['phone', 'email'\]\}/);
  assert.match(login, /onSuccess=\{acceptLogin\}/);
  assert.match(login, /返回套餐明细/);
  assert.doesNotMatch(login, /<h3>|<p\b|member-symbol|member-lead|member-local-demo|auth\/local-demo|localDemoAvailable/);
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby=/);
  assert.match(source, /role="alert"/);
});

test('auth UI: branded visual hierarchy is scoped to login, without new login providers', () => {
  const source = readFileSync(new URL('../src/components/membership/account-dialog.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/auth-polish.css', import.meta.url), 'utf8');
  assert.match(source, /view === 'login' \? 'member-dialog member-dialog-login' : 'member-dialog'/);
  assert.match(source, /view === 'login' && <img className="member-login-brand"/);
  assert.match(source, /src=\{`\$\{base\}media\/brand\.webp`\}/);
  assert.match(css, /\.member-dialog-login \.member-toolbar h2\{font-size:28px/);
  assert.match(css, /\.member-dialog\.member-dialog-login\{width:min\(456px,100%\)/);
  assert.match(css, /\.member-dialog-login \.member-auth-form input\{height:52px;font-size:16px/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(source, /Login with Github|登录 Google|auth\/github|auth\/google/);
});

test('auth UI: old email-only catalog is compatible, never invents SMS capability', () => {
  const result = validateMembershipStatus(catalog());
  assert.equal(result.emailLoginAvailable, true);
  assert.equal(result.phoneLoginAvailable, false);
  assert.equal(validateMembershipStatus(catalog({ loginAvailable: false })).emailLoginAvailable, false);
});

test('auth UI: dual-channel capability derives from server flags, rejects malformed flags', () => {
  const result = validateMembershipStatus(catalog({ emailLoginAvailable: false, phoneLoginAvailable: true }));
  assert.equal(result.loginAvailable, true);
  assert.equal(result.emailLoginAvailable, false);
  assert.equal(result.phoneLoginAvailable, true);
  assert.equal(validateMembershipStatus(catalog({ emailLoginAvailable: false, phoneLoginAvailable: false })).loginAvailable, false);
  assert.throws(() => validateMembershipStatus(catalog({ phoneLoginAvailable: 'true' })), /登录服务/);
});

test('auth UI: request identity is strictly one channel with normalized mainland phone', () => {
  for (const value of ['13800138000', '+8613800138000', ' +86 138-0013-8000 ']) assert.deepEqual(authIdentity('phone', value), { phone: '+8613800138000' });
  assert.deepEqual(authIdentity('email', '  Alice@Example.com '), { email: 'alice@example.com' });
  assert.throws(() => authIdentity('phone', '+12125550100'), /中国大陆/);
  assert.throws(() => authIdentity('phone', '12800138000'), /中国大陆/);
  assert.throws(() => authIdentity('email', 'alice@'), /邮箱/);
  assert.throws(() => authIdentity('anything', 'alice@example.com'), /请选择/);
});

test('auth UI: session accepts phone-only, email-only, dual identity, and explicit local demo', () => {
  const user = { id: 'phone-owner', email: null, phone: '+8613800138000' };
  const response = member(user); assert.equal(validateMember(response), response);
  assert.equal(validateMember(member({ id: 'email-owner', email: 'alice@example.com', phone: null })).user.id, 'email-owner');
  assert.equal(validateMember(member({ ...user, email: 'alice@example.com' })).user.id, 'phone-owner');
  assert.equal(validateMember(member({ id: 'demo', email: null, authentication: 'local-demo', label: '本机体验' })).user.label, '本机体验');
  assert.equal(validateMember(member(null)).user, null);
  assert.throws(() => validateMember(member({ id: 'invalid', email: null, phone: null })), /账号信息/);
  assert.throws(() => validateMember(member({ id: '', email: 'alice@example.com' })), /账号信息/);
});

test('auth UI: phone label is masked, never trusts arbitrary server label for real accounts', () => {
  assert.equal(maskPhone('+8613800138000'), '138****8000');
  assert.equal(memberIdentityLabel({ phone: '+8613800138000', label: '+8613800138000' }), '138****8000');
  assert.equal(memberIdentityLabel({ email: 'alice@example.com' }), 'alice@example.com');
  assert.equal(memberIdentityLabel({ authentication: 'local-demo', label: '本机体验' }), '本机体验');
});

test('auth UI: cooldown is at least 60 seconds and cannot become infinite or negative', () => {
  for (const value of [undefined, 0, -1, NaN, Infinity, 30, '60']) assert.equal(authRetrySeconds(value), 60);
  assert.equal(authRetrySeconds(60.1), 61);
  assert.equal(authRetrySeconds(120), 120);
  assert.equal(authRetrySeconds(99999), 3600);
});

test('auth UI: malformed quota is never promoted to a frontend entitlement', () => {
  for (const value of [-1, NaN, '100']) assert.throws(() => validateMember({ ...member({ id: 'one', email: 'a@example.com' }), quota: { used: 0, remaining: value, limit: 10 } }), /提问次数/);
});

test('auth UI: request keeps same-origin cookies, strict identity payload, and retry metadata', async t => {
  const oldFetch = globalThis.fetch, oldLocation = globalThis.location;
  t.after(() => { globalThis.fetch = oldFetch; globalThis.location = oldLocation; });
  globalThis.location = { origin: 'http://127.0.0.1:4190' };
  let observed;
  globalThis.fetch = async (url, options) => { observed = { url, options }; return new Response(JSON.stringify({ error: { message: '稍后重试', code: 'rate_limited' } }), { status: 429, headers: { 'retry-after': '75', 'content-type': 'application/json' } }); };
  await assert.rejects(membershipRequest('auth/code', { method: 'POST', body: authIdentity('phone', '13800138000') }), error => error.status === 429 && error.retryAfter === 75);
  assert.equal(observed.options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(observed.options.body), { phone: '+8613800138000' });
  assert.equal(observed.url, 'http://127.0.0.1:4190/api/auth/code');
});
