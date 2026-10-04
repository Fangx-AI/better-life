const pages = {
  home: { title: '高性价比人生指南 · Better Life — 省钱、避坑、少走弯路', description: '学校没教，生活会考。结合原书直接提问，把好建议变成自己的生活。650 条生活建议，34 个主题，免费阅读与下载 PDF。' },
  library: { title: '阅读人生指南 · Better Life', description: '按章节阅读 650 条生活建议：工作、省钱、住房等 34 个主题。查看适用条件、限制和原始出处，搜索与收藏仅在本机使用。' },
  pricing: { title: '会员方案与价格 · Better Life', description: '查看 Better Life 免费使用、月度与年度会员的价格、提问额度和个人指南功能。登录与付款以本站实际开放状态为准。' },
  guides: { title: '我的人生指南 · Better Life', description: '登录后查看和整理属于自己的个人指南。私人内容不公开。' },
  operations: { title: '运营后台 · Better Life', description: '仅限获授权运营者访问。' },
  privacy: { title: '隐私说明 · Better Life', description: '了解账号、问答、保存内容与订单信息的使用方式。' },
  terms: { title: '服务说明 · Better Life', description: '了解免费内容、会员权益与售后申请方式。' },
};

export function routeMetadata({ view = 'home', siteUrl, indexing = true, currentOrigin } = {}) {
  const page = pages[view] || pages.home;
  let url;
  try { url = new URL(siteUrl); } catch { return { ...page, canonical: null, robots: 'noindex,nofollow' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return { ...page, canonical: null, robots: 'noindex,nofollow' };
  const privatePage = ['guides', 'operations', 'privacy', 'terms'].includes(view);
  if (view === 'library' || view === 'pricing') url.searchParams.set('view', view);
  return { ...page, canonical: privatePage ? null : url.href, robots: indexing && !privatePage && (!currentOrigin || currentOrigin === url.origin) ? 'index,follow' : 'noindex,nofollow' };
}

export function applyRouteMetadata({ document = globalThis.document, location = globalThis.location, view = 'home' } = {}) {
  if (!document?.head) return null;
  const siteUrl = document.querySelector('meta[name="better-life:public-site-url"]')?.content;
  const indexing = document.querySelector('meta[name="better-life:indexing"]')?.content === 'true';
  const metadata = routeMetadata({ view, siteUrl, indexing, currentOrigin: location?.origin });
  function meta(selector, attr, value) {
    let element = document.querySelector(selector);
    if (value === null) { element?.remove(); return; }
    if (!element) {
      element = document.createElement('meta');
      const match = /\[(name|property)="([^"]+)"\]/.exec(selector); element.setAttribute(match[1], match[2]); document.head.append(element);
    }
    element.setAttribute(attr, value);
  }
  document.title = metadata.title;
  meta('meta[name="description"]', 'content', metadata.description);
  meta('meta[name="robots"]', 'content', metadata.robots);
  meta('meta[property="og:title"]', 'content', metadata.title);
  meta('meta[property="og:description"]', 'content', metadata.description);
  meta('meta[property="og:url"]', 'content', metadata.canonical);
  let canonical = document.querySelector('link[rel="canonical"]');
  if (!metadata.canonical) canonical?.remove();
  else { if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); } canonical.href = metadata.canonical; }
  return metadata;
}
