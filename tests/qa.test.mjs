import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { createQaHandler, retrieveEntries, validateAnswer } from '../server/qa.mjs';

const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
const env = { DEEPSEEK_API_KEY: 'test-only-placeholder', QA_ALLOWED_ORIGINS: 'https://fangx-ai.github.io' };
const request = (question = '离职后社保怎么办', options = {}) => new Request('https://api.example/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body: JSON.stringify({ question }), ...options });
const modelAnswer = (id, overrides = {}) => ({ intro: '先查原文中的具体手续。', steps: [{ title: '查看办理要求', detail: '根据原书条目办理，并核对所在地的现行规则。', entryIds: [id] }], caveat: '这是 AI 整理，不是实时政策核验。', insufficient: false, ...overrides });
function mockModel(override) {
  return async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'deepseek-flash');
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.equal(payload.max_tokens, 1800);
    const context = JSON.parse(payload.messages[1].content);
    assert.ok(context.entries.length <= 6);
    const answer = override ?? modelAnswer(context.entries[0].id);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
  };
}
const handler = (options = {}) => createQaHandler({ getCorpus: async () => corpus, env, fetchImpl: mockModel(), ...options });

test('自然中文提问召回正确场景，返回最多六个完整原书条目', () => {
  for (const [question, chapter] of [['离职后社保怎么办', 19], ['房东不退押金怎么办', 15], ['我最近总是睡不着', 2], ['老人跌倒怎么办', 17], ['怀孕了要做什么检查', 27]]) {
    const entries = retrieveEntries(corpus, question);
    assert.ok(entries.length > 0 && entries.length <= 6, question);
    assert.ok(entries.some(entry => entry.chapter === chapter), `${question}: ${entries.map(e => e.id)}`);
    for (const entry of entries) {
      assert.ok(entry.sources && entry.cost && entry.summary && entry.grade && entry.chapterTitle && entry.chapterFile);
      const original = corpus.chapters.find(c => c.id === entry.chapter).entries.find(e => e.id === entry.id);
      assert.equal(entry.sources, original.sources);
      assert.equal(entry.summary, original.summary);
    }
  }
  assert.deepEqual(retrieveEntries(corpus, '火星殖民飞船引擎XYZ'), []);
  assert.deepEqual(retrieveEntries(corpus, '明天比特币会涨吗'), []);
  assert.ok(retrieveEntries(corpus, '离职后社保怎么办').some(entry => entry.id === '7-18'));
  assert.ok(retrieveEntries(corpus, '房东不退押金怎么办').some(entry => entry.id === '15-1'));
  assert.ok(retrieveEntries(corpus, '我最近总是睡不着').some(entry => entry.id === '2-13'));
});

test('成功 contract 与引用来自真实检索上下文', async () => {
  const response = await handler()(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.status, 'answered');
  assert.equal(result.question, '离职后社保怎么办');
  assert.equal(result.snapshotDate, '2026-10-03');
  assert.equal(result.model, 'DeepSeek');
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.answer.steps[0].entryIds, [result.sources[0].id]);
  assert.ok(result.sources[0].chapterFile);
});

test('无书内证据不调用付费模型', async () => {
  const response = await handler({ fetchImpl: () => { throw new Error('must not call'); } })(request('火星殖民飞船引擎XYZ'));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.status, 'insufficient');
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.answer.steps, []);
});

test('验证未知、空引用与不足答案，不接受假出处', async () => {
  const entries = retrieveEntries(corpus, '医保');
  assert.throws(() => validateAnswer(modelAnswer('999-999'), entries));
  assert.throws(() => validateAnswer(modelAnswer(entries[0].id, { steps: [{ title: 'x', detail: 'x', entryIds: [] }] }), entries));
  assert.throws(() => validateAnswer(modelAnswer(entries[0].id, { insufficient: true }), entries));
  const insufficient = modelAnswer(entries[0].id, { insufficient: true, steps: [] });
  assert.deepEqual(validateAnswer(insufficient, entries).sources, []);
  const response = await handler({ fetchImpl: mockModel(modelAnswer('999-999')) })(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'invalid_answer');
});

test('只公开服务是否配置，不泄漏 env', async () => {
  for (const [configuration, expected] of [[env, true], [{}, false]]) {
    const response = await handler({ env: configuration })(new Request('https://api.example/api/qa/status'));
    assert.deepEqual(await response.json(), { configured: expected, provider: 'DeepSeek' });
  }
  const response = await handler({ env: {} })(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'not_configured');
});

test('路由、方法、CORS 与预检', async () => {
  const handle = handler();
  assert.equal((await handle(new Request('https://api.example/api/nope', { headers: { accept: 'text/html' } }))).status, 404);
  assert.equal((await handle(new Request('https://api.example/api/ask'))).status, 405);
  assert.equal((await handle(new Request('https://api.example/api/qa/status', { method: 'POST' }))).status, 405);
  const denied = await handle(request('医保', { headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const allowed = await handle(request('医保', { headers: { 'content-type': 'application/json', origin: 'https://fangx-ai.github.io' } }));
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://fangx-ai.github.io');
  const preflight = await handle(new Request('https://api.example/api/ask', { method: 'OPTIONS', headers: { origin: 'https://fangx-ai.github.io' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('输入500字、8KB、JSON限制', async () => {
  const handle = handler();
  for (const q of ['', ' '.repeat(3), '问'.repeat(501)]) assert.equal((await handle(request(q))).status, 400);
  assert.equal((await handle(new Request('https://api.example/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' }))).status, 400);
  assert.equal((await handle(new Request('https://api.example/api/ask', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status, 415);
  assert.equal((await handle(new Request('https://api.example/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '医保', padding: 'x'.repeat(9000) }) }))).status, 413);
});

test('模型空回答、截断、坏JSON与网络故障均不伪装成功', async () => {
  for (const body of [
    { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: '{}' }, finish_reason: 'length' }] },
    { choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] },
  ]) {
    const response = await handler({ fetchImpl: async () => new Response(JSON.stringify(body)) })(request());
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'invalid_answer');
  }
  const response = await handler({ fetchImpl: async () => { throw new Error('private upstream detail'); } })(request());
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('private upstream'));
});

test('上游认证、余额、限流与过载保留正确失败状态，无错误正文泄漏', async () => {
  for (const [upstream, expected] of [[401, 503], [402, 503], [429, 429], [503, 502]]) {
    const response = await handler({ fetchImpl: async () => new Response('secret upstream text', { status: upstream }) })(request());
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes('secret'));
  }
});

test('超时与主动取消终止等待，即便 mock fetch 不响应 abort', async () => {
  const response = await handler({ timeoutMs: 10, fetchImpl: () => new Promise(() => {}) })(request());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'timeout');
  const controller = new AbortController();
  const promise = handler({ fetchImpl: () => new Promise(() => {}) })(request('医保', { signal: controller.signal }));
  setTimeout(() => controller.abort(), 10);
  const cancelled = await promise;
  assert.equal(cancelled.status, 499);
  const already = new AbortController();
  already.abort();
  assert.equal((await handler()(request('医保', { signal: already.signal }))).status, 499);
});

test('限流窗口与并发限制', async () => {
  let clock = 0;
  const handle = handler({ rateLimit: 1, now: () => clock });
  assert.equal((await handle(request())).status, 200);
  const limited = await handle(request());
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  clock = 60001;
  assert.equal((await handle(request())).status, 200);
  let release;
  const pending = handler({ maxConcurrent: 1, fetchImpl: async (...args) => { await new Promise(resolve => { release = resolve; }); return mockModel()(...args); } });
  const first = pending(request());
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const second = await pending(request());
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'busy');
  release();
  assert.equal((await first).status, 200);
});

test('默认身份忽略伪造的转发头，空请求也在读 body 前计入限流', async () => {
  const handle = handler({ rateLimit: 1 });
  const first = request('', { headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '1.1.1.1', 'x-better-life-client-ip': '1.1.1.1' } });
  assert.equal((await handle(first)).status, 400);
  const forged = request('医保', { headers: { 'content-type': 'application/json', 'x-forwarded-for': '2.2.2.2', 'cf-connecting-ip': '2.2.2.2', 'x-better-life-client-ip': '2.2.2.2' } });
  const response = await handle(forged);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'rate_limited');
  assert.equal(forged.bodyUsed, false);
});

test('可信身份可分桶，但单实例全局额度阻止轮换 client 绕过', async () => {
  let clock = 0;
  let identity = 'trusted-a';
  const handle = handler({ getClientId: () => identity, globalRateLimit: 2, now: () => clock });
  assert.equal((await handle(request(''))).status, 400);
  identity = 'trusted-b';
  assert.equal((await handle(request(''))).status, 400);
  identity = 'trusted-c';
  const unconsumed = request();
  const blocked = await handle(unconsumed);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'global_rate_limited');
  assert.equal(unconsumed.bodyUsed, false);
  assert.equal(blocked.headers.get('retry-after'), '60');
  clock = 60001;
  assert.equal((await handle(request(''))).status, 400);
});

test('分桶容量最高1000，容量满时不淘汰旧身份，过期后释放', async () => {
  let clock = 0;
  let identity = '';
  const handle = handler({ getClientId: () => identity, globalRateLimit: 3000, bucketCapacity: 9999, now: () => clock });
  for (let index = 0; index < 1000; index++) {
    identity = `trusted-${index}`;
    assert.equal((await handle(request(''))).status, 400);
  }
  identity = 'trusted-overflow';
  const blocked = await handle(request(''));
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'bucket_capacity');
  identity = 'trusted-0';
  assert.equal((await handle(request(''))).status, 400);
  clock = 60001;
  identity = 'trusted-overflow';
  assert.equal((await handle(request(''))).status, 400);
});

function slowRequest({ signal, onCancel = () => {} } = {}) {
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"question":')); },
    cancel() { onCancel(); return new Promise(() => {}); },
  });
  return new Request('https://api.example/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half', signal });
}

test('读取慢 body 有独立超时、取消底层流并释放并发槽', async () => {
  let cancelled = false;
  const handle = handler({ readBodyTimeoutMs: 15, maxConcurrent: 1 });
  const pending = handle(slowRequest({ onCancel: () => { cancelled = true; } }));
  const busy = await handle(request());
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.code, 'busy');
  const timedOut = await pending;
  assert.equal(timedOut.status, 408);
  assert.equal((await timedOut.json()).error.code, 'body_timeout');
  assert.equal(cancelled, true);
  assert.equal((await handle(request(''))).status, 400);
});

test('读取慢 body 时主动 abort 返回499，不等待底层 cancel hook', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const pending = handler({ readBodyTimeoutMs: 1000 })(slowRequest({ signal: controller.signal, onCancel: () => { cancelled = true; } }));
  setTimeout(() => controller.abort(), 10);
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, 'cancelled');
  assert.equal(cancelled, true);
});
