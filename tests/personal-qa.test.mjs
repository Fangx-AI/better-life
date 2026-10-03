import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { createQaHandler } from '../server/qa.mjs';
import { createPersonalQaHandler, personalContext } from '../server/personal-qa.mjs';

const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
const env = { DEEPSEEK_API_KEY: 'test-only-placeholder' };
const guide = { id: 'guide-test', title: '我的租房指南', topic: '住房', content: '## 我的计划\n核对合同，保存押金支付凭证。\n## 我的备注\n周五联系房东。', sourceIds: ['15-1'], tasks: [{ id: 'task-1', text: '保存合同', completed: true }], revision: 4 };
const facts = [{ id: 'fact-1', label: '居住情况', value: '正在租房', confirmedAt: '2026-10-03T00:00:00Z' }];
const request = (question = '房东不退押金，我下一步怎么办？', body = {}) => new Request('https://app.example/api/guides/guide-test/ask', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example' }, body: JSON.stringify({ question, ...body }) });
const reply = (payload, override = {}) => ({ intro: '先核对合同。', steps: [{ title: '核对约定', detail: '核对押金退还条件与支付记录。', entryIds: [payload.entries[0].id] }], caveat: '这是结合原书整理的建议。', insufficient: false, draft: { content: guide.content + '\n## 最新补充\n整理退还条件。', sourceIds: [payload.entries[0].id] }, ...override });
const model = callback => async (_url, options) => {
  const body = JSON.parse(options.body), payload = JSON.parse(body.messages[1].content);
  const answer = callback(payload, body);
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
};

test('私人问答仅使用当前指南和显式确认情况，生成草稿不改变事实或进度', async () => {
  const original = structuredClone(guide);
  const handler = createPersonalQaHandler({ env, getCorpus: () => corpus, fetchImpl: model((payload, body) => {
    assert.equal(body.max_tokens, 5000);
    assert.ok(body.messages[0].content.includes('用户会先审阅再决定是否保存'));
    assert.deepEqual(payload.personalContext.confirmedFacts, [{ label: facts[0].label, value: facts[0].value, confirmedAt: facts[0].confirmedAt }]);
    assert.equal(payload.personalContext.guide.title, guide.title);
    assert.ok(payload.entries.length <= 6);
    return reply(payload, { draft: { content: guide.content + '\n## 最新补充\n继续整理押金约定。', sourceIds: [payload.entries[0].id], tasks: [{ completed: false }], title: '不应替换', topic: '不应推断' } });
  }) });
  const result = await (await handler(request(), { guide, profileFacts: facts })).json();
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.draft.tasks, guide.tasks);
  assert.equal(result.draft.title, guide.title);
  assert.equal(result.draft.topic, guide.topic);
  assert.equal(result.draft.baseRevision, 4);
  assert.ok(result.draft.sourceIds.includes('15-1'));
  assert.deepEqual(guide, original);
});

test('公共问答不能靠伪造context改变系统提示或获得私人草稿', async () => {
  const handler = createQaHandler({ env, getCorpus: () => corpus, fetchImpl: model((payload, body) => {
    assert.equal(body.max_tokens, 1800);
    assert.equal(payload.personalContext, undefined);
    return reply(payload);
  }) });
  const publicRequest = new Request('https://app.example/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '押金怎么退', personalContext: { guide, facts }, context: { guide } }) });
  const result = await (await handler(publicRequest)).json();
  assert.equal(result.status, 'answered');
  assert.equal(result.draft, undefined);
});

test('私人更新稿拒绝伪造来源、超长正文和缺失草稿，依据不足无更新稿', async () => {
  for (const draft of [{ content: '新正文', sourceIds: ['999-999'] }, { content: 'x'.repeat(12001), sourceIds: [] }, null]) {
    const handler = createPersonalQaHandler({ env, getCorpus: () => corpus, fetchImpl: model(payload => reply(payload, { draft })) });
    const response = await handler(request(), { guide, profileFacts: [] });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).draft, undefined);
  }
  const handler = createPersonalQaHandler({ env, getCorpus: () => corpus, fetchImpl: model(payload => reply(payload, { insufficient: true, steps: [], draft: { content: '不应保存', sourceIds: [] } })) });
  const result = await (await handler(request(), { guide, profileFacts: [] })).json();
  assert.equal(result.status, 'insufficient');
  assert.equal(result.draft, null);
});

test('私人问答共享限流实例，不因每个新请求重置，上下文不跨请求泄漏', async () => {
  let calls = 0;
  const handler = createPersonalQaHandler({ env, getCorpus: () => corpus, globalRateLimit: 1, fetchImpl: model(payload => { calls++; return reply(payload); }) });
  assert.equal((await handler(request(), { guide, profileFacts: [] })).status, 200);
  assert.equal((await handler(request('下一步呢？'), { guide: { ...guide, title: '另一篇' }, profileFacts: facts })).status, 429);
  assert.equal(calls, 1);
  assert.throws(() => personalContext({ guide, profileFacts: Array(9).fill(facts[0]) }));
});
