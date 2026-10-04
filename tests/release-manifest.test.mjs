import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReleaseBundle, verifyReleaseBundle, stageReleaseBundle, releasePathAllowed } from '../scripts/release-manifest.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-release-test-')), source = join(directory, 'source'), bundle = join(directory, 'bundle'), staged = join(directory, 'staged');
  mkdirSync(source);
  const put = (path, content = 'fixture-public-source') => { const filename = join(source, ...path.split('/')); mkdirSync(join(filename, '..'), { recursive: true }); writeFileSync(filename, content); };
  for (const [path, content] of Object.entries({ 'package.json': '{"name":"better-life","version":"fixture"}', 'package-lock.json': '{}', 'server/app.mjs': 'export const publicSource=true;', 'shared/usage-budget-config.mjs': 'export const fixture=true;', 'scripts/build.mjs': '// fixture does not execute a build', 'public/assets/home.png': 'public-image-fixture', 'library/book/1-生活.md': '原书虚构测试内容', 'docs/OPERATIONS.md': '公开运维说明', '.openai/hosting.json': '{"version":1}', 'public/.nojekyll': '', 'AGENTS.md': '公开仓库约定', 'design-qa.md': '公开设计验收说明' })) put(path, content);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, source, bundle, staged, put };
}

test('release bundle: explicit source allowlist copies hashes, supports Unicode, but never claims build or deployment', t => {
  const h = fixture(t), result = createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-release-1' });
  assert.equal(result.bundleCreated, true); assert.equal(result.productionActivated, false); assert.equal(result.buildAndTestsVerified, false); assert.equal(result.fileCount, 12);
  const verified = verifyReleaseBundle({ bundle: h.bundle, expectedSha256: result.manifestSha256 }); assert.equal(verified.verified, true);
  assert.equal(readFileSync(join(h.bundle, 'library/book/1-生活.md'), 'utf8'), '原书虚构测试内容');
  assert.equal(result.manifestSha256, hash(readFileSync(join(h.bundle, 'release-manifest.json'))));
});

test('release bundle: env/output/log/key/database/authentication files and opaque archives cannot enter the package', t => {
  const h = fixture(t);
  const forbidden = ['.env.local', '.git/config', '.npmrc', 'output/private/users.sqlite', 'server/credentials.json', 'public/auth.json', 'public/tokens.json', 'public/user.db-wal', 'public/api.key', 'docs/production.pem', 'public/debug.log', 'public/private-guide.zip', 'logs/debug.txt', 'node_modules/fake/index.js', 'dist/client/index.html'];
  for (const path of forbidden) h.put(path, 'fixture-private-content-must-not-be-bundled');
  const result = createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-private-exclusion' });
  for (const path of forbidden) assert.equal(existsSync(join(h.bundle, ...path.split('/'))), false, path);
  assert.equal(readFileSync(join(h.bundle, 'release-manifest.json'), 'utf8').includes('fixture-private-content'), false); assert.equal(result.fileCount, 12);
});

test('release bundle: exact public hosting/build inputs remain present while every other hidden tool file is excluded', t => {
  const h = fixture(t);
  h.put('.openai/credentials.json', 'must-not-read-or-copy-fixture-credential');
  h.put('.openai/nested/config.json', 'must-not-include-whole-hidden-folder');
  h.put('.other-tool/hosting.json', 'must-not-allow-another-hidden-root');
  h.put('library/source.json', '{"snapshotDate":"fixture-date"}');
  h.put('library/tools/check-plain.mjs', '// original source checker fixture');
  h.put('library/tools/check-refs.mjs', '// original reference checker fixture');
  const result = createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-build-inputs' });
  for (const path of ['.openai/hosting.json', 'AGENTS.md', 'design-qa.md', 'library/source.json', 'library/tools/check-plain.mjs', 'library/tools/check-refs.mjs']) assert.equal(existsSync(join(h.bundle, ...path.split('/'))), true, path);
  for (const path of ['.openai/credentials.json', '.openai/nested/config.json', '.other-tool/hosting.json', '.source.origin.json']) assert.equal(releasePathAllowed(path), false, path);
  assert.equal(existsSync(join(h.bundle, '.openai/credentials.json')), false); assert.equal(existsSync(join(h.bundle, '.openai/nested')), false);
  writeFileSync(join(h.bundle, '.openai/unlisted.json'), '{}');
  assert.throws(() => verifyReleaseBundle({ bundle: h.bundle, expectedSha256: result.manifestSha256 }), /校验失败/);
});

test('release bundle: absolute/traversal/ADS/encoded/control/hidden paths are rejected', () => {
  for (const path of ['/etc/passwd', 'C:/secrets.json', '../server/app.mjs', 'server/../app.mjs', 'server//app.mjs', 'server/./app.mjs', 'server\\app.mjs', 'server/a.js:payload', 'server/a.js.', 'server/a.js ', 'server/%2e%2e/a.js', 'server/private/a.js', 'public/.env', 'server/line\nbreak.js']) assert.equal(releasePathAllowed(path), false, path);
  assert.equal(releasePathAllowed('server/auth-delivery.mjs'), true, 'legitimate authentication source code is not a credential dump');
});

test('release bundle: wrong expected manifest hash, changed payload and undeclared files fail closed', t => {
  const h = fixture(t), result = createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-integrity' });
  assert.throws(() => verifyReleaseBundle({ bundle: h.bundle, expectedSha256: '0'.repeat(64) }), /未激活/);
  writeFileSync(join(h.bundle, 'server/app.mjs'), 'tampered'); assert.throws(() => verifyReleaseBundle({ bundle: h.bundle, expectedSha256: result.manifestSha256 }), /校验失败/);
  writeFileSync(join(h.bundle, 'server/app.mjs'), 'export const publicSource=true;'); writeFileSync(join(h.bundle, 'public/unlisted.json'), '{}');
  assert.throws(() => verifyReleaseBundle({ bundle: h.bundle, expectedSha256: result.manifestSha256 }), /校验失败/);
});

test('release bundle: even a rehashed malicious manifest cannot escape allowlist or duplicate paths', t => {
  const h = fixture(t); createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-malicious' });
  const original = JSON.parse(readFileSync(join(h.bundle, 'release-manifest.json'), 'utf8'));
  for (const change of [value => { value.files[0].path = '../../outside.md'; }, value => { value.files.push(value.files[0]); }, value => { value.files[0].path = 'server/secret.key'; }, value => { value.productionActivated = true; }]) {
    const changed = structuredClone(original); change(changed); const bytes = JSON.stringify(changed); writeFileSync(join(h.bundle, 'release-manifest.json'), bytes);
    assert.throws(() => verifyReleaseBundle({ bundle: h.bundle, expectedSha256: hash(bytes) }), /校验失败/);
  }
  assert.equal(existsSync(join(h.directory, 'outside.md')), false);
});

test('release bundle: source and bundle directory links cannot redirect copies or expose outside files', t => {
  const h = fixture(t), outside = join(h.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'outside.md'), 'keep-outside');
  const link = join(h.source, 'public', 'linked'); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-link' }), /校验失败/); assert.equal(existsSync(h.bundle), false);
  if (process.platform === 'win32') rmdirSync(link); else unlinkSync(link);
  const result = createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-no-link' });
  symlinkSync(outside, join(h.bundle, 'public', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageReleaseBundle({ bundle: h.bundle, destination: h.staged, expectedSha256: result.manifestSha256 }), /校验失败/); assert.equal(existsSync(h.staged), false);
  assert.equal(readFileSync(join(outside, 'outside.md'), 'utf8'), 'keep-outside');
});

test('release bundle: dry staging copies only verified files into a new directory and does not change source/current', t => {
  const h = fixture(t), result = createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-dry-stage' });
  const sourceBefore = readFileSync(join(h.source, 'server/app.mjs'));
  const staged = stageReleaseBundle({ bundle: h.bundle, destination: h.staged, expectedSha256: result.manifestSha256 });
  assert.equal(staged.staged, true); assert.equal(staged.productionActivated, false); assert.equal(staged.buildAndTestsVerified, false);
  assert.equal(verifyReleaseBundle({ bundle: h.staged, expectedSha256: result.manifestSha256 }).fileCount, result.fileCount);
  assert.deepEqual(readFileSync(join(h.source, 'server/app.mjs')), sourceBefore); assert.equal(existsSync(join(h.directory, 'better-life-current')), false);
});

test('release bundle: existing destinations/source nesting are never overwritten or recursively removed', t => {
  const h = fixture(t), prior = join(h.directory, 'prior'); mkdirSync(prior); writeFileSync(join(prior, 'keep.txt'), 'keep-prior');
  assert.throws(() => createReleaseBundle({ source: h.source, destination: prior, releaseId: 'fixture-existing' }), /校验失败/);
  assert.throws(() => createReleaseBundle({ source: h.source, destination: join(h.source, 'nested-bundle'), releaseId: 'fixture-nested' }), /校验失败/);
  const result = createReleaseBundle({ source: h.source, destination: h.bundle, releaseId: 'fixture-valid' });
  assert.throws(() => stageReleaseBundle({ bundle: h.bundle, destination: prior, expectedSha256: result.manifestSha256 }), /校验失败/);
  assert.equal(readFileSync(join(prior, 'keep.txt'), 'utf8'), 'keep-prior');
});

test('Linux installer remains explicitly dry-only, fixed-scope, and contains no install/network/service mutation', () => {
  const script = readFileSync(new URL('../deploy/install-release.sh', import.meta.url), 'utf8');
  assert.match(script, /--dry-stage/); assert.match(script, /RELEASE_ROOT=\/var\/www\/better-life-releases/); assert.match(script, /DATA_ROOT=\/var\/lib\/better-life/); assert.match(script, /ENV_FILE=\/etc\/better-life\/production\.env/);
  assert.match(script, /root-only|专用env/); assert.match(script, /process\.versions\.node/); assert.match(script, /expected-sha256/);
  const executable = script.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(executable, /(?:^|[;\s])(?:systemctl|service|nginx|npm|curl|wget|ssh|scp|apt|yum|certbot|source|ln|mv|rm)\s/);
  assert.doesNotMatch(executable, /MEMBERSHIP_PAYMENT_CREATE_ENABLED=true/); assert.doesNotMatch(executable, /image2\.fun|example\.test/);
});
