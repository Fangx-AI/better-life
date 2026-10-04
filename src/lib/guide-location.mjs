import { readGuideFilters, guideFilterParams } from './guide-filters.mjs';

// Resolve external links and browser history from one source of truth.
export function readGuideLocation(location, corpus) {
  const filters = readGuideFilters(location.search);
  if (corpus && filters.chapter && !corpus.chapters.some(c => String(c.id) === filters.chapter)) filters.chapter = '';
  const match = /^#entry-(\d+-\d+)$/.exec(location.hash || '');
  const entry = match && corpus ? corpus.chapters.flatMap(c => c.entries).find(e => e.id === match[1]) || null : null;
  if (entry) Object.assign(filters, { q: '', chapter: String(entry.chapter), free: false, saved: false });
  const params = new URLSearchParams(location.search);
  const browsing = params.get('view') === 'library' || ['q', 'chapter', 'free', 'saved', 'grade'].some(key => params.has(key)) || location.hash === '#library' || !!match;
  return { filters, browsing, entry, missingEntry: !!(match && corpus && !entry) };
}

// Query-based pages work both at / and GitHub Pages' /better-life/, without
// requiring server rewrites. Legacy chapter/hash links remain readable above.
export function guideLocationHref(pathname, filters = {}, hash = '') {
  const params = new URLSearchParams({ view: 'library' });
  for (const [key, value] of guideFilterParams(filters)) params.set(key, value);
  return `${pathname}?${params}${hash}`;
}

export function entryLocationHref(pathname, entry) {
  return guideLocationHref(pathname, { chapter: String(entry.chapter) }, `#entry-${entry.id}`);
}

export function readAppView(location) {
  const view = new URLSearchParams(location.search).get('view');
  // Private guide/checkout URLs can also contain old hashes or query filters.
  // Never redirect these away from their intended account-owned page.
  if (view === 'pricing' || view === 'guides') return view;
  return readGuideLocation(location).browsing ? 'library' : 'home';
}
