import { useCallback, useEffect } from 'react';
import { createAnalyticsClient } from '../lib/analytics.mjs';
import { publicAnalyticsEnabled } from '../lib/public-mode.mjs';

let client;
function browserClient() {
  client ??= createAnalyticsClient({ enabled: publicAnalyticsEnabled(import.meta.env.VITE_ANALYTICS_ENABLED), basePath: import.meta.env.BASE_URL || '/' });
  return client;
}
export function useAnalytics() {
  return useCallback((name, dimensions = {}) => { void browserClient().track(name, dimensions); }, []);
}
export function AnalyticsPageView({ view }) {
  const track = useAnalytics();
  useEffect(() => { if (['home', 'library', 'pricing', 'guides'].includes(view)) track('page_view', { view }); }, [track, view]);
  return null;
}
