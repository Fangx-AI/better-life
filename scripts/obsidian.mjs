import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { loadCorpus } from './content.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = loadCorpus(project);
const pad = value => String(value).padStart(2, '0');
const safe = value => value.replace(/[<>:"/\\|?*\[\]#^]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 55);
const notePath = e => `条目/${pad(e.chapter)}-${pad(e.number)} ${safe(e.title)}`;
const chapterPath = c => `主题/${pad(c.id)} ${safe(c.title)}`;
const wiki = (path, label) => `[[${path}|${label.replace(/[|\[\]]/g, '')}]]`;
const scenes = [
  ['工作与离职', [19, 7, 8, 24]], ['租房与买房', [15, 5, 8]],
  ['省钱与防骗', [5, 9, 14, 26]], ['照顾父母', [17, 16, 24, 33]],
  ['怀孕与育儿', [27, 18, 34]], ['时间与精力', [2, 3, 22, 23]],
];
const entries = new Map(corpus.chapters.flatMap(c => c.entries).map(e => [e.id, e]));
const chapters = new Map(corpus.chapters.map(c => [c.id, c]));
const root = resolve(project, 'output/obsidian', `Better-Life-${corpus.source.snapshotDate}`);
const generated = new Map();
const save = (path, body) => { generated.set(path + '.md', body); mkdirSync(dirname(resolve(root, path + '.md')), { recursive: true }); writeFileSync(resolve(root, path + '.md'), body); };
const yaml = (data) => '---\n' + Object.entries(data).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n---\n\n';
const crossEdges = [];
for (const chapter of corpus.chapters) {
  const raw = readFileSync(resolve(project, 'library/book', chapter.file), 'utf8');
  // 每条节点保留原书条目块；不改写正文，新增的连接写在独立段落。
  const blocks = new Map([...raw.matchAll(/^### (\d+)\. [^\r\n]+\r?\n[\s\S]*?(?=^### \d+\. |$(?![\s\S]))/gm)].map(m => [Number(m[1]), m[0].trimEnd()]));
  for (const entry of chapter.entries) {
    const block = blocks.get(entry.number);
    if (!block || !block.includes(entry.sources)) throw Error(`原文块缺失：${entry.id}`);
    const related = new Set();
    const chapterRefs = new Set();
    for (const line of block.split(/\r?\n/)) {
      if (!/^- (成本|说人话|收益|备注|来源)：/.test(line)) continue;
      // 跨节引用不会与法条条号混淆。只转换明确指向，未确定的保留在原文中。
      for (const ref of line.matchAll(/第\s*(\d+)\s*节(?:\s*第\s*([\d、,\s]+?(?:(?:到|至)\s*第?\s*\d+)?)\s*条)?/g)) {
        const chapterId = Number(ref[1]);
        if (!chapters.has(chapterId)) continue;
        if (!ref[2]) { if (chapterId !== chapter.id) chapterRefs.add(chapterId); continue; }
        for (const part of ref[2].split(/[、,]/)) {
          const range = /^\s*(\d+)\s*(?:到|至)\s*第?\s*(\d+)\s*$/.exec(part);
          const nums = range ? Array.from({ length: Math.max(0, Math.min(31, Number(range[2]) - Number(range[1]) + 1)) }, (_, i) => Number(range[1]) + i) : [Number(part.trim())];
          for (const n of nums) if (entries.has(`${chapterId}-${n}`) && `${chapterId}-${n}` !== entry.id) related.add(`${chapterId}-${n}`);
        }
      }
      if (/^- (成本|说人话|收益|备注)：/.test(line)) {
        const sameChapter = line.replace(/第\s*\d+\s*节\s*第\s*[\d、,\s]+?(?:(?:到|至)\s*第?\s*\d+)?\s*条/g, '');
        for (const ref of sameChapter.matchAll(/(?:见|参见|参考|本节)\s*第\s*(\d+)\s*条/g)) {
          const id = `${chapter.id}-${Number(ref[1])}`;
          if (entries.has(id) && id !== entry.id) related.add(id);
        }
      }
    }
    const links = [...related].map(id => { const other = entries.get(id); crossEdges.push([entry.id, id]); return '- ' + wiki(notePath(other), `${other.chapter}-${other.number} ${other.title}`); });
    links.push(...[...chapterRefs].map(id => '- ' + wiki(chapterPath(chapters.get(id)), `第 ${id} 节：${chapters.get(id).title}`)));
    const original = `原书/book/${chapter.file.replace(/\.md$/, '')}`;
    // 相对 Markdown 文件链接转为原书路径；外部 URL 和原文数值不变。
    const displayed = block.replace(/\]\((\.\.?\/[^)]+)\)/g, (_all, path) => `](${relative(dirname(resolve(root, notePath(entry))), resolve(root, '原书/book', path)).replace(/\\/g, '/')})`);
    save(notePath(entry), yaml({ type: 'entry', entry_id: entry.id, chapter: chapter.id, evidence: entry.gradeText, snapshot: corpus.source.snapshotDate, tags: ['指南条目'], source: `${corpus.source.repository}/blob/${corpus.source.revision}/book/${encodeURIComponent(chapter.file)}` }) + `# ${entry.title}\n\n所属主题：${wiki(chapterPath(chapter), chapter.title)} · ${wiki(original, '完整章节原文')}\n\n## 原书条目\n\n${displayed}\n\n## 原书中的关联\n\n${links.length ? links.join('\n') : '本条没有解析到明确的条目引用。可从所属主题继续阅读。'}\n`);
  }
  save(chapterPath(chapter), yaml({ type: 'chapter', chapter: chapter.id, tags: ['指南主题'] }) + `# ${chapter.title}\n\n${wiki('00 开始使用', '回到首页')} · ${wiki(`原书/book/${chapter.file.replace(/\.md$/, '')}`, '完整章节原文')}\n\n${chapter.entries.map(e => '- ' + wiki(notePath(e), `${e.number}. ${e.title}`)).join('\n')}\n`);
}
for (const [name, ids] of scenes) save(`场景/${name}`, yaml({ type: 'scene', tags: ['生活场景'] }) + `# ${name}\n\n这是相关主题的导航，不代表所有条目都适合你的情况。\n\n${ids.map(id => '- ' + wiki(chapterPath(chapters.get(id)), chapters.get(id).title)).join('\n')}\n\n先打开最相关的主题，再查看条目的适用条件、成本和来源。\n`);
save('00 开始使用', `# 高性价比人生指南 · Better Life\n\n学校没教，生活会考。${corpus.counts.entries} 条建议，${corpus.counts.chapters} 个主题。\n\n## 先找与你有关的事\n\n${scenes.map(([name]) => '- ' + wiki(`场景/${name}`, name)).join('\n')}\n\n## 如何使用节点图\n\n1. 在 Obsidian 选择「打开文件夹作为仓库」，打开这个目录。\n2. 打开「关系图谱」（Windows：Ctrl+G；macOS：Cmd+G）。预设按主题、条目和场景分色。\n3. 点开一个条目，使用右上角菜单「打开局部关系图」，深度设为 2。\n4. 从原书引用跳到关联建议；反向链接由 Obsidian 自动显示。\n\n图中的连线表示导航或原书明确引用，不表示因果、收益大小或个性化推荐。避免只看图不读适用条件。\n\n${wiki('使用说明/图谱说明', '图谱连接规则')} · ${wiki('使用说明/来源与版本', '来源与版本')} · ${wiki('主题目录', '全部主题')} · ${wiki('我的笔记/我的行动清单', '我的行动清单')}\n\n[在线使用](https://fangx-ai.github.io/better-life/)\n`);
save('主题目录', '# 全部主题\n\n' + corpus.chapters.map(c => '- ' + wiki(chapterPath(c), `${c.id}. ${c.title}（${c.entries.length} 条）`)).join('\n') + '\n');
save('使用说明/图谱说明', '# 图谱说明\n\n三种连接：场景 → 主题、主题 → 条目、条目 → 原书明确引用的条目或主题。条目节点保留完整原书条目。只有能解析且目标存在的引用才新增连线，未解析的引用仍可在正文中阅读。\n\n默认全局图隐藏目录、使用说明、原书和个人笔记，减少重复节点。要看完整图，在图谱搜索框清除筛选。颜色：珊瑚色为主题，蓝色为条目，绿色为场景。\n\n原书/book 保留完整章节，原书/docs 保留长文。条目节点新增导航和属性，不对正文结论进行改写。原文中的文件链接仅调整路径以便离线使用。没有插件依赖，没有远程脚本。\n\n每次导出固定对应一个上游快照。升级时打开新版 Vault，并自行迁移「我的笔记」，不要直接覆盖个人笔记。\n');
save('使用说明/来源与版本', `# 来源与版本\n\n原作者：eternity4719。正文：[《高性价比人生指南》](${corpus.source.repository})。许可：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。\n\n内容快照：${corpus.source.snapshotDate}。上游提交：${corpus.source.revision}。\n\nBetter Life 新增场景导航、独立条目节点、原书引用双链和图谱配置。正文结论未改写；不是原项目官方版本，也未实时核验政策和来源。证据等级沿用原书。\n\n原书许可见原书/LICENSE（若上游存在）。代码许可与正文许可分开。\n`);
save('我的笔记/我的行动清单', '# 我的行动清单\n\n从条目中复制双链到这里，记录你自己的行动。请先核对原文的适用条件。\n\n- [ ] 我要解决的问题：\n- [ ] 参考条目：\n- [ ] 下一步动作：\n- [ ] 完成时间：\n');
mkdirSync(resolve(root, '.obsidian'), { recursive: true });
writeFileSync(resolve(root, '.obsidian/graph.json'), JSON.stringify({ search: 'path:"主题/" OR path:"条目/" OR path:"场景/"', showTags: false, showAttachments: false, hideUnresolved: true, showOrphans: false, collapseFilter: false, colorGroups: [{ query: 'path:"主题/"', color: { a: 1, rgb: 16730947 } }, { query: 'path:"条目/"', color: { a: 1, rgb: 3890927 } }, { query: 'path:"场景/"', color: { a: 1, rgb: 3381621 } }], nodeSizeMultiplier: 1, lineSizeMultiplier: 0.7, centerStrength: 0.3, repelStrength: 12, linkStrength: 0.7, linkDistance: 110 }, null, 2));
writeFileSync(resolve(root, '.obsidian/app.json'), JSON.stringify({ defaultViewMode: 'preview', readableLineLength: true, newLinkFormat: 'absolute', useMarkdownLinks: false }, null, 2));
writeFileSync(resolve(root, '.obsidian/core-plugins.json'), JSON.stringify(['file-explorer', 'global-search', 'switcher', 'graph', 'backlink', 'outgoing-link', 'tag-pane', 'page-preview', 'bookmarks', 'properties', 'outline'], null, 2));
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const item of readdirSync(from, { withFileTypes: true })) {
    const source = resolve(from, item.name), target = resolve(to, item.name);
    if (item.isDirectory()) copyTree(source, target);
    else writeFileSync(target, readFileSync(source));
  }
}
for (const folder of ['book', 'docs']) copyTree(resolve(project, 'library', folder), resolve(root, '原书', folder));
for (const file of readdirSync(resolve(project, 'library')).filter(file => /^(README.*\.md|LICENSE.*)$/.test(file))) writeFileSync(resolve(root, '原书', file), readFileSync(resolve(project, 'library', file)));
// 检查所有新增双链；绝不静默输出悬空节点。
let wikiCount = 0;
for (const [file, body] of generated) for (const m of body.matchAll(/\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/g)) {
  const target = resolve(root, m[1] + '.md');
  try { readFileSync(target); } catch { throw Error(`${file} 双链目标不存在：${m[1]}`); }
  wikiCount++;
}
// ZIP writer：UTF-8 文件名，包含隐藏的 .obsidian，跨平台、不需要外部压缩依赖。
const table = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
const crc32 = bytes => { let crc = 0xffffffff; for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
function files(dir) { return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => e.isDirectory() ? files(resolve(dir, e.name)) : [resolve(dir, e.name)]); }
const chunks = [], central = []; let offset = 0;
const archiveRoots = new Set(['.obsidian', '场景', '使用说明', '条目', '我的笔记', '原书', '主题', '00 开始使用.md', '主题目录.md']);
for (const path of files(root).filter(path => archiveRoots.has(relative(root, path).split(/[\\/]/)[0]))) {
  const name = Buffer.from(`${root.split(/[\\/]/).at(-1)}/${relative(root, path).replace(/\\/g, '/')}`);
  const data = readFileSync(path), packed = deflateRawSync(data), crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt16LE(33, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
  chunks.push(local, name, packed); central.push(dir, name); offset += local.length + name.length + packed.length;
}
const centralBytes = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
const archive = resolve(project, 'public/downloads/better-life-obsidian.zip'); mkdirSync(dirname(archive), { recursive: true }); writeFileSync(archive, Buffer.concat([...chunks, centralBytes, end]));
// 网站与 Vault 共用已校验的原书关联，不另造展示数据。
writeFileSync(resolve(project, 'public/knowledge-graph.json'), JSON.stringify({ snapshot: corpus.source.snapshotDate, edges: crossEdges, counts: { entries: entries.size, chapters: chapters.size, crossReferences: crossEdges.length } }));
const report = { snapshot: corpus.source.snapshotDate, entries: entries.size, chapters: chapters.size, scenes: scenes.length, generatedNotes: generated.size, crossReferences: crossEdges.length, wikiLinks: wikiCount, brokenWikiLinks: 0, zipFiles: central.length / 2, zipBytes: readFileSync(archive).length, vault: root, archive };
writeFileSync(resolve(project, 'output/obsidian/report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
