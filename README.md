# 简记 · 笔记与待办

一款 **简洁风格**（暖米白 / 暖深色双主题）的本地笔记 + 清单化待办应用：**Web / Electron 桌面双形态**，基于 **CodeMirror 6** 的 Markdown 即时预览编辑器，后端为单文件零依赖 Node 服务，支持 **S3 / WebDAV 双后端云同步**。

## ✨ 特性

- **界面**：暖米白 / 暖深色双主题、衬线标题、赤陶橙强调色，左侧栏可一键收起，移动端抽屉式布局
- **Markdown 即时预览**：正文以 Markdown 为唯一数据源，语法符号由 Decoration 隐藏/替换，看到的就是排版后的样子；光标进入节点时源码自动显形
- **双模式**：顶栏下方切「笔记 / 任务」，两者互不干扰、共用同一套编辑内核与存储
- **任务**：清单分组、截止日、优先级（低优先/普通/高优先）、重要标记、Markdown 备注
- **清单**：可为任务建多个清单（默认「收件箱」），支持重命名、换色、折叠、删除
- **待办聚合**：任务面板自动汇总所有笔记正文里的 `- [ ]` 项，勾选即回写原笔记，点击直达出处
- **笔记管理**：自动保存、全文搜索（含任务）、置顶、收藏、标签筛选、三种排序、删除撤销、导出 Markdown
- **桌面应用**：Electron 内嵌同一后端（随机端口 + 仅本机回环），数据存系统用户目录
- **云同步**：S3（AWS SigV4 直连）或 WebDAV（坚果云 / Nextcloud / 群晖），笔记 + 任务 + 清单整体存档，按条目级合并多端变更

## 🚀 运行

### 方式一：桌面应用（Electron）

```bash
npm install     # 首次，安装 electron / esbuild
npm start       # 启动桌面窗口
```

桌面端数据存于系统用户数据目录（Windows：`%APPDATA%/简记/data`），与应用代码分离。
打包独立可执行文件：`npm run dist`（需已安装 electron-builder，产物在 `dist/`）。

打包产物（`dist/`）：

| 产物 | 说明 |
| --- | --- |
| `jianji-1.1.0-x64.exe`（NSIS） | 安装程序，可选安装目录、建桌面 / 开始菜单快捷方式 |
| `jianji-1.1.0-x64.exe`（portable） | 免安装单文件，双击即用（与上者同名，按需二选一target） |
| `win-unpacked/简记.exe` | 未压缩目录版，用于快速验证 |

图标由 `scripts/make-icon.py` **生成**，不要手改 `icon/` 下的产物：

```bash
python scripts/make-icon.py     # 重出全部尺寸 + .ico + .svg + 预览图
```

图形是一支斜置的「签字笔」：深炭圆角底 + 奶油白笔身 + 笔尖处的强调橙墨点。配色直接取自
`css/style.css` 的主题变量（`#21201c` / `#faf9f5` / `#d97757`），所以图标和界面是同一套色。

- `jianji-icon.ico` —— **Windows 打包与安装程序必须用 `.ico`**。NSIS 读取 PNG 会直接报
  `Error while loading icon ... invalid icon file` 并中止构建（electron-builder 不会自动转换）。
  本文件内嵌 **16/24/32/48/64/128/256 七档**，系统按 DPI 自动挑选。
- `jianji-icon-256.png` —— 经 `extraResources` 落到 `resources/icon.png`，供 `resolveIcon()` 运行时使用。
- `jianji-icon.svg` —— 矢量版，网页 favicon 首选（任何 DPI 都清晰）。
- `jianji-icon-16/32.png` —— 标签页 favicon 的位图兜底（小尺寸要单独出图，缩 180 会糊）。
- `jianji-icon-180.png` —— apple-touch-icon。

**网页里的 logo 与 `.ico` 是同源的**：`index.html` 里 `.brand-logo` / `.empty-logo` 的 SVG 坐标，
是从 `make-icon.py` 的同一组几何参数算出来的（`write_svg()` 会导出可对照的 `jianji-icon.svg`）。
改图形时两边一起改，否则应用内 logo 会和任务栏图标对不上。

> 打包验证：`npm run dist` 成功产出 exe，进程名 `简记.exe` 无乱码，数据目录落在
> `%APPDATA%\简记`，asar 内含 electron/main.js、server.js、index.html、css/、js/、vendor/、icon/，
> 未误打包 node_modules。

### 方式二：Web 服务

```bash
npm run web          # 等价于 node server.js
# 默认 http://localhost:8642（PORT / HOST 环境变量可改）
```

Web 模式**运行时零依赖**：`vendor/cm6.js` 已预打包入库，直接起 Node 服务即可。
不做后端、直接双击 `index.html` 也能用，此时数据仅保存在浏览器 localStorage（界面会提示「后端未连接」）。

### 回归自测

两组基于 Playwright + 系统 Edge 的端到端用例（需先 `npm run web` 起服务）：

```bash
npm run test:due     # 截止日期可维护性（选日期 / 键盘 / 清空 / 持久化）
npm run test:layout  # 排版不变量（行布局 / 左基准 / 图标 / 无子步骤）
```

## 📝 Markdown 即时预览

编辑器不再做「源码 / 预览」切换，输入即刻渲染：

| 输入 | 触发 | 结果 |
| --- | --- | --- |
| `#` `##` `###` `####` + 空格 | 行首 | 一 ~ 四级标题 |
| `>` + 空格 | 行首 | 引用块 |
| `-` / `*` / `1.` + 空格 | 行首 | 无序 / 有序列表 |
| `- [ ]` + 空格 | 行首 | 待办勾选框（点方框即打勾） |
| `**粗体**` `*斜体*` `~~删除~~` `==高亮==` `` `代码` `` | 成对符号 | 行内格式 |
| `\| 列 \| 列 \|` 或工具栏末按钮 | 行首 | 表格（光标离开后渲染为真正的表格） |
| ` ``` ` + 回车 | 行首 | 代码块（块内不参与行内渲染） |
| `---` + 回车 | 行首 | 分割线 |

实现要点（`build/cm6-entry.js` + `vendor/cm6.js`）：

- 解析用 **@lezer/markdown**（含 GFM 扩展），装饰走 `Decoration.replace / mark / line`，块级表格由一个 `StateField` 整块替换为 Widget
- 光标或选区与节点相交时**保留源码原文**，方便就地编辑
- 文本一律经 `textContent` 写入 DOM，天然免疫 XSS
- 存储格式只有 Markdown：旧版 HTML 富文本笔记在加载时经 `htmlToMd()` 自动迁移

> 需要重新打包编辑器内核时：`npm run build:cm`（esbuild iife → `vendor/cm6.js`）。

## ✅ 任务与清单

- 侧栏切到「任务」：顶部输入框回车即快速建任务；下方按清单分组，组头可折叠、换色、重命名、删除
- 组内排序：未完成 → 重要 → 有截止日 → 截止日近 → 优先级高
- 点开任务进入详情：标题、无边框的元信息条（所属清单色点 / 截止日 / 优先级 / 创建时间），以及一段与笔记同内核的 Markdown 备注
- 截止日期用原生 `<input type="date">`：点输入框任意位置唤起日历，也支持方向键切换月/日、直接敲数字、`Esc` 取消；有值时旁边出现 `×` 一键清除
- 筛选：**全部 / 今天 / 重要 / 未来 7 天 / 已完成**；顶栏「任务」页签显示未完成数量
- 「笔记中的待办」分组：把所有笔记正文里的 `- [ ]` 汇总于此，勾选直接回写源笔记、点击跳转出处

> 任务刻意只保留**标题 + Markdown 备注**两层结构，不引入子步骤/子任务，避免层级膨胀。

## 🎨 视觉约定

- **图标**：全站统一 24 网格、圆头圆角、1.7 描边，由 `js/app.js` 顶部的 `svg()` 助手集中定义（文档 / 钩子清单 / 文件夹 / 加号 / 铅笔 / 图钉 / 星标 / 垃圾桶 / 勾 / 信笺），不再零散拼字符
- **勾选框**：列表行与正文 widget 都是「圆角方块」，尺寸与描边同源，勾线为描边动画渐显
- **左基准**：任务详情内标题、元信息条色点、备注图标、工具栏图标、正文首行共用一条竖线，由 `.task-body` 上的 `--check-col` / `--check-gap` / `--text-inset` 三个变量推导，不写魔法数字
- **日期控件**：必须是「真控件」。不要用透明 `<input type="date">` 铺满自定义 chip 当点击垫片——一旦弹出日历再按 `Esc` 取消，原生段会脱离激活态，之后方向键与数字键被静默丢弃，且 `Esc` 被日历弹层吃掉、JS 收不到通知。空值的 `yyyy/mm/日` 画在 shadow DOM 里，`color:transparent` / `font-size:0` / `display:none` 全部无效，占位文案只能靠不透明底色盖住，不能靠改颜色
- **宽屏布局**：宽度分三层，各管一段——① `.app` 外壳**不加 `max-width`**，流式填满窗口；② `.page` 纸张**弹性**变宽（上限 `--doc-col`，窄时随容器收缩）；③ `--measure` 才是正文**文本栏宽**，只约束逐行阅读的内容。三者都在 `.editor` 上定义为变量。反例（都踩过）：给外壳写 `max-width: 1400px`，最大化后左右各空 256px；给纸张写死 `760px`，编辑器 1550px 时左右各空 395px —— 就是那两条难看的空白带
- **正文的宽度约束必须挂在 `.cm-content` 上**：纸张里的 `p` / `h1` / `table` 都是 CodeMirror 运行时生成的，静态 DOM 里只有一个 `div.cm-editor`。写 `.page p { max-width }` 这类选择器**永远命中不到**，得用 `.page .cm-content`（CM6 的量测基准元素，设 `max-width` + `margin-inline: auto` 是安全的）
- **验对齐要比「外框」，不要比「内容沿」**：头部三条（`.editor-top` / `.meta-row` / `.toolbar`）自带 padding，它们和纸张对齐的是**边框盒**。拿 `rect.left + paddingLeft` 去比，会看到 14/12/18px 的差，误判成错位——那其实是设计缩进。凡是"对齐"断言，先想清楚要对齐的是框还是内容（两种都对，但得挑一个说清楚）

## ⌨️ 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl/⌘ K` | 聚焦搜索（同时搜笔记与任务） |
| `Ctrl/⌘ Alt N` | 新建笔记 |
| `Ctrl/⌘ Alt T` | 新建任务 |
| `Ctrl/⌘ S` | 立即保存 |
| `Ctrl/⌘ B` / `I` | 加粗 / 斜体 |
| `Esc` | 关闭弹窗 · 清空搜索 |

## ☁️ 云端同步（S3 / WebDAV）

1. 启动后端，点击顶栏「设置」，在 S3 / WebDAV 间任选其一（两种配置可分别留存）
2. **S3**：填 Endpoint / Region / Bucket / Access Key / Secret（兼容一切 SigV4 服务）
   **WebDAV**：填地址 / 用户名 / 应用密码 / 存档路径（兼容坚果云、Nextcloud、群晖等）
3. 开启「保存即上传」：每次保存自动推送；「从云端合并」按条目级合并多端变更（较新修改胜出，删除同步传播）

- 存档内容为整体：`{notes, tasks, lists, settings, deleted, savedAt}`
- S3 存档对象默认 `notes.json`；WebDAV 存档路径默认 `/notes.json`（父目录不存在时自动逐级 MKCOL）
- 数据链路：浏览器 / 桌面端 → `data/notes.json` → 你的 S3 桶或 WebDAV 目录

本地自测同步链路（无需真实云服务）：

```bash
node scripts/mock-s3.js       # Mock S3（:9000，不做签名校验）
node scripts/mock-webdav.js   # Mock WebDAV（:9700，Basic Auth 固定 u:p）
```

> 注意：密钥 / 密码保存在服务器 `data/s3-config.json`，请勿将 `data/` 提交到公共仓库（已 gitignore）。

## 📁 结构

```
project/
├── package.json            # Electron 入口 / 脚本 / 打包配置
├── electron/main.js        # Electron 主进程（进程内启动后端 + BrowserWindow + 图标解析）
├── index.html              # 页面结构（笔记编辑器 / 任务详情 / 设置弹窗）
├── css/style.css           # 简洁风格设计系统（双主题）
├── js/app.js               # 前端逻辑（渲染 / 任务 / 迁移 / 同步设置）
├── js/markdown.js          # 零依赖 MD→HTML 渲染器（浏览器 / Node 双导出）
├── vendor/cm6.js           # CodeMirror 6 打包产物（运行时直接用，勿手改）
├── build/cm6-entry.js      # 编辑器内核源码（liverPreview 扩展、GFM 解析、快捷键）
├── icon/                   # 应用图标（产物，由 scripts/make-icon.py 生成）
├── server.js               # 零依赖 Node 后端（静态服务 + API + S3 SigV4 + WebDAV）
├── scripts/                # start-electron.js、mock-s3.js、mock-webdav.js、make-icon.py、回归用例
├── dist/                   # electron-builder 打包产物（安装包 / 便携版，已 gitignore）
└── data/                   # 运行时生成：notes.json、s3-config.json（已 gitignore）
```

> `vendor/cm6.js` 是构建产物，改编辑器内核请改 `build/cm6-entry.js` 后执行 `npm run build:cm` 重新生成（已 gitignore）。

### 存储键迁移（更名历史）

应用由「素笺」更名为「简记」时，localStorage 键同步前移。为避免老用户升级后看到空笔记库，`js/app.js` 保留了完整回退链，**首次启动自动迁移、旧键不删**（留作回滚保险）：

| 用途 | 新键 | 兼容读取的旧键 |
| --- | --- | --- |
| 笔记存档 | `jianji-notes-v2` | `sujian-notes-v2` → `sujian-notes-v1` → `liulin-notes-v1` |
| 主题 | `jianji-theme` | `sujian-theme` |
| 侧栏折叠 | `jianji-sidebar-collapsed` | `sujian-sidebar-collapsed` |

> 主题优先级：URL `?theme=` > 存档 `settings.theme` > 本地偏好键。存档里的主题是「存档时刻的快照」，本机偏好代表用户此刻的选择。

## 🔌 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（笔记数 / 任务数 / 是否配置同步） |
| GET | `/api/notes` | 读取本地存档（含 tasks / lists / settings / deleted） |
| PUT | `/api/notes` | 覆盖保存，autoSync 时顺带推送 |
| GET | `/api/config` | 读取同步配置（`{type, s3, webdav, autoSync}`） |
| PUT | `/api/config` | 保存同步配置（按 type 校验必填项） |
| POST | `/api/config/test` | 连接诊断（按类型逐级检查凭证与存档） |
| GET | `/api/sync/remote` | 只读云端存档（供前端合并） |
| POST | `/api/sync/push` | 本地 → 云端 |
| POST | `/api/sync/pull` | 云端 → 本地（保留 settings / deleted） |
