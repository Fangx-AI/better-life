import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operationsHealth } from '../scripts/operations-health.mjs';

const timestamp = Date.parse('2026-10-04T10:00:00Z');
const ready = { application: 'better-life', status: 'ready', metering: true, localDemo: false,
  login: { emailConfigured: true, phoneConfigured: true }, payments: { creationEnabled: true } };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-operations-health-')), privateDir = join(directory, 'private'), backups = join(directory, 'backups');
  mkdirSync(privateDir, { mode: 0o700 }); mkdirSync(backups, { mode: 0o700 });
  const filename = join(privateDir, 'membership.sqlite'); writeFileSync(filename, 'fixture-only-no-user-database', { mode: 0o600 });
  const backup = join(backups, 'better-life-2026-10-04T09-00-00Z-fixture.blbk'); writeFileSync(backup, Buffer.alloc(64), { mode: 0o600 }); utimesSync(backup, new Date(timestamp), new Date(timestamp));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, privateDir, backups, backup, filename, options: {
    env: { MEMBERSHIP_APP_ORIGIN: 'https://better-life.fixture.test', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_BACKUP_DIR: backups },
    now: () => timestamp, allowTemporary: true, statfs: () => ({ bavail: 3 * 1024 * 1024, bsize: 4096, blocks: 8 * 1024 * 1024 }),
    fetchImpl: async () => Response.json(ready),
  } };
}

test('operations health: only known public endpoint and metadata are checked; fresh backup is explicitly unverified', async t => {
  const h = fixture(t), calls = [];
  const result = await operationsHealth({ ...h.options, fetchImpl: async (url, options) => { calls.push({ url: String(url), method: options.method, redirect: options.redirect, headers: options.headers }); return Response.json(ready); } });
  assert.equal(result.status, 'healthy'); assert.deepEqual(result.problems, []);
  assert.equal(result.checks.backupFreshness, 'fresh-unverified'); assert.equal(result.backupRestorationVerified, false); assert.equal(result.liveDeliveryVerified, false); assert.equal(result.livePaymentVerified, false);
  assert.deepEqual(calls, [{ url: 'https://better-life.fixture.test/api/health', method: 'GET', redirect: 'error', headers: { accept: 'application/json' } }]);
});

test('operations health: no paths, secret values or unexpected health payloads leak into report', async t => {
  const h = fixture(t), secret = 'fixture-private-secret-that-is-never-reported';
  const result = await operationsHealth({ ...h.options, env: { ...h.options.env, MEMBERSHIP_AUTH_SECRET: secret }, fetchImpl: async () => Response.json({ ...ready, user: { email: 'private-person@example.test', question: 'private-question' }, secret }) });
  const report = JSON.stringify(result);
  for (const privateValue of [h.directory, h.filename, h.backups, secret, 'private-person@example.test', 'private-question']) assert.equal(report.includes(privateValue), false);
});

test('operations health: unsafe origin is not called and missing configuration fails without filesystem writes', async () => {
  let called = false;
  const result = await operationsHealth({ env: { MEMBERSHIP_APP_ORIGIN: 'http://image2.fun' }, fetchImpl: async () => { called = true; throw new Error('must-not-call'); } });
  assert.equal(called, false); assert.equal(result.status, 'unavailable'); assert.ok(result.problems.includes('API_ORIGIN_CONFIGURATION')); assert.ok(result.problems.includes('PRIVATE_DATABASE_METADATA_UNAVAILABLE'));
});

test('operations health: API errors, foreign application, disabled metering and login providers fail closed', async t => {
  const h = fixture(t);
  for (const response of [new Response('private-error-detail', { status: 503 }), Response.json({ ...ready, application: 'image2' }), Response.json({ ...ready, status: 'down' })]) {
    const result = await operationsHealth({ ...h.options, fetchImpl: async () => response }); assert.ok(result.problems.includes('API_HEALTH_UNAVAILABLE')); assert.equal(JSON.stringify(result).includes('private-error-detail'), false);
  }
  const result = await operationsHealth({ ...h.options, fetchImpl: async () => Response.json({ ...ready, metering: false, localDemo: true, login: { emailConfigured: false, phoneConfigured: true } }) });
  assert.ok(result.problems.includes('PRODUCTION_METERING_OR_DEMO')); assert.ok(result.problems.includes('LOGIN_PROVIDER_NOT_CONFIGURED'));
});

test('operations health: disabled payment is a visible warning, not a claim of charge-flow completion', async t => {
  const h = fixture(t), result = await operationsHealth({ ...h.options, fetchImpl: async () => Response.json({ ...ready, payments: { creationEnabled: false } }) });
  assert.equal(result.status, 'degraded'); assert.ok(result.warnings.includes('PAYMENT_CREATION_DISABLED')); assert.equal(result.livePaymentVerified, false);
});

test('operations health: timeout and bounded health body avoid waiting on a broken upstream or logging large bodies', async t => {
  const h = fixture(t);
  const timedOut = await operationsHealth({ ...h.options, timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) }); assert.ok(timedOut.problems.includes('API_HEALTH_UNAVAILABLE'));
  const large = await operationsHealth({ ...h.options, fetchImpl: async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'application/json' } }) }); assert.ok(large.problems.includes('API_HEALTH_UNAVAILABLE'));
});

test('operations health: absent/stale/future-dated snapshots generate actionable safe alert codes', async t => {
  const h = fixture(t);
  utimesSync(h.backup, new Date(timestamp - 27 * 3_600_000), new Date(timestamp - 27 * 3_600_000));
  const stale = await operationsHealth(h.options); assert.ok(stale.problems.includes('BACKUP_STALE')); assert.equal(stale.checks.backupFreshness, 'stale');
  utimesSync(h.backup, new Date(timestamp + 6 * 60_000), new Date(timestamp + 6 * 60_000));
  const future = await operationsHealth(h.options); assert.ok(future.warnings.includes('BACKUP_CLOCK_SKEW')); assert.ok(future.problems.includes('BACKUP_MISSING'));
  rmSync(h.backup); const absent = await operationsHealth(h.options); assert.ok(absent.problems.includes('BACKUP_MISSING'));
});

test('operations health: low absolute/fractional disk space and disk lookup failures are reported', async t => {
  const h = fixture(t);
  for (const statfs of [() => ({ bavail: 1, bsize: 4096, blocks: 100 }), () => ({ bavail: 500_000, bsize: 4096, blocks: 10_000_000 })]) {
    const result = await operationsHealth({ ...h.options, statfs }); assert.ok(result.problems.includes('DISK_SPACE_LOW')); assert.equal(result.checks.disk, 'low');
  }
  const failed = await operationsHealth({ ...h.options, statfs: () => { throw new Error('private-mount-error'); } }); assert.ok(failed.problems.includes('DISK_METADATA_UNAVAILABLE')); assert.equal(JSON.stringify(failed).includes('private-mount-error'), false);
});

test('operations health: no source-app/public/release paths or directory junctions are followed', async t => {
  const h = fixture(t);
  for (const name of ['image2-shared', 'Image_2', 'public', 'dist']) {
    const result = await operationsHealth({ ...h.options, env: { ...h.options.env, MEMBERSHIP_DB_PATH: join(h.directory, name, 'users.sqlite'), MEMBERSHIP_BACKUP_DIR: join(h.directory, name, 'backups') } });
    assert.ok(result.problems.includes('PRIVATE_DATABASE_METADATA_UNAVAILABLE')); assert.ok(result.problems.includes('BACKUP_DIRECTORY_UNAVAILABLE'));
  }
  const link = join(h.directory, 'linked-backups'); symlinkSync(h.backups, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await operationsHealth({ ...h.options, env: { ...h.options.env, MEMBERSHIP_BACKUP_DIR: link } }); assert.ok(linked.problems.includes('BACKUP_DIRECTORY_UNAVAILABLE'));
  const inRelease = await operationsHealth({ ...h.options, projectRoot: h.directory }); assert.ok(inRelease.problems.includes('PRIVATE_DATABASE_METADATA_UNAVAILABLE'));
});
