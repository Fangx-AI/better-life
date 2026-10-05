import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/components/operations/operations-page.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/operations/operations.css', import.meta.url), 'utf8');

test('operations page: existing Aceternity controls, no credential persistence or ordinary-member authorization', () => {
  assert.match(source, /NavbarButton.*ui\/resizable-navbar/); assert.match(source, /Input.*ui\/input/); assert.match(source, /Label.*ui\/label/);
  assert.match(source, /type="password"/); assert.match(source, /autoComplete="off"/); assert.match(source, /setToken\(''\); setCredential\(''\)/);
  assert.match(source, /cause.status === 401\) clearSession/); assert.match(source, /authController.current\?\.abort/); assert.match(source, /mutationController.current\?\.abort/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|useMembership|useAnalytics|URLSearchParams|window\.location\.search/);
  assert.match(source, /退出后台/); assert.match(source, /刷新后需重新输入/);
});

test('operations page: budget/conversion/user/order/audit views, no private-body reading or payment manual mutation', () => {
  for (const text of ['总览', '用户', '订单', '退款工单', '审计', '近 90 天匿名转化事件', '问答预算', '批准工单不等于退款到账', '未调用支付网关']) assert.ok(source.includes(text));
  assert.match(source, /revision: ticket.revision, state/); assert.match(source, /operationsTicketTransitions\(ticket.state\)/);
  assert.match(source, /maskedOperationsId\(user.id\)/); assert.match(source, /maskedOperationsId\(order.id\)/); assert.match(source, /maskedOperationsId\(ticket.id\)/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.email\b|\.phone\b|\.content\b|\.answer\b|\.facts\b|JSON\.stringify/);
  assert.match(source, /data\.nextCursor/); assert.match(source, /上一页/); assert.match(source, /下一页/);
  assert.match(source, /后台尚未启用或独立凭据未配置/); assert.match(source, /正在读取运营记录/); assert.match(source, /role="alert"/); assert.match(source, /role="status"/); assert.match(source, /aria-busy=\{loading\}/);
});

test('operations page: mobile layout and CSS are locally scoped without wide tables', () => {
  assert.match(source, /import '\.\/operations.css'/);
  assert.doesNotMatch(source, /<table|style=\{|<iframe/);
  assert.match(css, /\.operations-page \*\{box-sizing:border-box;min-width:0\}/);
  assert.match(css, /@media\(max-width:767px\)/); assert.match(css, /\.operations-records\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /prefers-reduced-motion:reduce/);
  for (const selector of css.split('}').flatMap(rule => rule.split('{').slice(0, -1)).filter(value => value.trim() && !value.includes('@media'))) assert.ok(selector.includes('.operations-page'), selector);
});

test('operations page: tab changes clear stale overview/list data before the route changes', () => {
  const selection = source.split('const selectTab = value =>')[1].split('const refresh =')[0];
  assert.match(selection, /setData\(null\); setLoading\(true\); setTab\(value\)/);
  assert.ok(selection.indexOf('setData(null)') < selection.indexOf('setTab(value)'));
  assert.match(selection, /setCursorStack\(\[null\]\)/); assert.match(selection, /setFilter\(''\)/);
});
