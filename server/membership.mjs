import { randomBytes, randomInt, randomUUID, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { MEMBERSHIP_PLANS, membershipPlan } from '../shared/membership-plans.mjs';
import { createMembershipStore, MembershipError, hash } from './membership-store.mjs';
import { validateAnswer } from './qa.mjs';
import { createTencentSmsSender } from './auth-delivery.mjs';
import { createAliyunSmsSender, createAliyunEmailSender } from './aliyun-delivery.mjs';
import { PaymentNotificationError } from './payment-hupijiao.mjs';
import { validateQaHistory, QaHistoryError } from '../shared/qa-history.mjs';
import { OperationsError } from './operations.mjs';
import { createAccountLifecycle, AccountLifecycleError } from './account-lifecycle.mjs';

const COOKIE = 'better_life_session';
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const failure = (status, code, message) => json({ error: { code, message } }, status);
const error = (status, code, message) => { throw new MembershipError(status, code, message); };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const loopbackClient = value => typeof value === 'string' && (value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1');
const loopbackOrigin = value => value.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname);
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(value);
function normalizeEmail(value) { const email = typeof value === 'string' ? value.trim().toLowerCase() : ''; if (!validEmail(email) || /@(?:[^@.]+\.)*local\.invalid$/.test(email)) error(400, 'invalid_email', '请填写有效的邮箱地址。'); return email; }
function normalizeIdentity(body, purpose = 'login', targetUserId = null) {
  const email = Object.hasOwn(body, 'email'), phone = Object.hasOwn(body, 'phone');
  if (email === phone) error(400, 'invalid_identity', '请只填写一个邮箱或手机号。');
  if (email) return { channel: 'email', identifier: normalizeEmail(body.email), purpose, targetUserId };
  const value = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!/^(?:\+86)?1[3-9]\d{9}$/.test(value)) error(400, 'invalid_phone', '请填写有效的中国大陆 11 位手机号。');
  return { channel: 'phone', identifier: value.startsWith('+86') ? value : `+86${value}`, purpose, targetUserId };
}
function token(request) { return request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''; }
function sessionHash(request) { const value = token(request); return /^[a-zA-Z0-9_-]{43}$/.test(value) ? hash(value) : ''; }
async function readJson(request, limit = 8192) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) error(415, 'invalid_content_type', '请使用 JSON 提交内容。');
  if (Number(request.headers.get('content-length')) > limit) error(413, 'body_too_large', '内容过长，请缩短后再试。');
  const reader = request.body?.getReader();
  if (!reader) error(400, 'invalid_request', '请填写提交内容。');
  let timer, abort;
  const interruption = new Promise((_, reject) => {
    const stop = value => { reject(value); reader.cancel().catch(() => {}); };
    abort = () => stop(new MembershipError(499, 'cancelled', '操作已取消。'));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    timer = setTimeout(() => stop(new MembershipError(408, 'body_timeout', '提交超时，请重试。')), 10000);
  });
  let length = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interruption]);
      if (done) break;
      length += value.byteLength;
      if (length > limit) { reader.cancel().catch(() => {}); error(413, 'body_too_large', '内容过长，请缩短后再试。'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { error(400, 'invalid_json', '提交内容格式不正确。'); }
}

export function createResendSender({ env = {}, fetchImpl = globalThis.fetch } = {}) {
  if (!env.RESEND_API_KEY?.trim() || !env.MEMBERSHIP_EMAIL_FROM?.trim()) return null;
  return async ({ email, code, purpose = 'login' }) => {
    const action = purpose === 'link' ? '绑定邮箱' : '登录';
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
        body: JSON.stringify({ from: env.MEMBERSHIP_EMAIL_FROM, to: [email], subject: `Better Life ${action}验证码`, text: `你的${action}验证码是 ${code}，5 分钟内有效，只能使用一次。如果不是你发起的请求，请忽略这封邮件。` }),
      });
      if (!response.ok) throw new Error('email_unavailable');
      const result = await response.json();
      // 这里只确认提供商接受发送；不将其描述为已送达用户收件箱。
      if (typeof result?.id !== 'string' || !result.id.trim()) throw new Error('email_unavailable');
    } catch { throw new Error('email_unavailable'); }
  };
}

// 显式选择通道；未知名称和缺项关闭，不自动转到另一个收费供应商。
export function createEmailSender({ env = {}, ...options } = {}) {
  const provider = env.MEMBERSHIP_EMAIL_PROVIDER || 'resend';
  if (provider === 'aliyun') return createAliyunEmailSender({ env, ...options });
  return provider === 'resend' ? createResendSender({ env, ...options }) : null;
}
export function createSmsSender({ env = {}, ...options } = {}) {
  const provider = env.MEMBERSHIP_SMS_PROVIDER || 'tencent';
  if (provider === 'aliyun') return createAliyunSmsSender({ env, ...options });
  return provider === 'tencent' ? createTencentSmsSender({ env, ...options }) : null;
}

// paymentProvider 仅接受服务端受信适配器注入；环境变量或前端回跳不能造出 paid。
// 必须提供 merchantId/createCheckout/verifyPayment。verifyPayment 内完成平台验签/查单。
export function createMembershipHandler({ env = {}, store = createMembershipStore(), sender = createEmailSender({ env }), phoneSender = createSmsSender({ env }), paymentProvider = null, qaHandler, personalQaHandler, getCorpus, getClientId = () => 'shared', now = Date.now, operationsStore = null, onPaymentConfirmed } = {}) {
  const lifecycle = createAccountLifecycle({ store, now });
  const supportUrl = (() => { try { const value = new URL(env.MEMBERSHIP_SUPPORT_URL); return value.protocol === 'https:' && !value.username && !value.password ? value.href : null; } catch { return null; } })();
  const secret = typeof env.MEMBERSHIP_AUTH_SECRET === 'string' ? env.MEMBERSHIP_AUTH_SECRET : '';
  const secretReady = secret.length >= 32;
  const emailLoginAvailable = secretReady && typeof sender === 'function';
  const phoneLoginAvailable = secretReady && typeof phoneSender === 'function';
  const authReady = emailLoginAvailable || phoneLoginAvailable;
  const smsDailyLimit = /^\d+$/.test(String(env.MEMBERSHIP_SMS_DAILY_LIMIT ?? '')) ? Math.max(1, Math.min(10000, Number(env.MEMBERSHIP_SMS_DAILY_LIMIT))) : 100;
  const enforced = env.MEMBERSHIP_ENFORCE === 'true';
  const localDemoConfigured = env.MEMBERSHIP_LOCAL_DEMO === 'true';
  const annualAvailable = env.MEMBERSHIP_ANNUAL_ENABLED === 'true';
  const providerReady = Boolean(paymentProvider?.merchantId && typeof paymentProvider.createCheckout === 'function' && typeof paymentProvider.verifyPayment === 'function');
  const checkoutAvailable = authReady && providerReady && paymentProvider.creationEnabled !== false && !localDemoConfigured;
  const key = Buffer.from(hash(secret), 'hex');
  const encrypt = value => {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return `${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  };
  const decrypt = value => {
    const [nonce, tag, data] = value.split('.'); const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
    cipher.setAuthTag(Buffer.from(tag, 'base64url')); return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, 'base64url')), cipher.final()]).toString('utf8'));
  };
  const codeDigest = (identity, code, salt) => createHmac('sha256', secret).update(`${identity.channel}\0${identity.purpose}\0${identity.targetUserId ?? ''}\0${identity.identifier}\0${salt}\0${code}`).digest('hex');
  const requireIdentityChannel = identity => {
    if (!(identity.channel === 'email' ? emailLoginAvailable : phoneLoginAvailable)) error(503, 'login_not_configured', identity.channel === 'email' ? '邮箱登录尚未开通，请稍后再试。' : '手机号登录尚未开通，请稍后再试。');
  };
  function origin(request) {
    const actual = new URL(request.url);
    let expected;
    try { expected = new URL(env.MEMBERSHIP_APP_ORIGIN || actual.origin); } catch { error(503, 'invalid_configuration', '会员服务配置尚未完成。'); }
    if (env.NODE_ENV === 'production' && (expected.protocol !== 'https:' || !env.MEMBERSHIP_APP_ORIGIN)) error(503, 'https_required', '会员服务需要配置同站点 HTTPS 主站。');
    if (expected.origin !== expected.href.replace(/\/$/, '')) error(503, 'invalid_configuration', '会员主站配置只允许 origin。');
    if (expected.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)) error(503, 'https_required', '会员服务需要 HTTPS，仅本机预览允许 HTTP。');
    if (request.headers.get('origin') && request.headers.get('origin') !== expected.origin) error(403, 'origin_not_allowed', '会员操作只能在当前主站完成。');
    if (request.method !== 'GET' && request.headers.get('origin') !== expected.origin) error(403, 'csrf_rejected', '请在会员主站页面完成此操作。');
    if (request.headers.get('sec-fetch-site') === 'cross-site') error(403, 'csrf_rejected', '请在会员主站页面完成此操作。');
    return expected;
  }
  const cookie = (value, secure, clear = false) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 30 * 86400}${secure ? '; Secure' : ''}`;
  const localDemoAllowed = request => {
    if (!localDemoConfigured || env.NODE_ENV === 'production' || !secretReady || !loopbackClient(getClientId(request)) || request.headers.get('x-better-life-proxy-present') === 'true') return false;
    const url = new URL(request.url);
    let expected; try { expected = new URL(env.MEMBERSHIP_APP_ORIGIN || url.origin); } catch { return false; }
    return loopbackOrigin(url) && loopbackOrigin(expected) && url.origin === expected.origin;
  };
  const sessionUser = request => {
    if (!secretReady) return null;
    const user = store.sessionUser(sessionHash(request));
    if (user?.auth_kind === 'local-demo' && !localDemoAllowed(request)) return null;
    return user;
  };
  const requireUser = request => {
    if (!secretReady) error(503, 'membership_not_configured', '私人指南服务配置尚未完成，请稍后再试。');
    const user = sessionUser(request);
    if (!user) error(401, 'login_required', '登录后可查看会员、提问次数和已保存的回答。');
    return user;
  };
  const revalidateUser = (request, previous) => {
    const current = requireUser(request);
    if (current.id !== previous.id) error(401, 'login_required', '登录状态已改变，请重新登录。');
    return current;
  };
  const requireFreshIdentity = (request, user) => {
    revalidateUser(request, user);
    if (!lifecycle.freshnessStatus(user, { tokenHash: sessionHash(request) }).freshAuthentication) error(403, 'reauthentication_required', '请先用已绑定的手机号或邮箱重新登录，再绑定新的登录方式。');
  };
  const guideView = row => ({ ...decrypt(row.content_cipher), id: row.id, revision: row.revision, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at ?? row.created_at).toISOString() });
  const profileView = user => { const row = store.profile(user); return { facts: row ? decrypt(row.facts_cipher) : [], revision: row?.revision ?? 0 }; };
  async function validateGuide(value, user, prior = null) {
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120 || typeof value.topic !== 'string' || value.topic.length > 80 || typeof value.content !== 'string' || value.content.length > 12000) error(400, 'invalid_guide', '请填写标题；正文最多 12000 字。');
    if (!Array.isArray(value.sourceIds) || value.sourceIds.length > 128 || value.sourceIds.some(id => typeof id !== 'string')) error(400, 'invalid_sources', '私人指南最多关联 128 条书中依据。');
    const corpus = await getCorpus(); const sourceIds = [...new Set(value.sourceIds)];
    const available = new Set(corpus.chapters.flatMap(chapter => chapter.entries.map(entry => entry.id)));
    if (sourceIds.some(id => !available.has(id))) error(400, 'invalid_sources', '无法核对部分书中依据，请重新选择。');
    const factIds = value.factIds ?? [];
    if (!Array.isArray(factIds) || factIds.length > 20 || factIds.some(id => typeof id !== 'string')) error(400, 'invalid_facts', '关联个人情况格式不正确。');
    const confirmed = new Set(profileView(user).facts.map(fact => fact.id));
    if (factIds.some(id => !confirmed.has(id))) error(400, 'unconfirmed_facts', '只能关联你已经确认保存的个人情况。');
    const tasks = value.tasks ?? [];
    if (!Array.isArray(tasks) || tasks.length > 50 || tasks.some(task => !task || typeof task.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.id) || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 300 || typeof task.done !== 'boolean') || new Set(tasks.map(task => task.id)).size !== tasks.length) error(400, 'invalid_tasks', '任务格式不正确，最多 50 项；完成状态需要明确选择。');
    const snapshotDate = corpus.source?.snapshotDate ?? '';
    if (!prior && value.snapshotDate && value.snapshotDate !== snapshotDate) error(400, 'snapshot_mismatch', '这份指南的书本版本无法核对，请刷新后重新保存。');
    // 每条出处保留其首次关联时的资料版本；后来的编辑不能冒充历史引用已实时更新。
    const sourceSnapshots = Object.fromEntries(sourceIds.map(sourceId => [sourceId, prior?.sourceSnapshots?.[sourceId] ?? {
      snapshotDate, revision: corpus.source?.revision ?? '', repository: corpus.source?.repository ?? '',
      chapterFile: corpus.chapters.find(chapter => chapter.entries.some(entry => entry.id === sourceId))?.file ?? '',
      title: corpus.chapters.flatMap(chapter => chapter.entries).find(entry => entry.id === sourceId)?.title ?? '',
    }]));
    return { title: value.title.trim(), topic: value.topic.trim(), content: value.content, sourceIds, sourceSnapshots, snapshotDate: prior?.snapshotDate ?? snapshotDate, factIds: [...new Set(factIds)], tasks: tasks.map(task => ({ id: task.id, title: task.title.trim(), done: task.done })) };
  }
  function validateRevision(revision) { if (!Number.isInteger(revision) || revision < 0) error(400, 'invalid_revision', '请刷新后使用当前版本编号保存。'); }
  async function paymentCall(method, value) {
    const controller = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MembershipError(503, 'payment_timeout', '支付平台暂未响应，请稍后查看订单。')); }, 10000); });
    try { return await Promise.race([paymentProvider[method]({ ...value, signal: controller.signal }), timeout]); }
    finally { clearTimeout(timer); }
  }
  async function ownedPayment(user, id) {
    const order = store.ownedOrder(user, id);
    if (['paid', 'refunded'].includes(order.status) || !providerReady) return store.orderView(order);
    store.throttle(`payment-check:${user.id}`, 20, 60000);
    const result = await paymentCall('verifyPayment', { id: order.id, amountFen: order.amount_fen, currency: order.currency });
    if (result?.status === 'paid') {
      if (result.merchantId !== paymentProvider.merchantId) error(502, 'payment_mismatch', '支付商户核对失败，暂不开通会员。');
      return store.orderView(store.confirmPaid(order, result));
    }
    store.expireOrder(order.id);
    return store.orderView(store.ownedOrder(user, id));
  }
  async function ask(request, guideId = null) {
    origin(request);
    if (!secretReady) error(503, 'membership_not_configured', '登录服务尚未配置，暂时可以阅读指南。');
    const user = requireUser(request), body = await readJson(request);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question || [...question].length > 500) error(400, 'invalid_question', '请填写 1–500 字的问题。');
    if (!validId(body.requestId)) error(400, 'invalid_request_id', '请使用有效的请求编号提交问题。');
    let history;
    try {
      history = validateQaHistory(body.history);
      if (history.length) {
        if (typeof getCorpus !== 'function') error(503, 'history_unavailable', '暂时无法核对对话依据，请开始新对话后重试。');
        validateQaHistory(history, await getCorpus());
      }
    }
    catch (value) { if (value instanceof QaHistoryError) error(400, 'invalid_history', value.message); throw value; }
    let context;
    if (guideId) {
      const guide = guideView(store.ownedGuide(user, guideId));
      const factIds = body.factIds ?? [];
      if (!Array.isArray(factIds) || factIds.length > 8 || factIds.some(id => typeof id !== 'string') || new Set(factIds).size !== factIds.length) error(400, 'invalid_facts', '最多选择 8 项已确认个人情况。');
      const profileFacts = profileView(user).facts.filter(fact => factIds.includes(fact.id));
      if (profileFacts.length !== factIds.length) error(400, 'unconfirmed_facts', '选中的个人情况尚未确认，请刷新后重新选择。');
      context = { guide, profileFacts };
    }
    revalidateUser(request, user);
    const reservation = store.reserve(user, body.requestId, hash(JSON.stringify({ question, ...(history.length ? { history } : {}), guideId, guideRevision: context?.guide.revision, profileFacts: context?.profileFacts })));
    if (reservation.cached) return json({ ...decrypt(reservation.cached), question, quota: store.me(user).quota, reused: true });
    try {
      const selectedHandler = guideId ? personalQaHandler : qaHandler;
      if (typeof selectedHandler !== 'function') error(503, 'qa_unavailable', '问答服务暂不可用。');
      const headers = new Headers(request.headers); headers.delete('content-length');
      const forwarded = new Request(request.url, { method: 'POST', headers, body: JSON.stringify({ question, history }), signal: request.signal });
      const response = await selectedHandler(forwarded, context);
      let result;
      try { result = await response.json(); } catch { error(502, 'invalid_answer', '回答校验未通过，请重试。'); }
      if (response.ok && result.status === 'answered' && !request.signal.aborted) {
        const { question: _question, ...cache } = result;
        if (!store.finish(user.id, body.requestId, true, encrypt(cache))) error(503, 'reservation_expired', '本次请求已过期，请重新提交。');
        return json({ ...result, quota: store.me(user).quota });
      }
      store.finish(user.id, body.requestId, false);
      return json({ ...result, quota: store.me(user).quota }, request.signal.aborted ? 499 : response.status);
    } catch (value) { store.finish(user.id, body.requestId, false); throw value; }
  }
  return async function membershipHandler(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/payments/hupijiao/notify') {
      // 非浏览器付款事实入口，不使用 Cookie 或前端回跳。先验签，再原子入账。
      const plain = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      if (request.method !== 'POST') return plain('method_not_allowed', 405);
      if (!secretReady || localDemoConfigured || typeof paymentProvider?.verifyNotification !== 'function') return plain('payment_not_configured', 503);
      try {
        const event = await paymentProvider.verifyNotification(request);
        if (event.merchantId !== paymentProvider.merchantId) return plain('payment_mismatch', 403);
        const paidOrder = store.acceptPaymentEvent(event);
        // 统计不能替代验签/入账，也不能让已提交付款被统计故障否决。
        if (event.type === 'paid' && typeof onPaymentConfirmed === 'function') { try { onPaymentConfirmed(paidOrder); } catch {} }
        // 只有已提交的事实/幂等重复才 acknowledge；失败让平台重试。
        return plain('success');
      } catch (value) {
        if (value instanceof PaymentNotificationError || value instanceof MembershipError) return plain(value.code, value.status);
        return plain('payment_not_committed', 503);
      }
    }
    if (['/api/ask', '/api/qa/status'].includes(path)) {
      if (!enforced || path === '/api/qa/status') return typeof qaHandler === 'function' ? qaHandler(request) : failure(503, 'qa_unavailable', '问答服务暂不可用。');
      if (request.method !== 'POST') return failure(405, 'method_not_allowed', '请使用 POST 提交问题。');
    }
    try {
      store.cleanup();
      if (path === '/api/ask') return await ask(request);
      const expected = origin(request);
      if (['POST', 'PATCH', 'DELETE'].includes(request.method) && /^\/api\/(guides|profile|saved-answers|orders|refund-requests|account)(?:\/|$)/.test(path)) {
        const user = requireUser(request);
        store.throttle(`private-write:${user.id}`, 30, 60000);
        store.throttle('private-write:global', 500, 60000);
      }
      if (path === '/api/membership' && request.method === 'GET') return json({ enforced, loginAvailable: authReady, emailLoginAvailable, phoneLoginAvailable, localDemoAvailable: localDemoAllowed(request), checkoutAvailable, annualAvailable, supportUrl, refundRequestsAvailable: Boolean(operationsStore),
        plans: MEMBERSHIP_PLANS.map(plan => ({ ...plan, purchasable: plan.id !== 'free' && checkoutAvailable && (plan.id !== 'member-year' || annualAvailable) })) });
      if (path === '/api/me' && request.method === 'GET') return json(store.me(sessionUser(request)));
      if (path === '/api/auth/local-demo' && request.method === 'POST') {
        if (!localDemoAllowed(request)) error(403, 'local_demo_forbidden', '本机体验只允许显式开启的本机预览，不能在公网或生产环境使用。');
        const session = randomBytes(32).toString('base64url');
        const user = store.localDemoUser(hash(session));
        store.revokeSession(sessionHash(request));
        return json(store.me(user), 200, { 'set-cookie': cookie(session, false) });
      }
      if (['/api/auth/code', '/api/auth/link/code'].includes(path) && request.method === 'POST') {
        const linking = path === '/api/auth/link/code';
        const user = linking ? requireUser(request) : null;
        if (user?.auth_kind === 'local-demo') error(403, 'identity_link_forbidden', '本机体验账号不能绑定正式登录信息，请先退出体验账号。');
        if (!authReady) error(503, 'login_not_configured', '登录服务尚未开通，请稍后再试。');
        const body = await readJson(request, 4096), identity = normalizeIdentity(body, linking ? 'link' : 'login', user?.id ?? null);
        if (linking) requireFreshIdentity(request, user);
        requireIdentityChannel(identity);
        const code = String(randomInt(1000000)).padStart(6, '0'), salt = randomBytes(16).toString('hex'), digest = codeDigest(identity, code, salt);
        store.issueCode(identity, digest, salt, getClientId(request), { smsDailyLimit });
        try { await (identity.channel === 'email' ? sender({ email: identity.identifier, code, purpose: identity.purpose }) : phoneSender({ phone: identity.identifier, code, purpose: identity.purpose })); }
        catch { store.cancelCode(identity, digest); error(503, identity.channel === 'email' ? 'email_unavailable' : 'sms_unavailable', '验证码暂时无法发送，请稍后重试。'); }
        return json({ sent: true, expiresIn: 300, retryAfter: 60 });
      }
      if (['/api/auth/verify', '/api/auth/link/verify'].includes(path) && request.method === 'POST') {
        const linking = path === '/api/auth/link/verify', current = linking ? requireUser(request) : null;
        if (current?.auth_kind === 'local-demo') error(403, 'identity_link_forbidden', '本机体验账号不能绑定正式登录信息，请先退出体验账号。');
        if (!authReady) error(503, 'login_not_configured', '登录服务尚未开通，请稍后再试。');
        const body = await readJson(request, 4096), identity = normalizeIdentity(body, linking ? 'link' : 'login', current?.id ?? null);
        if (linking) requireFreshIdentity(request, current);
        requireIdentityChannel(identity);
        if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) error(400, 'invalid_code', '请输入收到的 6 位验证码。');
        const session = randomBytes(32).toString('base64url');
        const user = store.verifyCode(identity, row => timingSafeEqual(Buffer.from(row.digest, 'hex'), Buffer.from(codeDigest(identity, body.code, row.salt), 'hex')), getClientId(request), hash(session));
        // 验证成功旋转当前浏览器旧会话，防会话固定。
        store.revokeSession(sessionHash(request));
        // 只有原有身份正常登录才可授权注销；新绑定通道不算本人重新认证。
        if (!linking) lifecycle.markAuthenticated(hash(session));
        return json(store.me(user), 200, { 'set-cookie': cookie(session, expected.protocol === 'https:') });
      }
      if (path === '/api/auth/logout' && request.method === 'POST') { store.revokeSession(sessionHash(request)); return json({ ok: true }, 200, { 'set-cookie': cookie('', expected.protocol === 'https:', true) }); }
      if (path === '/api/account/status' && request.method === 'GET') return json(lifecycle.accountStatus(requireUser(request), { tokenHash: sessionHash(request) }));
      if (path === '/api/account' && request.method === 'DELETE') {
        const user = requireUser(request), body = await readJson(request, 1024);
        if (Object.keys(body).some(key => key !== 'confirmation')) error(400, 'invalid_request', '请只提交注销确认。');
        const result = lifecycle.deleteAccount(user, { tokenHash: sessionHash(request), confirmation: body.confirmation });
        return json(result, 200, { 'set-cookie': cookie('', expected.protocol === 'https:', true) });
      }
      if (path === '/api/refund-requests' && ['GET', 'POST'].includes(request.method)) {
        const user = requireUser(request);
        if (!operationsStore) error(503, 'refund_requests_unavailable', '退款申请暂未开放，请联系本站客服。');
        if (request.method === 'GET') return json(operationsStore.listUserRefundRequests(user));
        const body = await readJson(request, 1024);
        revalidateUser(request, user);
        if (Object.keys(body).some(key => !['orderId', 'reason'].includes(key))) error(400, 'invalid_request', '请只提交订单和退款原因。');
        const result = operationsStore.submitRefundRequest(user, body);
        return json(result, result.created ? 201 : 200);
      }
      if (path === '/api/orders' && request.method === 'POST') {
        const user = requireUser(request);
        if (!checkoutAvailable) error(503, 'checkout_not_configured', '付款尚未开放，当前不会创建收费订单或扣款。');
        const body = await readJson(request, 4096), plan = membershipPlan(body.planId);
        revalidateUser(request, user);
        if (!plan || plan.id === 'free' || (plan.id === 'member-year' && !annualAvailable)) error(400, 'plan_unavailable', '这个套餐暂未开放购买。');
        if (!validId(body.requestId)) error(400, 'invalid_request_id', '订单请求编号无效，请重新提交。');
        const result = store.createOrder(user, plan, body.requestId, paymentProvider.merchantId);
        if (result.created) {
          try {
            const checkout = await paymentCall('createCheckout', { id: result.order.id, amountFen: result.order.amount_fen, currency: result.order.currency, description: result.order.plan_name, expiresAt: new Date(result.order.expires_at).toISOString() });
            const url = new URL(checkout?.checkoutUrl);
            if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid_checkout');
            store.pendingOrder(result.order.id, url.href);
          } catch { store.failOrder(result.order.id); error(503, 'checkout_unavailable', '暂时无法创建支付订单，请稍后再试。'); }
        }
        return json({ order: store.orderView(store.ownedOrder(user, result.order.id)) }, result.created ? 201 : 200);
      }
      if (path.startsWith('/api/orders/') && request.method === 'GET') {
        const user = requireUser(request), id = path.slice('/api/orders/'.length);
        return json({ order: await ownedPayment(user, id), ...store.me(user) });
      }
      if (path === '/api/saved-answers' && request.method === 'GET') {
        const user = requireUser(request);
        return json({ answers: store.savedAnswers(user).map(row => ({ id: row.id, createdAt: new Date(row.created_at).toISOString(), result: decrypt(row.result_cipher) })) });
      }
      if (path === '/api/saved-answers' && request.method === 'POST') {
        const user = requireUser(request), { result } = await readJson(request, 65536);
        if (typeof getCorpus !== 'function') error(503, 'save_unavailable', '云端保存暂不可用。');
        if (!result || result.status !== 'answered' || typeof result.question !== 'string' || !result.question.trim() || [...result.question].length > 500 || !Array.isArray(result.sources) || !result.sources.length || result.sources.length > 6) error(400, 'invalid_saved_answer', '只能保存有书中依据的完整回答。');
        const corpus = await getCorpus();
        if (result.snapshotDate !== corpus.source?.snapshotDate) error(400, 'snapshot_mismatch', '这个回答的书本版本无法核对，请重新提问。');
        const allEntries = corpus.chapters.flatMap(chapter => chapter.entries.map(entry => ({ ...entry, chapterTitle: chapter.title, chapterFile: chapter.file })));
        const sourceIds = result.sources.map(source => source?.id);
        const entries = allEntries.filter(entry => sourceIds.includes(entry.id));
        if (new Set(sourceIds).size !== sourceIds.length || entries.length !== sourceIds.length) error(400, 'invalid_sources', '回答引用无法核对，暂不保存。');
        let checked; try { checked = validateAnswer({ ...result.answer, insufficient: false }, entries); } catch { error(400, 'invalid_saved_answer', '回答内容或引用无法核对，暂不保存。'); }
        const saved = { status: 'answered', question: result.question.trim(), answer: checked.answer, sources: checked.sources, snapshotDate: corpus.source.snapshotDate, model: '用户保存', provenance: 'user-provided' };
        revalidateUser(request, user);
        return json({ answer: { ...store.saveAnswer(user, encrypt(saved)), result: saved } }, 201);
      }
      if (path.startsWith('/api/saved-answers/') && request.method === 'DELETE') {
        const user = requireUser(request);
        if (!store.deleteAnswer(user, path.slice('/api/saved-answers/'.length))) error(404, 'answer_not_found', '未找到这份保存记录。');
        return json({ ok: true });
      }
      if (path === '/api/profile' && request.method === 'GET') return json(profileView(requireUser(request)));
      if (path === '/api/profile' && request.method === 'PATCH') {
        const user = requireUser(request), body = await readJson(request, 65536);
        revalidateUser(request, user);
        validateRevision(body.revision);
        if (!Array.isArray(body.facts) || body.facts.length > 30 || body.facts.some(fact => !fact || (fact.id != null && (typeof fact.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(fact.id))) || typeof fact.label !== 'string' || !fact.label.trim() || fact.label.length > 80 || typeof fact.value !== 'string' || !fact.value.trim() || fact.value.length > 500)) error(400, 'invalid_facts', '个人情况最多 30 项，每项内容最多 500 字。');
        const existing = new Map(profileView(user).facts.map(fact => [fact.id, fact]));
        const facts = body.facts.map(fact => {
          const id = fact.id ?? randomUUID(), prior = existing.get(id), label = fact.label.trim(), value = fact.value.trim();
          return { id, label, value, confirmedAt: prior?.label === label && prior?.value === value ? prior.confirmedAt : new Date(now()).toISOString() };
        });
        if (new Set(facts.map(fact => fact.id)).size !== facts.length) error(400, 'invalid_facts', '个人情况编号不能重复。');
        store.updateProfile(user, body.revision, encrypt(facts));
        return json(profileView(user));
      }
      if (path === '/api/guides' && request.method === 'GET') {
        const user = requireUser(request), guides = store.guides(user).map(guideView), limit = store.guideLimit(user);
        return json({ guides, limit, remaining: Math.max(0, limit - guides.length) });
      }
      if (path === '/api/guides' && request.method === 'POST') {
        const user = requireUser(request), body = await readJson(request, 131072);
        if (typeof getCorpus !== 'function') error(503, 'guides_unavailable', '私人指南服务尚未配置。');
        const guide = await validateGuide(body, user);
        revalidateUser(request, user);
        return json({ guide: guideView(store.createGuide(user, encrypt(guide))) }, 201);
      }
      const guideMatch = /^\/api\/guides\/([a-zA-Z0-9_-]+)(?:\/(versions)(?:\/([a-zA-Z0-9_-]+))?|\/(restore|export|ask))?$/.exec(path);
      if (guideMatch) {
        const user = requireUser(request), id = guideMatch[1], action = guideMatch[2] || guideMatch[4], versionId = guideMatch[3];
        const stored = store.ownedGuide(user, id), current = guideView(stored);
        if (!action && request.method === 'GET') return json({ guide: current });
        if (!action && request.method === 'DELETE') { store.deleteGuide(user, id); return json({ ok: true }); }
        if (!action && request.method === 'PATCH') {
          const body = await readJson(request, 131072); validateRevision(body.revision);
          if (body.revision !== current.revision) error(409, 'revision_conflict', '这份指南已有新修改，请刷新后合并你的内容。');
          const fields = ['title', 'topic', 'content', 'sourceIds', 'factIds', 'tasks'];
          const changes = Object.fromEntries(fields.filter(field => Object.hasOwn(body, field)).map(field => [field, body[field]]));
          // 删除个人情况后，不让旧的失效关联阻塞正文编辑；显式新增仍严格校验。
          if (!Object.hasOwn(changes, 'factIds')) {
            const confirmed = new Set(profileView(user).facts.map(fact => fact.id));
            changes.factIds = current.factIds.filter(factId => confirmed.has(factId));
          }
          const next = await validateGuide({ ...current, ...changes }, user, current);
          revalidateUser(request, user);
          return json({ guide: guideView(store.updateGuide(user, id, body.revision, encrypt(next))) });
        }
        if (action === 'versions' && request.method === 'GET') {
          if (versionId) return json({ version: guideView(store.ownedVersion(user, id, versionId)) });
          return json({ versions: store.guideVersions(user, id).map(row => { const value = guideView(row); return { id: row.id, revision: row.revision, title: value.title, topic: value.topic, createdAt: value.createdAt }; }) });
        }
        if (action === 'restore' && request.method === 'POST') {
          const body = await readJson(request, 4096); validateRevision(body.revision);
          revalidateUser(request, user);
          if (typeof body.versionId !== 'string') error(400, 'invalid_version', '请选择需要恢复的版本。');
          const version = store.ownedVersion(user, id, body.versionId);
          // 旧版本可能包含已经删除的个人情况编号：恢复时去掉失效关联，不恢复个人事实。
          const content = decrypt(version.content_cipher), facts = new Set(profileView(user).facts.map(fact => fact.id));
          const restored = { ...content, factIds: content.factIds.filter(factId => facts.has(factId)) };
          return json({ guide: guideView(store.updateGuide(user, id, body.revision, encrypt(restored))) });
        }
        if (action === 'export' && request.method === 'GET') {
          const facts = profileView(user).facts.filter(fact => current.factIds.includes(fact.id));
          const references = current.sourceIds.map(sourceId => {
            const source = current.sourceSnapshots?.[sourceId], label = `条目 ${sourceId}${source?.title ? `：${source.title}` : ''}`;
            const validRepository = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(source?.repository ?? '');
            const link = validRepository && source?.revision && source?.chapterFile ? `${source.repository.replace(/\/$/, '')}/blob/${encodeURIComponent(source.revision)}/book/${encodeURIComponent(source.chapterFile)}` : '';
            return `- ${link ? `[${label.replace(/[\[\]]/g, '')}](${link})` : label}${source?.snapshotDate ? `（书本快照：${source.snapshotDate}）` : ''}`;
          });
          const markdown = [`# ${current.title}`, '', `主题：${current.topic || '未分类'}`, `版本：${current.revision} · 更新：${current.updatedAt}`, `首次资料快照：${current.snapshotDate || '未记录'}`, '', current.content,
            '', '## 我的行动清单', ...current.tasks.map(task => `- [${task.done ? 'x' : ' '}] ${task.title}`), '', '## 已确认的个人情况', ...facts.map(fact => `- ${fact.label}：${fact.value}（确认于 ${fact.confirmedAt}）`), '', '## 原书依据', ...references, '', '这是你主动保存、编辑的私人指南；AI 更新稿不会自动覆盖。原书：HowToLiveBetter，CC BY 4.0。', ''].join('\n');
          return new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="better-life-guide-${id}.md"` } });
        }
        if (action === 'ask' && request.method === 'POST') return await ask(request, id);
        return failure(405, 'method_not_allowed', '这个私人指南接口不支持此操作。');
      }
      const known = /^\/api\/(membership|me|profile|guides|auth\/(code|verify|logout|local-demo|link\/(code|verify))|orders(?:\/[^/]+)?|saved-answers(?:\/[^/]+)?)$/.test(path);
      return failure(known ? 405 : 404, known ? 'method_not_allowed' : 'not_found', known ? '这个接口不支持此操作。' : '会员接口不存在。');
    } catch (value) {
      if (value instanceof MembershipError || value instanceof OperationsError || value instanceof AccountLifecycleError) return failure(value.status, value.code, value.message);
      if (request.signal.aborted) return failure(499, 'cancelled', '操作已取消。');
      return failure(503, 'membership_unavailable', '会员服务暂不可用，请稍后重试。');
    }
  };
}
