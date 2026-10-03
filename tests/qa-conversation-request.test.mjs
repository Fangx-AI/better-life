import test from 'node:test';
import assert from 'node:assert/strict';
import { sendConversationQuestion } from '../src/lib/qa-conversation-request.mjs';

const body = { question: '第二步怎么做？', history: [{ question: '押金怎么办？', summary: '保存合同。', sourceIds: ['15-1'] }], requestId: 'old-request-id' };
test('conversation retry: a released reservation transparently retries once with fresh ID and identical history', async () => {
  const requests = [], ids = [], signal = new AbortController().signal;
  const result = await sendConversationQuestion('/api/ask', body, { signal, newId: () => 'fresh-request-id', onRequestId: id => ids.push(id),
    fetchImpl: async (_url, options) => { requests.push(options); return requests.length === 1 ? Response.json({ error: { code: 'request_released' } }, { status: 409 }) : Response.json({ status: 'answered' }); } });
  assert.equal(result.response.status, 200); assert.equal(result.requestId, 'fresh-request-id'); assert.deepEqual(ids, ['fresh-request-id']);
  assert.deepEqual(JSON.parse(requests[0].body), body); assert.deepEqual(JSON.parse(requests[1].body), { ...body, requestId: 'fresh-request-id' });
  assert.ok(requests.every(request => request.signal === signal && request.credentials === 'same-origin'));
});
test('conversation retry: pending, cached conflicts, provider failures and quota errors never silently create another ID', async () => {
  for (const [status, code] of [[409, 'request_pending'], [409, 'request_mismatch'], [502, 'service_error'], [403, 'quota_exhausted']]) {
    let calls = 0; const result = await sendConversationQuestion('/api/ask', body, { newId: () => { throw new Error('must not rotate'); },
      fetchImpl: async () => { calls++; return Response.json({ error: { code } }, { status }); } });
    assert.equal(calls, 1); assert.equal(result.requestId, body.requestId);
  }
});
test('conversation retry: stopped or account-switched requests cannot initiate another model request', async () => {
  for (const stopped of [true, false]) {
    const abort = new AbortController(); if (stopped) abort.abort(); let calls = 0;
    await sendConversationQuestion('/api/ask', body, { signal: abort.signal, isCurrent: () => stopped,
      fetchImpl: async () => { calls++; return Response.json({ error: { code: 'request_released' } }, { status: 409 }); } });
    assert.equal(calls, 1);
  }
});
test('conversation retry: persistent released failure is bounded to two requests', async () => {
  let calls = 0; const result = await sendConversationQuestion('/api/ask', body, { newId: () => 'new-id',
    fetchImpl: async () => { calls++; return Response.json({ error: { code: 'request_released' } }, { status: 409 }); } });
  assert.equal(calls, 2); assert.equal(result.response.status, 409);
});
