# 首页知识展示设计验收

final result: passed

## 视觉目标与证据

- 用户选择本轮第 1 张视觉稿：docs/image-assets/homepage-knowledge-selected.png，817 × 1925 px。
- 本地实现：http://127.0.0.1:4180/，桌面 CSS viewport 1440 × 1000，deviceScaleFactor 1；截图内容宽 1425 px（15 px 滚动条），整页 3444 px。
- 整页对比：output/playwright/knowledge-design-comparison.png。源稿与实现分别等比例缩至 720 px 宽后并排，未拉伸或改变比例。
- 桌面最终截图：output/playwright/knowledge-home-desktop-final.png。
- 图谱局部并排对比：output/playwright/knowledge-map-comparison.png；最终局部截图 knowledge-map-final.png。
- 问答局部：output/playwright/knowledge-answer-final.png；下载摄影细节：knowledge-book-desktop.png。
- 手机：390 × 844 CSS viewport，output/playwright/knowledge-home-mobile-final.png。
- 平板：840 × 1000 CSS viewport，output/playwright/knowledge-home-tablet-final.png 与 knowledge-map-tablet-final.png。
- 默认状态：未展开检索、押金条目预览、折叠的回答示例、下载区图片已加载。附加状态：34 主题展开、主题切换、图谱缩放/重置、原文弹窗、完整示例展开、实时模型回答、手机菜单。

## 比较记录与修复

1. 初次桌面截图 knowledge-home-desktop.png：
   - [P2] 图谱原文卡挡住健康主节点。上移卡片并扩大主节点；knowledge-map-comparison.png 显示四个主节点均可见。
   - [P2] 图谱最低条目越出绘制范围。把逻辑视图高度从 760 调整到 820，数据覆盖测试检查全部节点坐标位于视图内。
   - [P2] 问答展示正文过小。桌面正文从 12 调为 14 px，步骤标题从 14 调为 16 px；knowledge-answer-final.png 显示清晰层级。
   - 初次整页截图下载图为空：是原生 lazy image 尚未进入视口的捕获问题；滚动加载、decode 后重新捕获，书页完整可见。
2. 手机截图发现固定导航和焦点入口位置受截图时滚动状态影响：在回到顶部且滚动动画稳定后重新捕获。最终截图导航位于顶部、无意外焦点入口覆盖。
3. 平板初次预览卡遮住主节点：[P2] 将 768–1100 px 宽度的预览卡放到图谱下方，保持缩放控件可见。knowledge-map-tablet-final.png 显示四主题完整露出，无覆盖。
4. 复核最终整页并排和局部证据：无剩余 P0/P1/P2。

## 必查视觉表面

- 字体：保留自托管 LifeDisplay / Noto Sans SC 900 首屏字体及中文系统回退；新标题 52 px / 43 px / 34 px 分级，黑色重标题、珊瑚红首屏与按钮延续源稿。展示区桌面正文 14 px；实时问答手机正文在后续优化中统一提升到 14 px。大图不烘焙实际网页按钮或标题。
- 间距与布局：保留首屏与三张照片；下方为宽幅图谱、左右错开的真实问答界面、全宽书页摄影。手机改为纵向预览和独立原文卡，平板避免卡片压住主节点；未出现横向溢出。
- 颜色：白、暖中性色、#ff4b43 主色，绿/橙/蓝/浅黄图谱分组。选中节点与真实连接使用珊瑚高亮；控件保持既有 Aceternity 样式。
- 图片：保留已选首屏、场景图片。下载摄影独立生成，1774 × 887 的原图压缩为 153 KB WebP，不从整页截图裁图、不拉伸。书页中的排版为场景示意，真实 PDF/Vault 通过实际下载按钮提供。Canvas 是真实 650 条目、34 主题、490 个条目引用的数据视图，不是替代摄影/插画的装饰绘图。
- 文案：短标题、少量操作文案；不重新加入用户移除的技术介绍、等级或免责声明板块。图谱节点与弹窗保留原书文本；示例由真实本机 DeepSeek 请求产生并经过引用校验，明确标为“回答示例”。

## 功能验证

- 主题切换、34 个主题展开、放大/恢复、节点对应原文阅读、Escape 关闭并返回焦点。
- 检索全部 650 条、搜索押金、打开对应原文。
- 示例完整展开/收起、示例问题在首屏直接发起提问、聚焦提问框。
- 浏览器真实提交离职问题，获得答案和可打开的原书引用；答案引用同步到图谱选中状态。
- 手机菜单开关；390 px、840 px 无横向溢出。键盘主题入口、原文按钮、弹窗焦点循环沿用已有组件；尊重减少动画设置。
- 浏览器控制台 0 errors / 0 warnings。
- npm run check：48 项测试通过，650 条原文显示检查通过，797 处引用检查通过。

## 接受的真实数据差异与后续细节

- 图谱布局根据真实章节归属与原书条目引用生成，形态随所选条目变化；不照抄概念图里虚构的跨租房/消费连线。
- 问答文字、来源标题采用经过验证的真实回答与原文，和概念稿的简写示意不同。
- 保留现有首屏，不添加稿中仅为演示的“关于”新路由；所有内容来源集中在已有内容来源页面。
- [P3] 下方两处手写装饰未额外加入；不影响主要图谱、问答和摄影视觉。

实施检查完成：资源真实、主要交互可用、桌面/手机/平板布局通过。

## 2026-10-03 自主优化复验

final result: passed

- 新整页截图：output/playwright/optimization-home-desktop.png（1440 × 1000 viewport，1425 × 3444 截图）、optimization-home-mobile.png（390 × 844 viewport，375 × 3726 截图）、optimization-home-tablet.png（825 × 1000 viewport，810 × 3577 截图）。15 px 差异来自测试浏览器滚动条，不是页面溢出。
- 新同宽并排：output/playwright/optimization-design-comparison.png；原稿与实现各自等比例缩到 720 px 宽，没有拉伸。图谱保留真实数据形态，问答保留真实回答内容，摄影和品牌层次与选稿一致。
- 图谱局部证据：graph-polish-desktop.png、graph-polish-mobile.png；实时问答手机证据：qa-polish-mobile-final.png、qa-polish-source-mobile.png。新增状态：全部相关条目、上一条/下一条、缩放后选中节点重新定位、触屏滚动不误选、加载失败重试、问答取消即重试与新问题替代旧请求。
- 原文分享、复制失败的可选链接、收藏、直接链接、返回/前进由独立审阅再次复核通过；正常访问无残留 P0/P1/P2。
- 生产根域构建实测：首页不请求会员或个人指南路由包，进入对应页面时才加载；手机登录弹窗仍可打开。故意阻断路由包后显示“重新加载”，恢复网络并重试可打开，截图 optimization-route-retry.png。
- 默认 `/better-life/` 生产构建实测：图片、字体、正文和图谱请求均保留部署前缀；Vault 返回 200，原文分享链接、会员页和个人指南页均保持该子路径。独立预览进程验证后已关闭，原有 4180 预览保留。
- npm run check：106 项测试通过；650 条白话检查与 797 处原文引用检查通过。后续路由容错与开发入口调整又完成生产构建和浏览器验证。
- 主 JS 从 521.29 KB 降到 478.28 KB（gzip 164.52 → 153.14 KB），个人指南 CSS 21.86 KB 改为进入页面后加载。
- 生产预览的会员服务未配置时返回 503，界面按既有服务约定展示未开放状态；不将此预览当作已发布、可登录或可付费的在线服务。故障注入的网络和异常日志属于预期测试输出。

## 2026-10-03 私人指南、会员与 Pricing 验收

final result: passed（本地单实例 MVP；不是正式商业上线）

### 范围与视觉依据

- 保留已选二版首页及本轮首页图谱视觉；新增个人目录、私人指南编辑、个人情况、会员弹窗和 Pricing，复用现有 Aceternity Navbar/Bento/Input/Label/展开组件。没有引入第二套 UI 库，也没有重新设计首页。
- 来源视觉与新增路由并非同一页面，比较的是同一品牌体系：暖白、珊瑚色、中文重标题、真实工作/住房摄影、宽留白与明确主按钮；不声称新路由是源稿像素级复制。
- 桌面 CSS viewport 1435 × 1096，手机 390 × 844，deviceScaleFactor 1；截图正文宽 1420 / 375 px 是浏览器 15 px 滚动条。不同整页长度保留原比例，未拉伸。
- 本机预览 http://127.0.0.1:4190/；本机账号真实持久化。Pricing 0/19/129 为套餐真源的当前实验价格，真实购买关闭。

### 截图与人工复核

- Desktop：output/playwright/membership-pricing-desktop.png、personal-directory-desktop.png、personal-editor-desktop.png、personal-profile-desktop.png、personal-draft-desktop.png、personal-guest-desktop.png、personal-empty-desktop.png。
- Mobile：membership-pricing-mobile.png、personal-directory-mobile.png、personal-editor-mobile.png、membership-checkout-mobile.png、membership-account-mobile.png、personal-save-answer-mobile.png。
- 实际打开桌面/手机截图检查：标题与正文层级、按钮辨识、表单边界、主题卡片、个人情况与行动视觉分离；390 px 无横向溢出。
- [P2 修复] 手机 Pricing 原标题行尾只剩“南。”，改独立 span 均衡换行并保持原文；最终截图无孤立尾字。
- [P2 修复] 个人目录摘要原来露出 ##/###，改安全纯文本摘要；正文编辑仍保留 Markdown，数值条件不被删掉。最终两端目录截图无格式噪声。
- 初次弹窗截图恰好处在进入动画，表现半透明；改为等待 opacity=1 后重新捕获，最终白底弹窗内容清晰可读。长页捕获时固定导航/键盘焦点可能随测试滚动位置出现，并非替换静态布局的设计稿。
- 独立审阅发现跨账号旧响应污染界面的竞态，已修 owner/abort 双检查；回归测试覆盖 A 退出、B 登录后旧 guide/profile/delete 响应不更新 B 的 UI。
- 最终已查看稳态 Pricing/目录/编辑/会员/订单截图，无残留阻断性的 P0/P1/P2 视觉问题。

### 实际浏览器流程

- 显式本机登录 → 创建真实指南 → 编辑 → 新增/勾选行动 → 刷新仍保存 → 搜索和主题筛选。
- 主动确认个人情况；继续问仅选择本次情况，未选择项不发送。
- AI 更新稿先展示，确认前数据库正文不变；任务完成状态保留；生成后手动改过指南，旧草稿被拒绝覆盖。
- 确认采用更新稿生成真实新版本；查看与恢复历史，恢复另建版本；导出真实 Markdown 下载，核对正文、勾选任务、关联事实和原书来源快照。
- 首页回答新建指南、追加已有指南；保留旧正文和旧任务进度。手机未登录点存档，完成真实本机登录后待保存回答仍保留。
- 手机会员/订单弹窗处于视口内，Tab 保持内部焦点，Escape 关闭且返回触发按钮；没有邮件时明确“未开放”，没有支付适配器时按钮禁用，直调订单接口返回 503，不产生伪订单或付费权益。
- 私人目录的假 SQLite 路径（含大写目录）返回 403；没有下载真实数据库、密钥或环境文件。
- 原检索、主题、不花钱、旧 grade 链接去筛选及免费 Obsidian ZIP 下载回归通过。
- 最后仅清理本轮 2 篇有明确 ID/名称的测试指南及 1 项测试情况；保留账号和其他资料，不删除数据库。再次确认真实额度 used=0、订单为空。

### 验证性质与完整检查

- 浏览器 CRUD、登录、版本、导出与订单拒绝使用真实本机 API/SQLite；浏览器问答回复为明确注入的模拟数据。新个人上下文的模型链路通过注入单测，不把模拟回复说成新一轮真实 DeepSeek 调用。
- 稳定完整流程 pageerror=0，最后弹窗/登录流程 warnings=0。早期开发 HMR 重复 root 提示已修复并有回归测试；主动验证未配置支付的 503 是预期拒绝，不隐瞒为全请求成功。
- 最新 npm run check：122/122 测试通过；650 条白话检查零不合格，797 处引用检查通过；生产构建通过。
- 主包 479.65 KB / gzip 153.55 KB，Pricing 10.39 KB、个人指南 36.84 KB + 21.86 KB CSS 按路由加载，无 500 KB chunk 警告，未放宽警告阈值。
- SQLite 运行时有 experimental 提示，当前范围是单实例本机 MVP；正式邮件、商户支付、公网发布、运营后台界面、备份与密钥轮换仍需完成正式接通，不是本次已上线能力。

## 2026-10-03 手机号、邮箱与会员衔接

- 登录弹窗新增大陆+86手机号和邮箱两种验证码方式，沿用现有Aceternity输入/按钮；无配置时对应发送按钮禁用，不伪造成功。验证码6位，60秒重发冷却，切换身份清空验证码并中止旧请求。
- 正式账号可在当前会话中验证并绑定另一联系方式；共用同一用户ID、免费/付费权益、已用额度和指南。已有两个账号不自动合并，本机体验不能转为正式身份。
- 增加腾讯短信TC3签名发送适配器、全局日发送预算；Resend要求正确成功ID，HTTP200业务错误/坏JSON/发送失败均关闭并撤销验证码。供应商接受请求不等于用户实际收到验证码。
- 新增同源Node静态+API服务器（npm run serve），只托管dist/client，私人文件/外部软链接拒绝；受信代理IP须明确配置且覆盖X-Real-IP，默认不相信客户端代理头。
- 修复退出登录动画期间空me.user访问；保留登录后的原套餐确认意图和主动保存意图。
- 手机390×844与桌面1435×1096浏览器模拟通道：双方式、错误码、冷却、切换、绑定同账号/同10次额度、刷新、退出及套餐意图20项断言通过，pageerror=0。截图output/playwright/auth-phone-mobile.png、auth-bound-desktop.png已实际查看。
- 完整npm run check通过（当时166项），随后严格Resend新增3项，最新npm test为169/169；生产构建成功，650条白话零不合格、797引用通过。未改原书或个人数据库测试数据。
- 修复Sites发布包漏复制shared/qa-notice.mjs，新增临时全新包真实import测试；不把原公共问答Worker说成会员已部署。
- 当前真实4190接口：emailLoginAvailable=false、phoneLoginAvailable=false、localDemoAvailable=true、checkoutAvailable=false；未配置手机/邮箱发码实际返回503，不产生真实发送。
- 外部待办仍为邮件密钥/验证发件域、短信账户/签名/模板/密钥、HTTPS主站与持久数据部署、商户支付适配器和真机收码/付款验收。已新增docs/LOGIN-SETUP.md和不泄密、不发短信的npm run auth:status。以上mock不等于真实上线。
