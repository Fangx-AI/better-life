import { useCallback, useEffect } from 'react';
import { createAnalyticsClient } from '../lib/analytics.mjs';

let client;
function browserClient() {
  client ??= createAnalyticsClient({ enabled: import.meta.env.VITE_ANALYTICS_ENABLED === 'true', basePath: import.meta.env.BASE_URL || '/' });
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
