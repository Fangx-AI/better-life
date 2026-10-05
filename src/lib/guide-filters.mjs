import { matchesEntry } from '../../assets/search.mjs';

// Public filters describe user needs. Original editorial grades stay in the book data only.
export function readGuideFilters(search) {
  const params = new URLSearchParams(search);
  return { q: (params.get('q') || '').slice(0, 120), chapter: params.get('chapter') || '', free: params.get('free') === '1', saved: params.get('saved') === '1' };
}

export function guideFilterParams(filters) {
  const params = new URLSearchParams();
  for (const key of ['q', 'chapter']) if (filters[key]) params.set(key, filters[key]);
  for (const key of ['free', 'saved']) if (filters[key]) params.set(key, '1');
  return params;
}

export function matchesGuideEntry(entry, filters, saved) {
  // Explicitly pick fields: stale HMR state or old shared links must not invisibly filter grades.
  return matchesEntry(entry, { q: filters.q || '', chapter: filters.chapter || '', free: !!filters.free, saved: !!filters.saved }, saved);
}
