import { fileURLToPath } from 'node:url';
import { loadCorpus } from './content.mjs';
import { retrieveEntries } from '../server/retrieval.mjs';
import { retrieveEntries as baseline } from '../tests/fixtures/retrieval-baseline.mjs';
import { retrievalCases, unsupportedCases } from '../tests/fixtures/retrieval-cases.mjs';

export function evaluateRetrieval(retrieve, corpus) {
  let relevantCount = 0;
  let returnedCount = 0;
  let hits = 0;
  let top1 = 0;
  const results = retrievalCases.map(item => {
    const ids = retrieve(corpus, item.question).map(entry => entry.id);
    const relevant = ids.filter(id => item.relevant.includes(id)).length;
    const hit = item.anchors.some(id => ids.includes(id)) && (!item.allAnchors || item.allAnchors.every(id => ids.includes(id)));
    relevantCount += relevant;
    returnedCount += ids.length;
    hits += Number(hit);
    top1 += Number(item.relevant.includes(ids[0]));
    return { id: item.id, ids, irrelevant: ids.filter(id => !item.relevant.includes(id)), hit, precision: ids.length ? relevant / ids.length : 0 };
  });
  const unsupported = unsupportedCases.map(question => ({ question, ids: retrieve(corpus, question).map(entry => entry.id) }));
  return { metrics: { cases: results.length, hitAt6: hits / results.length, relevantTop1: top1 / results.length, precisionOfReturned: relevantCount / (returnedCount || 1), relevantCount, returnedCount, unsupportedCases: unsupported.length, unsupportedEmpty: unsupported.filter(item => !item.ids.length).length }, results, unsupported };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const corpus = loadCorpus(fileURLToPath(new URL('..', import.meta.url)));
  const previous = evaluateRetrieval(baseline, corpus);
  const current = evaluateRetrieval(retrieveEntries, corpus);
  console.log(JSON.stringify({ baseline: previous.metrics, current: current.metrics, currentProblems: current.results.filter(item => !item.hit || item.irrelevant.length), unsupportedProblems: current.unsupported.filter(item => item.ids.length), ...(process.argv.includes('--details') ? { details: current.results } : {}) }, null, 2));
}
