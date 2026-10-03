import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBasePath } from '../scripts/site-base.mjs';
test('Pages 默认子路径与 Sites 根域构建均有明确合法的资源前缀', () => {
  assert.equal(publicBasePath(), '/better-life/');
  assert.equal(publicBasePath('/'), '/');
  assert.equal(publicBasePath('/preview/project-1/'), '/preview/project-1/');
  for (const value of ['https://external.test/', '//host/', '../', '/../../', '/project', '/project?x=1/', null]) assert.throws(() => publicBasePath(value));
});
