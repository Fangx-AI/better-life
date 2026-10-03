import test from 'node:test';
import assert from 'node:assert/strict';
import { readGuideLocation, entryLocationHref, guideLocationHref } from '../src/lib/guide-location.mjs';
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
  assert.equal(href, '/better-life/?chapter=15#entry-15-1');
  const url = new URL(href, 'https://example.test');
  assert.equal(readGuideLocation(url, corpus).entry.id, '15-1');
  assert.equal(guideLocationHref('/', { q: '押金', free: true }), '/?q=%E6%8A%BC%E9%87%91&free=1#library');
});
