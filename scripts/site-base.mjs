export function publicBasePath(value = '/better-life/') {
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) throw new Error('PUBLIC_BASE_PATH 必须是 / 或 /project-name/ 形式的绝对路径。');
  return value;
}

// This is the already-public Pages entry, not an assertion that a new domain
// has been chosen, deployed or indexed.
export const DEFAULT_PUBLIC_SITE_ORIGIN = 'https://fangx-ai.github.io';
export function publicSiteConfig(env = {}) {
  const indexingValue = env.PUBLIC_INDEXING_ENABLED;
  if (indexingValue !== undefined && !['true', 'false'].includes(indexingValue)) throw new Error('PUBLIC_INDEXING_ENABLED 必须是 true 或 false。');
  const indexing = indexingValue !== 'false';
  const basePath = publicBasePath(env.PUBLIC_BASE_PATH || '/better-life/');
  let url;
  try { url = new URL(env.PUBLIC_SITE_ORIGIN || DEFAULT_PUBLIC_SITE_ORIGIN); }
  catch { throw new Error('PUBLIC_SITE_ORIGIN 必须是无路径的安全站点 origin。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !indexing) || local && indexing) throw new Error('PUBLIC_SITE_ORIGIN 必须是 HTTPS origin；本机 HTTP 仅允许 noindex 预演。');
  // A local root-path build changes resource URLs, not the already-public Pages
  // identity. Only an explicit public origin may select a different canonical base.
  const canonicalBase = env.PUBLIC_SITE_ORIGIN ? basePath : '/better-life/';
  return Object.freeze({ origin: url.origin, basePath, siteUrl: `${url.origin}${canonicalBase}`, indexing });
}
