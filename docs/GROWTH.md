# Better Life：首批推广与第一方转化测量

## 当前事实与上线边界

- 已公开的 GitHub Pages 入口仍是 `https://fangx-ai.github.io/better-life/`，源码默认 canonical 保留该入口；它不等于新商业域名已选定，也不证明搜索收录。
- 新部署域名通过 `PUBLIC_SITE_ORIGIN` 明确指定，路径通过 `PUBLIC_BASE_PATH` 指定。不得用尚未购买/未部署的域名写“已上线”。
- 统计模块只提供本站匿名产品事件与日报汇总，不制造访问、不注册账号、不发推广内容、不购买流量、不调用真实验证码、付款或模型。
- 测试验证的是实现与安全边界，不是实际访问量、实际转化或 SEO 排名。首批真实数据与推广执行需要负责人明确授权并在真实部署后进行。

## 配置与验收

以下都是非敏感开关，不能替代既有生产配置与预检：

| 变量 | 默认/用途 |
| --- | --- |
| `PUBLIC_SITE_ORIGIN` | 默认 `https://fangx-ai.github.io`；仅 origin，不含账号、路径、参数或 hash |
| `PUBLIC_BASE_PATH` | 默认 `/better-life/`；根站点填 `/` |
| `PUBLIC_INDEXING_ENABLED` | 默认 `true`；隔离预演填 `false`，输出 noindex 与空站点地图 |
| `VITE_ANALYTICS_ENABLED` | 默认关闭；前端构建明确填 `true` 才发送事件 |
| `ANALYTICS_ENABLED` | 默认关闭；服务端明确填 `true` 才接收统计 |

网站与 API 必须同源；统计不能被转发到第三方。启用前先把统计用途、数据范围、保留时间及 DNT/GPC 行为写入隐私说明。关闭任一统计开关都不得影响阅读、登录、付款或提问。

开发者可在仓库根目录运行定向检查，不会读取 `.env`、会员私库，也不会调用外部服务：

```powershell
node --test tests/analytics.test.mjs tests/seo.test.mjs tests/site-base.test.mjs
```

本机无索引预演的非敏感示例：

```powershell
$env:PUBLIC_SITE_ORIGIN = 'http://127.0.0.1:4300'
$env:PUBLIC_BASE_PATH = '/'
$env:PUBLIC_INDEXING_ENABLED = 'false'
```

这些环境变量会影响下一次构建；完成预演后需删除或恢复，不能把本机 canonical/noindex 产物发布为正式站点。

## 集成接口

### React

- 在路由根节点挂载 `SiteMetadata` 和 `AnalyticsPageView`，传 `view` 枚举 `home/library/pricing/guides`。
- 行为事件通过 `useAnalytics()` 的返回函数发送：`track('download_click', { format: 'pdf', source: 'formats' })`。
- 不传事件对象、账号、订单、问题、回答、搜索词、完整 URL、referrer 或任何自由文本；该模块会剔除非白名单字段，服务端再次拒绝非法字段和值。
- 不发送由展示组件推测的“付款成功”。支付返回页只允许 `checkout_return`，实际到账另走可信服务端事件。

### 同源服务端

```js
const stats = createAnalyticsStore({ db: store.db });
const analytics = createAnalyticsHandler({
  store: stats,
  enabled: env.ANALYTICS_ENABLED === 'true',
  allowedOrigin: env.MEMBERSHIP_APP_ORIGIN,
});
// normalized /api/analytics/events, before the membership handler:
const response = await analytics(request);
if (response !== null) return response;
return membership(request);
```

`store.db` 的生命周期、持久卷、文件权限与备份由既有会员服务管理；统计模块不打开另一份私库，不查询/关联用户表，不开放公开统计报表接口。负责人只在受控后台或本机运营工具中调用 `stats.report({ from: '2026-10-04', to: '2026-10-10' })`；示例日期是调用格式，不代表已有数据。

`stats.recordServer('payment_confirmed', { plan: 'member-month' })` 仅能在既有支付校验与到账幂等逻辑确认“首次生效”后调用。模块不存订单号或用户 ID，也不自建另一套支付幂等；重复调用会重复计数，不能在每次通知或支付返回页面调用。

### 数据边界

- 默认尊重浏览器 DNT 与 GPC；服务端也尊重 `DNT: 1` / `Sec-GPC: 1`。DNT 的浏览器属性不是可靠访问控制，缺少信号不代表同意第三方广告追踪。本项目没有第三方统计。
- 只生成 128 位随机、30 分钟固定到期的 tab 会话；存在 `sessionStorage` 或当页内存，不使用持久身份 cookie、指纹、账号关联或跨站 ID。到期会换随机值，不滑动续期。
- 发送 `credentials: 'omit'` 与 `referrerPolicy: 'no-referrer'`，仅访问固定同源 `/api/analytics/events`；URL 参数/hash 不进入载荷。
- 接口限制 2 KiB、5 秒请求体、白名单事件与枚举；同一会话最多 60 次/30 分钟，服务进程最多 600 次/分钟，不记录 IP、UA、Cookie 或拒绝请求的正文。生产入口仍需全站请求限流，匿名统计不能防御所有代理/分布式刷量。
- 会话去重键到期后由下一次接收/报表读取清理，默认只保留最近 90 个 UTC 日的聚合。服务无流量时不会在后台自动唤醒；若部署方要求严格到秒清理，可由现有维护循环调用 `stats.cleanup()`，不是自动创建新的计划任务。
- SQL 表仅为 `analytics_daily`、`analytics_session_events`、`analytics_session_limits`；日报不含随机会话 ID。日报不会提供跨事件个体轨迹。

## 事件与可用指标

| 事件 | 触发位置 | 允许维度 | 含义/限制 |
| --- | --- | --- | --- |
| `page_view` | 路由挂载 | `view` | 每个路由的匿名 30 分钟会话曝光 |
| `reader_open` | 明确打开阅读页 | `source` | `navigation/hero/scene/graph/showcase` 等固定入口 |
| `download_click` | 下载链接点击 | `format, source` | 点击意图，不是下载完成 |
| `qa_submit` | 有效问题提交到接口前 | `kind` | `public/personal`；从不记录问题内容 |
| `qa_result` | 请求实际结束 | `kind, outcome` | `success/unavailable/error/cancelled`；不是回答质量评分 |
| `login_open` | 用户明确打开登录 | `source` | 打开意图，不是发送验证码 |
| `login_complete` | 真实登录返回成功 | `channel` | `email/phone`；本机体验不算正式注册 |
| `pricing_open` | 会员方案入口点击 | `source` | 查看意图 |
| `checkout_start` | 成功创建真实付款跳转 | `plan` | `member-month/member-year`；不含金额或订单号 |
| `checkout_return` | 支付返回状态读取结束 | `outcome` | 前端状态，不作为实际到账证据 |
| `payment_confirmed` | 可信首次到账回调 | `plan` | 仅服务端事件，不能由客户端提交 |

所有维度实际允许值以 `shared/analytics-schema.mjs` 为真源，不允许 UTM 值、任意渠道名字或 referrer。首批渠道可按预先排定的推广时间窗观察总体变化；不能据此声称精确归因。

首批报表每周一次，只记录汇总数字与行动：

1. 首页会话曝光：`page_view` / `view=home` 的 `session_count`。
2. 阅读打开与下载意图：对应事件次数；同一会话多个入口会落多个维度桶，**不能把各桶 session_count 相加当去重访客数**。
3. 问答请求成功率：同 kind 的 `qa_result success / 全部 qa_result`；需同时展示样本量与不可用数量，不把点击 submit 等同接口完成。
4. 登录意图与登录完成：各自次数/匿名会话桶，作为粗趋势，不是可追溯注册漏斗；会话会过期、DNT 用户不计入，同一人可多次登录。
5. 付款：可信 `payment_confirmed` 计数才算订单转换；实际收入、退款和净收入由支付账本汇总，不由前端分析数据估算。

本阶段没有账号关联或跨事件会话级报表，因而不能严谨计算“某个访客从推广到付费”的漏斗、真实新注册人数、留存或复购。不要为了完善这些指标回填账号/手机号/email。若以后确有需要，先做单独隐私与统计设计评审。

## 首批执行清单（负责人授权后，手工执行）

### 发布前

- [ ] 确认实际 HTTPS 域名、同源 API、生产预检、登录/付款可用状态与停止开关；不可用功能如实标注，不把本机模拟测试当真实功能。
- [ ] 用真实部署 URL 检查 canonical、OG 图片、robots 与 sitemap；手机和桌面分别完成“首页 → 一个场景 → 阅读 → 返回”。
- [ ] 检查 DNT/GPC 开启时浏览器 Network 中无统计请求，提问正文/账号未出现在统计载荷；检查统计失败不影响核心流程。
- [ ] 用隔离测试数据先核对日报。真实登录、模型与支付的验收需负责人批准，不在推广检查里自动触发。

### 第一周：10 位自愿试用者，而不是刷量

- [ ] 邀请 10 位认识且自愿的人，覆盖手机/桌面及“工作、省钱、住房”三类需求；不新建账号代测、不填任何虚构访问。
- [ ] 每人只做一个具体任务，如“找到离职注意事项并打开原始出处”。观察完成与卡点，不要求向产品提交私人困境。
- [ ] 反馈只记去标识的“设备类别、任务是否完成、卡在哪一步”，不保存聊天记录、手机号、邮箱或问题全文到统计/推广表。
- [ ] 达到 10 次反馈后，优先修复重复出现的阅读/提问阻碍。样本不足时继续收集，不报告稳定转化率或统计显著性。

### 第二周：两篇具体场景内容，小规模人工发布

- [ ] 准备两篇短内容，一篇“离职前先核对哪些事”，一篇“租房签约前先查哪些条件”；引用现有指南的原始出处、适用条件与限制，不把通用建议包装成专业医疗/法律/金融结论。
- [ ] 在负责人已有且允许该内容/链接的渠道手工发布，不新注册账号、不私信陌生人、不群发。先查看所选渠道当日发布规则；平台可能限制外链，不能预先承诺可贴链接。
- [ ] CTA 只用一个，例如“打开指南，按工作章节查条件与原始出处”；不诱导购买、不虚构口碑，不承诺“AI 一定解决人生问题”。
- [ ] 分开两次发布时间，记录发文时段、公开内容 URL（不存账号敏感信息）、观察期间的匿名事件变化；同期改版/其他活动同样记录，承认无法精确归因。
- [ ] 没有自然阅读增长时，先检查内容与目标任务是否匹配；不自动购买广告、不扩大刷量、不替负责人发文。

### 每周复盘

- [ ] 列出“真实样本量、成功/失败/不可用次数、主要阻碍、下一项改进”，拒绝空白当 0 或模拟当真实。
- [ ] 只安排一个可验证改动，例如缩短阅读入口或修复接口错误；下周与相同口径的汇总比较。
- [ ] 投诉、敏感信息误采、重复扣款或生产故障出现时暂停推广，并关闭统计/付款或按对应回滚流程处理。

## SEO 操作边界

- 构建生成规范链接、OG、WebSite 结构化数据、robots 与 sitemap，公开地图只有首页、阅读页与价格页；搜索词、私人指南、账号、支付返回和 hash 条款不加入地图，不伪造 `lastmod`。
- JS 路由元数据会为阅读/价格使用纯 `?view=` canonical，私人指南 `noindex,nofollow` 且无 canonical。这不是权限保护，私人内容仍必须由服务端账号权限隔离；SSR/静态响应层的私人/支付查询应同步发送 `X-Robots-Tag: noindex,nofollow`。
- robots 文件对根域名生效的位置是 `/robots.txt`。GitHub 项目路径下的 `/better-life/robots.txt` 不会自动控制 `fangx-ai.github.io` 整个域；独立根域部署与受控反向代理应正确提供根 robots。不能声称生成文件就已控制搜索引擎。
- 拥有实际部署域名后，由负责人验证站点所有权、检查 URL 并提交 sitemap；无域名控制权不创建虚假验证文件。收录、排名与展示结果由搜索引擎决定，不保证完成。
- 根域 robots 规则、站点地图与 canonical 只是爬取/规范信号，robots 不用于隐藏私密页面；Google 明确建议以认证或 noindex 控制内容公开/索引。

依据：[Google robots 文档](https://developers.google.com/search/docs/crawling-indexing/robots/intro)、[Google sitemap 文档](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)、[Google canonical 文档](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)、[MDN DNT](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/doNotTrack)、[MDN GPC](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/globalPrivacyControl)。
