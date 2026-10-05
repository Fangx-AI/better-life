import { createHash } from 'node:crypto';

// 32 字符虎皮椒商户订单号；独立 namespace，不复用 Image2 商品或订单编号。
export function paymentOrderId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('invalid_payment_order');
  return `bl_${createHash('sha256').update(`better-life\0${id}`).digest('hex').slice(0, 29)}`;
}
