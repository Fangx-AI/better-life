import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { validateQaResponse } from '../src/lib/qa-response.mjs';
import { isCurrentGuideOwner } from '../src/lib/personal-guide-api.mjs';
import { validateAnalyticsPayload } from '../shared/analytics-schema.mjs';

// Execute the component's actual non-JSX callbacks with in-memory state and fake
// transport/timers. No React DOM, env, private database, model or network is used.
const source = readFileSync(new URL('../src/components/personal-guide/personal-guide-page.jsx', import.meta.url), 'utf8');
const editor = source.slice(source.indexOf('function GuideEditor('), source.indexOf('\nfunction NewGuideForm('));
const askSource = editor.slice(editor.indexOf('  const ask = async event => {'), editor.indexOf('\n  const completed ='));
const cleanupSource = editor.slice(editor.indexOf('  useLayoutEffect(() => {'), editor.indexOf('\n  const save ='));
assert.ok(askSource.startsWith('  const ask =') && cleanupSource.startsWith('  useLayoutEffect('), 'actual component callback boundaries must exist');
const makeAsk = new Function('scope', `const { question, asking, corpus, requestOwner, ownerRef, mounted, draft, guide, selectedFacts, questionRequest, controller, activeQuestion, track, fetch, refresh, openAccount, setAsking, setError, setAnswer, setDraft, setNotice, membershipApiUrl, validateQaResponse, crypto, window, AbortController, setTimeout, clearTimeout, useLayoutEffect } = scope;
${cleanupSource}
${askSource}
return ask;`);
const corpus = { source: { snapshotDate: '2026-10-05' }, chapters: [{ title: '合成章节', file: 'synthetic.md', entries: [{ id: '15-1', title: '合成来源' }] }] };
const answered = { status: 'answered', answer: { intro: '合成回答', steps: [{ title: '合成步骤', detail: '合成步骤内容', entryIds: ['15-1'] }], caveat: '' }, sources: [{ id: '15-1' }], draft: { content: 'synthetic-private-draft', tasks: [{ id: 'new-task', title: '合成任务' }], sourceIds: ['15-1'] } };
const insufficient = { status: 'insufficient', answer: { intro: '依据不足', steps: [], caveat: '' }, sources: [] };
const reply = (body = answered, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

function harness(t, options = {}) {
  const events = [], calls = [], errors = [], answers = [], drafts = [], busy = [], timers = new Map();
  let cleanup, refreshed = 0, opened = 0;
  const scope = {
    question: 'synthetic-private-question@example.test', asking: false, corpus, requestOwner: 'synthetic-private-owner',
    ownerRef: { current: 'synthetic-private-owner' }, mounted: { current: true }, draft: null,
    guide: { id: 'synthetic-private-guide', revision: 3, title: '合成指南', tasks: [], factIds: [] },
    selectedFacts: ['synthetic-private-fact'], questionRequest: { current: null }, controller: { current: null }, activeQuestion: { current: null },
    track: (name, dimensions) => { events.push({ name, dimensions }); },
    fetch: async (...args) => { calls.push(args); return options.fetch ? options.fetch(...args) : reply(); },
    refresh: async () => { refreshed++; if (options.refreshError) throw new Error('synthetic-refresh-failure'); },
    openAccount: () => { opened++; }, setAsking: value => busy.push(value), setError: value => errors.push(value),
    setAnswer: value => answers.push(value), setDraft: value => drafts.push(value), setNotice: () => {},
    membershipApiUrl: path => `https://synthetic.invalid/api/${path}`, validateQaResponse, crypto: { randomUUID },
    window: { confirm: () => true }, AbortController,
    setTimeout: callback => { const token = {}; timers.set(token, callback); return token; }, clearTimeout: token => timers.delete(token),
    useLayoutEffect: callback => { cleanup = callback(); }, ...options.scope,
  };
  const ask = makeAsk(scope), dispose = () => cleanup?.(); t.after(dispose);
  return { scope, events, calls, errors, answers, drafts, busy, timers, ask: () => ask({ preventDefault() {} }),
    dispose, timeout: () => [...timers.values()].forEach(callback => callback()), refreshed: () => refreshed, opened: () => opened };
}
function outcomes(h) { return h.events.filter(event => event.name === 'qa_result').map(event => event.dimensions.outcome); }
function assertPrivateFree(h) {
  for (const event of h.events) {
    assert.deepEqual(Object.keys(event.dimensions).sort(), event.name === 'qa_submit' ? ['kind'] : ['kind', 'outcome']);
    assert.equal(event.dimensions.kind, 'personal');
    assert.ok(validateAnalyticsPayload({ version: 1, sessionId: 'ab'.repeat(16), ...event }));
  }
  assert.doesNotMatch(JSON.stringify(h.events), /synthetic-private|@example|https:\/\//);
}

test('personal analytics: actual component uses the shared hook, success and insufficiency emit fixed one-shot results', async t => {
  assert.match(source, /import \{ useAnalytics \} from '\.\.\/analytics';/);
  assert.match(editor, /const track = useAnalytics\(\)/);
  for (const [body, outcome] of [[answered, 'success'], [insufficient, 'unavailable']]) {
    const h = harness(t, { fetch: async () => reply(body) }); await h.ask();
    assert.deepEqual(h.events.map(event => event.name), ['qa_submit', 'qa_result']); assert.deepEqual(outcomes(h), [outcome]);
    assert.equal(h.answers.filter(Boolean).length, 1); assert.equal(h.refreshed(), 1); assert.equal(h.timers.size, 0);
    assert.equal(h.scope.activeQuestion.current, null); assert.deepEqual(h.busy, [true, false]); assertPrivateFree(h);
  }
});

test('personal analytics: duplicate same-frame submission cannot dispatch or count twice', async t => {
  const pending = deferred(), h = harness(t, { fetch: () => pending.promise }); const first = h.ask(); await h.ask();
  assert.equal(h.calls.length, 1); assert.equal(h.events.length, 1); pending.resolve(reply()); await first;
  assert.deepEqual(outcomes(h), ['success']); assertPrivateFree(h);
});

test('personal analytics: HTTP, malformed and network failures emit error without exposing failure text', async t => {
  for (const fetch of [async () => reply({ error: { message: 'synthetic-private-error' } }, 502), async () => reply({ invalid: 'synthetic-private-payload' }), async () => { throw new TypeError('synthetic-private-network'); }]) {
    const h = harness(t, { fetch }); await h.ask(); assert.deepEqual(outcomes(h), ['error']); assert.equal(h.answers.filter(Boolean).length, 0); assertPrivateFree(h);
  }
  const unauthorized = harness(t, { fetch: async () => reply({ error: { code: 'login_required' } }, 401) }); await unauthorized.ask();
  assert.equal(unauthorized.opened(), 1); assert.deepEqual(outcomes(unauthorized), ['error']);
});

test('personal analytics: manual stop and timeout each finish once, ignoring late successful transport', async t => {
  for (const timeout of [false, true]) {
    const pending = deferred(), h = harness(t, { fetch: () => pending.promise }), task = h.ask();
    if (timeout) h.timeout(); else h.scope.controller.current.abort();
    assert.deepEqual(outcomes(h), ['cancelled']); pending.resolve(reply()); await task;
    assert.deepEqual(outcomes(h), ['cancelled']); assert.equal(h.answers.filter(Boolean).length, 0); assert.equal(h.drafts.filter(Boolean).length, 0);
    assert.equal(h.refreshed(), 0); assert.equal(h.timers.size, 0); assertPrivateFree(h);
  }
});

test('personal analytics: unmount/account change cancels, suppresses late UI writes and cannot clear a newer request', async t => {
  const pending = deferred(), h = harness(t, { fetch: () => pending.promise }), task = h.ask();
  h.scope.ownerRef.current = 'synthetic-new-owner'; h.dispose();
  const nextRequest = { abort: new AbortController(), owner: 'synthetic-new-owner' }; h.scope.activeQuestion.current = nextRequest;
  const writes = [h.errors.length, h.answers.length, h.drafts.length, h.busy.length]; pending.resolve(reply()); await task;
  assert.deepEqual(outcomes(h), ['cancelled']); assert.deepEqual([h.errors.length, h.answers.length, h.drafts.length, h.busy.length], writes);
  assert.equal(h.scope.activeQuestion.current, nextRequest); assert.equal(h.refreshed(), 0); assertPrivateFree(h);
});

test('personal analytics: an aborted body read cannot apply or report a late result', async t => {
  const pending = deferred(), entered = deferred(), h = harness(t, { fetch: async () => ({ ok: true, status: 200, json: () => { entered.resolve(); return pending.promise; } }) }), task = h.ask();
  await entered.promise; h.scope.controller.current.abort(); pending.resolve(answered); await task;
  assert.deepEqual(outcomes(h), ['cancelled']); assert.equal(h.answers.filter(Boolean).length, 0); assertPrivateFree(h);
});

test('personal analytics: optional tracker or membership refresh failure cannot add another result or break the model reply', async t => {
  const h = harness(t, { refreshError: true }); await h.ask(); assert.deepEqual(outcomes(h), ['success']); assert.equal(h.answers.filter(Boolean).length, 1);
  const absent = harness(t, { scope: { track: () => { throw new Error('synthetic-tracker-failure'); } } }); await absent.ask();
  assert.equal(absent.answers.filter(Boolean).length, 1); assert.equal(absent.refreshed(), 1); assert.equal(absent.busy.at(-1), false);
});

test('personal analytics: empty, anonymous, missing-corpus or declined draft does not dispatch or count', async t => {
  for (const scope of [{ question: ' ' }, { requestOwner: '' }, { corpus: null }, { draft: {}, window: { confirm: () => false } }]) {
    const h = harness(t, { scope }); await h.ask(); assert.equal(h.calls.length, 0); assert.deepEqual(h.events, []);
  }
});

const deleteSource = source.slice(source.indexOf('  const deleted = guideId => {'), source.indexOf('\n  const profileSaved ='));
const makeDelete = new Function('scope', `const { userIdRef, userId, isCurrentGuideOwner, setData, openGuide } = scope; ${deleteSource}; return deleted;`);
test('personal guide deletion: downgrade capacity uses actual remaining count, including repeated/missing callbacks', () => {
  let state = { limit: 5, remaining: 0, guides: Array.from({ length: 6 }, (_, index) => ({ id: `guide-${index}` })) };
  const owner = { current: 'synthetic-owner' }, navigation = [], deleted = makeDelete({ userIdRef: owner, userId: owner.current, isCurrentGuideOwner,
    setData: update => { state = update(state); }, openGuide: (...args) => navigation.push(args) });
  deleted('guide-0'); assert.equal(state.guides.length, 5); assert.equal(state.remaining, 0);
  deleted('guide-0'); assert.equal(state.guides.length, 5); assert.equal(state.remaining, 0);
  deleted('guide-1'); assert.equal(state.guides.length, 4); assert.equal(state.remaining, 1);
  deleted('unknown-guide'); assert.equal(state.remaining, 1);
  const before = state; owner.current = 'another-owner'; deleted('guide-2'); assert.equal(state, before); assert.equal(navigation.length, 4);
});

test('personal guide deletion: normal paid capacity and a null directory remain correct', () => {
  for (const initial of [null, { limit: 100, remaining: 97, guides: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]) {
    let state = initial;
    makeDelete({ userIdRef: { current: 'owner' }, userId: 'owner', isCurrentGuideOwner, setData: update => { state = update(state); }, openGuide() {} })('a');
    if (initial === null) assert.equal(state, null); else { assert.equal(state.guides.length, 2); assert.equal(state.remaining, 98); }
  }
});
