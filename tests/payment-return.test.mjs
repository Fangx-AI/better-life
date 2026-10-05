import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paymentReturnOrderId, paymentReturnMessage } from '../src/lib/payment-return.mjs';
const id = 'f524733e-4de1-4c19-8c3e-0123456789ab';
test('payment return: only one real UUID order locator is accepted; paid/amount params grant nothing', () => {
  assert.equal(paymentReturnOrderId(`?paymentOrder=${id}&status=paid&amountFen=1`), id);
  for (const value of ['', '?status=paid', '?paymentOrder=paid', '?paymentOrder=https://evil.test', `?paymentOrder=${id}&paymentOrder=${id}`]) assert.equal(paymentReturnOrderId(value), null);
  assert.match(paymentReturnMessage(null), /登录后查看/); assert.match(paymentReturnMessage({ status: 'pending' }), /正在确认/); assert.match(paymentReturnMessage({ status: 'refunded' }), /已退款/);
});
test('payment return: client fetches only authenticated own order, checks returned owner, and never POSTs paid', () => {
  const context = readFileSync(new URL('../src/components/membership/membership-context.jsx', import.meta.url), 'utf8');
  assert.match(context, /membershipRequest\(`orders\/\$\{encodeURIComponent\(orderId\)\}`/);
  assert.match(context, /data\.order\?\.id !== orderId \|\| member\.user\?\.id !== userId/);
  assert.match(context, /searchParams\.delete\('paymentOrder'\)/);
  assert.doesNotMatch(context, /orders\/paid|method:\s*['"]POST['"].*paid|localStorage.*paid/);
  const dialog = readFileSync(new URL('../src/components/membership/account-dialog.jsx', import.meta.url), 'utf8'); assert.match(dialog, /paymentReturnMessage\(paymentReturn\.order\)/);
});
