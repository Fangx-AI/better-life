import test from 'node:test';
import assert from 'node:assert/strict';
import { readGuideFilters, guideFilterParams, matchesGuideEntry } from '../src/lib/guide-filters.mjs';

test('旧等级链接只保留用户需要的筛选，URL 不再包含等级', () => {
  const state = readGuideFilters('?chapter=5&grade=B&q=合同&free=1&saved=1');
  assert.deepEqual(state, { q: '合同', chapter: '5', free: true, saved: true });
  assert.equal(guideFilterParams({ ...state, grade: 'B' }).has('grade'), false);
  assert.equal(guideFilterParams(state).get('chapter'), '5');
});
test('已有页面状态也不能产生隐藏等级筛选，分级原始数据保留', () => {
  for (const grade of ['A', 'B', 'C']) {
    const entry = { id: `5-${grade}`, title: '押金合同', chapter: 5, grade, tags: { 钱: '0' } };
    const state = { q: '合同', chapter: '5', free: false, saved: false, grade: 'B' };
    assert.equal(matchesGuideEntry(entry, state, new Set()), true);
    assert.equal(entry.grade, grade);
    assert.equal(matchesGuideEntry(entry, { ...state, saved: true }, new Set()), false);
    assert.equal(matchesGuideEntry(entry, { ...state, free: true, saved: true }, new Set([entry.id])), true);
  }
});
