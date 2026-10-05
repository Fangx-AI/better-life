// Explicit capability boundary for GitHub Pages. The independent same-origin
// service build remains the default; hostname guesses never enable services.
export function isPublicOnlyBuild(env = import.meta.env) {
  return env?.VITE_PUBLIC_ONLY === 'true';
}
export const PUBLIC_ONLY = isPublicOnlyBuild();

export function assertServerFeatures(publicOnly = PUBLIC_ONLY) {
  if (!publicOnly) return;
  const error = new Error('登录、AI 提问与会员服务暂未开放。');
  error.status = 503; error.code = 'public_only'; throw error;
}

export function publicRouteBlocked(view, publicOnly = PUBLIC_ONLY) {
  return publicOnly && ['guides', 'operations'].includes(view);
}

export function publicAnalyticsEnabled(flag, publicOnly = PUBLIC_ONLY) {
  return !publicOnly && flag === 'true';
}
