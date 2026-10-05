import { CLIENT_ANALYTICS_EVENTS, SERVER_ANALYTICS_EVENTS } from '../../shared/analytics-schema.mjs';
import { assertServerFeatures } from './public-mode.mjs';
const siteBase = import.meta.env?.BASE_URL || '/';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const validSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const stamp = value => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
export const OPERATIONS_TICKET_LABELS = Object.freeze({ requested: '已申请', reviewing: '审核中', approved: '人工已批准', awaiting_provider: '等待支付渠道', resolved: '已核验退款并关闭', rejected: '已拒绝', cancelled: '已取消' });
export const OPERATIONS_REASON_LABELS = Object.freeze({ mistaken_purchase: '误购', service_issue: '服务问题', duplicate_charge: '重复扣款疑问', other: '其他' });
export const OPERATIONS_ORDER_LABELS = Object.freeze({ created: '已创建', pending: '待支付', paid: '已核验支付', failed: '支付失败', expired: '已过期', refunded: '已核验退款' });
export const OPERATIONS_REFUND_LABELS = Object.freeze({ none: '无退款事实', refund_pending: '渠道处理中', refund_failed: '渠道处理失败', refunded: '已核验退款' });
export const OPERATIONS_AUDIT_LABELS = Object.freeze({ summary_viewed: '查看总览', users_viewed: '查看用户', orders_viewed: '查看订单', refund_tickets_viewed: '查看退款工单', audit_viewed: '查看审计', usage_budget_viewed: '查看预算', analytics_viewed: '查看转化汇总', refund_ticket_created: '新建工单', refund_ticket_reused: '复用工单', refund_ticket_updated: '更新工单', user_refund_requested: '用户申请退款', user_refund_request_reused: '复用用户申请', user_refund_requests_viewed: '查看本人申请', auth_denied: '认证被拒', origin_denied: '跨站请求被拒', request_rejected: '操作被拒' });
const transitions = Object.freeze({ requested: ['reviewing', 'cancelled'], reviewing: ['approved', 'rejected', 'cancelled'], approved: ['awaiting_provider', 'cancelled'], awaiting_provider: ['reviewing', 'resolved'], resolved: [], rejected: [], cancelled: [] });
export const operationsTicketTransitions = state => Object.hasOwn(transitions, state) ? [...transitions[state]] : [];
export const maskedOperationsId = value => validId(value) ? `${value.slice(0, 5)}…${value.slice(-4)}` : '—';

const messages = {
  operations_unauthorized: '运营凭据已失效，请重新输入。', operations_disabled: '运营接口尚未启用。',
  origin_forbidden: '当前入口不接受运营请求，请使用本站安全入口。', rate_limited: '操作太频繁，请稍后再试。',
  revision_conflict: '工单已有新修改，请刷新后再处理。', invalid_transition: '当前工单状态不允许此变更。',
  refund_not_verified: '尚无已核验退款事实，不能关闭为已退款。', operations_unavailable: '运营服务暂不可用，请稍后重试。',
};
export class OperationsClientError extends Error {
  constructor(status = 0, code = 'unavailable') { super(messages[code] || (status === 401 ? messages.operations_unauthorized : status === 404 ? '此运营功能尚未接通。' : status === 429 ? messages.rate_limited : '运营服务暂不可用，请重试。')); this.status = status; this.code = Object.hasOwn(messages, code) ? code : 'unavailable'; }
}

export function operationsApiUrl(path, { origin = globalThis.location?.origin, basePath = siteBase, query = {}, token } = {}) {
  try {
    const current = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(current.hostname);
    if (current.protocol !== 'https:' && !(current.protocol === 'http:' && local) || current.username || current.password || current.origin !== origin || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error();
    if (!/^(?:status|summary|users|orders|refund-tickets|audit|usage-budget|analytics)$/.test(path) && !/^refund-tickets\/[A-Za-z0-9_-]{8,128}$/.test(path)) throw new Error();
    const url = new URL(`${basePath}api/operations/${path}`, `${origin}/`);
    const allowed = ['users', 'orders', 'refund-tickets', 'audit'].includes(path) ? ['limit', 'cursor', ...(path === 'refund-tickets' ? ['state'] : [])] : path === 'analytics' ? ['from', 'to'] : [];
    for (const [key, value] of Object.entries(query)) {
      if (!allowed.includes(key) || typeof value !== 'string' && typeof value !== 'number') throw new Error();
      if (key === 'limit' ? !count(Number(value)) || Number(value) < 1 || Number(value) > 100 : key === 'cursor' ? !/^[A-Za-z0-9_-]{1,512}$/.test(value) : key === 'state' ? !Object.hasOwn(OPERATIONS_TICKET_LABELS, value) : !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error();
      url.searchParams.set(key, String(value));
    }
    if (token && url.href.includes(token)) throw new Error();
    return url.href;
  } catch { throw new OperationsClientError(0); }
}

function malformed() { throw new OperationsClientError(0); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function ticket(value) {
  if (!object(value) || ![value.id, value.orderId, value.userId].every(validId) || !count(value.amountFen) || value.currency !== 'CNY' || !Object.hasOwn(OPERATIONS_TICKET_LABELS, value.state) || !Object.hasOwn(OPERATIONS_REASON_LABELS, value.reasonCode) || !count(value.revision) || value.revision < 1 || !stamp(value.createdAt) || !stamp(value.updatedAt)) malformed();
  return { id: value.id, orderId: value.orderId, userId: value.userId, amountFen: value.amountFen, currency: value.currency, state: value.state, reasonCode: value.reasonCode, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function page(value, row) {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 100 || !count(value.limit) || value.limit < 1 || value.limit > 100 || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor))) malformed();
  return { items: value.items.map(row), nextCursor: value.nextCursor, limit: value.limit };
}
function plan(value) { return ['free', 'member-month', 'member-year'].includes(value); }
function user(value) {
  if (!object(value) || !validId(value.id) || !['email', 'phone', 'local-demo', 'deleted'].includes(value.authentication) || !stamp(value.createdAt) || !object(value.membership) || !plan(value.membership.planId) || !stamp(value.membership.expiresAt) || ![value.orderCount, value.guideCount, value.savedAnswerCount].every(count) || typeof value.hasProfile !== 'boolean') malformed();
  let quota = null;
  if (value.quota !== null) { if (!object(value.quota) || ![value.quota.limit, value.quota.used, value.quota.reserved].every(count) || !stamp(value.quota.resetsAt)) malformed(); quota = { limit: value.quota.limit, used: value.quota.used, reserved: value.quota.reserved, resetsAt: value.quota.resetsAt }; }
  return { id: value.id, authentication: value.authentication, createdAt: value.createdAt, membership: { planId: value.membership.planId, expiresAt: value.membership.expiresAt }, quota, orderCount: value.orderCount, guideCount: value.guideCount, savedAnswerCount: value.savedAnswerCount, hasProfile: value.hasProfile };
}
function order(value) {
  if (!object(value) || ![value.id, value.userId].every(validId) || !plan(value.planId) || !count(value.amountFen) || value.currency !== 'CNY' || !Object.hasOwn(OPERATIONS_ORDER_LABELS, value.status) || !Object.hasOwn(OPERATIONS_REFUND_LABELS, value.refundState) || ![value.createdAt, value.expiresAt, value.paidAt, value.refundedAt].every(stamp)) malformed();
  return { id: value.id, userId: value.userId, planId: value.planId, amountFen: value.amountFen, currency: value.currency, status: value.status, refundState: value.refundState, createdAt: value.createdAt, expiresAt: value.expiresAt, paidAt: value.paidAt, refundedAt: value.refundedAt };
}
function audit(value) {
  if (!object(value) || !count(value.id) || !['allowed', 'denied', 'failed'].includes(value.result) || !stamp(value.createdAt)) malformed();
  return { id: value.id, action: Object.hasOwn(OPERATIONS_AUDIT_LABELS, value.action) ? value.action : 'other', result: value.result, targetId: value.targetId === null ? null : validId(value.targetId) ? value.targetId : null, createdAt: value.createdAt };
}
function budgetPeriod(value) {
  if (!object(value) || ![value.limitMicroCny, value.reservedMicroCny, value.chargedMicroCny, value.committedMicroCny, value.remainingMicroCny, value.conservativeMicroCny, value.conservativeRequests, value.overrunRequests].every(count) || typeof value.fraction !== 'number' || !Number.isFinite(value.fraction) || typeof value.alert !== 'boolean' || typeof value.blocked !== 'boolean' || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value.period)) malformed();
  return Object.fromEntries(['period', 'limitMicroCny', 'reservedMicroCny', 'chargedMicroCny', 'committedMicroCny', 'remainingMicroCny', 'conservativeMicroCny', 'conservativeRequests', 'overrunRequests', 'fraction', 'alert', 'blocked'].map(key => [key, value[key]]));
}

export function validateOperationsResponse(path, value) {
  if (!object(value)) malformed();
  if (path === 'status') {
    if (!['enabled', 'configured', 'available'].every(key => typeof value[key] === 'boolean') || value.privateContentVisible !== false || value.paymentMutationAvailable !== false || value.refundGatewayAvailable !== false) malformed();
    return { enabled: value.enabled, configured: value.configured, available: value.available };
  }
  if (path === 'users') return page(value, user);
  if (path === 'orders') return page(value, order);
  if (path === 'refund-tickets') return page(value, ticket);
  if (path === 'audit') return page(value, audit);
  if (path.startsWith('refund-tickets/')) {
    if (value.gatewayCalled !== false || value.paymentChanged !== false) malformed();
    return { ticket: ticket(value.ticket), gatewayCalled: false, paymentChanged: false };
  }
  if (path === 'summary') {
    if (!count(value.users) || !Array.isArray(value.orders) || !Array.isArray(value.orderAmounts) || !Array.isArray(value.refundTickets)) malformed();
    const orders = value.orders.map(row => { if (!Object.hasOwn(OPERATIONS_ORDER_LABELS, row.status) || !count(row.count)) malformed(); return { status: row.status, count: row.count }; });
    const orderAmounts = value.orderAmounts.map(row => { if (row.currency !== 'CNY' || !['paid', 'refunded'].includes(row.status) || !count(row.count) || !count(row.amountFen)) malformed(); return { status: row.status, currency: 'CNY', count: row.count, amountFen: row.amountFen }; });
    const refundTickets = value.refundTickets.map(row => { if (!Object.hasOwn(OPERATIONS_TICKET_LABELS, row.state) || !count(row.count)) malformed(); return { state: row.state, count: row.count }; });
    return { users: value.users, orders, orderAmounts, refundTickets };
  }
  if (path === 'usage-budget') {
    if (typeof value.configured !== 'boolean') malformed();
    if (!value.configured) return { configured: false };
    if (value.currency !== 'CNY' || value.amountScale !== 1000000 || value.timezone !== 'Asia/Shanghai' || !['normal', 'warning', 'blocked'].includes(value.state)) malformed();
    return { configured: true, currency: 'CNY', amountScale: 1000000, state: value.state, day: budgetPeriod(value.day), month: budgetPeriod(value.month) };
  }
  if (path === 'analytics') {
    if (typeof value.configured !== 'boolean' || !Array.isArray(value.items) || value.items.length > 50000) malformed();
    const items = value.items.map(row => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day) || ![...CLIENT_ANALYTICS_EVENTS, ...SERVER_ANALYTICS_EVENTS].includes(row.name) || !['client', 'server'].includes(row.source) || !count(row.event_count) || !count(row.session_count)) malformed();
      // Rendering uses only fixed event names; arbitrary text/extra dimensions never enter UI state.
      return { day: row.day, name: row.name, source: row.source, event_count: row.event_count, session_count: row.session_count };
    });
    return { configured: value.configured, items };
  }
  malformed();
}

export async function operationsRequest(path, { token, method = 'GET', query = {}, body, signal, origin = globalThis.location?.origin,
  basePath = siteBase, fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 10000 } = {}) {
  assertServerFeatures();
  if (path !== 'status' && !validSecret(token)) throw new OperationsClientError(401, 'operations_unauthorized');
  if (!['GET', 'PATCH'].includes(method) || method === 'PATCH' && !/^refund-tickets\/[A-Za-z0-9_-]{8,128}$/.test(path)) throw new OperationsClientError(0);
  if (method === 'PATCH' && (!object(body) || Object.keys(body).some(key => !['revision', 'state'].includes(key)) || !count(body.revision) || body.revision < 1 || !Object.hasOwn(OPERATIONS_TICKET_LABELS, body.state))) throw new OperationsClientError(0);
  if (method === 'GET' && body !== undefined) throw new OperationsClientError(0);
  const url = operationsApiUrl(path, { origin, basePath, query, token });
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(url, { method, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', ...(path === 'status' ? {} : { Authorization: `Bearer ${token}` }), ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'PATCH' ? { body: JSON.stringify({ revision: body.revision, state: body.state }) } : {}) });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new OperationsClientError(response.status, value?.error?.code);
    return validateOperationsResponse(path, value);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (error instanceof OperationsClientError) throw error;
    throw new OperationsClientError(0);
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
