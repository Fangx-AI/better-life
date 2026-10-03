import { createHash, createHmac } from 'node:crypto';

const HOST = 'sms.tencentcloudapi.com';
const TYPE = 'application/json; charset=utf-8';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const clean = value => typeof value === 'string' ? value.trim() : '';

// 固定官方 HTTPS 端点。签名/正文/手机号/验证码均不写日志，也不返回客户端。
// https://cloud.tencent.com/document/api/382/55981
// https://cloud.tencent.com/document/api/382/52072
export function createTencentSmsSender({ env = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const secretId = clean(env.TENCENT_SMS_SECRET_ID), secretKey = clean(env.TENCENT_SMS_SECRET_KEY);
  const appId = clean(env.TENCENT_SMS_APP_ID), sign = clean(env.TENCENT_SMS_SIGN_NAME);
  const templateId = clean(env.TENCENT_SMS_TEMPLATE_ID), token = clean(env.TENCENT_SMS_TOKEN);
  const region = clean(env.TENCENT_SMS_REGION) || 'ap-guangzhou';
  const params = clean(env.TENCENT_SMS_TEMPLATE_PARAM_COUNT) || '1';
  if (!secretId || !secretKey || !appId || !sign || !templateId) return null;
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(secretId) || /[\r\n]/.test(secretKey + token)
    || !/^\d{1,20}$/.test(appId) || !/^\d{1,20}$/.test(templateId)
    || !/^[\p{L}\p{N}]{2,12}$/u.test(sign) || !/^ap-[a-z]+(?:-[a-z]+)?$/.test(region)
    || !['1', '2'].includes(params)) return null;
  return async ({ phone, code }) => {
    if (!/^\+861[3-9]\d{9}$/.test(phone) || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('sms_unavailable');
    try {
      const body = JSON.stringify({ PhoneNumberSet: [phone], SmsSdkAppId: appId, SignName: sign,
        TemplateId: templateId, TemplateParamSet: params === '2' ? [code, '5'] : [code] });
      const timestamp = Math.floor(now() / 1000), date = new Date(timestamp * 1000).toISOString().slice(0, 10);
      const signedHeaders = 'content-type;host;x-tc-action';
      const canonicalHeaders = `content-type:${TYPE}\nhost:${HOST}\nx-tc-action:sendsms\n`;
      const canonical = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
      const scope = `${date}/sms/tc3_request`;
      const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), 'sms'), 'tc3_request');
      const signature = hmac(signingKey, `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`, 'hex');
      const headers = { 'content-type': TYPE, host: HOST, 'x-tc-action': 'SendSms',
        'x-tc-version': '2021-01-11', 'x-tc-region': region, 'x-tc-timestamp': String(timestamp),
        authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        ...(token ? { 'x-tc-token': token } : {}) };
      const response = await fetchImpl(`https://${HOST}/`, { method: 'POST', headers, body,
        redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('sms_unavailable');
      const data = await response.json(), statuses = data?.Response?.SendStatusSet;
      if (data?.Response?.Error || !Array.isArray(statuses) || statuses.length !== 1
        || statuses[0].Code !== 'Ok' || statuses[0].PhoneNumber !== phone
        || typeof statuses[0].SerialNo !== 'string' || !statuses[0].SerialNo) throw new Error('sms_unavailable');
      // Provider accepted the request, not proof that the handset actually received it.
    } catch { throw new Error('sms_unavailable'); }
  };
}
