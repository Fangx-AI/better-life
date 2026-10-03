import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStaticMiddleware } from '../server/app.mjs';
import { qaMiddleware } from '../server/node-adapter.mjs';

async function fixture(t, basePath = '/') {
  const dir = mkdtempSync(join(tmpdir(), 'better-life-auth-static-')), root = join(dir, 'client');
  mkdirSync(join(root, 'assets'), { recursive: true }); writeFileSync(join(root, 'index.html'), '<title>fixture-site</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'fixture-js'); writeFileSync(join(root, '.env'), 'must-not-expose');
  writeFileSync(join(dir, 'secret.txt'), 'outside-root');
  const serve = createStaticMiddleware({ rootDir: root, basePath });
  const api = qaMiddleware(() => Response.json({ healthy: true }));
  const server = createServer((req, res) => api(req, res, () => serve(req, res)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, root, dir };
}

test('same-origin app: root website, assets, API and HEAD work together without exposing private files', async t => {
  const h = await fixture(t);
  const home = await fetch(`${h.origin}/`); assert.equal(home.status, 200); assert.match(await home.text(), /fixture-site/);
  const asset = await fetch(`${h.origin}/assets/app.js`); assert.equal(asset.status, 200); assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.match(asset.headers.get('cache-control'), /immutable/);
  const head = await fetch(`${h.origin}/`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.deepEqual(await (await fetch(`${h.origin}/api/me`)).json(), { healthy: true });
  for (const path of ['/.env', '/output/private/data.txt', '/other.key', '/@fs/C:/secret.sqlite', '/%2eenv', '/%5C..%5Csecret.txt']) {
    const response = await fetch(`${h.origin}${path}`); assert.equal(response.status, 403, path); assert.doesNotMatch(await response.text(), /must-not-expose|outside-root/);
  }
});

test('same-origin app: Pages base, redirect and safe HTML fallback preserve path/query', async t => {
  const h = await fixture(t, '/better-life/');
  const redirect = await fetch(`${h.origin}/better-life?view=guides`, { redirect: 'manual' });
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), '/better-life/?view=guides');
  assert.equal((await fetch(`${h.origin}/better-life/`)).status, 200);
  assert.equal((await fetch(`${h.origin}/`)).status, 404);
  assert.equal((await fetch(`${h.origin}/better-life/unknown`, { headers: { accept: 'text/html' } })).status, 200);
  assert.equal((await fetch(`${h.origin}/better-life/missing.js`, { headers: { accept: 'text/html' } })).status, 404);
  assert.equal((await fetch(`${h.origin}/better-life/`, { method: 'POST' })).status, 405);
  assert.deepEqual(await (await fetch(`${h.origin}/better-life/api/me`)).json(), { healthy: true });
});

test('same-origin app: symlinks outside static root are rejected', async t => {
  const h = await fixture(t);
  // Directory junctions need no administrator privilege on Windows.
  symlinkSync(h.dir, join(h.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const response = await fetch(`${h.origin}/outside/secret.txt`);
  assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /outside-root/);
});
