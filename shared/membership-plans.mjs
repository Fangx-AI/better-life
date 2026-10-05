// 公共套餐定义；价格仍必须由服务端按 planId 读取，不能信任客户端金额。
export const MEMBERSHIP_PLANS = Object.freeze([
  Object.freeze({ id: 'free', name: '免费使用', amountFen: 0, currency: 'CNY', durationDays: null, quotaPerPeriod: 10, periodDays: 30, guideLimit: 5 }),
  Object.freeze({ id: 'member-month', name: '月度会员', amountFen: 1900, currency: 'CNY', durationDays: 30, quotaPerPeriod: 200, periodDays: 30, guideLimit: 100 }),
  Object.freeze({ id: 'member-year', name: '年度会员', amountFen: 12900, currency: 'CNY', durationDays: 365, quotaPerPeriod: 200, periodDays: 30, guideLimit: 100 }),
]);
export const membershipPlan = id => MEMBERSHIP_PLANS.find(plan => plan.id === id);
