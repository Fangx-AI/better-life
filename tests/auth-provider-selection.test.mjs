import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSender, createSmsSender, createMembershipHandler } from '../server/membership.mjs';
import { createMembershipStore } from '../server/membership-store.mjs';
import { authStatus } from '../scripts/auth-status.mjs';

const env = { MEMBERSHIP_EMAIL_PROVIDER: 'aliyun', MEMBERSHIP_SMS_PROVIDER: 'aliyun',
  ALIYUN_ACCESS_KEY_ID: 'LTAIfixtureOnly', ALIYUN_ACCESS_KEY_SECRET: 'fixture-private-secret',
  ALIYUN_SMS_SIGN: '人生指南', ALIYUN_SMS_TEMPLATE_CODE: 'SMS_100001', ALIYUN_EMAIL_ACCOUNT_NAME: 'sender@example.test' };

test('provider selection: explicit Aliyun makes both existing login contracts available with no Resend/Tencent', async t => {
  assert.equal(typeof createEmailSender({ env }), 'function'); assert.equal(typeof createSmsSender({ env }), 'function');
  const store = createMembershipStore(); t.after(() => store.close());
  const handler = createMembershipHandler({ store, env: { ...env, MEMBERSHIP_AUTH_SECRET: 'fixture-independent-member-secret-longer-than32' } });
  const status = await (await handler(new Request('http://127.0.0.1/api/membership'))).json();
  assert.equal(status.emailLoginAvailable, true); assert.equal(status.phoneLoginAvailable, true); assert.equal(status.checkoutAvailable, false);
  const report = authStatus(env); assert.equal(report.email.provider, 'aliyun'); assert.equal(report.phone.provider, 'aliyun');
  assert.equal(report.email.configured, true); assert.equal(report.phone.configured, true); assert.equal(report.liveDeliveryVerified, false);
  for (const key of ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_EMAIL_ACCOUNT_NAME']) assert.ok(!JSON.stringify(report).includes(env[key]));
});

test('provider selection: missing or unknown selected transport cannot silently use another paid provider', () => {
  const others = { RESEND_API_KEY: 'fixture-resend', MEMBERSHIP_EMAIL_FROM: 'sender@example.test' };
  for (const provider of ['aliyun', 'unknown']) {
    assert.equal(createEmailSender({ env: { ...others, MEMBERSHIP_EMAIL_PROVIDER: provider } }), null);
    assert.equal(createSmsSender({ env: { MEMBERSHIP_SMS_PROVIDER: provider } }), null);
  }
});

test('provider selection: adapter calls only selected service, no change to recipient payload', async () => {
  const calls = [], fetchImpl = async (url, init) => { calls.push({ url, params: Object.fromEntries(new URLSearchParams(init.body)) }); return Response.json(url.includes('dysmsapi') ? { Code: 'OK', BizId: 'fixture-biz' } : { EnvId: 'fixture-mail' }); };
  await createEmailSender({ env, fetchImpl })({ email: 'recipient@example.test', code: '123456', purpose: 'link' });
  await createSmsSender({ env, fetchImpl })({ phone: '+8613800138000', code: '123456', purpose: 'login' });
  assert.deepEqual(calls.map(x => x.url), ['https://dm.aliyuncs.com/', 'https://dysmsapi.aliyuncs.com/']);
  assert.equal(calls[0].params.Subject, 'Better Life 绑定邮箱验证码'); assert.equal(calls[1].params.PhoneNumbers, '13800138000');
});
