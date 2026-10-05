import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, rmSync, symlinkSync, linkSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { operationsAlert, parseAlertArguments, isPublicAlertAddress, sendAlertWebhook, OperationsAlertError } from '../scripts/operations-alert.mjs';

const timestamp = Date.parse('2026-10-05T01:00:00.000Z');
const configured = { OPERATIONS_ALERT_WEBHOOK_URL: 'https://alerts.example.com/fixed-hook/synthetic-private-token', OPERATIONS_ALERT_WEBHOOK_HOST: 'alerts.example.com' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-alert-')), stateDirectory = join(directory, 'alerts');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, stateDirectory, stateFile: join(stateDirectory, 'alerts-state.json'), options: { stateDirectory, allowTemporary: true, env: { ...configured }, now: () => timestamp, fetchImpl: async () => new Response(null, { status: 204 }) } };
}
const read = h => JSON.parse(readFileSync(h.stateFile, 'utf8'));
const safeReject = code => error => error instanceof OperationsAlertError && error.code === code && !error.message.includes('synthetic-private-token');

test('alerts: unconfigured notification is durably pending, nonzero, and never claimed as sent', async t => {
  const h = fixture(t); let calls = 0;
  const result = await operationsAlert({ ...h.options, env: {}, event: 'BACKUP_FAILED', fetchImpl: async () => { calls++; throw new Error('must-not-call'); } });
  assert.equal(result.configured, false); assert.equal(result.sent, false); assert.equal(result.status, 'pending'); assert.equal(result.reason, 'NOT_CONFIGURED'); assert.equal(result.exitCode, 2); assert.equal(calls, 0);
  const state = read(h); assert.equal(state.scopes.backup.queue.length, 1); assert.equal(state.scopes.backup.queue[0].attempts, 0); assert.equal(state.scopes.backup.receipts.length, 0);
  assert.equal(state.application, 'better-life'); assert.equal(state.version, 1);
  const noKnownIncident = await operationsAlert({ ...h.options, env: {}, event: 'RECOVERED', scope: 'app' });
  assert.equal(noKnownIncident.status, 'unconfigured'); assert.equal(noKnownIncident.sent, false); assert.equal(noKnownIncident.exitCode, 2); assert.equal(noKnownIncident.pending, 0);
});

test('alerts: webhook uses only fixed minimal payload; receipts exclude provider data, URLs and credentials', async t => {
  const h = fixture(t), calls = [];
  const result = await operationsAlert({ ...h.options, event: 'APP_FAILED', env: { ...configured, MEMBERSHIP_AUTH_SECRET: 'never-read-synthetic-auth-secret' }, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, redirect: options.redirect, credentials: options.credentials, body: JSON.parse(options.body) });
    return new Response('arbitrary-private-response-text', { status: 202, headers: { 'x-provider-secret': 'never-persist' } });
  } });
  assert.equal(result.sent, true); assert.equal(result.exitCode, 0); assert.equal(result.status, 'delivered');
  assert.deepEqual(calls, [{ url: configured.OPERATIONS_ALERT_WEBHOOK_URL, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, redirect: 'error', credentials: 'omit', body: { application: 'better-life', event: 'APP_FAILED', status: 'app_failed', version: 1, time: new Date(timestamp).toISOString() } }]);
  const state = read(h); assert.equal(state.scopes.app.queue.length, 0); assert.equal(state.scopes.app.receipts[0].httpStatus, 202); assert.equal(state.scopes.app.receipts[0].attempts, 1);
  const serialized = JSON.stringify([state, result]);
  for (const forbidden of ['synthetic-private-token', 'never-read-synthetic-auth-secret', 'arbitrary-private-response-text', 'never-persist', configured.OPERATIONS_ALERT_WEBHOOK_URL, h.directory]) assert.equal(serialized.includes(forbidden), false);
});

test('alerts: delivered incidents deduplicate across new invocations, then recovery and a new incident notify once', async t => {
  const h = fixture(t), sent = [];
  const options = { ...h.options, fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200 }; } };
  await operationsAlert({ ...options, event: 'BACKUP_FAILED' });
  const duplicate = await operationsAlert({ ...options, event: 'BACKUP_FAILED' }); assert.equal(duplicate.status, 'deduplicated'); assert.equal(duplicate.sent, false); assert.equal(sent.length, 1);
  const recovery = await operationsAlert({ ...options, event: 'RECOVERED', scope: 'backup' }); assert.equal(recovery.exitCode, 0); assert.equal(sent.length, 2); assert.equal(sent[1].event, 'RECOVERED'); assert.equal(sent[1].status, 'backup_recovered');
  await operationsAlert({ ...options, event: 'RECOVERED', scope: 'backup' }); assert.equal(sent.length, 2);
  await operationsAlert({ ...options, event: 'BACKUP_FAILED' }); assert.equal(sent.length, 3); assert.deepEqual(read(h).scopes.backup.active, ['BACKUP_FAILED']);
});

test('alerts: failed delivery keeps pending and exponential retry metadata; success records original event time', async t => {
  const h = fixture(t); let time = timestamp, calls = 0, healthy = false;
  const options = { ...h.options, now: () => time, retryBaseMs: 1000, retryMaxMs: 4000, fetchImpl: async () => { calls++; if (!healthy) throw new Error('private-password-and-error-url'); return { ok: true, status: 204 }; } };
  const first = await operationsAlert({ ...options, event: 'HEALTH_UNAVAILABLE' }); assert.equal(first.exitCode, 1); assert.equal(first.reason, 'DELIVERY_FAILED'); assert.equal(first.sent, false);
  assert.equal(read(h).scopes.health.queue[0].attempts, 1); assert.equal(read(h).scopes.health.queue[0].nextAttemptAt, timestamp + 1000);
  const premature = await operationsAlert({ ...options, event: 'HEALTH_UNAVAILABLE' }); assert.equal(premature.reason, 'RETRY_NOT_DUE'); assert.equal(calls, 1);
  time += 1000; await operationsAlert({ ...options, event: 'HEALTH_UNAVAILABLE' }); assert.equal(calls, 2); assert.equal(read(h).scopes.health.queue[0].nextAttemptAt, time + 2000);
  time += 2000; healthy = true; const success = await operationsAlert({ ...options, event: 'HEALTH_UNAVAILABLE' }); assert.equal(success.exitCode, 0); assert.equal(calls, 3);
  const receipt = read(h).scopes.health.receipts[0]; assert.equal(receipt.attempts, 3); assert.equal(receipt.time, new Date(timestamp).toISOString()); assert.equal(receipt.deliveredAt, new Date(time).toISOString());
  assert.equal(JSON.stringify([read(h), first]).includes('private-password-and-error-url'), false);
});

test('alerts: an unsent failure and recovery remain ordered and durable until explicit configuration exists', async t => {
  const h = fixture(t), sent = [];
  await operationsAlert({ ...h.options, env: {}, event: 'BACKUP_FAILED' });
  const recoveryPending = await operationsAlert({ ...h.options, env: {}, event: 'RECOVERED', scope: 'backup' }); assert.equal(recoveryPending.sent, false); assert.equal(recoveryPending.exitCode, 2); assert.equal(recoveryPending.pending, 2);
  const repeated = await operationsAlert({ ...h.options, env: {}, event: 'RECOVERED', scope: 'backup' }); assert.equal(repeated.pending, 2);
  const result = await operationsAlert({ ...h.options, event: 'RECOVERED', scope: 'backup', fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200 }; } });
  assert.equal(result.pending, 0); assert.deepEqual(sent.map(value => value.event), ['BACKUP_FAILED', 'RECOVERED']); assert.equal(read(h).scopes.backup.receipts.length, 2);
});

test('alerts: scope-specific recovery does not erase unrelated incidents; budget escalation remains distinct', async t => {
  const h = fixture(t), events = [], options = { ...h.options, fetchImpl: async (_url, options) => { events.push(JSON.parse(options.body)); return { ok: true, status: 200 }; } };
  await operationsAlert({ ...options, event: 'BACKUP_FAILED' }); await operationsAlert({ ...options, event: 'BUDGET_WARNING' }); await operationsAlert({ ...options, event: 'BUDGET_EXHAUSTED' });
  await operationsAlert({ ...options, event: 'BUDGET_WARNING' }); assert.equal(events.length, 3);
  await operationsAlert({ ...options, event: 'RECOVERED', scope: 'budget' }); assert.equal(events[3].status, 'budget_recovered'); assert.deepEqual(read(h).scopes.backup.active, ['BACKUP_FAILED']); assert.deepEqual(read(h).scopes.budget.active, []);
  const noIncident = await operationsAlert({ ...options, event: 'RECOVERED', scope: 'health' }); assert.equal(noIncident.sent, false); assert.equal(events.length, 4);
});

test('alerts: invalid HTTPS configuration cannot call transport; pending is preserved without secret leakage', async t => {
  const h = fixture(t); let calls = 0;
  const unsafe = [
    'http://alerts.example.com/hook', 'https://user:password@alerts.example.com/hook', 'https://127.0.0.1/hook', 'https://[::1]/hook',
    'https://2130706433/hook', 'https://localhost/hook', 'https://alerts.local/hook', 'https://alerts.example.com:8443/hook', 'https://alerts.example.com/hook#secret', 'https://other.example.com/hook',
  ];
  for (const url of unsafe) {
    const result = await operationsAlert({ ...h.options, event: 'APP_FAILED', env: { ...configured, OPERATIONS_ALERT_WEBHOOK_URL: url }, fetchImpl: async () => { calls++; return { ok: true, status: 200 }; } });
    assert.equal(result.reason, 'CONFIGURATION_REJECTED'); assert.equal(result.exitCode, 2); assert.equal(result.pending, 1); assert.equal(JSON.stringify(result).includes(url), false);
  }
  assert.equal(calls, 0); assert.equal(read(h).scopes.app.queue[0].attempts, 0);
});

test('alerts: non-2xx responses and ignored-signal timeouts never become receipts', async t => {
  for (const response of [{ ok: false, status: 500 }, { ok: true, status: 302 }, { ok: true, status: 0 }]) {
    const h = fixture(t), result = await operationsAlert({ ...h.options, event: 'APP_FAILED', fetchImpl: async () => response });
    assert.equal(result.exitCode, 1); assert.equal(result.pending, 1); assert.equal(read(h).scopes.app.receipts.length, 0);
  }
  const h = fixture(t); let signal;
  const result = await operationsAlert({ ...h.options, event: 'APP_FAILED', timeoutMs: 10, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(result.exitCode, 1); assert.equal(signal.aborted, true); assert.equal(read(h).scopes.app.queue.length, 1); assert.equal(existsSync(join(h.stateDirectory, 'alerts.lock')), false);
});

test('alerts: production transport rejects every private/special DNS answer before dialing', async () => {
  const body = JSON.stringify({ application: 'better-life', event: 'APP_FAILED', status: 'app_failed', version: 1, time: new Date(timestamp).toISOString() });
  const options = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal: new AbortController().signal };
  const addresses = ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.1.2', '192.168.0.1', '100.64.0.1', '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::', '2001:20::1', '3fff:1::1'];
  for (const address of addresses) {
    assert.equal(isPublicAlertAddress(address), false, address);
    await assert.rejects(sendAlertWebhook(configured.OPERATIONS_ALERT_WEBHOOK_URL, options, { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], request: () => assert.fail('private address must not dial') }), safeReject('WEBHOOK_REJECTED'));
  }
  await assert.rejects(sendAlertWebhook(configured.OPERATIONS_ALERT_WEBHOOK_URL, options, { lookup: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }], request: () => assert.fail('mixed answer must not dial') }), safeReject('WEBHOOK_REJECTED'));
  assert.equal(isPublicAlertAddress('1.1.1.1'), true); assert.equal(isPublicAlertAddress('2606:4700:4700::1111'), true);
});

test('alerts: production HTTPS DNS is pinned with TLS validation, and redirect response is not followed', async () => {
  let dialed = 0, ended = null, responseDestroyed = false;
  const payload = { application: 'better-life', event: 'BACKUP_FAILED', status: 'backup_failed', version: 1, time: new Date(timestamp).toISOString() };
  const result = await sendAlertWebhook(configured.OPERATIONS_ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload), signal: new AbortController().signal }, {
    lookup: async (_hostname, options) => { assert.deepEqual(options, { all: true, verbatim: true }); return [{ address: '1.1.1.1', family: 4 }]; },
    request: (url, options, receive) => {
      dialed++; assert.equal(url.hostname, 'alerts.example.com'); assert.equal(options.servername, url.hostname); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
      options.lookup('untrusted-rebinding-name', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
      options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]); });
      const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = () => {};
      request.end = body => { ended = body; receive({ statusCode: 302, headers: { location: 'http://169.254.169.254/' }, destroy: () => { responseDestroyed = true; } }); }; return request;
    },
  });
  assert.deepEqual(result, { ok: false, status: 302 }); assert.equal(dialed, 1); assert.equal(responseDestroyed, true); assert.deepEqual(JSON.parse(ended), payload);
  await assert.rejects(sendAlertWebhook(configured.OPERATIONS_ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ ...payload, error: 'private-free-text' }) }, { lookup: () => assert.fail('invalid payload must not resolve') }), safeReject('WEBHOOK_REJECTED'));
});

test('alerts: concurrent invocations cannot duplicate a queued send or overwrite locked state', async t => {
  const h = fixture(t); let release, started;
  const waiting = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const first = operationsAlert({ ...h.options, event: 'APP_FAILED', fetchImpl: async () => { started(); await gate; return { ok: true, status: 200 }; } });
  await waiting;
  await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED' }), safeReject('STATE_BUSY'));
  assert.equal(read(h).scopes.app.queue.length, 1); release(); await first; assert.equal(read(h).scopes.app.receipts.length, 1);
});

test('alerts: private directory/file modes, dedicated path, symlinks and foreign/corrupt state fail closed', async t => {
  const h = fixture(t);
  await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED', stateDirectory: join(h.directory, 'public', 'alerts') }), safeReject('UNSAFE_STATE_STORAGE'));
  await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED', projectRoot: h.directory }), safeReject('UNSAFE_STATE_STORAGE'));
  await operationsAlert({ ...h.options, event: 'APP_FAILED' });
  if (process.platform !== 'win32') { assert.equal(lstatSync(h.stateDirectory).mode & 0o777, 0o700); assert.equal(lstatSync(h.stateFile).mode & 0o777, 0o600); }
  const link = join(h.directory, 'linked'); symlinkSync(h.stateDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED', stateDirectory: join(link, 'alerts') }), safeReject('UNSAFE_STATE_STORAGE'));
  writeFileSync(h.stateFile, JSON.stringify({ application: 'foreign-site', secret: 'fixture-only' }), { mode: 0o600 });
  await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED' }), safeReject('INVALID_STATE'));
  writeFileSync(h.stateFile, 'not JSON fixture-only', { mode: 0o600 }); await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED' }), safeReject('INVALID_STATE'));
  if (process.platform !== 'win32') {
    chmodSync(h.stateFile, 0o644); await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED' }), safeReject('UNSAFE_STATE_STORAGE')); chmodSync(h.stateFile, 0o600);
    chmodSync(h.stateDirectory, 0o755); await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED' }), safeReject('UNSAFE_STATE_STORAGE')); chmodSync(h.stateDirectory, 0o700);
  }
});

test('alerts: state file links are rejected without reading their target or overwriting any other project', async t => {
  const h = fixture(t), target = join(h.directory, 'unrelated-fixture.txt'); mkdirSync(h.stateDirectory, { mode: 0o700 }); writeFileSync(target, 'unrelated-project-fixture', { mode: 0o600 });
  try { symlinkSync(target, h.stateFile); } catch (error) {
    // Windows without symlink privilege still exercises hard-link rejection;
    // directory junction rejection is covered independently above.
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    linkSync(target, h.stateFile);
  }
  await assert.rejects(operationsAlert({ ...h.options, event: 'APP_FAILED' }), safeReject('UNSAFE_STATE_STORAGE'));
  assert.equal(readFileSync(target, 'utf8'), 'unrelated-project-fixture'); const info = lstatSync(h.stateFile); assert.equal(info.isSymbolicLink() || info.nlink > 1, true);
});

test('alerts: CLI events/scopes/units are exact allowlists and never accept URL or free-text arguments', () => {
  for (const event of ['BACKUP_FAILED', 'APP_FAILED', 'HEALTH_UNAVAILABLE', 'BUDGET_WARNING', 'BUDGET_EXHAUSTED']) assert.deepEqual(parseAlertArguments([event]), { event });
  for (const scope of ['backup', 'app', 'health', 'budget']) assert.deepEqual(parseAlertArguments(['RECOVERED', scope]), { event: 'RECOVERED', scope });
  assert.deepEqual(parseAlertArguments(['--unit', 'better-life.service']), { event: 'APP_FAILED' }); assert.deepEqual(parseAlertArguments(['--unit', 'better-life-backup.service']), { event: 'BACKUP_FAILED' }); assert.deepEqual(parseAlertArguments(['--unit', 'better-life-health.service']), { event: 'HEALTH_UNAVAILABLE' });
  for (const args of [[], ['RECOVERED'], ['backUp_failed'], ['PRIVATE_USER_MESSAGE'], ['APP_FAILED', 'https://example.com'], ['RECOVERED', 'other-site'], ['--unit', 'image2.service'], ['--unit', 'better-life-api.service'], ['--unit', 'better-life.service;secret'], ['--unit', '../better-life.service'], ['--url', configured.OPERATIONS_ALERT_WEBHOOK_URL]]) assert.throws(() => parseAlertArguments(args), error => error instanceof OperationsAlertError);
  const script = fileURLToPath(new URL('../scripts/operations-alert.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--unit', 'image2.service'], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1); const output = JSON.parse(result.stderr.trim()); assert.equal(output.reason, 'INVALID_UNIT'); assert.equal(result.stderr.includes('image2'), false); assert.equal(result.stdout, '');
});

test('alerts: isolated systemd template validates literal %i and cannot trigger itself or mutate services', () => {
  const template = readFileSync(new URL('../deploy/better-life-alert@.service', import.meta.url), 'utf8');
  assert.ok(template.includes('User=better-life')); assert.ok(template.includes('UMask=0077')); assert.ok(template.includes('EnvironmentFile=-/etc/better-life/alerts.env')); assert.ok(template.includes('ExecStart=/usr/bin/node scripts/operations-alert.mjs --unit %i'));
  assert.equal(template.includes('%I'), false); assert.equal(/^OnFailure=/m.test(template), false); assert.equal(/ExecStart=.*(?:curl|bash|systemctl|https?:\/\/)/.test(template), false); assert.ok(template.includes('ReadWritePaths=/var/lib/better-life/alerts'));
});
