import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { membershipPlan } from '../shared/membership-plans.mjs';
import { paymentOrderId } from './payment-order-id.mjs';
import { MEMBERSHIP_DATABASE_APPLICATION_ID } from './production-config.mjs';

export const DAY = 86400000;
export const PERIOD = 30 * DAY;
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export class MembershipError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new MembershipError(status, code, message); };
const iso = value => value == null ? null : new Date(value).toISOString();
const identityValue = identity => typeof identity === 'string' ? { channel: 'email', identifier: identity, purpose: 'login', targetUserId: null } : { purpose: 'login', targetUserId: null, ...identity };
const deliveryHash = identity => hash(identity.channel === 'email' ? identity.identifier : `${identity.channel}:${identity.identifier}`);
const codeKey = value => {
  const identity = identityValue(value);
  // 保留旧邮箱登录键，其他通道和绑定用途使用不可能是邮箱的独立键。
  return identity.channel === 'email' && identity.purpose === 'login' ? identity.identifier : `auth:${identity.channel}:${identity.purpose}:${identity.targetUserId ?? ''}:${identity.identifier}`;
};

// 同步 SQLite 事务适合本地单实例原型；生产需持久卷、备份与正式数据库迁移。
export function createMembershipStore({ filename = ':memory:', now = Date.now } = {}) {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
    // 新私库无需依赖启动 shell 的 umask；已有文件不改权限，不覆盖其他数据。
    let descriptor;
    try { descriptor = openSync(filename, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error('私人数据库文件无法创建，请检查独立目录权限。'); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  const db = new DatabaseSync(filename);
  // 防止误把别的 SQLite 应用当成人生指南；旧原型库只允许已知核心 schema 迁移。
  const applicationId = db.prepare('PRAGMA application_id').get().application_id;
  const existingTables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
  const legacyCore = ['users', 'codes', 'sessions', 'guides', 'quota_periods'];
  if (applicationId !== 0 && applicationId !== MEMBERSHIP_DATABASE_APPLICATION_ID || applicationId === 0 && existingTables.size && !legacyCore.every(table => existingTables.has(table))) {
    db.close(); throw new Error('数据库不属于 Better Life，未执行迁移。请使用独立会员数据库。');
  }
  if (applicationId === 0) db.exec(`PRAGMA application_id=${MEMBERSHIP_DATABASE_APPLICATION_ID}`);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,auth_kind TEXT NOT NULL DEFAULT 'email',label TEXT);
    CREATE TABLE IF NOT EXISTS account_identities(channel TEXT NOT NULL,identifier TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,PRIMARY KEY(channel,identifier),UNIQUE(user_id,channel));
    CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY,digest TEXT NOT NULL,salt TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS code_delivery(email_hash TEXT PRIMARY KEY,last_sent_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rates(key TEXT PRIMARY KEY,start_at INTEGER NOT NULL,count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,plan_id TEXT NOT NULL,plan_name TEXT NOT NULL,amount_fen INTEGER NOT NULL,currency TEXT NOT NULL,duration_days INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,paid_at INTEGER,transaction_id TEXT UNIQUE,checkout_url TEXT,UNIQUE(user_id,request_id));
    CREATE TABLE IF NOT EXISTS entitlements(order_id TEXT PRIMARY KEY REFERENCES orders(id),user_id TEXT NOT NULL REFERENCES users(id),plan_id TEXT NOT NULL,starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS entitlement_user ON entitlements(user_id,starts_at,ends_at);
    CREATE TABLE IF NOT EXISTS quota_periods(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL,limit_count INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS generations(user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,question_hash TEXT NOT NULL,period_id TEXT NOT NULL REFERENCES quota_periods(id),status TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,result_cipher TEXT,PRIMARY KEY(user_id,request_id));
    CREATE TABLE IF NOT EXISTS quota_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,request_id TEXT NOT NULL,period_id TEXT NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS saved_answers(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),result_cipher TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guides(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),content_cipher TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS guide_versions(id TEXT PRIMARY KEY,guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,revision INTEGER NOT NULL,content_cipher TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(guide_id,revision));
    CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY REFERENCES users(id),facts_cipher TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_events(event_key TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES orders(id),transaction_id TEXT NOT NULL,type TEXT NOT NULL,amount_fen INTEGER NOT NULL,currency TEXT NOT NULL,occurred_at INTEGER NOT NULL,received_at INTEGER NOT NULL);
  `);
  // 为此前本地原型平滑补列；不清空已有私人档案。
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!userColumns.has('auth_kind')) db.exec("ALTER TABLE users ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'email'");
  if (!userColumns.has('label')) db.exec('ALTER TABLE users ADD COLUMN label TEXT');
  const orderColumns = new Set(db.prepare('PRAGMA table_info(orders)').all().map(column => column.name));
  if (!orderColumns.has('provider_order_id')) db.exec('ALTER TABLE orders ADD COLUMN provider_order_id TEXT');
  if (!orderColumns.has('refund_state')) db.exec("ALTER TABLE orders ADD COLUMN refund_state TEXT NOT NULL DEFAULT 'none'");
  if (!orderColumns.has('refunded_at')) db.exec('ALTER TABLE orders ADD COLUMN refunded_at INTEGER');
  if (!orderColumns.has('merchant_id')) db.exec('ALTER TABLE orders ADD COLUMN merchant_id TEXT');
  if (!orderColumns.has('refund_state_at')) db.exec('ALTER TABLE orders ADD COLUMN refund_state_at INTEGER NOT NULL DEFAULT 0');
  for (const row of db.prepare('SELECT id FROM orders WHERE provider_order_id IS NULL').all()) db.prepare('UPDATE orders SET provider_order_id=? WHERE id=?').run(paymentOrderId(row.id), row.id);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS provider_order_unique ON orders(provider_order_id)');
  db.exec('CREATE INDEX IF NOT EXISTS order_user_history ON orders(user_id,created_at DESC,id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS order_user_status_history ON orders(user_id,status,created_at DESC,id DESC)');
  const codeColumns = new Set(db.prepare('PRAGMA table_info(codes)').all().map(column => column.name));
  if (!codeColumns.has('channel')) db.exec("ALTER TABLE codes ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'");
  if (!codeColumns.has('purpose')) db.exec("ALTER TABLE codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'");
  if (!codeColumns.has('target_user_id')) db.exec('ALTER TABLE codes ADD COLUMN target_user_id TEXT');
  if (!codeColumns.has('identifier')) db.exec('ALTER TABLE codes ADD COLUMN identifier TEXT');
  db.exec("UPDATE codes SET identifier=email WHERE identifier IS NULL; INSERT OR IGNORE INTO account_identities(channel,identifier,user_id,created_at) SELECT 'email',email,id,created_at FROM users WHERE auth_kind='email'");
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const assertUserActive = user => { const current = get('SELECT id,auth_kind FROM users WHERE id=?', user?.id); if (!current || current.auth_kind === 'deleted') fail(401, 'login_required', '登录状态已失效，请重新登录。'); return current; };
  const ledger = (user, request, period, action) => run('INSERT INTO quota_ledger(user_id,request_id,period_id,action,created_at) VALUES(?,?,?,?,?)', user, request, period, action, now());
  function rate(key, max, windowMs) {
    const timestamp = now();
    const row = get('SELECT * FROM rates WHERE key=?', key);
    if (!row || timestamp - row.start_at >= windowMs) run('INSERT INTO rates(key,start_at,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET start_at=excluded.start_at,count=1', key, timestamp);
    else {
      if (row.count >= max) fail(429, 'rate_limited', '操作太频繁，请稍后再试。');
      run('UPDATE rates SET count=count+1 WHERE key=?', key);
    }
  }
  function finish(userId, requestId, consume, resultCipher = null) {
    return tx(() => {
      const generation = get('SELECT * FROM generations WHERE user_id=? AND request_id=?', userId, requestId);
      if (!generation || generation.status !== 'reserved') return false;
      run('UPDATE quota_periods SET reserved=MAX(0,reserved-1),used=used+? WHERE id=?', consume ? 1 : 0, generation.period_id);
      run('UPDATE generations SET status=?,result_cipher=?,expires_at=? WHERE user_id=? AND request_id=?', consume ? 'completed' : 'released', resultCipher, now() + DAY, userId, requestId);
      ledger(userId, requestId, generation.period_id, consume ? 'consume' : 'release');
      return true;
    });
  }
  function cleanup() {
    // 悬挂预占不能变成永久扣次；最长模型等待 45 秒，预占 2 分钟后释放。
    for (const row of all("SELECT user_id,request_id FROM generations WHERE status='reserved' AND expires_at<=?", now())) finish(row.user_id, row.request_id, false);
    run('DELETE FROM codes WHERE expires_at<=?', now());
    run('DELETE FROM sessions WHERE expires_at<=?', now());
    run('DELETE FROM rates WHERE start_at<?', now() - 2 * DAY);
    run('DELETE FROM code_delivery WHERE last_sent_at<?', now() - 2 * DAY);
    // 删除回答缓存，不删除扣次流水或幂等墓碑，防止旧 requestId 再次生成。
    run("UPDATE generations SET result_cipher=NULL WHERE status!='reserved' AND expires_at<=? AND result_cipher IS NOT NULL", now());
  }
  const identityOwner = identity => { const value = identityValue(identity); return get('SELECT users.* FROM account_identities JOIN users ON users.id=account_identities.user_id WHERE channel=? AND identifier=?', value.channel, value.identifier) ?? null; };
  function linkAllowed(user, identity) {
    const current = get('SELECT * FROM users WHERE id=?', user.id), value = identityValue(identity);
    if (!current || ['local-demo', 'deleted'].includes(current.auth_kind)) fail(403, 'identity_link_forbidden', '当前账号不能绑定正式登录信息，请重新登录。');
    const owner = identityOwner(value);
    if (owner && owner.id !== user.id) fail(409, 'identity_in_use', '这个手机号或邮箱已绑定其他账号，不能合并账号。');
    const existing = get('SELECT identifier FROM account_identities WHERE user_id=? AND channel=?', user.id, value.channel);
    if (existing && existing.identifier !== value.identifier) fail(409, 'identity_already_linked', '当前账号已经绑定该类登录信息，暂不支持直接更换。');
    return current;
  }
  function issueCode(identity, digest, salt, client, { smsDailyLimit = 100 } = {}) {
    const value = identityValue(identity), key = codeKey(value), identityHash = deliveryHash(value);
    tx(() => {
      rate(`code:ip:${hash(client)}`, 20, 3600000);
      rate('code:global', 200, 3600000);
      rate(`code:${value.channel}:${identityHash}`, 5, 3600000);
      if (value.channel === 'phone') rate('code:sms:daily', smsDailyLimit, DAY);
      if (value.purpose === 'link') { linkAllowed({ id: value.targetUserId }, value); rate(`code:link:${value.targetUserId}`, 10, 3600000); }
      const previous = get('SELECT last_sent_at FROM code_delivery WHERE email_hash=?', identityHash);
      if (previous && now() - previous.last_sent_at < 60000) fail(429, 'code_cooldown', '请等 60 秒后再获取验证码。');
      run('INSERT INTO codes(email,digest,salt,expires_at,attempts,created_at,channel,purpose,target_user_id,identifier) VALUES(?,?,?,?,0,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET digest=excluded.digest,salt=excluded.salt,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at,channel=excluded.channel,purpose=excluded.purpose,target_user_id=excluded.target_user_id,identifier=excluded.identifier', key, digest, salt, now() + 300000, now(), value.channel, value.purpose, value.targetUserId, value.identifier);
      run('INSERT INTO code_delivery(email_hash,last_sent_at) VALUES(?,?) ON CONFLICT(email_hash) DO UPDATE SET last_sent_at=excluded.last_sent_at', identityHash, now());
    });
  }
  function verifyCode(identity, checkDigest, client, tokenHash) {
    const value = identityValue(identity), key = codeKey(value);
    // 错误尝试必须提交，不能因抛错而被事务回滚。
    const outcome = tx(() => {
      rate(`verify:ip:${hash(client)}`, 30, 60000);
      rate(`verify:${value.channel}:${deliveryHash(value)}`, 15, 60000);
      const code = get('SELECT * FROM codes WHERE email=?', key);
      if (!code || code.expires_at <= now() || code.attempts >= 5 || code.channel !== value.channel || code.purpose !== value.purpose || code.target_user_id !== value.targetUserId || code.identifier !== value.identifier) return null;
      run('UPDATE codes SET attempts=attempts+1 WHERE email=?', key);
      if (!checkDigest(code)) return null;
      run('DELETE FROM codes WHERE email=?', key);
      let user = identityOwner(value);
      if (value.purpose === 'link') {
        try { user = linkAllowed({ id: value.targetUserId }, value); } catch (error) { if (error instanceof MembershipError) return { error }; throw error; }
        run('INSERT OR IGNORE INTO account_identities(channel,identifier,user_id,created_at) VALUES(?,?,?,?)', value.channel, value.identifier, user.id, now());
      } else if (!user) {
        const id = randomUUID(), email = value.channel === 'email' ? value.identifier : `phone-${id}@local.invalid`;
        run('INSERT INTO users(id,email,created_at,auth_kind) VALUES(?,?,?,?)', id, email, now(), value.channel);
        run('INSERT INTO account_identities(channel,identifier,user_id,created_at) VALUES(?,?,?,?)', value.channel, value.identifier, id, now());
        user = get('SELECT * FROM users WHERE id=?', id);
      }
      run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', tokenHash, user.id, now() + PERIOD);
      return user;
    });
    if (!outcome) fail(400, 'invalid_code', '验证码无效或已过期，请重新获取。');
    if (outcome.error) throw outcome.error;
    return outcome;
  }
  const sessionUser = tokenHash => get("SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.auth_kind!='deleted'", tokenHash, now()) ?? null;
  function localDemoUser(tokenHash) {
    return tx(() => {
      rate('local-demo:session', 5, 60000);
      let user = get("SELECT * FROM users WHERE auth_kind='local-demo' LIMIT 1");
      if (!user) {
        const id = randomUUID();
        run("INSERT INTO users(id,email,created_at,auth_kind,label) VALUES(?,?,?,'local-demo','本机体验账号')", id, `local-preview-${id}@local.invalid`, now());
        user = get('SELECT * FROM users WHERE id=?', id);
      }
      run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', tokenHash, user.id, now() + PERIOD);
      return user;
    });
  }
  function active(user) { return user.auth_kind === 'local-demo' ? null : get('SELECT * FROM entitlements WHERE user_id=? AND starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1', user.id, now(), now()); }
  function period(user) {
    const entitlement = active(user);
    const plan = membershipPlan(entitlement?.plan_id || 'free');
    const anchor = entitlement?.starts_at ?? user.created_at;
    const starts = anchor + Math.floor((now() - anchor) / PERIOD) * PERIOD;
    const ends = Math.min(starts + PERIOD, entitlement?.ends_at ?? Infinity);
    const id = hash(`${user.id}:${entitlement?.order_id ?? 'free'}:${starts}`);
    run('INSERT OR IGNORE INTO quota_periods(id,user_id,starts_at,ends_at,limit_count) VALUES(?,?,?,?,?)', id, user.id, starts, ends, plan.quotaPerPeriod);
    return get('SELECT * FROM quota_periods WHERE id=?', id);
  }
  const orderView = row => ({ id: row.id, planId: row.plan_id, planName: row.plan_name, amountFen: row.amount_fen, currency: row.currency, status: row.status, refundState: row.refund_state, createdAt: iso(row.created_at), paidAt: iso(row.paid_at), refundedAt: iso(row.refunded_at), expiresAt: iso(row.expires_at), checkoutUrl: row.status === 'pending' && row.expires_at > now() ? row.checkout_url : null });
  function orderHistory(user, { status = 'all', limit = 20, cursor = null } = {}) {
    assertUserActive(user);
    if (!['all', 'paid'].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(cursor))) fail(400, 'invalid_order_history', '订单列表参数无效，请刷新后重试。');
    // 游标只接受本人已有的订单 ID；时间和账号不由客户端决定。
    // 本接口只读本地已核验状态，不查支付网关、不修改订单或额度。
    const anchor = cursor === null ? null : get('SELECT id,created_at,status FROM orders WHERE id=? AND user_id=?', cursor, user.id);
    if (cursor !== null && (!anchor || status === 'paid' && anchor.status !== 'paid')) fail(400, 'invalid_order_cursor', '订单列表已变化，请刷新后重试。');
    const conditions = ['user_id=?'], parameters = [user.id];
    if (status === 'paid') conditions.push("status='paid'");
    if (anchor) { conditions.push('(created_at<? OR (created_at=? AND id<?))'); parameters.push(anchor.created_at, anchor.created_at, anchor.id); }
    const rows = all(`SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`, ...parameters, limit + 1);
    const hasMore = rows.length > limit, items = rows.slice(0, limit);
    return { ownerId: user.id, items: items.map(orderView), nextCursor: hasMore ? items.at(-1).id : null };
  }
  function me(user) {
    if (!user) return { user: null, membership: { planId: 'free', name: '免费使用', expiresAt: null }, quota: { limit: 0, used: 0, remaining: 0, resetsAt: null }, orders: [] };
    const entitlement = active(user), plan = membershipPlan(entitlement?.plan_id ?? 'free'), quota = period(user);
    const identities = user.auth_kind === 'local-demo' ? [] : all('SELECT channel,identifier FROM account_identities WHERE user_id=?', user.id);
    const email = identities.find(identity => identity.channel === 'email')?.identifier ?? null, phone = identities.find(identity => identity.channel === 'phone')?.identifier ?? null;
    return { user: { id: user.id, email, phone, label: user.auth_kind === 'local-demo' ? '本机体验账号' : email ?? phone, authentication: user.auth_kind || 'email' }, membership: { planId: plan.id, name: plan.name, expiresAt: iso(entitlement?.ends_at) }, quota: { limit: quota.limit_count, used: quota.used, remaining: Math.max(0, quota.limit_count - quota.used - quota.reserved), resetsAt: iso(quota.ends_at) }, orders: all('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30', user.id).map(orderView) };
  }
  function reserve(user, requestId, questionHash) {
    return tx(() => {
      assertUserActive(user);
      const previous = get('SELECT * FROM generations WHERE user_id=? AND request_id=?', user.id, requestId);
      if (previous) {
        if (previous.question_hash !== questionHash) fail(409, 'request_id_conflict', '这个请求编号已用于其他问题，请重新提交。');
        if (previous.status === 'completed') {
          if (!previous.result_cipher || previous.expires_at <= now()) fail(409, 'request_expired', '回答重试已过期，请使用新的请求编号。');
          return { cached: previous.result_cipher };
        }
        if (previous.status === 'reserved') fail(409, 'request_pending', '这个问题正在回答，请稍后再查看。');
        fail(409, 'request_released', '上次请求未完成，请使用新的请求编号重试。');
      }
      if (get("SELECT request_id FROM generations WHERE user_id=? AND status='reserved'", user.id)) fail(429, 'user_busy', '先等当前回答完成，再问下一个问题。');
      if (get("SELECT COUNT(*) AS count FROM generations WHERE user_id=? AND status='completed' AND created_at>=?", user.id, Math.floor(now() / DAY) * DAY).count >= 30) fail(429, 'daily_limit', '今天已生成 30 份回答，明天再来吧。');
      rate(`ask:${user.id}`, 6, 60000);
      const quota = period(user);
      const update = run('UPDATE quota_periods SET reserved=reserved+1 WHERE id=? AND used+reserved<limit_count', quota.id);
      if (!update.changes) fail(402, 'quota_exhausted', '本期提问次数已用完，可查看额度更新时间或会员套餐。');
      run("INSERT INTO generations(user_id,request_id,question_hash,period_id,status,created_at,expires_at) VALUES(?,?,?,?,'reserved',?,?)", user.id, requestId, questionHash, quota.id, now(), now() + 120000);
      ledger(user.id, requestId, quota.id, 'reserve');
      return { reserved: true };
    });
  }
  function createOrder(user, plan, requestId, merchantId) {
    return tx(() => {
      assertUserActive(user);
      if (typeof merchantId !== 'string' || !/^[A-Za-z0-9_*-]{1,128}$/.test(merchantId)) fail(503, 'payment_merchant_unbound', '收费订单必须绑定已配置的商户。');
      const existing = get('SELECT * FROM orders WHERE user_id=? AND request_id=?', user.id, requestId);
      if (existing) {
        if (existing.merchant_id !== merchantId) fail(409, 'payment_merchant_mismatch', '这笔订单属于原商户，请保留原支付通道核对。');
        if (existing.plan_id !== plan.id) fail(409, 'request_id_conflict', '这个请求编号已用于其他套餐。');
        return { order: existing, created: false };
      }
      // 控制未支付订单堆积；刷新/双击通过 requestId 复用原订单。
      rate(`orders:${user.id}`, 10, 3600000);
      const id = randomUUID();
      run("INSERT INTO orders(id,user_id,request_id,plan_id,plan_name,amount_fen,currency,duration_days,status,created_at,expires_at,provider_order_id,merchant_id) VALUES(?,?,?,?,?,?,?,?,'created',?,?,?,?)", id, user.id, requestId, plan.id, plan.name, plan.amountFen, plan.currency, plan.durationDays, now(), now() + 1800000, paymentOrderId(id), merchantId);
      return { order: get('SELECT * FROM orders WHERE id=?', id), created: true };
    });
  }
  const ownedOrder = (user, id) => { const row = get('SELECT * FROM orders WHERE id=? AND user_id=?', id, user.id); if (!row) fail(404, 'order_not_found', '未找到这个订单。'); return row; };
  function settlePaid(current, payment) {
      if (!current || !current.merchant_id || payment.merchantId !== current.merchant_id || payment.amountFen !== current.amount_fen || payment.currency !== current.currency || payment.orderId !== current.id || typeof payment.transactionId !== 'string' || !/^[A-Za-z0-9_*-]{1,128}$/.test(payment.transactionId) || payment.status !== 'paid') fail(502, 'payment_mismatch', '支付结果尚未通过核对，暂不开通会员。');
      if (current.transaction_id && current.transaction_id !== payment.transactionId) fail(502, 'payment_mismatch', '支付流水与原订单不一致，暂不变更权益。');
      // 已退款是终态；迟到/重复的已支付通知绝不能复活会员。
      if (current.status === 'paid' || current.status === 'refunded') return current;
      const duplicate = get('SELECT id FROM orders WHERE transaction_id=?', payment.transactionId);
      if (duplicate && duplicate.id !== current.id) fail(502, 'duplicate_payment', '支付流水核对失败，暂不开通会员。');
      const end = get('SELECT MAX(ends_at) AS end FROM entitlements WHERE user_id=?', current.user_id)?.end;
      const start = Math.max(now(), end ?? now());
      run("UPDATE orders SET status='paid',transaction_id=?,paid_at=? WHERE id=?", payment.transactionId, now(), current.id);
      run('INSERT OR IGNORE INTO entitlements(order_id,user_id,plan_id,starts_at,ends_at) VALUES(?,?,?,?,?)', current.id, current.user_id, current.plan_id, start, start + current.duration_days * DAY);
      return get('SELECT * FROM orders WHERE id=?', current.id);
  }
  function confirmPaid(order, payment) { return tx(() => settlePaid(get('SELECT * FROM orders WHERE id=?', order.id), payment)); }
  function acceptPaymentEvent(event) {
    return tx(() => {
      if (!event || !/^[a-f0-9]{64}$/.test(event.eventKey || '') || !['paid', 'refunded', 'refund_pending', 'refund_failed'].includes(event.type)) fail(400, 'invalid_payment_event', '支付通知格式无效。');
      const order = get('SELECT * FROM orders WHERE provider_order_id=?', event.providerOrderId);
      if (!order) fail(404, 'order_not_found', '未找到支付通知对应的订单。');
      const user = get('SELECT auth_kind FROM users WHERE id=?', order.user_id);
      if (user?.auth_kind === 'local-demo') fail(403, 'demo_payment_forbidden', '本机体验账号不能开通付费会员。');
      if (!order.merchant_id || event.merchantId !== order.merchant_id || event.amountFen !== order.amount_fen || event.currency !== order.currency || typeof event.transactionId !== 'string' || !/^[A-Za-z0-9_*-]{1,128}$/.test(event.transactionId) || !Number.isSafeInteger(event.occurredAt) || event.occurredAt < order.created_at - 300000 || event.occurredAt > now() + 300000) fail(502, 'payment_mismatch', '支付通知与订单金额或商户归属不一致。');
      if (order.transaction_id && order.transaction_id !== event.transactionId) fail(502, 'payment_mismatch', '支付通知与原交易流水不一致。');
      const duplicateTransaction = get('SELECT id FROM orders WHERE transaction_id=?', event.transactionId);
      if (duplicateTransaction && duplicateTransaction.id !== order.id) fail(502, 'duplicate_payment', '支付流水已用于其他订单。');
      if (get('SELECT order_id FROM payment_events WHERE transaction_id=? AND order_id<>? LIMIT 1', event.transactionId, order.id)) fail(502, 'duplicate_payment', '支付通知流水已归属于其他订单。');
      const prior = get('SELECT * FROM payment_events WHERE event_key=?', event.eventKey);
      if (prior) {
        if (prior.merchant_id !== event.merchantId || prior.order_id !== order.id || prior.transaction_id !== event.transactionId || prior.amount_fen !== event.amountFen || prior.currency !== event.currency || prior.type !== event.type || prior.occurred_at !== event.occurredAt) fail(502, 'payment_event_conflict', '重复支付通知的内容不一致。');
        return order;
      }
      run('INSERT INTO payment_events(event_key,merchant_id,order_id,transaction_id,type,amount_fen,currency,occurred_at,received_at) VALUES(?,?,?,?,?,?,?,?,?)', event.eventKey, event.merchantId, order.id, event.transactionId, event.type, event.amountFen, event.currency, event.occurredAt, now());
      if (event.type === 'paid') return settlePaid(order, { ...event, orderId: order.id, status: 'paid' });
      if (event.type === 'refunded') {
        // 无论 CD / OD 的网络到达顺序，只撤销此订单，不改其他已付续购窗口。
        if (order.status !== 'refunded') run("UPDATE orders SET status='refunded',refund_state='refunded',refund_state_at=?,refunded_at=?,transaction_id=? WHERE id=?", event.occurredAt, event.occurredAt, event.transactionId, order.id);
        run('DELETE FROM entitlements WHERE order_id=?', order.id);
      } else if (order.status !== 'refunded') {
        const ranks = { none: 0, refund_pending: 1, refund_failed: 2, refunded: 3 };
        // 后来的退款尝试可以重进pending；同秒/倒序旧消息不能抹掉更晚失败事实。
        if (event.occurredAt > order.refund_state_at || event.occurredAt === order.refund_state_at && ranks[event.type] > ranks[order.refund_state]) run('UPDATE orders SET refund_state=?,refund_state_at=? WHERE id=?', event.type, event.occurredAt, order.id);
      }
      return get('SELECT * FROM orders WHERE id=?', order.id);
    });
  }
  function saveAnswer(user, cipher) {
    return tx(() => {
      assertUserActive(user);
      const max = active(user) ? 200 : 10;
      if (get('SELECT COUNT(*) AS count FROM saved_answers WHERE user_id=?', user.id).count >= max) fail(409, 'save_limit', `已达到 ${max} 份云端保存上限，删除旧记录后再保存。`);
      const id = randomUUID(); run('INSERT INTO saved_answers(id,user_id,result_cipher,created_at) VALUES(?,?,?,?)', id, user.id, cipher, now());
      return { id, createdAt: iso(now()) };
    });
  }
  const ownedGuide = (user, id) => {
    const guide = get('SELECT * FROM guides WHERE user_id=? AND id=?', user.id, id);
    if (!guide) fail(404, 'guide_not_found', '未找到这份私人指南。');
    return guide;
  };
  const guideLimit = user => membershipPlan(active(user)?.plan_id ?? 'free').guideLimit;
  function createGuide(user, cipher) {
    return tx(() => {
      assertUserActive(user);
      if (get('SELECT COUNT(*) AS count FROM guides WHERE user_id=?', user.id).count >= guideLimit(user)) fail(409, 'guide_limit', '私人指南已达到本套餐容量，请整理旧档案或查看会员套餐。');
      const id = randomUUID(), timestamp = now();
      run('INSERT INTO guides(id,user_id,content_cipher,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)', id, user.id, cipher, timestamp, timestamp);
      run('INSERT INTO guide_versions(id,guide_id,revision,content_cipher,created_at) VALUES(?,?,1,?,?)', randomUUID(), id, cipher, timestamp);
      return ownedGuide(user, id);
    });
  }
  function updateGuide(user, id, revision, cipher) {
    return tx(() => {
      assertUserActive(user);
      const guide = ownedGuide(user, id);
      if (guide.revision !== revision) fail(409, 'revision_conflict', '这份指南已有新修改，请刷新后合并你的内容。');
      const timestamp = now();
      run('UPDATE guides SET content_cipher=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?', cipher, timestamp, id, user.id, revision);
      run('INSERT INTO guide_versions(id,guide_id,revision,content_cipher,created_at) VALUES(?,?,?,?,?)', randomUUID(), id, revision + 1, cipher, timestamp);
      // 每份指南保留最新 100 个版本；恢复生成新版本，不篡改历史。
      run('DELETE FROM guide_versions WHERE guide_id=? AND id NOT IN (SELECT id FROM guide_versions WHERE guide_id=? ORDER BY revision DESC LIMIT 100)', id, id);
      return ownedGuide(user, id);
    });
  }
  function guideVersions(user, id) { ownedGuide(user, id); return all('SELECT * FROM guide_versions WHERE guide_id=? ORDER BY revision DESC', id); }
  function ownedVersion(user, id, versionId) {
    ownedGuide(user, id);
    const version = get('SELECT * FROM guide_versions WHERE guide_id=? AND id=?', id, versionId);
    if (!version) fail(404, 'version_not_found', '未找到这个历史版本。');
    return version;
  }
  function updateProfile(user, revision, cipher) {
    return tx(() => {
      assertUserActive(user);
      const profile = get('SELECT * FROM profiles WHERE user_id=?', user.id);
      if ((profile?.revision ?? 0) !== revision) fail(409, 'revision_conflict', '个人情况已有新修改，请刷新后再保存。');
      run('INSERT INTO profiles(user_id,facts_cipher,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET facts_cipher=excluded.facts_cipher,revision=profiles.revision+1,updated_at=excluded.updated_at', user.id, cipher, now());
      return get('SELECT * FROM profiles WHERE user_id=?', user.id);
    });
  }
  const assertPaymentMerchant = merchantId => {
    if (get('SELECT id FROM orders WHERE merchant_id IS NULL OR merchant_id<>? LIMIT 1', merchantId)) fail(503, 'payment_merchant_mismatch', '数据库含未绑定或其他商户的历史订单，需保留原通道并人工核对，不自动迁移支付归属。');
  };
  return { db, close: () => db.close(), cleanup, issueCode, verifyCode, identityOwner, linkAllowed, sessionUser, localDemoUser, me, reserve, finish, orderView, orderHistory, createOrder, ownedOrder, confirmPaid, acceptPaymentEvent, assertPaymentMerchant, saveAnswer,
    throttle: (key, max, windowMs) => tx(() => rate(key, max, windowMs)),
    revokeSession: tokenHash => run('DELETE FROM sessions WHERE token_hash=?', tokenHash),
    cancelCode: (identity, digest) => run('DELETE FROM codes WHERE email=? AND digest=?', codeKey(identity), digest),
    pendingOrder: (id, checkoutUrl) => run("UPDATE orders SET status='pending',checkout_url=? WHERE id=? AND status='created'", checkoutUrl, id),
    failOrder: id => run("UPDATE orders SET status='failed' WHERE id=? AND status='created'", id),
    expireOrder: id => run("UPDATE orders SET status='expired' WHERE id=? AND status IN('created','pending') AND expires_at<=?", id, now()),
    savedAnswers: user => all('SELECT * FROM saved_answers WHERE user_id=? ORDER BY created_at DESC', user.id),
    deleteAnswer: (user, id) => run('DELETE FROM saved_answers WHERE user_id=? AND id=?', user.id, id).changes,
    ownedGuide, guideLimit, createGuide, updateGuide, guideVersions, ownedVersion, updateProfile,
    guides: user => all('SELECT * FROM guides WHERE user_id=? ORDER BY updated_at DESC', user.id),
    deleteGuide: (user, id) => { ownedGuide(user, id); return run('DELETE FROM guides WHERE user_id=? AND id=?', user.id, id).changes; },
    profile: user => get('SELECT * FROM profiles WHERE user_id=?', user.id) ?? null,
  };
}
