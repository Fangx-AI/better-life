import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const init = main.match(/const root = [^\n]+\nif \(import\.meta\.hot\) [^\n]+/)[0];
const initialize = new Function('hot', 'createRoot', 'document', `${init.replaceAll('import.meta.hot', 'hot')}\nreturn root;`);

test('development HMR reuses its saved React root instead of creating a duplicate', () => {
  let creations = 0;
  const hot = { data: {} }, document = { getElementById: () => ({}) };
  const create = () => ({ number: ++creations });
  const first = initialize(hot, create, document);
  assert.equal(initialize(hot, create, document), first);
  assert.equal(creations, 1);
  assert.equal(hot.data.root, first);
});

test('production without HMR creates its root without a window-global cache', () => {
  let creations = 0;
  const result = initialize(undefined, () => ({ number: ++creations }), { getElementById: () => ({}) });
  assert.equal(result.number, 1);
  assert.equal(creations, 1);
  assert.doesNotMatch(init, /window\./);
});

test('checkout confirmation discloses minute/day/concurrency limits alongside total quota', () => {
  const account = readFileSync(new URL('../src/components/membership/account-dialog.jsx', import.meta.url), 'utf8');
  const rules = account.match(/className="member-checkout-rules">([^<]+)<\/p>/)[1];
  assert.match(rules, /每分钟最多 6 次/);
  assert.match(rules, /每天最多 30 次/);
  assert.match(rules, /同时生成 1 份回答/);
  assert.match(rules, /与套餐总次数共同生效/);
});
