import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { MEMBERSHIP_DATABASE_APPLICATION_ID } from './production-config.mjs';

export const REFUND_TICKET_STATES = Object.freeze(['requested', 'reviewing', 'approved', 'awaiting_provider', 'resolved', 'rejected', 'cancelled']);
export const REFUND_REASON_CODES = Object.freeze(['mistaken_purchase', 'service_issue', 'duplicate_charge', 'other']);
const OPEN_STATES = ['requested', 'reviewing', 'approved', 'awaiting_provider'];
const ORDER_STATES = ['created', 'pending', 'paid', 'failed', 'expired', 'refunded'];
const REFUND_STATES = ['none', 'refund_pending', 'refund_failed', 'refunded'];
const TRANSITIONS = { requested: ['reviewing', 'cancelled'], reviewing: ['approved', 'rejected', 'cancelled'], approved: ['awaiting_provider', 'cancelled'], awaiting_provider: ['reviewing', 'resolved'], resolved: [], rejected: [], cancelled: [] };
const AUDIT_ACTIONS = ['summary_viewed', 'users_viewed', 'orders_viewed', 'refund_tickets_viewed', 'audit_viewed', 'usage_budget_viewed', 'analytics_viewed', 'refund_ticket_created', 'refund_ticket_reused', 'refund_ticket_updated', 'user_refund_requested', 'user_refund_request_reused', 'user_refund_requests_viewed', 'auth_denied', 'origin_denied', 'request_rejected'];
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const validActor = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const iso = value => value == null ? null : new Date(value).toISOString();
const digest = value => createHash('sha256').update(value).digest();
export class OperationsError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new OperationsError(status, code, message); };

// 48 随机字节的规范 base64url；不能复用登录、支付或备份密钥，也不接受示例占位值。
export function validOperationsSecret(value, env = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(value) || new Set(value).size < 16 || /test.only|example|replace|change.?me|your.?secret/i.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 48 || bytes.toString('base64url') !== value) return false;
  return !['MEMBERSHIP_AUTH_SECRET', 'MEMBERSHIP_BACKUP_ENCRYPTION_KEY', 'MEMBERSHIP_HUPIJIAO_APPSECRET'].some(key => env[key] === value);
}
export function operationsConfiguration(env = {}) {
  const enabled = env.OPERATIONS_ENABLED === 'true';
  const configured = validOperationsSecret(env.OPERATIONS_SECRET, env) && (env.OPERATIONS_OPERATOR_ID === undefined || validActor(env.OPERATIONS_OPERATOR_ID));
  return { enabled, configured, available: enabled && configured };
}
export function assertOperationsConfig(env = {}) {
  if (env.OPERATIONS_ENABLED !== 'true') return;
  if (!validOperationsSecret(env.OPERATIONS_SECRET, env)) throw new Error('OPERATIONS_SECRET 必须为独立强随机密钥；运营接口未启动。');
  if (env.OPERATIONS_OPERATOR_ID !== undefined && !validActor(env.OPERATIONS_OPERATOR_ID)) throw new Error('OPERATIONS_OPERATOR_ID 配置无效；运营接口未启动。');
}

function pagination(options, kind) {
  const limit = options.limit === undefined ? 25 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_pagination', '每页数量必须为 1 到 100。');
  let cursor = null;
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor)) throw new Error();
      cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || cursor.kind !== kind || !Number.isSafeInteger(cursor.at) || cursor.at < 0 || (kind === 'audit' ? !Number.isSafeInteger(cursor.id) || cursor.id < 1 : !validId(cursor.id))) throw new Error();
    } catch { fail(400, 'invalid_cursor', '分页游标无效，请从第一页重新查看。'); }
  }
  return { limit, cursor };
}
function page(rows, limit, kind, view, timestamp = 'created_at') {
  const more = rows.length > limit, selected = rows.slice(0, limit), last = selected.at(-1);
  const nextCursor = more ? Buffer.from(JSON.stringify({ v: 1, kind, at: last[timestamp], id: last.id })).toString('base64url') : null;
  return { items: selected.map(view), nextCursor, limit };
}
function filterId(value) { if (value !== undefined && !validId(value)) fail(400, 'invalid_id', '记录编号格式无效。'); return value; }
function filterEnum(value, allowed) { if (value !== undefined && !allowed.includes(value)) fail(400, 'invalid_filter', '筛选条件无效。'); return value; }
const orderView = row => ({ id: row.id, userId: row.user_id, planId: row.plan_id, planName: row.plan_name, amountFen: row.amount_fen, currency: row.currency, durationDays: row.duration_days, status: row.status, refundState: row.refund_state, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), paidAt: iso(row.paid_at), refundedAt: iso(row.refunded_at) });
const ticketView = row => ({ id: row.id, orderId: row.order_id, userId: row.user_id, amountFen: row.amount_fen, currency: row.currency, reasonCode: row.reason_code, state: row.state, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

// 复用已验证的会员连接；不打开 env 路径、不读取私人正文、不写 orders / entitlements。
// close 由会员 store 所有者负责。审计防 API 改写，不能替代主机权限与离线备份。
export function createOperationsStore({ membershipStore, now = Date.now } = {}) {
  const db = membershipStore?.db;
  if (!db || db.prepare('PRAGMA application_id').get().application_id !== MEMBERSHIP_DATABASE_APPLICATION_ID) throw new Error('运营接口需要已验证的 Better Life 会员数据库。');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  if (!['users', 'orders', 'entitlements', 'quota_periods', 'guides', 'saved_answers', 'profiles'].every(name => tables.has(name))) throw new Error('运营接口需要完整会员数据库结构。');
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations_refund_tickets(
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), user_id TEXT NOT NULL REFERENCES users(id),
      request_id TEXT NOT NULL, amount_fen INTEGER NOT NULL, currency TEXT NOT NULL,
      reason_code TEXT NOT NULL CHECK(reason_code IN ('mistaken_purchase','service_issue','duplicate_charge','other')),
      state TEXT NOT NULL CHECK(state IN ('requested','reviewing','approved','awaiting_provider','resolved','rejected','cancelled')),
      revision INTEGER NOT NULL CHECK(revision>=1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(order_id,request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS operations_open_ticket ON operations_refund_tickets(order_id) WHERE state IN ('requested','reviewing','approved','awaiting_provider');
    CREATE INDEX IF NOT EXISTS operations_ticket_page ON operations_refund_tickets(created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS operations_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT, client_hash TEXT, details_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS operations_audit_no_update BEFORE UPDATE ON operations_audit BEGIN SELECT RAISE(ABORT,'operations_audit_append_only'); END;
    CREATE TRIGGER IF NOT EXISTS operations_audit_no_delete BEFORE DELETE ON operations_audit BEGIN SELECT RAISE(ABORT,'operations_audit_append_only'); END;
  `);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  function recordAudit({ actor = 'operator', action, result = 'allowed', targetType = 'api', targetId = null, clientHash = null, details = {} } = {}) {
    if (!validActor(actor) || !AUDIT_ACTIONS.includes(action) || !['allowed', 'denied', 'failed'].includes(result) || !['api', 'order', 'refund_ticket'].includes(targetType) || targetId !== null && !validId(targetId) || clientHash !== null && !/^[a-f0-9]{64}$/.test(clientHash)) throw new Error('invalid_operations_audit');
    // 永不转存 body、Origin、Authorization、原始 IP、联系方式或自由文本。
    const safe = {};
    for (const key of ['fromState', 'toState']) if (REFUND_TICKET_STATES.includes(details[key])) safe[key] = details[key];
    if (REFUND_REASON_CODES.includes(details.reasonCode)) safe.reasonCode = details.reasonCode;
    if (Number.isSafeInteger(details.revision) && details.revision > 0) safe.revision = details.revision;
    if (Number.isSafeInteger(details.count) && details.count >= 0 && details.count <= 100) safe.count = details.count;
    if (typeof details.code === 'string' && /^[a-z_]{1,64}$/.test(details.code)) safe.code = details.code;
    run('INSERT INTO operations_audit(actor,action,result,target_type,target_id,client_hash,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)', actor, action, result, targetType, targetId, clientHash, JSON.stringify(safe), now());
  }
  function listUsers(options = {}) {
    const { limit, cursor } = pagination(options, 'users'), args = [], conditions = [];
    if (filterId(options.userId)) { conditions.push('u.id=?'); args.push(options.userId); }
    if (filterEnum(options.authentication, ['email', 'phone', 'local-demo', 'deleted'])) { conditions.push('u.auth_kind=?'); args.push(options.authentication); }
    if (cursor) { conditions.push('(u.created_at<? OR (u.created_at=? AND u.id<?))'); args.push(cursor.at, cursor.at, cursor.id); }
    const rows = all(`SELECT u.id,u.created_at,u.auth_kind,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id=u.id) AS order_count,
      (SELECT COUNT(*) FROM guides g WHERE g.user_id=u.id) AS guide_count,
      (SELECT COUNT(*) FROM saved_answers a WHERE a.user_id=u.id) AS saved_answer_count,
      EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=u.id) AS has_profile
      FROM users u ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY u.created_at DESC,u.id DESC LIMIT ?`, ...args, limit + 1);
    return page(rows, limit, 'users', row => {
      const entitlement = get('SELECT plan_id,ends_at FROM entitlements WHERE user_id=? AND starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1', row.id, now(), now());
      const quota = get('SELECT limit_count,used,reserved,ends_at FROM quota_periods WHERE user_id=? AND starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1', row.id, now(), now());
      return { id: row.id, createdAt: iso(row.created_at), authentication: row.auth_kind, membership: { planId: entitlement?.plan_id ?? 'free', expiresAt: iso(entitlement?.ends_at) }, quota: quota ? { limit: quota.limit_count, used: quota.used, reserved: quota.reserved, resetsAt: iso(quota.ends_at) } : null, orderCount: row.order_count, guideCount: row.guide_count, savedAnswerCount: row.saved_answer_count, hasProfile: Boolean(row.has_profile) };
    });
  }
  function listOrders(options = {}) {
    const { limit, cursor } = pagination(options, 'orders'), args = [], conditions = [];
    for (const [option, column] of [['userId', 'user_id'], ['orderId', 'id']]) if (filterId(options[option])) { conditions.push(`${column}=?`); args.push(options[option]); }
    for (const [option, column, allowed] of [['status', 'status', ORDER_STATES], ['refundState', 'refund_state', REFUND_STATES]]) if (filterEnum(options[option], allowed)) { conditions.push(`${column}=?`); args.push(options[option]); }
    if (cursor) { conditions.push('(created_at<? OR (created_at=? AND id<?))'); args.push(cursor.at, cursor.at, cursor.id); }
    return page(all(`SELECT id,user_id,plan_id,plan_name,amount_fen,currency,duration_days,status,refund_state,created_at,expires_at,paid_at,refunded_at FROM orders ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, ...args, limit + 1), limit, 'orders', orderView);
  }
  function listRefundTickets(options = {}) {
    const { limit, cursor } = pagination(options, 'refund-tickets'), args = [], conditions = [];
    for (const [option, column] of [['userId', 'user_id'], ['orderId', 'order_id']]) if (filterId(options[option])) { conditions.push(`${column}=?`); args.push(options[option]); }
    if (filterEnum(options.state, REFUND_TICKET_STATES)) { conditions.push('state=?'); args.push(options.state); }
    if (cursor) { conditions.push('(created_at<? OR (created_at=? AND id<?))'); args.push(cursor.at, cursor.at, cursor.id); }
    return page(all(`SELECT * FROM operations_refund_tickets ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, ...args, limit + 1), limit, 'refund-tickets', ticketView);
  }
  function listAudit(options = {}) {
    const { limit, cursor } = pagination(options, 'audit'), args = [], conditions = [];
    if (filterEnum(options.action, AUDIT_ACTIONS)) { conditions.push('action=?'); args.push(options.action); }
    if (cursor) { conditions.push('(created_at<? OR (created_at=? AND id<?))'); args.push(cursor.at, cursor.at, cursor.id); }
    return page(all(`SELECT * FROM operations_audit ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, ...args, limit + 1), limit, 'audit', row => ({ id: row.id, actor: row.actor, action: row.action, result: row.result, targetType: row.target_type, targetId: row.target_id, clientHash: row.client_hash, details: JSON.parse(row.details_json), createdAt: iso(row.created_at) }));
  }
  function summary() {
    return { users: get('SELECT COUNT(*) AS n FROM users').n, orders: all('SELECT status,COUNT(*) AS count FROM orders GROUP BY status'),
      orderAmounts: all("SELECT currency,status,COUNT(*) AS count,SUM(amount_fen) AS amountFen FROM orders WHERE status IN ('paid','refunded') GROUP BY currency,status"),
      refundTickets: all('SELECT state,COUNT(*) AS count FROM operations_refund_tickets GROUP BY state') };
  }
  function createRefundTicket({ orderId, requestId, reasonCode }, audit = {}) {
    if (!validId(orderId) || !validId(requestId) || !REFUND_REASON_CODES.includes(reasonCode)) fail(400, 'invalid_refund_ticket', '请提交有效订单编号、请求编号和申请原因类别。');
    return tx(() => {
      const previous = get('SELECT * FROM operations_refund_tickets WHERE order_id=? AND request_id=?', orderId, requestId);
      if (previous) {
        if (previous.reason_code !== reasonCode) fail(409, 'request_conflict', '请求编号已用于另一份申请内容。');
        recordAudit({ ...audit, action: 'refund_ticket_reused', targetType: 'refund_ticket', targetId: previous.id });
        return { ticket: ticketView(previous), created: false };
      }
      const order = get('SELECT id,user_id,amount_fen,currency,status FROM orders WHERE id=?', orderId);
      if (!order) fail(404, 'order_not_found', '未找到这个订单。');
      if (order.status !== 'paid') fail(409, 'order_not_paid', '仅已核验支付且尚未退款的订单可以登记退款申请。');
      if (get(`SELECT id FROM operations_refund_tickets WHERE order_id=? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`, orderId, ...OPEN_STATES)) fail(409, 'refund_ticket_open', '这个订单已有处理中申请，请继续处理原工单。');
      const id = randomUUID(), timestamp = now();
      run("INSERT INTO operations_refund_tickets(id,order_id,user_id,request_id,amount_fen,currency,reason_code,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'requested',1,?,?)", id, order.id, order.user_id, requestId, order.amount_fen, order.currency, reasonCode, timestamp, timestamp);
      recordAudit({ ...audit, action: 'refund_ticket_created', targetType: 'refund_ticket', targetId: id, details: { reasonCode, toState: 'requested', revision: 1 } });
      return { ticket: ticketView(get('SELECT * FROM operations_refund_tickets WHERE id=?', id)), created: true };
    });
  }
  function updateRefundTicket(id, { revision, state }, audit = {}) {
    if (!validId(id) || !Number.isSafeInteger(revision) || revision < 1 || !REFUND_TICKET_STATES.includes(state)) fail(400, 'invalid_refund_ticket', '工单编号、版本或状态格式无效。');
    return tx(() => {
      const ticket = get('SELECT * FROM operations_refund_tickets WHERE id=?', id);
      if (!ticket) fail(404, 'refund_ticket_not_found', '未找到这个退款申请工单。');
      if (ticket.revision !== revision) fail(409, 'revision_conflict', '工单已有新修改，请刷新后再处理。');
      if (!TRANSITIONS[ticket.state].includes(state)) fail(409, 'invalid_transition', '当前工单状态不允许此变更。');
      if (state === 'resolved' && get('SELECT status FROM orders WHERE id=?', ticket.order_id)?.status !== 'refunded') fail(409, 'refund_not_verified', '尚无已核验退款事实，不能关闭为已退款。');
      run('UPDATE operations_refund_tickets SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?', state, now(), id, revision);
      recordAudit({ ...audit, action: 'refund_ticket_updated', targetType: 'refund_ticket', targetId: id, details: { fromState: ticket.state, toState: state, revision: revision + 1 } });
      return ticketView(get('SELECT * FROM operations_refund_tickets WHERE id=?', id));
    });
  }
  // 仅供已由会员 handler 验证登录/Origin 的调用；用户绝不能传入另一个 userId。
  function submitRefundRequest(user, { orderId, reason } = {}) {
    if (!validId(user?.id) || !validId(orderId) || !REFUND_REASON_CODES.includes(reason)) fail(400, 'invalid_refund_ticket', '请选择自己的有效订单和申请原因类别；不接收自由文本。');
    return tx(() => {
      const order = get('SELECT id,user_id,amount_fen,currency,status FROM orders WHERE id=? AND user_id=?', orderId, user.id);
      if (!order) fail(404, 'order_not_found', '未找到这个订单。');
      const previous = get(`SELECT * FROM operations_refund_tickets WHERE order_id=? AND user_id=? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`, orderId, user.id, ...OPEN_STATES);
      if (previous) {
        recordAudit({ actor: 'user', action: 'user_refund_request_reused', targetType: 'refund_ticket', targetId: previous.id });
        return { ticket: ticketView(previous), created: false };
      }
      if (order.status !== 'paid') fail(409, 'order_not_paid', '仅已核验支付且尚未退款的订单可以登记退款申请。');
      const id = randomUUID(), timestamp = now();
      run("INSERT INTO operations_refund_tickets(id,order_id,user_id,request_id,amount_fen,currency,reason_code,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'requested',1,?,?)", id, order.id, order.user_id, `user-${randomUUID()}`, order.amount_fen, order.currency, reason, timestamp, timestamp);
      recordAudit({ actor: 'user', action: 'user_refund_requested', targetType: 'refund_ticket', targetId: id, details: { reasonCode: reason, toState: 'requested', revision: 1 } });
      return { ticket: ticketView(get('SELECT * FROM operations_refund_tickets WHERE id=?', id)), created: true };
    });
  }
  function listUserRefundRequests(user) {
    if (!validId(user?.id)) fail(401, 'login_required', '请先登录。');
    const items = all('SELECT * FROM operations_refund_tickets WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100', user.id).map(ticketView);
    recordAudit({ actor: 'user', action: 'user_refund_requests_viewed', details: { count: items.length } });
    return { items };
  }
  return { summary, listUsers, listOrders, listRefundTickets, listAudit, createRefundTicket, updateRefundTicket, submitRefundRequest, listUserRefundRequests, recordAudit };
}

const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra } });
const failure = (status, code, message, extra = {}) => json({ error: { code, message } }, status, extra);
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) fail(415, 'invalid_content_type', '请使用 JSON 提交工单。');
  if (Number(request.headers.get('content-length')) > 4096) fail(413, 'body_too_large', '工单内容过长。');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_request', '缺少工单内容。');
  let timer, abort, length = 0; const chunks = [];
  const interruption = new Promise((_, reject) => {
    const stop = error => { reject(error); reader.cancel().catch(() => {}); };
    abort = () => stop(new OperationsError(499, 'cancelled', '操作已取消。'));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    timer = setTimeout(() => stop(new OperationsError(408, 'body_timeout', '提交超时，请重试。')), 10000);
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interruption]);
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { reader.cancel().catch(() => {}); fail(413, 'body_too_large', '工单内容过长。'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { fail(400, 'invalid_json', '工单内容格式不正确。'); }
}
function strictKeys(body, allowed) { if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'unexpected_field', '接口不接受额外字段；不支持修改付款事实或会员权益。'); }
function queryOptions(url, allowed) {
  const options = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(options, key)) fail(400, 'invalid_filter', '查询包含不支持或重复的筛选条件。');
    options[key] = value;
  }
  return options;
}

// 只接受独立 Bearer；Cookie、URL token、普通会员会话都不能获得运营权限。
// 浏览器只应在当前内存中持有密钥，服务器不签发永久 cookie，也不设置 CORS。
export function createOperationsHandler({ env = {}, store, getClientId = () => 'shared', getUsageBudgetSnapshot = () => ({ configured: false }), getAnalyticsReport, now = Date.now } = {}) {
  const configuration = operationsConfiguration(env), actor = env.OPERATIONS_OPERATOR_ID || 'operator';
  const secret = configuration.available ? env.OPERATIONS_SECRET : '', secretDigest = digest(secret);
  const buckets = new Map();
  const rate = (key, max) => {
    const timestamp = now();
    if (buckets.size > 2048) for (const [name, row] of buckets) if (timestamp - row.start >= 60000) buckets.delete(name);
    const row = buckets.get(key);
    if (!row || timestamp - row.start >= 60000) { if (buckets.size >= 4096) return false; buckets.set(key, { start: timestamp, count: 1 }); return true; }
    row.count += 1; return row.count <= max;
  };
  return async request => {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/api/operations/status') {
      if (request.method !== 'GET') return failure(405, 'method_not_allowed', '状态接口仅支持 GET。', { allow: 'GET' });
      return json({ ...configuration, available: configuration.available && Boolean(store), privateContentVisible: false, paymentMutationAvailable: false, refundGatewayAvailable: false });
    }
    if (!configuration.available || !store) return failure(503, 'operations_disabled', '运营接口尚未启用。');
    let clientHash;
    try { clientHash = createHmac('sha256', secret).update(String(getClientId(request)).slice(0, 256)).digest('hex'); }
    catch { return failure(503, 'operations_unavailable', '运营接口暂不可用。'); }
    const audit = { actor, clientHash };
    try {
      if (!rate('global', 600) || !rate(`request:${clientHash}`, 120)) return failure(429, 'rate_limited', '操作太频繁，请稍后再试。', { 'retry-after': '60' });
      const authorization = request.headers.get('authorization') ?? '';
      const match = authorization.length <= 80 ? /^Bearer ([A-Za-z0-9_-]{64})$/i.exec(authorization) : null;
      // 两侧先散列成固定长度，避免按输入 token 长度提前比较秘密内容。
      const authenticated = timingSafeEqual(digest(match?.[1] ?? ''), secretDigest) && Boolean(match);
      if (!authenticated) {
        if (rate(`denied-audit:${clientHash}`, 1)) store.recordAudit({ ...audit, actor: 'unauthenticated', action: 'auth_denied', result: 'denied' });
        return failure(401, 'operations_unauthorized', '需要独立运营凭据。', { 'www-authenticate': 'Bearer' });
      }
      const origin = request.headers.get('origin'), fetchSite = request.headers.get('sec-fetch-site');
      const expectedOrigin = env.MEMBERSHIP_APP_ORIGIN?.replace(/\/$/, '') || url.origin;
      if (origin && origin !== expectedOrigin || fetchSite === 'cross-site') {
        store.recordAudit({ ...audit, action: 'origin_denied', result: 'denied' });
        return failure(403, 'origin_forbidden', '不接受跨站运营请求。');
      }
      if (['POST', 'PATCH'].includes(request.method) && !rate(`write:${clientHash}`, 20)) return failure(429, 'rate_limited', '工单操作太频繁，请稍后再试。', { 'retry-after': '60' });
      if (request.method === 'GET') {
        if (path === '/api/operations/analytics') {
          const options = queryOptions(url, ['from', 'to']);
          for (const value of Object.values(options)) if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(400, 'invalid_filter', '统计日期必须是有效的 YYYY-MM-DD。');
          if (options.from && options.to && options.from > options.to) fail(400, 'invalid_filter', '统计开始日期不能晚于结束日期。');
          const items = typeof getAnalyticsReport === 'function' ? getAnalyticsReport(options) : [];
          store.recordAudit({ ...audit, action: 'analytics_viewed' });
          return json({ configured: typeof getAnalyticsReport === 'function', items });
        }
        if (path === '/api/operations/usage-budget') {
          queryOptions(url, []);
          const result = getUsageBudgetSnapshot();
          store.recordAudit({ ...audit, action: 'usage_budget_viewed' });
          return json(result);
        }
        const routes = {
          '/api/operations/summary': ['summary', 'summary_viewed', []],
          '/api/operations/users': ['listUsers', 'users_viewed', ['limit', 'cursor', 'userId', 'authentication']],
          '/api/operations/orders': ['listOrders', 'orders_viewed', ['limit', 'cursor', 'userId', 'orderId', 'status', 'refundState']],
          '/api/operations/refund-tickets': ['listRefundTickets', 'refund_tickets_viewed', ['limit', 'cursor', 'userId', 'orderId', 'state']],
          '/api/operations/audit': ['listAudit', 'audit_viewed', ['limit', 'cursor', 'action']],
        };
        const route = routes[path];
        if (route) {
          const result = store[route[0]](queryOptions(url, route[2]));
          store.recordAudit({ ...audit, action: route[1], details: { count: result.items?.length ?? 0 } });
          return json(result);
        }
      }
      if (path === '/api/operations/refund-tickets' && request.method === 'POST') {
        queryOptions(url, []);
        const body = await readJson(request); strictKeys(body, ['orderId', 'requestId', 'reasonCode']);
        const result = store.createRefundTicket(body, audit);
        return json({ ...result, gatewayCalled: false, paymentChanged: false }, result.created ? 201 : 200);
      }
      const ticket = /^\/api\/operations\/refund-tickets\/([A-Za-z0-9_-]{8,128})$/.exec(path);
      if (ticket && request.method === 'PATCH') {
        queryOptions(url, []);
        const body = await readJson(request); strictKeys(body, ['revision', 'state']);
        return json({ ticket: store.updateRefundTicket(ticket[1], body, audit), gatewayCalled: false, paymentChanged: false });
      }
      const known = ['/api/operations/summary', '/api/operations/users', '/api/operations/orders', '/api/operations/refund-tickets', '/api/operations/audit', '/api/operations/usage-budget', '/api/operations/analytics'].includes(path) || Boolean(ticket);
      fail(known ? 405 : 404, known ? 'method_not_allowed' : 'not_found', known ? '此运营接口不支持该操作。' : '运营接口不存在。');
    } catch (error) {
      if (error instanceof OperationsError) {
        try { store.recordAudit({ ...audit, action: 'request_rejected', result: 'denied', details: { code: error.code } }); }
        catch { return failure(503, 'operations_unavailable', '运营接口暂不可用。'); }
        return failure(error.status, error.code, error.message);
      }
      return failure(503, 'operations_unavailable', '运营接口暂不可用。');
    }
  };
}
