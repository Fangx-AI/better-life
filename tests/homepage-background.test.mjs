import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('首页装饰背景按图片边缘渐隐，保持原比例与手机裁切，不拉伸正文', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const component = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const rule = css.match(/\.landing-background\{--landing-art-width:1440px;[^}]*\}/)?.[0];
  assert.ok(rule);
  assert.match(rule, /mask-image:linear-gradient\(to right,transparent,[^)]*,transparent\)/);
  assert.match(rule, /mask-size:var\(--landing-art-width\) 100%;mask-position:top center;mask-repeat:no-repeat/);
  assert.match(rule, /pointer-events:none/);
  for (const [width, height] of [[1440, 1100], [1600, 1222], [1300, 993], [850, 650]]) {
    const pattern = new RegExp('\\.landing-background\\{--landing-art-width:' + width + 'px;[^}]*background-size:var\\(--landing-art-width\\) ' + height + 'px');
    assert.match(css, pattern);
    assert.ok(Math.abs(width / height - 1435 / 1096) < .005);
  }
  assert.match(css, /@media\(max-width:767px\)\{\.landing-background\{background-position:center 50px\}\}/);
  assert.match(css, /\.page-width\{width:calc\(100% - 160px\);max-width:1280px/);
  assert.match(component, /className="landing-background" aria-hidden="true"/);
});
