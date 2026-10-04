import { ANALYTICS_SESSION_MS, ANALYTICS_VERSION, CLIENT_ANALYTICS_EVENTS, analyticsDimensions, validAnalyticsSession } from '../../shared/analytics-schema.mjs';

const SESSION_KEY = 'better-life:analytics-session';
export function analyticsPrivacyBlocked({ navigator = globalThis.navigator, window = globalThis.window } = {}) {
  return navigator?.globalPrivacyControl === true || [navigator?.doNotTrack, window?.doNotTrack, navigator?.msDoNotTrack].some(value => value === '1' || value === 'yes');
}

export function analyticsEndpoint({ origin, basePath = '/', endpoint } = {}) {
  try {
    const current = new URL(origin);
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password || current.origin !== origin) return null;
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) return null;
    const url = new URL(endpoint || `${basePath}api/analytics/events`, `${origin}/`);
    return url.origin === origin && !url.username && !url.password && !url.search && !url.hash && url.pathname === `${basePath}api/analytics/events` ? url.href : null;
  } catch { return null; }
}

export function createAnalyticsClient({ enabled = false, origin = globalThis.location?.origin, basePath = '/', endpoint,
  fetchImpl = globalThis.fetch?.bind(globalThis), navigator = globalThis.navigator, window = globalThis.window,
  storage, crypto = globalThis.crypto, now = Date.now, timeoutMs = 2000 } = {}) {
  const url = analyticsEndpoint({ origin, basePath, endpoint });
  let memorySession = null;
  const recentlySent = new Map();
  function session() {
    let saved = memorySession;
    try { saved = JSON.parse((storage || window?.sessionStorage)?.getItem(SESSION_KEY) || 'null') || saved; } catch { /* Storage denial falls back to this tab's memory. */ }
    const time = now();
    if (!validAnalyticsSession(saved?.id) || !Number.isFinite(saved?.expires) || saved.expires <= time || saved.expires > time + ANALYTICS_SESSION_MS) {
      if (!crypto?.getRandomValues) return null;
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      saved = { id: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''), expires: time + ANALYTICS_SESSION_MS };
      try { (storage || window?.sessionStorage)?.setItem(SESSION_KEY, JSON.stringify(saved)); } catch { /* No cookie or localStorage fallback. */ }
    }
    memorySession = saved;
    return saved.id;
  }
  async function track(name, input = {}) {
    if (!enabled || !url || typeof fetchImpl !== 'function' || analyticsPrivacyBlocked({ navigator, window }) || !CLIENT_ANALYTICS_EVENTS.includes(name)) return false;
    const dimensions = analyticsDimensions(name, input), sessionId = session();
    if (!dimensions || !sessionId) return false;
    const key = JSON.stringify([sessionId, name, dimensions]), time = now();
    if (recentlySent.has(key) && time - recentlySent.get(key) < 1000) return false;
    for (const [oldKey, sentAt] of recentlySent) if (time - sentAt >= 1000) recentlySent.delete(oldKey);
    recentlySent.set(key, time);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'POST', credentials: 'omit', cache: 'no-store', keepalive: true,
        signal: controller.signal, referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: ANALYTICS_VERSION, name, sessionId, dimensions }) });
      return response.ok;
    } catch { return false; } // Statistics never block a product action or display a user error.
    finally { clearTimeout(timeout); }
  }
  return Object.freeze({ track });
}
