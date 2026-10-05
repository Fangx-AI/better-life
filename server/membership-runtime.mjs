import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, writeFileSync, readFileSync, closeSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createQaHandler } from './qa.mjs';
import { createPersonalQaHandler } from './personal-qa.mjs';
import { createMembershipStore } from './membership-store.mjs';
import { createMembershipHandler, createEmailSender, createSmsSender } from './membership.mjs';
import { assertProductionConfig, assertProductionStorage } from './production-config.mjs';
import { createHupijiaoPaymentProvider } from './payment-hupijiao.mjs';
import { createOperationsStore, createOperationsHandler, assertOperationsConfig } from './operations.mjs';
import { createUsageBudget } from './usage-budget.mjs';
import { createAnalyticsStore, createAnalyticsHandler } from './analytics.mjs';
import { createPaymentAnalytics } from './analytics-payments.mjs';

// 仅明确开启的非生产本机体验可自动生成密钥；不得写 env、响应或日志。
export function prepareLocalDemoEnv(env = {}, { keyPath = fileURLToPath(new URL('../output/private/local-demo.key', import.meta.url)) } = {}) {
  if (env.MEMBERSHIP_LOCAL_DEMO !== 'true' || env.NODE_ENV === 'production' || (typeof env.MEMBERSHIP_AUTH_SECRET === 'string' && env.MEMBERSHIP_AUTH_SECRET.trim())) return env;
  mkdirSync(dirname(keyPath), { recursive: true });
  let fd;
  try {
    fd = openSync(keyPath, 'wx', 0o600);
    writeFileSync(fd, randomBytes(48).toString('base64url'), { encoding: 'utf8' });
  } catch (error) { if (error.code !== 'EEXIST') throw new Error('本机体验密钥无法准备，请检查私人数据目录权限。'); }
  finally { if (fd !== undefined) closeSync(fd); }
  if (!lstatSync(keyPath).isFile()) throw new Error('本机体验密钥文件不可用。');
  const secret = readFileSync(keyPath, 'utf8').trim();
  if (!/^[a-zA-Z0-9_-]{64}$/.test(secret)) throw new Error('本机体验密钥格式无效，请保留旧文件并检查配置。');
  return { ...env, MEMBERSHIP_AUTH_SECRET: secret };
}

// 本地 Vite / 单实例 Node 共用；没有支付 adapter 的情况下始终禁止 checkout。
export function createApiRuntime({ env = {}, getCorpus } = {}) {
  if (env.NODE_ENV && !['production', 'development', 'test'].includes(env.NODE_ENV)) throw new Error('运行环境配置无效，服务未启动。');
  assertProductionConfig(env);
  assertProductionStorage(env);
  assertOperationsConfig(env);
  env = prepareLocalDemoEnv(env);
  const sender = createEmailSender({ env }), phoneSender = createSmsSender({ env });
  if (env.NODE_ENV === 'production' && (!sender || !phoneSender)) throw new Error('生产登录发送通道未配置完整，服务未启动。请检查 provider 及对应服务端配置。');
  const paymentProvider = createHupijiaoPaymentProvider({ env });
  if (env.NODE_ENV === 'production' && env.MEMBERSHIP_PAYMENT_CREATE_ENABLED === 'true' && !paymentProvider) throw new Error('生产付款配置未完成，服务未启动。');
  const getClientId = request => request.headers.get('x-better-life-client-ip') || 'shared';
  const store = createMembershipStore({ filename: env.MEMBERSHIP_DB_PATH || fileURLToPath(new URL('../output/private/membership.sqlite', import.meta.url)) });
  if (paymentProvider) {
    try { store.assertPaymentMerchant(paymentProvider.merchantId); }
    catch (error) { store.close(); throw error; }
  }
  let usageBudget, operationsStore, analyticsStore, onPaymentConfirmed;
  try {
    usageBudget = createUsageBudget({ db: store.db, env });
    operationsStore = createOperationsStore({ membershipStore: store });
    analyticsStore = createAnalyticsStore({ db: store.db });
    onPaymentConfirmed = createPaymentAnalytics({ db: store.db, store: analyticsStore, enabled: env.ANALYTICS_ENABLED === 'true' });
  } catch (error) { store.close(); throw error; }
  const analytics = createAnalyticsHandler({ store: analyticsStore, enabled: env.ANALYTICS_ENABLED === 'true', allowedOrigin: env.MEMBERSHIP_APP_ORIGIN });
  // A bounded, durable scan repairs optional analytics without changing financial facts.
  // Failure must never prevent startup, a health response, or a verified payment ACK.
  const reconcilePayments = () => { try { onPaymentConfirmed.reconcile(); } catch {} };
  reconcilePayments();
  const operations = createOperationsHandler({ env, store: operationsStore, getClientId, getUsageBudgetSnapshot: () => usageBudget.snapshot(), getAnalyticsReport: env.ANALYTICS_ENABLED === 'true' ? options => { reconcilePayments(); return analyticsStore.report(options); } : undefined });
  const qaHandler = createQaHandler({ env, getCorpus, getClientId, usageBudget });
  const personalQaHandler = createPersonalQaHandler({ env, getCorpus, getClientId, usageBudget });
  const membership = createMembershipHandler({ env, store, sender, phoneSender, paymentProvider, qaHandler, personalQaHandler, getCorpus, getClientId, operationsStore, onPaymentConfirmed });
  const handler = async request => {
    if (new URL(request.url).pathname === '/api/health') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { 'cache-control': 'no-store' } });
      try {
        store.db.prepare('SELECT 1').get();
        reconcilePayments();
        return Response.json({ status: 'ready', application: 'better-life', metering: env.MEMBERSHIP_ENFORCE === 'true', localDemo: env.MEMBERSHIP_LOCAL_DEMO === 'true',
          login: { emailConfigured: Boolean(sender), phoneConfigured: Boolean(phoneSender) }, payments: { creationEnabled: Boolean(paymentProvider?.creationEnabled) } }, { headers: { 'cache-control': 'no-store' } });
      } catch { return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
    }
    if (new URL(request.url).pathname.startsWith('/api/operations/')) return operations(request);
    const eventResponse = await analytics(request);
    if (eventResponse) return eventResponse;
    return membership(request);
  };
  return { handler, close: () => store.close() };
}
