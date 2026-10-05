import test from 'node:test';
import assert from 'node:assert/strict';
import { answerGuide } from '../src/lib/answer-guide.mjs';

const result = { status: 'answered', answer: { intro: '先留好材料。', steps: [{ title: '保存合同（B级）', detail: '需要注意适用条件。', entryIds: ['19-8'] }], caveat: '这是整理，不是原文逐字回答。' }, sources: [{ id: '19-8', chapter: 19 }], snapshotDate: '2026-10-03' };
test('主动存档由回答产生方案和未完成行动，不推测个人事实', () => {
  const guide = answerGuide('离职前要留什么？', result, () => 'task-id');
  assert.equal(guide.title, '离职前要留什么？');
  assert.equal(guide.topic, '工作');
  assert.deepEqual(guide.factIds, []);
  assert.deepEqual(guide.tasks, [{ id: 'task-id', title: '保存合同', done: false }]);
  assert.equal(guide.snapshotDate, result.snapshotDate);
  assert.deepEqual(guide.sourceIds, ['19-8']);
  assert.ok(guide.content.includes('需要注意适用条件'));
  assert.ok(!guide.content.includes('B级'));
  assert.equal(result.answer.steps[0].title, '保存合同（B级）');
});
test('不足回答不能作为有依据的个人指南保存', () => {
  assert.throws(() => answerGuide('问题', { ...result, status: 'insufficient' }));
  assert.throws(() => answerGuide('问题', { ...result, sources: [] }));
});
