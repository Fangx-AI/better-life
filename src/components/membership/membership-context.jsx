import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { membershipRequest, validateMembershipStatus, validateMember } from '../../lib/membership-api.mjs';
import { MEMBERSHIP_PLANS } from '../../../shared/membership-plans.mjs';
import { paymentReturnOrderId } from '../../lib/payment-return.mjs';

// Display-only fallback. It never creates a session or grants an entitlement.
const previewPlans = MEMBERSHIP_PLANS.map(plan => ({ ...plan, purchasable: false }));
const previewStatus = { available: false, preview: true, enforced: false, loginAvailable: false, emailLoginAvailable: false, phoneLoginAvailable: false, checkoutAvailable: false, annualAvailable: false, localDemoAvailable: false, plans: previewPlans };
const MembershipContext = createContext(null);

export function MembershipProvider({ children }) {
  const [status, setStatus] = useState(previewStatus), [me, setMe] = useState(null), [loading, setLoading] = useState(true), [serviceError, setServiceError] = useState('');
  const [accountOpen, setAccountOpen] = useState(false), [accountView, setAccountView] = useState('auto'), [checkoutPlanId, setCheckoutPlanId] = useState(null);
  const [paymentReturn, setPaymentReturn] = useState(null);
  const paymentRequest = useRef(null), paymentHandled = useRef('');
  const mounted = useRef(true), request = useRef(0), controller = useRef(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const sequence = ++request.current;
    setLoading(true);
    const [catalog, member] = await Promise.allSettled([
      membershipRequest('membership', { signal: abort.signal }).then(validateMembershipStatus),
      membershipRequest('me', { signal: abort.signal }).then(validateMember),
    ]);
    if (!mounted.current || abort.signal.aborted || sequence !== request.current) return;
    setStatus(catalog.status === 'fulfilled' ? catalog.value : previewStatus);
    setMe(member.status === 'fulfilled' ? member.value : null);
    setServiceError(catalog.status === 'rejected' ? catalog.reason.message : member.status === 'rejected' ? member.reason.message : '');
    setLoading(false);
  }, []);
  useEffect(() => {
    mounted.current = true; refresh();
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    const orderId = paymentReturnOrderId(window.location.search);
    if (!orderId) return;
    setPaymentReturn({ orderId, checking: false, error: '', order: null });
    setAccountView('auto'); setAccountOpen(true);
    const url = new URL(window.location.href); url.searchParams.delete('paymentOrder');
    // 去掉定位参数避免复制链接暴露订单号，不接受任何 paid/金额参数。
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  useEffect(() => {
    const userId = me?.user?.id, orderId = paymentReturn?.orderId;
    if (!userId || !orderId) return;
    const key = `${userId}:${orderId}`; if (paymentHandled.current === key) return;
    paymentHandled.current = key;
    const abort = new AbortController(); let settled = false; paymentRequest.current?.abort(); paymentRequest.current = abort;
    setPaymentReturn(value => ({ ...value, checking: true, error: '', order: null, userId }));
    membershipRequest(`orders/${encodeURIComponent(orderId)}`, { signal: abort.signal }).then(data => {
      if (!mounted.current || abort.signal.aborted) return;
      const member = validateMember(data);
      if (data.order?.id !== orderId || member.user?.id !== userId) throw new Error('账号状态已改变，请刷新后查看订单。');
      settled = true; setMe(member); setPaymentReturn(value => ({ ...value, checking: false, order: data.order }));
    }).catch(error => { if (mounted.current && !abort.signal.aborted) { settled = true; setPaymentReturn(value => ({ ...value, checking: false, error: error.message })); } });
    return () => { abort.abort(); if (!settled && paymentHandled.current === key) paymentHandled.current = ''; if (paymentRequest.current === abort) paymentRequest.current = null; };
  }, [me?.user?.id, paymentReturn?.orderId]);
  const openAccount = useCallback(() => { setCheckoutPlanId(null); setAccountView('auto'); setAccountOpen(true); }, []);
  const closeAccount = useCallback(() => { paymentRequest.current?.abort(); setPaymentReturn(null); setAccountOpen(false); setCheckoutPlanId(null); setAccountView('auto'); }, []);
  const openCheckout = useCallback(planId => { paymentRequest.current?.abort(); setPaymentReturn(null); setCheckoutPlanId(planId); setAccountView('checkout'); setAccountOpen(true); }, []);
  const updateMember = useCallback(data => { const member = validateMember(data); controller.current?.abort(); ++request.current; setLoading(false); setServiceError(''); setMe(member); }, []);
  const acceptLogin = useCallback(data => { const member = validateMember(data); controller.current?.abort(); ++request.current; setLoading(false); setServiceError(''); setMe(member); setAccountView(checkoutPlanId ? 'checkout' : 'auto'); }, [checkoutPlanId]);
  const logout = useCallback(async () => { paymentRequest.current?.abort(); await membershipRequest('auth/logout', { method: 'POST' }); controller.current?.abort(); ++request.current; setPaymentReturn(null); setMe(null); setAccountView('auto'); setCheckoutPlanId(null); setAccountOpen(false); await refresh(); }, [refresh]);
  const returnedOrder = me?.orders?.find(order => order.id === paymentReturn?.orderId) || (paymentReturn?.userId === me?.user?.id ? paymentReturn?.order : null);
  return <MembershipContext.Provider value={{ status, me, loading, serviceError, refresh, openAccount, closeAccount, openCheckout, accountOpen, accountView, setAccountView, checkoutPlanId, acceptLogin, updateMember, logout,
    paymentReturn: paymentReturn && { ...paymentReturn, order: returnedOrder } }}>{children}</MembershipContext.Provider>;
}

export function useMembership() {
  const value = useContext(MembershipContext);
  if (!value) throw new Error('MembershipProvider is required');
  return value;
}
