import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { createMembershipStore, hash } from '../server/membership-store.mjs';
import { createEncryptedBackup, checkEncryptedBackup, verifyPrivateDatabase } from '../scripts/membership-backup.mjs';
import { productionPreflight } from '../scripts/production-preflight.mjs';
import { DatabaseSync } from 'node:sqlite';
import { validBackupEncryptionKey } from '../server/production-config.mjs';

const secret = 'fixture-only-auth-secret-with-private-data-1234567890', encryptionKey = () => randomBytes(32).toString('base64url');
const encrypt = value => { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce), body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return `${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`; };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'better-life-backup-test-')), privateDir = join(directory, 'private'); mkdirSync(privateDir, { mode: 0o700 });
  const filename = join(privateDir, 'membership.sqlite'), store = createMembershipStore({ filename });
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const user = store.localDemoUser(hash('fixture-session'));
  store.createGuide(user, encrypt({ title: 'private-title-never-in-backup-log', content: 'private-personal-content', sourceIds: [] }));
  return { directory, privateDir, filename, store, destination: join(privateDir, 'backup.blbk') };
}
test('backup: consistent SQLite WAL snapshot is encrypted, restored and integrity/decryption checked without changing live source', async t => {
  const h = fixture(t), key = encryptionKey(), before = h.store.db.prepare('SELECT content_cipher FROM guides').get().content_cipher;
  const result = await createEncryptedBackup({ filename: h.filename, destination: h.destination, encryptionKey: key, authSecret: secret });
  assert.equal(result.backupCreated, true); assert.equal(result.privateContentDecryption, 'verified');
  const raw = readFileSync(h.destination); assert.equal(raw.subarray(0, 5).toString(), 'BLBK1'); assert.ok(!raw.includes(Buffer.from('SQLite format'))); assert.ok(!raw.includes(Buffer.from(before))); assert.ok(!raw.includes(Buffer.from('private-personal')));
  const checked = await checkEncryptedBackup({ filename: h.destination, workDirectory: h.privateDir, encryptionKey: key, authSecret: secret });
  assert.equal(checked.restorationChecked, true); assert.equal(checked.sourceDatabaseUnmodified, true); assert.equal(checked.privateContentDecryption, 'verified');
  assert.equal(h.store.db.prepare('SELECT content_cipher FROM guides').get().content_cipher, before);
  assert.ok(readdirSync(h.privateDir).every(name => !name.startsWith('.better-life-')));
});
test('backup: wrong encryption/auth keys and modified ciphertext fail closed and remove decrypted temporary files', async t => {
  const h = fixture(t), key = encryptionKey(); await createEncryptedBackup({ filename: h.filename, destination: h.destination, encryptionKey: key, authSecret: secret });
  for (const options of [{ encryptionKey: encryptionKey(), authSecret: secret }, { encryptionKey: key, authSecret: 'wrong-private-auth-secret-1234567890' }]) await assert.rejects(() => checkEncryptedBackup({ filename: h.destination, workDirectory: h.privateDir, ...options }), /原库未改动/);
  const changed = readFileSync(h.destination); changed[changed.length - 3] ^= 1; writeFileSync(h.destination, changed);
  await assert.rejects(() => checkEncryptedBackup({ filename: h.destination, workDirectory: h.privateDir, encryptionKey: key, authSecret: secret }), /原库未改动/);
  assert.ok(readdirSync(h.privateDir).every(name => !name.startsWith('.better-life-'))); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guides').get().n, 1);
});
test('backup: source/destination identity, old backups and public destinations cannot be overwritten', async t => {
  const h = fixture(t), key = encryptionKey();
  await assert.rejects(() => createEncryptedBackup({ filename: h.filename, destination: h.filename, encryptionKey: key, authSecret: secret }));
  writeFileSync(h.destination, 'keep-previous-backup'); await assert.rejects(() => createEncryptedBackup({ filename: h.filename, destination: h.destination, encryptionKey: key, authSecret: secret })); assert.equal(readFileSync(h.destination, 'utf8'), 'keep-previous-backup');
  const publicPath = join(h.directory, 'public', 'exposed.blbk'); await assert.rejects(() => createEncryptedBackup({ filename: h.filename, destination: publicPath, encryptionKey: key, authSecret: secret })); assert.equal(existsSync(publicPath), false);
  await assert.rejects(() => createEncryptedBackup({ filename: h.filename, destination: join(h.privateDir, 'bad-key.blbk'), encryptionKey: secret, authSecret: secret }));
});
test('backup: directory junctions/symlinks cannot redirect plaintext snapshots into a different directory', async t => {
  const h = fixture(t), actual = join(h.directory, 'redirected'); mkdirSync(actual); const link = join(h.directory, 'private-link'); symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => createEncryptedBackup({ filename: h.filename, destination: join(link, 'backup.blbk'), encryptionKey: encryptionKey(), authSecret: secret }));
  assert.deepEqual(readdirSync(actual), []);
});
test('backup: ancestor junction with missing destination child is rejected before mkdir; source links are also rejected', async t => {
  const h = fixture(t), actual = join(h.directory, 'redirected'); mkdirSync(actual); const link = join(h.directory, 'ancestor-link'); symlinkSync(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => createEncryptedBackup({ filename: h.filename, destination: join(link, 'must-not-create', 'nested', 'backup.blbk'), encryptionKey: encryptionKey(), authSecret: secret }));
  assert.deepEqual(readdirSync(actual), []);
  const sourceLink = join(h.directory, 'source-link'); symlinkSync(h.privateDir, sourceLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => createEncryptedBackup({ filename: join(sourceLink, 'membership.sqlite'), destination: h.destination, encryptionKey: encryptionKey(), authSecret: secret }));
  assert.equal(existsSync(h.destination), false); assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guides').get().n, 1);
});
test('backup: shared source-app directories are rejected before creating output or accessing source databases', async t => {
  const h = fixture(t);
  for (const name of ['image2-shared', 'image2-current', 'image2-releases', 'Image_2', 'public', 'dist']) {
    const destination = join(h.directory, name, 'must-not-create', 'backup.blbk');
    await assert.rejects(() => createEncryptedBackup({ filename: h.filename, destination, encryptionKey: encryptionKey(), authSecret: secret }));
    assert.equal(existsSync(join(h.directory, name)), false);
    await assert.rejects(() => createEncryptedBackup({ filename: join(h.directory, name, 'users.sqlite'), destination: h.destination, encryptionKey: encryptionKey(), authSecret: secret }));
    assert.equal(existsSync(h.destination), false);
  }
});
test('backup: explicit restoration writes only a new validated file, never overwrites live DB or old recovery', async t => {
  const h = fixture(t), key = encryptionKey(); await createEncryptedBackup({ filename: h.filename, destination: h.destination, encryptionKey: key, authSecret: secret });
  const destination = join(h.privateDir, 'recovery.sqlite');
  const result = await checkEncryptedBackup({ filename: h.destination, workDirectory: h.privateDir, restoreDestination: destination, encryptionKey: key, authSecret: secret });
  assert.equal(result.restoredToNewFile, true); const recovered = new DatabaseSync(destination, { readOnly: true });
  try { assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM guides').get().n, 1); } finally { recovered.close(); }
  for (const restoreDestination of [destination, h.filename]) await assert.rejects(() => checkEncryptedBackup({ filename: h.destination, workDirectory: h.privateDir, restoreDestination, encryptionKey: key, authSecret: secret }));
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM guides').get().n, 1);
});
test('backup: unrelated/corrupt DB is never declared restorable', t => {
  const h = fixture(t), unrelated = join(h.privateDir, 'unrelated.sqlite'); writeFileSync(unrelated, 'not-a-database');
  assert.throws(() => verifyPrivateDatabase(unrelated, { authSecret: secret }), /原库未改动/);
});
test('production preflight: secrets absent report only field names; complete config still does not claim live delivery/payment', () => {
  const missing = productionPreflight({}, { checkFiles: false }); assert.equal(missing.readyForProductionStartup, false); assert.equal(missing.liveDeliveryVerified, false); assert.equal(missing.livePaymentVerified, false);
  const env = { MEMBERSHIP_AUTH_SECRET: randomBytes(48).toString('base64url'), MEMBERSHIP_APP_ORIGIN: 'https://private.fixture.test', MEMBERSHIP_DB_PATH: process.platform === 'win32' ? 'C:\\private-better-life\\membership.sqlite' : '/var/lib/better-life/membership.sqlite', MEMBERSHIP_ENFORCE: 'true', MEMBERSHIP_LOCAL_DEMO: 'false', QA_ALLOWED_ORIGINS: 'https://private.fixture.test', DEEPSEEK_API_KEY: 'private-fixture-model-key', MEMBERSHIP_EMAIL_PROVIDER: 'aliyun', MEMBERSHIP_SMS_PROVIDER: 'aliyun', ALIYUN_ACCESS_KEY_ID: 'fixtureAccessKey', ALIYUN_ACCESS_KEY_SECRET: 'private-fixture-access-secret', ALIYUN_EMAIL_ACCOUNT_NAME: 'private@fixture.test', ALIYUN_SMS_SIGN: '人生指南', ALIYUN_SMS_TEMPLATE_CODE: 'SMS_123456', MEMBERSHIP_BACKUP_ENCRYPTION_KEY: encryptionKey(), MEMBERSHIP_BACKUP_DIR: process.platform === 'win32' ? 'C:\\private-backups' : '/var/backups/better-life', MEMBERSHIP_PAYMENT_PROVIDER: 'none', MEMBERSHIP_PAYMENT_CREATE_ENABLED: 'false' };
  const result = productionPreflight(env, { checkFiles: false }); assert.equal(result.readyForProductionStartup, true); assert.equal(result.paymentCreationEnabled, false); assert.equal(result.livePaymentVerified, false);
  for (const key of ['MEMBERSHIP_AUTH_SECRET', 'DEEPSEEK_API_KEY', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_EMAIL_ACCOUNT_NAME', 'MEMBERSHIP_BACKUP_ENCRYPTION_KEY', 'MEMBERSHIP_APP_ORIGIN']) assert.ok(!JSON.stringify(result).includes(env[key]));
});
test('production preflight: noncanonical/placeholder backup keys and shared/public/temporary/release backup directories fail closed', () => {
  const key = encryptionKey(), chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical = key.slice(0, -1) + chars[chars.indexOf(key.at(-1)) + 1];
  assert.deepEqual(Buffer.from(noncanonical, 'base64url'), Buffer.from(key, 'base64url'));
  for (const invalid of [noncanonical, Buffer.alloc(32).toString('base64url'), key + '=', secret]) {
    assert.equal(validBackupEncryptionKey(invalid, secret), false);
    const result = productionPreflight({ MEMBERSHIP_AUTH_SECRET: secret, MEMBERSHIP_BACKUP_ENCRYPTION_KEY: invalid }, { checkFiles: false });
    assert.ok(result.problems.includes('MEMBERSHIP_BACKUP_ENCRYPTION_KEY')); assert.ok(!JSON.stringify(result).includes(invalid));
  }
  assert.equal(validBackupEncryptionKey(key, secret), true);
  const root = process.platform === 'win32' ? 'C:\\release-better-life' : '/var/www/release-better-life';
  const backupPaths = ['image2-shared', 'image2-current', 'image2-releases', 'Image_2', 'public', 'dist', 'tmp', 'temp'].map(name => process.platform === 'win32' ? `C:\\${name}\\backups` : `/var/${name}/backups`);
  backupPaths.push(join(root, 'private-backups'));
  for (const path of backupPaths) assert.ok(productionPreflight({ MEMBERSHIP_BACKUP_DIR: path, MEMBERSHIP_BACKUP_ENCRYPTION_KEY: key }, { checkFiles: false, projectRoot: root }).problems.includes('MEMBERSHIP_BACKUP_DIR'), path);
});
