import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaRequestGate, previewQaStep } from '../src/lib/qa-request-gate.mjs';

test('取消立即允许重试，旧请求的 late completion 不结束新请求', () => {
  const gate = createQaRequestGate();
  const old = gate.begin();
  gate.cancel();
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(gate.isCurrent(old), false);
  const retry = gate.begin();
  assert.equal(gate.finish(old), false);
  assert.equal(gate.isCurrent(retry), true);
  assert.equal(retry.controller.signal.aborted, false);
  assert.equal(gate.finish(retry), true);
});

test('新问题替代上一请求，只有新结果能更新界面', () => {
  const gate = createQaRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(first.controller.signal.reason, 'superseded');
  const published = [];
  for (const [request, answer] of [[first, '旧答案'], [second, '新答案']]) {
    if (gate.isCurrent(request)) published.push(answer);
  }
  assert.deepEqual(published, ['新答案']);
  gate.finish(second);
});

test('超时终止 fetch；完成的请求清除超时，不再意外 abort', async () => {
  const gate = createQaRequestGate({ timeoutMs: 10 });
  const timed = gate.begin();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(timed.controller.signal.reason, 'timeout');
  assert.equal(gate.isCurrent(timed), true);
  gate.finish(timed);
  const finished = gate.begin();
  gate.finish(finished);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(finished.controller.signal.aborted, false);
});

test('详情预览保留完整句子与限制，展开后没有丢失任何内容', () => {
  const detail = '先保留合同和付款凭证。注意：不要扣留钥匙；是否起诉应看所在地规则。';
  const parts = previewQaStep(detail);
  assert.equal(parts.preview, '先保留合同和付款凭证。');
  assert.equal(parts.remainder, '注意：不要扣留钥匙；是否起诉应看所在地规则。');
  assert.equal(parts.preview + parts.remainder, detail);
  assert.deepEqual(previewQaStep('如有急性症状，应及时就医。'), { preview: '如有急性症状，应及时就医。', remainder: '' });
  assert.deepEqual(previewQaStep('未分句的操作和全部限制'), { preview: '未分句的操作和全部限制', remainder: '' });
});
