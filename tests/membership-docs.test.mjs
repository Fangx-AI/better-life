import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEMBERSHIP_PLANS } from '../shared/membership-plans.mjs';
import { createMembershipStore } from '../server/membership-store.mjs';
import { createMembershipHandler } from '../server/membership.mjs';
import { createHupijiaoPaymentProvider } from '../server/payment-hupijiao.mjs';

// 只核对仓库公开源码/文档和内存数据库；不读取env、真实数据库或私钥。
const doc = readFileSync(new URL('../docs/MEMBERSHIP-SERVICE.md', import.meta.url), 'utf8');

test('membership docs: published preview contract matches unconfigured runtime without fake login or payment', async t => {
  const store = createMembershipStore(); t.after(() => store.close());
  const handler = createMembershipHandler({ store, env: {}, sender: null });
  const catalog = await (await handler(new Request('http://127.0.0.1:4190/api/membership'))).json();
  for (const field of ['enforced', 'loginAvailable', 'emailLoginAvailable', 'phoneLoginAvailable', 'localDemoAvailable', 'checkoutAvailable', 'annualAvailable', 'plans']) {
    assert.ok(Object.hasOwn(catalog, field)); assert.ok(doc.includes(field));
  }
  assert.equal(catalog.enforced, false); assert.equal(catalog.loginAvailable, false); assert.equal(catalog.checkoutAvailable, false); assert.equal(catalog.localDemoAvailable, false);
  assert.match(doc, /未开通真实收款/); assert.match(doc, /没有一个环境开关能直接开启真实收款/);
  for (const plan of MEMBERSHIP_PLANS) {
    assert.ok(catalog.plans.some(value => value.id === plan.id && value.guideLimit === plan.guideLimit && value.quotaPerPeriod === plan.quotaPerPeriod));
  }
  assert.match(doc, /¥19 \/ 30 天/); assert.match(doc, /¥129 \/ 365 天/); assert.match(doc, /免费登录：5 份私人指南/);
});

test('membership docs: local startup and cookie identity specify explicit development loopback only', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts.dev, /vite/); assert.match(packageJson.scripts.preview, /vite preview/);
  assert.match(doc, /\$env:NODE_ENV = 'development'/); assert.match(doc, /\$env:MEMBERSHIP_LOCAL_DEMO = 'true'/);
  assert.match(doc, /\$env:MEMBERSHIP_APP_ORIGIN = 'http:\/\/127\.0\.0\.1:4190'/);
  assert.match(doc, /npm run dev -- --host 127\.0\.0\.1 --port 4190 --strictPort/);
  for (const text of ["authentication='local-demo'", 'user.email=null', '本机体验账号', '不是邮箱账号', '不能挂在公网或反向代理后']) assert.ok(doc.includes(text));
});

test('membership docs: implemented adapter/backup and remaining production limitations are explicit', () => {
  const runtime = readFileSync(new URL('../server/membership-runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /output\/private\/membership\.sqlite/); assert.match(runtime, /output\/private\/local-demo\.key/);
  for (const text of ['不是数据库备份', '停止**所有**', 'WAL', '同一秘密', '不是 PostgreSQL 连接串', '既有指南仍能编辑', '会员到期是两回事', '退款撤权', '商户回调', '尚未实现', 'baseRevision', 'membership.expiresAt']) assert.ok(doc.includes(text), text);
  assert.match(runtime, /createHupijiaoPaymentProvider\(\{ env \}\)/);
  assert.equal(createHupijiaoPaymentProvider({ env: {} }), null, 'unconfigured runtime still closes real checkout');
  const configured = createHupijiaoPaymentProvider({ env: { MEMBERSHIP_PAYMENT_PROVIDER: 'hupijiao', MEMBERSHIP_HUPIJIAO_APPID: 'fixture-docs-merchant', MEMBERSHIP_HUPIJIAO_APPSECRET: 'fixture-docs-private-pay-secret', MEMBERSHIP_APP_ORIGIN: 'https://docs.fixture.test' } });
  assert.equal(configured.creationEnabled, false, 'merchant config alone never silently enables new orders');
  for (const text of ['生产至少 48', '阿里云配置已复用', '尚未实际收码', 'Online Backup API', 'db:restore-check', '不能复用 AUTH_SECRET', 'merchant_id', '网关关单', '历史价格和时长兑现', '时间倒序', '默认关闭']) assert.ok(doc.includes(text), text);
});
