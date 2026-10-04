import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { publicSiteConfig } from './site-base.mjs';

const marker = /<!-- better-life:seo:start -->[\s\S]*?<!-- better-life:seo:end -->/;
const escaped = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function seoArtifacts(env = {}) {
  const config = publicSiteConfig(env), { siteUrl, basePath, indexing } = config;
  const publicUrls = [siteUrl, `${siteUrl}?view=library`, `${siteUrl}?view=pricing`];
  const structured = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: '高性价比人生指南 · Better Life', url: siteUrl, inLanguage: 'zh-CN' }).replaceAll('<', '\\u003c');
  const head = `<!-- better-life:seo:start -->
  <meta name="robots" content="${indexing ? 'index,follow' : 'noindex,nofollow'}" />
  <meta name="better-life:public-site-url" content="${escaped(siteUrl)}" />
  <meta name="better-life:indexing" content="${indexing}" />
  <meta property="og:url" content="${escaped(siteUrl)}" />
  <meta property="og:image" content="${escaped(`${siteUrl}media/hero-background.webp`)}" />
  <link rel="canonical" href="${escaped(siteUrl)}" />
  <script type="application/ld+json">${structured}</script>
  <!-- better-life:seo:end -->`;
  // noindex remains a meta directive. Do not block the preview document from
  // crawling and thereby prevent a crawler from seeing that directive.
  const robots = `User-agent: *\nAllow: ${basePath}\nDisallow: ${basePath}api/\n${basePath === '/' ? '' : 'Disallow: /api/\n'}${indexing ? `Sitemap: ${siteUrl}sitemap.xml\n` : '# Preview build: pages carry noindex; no sitemap is advertised.\n'}`;
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${indexing ? publicUrls.map(url => `<url><loc>${escaped(url)}</loc></url>`).join('') : ''}</urlset>\n`;
  return { config, head, robots, sitemap };
}

export function replaceSeoHead(html, env = {}) {
  if (!marker.test(html)) throw new Error('首页缺少 SEO 生成区标记，未覆盖 HTML。');
  return html.replace(marker, () => seoArtifacts(env).head);
}

export function writeSeoArtifacts(root, env = {}) {
  const artifacts = seoArtifacts(env);
  const indexFile = resolve(root, 'index.html');
  const html = replaceSeoHead(readFileSync(indexFile, 'utf8'), env);
  const publicDir = resolve(root, 'public'); mkdirSync(publicDir, { recursive: true });
  writeFileSync(indexFile, html);
  for (const directory of [root, publicDir]) {
    writeFileSync(resolve(directory, 'robots.txt'), artifacts.robots);
    writeFileSync(resolve(directory, 'sitemap.xml'), artifacts.sitemap);
  }
  return artifacts.config;
}
