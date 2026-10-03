import { isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, realpathSync, accessSync, constants } from 'node:fs';
import { dirname } from 'node:path';

export const MEMBERSHIP_DATABASE_APPLICATION_ID = 0x424c4946;

const project = fileURLToPath(new URL('..', import.meta.url));
const within = (root, path) => { const value = relative(resolve(root), resolve(path)); return !value || (!value.startsWith('..') && !isAbsolute(value)); };
export function privateStoragePath(value, { projectRoot, allowTemporary = false } = {}) {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\0')
    && !/(?:^|[/\\])(?:public|dist|image[_-]?2(?:[-_.][^/\\]*)?)(?:[/\\]|$)/i.test(value)
    && (allowTemporary || !/(?:^|[/\\])(?:tmp|temp)(?:[/\\]|$)/i.test(value))
    && (!projectRoot || !within(projectRoot, value));
}
export function validBackupEncryptionKey(value, authSecret) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || value === authSecret || new Set(value).size < 16) return false;
  const bytes = Buffer.from(value, 'base64url'); return bytes.length === 32 && bytes.toString('base64url') === value;
}
// 读检查：每一层已存在祖先都必须为真实目录，不跟随 symlink/junction。
// 创建新私人目录前也使用此检查，避免先沿链接 mkdir 再发现逃逸。
export function assertDirectoryAncestors(directory, { requireExisting = true } = {}) {
  let part = resolve(directory), missing = false;
  while (true) {
    if (!existsSync(part)) { missing = true; }
    else { const info = lstatSync(part); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_storage_directory'); }
    const parent = dirname(part); if (parent === part) break; part = parent;
  }
  if (requireExisting && missing) throw new Error('missing_storage_directory');
}
export function validHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === url.href.replace(/\/$/, '') && !url.username && !url.password
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

// 生产不能靠缺省 env 悄悄开放不限额问答，也不能误用本机私人库。
// 返回值只有问题键名；不得在错误、preflight 或日志中拼接配置值。
export function productionProblems(env = {}, { projectRoot = project } = {}) {
  const problems = [];
  const secret = typeof env.MEMBERSHIP_AUTH_SECRET === 'string' ? env.MEMBERSHIP_AUTH_SECRET : '';
  if (secret.length < 48 || new Set(secret).size < 16 || /test.only|example|replace|change.?me|your.?secret/i.test(secret)) problems.push('MEMBERSHIP_AUTH_SECRET');
  if (!validHttpsOrigin(env.MEMBERSHIP_APP_ORIGIN)) problems.push('MEMBERSHIP_APP_ORIGIN');
  const filename = env.MEMBERSHIP_DB_PATH;
  if (!privateStoragePath(filename, { projectRoot }) || !/\.(?:sqlite|db)$/.test(filename)) problems.push('MEMBERSHIP_DB_PATH');
  if (env.MEMBERSHIP_ENFORCE !== 'true') problems.push('MEMBERSHIP_ENFORCE');
  if (env.MEMBERSHIP_LOCAL_DEMO !== 'false') problems.push('MEMBERSHIP_LOCAL_DEMO');
  const origins = typeof env.QA_ALLOWED_ORIGINS === 'string' ? env.QA_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean) : [];
  if (origins.length !== 1 || origins[0] !== env.MEMBERSHIP_APP_ORIGIN?.replace(/\/$/, '')) problems.push('QA_ALLOWED_ORIGINS');
  if (typeof env.DEEPSEEK_API_KEY !== 'string' || !env.DEEPSEEK_API_KEY.trim()) problems.push('DEEPSEEK_API_KEY');
  return problems;
}

export function assertProductionConfig(env = {}, options) {
  if (env.NODE_ENV !== 'production') return;
  const problems = productionProblems(env, options);
  if (problems.length) throw new Error(`生产配置未完成：${problems.join(', ')}。服务未启动；请运行生产 preflight。`);
}

export function assertProductionStorage(env = {}, { projectRoot = project } = {}) {
  if (env.NODE_ENV !== 'production') return;
  try {
    const directory = dirname(env.MEMBERSHIP_DB_PATH); assertDirectoryAncestors(directory);
    const info = lstatSync(directory); if (process.platform !== 'win32' && info.mode & 0o077) throw new Error();
    if (within(projectRoot, realpathSync(directory))) throw new Error(); accessSync(directory, constants.R_OK | constants.W_OK);
    if (existsSync(env.MEMBERSHIP_DB_PATH)) {
      const file = lstatSync(env.MEMBERSHIP_DB_PATH);
      if (!file.isFile() || file.isSymbolicLink() || process.platform !== 'win32' && file.mode & 0o077) throw new Error();
    }
  } catch { throw new Error('生产持久数据库目录或权限不安全，服务未启动。请使用独立私人目录并运行 preflight。'); }
}
