import { cleanQaNotice } from '../../shared/qa-notice.mjs';
// Validate the API shape before rendering; display source metadata from our local book snapshot.
export function validateQaResponse(data, corpus) {
  const fail = () => { throw new Error('答案没有完整返回，请重试。'); };
  const string = (value, limit, required = false) => typeof value === 'string' && value.length <= limit && (!required || value.trim().length);
  if (!data || !['answered', 'insufficient'].includes(data.status) || !data.answer || !Array.isArray(data.sources) || data.sources.length > 6) fail();
  const answer = data.answer;
  if (!string(answer.intro, 2000, true) || !string(answer.caveat, 2000) || !Array.isArray(answer.steps) || answer.steps.length > 6) fail();
  if (data.status === 'answered' && !answer.steps.length || data.status === 'insufficient' && answer.steps.length) fail();
  const entries = new Map(corpus.chapters.flatMap(chapter => chapter.entries.map(entry => [entry.id, { ...entry, chapterTitle: chapter.title, chapterFile: chapter.file }])));
  const sources = data.sources.map(source => { if (!source || !entries.has(source.id)) fail(); return entries.get(source.id); });
  const ids = new Set(sources.map(source => source.id));
  if (ids.size !== sources.length || data.status === 'insufficient' && sources.length) fail();
  for (const step of answer.steps) {
    if (!step || !string(step.title, 200, true) || !string(step.detail, 4000, true) || !Array.isArray(step.entryIds) || !step.entryIds.length || step.entryIds.length > 6 || step.entryIds.some(id => !ids.has(id))) fail();
  }
  return { status: data.status, answer: { ...answer, caveat: cleanQaNotice(answer.caveat) }, sources, snapshotDate: corpus.source.snapshotDate };
}
