# 更新日志

本文件的格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- `npm test`：一条命令跑完四组回归（91 项）。自动拉起 `:8642` 服务并在结束后收尾，
  并自动挪走上一轮残留的 mock 同步配置 —— 此前这一步只能手工把 `data/s3-config.json` 置空，
  忘做了就会看到一堆 502，「无控制台错误」断言全部挂掉
- GitHub Actions CI（`.github/workflows/ci.yml`）：`main` / `dev` 的 push 与 PR 自动跑回归套件

### 修复

- **同步配置删不掉**：`readJson()` 在主档缺失 / 损坏时会回退读 `${file}.bak`，
  于是手动删掉 `data/s3-config.json` 断开同步后，配置被 `.bak` 原样复活 ——
  界面依旧显示「云端同步已配置」，页面照旧去连一个已经不存在的端点
  （回归套件里表现为一堆 502、「无控制台错误」断言全挂）。
  现在 `.bak` 兜底只用于笔记存档（那是防丢数据的，必须留），同步配置不走回退

### 变更

- 四个回归脚本不再各自写死 Edge 路径与 `headless: false`，统一收敛到 `scripts/lib/browser.js`，
  可用 `JIANJI_BROWSER` / `JIANJI_HEADLESS=1` 覆盖。这是它们能在 CI 上跑起来的前提 ——
  之前这套用例只在作者本机可执行
- `package.json` 补 `mock-webdav` 脚本（`scripts/mock-webdav.js` 一直存在但没有入口）

## [1.1.0] - 2026-09-20

首个对外发布的版本。Windows x64 安装包与便携版见
[Releases](https://github.com/myyyisbest/jianji/releases/tag/v1.1.0)。

### 新增

- Electron 桌面形态：内嵌同一后端（随机端口 + 仅本机回环）、系统托盘（图标随系统主题深浅自动切换）
- 基于 CodeMirror 6 的 Markdown 即时预览编辑器，取代原先的源码 / 预览双栏
- S3 / WebDAV 双后端云同步，条目级合并
- 四组 Playwright 回归用例（截止日期 / 排版 / 排序 / 同步，共 91 项）
- 图标体系重做：应用图标（.ico 七档）+ 深浅两套托盘图标，由 `scripts/make-icon.py` 生成
- 侧栏底栏右下角「新建」入口：笔记分栏点击直接新建笔记，待办分栏弹出「任务 / 清单」两项菜单
- 设置面板按「连接配置 / 同步操作」分区折叠，降低单屏信息密度
- 桌面端侧栏折叠时显示「返回列表」按钮

### 修复

- **删除提示常驻**：`toast()` 的 `mouseenter` 会暂停消失却没有配套的 `mouseleave` 重启，
  删完条目光标恰好停在提示区域时提示永不消失。现改为悬停暂停 + 移开重新计时，默认时长 4500ms → 3000ms，
  并补上 `animationend` 之外的移除兜底
- **侧栏弹出菜单只剩一条缝**：`.side-new-pop` 覆盖规则写在 `.new-pop` 基础规则之前，
  `top: auto` 与 `width` 被盖回，导致 `top` 与 `bottom` 同时有效、高度被压成 14px
- **两处新建菜单可同时展开**：按钮点击都 `stopPropagation`，document 级「点外部」收不到通知，
  互斥改为在 `toggleNewPop()` 里显式处理
- `/api/health` 的 `sync` 语义：改为「当前类型 endpoint 非空」而非「配置文件存在」

### 变更

- 存储格式统一为 Markdown，旧版 HTML 笔记加载时经 `htmlToMd()` 自动迁移
- 应用由「素笺」更名为「简记」，localStorage 键自动迁移、旧键保留作回滚保险
- 删除任务的提示带所属分类：`已删除任务「x」· 清单「工作」` / `· 收件箱`
- 排序弹出层与标签 chips 间距微调

## [1.0.0] - 2026-09

- 首个可用版本：笔记 + 清单待办、双主题、全文搜索、置顶收藏标签
