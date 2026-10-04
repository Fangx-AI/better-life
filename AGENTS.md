# better-life 开发约定

- 简体中文；产品定位是「人生工具箱」，优先手机体验、具体场景和低门槛使用。
- 普通用户页面不展示原书 A/B/C 编辑分级，不设等级筛选；适用条件、限制和原始出处保留。原书数据不删不改，旧 grade 链接不得产生隐藏筛选。
- 用户选定 outputs/design-options/02.png 的白底、珊瑚暖色、大标题、首屏搜索视觉。忠实实现，不另行设计。
- 首页向下滚动的展示视觉以 docs/image-assets/homepage-knowledge-selected.png 为准（本轮用户选定第一张长页稿）：真实关系图谱、问答示例、书桌大图下载区；保留既有首屏。不要退回纯文字介绍板块。
- 2026-10-04 用户要求：具体条款与检索移到独立阅读页；桌面左侧章节目录、右侧阅读，手机可展开目录。首页只保留场景、提问、展示和阅读入口，不再堆条款列表。
- 使用 React / Vite / Tailwind / Motion，前端仍为静态 Pages，DeepSeek 问答需独立服务端；交互组件全部基于 Aceternity 官方公开 registry，不另引 UI 库。
- 官方组件原始快照在 docs/aceternity/；允许品牌、响应式、无障碍和真实数据适配，记录差异。
- 保留 Product Design starter 的 worker/、.openai/、scripts/prepare-sites-build.mjs 和 tests/sites-worker.test.mjs；Pages 发布 dist/client。
- library/ 是上游快照，正文未改写。修改其中内容前完整阅读 library/AGENTS.md 和 library/CLAUDE.md。
- 不把尚未实现的在线 AI 问答和 Obsidian 导出写成可用功能。
- 新增产品功能运行 npm run check；生成数据不手工修改。
- 不提交密钥、个人数据和运行日志；用户收藏只保存在浏览器。
- 问答服务自行检索原书并验证引用；未配置密钥、未部署后端、模拟接口测试不能宣称真实模型已接通。密钥不得使用 VITE_ 前缀。
