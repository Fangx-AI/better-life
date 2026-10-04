// The membership session is held by the server, never by browser storage.
const configuredBase = import.meta.env?.VITE_MEMBERSHIP_API_URL;
const siteBase = import.meta.env?.BASE_URL || '/';

export function membershipApiUrl(path, origin = globalThis.location?.origin) {
  if (!origin) throw new Error('请在网站中使用会员服务。');
  const base = new URL(configuredBase || `${siteBase}api/`, `${origin}/`);
  if (base.origin !== origin) throw new Error('登录与付款需要在本站的安全服务中完成，当前入口尚未开放。');
  base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
  return new URL(path.replace(/^\//, ''), base).href;
}

export async function membershipRequest(path, { method = 'GET', body, signal } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), 15000);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(membershipApiUrl(path), {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data?.error?.message || (response.status === 401 ? '请先登录，再继续操作。' : '会员服务暂时不可用，请稍后重试。');
      const error = new Error(message); error.status = response.status; error.code = data?.error?.code;
      const retryAfter = Number(response.headers.get('retry-after') || data?.error?.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter;
      throw error;
    }
    if (!data || typeof data !== 'object') throw new Error('当前只有价格预览，登录与付款服务尚未开放。');
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      throw new Error('连接等待太久，请稍后重试。');
    }
    if (error instanceof TypeError) throw new Error('连接失败，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
  }
}

export function validateMembershipStatus(data) {
  if (!Array.isArray(data?.plans) || typeof data.loginAvailable !== 'boolean' || typeof data.checkoutAvailable !== 'boolean') throw new Error('当前只有价格预览，登录与付款服务尚未开放。');
  for (const key of ['emailLoginAvailable', 'phoneLoginAvailable']) if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new Error('登录服务暂时无法读取，请稍后重试。');
  const plans = data.plans.filter(plan => ['free', 'member-month', 'member-year'].includes(plan.id) && Number.isInteger(plan.amountFen) && plan.amountFen >= 0 && Number.isInteger(plan.quotaPerPeriod) && plan.quotaPerPeriod >= 0 && typeof plan.name === 'string');
  if (plans.length !== 3) throw new Error('套餐信息暂时无法读取，请稍后重试。');
  const emailLoginAvailable = data.emailLoginAvailable ?? data.loginAvailable;
  const phoneLoginAvailable = data.phoneLoginAvailable === true;
  let supportUrl = null;
  try { const url = new URL(data.supportUrl); if (url.protocol === 'https:' && !url.username && !url.password) supportUrl = url.href; } catch {}
  return { ...data, plans, emailLoginAvailable, phoneLoginAvailable, loginAvailable: emailLoginAvailable || phoneLoginAvailable, localDemoAvailable: data.localDemoAvailable === true, supportUrl, refundRequestsAvailable: data.refundRequestsAvailable === true, available: true, preview: false };
}

export function validateMember(data) {
  const validUser = data?.user === null || (typeof data?.user?.id === 'string' && data.user.id.length > 0 && (typeof data.user.email === 'string' && data.user.email.length > 0 || typeof data.user.phone === 'string' && /^\+861[3-9]\d{9}$/.test(data.user.phone) || (data.user.authentication === 'local-demo' && data.user.email === null && typeof data.user.label === 'string')));
  if (!data || !Array.isArray(data.orders) || !data.membership || !data.quota || !validUser) throw new Error('账号信息暂时无法读取，请稍后重试。');
  for (const key of ['limit', 'used', 'remaining']) if (!Number.isFinite(data.quota[key]) || data.quota[key] < 0) throw new Error('提问次数暂时无法读取，请稍后重试。');
  return data;
}

export function authIdentity(channel, value) {
  if (channel === 'email') {
    const email = String(value || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入正确的邮箱地址。');
    return { email };
  }
  if (channel === 'phone') {
    const phone = String(value || '').replace(/[\s-]/g, '').replace(/^\+86/, '');
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('请输入中国大陆 11 位手机号。');
    return { phone: `+86${phone}` };
  }
  throw new Error('请选择手机号或邮箱登录。');
}

export function authRetrySeconds(value) {
  return Number.isFinite(value) && value > 0 ? Math.max(60, Math.min(3600, Math.ceil(value))) : 60;
}

export function maskPhone(value) {
  const phone = String(value || '').replace(/^\+86/, '');
  return /^1[3-9]\d{9}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '已绑定手机号';
}

export function memberIdentityLabel(user) {
  if (user?.authentication === 'local-demo') return user.label || '本机体验账号';
  return user?.phone ? maskPhone(user.phone) : user?.email || '我的账号';
}

export function formatMoney(amountFen = 0) {
  return Number(amountFen / 100).toLocaleString('zh-CN', { minimumFractionDigits: amountFen % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

export function formatMemberDate(value, fallback = '—') {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date) : fallback;
}

export function safeCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
