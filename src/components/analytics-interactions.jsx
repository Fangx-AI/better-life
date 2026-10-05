import { useEffect } from 'react';
import { useAnalytics } from './analytics.jsx';
import { analyticsDownloadFormat, trackOptionalAnalytics } from '../lib/analytics-flow.mjs';

// 只识别公开操作类型；不读取输入值、搜索词、referrer或账号数据。
export function AnalyticsInteractions({ view }) {
  const track = useAnalytics();
  useEffect(() => {
    if (!['home', 'library', 'pricing', 'guides'].includes(view)) return;
    const click = event => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || event.defaultPrevented) return;
      let url; try { url = new URL(anchor.href, window.location.origin); } catch { return; }
      const source = anchor.closest('#formats') ? 'formats' : anchor.closest('#scenes') ? 'scene' : 'navigation';
      const format = analyticsDownloadFormat(url.pathname);
      if (format) trackOptionalAnalytics(track, 'download_click', { format, source });
      if (url.origin === window.location.origin && url.searchParams.get('view') === 'library') trackOptionalAnalytics(track, 'reader_open', { source });
      if (url.origin === window.location.origin && url.searchParams.get('view') === 'pricing') trackOptionalAnalytics(track, 'pricing_open', { source });
    };
    document.addEventListener('click', click);
    return () => document.removeEventListener('click', click);
  }, [view, track]);
  return null;
}
