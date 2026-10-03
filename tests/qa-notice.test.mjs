import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanQaNotice, qaNoticeParts } from '../shared/qa-notice.mjs';
import { createQaHandler, validateAnswer } from '../server/qa.mjs';
import { createPersonalQaHandler } from '../server/personal-qa.mjs';
import { validateQaResponse } from '../src/lib/qa-response.mjs';
import { answerGuide } from '../src/lib/answer-guide.mjs';

const research = '原书这些条目主要来自观察性研究，部分结论有争议或证据有限，不适用于所有人。';
const condition = '如果你长期睡不着、睡眠问题已经影响白天生活，或同时有心慌、手抖、情绪明显异常等情况，请咨询医生等专业人士。';
const risk = '特别提醒：如果你每天都大量喝酒，一停就手抖心慌睡不着，不要自己硬戒，应去医院说明每天喝多少，由医生处理。';
const boilerplate = '以上是AI根据你提供的原书条目整理，不是原文，也不能作为诊断或治疗建议。';
const screenshotNotice = boilerplate + research + condition + risk;
const entry = { id: '2-13', chapter: 2, title: '睡眠建议', summary: '睡眠注意事项', benefit: '改善睡眠', notes: '', cost: '无', sources: 'https://source.example/sleep' };
const corpus = { source: { snapshotDate: '2026-10-03' }, chapters: [{ id: 2, title: '睡眠', file: '2.md', entries: [entry] }, { id: 15, title: '租房', file: '15.md', entries: Array.from({ length: 5 }, (_, index) => ({ ...entry, id: `15-${index + 1}`, chapter: 15, title: '核对租房合同', summary: '押金退还条件', benefit: '避免合同纠纷' })) }] };
const payload = (caveat = screenshotNotice) => ({ intro: '先把作息固定下来。', steps: [{ title: '固定睡觉时间', detail: '每天按相同时间上床和起床。', entryIds: [entry.id] }], caveat, insufficient: false });
const result = (caveat = screenshotNotice) => ({ status: 'answered', answer: payload(caveat), sources: [entry], snapshotDate: corpus.source.snapshotDate });

test('截图长提示只移除明确套话，原研究限制与戒断风险原样保留', () => {
  const cleaned = cleanQaNotice(screenshotNotice);
  assert.ok(!cleaned.includes(boilerplate));
  assert.ok(!cleaned.includes('AI根据'));
  for (const sentence of [research, condition, risk]) assert.ok(cleaned.includes(sentence), sentence);
  assert.equal(cleanQaNotice(cleaned), cleaned, '清理重复执行不应再改变真实内容');
});

test('只有套话时不渲染空提示；坏类型兼容为空', () => {
  for (const value of [boilerplate, '这是 AI 整理，不是原文。', '以上内容仅供参考，不作为诊断或治疗建议。', '仅供参考。', '', '  ', null, undefined, {}, [], 123]) {
    assert.equal(cleanQaNotice(value), '', String(value));
    assert.deepEqual(qaNoticeParts(value), { primary: '', extra: '' }, String(value));
  }
});

test('具体条件、急救措施、政策地区差异和书本研究局限不被重写', () => {
  for (const value of [risk, condition, research, '若出现胸痛、呼吸困难，立即拨打急救电话。', '养老金领取条件因地区和参保时间而异，办理前核对当地现行要求。', '不要把所有积蓄投入单只股票。', '不要停用医生开的药。']) {
    assert.equal(cleanQaNotice(value), value);
    assert.equal(qaNoticeParts(value).primary, value);
    assert.equal(qaNoticeParts(value).extra, '');
  }
});

test('最直接的重要风险优先展示，其他完整句留在补充提示，不截断内容', () => {
  const parts = qaNoticeParts(screenshotNotice);
  assert.equal(parts.primary, risk);
  assert.ok(parts.extra.includes(research));
  assert.ok(parts.extra.includes(condition));
  const original = cleanQaNotice(screenshotNotice);
  const remaining = original.replace(parts.primary, '').replace(/\s/g, '');
  assert.equal(parts.extra.replace(/\s/g, ''), remaining);
  assert.ok(!parts.primary.endsWith('…') && !parts.extra.endsWith('…'));
});

test('普通长提示仅按完整句折叠，不按字符长度裁切', () => {
  const first = '午睡建议控制在半小时内。';
  const second = '这条建议针对一般成年人。';
  const third = '观察性研究不能直接证明因果关系。';
  const parts = qaNoticeParts(first + second + third);
  assert.equal(parts.primary, first);
  assert.equal(parts.extra, second + third);
  const longSentence = '注意：' + '需要核对具体适用条件，'.repeat(40) + '不要省略。';
  assert.equal(qaNoticeParts(longSentence).primary, longSentence);
});

test('server、client 与存档一致清理旧响应，不修改引用、步骤或输入数据', () => {
  const serverInput = payload();
  const clientInput = result();
  const expected = cleanQaNotice(screenshotNotice);
  const server = validateAnswer(serverInput, [entry]);
  const client = validateQaResponse(clientInput, corpus);
  const guide = answerGuide('睡不着怎么办？', result(), () => 'task-id');
  assert.equal(server.answer.caveat, expected);
  assert.equal(client.answer.caveat, expected);
  assert.ok(guide.content.includes(expected));
  assert.ok(!guide.content.includes(boilerplate));
  assert.deepEqual(server.answer.steps, serverInput.steps);
  assert.deepEqual(client.answer.steps, clientInput.answer.steps);
  assert.deepEqual(guide.sourceIds, [entry.id]);
  assert.equal(serverInput.caveat, screenshotNotice);
  assert.equal(clientInput.answer.caveat, screenshotNotice);
  const noNoticeGuide = answerGuide('睡眠？', result(boilerplate), () => 'task-id');
  assert.ok(!noNoticeGuide.content.includes('## 需要注意'));
});

test('去套话的 helper 不放宽客户端和服务端原本的接口类型校验', () => {
  for (const value of [null, {}, 1]) {
    assert.throws(() => validateAnswer(payload(value), [entry]));
    assert.throws(() => validateQaResponse(result(value), corpus));
  }
});

test('公共与私人模型 prompt 默认不写长免责声明，具体风险放入相应步骤', async () => {
  const prompts = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    prompts.push(body.messages[0].content);
    const context = JSON.parse(body.messages[1].content);
    const value = payload(boilerplate);
    value.steps[0].entryIds = [context.entries[0].id];
    if (context.personalContext) value.draft = { content: '## 睡眠方案\n固定作息。', sourceIds: [context.entries[0].id] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
  };
  const options = { getCorpus: async () => corpus, fetchImpl, env: { DEEPSEEK_API_KEY: 'mock-only-not-a-real-key' } };
  const request = () => new Request('https://qa.example/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '睡眠怎么办' }) });
  const publicResponse = await createQaHandler(options)(request());
  const personalResponse = await createPersonalQaHandler(options)(request(), { guide: { title: '睡眠', topic: '健康', content: '固定作息。', sourceIds: [entry.id], tasks: [], revision: 1 }, profileFacts: [] });
  assert.equal(publicResponse.status, 200);
  assert.equal(personalResponse.status, 200);
  assert.equal((await publicResponse.json()).answer.caveat, '');
  assert.equal((await personalResponse.json()).answer.caveat, '');
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.ok(!prompt.includes('说明这是AI整理而非原文'));
    assert.match(prompt, /"caveat"\s*:\s*""/);
    assert.match(prompt, /默认.{0,30}(?:空|"")/);
    assert.match(prompt, /(?:风险|限制).{0,50}(?:对应|相应).{0,20}(?:步骤|step)|(?:对应|相应).{0,20}(?:步骤|step).{0,50}(?:风险|限制)/);
  }
});
