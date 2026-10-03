# better-life 开发约定

- 简体中文；产品定位是「人生工具箱」，优先手机体验、具体场景和低门槛使用。
- 纯静态 HTML/CSS/JavaScript，Node 22+ 构建，不引入无必要的框架或服务。
- library/ 是上游快照，正文未改写。修改其中内容前完整阅读 library/AGENTS.md 和 library/CLAUDE.md。
- 不把尚未实现的在线 AI 问答和 Obsidian 导出写成可用功能。
- 新增产品功能运行 npm run check；生成数据不手工修改。
- 不提交密钥、个人数据和运行日志；用户收藏只保存在浏览器。
