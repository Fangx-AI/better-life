import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../scripts/content.mjs';
import { createApiRuntime } from './membership-runtime.mjs';
import { qaMiddleware } from './node-adapter.mjs';

const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
const runtime = createApiRuntime({ getCorpus: () => corpus, env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' } });
const middleware = qaMiddleware(runtime.handler, { trustedProxyIps: (process.env.MEMBERSHIP_TRUSTED_PROXY_IPS || '').split(',').map(ip => ip.trim()) });
const port = Number(process.env.QA_PORT || 4175);
createServer((req, res) => middleware(req, res, () => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }));
})).on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); })
  .listen(port, process.env.QA_HOST || '127.0.0.1', () => console.log(`Better Life API：http://${process.env.QA_HOST || '127.0.0.1'}:${port}/api/membership（密钥仅服务端；付款默认关闭）`))
  .requestTimeout = 15000;
