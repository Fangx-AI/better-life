import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { IconArrowLeft, IconArrowRight, IconLogout, IconRefresh, IconShieldLock } from '@tabler/icons-react';
import { NavbarButton } from '../ui/resizable-navbar';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { operationsRequest, maskedOperationsId, operationsTicketTransitions, OPERATIONS_TICKET_LABELS, OPERATIONS_REASON_LABELS,
  OPERATIONS_ORDER_LABELS, OPERATIONS_REFUND_LABELS, OPERATIONS_AUDIT_LABELS } from '../../lib/operations-api.mjs';
import './operations.css';

const base = import.meta.env.BASE_URL;
const tabs = [['overview', '总览'], ['users', '用户'], ['orders', '订单'], ['refund-tickets', '退款工单'], ['audit', '审计']];
const planNames = { free: '免费使用', 'member-month': '月度会员', 'member-year': '年度会员' };
const authNames = { email: '邮箱', phone: '手机号', 'local-demo': '本机体验', deleted: '已注销' };
const eventNames = { page_view: '页面曝光', reader_open: '打开阅读', download_click: '下载点击', qa_submit: '提交问答', qa_result: '问答结果', login_open: '打开登录', login_complete: '完成登录', pricing_open: '查看方案', checkout_start: '创建支付跳转', checkout_return: '支付返回', payment_confirmed: '可信到账确认' };
const date = value => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const money = value => `¥${(value / 100).toFixed(2)}`;
const budgetMoney = value => `¥${(value / 1000000).toFixed(4)}`;
function Empty({ children = '还没有记录。' }) { return <p className="operations-empty" role="status">{children}</p>; }
function ErrorNotice({ message }) { return message ? <p className="operations-error" role="alert">{message}</p> : null; }

function Overview({ data }) {
  if (!data) return null;
  const summary = data.summary.value, budget = data.budget.value, analytics = data.analytics.value;
  const eventCounts = new Map();
  for (const item of analytics?.items || []) eventCounts.set(item.name, (eventCounts.get(item.name) || 0) + item.event_count);
  return <div className="operations-overview">
    <section className="operations-panel"><div className="operations-section-title"><h2>运营概况</h2><span>存储事实 · 非财务结算</span></div><ErrorNotice message={data.summary.error}/>
      {summary && <><div className="operations-stat-grid"><article><span>账号记录</span><b>{summary.users}</b><small>包含本机体验与已注销记录</small></article><article><span>订单记录</span><b>{summary.orders.reduce((sum, row) => sum + row.count, 0)}</b><small>所有支付状态</small></article><article><span>退款工单</span><b>{summary.refundTickets.reduce((sum, row) => sum + row.count, 0)}</b><small>工单不是退款到账证明</small></article></div>
        <div className="operations-summary-columns"><div><h3>订单状态</h3>{summary.orders.length ? <dl>{summary.orders.map(row => <div key={row.status}><dt>{OPERATIONS_ORDER_LABELS[row.status]}</dt><dd>{row.count} 笔</dd></div>)}</dl> : <Empty>还没有订单。</Empty>}</div><div><h3>金额分类</h3>{summary.orderAmounts.length ? <dl>{summary.orderAmounts.map(row => <div key={row.status}><dt>{OPERATIONS_ORDER_LABELS[row.status]}</dt><dd>{money(row.amountFen)}</dd></div>)}</dl> : <Empty>还没有已核验支付/退款金额。</Empty>}<p className="operations-note">按订单状态分组的金额，不等于净收入、利润或渠道结算。</p></div></div></>}
    </section>
    <section className="operations-panel"><div className="operations-section-title"><h2>问答预算</h2><span>上海时区 · 配置费率估算</span></div><ErrorNotice message={data.budget.error}/>
      {budget && !budget.configured ? <Empty>成本预算尚未配置，不能把空白当作零成本。</Empty> : budget?.configured && <><p className={`operations-budget-state is-${budget.state}`}>{budget.state === 'blocked' ? '预算已达上限 · 问答应停止新请求' : budget.state === 'warning' ? '预算已达预警区间' : '预算在配置上限内'}</p><div className="operations-budget-grid">{[['day', '今日'], ['month', '本月']].map(([key, label]) => <article key={key}><h3>{label} <small>{budget[key].period}</small></h3><dl><div><dt>已承诺成本</dt><dd>{budgetMoney(budget[key].committedMicroCny)}</dd></div><div><dt>预算上限</dt><dd>{budgetMoney(budget[key].limitMicroCny)}</dd></div><div><dt>剩余空间</dt><dd>{budgetMoney(budget[key].remainingMicroCny)}</dd></div><div><dt>保守计费请求</dt><dd>{budget[key].conservativeRequests}</dd></div></dl><progress max="1" value={Math.min(1, budget[key].fraction)} aria-label={`${label}预算使用比例`}/></article>)}</div><p className="operations-note">包含在途预占与不确定请求的保守估算，不是模型供应商账单。正式费用以供应商核验为准。</p></>}
    </section>
    <section className="operations-panel"><div className="operations-section-title"><h2>近 90 天匿名转化事件</h2><span>UTC 日聚合 · 非用户轨迹</span></div><ErrorNotice message={data.analytics.error}/>
      {analytics && !analytics.configured ? <Empty>转化统计尚未接通，不展示虚构的零访问。</Empty> : analytics?.configured && (!analytics.items.length ? <Empty>还没有已接收的统计事件。空记录不代表网站没有访问。</Empty> : <div className="operations-event-grid">{[...eventCounts].map(([name, total]) => <article key={name}><span>{eventNames[name] || '其他产品事件'}</span><b>{total}</b><small>事件次数</small></article>)}</div>)}
      <p className="operations-note">下载点击不等于下载完成；支付返回不等于到账。只把可信服务端 payment_confirmed 作为到账事件。统计受 DNT/GPC 与会话到期影响，不能据此计算真实注册数、留存或跨渠道个体漏斗。</p>
    </section>
  </div>;
}

function UserRecords({ items }) {
  return items.length ? <div className="operations-records">{items.map(user => <article className="operations-record" key={user.id}><header><h3>用户 {maskedOperationsId(user.id)}</h3><span className="operations-badge">{authNames[user.authentication]}</span></header><dl><div><dt>创建</dt><dd>{date(user.createdAt)}</dd></div><div><dt>会员</dt><dd>{planNames[user.membership.planId]}</dd></div><div><dt>到期</dt><dd>{date(user.membership.expiresAt)}</dd></div><div><dt>额度使用 / 预占</dt><dd>{user.quota ? `${user.quota.used} / ${user.quota.reserved}（上限 ${user.quota.limit}）` : '尚无当前额度记录'}</dd></div><div><dt>指南 / 保存回答</dt><dd>{user.guideCount} / {user.savedAnswerCount}</dd></div><div><dt>档案</dt><dd>{user.hasProfile ? '存在 · 不读取正文' : '未建立'}</dd></div></dl></article>)}</div> : <Empty>当前页没有用户记录。</Empty>;
}

function OrderRecords({ items }) {
  return items.length ? <div className="operations-records">{items.map(order => <article className="operations-record" key={order.id}><header><h3>订单 {maskedOperationsId(order.id)}</h3><span className="operations-badge">{OPERATIONS_ORDER_LABELS[order.status]}</span></header><dl><div><dt>归属用户</dt><dd>{maskedOperationsId(order.userId)}</dd></div><div><dt>套餐 / 金额</dt><dd>{planNames[order.planId]} · {money(order.amountFen)}</dd></div><div><dt>创建</dt><dd>{date(order.createdAt)}</dd></div><div><dt>付款核验</dt><dd>{date(order.paidAt)}</dd></div><div><dt>退款事实</dt><dd>{OPERATIONS_REFUND_LABELS[order.refundState]}</dd></div><div><dt>退款核验</dt><dd>{date(order.refundedAt)}</dd></div></dl></article>)}</div> : <Empty>当前页没有订单记录。</Empty>;
}

function RefundRecord({ ticket, onUpdate, busy }) {
  const allowed = operationsTicketTransitions(ticket.state), [nextState, setNextState] = useState(''), selectId = useId();
  useEffect(() => setNextState(''), [ticket.id, ticket.revision]);
  return <article className="operations-record"><header><h3>工单 {maskedOperationsId(ticket.id)}</h3><span className="operations-badge">{OPERATIONS_TICKET_LABELS[ticket.state]}</span></header><dl><div><dt>订单 / 用户</dt><dd>{maskedOperationsId(ticket.orderId)} / {maskedOperationsId(ticket.userId)}</dd></div><div><dt>申请类别</dt><dd>{OPERATIONS_REASON_LABELS[ticket.reasonCode]}</dd></div><div><dt>整单金额</dt><dd>{money(ticket.amountFen)}</dd></div><div><dt>版本</dt><dd>{ticket.revision}</dd></div><div><dt>更新</dt><dd>{date(ticket.updatedAt)}</dd></div></dl>
    {allowed.length ? <div className="operations-ticket-action"><Label htmlFor={selectId}>调整工单状态</Label><select id={selectId} value={nextState} onChange={event => setNextState(event.target.value)} disabled={busy}><option value="">选择合法下一状态</option>{allowed.map(state => <option key={state} value={state}>{OPERATIONS_TICKET_LABELS[state]}</option>)}</select><NavbarButton as="button" type="button" className="outline-button" disabled={busy || !allowed.includes(nextState)} onClick={() => onUpdate(ticket, nextState)}>{busy ? '正在更新……' : '更新工单'}</NavbarButton></div> : <p className="operations-note">工单已关闭，不能继续变更。</p>}
  </article>;
}

function AuditRecords({ items }) {
  return items.length ? <div className="operations-records">{items.map(item => <article className="operations-record" key={item.id}><header><h3>{OPERATIONS_AUDIT_LABELS[item.action] || '其他审计动作'}</h3><span className="operations-badge">{item.result === 'allowed' ? '允许' : item.result === 'denied' ? '拒绝' : '失败'}</span></header><dl><div><dt>记录序号</dt><dd>{item.id}</dd></div><div><dt>目标编号</dt><dd>{maskedOperationsId(item.targetId)}</dd></div><div><dt>发生时间</dt><dd>{date(item.createdAt)}</dd></div></dl></article>)}</div> : <Empty>当前页没有审计记录。</Empty>;
}

export function OperationsPage() {
  // Secrets are page-local React state only. No URL, persistence, membership
  // context, analytics, export, error output or console ever receives them.
  const [credential, setCredential] = useState(''), [token, setToken] = useState('');
  const [status, setStatus] = useState(null), [statusLoading, setStatusLoading] = useState(true), [statusError, setStatusError] = useState('');
  const [tab, setTab] = useState('overview'), [cursorStack, setCursorStack] = useState([null]), [filter, setFilter] = useState('');
  const [data, setData] = useState(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const requestController = useRef(null), statusController = useRef(null), authController = useRef(null), mutationController = useRef(null), authInputId = useId();
  const clearSession = useCallback((message = '') => {
    requestController.current?.abort(); authController.current?.abort(); mutationController.current?.abort();
    setToken(''); setCredential(''); setData(null); setCursorStack([null]); setTab('overview'); setFilter(''); setError(message); setNotice(''); setBusy(false); setLoading(false);
  }, []);
  const checkStatus = useCallback(async () => {
    statusController.current?.abort(); const controller = new AbortController(); statusController.current = controller;
    setStatusLoading(true); setStatusError('');
    try { setStatus(await operationsRequest('status', { signal: controller.signal })); }
    catch (cause) { if (cause.name !== 'AbortError') { setStatus(null); setStatusError(cause.message); } }
    finally { if (!controller.signal.aborted) setStatusLoading(false); }
  }, []);
  useEffect(() => { void checkStatus(); return () => { statusController.current?.abort(); requestController.current?.abort(); authController.current?.abort(); mutationController.current?.abort(); }; }, [checkStatus]);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController(); requestController.current = controller; setLoading(true); setData(null);
    const cursor = cursorStack.at(-1);
    async function load() {
      try {
        let result;
        if (tab === 'overview') {
          const names = ['summary', 'usage-budget', 'analytics'];
          const responses = await Promise.allSettled(names.map(path => operationsRequest(path, { token, signal: controller.signal }).catch(cause => { if (cause.status === 401) clearSession(cause.message); throw cause; })));
          const unauthorized = responses.find(row => row.status === 'rejected' && row.reason.status === 401); if (unauthorized) throw unauthorized.reason;
          result = Object.fromEntries(responses.map((row, index) => [['summary', 'budget', 'analytics'][index], row.status === 'fulfilled' ? { value: row.value } : { error: row.reason.message }]));
        } else result = await operationsRequest(tab, { token, signal: controller.signal, query: { limit: 20, ...(cursor ? { cursor } : {}), ...(tab === 'refund-tickets' && filter ? { state: filter } : {}) } });
        if (!controller.signal.aborted) setData(result);
      } catch (cause) { if (cause.name !== 'AbortError') { if (cause.status === 401) clearSession(cause.message); else if (!controller.signal.aborted) setError(cause.message); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [token, tab, cursorStack, filter, reload, clearSession]);
  const authenticate = async event => {
    event.preventDefault(); if (busy || !status?.available) return;
    const candidate = credential; setCredential(''); setError(''); setBusy(true);
    const controller = new AbortController(); authController.current = controller;
    try { await operationsRequest('summary', { token: candidate, signal: controller.signal }); if (!controller.signal.aborted) setToken(candidate); }
    catch (cause) { if (cause.name !== 'AbortError') clearSession(cause.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const updateTicket = async (ticket, state) => {
    if (busy || !operationsTicketTransitions(ticket.state).includes(state)) return;
    setBusy(true); setError(''); setNotice(''); const controller = new AbortController(); mutationController.current = controller;
    try { await operationsRequest(`refund-tickets/${ticket.id}`, { token, method: 'PATCH', body: { revision: ticket.revision, state }, signal: controller.signal }); if (!controller.signal.aborted) { setNotice('工单状态已更新；未调用支付网关，也未改动付款或退款事实。'); setReload(value => value + 1); } }
    catch (cause) { if (cause.name !== 'AbortError') { if (cause.status === 401) clearSession(cause.message); else setError(cause.message); } }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  // Clear the old response synchronously: overview and list payloads have
  // different shapes, so waiting for useEffect can crash the next render.
  const selectTab = value => { if (busy) return; setData(null); setLoading(true); setTab(value); setCursorStack([null]); setFilter(''); setError(''); setNotice(''); };
  const refresh = () => { setError(''); setNotice(''); setReload(value => value + 1); };

  return <div className="operations-page"><a className="skip-link" href="#operations-main">跳到运营内容</a>
    <header className="operations-topbar"><a className="operations-brand" href={base}><img src={`${base}media/brand.webp`} width="38" height="38" alt=""/><span><b>BETTER LIFE</b><small>受限运营工作区</small></span></a><div className="operations-top-actions"><NavbarButton href={base} variant="secondary"><IconArrowLeft size={17}/> 返回指南</NavbarButton>{token && <NavbarButton as="button" type="button" className="outline-button" onClick={() => clearSession()}><IconLogout size={17}/> 退出后台</NavbarButton>}</div></header>
    <main id="operations-main" tabIndex={-1}><header className="operations-heading"><p><IconShieldLock size={18}/> 独立运营凭据 · 不读取私人正文</p><h1>把状态看清楚。<br/><span>把边界留明确。</span></h1><p>只读用户与订单、查看预算和审计、处理退款工单。不能手工改付款状态、开通会员或调整额度。</p></header>
      {!token ? <section className="operations-panel operations-auth" aria-busy={statusLoading || busy}><h2>进入运营工作区</h2>{statusLoading ? <Empty>正在确认后台开放状态……</Empty> : statusError ? <><ErrorNotice message={statusError}/><NavbarButton as="button" type="button" className="outline-button" onClick={checkStatus}>重新检查</NavbarButton></> : !status?.available ? <><Empty>后台尚未启用或独立凭据未配置。普通会员登录不能获得运营权限。</Empty><NavbarButton as="button" type="button" className="outline-button" onClick={checkStatus}>刷新开放状态</NavbarButton></> : <form onSubmit={authenticate} autoComplete="off"><Label htmlFor={authInputId}>独立运营凭据</Label><Input id={authInputId} type="password" value={credential} onChange={event => setCredential(event.target.value)} required maxLength={64} autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={busy} aria-describedby={`${authInputId}-hint`}/><p id={`${authInputId}-hint`} className="operations-note">仅保留在当前页面内存。退出、凭据失效或刷新后需重新输入；不会使用会员 Cookie。</p><NavbarButton as="button" type="submit" className="coral-button" disabled={busy || credential.length !== 64}>{busy ? '正在核验……' : '核验并进入'}<IconArrowRight size={18}/></NavbarButton></form>}<ErrorNotice message={error}/></section> : <>
        <nav className="operations-tabs" aria-label="运营工作区">{tabs.map(([value, label]) => <NavbarButton as="button" type="button" variant="secondary" key={value} aria-pressed={tab === value} onClick={() => selectTab(value)} disabled={busy}>{label}</NavbarButton>)}</nav>
        <div className="operations-toolbar"><h2>{tabs.find(([value]) => value === tab)?.[1]}</h2><NavbarButton as="button" type="button" className="outline-button" onClick={refresh} disabled={loading || busy}><IconRefresh size={17}/> 刷新</NavbarButton></div>
        <ErrorNotice message={error}/>{notice && <p className="operations-notice" role="status">{notice}</p>}
        {tab === 'refund-tickets' && <><p className="operations-boundary">批准工单不等于退款到账。此处只调整工单，不能发起网关退款；“已核验退款并关闭”仍需服务端已有可信退款事实。</p><div className="operations-filter"><Label htmlFor="operations-refund-state">工单状态</Label><select id="operations-refund-state" value={filter} onChange={event => { setFilter(event.target.value); setCursorStack([null]); }} disabled={loading || busy}><option value="">全部状态</option>{Object.entries(OPERATIONS_TICKET_LABELS).map(([state, label]) => <option key={state} value={state}>{label}</option>)}</select></div></>}
        <div className="operations-content" aria-busy={loading}>{loading ? <Empty>正在读取运营记录……</Empty> : tab === 'overview' ? <Overview data={data}/> : data && (tab === 'users' ? <UserRecords items={data.items}/> : tab === 'orders' ? <OrderRecords items={data.items}/> : tab === 'audit' ? <AuditRecords items={data.items}/> : data.items.length ? <div className="operations-records">{data.items.map(ticket => <RefundRecord key={ticket.id} ticket={ticket} onUpdate={updateTicket} busy={busy}/>)}</div> : <Empty>当前筛选没有退款工单。</Empty>)}</div>
        {tab !== 'overview' && <nav className="operations-pagination" aria-label="记录分页"><NavbarButton as="button" type="button" className="outline-button" disabled={loading || busy || cursorStack.length === 1} onClick={() => setCursorStack(value => value.slice(0, -1))}><IconArrowLeft size={17}/> 上一页</NavbarButton><span>第 {cursorStack.length} 页</span><NavbarButton as="button" type="button" className="outline-button" disabled={loading || busy || !data?.nextCursor} onClick={() => setCursorStack(value => [...value, data.nextCursor])}>下一页<IconArrowRight size={17}/></NavbarButton></nav>}
      </>}
    </main><footer className="operations-footer">只展示脱敏编号与必要状态。运营凭据不等于个人身份；敏感读取与工单动作由服务端记录审计。</footer>
  </div>;
}
