import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsApiUrl, operationsRequest, validateOperationsResponse, operationsTicketTransitions, maskedOperationsId } from '../src/lib/operations-api.mjs';

const origin = 'https://better-life.example.test', token = 'FixtureOperatorSecret0123456789_-'.repeat(2).slice(0, 64);
const at = '2026-10-04T00:00:00.000Z';
const status = { enabled: true, configured: true, available: true, privateContentVisible: false, paymentMutationAvailable: false, refundGatewayAvailable: false };
const summary = { users: 0, orders: [], orderAmounts: [], refundTickets: [] };
const ticket = { id: 'ticket-fixture-001', orderId: 'order-fixture-001', userId: 'user-fixture-001', amountFen: 1900, currency: 'CNY', state: 'reviewing', reasonCode: 'service_issue', revision: 2, createdAt: at, updatedAt: at };
const page = items => ({ items, nextCursor: null, limit: 20 });
const user = { id: 'user-fixture-001', authentication: 'email', createdAt: at, membership: { planId: 'free', expiresAt: null }, quota: { limit: 10, used: 2, reserved: 0, resetsAt: at }, orderCount: 1, guideCount: 2, savedAnswerCount: 3, hasProfile: true };
const order = { id: 'order-fixture-001', userId: user.id, planId: 'member-month', amountFen: 1900, currency: 'CNY', status: 'paid', refundState: 'none', createdAt: at, expiresAt: at, paidAt: at, refundedAt: null };
const response = (body, statusCode = 200) => new Response(JSON.stringify(body), { status: statusCode, headers: { 'content-type': 'application/json' } });

test('operations UI API: fixed first-party paths/queries never carry credentials, free text or external URLs', () => {
  assert.equal(operationsApiUrl('users', { origin, basePath: '/better-life/', query: { limit: 20, cursor: 'fixture_cursor' } }), `${origin}/better-life/api/operations/users?limit=20&cursor=fixture_cursor`);
  assert.equal(operationsApiUrl('analytics', { origin, query: { from: '2026-10-01', to: '2026-10-04' } }), `${origin}/api/operations/analytics?from=2026-10-01&to=2026-10-04`);
  for (const path of ['https://external.test/status', '//external.test', '../status', 'users?secret=private', 'refund-tickets/not valid', 'payment/mark-paid']) assert.throws(() => operationsApiUrl(path, { origin }));
  for (const query of [{ secret: token }, { token }, { email: 'private@example.test' }, { cursor: token }, { limit: 101 }, { limit: 0 }, { cursor: '../' }]) assert.throws(() => operationsApiUrl('users', { origin, query, token }));
  for (const originValue of ['javascript:alert(1)', 'https://u:secret@example.test', `${origin}/private`, 'http://insecure-public.test']) assert.throws(() => operationsApiUrl('status', { origin: originValue }));
  assert.equal(operationsApiUrl('status', { origin: 'http://127.0.0.1:4300' }), 'http://127.0.0.1:4300/api/operations/status');
});

test('operations UI API: only in-memory Bearer header, omit cookies/referrer, no-store, no redirect forwarding', async () => {
  let call;
  const data = await operationsRequest('summary', { origin, token, fetchImpl: async (...args) => { call = args; return response(summary); } });
  assert.deepEqual(data, summary); assert.equal(call[0], `${origin}/api/operations/summary`);
  assert.ok(!call[0].includes(token)); assert.equal(call[1].headers.Authorization, `Bearer ${token}`);
  assert.equal(call[1].credentials, 'omit'); assert.equal(call[1].cache, 'no-store'); assert.equal(call[1].referrerPolicy, 'no-referrer'); assert.equal(call[1].redirect, 'error');
  let statusHeaders;
  assert.deepEqual(await operationsRequest('status', { origin, fetchImpl: async (_url, options) => { statusHeaders = options.headers; return response(status); } }), { enabled: true, configured: true, available: true });
  assert.equal(statusHeaders.Authorization, undefined);
  await assert.rejects(operationsRequest('summary', { origin, token: 'short', fetchImpl: () => { throw new Error('must not send'); } }), error => error.status === 401);
});

test('operations UI API: responses retain necessary metadata only, never contacts or private content', () => {
  const privateFields = { email: 'private@example.test', phone: '13800138000', question: 'private-question', content: 'private-guide-body', token };
  const users = validateOperationsResponse('users', page([{ ...user, ...privateFields }]));
  assert.deepEqual(users.items[0], user);
  const orders = validateOperationsResponse('orders', page([{ ...order, checkoutUrl: `https://private.test/?token=${token}`, transactionId: 'private-transaction', ...privateFields }]));
  assert.deepEqual(orders.items[0], order);
  const tickets = validateOperationsResponse('refund-tickets', page([{ ...ticket, ...privateFields }])); assert.deepEqual(tickets.items[0], ticket);
  const audit = validateOperationsResponse('audit', page([{ id: 1, actor: 'private-operator', action: 'orders_viewed', result: 'allowed', targetId: order.id, clientHash: 'a'.repeat(64), details: privateFields, createdAt: at }]));
  assert.deepEqual(audit.items[0], { id: 1, action: 'orders_viewed', result: 'allowed', targetId: order.id, createdAt: at });
  const analytics = validateOperationsResponse('analytics', { configured: true, items: [{ day: '2026-10-04', name: 'qa_submit', source: 'client', event_count: 3, session_count: 2, dimensions: privateFields, ...privateFields }] });
  assert.deepEqual(analytics.items[0], { day: '2026-10-04', name: 'qa_submit', source: 'client', event_count: 3, session_count: 2 });
  for (const output of [users, orders, tickets, audit, analytics]) for (const secret of ['private@example.test', '13800138000', 'private-question', 'private-guide-body', token]) assert.ok(!JSON.stringify(output).includes(secret));
  assert.equal(maskedOperationsId(user.id), 'user-…-001'); assert.equal(maskedOperationsId('private@example.test'), '—');
});

test('operations UI API: malformed or falsely expanded privileges never become available', () => {
  assert.throws(() => validateOperationsResponse('status', { ...status, paymentMutationAvailable: true }));
  assert.throws(() => validateOperationsResponse('users', page([{ ...user, id: 'private@example.test' }])));
  assert.throws(() => validateOperationsResponse('orders', page([{ ...order, status: 'manual-paid' }])));
  assert.throws(() => validateOperationsResponse('refund-tickets', page([{ ...ticket, revision: 0 }])));
  assert.throws(() => validateOperationsResponse('summary', { ...summary, users: -1 }));
  assert.throws(() => validateOperationsResponse('analytics', { configured: true, items: [{ day: '2026-10-04', name: 'private_secret', source: 'client', event_count: 1, session_count: 1 }] }));
  assert.throws(() => validateOperationsResponse('audit', { ...page([]), nextCursor: '../private' }));
  assert.throws(() => validateOperationsResponse('audit', { items: [], limit: 20 }));
  assert.deepEqual(validateOperationsResponse('usage-budget', { configured: false, privatePath: '/private/db' }), { configured: false });
  assert.throws(() => validateOperationsResponse('usage-budget', { configured: true, day: {} }));
});

test('operations UI API: finite revision transitions and PATCH never mutate payment facts', async () => {
  assert.deepEqual(operationsTicketTransitions('requested'), ['reviewing', 'cancelled']);
  assert.deepEqual(operationsTicketTransitions('approved'), ['awaiting_provider', 'cancelled']);
  assert.deepEqual(operationsTicketTransitions('awaiting_provider'), ['reviewing', 'resolved']);
  for (const state of ['resolved', 'rejected', 'cancelled', 'unknown', 'constructor', '__proto__']) assert.deepEqual(operationsTicketTransitions(state), []);
  let call;
  const result = await operationsRequest(`refund-tickets/${ticket.id}`, { origin, token, method: 'PATCH', body: { state: 'approved', revision: 2 }, fetchImpl: async (...args) => { call = args; return response({ ticket: { ...ticket, state: 'approved', revision: 3 }, gatewayCalled: false, paymentChanged: false }); } });
  assert.equal(result.ticket.revision, 3); assert.deepEqual(JSON.parse(call[1].body), { revision: 2, state: 'approved' });
  await assert.rejects(operationsRequest(`refund-tickets/${ticket.id}`, { origin, token, method: 'PATCH', body: { state: 'approved', revision: 2, paymentStatus: 'refunded' } }));
  await assert.rejects(operationsRequest('orders', { origin, token, method: 'PATCH', body: { status: 'paid' } }));
  assert.throws(() => validateOperationsResponse(`refund-tickets/${ticket.id}`, { ticket, gatewayCalled: true, paymentChanged: true }));
});

test('operations UI API: 401/conflict/offline/timeout errors cannot echo server secrets', async () => {
  for (const [statusCode, code] of [[401, 'operations_unauthorized'], [409, 'revision_conflict'], [409, 'refund_not_verified'], [503, 'operations_disabled'], [503, 'unknown_private_code']]) {
    await assert.rejects(operationsRequest('summary', { origin, token, fetchImpl: async () => response({ error: { code, message: `private-body-${token}` } }, statusCode) }), error => { assert.equal(error.status, statusCode); assert.ok(!error.message.includes(token)); assert.ok(!error.message.includes('private-body')); assert.ok(!error.code.includes('private')); return true; });
  }
  await assert.rejects(operationsRequest('summary', { origin, token, fetchImpl: async () => { throw new Error(`offline-${token}`); } }), error => !error.message.includes(token));
  await assert.rejects(operationsRequest('summary', { origin, token, timeoutMs: 5, fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(token)), { once: true })) }), error => !error.message.includes(token));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(operationsRequest('summary', { origin, token, signal: controller.signal, fetchImpl: async () => { throw new Error(token); } }), error => error.name === 'AbortError' && !error.message.includes(token));
});
