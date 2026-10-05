import { createHash } from 'node:crypto';
import { MEMBERSHIP_DATABASE_APPLICATION_ID } from './production-config.mjs';

export const FRESH_AUTHENTICATION_MS = 10 * 60 * 1000;
export class AccountLifecycleError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new AccountLifecycleError(status, code, message); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const validTokenHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new AccountLifecycleError(503, 'account_unavailable', '账号操作暂不可用，请稍后重试。');

// 连接由会员 store 所有者管理；markAuthenticated 只能由真正成功的 OTP 登录/绑定调用。
// 不提供公开 mark/刷新鲜登录接口，旧 session 没有标记必须重新验证。
export function createAccountLifecycle({ store, now = Date.now } = {}) {
  const db = store?.db;
  if (!db || db.prepare('PRAGMA application_id').get().application_id !== MEMBERSHIP_DATABASE_APPLICATION_ID) throw new Error('账号生命周期需要已验证的 Better Life 会员数据库。');
  const required = ['users', 'sessions', 'account_identities', 'codes', 'code_delivery', 'rates', 'guides', 'guide_versions', 'profiles', 'saved_answers', 'generations', 'quota_periods', 'entitlements', 'orders', 'payment_events', 'quota_ledger'];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  if (!required.every(name => tables.has(name))) throw new Error('账号生命周期需要完整会员数据库结构。');
  db.exec('CREATE TABLE IF NOT EXISTS account_session_freshness(token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,authenticated_at INTEGER NOT NULL)');
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function safely(fn) { try { return fn(); } catch (error) { throw error instanceof AccountLifecycleError ? error : unavailable(); } }
  function session(user, tokenHash) {
    if (!validId(user?.id) || !validTokenHash(tokenHash)) fail(401, 'login_required', '请先登录。');
    const row = get('SELECT u.id,u.email,u.auth_kind FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=? AND s.expires_at>?', user.id, tokenHash, now());
    if (!row || row.auth_kind === 'deleted') fail(401, 'login_required', '请重新登录后再操作。');
    return row;
  }
  function freshness(user, tokenHash) {
    session(user, tokenHash);
    const row = get('SELECT authenticated_at FROM account_session_freshness WHERE token_hash=?', tokenHash), timestamp = now();
    const fresh = Boolean(row && Number.isSafeInteger(row.authenticated_at) && row.authenticated_at <= timestamp && timestamp - row.authenticated_at < FRESH_AUTHENTICATION_MS);
    return { freshAuthentication: fresh, reauthenticationRequired: !fresh,
      authenticatedAt: row ? new Date(row.authenticated_at).toISOString() : null,
      expiresAt: row ? new Date(row.authenticated_at + FRESH_AUTHENTICATION_MS).toISOString() : null };
  }
  function markAuthenticated(tokenHash) {
    return safely(() => {
      if (!validTokenHash(tokenHash)) fail(401, 'login_required', '请先完成真实登录验证。');
      const row = get('SELECT u.auth_kind FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', tokenHash, now());
      if (!row || row.auth_kind === 'deleted') fail(401, 'login_required', '请先完成真实登录验证。');
      if (row.auth_kind === 'local-demo') fail(403, 'demo_account_forbidden', '本机体验账号不支持正式账号注销。');
      run('INSERT INTO account_session_freshness(token_hash,authenticated_at) VALUES(?,?) ON CONFLICT(token_hash) DO UPDATE SET authenticated_at=excluded.authenticated_at', tokenHash, now());
      return { authenticatedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + FRESH_AUTHENTICATION_MS).toISOString() };
    });
  }
  function blockers(userId) {
    const reasons = [], timestamp = now();
    // 包含未来续期窗口；不能把未开始但仍有效的权益偷偷丢弃。
    if (get('SELECT 1 FROM entitlements WHERE user_id=? AND ends_at>? LIMIT 1', userId, timestamp)) reasons.push('active_membership');
    // 本地失败/到期只是界面和请求状态，不是网关确认关单；有效迟到 paid 仍会入账。
    // 没有受信关单实现前，任何未核验 paid/refunded 的订单都不能随注销失去登录归属。
    if (get("SELECT 1 FROM orders WHERE user_id=? AND status NOT IN ('paid','refunded') LIMIT 1", userId)) reasons.push('unsettled_orders');
    if (get("SELECT 1 FROM orders WHERE user_id=? AND refund_state='refund_pending' LIMIT 1", userId)) reasons.push('refund_pending');
    if (get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='operations_refund_tickets'") && get("SELECT 1 FROM operations_refund_tickets WHERE user_id=? AND state IN ('requested','reviewing','approved','awaiting_provider') LIMIT 1", userId)) reasons.push('open_refund_request');
    if (get("SELECT 1 FROM generations WHERE user_id=? AND status='reserved' AND expires_at>? LIMIT 1", userId, timestamp)) reasons.push('generation_in_progress');
    return reasons;
  }
  const blockerMessages = {
    active_membership: '账号仍有当前或未来生效的会员权益，请先处理后再注销。',
    unsettled_orders: '账号仍有未核清订单，本地失败或到期不等于支付平台关单，请先联系本站客服核对后再申请注销。',
    refund_pending: '账号仍有支付平台退款处理中订单，请待核验结果后再注销。',
    open_refund_request: '账号仍有未结退款申请，请先完成工单处理后再注销。',
    generation_in_progress: '账号仍有进行中的问答，请等本次请求结束后再注销。',
  };
  function freshnessStatus(user, { tokenHash } = {}) { return safely(() => freshness(user, tokenHash)); }
  function accountStatus(user, { tokenHash } = {}) {
    return safely(() => {
      const row = session(user, tokenHash), status = freshness(user, tokenHash);
      const deletionBlockers = row.auth_kind === 'local-demo' ? ['demo_account_forbidden'] : blockers(row.id);
      return { ...status, deletionBlockers, canDelete: status.freshAuthentication && deletionBlockers.length === 0 };
    });
  }
  function deleteAccount(user, { tokenHash, confirmation } = {}) {
    return safely(() => {
      let started = false;
      try {
        db.exec('BEGIN IMMEDIATE'); started = true;
        const row = session(user, tokenHash);
        if (row.auth_kind === 'local-demo') fail(403, 'demo_account_forbidden', '本机体验账号不支持正式账号注销。');
        if (confirmation !== '删除我的账号') fail(400, 'confirmation_required', '请准确输入“删除我的账号”确认。');
        if (!freshness(user, tokenHash).freshAuthentication) fail(403, 'reauthentication_required', '注销需要最近 10 分钟内重新登录验证，请先退出并重新登录。');
        const blocked = blockers(row.id);
        if (blocked.length) fail(409, blocked[0], blockerMessages[blocked[0]]);
        const identities = all('SELECT channel,identifier FROM account_identities WHERE user_id=?', row.id);
        run('DELETE FROM codes WHERE target_user_id=? OR email=?', row.id, row.email);
        for (const identity of identities) {
          run('DELETE FROM codes WHERE (channel=? AND identifier=?) OR (channel=? AND email=?)', identity.channel, identity.identifier, identity.channel, identity.identifier);
          const identityHash = hash(identity.channel === 'email' ? identity.identifier : `${identity.channel}:${identity.identifier}`);
          run('DELETE FROM code_delivery WHERE email_hash=?', identityHash);
          run('DELETE FROM rates WHERE key IN (?,?)', `code:${identity.channel}:${identityHash}`, `verify:${identity.channel}:${identityHash}`);
        }
        // 只删可归属的主体限流记录；全局和 IP/SMS 费用限额保留，不能注销重置全站保护。
        run('DELETE FROM rates WHERE key IN (?,?)', `code:link:${row.id}`, `private-write:${row.id}`);
        run('DELETE FROM guide_versions WHERE guide_id IN (SELECT id FROM guides WHERE user_id=?)', row.id);
        for (const table of ['guides', 'profiles', 'saved_answers', 'generations', 'quota_periods', 'account_identities']) run(`DELETE FROM ${table} WHERE user_id=?`, row.id);
        // 先删 generations 再删 quota；扣次金融/用量流水不含原问题，继续保留。
        run('DELETE FROM entitlements WHERE user_id=? AND ends_at<=?', row.id, now());
        run('DELETE FROM sessions WHERE user_id=?', row.id); // FK cascade 清除所有端 freshness。
        run("UPDATE users SET email=?,auth_kind='deleted',label=NULL WHERE id=?", `deleted-${row.id}@local.invalid`, row.id);
        db.exec('COMMIT'); started = false;
        return { deleted: true, sessionsRevoked: true, privateContentDeleted: true, financialRecordsRetained: true };
      } catch (error) { if (started) { try { db.exec('ROLLBACK'); } catch {} } throw error; }
    });
  }
  return { markAuthenticated, freshnessStatus, accountStatus, deleteAccount };
}
