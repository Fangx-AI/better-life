import { loadEnv } from 'vite';
import { createEmailSender, createSmsSender } from '../server/membership.mjs';

// 只输出配置键名与状态，不输出密钥、手机号、邮箱或Origin值；不产生发送费用。
export function authStatus(env) {
  const filled = key => typeof env[key] === 'string' && Boolean(env[key].trim());
  const emailProvider = env.MEMBERSHIP_EMAIL_PROVIDER || 'resend', smsProvider = env.MEMBERSHIP_SMS_PROVIDER || 'tencent';
  const emailKeys = emailProvider === 'aliyun' ? ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_EMAIL_ACCOUNT_NAME'] : ['RESEND_API_KEY', 'MEMBERSHIP_EMAIL_FROM'];
  const smsKeys = smsProvider === 'aliyun' ? ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN', 'ALIYUN_SMS_TEMPLATE_CODE'] : ['TENCENT_SMS_SECRET_ID', 'TENCENT_SMS_SECRET_KEY', 'TENCENT_SMS_APP_ID', 'TENCENT_SMS_SIGN_NAME', 'TENCENT_SMS_TEMPLATE_ID'];
  const missingEmail = emailKeys.filter(key => !filled(key)), missingSms = smsKeys.filter(key => !filled(key));
  const secretReady = filled('MEMBERSHIP_AUTH_SECRET') && env.MEMBERSHIP_AUTH_SECRET.length >= 32;
  let originReady = false;
  try { const origin = new URL(env.MEMBERSHIP_APP_ORIGIN); originReady = origin.protocol === 'https:' && origin.origin === origin.href.replace(/\/$/, '') && !origin.username && !origin.password; } catch {}
  return {
    email: { provider: emailProvider, configured: typeof createEmailSender({ env }) === 'function', missing: missingEmail },
    phone: { provider: smsProvider, configured: typeof createSmsSender({ env }) === 'function', missing: missingSms,
      ...(missingSms.length === 0 && !createSmsSender({ env }) ? { problem: '短信参数格式不正确或通道名称无效，请按服务商控制台填写。' } : {}) },
    production: { secretReady, httpsOriginReady: originReady, explicitPersistentDb: filled('MEMBERSHIP_DB_PATH'),
      membershipMetering: env.MEMBERSHIP_ENFORCE === 'true', localDemoDisabled: env.MEMBERSHIP_LOCAL_DEMO !== 'true' },
    liveDeliveryVerified: false,
    note: '配置存在不代表送达。仍须用真实手机与邮箱完成收码、登录、刷新保持、绑定、换方式登录和退出验收；付款未配置商户适配器时不开放。',
  };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/auth-status.mjs')) {
  console.log(JSON.stringify(authStatus({ ...loadEnv('development', process.cwd(), ''), ...process.env }), null, 2));
}
