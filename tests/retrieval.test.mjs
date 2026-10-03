import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { retrieveEntries } from '../server/retrieval.mjs';
import { retrieveEntries as baseline } from './fixtures/retrieval-baseline.mjs';
import { retrievalCases, unsupportedCases } from './fixtures/retrieval-cases.mjs';
import { evaluateRetrieval } from '../scripts/retrieval-eval.mjs';

const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
const originalEntries = new Map(corpus.chapters.flatMap(chapter => chapter.entries.map(entry => [entry.id, entry])));

test('50条生活问法的人工相关性标注仅引用真实原书，不把章节命中冒充条目精度', () => {
  assert.ok(retrievalCases.length >= 50);
  assert.ok(unsupportedCases.length >= 10);
  for (const item of retrievalCases) {
    assert.ok(item.question && item.relevant.length && item.anchors.length, item.id);
    for (const id of item.relevant) assert.ok(originalEntries.has(id), `${item.id}: ${id}`);
    for (const id of item.anchors) assert.ok(item.relevant.includes(id), `${item.id}: anchor ${id}`);
  }
});

test('金标问法核心条目Hit@6全覆盖，每条返回不超过六项且无重复', () => {
  for (const item of retrievalCases) {
    const entries = retrieveEntries(corpus, item.question);
    const ids = entries.map(entry => entry.id);
    assert.ok(entries.length <= 6, item.id);
    assert.equal(new Set(ids).size, entries.length, item.id);
    assert.ok(item.anchors.some(id => ids.includes(id)), `${item.id}: ${ids}`);
    if (item.allAnchors) for (const id of item.allAnchors) assert.ok(ids.includes(id), `${item.id}: missing ${id}`);
  }
});

test('可复现评估：比冻结旧版提高核心命中率和实际返回条目精度', () => {
  const previous = evaluateRetrieval(baseline, corpus).metrics;
  const current = evaluateRetrieval(retrieveEntries, corpus).metrics;
  assert.ok(current.hitAt6 >= 0.95, JSON.stringify(current));
  assert.ok(current.relevantTop1 >= 0.95, JSON.stringify(current));
  assert.ok(current.precisionOfReturned >= 0.9, JSON.stringify(current));
  assert.ok(current.hitAt6 - previous.hitAt6 >= 0.25);
  assert.ok(current.precisionOfReturned - previous.precisionOfReturned >= 0.25);
  assert.equal(current.unsupportedEmpty, current.unsupportedCases);
});

test('书外预测、代码、烹饪和图片操作不硬凑生活条目', () => {
  for (const question of unsupportedCases) assert.deepEqual(retrieveEntries(corpus, question), [], question);
});

test('原单轮自然中文关键场景和条目回归仍保留', () => {
  for (const [question, chapter, anchor] of [
    ['离职后社保怎么办', 19, '7-18'],
    ['房东不退押金怎么办', 15, '15-1'],
    ['我最近总是睡不着', 2, '2-13'],
    ['老人跌倒怎么办', 17, '13-2'],
    ['怀孕了要做什么检查', 27, '27-2'],
  ]) {
    const entries = retrieveEntries(corpus, question);
    assert.ok(entries.some(entry => entry.chapter === chapter), question);
    assert.ok(entries.some(entry => entry.id === anchor), question);
    for (const entry of entries) {
      const original = originalEntries.get(entry.id);
      for (const field of ['title', 'summary', 'benefit', 'notes', 'cost', 'grade', 'sources']) assert.equal(entry[field], original[field], `${entry.id}.${field}`);
      assert.ok(entry.chapterTitle && entry.chapterFile);
    }
  }
});

test('省钱、存钱自然表达不会被工资金额或跨词二元组带偏', () => {
  for (const question of ['省钱', '怎么存钱', '月薪6000如何攒下钱', '想每个月攒点钱', '日常花销太大怎样节约用钱']) {
    const entries = retrieveEntries(corpus, question);
    assert.ok(entries.some(entry => entry.id === '5-27'), question);
    assert.ok(entries.every(entry => [5, 7].includes(entry.chapter)), question);
    assert.ok(!entries.some(entry => /婴儿|电诈/.test(entry.title)), question);
  }
});

test('原词BM25兜底保留词典外原书主题，但不能被天气上下文一律排除', () => {
  assert.ok(retrieveEntries(corpus, '低钠盐值得换吗').some(entry => entry.id === '2-9'));
  assert.ok(retrieveEntries(corpus, '高温天气中暑了先做什么').some(entry => entry.id === '13-22'));
  assert.ok(retrieveEntries(corpus, '山里被蛇咬了怎么办').some(entry => entry.id === '13-29'));
});

test('小语料明确领域也可召回规范词，不依赖特定原标题和650条数据规模', () => {
  const tiny = { chapters: [
    { id: 2, title: '睡眠', file: '02-sleep.md', entries: [{ id: '2-13', chapter: 2, title: '睡眠建议', summary: '睡眠注意事项', benefit: '改善睡眠', notes: '' }] },
    { id: 15, title: '租房', file: '15-renting.md', entries: Array.from({ length: 5 }, (_, index) => ({ id: `15-${index + 1}`, chapter: 15, title: `租房事项${index + 1}`, summary: '租房押金事项', notes: '' })) },
  ] };
  assert.equal(retrieveEntries(tiny, '睡眠怎么办')[0]?.id, '2-13');
  assert.equal(retrieveEntries(tiny, '总是睡不着')[0]?.id, '2-13');
  assert.deepEqual(retrieveEntries(tiny, '明天比特币会涨吗'), []);
  assert.deepEqual(retrieveEntries(tiny, '火星殖民飞船引擎XYZ'), []);
});

test('数量限制、空输入和原书对象不变', () => {
  const before = JSON.stringify(corpus);
  for (const [limit, expected] of [[0, 0], [-1, 0], [1, 1], [2.9, 2], [99, 6], [NaN, 6]]) assert.equal(retrieveEntries(corpus, '省钱', { limit }).length, expected);
  assert.deepEqual(retrieveEntries(corpus, ''), []);
  assert.deepEqual(retrieveEntries(corpus, '  '), []);
  assert.deepEqual(retrieveEntries({ chapters: [] }, '省钱'), []);
  assert.equal(JSON.stringify(corpus), before);
});
