import * as nativeFs from 'node:fs';
import { posix as path } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { verifyReleaseBundle, stageReleaseBundle } from './release-manifest.mjs';
import { productionPreflight } from './production-preflight.mjs';
import { MEMBERSHIP_DATABASE_APPLICATION_ID } from '../server/production-config.mjs';

export const ACTIVATION_PATHS = Object.freeze({ releases: '/var/www/better-life-releases', incoming: '/var/www/better-life-releases/incoming', current: '/var/www/better-life-current',
  data: '/var/lib/better-life', db: '/var/lib/better-life/membership.sqlite', backup: '/var/backups/better-life', config: '/etc/better-life', env: '/etc/better-life/production.env',
  tls: '/etc/better-life/tls', cert: '/etc/better-life/tls/fullchain.pem', key: '/etc/better-life/tls/privkey.pem', unit: '/etc/systemd/system/better-life.service',
  nginx: '/etc/nginx/conf.d/better-life.conf', journal: '/etc/better-life/activation-state.json', lock: '/etc/better-life/activation.lock' });
const P = ACTIVATION_PATHS, MARKER = '# better-life managed activation v1', OWNER = '.activation-owner.json', READY = '.activation-ready.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const idOk = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !['incoming', 'current'].includes(id);
const releasePath = id => { guard(idOk(id), 'RELEASE_ID'); return `${P.releases}/${id}`; };
const below = (root, value) => typeof value === 'string' && value.startsWith(`${root}/`) && path.normalize(value) === value;
const safeRelease = value => below(P.releases, value) && idOk(path.basename(value)) && path.dirname(value) === P.releases;
class ActivationError extends Error { constructor(code) { super('Better Life 发布闸门未通过或需要人工恢复；未输出配置秘密。'); this.code = code; } }
function guard(value, code) { if (!value) throw new ActivationError(code); }
export function validActivationDomain(domain) {
  return typeof domain === 'string' && domain.length <= 253 && domain === domain.toLowerCase() && domain.split('.').length > 1 &&
    domain.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) && !isIP(domain) &&
    !/(?:^|\.)(?:localhost|example|test|invalid|local|internal)(?:\.|$)/.test(domain) && !/^example\.(?:com|org|net)$/.test(domain);
}
export function parseProductionEnv(text) {
  guard(typeof text === 'string' && Buffer.byteLength(text) <= 65536 && !text.includes('\0'), 'ENV_FORMAT');
  const result = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    // A deliberately strict subset shared by systemd EnvironmentFile and this
    // parser. No shell, expansion, multiline, quoting or executable loader keys.
    const match = /^([A-Z][A-Z0-9_]*)=([^\s'"\\`$#\x00-\x1f]*)$/.exec(line);
    guard(match && /^(?:NODE_ENV|QA_[A-Z0-9_]+|DEEPSEEK_[A-Z0-9_]+|MEMBERSHIP_[A-Z0-9_]+|OPERATIONS_[A-Z0-9_]+|ANALYTICS_ENABLED|RESEND_API_KEY|ALIYUN_[A-Z0-9_]+|TENCENT_[A-Z0-9_]+|HUPIJIAO_[A-Z0-9_]+|PUBLIC_[A-Z0-9_]+|VITE_ANALYTICS_ENABLED)$/.test(match[1]) && !(match[1] in result), 'ENV_FORMAT');
    result[match[1]] = match[2];
  }
  return result;
}
export function activationUnit(release) {
  guard(safeRelease(release), 'UNIT_SCOPE');
  return `${MARKER}\n[Unit]\nDescription=Better Life independent same-origin service\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=better-life\nGroup=better-life\nWorkingDirectory=${release}\nEnvironmentFile=${P.env}\nExecStartPre=/usr/bin/node scripts/production-preflight.mjs\nExecStart=/usr/bin/node server/app.mjs\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=60\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${P.data} ${P.backup}\nRestrictSUIDSGID=true\nLockPersonality=true\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export function activationNginx(domain, maintenance = false) {
  guard(validActivationDomain(domain), 'DOMAIN');
  return `${MARKER}\nserver {\n    listen 80;\n    listen [::]:80;\n    server_name ${domain};\n    if ($host != "${domain}") { return 444; }\n    access_log off;\n    return 308 https://${domain}$request_uri;\n}\nserver {\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    server_name ${domain};\n    if ($host != "${domain}") { return 444; }\n    ssl_certificate ${P.cert};\n    ssl_certificate_key ${P.key};\n    ssl_protocols TLSv1.2 TLSv1.3;\n    client_max_body_size 256k;\n    access_log off;\n${maintenance ? '    return 503;\n' : `    location / {\n        proxy_pass http://127.0.0.1:4178;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $remote_addr;\n        proxy_set_header X-Forwarded-Proto https;\n        proxy_set_header X-Forwarded-Host $host;\n        proxy_set_header Connection "";\n        proxy_read_timeout 65s;\n        proxy_connect_timeout 5s;\n    }\n`} }\n`;
}
export function assertDomainUnused(output, domain, ownFileContent) {
  guard(typeof output === 'string' && output.length <= 2 * 1024 * 1024 && !output.includes('\0'), 'NGINX_INSPECTION');
  const sections = output.split(/(?=^# configuration file )/m);
  for (const section of sections) {
    const file = /^# configuration file ([^\n]+):\s*$/m.exec(section)?.[1];
    if (file === P.nginx && typeof ownFileContent === 'string') { guard(section.replace(/^# configuration file [^\n]+:\s*\n/, '').trim() === ownFileContent.trim(), 'NGINX_INSPECTION'); continue; }
    const cleaned = section.replace(/#[^\n]*/g, '');
    for (const match of cleaned.matchAll(/\bserver_name\s+([^;]+);/g)) for (let name of match[1].split(/\s+/).filter(Boolean)) {
      name = name.replace(/^['"]|['"]$/g, '').toLowerCase();
      // Dynamic/regex names cannot be safely proven disjoint; reject rather than
      // rewriting an unrelated server. Exact and wildcard collisions are denied.
      guard(!/[~$\\]/.test(name), 'DOMAIN_UNPROVEN');
      guard(name !== domain && !(name.startsWith('*.') && domain.endsWith(name.slice(1))) && !(name.startsWith('.') && (domain === name.slice(1) || domain.endsWith(name))) && !(name.endsWith('.*') && domain.startsWith(name.slice(0, -1))), 'DOMAIN_IN_USE');
    }
  }
}
export function assertActivationCertificateMetadata(cert, domain, time = Date.now()) {
  guard(cert?.subjectAltName?.includes('DNS:') && cert.checkHost(domain, { subject: 'never', wildcards: true }) !== undefined &&
    Date.parse(cert.validFrom) <= time && Date.parse(cert.validTo) >= time + 7 * 86400000, 'TLS_CERTIFICATE');
}
export function checkActivationCertificate(certBytes, keyBytes, domain, time = Date.now()) {
  try {
    const cert = new X509Certificate(certBytes); assertActivationCertificateMetadata(cert, domain, time); const key = createPrivateKey(keyBytes);
    const expected = cert.publicKey.export({ type: 'spki', format: 'der' }), actual = createPublicKey(key).export({ type: 'spki', format: 'der' });
    guard(expected.equals(actual), 'TLS_KEY_PAIR');
    return { fingerprint: cert.fingerprint256 };
  } catch { throw new ActivationError('TLS_CERTIFICATE'); }
}
const baseEnv = () => ({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' });
export function buildActivationEnv(env, candidate) {
  return { ...baseEnv(), HOME: `${candidate}/.build-home`, NODE_ENV: 'production', NPM_CONFIG_USERCONFIG: `${candidate}/.build-home/user.npmrc`, NPM_CONFIG_GLOBALCONFIG: `${candidate}/.build-home/global.npmrc`, NPM_CONFIG_CACHE: `${candidate}/.build-home/npm-cache`,
    PUBLIC_SITE_ORIGIN: env.PUBLIC_SITE_ORIGIN, PUBLIC_BASE_PATH: '/', PUBLIC_INDEXING_ENABLED: 'false', VITE_ANALYTICS_ENABLED: env.ANALYTICS_ENABLED === 'true' ? 'true' : 'false' };
}
export function checkDatabaseHeader(fs, filename) {
  const buffer = Buffer.alloc(100), fd = fs.openSync(filename, 'r');
  try { guard(fs.readSync(fd, buffer, 0, 100, 0) === 100 && buffer.subarray(0, 16).toString('ascii') === 'SQLite format 3\0' && buffer.readUInt32BE(68) === MEMBERSHIP_DATABASE_APPLICATION_ID, 'DATABASE_IDENTITY'); }
  finally { fs.closeSync(fd); }
}
async function defaultRunner({ program, args = [], cwd = '/', env = baseEnv(), timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    let output = '', bytes = 0, exceeded = false;
    const consume = (value, stdout) => { bytes += value.length; if (bytes > 2 * 1024 * 1024) { exceeded = true; killGroup(); } else if (stdout) output += value; };
    child.stdout.on('data', value => consume(value, true)); child.stderr.on('data', value => consume(value, false));
    const timer = setTimeout(() => { exceeded = true; killGroup(); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new ActivationError('COMMAND_FAILED')); });
    child.once('close', code => { clearTimeout(timer); killGroup(); resolve({ code: exceeded ? -1 : code, stdout: output }); });
  });
}
async function defaultHealth({ domain, fingerprint, tls = false }) {
  return new Promise((resolve, reject) => {
    const req = (tls ? httpsRequest : httpRequest)({ hostname: tls ? domain : '127.0.0.1', port: tls ? 443 : 4178, path: '/api/health', method: 'GET',
      ...(tls ? { servername: domain, rejectUnauthorized: true, lookup: (_host, options, callback) => options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4) } : {}), timeout: 3000 }, response => {
      let text = '', size = 0; const peerMatches = !tls || response.socket.getPeerCertificate().fingerprint256 === fingerprint;
      response.on('data', chunk => { size += chunk.length; if (size > 4096) req.destroy(); else text += chunk; });
      response.on('end', () => {
        try { guard(response.statusCode === 200 && peerMatches, 'HEALTH'); resolve(JSON.parse(text)); }
        catch { reject(new ActivationError('HEALTH')); }
      }); response.on('error', () => reject(new ActivationError('HEALTH'))); response.on('aborted', () => reject(new ActivationError('HEALTH')));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => reject(new ActivationError('HEALTH'))); req.end();
  });
}
function context(deps) {
  return { fs: deps.fs ?? nativeFs, run: deps.run ?? defaultRunner, verify: deps.verify ?? verifyReleaseBundle, stage: deps.stage ?? stageReleaseBundle,
    preflight: deps.preflight ?? productionPreflight, identityCheck: deps.identityCheck ?? checkDatabaseHeader, certificate: deps.certificate ?? checkActivationCertificate, health: deps.health ?? defaultHealth,
    resolveDomain: deps.resolveDomain ?? (domain => lookup(domain, { all: true, verbatim: true })), addresses: deps.addresses ?? (() => Object.values(networkInterfaces()).flat().filter(Boolean).filter(row => !row.internal).map(row => row.address)),
    processAlive: deps.processAlive ?? (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }),
    platform: deps.platform ?? process.platform, uid: deps.uid ?? process.getuid?.(), pid: deps.pid ?? process.pid, now: deps.now ?? Date.now, sleep: deps.sleep ?? (ms => new Promise(done => setTimeout(done, ms))) };
}
function ancestors(c, directory) {
  for (let part = directory;; part = path.dirname(part)) {
    const info = c.fs.lstatSync(part); guard(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o022) &&
      (info.uid === 0 || [P.data, P.backup].includes(part) && info.uid === c.appUid || safeRelease(part) && info.uid === c.buildUid), 'PATH_ANCESTOR');
    if (part === '/') break;
  }
}
function metadata(c, filename, { directory = false, uid = 0, gid, mode, optional = false } = {}) {
  ancestors(c, path.dirname(filename));
  if (!c.fs.existsSync(filename)) { guard(optional, 'MISSING_PATH'); return null; }
  const info = c.fs.lstatSync(filename);
  guard(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()) && info.uid === uid && (gid === undefined || info.gid === gid) &&
    (mode === undefined ? !(info.mode & 0o022) : (info.mode & 0o777) === mode) && (directory || info.nlink === 1), 'PATH_OWNERSHIP');
  return info;
}
function traversable(c, directory, identity) {
  for (let part = directory;; part = path.dirname(part)) {
    const info = c.fs.lstatSync(part), bit = info.uid === identity.uid ? 0o100 : info.gid === identity.gid ? 0o010 : 0o001;
    guard(info.isDirectory() && !info.isSymbolicLink() && info.mode & bit, 'IDENTITY_TRAVERSAL'); if (part === '/') break;
  }
}
function text(c, filename, limit = 65536) { const info = c.fs.lstatSync(filename); guard(info.isFile() && info.size <= limit, 'FILE_LIMIT'); return c.fs.readFileSync(filename, 'utf8'); }
function syncDirectory(c, directory) { const fd = c.fs.openSync(directory, 'r'); try { c.fs.fsyncSync(fd); } finally { c.fs.closeSync(fd); } }
function atomic(c, filename, bytes, mode = 0o600) {
  ancestors(c, path.dirname(filename)); const temporary = `${filename}.activation-${randomUUID()}`;
  const fd = c.fs.openSync(temporary, 'wx', 0o600);
  try {
    try { c.fs.writeFileSync(fd, bytes); c.fs.chmodSync(temporary, mode); c.fs.fsyncSync(fd); } finally { c.fs.closeSync(fd); }
    c.fs.renameSync(temporary, filename); syncDirectory(c, path.dirname(filename));
  } finally { if (c.fs.existsSync(temporary)) c.fs.unlinkSync(temporary); }
}
function linkCurrent(c, target) {
  guard(target === null || safeRelease(target), 'CURRENT_SCOPE'); ancestors(c, path.dirname(P.current));
  if (c.fs.existsSync(P.current) || (() => { try { return Boolean(c.fs.lstatSync(P.current)); } catch { return false; } })()) guard(c.fs.lstatSync(P.current).isSymbolicLink() && c.fs.lstatSync(P.current).uid === 0, 'CURRENT_LINK');
  if (target === null) { try { c.fs.lstatSync(P.current); c.fs.unlinkSync(P.current); } catch (error) { guard(error.code === 'ENOENT', 'CURRENT_LINK'); } }
  else { const temporary = `${P.current}.activation-${randomUUID()}`; c.fs.symlinkSync(target, temporary); try { c.fs.renameSync(temporary, P.current); } finally { try { c.fs.lstatSync(temporary); c.fs.unlinkSync(temporary); } catch (error) { guard(error.code === 'ENOENT', 'CURRENT_LINK'); } } }
  syncDirectory(c, path.dirname(P.current));
}
async function command(c, program, args = [], options = {}) {
  const result = await c.run({ program, args, cwd: '/', env: baseEnv(), timeoutMs: 30000, ...options });
  guard(result?.code === 0 && typeof (result.stdout ?? '') === 'string' && (result.stdout ?? '').length <= 2 * 1024 * 1024, 'COMMAND_FAILED'); return result.stdout ?? '';
}
const system = (c, verb) => command(c, '/usr/bin/systemctl', [verb, 'better-life.service'], { timeoutMs: 90000 });
async function runningProof(c) {
  const show = await command(c, '/usr/bin/systemctl', ['show', 'better-life.service', '--property=LoadState', '--property=ActiveState', '--property=MainPID', '--property=FragmentPath', '--property=DropInPaths']);
  const properties = Object.fromEntries(show.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2))), pid = Number(properties.MainPID);
  guard(properties.LoadState === 'loaded' && properties.ActiveState === 'active' && properties.FragmentPath === P.unit && properties.DropInPaths === '' && Number.isSafeInteger(pid) && pid > 0, 'SERVICE_SCOPE');
  const listeners = (await command(c, '/usr/bin/ss', ['-H', '-ltnp', 'sport = :4178'])).trim();
  guard(listeners && listeners.split('\n').every(line => /(?:^|\s)127\.0\.0\.1:4178\s/.test(line) && [...line.matchAll(/pid=(\d+)/g)].length === 1 && Number(/pid=(\d+)/.exec(line)?.[1]) === pid), 'PORT_OWNERSHIP');
}
async function nginxReload(c) { await command(c, '/usr/sbin/nginx', ['-t']); await command(c, '/usr/bin/systemctl', ['reload', 'nginx.service']); }
async function builderProcesses(c) {
  const result = await c.run({ program: '/usr/bin/ps', args: ['-u', 'better-life-build', '-o', 'pid='], cwd: '/', env: baseEnv(), timeoutMs: 10000 });
  const output = result?.stdout ?? '';
  // Linux ps returns 1 when a valid user selection contains zero processes.
  // Do not reinterpret another exit/error or non-PID output as an idle builder.
  guard(typeof output === 'string' && output.length <= 65536 && (result?.code === 0 || result?.code === 1 && !output.trim()) && output.trim().split(/\s+/).filter(Boolean).every(pid => /^[1-9][0-9]*$/.test(pid)), 'BUILD_PROCESSES');
  return output.trim();
}
async function stopBuilder(c) {
  c.buildUid = (await user(c, 'better-life-build')).uid;
  const result = await c.run({ program: '/usr/bin/pkill', args: ['--signal', 'KILL', '--uid', 'better-life-build'], cwd: '/', env: baseEnv(), timeoutMs: 10000 });
  guard([0, 1].includes(result?.code), 'BUILD_PROCESSES');
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await builderProcesses(c))) return;
    await c.sleep(100);
  }
  throw new ActivationError('BUILD_PROCESSES');
}
async function user(c, name) {
  const row = (await command(c, '/usr/bin/getent', ['passwd', name])).trim().split(':');
  guard(row.length === 7 && row[0] === name && /^[0-9]+$/.test(row[2]) && /^[0-9]+$/.test(row[3]) && Number(row[2]) > 0 && Number(row[3]) > 0 && ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false'].includes(row[6]), 'SERVICE_IDENTITY');
  const groups = (await command(c, '/usr/bin/id', ['-G', name])).trim().split(/\s+/); guard(groups.length === 1 && Number(groups[0]) === Number(row[3]), 'SERVICE_GROUPS');
  return { uid: Number(row[2]), gid: Number(row[3]) };
}
function currentTarget(c) {
  let info; try { info = c.fs.lstatSync(P.current); } catch (error) { guard(error.code === 'ENOENT', 'CURRENT_LINK'); return null; }
  guard(info.isSymbolicLink() && info.uid === 0, 'CURRENT_LINK'); const target = c.fs.readlinkSync(P.current); guard(safeRelease(target), 'CURRENT_SCOPE'); return target;
}
function knownFile(c, filename, possibilities) { metadata(c, filename, { optional: true }); if (!c.fs.existsSync(filename)) return null; const value = text(c, filename); guard(possibilities.includes(value), 'UNKNOWN_CONFIGURATION'); return value; }
function lock(c, recovering) {
  if (c.fs.existsSync(P.lock)) {
    metadata(c, P.lock, { directory: true, mode: 0o700 }); metadata(c, `${P.lock}/owner.json`, { mode: 0o600 });
    const prior = JSON.parse(text(c, `${P.lock}/owner.json`)); guard(recovering && prior.application === 'better-life' && Number.isSafeInteger(prior.pid) && prior.pid > 0 && !c.processAlive(prior.pid), 'ACTIVATION_LOCKED');
    c.fs.unlinkSync(`${P.lock}/owner.json`); c.fs.rmdirSync(P.lock);
  }
  c.fs.mkdirSync(P.lock, { mode: 0o700 }); atomic(c, `${P.lock}/owner.json`, JSON.stringify({ application: 'better-life', pid: c.pid })); syncDirectory(c, P.config);
}
function unlock(c) { c.fs.unlinkSync(`${P.lock}/owner.json`); c.fs.rmdirSync(P.lock); syncDirectory(c, P.config); }
function save(c, journal, state, patch = {}) { const next = { ...journal, ...patch, state, updatedAt: c.now() }; atomic(c, P.journal, `${JSON.stringify(next)}\n`); Object.assign(journal, next); }
function readJournal(c) {
  metadata(c, P.journal, { mode: 0o600, optional: true }); if (!c.fs.existsSync(P.journal)) return null;
  const value = JSON.parse(text(c, P.journal, 131072));
  guard(value.application === 'better-life' && value.format === 1 && idOk(value.releaseId) && value.candidate === releasePath(value.releaseId) && /^[a-f0-9]{64}$/.test(value.manifestSha256) &&
    validActivationDomain(value.domain) && (value.previous === null || safeRelease(value.previous)) && typeof value.previousActive === 'boolean' && typeof value.candidatePrepared === 'boolean' &&
    /^[a-f0-9]{64}$/.test(value.envHash) && /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(value.fingerprint) &&
    [null, value.previous && activationUnit(value.previous)].includes(value.previousUnit) && [null, activationNginx(value.domain)].includes(value.previousNginx) &&
    ['preparing', 'prepared', 'maintenance', 'candidate', 'switching', 'committed', 'rolling-back', 'rolled-back', 'recovery-required'].includes(value.state), 'JOURNAL');
  return value;
}
function tree(c, root, { seal = false, buildUid } = {}) {
  const files = []; let total = 0;
  function visit(directory, prefix = '') {
    const dir = c.fs.lstatSync(directory); guard(dir.isDirectory() && !dir.isSymbolicLink() && (dir.uid === 0 || seal && dir.uid === buildUid), 'ARTIFACT_DIRECTORY');
    if (seal) { c.fs.chownSync(directory, 0, 0); c.fs.chmodSync(directory, 0o755); }
    else guard(dir.uid === 0 && !(dir.mode & 0o022), 'ARTIFACT_OWNERSHIP');
    for (const name of c.fs.readdirSync(directory).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name, absolute = `${directory}/${name}`;
      guard(!/[\x00-\x1f\\]/.test(rel), 'ARTIFACT_PATH'); if (!prefix && name === READY) continue;
      const info = c.fs.lstatSync(absolute);
      if (info.isSymbolicLink()) {
        guard(rel.startsWith('node_modules/.bin/') && below(`${root}/node_modules`, c.fs.realpathSync(absolute)) && c.fs.lstatSync(c.fs.realpathSync(absolute)).isFile(), 'ARTIFACT_LINK');
        if (seal) c.fs.lchownSync(absolute, 0, 0); else guard(info.uid === 0, 'ARTIFACT_OWNERSHIP');
        files.push({ path: rel, link: c.fs.readlinkSync(absolute) });
      } else if (info.isDirectory()) visit(absolute, rel);
      else {
        guard(info.isFile() && info.nlink === 1 && info.size <= 128 * 1024 * 1024, 'ARTIFACT_FILE');
        if (!rel.startsWith('node_modules/')) guard(!/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\..*)?|output|private|logs?)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|pem|key|log|har)$/i.test(rel), 'ARTIFACT_PRIVATE');
        if (seal) { guard(info.uid === 0 || info.uid === buildUid, 'ARTIFACT_OWNERSHIP'); c.fs.chownSync(absolute, 0, 0); c.fs.chmodSync(absolute, info.mode & 0o111 ? 0o755 : 0o644); }
        else guard(info.uid === 0 && !(info.mode & 0o022), 'ARTIFACT_OWNERSHIP');
        total += info.size; files.push({ path: rel, size: info.size, sha256: sha(c.fs.readFileSync(absolute)) });
      }
      guard(files.length <= 200000 && total <= 4 * 1024 * 1024 * 1024, 'ARTIFACT_LIMIT');
    }
  }
  visit(root); return files;
}
function prepared(c, release) {
  guard(safeRelease(release), 'RELEASE_SCOPE'); metadata(c, release, { directory: true }); metadata(c, `${release}/${READY}`, { mode: 0o600 });
  const receipt = JSON.parse(text(c, `${release}/${READY}`, 32 * 1024 * 1024));
  guard(receipt.application === 'better-life' && receipt.releaseId === path.basename(release) && /^[a-f0-9]{64}$/.test(receipt.manifestSha256) && receipt.buildAndTestsVerified === true && Array.isArray(receipt.files) && receipt.files.length <= 200000, 'PREPARED_RECEIPT');
  guard(JSON.stringify(tree(c, release)) === JSON.stringify(receipt.files), 'PREPARED_INTEGRITY'); return receipt;
}
function removeCandidate(c, journal) {
  const candidate = journal.candidate; guard(candidate === releasePath(journal.releaseId) && currentTarget(c) !== candidate, 'CLEANUP_SCOPE');
  if (!c.fs.existsSync(candidate)) return;
  ancestors(c, path.dirname(candidate)); guard(c.fs.lstatSync(candidate).isDirectory() && !c.fs.lstatSync(candidate).isSymbolicLink(), 'CLEANUP_SCOPE');
  if (!c.fs.existsSync(`${candidate}/${OWNER}`)) {
    // Interrupted immediately after stage: only an exact, root-owned trusted
    // source bundle claimed by this durable journal can be removed.
    metadata(c, candidate, { directory: true }); c.verify({ bundle: candidate, expectedSha256: journal.manifestSha256 });
  } else {
    metadata(c, `${candidate}/${OWNER}`, { mode: 0o644 }); const owner = JSON.parse(text(c, `${candidate}/${OWNER}`));
    guard(owner.application === 'better-life' && owner.releaseId === journal.releaseId && owner.manifestSha256 === journal.manifestSha256, 'CLEANUP_OWNER');
  }
  // Prepared releases may be pinned by an independent backup unit or another
  // authorized maintenance task. Never delete them, even after code rollback;
  // retention cleanup requires a separate audited inventory of those references.
  // The durable flag also protects a previously prepared release if its receipt
  // was externally removed. A receipt protects a crash before the prepared save.
  if (journal.candidatePrepared || c.fs.existsSync(`${candidate}/${READY}`)) return;
  c.fs.rmSync(candidate, { recursive: true, force: false }); syncDirectory(c, P.releases);
}
function healthy(body) { return body?.status === 'ready' && body.application === 'better-life' && body.metering === true && body.localDemo === false && body.login?.emailConfigured === true && body.login?.phoneConfigured === true && body.payments?.creationEnabled === false; }
async function waitHealth(c, domain, fingerprint, tls = false) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { if (healthy(await c.health({ domain, fingerprint, tls }))) return; } catch {}
    if (attempt < 19) await c.sleep(1000);
  }
  throw new ActivationError('HEALTH');
}
function checkDependencies(c, bundle) {
  const pkg = JSON.parse(text(c, `${bundle}/package.json`, 131072)), lockfile = JSON.parse(text(c, `${bundle}/package-lock.json`, 8 * 1024 * 1024));
  guard(pkg.name === 'better-life' && lockfile.name === 'better-life' && [2, 3].includes(lockfile.lockfileVersion) && lockfile.packages &&
    pkg.scripts?.check === 'npm run build && npm test && node library/tools/check-plain.mjs && node library/tools/check-refs.mjs --check' &&
    pkg.scripts?.build === 'node scripts/build.mjs && vite build && node scripts/prepare-sites-build.mjs' && pkg.scripts?.test === 'node --test --test-concurrency=4 tests/*.test.mjs', 'LOCKED_DEPENDENCIES');
  const own = (entry, key) => Object.hasOwn(entry, key);
  const packagePath = name => typeof name === 'string' && name.length <= 2048 && /^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/.test(name);
  const object = entry => entry && typeof entry === 'object' && !Array.isArray(entry);
  const registry = entry => object(entry) && !own(entry, 'inBundle') && !entry.link && /^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? '') && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '');
  const bundled = entry => object(entry) && entry.inBundle === true && ['resolved', 'integrity', 'link', 'path', 'workspace'].every(key => !own(entry, key)) && typeof entry.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version);
  for (const [name, entry] of Object.entries(lockfile.packages)) {
    if (!name) continue;
    guard(packagePath(name) && object(entry), 'LOCKED_DEPENDENCIES');
    if (!own(entry, 'inBundle')) { guard(registry(entry), 'LOCKED_DEPENDENCIES'); continue; }
    // npm lockfiles omit fetch metadata for dependencies already included in a
    // verified parent tarball. Never accept a bare inBundle claim: prove each
    // containing package, stop at the closest registry+SHA512 anchor, and require
    // that anchor's explicit bundle declaration. No extra transport is allowed.
    guard(bundled(entry), 'LOCKED_DEPENDENCIES');
    let child = name, anchored = false;
    while (child.includes('/node_modules/')) {
      const index = child.lastIndexOf('/node_modules/'), parentName = child.slice(0, index), childName = child.slice(index + '/node_modules/'.length), parent = lockfile.packages[parentName];
      guard(packagePath(parentName) && object(parent), 'LOCKED_DEPENDENCIES');
      if (!own(parent, 'inBundle')) {
        guard(registry(parent) && Array.isArray(parent.bundleDependencies) && parent.bundleDependencies.includes(childName), 'LOCKED_DEPENDENCIES');
        anchored = true; break;
      }
      guard(bundled(parent) && object(parent.dependencies) && own(parent.dependencies, childName) && typeof parent.dependencies[childName] === 'string' && !/(?:[:/\\]|\x00)/.test(parent.dependencies[childName]), 'LOCKED_DEPENDENCIES');
      child = parentName;
    }
    guard(anchored, 'LOCKED_DEPENDENCIES');
  }
}
async function inspect(c, options, { checkHealth = false } = {}) {
  const { releaseId, domain, expectedSha256, bundle } = options;
  guard(c.platform === 'linux' && c.uid === 0, 'LINUX_ROOT'); guard(idOk(releaseId) && validActivationDomain(domain) && /^[a-f0-9]{64}$/.test(expectedSha256 ?? '') && bundle === `${P.incoming}/${releaseId}`, 'RELEASE_INPUT');
  for (const [filename, directory, mode] of [[P.config, true, 0o700], [P.env, false, 0o600], [P.tls, true, 0o700], [P.cert, false, 0o644], [P.key, false, 0o600], [P.releases, true], [P.incoming, true], ['/etc/systemd/system', true], ['/etc/nginx/conf.d', true]]) metadata(c, filename, { directory, mode });
  guard(c.fs.lstatSync(P.cert).size <= 1024 * 1024 && c.fs.lstatSync(P.key).size <= 65536, 'TLS_FILE_LIMIT');
  metadata(c, bundle, { directory: true });
  for (const executable of ['/usr/bin/node', '/usr/bin/npm', '/usr/bin/env', '/usr/bin/setpriv', '/usr/bin/getent', '/usr/bin/id', '/usr/bin/systemctl', '/usr/sbin/nginx', '/usr/bin/openssl', '/usr/bin/ss', '/usr/bin/pkill', '/usr/bin/ps']) metadata(c, c.fs.realpathSync(executable));
  const version = (await command(c, '/usr/bin/node', ['-p', 'process.versions.node'])).trim().split('.').map(Number); guard(version.length === 3 && version.every(Number.isInteger) && (version[0] > 22 || version[0] === 22 && version[1] >= 16), 'NODE_VERSION');
  const appUser = await user(c, 'better-life'), buildUser = await user(c, 'better-life-build'); guard(appUser.uid !== buildUser.uid && appUser.gid !== buildUser.gid, 'BUILD_IDENTITY');
  c.appUid = appUser.uid; c.buildUid = buildUser.uid;
  for (const identity of [appUser, buildUser]) {
    traversable(c, P.releases, identity);
    for (const executable of ['/usr/bin/node', '/usr/bin/npm', '/usr/bin/env']) { const actual = c.fs.realpathSync(executable); traversable(c, path.dirname(actual), identity); guard(c.fs.lstatSync(actual).mode & 0o001, 'IDENTITY_EXECUTABLE'); }
  }
  guard(!(await builderProcesses(c)), 'BUILD_IDENTITY_BUSY');
  metadata(c, P.data, { directory: true, ...appUser, mode: 0o700 }); metadata(c, P.backup, { directory: true, ...appUser, mode: 0o700 });
  traversable(c, P.data, appUser); traversable(c, P.backup, appUser);
  for (const filename of [P.db, `${P.db}-wal`, `${P.db}-shm`]) metadata(c, filename, { ...appUser, mode: 0o600, optional: true });
  if (c.fs.existsSync(P.db)) c.identityCheck(c.fs, P.db); // Exactly 100 header bytes; no SQL, WAL writes or user content.
  const bytes = text(c, P.env), env = parseProductionEnv(bytes), origin = `https://${domain}`;
  guard(env.NODE_ENV === 'production' && env.QA_HOST === '127.0.0.1' && env.QA_PORT === '4178' && env.MEMBERSHIP_DB_PATH === P.db && env.MEMBERSHIP_BACKUP_DIR === P.backup &&
    env.MEMBERSHIP_APP_ORIGIN === origin && env.PUBLIC_SITE_ORIGIN === origin && env.PUBLIC_BASE_PATH === '/' && env.QA_ALLOWED_ORIGINS === origin &&
    env.MEMBERSHIP_LOCAL_DEMO === 'false' && env.MEMBERSHIP_ENFORCE === 'true' && env.MEMBERSHIP_PAYMENT_CREATE_ENABLED === 'false' && env.MEMBERSHIP_TRUSTED_PROXY_IPS === '127.0.0.1', 'APPLICATION_SCOPE');
  guard(c.preflight(env, { projectRoot: bundle, checkFiles: false }).readyForProductionStartup, 'PRODUCTION_CONFIGURATION');
  const verified = c.verify({ bundle, expectedSha256 }); guard(verified.verified && verified.releaseId === releaseId, 'TRUSTED_MANIFEST'); tree(c, bundle); checkDependencies(c, bundle);
  const cert = c.certificate(c.fs.readFileSync(P.cert), c.fs.readFileSync(P.key), domain, c.now()); guard(typeof cert?.fingerprint === 'string', 'TLS_CERTIFICATE');
  await command(c, '/usr/bin/openssl', ['verify', '-CAfile', '/etc/ssl/certs/ca-certificates.crt', '-untrusted', P.cert, '-verify_hostname', domain, P.cert]);
  const addresses = c.addresses(), dns = await c.resolveDomain(domain); guard(Array.isArray(dns) && dns.length > 0 && dns.every(row => addresses.includes(row.address) && isIP(row.address) && !/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.|2(?:2[4-9]|3\d)\.|::1$|::ffff:|f[cd]|fe80:|ff)/i.test(row.address)), 'DOMAIN_DNS');
  const previous = currentTarget(c); if (previous) prepared(c, previous);
  const previousUnit = knownFile(c, P.unit, previous ? [activationUnit(previous)] : []), previousNginx = knownFile(c, P.nginx, [activationNginx(domain)]);
  guard(previousUnit === null ? previous === null : previous !== null, 'PREVIOUS_SERVICE');
  const show = await command(c, '/usr/bin/systemctl', ['show', 'better-life.service', '--property=LoadState', '--property=ActiveState', '--property=MainPID', '--property=FragmentPath', '--property=DropInPaths']);
  const properties = Object.fromEntries(show.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  guard(properties.DropInPaths === '' && (previousUnit ? properties.LoadState === 'loaded' && properties.FragmentPath === P.unit : properties.LoadState === 'not-found'), 'SERVICE_SCOPE');
  const previousActive = properties.ActiveState === 'active', pid = Number(properties.MainPID); guard(Number.isSafeInteger(pid) && (previousActive ? pid > 0 : pid === 0) && ['active', 'inactive'].includes(properties.ActiveState), 'SERVICE_STATE');
  const listeners = (await command(c, '/usr/bin/ss', ['-H', '-ltnp', 'sport = :4178'])).trim();
  if (listeners) guard(previousActive && listeners.split('\n').every(line => /(?:^|\s)127\.0\.0\.1:4178\s/.test(line) && [...line.matchAll(/pid=(\d+)/g)].length === 1 && Number(/pid=(\d+)/.exec(line)?.[1]) === pid), 'PORT_OWNERSHIP');
  else guard(!previousActive, 'PORT_OWNERSHIP');
  if (previousActive && checkHealth) await waitHealth(c, domain, cert.fingerprint);
  assertDomainUnused(await command(c, '/usr/sbin/nginx', ['-T']), domain, previousNginx);
  const disk = c.fs.statfsSync(P.releases); guard(Number(disk.bavail) * Number(disk.bsize) >= Math.max(1024 ** 3, (verified.sourceBytes ?? 0) * 3), 'DISK_SPACE');
  return { env, envHash: sha(bytes), verified, cert, appUser, buildUser, previous, previousUnit, previousNginx, previousActive };
}
async function prepare(c, options, plan, journal) {
  const candidate = journal.candidate; guard(!c.fs.existsSync(candidate), 'EXISTING_RELEASE');
  c.stage({ bundle: options.bundle, destination: candidate, expectedSha256: options.expectedSha256 });
  atomic(c, `${candidate}/${OWNER}`, JSON.stringify({ application: 'better-life', releaseId: options.releaseId, manifestSha256: options.expectedSha256 }), 0o644);
  const give = directory => { for (const name of c.fs.readdirSync(directory)) { const file = `${directory}/${name}`, info = c.fs.lstatSync(file); guard(!info.isSymbolicLink(), 'SOURCE_LINK'); if (info.isDirectory()) give(file); c.fs.chownSync(file, plan.buildUser.uid, plan.buildUser.gid); } c.fs.chownSync(directory, plan.buildUser.uid, plan.buildUser.gid); };
  give(candidate);
  // The immutable owner marker must not be writable by the build identity.
  c.fs.chownSync(`${candidate}/${OWNER}`, 0, 0); c.fs.chmodSync(`${candidate}/${OWNER}`, 0o644);
  c.fs.mkdirSync(`${candidate}/.build-home`, { mode: 0o755 });
  c.fs.chmodSync(`${candidate}/.build-home`, 0o755); // Independent of a root 0077 umask.
  for (const name of ['user.npmrc', 'global.npmrc']) atomic(c, `${candidate}/.build-home/${name}`, '', 0o644);
  c.fs.mkdirSync(`${candidate}/.build-home/npm-cache`, { mode: 0o700 }); c.fs.chownSync(`${candidate}/.build-home/npm-cache`, plan.buildUser.uid, plan.buildUser.gid);
  const checkBuildConfig = () => {
    metadata(c, `${candidate}/.build-home`, { directory: true, mode: 0o755 });
    for (const name of ['user.npmrc', 'global.npmrc']) { const filename = `${candidate}/.build-home/${name}`; metadata(c, filename, { mode: 0o644 }); guard(c.fs.lstatSync(filename).size === 0, 'BUILD_NPM_CONFIGURATION'); }
  };
  const env = buildActivationEnv(plan.env, candidate), privilege = ['--no-new-privs', '--reuid', String(plan.buildUser.uid), '--regid', String(plan.buildUser.gid), '--clear-groups', '--'];
  checkBuildConfig();
  await command(c, '/usr/bin/setpriv', [...privilege, '/usr/bin/npm', 'ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: candidate, env, timeoutMs: 1800000 });
  checkBuildConfig();
  await command(c, '/usr/bin/setpriv', [...privilege, '/usr/bin/npm', 'run', 'check'], { cwd: candidate, env, timeoutMs: 1800000 });
  checkBuildConfig();
  await stopBuilder(c);
  metadata(c, `${candidate}/${OWNER}`, { mode: 0o644 }); guard(JSON.parse(text(c, `${candidate}/${OWNER}`)).manifestSha256 === options.expectedSha256, 'BUILD_OWNER');
  c.fs.rmSync(`${candidate}/.build-home`, { recursive: true, force: false });
  const files = tree(c, candidate, { seal: true, buildUid: plan.buildUser.uid });
  metadata(c, `${candidate}/dist/client/index.html`);
  atomic(c, `${candidate}/${READY}`, JSON.stringify({ application: 'better-life', releaseId: options.releaseId, manifestSha256: options.expectedSha256, buildAndTestsVerified: true, files }), 0o600);
  const result = await command(c, '/usr/bin/setpriv', ['--no-new-privs', '--reuid', String(plan.appUser.uid), '--regid', String(plan.appUser.gid), '--clear-groups', '--', '/usr/bin/node', 'scripts/production-preflight.mjs'], { cwd: candidate, env: { ...baseEnv(), ...plan.env }, timeoutMs: 30000 });
  guard(JSON.parse(result).readyForProductionStartup === true, 'PRODUCTION_PREFLIGHT'); prepared(c, candidate); save(c, journal, 'prepared', { candidatePrepared: true });
}
function validateRollbackFiles(c, journal) {
  const current = currentTarget(c); guard(current === journal.previous || current === journal.candidate || current === null && journal.previous === null, 'ROLLBACK_CURRENT_CHANGED');
  knownFile(c, P.unit, [journal.previousUnit, activationUnit(journal.candidate)].filter(Boolean));
  knownFile(c, P.nginx, [journal.previousNginx, activationNginx(journal.domain), activationNginx(journal.domain, true)].filter(Boolean));
  if (journal.previous) prepared(c, journal.previous);
}
async function rollback(c, journal, originalState = journal.state) {
  validateRollbackFiles(c, journal); save(c, journal, 'rolling-back');
  await stopBuilder(c);
  if (!['preparing', 'prepared'].includes(originalState)) {
    // Keep only this hostname unavailable while stopping/restoring code. Never
    // fall back to exposing an unverified candidate or restore an old database.
    if (c.fs.existsSync(P.nginx)) { atomic(c, P.nginx, activationNginx(journal.domain, true), 0o644); await nginxReload(c); }
    if (c.fs.existsSync(P.unit)) await system(c, 'stop');
    linkCurrent(c, journal.previous);
    if (journal.previousUnit === null) { if (c.fs.existsSync(P.unit)) c.fs.unlinkSync(P.unit); }
    else atomic(c, P.unit, journal.previousUnit, 0o644);
    await command(c, '/usr/bin/systemctl', ['daemon-reload']);
    if (journal.previousActive) {
      metadata(c, P.env, { mode: 0o600 }); const env = parseProductionEnv(text(c, P.env));
      guard(sha(text(c, P.env)) === journal.envHash && env.MEMBERSHIP_PAYMENT_CREATE_ENABLED === 'false' && env.QA_PORT === '4178' && env.QA_HOST === '127.0.0.1', 'ROLLBACK_ENV_CHANGED');
      await system(c, 'start'); await waitHealth(c, journal.domain, journal.fingerprint); await runningProof(c);
    }
    if (journal.previousNginx === null) { if (c.fs.existsSync(P.nginx)) c.fs.unlinkSync(P.nginx); }
    else atomic(c, P.nginx, journal.previousNginx, 0o644);
    await nginxReload(c);
    if (journal.previousActive && journal.previousNginx) await waitHealth(c, journal.domain, journal.fingerprint, true);
  }
  removeCandidate(c, journal); save(c, journal, 'rolled-back');
}
async function quarantine(c, journal) {
  try { if (knownFile(c, P.nginx, [journal.previousNginx, activationNginx(journal.domain), activationNginx(journal.domain, true)].filter(Boolean))) { atomic(c, P.nginx, activationNginx(journal.domain, true), 0o644); await nginxReload(c); } } catch {}
  try { if (knownFile(c, P.unit, [journal.previousUnit, activationUnit(journal.candidate)].filter(Boolean))) await system(c, 'stop'); } catch {}
}

// Default is read-only. Mutations require the explicit activate/rollback/recover
// action. Dependency injection is only for local synthetic tests; CLI uses real
// fixed Linux paths, identities and OS commands, never a caller-selected scope.
export async function releaseActivation(options = {}, dependencies = {}) {
  const c = context(dependencies), action = options.action ?? 'preflight'; let journal, locked = false;
  try {
    guard(['preflight', 'activate', 'rollback', 'recover'].includes(action), 'ACTION'); guard(c.platform === 'linux' && c.uid === 0, 'LINUX_ROOT');
    metadata(c, P.config, { directory: true, mode: 0o700 }); journal = readJournal(c);
    if (['rollback', 'recover'].includes(action)) {
      guard(journal && (action === 'rollback' ? journal.state === 'committed' : !['committed', 'rolled-back'].includes(journal.state)), 'RECOVERY_STATE');
      lock(c, action === 'recover'); locked = true; await rollback(c, journal); return { ok: true, state: 'rolled-back', databaseRestored: false, releaseId: journal.releaseId };
    }
    guard(!journal || ['committed', 'rolled-back'].includes(journal.state), 'RECOVERY_REQUIRED'); guard(!c.fs.existsSync(P.lock), 'ACTIVATION_LOCKED');
    const plan = await inspect(c, options, { checkHealth: action === 'activate' }); guard(!c.fs.existsSync(releasePath(options.releaseId)), 'EXISTING_RELEASE');
    if (action === 'preflight') return { ok: true, state: 'preflight-passed', changed: false, buildAndTestsVerified: false, productionActivated: false, releaseId: options.releaseId };
    lock(c, false); locked = true;
    journal = { application: 'better-life', format: 1, releaseId: options.releaseId, candidate: releasePath(options.releaseId), manifestSha256: options.expectedSha256, domain: options.domain,
      previous: plan.previous, previousUnit: plan.previousUnit, previousNginx: plan.previousNginx, previousActive: plan.previousActive, fingerprint: plan.cert.fingerprint, envHash: plan.envHash, candidatePrepared: false, state: 'preparing' };
    save(c, journal, 'preparing'); await prepare(c, options, plan, journal);
    const checked = await inspect(c, options, { checkHealth: true }); guard(checked.envHash === plan.envHash && checked.cert.fingerprint === plan.cert.fingerprint && checked.previous === plan.previous && checked.previousUnit === plan.previousUnit && checked.previousNginx === plan.previousNginx && checked.previousActive === plan.previousActive, 'PREFLIGHT_CHANGED');
    // Existing public routing enters maintenance before candidate code owns the
    // single fixed loopback port. First deployment has no public route yet.
    save(c, journal, 'maintenance');
    if (plan.previousNginx) { atomic(c, P.nginx, activationNginx(options.domain, true), 0o644); await nginxReload(c); }
    save(c, journal, 'candidate'); if (plan.previousUnit) await system(c, 'stop');
    guard(!(await command(c, '/usr/bin/ss', ['-H', '-ltnp', 'sport = :4178'])).trim(), 'PORT_OWNERSHIP');
    atomic(c, P.unit, activationUnit(journal.candidate), 0o644); await command(c, '/usr/bin/systemctl', ['daemon-reload']); await system(c, 'start');
    await waitHealth(c, options.domain, plan.cert.fingerprint); await runningProof(c);
    save(c, journal, 'switching'); linkCurrent(c, journal.candidate);
    atomic(c, P.nginx, activationNginx(options.domain), 0o644); await nginxReload(c); await waitHealth(c, options.domain, plan.cert.fingerprint, true);
    save(c, journal, 'committed'); return { ok: true, state: 'committed', releaseId: options.releaseId, productionActivated: true, buildAndTestsVerified: true, paymentCreationEnabled: false, databaseRestored: false,
      livePublicReachabilityVerified: false, liveDeliveryVerified: false, livePaymentVerified: false };
  } catch (error) {
    const code = error instanceof ActivationError ? error.code : 'ACTIVATION_FAILED';
    if (locked && journal && !['committed', 'rolled-back'].includes(journal.state)) {
      try { await rollback(c, journal); return { ok: false, state: 'rolled-back', code, databaseRestored: false }; }
      catch { await quarantine(c, journal); try { save(c, journal, 'recovery-required'); } catch {} return { ok: false, state: 'recovery-required', code, databaseRestored: false }; }
    }
    return { ok: false, state: 'blocked', code, changed: false, productionActivated: false };
  } finally { if (locked) { try { unlock(c); } catch {} } }
}

export function parseActivationArguments(argv = []) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return null;
  const implicit = !argv.length || argv[0].startsWith('--'), action = implicit ? 'preflight' : argv[0], args = implicit ? argv : argv.slice(1);
  if (!['preflight', 'activate', 'rollback', 'recover'].includes(action) || args.length % 2 !== 0) return null;
  const options = { action };
  const keys = { '--bundle': 'bundle', '--release-id': 'releaseId', '--domain': 'domain', '--expected-sha256': 'expectedSha256' };
  for (let index = 0; index < args.length; index += 2) {
    if (!Object.hasOwn(keys, args[index])) return null;
    const key = keys[args[index]], value = args[index + 1];
    if (Object.hasOwn(options, key) || !value || value.startsWith('--')) return null;
    options[key] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseActivationArguments(process.argv.slice(2));
  const result = options ? await releaseActivation(options) : { ok: false, state: 'blocked', code: 'CLI_ARGUMENTS' };
  console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
}
