import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/components/membership/account-settings.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/membership/account-settings.css', import.meta.url), 'utf8');
const dialog = readFileSync(new URL('../src/components/membership/account-dialog.jsx', import.meta.url), 'utf8');

test('account settings UI: existing Aceternity controls and same-origin membership API only, no fake auth/backend or credential storage', () => {
  assert.match(source, /NavbarButton.*ui\/resizable-navbar/); assert.match(source, /Input.*ui\/input/); assert.match(source, /Label.*ui\/label/); assert.match(source, /useMembership.*membership-context/);
  assert.match(source, /export function AccountSettings\(\)/); assert.match(source, /import '\.\/account-settings.css'/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|auth\/local-demo|localDemoAvailable|fetch\(|dangerouslySetInnerHTML|auth\/code|auth\/verify|logout\(/);
  assert.match(source, /setAccountView\('login'\)/); assert.match(source, /failure.status === 401/); assert.match(source, /failure.code === 'reauthentication_required'/);
});

test('account settings UI: paid orders remain selectable when refunds are closed; reasons are enums and approval never claims cash arrival', () => {
  assert.match(source, /order.status === 'paid'/); assert.match(source, /status.refundRequestsAvailable === true/);
  for (const reason of ['mistaken_purchase', 'service_issue', 'duplicate_charge', 'other']) assert.ok(source.includes(reason));
  assert.match(source, /membershipRequest\('refund-requests', \{ method: 'POST', body: \{ orderId, reason \}, signal: abort.signal \}\)/);
  assert.match(source, /membershipRequest\('refund-requests', \{ signal: abort.signal \}\)/);
  assert.match(source, /!refundAvailable && <p/); assert.match(source, /paidOrders.length > 0 \? <form/); assert.doesNotMatch(source, /refundAvailable && paidOrders.length/);
  for (const text of ['退款申请暂未开放', '选择已支付订单', '申请已登记', '已批准，尚非到账', '待支付平台核验', '已核验退款', '不等于退款到账', '不会自动调用退款网关']) assert.ok(source.includes(text), text);
  assert.match(source, /hasOpenRequest/); assert.match(source, /ticket.userId === userId/); assert.match(source, /Object.hasOwn\(reasons, reason\)/); assert.doesNotMatch(source, /<textarea|amountFen:|userId:|gatewayCalled: true/);
});

test('account settings UI: independently paginates paid history rather than treating the recent summary as all refundable orders', () => {
  assert.match(source, /membershipRequest\('orders\?status=paid&limit=20', \{ signal: abort.signal \}\)/);
  assert.match(source, /orders\?status=paid&limit=20&cursor=\$\{encodeURIComponent\(cursor\)\}/);
  assert.match(source, /validateOrderHistory\(data, userId, \{ status: 'paid' \}\)/);
  assert.match(source, /stateOwner === userId \? orderItems.filter/);
  assert.doesNotMatch(source, /const paidOrders = \(me\?\.orders/);
  assert.match(source, /ordersLock.current/); assert.match(source, /orderController.current\?\.abort\(\)/); assert.match(source, /owner.current !== userId/);
  assert.match(source, /ordersLoaded && !ordersLoading && !ordersError/);
  for (const text of ['加载更早的已支付订单', '正在读取已支付订单', '重新读取订单']) assert.ok(source.includes(text));
  assert.match(dialog, /LinkedIdentities key=\{`identities:\$\{me.user.id\}`\}/);
  assert.match(dialog, /AccountSettings key=\{`settings:\$\{me.user.id\}`\}/);
  assert.doesNotMatch(dialog, /(?:LinkedIdentities|AccountSettings) key=\{me.user.id\}/);
});

test('account settings UI: deletion is initially collapsed, loads only on open, aborts, and is forbidden for demo accounts', () => {
  assert.match(source, /\[deleteOpen, setDeleteOpen\] = useState\(false\)/); assert.match(source, /<details className="account-settings-delete" onToggle=/); assert.doesNotMatch(source, /<details[^>]+\bopen=/);
  assert.match(source, /if \(!deleteOpen \|\| !userId \|\| isDemo\)/); assert.match(source, /membershipRequest\('account\/status', \{ signal: abort.signal \}\)/); assert.match(source, /return \(\) => abort.abort\(\)/);
  assert.match(source, /authentication === 'local-demo'/); assert.match(source, /体验账号不支持正式注销/); assert.match(source, /const canDelete = currentState && !isDemo && fresh/);
  for (const code of ['active_membership', 'unsettled_orders', 'refund_pending', 'open_refund_request', 'generation_in_progress']) assert.ok(source.includes(code));
  assert.match(source, /<summary tabIndex=\{0\}/); assert.match(source, /aria-controls=/);
});

test('account settings UI: exact delete confirmation requires fresh server permission, duplicate lock, and revokes via DELETE without secondary logout', () => {
  assert.match(source, /const confirmationText = '删除我的账号'/); assert.match(source, /confirmation !== confirmationText/); assert.match(source, /accountStatus\?\.canDelete === true/); assert.match(source, /accountStatus.deletionBlockers.length === 0/);
  assert.match(source, /freshAuthentication === true && Date.parse\(accountStatus.expiresAt\) > clock/); assert.match(source, /deleteLock.current/); assert.match(source, /stateOwner === userId/); assert.match(source, /requests.filter\(ticket => ticket.userId === userId\)/);
  assert.match(source, /membershipRequest\('account', \{ method: 'DELETE', body: \{ confirmation \}, signal: abort.signal \}\)/); assert.match(source, /data.deleted !== true/); assert.match(source, /closeAccount\(\); await refresh\(\)/);
  assert.match(source, /disabled=\{!canDelete \|\| confirmation !== confirmationText \|\| deleteBusy \|\| statusLoading\}/); assert.doesNotMatch(source, /confirmation\.trim|logout|所有数据永久|彻底删除|物理擦除完成/);
  for (const text of ['主数据库中的私人记录', '金融记录脱敏关联后保留', '备份和已导出文件不会因此物理擦除', '注销不会自动退款', '重新登录验证']) assert.ok(source.includes(text), text);
});

test('account settings UI: support link is configured HTTPS only and privacy/terms have real routes', () => {
  assert.match(source, /safeCheckoutUrl\(status.supportUrl\)/); assert.match(source, /supportUrl && <a href=\{supportUrl\} target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /href=\{`\$\{base\}\?view=privacy`\}/); assert.match(source, /href=\{`\$\{base\}\?view=terms`\}/); assert.doesNotMatch(source, /href="#"|mailto:|https:\/\/.*客服|QQ|微信/);
});

test('account settings UI: scoped mobile CSS, 16px fields, visible loading/errors and native modal focus targets', () => {
  assert.match(source, /role="status"/); assert.match(source, /role="alert"/); assert.match(source, /aria-busy=\{refundLoading \|\| refundBusy \|\| ordersLoading\}/); assert.match(source, /aria-busy=\{statusLoading \|\| deleteBusy\}/); assert.match(source, /aria-describedby=/);
  assert.match(css, /\.account-settings \*\{box-sizing:border-box;min-width:0\}/); assert.match(css, /font-size:16px/); assert.match(css, /max-width:100%/); assert.match(css, /grid-template-columns:minmax\(0,1fr\)/); assert.match(css, /overflow-wrap:anywhere/); assert.match(css, /@media\(max-width:767px\)/); assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(source, /<table|<iframe|<h1|<h2/);
  for (const selector of css.split('}').flatMap(rule => rule.split('{').slice(0, -1)).filter(value => value.trim() && !value.includes('@media'))) assert.ok(selector.includes('.account-settings'), selector);
});
