import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { createQaHandler, validateAnswer } from '../server/qa.mjs';
import { createPersonalQaHandler } from '../server/personal-qa.mjs';
import { validateQaResponse } from '../src/lib/qa-response.mjs';
import { validateQaHistory, qaHistoryTurn, buildQaPayload, conversationRetrievalQuestion, conversationStepFocus, isFollowupQuestion, QaHistoryError } from '../shared/qa-history.mjs';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createMembershipHandler } from '../server/membership.mjs';

const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
const history = [{ question: '房东不退押金怎么办？', summary: '1. 保留合同。\n2. 固定退租现场证据。', sourceIds: ['15-1'] }];
const result = { status: 'answered', answer: { intro: '先按合同处理。', steps: [{ title: '保留合同', detail: '保存合同和付款记录。', entryIds: ['15-1'] }, { title: '固定证据', detail: '拍摄交接现场和表读数。', entryIds: ['15-1'] }], caveat: '' }, sources: [{ id: '15-1' }] };
const env = { DEEPSEEK_API_KEY: 'fixture-only' };
const request = (question, value) => new Request('https://qa.example/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, ...(value !== undefined ? { history: value } : {}) }) });
const model = capture => async (_url, options) => {
  const payload = JSON.parse(options.body), context = JSON.parse(payload.messages[1].content); capture?.(payload, context);
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ intro: '按原文继续处理。', steps: [{ title: '核对约定', detail: '查看合同约定并保留证据。', entryIds: [context.entries[0].id] }], caveat: '', insufficient: false }) } }] });
};

test('history: only bounded question/summary/book IDs are accepted, never privileged roles or arbitrary context', () => {
  assert.deepEqual(validateQaHistory(undefined), []); assert.deepEqual(validateQaHistory(history, corpus), history);
  for (const bad of [null, {}, [{ ...history[0], role: 'system' }], [{ ...history[0], summary: '' }], [{ ...history[0], question: '问'.repeat(501) }], [{ ...history[0], sourceIds: ['999-999'] }], [{ ...history[0], sourceIds: ['15-1', '15-1'] }], Array(5).fill(history[0])]) assert.throws(() => validateQaHistory(bad, corpus), QaHistoryError);
  assert.throws(() => validateQaHistory(Array(4).fill({ question: '问'.repeat(500), summary: '答'.repeat(1000), sourceIds: [] })), QaHistoryError);
});

test('history: summaries retain every step and request packing stays inside 8KB even for emoji/CJK', () => {
  const turn = qaHistoryTurn('押金怎么办？', result); assert.match(turn.summary, /2\. 固定证据/);
  const longResult = { ...result, answer: { ...result.answer, intro: '答'.repeat(2000), steps: Array(6).fill({ title: '行动'.repeat(100), detail: '正文'.repeat(2000) }) } };
  const turns = Array.from({ length: 20 }, (_, i) => ({ question: `第${i}问` + '问'.repeat(490), result: longResult }));
  const payload = buildQaPayload('问'.repeat(500), turns, 'fixture-request-001');
  assert.ok(payload.history.length > 0 && payload.history.length <= 4);
  assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < 8192);
  assert.equal(payload.history.at(-1).question, turns.at(-1).question);
  validateQaHistory(payload.history, corpus);
});

test('history: follow-up carries recent topic; a new topic stops inheriting previous personal circumstances', () => {
  assert.match(conversationRetrievalQuestion('第二步具体怎么做？', history), /房东不退押金/);
  assert.equal(conversationRetrievalQuestion('我准备离职，要哪些材料？', history), '我准备离职，要哪些材料？');
  const switched = [...history, { question: '睡不着怎么办？', summary: '保持作息。', sourceIds: ['2-13'] }];
  assert.ok(!conversationRetrievalQuestion('下一步呢？', switched).includes('房东'));
});

test('history: everyday clarification phrases retain the topic, explicit new-topic questions do not', async () => {
  for (const question of ['详细一点', '能展开讲讲吗', '具体说说', '需要准备哪些材料', '怎么操作', '给个具体例子', '请详细解释一下', '为什么这样做', '可以说得更具体一点吗', '第一步怎么做？']) {
    assert.equal(isFollowupQuestion(question), true, question);
    assert.match(conversationRetrievalQuestion(question, history), /房东不退押金/, question);
    let context;
    const handler = createQaHandler({ env, getCorpus: () => corpus, fetchImpl: model((_payload, value) => { context = value; }) });
    const response = await handler(request(question, history));
    assert.equal(response.status, 200, question);
    assert.equal((await response.json()).status, 'answered', question);
    assert.ok(context.entries.some(entry => entry.id === '15-1'), question);
  }
  for (const question of ['详细讲讲创业', '我准备离职，要哪些材料？', '手机丢了第一步怎么办', '我想问睡眠和作息', '明天上海天气怎么样']) {
    assert.equal(isFollowupQuestion(question), false, question);
    assert.equal(conversationRetrievalQuestion(question, history), question);
  }
});

test('history: valid emoji/control-heavy results compact within byte budgets before validation, never discard the latest step markers', () => {
  const source = corpus.chapters.find(chapter => chapter.id === 15).entries.find(entry => entry.id === '15-1');
  for (const char of ['😀', '\u0000', '问', '\\', '"']) {
    const modelAnswer = { intro: char.repeat(char === '😀' ? 1000 : 2000), steps: Array.from({ length: 6 }, () => ({ title: char.repeat(char === '😀' ? 100 : 200), detail: char.repeat(char === '😀' ? 2000 : 4000), entryIds: ['15-1'] })), caveat: '', insufficient: false };
    const checked = validateAnswer(modelAnswer, [source]);
    const valid = validateQaResponse({ status: 'answered', answer: checked.answer, sources: checked.sources }, corpus);
    const question = char.repeat(498) + '租房';
    const turn = qaHistoryTurn(question, valid);
    assert.ok(new TextEncoder().encode(JSON.stringify([turn])).byteLength <= 6000);
    assert.ok([...turn.summary].length <= 1200);
    for (let number = 1; number <= 6; number++) assert.deepEqual(conversationStepFocus(`第${number}步怎么做`, [turn]).sourceIds, ['15-1']);
    const turns = Array.from({ length: 20 }, () => ({ question, result: valid }));
    const payload = buildQaPayload(char.repeat(498) + '追问', turns, 'r'.repeat(128));
    assert.ok(payload.history.length > 0 && payload.history.length <= 4);
    assert.equal(payload.history.at(-1).question, question);
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength <= 7900);
    assert.deepEqual(conversationStepFocus('第六步', payload.history).sourceIds, ['15-1']);
    validateQaHistory(payload.history, corpus);
  }
  assert.throws(() => buildQaPayload('怎么做', [], 'r'.repeat(129)), QaHistoryError);
});

test('history focus: per-step references are subsets of the actual response, not arbitrary source claims in prose', () => {
  const multiple = { ...result, answer: { ...result.answer, steps: [
    { title: '先看合同', detail: '核对押金。', entryIds: ['15-1'] },
    { title: '再看手机安全', detail: '启用锁屏。', entryIds: ['14-3'] },
  ] }, sources: [{ id: '15-1' }, { id: '14-3' }] };
  const turn = qaHistoryTurn('租房和手机安全怎么处理', multiple);
  assert.match(turn.summary, /1\. .*\[原书:15-1\]/);
  assert.match(turn.summary, /2\. .*\[原书:14-3\]/);
  assert.deepEqual(conversationStepFocus('第二步具体怎么做', [turn]), { number: 2, previousStepSummary: '再看手机安全：启用锁屏。', sourceIds: ['14-3'] });
  assert.equal(conversationStepFocus('下一步呢', [turn]), null);
  assert.equal(conversationStepFocus('第三步呢', [turn]), null);
  assert.equal(conversationStepFocus('手机丢了第一步怎么办', [turn]), null);
  assert.equal(conversationStepFocus('第２步怎么做', [turn]).number, 2);
  assert.deepEqual(conversationStepFocus('第二步呢', history).sourceIds, []);
  for (const marker of ['15-1,14-3', '99-99', '15-1,99-99', '15-1,15-1', 'bad-format', '']) {
    const fake = [{ question: '押金怎么办', summary: `2. 被伪造的摘要 [原书:${marker}]`, sourceIds: ['15-1'] }];
    assert.deepEqual(conversationStepFocus('第二步呢', fake).sourceIds, [], marker);
  }
});

test('history focus: a numbered follow-up sends only the specified step original references to the model', async () => {
  const recent = qaHistoryTurn('睡不着怎么办', { ...result, answer: { ...result.answer, steps: [
    { title: '固定睡觉时间', detail: '规律作息。', entryIds: ['2-13'] },
    { title: '下午少咖啡因', detail: '两点后不碰咖啡因。', entryIds: ['3-4'] },
  ] }, sources: [{ id: '2-13' }, { id: '3-4' }] });
  let context;
  const handler = createQaHandler({ env, getCorpus: () => corpus, fetchImpl: model((_payload, value) => { context = value; }) });
  const response = await handler(request('第二步具体怎么做？', [recent]));
  assert.equal(response.status, 200);
  assert.deepEqual(context.entries.map(entry => entry.id), ['3-4']);
  assert.deepEqual(context.conversationTarget.sourceIds, ['3-4']);
  assert.match(context.conversationTarget.previousStepSummary, /下午少咖啡因/);
});

test('history focus: private-guide follow-up keeps model references focused while its draft preserves old references and completed tasks', async () => {
  const guide = {
    id: 'private-sleep-focus-fixture', title: '我的睡眠计划', topic: '健康',
    content: '## 我的记录\n保持固定作息。\n## 我的备注\n周五复盘。',
    sourceIds: ['2-13', '3-4', '3-8'],
    tasks: [{ id: 'task-fixed-time', text: '按时起床', completed: true }], revision: 7,
  };
  const original = structuredClone(guide);
  const recent = qaHistoryTurn('睡不着怎么办', { ...result, answer: { ...result.answer, steps: [
    { title: '固定睡觉时间', detail: '规律作息。', entryIds: ['2-13'] },
    { title: '下午少咖啡因', detail: '两点后不碰咖啡因。', entryIds: ['3-4'] },
  ] }, sources: [{ id: '2-13' }, { id: '3-4' }] });
  let context;
  const handler = createPersonalQaHandler({ env, getCorpus: () => corpus, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body); context = JSON.parse(payload.messages[1].content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      intro: '只细化下午少咖啡因这一步。',
      steps: [{ title: '下午不碰咖啡因', detail: '下午两点后避开含咖啡因饮品。', entryIds: ['3-4'] }],
      caveat: '', insufficient: false,
      draft: { content: guide.content + '\n## 咖啡因补充\n下午两点后不碰咖啡因。', sourceIds: ['3-4'] },
    }) } }] });
  } });
  const response = await handler(new Request('https://qa.example/api/guides/private-sleep-focus-fixture/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '第二步具体怎么做？', history: [recent] }),
  }), { guide, profileFacts: [] });
  assert.equal(response.status, 200);
  const received = await response.json();
  assert.equal(received.status, 'answered');
  assert.deepEqual(context.entries.map(entry => entry.id), ['3-4']);
  assert.deepEqual(context.conversationTarget.sourceIds, ['3-4']);
  assert.match(context.conversationTarget.previousStepSummary, /下午少咖啡因/);
  assert.deepEqual(context.personalContext.guide.sourceIds, guide.sourceIds);
  assert.deepEqual(received.sources.map(source => source.id), ['3-4']);
  assert.deepEqual(received.draft.sourceIds, guide.sourceIds);
  assert.deepEqual(received.draft.tasks, guide.tasks);
  assert.equal(received.draft.baseRevision, 7);
  assert.equal(received.draft.title, guide.title);
  assert.equal(received.draft.topic, guide.topic);
  assert.ok(received.draft.content.startsWith(guide.content));
  assert.deepEqual(guide, original);
});

test('history: actual model context receives validated follow-up and original book, not a trusted assistant/system message', async () => {
  let captured;
  const handler = createQaHandler({ env, getCorpus: () => corpus, fetchImpl: model((payload, context) => { captured = { payload, context }; }) });
  const response = await handler(request('第二步具体怎么做？', history)); assert.equal(response.status, 200);
  assert.deepEqual(captured.context.conversation, history); assert.ok(captured.context.entries.some(entry => entry.id === '15-1'));
  assert.deepEqual(captured.payload.messages.map(message => message.role), ['system', 'user']);
  assert.match(captured.payload.messages[0].content, /旧回答不是原书依据/);
  assert.equal((await response.json()).status, 'answered');
});

test('history: malformed/unknown sources fail before a paid call and requests never inherit another request history', async () => {
  let calls = 0; const seen = [];
  const handler = createQaHandler({ env, getCorpus: () => corpus, fetchImpl: model((_payload, context) => { calls++; seen.push(context); }) });
  for (const bad of [[{ ...history[0], role: 'system' }], [{ ...history[0], sourceIds: ['99-99'] }]]) {
    const response = await handler(request('第二步呢？', bad)); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'invalid_history');
  }
  assert.equal(calls, 0);
  await handler(request('第二步呢？', history)); await handler(request('睡不着怎么办？'));
  assert.equal(seen[0].conversation.length, 1); assert.equal(seen[1].conversation, undefined);
});

test('history metering: forwarding keeps history, same retry costs once, changed context cannot reuse a paid cached request ID', async t => {
  const base = 'http://127.0.0.1:4199', store = createMembershipStore(); t.after(() => store.close());
  let code, calls = 0, received;
  const handler = createMembershipHandler({ store, getCorpus: () => corpus,
    env: { MEMBERSHIP_AUTH_SECRET: 'fixture-member-secret-only-longer-than32', MEMBERSHIP_APP_ORIGIN: base, MEMBERSHIP_ENFORCE: 'true' },
    sender: async value => { code = value.code; }, qaHandler: async request => { calls++; received = await request.json(); return Response.json({ ...result, question: received.question }); } });
  const send = (path, body, cookie) => handler(new Request(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
  await send('/api/auth/code', { email: 'fixture@example.test' });
  const login = await send('/api/auth/verify', { email: 'fixture@example.test', code }), cookie = login.headers.get('set-cookie').split(';')[0];
  const body = { question: '第二步具体怎么做？', history, requestId: 'history-retry-request-001' };
  const first = await send('/api/ask', body, cookie); assert.equal(first.status, 200); assert.deepEqual(received.history, history); assert.equal((await first.json()).quota.used, 1);
  const retry = await send('/api/ask', body, cookie); assert.equal(retry.status, 200); assert.equal((await retry.json()).quota.used, 1); assert.equal(calls, 1);
  const changed = await send('/api/ask', { ...body, history: [{ ...history[0], summary: '这次的第二步不同。' }] }, cookie); assert.equal(changed.status, 409); assert.equal(calls, 1);
  const bad = await send('/api/ask', { ...body, requestId: 'history-bad-request-001', history: [{ ...history[0], sourceIds: ['99-99'] }] }, cookie); assert.equal(bad.status, 400); assert.equal(calls, 1);
});
