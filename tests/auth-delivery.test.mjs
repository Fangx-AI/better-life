import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { createTencentSmsSender } from '../server/auth-delivery.mjs';

// 网络/所有凭据均为fixture，不发送真实短信、不读取env。
const env = { TENCENT_SMS_SECRET_ID: 'AKIDfixtureOnly', TENCENT_SMS_SECRET_KEY: 'fixture-secret-never-production',
  TENCENT_SMS_APP_ID: '1400000000', TENCENT_SMS_SIGN_NAME: '人生指南', TENCENT_SMS_TEMPLATE_ID: '100001' };
const phone = '+8613800138000', code = '123456';
const success = (status = {}) => Response.json({ Response: { SendStatusSet: [{ Code: 'Ok', PhoneNumber: phone, SerialNo: 'fixture-serial', ...status }] } });

test('SMS: missing or invalid config cannot enable delivery', () => {
  for (const key of Object.keys(env)) assert.equal(createTencentSmsSender({ env: { ...env, [key]: '' } }), null);
  for (const patch of [{ TENCENT_SMS_SECRET_ID: 'key\r\nx-unsafe:yes' }, { TENCENT_SMS_TEMPLATE_ID: 'oops' },
    { TENCENT_SMS_SIGN_NAME: 'x' }, { TENCENT_SMS_REGION: 'bad/region' }, { TENCENT_SMS_TEMPLATE_PARAM_COUNT: '3' }]) {
    assert.equal(createTencentSmsSender({ env: { ...env, ...patch } }), null);
  }
});

test('SMS: request uses fixed endpoint, single E164 destination, UTC TC3 signature and timeout', async () => {
  let observed;
  const timestamp = 1551113065;
  const send = createTencentSmsSender({ env, now: () => timestamp * 1000, fetchImpl: async (url, init) => { observed = { url, ...init }; return success(); } });
  assert.equal(await send({ phone, code }), undefined);
  assert.equal(observed.url, 'https://sms.tencentcloudapi.com/'); assert.equal(observed.redirect, 'error');
  assert.equal(observed.method, 'POST'); assert.ok(observed.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(observed.body), { PhoneNumberSet: [phone], SmsSdkAppId: '1400000000', SignName: '人生指南', TemplateId: '100001', TemplateParamSet: [code] });
  const h = observed.headers;
  assert.equal(h['x-tc-timestamp'], String(timestamp)); assert.equal(h['x-tc-version'], '2021-01-11');
  assert.equal(h['x-tc-action'], 'SendSms'); assert.equal(h['x-tc-region'], 'ap-guangzhou');
  assert.match(h.authorization, /Credential=AKIDfixtureOnly\/2019-02-25\/sms\/tc3_request/);
  const sha = value => createHash('sha256').update(value).digest('hex');
  const hm = (key, msg, encoding) => createHmac('sha256', key).update(msg).digest(encoding);
  const canonical = ['POST', '/', '', 'content-type:application/json; charset=utf-8\nhost:sms.tencentcloudapi.com\nx-tc-action:sendsms\n', 'content-type;host;x-tc-action', sha(observed.body)].join('\n');
  const signing = hm(hm(hm(`TC3${env.TENCENT_SMS_SECRET_KEY}`, '2019-02-25'), 'sms'), 'tc3_request');
  const signature = hm(signing, `TC3-HMAC-SHA256\n${timestamp}\n2019-02-25/sms/tc3_request\n${sha(canonical)}`, 'hex');
  assert.ok(h.authorization.endsWith(`Signature=${signature}`));
  assert.ok(!h.authorization.includes(env.TENCENT_SMS_SECRET_KEY));
});

test('SMS: optional template duration and STS token stay server side', async () => {
  let init;
  const send = createTencentSmsSender({ env: { ...env, TENCENT_SMS_TEMPLATE_PARAM_COUNT: '2', TENCENT_SMS_TOKEN: 'fixture-sts-token' },
    fetchImpl: async (_url, value) => { init = value; return success(); } });
  await send({ phone, code }); assert.deepEqual(JSON.parse(init.body).TemplateParamSet, [code, '5']);
  assert.equal(init.headers['x-tc-token'], 'fixture-sts-token');
});

test('SMS: provider HTTP200 errors, mismatch, empty statuses, timeout and malformed JSON fail closed without leakage', async () => {
  const responses = [() => success({ Code: 'FailedOperation.TemplateUnapprovedOrNotExist' }), () => success({ PhoneNumber: '+8613900139000' }),
    () => success({ SerialNo: '' }), () => Response.json({ Response: { Error: { Code: 'SecretError', Message: `${phone} ${code} ${env.TENCENT_SMS_SECRET_KEY}` } } }),
    () => Response.json({ Response: { SendStatusSet: [] } }), () => new Response('not-json'), () => new Response('denied', { status: 403 }),
    () => { throw new Error(`network ${env.TENCENT_SMS_SECRET_KEY}`); }];
  for (const fixture of responses) {
    const send = createTencentSmsSender({ env, fetchImpl: async () => fixture() });
    await assert.rejects(send({ phone, code }), error => error.message === 'sms_unavailable');
  }
});

test('SMS: rejects raw phone, international phone or non-six-digit code before network', async () => {
  const send = createTencentSmsSender({ env, fetchImpl: () => assert.fail('must not send') });
  for (const input of [{ phone: '13800138000', code }, { phone: '+11234567890', code }, { phone, code: '12345' }, { phone, code: 123456 }]) {
    await assert.rejects(send(input), /sms_unavailable/);
  }
});
