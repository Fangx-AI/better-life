import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSiteConfig } from '../scripts/site-base.mjs';
import { seoArtifacts, replaceSeoHead } from '../scripts/seo.mjs';
import { routeMetadata } from '../src/lib/site-metadata.mjs';

test('SEO: preserve the already-public Pages canonical; explicit domain/base paths replace it everywhere', () => {
  const defaults = seoArtifacts();
  assert.equal(defaults.config.siteUrl, 'https://fangx-ai.github.io/better-life/');
  assert.match(defaults.head, /name="robots" content="index,follow"/);
  const localRoot = seoArtifacts({ PUBLIC_BASE_PATH: '/' });
  assert.equal(localRoot.config.basePath, '/');
  assert.equal(localRoot.config.siteUrl, 'https://fangx-ai.github.io/better-life/');
  assert.match(localRoot.sitemap, /https:\/\/fangx-ai.github.io\/better-life\//);
  const custom = seoArtifacts({ PUBLIC_SITE_ORIGIN: 'https://better-life.example.test', PUBLIC_BASE_PATH: '/' });
  assert.match(custom.head, /rel="canonical" href="https:\/\/better-life.example.test\/"/);
  assert.match(custom.robots, /Sitemap: https:\/\/better-life.example.test\/sitemap.xml/);
  assert.match(custom.sitemap, /https:\/\/better-life.example.test\/\?view=library/);
  assert.match(custom.sitemap, /https:\/\/better-life.example.test\/\?view=pricing/);
  for (const text of [custom.head, custom.robots, custom.sitemap]) assert.ok(!text.includes('fangx-ai.github.io'));
  assert.ok(!/guides|checkout|payment|q=|saved=|#entry|lastmod/.test(custom.sitemap));
  assert.match(custom.head, /media\/hero-background.webp/);
});

test('SEO: noindex rehearsals have no advertised sitemap, without falsely blocking noindex discovery', () => {
  const preview = seoArtifacts({ PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:4300', PUBLIC_BASE_PATH: '/', PUBLIC_INDEXING_ENABLED: 'false' });
  assert.match(preview.head, /content="noindex,nofollow"/);
  assert.ok(!preview.robots.includes('Sitemap:'));
  assert.ok(!preview.robots.includes('Disallow: /\n'));
  assert.ok(!preview.sitemap.includes('<url>'));
});

test('SEO: unsafe domain/base/indexing settings fail before emitting credentials or HTML', () => {
  for (const value of ['https://user:secret@example.test', 'https://example.test/path', 'https://example.test?token=private', 'https://example.test#private', 'javascript:alert(1)', 'http://example.test', 'https://localhost']) assert.throws(() => publicSiteConfig({ PUBLIC_SITE_ORIGIN: value }), /PUBLIC_SITE_ORIGIN/);
  assert.throws(() => publicSiteConfig({ PUBLIC_INDEXING_ENABLED: 'yes' }), /PUBLIC_INDEXING_ENABLED/);
  assert.throws(() => publicSiteConfig({ PUBLIC_BASE_PATH: '/unsafe?secret=/' }), /PUBLIC_BASE_PATH/);
  assert.throws(() => publicSiteConfig({ PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:4300' }), /PUBLIC_SITE_ORIGIN/);
});

test('SEO: generated head is idempotent and leaves the app entry/design intact', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const env = { PUBLIC_SITE_ORIGIN: 'https://better-life.example.test', PUBLIC_BASE_PATH: '/preview/' };
  const first = replaceSeoHead(html, env);
  assert.equal(replaceSeoHead(first, env), first);
  assert.equal((first.match(/rel="canonical"/g) || []).length, 1);
  assert.match(first, /src="\/src\/main.jsx"/); assert.match(first, /<div id="root"><\/div>/);
  assert.throws(() => replaceSeoHead('<html></html>'), /SEO 生成区/);
});

test('SEO: route canonicals never carry private search/hash/payment params; personal guides are noindex', () => {
  const siteUrl = 'https://better-life.example.test/better-life/';
  assert.equal(routeMetadata({ view: 'library', siteUrl }).canonical, `${siteUrl}?view=library`);
  assert.equal(routeMetadata({ view: 'pricing', siteUrl }).canonical, `${siteUrl}?view=pricing`);
  assert.equal(routeMetadata({ view: 'guides', siteUrl }).canonical, null);
  assert.equal(routeMetadata({ view: 'guides', siteUrl }).robots, 'noindex,nofollow');
  for (const view of ['operations', 'privacy', 'terms']) {
    assert.equal(routeMetadata({ view, siteUrl }).canonical, null);
    assert.equal(routeMetadata({ view, siteUrl }).robots, 'noindex,nofollow');
  }
  assert.equal(routeMetadata({ view: 'home', siteUrl, currentOrigin: 'http://localhost:5173' }).robots, 'noindex,nofollow');
  assert.equal(routeMetadata({ view: 'home', siteUrl, indexing: false }).robots, 'noindex,nofollow');
  for (const value of ['https://u:secret@example.test/', 'https://example.test/?q=private', 'https://example.test/#private', 'javascript:alert(1)', undefined]) assert.equal(routeMetadata({ siteUrl: value }).canonical, null);
});
