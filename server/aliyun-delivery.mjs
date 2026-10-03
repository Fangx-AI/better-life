import { createHmac, randomUUID } from 'node:crypto';

const clean = value => typeof value === 'string' ? value.trim() : '';
const safeText = (value, min, max) => value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const validEmail = value => typeof value === 'string' && value.length <= 254
  && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(value);
const validCode = value => typeof value === 'string' && /^\d{6}$/.test(value);
const validPurpose = value => value === 'login' || value === 'link';
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function credentials(env) {
  const accessKeyId = clean(env.ALIYUN_ACCESS_KEY_ID), accessKeySecret = clean(env.ALIYUN_ACCESS_KEY_SECRET);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(accessKeyId) || !safeText(accessKeySecret, 8, 256)) return null;
  return { accessKeyId, accessKeySecret };
}

// 与 Image2 共用阿里云 POP v1 协议，不共用用户、会话或验证码数据库。
// 固定 HTTPS 服务端端点；凭据、签名、收件人和验证码不写日志、不返回客户端。
// https://help.aliyun.com/zh/vms/the-http-protocol-and-signature
// https://help.aliyun.com/en/direct-mail/signature
async function rpc({ endpoint, version, action, params, auth, fetchImpl, now }) {
  const values = {
    AccessKeyId: auth.accessKeyId, Action: action, Format: 'JSON', RegionId: 'cn-hangzhou',
    SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0',
    Timestamp: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: version, ...params,
  };
  const canonical = Object.keys(values).sort().map(key => `${encode(key)}=${encode(values[key])}`).join('&');
  values.Signature = createHmac('sha1', `${auth.accessKeySecret}&`).update(`POST&${encode('/')}&${encode(canonical)}`).digest('base64');
  const body = Object.entries(values).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
  const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('provider_unavailable');
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('provider_unavailable');
  return data;
}

// https://help.aliyun.com/en/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms
export function createAliyunSmsSender({ env = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const auth = credentials(env), sign = clean(env.ALIYUN_SMS_SIGN), template = clean(env.ALIYUN_SMS_TEMPLATE_CODE);
  if (!auth || !safeText(sign, 2, 64) || !/^SMS_[A-Za-z0-9]{1,64}$/.test(template)) return null;
  return async ({ phone, code, purpose = 'login' }) => {
    try {
      if (typeof phone !== 'string' || !/^\+861[3-9]\d{9}$/.test(phone) || !validCode(code) || !validPurpose(purpose)) throw new Error();
      const data = await rpc({ endpoint: 'https://dysmsapi.aliyuncs.com/', version: '2017-05-25', action: 'SendSms',
        params: { PhoneNumbers: phone.slice(3), SignName: sign, TemplateCode: template, TemplateParam: JSON.stringify({ code }) }, auth, fetchImpl, now });
      if (data.Code !== 'OK' || typeof data.BizId !== 'string' || !data.BizId.trim()) throw new Error();
      // BizId 仅表示提供商受理；实际手机收码仍需真机验收。
    } catch { throw new Error('sms_unavailable'); }
  };
}

// https://help.aliyun.com/en/direct-mail/api-dm-2015-11-23-singlesendmail
export function createAliyunEmailSender({ env = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const auth = credentials(env), accountName = clean(env.ALIYUN_EMAIL_ACCOUNT_NAME);
  if (!auth || !validEmail(accountName)) return null;
  return async ({ email, code, purpose = 'login' }) => {
    try {
      if (!validEmail(email) || !validCode(code) || !validPurpose(purpose)) throw new Error();
      const action = purpose === 'link' ? '绑定邮箱' : '登录';
      const text = `你的${action}验证码是 ${code}，5 分钟内有效，只能使用一次。请勿向他人泄露。如果不是你发起的请求，请忽略这封邮件。`;
      const html = `<div style="font-family:Arial,sans-serif;line-height:1.8;color:#171717"><h2>Better Life ${action}验证码</h2><p>你的验证码是：</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</p><p>5 分钟内有效，只能使用一次。请勿向他人泄露。</p><p>如果不是你发起的请求，请忽略这封邮件。</p></div>`;
      const data = await rpc({ endpoint: 'https://dm.aliyuncs.com/', version: '2015-11-23', action: 'SingleSendMail',
        params: { AccountName: accountName, AddressType: '1', ReplyToAddress: 'false', ToAddress: email,
          Subject: `Better Life ${action}验证码`, TextBody: text, HtmlBody: html }, auth, fetchImpl, now });
      if (typeof data.EnvId !== 'string' || !data.EnvId.trim() || (data.Code !== undefined && data.Code !== 'OK')) throw new Error();
      // EnvId 仅表示提供商受理；不把它描述为邮箱已经送达。
    } catch { throw new Error('email_unavailable'); }
  };
}
