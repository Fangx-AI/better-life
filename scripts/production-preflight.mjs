import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { productionProblems, privateStoragePath, validBackupEncryptionKey, assertDirectoryAncestors, MEMBERSHIP_DATABASE_APPLICATION_ID } from '../server/production-config.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createEmailSender, createSmsSender } from '../server/membership.mjs';
import { createHupijiaoPaymentProvider } from '../server/payment-hupijiao.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
export function productionPreflight(env = {}, { projectRoot = project, checkFiles = true } = {}) {
  const problems = productionProblems(env, { projectRoot });
  const email = Boolean(createEmailSender({ env })), phone = Boolean(createSmsSender({ env }));
  if (!email) problems.push('EMAIL_PROVIDER_CONFIGURATION'); if (!phone) problems.push('SMS_PROVIDER_CONFIGURATION');
  const payment = createHupijiaoPaymentProvider({ env });
  if (env.MEMBERSHIP_PAYMENT_PROVIDER && !['none', 'hupijiao'].includes(env.MEMBERSHIP_PAYMENT_PROVIDER)) problems.push('MEMBERSHIP_PAYMENT_PROVIDER');
  if (env.MEMBERSHIP_PAYMENT_PROVIDER === 'hupijiao' && !payment) problems.push('HUPIJIAO_CONFIGURATION');
  if (env.MEMBERSHIP_PAYMENT_CREATE_ENABLED === 'true' && !payment?.creationEnabled) problems.push('MEMBERSHIP_PAYMENT_CREATE_ENABLED');
  const key = env.MEMBERSHIP_BACKUP_ENCRYPTION_KEY;
  if (!validBackupEncryptionKey(key, env.MEMBERSHIP_AUTH_SECRET)) problems.push('MEMBERSHIP_BACKUP_ENCRYPTION_KEY');
  if (!privateStoragePath(env.MEMBERSHIP_BACKUP_DIR, { projectRoot })) problems.push('MEMBERSHIP_BACKUP_DIR');
  if (checkFiles) {
    if (!existsSync(resolve(projectRoot, 'dist/client/index.html'))) problems.push('BUILT_STATIC_SITE');
    for (const [field, path] of [['MEMBERSHIP_DB_DIRECTORY', env.MEMBERSHIP_DB_PATH && dirname(env.MEMBERSHIP_DB_PATH)], ['MEMBERSHIP_BACKUP_DIRECTORY', env.MEMBERSHIP_BACKUP_DIR]]) {
      try {
        if (!path || !isAbsolute(path)) throw new Error(); const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
        assertDirectoryAncestors(path);
        const actual = realpathSync(path), rel = relative(resolve(projectRoot), actual);
        if (!rel || !rel.startsWith('..') && !isAbsolute(rel)) throw new Error(); accessSync(path, constants.R_OK | constants.W_OK);
        if (process.platform !== 'win32' && info.mode & 0o077) throw new Error();
      } catch { problems.push(field); }
    }
    if (!problems.includes('MEMBERSHIP_DB_PATH') && !problems.includes('MEMBERSHIP_DB_DIRECTORY') && existsSync(env.MEMBERSHIP_DB_PATH)) {
      try { const info = lstatSync(env.MEMBERSHIP_DB_PATH); if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && info.mode & 0o077) throw new Error(); } catch { problems.push('MEMBERSHIP_DB_FILE_PERMISSIONS'); }
      let db;
      try {
        if (problems.includes('MEMBERSHIP_DB_FILE_PERMISSIONS')) throw new Error();
        db = new DatabaseSync(env.MEMBERSHIP_DB_PATH, { readOnly: true });
        if (db.prepare('PRAGMA application_id').get().application_id !== MEMBERSHIP_DATABASE_APPLICATION_ID) throw new Error();
        if (payment) {
          const columns = new Set(db.prepare('PRAGMA table_info(orders)').all().map(value => value.name));
          if (!columns.has('merchant_id') || db.prepare('SELECT 1 FROM orders WHERE merchant_id IS NULL OR merchant_id<>? LIMIT 1').get(payment.merchantId)) problems.push('HISTORICAL_PAYMENT_MERCHANT_BINDING');
        }
      } catch { problems.push('MEMBERSHIP_DATABASE_IDENTITY'); }
      finally { db?.close(); }
    }
  }
  return { readyForProductionStartup: !problems.length, problems: [...new Set(problems)], loginProvidersConfigured: { email, phone }, paymentCreationEnabled: Boolean(payment?.creationEnabled),
    liveDeliveryVerified: false, livePaymentVerified: false, note: '本检查不发送验证码、不创建收费订单、不读用户内容。配置通过仍不代表域名/TLS/收码/支付/恢复演练完成。' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = productionPreflight(process.env); console.log(JSON.stringify(result, null, 2)); if (!result.readyForProductionStartup) process.exitCode = 1;
}
