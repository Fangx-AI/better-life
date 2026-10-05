import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { createQaHandler } from '../server/qa.mjs';
import { createPersonalQaHandler } from '../server/personal-qa.mjs';
import { createUsageBudget } from '../server/usage-budget.mjs';

const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
// Fictional arithmetic fixture pricing; no actual model requests are performed.
const env = { DEEPSEEK_API_KEY: 'fixture-only-model-key', QA_BUDGET_DAILY_CNY: '1', QA_BUDGET_MONTHLY_CNY: '10', QA_PRICE_INPUT_CNY_PER_MILLION: '1', QA_PRICE_OUTPUT_CNY_PER_MILLION: '2' };
const request = (question = '离职后社保怎么办', signal) => new Request('https://better-life.fixture.test/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }), signal });
function fixture(t, budgetEnv = env) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-qa-budget-')), budget = createUsageBudget({ filename: join(directory, 'budget.sqlite'), env: budgetEnv });
  t.after(() => { budget.close(); rmSync(directory, { recursive: true, force: true }); }); return budget;
}
function modelResponse(options, { usage = { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 }, answer, draft } = {}) {
  const context = JSON.parse(JSON.parse(options.body).messages[1].content);
  const result = answer || { intro: '先看原文。', steps: [{ title: '查看手续', detail: '按原书办理并核对当地现行要求。', entryIds: [context.entries[0].id] }], caveat: '', insufficient: false, ...(draft ? { draft } : {}) };
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], ...(usage === null ? {} : { usage }) });
}
const handler = (budget, options = {}) => createQaHandler({ env, getCorpus: async () => corpus, usageBudget: budget, fetchImpl: async (_url, options) => modelResponse(options), ...options });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('qa budget: reserves UTF-8 full upstream body plus margin, dispatches, then charges actual reported usage', async t => {
  const budget = fixture(t), events = [], wrapped = {
    reserve(value) { events.push(['reserve', value]); return budget.reserve(value); },
    markDispatched(id) { events.push(['dispatch']); return budget.markDispatched(id); },
    settle(id, value) { events.push(['settle']); return budget.settle(id, value); },
    fail(id) { events.push(['fail']); return budget.fail(id); },
  };
  let upstreamBody;
  const response = await handler(wrapped, { fetchImpl: async (_url, options) => { upstreamBody = options.body; events.push(['fetch']); return modelResponse(options); } })(request());
  assert.equal(response.status, 200); assert.equal(events[0][1].inputTokens, new TextEncoder().encode(upstreamBody).byteLength + 1024); assert.equal(events[0][1].maxOutputTokens, 1800);
  assert.deepEqual(events.map(event => event[0]), ['reserve', 'dispatch', 'fetch', 'settle', 'fail']);
  assert.equal(budget.snapshot().day.chargedMicroCny, 150); assert.equal(budget.snapshot().day.reservedMicroCny, 0);
});

test('qa budget: valid usage is charged before invalid answer validation instead of being refunded', async t => {
  const budget = fixture(t), response = await handler(budget, { fetchImpl: async (_url, options) => modelResponse(options, { answer: { intro: 'bad', steps: [], caveat: '', insufficient: false } }) })(request());
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'invalid_answer'); assert.equal(budget.snapshot().day.chargedMicroCny, 150); assert.equal(budget.snapshot().day.conservativeRequests, 0);
});

test('qa budget: missing usage/HTTP/network/invalid JSON retain conservative cost without leaking error details', async t => {
  for (const fetchImpl of [async (_url, options) => modelResponse(options, { usage: null }), async () => new Response('private-upstream-error', { status: 401 }), async () => { throw new Error('private-upstream-error'); }, async () => new Response('{broken-json')]) {
    const budget = fixture(t), response = await handler(budget, { fetchImpl })(request());
    assert.ok([200, 502, 503].includes(response.status)); assert.equal((await response.text()).includes('private-upstream-error'), false);
    const state = budget.snapshot(); assert.equal(state.day.conservativeRequests, 1); assert.ok(state.day.chargedMicroCny > 0); assert.equal(state.day.reservedMicroCny, 0);
  }
});

test('qa budget: exhausted budget maps to 503 before paid fetch; invalid input/no evidence never reserve', async t => {
  const budget = fixture(t, { ...env, QA_BUDGET_DAILY_CNY: '0.000001' }); let calls = 0;
  const response = await handler(budget, { fetchImpl: async () => { calls += 1; throw new Error('must-not-call'); } })(request());
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'budget_exhausted'); assert.equal(calls, 0); assert.equal(budget.snapshot().day.committedMicroCny, 0);
  const guard = { reserve() { throw new Error('must-not-reserve'); } };
  assert.equal((await handler(guard)(request(''))).status, 400); assert.equal((await handler(guard)(request('火星殖民飞船引擎XYZ'))).status, 200);
});

test('qa budget: unavailable dispatch prevents fetch and releases the still-unsent reservation', async t => {
  const budget = fixture(t), wrapped = { reserve: budget.reserve, markDispatched: () => false, fail: budget.fail }; let calls = 0;
  const response = await handler(wrapped, { fetchImpl: async () => { calls += 1; throw new Error('must-not-call'); } })(request());
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'budget_unavailable'); assert.equal(calls, 0); assert.equal(budget.snapshot().day.committedMicroCny, 0);
});

test('qa budget: cancellation while retrieval/context awaits never dispatches a late paid call', async t => {
  for (const stage of ['corpus', 'context']) {
    const budget = fixture(t), controller = new AbortController(); let release, entered, calls = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const delayed = async value => { entered(); await new Promise(resolve => { release = resolve; }); return value; };
    const options = { fetchImpl: async () => { calls += 1; throw new Error('must-not-call'); }, ...(stage === 'corpus' ? { getCorpus: () => delayed(corpus) } : { resolveContext: () => delayed(null) }) };
    const pending = handler(budget, options)(request(undefined, controller.signal)); await started; controller.abort();
    assert.equal((await pending).status, 499); release(); await tick(); assert.equal(calls, 0); assert.equal(budget.snapshot().day.committedMicroCny, 0);
  }
});

test('qa budget: timeout while context awaits prevents late reserve/fetch, not merely an abort signal', async t => {
  const budget = fixture(t); let release, calls = 0;
  const pending = handler(budget, { timeoutMs: 10, resolveContext: () => new Promise(resolve => { release = resolve; }), fetchImpl: async () => { calls += 1; throw new Error('must-not-call'); } })(request());
  assert.equal((await pending).status, 504); release(null); await tick(); assert.equal(calls, 0); assert.equal(budget.snapshot().day.committedMicroCny, 0);
});

test('qa budget: synchronous reservation cancellation releases unsent budget and never calls fetch', async t => {
  const budget = fixture(t), controller = new AbortController(), wrapped = { ...budget, reserve(value) { const row = budget.reserve(value); controller.abort(); return row; } }; let calls = 0;
  const response = await handler(wrapped, { fetchImpl: async () => { calls += 1; throw new Error('must-not-call'); } })(request(undefined, controller.signal));
  assert.equal(response.status, 499); assert.equal(calls, 0); assert.equal(budget.snapshot().day.committedMicroCny, 0);
});

test('qa budget: timeout after dispatch conservatively charges; late usage corrects cost but not returned response', async t => {
  const budget = fixture(t); let release, upstreamOptions;
  const pending = handler(budget, { timeoutMs: 10, fetchImpl: async (_url, options) => { upstreamOptions = options; return new Promise(resolve => { release = resolve; }); } })(request());
  const response = await pending; assert.equal(response.status, 504); assert.equal(budget.snapshot().day.conservativeRequests, 1);
  release(modelResponse(upstreamOptions)); await tick(); await tick();
  assert.equal(response.status, 504); assert.equal(budget.snapshot().day.conservativeRequests, 0); assert.equal(budget.snapshot().day.chargedMicroCny, 150); assert.equal(budget.snapshot().day.reservedMicroCny, 0);
});

test('qa budget: client abort after dispatch retains cost and never revives a late successful response', async t => {
  const budget = fixture(t), controller = new AbortController(); let release, upstreamOptions, started;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = handler(budget, { fetchImpl: async (_url, options) => { upstreamOptions = options; started(); return new Promise(resolve => { release = resolve; }); } })(request(undefined, controller.signal));
  await entered; controller.abort(); const response = await pending;
  assert.equal(response.status, 499); assert.equal(budget.snapshot().day.conservativeRequests, 1);
  release(modelResponse(upstreamOptions)); await tick(); await tick();
  assert.equal(response.status, 499); assert.equal(budget.snapshot().day.chargedMicroCny, 150); assert.equal(budget.snapshot().day.conservativeRequests, 0);
});

test('qa budget: personal guide uses the same guardrail with 5000 output limit, not a separate ledger', async t => {
  const budget = fixture(t); let bound;
  const wrapped = { ...budget, reserve(value) { bound = value; return budget.reserve(value); } };
  const handle = createPersonalQaHandler({ env, getCorpus: async () => corpus, usageBudget: wrapped, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).max_tokens, 5000);
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    return modelResponse(options, { draft: { content: '新的私人指南内容。', sourceIds: [context.entries[0].id] } });
  } });
  const response = await handle(request(), { guide: { title: '手续指南', topic: '社保', content: '旧指南内容。', sourceIds: [], tasks: [], revision: 1 }, profileFacts: [] });
  assert.equal(response.status, 200); assert.equal(bound.maxOutputTokens, 5000); assert.equal(budget.snapshot().day.chargedMicroCny, 150);
});
