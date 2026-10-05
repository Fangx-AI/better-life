import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { isPrivateFileRequest } from './private-files.mjs';

// Local Vite / Node API share this adapter. Production auth must be reverse-
// proxied under the same HTTPS commercial site, not third-party Pages cookies.
export function qaMiddleware(handler, { trustedProxyIps = [] } = {}) {
  const trusted = new Set(trustedProxyIps.filter(ip => typeof ip === 'string' && isIP(ip)));
  return async (req, res, next) => {
    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      if (isPrivateFileRequest(req.url)) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { code: 'PRIVATE_FILE', message: '私人数据文件不能通过网页访问。' } }));
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (!/^\/(?:better-life\/)?api\//.test(url.pathname)) return next();
      url.pathname = url.pathname.replace(/^\/better-life\//, '/');
      const headers = new Headers(req.headers);
      const trustedProxy = trusted.has(req.socket.remoteAddress);
      const proxyPresent = trustedProxy || ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip'].some(name => req.headers[name] != null);
      headers.delete('cf-connecting-ip'); headers.delete('x-forwarded-for');
      // 仅明确列出的入口socket可提供单个X-Real-IP；代理必须覆盖而非转发客户端头。
      const realIp = typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'].trim() : '';
      headers.delete('x-real-ip');
      headers.set('x-better-life-client-ip', trustedProxy && isIP(realIp) ? realIp : req.socket.remoteAddress || 'shared');
      // 本机体验不接受已知反向代理/隧道流量；此标记只能由 socket adapter 产生。
      headers.set('x-better-life-proxy-present', proxyPresent ? 'true' : 'false');
      const request = new Request(url, { method: req.method, headers, signal: abort.signal,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: '服务暂时不可用，请稍后重试。' } }));
    }
  };
}
