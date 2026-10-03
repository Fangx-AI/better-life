import { readerText } from './reader-text.mjs';
import { cleanQaNotice } from '../../shared/qa-notice.mjs';

const topics = { 5: '省钱', 7: '工作', 19: '工作', 15: '住房', 1: '健康', 2: '健康', 3: '精力', 4: '时间', 10: '关系', 27: '家庭', 17: '家庭', 14: '安全' };
export function answerGuide(question, result, id = () => crypto.randomUUID()) {
  if (result?.status !== 'answered' || !result.answer?.steps?.length || !result.sources?.length) throw new Error('需要有原文依据的回答才能整理成指南。');
  const notice = cleanQaNotice(result.answer.caveat);
  return {
    title: question.trim().slice(0, 120), topic: topics[result.sources[0].chapter] || '生活',
    content: [readerText(result.answer.intro), '', '## 接下来怎么做', ...result.answer.steps.flatMap((step, index) => [`### ${index + 1}. ${readerText(step.title)}`, readerText(step.detail), '']), ...(notice ? ['## 需要注意', readerText(notice)] : [])].join('\n'),
    sourceIds: [...new Set(result.sources.map(source => source.id))], snapshotDate: result.snapshotDate,
    factIds: [], tasks: result.answer.steps.map(step => ({ id: id(), title: readerText(step.title), done: false })),
  };
}
