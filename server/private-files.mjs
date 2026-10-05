// Vite 8 当前默认 deny 原样保留，再增加私人档案和数据库；升级 Vite 时重新核对。
export const PRIVATE_FS_DENY = [
  '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  '**/output/private/**', '**/private/**', '*.{sqlite,sqlite-wal,sqlite-shm,db,db-wal,db-shm}',
];

// 额外的 pre-static guard：Git ignore 不是 HTTP 访问控制，预览服务也要拦截。
export function isPrivateFileRequest(url) {
  let path;
  try { path = new URL(url, 'http://127.0.0.1').pathname; }
  catch { return true; }
  for (let i = 0; i < 8; i++) {
    let decoded; try { decoded = decodeURIComponent(path); } catch { return true; }
    if (decoded === path) break;
    path = decoded;
  }
  if (path.includes('\0')) return true;
  // Windows 会将路径分段的末尾空格/点规范化，不能让这些别名绕过 deny。
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
    .split('/').map(segment => segment.replace(/[ .]+$/g, '')).join('/');
  return /(?:^|\/)private(?:\/|$)/.test(path)
    || /\.(?:key|sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?)(?:[/:]|$)/.test(path);
}
