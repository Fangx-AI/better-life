import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { createAliyunSmsSender, createAliyunEmailSender } from '../server/aliyun-delivery.mjs';

// 全部为 fixture；不读取真实环境变量，不发送短信、邮件或支付请求。
const env = { ALIYUN_ACCESS_KEY_ID: 'LTAIfixtureOnly', ALIYUN_ACCESS_KEY_SECRET: 'fixture+secret/Only',
  ALIYUN_SMS_SIGN: '人生指南', ALIYUN_SMS_TEMPLATE_CODE: 'SMS_100001', ALIYUN_EMAIL_ACCOUNT_NAME: 'noreply@example.com' };
const phone = '+8613800138000', email = 'reader+test@example.com', code = '123456';
const now = () => Date.UTC(2026, 9, 3, 1, 2, 3, 456);
const smsOk = () => Response.json({ Code: 'OK', BizId: 'fixture-biz-id', RequestId: 'fixture-request-id' });
const emailOk = () => Response.json({ EnvId: 'fixture-env-id', RequestId: 'fixture-request-id' });
const factories = [{ name: 'SMS', factory: createAliyunSmsSender, target: { phone, code }, ok: smsOk, message: 'sms_unavailable' },
  { name: 'Email', factory: createAliyunEmailSender, target: { email, code }, ok: emailOk, message: 'email_unavailable' }];

// 独立按 RFC3986 的逐字符编码计算签名；不调用 adapter 内部编码实现。
function rfc3986(value) {
  return [...Buffer.from(value, 'utf8')].map(byte => /[A-Za-z0-9_.~-]/.test(String.fromCharCode(byte))
    ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}
function verifySignature(body, secret) {
  const values = Object.fromEntries(new URLSearchParams(body));
  const actual = values.Signature; delete values.Signature;
  const canonical = Object.keys(values).sort().map(key => `${rfc3986(key)}=${rfc3986(values[key])}`).join('&');
  assert.equal(actual, createHmac('sha1', `${secret}&`).update(`POST&%2F&${rfc3986(canonical)}`).digest('base64'));
  assert.equal(values.SignatureMethod, 'HMAC-SHA1'); assert.equal(values.SignatureVersion, '1.0');
  assert.equal(values.Timestamp, '2026-10-03T01:02:03Z'); assert.equal(values.RegionId, 'cn-hangzhou');
  assert.match(values.SignatureNonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return values;
}

test('Aliyun: missing/invalid shared credentials disable both senders without mock success', () => {
  for (const key of ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET']) {
    for (const { factory } of factories) assert.equal(factory({ env: { ...env, [key]: '' } }), null);
  }
  for (const patch of [{ ALIYUN_ACCESS_KEY_ID: 'key\r\nx' }, { ALIYUN_ACCESS_KEY_SECRET: 'bad\r\nsecret' },
    { ALIYUN_ACCESS_KEY_SECRET: 'short' }, { ALIYUN_ACCESS_KEY_ID: 'bad/key' }]) {
    for (const { factory } of factories) assert.equal(factory({ env: { ...env, ...patch } }), null);
  }
  for (const patch of [{ ALIYUN_SMS_SIGN: '' }, { ALIYUN_SMS_SIGN: 'a' }, { ALIYUN_SMS_SIGN: 'sign\r\nbad' },
    { ALIYUN_SMS_TEMPLATE_CODE: '' }, { ALIYUN_SMS_TEMPLATE_CODE: 'not-sms-template' }]) {
    assert.equal(createAliyunSmsSender({ env: { ...env, ...patch } }), null);
  }
  for (const value of ['', 'bad', 'a@example.com,other@example.com', 'a@example.com\r\nBcc:x@example.com']) {
    assert.equal(createAliyunEmailSender({ env: { ...env, ALIYUN_EMAIL_ACCOUNT_NAME: value } }), null);
  }
});

test('Aliyun SMS: official fixed endpoint, single domestic number, POP v1 signature, cryptographic nonce and timeout', async () => {
  let observed;
  const send = createAliyunSmsSender({ env, now, fetchImpl: async (url, init) => { observed = { url, ...init }; return smsOk(); } });
  assert.equal(await send({ phone, code }), undefined);
  assert.equal(observed.url, 'https://dysmsapi.aliyuncs.com/'); assert.equal(observed.method, 'POST');
  assert.equal(observed.redirect, 'error'); assert.ok(observed.signal instanceof AbortSignal);
  assert.equal(observed.headers['content-type'], 'application/x-www-form-urlencoded');
  const values = verifySignature(observed.body, env.ALIYUN_ACCESS_KEY_SECRET);
  assert.equal(values.Action, 'SendSms'); assert.equal(values.Version, '2017-05-25'); assert.equal(values.Format, 'JSON');
  assert.equal(values.PhoneNumbers, phone.slice(3)); assert.equal(values.SignName, env.ALIYUN_SMS_SIGN);
  assert.equal(values.TemplateCode, env.ALIYUN_SMS_TEMPLATE_CODE); assert.deepEqual(JSON.parse(values.TemplateParam), { code });
  assert.ok(!observed.body.includes(env.ALIYUN_ACCESS_KEY_SECRET));
});

test('Aliyun Email: official inline body, Better Life branding, binding purpose and actual five-minute OTP duration', async () => {
  let observed;
  const send = createAliyunEmailSender({ env, now, fetchImpl: async (url, init) => { observed = { url, ...init }; return emailOk(); } });
  assert.equal(await send({ email, code, purpose: 'link' }), undefined);
  assert.equal(observed.url, 'https://dm.aliyuncs.com/'); assert.equal(observed.method, 'POST');
  assert.equal(observed.redirect, 'error'); assert.ok(observed.signal instanceof AbortSignal);
  const values = verifySignature(observed.body, env.ALIYUN_ACCESS_KEY_SECRET);
  assert.equal(values.Action, 'SingleSendMail'); assert.equal(values.Version, '2015-11-23');
  assert.equal(values.AccountName, env.ALIYUN_EMAIL_ACCOUNT_NAME); assert.equal(values.ToAddress, email);
  assert.equal(values.AddressType, '1'); assert.equal(values.ReplyToAddress, 'false');
  assert.equal(values.Subject, 'Better Life 绑定邮箱验证码'); assert.match(values.TextBody, /5 分钟/);
  assert.match(values.HtmlBody, /Better Life 绑定邮箱验证码/); assert.match(values.HtmlBody, /123456/);
  assert.ok(!values.TextBody.includes('10 分钟')); assert.ok(!values.HtmlBody.includes('Image2'));
  assert.ok(!Object.hasOwn(values, 'Template')); assert.ok(!Object.hasOwn(values, 'TemplateId'));
  assert.ok(!observed.body.includes(env.ALIYUN_ACCESS_KEY_SECRET));
});

test('Aliyun: nonce unique for every request and special UTF8/punctuation fields are signed correctly', async () => {
  const observed = [];
  const send = createAliyunSmsSender({ env: { ...env, ALIYUN_SMS_SIGN: "指南!()'*~ 空格" }, now,
    fetchImpl: async (_url, init) => { observed.push(init.body); return smsOk(); } });
  await send({ phone, code }); await send({ phone, code, purpose: 'link' });
  const first = verifySignature(observed[0], env.ALIYUN_ACCESS_KEY_SECRET), second = verifySignature(observed[1], env.ALIYUN_ACCESS_KEY_SECRET);
  assert.notEqual(first.SignatureNonce, second.SignatureNonce); assert.equal(first.SignName, "指南!()'*~ 空格");
  assert.ok(observed[0].includes('%20')); assert.ok(!observed[0].includes('+')); assert.ok(observed[0].includes('%21%28%29%27%2A~'));
});

for (const { name, factory, target, message } of factories) {
  test(`Aliyun ${name}: malformed code, purpose and destination rejected before network`, async () => {
    const send = factory({ env, fetchImpl: () => assert.fail('must not send') });
    const badTargets = name === 'SMS' ? [{ phone: '13800138000' }, { phone: '+11234567890' }, { phone: `${phone},+8613900139000` }, { phone: 13800138000 }]
      : [{ email: 'not-email' }, { email: 'one@example.com,two@example.com' }, { email: 'one@example.com\r\nBcc:x@example.com' }];
    for (const patch of [...badTargets, { code: 123456 }, { code: '12345' }, { code: '<script>' }, { purpose: 'reset_password' }]) {
      await assert.rejects(send({ ...target, ...patch }), error => error.message === message);
    }
  });

  test(`Aliyun ${name}: HTTP200 business errors, malformed JSON and network failures expose only safe error`, async () => {
    const rejection = name === 'SMS' ? { Code: 'isv.BUSINESS_LIMIT_CONTROL', BizId: 'not-success' } : { Code: 'InvalidMailAddress', EnvId: 'not-success' };
    const fixtures = [() => Response.json(rejection), () => Response.json({ Code: 'OK' }), () => Response.json(null), () => Response.json([]),
      () => Response.json(name === 'SMS' ? { Code: 'OK', BizId: '' } : { EnvId: '' }),
      () => Response.json(name === 'SMS' ? { Code: 'OK', BizId: 123 } : { EnvId: 123 }),
      () => new Response('not-json'), () => new Response('denied', { status: 403 }),
      () => { throw new Error(`transport ${target.phone ?? target.email} ${code} ${env.ALIYUN_ACCESS_KEY_SECRET}`); }];
    for (const fixture of fixtures) {
      const send = factory({ env, fetchImpl: async () => fixture() });
      await assert.rejects(send(target), error => error.message === message && !error.message.includes(code));
    }
  });
}

test('Aliyun Email: login purpose gets login subject and does not depend on obsolete template env', async () => {
  let values;
  const send = createAliyunEmailSender({ env, fetchImpl: async (_url, init) => { values = Object.fromEntries(new URLSearchParams(init.body)); return emailOk(); } });
  await send({ email, code }); assert.equal(values.Subject, 'Better Life 登录验证码');
});
