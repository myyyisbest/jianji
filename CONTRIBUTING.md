# 贡献指南

感谢你愿意改进简记。这是一份个人项目，但欢迎任何形式的参与：报 bug、提需求、改文档、提 PR。

## 开发环境

```bash
npm install     # 装 devDependencies
npm run web     # 起服务，http://127.0.0.1:8642
```

前端是原生 JS，**没有构建步骤**，改完刷新即生效。只有修改 `build/cm6-entry.js` 后才需要 `npm run build:cm`。

## 提交前请跑回归

四组端到端用例共 91 项，基于 Playwright + 系统 Edge：

一条命令跑完（自己拉起 `:8642` 服务，并自动挪走上一轮残留的 mock 同步配置）：

```bash
npm test
```

想只跑某一组：`npm run test:due`（28 项）/ `test:layout`（10 项）/ `test:sort`（34 项）/ `test:sync`（19 项）。
单独跑前三条时记得先 `npm run web`；`test:sync` 自带 mock 与独立服务。

CI 会在 `main` / `dev` / `release/**` 的 push 与 PR 上自动跑同一套
（`.github/workflows/ci.yml`），红了请先修再提。
浏览器路径与无头模式可用 `JIANJI_BROWSER` / `JIANJI_HEADLESS=1` 覆盖，细节见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

> 如果你的改动涉及 UI 布局，`test:layout` 是你的朋友 —— 它守着几条硬不变量（任务详情左基准、行布局、图标规格）。

## 提交信息

用 Conventional Commits：

```
feat: 新增 xxx
fix: 修复 xxx
docs: 补充 xxx
refactor: 重构 xxx
test: 补充 xxx 用例
chore: 清理 xxx
```

## 分支

- `main` —— 稳定分支
- `dev` —— 开发分支

小改动可以直接 PR 到 `main`，较大的改动建议先开 Issue 讨论。

## 几条硬规则

1. **不要提交 `data/`** —— 里面有笔记存档和明文同步密钥，已被 gitignore。
2. **不要手改 `vendor/cm6.js`** —— 它是 `build/cm6-entry.js` 的 esbuild 产物，改源码后跑 `npm run build:cm`。
3. **不要手改 `icon/` 下的产物** —— 全部由 `scripts/make-icon.py` 生成。
4. **不要往页面里加内联 `<script>` 或 CDN 脚本** —— 页面有 CSP（`script-src 'self'`），会被拦。
5. **任何会写服务端 `data/notes.json` 的脚本，必须先备份再善后** —— 详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 的「还原逻辑的绝对红线」。

## 代码风格

- 原生 JS，不引入框架或运行时依赖（后端保持零依赖）
- 颜色、间距走 `css/style.css` 里的 CSS 变量，不写魔法数字
- 图标统一 24 网格，由 `js/app.js` 顶部的 `svg()` 助手集中定义
- 函数单一职责，避免多层嵌套
