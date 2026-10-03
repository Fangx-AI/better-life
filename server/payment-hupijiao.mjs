import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { paymentOrderId } from './payment-order-id.mjs';
import { validHttpsOrigin } from './production-config.mjs';

const PAY_API = 'https://api.xunhupay.com/payment/do.html';
const QUERY_API = 'https://api.xunhupay.com/payment/query.html';
const scalar = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_*-]{1,128}$/.test(value);
export class PaymentNotificationError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const fail = (status, code) => { throw new PaymentNotificationError(status, code); };

// 官方 POP 文档采用未编码的 ASCII 字典序键值串，再直接追加 APPSECRET。
export function signPaymentParams(params, secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('payment_unavailable');
  const keys = Object.keys(params).filter(key => key !== 'hash' && params[key] !== undefined && params[key] !== null && params[key] !== '').sort();
  if (keys.some(key => !scalar(params[key]))) throw new Error('payment_unavailable');
  return createHash('md5').update(keys.map(key => `${key}=${params[key]}`).join('&') + secret).digest('hex');
}
function verify(params, secret, { advisoryEnvelope = false } = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || !/^[a-fA-F0-9]{32}$/.test(params.hash ?? '')) return false;
  const fields = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'hash' || value == null || value === '') continue;
    if (!scalar(value)) { if (advisoryEnvelope && key === 'data') continue; return false; }
    fields[key] = value;
  }
  return timingSafeEqual(Buffer.from(signPaymentParams(fields, secret), 'ascii'), Buffer.from(params.hash.toLowerCase(), 'ascii'));
}
export function yuanToFen(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimal = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
function payUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'xunhupay.com' || url.hostname.endsWith('.xunhupay.com')) ? url.href : null; } catch { return null; }
}
async function readForm(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) fail(415, 'unsupported_notification');
  const rawLength = request.headers.get('content-length');
  if (rawLength != null && (!/^\d+$/.test(rawLength) || Number(rawLength) > 16384)) fail(413, 'notification_too_large');
  const reader = request.body?.getReader(); if (!reader) fail(400, 'invalid_notification');
  let timer, abort, length = 0; const chunks = [];
  const interrupted = new Promise((_, reject) => {
    const stop = code => { reject(new PaymentNotificationError(408, code)); reader.cancel().catch(() => {}); };
    abort = () => stop('notification_cancelled'); request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort(); timer = setTimeout(() => stop('notification_timeout'), 10000);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interrupted]); if (done) break;
      length += value.length; if (length > 16384) { reader.cancel().catch(() => {}); fail(413, 'notification_too_large'); } chunks.push(value);
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { fail(400, 'invalid_notification'); }
  if (/%(?![a-fA-F0-9]{2})/.test(raw)) fail(400, 'invalid_notification');
  const fields = Object.create(null);
  for (const [key, value] of new URLSearchParams(raw)) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || Object.hasOwn(fields, key) || /[\x00-\x1f\x7f]/.test(value) || value.length > 2048) fail(400, 'invalid_notification');
    fields[key] = value;
  }
  return fields;
}

// 独立字段，绝不继承 Image2 的 notify base、订单/商品或 mock 模式。
// configured 允许停新单后继续接收真实退款；creationEnabled 默认 false。
export function createHupijiaoPaymentProvider({ env = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (env.MEMBERSHIP_PAYMENT_PROVIDER !== 'hupijiao') return null;
  const appid = env.MEMBERSHIP_HUPIJIAO_APPID, secret = env.MEMBERSHIP_HUPIJIAO_APPSECRET;
  if (!identity(appid) || appid.length > 32 || typeof secret !== 'string' || secret.length < 16 || /[\r\n\0]/.test(secret) || !validHttpsOrigin(env.MEMBERSHIP_APP_ORIGIN)) return null;
  const origin = new URL(env.MEMBERSHIP_APP_ORIGIN).origin;
  const creationEnabled = env.MEMBERSHIP_PAYMENT_CREATE_ENABLED === 'true' && env.MEMBERSHIP_LOCAL_DEMO !== 'true';
  const params = extra => ({ appid, time: String(Math.floor(now() / 1000)), nonce_str: randomBytes(16).toString('hex'), ...extra });
  async function call(url, values, signal) {
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(9000)]) : AbortSignal.timeout(9000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...values, hash: signPaymentParams(values, secret) }).toString() });
      if (!response.ok) throw new Error();
      const text = await response.text(); if (text.length > 16384) throw new Error();
      const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new Error('payment_unavailable'); }
  }
  return {
    merchantId: appid, creationEnabled,
    async createCheckout({ id, amountFen, currency, description, signal }) {
      if (!creationEnabled || currency !== 'CNY' || !Number.isSafeInteger(amountFen) || amountFen <= 0) throw new Error('payment_unavailable');
      const values = params({ version: '1.1', trade_order_id: paymentOrderId(id), total_fee: `${Math.floor(amountFen / 100)}.${String(amountFen % 100).padStart(2, '0')}`,
        title: `Better Life ${String(description || '会员').replace(/[%\x00-\x1f\x7f&=]/g, '').slice(0, 30)}`,
        notify_url: `${origin}/api/payments/hupijiao/notify`, return_url: `${origin}/?paymentOrder=${encodeURIComponent(id)}`, plugins: 'better-life' });
      if (values.notify_url.length > 128 || values.return_url.length > 128) throw new Error('payment_unavailable');
      const result = await call(PAY_API, values, signal);
      if (!verify(result, secret) || result.errcode !== 0 || !payUrl(result.url) || result.url_qrcode && !payUrl(result.url_qrcode)) throw new Error('payment_unavailable');
      return { checkoutUrl: payUrl(result.url) };
    },
    async verifyPayment({ id, signal }) {
      // 查询契约中的 nested data 没有可核对的 canonical 签名，不作为扣款/退款事实。
      // 不暴露或使用其 amount / transaction；有签名也永不返回 paid。
      try {
        const result = await call(QUERY_API, params({ out_trade_order: paymentOrderId(id) }), signal);
        const advisory = verify(result, secret, { advisoryEnvelope: true }) && result.errcode === 0;
        return { status: 'pending', advisoryOnly: true, queryAccepted: advisory };
      } catch { return { status: 'pending', advisoryOnly: true, queryAccepted: false }; }
    },
    async verifyNotification(request) {
      const fields = await readForm(request);
      if (fields.appid !== appid || !verify(fields, secret)) fail(403, 'invalid_payment_signature');
      if (!/^bl_[a-f0-9]{29}$/.test(fields.trade_order_id || '') || !['OD', 'CD', 'RD', 'UD'].includes(fields.status)) fail(400, 'invalid_payment_event');
      const amountFen = yuanToFen(fields.total_fee), transactionId = fields.transaction_id;
      const milliseconds = /^\d{10}$/.test(fields.time || '') ? Number(fields.time) * 1000 : /^\d{13}$/.test(fields.time || '') ? Number(fields.time) : NaN;
      if (!amountFen || !identity(transactionId) || !Number.isSafeInteger(milliseconds) || milliseconds < Date.UTC(2018, 0, 1) || milliseconds > now() + 300000) fail(400, 'invalid_payment_event');
      return { merchantId: appid, providerOrderId: fields.trade_order_id, transactionId, amountFen, currency: 'CNY',
        type: { OD: 'paid', CD: 'refunded', RD: 'refund_pending', UD: 'refund_failed' }[fields.status], occurredAt: milliseconds,
        eventKey: createHash('sha256').update([appid, fields.trade_order_id, transactionId, fields.status, milliseconds].join('\0')).digest('hex') };
    },
  };
}
