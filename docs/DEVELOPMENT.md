# 开发说明

普通用户直接用在线页面，不需要安装。这一页只供维护者使用。

## 本地预览

Node.js 22.12+。网站采用 React / Vite / Tailwind / Motion / Aceternity，前端构建后仍是静态文件。DeepSeek 问答与账户需要服务端，配置与部署见 [问答服务说明](QA-SERVICE.md) 和 [会员服务说明](MEMBERSHIP-SERVICE.md)。

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 4173
```

默认本地地址 http://127.0.0.1:4173/。不要双击源码 index.html。

## 检查与发布

```sh
npm run check
```

覆盖正文解析、原文保真、650 条/34 章、组合检索、收藏筛选、797 处交叉引用、白话规范及静态打包。页面交互、响应式和视觉验收另见根目录 design-qa.md。

main 推送后 GitHub Actions 用 npm ci 安装锁定依赖，构建 dist/client 并发布到原有 GitHub Pages；PR 只检查。vite 默认生产 base 为 /better-life/，开发 base 为 /。保留 Product Design starter 的 worker、.openai 和打包检查，不会自动发布到 Sites。

部署到 Sites 或其他根域时，构建与预览都设置 `PUBLIC_BASE_PATH=/`；部署到子目录时设置对应路径（必须以 `/` 开头）。下面的 PowerShell 命令只在此次构建期间覆盖环境变量，并恢复原值：

```powershell
$previousPublicBase = $env:PUBLIC_BASE_PATH
try {
  $env:PUBLIC_BASE_PATH = '/'
  npm run build
} finally {
  $env:PUBLIC_BASE_PATH = $previousPublicBase
}
```

根域构建发布 `dist/client`；Sites 打包还需生成的 `dist/server` 和 `dist/.openai`。GitHub Pages 保持默认配置。资源、图谱、Vault 和页面入口都随构建前缀变化，不在代码中写死根域。

首页不预加载会员方案和个人指南页面的代码；进入相应路由时再加载。全局账户状态与登录弹窗仍在首页可用，加载失败可以重新加载页面。

## 文件说明

普通用户只筛选主题、不花钱和收藏，不展示原书编辑等级。`src/lib/guide-filters.mjs` 忽略并移除旧链接的 `grade`，防止隐藏筛选；`reader-text.mjs` 仅清理展示中的分级字样，保留数字、限制和适用条件，不修改原数据。

- src/：产品页面与经过适配的 Aceternity 组件。
- docs/aceternity/：官方 registry 源码快照；适配说明见 ACETERNITY.md。
- public/：压缩后的 WebP、字体、SEO 文件；content.json 是生成数据，不手改、不提交。
- scripts/content.mjs、build.mjs：从 library 构建正文数据，不生成新建议。
- assets/search.mjs：可复用的关键词匹配；旧首页 assets/app.mjs 和 style.css 不再作为入口。
- library/：上游内容快照，正文不改。source.json 记录版本。
- tests/：Node 测试；output/playwright/：本地浏览器证据，不入 Git。

「查看指南」的空格分隔关键词需同时命中，不调用模型。首屏「问一问」独立调用 DeepSeek，并保留可展开的书内依据；没有配置服务时明确报错。收藏只在本地 localStorage；不允许存储时保留当前会话并明确提示。旧 ?chapter=19#library、?q=离职、#entry-15-1 等链接兼容。

更新 library 前完整读取它的 AGENTS.md 和 CLAUDE.md，记录新快照版本，不为了通过统计而删减原文。正文 CC BY 4.0，原创脚本 MIT，第三方组件与字体保留各自许可和来源。
