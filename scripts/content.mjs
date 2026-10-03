import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// 复用原书的条目格式；只转换表示形式，不改写正文和证据。
export function parseChapter(text, file) {
  const lines = text.split(/\r?\n/);
  const heading = lines.map(line => /^# (\d+)\. (.+)$/.exec(line)).find(Boolean);
  if (!heading) throw new Error(`缺少章节标题：${file}`);
  const chapter = { id: Number(heading[1]), title: heading[2], file, entries: [] };
  let entry;
  const fields = { '成本': 'cost', '说人话': 'summary', '收益': 'benefit', '证据等级': 'grade', '来源': 'sources', '备注': 'notes' };
  for (const line of lines) {
    const title = /^### (\d+)\. (.+)$/.exec(line);
    if (title) {
      entry = { id: `${chapter.id}-${title[1]}`, number: Number(title[1]), chapter: chapter.id, title: title[2], tags: {} };
      chapter.entries.push(entry);
    } else if (entry) {
      const tags = /^<!--\s*成本标签:\s*(.*?)\s*-->/.exec(line);
      if (tags) entry.tags = Object.fromEntries(tags[1].split(/\s+/).map(kv => kv.split('=')));
      const field = /^- (成本|说人话|收益|证据等级|来源|备注)：\s*(.*)$/.exec(line);
      if (field) {
        entry[fields[field[1]]] = field[2];
        if (field[1] === '证据等级') { entry.gradeText = field[2]; entry.grade = /^([ABC])/.exec(field[2])?.[1]; }
      }
    }
  }
  for (const e of chapter.entries) {
    for (const key of ['cost', 'summary', 'benefit', 'grade', 'sources']) {
      if (!e[key]) throw new Error(`${file} 条目 ${e.number} 缺少 ${key}`);
    }
    if (!/^[ABC]$/.test(e.grade)) throw new Error(`证据等级不正确：${e.id}`);
  }
  return chapter;
}

export function loadCorpus(root) {
  const chapters = readdirSync(resolve(root, 'library/book')).filter(f => /^\d\d-.*\.md$/.test(f)).sort()
    .map(file => parseChapter(readFileSync(resolve(root, 'library/book', file), 'utf8'), file));
  const entries = chapters.flatMap(c => c.entries);
  if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('条目 ID 重复');
  const source = JSON.parse(readFileSync(resolve(root, 'library/source.json'), 'utf8').replace(/^\uFEFF/, ''));
  return { source, counts: { chapters: chapters.length, entries: entries.length }, chapters };
}
