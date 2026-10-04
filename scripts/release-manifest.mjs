import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'release-manifest.json';
const roots = new Set(['server', 'shared', 'scripts', 'src', 'assets', 'public', 'docs', 'library', 'tests', 'deploy', 'worker']);
const topFiles = new Set(['package.json', 'package-lock.json', 'index.html', 'vite.config.mjs', 'robots.txt', 'sitemap.xml', 'README.md', 'LICENSE', 'LICENSE-CONTENT', 'CONTRIBUTING.md', 'AGENTS.md', 'design-qa.md']);
const extensions = new Set(['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.sh', '.conf', '.service', '.timer']);
const forbiddenSegments = /^(?:node_modules|output|private|logs?|coverage|\.git|\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\..*)?)$/i;
const forbiddenExtension = /\.(?:env|log|har|trace|sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|key|pem|p12|pfx|crt|cer|der|blbk|bak|zip|tar|tgz|gz|7z)$/i;
const forbiddenCredentialName = /^(?:auth|credentials?|secrets?|tokens?|cookies?|sessions?|passwords?)(?:[-_.].*)?\.(?:json|txt|yaml|yml|xml|csv)$/i;
const fail = () => new Error('Better Life 发布包校验失败；未激活、未修改现网服务。');
const digest = value => createHash('sha256').update(value).digest('hex');
function inside(root, path) { const rel = relative(resolve(root), resolve(path)); return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`); }
function directoryAncestors(path) {
  for (let part = resolve(path);; part = dirname(part)) {
    if (existsSync(part)) { const info = lstatSync(part); if (!info.isDirectory() || info.isSymbolicLink()) throw fail(); }
    const parent = dirname(part); if (parent === part) break;
  }
}
export function releasePathAllowed(path) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f<>"|?*%]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[ .]$/.test(segment) || segment.includes(':') || forbiddenSegments.test(segment))) return false;
  if (forbiddenExtension.test(path) || forbiddenCredentialName.test(segments.at(-1))) return false;
  if (path === '.openai/hosting.json' || path === 'public/.nojekyll') return true;
  if (segments.some(segment => segment.startsWith('.'))) return false;
  if (segments.length === 1) return topFiles.has(path);
  return roots.has(segments[0]) && (extensions.has(extname(path).toLowerCase()) || /^(LICENSE(?:-CODE|-CONTENT)?)$/.test(segments.at(-1)));
}
function walk(root, { strict = false } = {}) {
  const files = [];
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === MANIFEST) { if (prefix || !strict) throw fail(); continue; }
      // The build needs this one public hosting file, not the rest of a hidden tool folder.
      // In source mode do not even descend into .openai subdirectories or inspect credentials.
      if (prefix === '.openai' && path !== '.openai/hosting.json') { if (strict) throw fail(); continue; }
      const absolute = join(directory, name), info = lstatSync(absolute);
      // Only enter explicit source roots; do not inspect the user's output/env/private trees.
      const traversable = !prefix ? roots.has(name) || name === '.openai' : !forbiddenSegments.test(name) && !name.startsWith('.');
      if (info.isSymbolicLink()) { if (strict || traversable || releasePathAllowed(path)) throw fail(); continue; }
      if (info.isDirectory()) {
        if (traversable) visit(absolute, path);
        else if (strict) throw fail();
        continue;
      }
      if (!info.isFile()) { if (strict) throw fail(); continue; }
      if (!releasePathAllowed(path)) { if (strict) throw fail(); continue; }
      if (info.size > 64 * 1024 * 1024 || files.length >= 20_000) throw fail();
      files.push({ path, size: info.size, sha256: digest(readFileSync(absolute)) });
    }
  }
  visit(root); if (!files.length || files.reduce((sum, file) => sum + file.size, 0) > 512 * 1024 * 1024) throw fail();
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function validateManifest(value) {
  if (!value || value.application !== 'better-life' || value.format !== 1 || value.kind !== 'offline-source-bundle'
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.releaseId) || !Array.isArray(value.files) || !value.files.length || value.files.length > 20_000
    || value.productionActivated !== false || value.buildAndTestsVerified !== false) throw fail();
  const seen = new Set();
  for (const file of value.files) {
    if (!file || !releasePathAllowed(file.path) || seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw fail();
    seen.add(file.path.toLowerCase());
  }
  return value;
}

export function verifyReleaseBundle({ bundle, expectedSha256 } = {}) {
  try {
    if (typeof bundle !== 'string' || !isAbsolute(bundle) || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw fail();
    directoryAncestors(bundle); const manifestPath = join(bundle, MANIFEST), info = lstatSync(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw fail();
    const bytes = readFileSync(manifestPath); if (digest(bytes) !== expectedSha256) throw fail();
    const manifest = validateManifest(JSON.parse(bytes.toString('utf8'))), actual = walk(bundle, { strict: true });
    if (actual.length !== manifest.files.length) throw fail();
    const expected = new Map(manifest.files.map(file => [file.path, file]));
    for (const file of actual) { const target = expected.get(file.path); if (!target || target.sha256 !== file.sha256 || target.size !== file.size) throw fail(); }
    return { verified: true, application: 'better-life', releaseId: manifest.releaseId, manifestSha256: expectedSha256, fileCount: actual.length,
      sourceBytes: actual.reduce((sum, file) => sum + file.size, 0), buildAndTestsVerified: false, productionActivated: false };
  } catch { throw fail(); }
}

export function createReleaseBundle({ source, destination, releaseId } = {}) {
  let created = false;
  try {
    if (typeof source !== 'string' || typeof destination !== 'string' || !isAbsolute(source) || !isAbsolute(destination)
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(releaseId) || inside(source, destination) || inside(destination, source) || existsSync(destination)) throw fail();
    directoryAncestors(source); directoryAncestors(dirname(destination)); const files = walk(source);
    const manifest = validateManifest({ application: 'better-life', format: 1, kind: 'offline-source-bundle', releaseId,
      buildAndTestsVerified: false, productionActivated: false, files });
    mkdirSync(destination, { mode: 0o700 }); created = true;
    for (const file of files) {
      const original = join(source, ...file.path.split('/')), target = join(destination, ...file.path.split('/'));
      directoryAncestors(dirname(original)); if (lstatSync(original).isSymbolicLink() || digest(readFileSync(original)) !== file.sha256) throw fail();
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(original, target, 1);
      if (digest(readFileSync(target)) !== file.sha256) throw fail();
    }
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), manifestSha256 = digest(bytes);
    writeFileSync(join(destination, MANIFEST), bytes, { flag: 'wx', mode: 0o600 });
    return { bundleCreated: true, ...verifyReleaseBundle({ bundle: destination, expectedSha256: manifestSha256 }) };
  } catch {
    // Only remove the directory this invocation exclusively created; never overwrite a prior bundle.
    if (created && inside(dirname(destination), destination) && !lstatSync(destination).isSymbolicLink()) rmSync(destination, { recursive: true, force: true });
    throw fail();
  }
}

export function stageReleaseBundle({ bundle, destination, expectedSha256 } = {}) {
  const verified = verifyReleaseBundle({ bundle, expectedSha256 });
  // Copy from verified files, not tar extraction or a shell-built list of arbitrary paths.
  // Re-create a fresh source manifest at the destination and verify the caller's original digest.
  const bytes = readFileSync(join(bundle, MANIFEST)), manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
  let created = false;
  try {
    if (typeof destination !== 'string' || !isAbsolute(destination) || inside(bundle, destination) || inside(destination, bundle) || existsSync(destination)) throw fail();
    directoryAncestors(dirname(destination)); mkdirSync(destination, { mode: 0o700 }); created = true;
    for (const file of manifest.files) {
      const original = join(bundle, ...file.path.split('/')), target = join(destination, ...file.path.split('/'));
      directoryAncestors(dirname(original)); const info = lstatSync(original); if (!info.isFile() || info.isSymbolicLink() || digest(readFileSync(original)) !== file.sha256) throw fail();
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(original, target, 1);
    }
    writeFileSync(join(destination, MANIFEST), bytes, { flag: 'wx', mode: 0o600 }); verifyReleaseBundle({ bundle: destination, expectedSha256 });
    return { staged: true, ...verified, productionActivated: false, note: '只完成离线源码暂存；未安装依赖、构建、preflight、启动服务或修改Nginx/current。' };
  } catch {
    if (created && inside(dirname(destination), destination) && !lstatSync(destination).isSymbolicLink()) rmSync(destination, { recursive: true, force: true });
    throw fail();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2); if (args.length % 2) throw fail();
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]; if (!['--source', '--destination', '--release-id', '--bundle', '--expected-sha256'].includes(key) || key in values) throw fail(); values[key] = args[index + 1];
    }
    let result;
    if (mode === 'create') result = createReleaseBundle({ source: values['--source'], destination: values['--destination'], releaseId: values['--release-id'] });
    else if (mode === 'verify') result = verifyReleaseBundle({ bundle: values['--bundle'], expectedSha256: values['--expected-sha256'] });
    else if (mode === 'stage') result = stageReleaseBundle({ bundle: values['--bundle'], destination: values['--destination'], expectedSha256: values['--expected-sha256'] });
    else throw fail();
    console.log(JSON.stringify(result));
  } catch { console.error(fail().message); process.exitCode = 1; }
}
