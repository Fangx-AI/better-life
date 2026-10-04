import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDirectoryAncestors, privateStoragePath, validHttpsOrigin } from '../server/production-config.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const GIB = 1024 * 1024 * 1024;
function directory(path, { projectRoot, allowTemporary }) {
  if (!privateStoragePath(path, { projectRoot, allowTemporary })) throw new Error('unsafe_directory');
  assertDirectoryAncestors(path);
  if (process.platform !== 'win32' && lstatSync(path).mode & 0o077) throw new Error('unsafe_directory');
}
function fileBytes(path, { optional = false } = {}) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (optional && error.code === 'ENOENT') return 0; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && info.mode & 0o077) throw new Error('unsafe_file');
  return info.size;
}

// Read-only inspection; no credentials/body/database contents are read, and no timer is installed.
// Backup mtime is only a freshness signal, never proof that encryption or restoration passed.
export async function operationsHealth({ env = {}, fetchImpl = globalThis.fetch, now = Date.now,
  projectRoot = project, allowTemporary = false, timeoutMs = 10_000, maxBackupAgeMs = 26 * 3_600_000,
  minFreeBytes = GIB, minFreeFraction = 0.15, statfs = statfsSync } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000
    || !Number.isSafeInteger(maxBackupAgeMs) || maxBackupAgeMs <= 0 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0
    || !Number.isFinite(minFreeFraction) || minFreeFraction < 0 || minFreeFraction > 1) throw new Error('运维巡检参数无效。');
  const problems = [], warnings = [], checks = { api: 'not-checked', backupFreshness: 'not-checked', disk: 'not-checked' };
  const timestamp = now();
  if (!validHttpsOrigin(env.MEMBERSHIP_APP_ORIGIN)) problems.push('API_ORIGIN_CONFIGURATION');
  else {
    const controller = new AbortController(); let timer;
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
    });
    try {
      const task = async () => {
        const response = await fetchImpl(new URL('/api/health', env.MEMBERSHIP_APP_ORIGIN), { method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) throw new Error('unavailable');
        // Do not collect or log arbitrary error payloads; even an accidental giant response is bounded.
        const reader = response.body?.getReader(); if (!reader) throw new Error('unavailable');
        let length = 0, chunks = [];
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            length += part.value.byteLength; if (length > 4096) { reader.cancel().catch(() => {}); throw new Error('oversized'); } chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); chunks = [];
        if (body.application !== 'better-life' || body.status !== 'ready') throw new Error('wrong_application');
        return body;
      };
      const body = await Promise.race([task(), interrupted]); checks.api = 'ready';
      if (body.metering !== true || body.localDemo !== false) problems.push('PRODUCTION_METERING_OR_DEMO');
      if (body.login?.emailConfigured !== true || body.login?.phoneConfigured !== true) problems.push('LOGIN_PROVIDER_NOT_CONFIGURED');
      if (body.payments?.creationEnabled !== true) warnings.push('PAYMENT_CREATION_DISABLED');
    } catch { checks.api = 'unavailable'; problems.push('API_HEALTH_UNAVAILABLE'); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  let databaseBytes = 0, databaseDirectory;
  try {
    if (!privateStoragePath(env.MEMBERSHIP_DB_PATH, { projectRoot, allowTemporary }) || !/\.(sqlite|db)$/.test(env.MEMBERSHIP_DB_PATH)) throw new Error('unsafe_database');
    databaseDirectory = dirname(env.MEMBERSHIP_DB_PATH); directory(databaseDirectory, { projectRoot, allowTemporary });
    databaseBytes = fileBytes(env.MEMBERSHIP_DB_PATH) + fileBytes(`${env.MEMBERSHIP_DB_PATH}-wal`, { optional: true }) + fileBytes(`${env.MEMBERSHIP_DB_PATH}-shm`, { optional: true });
  } catch { databaseDirectory = null; problems.push('PRIVATE_DATABASE_METADATA_UNAVAILABLE'); }

  let backupDirectory;
  try {
    backupDirectory = env.MEMBERSHIP_BACKUP_DIR; directory(backupDirectory, { projectRoot, allowTemporary });
    let newest = 0, future = false;
    for (const name of readdirSync(backupDirectory)) {
      if (!/^better-life-[A-Za-z0-9-]+\.blbk$/.test(name)) continue;
      const path = join(backupDirectory, name), info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 33 || process.platform !== 'win32' && info.mode & 0o077) continue;
      if (info.mtimeMs > timestamp + 5 * 60_000) { future = true; continue; }
      newest = Math.max(newest, info.mtimeMs);
    }
    if (future) warnings.push('BACKUP_CLOCK_SKEW');
    if (!newest) { checks.backupFreshness = 'missing'; problems.push('BACKUP_MISSING'); }
    else if (timestamp - newest > maxBackupAgeMs) { checks.backupFreshness = 'stale'; problems.push('BACKUP_STALE'); }
    else checks.backupFreshness = 'fresh-unverified';
  } catch { backupDirectory = null; checks.backupFreshness = 'unavailable'; problems.push('BACKUP_DIRECTORY_UNAVAILABLE'); }

  if (databaseDirectory && backupDirectory) {
    try {
      const requiredBytes = Math.max(minFreeBytes, databaseBytes * 2);
      let low = false;
      for (const path of new Set([databaseDirectory, backupDirectory])) {
        const disk = statfs(path), free = Number(disk.bavail) * Number(disk.bsize), capacity = Number(disk.blocks) * Number(disk.bsize);
        if (!Number.isFinite(free) || !Number.isFinite(capacity) || capacity <= 0 || free < 0) throw new Error('unavailable');
        if (free < requiredBytes || free / capacity < minFreeFraction) low = true;
      }
      checks.disk = low ? 'low' : 'ok'; if (low) problems.push('DISK_SPACE_LOW');
    } catch { checks.disk = 'unavailable'; problems.push('DISK_METADATA_UNAVAILABLE'); }
  }
  return { application: 'better-life', status: problems.length ? 'unavailable' : warnings.length ? 'degraded' : 'healthy', checks,
    problems: [...new Set(problems)], warnings: [...new Set(warnings)], backupRestorationVerified: false,
    liveDeliveryVerified: false, livePaymentVerified: false,
    note: '仅检查本项目进程、文件元数据、备份新鲜度和磁盘余量；不证明真实收码、模型、付款或灾备恢复成功。' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await operationsHealth({ env: process.env }); console.log(JSON.stringify(result, null, 2)); if (result.problems.length) process.exitCode = 1; }
  catch { console.error('Better Life 运维巡检失败，未执行任何修复或写操作。'); process.exitCode = 1; }
}
