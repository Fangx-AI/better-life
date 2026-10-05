import { existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, constants } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { assertDirectoryAncestors, privateStoragePath } from '../server/production-config.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const application = 'better-life', version = 1;
const scopes = ['backup', 'app', 'health', 'budget'];
const failures = Object.freeze({ BACKUP_FAILED: 'backup', APP_FAILED: 'app', HEALTH_UNAVAILABLE: 'health', BUDGET_WARNING: 'budget', BUDGET_EXHAUSTED: 'budget' });
const units = Object.freeze({ 'better-life.service': 'APP_FAILED', 'better-life-backup.service': 'BACKUP_FAILED', 'better-life-health.service': 'HEALTH_UNAVAILABLE' });
const statuses = Object.freeze({ BACKUP_FAILED: 'backup_failed', APP_FAILED: 'app_failed', HEALTH_UNAVAILABLE: 'health_unavailable', BUDGET_WARNING: 'budget_warning', BUDGET_EXHAUSTED: 'budget_exhausted' });
const stateName = 'alerts-state.json', lockName = 'alerts.lock', maxBytes = 128 * 1024;
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export class OperationsAlertError extends Error { constructor(code) { super('Better Life 告警操作未完成。'); this.name = 'OperationsAlertError'; this.code = code; } }
const fail = code => { throw new OperationsAlertError(code); };

function eventScope(event, scope) {
  if (event === 'RECOVERED') { if (!scopes.includes(scope)) fail('INVALID_ARGUMENTS'); return scope; }
  if (!Object.hasOwn(failures, event) || scope !== undefined && scope !== failures[event]) fail('INVALID_ARGUMENTS');
  return failures[event];
}
export function parseAlertArguments(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) fail('INVALID_ARGUMENTS');
  if (args.length === 2 && args[0] === '--unit') {
    if (!Object.hasOwn(units, args[1])) fail('INVALID_UNIT');
    return { event: units[args[1]] };
  }
  if (args.length === 2 && args[0] === 'RECOVERED' && scopes.includes(args[1])) return { event: 'RECOVERED', scope: args[1] };
  if (args.length === 1 && Object.hasOwn(failures, args[0])) return { event: args[0] };
  fail('INVALID_ARGUMENTS');
}

function endpoint(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
    const url = new URL(value), host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || isIP(host) || host.startsWith('[')
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host)) return null;
    return url;
  } catch { return null; }
}
function webhookConfig(env) {
  if (!env.OPERATIONS_ALERT_WEBHOOK_URL && !env.OPERATIONS_ALERT_WEBHOOK_HOST) return { configured: false, reason: 'NOT_CONFIGURED' };
  const url = endpoint(env.OPERATIONS_ALERT_WEBHOOK_URL);
  if (!url || typeof env.OPERATIONS_ALERT_WEBHOOK_HOST !== 'string' || env.OPERATIONS_ALERT_WEBHOOK_HOST !== url.hostname) return { configured: false, reason: 'CONFIGURATION_REJECTED' };
  return { configured: true, url };
}

// Conservatively permit public unicast only. Mapped/NAT64/transition IPv6 and
// special/documentation ranges are rejected, including every DNS answer.
export function isPublicAlertAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || address.includes('.') || address.includes('%')) return false;
  const [first = '0', second = '0'] = address.toLowerCase().split(':'), a = parseInt(first || '0', 16), b = parseInt(second || '0', 16);
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3ffe && !(a === 0x3fff && b < 0x1000) && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
}

// Production uses a pinned HTTPS connection, not fetch-follow-redirect/DNS
// check-then-fetch. The TLS server name remains the explicit configured host.
export async function sendAlertWebhook(value, options, { lookup = dnsLookup, request = httpsRequest } = {}) {
  const url = endpoint(String(value)); if (!url) fail('WEBHOOK_REJECTED');
  let payload;
  try { payload = JSON.parse(options.body); } catch { fail('WEBHOOK_REJECTED'); }
  if (options.method !== 'POST' || !scopes.some(scope => validPayload(payload, scope))
    || !keys(options.headers, ['content-type', 'accept']) || options.headers['content-type'] !== 'application/json' || options.headers.accept !== 'application/json') fail('WEBHOOK_REJECTED');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (options.signal?.aborted) fail('DELIVERY_TIMEOUT');
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 16 || addresses.some(item => !item || ![4, 6].includes(item.family) || isIP(item.address) !== item.family || !isPublicAlertAddress(item.address))) fail('WEBHOOK_REJECTED');
  const pinned = addresses[0];
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; error ? reject(new OperationsAlertError('DELIVERY_FAILED')) : resolvePromise(result); };
    const connection = request(url, { method: 'POST', headers: options.headers, signal: options.signal, agent: false, servername: url.hostname, rejectUnauthorized: true,
      lookup: (_hostname, lookupOptions, callback) => { if (lookupOptions?.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family); },
    }, response => {
      const status = response.statusCode;
      finish(null, { ok: Number.isInteger(status) && status >= 200 && status < 300, status });
      response.destroy(); // Never read/log provider bodies or follow Location.
    });
    connection.on('error', error => finish(error));
    connection.setTimeout(10_000, () => connection.destroy(new OperationsAlertError('DELIVERY_TIMEOUT')));
    connection.end(options.body);
  });
}

function ownPrivate(info, type) {
  if (!info[type]() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid())) fail('UNSAFE_STATE_STORAGE');
}
function prepareDirectory(value, { projectRoot, allowTemporary }) {
  if (!privateStoragePath(value, { projectRoot, allowTemporary }) || basename(value) !== 'alerts'
    || !allowTemporary && !/(?:^|[/\\])better-life(?:-private)?[/\\]alerts$/.test(value)) fail('UNSAFE_STATE_STORAGE');
  try {
    assertDirectoryAncestors(value, { requireExisting: false });
    if (!allowTemporary && process.platform !== 'win32') {
      for (let part = resolve(value); ; part = dirname(part)) {
        if (existsSync(part) && lstatSync(part).mode & 0o022) fail('UNSAFE_STATE_STORAGE');
        if (dirname(part) === part) break;
      }
    }
    mkdirSync(value, { recursive: true, mode: 0o700 });
    assertDirectoryAncestors(value); ownPrivate(lstatSync(value), 'isDirectory');
  } catch { fail('UNSAFE_STATE_STORAGE'); }
  return resolve(value);
}
function privateFile(filename) {
  const info = lstatSync(filename); ownPrivate(info, 'isFile');
  if (info.nlink !== 1 || info.size > maxBytes) fail('UNSAFE_STATE_STORAGE');
}
function fileExists(filename) { try { lstatSync(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; fail('UNSAFE_STATE_STORAGE'); } }
function emptyState() { return { application, version, sequence: 0, scopes: Object.fromEntries(scopes.map(scope => [scope, { active: [], queue: [], receipts: [] }])) }; }
function validPayload(value, scope) {
  return keys(value, ['application', 'event', 'status', 'version', 'time']) && value.application === application && value.version === version && iso(value.time)
    && (value.event === 'RECOVERED' ? value.status === `${scope}_recovered` : failures[value.event] === scope && value.status === statuses[value.event]);
}
function validateState(value) {
  if (!keys(value, ['application', 'version', 'sequence', 'scopes']) || value.application !== application || value.version !== version || !integer(value.sequence) || !keys(value.scopes, scopes)) fail('INVALID_STATE');
  const ids = new Set();
  for (const scope of scopes) {
    const part = value.scopes[scope];
    if (!keys(part, ['active', 'queue', 'receipts']) || !Array.isArray(part.active) || part.active.length > 2 || new Set(part.active).size !== part.active.length || part.active.some(event => failures[event] !== scope)
      || !Array.isArray(part.queue) || part.queue.length > 32 || !Array.isArray(part.receipts) || part.receipts.length > 32) fail('INVALID_STATE');
    for (const item of part.queue) {
      if (!keys(item, ['id', 'payload', 'attempts', 'nextAttemptAt']) || !validPayload(item.payload, scope) || !integer(item.id) || item.id === 0 || item.id > value.sequence || ids.has(item.id) || !integer(item.attempts) || item.attempts > 1_000_000 || !integer(item.nextAttemptAt)) fail('INVALID_STATE');
      ids.add(item.id);
    }
    for (const item of part.receipts) {
      const { id, attempts, deliveredAt, httpStatus, ...payload } = item;
      if (!keys(item, ['id', 'attempts', 'deliveredAt', 'httpStatus', 'application', 'event', 'status', 'version', 'time']) || !validPayload(payload, scope) || !integer(id) || id === 0 || id > value.sequence || ids.has(id) || !integer(attempts) || attempts < 1 || attempts > 1_000_000 || !iso(deliveredAt) || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) fail('INVALID_STATE');
      ids.add(id);
    }
  }
  return value;
}
function readState(filename) {
  if (!fileExists(filename)) return emptyState();
  let fd;
  try { privateFile(filename); fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); ownPrivate(fstatSync(fd), 'isFile'); return validateState(JSON.parse(readFileSync(fd, 'utf8'))); }
  catch (error) { if (error instanceof OperationsAlertError) throw error; fail('INVALID_STATE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function saveState(directory, state) {
  validateState(state);
  const filename = join(directory, stateName), temporary = join(directory, `.alerts-${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  try {
    if (fileExists(filename)) privateFile(filename);
    const content = JSON.stringify(state); if (Buffer.byteLength(content) > maxBytes) fail('STATE_CAPACITY');
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, filename);
    if (process.platform !== 'win32') { const directoryFd = openSync(directory, 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); } }
  } catch (error) { if (error instanceof OperationsAlertError) throw error; fail('STATE_WRITE_FAILED'); }
  finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
}

export async function operationsAlert({ event, scope, env = {}, stateDirectory = env.OPERATIONS_ALERT_STATE_DIR || '/var/lib/better-life/alerts', fetchImpl = sendAlertWebhook, now = Date.now,
  projectRoot = project, allowTemporary = false, timeoutMs = 10_000, retryBaseMs = 60_000, retryMaxMs = 3_600_000 } = {}) {
  scope = eventScope(event, scope);
  const timestamp = now();
  if (!integer(timestamp) || timestamp > 8_640_000_000_000_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1 || !Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs || retryMaxMs > 86_400_000 || typeof fetchImpl !== 'function') fail('INVALID_ARGUMENTS');
  const directory = prepareDirectory(stateDirectory, { projectRoot, allowTemporary }), lock = join(directory, lockName);
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); writeFileSync(lockFd, JSON.stringify({ application, version, time: new Date(timestamp).toISOString() })); fsyncSync(lockFd); }
  catch { if (lockFd !== undefined) { closeSync(lockFd); unlinkSync(lock); } fail('STATE_BUSY'); }
  try {
    const state = readState(join(directory, stateName)), part = state.scopes[scope], configuration = webhookConfig(env);
    let added = false;
    if (event === 'RECOVERED' ? part.active.length > 0 : !part.active.includes(event)) {
      if (part.queue.length >= 32 || state.sequence >= Number.MAX_SAFE_INTEGER) fail('STATE_CAPACITY');
      const payload = { application, event, status: event === 'RECOVERED' ? `${scope}_recovered` : statuses[event], version, time: new Date(timestamp).toISOString() };
      part.queue.push({ id: ++state.sequence, payload, attempts: 0, nextAttemptAt: 0 });
      part.active = event === 'RECOVERED' ? [] : [...part.active, event]; added = true;
      saveState(directory, state); // Pending exists durably before any network call.
    }
    const result = (status, reason, sent, exitCode) => ({ application, version, event, scope, status, reason, configured: configuration.configured, sent, pending: part.queue.length, receiptCount: part.receipts.length, time: new Date(timestamp).toISOString(), exitCode });
    if (!configuration.configured) return result(part.queue.length ? 'pending' : 'unconfigured', configuration.reason, false, 2);
    if (!part.queue.length) return result('deduplicated', 'NO_PENDING_NOTIFICATION', false, 0);
    let sent = false;
    for (let index = 0; index < 8 && part.queue.length; index++) {
      const item = part.queue[0], time = now();
      if (!integer(time)) fail('INVALID_ARGUMENTS');
      if (item.nextAttemptAt > time) return result('pending', 'RETRY_NOT_DUE', sent, 1);
      if (item.attempts >= 1_000_000) fail('STATE_CAPACITY');
      item.attempts++; item.nextAttemptAt = time + Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(item.attempts - 1, 20));
      saveState(directory, state);
      const controller = new AbortController(); let timer;
      try {
        const timedOut = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new OperationsAlertError('DELIVERY_TIMEOUT')); }, timeoutMs); });
        const response = await Promise.race([Promise.resolve().then(() => fetchImpl(configuration.url, { method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(item.payload) })), timedOut]);
        if (!response || response.ok !== true || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) return result('pending', 'DELIVERY_FAILED', sent, 1);
        // Provider response text/headers are deliberately never persisted.
        const deliveredAt = now(); if (!integer(deliveredAt)) fail('INVALID_ARGUMENTS');
        part.receipts.push({ id: item.id, ...item.payload, attempts: item.attempts, deliveredAt: new Date(deliveredAt).toISOString(), httpStatus: response.status });
        part.receipts = part.receipts.slice(-32); part.queue.shift(); saveState(directory, state); sent = true;
      } catch (error) {
        if (error instanceof OperationsAlertError && ['STATE_WRITE_FAILED', 'STATE_CAPACITY', 'INVALID_ARGUMENTS'].includes(error.code)) throw error;
        return result('pending', 'DELIVERY_FAILED', sent, 1);
      } finally { clearTimeout(timer); controller.abort(); }
    }
    return part.queue.length ? result('pending', 'PENDING_BATCH_REMAINS', sent, 1) : result('delivered', 'RECEIPT_RECORDED', sent, 0);
  } finally { closeSync(lockFd); unlinkSync(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await operationsAlert({ ...parseAlertArguments(process.argv.slice(2)), env: process.env }); console.log(JSON.stringify(result)); process.exitCode = result.exitCode; }
  catch (error) { console.error(JSON.stringify({ application, version, status: 'unavailable', reason: error instanceof OperationsAlertError ? error.code : 'ALERT_FAILED' })); process.exitCode = 1; }
}
