const SCALE = 1_000_000;
export const USAGE_BUDGET_FIELDS = ['QA_BUDGET_DAILY_CNY', 'QA_BUDGET_MONTHLY_CNY', 'QA_PRICE_INPUT_CNY_PER_MILLION', 'QA_PRICE_OUTPUT_CNY_PER_MILLION'];
export class UsageBudgetError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const usageBudgetConfigurationError = () => new UsageBudgetError(503, 'budget_configuration', '问答成本预算配置未完成，服务未启动。');
function money(value) {
  // Pure config parsing: no provider price defaults and no values in diagnostics.
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value)) throw usageBudgetConfigurationError();
  const [whole, decimal = ''] = value.split('.');
  const result = Number(BigInt(whole) * BigInt(SCALE) + BigInt(decimal.padEnd(6, '0')));
  if (!Number.isSafeInteger(result) || result <= 0) throw usageBudgetConfigurationError();
  return result;
}
export function usageBudgetConfig(env = {}) {
  const present = USAGE_BUDGET_FIELDS.map(field => typeof env[field] === 'string' && Boolean(env[field].trim()));
  if (!present.some(Boolean)) return { configured: false, currency: 'CNY', timezone: 'Asia/Shanghai' };
  if (!present.every(Boolean)) throw usageBudgetConfigurationError();
  const [dailyLimit, monthlyLimit, inputRate, outputRate] = USAGE_BUDGET_FIELDS.map(field => money(env[field]));
  if (dailyLimit > monthlyLimit) throw usageBudgetConfigurationError();
  return { configured: true, currency: 'CNY', timezone: 'Asia/Shanghai', dailyLimit, monthlyLimit, inputRate, outputRate };
}
