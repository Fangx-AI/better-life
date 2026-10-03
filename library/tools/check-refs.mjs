// 交叉引用对照表：把正文里每一处「第 X 条」引用解析成它实际指向的条目标题，
// 写进 docs/引用对照.md。那份文件入库，所以插入或删除条目导致引用指向变化时，
// git diff 会直接把变化摆出来——条号没动而标题变了，就是错位。
//
//   node tools/check-refs.mjs            # 重新生成对照表（sync-stats.mjs 会自动调用）
//   node tools/check-refs.mjs --check    # 只校验不写文件，有失效引用则退出码 1（CI 用）
//   node tools/check-refs.mjs --suspect  # 额外列出措辞和目标标题对不上的，误报多，排查历史遗留时用
//
// 为什么需要它：条号是位置依赖的，正文里的引用只记了位置不记内容。2026-09-19
// 在第 7 节发现 6 处指错（医疗救助指到低保、救助站指错条），全都在条号范围内，
// 越界检查一条都抓不到。
// 注意：切行一律用 /\r?\n/，不能用 '\n'。book/ 下的文件行尾不统一（有 CRLF 有 LF），
// 而 JS 正则的 . 不匹配 \r（CR 也算行终止符，这点和 Python、Perl 不一样），
// 留着 \r 会让 /^### (\d+)\. (.*)$/ 在 CRLF 文件上一条都匹配不到。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

// 节内的裸引用（「见第 8 条」）只在这几个栏位里找：来源栏里的「第 N 条」几乎都是
// 法条条款号，扫进来全是误报。
const FIELDS = /^- (说人话|收益|备注|成本)：/;
// 但带节号的跨节引用（「见第 11 节第 16 条」）不会和法条混淆，来源栏里也有，一并扫。
// book/26 第 103 条那处「日志留存见第 11 节第 16 条」就写在来源栏里，差点漏掉。
const CROSS_FIELDS = /^- (说人话|收益|备注|成本|来源)：/;

const files = readdirSync(resolve(ROOT, 'book')).filter(f => /^\d\d-.*\.md$/.test(f)).sort();
// docs/ 下的长文也扫。它们和节首引言一样，长期不在扫描范围内：条号被顺延撞歪时
// --check 照常显示通过，对照表的 diff 里也看不到这些引用。2026-09-21 清点时
// 三篇长文里有 23 处「第 X 节第 Y 条」，一处都没被查过。
// 只取 docs/ 根下的 .md。子目录 docs/核实记录/ 不扫：那些文件记的是当时的核实过程，
// 里面的条号是历史状态，不该跟着正文走。对照表自己也排除掉。
const docs = readdirSync(resolve(ROOT, 'docs')).filter(f => f.endsWith('.md') && f !== '引用对照.md').sort();

// 先把每节的条目标题读出来：sections[节号] = { file, titles: { 条号: 标题 } }
const sections = new Map();
for (const f of files) {
  const num = Number(f.slice(0, 2));
  const titles = new Map();
  for (const line of readFileSync(resolve(ROOT, 'book', f), 'utf8').split(/\r?\n/)) {
    const m = /^### (\d+)\. (.*)$/.exec(line);
    if (m) titles.set(Number(m[1]), m[2].trim());
  }
  sections.set(num, { file: f, titles });
}

// 一处引用可能写成「第 3、10、11 条」，拆成多个条号。也认区间写法「第 11 到 14 条」
// 「第 5 到第 10 条」：这种写法原先整处都匹配不上，等于没扫，全书有 5 处这么写的。
const RANGE = /^\s*(\d+)\s*(?:到|至)\s*第?\s*(\d+)\s*$/;
// 返回 [条号, 是不是区间展开来的]。区间指的是一整块条目（「泄愤那几条」「平台义务
// 那几条」），没法给块里每一条都配一个锚点，所以展开出来的条号免验锚点——它们仍然
// 进对照表，被顺延撞歪时靠 diff 里标题变化来发现。
const nums = s => {
  const out = [];
  for (const part of s.split(/[、,]/)) {
    const r = RANGE.exec(part);
    if (r) {
      const [a, b] = [Number(r[1]), Number(r[2])];
      if (b >= a && b - a <= 30) for (let i = a; i <= b; i++) out.push([i, true]);
      continue;
    }
    const n = Number(part.trim());
    if (Number.isFinite(n)) out.push([n, false]);
  }
  return out;
};
// 条号那一段的写法：「3」「3、10」「11 到 14」「5 到第 10」
const SPEC = '[\\d、,\\s]+?(?:(?:到|至)\\s*第?\\s*\\d+)?';

const out = [];
const problems = [];
const suspects = [];
const weak = [];
let total = 0;

// 扫描单元：book/ 下每节一个，docs/ 下每篇长文一个。
const targets = [
  ...files.map(f => ({ f, dir: 'book', isDoc: false })),
  ...docs.map(f => ({ f, dir: 'docs', isDoc: true })),
];

for (const { f, dir, isDoc } of targets) {
  const num = isDoc ? 0 : Number(f.slice(0, 2));
  const self = isDoc ? null : sections.get(num);
  const lines = readFileSync(resolve(ROOT, dir, f), 'utf8').split(/\r?\n/);
  const rows = [];
  // cur 是当前所在条目的条号，0 表示还没进条目（book 的节首引言、docs 的任何位置）。
  // unit 是「出处」列显示的名字：条目写「第 N 条」，节首写「节首」，长文写最近的小标题。
  let cur = 0;
  let unit = isDoc ? '开头' : '节首';

  // 引用前面那句话往往就写着它想指什么（「医疗救助（见第 11 条）」），把整个分句
  // 列出来，人工扫对照表时不用翻正文就能判断指对没有。
  // 取到最近的句读为界而不是固定字数——固定 14 字曾让好几处正确引用看起来可疑
  // （「一氧化碳见第 18 条，烧烫伤见第 13 条」截断后只剩「氧化碳」对着「烫伤」）。
  const ctxOf = (line, idx) => {
    const before = line.slice(0, idx);
    let start = -1;
    for (const p of ['。', '；', '！', '？', '：']) start = Math.max(start, before.lastIndexOf(p));
    return before.slice(start + 1).slice(-44).replace(/\|/g, '｜');
  };
  // 验锚点时用的窗口比上面这个窄：只取引用所在的那个逗号分句。整句那么宽的窗口里
  // 「自己」「公司」这类常见词很容易和别的条目标题偶然重合，锚点就成了假的——
  // 2026-09-20 第 31 节插条目，第 1 条备注里「……的贷款见本节第 15 条」被顺延撞到
  // 新条目「在家给境外公司远程干活……个税自己报」上，整句窗口里两个逗号之外的
  // 「你自己还」撞上标题里的「个税自己报」，--check 报了通过。
  // 分句太短时（「……，见第 11 条」这种，窗口只剩一个「见」字）往前再退一个分句，
  // 否则会把本来正确的引用误判成裸条号。
  // 顿号和引号、括号都不算分句边界：「含糖饮料、加工肉（本节第 3 条）」的锚点隔着顿号，
  // 「为『比别人强一档』而加的预算见本节第 24 条」的锚点在引号里，切了都会误伤。
  const CLAUSE = ['。', '；', '！', '？', '：', '，'];
  const narrowOf = (line, idx) => {
    const before = line.slice(0, idx);
    const cut = s => {
      let start = -1;
      for (const p of CLAUSE) start = Math.max(start, s.lastIndexOf(p));
      return { head: s.slice(0, start + 1), tail: s.slice(start + 1) };
    };
    const last = cut(before);
    if (last.tail.replace(/[见按同和依据参照的在]/g, '').length >= 4) return last.tail.slice(-24);
    return (cut(last.head.slice(0, -1)).tail + last.tail).slice(-24);
  };
  // 引用后面的文字也算锚点：「第 16 条（借条和担保）」这种把关键词写在条号之后
  // 取到引用后的第一个句读为止（最多 40 字）。不能用固定字符数：「见第 1 节第 7、8、
  // 14、17、18、19、23、24、29 条（血压、血糖…）」这种长条号串会把标注挤出窗口。
  const afterOf = (line, idx) => {
    const rest = line.slice(idx).replace(new RegExp(`^第\\s*\\d+\\s*节?第?\\s*(?:${SPEC})?\\s*条`), '');
    const end = rest.search(/[。；！？]/);
    return (end === -1 ? rest : rest.slice(0, end)).slice(0, 40).replace(/\|/g, '｜');
  };

  lines.forEach((line, i) => {
    if (isDoc) {
      const h = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (h) { unit = h[1].slice(0, 24); return; }
    } else {
      const t = /^### (\d+)\. (.*)$/.exec(line);
      if (t) { cur = Number(t[1]); unit = `第 ${cur} 条`; return; }
    }
    // 条目正文只扫那几个栏位（来源栏的「第 N 条」多是法条条款号）。节首引言和长文
    // 正文是普通段落，匹配不上栏位前缀，整行放行——它们原先就是这样被静默跳过的。
    const inEntry = !isDoc && cur > 0;
    if (inEntry ? !CROSS_FIELDS.test(line) : !line.trim()) return;

    // 相对指路（「见下一条」「罚则见上一条」）一律禁掉：它不带条号，插入条目时跟着
    // 整体平移，撞歪了对照表的 diff 也看不出来，--check 的裸条号检查更是扫不到它。
    // 2026-09-20 一次扫描就查出三处早就指错的：HPV 疫苗条的「见下一条」指到了乳腺癌
    // 筛查（该指宫颈癌筛查），扬言条的「罚则见上一条」指到了念头条，失业登记条的
    // 「上一条不签主动辞职」指到了存证据条。排除「最后一条」「之后一条腿」这类误命中。
    for (const m of line.matchAll(/(?<![最之以])(上一条|下一条|前一条|后一条|上面那条|上面这条|前面那条)/g)) {
      problems.push(`${f}:${i + 1} ${unit}用了相对指路「${m[1]}」——改成「第 N 条（锚点词）」`);
    }

    // 跨节：第 N 节第 X 条
    for (const m of line.matchAll(new RegExp(`第\\s*(\\d+)\\s*节第\\s*(${SPEC})\\s*条`, 'g'))) {
      const target = sections.get(Number(m[1]));
      for (const [x, range] of nums(m[2])) {
        const title = target?.titles.get(x);
        rows.push({ from: unit, range, ref: `第 ${m[1]} 节第 ${x} 条`, title, line: i + 1, ctx: ctxOf(line, m.index), narrow: narrowOf(line, m.index), after: afterOf(line, m.index) });
        if (!title) problems.push(`${f}:${i + 1} ${unit}引用「第 ${m[1]} 节第 ${x} 条」——该节没有这一条`);
      }
    }

    // 长文里没有「本节」这个概念，裸的「第 N 条」在长文里指的是法条条款号，不扫。
    if (isDoc) return;

    // 节内：扫所有「第 X 条」，不限引导词——正文里的写法远不止「见第 X 条」，还有
    // 「按第 1 条压胸」「判断方法同第 4 条」「先对照第 8 条」「和第 4 条二选一」，
    // 早先只认三种引导词，这些全漏在扫描之外。来源栏整行不扫（全是法条条款号）。
    // 节首引言不受栏位限制：那里的「第 N 条」是导读（「第 9 条算钱」「第 2 条算读书
    // 和寿命的关系」），同样会被顺延撞歪，同样要进对照表。
    if (inEntry && !FIELDS.test(line)) return;
    const stripped = line.replace(new RegExp(`第\\s*\\d+\\s*节第\\s*${SPEC}\\s*条`, 'g'), '');
    for (const m of stripped.matchAll(new RegExp(`第\\s*(${SPEC})\\s*条`, 'g'))) {
      // 判定这是法条条款号还是条目引用。2026-09-21 之前的办法是看前 16 个字里有没有
      // 「法」字，可是「办法」「查法」「法律援助」「违法解除」都带「法」，一大批真引用
      // 被连带跳过。而且是静默跳过：引用压根不进对照表，--check 没有可查的引用反而显示
      // 「通过」，只能靠引用总数少了才发现。一次全量扫描查出 12 处这样的引用。
      // 现在按两条明确的判据跳过：
      //   ① 紧挨着「第 N 条」的是引文标记——《…》、〔…〕、「14 号」、「该解释」，
      //      或者以法规名收尾（「治安管理处罚法第 26 条」）；
      // 只认「紧挨着」，不按前 N 个字的模糊窗口，也不拿「是不是句首」当判据——条目引用
      // 照样会顶在句首（「第 4 条的救助站免费管吃住」「第 7 条那张『立刻去医院』的清单」）。
      // 代价是法条引文必须自带文件名：一句一条往下列时要写「该解释第 11 条」，不能写
      // 「……的法院命令。第 11 条讲的是取证」靠上一句撑着。这本来也是正文的自足性要求。
      const tail = stripped.slice(0, m.index).replace(/\s+$/, '');
      const CITE = /(《[^》]*》|〔[^〕]*〕|\d+\s*号|该(?:解释|意见|办法|规定|条例|通知|法)|[^\s，。；：、（）「」]{0,8}(?:法|条例|办法|规定|准则|细则|公约))$/;
      if (CITE.test(tail)) continue;
      for (const [x, range] of nums(m[1])) {
        const title = self.titles.get(x);
        rows.push({ from: unit, range, ref: `本节第 ${x} 条`, title, line: i + 1, ctx: ctxOf(stripped, m.index), narrow: narrowOf(stripped, m.index), after: afterOf(stripped, m.index) });
        // 节内引用超出本节条目数的，多半是法条条款号被误当成条目引用，列出来人工看
        if (!title) problems.push(`${f}:${i + 1} ${unit}引用「第 ${x} 条」——本节只有 ${self.titles.size} 条（可能是法条条款号）`);
        if (inEntry && x === cur) problems.push(`${f}:${i + 1} 第 ${cur} 条引用了它自己`);
      }
    }
  });

  // 能不能自动验证这处引用指对了：引用前后的文字里，有没有一段字也出现在目标条目
  // 标题里。有 → 这处引用自带锚点，改动导致错位时会被察觉；没有 → 它是个裸条号
  // （「实际算法可以看第 34 条」），错了也看不出来，需要补一个显式标注。
  // 两个汉字的重合太容易偶然发生（「自己」「公司」「时间」），所以按长度和距离分级：
  // 整句里连着三个汉字对上（「含糖饮料」「居民医保」）算实锚点；只有两个汉字对上时，
  // 要求它落在引用所在的分句里才算——隔着两个逗号的「你自己还」撞上标题里的
  // 「个税自己报」，就是 2026-09-20 那处漂移蒙过检查的原因。
  const longest = (text, title) => {
    let best = 0;
    for (let i = 0; i < text.length; i++) {
      for (let n = 1; i + n <= text.length; n++) {
        const seg = text.slice(i, i + n);
        if (!/^[一-龥]+$/.test(seg)) break;
        if (!title.includes(seg)) break;
        best = Math.max(best, n);
      }
    }
    return best;
  };
  // 数字和英文串也是锚点：12356、AED、CT、BMI、LPR 这些常常就是引用要指的东西
  const token = (text, title) => (text.match(/[0-9A-Za-z]{2,}/g) ?? []).some(t => title.includes(t));
  for (const r of rows) {
    if (!r.title || r.range) continue;
    const wide = r.ctx + r.after;
    if (token(wide, r.title) || longest(wide, r.title) >= 3) continue;
    if (longest(r.narrow + r.after, r.title) >= 2) continue;
    // 只在分句之外撞上两个字的，按弱锚点单独列：修法和裸条号一样是补显式标注。
    const list = longest(wide, r.title) >= 2 ? weak : suspects;
    list.push(`${f}:${r.line} ${r.from} →「${r.ref}」${r.title.slice(0, 20)}…　…${r.ctx}【${r.ref}】${r.after}…`);
  }

  if (!rows.length) continue;
  total += rows.length;
  out.push(`## ${isDoc ? 'docs/' : ''}${basename(f, '.md')}\n`);
  out.push('| 出处 | 引用 | 指向的条目 | 引用处的上下文 |');
  out.push('| --- | --- | --- | --- |');
  for (const r of rows) {
    const title = r.title ? r.title : '**指向不存在的条目**';
    out.push(`| ${r.from} | ${r.ref} | ${title} | …${r.ctx}… |`);
  }
  out.push('');
}

const body = [
  '# 交叉引用对照表',
  '',
  '本文件由 `node tools/check-refs.mjs` 生成，不要手改。',
  '',
  '正文里的「第 X 条」只记条号不记内容，插入或删除条目会让后面的引用集体错位，',
  '而错位后的条号往往仍在范围内，光查越界抓不到。所以把每处引用**实际指向的标题**',
  '摊开写在这里并入库：改完条目重新生成，`git diff` 里凡是条号没动而标题变了的，',
  '就是被顺延撞歪的引用。',
  '',
  '扫描范围：`book/` 下每节的条目正文和节首引言，加上 `docs/` 下的长文。长文里没有',
  '「本节」，裸的「第 N 条」一律当法条跳过，所以长文引用要写全「第 X 节第 Y 条」。',
  '「出处」列里，条目写「第 N 条」，节首写「节首」，长文写最近的那个小标题。',
  '',
  '另一道保险是**锚点**：每处引用的前后文里都得有一个词和目标条目标题对得上',
  '（「医疗救助见第 11 条」里的「医疗救助」，或显式写成「见第 16 条（借条和担保）」）。',
  '`node tools/check-refs.mjs --check` 会把没有锚点的裸条号判为失败——那种引用一旦',
  '被撞歪，对照表的 diff 也看不出异常，只能靠锚点兜住。区间引用（「见第 8 节第 11 到',
  '14 条」）是例外：它指的是一整块条目，没法给块里每条都配锚点，只靠 diff 兜。',
  '',
  '锚点算不算数按长度和距离判：整句里连着三个汉字和标题对上（「含糖饮料」「居民医保」），',
  '或者引用所在的那个逗号分句里有两个汉字对上，才算实锚点；只在分句之外撞上两个常见汉字',
  '（「自己」「公司」）的，按没有锚点处理。这道加严是 2026-09-20 补的：第 31 节插条目时',
  '「……的贷款见本节第 15 条」被顺延撞到新条目「在家给境外公司远程干活……个税自己报」上，',
  '隔着两个逗号的「你自己还」冒充了锚点，`--check` 当时报的是通过。',
  '',
  `共 ${total} 处引用。`,
  '',
  ...out,
].join('\n');

if (problems.length) {
  console.log('需要人工确认：');
  for (const p of problems) console.log('  ' + p);
  console.log('');
}

// 这个启发式当年误报率极高（中文里「未遂之后的长期结局见第 30 条」指向「念头一冒出来
// 先告诉身边的一个人」完全正确，却一个字都不重叠），288 处能报出 159 处；后来全书 345 处
// 引用逐一补了锚点，这两类现在正常情况下都应该是 0，报出来就是真有一处该补标注。
// 但它只保证「错位能被察觉」，不保证「错位一定被拦下」：模拟把节内引用整体顺延一条，
// 能当场拦下的约七成，剩下的（相邻两条讲同一件事、标题共用词）仍要靠对照表的 diff。
if (process.argv.includes('--suspect') && suspects.length) {
  console.log(`引用处的措辞和目标标题对不上（${suspects.length} 处，误报很多，仅供人工排查参考）：`);
  for (const s of suspects) console.log('  ' + s);
  console.log('');
}

if (process.argv.includes('--suspect') && weak.length) {
  console.log(`锚点只在分句之外对上（${weak.length} 处，多半是常见词偶然撞上，等于没有锚点）：`);
  for (const s of weak) console.log('  ' + s);
  console.log('');
}

if (CHECK_ONLY) {
  const fatal = problems.filter(p => p.includes('该节没有这一条') || p.includes('引用了它自己') || p.includes('相对指路'));
  for (const p of fatal) console.log('  ' + p);
  // 裸条号（引用前后没有一个词和目标标题对得上）同样算失败：这种引用一旦被条目顺延
  // 撞歪，谁也看不出来。修法是补个锚点——「见第 16 条（借条和担保）」，
  // 括号里的词取自目标条目标题即可。
  if (suspects.length) {
    console.log(`${suspects.length} 处引用是裸条号，错了看不出来，请补锚点（跑 --suspect 看清单）：`);
    for (const s of suspects.slice(0, 10)) console.log('  ' + s.split('　')[0]);
    if (suspects.length > 10) console.log(`  …另有 ${suspects.length - 10} 处`);
  }
  // 弱锚点同样算失败：整句里只有两个常见汉字对上、还隔着分句，等于没有锚点。
  if (weak.length) {
    console.log(`${weak.length} 处引用的锚点只在分句之外偶然对上，等于没有锚点，请补显式标注（跑 --suspect 看清单）：`);
    for (const s of weak.slice(0, 10)) console.log('  ' + s.split('　')[0]);
    if (weak.length > 10) console.log(`  …另有 ${weak.length - 10} 处`);
  }
  const bad = fatal.length + suspects.length + weak.length;
  console.log(bad ? `共 ${bad} 处要处理` : `引用检查通过：${total} 处全部指向正确，且都带锚点`);
  process.exit(bad ? 1 : 0);
}

writeFileSync(resolve(ROOT, 'docs/引用对照.md'), body, 'utf8');
console.log(`已写入 docs/引用对照.md，共 ${total} 处引用`);
