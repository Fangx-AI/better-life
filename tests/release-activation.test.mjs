import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix as path, join as hostJoin, dirname as hostDirname, resolve as hostResolve } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { releaseActivation, ACTIVATION_PATHS as P, parseProductionEnv, validActivationDomain, activationUnit, activationNginx, assertDomainUnused, buildActivationEnv, assertActivationCertificateMetadata, checkActivationCertificate, checkDatabaseHeader, parseActivationArguments } from '../scripts/release-activation.mjs';

// Fully virtual Linux filesystem, commands, DNS, certificates and health. Tests
// cannot read a real env/private database, spawn services, build or use network.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const DOMAIN = 'life.fixture-owned.org', FINGERPRINT = Array(32).fill('AB').join(':'), UID = 1001, BUILD_UID = 1002;
const ready = { status: 'ready', application: 'better-life', metering: true, localDemo: false, login: { emailConfigured: true, phoneConfigured: true }, payments: { creationEnabled: false } };
const failure = code => Object.assign(new Error('synthetic-private-command-failure'), { code });
class VirtualFs {
  constructor() { this.nodes = new Map([['/', { kind: 'dir', uid: 0, gid: 0, mode: 0o755 }]]); this.fds = new Map(); this.nextFd = 1; this.mutations = []; }
  node(filename, follow = false) { const normalized = path.normalize(filename), entry = this.nodes.get(normalized); if (!entry) throw failure('ENOENT'); return follow && entry.kind === 'link' ? this.node(this.realpathSync(normalized), true) : entry; }
  put(filename, value, options = {}) { if (!this.nodes.has(path.dirname(filename))) this.mkdirSync(path.dirname(filename), { recursive: true }); this.nodes.set(filename, { kind: 'file', uid: 0, gid: 0, mode: 0o644, bytes: Buffer.from(value), ...options }); this.mutations.push(['put', filename]); }
  lstatSync(filename) { const value = this.node(filename); return { ...value, nlink: value.nlink ?? 1, size: value.bytes?.length ?? 0, isDirectory: () => value.kind === 'dir', isFile: () => value.kind === 'file', isSymbolicLink: () => value.kind === 'link' }; }
  existsSync(filename) { try { this.node(filename, true); return true; } catch { return false; } }
  readFileSync(filename, encoding) { const entry = this.node(filename, true); if (entry.kind !== 'file') throw failure('EISDIR'); return encoding ? entry.bytes.toString(encoding) : Buffer.from(entry.bytes); }
  writeFileSync(filename, bytes, options = {}) { if (typeof filename === 'number') filename = this.fds.get(filename); if (options.flag === 'wx' && this.nodes.has(filename)) throw failure('EEXIST'); const entry = this.nodes.get(filename); this.put(filename, bytes, entry ? { uid: entry.uid, gid: entry.gid, mode: entry.mode } : { mode: options.mode ?? 0o644 }); }
  mkdirSync(filename, options = {}) { if (this.nodes.has(filename)) { if (options.recursive && this.node(filename).kind === 'dir') return; throw failure('EEXIST'); } if (!this.nodes.has(path.dirname(filename))) { if (!options.recursive) throw failure('ENOENT'); this.mkdirSync(path.dirname(filename), options); } this.nodes.set(filename, { kind: 'dir', uid: 0, gid: 0, mode: options.mode ?? 0o755 }); this.mutations.push(['mkdir', filename]); }
  readdirSync(directory) { this.node(directory); return [...this.nodes.keys()].filter(file => file !== directory && path.dirname(file) === directory).map(file => path.basename(file)); }
  chownSync(filename, uid, gid) { Object.assign(this.node(filename), { uid, gid }); this.mutations.push(['chown', filename]); }
  lchownSync(filename, uid, gid) { this.chownSync(filename, uid, gid); }
  chmodSync(filename, mode) { this.node(filename).mode = mode; this.mutations.push(['chmod', filename]); }
  openSync(filename, flags, mode) { if (flags === 'wx') { if (this.nodes.has(filename)) throw failure('EEXIST'); this.put(filename, '', { mode }); } else this.node(filename); const fd = this.nextFd++; this.fds.set(fd, filename); return fd; }
  closeSync(fd) { this.fds.delete(fd); }
  fsyncSync() {}
  renameSync(original, target) { const entry = this.node(original); this.nodes.set(target, entry); this.nodes.delete(original); this.mutations.push(['rename', target]); }
  symlinkSync(target, filename) { if (this.nodes.has(filename)) throw failure('EEXIST'); this.nodes.set(filename, { kind: 'link', target, uid: 0, gid: 0, mode: 0o777 }); this.mutations.push(['symlink', filename]); }
  readlinkSync(filename) { return this.node(filename).target; }
  realpathSync(filename) { const entry = this.node(filename); return entry.kind === 'link' ? this.realpathSync(path.resolve(path.dirname(filename), entry.target)) : filename; }
  unlinkSync(filename) { this.node(filename); this.nodes.delete(filename); this.mutations.push(['unlink', filename]); }
  rmdirSync(filename) { if (this.readdirSync(filename).length) throw failure('ENOTEMPTY'); this.nodes.delete(filename); this.mutations.push(['rmdir', filename]); }
  rmSync(filename) { for (const file of [...this.nodes.keys()]) if (file === filename || file.startsWith(`${filename}/`)) this.nodes.delete(file); this.mutations.push(['rm', filename]); }
  statfsSync() { return { bavail: 10 * 1024 * 1024, bsize: 4096 }; }
  snapshot() { return JSON.stringify([...this.nodes].map(([key, value]) => [key, { ...value, bytes: value.bytes?.toString('base64') }])); }
}
function fixture({ packageJson, packageLockJson } = {}) {
  const fs = new VirtualFs(), calls = [], healthCalls = [], bundles = new Map(); let clock = Date.UTC(2026, 9, 5), active = false, currentOptions, failCommand, healthFailure;
  for (const directory of [P.releases, P.incoming, P.config, P.tls, P.data, P.backup, '/etc/systemd/system', '/etc/nginx/conf.d', '/usr/bin', '/usr/sbin']) fs.mkdirSync(directory, { recursive: true });
  for (const directory of [P.config, P.tls]) fs.chmodSync(directory, 0o700);
  for (const directory of [P.data, P.backup]) { fs.chownSync(directory, UID, UID); fs.chmodSync(directory, 0o700); }
  fs.put(P.db, 'synthetic-private-financial-db-sentinel', { uid: UID, gid: UID, mode: 0o600 }); fs.put(P.cert, 'synthetic-certificate'); fs.put(P.key, 'synthetic-private-key', { mode: 0o600 });
  for (const executable of ['/usr/bin/node', '/usr/bin/npm', '/usr/bin/env', '/usr/bin/setpriv', '/usr/bin/getent', '/usr/bin/id', '/usr/bin/systemctl', '/usr/sbin/nginx', '/usr/bin/openssl', '/usr/bin/ss', '/usr/bin/ps', '/usr/bin/pkill']) fs.put(executable, 'synthetic-executable', { mode: 0o755 });
  const env = { NODE_ENV: 'production', QA_HOST: '127.0.0.1', QA_PORT: '4178', MEMBERSHIP_DB_PATH: P.db, MEMBERSHIP_BACKUP_DIR: P.backup, MEMBERSHIP_APP_ORIGIN: `https://${DOMAIN}`, PUBLIC_SITE_ORIGIN: `https://${DOMAIN}`, PUBLIC_BASE_PATH: '/', QA_ALLOWED_ORIGINS: `https://${DOMAIN}`,
    MEMBERSHIP_LOCAL_DEMO: 'false', MEMBERSHIP_ENFORCE: 'true', MEMBERSHIP_PAYMENT_CREATE_ENABLED: 'false', MEMBERSHIP_TRUSTED_PROXY_IPS: '127.0.0.1', MEMBERSHIP_AUTH_SECRET: 'synthetic-private-auth-secret', DEEPSEEK_API_KEY: 'synthetic-private-model-secret', MEMBERSHIP_BACKUP_ENCRYPTION_KEY: 'synthetic-private-backup-key', ANALYTICS_ENABLED: 'false' };
  fs.put(P.env, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  const imageConfig = '/etc/nginx/conf.d/image2.conf', imageText = 'server { listen 443 ssl; server_name image2.fixture-owned.org; }\n'; fs.put(imageConfig, imageText);
  function seed(releaseId = 'fixture-release-1') {
    const bundle = `${P.incoming}/${releaseId}`, source = { 'package.json': packageJson ?? JSON.stringify({ name: 'better-life', scripts: { check: 'npm run build && npm test && node library/tools/check-plain.mjs && node library/tools/check-refs.mjs --check', build: 'node scripts/build.mjs && vite build && node scripts/prepare-sites-build.mjs', test: 'node --test --test-concurrency=4 tests/*.test.mjs' } }),
      'package-lock.json': packageLockJson ?? JSON.stringify({ name: 'better-life', lockfileVersion: 3, packages: { '': {}, 'node_modules/fixture': { resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } } }), 'server/app.mjs': 'synthetic trusted app source', 'scripts/production-preflight.mjs': 'synthetic trusted preflight source' };
    for (const [name, value] of Object.entries(source)) fs.put(`${bundle}/${name}`, value);
    const manifest = JSON.stringify({ releaseId, files: Object.entries(source).map(([name, value]) => ({ path: name, sha256: digest(value), size: value.length })) }); fs.put(`${bundle}/release-manifest.json`, manifest);
    const expectedSha256 = digest(manifest); bundles.set(releaseId, { source, manifest, expectedSha256 }); currentOptions = { bundle, expectedSha256, releaseId, domain: DOMAIN }; return { ...currentOptions };
  }
  const verify = ({ bundle, expectedSha256 }) => {
    const id = path.basename(bundle), original = bundles.get(id); if (!original || expectedSha256 !== original.expectedSha256 || fs.readFileSync(`${bundle}/release-manifest.json`, 'utf8') !== original.manifest || Object.entries(original.source).some(([name, value]) => fs.readFileSync(`${bundle}/${name}`, 'utf8') !== value)) throw failure('SYNTHETIC_MANIFEST');
    return { verified: true, releaseId: id, sourceBytes: 1000 };
  };
  const stage = input => { verify(input); if (fs.existsSync(input.destination)) throw failure('EEXIST'); fs.mkdirSync(input.destination, { mode: 0o700 }); const original = bundles.get(path.basename(input.bundle)); for (const [name, value] of Object.entries({ ...original.source, 'release-manifest.json': original.manifest })) fs.put(`${input.destination}/${name}`, value); };
  const run = async call => {
    calls.push(structuredClone(call)); const selected = failCommand?.(call, calls.length); if (selected) return { code: 1, stdout: 'synthetic-private-runner-output' };
    const args = call.args, name = path.basename(call.program);
    if (name === 'node') return { code: 0, stdout: '24.13.0\n' };
    if (name === 'getent') { const uid = args[1] === 'better-life' ? UID : BUILD_UID; return { code: 0, stdout: `${args[1]}:x:${uid}:${uid}::/nonexistent:/usr/sbin/nologin\n` }; }
    if (name === 'id') return { code: 0, stdout: `${args[1] === 'better-life' ? UID : BUILD_UID}\n` };
    if (name === 'pkill') return { code: 1, stdout: '' };
    if (name === 'ps') return { code: 1, stdout: '' };
    if (name === 'ss') return { code: 0, stdout: active ? 'LISTEN 0 511 127.0.0.1:4178 0.0.0.0:* users:(("node",pid=321,fd=22))\n' : '' };
    if (name === 'openssl') return { code: 0, stdout: `${P.cert}: OK\n` };
    if (name === 'nginx') return { code: 0, stdout: args[0] === '-T' ? `# configuration file ${imageConfig}:\n${imageText}${fs.existsSync(P.nginx) ? `# configuration file ${P.nginx}:\n${fs.readFileSync(P.nginx, 'utf8')}` : ''}` : '' };
    if (name === 'systemctl') {
      if (args[0] === 'show') return { code: 0, stdout: `LoadState=${fs.existsSync(P.unit) ? 'loaded' : 'not-found'}\nActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? 321 : 0}\nFragmentPath=${fs.existsSync(P.unit) ? P.unit : ''}\nDropInPaths=\n` };
      if (args[0] === 'start') active = true; if (args[0] === 'stop') active = false; return { code: 0, stdout: '' };
    }
    if (name === 'setpriv') {
      if (args.includes('check')) { fs.put(`${call.cwd}/dist/client/index.html`, 'synthetic-public-built-site', { uid: BUILD_UID, gid: BUILD_UID, mode: 0o644 }); fs.put(`${call.cwd}/node_modules/fixture/index.js`, 'synthetic locked dependency', { uid: BUILD_UID, gid: BUILD_UID }); }
      return { code: 0, stdout: args.at(-1) === 'scripts/production-preflight.mjs' ? JSON.stringify({ readyForProductionStartup: true }) : '' };
    }
    throw failure('UNEXPECTED_COMMAND');
  };
  const deps = { fs, run, verify, stage, platform: 'linux', uid: 0, pid: 12345, now: () => clock, sleep: async ms => { clock += ms; }, processAlive: () => false,
    preflight: () => ({ readyForProductionStartup: true }), identityCheck: () => true, certificate: () => ({ fingerprint: FINGERPRINT }), addresses: () => ['203.0.113.20'], resolveDomain: async () => [{ address: '203.0.113.20', family: 4 }],
    health: async input => { healthCalls.push(input); if (healthFailure?.(input, fs.existsSync(P.unit) ? fs.readFileSync(P.unit, 'utf8') : '')) throw failure('SYNTHETIC_HEALTH'); return active ? structuredClone(ready) : { status: 'unavailable' }; } };
  seed(); fs.mutations.length = 0;
  return { fs, deps, env, calls, healthCalls, seed, get options() { return { ...currentOptions }; }, invoke: (action, options = {}, overrides = {}) => releaseActivation({ ...currentOptions, ...(action ? { action } : {}), ...options }, { ...deps, ...overrides }),
    fail: handler => { failCommand = handler; }, failHealth: handler => { healthFailure = handler; }, active: () => active,
    safe: () => { assert.equal(fs.readFileSync(P.db, 'utf8'), 'synthetic-private-financial-db-sentinel'); assert.equal(fs.readFileSync(imageConfig, 'utf8'), imageText); assert.ok(!calls.some(call => call.args.some(arg => /image2\.service/i.test(arg)))); assert.ok(!fs.mutations.some(([, file]) => file === P.db || file.startsWith(`${P.db}-`))); },
  };
}

test('activation default preflight is read-only, verifies trusted bundle and never claims build or activation', async () => {
  const h = fixture(), before = h.fs.snapshot(), result = await h.invoke(); assert.equal(result.ok, true); assert.equal(result.state, 'preflight-passed'); assert.equal(result.productionActivated, false); assert.equal(result.buildAndTestsVerified, false);
  assert.equal(h.fs.snapshot(), before); assert.equal(h.fs.mutations.length, 0); assert.ok(!h.calls.some(call => call.args.includes('start') || call.args.includes('reload') || call.args.includes('ci'))); h.safe();
});
test('actual repository package and lockfile pass the virtual read-only production preflight contract', async () => {
  // Only public source metadata is read. All Linux paths, secrets, commands,
  // certificates, DNS and database sentinels remain synthetic and injected.
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const packageLockJson = readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8');
  assert.equal(JSON.parse(packageJson).scripts.test, 'node --test --test-concurrency=4 tests/*.test.mjs');
  const h = fixture({ packageJson, packageLockJson }), before = h.fs.snapshot(), result = await h.invoke('preflight');
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.state, 'preflight-passed'); assert.equal(result.productionActivated, false); assert.equal(result.buildAndTestsVerified, false);
  assert.equal(h.fs.snapshot(), before); assert.equal(h.fs.mutations.length, 0); assert.equal(h.healthCalls.length, 0);
  assert.ok(!h.calls.some(call => call.args.includes('start') || call.args.includes('reload') || call.args.includes('ci') || call.args.includes('check'))); h.safe();
});
test('test script contract rejects old uncapped, arbitrary concurrency, loaders and shell injection before mutation', async () => {
  const actualPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const command of ['node --test tests/*.test.mjs', 'node --test --test-concurrency=8 tests/*.test.mjs', 'node --test --test-concurrency=4 --import=./injected.mjs tests/*.test.mjs', 'node --test --test-concurrency=4 tests/*.test.mjs; node injected.mjs', 'node --test --test-concurrency=4 tests/*.test.mjs\nnode injected.mjs']) {
    const h = fixture({ packageJson: JSON.stringify({ ...actualPackage, scripts: { ...actualPackage.scripts, test: command } }) }), before = h.fs.snapshot(), result = await h.invoke('preflight');
    assert.equal(result.ok, false); assert.equal(result.code, 'LOCKED_DEPENDENCIES'); assert.equal(h.fs.snapshot(), before); assert.equal(h.fs.mutations.length, 0); assert.equal(h.healthCalls.length, 0); h.safe();
  }
});
test('real bundled lock metadata requires its closest declared registry and SHA512 anchor', async () => {
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8'), realLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const parent = 'node_modules/@tailwindcss/oxide-wasm32-wasi', child = `${parent}/node_modules/@emnapi/core`;
  assert.equal(realLock.packages[child].inBundle, true); assert.ok(realLock.packages[parent].bundleDependencies.includes('@emnapi/core'));
  assert.equal(Object.hasOwn(realLock.packages[child], 'resolved'), false); assert.equal(Object.hasOwn(realLock.packages[child], 'integrity'), false);
  // A nested bundled dependency has a declared dependency relation at every
  // bundled level, with fetch integrity anchored at the deepest registry parent.
  const nested = structuredClone(realLock); nested.packages[`${child}/node_modules/tslib`] = structuredClone(realLock.packages[`${parent}/node_modules/tslib`]);
  const accepted = fixture({ packageJson, packageLockJson: JSON.stringify(nested) }), before = accepted.fs.snapshot();
  assert.equal((await accepted.invoke('preflight')).ok, true); assert.equal(accepted.fs.snapshot(), before); accepted.safe();
  const malicious = [
    lock => { lock.packages[child] = null; },
    lock => { lock.packages[child] = []; },
    lock => { lock.packages['node_modules/unanchored'] = { version: '1.0.0', inBundle: true }; },
    lock => { lock.packages['node_modules/missing/node_modules/unanchored'] = { version: '1.0.0', inBundle: true }; },
    lock => { delete lock.packages[parent].bundleDependencies; },
    lock => { delete lock.packages[parent].integrity; },
    lock => { lock.packages[parent].resolved = 'https://unknown.invalid/parent.tgz'; },
    lock => { lock.packages[child].resolved = 'https://registry.npmjs.org/child/-/child-1.0.0.tgz'; },
    lock => { lock.packages[child].resolved = 'file:../../outside'; },
    lock => { lock.packages[child].integrity = `sha512-${Buffer.alloc(64).toString('base64')}`; },
    lock => { lock.packages[child].link = true; },
    lock => { lock.packages[child].link = false; },
    lock => { lock.packages[child].path = '/outside'; },
    lock => { lock.packages[child].workspace = true; },
    lock => { lock.packages[child].version = 'file:../../outside'; },
    lock => { lock.packages[child].inBundle = 'true'; },
    lock => { lock.packages[child].inBundle = false; },
    lock => { lock.packages[`${parent}/node_modules/../outside`] = { version: '1.0.0', inBundle: true }; },
    lock => { lock.packages[`${parent}\\node_modules\\outside`] = { version: '1.0.0', inBundle: true }; },
    lock => { lock.packages[`${parent}/node_modules/not-declared`] = { version: '1.0.0', inBundle: true }; },
    lock => { lock.packages[`${child}/node_modules/not-declared`] = { version: '1.0.0', inBundle: true }; },
    lock => { lock.packages[`${child}/node_modules/tslib`] = { version: '1.0.0', inBundle: true }; lock.packages[child].dependencies.tslib = 'file:../../outside'; },
    lock => { lock.packages[`${child}/node_modules/tslib`] = { version: '1.0.0', inBundle: true }; lock.packages[child] = { version: '1.0.0', resolved: 'https://registry.npmjs.org/core/-/core-1.0.0.tgz', integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, bundleDependencies: [] }; },
  ];
  for (const mutate of malicious) {
    const lockfile = structuredClone(realLock); mutate(lockfile);
    const h = fixture({ packageJson, packageLockJson: JSON.stringify(lockfile) }), unchanged = h.fs.snapshot(), result = await h.invoke('preflight');
    assert.equal(result.ok, false); assert.equal(result.code, 'LOCKED_DEPENDENCIES'); assert.equal(h.fs.snapshot(), unchanged); assert.equal(h.fs.mutations.length, 0); assert.equal(h.healthCalls.length, 0); h.safe();
  }
});
test('CLI defaults option-first/empty arguments to preflight and rejects duplicate, unknown, odd or malformed arguments', async () => {
  const h = fixture(), options = h.options, flags = ['--bundle', options.bundle, '--release-id', options.releaseId, '--domain', options.domain, '--expected-sha256', options.expectedSha256];
  assert.deepEqual(parseActivationArguments(), { action: 'preflight' }); assert.deepEqual(parseActivationArguments([]), { action: 'preflight' });
  assert.deepEqual(parseActivationArguments(flags), { action: 'preflight', ...options });
  for (const action of ['preflight', 'activate', 'rollback', 'recover']) assert.deepEqual(parseActivationArguments([action, ...flags]), { action, ...options });
  const before = h.fs.snapshot(), result = await releaseActivation(parseActivationArguments(flags), h.deps); assert.equal(result.ok, true); assert.equal(result.state, 'preflight-passed'); assert.equal(h.fs.snapshot(), before);
  for (const args of [['unknown', ...flags], [...flags, '--domain', DOMAIN], [...flags, '--unknown', 'value'], ['--bundle'], ['activate', '--bundle'], ['--bundle', '--domain'], ['--domain', ''], ['--', 'value'], ['--domain', DOMAIN, 'activate'], ['--domain', null], 'activate']) assert.equal(parseActivationArguments(args), null);
  h.safe();
});
test('Linux idle ps exit 1 is allowed, other selection errors or non-PID stdout fail closed; backup scope matches existing timer', async () => {
  const h = fixture(); assert.equal((await h.invoke()).ok, true); assert.equal((await h.invoke('activate')).ok, true); assert.equal(P.backup, '/var/backups/better-life'); assert.ok(activationUnit(`${P.releases}/fixture`).includes(`ReadWritePaths=${P.data} /var/backups/better-life`));
  for (const [code, stdout] of [[2, ''], [1, '123'], [0, 'not-a-pid']]) { const bad = fixture(), run = bad.deps.run, before = bad.fs.snapshot(); const result = await bad.invoke('activate', {}, { run: async call => call.program.endsWith('/ps') ? { code, stdout } : run(call) }); assert.equal(result.ok, false); assert.equal(result.code, 'BUILD_PROCESSES'); assert.equal(bad.fs.snapshot(), before); }
});
test('explicit activation installs only the independent unit/current/config after candidate health; build never receives secrets', async () => {
  const h = fixture(), result = await h.invoke('activate'); assert.equal(result.ok, true); assert.equal(result.state, 'committed'); assert.equal(result.paymentCreationEnabled, false);
  assert.equal(h.fs.readlinkSync(P.current), `${P.releases}/${h.options.releaseId}`); assert.equal(h.fs.readFileSync(P.unit, 'utf8'), activationUnit(`${P.releases}/${h.options.releaseId}`)); assert.equal(h.fs.readFileSync(P.nginx, 'utf8'), activationNginx(DOMAIN));
  const builds = h.calls.filter(call => call.program === '/usr/bin/setpriv' && call.args.includes('/usr/bin/npm')); assert.equal(builds.length, 2); assert.ok(builds[0].args.includes('--ignore-scripts')); assert.ok(builds[0].args.includes('--include=dev'));
  for (const call of builds) { assert.equal(call.env.NODE_ENV, 'production'); assert.ok(call.env.NPM_CONFIG_USERCONFIG.endsWith('/user.npmrc')); assert.ok(call.env.NPM_CONFIG_GLOBALCONFIG.endsWith('/global.npmrc')); assert.notEqual(call.env.NPM_CONFIG_USERCONFIG, call.env.NPM_CONFIG_GLOBALCONFIG); assert.ok(call.args.includes('--no-new-privs')); for (const [key, value] of Object.entries(h.env)) if (/SECRET|KEY/.test(key)) { assert.ok(!(key in call.env)); assert.ok(!JSON.stringify(call.args).includes(value)); } }
  assert.ok(h.healthCalls.some(call => call.tls === true)); assert.equal(h.fs.node(`${P.releases}/${h.options.releaseId}`).uid, 0); h.safe();
});
test('activation aborts before any mutation for invalid scope, placeholders, weak permissions, active locks, untrusted source and foreign ports', async () => {
  const scenarios = [
    h => ({ options: { bundle: '/srv/image2/source' } }), h => ({ options: { releaseId: '../escape' } }), h => ({ options: { domain: 'better-life.example.test' } }),
    h => ({ overrides: { platform: 'win32' } }), h => ({ overrides: { uid: 1000 } }),
    h => { h.fs.node(P.env).mode = 0o644; return {}; }, h => { h.fs.node(P.data).uid = BUILD_UID; return {}; },
    h => { h.fs.node(P.releases).mode = 0o700; return {}; }, h => { h.fs.node('/var/backups').mode = 0o700; return {}; },
    h => { h.fs.symlinkSync('/srv/image2', `${P.releases}/bad`); h.fs.nodes.set(P.incoming, { kind: 'link', target: '/srv/image2', uid: 0, mode: 0o777 }); return {}; },
    h => { h.fs.mkdirSync(P.lock, { mode: 0o700 }); return {}; }, h => { h.fs.put(`${h.options.bundle}/server/app.mjs`, 'tampered'); return {}; },
    h => { h.fs.put(P.unit, '# unknown existing service'); return {}; },
    h => ({ overrides: { run: async call => call.program.endsWith('/ss') ? { code: 0, stdout: 'LISTEN 0 511 0.0.0.0:4178 0.0.0.0:* users:(("other",pid=789,fd=2))' } : h.deps.run(call) } }),
    h => ({ overrides: { resolveDomain: async () => [{ address: '203.0.113.99', family: 4 }] } }),
  ];
  for (const setup of scenarios) { const h = fixture(), data = setup(h), before = h.fs.snapshot(), result = await h.invoke('activate', data.options, data.overrides); assert.equal(result.ok, false); assert.equal(result.state, 'blocked'); assert.equal(h.fs.snapshot(), before); }
});
test('new-order enablement, executable env keys and duplicate/quoted env values are fail-closed', async () => {
  for (const tail of ['MEMBERSHIP_PAYMENT_CREATE_ENABLED=true', 'NODE_OPTIONS=--import=malicious', 'LD_PRELOAD=/tmp/injected', 'QA_PORT=4179', 'PUBLIC_BASE_PATH=/better-life/', 'EXTRA_SECRET=value']) {
    const h = fixture(); let bytes = h.fs.readFileSync(P.env, 'utf8'); const key = tail.split('=')[0]; bytes = bytes.replace(new RegExp(`^${key}=.*\\n`, 'm'), ''); h.fs.put(P.env, `${bytes}${tail}\n`, { mode: 0o600 }); const before = h.fs.snapshot(); assert.equal((await h.invoke('activate')).ok, false); assert.equal(h.fs.snapshot(), before);
  }
  for (const text of ['A=one\nA=two', 'MEMBERSHIP_AUTH_SECRET="secret"', 'MEMBERSHIP_AUTH_SECRET=$(cat)', 'MEMBERSHIP_AUTH_SECRET=x\\y', 'MEMBERSHIP_AUTH_SECRET= x']) assert.throws(() => parseProductionEnv(text));
});
test('SAN is mandatory, wrong host/future/near-expiry fail, key/PEM failures stay generic, and nginx cannot borrow a domain', () => {
  const time = Date.UTC(2026, 9, 5), base = { subjectAltName: `DNS:${DOMAIN}`, validFrom: new Date(time - 86400000).toUTCString(), validTo: new Date(time + 30 * 86400000).toUTCString(), checkHost: (host, options) => { assert.equal(options.subject, 'never'); return host === DOMAIN ? host : undefined; } };
  assert.doesNotThrow(() => assertActivationCertificateMetadata(base, DOMAIN, time));
  for (const change of [{ subjectAltName: undefined }, { checkHost: () => undefined }, { validFrom: new Date(time + 1000).toUTCString() }, { validTo: new Date(time + 6 * 86400000).toUTCString() }]) assert.throws(() => assertActivationCertificateMetadata({ ...base, ...change }, DOMAIN, time));
  assert.throws(() => checkActivationCertificate('not-a-certificate', 'synthetic-private-key', DOMAIN, time), error => !error.message.includes('synthetic-private'));
  for (const name of [DOMAIN, '*.fixture-owned.org', '.fixture-owned.org', 'life.*', '~^life', '$dynamic']) assert.throws(() => assertDomainUnused(`# configuration file /etc/nginx/conf.d/unrelated.conf:\nserver { server_name ${name}; }`, DOMAIN, null));
  assert.doesNotThrow(() => assertDomainUnused('server { server_name image2.fixture-owned.org; }', DOMAIN, null));
  assert.throws(() => assertDomainUnused(`# configuration file ${P.nginx}:\nserver { server_name ${DOMAIN}; }`, DOMAIN, activationNginx(DOMAIN)));
  for (const domain of ['localhost', 'example.com', 'a.test', 'a.invalid', 'a.local', 'a.example.org', '127.0.0.1', 'x.org;rm', 'Life.fixture-owned.org']) assert.equal(validActivationDomain(domain), false);
});
test('builder env is an explicit non-sensitive whitelist and changing locked install/check metadata is rejected', async () => {
  const h = fixture(), env = buildActivationEnv({ ...h.env, PATH: '/tmp/evil', NODE_OPTIONS: '--import=evil', LD_PRELOAD: 'evil', HTTP_PROXY: 'secret-url', VITE_SECRET: 'private' }, `${P.releases}/fixture`);
  assert.equal(env.PATH, '/usr/bin:/bin'); for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'HTTP_PROXY', 'VITE_SECRET', 'MEMBERSHIP_AUTH_SECRET', 'DEEPSEEK_API_KEY']) assert.ok(!(name in env));
  for (const change of [lock => { lock.packages['node_modules/fixture'].resolved = 'https://unknown.test/file.tgz'; }, lock => { delete lock.packages['node_modules/fixture'].integrity; }, lock => { lock.packages['node_modules/fixture'].link = true; }]) {
    const fresh = fixture(), filename = `${fresh.options.bundle}/package-lock.json`, lockfile = JSON.parse(fresh.fs.readFileSync(filename, 'utf8')); change(lockfile); fresh.fs.put(filename, JSON.stringify(lockfile));
    // Manifest authenticity and dependency policy are distinct gates.
    const result = await fresh.invoke('activate', {}, { verify: () => ({ verified: true, releaseId: fresh.options.releaseId }) }); assert.equal(result.ok, false); assert.equal(result.code, 'LOCKED_DEPENDENCIES');
  }
});
test('build failure removes only this candidate and leaves prior live code/config and database unchanged', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current), unit = h.fs.readFileSync(P.unit, 'utf8'), conf = h.fs.readFileSync(P.nginx, 'utf8'); h.seed('fixture-release-2'); h.calls.length = 0;
  let failed = false; h.fail(call => !failed && call.args.includes('ci') ? (failed = true) : false);
  const result = await h.invoke('activate'); assert.equal(result.state, 'rolled-back'); assert.equal(result.ok, false); assert.equal(h.fs.existsSync(`${P.releases}/fixture-release-2`), false); assert.equal(h.fs.readlinkSync(P.current), previous); assert.equal(h.fs.readFileSync(P.unit, 'utf8'), unit); assert.equal(h.fs.readFileSync(P.nginx, 'utf8'), conf); assert.equal(h.active(), true); assert.ok(!h.calls.some(call => call.args[0] === 'stop')); h.safe();
});
test('candidate loopback or final TLS health failure restores old code/unit/nginx without restoring the database', async () => {
  for (const tlsOnly of [false, true]) {
    const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current); h.seed('fixture-release-2'); h.failHealth((input, unit) => unit.includes('/fixture-release-2\n') && (!tlsOnly || input.tls));
    const result = await h.invoke('activate'); assert.equal(result.ok, false); assert.equal(result.state, 'rolled-back'); assert.equal(result.databaseRestored, false); assert.equal(h.fs.readlinkSync(P.current), previous); assert.equal(h.fs.readFileSync(P.unit, 'utf8'), activationUnit(previous)); assert.equal(h.fs.readFileSync(P.nginx, 'utf8'), activationNginx(DOMAIN)); assert.equal(h.active(), true); h.safe();
    const configWrites = h.fs.mutations.filter(([verb, filename]) => verb === 'rename' && filename === P.nginx); assert.ok(configWrites.length >= 3, 'maintenance precedes candidate and rollback routing');
  }
});
test('nginx test/reload and systemd start failures perform automatic scoped rollback', async () => {
  for (const failAt of ['nginx-test', 'nginx-reload', 'candidate-start']) {
    const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current); h.seed('fixture-release-2'); let failed = false;
    h.fail(call => { if (failed) return false; const hit = failAt === 'nginx-test' ? call.program.endsWith('/nginx') && call.args[0] === '-t' : failAt === 'nginx-reload' ? call.args[0] === 'reload' : call.args[0] === 'start'; if (hit) failed = true; return hit; });
    const result = await h.invoke('activate'); assert.equal(result.state, 'rolled-back'); assert.equal(h.fs.readlinkSync(P.current), previous); assert.equal(h.fs.readFileSync(P.nginx, 'utf8'), activationNginx(DOMAIN)); h.safe();
  }
});
test('explicit rollback restores a previous sealed release, first-release rollback leaves private database intact', async () => {
  for (const prior of [false, true]) {
    const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const first = h.fs.readlinkSync(P.current); if (prior) { h.seed('fixture-release-2'); assert.equal((await h.invoke('activate')).ok, true); }
    const result = await h.invoke('rollback'); assert.equal(result.ok, true); assert.equal(result.state, 'rolled-back'); assert.equal(result.databaseRestored, false);
    if (prior) { assert.equal(h.fs.readlinkSync(P.current), first); assert.equal(h.active(), true); }
    else { assert.equal(h.fs.existsSync(P.current), false); assert.equal(h.fs.existsSync(P.unit), false); assert.equal(h.fs.existsSync(P.nginx), false); assert.equal(h.active(), false); } h.safe();
  }
});
test('interrupted journal/stale lock recover idempotently; live lock and externally changed config are never overwritten', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current); h.seed('fixture-release-2'); assert.equal((await h.invoke('activate')).ok, true);
  const journal = JSON.parse(h.fs.readFileSync(P.journal, 'utf8')); journal.state = 'switching'; h.fs.put(P.journal, JSON.stringify(journal), { mode: 0o600 }); h.fs.mkdirSync(P.lock, { mode: 0o700 }); h.fs.put(`${P.lock}/owner.json`, JSON.stringify({ application: 'better-life', pid: 777 }), { mode: 0o600 });
  const before = h.fs.snapshot(); assert.equal((await h.invoke('recover', {}, { processAlive: () => true })).ok, false); assert.equal(h.fs.snapshot(), before);
  const recovered = await h.invoke('recover'); assert.equal(recovered.state, 'rolled-back'); assert.equal(h.fs.readlinkSync(P.current), previous); assert.equal(h.fs.existsSync(P.lock), false); assert.equal((await h.invoke('recover')).ok, false); h.safe();
  const foreign = fixture(); assert.equal((await foreign.invoke('activate')).ok, true); foreign.fs.put(P.nginx, '# operator replaced with an unknown site'); const untouched = foreign.fs.readFileSync(P.nginx, 'utf8'); assert.equal((await foreign.invoke('rollback')).ok, false); assert.equal(foreign.fs.readFileSync(P.nginx, 'utf8'), untouched);
});
test('rollback failure stays maintenance/recovery-required, never deletes candidate or restores old database, then explicit recover succeeds', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); h.seed('fixture-release-2'); h.failHealth(() => true);
  // Existing service inspection must pass; begin the fault only after candidate starts.
  h.failHealth((input, unit) => unit.includes('/fixture-release-2\n')); let blockOld = false;
  const original = h.deps.health; h.deps.health = async input => { if (h.fs.existsSync(P.unit) && h.fs.readFileSync(P.unit, 'utf8').includes('/fixture-release-2\n')) blockOld = true; if (blockOld) throw failure('SYNTHETIC_OLD_HEALTH'); return original(input); };
  const result = await h.invoke('activate'); assert.equal(result.state, 'recovery-required'); assert.equal(h.fs.existsSync(`${P.releases}/fixture-release-2`), true); assert.equal(h.fs.readFileSync(P.nginx, 'utf8'), activationNginx(DOMAIN, true)); h.safe();
  h.failHealth(null); h.deps.health = original; const recovered = await h.invoke('recover'); assert.equal(recovered.ok, true); assert.equal(recovered.state, 'rolled-back'); assert.equal(h.fs.existsSync(`${P.releases}/fixture-release-2`), true); h.safe();
});
test('sealed previous release tampering or changed env cannot be silently used for code rollback', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current); h.seed('fixture-release-2'); assert.equal((await h.invoke('activate')).ok, true);
  h.fs.put(`${previous}/server/app.mjs`, 'tampered old app'); assert.equal((await h.invoke('rollback')).ok, false); assert.equal(h.fs.readlinkSync(P.current), `${P.releases}/fixture-release-2`); h.safe();
  const changed = fixture(); assert.equal((await changed.invoke('activate')).ok, true); changed.seed('fixture-release-2'); assert.equal((await changed.invoke('activate')).ok, true); changed.fs.put(P.env, changed.fs.readFileSync(P.env, 'utf8').replace('MEMBERSHIP_PAYMENT_CREATE_ENABLED=false', 'MEMBERSHIP_PAYMENT_CREATE_ENABLED=true'), { mode: 0o600 }); const result = await changed.invoke('rollback'); assert.equal(result.ok, false); assert.equal(result.state, 'recovery-required'); assert.equal(changed.fs.readFileSync(P.nginx, 'utf8'), activationNginx(DOMAIN, true)); assert.equal(changed.active(), false);
});
test('command errors never return stderr/stdout/env/private keys in results or command arguments', async () => {
  const h = fixture(); h.fail(() => true); const result = await h.invoke('activate'); const text = JSON.stringify(result); assert.ok(!text.includes('synthetic-private')); assert.ok(!text.includes('command-failure'));
  for (const call of h.calls) for (const value of ['synthetic-private-auth-secret', 'synthetic-private-model-secret', 'synthetic-private-backup-key']) assert.ok(!JSON.stringify(call.args).includes(value));
});

test('read-only preflight against an existing deployment never calls health or causes runtime analytics writes', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); h.seed('fixture-release-2'); h.healthCalls.length = 0; const before = h.fs.snapshot();
  const result = await h.invoke(); assert.equal(result.ok, true); assert.equal(h.healthCalls.length, 0); assert.equal(h.fs.snapshot(), before); h.safe();
});
test('database identity checking reads exactly the SQLite header and always closes the handle', () => {
  const header = Buffer.alloc(100); header.write('SQLite format 3\0', 0, 'ascii'); header.writeUInt32BE(0x424c4946, 68); let opened = 0, closed = 0;
  const fs = { openSync: (_file, flags) => { assert.equal(flags, 'r'); opened++; return 1; }, readSync: (_fd, bytes, offset, length, position) => { assert.equal(length, 100); assert.equal(position, 0); header.copy(bytes, offset); return 100; }, closeSync: () => { closed++; } };
  checkDatabaseHeader(fs, P.db); header.writeUInt32BE(0x11111111, 68); assert.throws(() => checkDatabaseHeader(fs, P.db)); assert.equal(opened, 2); assert.equal(closed, 2);
});
test('first-deployment forbidden creation flag or a foreign PID after startup cannot be activated', async () => {
  const h = fixture(); const result = await h.invoke('activate', {}, { health: async () => ({ ...ready, payments: { creationEnabled: true } }) }); assert.equal(result.state, 'rolled-back'); assert.equal(h.fs.existsSync(P.current), false); h.safe();
  const foreign = fixture(), run = foreign.deps.run; const failed = await foreign.invoke('activate', {}, { run: async call => {
    const response = await run(call); if (call.program.endsWith('/ss') && foreign.active()) response.stdout = 'LISTEN 0 511 127.0.0.1:4178 0.0.0.0:* users:(("foreign",pid=789,fd=2))'; return response;
  } }); assert.equal(failed.state, 'rolled-back'); assert.equal(foreign.fs.existsSync(P.current), false); foreign.safe();
});
test('a service can be active before cold-start readiness without causing a premature rollback', async () => {
  const h = fixture(); let calls = 0; const result = await h.invoke('activate', {}, { health: async () => { if (++calls < 4) throw failure('SYNTHETIC_COLD_START'); return structuredClone(ready); } });
  assert.equal(result.ok, true); assert.ok(calls >= 4); h.safe();
});
test('build-produced private files/escaping links or externally rotated env are rejected before service switching', async () => {
  for (const variant of ['private-file', 'link', 'env-rotation']) {
    const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current); h.seed('fixture-release-2'); const run = h.deps.run;
    const result = await h.invoke('activate', {}, { run: async call => { const response = await run(call); if (call.args.includes('check')) {
      if (variant === 'private-file') h.fs.put(`${call.cwd}/dist/client/leaked.key`, 'synthetic-private');
      else if (variant === 'link') h.fs.symlinkSync(P.db, `${call.cwd}/dist/client/leaked`);
      else h.fs.put(P.env, h.fs.readFileSync(P.env, 'utf8').replace('synthetic-private-auth-secret', 'synthetic-private-rotated-secret'), { mode: 0o600 });
    } return response; } });
    assert.equal(result.ok, false); assert.equal(h.fs.readlinkSync(P.current), previous); assert.equal(h.fs.readFileSync(P.nginx, 'utf8'), activationNginx(DOMAIN)); h.safe();
  }
});
test('a failed durable committed journal write is not mistaken for a committed activation', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current); h.seed('fixture-release-2'); const rename = h.fs.renameSync.bind(h.fs); let failed = false;
  h.fs.renameSync = (original, target) => { if (!failed && target === P.journal && JSON.parse(h.fs.readFileSync(original, 'utf8')).state === 'committed') { failed = true; throw failure('SYNTHETIC_DISK_WRITE'); } return rename(original, target); };
  const result = await h.invoke('activate'); assert.equal(result.ok, false); assert.equal(result.state, 'rolled-back'); assert.equal(h.fs.readlinkSync(P.current), previous); assert.equal(JSON.parse(h.fs.readFileSync(P.journal, 'utf8')).state, 'rolled-back'); h.safe();
});
test('failed restored TLS health quarantines only this site and stops its service until explicit recovery', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); h.seed('fixture-release-2'); let candidateSeen = false; const health = h.deps.health;
  h.deps.health = async input => { const unit = h.fs.existsSync(P.unit) ? h.fs.readFileSync(P.unit, 'utf8') : ''; if (unit.includes('/fixture-release-2\n')) candidateSeen = true; if (candidateSeen && input.tls) throw failure('SYNTHETIC_TLS_FAILURE'); return health(input); };
  const result = await h.invoke('activate'); assert.equal(result.state, 'recovery-required'); assert.equal(h.fs.readFileSync(P.nginx, 'utf8'), activationNginx(DOMAIN, true)); assert.equal(h.active(), false); h.safe();
  h.deps.health = health; assert.equal((await h.invoke('recover')).ok, true); h.safe();
});
test('recovering an interrupted prepare cleans its claimed source candidate without modifying service/database', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const journal = JSON.parse(h.fs.readFileSync(P.journal, 'utf8')); assert.equal((await h.invoke('rollback')).ok, true);
  // Synthetic crash fixture replaces the inactive retained release with a new,
  // never-prepared source stage. The production tool never performs this reset.
  h.fs.rmSync(journal.candidate); journal.candidatePrepared = false;
  h.deps.stage({ bundle: h.options.bundle, destination: journal.candidate, expectedSha256: h.options.expectedSha256 });
  h.fs.put(`${journal.candidate}/.activation-owner.json`, JSON.stringify({ application: 'better-life', releaseId: journal.releaseId, manifestSha256: journal.manifestSha256 })); h.fs.chownSync(journal.candidate, BUILD_UID, BUILD_UID);
  journal.state = 'preparing'; h.fs.put(P.journal, JSON.stringify(journal), { mode: 0o600 }); h.calls.length = 0;
  const result = await h.invoke('recover'); assert.equal(result.ok, true); assert.equal(h.fs.existsSync(journal.candidate), false); assert.ok(!h.calls.some(call => call.program.endsWith('/systemctl'))); h.safe();
});

test('actual local npm loads distinct synthetic blank configs without network, host env or credential files', t => {
  const candidates = [hostJoin(hostDirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), hostJoin(hostDirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js'];
  const cli = candidates.find(filename => existsSync(filename)); if (!cli) { t.skip('本机没有可用 npm CLI；真实无网络 probe 未验证。'); return; }
  const directory = mkdtempSync(hostJoin(tmpdir(), 'better-life-npm-config-test-'));
  t.after(() => { const resolved = hostResolve(directory); assert.equal(hostDirname(resolved), hostResolve(tmpdir())); assert.ok(resolved.startsWith(hostJoin(hostResolve(tmpdir()), 'better-life-npm-config-test-'))); rmSync(resolved, { recursive: true, force: true }); });
  const home = hostJoin(directory, '.build-home'); mkdirSync(home); mkdirSync(hostJoin(home, 'npm-cache'));
  writeFileSync(hostJoin(home, 'user.npmrc'), ''); writeFileSync(hostJoin(home, 'global.npmrc'), ''); writeFileSync(hostJoin(directory, '.npmrc'), ''); writeFileSync(hostJoin(directory, 'package.json'), '{"name":"synthetic-npm-config-probe","version":"0.0.0","private":true}');
  const env = buildActivationEnv({ PUBLIC_SITE_ORIGIN: `https://${DOMAIN}`, ANALYTICS_ENABLED: 'false' }, directory);
  const probe = spawnSync(process.execPath, [cli, 'config', 'get', 'registry'], { cwd: directory, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
  assert.equal(probe.status, 0, 'npm 无网络配置加载失败（未回显输出/路径/环境）'); assert.equal(probe.stdout.trim(), 'https://registry.npmjs.org/');
});
test('builder cannot replace a controlled blank npm configuration unnoticed', async () => {
  const h = fixture(), run = h.deps.run; const result = await h.invoke('activate', {}, { run: async call => { const response = await run(call); if (call.args.includes('ci')) h.fs.put(`${call.cwd}/.build-home/user.npmrc`, 'registry=https://unknown.test', { uid: BUILD_UID, gid: BUILD_UID }); return response; } });
  assert.equal(result.ok, false); assert.equal(h.fs.existsSync(P.current), false); assert.ok(!h.calls.some(call => call.args.includes('check'))); h.safe();
});

test('rollback retains a prepared release pinned by a backup unit without changing that unit or private data', async () => {
  const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const previous = h.fs.readlinkSync(P.current);
  h.seed('fixture-release-2'); assert.equal((await h.invoke('activate')).ok, true); const pinned = h.fs.readlinkSync(P.current);
  const backupUnit = '/etc/systemd/system/better-life-backup.service', contents = `[Service]\nWorkingDirectory=${pinned}\nExecStart=/usr/bin/node ${pinned}/scripts/backup-private-data.mjs\n`;
  h.fs.put(backupUnit, contents); const result = await h.invoke('rollback'); assert.equal(result.ok, true); assert.equal(h.fs.readlinkSync(P.current), previous); assert.equal(h.fs.existsSync(pinned), true); assert.equal(h.fs.readFileSync(backupUnit, 'utf8'), contents);
  assert.ok(!h.calls.some(call => call.args.includes('better-life-backup.service'))); h.safe();
});
test('stale locks from another application or non-positive/non-integer PIDs are never taken over', async () => {
  for (const owner of [{ application: 'foreign-project', pid: 777 }, { application: 'better-life', pid: 0 }, { application: 'better-life', pid: -777 }, { application: 'better-life', pid: '777' }]) {
    const h = fixture(); assert.equal((await h.invoke('activate')).ok, true); const journal = JSON.parse(h.fs.readFileSync(P.journal, 'utf8')); journal.state = 'switching'; h.fs.put(P.journal, JSON.stringify(journal), { mode: 0o600 });
    h.fs.mkdirSync(P.lock, { mode: 0o700 }); h.fs.put(`${P.lock}/owner.json`, JSON.stringify(owner), { mode: 0o600 }); const before = h.fs.snapshot(); let inspected = false;
    const result = await h.invoke('recover', {}, { processAlive: () => { inspected = true; return false; } }); assert.equal(result.ok, false); assert.equal(result.code, 'ACTIVATION_LOCKED'); assert.equal(inspected, false); assert.equal(h.fs.snapshot(), before); h.safe();
  }
});
test('root umask 0077 cannot silently make the read-only build configs or HOME inaccessible', async () => {
  const h = fixture(), open = h.fs.openSync.bind(h.fs), mkdir = h.fs.mkdirSync.bind(h.fs);
  h.fs.openSync = (filename, flags, mode) => open(filename, flags, flags === 'wx' ? mode & ~0o077 : mode);
  h.fs.mkdirSync = (filename, options = {}) => mkdir(filename, { ...options, ...(options.mode === undefined ? {} : { mode: options.mode & ~0o077 }) });
  const result = await h.invoke('activate'); assert.equal(result.ok, true); assert.equal(h.fs.lstatSync(P.unit).mode & 0o777, 0o644); assert.equal(h.fs.lstatSync(P.nginx).mode & 0o777, 0o644); h.safe();
});
