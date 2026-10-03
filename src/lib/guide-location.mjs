import { readGuideFilters, guideFilterParams } from './guide-filters.mjs';

// Resolve external links and browser history from one source of truth.
export function readGuideLocation(location, corpus) {
  const filters = readGuideFilters(location.search);
  if (corpus && filters.chapter && !corpus.chapters.some(c => String(c.id) === filters.chapter)) filters.chapter = '';
  const match = /^#entry-(\d+-\d+)$/.exec(location.hash || '');
  const entry = match && corpus ? corpus.chapters.flatMap(c => c.entries).find(e => e.id === match[1]) || null : null;
  if (entry) Object.assign(filters, { q: '', chapter: String(entry.chapter), free: false, saved: false });
  const params = new URLSearchParams(location.search);
  const browsing = ['q', 'chapter', 'free', 'saved', 'grade'].some(key => params.has(key)) || location.hash === '#library' || !!match;
  return { filters, browsing, entry };
}

export function guideLocationHref(pathname, filters, hash = '#library') {
  const params = guideFilterParams(filters);
  return `${pathname}${params.size ? '?' + params : ''}${hash}`;
}

export function entryLocationHref(pathname, entry) {
  return guideLocationHref(pathname, { chapter: String(entry.chapter) }, `#entry-${entry.id}`);
}
