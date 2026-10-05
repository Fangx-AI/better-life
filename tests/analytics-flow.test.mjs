import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { trackOptionalAnalytics, createQaAnalyticsAttempt, createCheckoutReturnAnalyticsAttempt, checkoutReturnOutcome, analyticsDownloadFormat } from '../src/lib/analytics-flow.mjs';
import { validateAnalyticsPayload } from '../shared/analytics-schema.mjs';
import { createQaRequestGate } from '../src/lib/qa-request-gate.mjs';
import { buildQaPayload } from '../shared/qa-history.mjs';
import { validateQaResponse } from '../src/lib/qa-response.mjs';
import { validateMember } from '../src/lib/membership-api.mjs';

// Component non-JSX callbacks execute with synthetic state, signals and deferred
// transport only. No real URL, env, private library, OTP, model or payment call.
const read = filename => readFileSync(new URL(`../src/${filename}`, import.meta.url), 'utf8');
const questionSource = read('components/guide-question.jsx'), contextSource = read('components/membership/membership-context.jsx');
const interactionsSource = read('components/analytics-interactions.jsx'), appSource = read('App.jsx');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = () => new Promise(done => setImmediate(done));
const recorder = () => { const events = []; return { events, track: (name, dimensions) => { events.push({ name, dimensions }); } }; };
function safeEvents(events) {
  for (const event of events) assert.ok(validateAnalyticsPayload({ version: 1, sessionId: 'cd'.repeat(16), ...event }));
  assert.doesNotMatch(JSON.stringify(events), /synthetic-private|@example|https?:\/\/|payment_confirmed|amountFen|orderId|userId/);
}

test('analytics flow: start/terminal result are one-shot and abort wins over late success', () => {
  for (const kind of ['public', 'personal']) {
    const h = recorder(), controller = new AbortController(), attempt = createQaAnalyticsAttempt(h.track, kind, controller.signal);
    attempt.result('success'); assert.deepEqual(h.events, []); attempt.start(); attempt.start(); controller.abort(); attempt.result('success'); attempt.result('error'); attempt.dispose();
    assert.deepEqual(h.events, [{ name: 'qa_submit', dimensions: { kind } }, { name: 'qa_result', dimensions: { kind, outcome: 'cancelled' } }]); safeEvents(h.events);
  }
});

test('analytics flow: disposing unfinished work closes as cancelled and permanently seals the attempt', () => {
  const h = recorder(), controller = new AbortController(), attempt = createQaAnalyticsAttempt(h.track, 'public', controller.signal);
  attempt.start(); attempt.dispose(); attempt.result('success'); attempt.start(); controller.abort();
  assert.deepEqual(h.events.map(event => event.dimensions.outcome).filter(Boolean), ['cancelled']);
  const unused = createQaAnalyticsAttempt(h.track, 'public'); unused.dispose(); unused.start(); unused.result('success'); assert.equal(h.events.length, 2);
});

test('analytics flow: completed work stays completed, invalid states/kinds and server revenue events cannot enter the client', () => {
  const h = recorder(), controller = new AbortController(), attempt = createQaAnalyticsAttempt(h.track, 'personal', controller.signal);
  attempt.start(); attempt.result('synthetic-private-state'); attempt.result('success'); controller.abort(); attempt.dispose();
  assert.deepEqual(h.events.map(event => event.name), ['qa_submit', 'qa_result']); assert.equal(h.events[1].dimensions.outcome, 'success');
  assert.throws(() => createQaAnalyticsAttempt(h.track, 'synthetic-private-kind'));
  trackOptionalAnalytics(h.track, 'payment_confirmed', { plan: 'member-month' }); assert.equal(h.events.length, 2); safeEvents(h.events);
});

test('analytics flow: synchronous exceptions, rejected promises, unavailable tracker and bad inputs never throw', async () => {
  for (const track of [undefined, () => { throw new Error('synthetic-private-error'); }, () => Promise.reject(new Error('synthetic-private-rejection'))]) {
    assert.doesNotThrow(() => { const attempt = createQaAnalyticsAttempt(track, 'public'); attempt.start(); attempt.result('error'); attempt.dispose(); trackOptionalAnalytics(track, 'reader_open', { source: 'graph' }); });
  }
  const h = recorder(); trackOptionalAnalytics(h.track, 'qa_submit', new Proxy({}, { get() { throw new Error('synthetic-private-getter'); }, getOwnPropertyDescriptor() { throw new Error('synthetic-private-getter'); } }));
  assert.deepEqual(h.events, []); await flush();
});

test('analytics flow: optional sends strip account, question, order, URL and arbitrary dimensions', () => {
  const h = recorder(); trackOptionalAnalytics(h.track, 'checkout_return', { outcome: 'success', question: 'synthetic-private-question', orderId: 'synthetic-private-order', userId: 'synthetic-private-user', url: 'https://synthetic-private.invalid', email: 'synthetic-private@example.test' });
  assert.deepEqual(h.events, [{ name: 'checkout_return', dimensions: { outcome: 'success' } }]); safeEvents(h.events);
});

test('checkout analytics: checked state classification is not an income event and cancellation is terminal once', () => {
  for (const [status, expected] of [['paid', 'success'], ['refunded', 'cancelled'], ['failed', 'error'], ['created', 'unavailable'], ['pending', 'unavailable'], ['expired', 'unavailable'], ['paid=true', 'unavailable'], [null, 'unavailable']]) assert.equal(checkoutReturnOutcome(status), expected);
  const h = recorder(), controller = new AbortController(), attempt = createCheckoutReturnAnalyticsAttempt(h.track, controller.signal);
  controller.abort(); attempt.result('success'); attempt.dispose(); assert.deepEqual(h.events, [{ name: 'checkout_return', dimensions: { outcome: 'cancelled' } }]); safeEvents(h.events);
});

const askSource = questionSource.slice(questionSource.indexOf('  const ask = useCallback(async value => {'), questionSource.indexOf('\n  useEffect(() => {\n    if (!questionRequest'));
assert.ok(askSource.startsWith('  const ask = useCallback('));
const makeAsk = new Function('scope', `const { corpus, loadError, gate, ownerRef, track, setConversationOwner, setDraft, setFollowup, setQuestion, setError, setBusy, requestAnimationFrame, pendingPanel, panel, buildQaPayload, turnsRef, retryKey, crypto, api, sendConversationQuestion, openAccount, validateQaResponse, setTurns, onResult, membershipStatus, refresh, document, followupId, useCallback, createQaAnalyticsAttempt } = scope; ${askSource}; return ask;`);
const corpus = { source: { snapshotDate: '2026-10-05' }, chapters: [{ title: '合成章节', entries: [{ id: '15-1', title: '合成来源' }] }] };
const answered = { status: 'answered', answer: { intro: '合成回答', steps: [{ title: '合成步骤', detail: '合成内容', entryIds: ['15-1'] }], caveat: '' }, sources: [{ id: '15-1' }] };
function questionHarness(t, options = {}) {
  const h = recorder(), transport = deferred(), turns = [], busy = [], errors = [], gate = { current: createQaRequestGate() }, ownerRef = { current: 'synthetic-private-owner' };
  const scope = { corpus, loadError: false, gate, ownerRef, track: options.track || h.track,
    setConversationOwner() {}, setDraft() {}, setFollowup() {}, setQuestion() {}, setError: value => errors.push(value), setBusy: value => busy.push(value),
    requestAnimationFrame() {}, pendingPanel: { current: null }, panel: { current: null }, buildQaPayload, turnsRef: { current: [] }, retryKey: { current: null }, crypto: { randomUUID },
    api: 'https://synthetic-private.invalid/api/ask', sendConversationQuestion: () => transport.promise, openAccount() {}, validateQaResponse,
    setTurns: value => turns.push(value), onResult() {}, membershipStatus: { enforced: false }, refresh() {}, document: {}, followupId: 'synthetic-id', useCallback: fn => fn, createQaAnalyticsAttempt };
  const ask = makeAsk(scope); t.after(() => gate.current.cancel('unmounted'));
  return { ...h, gate, ownerRef, transport, turns, busy, errors, ask: () => ask('synthetic-private-question@example.test'), answer: () => transport.resolve({ response: { ok: true }, data: answered, requestId: randomUUID() }) };
}
test('GuideQuestion actual callback: manual stop and supersession each record cancelled once, with no late rendered turn', async t => {
  for (const reason of ['cancelled', 'new-conversation', 'superseded', 'unmounted']) {
    const h = questionHarness(t), task = h.ask(); h.gate.current.cancel(reason); h.answer(); await task;
    assert.deepEqual(h.events.map(event => event.dimensions.outcome).filter(Boolean), ['cancelled']); assert.equal(h.turns.length, 0); safeEvents(h.events);
  }
});
test('GuideQuestion actual callback: owner mismatch closes discarded work, while optional tracker failure preserves success', async t => {
  const changed = questionHarness(t), task = changed.ask(); changed.ownerRef.current = 'another-owner'; changed.answer(); await task;
  assert.equal(changed.turns.length, 0); assert.deepEqual(changed.events.map(event => event.dimensions.outcome).filter(Boolean), ['cancelled']);
  const h = questionHarness(t, { track: () => { throw new Error('synthetic-private-stat-error'); } }), success = h.ask(); h.answer(); await success;
  assert.equal(h.turns.length, 1); assert.equal(h.busy.at(-1), false); assert.ok(h.errors.every(value => !value));
});

const effectSource = contextSource.slice(contextSource.indexOf('  useEffect(() => {\n    const userId ='), contextSource.indexOf('\n  const openAccount ='));
assert.ok(effectSource.startsWith('  useEffect('));
const runPaymentEffect = new Function('scope', `const { me, paymentReturn, paymentHandled, paymentRequest, memberOwner, mounted, track, setPaymentReturn, membershipRequest, validateMember, setMe, checkoutReturnOutcome, createCheckoutReturnAnalyticsAttempt, AbortController, useEffect } = scope; ${effectSource}`);
const orderId = 'f524733e-4de1-4c19-8c3e-0123456789ab';
function paymentHarness(t, options = {}) {
  const h = recorder(), transport = deferred(), members = [], requests = []; let cleanup, state = { orderId };
  const scope = { me: { user: { id: 'synthetic-private-owner' } }, paymentReturn: state, paymentHandled: { current: '' }, paymentRequest: { current: null },
    memberOwner: { current: 'synthetic-private-owner' }, mounted: { current: true }, track: options.track || h.track,
    setPaymentReturn: fn => { state = fn(state); }, membershipRequest: (...args) => { requests.push(args); return transport.promise; }, validateMember,
    setMe: member => members.push(member), checkoutReturnOutcome, createCheckoutReturnAnalyticsAttempt, AbortController, useEffect: fn => { cleanup = fn(); } };
  runPaymentEffect(scope); const dispose = () => cleanup?.(); t.after(dispose);
  const answer = (status = 'paid', userId = scope.me.user.id) => transport.resolve({ user: { id: userId, email: 'synthetic-private@example.test' }, orders: [], membership: { planId: 'member-month' }, quota: { limit: 200, used: 0, remaining: 200 }, order: { id: orderId, status, amountFen: 1900 } });
  return { ...h, scope, transport, members, requests, dispose, answer, state: () => state };
}
test('payment return actual callback: only server checked state is tracked once; tracker failure cannot turn paid into error', async t => {
  for (const status of ['paid', 'refunded', 'pending', 'failed']) {
    const h = paymentHarness(t); h.answer(status); await flush(); h.dispose();
    assert.deepEqual(h.events, [{ name: 'checkout_return', dimensions: { outcome: checkoutReturnOutcome(status) } }]); assert.equal(h.members.length, 1); assert.equal(h.state().checking, false); safeEvents(h.events);
    assert.equal(h.requests[0][0], `orders/${orderId}`); assert.equal(h.requests[0][1].method, undefined);
  }
  const h = paymentHarness(t, { track: () => { throw new Error('synthetic-private-stats-error'); } }); h.answer(); await flush();
  assert.equal(h.members.length, 1); assert.equal(h.state().order.status, 'paid'); assert.equal(h.state().error, '');
});
test('payment return actual callback: late old-owner/closed/replaced work cannot overwrite member data or emit success', async t => {
  for (const mode of ['owner', 'closed', 'replaced']) {
    const h = paymentHarness(t); if (mode === 'owner') h.scope.memberOwner.current = 'new-owner';
    if (mode === 'closed') h.dispose(); if (mode === 'replaced') h.scope.paymentRequest.current = new AbortController();
    h.answer(); await flush(); assert.equal(h.members.length, 0); assert.deepEqual(h.events, [{ name: 'checkout_return', dimensions: { outcome: 'cancelled' } }]); safeEvents(h.events);
  }
  assert.match(contextSource, /memberOwner\.current = member\.user\?\.id \|\| ''/);
});
test('payment return actual callback: mismatched owner or rejected lookup emits only fixed error and no income event', async t => {
  for (const reject of [false, true]) {
    const h = paymentHarness(t); if (reject) h.transport.reject(new Error('synthetic-private-payment-error')); else h.answer('paid', 'other-owner'); await flush();
    assert.equal(h.members.length, 0); assert.deepEqual(h.events, [{ name: 'checkout_return', dimensions: { outcome: 'error' } }]); safeEvents(h.events);
  }
});

test('download analytics: exact reviewed HTML is recognized, ordinary site HTML is never called a download', () => {
  for (const [path, format] of [['/HowToLiveBetter.html', 'html'], ['/better-life/HowToLiveBetter.html', 'html'], ['/book.pdf', 'pdf'], ['/better-life-obsidian.zip', 'obsidian'], ['/book.epub', 'epub'], ['/index.html', null], ['/content-source.html', null], ['/share/work.html', null]]) assert.equal(analyticsDownloadFormat(path), format);
});
test('actual graph/showcase navigation and delegated download handlers survive synchronous statistics failure', () => {
  const openSource = appSource.slice(appSource.indexOf('  const openEntry ='), appSource.indexOf('\n  const toggleSaved ='));
  const navigated = [], open = new Function('scope', `const { track, trackOptionalAnalytics, window, entryLocationHref, base } = scope; ${openSource}; return openEntry;`)({ track: () => { throw new Error('synthetic-private-stat-error'); }, trackOptionalAnalytics, window: { location: { assign: value => navigated.push(value) } }, entryLocationHref: () => '/?view=library#synthetic-entry', base: '/' });
  open({ id: 'synthetic-private-entry' }, 'graph'); assert.equal(navigated.length, 1);
  const clickSource = interactionsSource.slice(interactionsSource.indexOf('    const click ='), interactionsSource.indexOf('\n    document.addEventListener'));
  const makeClick = new Function('scope', `const { track, trackOptionalAnalytics, analyticsDownloadFormat, window } = scope; ${clickSource}; return click;`);
  const h = recorder(), click = makeClick({ ...h, trackOptionalAnalytics, analyticsDownloadFormat, window: { location: { origin: 'https://synthetic.invalid' } } });
  const event = { defaultPrevented: false, target: { closest: () => ({ href: 'https://synthetic.invalid/HowToLiveBetter.html?user=synthetic-private-user', closest: selector => selector === '#formats' }) } };
  click(event); assert.deepEqual(h.events, [{ name: 'download_click', dimensions: { format: 'html', source: 'formats' } }]); safeEvents(h.events);
  const failing = makeClick({ track: () => { throw new Error('synthetic-private-stat-error'); }, trackOptionalAnalytics, analyticsDownloadFormat, window: { location: { origin: 'https://synthetic.invalid' } } }); assert.doesNotThrow(() => failing(event));
});
