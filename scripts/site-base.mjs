export function publicBasePath(value = '/better-life/') {
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(value)) throw new Error('PUBLIC_BASE_PATH 必须是 / 或 /project-name/ 形式的绝对路径。');
  return value;
}
