import test from 'node:test';
import assert from 'node:assert/strict';
import { readGuideLocation, entryLocationHref, guideLocationHref, readAppView } from '../src/lib/guide-location.mjs';
const corpus = { chapters: [{ id: 15, entries: [{ id: '15-1', chapter: 15 }] }, { id: 19, entries: [] }] };
test('library hash, entry links, old filters and ordinary landing anchors resolve consistently', () => {
  assert.equal(readGuideLocation({ search: '', hash: '#library' }, corpus).browsing, true);
  assert.equal(readGuideLocation({ search: '?utm_source=test', hash: '#scenes' }, corpus).browsing, false);
  const result = readGuideLocation({ search: '?q=离职&chapter=19&free=1', hash: '#entry-15-1' }, corpus);
  assert.equal(result.entry.id, '15-1');
  assert.deepEqual(result.filters, { q: '', chapter: '15', free: false, saved: false });
  assert.equal(readGuideLocation({ search: '?chapter=999', hash: '#library' }, corpus).filters.chapter, '');
  assert.equal(readGuideLocation({ search: '?grade=A', hash: '' }, corpus).browsing, true);
  assert.equal(readGuideLocation({ search: '', hash: '#entry-nope' }, corpus).entry, null);
});
test('canonical share URLs always open the selected entry and cannot carry stale filters', () => {
  const href = entryLocationHref('/better-life/', { id: '15-1', chapter: 15 });
  assert.equal(href, '/better-life/?view=library&chapter=15#entry-15-1');
  const url = new URL(href, 'https://example.test');
  assert.equal(readGuideLocation(url, corpus).entry.id, '15-1');
  assert.equal(guideLocationHref('/', { q: '押金', free: true }), '/?view=library&q=%E6%8A%BC%E9%87%91&free=1');
});

test('dedicated library URLs are explicit and work with root and Pages base paths', () => {
  for (const base of ['/', '/better-life/']) {
    assert.equal(guideLocationHref(base), `${base}?view=library`);
    const url = new URL(guideLocationHref(base, { chapter: '15', free: true, saved: true }), 'https://example.test');
    assert.equal(url.pathname, base);
    assert.equal(readAppView(url), 'library');
    assert.deepEqual(readGuideLocation(url, corpus).filters, { q: '', chapter: '15', free: true, saved: true });
    assert.equal(url.hash, '');
  }
});

test('legacy bookmarks enter the library without changing marketing landing anchors', () => {
  for (const suffix of ['#library', '#entry-15-1', '?q=押金', '?chapter=19', '?saved=1', '?free=1', '?grade=B']) {
    assert.equal(readAppView(new URL(`https://example.test/better-life/${suffix}`)), 'library', suffix);
  }
  for (const suffix of ['', '#scenes', '#formats', '#answer-example', '?utm_source=share', '?view=unknown']) {
    assert.equal(readAppView(new URL(`https://example.test/${suffix}`)), 'home', suffix);
  }
});

test('account-owned pages retain precedence over old book filters and entry hashes', () => {
  for (const view of ['guides', 'pricing']) {
    const url = new URL(`https://example.test/?view=${view}&chapter=15&q=押金#entry-15-1`);
    assert.equal(readAppView(url), view);
  }
});

test('missing entry detection waits for actual corpus and never invents a book entry', () => {
  const url = new URL('https://example.test/?view=library&chapter=999#entry-999-1');
  assert.equal(readAppView(url), 'library');
  assert.equal(readGuideLocation(url).missingEntry, false);
  const route = readGuideLocation(url, corpus);
  assert.equal(route.entry, null);
  assert.equal(route.missingEntry, true);
  assert.equal(route.filters.chapter, '');
  assert.equal(readGuideLocation(new URL('https://example.test/#entry-15-1'), corpus).missingEntry, false);
});

test('canonical links drop stale grade and private route parameters while encoding search text', () => {
  const href = guideLocationHref('/better-life/', { q: '押金 & #下一步', chapter: '15', grade: 'B', view: 'guides', guide: 'private-id' });
  const url = new URL(href, 'https://example.test');
  assert.equal(url.searchParams.get('q'), '押金 & #下一步');
  assert.equal(url.searchParams.get('view'), 'library');
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.has('grade'), false);
  assert.equal(url.searchParams.has('guide'), false);
});

test('homepage renders only reading entrances, never the complete clause search list', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /id="library"|<ExpandableCards|className="browse-controls"/);
  assert.match(app, /const libraryHref = guideLocationHref\(base\)/);
  assert.match(app, /as="a" href=\{guideLocationHref\(base,/);
  assert.match(main, /view === 'library' \? <LibraryPage/);
});
