import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { publicBasePath } from '../scripts/site-base.mjs';
import { createApiRuntime } from './membership-runtime.mjs';
import { qaMiddleware } from './node-adapter.mjs';
import { isPrivateFileRequest } from './private-files.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const within = (root, file) => { const path = relative(root, file); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..\\`) && !path.startsWith('../')); };
const respond = (res, status, message) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { message } })); };

// 仅托管dist/client；不得托管仓库、env、key或数据库。会员/API始终与页面同源。
export function createStaticMiddleware({ rootDir = resolve(project, 'dist/client'), basePath = '/better-life/' } = {}) {
  const base = publicBasePath(basePath), root = resolve(rootDir);
  return async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) return respond(res, 405, '请求方式不支持。');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (isPrivateFileRequest(req.url)) return respond(res, 403, '私人文件不可访问。');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) return respond(res, 403, '文件不可访问。');
      if (base !== '/' && pathname === base.slice(0, -1)) { res.writeHead(308, { location: `${base}${url.search}` }); return res.end(); }
      if (!pathname.startsWith(base)) return respond(res, 404, '页面不存在。');
      pathname = pathname.slice(base.length);
      if (pathname === 'api' || pathname.startsWith('api/')) return respond(res, 404, '接口不存在。');
      const actualRoot = await realpath(root);
      let file = resolve(actualRoot, pathname || 'index.html');
      if (!within(actualRoot, file)) return respond(res, 403, '文件不可访问。');
      let info;
      try { info = await stat(file); }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        if (extname(pathname) || !req.headers.accept?.includes('text/html')) return respond(res, 404, '文件不存在。');
        file = resolve(actualRoot, 'index.html'); info = await stat(file);
      }
      const actualFile = await realpath(file);
      if (!within(actualRoot, actualFile) || !info.isFile()) return respond(res, 403, '文件不可访问。');
      res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': info.size, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
        'cache-control': pathname.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(actualFile), res);
    } catch {
      if (!res.headersSent) respond(res, 503, '页面文件尚未准备，请先构建网站。');
      else if (!res.destroyed) res.destroy();
    }
  };
}

export function startApp({ env = process.env } = {}) {
  const runtimeEnv = { ...env, NODE_ENV: env.NODE_ENV || 'production' };
  const corpus = loadCorpus(project), runtime = createApiRuntime({ env: runtimeEnv, getCorpus: () => corpus });
  const api = qaMiddleware(runtime.handler, { trustedProxyIps: (runtimeEnv.MEMBERSHIP_TRUSTED_PROXY_IPS || '').split(',').map(ip => ip.trim()) });
  const serve = createStaticMiddleware({ basePath: runtimeEnv.PUBLIC_BASE_PATH || '/better-life/' });
  const server = createServer((req, res) => api(req, res, () => serve(req, res)));
  server.requestTimeout = 15000;
  server.on('close', runtime.close);
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  server.listen(Number(runtimeEnv.QA_PORT || 4175), runtimeEnv.QA_HOST || '127.0.0.1');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = startApp();
  server.on('listening', () => console.log('Better Life 同源网站与API已启动；验证码和付款只按真实配置开放。'));
  server.on('error', () => { console.error('网站无法启动，请检查端口和持久存储配置。'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
