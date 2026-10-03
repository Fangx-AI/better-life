import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, parseChapter } from '../scripts/content.mjs';
import { matchesEntry, plainText } from '../assets/search.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = loadCorpus(root);
const entries = corpus.chapters.flatMap(c => c.entries);
test('快照包含全部章节和条目', () => {
  assert.equal(corpus.counts.chapters, 34);
  assert.equal(corpus.counts.entries, 650);
  assert.equal(entries.filter(e => e.grade === 'A').length, 428);
});
test('CRLF 和 LF 解析一致', () => {
  const file = corpus.chapters[0].file;
  const text = readFileSync(resolve(root, 'library/book', file), 'utf8');
  assert.deepEqual(parseChapter(text.replace(/\r?\n/g, '\r\n'), file), parseChapter(text.replace(/\r?\n/g, '\n'), file));
});
test('来源、摘要、成本与原文逐字一致', () => {
  for (const c of corpus.chapters) {
    const raw = readFileSync(resolve(root, 'library/book', c.file), 'utf8');
    for (const e of c.entries) for (const key of ['summary', 'sources', 'benefit', 'cost']) assert.ok(raw.includes(e[key]), `${e.id}: ${key}`);
  }
});
test('检索、章节和等级可以组合', () => {
  const state = { q: '离职', chapter: '19', grade: 'A', free: false, saved: false };
  const found = entries.filter(e => matchesEntry(e, state, new Set()));
  assert.ok(found.length > 0);
  assert.ok(found.every(e => e.chapter === 19 && e.grade === 'A'));
  assert.equal(entries.filter(e => matchesEntry(e, { ...state, q: '不存在的检索词XYZ' }, new Set())).length, 0);
});
test('免费筛选与收藏筛选', () => {
  const e = entries.find(e => e.tags['钱'] === '0');
  const state = { q: '', chapter: '', grade: '', free: true, saved: true };
  assert.equal(matchesEntry(e, state, new Set([e.id])), true);
  assert.equal(matchesEntry(e, state, new Set()), false);
});
test('Markdown 展示文字和章节锚点', () => {
  assert.equal(plainText('**说明** [长文](docs/示例.md)'), '说明 长文');
  assert.equal(new Set(entries.map(e => e.id)).size, 650);
});
test('证据等级的附加说明不会丢失', () => {
  const e = entries.find(e => e.id === '5-14');
  assert.equal(e.grade, 'C');
  assert.equal(e.gradeText, 'C（争议）');
});
test('README 中的图片和本地入口存在', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
  links.push(...[...readme.matchAll(/src="([^"]+)"/g)].map(m => m[1]));
  for (const link of links) if (!/^https?:|^#/.test(link)) assert.ok(existsSync(resolve(root, link.split('#')[0])), link);
});
