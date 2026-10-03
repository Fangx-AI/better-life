# 开发说明

普通用户直接用 [在线工具箱](https://fangx-ai.github.io/better-life/)，无需安装。本页只供开发和维护。

## 本地预览

需要 Node.js 22+；项目没有第三方运行依赖。

```sh
npm run build
python -m http.server 8000 --directory dist
```

打开 http://localhost:8000/ 。也可用任意静态 HTTP 服务器服务 dist/。不要直接双击源码 index.html，它需要读取生成的数据。

## 检查与发布

```sh
npm run check
```

检查覆盖：正文解析、章节条目数、原文保真、检索组合、收藏筛选、原书交叉引用与白话规范。浏览器交互和移动版另外进行实际验收。

main 推送后 GitHub Actions 构建 dist/ 并部署到 GitHub Pages；PR 只检查，不发布。

## 文件说明

- index.html / assets/：产品首页、全文检索、收藏和图片。
- scripts/：从原书格式构建静态数据，不生成新建议。
- library/：上游正文、长文与 skill 快照。source.json 记录版本。
- tests/：Node 内置测试，不需要安装测试框架。
- dist/：构建结果，不入 Git。

搜索是关键词匹配，空格分隔的关键词需同时命中。不调用模型，不是自然语言问答。

收藏是浏览器 localStorage；禁用存储时退化为本次会话收藏。没有用户账户、后台、追踪脚本或跨设备同步。

## 内容更新

library/ 不会自动同步。更新前读取 library/AGENTS.md、library/CLAUDE.md，使用新上游快照替换对应文件，记录提交版本，更新测试中的基线数字与 README，再跑 npm run check。不要为了统计通过而删减原文。

新首页和脚本采用 MIT；导入内容仍为 CC BY 4.0。图片生成记录见 IMAGE-PROMPTS.json。
