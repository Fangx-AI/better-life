import { membershipRequest, membershipApiUrl } from './membership-api.mjs';

// Ignore UI completions from an account that has since logged out or switched.
export function isCurrentGuideOwner(currentOwner, requestOwner, signal) {
  return typeof requestOwner === 'string' && requestOwner.length > 0 && currentOwner === requestOwner && !signal?.aborted;
}

export function validateGuide(guide) {
  if (!guide || typeof guide.id !== 'string' || typeof guide.title !== 'string' || typeof guide.topic !== 'string' || typeof guide.content !== 'string' || !Array.isArray(guide.tasks) || !Array.isArray(guide.sourceIds) || !Array.isArray(guide.factIds) || !Number.isInteger(guide.revision)) throw new Error('这篇指南暂时无法读取，请刷新后重试。');
  return guide;
}

export async function loadGuides(options) {
  const data = await membershipRequest('guides', options);
  if (!Array.isArray(data.guides) || !Number.isInteger(data.limit)) throw new Error('个人目录暂时无法读取，请稍后重试。');
  return { ...data, guides: data.guides.map(validateGuide) };
}

export async function savePersonalGuide(id, values) {
  const data = await membershipRequest(id ? `guides/${encodeURIComponent(id)}` : 'guides', { method: id ? 'PATCH' : 'POST', body: values });
  return validateGuide(data.guide);
}

export async function exportPersonalGuide(id) {
  const response = await fetch(membershipApiUrl(`guides/${encodeURIComponent(id)}/export`), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/markdown' } });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message || '导出失败，请稍后重试。');
  }
  if (!response.headers.get('content-type')?.includes('text/markdown')) throw new Error('当前服务没有返回可用的 Markdown 文件。');
  return response.blob();
}
