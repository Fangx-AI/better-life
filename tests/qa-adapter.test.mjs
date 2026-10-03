import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { qaMiddleware } from '../server/node-adapter.mjs';
import worker from '../worker/index.js';

function exchange({ url = '/api/qa/status', method = 'GET', headers = {}, body = '', address = '127.0.0.8' } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [], { objectMode: false });
  Object.assign(req, { url, method, headers: { host: 'example.test', ...headers }, socket: { remoteAddress: address } });
  const res = new EventEmitter();
  Object.assign(res, {
    writableEnded: false, destroyed: false,
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
    end(data) { this.body = Buffer.from(data).toString(); this.writableEnded = true; },
  });
  return { req, res };
}

test('Node adapter discards spoofed proxy addresses and uses socket identity', async () => {
  const { req, res } = exchange({ headers: {
    'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '203.0.113.2', 'x-better-life-client-ip': '203.0.113.3',
  } });
  let observed;
  await qaMiddleware(async request => { observed = request; return new Response('ok'); })(req, res, () => assert.fail('unexpected next'));
  assert.equal(observed.headers.get('cf-connecting-ip'), null);
  assert.equal(observed.headers.get('x-forwarded-for'), null);
  assert.equal(observed.headers.get('x-better-life-client-ip'), '127.0.0.8');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'ok');
});

test('Node adapter normalizes Pages API prefix while preserving query, method and body', async () => {
  const payload = JSON.stringify({ question: '离职后社保怎么办' });
  const { req, res } = exchange({ url: '/better-life/api/ask?source=share', method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  let observed;
  await qaMiddleware(async request => {
    observed = { url: request.url, method: request.method, body: await request.text() };
    return new Response('accepted', { status: 202 });
  })(req, res, () => assert.fail('unexpected next'));
  assert.deepEqual(observed, { url: 'http://example.test/api/ask?source=share', method: 'POST', body: payload });
  assert.equal(res.status, 202);
});

test('Node adapter trusts a single real IP only from an explicitly configured proxy socket', async () => {
  for (const [address, realIp, expected] of [
    ['127.0.0.8', '203.0.113.5', '203.0.113.5'],
    ['127.0.0.9', '203.0.113.5', '127.0.0.9'],
    ['127.0.0.8', '203.0.113.5, 203.0.113.6', '127.0.0.8'],
    ['127.0.0.8', 'invalid-address', '127.0.0.8'],
  ]) {
    const { req, res } = exchange({ address, headers: { 'x-real-ip': realIp, 'x-better-life-client-ip': '203.0.113.99' } });
    await qaMiddleware(request => {
      assert.equal(request.headers.get('x-better-life-client-ip'), expected);
      assert.equal(request.headers.get('x-real-ip'), null);
      assert.equal(request.headers.get('x-better-life-proxy-present'), address === '127.0.0.8' ? 'true' : 'false');
      return new Response('ok');
    }, { trustedProxyIps: ['127.0.0.8', 'invalid-address'] })(req, res, () => assert.fail('unexpected next'));
    assert.equal(res.status, 200);
  }
});

test('invalid Host is contained as a JSON response rather than an unhandled rejection', async () => {
  const { req, res } = exchange({ headers: { host: '[invalid' } });
  await assert.doesNotReject(() => qaMiddleware(() => assert.fail('handler must not run'))(req, res, () => assert.fail('unexpected next')));
  assert.equal(res.status, 500);
  assert.equal(res.headers['Content-Type'], 'application/json');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(res.body).error.code, 'INTERNAL');
  assert.equal(res.writableEnded, true);
});

test('static paths call next without invoking the QA handler or writing a response', async () => {
  for (const url of ['/assets/app.js', '/better-life/', '/content.json']) {
    const { req, res } = exchange({ url });
    let calls = 0;
    await qaMiddleware(() => assert.fail('handler must not run'))(req, res, () => { calls++; });
    assert.equal(calls, 1, url);
    assert.equal(res.status, undefined, url);
    assert.equal(res.writableEnded, false, url);
  }
});

test('Worker status needs no ASSETS and unknown HTML API routes never use app fallback', async () => {
  const env = { DEEPSEEK_API_KEY: 'test-only-placeholder' };
  const response = await worker.fetch(new Request('https://example.test/api/qa/status'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true, provider: 'DeepSeek' });
  let calls = 0;
  const missing = await worker.fetch(new Request('https://example.test/api/missing', { headers: { accept: 'text/html' } }), {
    ...env, ASSETS: { fetch: () => { calls++; throw new Error('API must not fetch app shell'); } },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');
  assert.equal(calls, 0);
});
