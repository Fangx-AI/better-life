import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'public/share-kit');
const read = file => readFileSync(resolve(directory, file), 'utf8');
const kit = JSON.parse(read('content.json'));
const corpus = JSON.parse(readFileSync(resolve(root, 'public/content.json'), 'utf8'));
const entries = new Map(corpus.chapters.flatMap(chapter => chapter.entries.map(entry => [entry.id, { ...entry, chapterTitle: chapter.title }])));
const site = 'https://fangx-ai.github.io/better-life/';
const unescape = value => value.replaceAll('&amp;', '&');

test('share kit: exactly three finished cards use genuine snapshot IDs, titles, original sources and complete conditions', () => {
  assert.equal(kit.schemaVersion, 1);
  assert.equal(kit.status, 'prepared-not-published');
  assert.equal(kit.cards.length, 3);
  assert.deepEqual(kit.cards.map(card => card.id), ['rent-deposit', 'leaving-job', 'spending-pause']);
  assert.equal(kit.counts.entries, corpus.counts.entries); assert.equal(kit.counts.entries, 650);
  assert.equal(kit.counts.themes, corpus.counts.chapters); assert.equal(kit.counts.themes, 34);
  assert.equal(kit.attribution.revision, corpus.source.revision);
  assert.equal(kit.attribution.snapshotDate, corpus.source.snapshotDate);
  for (const card of kit.cards) {
    const html = read(card.file);
    assert.match(html, /<!doctype html>/i);
    assert.match(html, new RegExp(`data-card-id="${card.id}"`));
    assert.equal((html.match(/class="action-number"/g) || []).length, 3);
    const htmlIds = [...new Set([...html.matchAll(/data-source-id="([\d-]+)"/g)].map(match => match[1]))];
    assert.deepEqual(htmlIds.sort(), [...card.sourceIds].sort());
    assert.deepEqual(card.sources.map(source => source.id), card.sourceIds);
    for (const source of card.sources) {
      const original = entries.get(source.id);
      assert.ok(original, `missing real entry ${source.id}`);
      assert.equal(source.chapter, original.chapter); assert.equal(source.number, original.number);
      assert.equal(source.title, original.title); assert.equal(source.chapterTitle, original.chapterTitle);
      assert.equal(source.originalSources, original.sources); assert.equal(source.originalConditions, original.notes);
      assert.equal(source.readingUrl, `${site}?view=library&chapter=${source.chapter}#entry-${source.id}`);
      assert.ok(unescape(html).includes(source.readingUrl), `missing source link ${source.id}`);
    }
  }
});

test('share kit: every image-ready page carries CC BY attribution, adaptation notice, exact version and real public project backlinks', () => {
  assert.equal(kit.publicSiteUrl, site);
  assert.equal(kit.attribution.author, 'eternity4719'); assert.equal(kit.attribution.title, '高性价比人生指南');
  assert.equal(kit.attribution.license, 'CC BY 4.0'); assert.equal(kit.attribution.unofficial, true);
  for (const file of ['index.html', ...kit.cards.map(card => card.file)]) {
    const html = read(file);
    for (const text of ['《高性价比人生指南》', 'eternity4719', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', 'https://github.com/eternity4719/HowToLiveBetter', corpus.source.revision, corpus.source.snapshotDate, '摘编', '重排', '非原作者官方版本', site]) assert.ok(html.includes(text), `${file} lacks ${text}`);
    assert.match(html, /650 条建议/); assert.match(html, /34 个主题/); assert.match(html, /原书免费/);
    assert.match(html, /name="robots" content="noindex,follow"/);
    for (const [, raw] of html.matchAll(/href="([^"]+)"/g)) {
      const href = unescape(raw);
      if (href.startsWith('./')) continue;
      const url = new URL(href);
      assert.equal(url.protocol, 'https:'); assert.equal(url.username, ''); assert.equal(url.password, '');
      assert.ok(['fangx-ai.github.io', 'github.com', 'creativecommons.org'].includes(url.hostname));
      if (url.hostname === 'fangx-ai.github.io') {
        assert.equal(url.pathname, '/better-life/');
        for (const name of url.searchParams.keys()) assert.ok(['view', 'chapter'].includes(name));
        if (url.search) assert.equal(url.searchParams.get('view'), 'library');
        if (url.hash) assert.match(url.hash, /^#entry-\d+-\d+$/);
      }
    }
  }
});

test('share kit: essential exceptions remain visible without public grade labels, fake outcomes or unsupported member/AI sales claims', () => {
  const rent = read('rent-deposit.html'), job = read('leaving-job.html'), money = read('spending-pause.html');
  assert.match(rent, /押金多少、什么时候退、什么情况能扣/);
  assert.match(rent, /本人不到场，留书面授权/); assert.match(rent, /原房东书面同意/);
  assert.match(rent, /中介不能代收代付房租和押金/); assert.match(rent, /留证不等于押金一定退回/);
  assert.match(job, /自己的劳动关系材料/); assert.match(job, /不带走公司源码、客户名单或技术文档/);
  assert.match(job, /如果不是你主动辞职/); assert.match(job, /不保证都有补偿/);
  assert.match(job, /合同期限、离职日期、岗位、工作年限/);
  assert.match(money, /非必需大件，等 24 小时/); assert.match(money, /经验做法，没有统一省钱比例/);
  assert.match(money, /保质期长、确定会用完/); assert.match(money, /年付和月付价格/);
  for (const html of [rent, job, money]) {
    assert.doesNotMatch(html, /证据等级|A\s*\/\s*B\s*\/\s*C|保证省下|保证胜诉|退款必成|已开通会员|立即购买|会员已上线|真实模型已接通|万人使用|已发布到小红书/);
  }
});

test('share kit: plain offline HTML/CSS uses existing local brand/font assets; no scripts, API calls, tracking, credentials or data entry', () => {
  const files = readdirSync(directory);
  assert.deepEqual(files.sort(), ['content.json', 'index.html', 'leaving-job.html', 'rent-deposit.html', 'share-kit.css', 'spending-pause.html'].sort());
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /<script\b|<iframe\b|<form\b|<input\b|<textarea\b|on(?:click|load|error)\s*=|fetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|\/api\/|Bearer\s|(?:sk-|sk_)[A-Za-z0-9_-]{16,}|(?:API_KEY|APPSECRET|AUTH_SECRET|OPERATIONS_SECRET)\s*[:=]/i, file);
    if (file.endsWith('.html')) {
      assert.match(text, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
      assert.match(text, /href="\.\/share-kit\.css"/);
      assert.match(text, /src="\.\.\/media\/brand\.webp"/);
      for (const [, url] of text.matchAll(/(?:src|href)="((?:\.\.\/|\.\/)[^"]+)"/g)) assert.ok(existsSync(resolve(dirname(resolve(directory, file)), url)), `${file}: missing ${url}`);
    }
  }
  const css = read('share-kit.css');
  assert.doesNotMatch(css, /@import|https?:\/\//);
  assert.match(css, /url\('\.\.\/fonts\/display-900\.ttf'\)/);
  assert.ok(existsSync(resolve(directory, '../fonts/display-900.ttf')));
  assert.match(css, /@media\(max-width:640px\)/); assert.match(css, /@media\(max-width:350px\)/); assert.match(css, /@media print/);
  assert.match(css, /max-width:100%/); assert.match(css, /overflow-wrap:anywhere/);
});

test('share kit: launch copy provides both platform drafts per card and states prepared/non-deployed/non-published boundaries', () => {
  const doc = readFileSync(resolve(root, 'docs/LAUNCH-CONTENT.md'), 'utf8');
  assert.equal((doc.match(/\*\*小红书标题：\*\*/g) || []).length, 3);
  assert.equal((doc.match(/\*\*小红书正文（可直接复制）：\*\*/g) || []).length, 3);
  assert.equal((doc.match(/\*\*朋友圈配文：\*\*/g) || []).length, 3);
  for (const card of kit.cards) assert.ok(doc.includes(`public/share-kit/${card.file}`));
  assert.match(doc, /尚未发布到小红书、朋友圈或任何外部账号/);
  assert.match(doc, /新分享页本身尚未公开部署/);
  assert.match(doc, /不宣传会员已真实开售/);
  assert.ok(doc.includes(site));
  assert.ok(doc.includes(corpus.source.revision));
});
