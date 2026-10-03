import { DatabaseSync, backup } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, mkdirSync, openSync, closeSync, writeSync, readSync, fsyncSync, unlinkSync, linkSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MEMBERSHIP_DATABASE_APPLICATION_ID, validBackupEncryptionKey, privateStoragePath, assertDirectoryAncestors } from '../server/production-config.mjs';

const MAGIC = Buffer.from('BLBK1'), HEADER = MAGIC.length + 12 + 16;
const requiredTables = ['users', 'account_identities', 'sessions', 'orders', 'entitlements', 'quota_periods', 'guides', 'guide_versions', 'profiles', 'payment_events'];
const safeError = () => new Error('私人数据库备份或恢复校验失败；原库未改动。请检查独立密钥、文件权限和备份完整性。');
function backupKey(value, authSecret) {
  if (!validBackupEncryptionKey(value, authSecret)) throw safeError();
  return Buffer.from(value, 'base64url');
}
function privatePath(value) {
  if (!privateStoragePath(value, { allowTemporary: true })) throw safeError();
  return resolve(value);
}
function regularFile(value) { try { assertDirectoryAncestors(dirname(value)); const info = lstatSync(value); if (!info.isFile() || info.isSymbolicLink()) throw safeError(); } catch { throw safeError(); } }
function privateDirectory(value) {
  try { assertDirectoryAncestors(value, { requireExisting: false }); } catch { throw safeError(); }
  mkdirSync(value, { recursive: true, mode: 0o700 });
  // 拒绝路径中的 symlink/junction，避免把明文临时快照放进可公开的目录。
  assertDirectoryAncestors(value);
  if (process.platform !== 'win32' && lstatSync(value).mode & 0o077) throw safeError();
}
function temporary(directory, suffix) { const name = join(directory, `.better-life-${randomBytes(16).toString('hex')}${suffix}`); const rel = relative(directory, name); if (isAbsolute(rel) || rel.startsWith('..')) throw safeError(); return name; }
function emptyPrivateFile(filename) { const fd = openSync(filename, 'wx', 0o600); closeSync(fd); }
function removeOwnedTemp(filename) { if (filename && existsSync(filename)) { regularFile(filename); unlinkSync(filename); } }
function removeOwnedSnapshot(filename) { for (const suffix of ['', '-wal', '-shm', '-journal']) removeOwnedTemp(`${filename}${suffix}`); }
function fsyncFile(filename) { const fd = openSync(filename, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function fsyncDirectory(directory) { if (process.platform === 'win32') return; const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

export function verifyPrivateDatabase(filename, { authSecret } = {}) {
  regularFile(filename); const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== MEMBERSHIP_DATABASE_APPLICATION_ID) throw safeError();
    const integrity = db.prepare('PRAGMA integrity_check').all(); if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw safeError();
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw safeError();
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    if (requiredTables.some(table => !tables.has(table))) throw safeError();
    let verified = false;
    for (const [table, column] of [['guides', 'content_cipher'], ['guide_versions', 'content_cipher'], ['profiles', 'facts_cipher'], ['saved_answers', 'result_cipher'], ['generations', 'result_cipher']]) {
      for (const row of db.prepare(`SELECT ${column} AS cipher FROM ${table} WHERE ${column} IS NOT NULL`).iterate()) {
        if (typeof authSecret !== 'string' || authSecret.length < 32) throw safeError();
        const parts = row.cipher.split('.'); if (parts.length !== 3) throw safeError();
        const nonce = Buffer.from(parts[0], 'base64url'), tag = Buffer.from(parts[1], 'base64url'); if (nonce.length !== 12 || tag.length !== 16) throw safeError();
        const cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(authSecret).digest(), nonce); cipher.setAuthTag(tag);
        const content = Buffer.concat([cipher.update(Buffer.from(parts[2], 'base64url')), cipher.final()]);
        JSON.parse(content.toString('utf8')); content.fill(0); verified = true;
      }
    }
    return { integrity: 'ok', foreignKeys: 'ok', application: 'better-life', privateContentDecryption: verified ? 'verified' : 'no-encrypted-content' };
  } catch { throw safeError(); }
  finally { db.close(); }
}

// Online Backup API 包含 WAL 中已提交事务，不能用 copy *.sqlite 冒充完整备份。
// 全库另加 AES-GCM，保护未单独加密的账号联系方式。临时明文只在私人目录出现并清理。
export async function createEncryptedBackup({ filename, destination, encryptionKey, authSecret } = {}) {
  const source = privatePath(filename), target = privatePath(destination), key = backupKey(encryptionKey, authSecret);
  if (source === target || existsSync(target)) throw safeError(); regularFile(source); privateDirectory(dirname(target));
  const plain = temporary(dirname(target), '.sqlite'), encrypted = temporary(dirname(target), '.blbk'); let db;
  try {
    emptyPrivateFile(plain); db = new DatabaseSync(source, { readOnly: true }); await backup(db, plain); db.close(); db = null;
    const verified = verifyPrivateDatabase(plain, { authSecret });
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(MAGIC);
    const fd = openSync(encrypted, 'wx', 0o600); try { writeSync(fd, Buffer.concat([MAGIC, nonce, Buffer.alloc(16)])); } finally { closeSync(fd); }
    await pipeline(createReadStream(plain), cipher, createWriteStream(encrypted, { flags: 'a', mode: 0o600 }));
    const tagFd = openSync(encrypted, 'r+'); try { writeSync(tagFd, cipher.getAuthTag(), 0, 16, MAGIC.length + 12); fsyncSync(tagFd); } finally { closeSync(tagFd); }
    // 同目录原子公布；link 的 exclusive 语义不覆盖任何旧备份。
    linkSync(encrypted, target);
    fsyncDirectory(dirname(target));
    return { backupCreated: true, ...verified };
  } catch { throw safeError(); }
  finally { if (db) db.close(); removeOwnedSnapshot(plain); removeOwnedTemp(encrypted); key.fill(0); }
}

// 只还原到随机私人临时文件校验，不覆盖运行中的原库；事故切换由 runbook 执行。
export async function checkEncryptedBackup({ filename, workDirectory, encryptionKey, authSecret, restoreDestination } = {}) {
  const source = privatePath(filename), directory = privatePath(workDirectory), key = backupKey(encryptionKey, authSecret);
  const target = restoreDestination ? privatePath(restoreDestination) : null;
  if (target && (existsSync(target) || dirname(target) !== directory || target === source)) throw safeError();
  regularFile(source); privateDirectory(directory); const plain = temporary(directory, '.sqlite');
  try {
    const fd = openSync(source, 'r'), header = Buffer.alloc(HEADER); let read;
    try { read = readSync(fd, header, 0, HEADER, 0); } finally { closeSync(fd); }
    if (read !== HEADER || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw safeError();
    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length, MAGIC.length + 12)); cipher.setAAD(MAGIC); cipher.setAuthTag(header.subarray(MAGIC.length + 12));
    emptyPrivateFile(plain); await pipeline(createReadStream(source, { start: HEADER }), cipher, createWriteStream(plain, { flags: 'r+', mode: 0o600 })); fsyncFile(plain);
    const verified = verifyPrivateDatabase(plain, { authSecret });
    if (target) { linkSync(plain, target); fsyncDirectory(dirname(target)); }
    return { restorationChecked: true, sourceDatabaseUnmodified: true, ...(target ? { restoredToNewFile: true } : {}), ...verified };
  } catch { throw safeError(); }
  finally { removeOwnedSnapshot(plain); key.fill(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const env = process.env, mode = process.argv[2];
    const options = { encryptionKey: env.MEMBERSHIP_BACKUP_ENCRYPTION_KEY, authSecret: env.MEMBERSHIP_AUTH_SECRET };
    let result;
    if (mode === 'create') {
      const directory = privatePath(env.MEMBERSHIP_BACKUP_DIR), destination = join(directory, `better-life-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.blbk`);
      result = await createEncryptedBackup({ ...options, filename: env.MEMBERSHIP_DB_PATH, destination });
      const checked = await checkEncryptedBackup({ ...options, filename: destination, workDirectory: directory });
      result = { ...result, restorationChecked: checked.restorationChecked };
    } else if (mode === 'check' || mode === 'restore') {
      if (mode === 'restore' && (env.MEMBERSHIP_RESTORE_CONFIRM !== 'restore-to-new-file' || privatePath(env.MEMBERSHIP_RESTORE_DESTINATION) === privatePath(env.MEMBERSHIP_DB_PATH))) throw safeError();
      result = await checkEncryptedBackup({ ...options, filename: env.MEMBERSHIP_RESTORE_CHECK_FILE, workDirectory: mode === 'restore' ? dirname(env.MEMBERSHIP_RESTORE_DESTINATION) : env.MEMBERSHIP_BACKUP_DIR,
        ...(mode === 'restore' ? { restoreDestination: env.MEMBERSHIP_RESTORE_DESTINATION } : {}) });
    } else throw safeError();
    console.log(JSON.stringify(result));
  } catch { console.error(safeError().message); process.exitCode = 1; }
}
