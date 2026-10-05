// 本地原书检索：概念词典只辅助召回，不提供事实、条目或书外答案。
// 不使用联网搜索、模型或 embedding，也不存储用户的问题。
const indexCache = new WeakMap();
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();
const words = value => value.split(' ').filter(Boolean);
const topic = (id, query, terms, chapters, extra = {}) => ({ id, query, terms: words(terms), chapters: new Set(chapters), ...extra });

// 以完整词/短语匹配自然问法，避免“怎么存”被拆成“么存”等跨词二元组。
// 章节是相关性约束，不是内容来源；返回的数据仍完全来自 corpus。
const topics = [
  topic('saving', /省钱|存钱|攒钱|攒下钱|攒不下|攒点钱|存下钱|存不下|月光|储蓄|预算|开支|花销|花费太多|花钱太多|节省|节约用钱|钱怎么花|钱花在哪|存款规划/, '应急金 自动续费 套餐 冷静期 冲动下单 最低还款 自炊 合租', [5, 7], { prefer: '先存出' }),
  topic('emergency-fund', /应急金|备用金|紧急备用|生活费.*存|存.*生活费/, '应急金 生活费 随时能取 存款保险', [5]),
  topic('shopping', /冲动.*(买|下单|消费)|忍不住.*(买|下单)|剁手|购物成瘾|买买买|大促|囤货|打赏|游戏充值/, '冲动下单 冷静期 大促 囤货 打赏 充值 免密支付', [5, 6]),
  topic('subscription', /自动续费|自动扣费|自动扣款|订阅.*(取消|扣钱)|取消.*订阅/, '自动续费 自动扣款 订阅', [5]),
  topic('mobile-plan', /套餐|话费|宽带|流量.*(贵|省)|手机费/, '套餐 宽带 资费 12300', [5]),
  topic('debt', /信用卡|最低还款|花呗|借呗|网贷|消费贷|分期|负债|欠了.*钱|还不起|还债/, '信用卡 最低还款 消费贷 高利贷 网贷 债务', [5, 7, 8, 29]),
  topic('credit-card', /信用卡|最低还款/, '信用卡 最低还款', [5, 7]),
  topic('investing', /投资|理财|股票|基金|加杠杆|比特币|美股/, '投资 理财 股票 基金 杠杆 高收益', [5, 8, 17]),
  topic('fund', /指数基金|主动基金|基金.*费率|基金.*手续费|低费率|宽基|长期.*投资/, '宽基 指数基金 主动管理基金 费率 长期底仓', [5]),
  topic('insurance', /买保险|保险.*(买|选择)|寿险|重疾险|医疗险|退保|保单|保证续保/, '保险 消费型 定期寿险 保单 退保 保证续保', [5, 7, 21]),
  topic('mortgage', /房贷|提前还贷|提前还款.*房/, '房贷 提前还 贷款利率', [5, 15], { require: '提前还房贷 房贷利率 房贷的利率' }),
  topic('renting', /租房|房东|退租|租约|租赁|长租公寓|合租/, '租房 房东 租赁 租金 押金 租约', [15, 7, 5]),
  topic('deposit', /押金|房东.*(不退|扣钱)|退租.*(钱|退)/, '押金 退还 扣减 租赁合同', [15]),
  topic('buying-home', /买房|二手房|购房|产权证|房产.*(交易|买)/, '产权证 二手房 房款 买房 抵押', [15, 5, 10]),
  topic('social-insurance', /社保|社会保险|养老保险|断缴|断交/, '社保 断缴 养老保险 缴费年限', [7, 19, 31, 5]),
  topic('health-insurance', /医保|医疗保险|报销|异地就医/, '医保 医疗保险 报销 异地备案 共济', [7, 16, 24, 5, 27, 31]),
  topic('provident-fund', /公积金/, '公积金 提取', [5, 7, 25]),
  topic('unemployment', /失业|被裁|裁员|被开除|被辞退|辞退/, '失业保险 失业 被裁 解除 补偿 辞退', [7, 19, 29], { require: '失业 被裁 解除 辞退' }),
  topic('resignation', /离职|辞职|离开公司|离开单位/, '离职 辞职 证明 社保断缴 主动辞职', [7, 19, 11]),
  topic('unpaid-wage', /欠薪|讨薪|拖欠.*(工资|薪水|工钱)|不发工资|工资.*(不给|没发)|工钱.*(不给|没给)/, '欠薪 劳动监察 劳动仲裁 工钱', [7, 19, 8]),
  topic('overtime', /加班|年休假|年假|工作.*小时|工时/, '加班 工作时间 年休假 工龄', [19, 3, 2]),
  topic('overtime-pay', /加班费|加班.*(钱|报酬)|加班.*不给/, '加班费 劳动监察 劳动仲裁', [19, 7]),
  topic('work-harassment', /职场.*(欺负|霸凌)|领导.*(辱骂|刁难|欺负)|单位.*(欺负|辱骂|刁难)/, '欺负 辱骂 刁难 留证据', [19]),
  topic('stress', /压力|减压|放松|缓解.*(紧张|情绪)|心累|心里.*(累|压)|内耗|糟心|想太多|反复.*(回想|想)/, '工作时间 糟心 反复回想 拒绝 想法和感受 呼吸 循环叹息 正念 减压', [3, 22], { prefer: '工作时间 循环叹息 想法和感受 糟心' }),
  topic('anxiety', /焦虑|紧张得|担心.*(未来|出丑)|总.*担心|完美主义/, '焦虑 正念减压 完美 出丑 循环叹息', [3, 22]),
  topic('depression', /抑郁|情绪低落|心情差|心情不好|不开心|开心不起来/, '抑郁 情绪低落 心情差 12356', [1, 3, 22, 29]),
  topic('anger', /生气|愤怒|发火|发脾气|吵架/, '生气 发泄 身体慢下来 离场 吵架', [3, 10, 8]),
  topic('loneliness', /孤独|寂寞|没人.*(陪|说话)|没有朋友|独居/, '孤独 独居 定期和人见面 紧急联络 找人说', [22, 29, 3]),
  topic('focus', /专注|注意力|分心|被打断|工作.*(消息|手机)|消息.*(太多|通知)/, '通知 打断 连续思考 批量处理 一次只做 手机', [3, 4], { require: '通知 打断 连续思考 批量处理 一次只做' }),
  topic('procrastination', /拖延|拖着.*(做|开始)|迟迟.*(开始|动手)|启动不了|执行力|不想开始|习惯|坚持.*(计划|做)/, '拖延 大任务 子任务 截止 日期 习惯 几点', [4]),
  topic('time', /时间管理|效率|浪费时间|会议太多|开会.*(太多|浪费)|通勤/, '会议 议程 异步 通勤 估工期 时薪 快捷键', [4, 3]),
  topic('phone-use', /刷.*(手机|短视频)|短视频|沉迷.*(手机|屏幕)|手机.*(停不下|放不下|上瘾)/, '短视频 刷屏 硬上限 通知 屏幕', [4, 3, 30]),
  topic('sleep', /睡不着|失眠|睡眠|熬夜|补觉|作息|睡觉|睡不好|睡得少|睡多久|起床/, '睡眠 作息 固定起床 睡前 每晚睡 咖啡因 补觉 熬夜 发光屏幕', [2, 3], { prefer: '作息固定 固定起床 每晚睡' }),
  topic('nap', /午睡|午觉|下午.*困|白天.*困|打瞌睡/, '午睡 下午困 半小时 十分钟', [2, 3]),
  topic('smoking', /戒烟|抽烟|吸烟|电子烟/, '戒烟 抽烟 吸烟 电子烟 戒烟门诊', [2, 1, 27]),
  topic('alcohol', /喝酒|戒酒|饮酒|酒精|喝得多|少喝酒/, '喝酒 戒酒 酒精 饮酒 手抖心慌', [2, 1, 8, 29, 34]),
  topic('exercise', /运动|锻炼|健身|力量训练|久坐|爬楼|走路|步数/, '运动 力量训练 快走 步 球拍 坐太久', [2, 22, 1]),
  topic('weight', /减肥|减重|肥胖|超重|体重|瘦下来|节食|断食/, '减重 体重 减肥 极端节食 bmi', [2, 6, 28]),
  topic('diet', /饮食|吃.*(健康|划算)|怎么吃|营养|含糖饮料|蔬菜|水果|全谷物|加工肉/, '含糖饮料 水果蔬菜 全谷物 加工肉 食盐 植物油 超加工', [2, 6]),
  topic('teeth', /刷牙|牙缝|牙线|看牙|蛀牙|缺牙/, '刷牙 牙缝 缺牙 窝沟封闭', [2, 30]),
  topic('supplements', /保健品|维生素|鱼油|益生菌|排毒|滋补|有机食品/, '保健品 维生素 鱼油 益生菌 排毒 有机食品', [6, 16]),
  topic('screening', /体检|筛查|肿瘤标志物|pet.?ct|全身检查/, '体检 筛查 肿瘤标志物 全身pet', [1, 6, 30]),
  topic('doctor', /看病|挂号|转诊|病历|急诊|社区医院|医疗.*(少花|省钱)/, '社区 转诊 病历 急诊 挂号', [24, 16, 7]),
  topic('chronic', /慢性病|长期吃药|自行停药|停药|药.*能停/, '医嘱 复查 慢性病 停药 停掉 家庭医生', [16, 2], { require: '医嘱 复查 自行停 正规治疗' }),
  topic('hypertension', /高血压|血压.*高|降压/, '血压 降压 医嘱', [1, 2, 16]),
  topic('diabetes', /糖尿病|血糖|低血糖/, '糖尿病 血糖 眼底 出冷汗', [1, 16, 13, 27]),
  topic('cold', /感冒|抗生素|头孢|感冒药/, '感冒 抗生素 头孢 对乙酰氨基酚', [34, 6]),
  topic('painkillers', /止痛药|布洛芬|阿司匹林|对乙酰氨基酚|头痛.*药/, '止痛药 布洛芬 阿司匹林 对乙酰氨基酚', [34, 27]),
  topic('diarrhea', /拉肚子|腹泻|补液盐/, '拉肚子 口服补液盐 止泻药', [34]),
  topic('pregnancy', /怀孕|孕妇|备孕|产检|妊娠|叶酸|分娩|生育|产后/, '怀孕 孕 产检 叶酸 分娩 生育 产后', [27, 18, 34]),
  topic('prenatal-check', /产检|孕.*检查|怀孕.*(做什么|先做)/, '产检 母子健康手册 糖尿病筛查 艾滋病梅毒乙肝', [27]),
  topic('infant', /婴儿|新生儿|刚出生|奶粉|喂奶|母乳|辅食|宝宝/, '婴儿 新生儿 奶粉 母乳 辅食 孩子仰着睡', [20, 27]),
  topic('infant-sleep', /(?:宝宝|婴儿|新生儿).*(?:睡|枕头|被子)|(?:睡|枕头|被子).*(?:宝宝|婴儿|新生儿)/, '仰着睡 同房不同床 软东西', [20]),
  topic('infant-fever', /(宝宝|婴儿|个月|月龄).*发烧|发烧.*(婴儿|宝宝|个月)|体温.*38/, '婴儿体温 38 发烧', [20, 34], { prefer: '不满3个月' }),
  topic('child-fever', /(?:孩子|儿童|小孩).*(?:发烧|退烧)|(?:发烧|退烧).*(?:孩子|儿童|小孩)/, '孩子发烧 阿司匹林 安乃近 尼美舒利', [34]),
  topic('child', /孩子|儿童|小孩|未成年|上学|学生/, '孩子 儿童 学生', [30, 20, 18, 1], { background: true }),
  topic('child-bullying', /校园霸凌|欺凌|孩子.*(被打|被欺负|霸凌)/, '欺凌 书面处理', [30]),
  topic('child-myopia', /近视|护眼|视力|散瞳/, '近视 户外 散瞳 视力', [30, 6]),
  topic('vaccines', /疫苗|hpv|乙肝|带状疱疹|肺炎球菌|流感/, '疫苗 hpv 乙肝 带状疱疹 肺炎球菌 流感', [1, 20]),
  topic('elder', /老人|父母.*养老|老年|老爸|老妈/, '老人 老年', [17, 1, 13], { background: true }),
  topic('falling', /跌倒|摔倒|摔跤|防跌|骨质疏松|骨密度/, '跌倒 摔倒 摔跤 平衡 腿部力量 骨密度 骨质疏松', [1, 13, 17]),
  topic('care', /卧床|失能|长期护理|压疮|照护/, '卧床 失能 长期护理 压疮 翻身', [17, 33]),
  topic('will', /遗嘱|继承|遗产|监护人|意定监护/, '遗嘱 遗产 监护人 意定监护', [17, 10, 33, 25]),
  topic('bereavement', /亲人.*(去世|离世|走了)|丧偶|丧亲|哀伤|葬礼|火化|死亡证明/, '哀伤 丧偶 亲人 死亡证明 殡仪馆 火化', [29, 25]),
  topic('dating', /恋爱|相亲|找对象|追求|表白|伴侣|冷战/, '关系 兴趣 见面 拒绝 冷战 伴侣', [10]),
  topic('marriage', /结婚|婚姻|领证|婚检|彩礼|婚前财产/, '结婚 婚姻 领证 婚检 彩礼 婚前财产', [10, 8]),
  topic('divorce', /离婚|分居/, '离婚 分居 冷静期 医保', [10, 29]),
  topic('domestic-violence', /家暴|家庭暴力|配偶.*(打我|打人)|老公.*打我/, '家暴 人身安全保护令 出警记录', [8]),
  topic('fraud', /被骗|骗子|诈骗|骗局|反诈|电诈|钱转.*骗子|转账.*被骗/, '被骗 诈骗 反诈 止付 96110 报警', [8, 21, 5, 14], { require: '被骗 诈骗 反诈 止付 96110' }),
  topic('fraud-response', /被骗|(?:转|给|付|汇).*骗子|骗子.*(?:转账|收钱)/, '止付 96110 报警 平台投诉', [8, 14], { require: '止付 96110 网购二手交易被骗 盗刷' }),
  topic('password', /密码|二次验证|验证码|账号.*安全|账户.*安全|邮箱.*安全/, '密码 二次验证 验证码 登录设备', [14], { direct: '密码 二次验证 验证码', prefer: '邮箱密码' }),
  topic('password-reuse', /密码.*(?:重复|复用|一样|相同)|(?:重复|复用|一样|相同).*密码/, '邮箱密码 重复 密码', [14], { require: '邮箱密码 网站重复' }),
  topic('lost-phone', /手机.*(丢|被偷)|丢.*手机/, '手机丢 挂失sim 远程锁定 冻结银行卡', [14]),
  topic('bank-card', /银行卡|手机卡.*借|借.*手机卡|跑分|兼职.*(收钱|转账)/, '银行卡 手机卡 跑分 自己的卡收钱 盗刷', [8, 9, 14]),
  topic('card-misuse', /(?:银行卡|手机卡|支付账号).*(?:借|兼职|收钱|转账)|(?:借|兼职).*(?:银行卡|手机卡|支付账号)/, '银行卡手机卡支付账号 跑分 自己的卡收钱', [8, 9]),
  topic('privacy', /隐私|个人信息|刷脸|授权应用|app.*权限/, '个人信息 刷脸 授权应用', [14, 11, 26]),
  topic('identity-card', /身份证.*(丢|补)|临时身份证/, '身份证丢 临时身份证 补办', [7]),
  topic('work-injury', /工伤|上班.*受伤|工作.*受伤|通勤.*(撞|受伤)/, '工伤 认定 劳动能力鉴定', [19, 7]),
  topic('work-injury-claim', /(?:工伤|受伤).*(?:申报|申请|认定|待遇)|(?:申报|申请|认定).*工伤/, '工伤认定 工伤待遇 劳动能力鉴定 法律援助', [19, 7]),
  topic('legal-aid', /法律援助|打官司|诉讼|劳动仲裁/, '法律援助 诉讼 劳动仲裁 时效', [7, 8, 19]),
  topic('first-aid', /急救|心肺复苏|aed|倒地.*呼吸|没有呼吸/, '急救 心肺复苏 按压胸口 aed', [13, 1]),
  topic('burns', /烫伤|烧伤|烫到/, '烫伤 流动水 20分钟', [13], { require: '烫伤' }),
  topic('animal-bite', /狗咬|猫咬|猫抓|狗.*咬|猫.*抓|狂犬/, '咬伤 抓破皮 肥皂水 疫苗', [13]),
  topic('stroke', /中风|卒中|嘴歪|说话不清|一侧.*没劲/, '卒中 嘴歪 一侧胳膊 说话说不清', [13]),
  topic('chest-pain', /胸痛|胸口.*(疼|闷|发紧)|心梗/, '胸口压着疼 胸痛 120', [13, 29]),
  topic('heat', /中暑|热射病|高温.*(头晕|恶心|晕倒)/, '中暑 高温 不出汗 降温', [13]),
  topic('drowning', /溺水|落水|掉.*水里|掉.*河里/, '溺水 下水 救生衣', [13, 1]),
  topic('snake-bite', /蛇咬|被蛇.*咬/, '蛇咬 抗蛇毒血清', [13]),
  topic('poisoning', /误服|误吞|误喝|农药|清洁剂.*(喝|吃)|吞.*药物/, '误服 清洁剂 农药 催吐', [13]),
  topic('high-altitude', /高原|高反|海拔/, '高原 海拔 下撤', [13]),
  topic('fire', /火灾|着火|烟雾报警|灭火器|一氧化碳|煤气/, '火灾 烟雾报警 灭火器 一氧化碳', [1, 13]),
  topic('earthquake', /地震/, '地震 抗震 老房子', [13]),
  topic('travel', /旅游|旅行|出国|出境|境外|护照|签证|领事保护/, '出境 境外 护照 签证 领事保护', [21, 32]),
  topic('overseas-work', /出国.*(打工|工作)|境外.*招聘|海外.*工作|国外.*打工/, '对外劳务 境外高薪招聘 出国打工', [31, 21]),
  topic('study-abroad', /留学|f-1|oshc|留服|学历认证/, '留学 f-1 oshc 留服 认证', [32, 21]),
  topic('learning', /学习|学东西|背书|记不住|复习|记忆|考试|自学/, '学法 考自己 重读 摊到几天 混着练', [23, 4]),
  topic('training', /培训|学.*技能|学什么|转行|职业资格|考证|技能.*划算|职称/, '技能 职业资格 培训 补贴 评价机构 职称', [23, 7, 31]),
  topic('job-search', /找工作|求职|简历|面试|找活|招聘|就业/, '求职 找活 公共就业 简历 紧缺职业', [7, 23, 31]),
  topic('business', /创业|做生意|开店|加盟|公司注册|注册公司|营业执照|合伙/, '创业 加盟 预售 注册 有限公司 担保 执照', [12, 31, 8]),
  topic('website', /网站|平台|icp|备案|服务器/, '网站 平台 备案 服务器 许可证', [26, 11]),
  topic('disability', /残疾|轮椅|残联|助听器|导盲犬|康复救助/, '残疾 残联 轮椅 助听器 康复救助', [33, 7, 24]),
];

const stopGrams = new Set(words('怎么 如何 什么 多少 是否 可以 能够 应该 最近 总是 一下 一个 一些 之后 时候 帮我 告诉 请问 办法 建议 问题 生活 需要 有没有 所有 输出 总结 本书 明天 今天 想要 想问 怎样 为了 自己 现在 知道 值得 的吗 有什 么办 么做 么样 这个 那个 事情 情况 还是 对我 关于 你好'));
const unsupported = [
  /(?:明天|下周|下个月|未来|今年).*(?:股票|股价|币价|比特币|基金).*(?:涨|跌|价格|行情)/,
  /(?:股票|股价|币价|比特币|基金).*(?:明天|下周|下个月).*(?:涨|跌|价格|行情)/,
  /(?:明天|下周|后天).*(?:天气|气温|降雨|下雨)/,
  /(?:天气预报|气温是多少|比分|开奖|彩票号码|星座运势|塔罗占卜|算命结果)/,
  /(?:写|生成|编写|创作|翻译).*(?:代码|程序|python|javascript|小说|诗歌|诗词|情书)/,
  /(?:火星|飞船引擎|量子计算|广义相对论|微积分|核聚变)/,
];

function grams(value) {
  const result = new Map();
  for (const run of normalize(value).match(/[\p{Script=Han}]+|[a-z]+[a-z0-9-]*/gu) ?? []) {
    if (/^[a-z]/.test(run)) { if (run.length > 1) result.set(run, (result.get(run) || 0) + 1); continue; }
    for (let i = 0; i < run.length - 1; i++) {
      const token = run.slice(i, i + 2);
      if (!stopGrams.has(token)) result.set(token, (result.get(token) || 0) + 1);
    }
  }
  return result;
}

function makeIndex(corpus) {
  if (indexCache.has(corpus)) return indexCache.get(corpus);
  const documents = corpus.chapters.flatMap(chapter => chapter.entries.map(entry => {
    const complete = { ...entry, chapterTitle: chapter.title, chapterFile: chapter.file };
    // 出处/证据等级/成本是返回资料，不参与相关性；它们有大量无关泛词。
    const fields = [[normalize(entry.title).replace(/\s+/g, ''), 5], [normalize(entry.summary).replace(/\s+/g, ''), 2.4], [normalize(entry.notes).replace(/\s+/g, ''), 0.55]];
    const tokens = new Map();
    for (const [field, weight] of fields) for (const [token, count] of grams(field)) tokens.set(token, (tokens.get(token) || 0) + count * weight);
    return { entry: complete, fields, tokens, length: [...tokens.values()].reduce((sum, value) => sum + value, 0) };
  }));
  const df = new Map();
  for (const { tokens } of documents) for (const token of tokens.keys()) df.set(token, (df.get(token) || 0) + 1);
  const index = { documents, df, size: documents.length, avgLength: documents.reduce((sum, document) => sum + document.length, 0) / (documents.length || 1), termDf: new Map() };
  indexCache.set(corpus, index);
  return index;
}

const idf = (size, count) => Math.log(1 + (size - count + 0.5) / (count + 0.5));
function phraseFrequency(index, phrase) {
  if (!index.termDf.has(phrase)) index.termDf.set(phrase, index.documents.filter(({ fields }) => fields.some(([field]) => field.includes(phrase))).length);
  return index.termDf.get(phrase);
}
function phraseScore(document, phrase, index) {
  const weights = document.fields.filter(([field]) => field.includes(phrase)).map(([, weight]) => weight);
  return weights.length ? idf(index.size, phraseFrequency(index, phrase)) * (Math.max(...weights) + (weights.length > 1 ? 0.45 : 0)) : 0;
}
function bm25(document, queryTokens, index) {
  let score = 0;
  let matched = 0;
  for (const token of queryTokens) {
    const frequency = index.df.get(token) || 0;
    const tf = document.tokens.get(token) || 0;
    if (!tf || frequency / index.size > 0.25) continue;
    score += idf(index.size, frequency) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * document.length / (index.avgLength || 1)));
    matched += 1;
  }
  return { score, matched };
}

export function retrieveEntries(corpus, question, { limit = 6 } = {}) {
  const count = Number.isFinite(limit) ? Math.min(6, Math.max(0, Math.floor(limit))) : 6;
  if (!count || !corpus?.chapters?.length) return [];
  const query = normalize(question).trim();
  if (!query || unsupported.some(pattern => pattern.test(query))) return [];
  const index = makeIndex(corpus);
  let intents = topics.filter(item => item.query.test(query));
  // “孩子感冒”“老人跌倒”中的人群是条件，不应冲掉病症/处置主题。
  if (intents.some(item => !item.background)) intents = intents.filter(item => !item.background);
  // 广义词只提供上下文，不与其更具体的子主题争夺有限的引用名额。
  const specificParents = [['saving', ['emergency-fund', 'subscription', 'mobile-plan', 'shopping']], ['investing', ['fund']], ['debt', ['credit-card']], ['infant', ['infant-fever', 'infant-sleep']], ['doctor', ['chronic', 'hypertension', 'diabetes']], ['learning', ['training']], ['time', ['learning']], ['travel', ['study-abroad', 'overseas-work']], ['resignation', ['unpaid-wage', 'work-injury', 'social-insurance']], ['renting', ['deposit']], ['pregnancy', ['prenatal-check', 'infant-fever']], ['overtime', ['overtime-pay']], ['sleep', ['nap', 'infant-sleep']], ['bank-card', ['card-misuse']], ['divorce', ['domestic-violence']], ['website', ['password', 'password-reuse', 'privacy', 'lost-phone']], ['password', ['password-reuse']], ['fraud', ['fraud-response']], ['work-injury', ['work-injury-claim']]];
  for (const [parent, children] of specificParents) if (children.some(id => intents.some(item => item.id === id))) intents = intents.filter(item => item.id !== parent);
  const cleaned = query.replace(/请告诉我|请问|帮我|我最近|最近|总是|怎么办|怎么|如何|怎样|这个问题|这本书|明天|今天|有什么|有没有|我想|想要|建议|方法|办法|可以|应该|值得|需要/g, ' ');
  const queryTokens = new Set(grams(cleaned).keys());
  const lists = [];
  if (intents.length) {
    for (const intent of intents) {
      const candidates = [];
      for (const document of index.documents) {
        if (!intent.chapters.has(document.entry.chapter)) continue;
        const childOnly = [20, 30].includes(document.entry.chapter) || /^(?:孩子|儿童|婴儿|新生儿|未成年人|让孩子|教孩子)|^不满.*(?:孩子|婴儿)|^给.*(?:孩子|儿童)/.test(document.entry.title);
        if (childOnly && !/孩子|儿童|婴儿|新生儿|未成年|宝宝|小孩|学生|儿子|女儿|个月|育儿|怀孕|分娩|生育/.test(query) && !['infant', 'pregnancy'].includes(intent.id)) continue;
        const mainFields = document.fields.slice(0, 2);
        if (!words(intent.require || intent.terms.join(' ')).some(term => mainFields.some(([field]) => field.includes(term)))) continue;
        const direct = words(intent.direct || '').filter(term => query.includes(term));
        if (direct.length && !direct.some(term => mainFields.some(([field]) => field.includes(term)))) continue;
        const matches = intent.terms.map(term => {
          const phrase = normalize(term).replace(/\s+/g, '');
          return phraseScore(document, phrase, index) * (query.includes(phrase) ? (document.fields[0][0].includes(phrase) ? 2 : 1.45) : 1);
        }).filter(Boolean).sort((a, b) => b - a);
        if (!matches.length) continue;
        const lexical = bm25(document, queryTokens, index);
        let score = matches[0] + (matches[1] || 0) * 0.4 + (matches[2] || 0) * 0.15 + Math.min(lexical.score, 20) * 0.45;
        if (intent.prefer && words(intent.prefer).some(term => document.fields[0][0].includes(term))) score *= intent.id === 'saving' ? 1.8 : 1.25;
        if (intent.id === 'stress' && !/工作|上班|职场|加班/.test(query) && document.entry.title.includes('工作时间')) continue;
        if (intent.id === 'falling' && /跌倒|摔倒|摔跤/.test(query) && /怎么办|怎么做|先做|刚|倒在|能不能扶/.test(query) && document.entry.chapter === 13) score *= 2;
        // 仅在备注中提到该概念的“见别章”已在 mainFields 门槛排除。
        if (score >= 6) candidates.push({ entry: document.entry, score });
      }
      candidates.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id, 'en', { numeric: true }));
      if (candidates.length) lists.push(candidates.filter(item => item.score >= Math.max(6, candidates[0].score * 0.28)));
    }
  } else {
    // 词典外问题仍可用 BM25；至少两个低频原词命中，而且不能只有备注。
    const candidates = [];
    for (const document of index.documents) {
      const { score, matched } = bm25(document, queryTokens, index);
      const titleMatches = [...queryTokens].filter(token => document.fields[0][0].includes(token));
      const titleCoverage = titleMatches.length / Math.max(1, queryTokens.size);
      if (matched >= 2 && titleMatches.length >= 2 && (titleCoverage >= 0.3 || titleMatches.length >= 4) && score >= 10) candidates.push({ entry: document.entry, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id, 'en', { numeric: true }));
    if (candidates.length) lists.push(candidates.filter(item => item.score >= Math.max(10, candidates[0].score * 0.45)));
  }
  // 每个明确主题先获得一个位置，再轮流补充，避免多主题问题被单一词占满。
  const selected = new Map();
  for (let round = 0; selected.size < count && lists.some(list => list.length > round); round++) {
    for (const list of lists) {
      if (list[round]) selected.set(list[round].entry.id, list[round].entry);
      if (selected.size >= count) break;
    }
  }
  return [...selected.values()];
}
