// Frozen retrieval baseline before the 2026-10-03 relevance improvements. Test-only.
const indexCache = new WeakMap();
const aliases = [
  ['睡不着', '失眠 睡眠'], ['失眠', '睡眠'], ['熬夜', '睡眠 补觉'],
  ['房东', '租房 押金'], ['租房', '租赁 押金'], ['不退押金', '押金 退还 租房'],
  ['离职', '辞职 社保 医保 公积金'], ['失业', '失业保险 离职'],
  ['社保', '社会保险 社保'], ['医保', '医疗保险 医保'],
  ['欠薪', '工资 劳动仲裁'], ['拖欠工资', '欠薪 劳动仲裁'],
  ['被骗', '诈骗 报警'], ['诈骗', '报警 反诈'], ['老人', '养老 老年'],
  ['怀孕', '孕妇 产检 妊娠'], ['生产', '分娩 生育'], ['账号', '账户 密码'],
];
const stopGrams = new Set(['怎么', '如何', '什么', '多少', '是否', '可以', '能够', '应该', '最近', '总是', '一下', '一个', '一些', '之后', '时候', '帮我', '告诉', '请问', '办法', '建议', '问题', '生活', '需要', '有没有', '所有', '输出', '总结', '本书', '明天', '今天']);
const topics = [...new Set([...aliases.map(([phrase]) => phrase), ...'社保 医保 公积金 养老 押金 房租 房屋 租赁 合同 退还 退租 房贷 房产 买房 失眠 睡眠 补觉 作息 酒精 戒酒 抽烟 血压 血糖 慢性病 糖尿病 看病 医院 看牙 急救 中风 心梗 工伤 辞职 竞业 补偿 裁员 劳动仲裁 工资 个税 贷款 保险 理财 股票 比特币 存款 预付款 网贷 诈骗 报警 密码 密钥 隐私 验证码 手机 账户 安全 创业 生意 公司 技能 学习 求职 简历 面试 大学 留学 出国 旅行 机票 签证 残疾 结婚 离婚 恋爱 婚姻 彩礼 怀孕 孕妇 产检 生育 分娩 哺乳 宝宝 婴儿 儿童 孩子 疫苗 助学 失能 跌倒 遗产 丧葬 法律 诉讼 仲裁 官司 证据 欠款 欠钱 时间 精力 运动 锻炼 饮食 肥胖 减肥 药物 吃药 常备药 自伤 自杀 焦虑 抑郁 情绪 心理 地震 火灾 溺水 网站 平台 退款 睡不着'.split(' ')] )];
const chapterHints = [
  [/房东|租房|押金|退租|房租|买房|房产|房贷/, [15]],
  [/睡不着|失眠|睡眠|熬夜|补觉|作息/, [2, 3]],
  [/离职|社保|辞职|失业|欠薪|劳动仲裁/, [7, 19]],
  [/怀孕|孕妇|产检|分娩/, [27]], [/老人|失能|跌倒/, [17]],
  [/密码|密钥|验证码|账号|账户/, [14]],
];
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();
function grams(text) {
  const result = new Set();
  for (const run of normalize(text).match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[a-z0-9]+$/.test(run)) { if (run.length > 1) result.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) {
      const token = run.slice(i, i + 2);
      if (!stopGrams.has(token)) result.add(token);
    }
  }
  return result;
}
function makeIndex(corpus) {
  if (indexCache.has(corpus)) return indexCache.get(corpus);
  const entries = corpus.chapters.flatMap(chapter => chapter.entries.map(entry => ({ ...entry, chapterTitle: chapter.title, chapterFile: chapter.file })));
  const documents = entries.map(entry => ({ entry, fields: [
    [grams(entry.title), 5], [grams(entry.summary), 3], [grams(entry.benefit), 1.5],
    [grams(entry.notes), 1], [grams(entry.cost), 0.5], [grams(entry.chapterTitle), 0.3],
  ] }));
  const df = new Map();
  for (const document of documents) {
    const unique = new Set(document.fields.flatMap(([tokens]) => [...tokens]));
    for (const token of unique) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const index = { documents, df, size: entries.length };
  indexCache.set(corpus, index);
  return index;
}

export function retrieveEntries(corpus, question, { limit = 6 } = {}) {
  const index = makeIndex(corpus);
  // 识别书中常见主题，避免“职后/明天/所有”等跨词二元组压过真正问题。
  const query = normalize(question);
  const core = topics.filter(topic => query.includes(topic));
  const cleaned = query.replace(/请问|请告诉我|帮我|我最近|最近|总是|怎么办|该怎么办|如何|怎么|这个问题|这本书|总结|所有|输出|明天|今天/g, ' ');
  const original = grams(core.length ? core.join(' ') : cleaned);
  const focusChapters = new Set(chapterHints.filter(([pattern]) => pattern.test(query)).flatMap(([, chapters]) => chapters));
  const expanded = new Set(original);
  for (const [phrase, terms] of aliases) if (normalize(question).includes(phrase)) for (const token of grams(terms)) expanded.add(token);
  const candidates = [];
  for (const { entry, fields } of index.documents) {
    let score = 0;
    const directMatches = new Set();
    for (const [tokens, weight] of fields) for (const token of expanded) if (tokens.has(token)) {
      const frequency = index.df.get(token) ?? 0;
      // 常见词不应把书外问题硬凑到生活建议上。
      if (frequency / index.size > 0.4) continue;
      const idf = Math.log(1 + (index.size - frequency + 0.5) / (frequency + 0.5));
      score += idf * weight * (original.has(token) ? 1 : 0.35);
      if (original.has(token)) directMatches.add(token);
    }
    if (focusChapters.size) score *= focusChapters.has(entry.chapter) ? 1.5 : 0.5;
    const minimumMatches = !core.length && original.size > 1 ? 2 : 1;
    if (directMatches.size >= minimumMatches && score >= 5) candidates.push({ entry, score, coverage: directMatches.size });
  }
  candidates.sort((a, b) => (b.score * (1 + Math.min(b.coverage, 5) * 0.12)) - (a.score * (1 + Math.min(a.coverage, 5) * 0.12)) || a.entry.id.localeCompare(b.entry.id));
  if (!candidates.length) return [];
  const eligible = candidates.filter(candidate => candidate.score >= Math.max(5, candidates[0].score * 0.2));
  // 为多主题问题保留每个明确关键词的标题锚点，避免所有位置被一个词占满。
  const anchors = core.map(topic => eligible.filter(({ entry }) => normalize(entry.title).includes(topic)).sort((a, b) => normalize(a.entry.title).indexOf(topic) - normalize(b.entry.title).indexOf(topic) || b.score - a.score)[0]).filter(Boolean);
  const unique = new Map([...anchors, ...eligible].map(candidate => [candidate.entry.id, candidate.entry]));
  return [...unique.values()].slice(0, Math.min(6, Math.max(0, limit)));
}
