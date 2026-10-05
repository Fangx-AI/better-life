import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './content.mjs';
import { validateQaResponse } from '../src/lib/qa-response.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = loadCorpus(root);
const endpoint = process.env.QA_CHECK_URL || 'http://127.0.0.1:4175/api/ask';
const cases = ['准备离职，哪些材料要先留下？', '第一次租房，签合同前需要检查什么？', '如何设置不容易被盗的密码？', '火星上的外星人如何申请宇宙通行证？'];
const report = { checkedAt: new Date().toISOString(), endpoint, model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', results: [] };
for (const question of cases) {
  const started = Date.now();
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }), signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (!response.ok) {
      report.results.push({ question, httpStatus: response.status, elapsedMs: Date.now() - started, passed: false, error: data.error?.code });
    } else {
      const verified = validateQaResponse(data, corpus);
      const expected = question.startsWith('火星') ? 'insufficient' : 'answered';
      report.results.push({ question, httpStatus: response.status, elapsedMs: Date.now() - started, passed: verified.status === expected, status: verified.status, sources: verified.sources.map(e => ({ id: e.id, title: e.title })), answer: verified.answer });
    }
  } catch (error) {
    report.results.push({ question, passed: false, elapsedMs: Date.now() - started, error: error.name });
  }
  console.log(JSON.stringify({ question, ...report.results.at(-1), answer: undefined }));
}
report.passed = report.results.every(row => row.passed);
mkdirSync(resolve(root, 'output'), { recursive: true });
writeFileSync(resolve(root, 'output/qa-live-check.json'), JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
