// Explicit, limited real-model acceptance; never sends OTPs or creates payment orders.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './content.mjs';
import { createQaHandler } from '../server/qa.mjs';
import { buildQaPayload } from '../shared/qa-history.mjs';
import { validateQaResponse } from '../src/lib/qa-response.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = loadCorpus(root);
if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('请先在服务端配置 DEEPSEEK_API_KEY。');
const handle = createQaHandler({ getCorpus: () => corpus, env: process.env });
const report = { checkedAt: new Date().toISOString(), mode: 'real-model-direct-handler', results: [] };
const turns = [];
const cases = [
  { question: '月薪6000元，想开始存钱，不想再乱花钱，怎么做？', chapters: [4, 5], remember: true },
  { question: '第二步可以给我一个每天能照做的版本吗？', chapters: [4, 5], followup: true },
  { question: '工作压力大，经常下班了还停不下来，怎么调整？', chapters: [3, 19, 22] },
  { question: '火星上的外星人如何申请宇宙通行证？', insufficient: true },
];
for (const sample of cases) {
  const started = Date.now();
  try {
    const payload = buildQaPayload(sample.question, sample.followup ? turns : []);
    const response = await handle(new Request('https://acceptance.better-life.invalid/api/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.code || `http_${response.status}`);
    const result = validateQaResponse(data, corpus);
    const expected = sample.insufficient ? 'insufficient' : 'answered';
    const relevant = sample.insufficient ? result.sources.length === 0 : result.sources.some(source => sample.chapters.includes(source.chapter));
    const row = { question: sample.question, httpStatus: response.status, elapsedMs: Date.now() - started,
      status: result.status, historyTurns: payload.history.length, passed: result.status === expected && relevant,
      sourceIds: result.sources.map(source => source.id), answer: result.answer };
    report.results.push(row);
    if (sample.remember && row.passed) turns.push({ question: sample.question, result });
    console.log(JSON.stringify({ ...row, answer: undefined }));
  } catch (error) {
    const row = { question: sample.question, elapsedMs: Date.now() - started, passed: false, error: error.message };
    report.results.push(row); console.log(JSON.stringify(row));
  }
}
report.passed = report.results.every(row => row.passed) && report.results[1].historyTurns === 1;
mkdirSync(resolve(root, 'output'), { recursive: true });
writeFileSync(resolve(root, 'output/qa-conversation-live-check.json'), JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
