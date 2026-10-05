# 第二版设计验收：隐藏面向用户的编辑分级

## 本轮局部改动（2026-10-03）

- 用户圈选：`C:\Users\PC\AppData\Local\Temp\codex-clipboard-08b1994a-d6f5-44dc-9ae0-6fdc603d6393.png`，要求移除普通用户不需要理解的 A/B/C 等级。附件包含应用边框，未以外框测量网页布局。
- Source visual truth / implementation：`output/playwright/grade-before-desktop.png` 和 `grade-after-desktop.png`，均为 1435 × 1096、deviceScaleFactor 1；同一次工具输入查看前后截图，无密度归一化。首屏、图片、字体与暖珊瑚配色保持原样。
- Focused comparison：`grade-before-controls.png` 与 `grade-after-controls.png` 同次查看。原等级选项移除，仅保留「全部建议 / 不花钱 / 我的收藏」；旧链接不再暗中筛选等级，章节 5 完整返回 44 条，而不是旧 B 级的 10 条。
- 完整检索视图：`grade-after-search.png`，1435 × 1096；移动：`grade-after-mobile.png`，390 × 844。均实际查看，移动筛选不溢出、原列表和章节选择保留。README 检索截图同步更新。
- 阅读内容与 AI 引用卡片不展示等级，但保留研究限制、适用条件、成本、收益与出处；原始 650 条内容及分级数据不改。`readerText` 仅清理编辑分类用语，不删除安全条件或把不确定性说成确定。

### 验收与迭代记录

- Fonts / spacing / colors / assets：复用现有字号、间距、白底、珊瑚色和 Aceternity Tabs，不重设计周边布局、不生成新图。
- Copy：仅将编辑分级从用户界面移除，阅读工具栏改为「阅读建议」，逐字原文仍由「章节原文」核对。
- 初次浏览器检查因开发服务器重启期间资源连接重置而超时；刷新后重新完整验收，不将超时当作通过。
- Playwright CLI **16 / 16**：旧链接清理、完整结果、原始数据、三选项、不花钱、重置、搜索、阅读条件、原文、收藏、手机无溢出、模拟 AI 答案与原文弹层、无 pageerror。
- AI 界面验收使用故意含 B 级字样的模拟接口响应；本轮不调用付费模型，不能据此宣称真实模型质量已验收。
- `npm run check`：**46 / 46** Node 测试通过，构建成功；650 条白话及 797 处引用检查通过。新增测试验证旧筛选状态不会影响结果，显示文本不丢关键数字或安全条件。
- [P2，已修] 手机阅读区标题因 border-width 把四边设成黑框；限定为 border-left-width，保持原珊瑚左边线。重新构建、46 项测试和移动截图检查通过。无本轮待修 P0/P1/P2，未推送或部署。

本轮局部 UI / 回归验收 final result: passed

---

# 第二版设计验收：首屏书本问答迭代

## 本轮局部改动（2026-10-03）

- 用户视觉指示：`C:\Users\PC\AppData\Local\Temp\codex-clipboard-d4b27a97-485f-4d29-8a41-179aa698c7a1.png`，圈出原「查一查」按钮，要求改为结合书中内容的大模型提问。该图含 Codex 应用外框，2559 × 1527 原始像素，不以应用外框测量站内布局。
- Source visual truth（周边样式）：`C:\Users\PC\Documents\Codex\2026-10-03\new-chat\outputs\better-life\output\playwright\redesign-desktop-final.png`，用户已认可的第二版实装，1435 × 1096。原选定设计仍为 `C:\Users\PC\Documents\Codex\2026-10-03\new-chat\outputs\design-options\02.png`。
- Implementation full-view：`C:\Users\PC\Documents\Codex\2026-10-03\new-chat\outputs\better-life\output\playwright\qa-home-desktop.png`，1435 × 1096 CSS / 像素，deviceScaleFactor 1。移动版 `qa-home-mobile.png`，390 × 844。同一工具输入并列查看旧版/新版首页；完整视图对比标题、背景、导航、三张场景图与阅读区。无额外密度归一化。
- Focused evidence：同目录 `qa-answer-desktop.png`（806 × 583，答案面板）、`qa-answer-mobile.png`（390 × 844，答案状态）、`qa-unconfigured.png`（1435 × 1096）。问答是本轮新增状态，没有旧版对应答案图；按现有白底/暖珊瑚/原文阅读体系延伸。
- State：空问题首页；未配置真实错误；**模拟接口答案**和依据阅读。截图中的答案是测试 fixture，不是真实 DeepSeek 输出，运行页面不包含默认假回答。

### Findings / iteration history

- [P1，已修] 旧开发服务器缓存了临时的请求 URL，导致同源 POST 被 CORS 拒绝。保留真实 Host、在异常捕获内创建 URL，并重启本任务旧预览；真实浏览器 POST 现在返回准确的未配置 503，不是 403。
- [P2，已修] 第一轮答案的 Tracing Beam 起点覆盖段落首字。只将问答光束位置移到左留白，最新桌面/手机截图同次查看确认无遮挡；DOM 检查 marker.right < intro.left，两个 viewport 均通过。
- 无其他待修 P0/P1/P2。新增模型说明、隐私说明和示例提问使下方内容自然下移约 92px，是本轮提问流程的明确变化；未改标题、导航、图片、场景结构或原文检索布局。

### 五项必检与功能验收

- Fonts：原大标题字体、字重、两行结构不变；问答段落 16px / 手机 15px、约 1.9 行距，长问题可换行，引用不截断主要标题。
- Spacing：原 806px 宽首屏输入、珊瑚 CTA 与外围排版保持；答案面板留白、引用与来源分区清晰；390px 无横向溢出。
- Colors：继续沿用现有 white / coral / muted tokens；空问题按钮禁用有较低 opacity；没有新造渐变或图片。
- Assets：所有既有生成摄影、背景、字体与图标保持；问答使用 Aceternity 输入/按钮/Tracing Beam/Expandable Card 与 Tabler 图标，无新 UI 套件。
- Copy：首屏「问一问」与自然语言问题；「查看指南」仍是关键词检索。真实未配置状态明确可见，不把 AI 整理冒充原书逐字回答，也不宣称政策实时核验。
- Playwright CLI：**19 / 19**（提问、空问题、真实未配置、模拟答案、逐项原文引用、桌面/手机光束、来源弹层、停止、保留问题、非法响应、资料不足、示例填入、原检索保留、响应式、pageerror）。无运行时 pageerror；控制台中预期的未配置 503 单独记录，不伪称所有失败请求都不存在。粒子 canvas 已设置 willReadFrequently，消除读回性能警告。
- `npm run check`：**35 / 35** Node 测试、650 条白话检查和 797 处引用检查全部通过。Node adapter 的伪造转发 IP、异常 Host、Pages API 前缀及 Worker 非 SPA API 路由均已测试。

### 实际接通边界

服务端 DeepSeek 调用、书内检索与引用校验代码已完成，**未配置 API Key，没有真实模型回答验收，也未部署后端/发布 Pages**。模拟上游测试不证明语义质量。正式接通后仍需真实问题逐项核对引用支持情况；现有内存限流不等于正式防刷系统。配置说明在 `docs/QA-SERVICE.md`。

本轮局部 UI / 接口代码验收 final result: passed

---

# 第二版初始实现验收（保留历史）

## 比较目标与证据

- Source visual truth: C:\Users\PC\Documents\Codex\2026-10-03\new-chat\outputs\design-options\02.png
- Implementation: C:\Users\PC\Documents\Codex\2026-10-03\new-chat\outputs\better-life\output\playwright\redesign-desktop-final.png
- 桌面同一 viewport / pixels: 1435 × 1096，deviceScaleFactor 1，无浏览器边框、无需密度归一化。
- State: 首页、空查询、正文已加载、搜索可用、动画稳定；源码和最终截图在同一次工具输入中并列查看，非凭记忆评价。
- Full-view comparison: 上述 source 与 implementation。
- Focused comparison: output/playwright/source-hero-detail.png 与 implementation-hero-detail.png，来自相同 x310/y130、815×395 区域；同次输入比较标题、字号、搜索框、图标、CTA 和统计文案。
- Mobile: output/playwright/redesign-mobile.png（390×844），另有 redesign-mobile-reader.png；移动版无独立参考，按所选桌面设计的响应式延展验收。
- Search: output/playwright/redesign-search.png。
- Browser: IAB 连接超时；用户明确同意改用 Playwright CLI。开发与生产预览均实际打开，不把构建成功替代浏览器验收。

## Findings / comparison history

### 第一轮：blocked

- [P2] 首屏垂直节奏偏长：场景和阅读区比 source 下移约 23px，阅读区标题下的卡片再多移约 12px。调整第二行标题 line-height、subtitle margin、阅读区标题 line-height 和 padding；最终截图场景 y560、阅读区约 y786，与 source y560/y784 对齐。
- [P2] 缺失阅读区右上手写便笺。独立生成 reading-note 并实装，不用 CSS/SVG 替代。
- [P0] 搜索提交出现局部变量 value 的 TDZ 异常。改为 submittedValue，Enter 和点击的实际检索均重新通过。
- [P0] fixed 阅读弹层受 main stacking context 限制，导航拦截关闭按钮。以 Portal 挂载到 body；手机、桌面、单条深链接、Escape 和显式关闭重新通过。

### 第二轮：blocked

- [P2] 390px 下背景手写 slogan 与导航品牌重叠。只在手机将背景位置下移 50px；最新 mobile 截图显示 slogan 与导航、标题均分开。
- [P2] 阅读光束起点覆盖标题第一字。将阅读边距内的 beam-track 移到文字之外，reader-scroll 设 relative，并绑定其实际滚动容器。最新手机截图及 DOM 边界检查确认 marker.right < heading.left；生产浏览器无相关 warning。
- 生产预览的 /better-life/ base 未与 build 对齐，资源 404。修正 preview 配置并重启，实际生产目录资源、图片、搜索和深链接重新通过；此项是功能验收，不伪称视觉迭代。

### 最后一轮：passed

已重新打开 source / desktop 截图及 hero 细节图，在同一输入中对比；再查看手机首页与稳定后的阅读窗口。无待修 P0/P1/P2。

## 五项必检

- Fonts / typography: 标题为自托管 Noto Sans SC 900 字形子集，两行黑/珊瑚色，保持强标题层级。正文与操作文字为系统中文字体；阅读 17–18px（手机长文 16–17px）、舒适行距。不挤压长标题，结果摘要可截断，展开窗口显示完整内容。
- Spacing / rhythm: 同尺寸比较三列、首屏搜索、场景高度 208px、边距 80px、阅读区、圆角、背景和层级。修复上述垂直漂移；手机场景改为单列、检索控件换行，无水平溢出。
- Colors / tokens: 白底、黑字、coral #ff4b43、柔和暖色 raster 背景、低强度阴影。标题第二行采用统一珊瑚色而非 source 的红橙过渡，作为可接受 P3 品牌统一差异；没有新造渐变插画。
- Image / assets: 三张生活摄影、背景绿植/手写、B 标志、阅读便笺都为独立 Image Gen 图片；WebP 交付共约 196KB，不以整张设计图代替页面。正确主题、裁切、光线和高清度；图标用 Tabler，不自画 SVG。Tracing Beam 的 SVG 是官方组件本体。
- Copy / content: 保持标题、标语、场景与主动作。首页离职示例改为能与真实正文对应的“准备离职，哪些材料先留下？”，避免概念图里未对应章节的社保泛化文案。650 条/34 主题是实际快照；原文、出处和证据等级不改，无虚构评价或已上线 AI 问答。

## 功能与检查结果

- Playwright 浏览器 23 项通过：首屏搜索、Enter、分页、阅读、成本/出处、收藏反馈、Escape、收藏筛选、刷新持久化、空结果、重置650条、加载24条、A级428条、免费筛选、章节19/18条、旧单条链接、手机无溢出、手机菜单、手机搜索/关闭、加载失败、禁用状态、重试、减少动态效果、无运行时异常。
- 生产 /better-life/ 路径：实际资源和图片加载、检索、单条深链接、阅读关闭通过；额外检测无 pageerror、无 console error/warning。
- npm run check: 12 个 Node 测试、650 条白话规范、797 处交叉引用全部通过。npm audit: 0 vulnerabilities。
- 特意注入的 HTTP 503、开发 HMR 修复过程和减少动画提示记在旧 console 日志中；不把这些冒充最终正常场景错误。最终生产复验独立收集 error/warning，均为空。
- 未部署到远端，GitHub Pages 线上仍是旧版。外部 PDF/EPUB/HTML 入口保留原作者地址，本轮不宣称重新下载完整文件。

## Follow-up Polish

- P3：标题颜色过渡及字体的数像素宽度差异，可按用户反馈微调。
- P3：系统中文正文在不同设备的字形有少许差异；后续可考虑自托管完整字体，但要权衡下载体积。
- 尚未全面测试 200% 浏览器缩放或每个外部出处可用性；不影响本轮核心路径。

## Implementation checklist

- [x] source 与同 viewport 原型全景及细节实际比较。
- [x] 修复全部 P0/P1/P2 并再次捕获。
- [x] Aceternity 组件、真实数据、所有图片实装。
- [x] 桌面、手机、生产 base、交互、异常状态实际验证。
- [x] 保留运行中的本地预览；线上发布等待用户决定。

final result: passed
