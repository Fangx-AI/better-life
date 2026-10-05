// 对话仅由当前页面带回，不落本地存储或共享服务端会话；历史也是不可信资料。
export const MAX_HISTORY_TURNS = 4;
export const MAX_HISTORY_BYTES = 6000;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, max) => typeof value === 'string' && value.trim() && [...value].length <= max;

export class QaHistoryError extends Error {
  constructor() { super('对话记录暂时无法使用，请开始新对话后重试。'); this.name = 'QaHistoryError'; }
}

export function validateQaHistory(value, corpus) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_HISTORY_TURNS || bytes(value) > MAX_HISTORY_BYTES) throw new QaHistoryError();
  const available = corpus ? new Set(corpus.chapters.flatMap(chapter => chapter.entries.map(entry => entry.id))) : null;
  return value.map(turn => {
    if (!isObject(turn) || Object.keys(turn).some(key => !['question', 'summary', 'sourceIds'].includes(key))
      || !bounded(turn.question, 500) || !bounded(turn.summary, 1200) || !Array.isArray(turn.sourceIds)
      || turn.sourceIds.length > 6 || new Set(turn.sourceIds).size !== turn.sourceIds.length
      || turn.sourceIds.some(id => typeof id !== 'string' || !/^\d{1,2}-\d{1,3}$/.test(id) || (available && !available.has(id)))) throw new QaHistoryError();
    return { question: turn.question.trim(), summary: turn.summary.trim(), sourceIds: [...turn.sourceIds] };
  });
}

// 每个步骤都留一小段，避免只保留开头而无法承接“第二步”。重新回答仍须看完整原书。
function excerpt(value, limit) {
  const chars = [...String(value || '').trim()];
  if (chars.length <= limit) return chars.join('');
  const prefix = chars.slice(0, limit - 1).join('');
  const end = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'));
  return end >= Math.floor(limit / 3) ? prefix.slice(0, end + 1) : `${prefix}…`;
}

function compactHistoryTurn(question, result, maxBytes = MAX_HISTORY_BYTES - 2) {
  if (!['answered', 'insufficient'].includes(result?.status) || !result.answer || !Array.isArray(result.sources)) throw new QaHistoryError();
  const turn = { question, summary: '上轮回答', sourceIds: [...new Set(result.sources.map(source => source.id))] };
  // 先核对问题与来源，不让一个合法但较长的 emoji 摘要在缩减前触发 6KB 错误。
  validateQaHistory([turn]);
  const sources = new Set(turn.sourceIds);
  const steps = Array.isArray(result.answer.steps) ? result.answer.steps.slice(0, 6) : [];
  const oneLine = value => String(value || '').replace(/[\r\n]+/g, ' ').trim();
  const references = steps.map(step => [...new Set((Array.isArray(step?.entryIds) ? step.entryIds : []).filter(id => sources.has(id)))]);
  let scale = 1;
  for (let attempt = 0; attempt < 24; attempt++) {
    // 每行单独缩减，不能整体截尾，否则第六步和该步引用标记会一起丢失。
    const pieces = [excerpt(oneLine(result.answer.intro), Math.max(12, Math.floor(120 * scale))), ...steps.map((step, index) => {
      const marker = references[index].length ? ` [原书:${references[index].join(',')}]` : '';
      return `${index + 1}. ${excerpt(oneLine(step?.title), Math.max(8, Math.floor(50 * scale)))}：${excerpt(oneLine(step?.detail), Math.max(8, Math.floor(64 * scale)))}${marker}`;
    })];
    turn.summary = pieces.filter(Boolean).join('\n') || '上轮回答';
    if ([...turn.summary].length <= 1200 && bytes(turn) <= maxBytes) return validateQaHistory([turn])[0];
    scale *= 0.8;
  }
  // 500 字合法问题和六组最多六个条目 ID 应总能容纳最小摘要；不静默接受坏输入。
  throw new QaHistoryError();
}

export function qaHistoryTurn(question, result) {
  const turn = compactHistoryTurn(question, result);
  return validateQaHistory([turn])[0];
}

export function buildQaPayload(question, turns = [], requestId) {
  if (!bounded(question, 500) || !Array.isArray(turns) || (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)))) throw new QaHistoryError();
  let history = turns.slice(-MAX_HISTORY_TURNS).map(turn => qaHistoryTurn(turn.question, turn.result));
  const payload = () => ({ question: question.trim(), requestId, history });
  while (history.length > 1 && (bytes(history) > MAX_HISTORY_BYTES || bytes(payload()) > 7900)) history.shift();
  if (history.length && (bytes(history) > MAX_HISTORY_BYTES || bytes(payload()) > 7900)) {
    const latest = turns.at(-1);
    const overhead = bytes({ question: question.trim(), requestId, history: [] });
    history = [compactHistoryTurn(latest.question, latest.result, Math.min(MAX_HISTORY_BYTES - 2, 7900 - overhead))];
  }
  validateQaHistory(history);
  return payload();
}

export function isFollowupQuestion(question) {
  const text = String(question).normalize('NFKC').trim();
  const explicit = /^(?:那(?:么|如果|要是|个|些|呢|我|他|她|这)?|然后|接着|继续|还有|下一步|第[一二三四五六1-6](?:个)?步)|刚才|上面|你(?:刚才)?说|上一(?:步|条|个)|这(?:一)?步|这个(?:步骤|做法|建议)|这些(?:步骤|建议)|具体(?:怎么|如何)|什么意思|再(?:详细|展开|说|解释|讲|举例)|还是(?:不|没)|如果.{0,20}(?:还是|仍然)/;
  if (explicit.test(text)) return true;
  // 不带主题名的日常追问；句子必须完整匹配，避免把“详细讲讲创业”当成旧话题。
  const clarification = /^(?:(?:能不能|可不可以|能|可以|请|再帮我|再|麻烦|给我)\s*)?(?:详细(?:一点|一些|点|说说|讲讲|说明|解释|讲解)?|展开(?:讲讲|说说|一下|说明|解释)?|具体(?:说说|讲讲|一点|点|一些|解释|说明|举例)|说(?:得|的)(?:更)?(?:具体|详细)(?:一点|点)?|讲(?:得|的)?(?:简单|明白|清楚)(?:一点|点)?|(?:举|给)(?:个|一个)?(?:具体)?例子|(?:具体)?怎么(?:操作|办理|执行|处理|做)|(?:要|需要)(?:准备|带)(?:哪些|什么)(?:材料|东西)|(?:需要|要)(?:多久|花多久|花多少钱)|流程(?:是什么|呢|怎么走)|更多(?:细节|例子|说明)|有没有(?:例子|具体步骤|(?:别的|其他)(?:办法|选择|做法))|为什么(?:要)?(?:这样|这么)(?:做|说|处理))(?:一下)?(?:吗|呢|吧|啊|好吗|可以吗)?[。？！?!.]*$/;
  return clarification.test(text);
}

// Only an explicit numbered-step follow-up is narrowed; a general "继续" keeps the topic.
// This is a pointer into untrusted history, not a new instruction or book evidence.
export function conversationStepFocus(question, history) {
  if (!history.length || !isFollowupQuestion(question)) return null;
  const match = String(question).normalize('NFKC').match(/第\s*([一二三四五六1-6])\s*(?:个)?步/);
  if (!match) return null;
  const number = Number(match[1]) || '一二三四五六'.indexOf(match[1]) + 1;
  const line = history.at(-1).summary.split('\n').find(value => value.startsWith(`${number}. `));
  if (!line) return null;
  const previousStepSummary = line.slice(`${number}. `.length);
  const marker = previousStepSummary.match(/\s*\[原书:([^\]]*)\]\s*$/);
  const allowed = new Set(history.at(-1).sourceIds);
  const ids = marker ? marker[1].split(',') : [];
  // 标记只是一份资料中的定位指针；只允许该轮响应已验证的来源子集。
  const valid = ids.length > 0 && ids.length <= 6 && new Set(ids).size === ids.length && ids.every(id => /^\d{1,2}-\d{1,3}$/.test(id) && allowed.has(id));
  return { number, previousStepSummary: marker ? previousStepSummary.slice(0, marker.index).trim() : previousStepSummary, sourceIds: valid ? ids : [] };
}

export function conversationRetrievalQuestion(question, history) {
  if (!history.length || !isFollowupQuestion(question)) return question;
  const questions = [];
  for (let index = history.length - 1; index >= 0; index--) {
    questions.unshift(history[index].question);
    if (!isFollowupQuestion(history[index].question)) break;
  }
  return [...questions, question].join(' ');
}
