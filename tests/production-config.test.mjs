import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { productionProblems, assertProductionConfig, validHttpsOrigin } from '../server/production-config.mjs';
import { createApiRuntime } from '../server/membership-runtime.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createMembershipStore } from '../server/membership-store.mjs';
import { MEMBERSHIP_DATABASE_APPLICATION_ID, assertProductionStorage } from '../server/production-config.mjs';

const good = () => ({ NODE_ENV: 'production', MEMBERSHIP_AUTH_SECRET: randomBytes(48).toString('base64url'),
  MEMBERSHIP_APP_ORIGIN: 'https://better-life.example.test', MEMBERSHIP_DB_PATH: process.platform === 'win32' ? 'C:\\private-better-life\\membership.sqlite' : '/var/lib/better-life/membership.sqlite',
  MEMBERSHIP_ENFORCE: 'true', MEMBERSHIP_LOCAL_DEMO: 'false', QA_ALLOWED_ORIGINS: 'https://better-life.example.test', DEEPSEEK_API_KEY: 'fixture-model-key' });
test('production configuration: HTTPS, independent explicit DB, secret and metering are required before startup', () => {
  assert.deepEqual(productionProblems(good()), []);
  for (const [key, value] of Object.entries({ MEMBERSHIP_AUTH_SECRET: '', MEMBERSHIP_APP_ORIGIN: 'http://public.test', MEMBERSHIP_DB_PATH: ':memory:', MEMBERSHIP_ENFORCE: 'false', MEMBERSHIP_LOCAL_DEMO: 'true', QA_ALLOWED_ORIGINS: 'https://fangx-ai.github.io', DEEPSEEK_API_KEY: '' })) {
    const env = { ...good(), [key]: value };
    assert.ok(productionProblems(env).includes(key), key); assert.throws(() => assertProductionConfig(env), /服务未启动/);
  }
  for (const secret of ['a'.repeat(64), 'test-only-never-use-this-production-secret-0123456789', 'example-please-replace-with-secret-1234567890ABCDEFG']) assert.ok(productionProblems({ ...good(), MEMBERSHIP_AUTH_SECRET: secret }).includes('MEMBERSHIP_AUTH_SECRET'));
});
test('production configuration: credentials/path/origin values are never exposed in diagnostics', () => {
  const env = { ...good(), MEMBERSHIP_APP_ORIGIN: 'https://private-user:private-password@host.test/path', MEMBERSHIP_DB_PATH: 'relative-private-database.sqlite' };
  const problems = JSON.stringify(productionProblems(env));
  for (const value of [env.MEMBERSHIP_AUTH_SECRET, env.MEMBERSHIP_APP_ORIGIN, env.MEMBERSHIP_DB_PATH, env.DEEPSEEK_API_KEY]) assert.ok(!problems.includes(value));
  try { assertProductionConfig(env); } catch (error) { assert.ok(!error.message.includes('private-user')); assert.ok(!error.message.includes('relative-private')); }
});
test('production configuration: static/release/default/source-app DB locations and unsafe origins are rejected', () => {
  for (const value of [resolve('output/private/membership.sqlite'), resolve('dist/client/users.db'), 'membership.sqlite', ':memory:']) assert.ok(productionProblems({ ...good(), MEMBERSHIP_DB_PATH: value }).includes('MEMBERSHIP_DB_PATH'));
  for (const name of ['image2-shared', 'image2-current', 'image2-releases', 'Image_2']) {
    const source = process.platform === 'win32' ? `C:\\${name}\\membership.sqlite` : `/var/www/${name}/membership.sqlite`;
    assert.ok(productionProblems({ ...good(), MEMBERSHIP_DB_PATH: source }).includes('MEMBERSHIP_DB_PATH'));
  }
  for (const value of ['http://localhost', 'https://localhost', 'https://127.0.0.1', 'https://host.test/path', 'https://host.test?x=1', 'https://host.test#x', 'https://u:p@host.test']) assert.equal(validHttpsOrigin(value), false, value);
});
test('production startup: invalid configuration is rejected before a database/private key is created', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-production-test-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'never-created.sqlite');
  assert.throws(() => createApiRuntime({ env: { NODE_ENV: 'production', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_LOCAL_DEMO: 'true' } }), /生产配置未完成/);
  assert.equal(existsSync(filename), false);
  assert.doesNotThrow(() => assertProductionConfig({ NODE_ENV: 'development' }));
  assert.throws(() => createApiRuntime({ env: { NODE_ENV: 'prod' } }), /运行环境配置无效/);
});
test('database brand marker: unrelated SQLite databases are rejected without migration or changing their data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-db-brand-test-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const unrelated = join(directory, 'unrelated.sqlite'), db = new DatabaseSync(unrelated); db.exec('CREATE TABLE other_app(id INTEGER PRIMARY KEY); INSERT INTO other_app VALUES(1)'); db.close();
  assert.throws(() => createMembershipStore({ filename: unrelated }), /不属于 Better Life/);
  const read = new DatabaseSync(unrelated, { readOnly: true }); try { assert.equal(read.prepare('SELECT COUNT(*) AS n FROM other_app').get().n, 1); assert.equal(read.prepare('PRAGMA application_id').get().application_id, 0); assert.equal(read.prepare("SELECT name FROM sqlite_schema WHERE name='users'").get(), undefined); } finally { read.close(); }
  const owned = createMembershipStore({ filename: join(directory, 'owned.sqlite') }); try { assert.equal(owned.db.prepare('PRAGMA application_id').get().application_id, MEMBERSHIP_DATABASE_APPLICATION_ID); } finally { owned.close(); }
});
test('production storage: absent private persistent directory is rejected instead of being silently created', () => {
  const filename = join(tmpdir(), `better-life-absent-${Date.now()}`, 'membership.sqlite');
  assert.throws(() => assertProductionStorage({ NODE_ENV: 'production', MEMBERSHIP_DB_PATH: filename }), /持久数据库目录或权限不安全/); assert.equal(existsSync(filename), false);
});
test('new persistent private DB is created exclusively with owner-only Unix permissions independent of shell umask', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-db-permissions-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'membership.sqlite'), store = createMembershipStore({ filename });
  try { assert.equal(statSync(filename).isFile(), true); if (process.platform !== 'win32') assert.equal(statSync(filename).mode & 0o777, 0o600); } finally { store.close(); }
  const reopened = createMembershipStore({ filename }); try { assert.equal(reopened.db.prepare('PRAGMA application_id').get().application_id, MEMBERSHIP_DATABASE_APPLICATION_ID); } finally { reopened.close(); }
});
test('runtime health: local preview remains available, exposes no paths/secrets and responds unavailable after close', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-health-test-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'health.sqlite'), secret = 'fixture-secret-is-kept-private-0123456789abcdef';
  const runtime = createApiRuntime({ env: { NODE_ENV: 'test', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_AUTH_SECRET: secret }, getCorpus: () => ({ chapters: [] }) });
  const result = await runtime.handler(new Request('http://127.0.0.1:4200/api/health'));
  assert.equal(result.status, 200); const text = await result.text(); assert.match(text, /ready/); assert.ok(!text.includes(filename)); assert.ok(!text.includes(secret));
  assert.equal((await runtime.handler(new Request('http://127.0.0.1:4200/api/health', { method: 'POST' }))).status, 405);
  runtime.close(); assert.equal((await runtime.handler(new Request('http://127.0.0.1:4200/api/health'))).status, 503);
});
test('runtime startup: changing merchant or legacy unbound orders is rejected before serving callbacks, with original DB intact', t => {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-merchant-startup-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'membership.sqlite'), store = createMembershipStore({ filename });
  const user = store.localDemoUser('fixture-merchant-session');
  const order = store.createOrder(user, { id: 'member-month', name: '月付', amountFen: 1900, currency: 'CNY', durationDays: 30 }, 'fixture-merchant-order', 'merchant-A').order; store.close();
  const env = { NODE_ENV: 'test', MEMBERSHIP_DB_PATH: filename, MEMBERSHIP_AUTH_SECRET: 'fixture-private-login-secret-1234567890abcdef', MEMBERSHIP_APP_ORIGIN: 'https://better-life.fixture.test', MEMBERSHIP_PAYMENT_PROVIDER: 'hupijiao', MEMBERSHIP_HUPIJIAO_APPID: 'merchant-B', MEMBERSHIP_HUPIJIAO_APPSECRET: 'fixture-private-merchant-secret', MEMBERSHIP_PAYMENT_CREATE_ENABLED: 'false' };
  assert.throws(() => createApiRuntime({ env }), /其他商户的历史订单/);
  const original = createMembershipStore({ filename }); try { assert.equal(original.ownedOrder(user, order.id).merchant_id, 'merchant-A'); original.db.prepare('UPDATE orders SET merchant_id=NULL WHERE id=?').run(order.id); } finally { original.close(); }
  assert.throws(() => createApiRuntime({ env: { ...env, MEMBERSHIP_HUPIJIAO_APPID: 'merchant-A' } }), /未绑定/);
  const check = new DatabaseSync(filename, { readOnly: true }); try { assert.equal(check.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1); assert.equal(check.prepare('SELECT merchant_id FROM orders').get().merchant_id, null); } finally { check.close(); }
});
