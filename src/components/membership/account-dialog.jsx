import { useEffect, useState, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { IconX, IconMail, IconPhone, IconArrowRight, IconCheck, IconRefresh, IconLogout, IconBook2, IconExternalLink } from '@tabler/icons-react';
import { NavbarButton } from '../ui/resizable-navbar';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useMembership } from './membership-context';
import { membershipRequest, formatMoney, formatMemberDate, safeCheckoutUrl, authIdentity, authRetrySeconds, maskPhone, memberIdentityLabel } from '../../lib/membership-api.mjs';

import '../../auth-polish.css';
import { paymentReturnMessage } from '../../lib/payment-return.mjs';

const base = import.meta.env.BASE_URL;
const orderLabels = { created: '待支付', pending: '待支付', paid: '已支付', cancelled: '已取消', expired: '已过期', refunded: '已退款', refund_pending: '退款处理中', partially_refunded: '部分退款' };

function VerificationForm({ channels, initialChannel, binding = false, onSuccess, children }) {
  const { status } = useMembership();
  const [channel, setChannel] = useState(initialChannel || channels[0]), [value, setValue] = useState(''), [sent, setSent] = useState(null), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retryAt, setRetryAt] = useState(0), [now, setNow] = useState(Date.now());
  const controller = useRef(null), locked = useRef(false), generation = useRef(0), cooldowns = useRef(new Map()), id = useId();
  useEffect(() => () => { ++generation.current; controller.current?.abort(); locked.current = false; }, []);
  useEffect(() => { if (!retryAt || retryAt <= Date.now()) return; const timer = setInterval(() => { const time = Date.now(); setNow(time); if (time >= retryAt) clearInterval(timer); }, 1000); return () => clearInterval(timer); }, [retryAt]);
  const retryIn = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const available = channel === 'phone' ? status.phoneLoginAvailable : status.emailLoginAvailable;
  const targetKey = (kind, input) => { try { return JSON.stringify(authIdentity(kind, input)); } catch { return ''; } };
  const reset = (nextChannel, nextValue) => {
    ++generation.current; controller.current?.abort(); locked.current = false;
    setChannel(nextChannel); setValue(nextValue); setSent(null); setCode(''); setBusy(false); setError(''); setNotice('');
    setRetryAt(cooldowns.current.get(targetKey(nextChannel, nextValue)) || 0); setNow(Date.now());
  };
  const start = () => { if (locked.current) return null; locked.current = true; setBusy(true); const abort = new AbortController(); controller.current = abort; const sequence = ++generation.current; return { abort, current: () => sequence === generation.current && !abort.signal.aborted }; };
  const finish = task => { if (task.current()) { locked.current = false; setBusy(false); } };
  const sendCode = async event => {
    event?.preventDefault(); if (!available || locked.current || retryIn) return;
    let identity; try { identity = authIdentity(channel, value); } catch (failure) { setError(failure.message); return; }
    const task = start(); if (!task) return; setError(''); setNotice('');
    try {
      const result = await membershipRequest(binding ? 'auth/link/code' : 'auth/code', { method: 'POST', body: identity, signal: task.abort.signal });
      if (!task.current()) return;
      if (result.sent !== true) throw new Error('验证码未能发送，请稍后重试。');
      const until = Date.now() + authRetrySeconds(result.retryAfter) * 1000;
      cooldowns.current.set(JSON.stringify(identity), until); setSent(identity); setCode(''); setRetryAt(until); setNow(Date.now());
      const expires = Number.isFinite(result.expiresIn) && result.expiresIn > 0 ? Math.ceil(result.expiresIn / 60) : 5;
      setNotice(`验证码已发到 ${channel === 'phone' ? maskPhone(identity.phone) : identity.email}，${expires} 分钟内有效。`);
    } catch (failure) {
      if (task.current()) {
        setError(failure.message);
        if (failure.status === 429) { const until = Date.now() + authRetrySeconds(failure.retryAfter) * 1000; cooldowns.current.set(JSON.stringify(identity), until); setRetryAt(until); setNow(Date.now()); }
      }
    } finally { finish(task); }
  };
  const verify = async event => {
    event.preventDefault(); if (!available || !sent || !/^[0-9]{6}$/.test(code) || locked.current) return;
    const task = start(); if (!task) return; setError('');
    try {
      const result = await membershipRequest(binding ? 'auth/link/verify' : 'auth/verify', { method: 'POST', body: { ...sent, code }, signal: task.abort.signal });
      if (task.current()) onSuccess(result);
    } catch (failure) { if (task.current()) setError(failure.message); }
    finally { finish(task); }
  };
  return <div className="member-verification">
    {channels.length > 1 && <div className="member-login-tabs" role="tablist" aria-label="登录方式">{channels.map(kind => <NavbarButton key={kind} as="button" type="button" variant="secondary" role="tab" aria-selected={channel === kind} aria-controls={`${id}-panel`} id={`${id}-${kind}-tab`} onClick={() => { if (kind !== channel) reset(kind, ''); }}>{kind === 'phone' ? <IconPhone size={17}/> : <IconMail size={17}/>} {kind === 'phone' ? '手机号登录' : '邮箱登录'}</NavbarButton>)}</div>}
    {!available && <p className="member-service-note" role="status">{channel === 'phone' ? '手机验证码' : '邮箱验证码'}暂未开通。{channels.length > 1 && (channel === 'phone' ? status.emailLoginAvailable : status.phoneLoginAvailable) ? '请切换另一种方式登录。' : '你仍可免费阅读和下载指南。'}</p>}
    <form className="member-form member-auth-form" onSubmit={sent ? verify : sendCode} id={`${id}-panel`} role={channels.length > 1 ? 'tabpanel' : undefined} aria-labelledby={channels.length > 1 ? `${id}-${channel}-tab` : undefined}>
      <Label htmlFor={`${id}-identity`}>{channel === 'phone' ? '你的手机号' : '你的邮箱'}</Label>
      <div className={channel === 'phone' ? 'member-phone-field' : 'member-identity-field'}>{channel === 'phone' && <span className="member-phone-prefix" aria-hidden="true">+86</span>}<Input key={channel} id={`${id}-identity`} name={channel} type={channel === 'phone' ? 'tel' : 'email'} inputMode={channel === 'phone' ? 'tel' : 'email'} autoComplete={channel === 'phone' ? 'tel-national' : 'email'} value={value} onChange={event => reset(channel, channel === 'phone' ? event.target.value.replace(/^\s*\+86\s*/, '') : event.target.value)} placeholder={channel === 'phone' ? '中国大陆 11 位手机号' : 'you@example.com'} maxLength={channel === 'phone' ? 20 : 254} required aria-label={channel === 'phone' ? '中国大陆手机号，国家区号 +86' : '你的邮箱'} disabled={busy}/></div>
      {sent && <><Label htmlFor={`${id}-code`}>{channel === 'phone' ? '短信中的 6 位验证码' : '邮箱中的 6 位验证码'}</Label><Input id={`${id}-code`} name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => { setCode(event.target.value.replace(/\D/g, '')); setError(''); }} placeholder="输入 6 位验证码" required disabled={busy}/></>}
      <NavbarButton as="button" type="submit" className="coral-button" disabled={!available || busy || (sent ? code.length !== 6 : retryIn > 0)}>{busy ? sent ? '正在验证……' : '正在发送……' : sent ? binding ? '确认绑定' : '登录并继续' : retryIn > 0 ? `${retryIn} 秒后可发送` : '发送验证码'}<IconArrowRight size={18}/></NavbarButton>
      {sent && <div className="member-code-actions"><NavbarButton as="button" type="button" variant="secondary" onClick={sendCode} disabled={!available || busy || retryIn > 0}>{retryIn > 0 ? `${retryIn} 秒后重新发送` : '重新发送验证码'}</NavbarButton><NavbarButton as="button" type="button" variant="secondary" disabled={busy} onClick={() => reset(channel, '')}>换一个{channel === 'phone' ? '手机号' : '邮箱'}</NavbarButton></div>}
    </form>
    {notice && <p className="member-notice" role="status">{notice}</p>}{error && <p className="member-error" role="alert">{error}</p>}
    {children}
  </div>;
}

function LoginForm() {
  const { status, checkoutPlanId, acceptLogin, setAccountView } = useMembership();
  return <div className="member-login">
    <VerificationForm channels={['phone', 'email']} initialChannel={status.phoneLoginAvailable ? 'phone' : 'email'} onSuccess={acceptLogin}/>
    {checkoutPlanId && <NavbarButton as="button" variant="secondary" type="button" onClick={() => setAccountView('checkout')} className="member-back-link">返回套餐明细</NavbarButton>}
  </div>;
}

function LinkedIdentities() {
  const { me, updateMember } = useMembership();
  const [channel, setChannel] = useState(''), [notice, setNotice] = useState('');
  if (!me?.user || me.user.authentication === 'local-demo') return null;
  const missing = !me.user.phone ? 'phone' : !me.user.email ? 'email' : '';
  return <section className="member-identities"><h3>登录方式</h3><ul>{me.user.phone && <li><IconPhone size={17}/><span>{maskPhone(me.user.phone)}</span><small>已验证</small></li>}{me.user.email && <li><IconMail size={17}/><span>{me.user.email}</span><small>已验证</small></li>}</ul>
    {missing && !channel && <NavbarButton as="button" type="button" variant="secondary" className="member-bind-button" onClick={() => { setNotice(''); setChannel(missing); }}>绑定{missing === 'phone' ? '手机号' : '邮箱'}，下次也能这样登录<IconArrowRight size={16}/></NavbarButton>}
    {channel && <div className="member-binding"><div className="member-binding-heading"><b>绑定{channel === 'phone' ? '手机号' : '邮箱'}</b><NavbarButton as="button" type="button" variant="secondary" aria-label="取消绑定" onClick={() => setChannel('')}><IconX size={18}/></NavbarButton></div><p>绑定后继续使用当前会员和额度，不会另建账号。</p><VerificationForm key={channel} channels={[channel]} binding onSuccess={data => { if (data?.user?.id !== me.user.id) throw new Error('账号状态已改变，请刷新后重试。'); updateMember(data); setChannel(''); setNotice('绑定成功，下次可以使用这两种方式登录。'); }}/></div>}
    {notice && <p className="member-notice" role="status">{notice}</p>}
  </section>;
}

function MemberOverview() {
  const { me, status, openCheckout, refresh, loading, logout } = useMembership();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const leave = async () => { setBusy(true); setError(''); try { await logout(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  // AnimatePresence keeps the closing dialog mounted briefly after logout.
  if (!me?.user) return null;
  return <div className="member-overview"><p className="member-email">{memberIdentityLabel(me.user)}</p>{me.user.authentication === 'local-demo' && <p className="member-service-note">本机体验账号，仅用于这台电脑上的功能体验。不代表手机号或邮箱验证，不会扣费。</p>}<div className="member-current-plan"><span>当前套餐</span><h3>{me.membership.name || '免费使用'}</h3><p>{me.membership.expiresAt ? `有效至 ${formatMemberDate(me.membership.expiresAt)}` : '完整指南一直免费'}</p></div><div className="member-quota"><div><span>本周期还可以问</span><strong>{me.quota.remaining}<small> / {me.quota.limit} 次</small></strong></div><span className="member-quota-used">已用 {me.quota.used} 次</span></div><div className="member-quota-track" aria-hidden="true"><span style={{ width: `${me.quota.limit ? Math.max(0, Math.min(100, me.quota.remaining / me.quota.limit * 100)) : 0}%` }}/></div><p className="member-period">{me.quota.resetsAt ? `次数更新日：${formatMemberDate(me.quota.resetsAt)}` : '提问次数由服务端按当前套餐确认。'} 成功回答才扣次。</p><div className="member-actions"><NavbarButton href={`${base}?view=guides`} className="coral-button"><IconBook2 size={18}/> 我的人生指南</NavbarButton><NavbarButton as="button" type="button" className="outline-button" onClick={() => openCheckout('member-month')}>{me.membership.planId === 'free' ? '了解会员' : '查看续购明细'}</NavbarButton><NavbarButton as="button" type="button" variant="secondary" onClick={refresh} disabled={loading}><IconRefresh size={17}/> 刷新</NavbarButton></div>
    <LinkedIdentities key={me.user.id}/><section className="member-orders"><h3>我的订单</h3>{me.orders.length ? <ul>{me.orders.map(order => <li key={order.id}><div><b>{order.planName}</b><span>{formatMemberDate(order.createdAt)} · ¥{formatMoney(order.amountFen)}</span><small>订单号：{order.id}</small></div><span className={`member-order-status ${order.status === 'paid' ? 'is-paid' : ''}`}>{orderLabels[order.status] || '处理中'}</span></li>)}</ul> : <p className="member-empty">还没有订单。免费使用不需要下单。</p>}</section>{!status.checkoutAvailable && <p className="member-service-note">付款暂未开放，不会自动扣款。</p>}{error && <p className="member-error" role="alert">{error}</p>}<NavbarButton as="button" type="button" variant="secondary" className="member-logout" onClick={leave} disabled={busy}><IconLogout size={17}/>{busy ? '正在退出……' : '退出登录'}</NavbarButton></div>;
}

function CheckoutDetails() {
  const { status, me, checkoutPlanId, setAccountView, refresh } = useMembership();
  const plan = status.plans.find(item => item.id === checkoutPlanId);
  const [order, setOrder] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID()), controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (!plan) return <p className="member-error">这份套餐暂时无法读取，请关闭后重试。</p>;
  const available = status.checkoutAvailable && plan.purchasable;
  const checkoutUrl = safeCheckoutUrl(order?.checkoutUrl);
  const submit = async () => {
    if (busy || !available || !me?.user) return;
    setBusy(true); setError(''); const abort = new AbortController(); controller.current = abort;
    try {
      const data = await membershipRequest('orders', { method: 'POST', body: { planId: plan.id, requestId: requestId.current }, signal: abort.signal });
      if (!data.order?.id) throw new Error('订单暂时无法读取，请稍后重试。');
      setOrder(data.order); if (data.order.status === 'paid') await refresh();
    } catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const checkOrder = async () => {
    if (!order?.id || busy) return; setBusy(true); setError(''); const abort = new AbortController(); controller.current = abort;
    try { const result = await membershipRequest(`orders/${encodeURIComponent(order.id)}`, { signal: abort.signal }); if (!result.order?.id) throw new Error('订单状态暂时无法读取。'); setOrder(result.order); if (result.order.status === 'paid') await refresh(); }
    catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  return <div className="member-checkout"><p className="member-checkout-label">{available ? '确认购买内容' : '套餐明细 · 付款待开放'}</p><h3>{plan.name}</h3><p className="member-checkout-price">¥<b>{formatMoney(plan.amountFen)}</b><span>一次支付</span></p><dl className="member-order-detail"><div><dt>有效期</dt><dd>{plan.durationDays} 天</dd></div><div><dt>书本 AI 提问</dt><dd>每 {plan.periodDays} 天 {plan.quotaPerPeriod} 次</dd></div><div><dt>我的人生指南</dt><dd>最多 {plan.guideLimit || 100} 篇，支持持续完善</dd></div><div><dt>个人行动记录</dt><dd>确认情况、勾选任务、保留版本</dd></div><div><dt>导出</dt><dd>Markdown，可放入 Obsidian</dd></div><div><dt>续费方式</dt><dd>不自动续费</dd></div></dl><p className="member-checkout-rules">每次成功生成扣 1 次，失败不扣。每分钟最多 6 次、每天最多 30 次，同一账号同时生成 1 份回答；这些限制与套餐总次数共同生效。剩余次数不结转。阅读原文和下载指南始终免费。</p>
    {!available && <div className="member-service-note"><strong>{plan.id === 'member-year' ? '年度套餐暂未开放' : '付款暂未开放'}</strong><p>当前仅查看价格和权益，不会扣款，也不会开通虚假的会员。</p></div>}
    {order ? <div className="member-payment-result"><p className={order.status === 'paid' ? 'member-payment-paid' : ''}>{order.status === 'paid' && <IconCheck size={20}/>} {orderLabels[order.status] || '处理中'}</p><small>订单号：{order.id}</small>{order.status !== 'paid' && <div className="member-actions">{checkoutUrl && <NavbarButton href={checkoutUrl} target="_blank" rel="noopener noreferrer" className="coral-button">前往支付<IconExternalLink size={18}/></NavbarButton>}<NavbarButton as="button" type="button" className="outline-button" onClick={checkOrder} disabled={busy}>{busy ? '正在查询……' : '查询支付结果'}</NavbarButton></div>}<p className="member-privacy">会员只在服务端确认支付成功后开通。</p></div> : !me?.user ? <NavbarButton as="button" type="button" className="coral-button member-wide-button" onClick={() => setAccountView('login')}>登录{available ? '后确认订单' : '查看我的额度'}<IconArrowRight size={18}/></NavbarButton> : <NavbarButton as="button" type="button" className="coral-button member-wide-button" disabled={busy || !available} onClick={submit}>{busy ? '正在创建订单……' : available ? `确认订单 · ¥${formatMoney(plan.amountFen)}` : '付款待开放'}</NavbarButton>}
    {error && <p className="member-error" role="alert">{error}</p>}
  </div>;
}

export function AccountDialog() {
  const { accountOpen, accountView, checkoutPlanId, closeAccount, me, loading, serviceError, paymentReturn } = useMembership();
  const ref = useRef(null), opener = useRef(null), id = useId();
  const view = accountView === 'login' ? 'login' : accountView === 'checkout' ? 'checkout' : me?.user ? 'overview' : 'login';
  useEffect(() => {
    if (!accountOpen) return;
    opener.current = document.activeElement; const old = document.body.style.overflow; document.body.style.overflow = 'hidden';
    ref.current?.querySelector('button')?.focus();
    const keyboard = event => {
      if (event.key === 'Escape') closeAccount();
      if (event.key !== 'Tab') return;
      const focusables = [...(ref.current?.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])].filter(el => el.getClientRects().length);
      const first = focusables[0], last = focusables.at(-1);
      if (!focusables.length) { event.preventDefault(); ref.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = old; window.removeEventListener('keydown', keyboard); opener.current?.focus(); };
  }, [accountOpen, closeAccount]);
  return createPortal(<AnimatePresence>{accountOpen && <motion.div className="member-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={e => { if (e.target === e.currentTarget) closeAccount(); }}><motion.section className={view === 'login' ? 'member-dialog member-dialog-login' : 'member-dialog'} ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} initial={{ opacity: 0, y: 16, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }}><div className="member-toolbar">{view === 'login' && <img className="member-login-brand" src={`${base}media/brand.webp`} alt="" width={44} height={44}/>}<h2 id={`${id}-title`}>{view === 'checkout' ? '会员套餐' : view === 'overview' ? '我的会员' : '登录 Better Life'}</h2><NavbarButton as="button" type="button" variant="secondary" className="icon-button" aria-label="关闭会员窗口" onClick={closeAccount}><IconX size={22}/></NavbarButton></div><div className="member-dialog-scroll">{paymentReturn && <p className={paymentReturn.error ? "member-error" : "member-notice"} role={paymentReturn.error ? "alert" : "status"}>{paymentReturn.error || (paymentReturn.checking ? "正在核对支付结果……" : paymentReturnMessage(paymentReturn.order))}</p>}{loading && !me ? <p className="member-loading" role="status">正在读取账号信息……</p> : view === 'checkout' ? <CheckoutDetails key={checkoutPlanId}/> : view === 'overview' ? <MemberOverview/> : <LoginForm/>}{serviceError && <p className="member-error" role="alert">{serviceError}</p>}</div></motion.section></motion.div>}</AnimatePresence>, document.body);
}
