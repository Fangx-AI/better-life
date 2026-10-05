import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { NavbarButton } from '../ui/resizable-navbar';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { useMembership } from './membership-context';
import { membershipRequest, validateOrderHistory, formatMoney, formatMemberDate, safeCheckoutUrl } from '../../lib/membership-api.mjs';
import './account-settings.css';

const base = import.meta.env.BASE_URL;
const confirmationText = '删除我的账号';
const reasons = { mistaken_purchase: '误购', service_issue: '服务问题', duplicate_charge: '重复扣款疑问', other: '其他' };
const requestStates = { requested: '申请已登记', reviewing: '审核中', approved: '已批准，尚非到账', awaiting_provider: '待支付平台核验', resolved: '已核验退款', rejected: '申请未通过', cancelled: '申请已取消' };
const openStates = ['requested', 'reviewing', 'approved', 'awaiting_provider'];
const blockerLabels = { active_membership: '仍有当前或未来生效的会员权益。', unsettled_orders: '仍有未结算订单，请先核对订单状态。', refund_pending: '支付平台退款仍在处理中。', open_refund_request: '仍有未结束的退款申请，请先处理工单。', generation_in_progress: '仍有进行中的问答，请等待请求结束。', demo_account_forbidden: '体验账号不支持正式注销。' };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0 ? `¥${formatMoney(value)}` : '金额待核对';
function validTicket(ticket, userId) { return ticket && validId(ticket.id) && validId(ticket.orderId) && ticket.userId === userId && Object.hasOwn(requestStates, ticket.state) && Object.hasOwn(reasons, ticket.reasonCode) && Number.isSafeInteger(ticket.amountFen) && ticket.amountFen >= 0 && ticket.currency === 'CNY'; }

export function AccountSettings() {
  const { me, status, refresh, closeAccount, setAccountView } = useMembership();
  const userId = me?.user?.id, isDemo = me?.user?.authentication === 'local-demo';
  const refundAvailable = status.refundRequestsAvailable === true;
  const meOrderRevision = (me?.orders || []).map(order => `${order.id}:${order.status}:${order.refundState}`).join('|');
  const supportUrl = safeCheckoutUrl(status.supportUrl), id = useId();
  const [stateOwner, setStateOwner] = useState(userId), [orderId, setOrderId] = useState(''), [reason, setReason] = useState('other'), [requests, setRequests] = useState([]);
  const [refundLoading, setRefundLoading] = useState(false), [refundBusy, setRefundBusy] = useState(false), [refundError, setRefundError] = useState(''), [refundNotice, setRefundNotice] = useState(''), [refundReload, setRefundReload] = useState(0);
  const [orderItems, setOrderItems] = useState([]), [orderNextCursor, setOrderNextCursor] = useState(null), [ordersLoaded, setOrdersLoaded] = useState(false), [ordersLoading, setOrdersLoading] = useState(false), [ordersError, setOrdersError] = useState(''), [ordersReload, setOrdersReload] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false), [accountStatus, setAccountStatus] = useState(null), [statusLoading, setStatusLoading] = useState(false), [statusReload, setStatusReload] = useState(0);
  const [confirmation, setConfirmation] = useState(''), [deleteBusy, setDeleteBusy] = useState(false), [deleteError, setDeleteError] = useState(''), [clock, setClock] = useState(Date.now());
  const mounted = useRef(true), owner = useRef(userId), listController = useRef(null), orderController = useRef(null), refundController = useRef(null), statusController = useRef(null), deleteController = useRef(null), ordersLock = useRef(false), refundLock = useRef(false), deleteLock = useRef(false);
  owner.current = userId;
  const paidOrders = stateOwner === userId ? orderItems.filter(order => order.status === 'paid' && validId(order.id)) : [];
  const paidOrderKey = paidOrders.map(order => order.id).join('|');
  const loginAgain = useCallback(() => setAccountView('login'), [setAccountView]);
  const reportError = useCallback((failure, display) => {
    if (failure.name === 'AbortError') return;
    display(failure.message || '操作暂不可用，请稍后重试。');
    if (failure.status === 401 || failure.code === 'reauthentication_required') loginAgain();
  }, [loginAgain]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const controller of [listController, orderController, refundController, statusController, deleteController]) controller.current?.abort(); };
  }, []);
  useEffect(() => {
    setStateOwner(userId); setRequests([]); setOrderItems([]); setOrderNextCursor(null); setOrdersLoaded(false); setOrdersError(''); setRefundError(''); setRefundNotice(''); setRefundBusy(false); setAccountStatus(null); setConfirmation(''); setDeleteError(''); setDeleteBusy(false); ordersLock.current = false; refundLock.current = false; deleteLock.current = false;
    return () => { for (const controller of [listController, orderController, refundController, statusController, deleteController]) controller.current?.abort(); };
  }, [userId]);
  useEffect(() => {
    if (!userId || isDemo) { setOrdersLoading(false); return; }
    const abort = new AbortController(); orderController.current?.abort(); orderController.current = abort; ordersLock.current = true; setOrdersLoading(true); setOrdersLoaded(false); setOrdersError(''); setOrderItems([]); setOrderNextCursor(null);
    membershipRequest('orders?status=paid&limit=20', { signal: abort.signal }).then(data => {
      if (abort.signal.aborted || owner.current !== userId) return;
      const page = validateOrderHistory(data, userId, { status: 'paid' });
      setOrderItems(page.items); setOrderNextCursor(page.nextCursor); setOrdersLoaded(true);
    }).catch(failure => { if (!abort.signal.aborted && owner.current === userId) reportError(failure, setOrdersError); })
      .finally(() => { if (!abort.signal.aborted && owner.current === userId) { ordersLock.current = false; setOrdersLoading(false); } });
    return () => abort.abort();
  }, [userId, isDemo, ordersReload, meOrderRevision, reportError]);
  useEffect(() => { if (!paidOrders.some(order => order.id === orderId)) setOrderId(paidOrders[0]?.id || ''); }, [paidOrderKey, orderId]);
  useEffect(() => {
    if (!userId || !refundAvailable || isDemo) { setRefundLoading(false); return; }
    const abort = new AbortController(); listController.current?.abort(); listController.current = abort; setRefundLoading(true); setRefundError('');
    membershipRequest('refund-requests', { signal: abort.signal }).then(data => {
      if (abort.signal.aborted || owner.current !== userId) return;
      if (!Array.isArray(data.items) || data.items.length > 100 || !data.items.every(ticket => validTicket(ticket, userId))) throw new Error('申请记录暂时无法核对，请稍后刷新。');
      setRequests(data.items);
    }).catch(failure => { if (!abort.signal.aborted && owner.current === userId) reportError(failure, setRefundError); })
      .finally(() => { if (!abort.signal.aborted && owner.current === userId) setRefundLoading(false); });
    return () => abort.abort();
  }, [userId, refundAvailable, isDemo, refundReload, reportError]);
  useEffect(() => {
    if (!deleteOpen || !userId || isDemo) { setStatusLoading(false); return; }
    const abort = new AbortController(); statusController.current?.abort(); statusController.current = abort; setStatusLoading(true); setAccountStatus(null); setDeleteError(''); setClock(Date.now());
    membershipRequest('account/status', { signal: abort.signal }).then(data => {
      if (abort.signal.aborted || owner.current !== userId) return;
      if (typeof data.freshAuthentication !== 'boolean' || typeof data.canDelete !== 'boolean' || !Array.isArray(data.deletionBlockers) || data.deletionBlockers.some(value => typeof value !== 'string') || data.freshAuthentication && !Number.isFinite(Date.parse(data.expiresAt))) throw new Error('注销条件暂时无法核对，请稍后刷新。');
      setAccountStatus(data); setClock(Date.now());
    }).catch(failure => { if (!abort.signal.aborted && owner.current === userId) reportError(failure, setDeleteError); })
      .finally(() => { if (!abort.signal.aborted && owner.current === userId) setStatusLoading(false); });
    return () => abort.abort();
  }, [deleteOpen, userId, isDemo, statusReload, reportError]);
  useEffect(() => {
    const expiresAt = Date.parse(accountStatus?.expiresAt);
    if (!deleteOpen || !accountStatus?.freshAuthentication || !Number.isFinite(expiresAt)) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [deleteOpen, accountStatus]);

  const currentState = stateOwner === userId, visibleRequests = currentState ? requests.filter(ticket => ticket.userId === userId) : [];
  const hasOpenRequest = visibleRequests.some(ticket => ticket.orderId === orderId && openStates.includes(ticket.state));
  const fresh = currentState && accountStatus?.freshAuthentication === true && Date.parse(accountStatus.expiresAt) > clock;
  const canDelete = currentState && !isDemo && fresh && accountStatus?.canDelete === true && accountStatus.deletionBlockers.length === 0;
  const loadOlderOrders = async () => {
    if (!currentState || !orderNextCursor || isDemo || ordersLock.current) return;
    const cursor = orderNextCursor, abort = new AbortController(); orderController.current?.abort(); orderController.current = abort; ordersLock.current = true; setOrdersLoading(true); setOrdersError('');
    try {
      const data = await membershipRequest(`orders?status=paid&limit=20&cursor=${encodeURIComponent(cursor)}`, { signal: abort.signal });
      if (abort.signal.aborted || !mounted.current || owner.current !== userId) return;
      const page = validateOrderHistory(data, userId, { status: 'paid' });
      if (page.nextCursor === cursor) throw new Error('订单记录暂时无法核对，请刷新后重试。');
      setOrderItems(value => [...value, ...page.items.filter(order => !value.some(existing => existing.id === order.id))]); setOrderNextCursor(page.nextCursor);
    } catch (failure) { if (!abort.signal.aborted && mounted.current && owner.current === userId) reportError(failure, setOrdersError); }
    finally { if (!abort.signal.aborted && mounted.current && owner.current === userId) { ordersLock.current = false; setOrdersLoading(false); } }
  };
  const submitRefund = async event => {
    event.preventDefault();
    if (!currentState || !refundAvailable || isDemo || !paidOrders.some(order => order.id === orderId) || !Object.hasOwn(reasons, reason) || refundLock.current || hasOpenRequest) return;
    const abort = new AbortController(); refundController.current = abort; refundLock.current = true; setRefundBusy(true); setRefundError(''); setRefundNotice('');
    try {
      const data = await membershipRequest('refund-requests', { method: 'POST', body: { orderId, reason }, signal: abort.signal });
      if (abort.signal.aborted || !mounted.current || owner.current !== userId) return;
      if (!validTicket(data.ticket, userId) || data.ticket.orderId !== orderId || typeof data.created !== 'boolean') throw new Error('申请结果暂时无法核对，请刷新记录后再试。');
      setRequests(value => [data.ticket, ...value.filter(ticket => ticket.id !== data.ticket.id)]); setRefundNotice(data.created ? '申请已登记，不等于退款到账。请以核验后的支付结果为准。' : '已有这份申请，未重复创建工单。申请不等于退款到账。'); setRefundReload(value => value + 1);
      if (deleteOpen) { setAccountStatus(null); setStatusReload(value => value + 1); }
    } catch (failure) { if (!abort.signal.aborted && mounted.current && owner.current === userId) reportError(failure, setRefundError); }
    finally { if (!abort.signal.aborted && mounted.current && owner.current === userId) { refundLock.current = false; setRefundBusy(false); } }
  };
  const removeAccount = async event => {
    event.preventDefault();
    if (!canDelete || confirmation !== confirmationText || deleteLock.current || statusLoading) return;
    const abort = new AbortController(); deleteController.current = abort; deleteLock.current = true; setDeleteBusy(true); setDeleteError('');
    try {
      const data = await membershipRequest('account', { method: 'DELETE', body: { confirmation }, signal: abort.signal });
      if (abort.signal.aborted || !mounted.current || owner.current !== userId) return;
      if (data.deleted !== true) throw new Error('注销结果暂时无法核对，请刷新账号状态。');
      closeAccount(); await refresh();
    } catch (failure) {
      if (!abort.signal.aborted && mounted.current && owner.current === userId) { reportError(failure, setDeleteError); if (failure.status === 409) setStatusReload(value => value + 1); }
    } finally { if (!abort.signal.aborted && mounted.current && owner.current === userId) { deleteLock.current = false; setDeleteBusy(false); } }
  };
  if (!userId) return null;
  return <div className="account-settings">
    <section className="account-settings-refunds" aria-labelledby={`${id}-refund-title`} aria-busy={refundLoading || refundBusy || ordersLoading}>
      <div className="account-settings-heading"><h3 id={`${id}-refund-title`}>退款申请</h3>{!isDemo && <NavbarButton as="button" type="button" variant="secondary" disabled={refundBusy || refundLoading || ordersLoading} onClick={() => { setRefundReload(value => value + 1); setOrdersReload(value => value + 1); }}>刷新记录</NavbarButton>}</div>
      <p className="account-settings-note">这里只登记申请。审核批准不等于退款到账，不会自动调用退款网关。</p>
      {!refundAvailable && <p className="account-settings-state" role="status">退款申请暂未开放。已支付订单仍保留；{supportUrl ? '可通过下方客服入口联系。' : '本站尚未配置客服入口。'}</p>}
      {paidOrders.length > 0 ? <form onSubmit={submitRefund} className="account-settings-form">
        <Label htmlFor={`${id}-refund-order`}>选择已支付订单</Label>
        <select id={`${id}-refund-order`} name="refund-order" value={orderId} onChange={event => { setOrderId(event.target.value); setRefundError(''); setRefundNotice(''); }} disabled={refundBusy || isDemo}>
          {paidOrders.map(order => <option key={order.id} value={order.id}>{order.planName || '已支付订单'} · {money(order.amountFen)} · {formatMemberDate(order.paidAt || order.createdAt)} · 尾号 {order.id.slice(-8)}</option>)}
        </select>
        <Label htmlFor={`${id}-refund-reason`}>申请原因</Label>
        <select id={`${id}-refund-reason`} name="refund-reason" value={reason} onChange={event => setReason(event.target.value)} disabled={!refundAvailable || refundBusy || isDemo}>{Object.entries(reasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        {hasOpenRequest && <p className="account-settings-note" role="status">该订单已有处理中申请，不必重复提交。</p>}
        <NavbarButton as="button" type="submit" className="outline-button" aria-live="polite" disabled={!currentState || !refundAvailable || refundBusy || refundLoading || isDemo || !orderId || hasOpenRequest}>{refundBusy ? '正在提交申请……' : '提交退款申请'}</NavbarButton>
      </form> : ordersLoaded && !ordersLoading && !ordersError ? <p className="account-settings-note">没有可申请的已支付订单。</p> : null}
      {ordersLoading && <p className="account-settings-state" role="status">正在读取已支付订单……</p>}
      {currentState && orderNextCursor && <NavbarButton as="button" type="button" variant="secondary" className="account-settings-orders-more" disabled={ordersLoading || refundBusy} onClick={loadOlderOrders}>加载更早的已支付订单</NavbarButton>}
      {ordersError && <div className="account-settings-orders-error"><p className="account-settings-error" role="alert">{ordersError}</p><NavbarButton as="button" type="button" variant="secondary" disabled={ordersLoading || refundBusy} onClick={() => setOrdersReload(value => value + 1)}>重新读取订单</NavbarButton></div>}
      {refundLoading && <p className="account-settings-state" role="status">正在读取申请记录……</p>}
      {visibleRequests.length > 0 && <ul className="account-settings-requests" aria-label="我的退款申请">{visibleRequests.map(ticket => <li key={ticket.id}><div><b>{requestStates[ticket.state]}</b><small>订单尾号 {ticket.orderId.slice(-8)} · {money(ticket.amountFen)} · {reasons[ticket.reasonCode]}</small><small>{formatMemberDate(ticket.updatedAt || ticket.createdAt)}</small></div></li>)}</ul>}
      {refundNotice && <p className="account-settings-state" role="status">{refundNotice}</p>}{refundError && <p className="account-settings-error" role="alert">{refundError}</p>}
    </section>
    <nav className="account-settings-links" aria-label="账号服务与条款">{supportUrl && <a href={supportUrl} target="_blank" rel="noopener noreferrer">联系客服</a>}<a href={`${base}?view=privacy`}>隐私说明</a><a href={`${base}?view=terms`}>服务条款</a></nav>
    <details className="account-settings-delete" onToggle={event => { const open = event.currentTarget.open; setDeleteOpen(open); setConfirmation(''); if (!open) statusController.current?.abort(); }}>
      <summary tabIndex={0} aria-expanded={deleteOpen} aria-controls={`${id}-delete-panel`}>注销账号</summary>
      <div id={`${id}-delete-panel`} className="account-settings-delete-panel" aria-busy={statusLoading || deleteBusy}>
        <p className="account-settings-note">注销会清理主数据库中的私人记录并撤销所有设备登录，金融记录脱敏关联后保留。备份和已导出文件不会因此物理擦除。注销不会自动退款。</p>
        {isDemo ? <p className="account-settings-state" role="status">体验账号不支持正式注销。</p> : <>
          {statusLoading && <p className="account-settings-state" role="status">正在核对注销条件……</p>}
          {accountStatus?.deletionBlockers.length > 0 && <ul className="account-settings-blockers" aria-label="暂不能注销的原因">{accountStatus.deletionBlockers.map((code, index) => <li key={`${code}-${index}`}>{blockerLabels[code] || '账号仍有未处理事项，请先刷新核对。'}</li>)}</ul>}
          {accountStatus && !fresh && <div className="account-settings-reauth"><p className="account-settings-note" role="status">注销需要最近 10 分钟内重新登录验证。</p><NavbarButton as="button" type="button" variant="secondary" onClick={loginAgain} disabled={deleteBusy}>重新登录验证</NavbarButton></div>}
          <NavbarButton as="button" type="button" variant="secondary" className="account-settings-status-refresh" disabled={statusLoading || deleteBusy} onClick={() => setStatusReload(value => value + 1)}>重新核对条件</NavbarButton>
          <form onSubmit={removeAccount} className="account-settings-form">
            <Label htmlFor={`${id}-delete-confirmation`}>输入“删除我的账号”确认</Label>
            <Input id={`${id}-delete-confirmation`} name="account-deletion-confirmation" value={currentState ? confirmation : ''} onChange={event => setConfirmation(event.target.value)} autoComplete="off" maxLength={20} required disabled={!canDelete || deleteBusy || statusLoading} aria-describedby={`${id}-delete-help`}/>
            <p id={`${id}-delete-help`} className="account-settings-note">仅满足上述条件且确认文字完全一致时可以提交。</p>
            <NavbarButton as="button" type="submit" className="account-settings-danger" aria-live="polite" disabled={!canDelete || confirmation !== confirmationText || deleteBusy || statusLoading}>{deleteBusy ? '正在注销……' : '确认注销账号'}</NavbarButton>
          </form>
        </>}
        {deleteError && <p className="account-settings-error" role="alert">{deleteError}</p>}
      </div>
    </details>
  </div>;
}
