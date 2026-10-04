import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './content.mjs';
import { writeSeoArtifacts } from './seo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public');
writeSeoArtifacts(root, process.env);
const corpus = loadCorpus(root);
mkdirSync(resolve(out, 'assets'), { recursive: true });
writeFileSync(resolve(out, 'content.json'), JSON.stringify(corpus));
writeFileSync(resolve(out, '.nojekyll'), '');
console.log(`构建完成：${corpus.counts.chapters} 个章节，${corpus.counts.entries} 条建议。`);
await import('./obsidian.mjs');
