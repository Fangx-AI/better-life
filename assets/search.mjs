export function plainText(value = '') {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|`/g, '');
}
export function matchesEntry(entry, state, saved) {
  if (state.chapter && entry.chapter !== Number(state.chapter)) return false;
  if (state.grade && entry.grade !== state.grade) return false;
  if (state.free && entry.tags['钱'] !== '0') return false;
  if (state.saved && !saved.has(entry.id)) return false;
  const hay = [entry.title, entry.summary, entry.cost, entry.benefit, entry.notes, entry.sources].join(' ').toLowerCase();
  return state.q.trim().toLowerCase().split(/\s+/).filter(Boolean).every(word => hay.includes(word));
}
