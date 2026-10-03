import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { isPrivateFileRequest, PRIVATE_FS_DENY } from '../server/private-files.mjs';
import { qaMiddleware } from '../server/node-adapter.mjs';

test('private files: plain, encoded, Windows @fs, uppercase and raw-query paths are denied', () => {
  for (const path of [
    '/output/private/membership.sqlite', '/output/private/local-demo.key', '/output/private/any-file.txt',
    '/output/%70rivate/any-file.txt', '/output%2fprivate%2fany-file.txt', '/output%252fprivate%252fany-file.txt',
    '/@fs/C:/project/output/private/any-file.txt', '/@fs/C:%5cproject%5cOUTPUT%5cPRIVATE%5cany-file.txt',
    '/@fs/C:/project/other.SQLITE-WAL?raw', '/other.sqlite-shm', '/backups/user.DB', '/sensitive.key',
    '/@fs/C:/project/OUTPUT/PRIVATE./dummy.txt', '/@fs/C:/project/output/private%20/dummy.txt',
    '/@fs/C:/project/output/private./local-demo.key.', '/other.sqlite::$DATA', '/sensitive.key%20',
  ]) assert.equal(isPrivateFileRequest(path), true, path);
  for (const path of ['/api/guides', '/better-life/api/auth/local-demo', '/content.json', '/src/main.jsx', '/assets/private-guide-card.png']) assert.equal(isPrivateFileRequest(path), false, path);
});

test('private files: adapter refuses before API/static next without reading any disk file', async () => {
  const req = Readable.from([]); Object.assign(req, { url: '/@fs/C:/fake/project/output/private/dummy.txt', method: 'GET', headers: { host: '127.0.0.1:4190' }, socket: { remoteAddress: '127.0.0.1' } });
  const res = new EventEmitter(); Object.assign(res, { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } });
  await qaMiddleware(() => assert.fail('must not call API'))(req, res, () => assert.fail('must not continue to static server'));
  assert.equal(res.status, 403); assert.equal(res.headers['Cache-Control'], 'no-store'); assert.equal(JSON.parse(res.body).error.code, 'PRIVATE_FILE');
});

test('private files: Vite deny retains installed defaults and adds SQLite/private coverage', () => {
  for (const pattern of ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/output/private/**', '**/private/**', '*.{sqlite,sqlite-wal,sqlite-shm,db,db-wal,db-shm}']) assert.ok(PRIVATE_FS_DENY.includes(pattern));
  const source = readFileSync(new URL('../vite.config.mjs', import.meta.url), 'utf8');
  assert.match(source, /fs:\{deny:PRIVATE_FS_DENY\}/); assert.match(source, /host:localDemo\?'127\.0\.0\.1'/);
});

test('local demo: adapter overwrites proxy marker rather than trusting a spoofed client flag', async () => {
  for (const [headers, expected] of [[{ 'x-better-life-proxy-present': 'true' }, 'false'], [{ 'x-forwarded-for': '203.0.113.10', 'x-better-life-proxy-present': 'false' }, 'true']]) {
    const req = Readable.from([]); Object.assign(req, { url: '/api/membership', method: 'GET', headers: { host: '127.0.0.1:4190', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const res = new EventEmitter(); Object.assign(res, { writeHead() {}, end() { this.writableEnded = true; } });
    await qaMiddleware(request => { assert.equal(request.headers.get('x-better-life-proxy-present'), expected); return new Response('{}'); })(req, res, () => assert.fail('unexpected static'));
  }
});
