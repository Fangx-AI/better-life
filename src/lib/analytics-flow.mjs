import { CLIENT_ANALYTICS_EVENTS, analyticsDimensions } from '../../shared/analytics-schema.mjs';

// These helpers accept only fixed product states; never supply account/order/body data.
export function trackOptionalAnalytics(track, name, input = {}) {
  try {
    if (!CLIENT_ANALYTICS_EVENTS.includes(name)) return;
    const dimensions = analyticsDimensions(name, input); if (!dimensions) return;
    Promise.resolve(track(name, dimensions)).catch(() => {});
  } catch { /* Optional statistics never block the product. */ }
}

export function createQaAnalyticsAttempt(track, kind, signal) {
  if (!['public', 'personal'].includes(kind)) throw new Error('Invalid question kind');
  let started = false, reported = false, disposed = false;
  const result = outcome => {
    if (!started || reported || disposed || !['success', 'unavailable', 'error', 'cancelled'].includes(outcome)) return;
    reported = true; trackOptionalAnalytics(track, 'qa_result', { kind, outcome });
  };
  const aborted = () => result('cancelled');
  return {
    start() {
      if (started || disposed) return;
      started = true; trackOptionalAnalytics(track, 'qa_submit', { kind });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    },
    result,
    dispose() { result('cancelled'); disposed = true; signal?.removeEventListener('abort', aborted); },
  };
}

// Each authenticated return lookup has one terminal display-state event. Neither
// the URL locator nor cancellation/response details become statistics or revenue.
export function createCheckoutReturnAnalyticsAttempt(track, signal) {
  let reported = false, disposed = false;
  const result = outcome => {
    if (reported || disposed || !['success', 'unavailable', 'error', 'cancelled'].includes(outcome)) return;
    reported = true; trackOptionalAnalytics(track, 'checkout_return', { outcome });
  };
  const aborted = () => result('cancelled'); signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  return { result, dispose() { result('cancelled'); disposed = true; signal?.removeEventListener('abort', aborted); } };
}

// A browser return is not a revenue event. Only a checked server order supplies this state.
export function checkoutReturnOutcome(status) {
  if (status === 'paid') return 'success';
  if (status === 'refunded') return 'cancelled';
  if (status === 'failed') return 'error';
  return 'unavailable';
}

export function analyticsDownloadFormat(pathname = '') {
  if (pathname.endsWith('.pdf')) return 'pdf';
  if (pathname.endsWith('better-life-obsidian.zip')) return 'obsidian';
  if (pathname.endsWith('.epub')) return 'epub';
  // Do not classify arbitrary site HTML pages as downloads.
  if (pathname.endsWith('/HowToLiveBetter.html')) return 'html';
  return null;
}
