import { mkdirSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const corpus = loadCorpus(root);
mkdirSync(resolve(out, 'assets'), { recursive: true });
for (const file of ['index.html', 'robots.txt', 'sitemap.xml']) copyFileSync(resolve(root, file), resolve(out, file));
cpSync(resolve(root, 'assets'), resolve(out, 'assets'), { recursive: true });
writeFileSync(resolve(out, 'assets/content.json'), JSON.stringify(corpus));
writeFileSync(resolve(out, '.nojekyll'), '');
console.log(`构建完成：${corpus.counts.chapters} 个章节，${corpus.counts.entries} 条建议。`);
