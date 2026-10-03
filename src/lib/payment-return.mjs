// 浏览器回跳只携带订单定位，不是付款事实；金额/paid 参数一律不用。
export function paymentReturnOrderId(search = '') {
  const values = new URLSearchParams(search).getAll('paymentOrder');
  return values.length === 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(values[0]) ? values[0] : null;
}

export function paymentReturnMessage(order) {
  if (!order) return '登录后查看这笔订单的实际支付结果。';
  if (order.status === 'paid') return '支付已确认，可在下方查看会员权益。';
  if (order.status === 'refunded') return '这笔订单已退款，对应会员权益已撤销。';
  if (order.status === 'expired') return '这笔订单已过期。如已付款，稍后刷新查看确认结果。';
  if (order.status === 'failed') return '这笔订单未能创建成功，没有开通会员。';
  return '支付结果正在确认，可点击刷新查看。';
}
