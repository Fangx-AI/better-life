# Aceternity 组件来源与适配

用户在 2026-10-03 选定第二版设计：大标题、暖色背景、首屏搜索、三张场景卡和展开阅读。网站不使用其他 UI 套件。

## 实际采用的公开组件

| 产品区域 | 官方组件 | 适配 |
| --- | --- | --- |
| 桌面 / 手机导航及按钮 | [Resizable Navbar](https://ui.aceternity.com/components/resizable-navbar) | 品牌、滚动收窄宽度、手机菜单、中文按钮 |
| 首屏提问 | [Placeholders And Vanish Input](https://ui.aceternity.com/components/placeholders-and-vanish-input) | 问一问、500 字自然语言问题、加载/停止/重试、保留问题、IME 与减少动画支持 |
| 场景入口 | [Bento Grid](https://ui.aceternity.com/components/bento-grid) | 原始布局与 hover 模式；语义 button、真实场景配图 |
| 原文阅读 | [Expandable Card Standard](https://ui.aceternity.com/components/expandable-card) | 原始 shared-layout 展开模式接真实条目；Portal、焦点循环、Escape、关闭按钮 |
| 阅读光束 | [Tracing Beam](https://ui.aceternity.com/components/tracing-beam) | 原始 SVG 滚动光束；内容尺寸观察、唯一 gradient ID |
| 问答与原文依据 | [Tracing Beam](https://ui.aceternity.com/components/tracing-beam) / [Expandable Card](https://ui.aceternity.com/components/expandable-card) | AI 答案逐项关联真实条目；引用可打开原文，不使用 HTML 渲染模型输出 |
| 筛选 | [Tabs](https://ui.aceternity.com/components/tabs) | 保留 Motion layoutId / spring 选择指示；仅全部建议、不花钱、我的收藏，不向用户展示编辑分级 |
| 结果搜索字段 | [Input / Label](https://ui.aceternity.com/components/signup-form) | 官方输入、label；主题选择为原生语义 select，不另引下拉库 |

原始 registry JSON 快照保存在本目录 aceternity/，便于维护者核对，不把自制仿样式称为官方组件。样式与交互已作产品适配，不声称完全未改源码。

图标来自 Tabler Icons，与 Aceternity 默认图标一致。大标题使用自托管 Noto Sans SC 900 字形子集（SIL OFL）；正文使用系统中文字体。照片、品牌 B、手写背景与阅读区手写便笺使用 Image Gen 独立生成，然后压缩成 WebP。图像不从页面截图裁出，也没有把整张设计图当网站。

只采用公开免费 registry；未购买或包含 Aceternity Pro 付费模板。Aceternity 代码保留来源，权利遵循其官方条款，不把第三方组件重新声明为本项目原创 MIT 代码。正文原有 CC BY 4.0 与署名不变。

## 首页知识展示（用户选定的第一张长页视觉稿）

- 保留原首屏和三张场景照片，新增真实知识图谱、问答示例与书桌下载大图。
- 图谱是 Canvas 数据可视化：650 条目、34 主题与 Vault 生成器同一组明确原书关联；主题布局为场景聚类，圈内节点仍保留原章节归属。不是图谱截图或虚构关系。
- 图谱的主题切换使用已有 Aceternity Tabs，缩放/重置/原文操作使用 NavbarButton，原文继续使用 Expandable Card；未新增其他 UI 库。
- 问答展示采用 Tracing Beam 内容容器和 NavbarButton，基于本机真实 DeepSeek 回答的公开示例（public/qa-example.json），来源经过 validateQaResponse 校验，主提问框继续发起实时请求。
- 书桌照片为 ImageGen 独立生成的展示资产 public/media/knowledge-book.webp，含书页与笔记本关系图示意；真实交付仍是 PDF / Obsidian Vault 下载。保留其他格式在可展开区域。
- 图谱支持鼠标拖动、缩放、节点点选，以及键盘可用的全部主题入口；小屏使用可纵向滚动的图谱预览和独立原文卡。

## 自主优化中的交互适配

- 提问框的例题点击即提交；停止后立即恢复编辑与重试，前一个请求的迟到结果不会覆盖新问题。正文先展示完整句子和前三步，其余步骤与原文依据可展开，不删适用条件。
- 图谱绘制与 Canvas 尺寸观察分离，拖动不重复创建观察器。点选范围与可见节点匹配；换主题或选中条目时重新定位，支持上一条/下一条、全部相关建议和失败重载。
- 原文弹窗增加独立收藏提示、规范分享链接及复制失败时的可选链接字段；浏览器返回、前进和直接链接均能恢复对应原文。
- 小屏图谱将预览卡与画布分行，避免遮住节点。所有操作继续使用既有 Aceternity Tabs、NavbarButton 和 Expandable Card，加载失败操作也沿用 NavbarButton。

## 独立阅读页与章节目录

- 首页保留提问、场景入口、知识图谱和问答示例，不再混排完整条款检索列表；查看指南、场景建议和原文引用统一进入 `?view=library` 阅读页。旧章节参数、`#library` 与条目分享链接仍兼容。
- 左侧章节目录基于官方公开 [Sidebar](https://ui.aceternity.com/components/sidebar) registry（原始快照 `docs/aceternity/sidebar.json`），适配已有白底与珊瑚品牌、章节名称、条目计数、当前章节状态和小屏目录入口；不另引 UI 套件。
- 搜索与筛选继续使用既有 Input、Label 和 Tabs；条款列表及原文展开沿用 Expandable Card / Tracing Beam，按钮沿用 NavbarButton。适配的是阅读导航与响应式布局，不改写原书内容、出处或用户收藏数据。
- 个人指南中的原文依据与问答失败后的“先读指南”采用统一导航 helper，确保 root 路径和 GitHub Pages 子路径均进入独立阅读页；个人指南的原文依据仍在新标签打开，避免打断未保存草稿。
