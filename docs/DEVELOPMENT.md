# 开发指南

> 面向维护者与贡献者。跑起来看 [README](../README.md)，架构看 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 环境

| 依赖 | 用途 |
| --- | --- |
| Node.js ≥ 18 | 后端与开发脚本（后端零第三方依赖） |
| npm | 装 devDependencies（electron / esbuild / playwright-core） |
| Python + Pillow | 仅重生成图标时需要：`pip install pillow` |
| 系统 Edge | 回归测试用（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`） |

## npm scripts

| 命令 | 作用 |
| --- | --- |
| `npm run web` | 起 Web 服务（默认 `:8642`，`PORT` / `HOST` 可改） |
| `npm start` | 起 Electron 桌面窗口 |
| `npm run dist` | electron-builder 打包（产物在 `dist/`） |
| `npm run dist:mac` | 打 Mac 包（arm64 + x64），**只能在 macOS 上跑** |
| `npm run build:cm` | esbuild 重打包编辑器内核 → `vendor/cm6.js` |
| `npm run mock-s3` | 起假 S3 |
| `npm test` | 跑全部四组回归（自己拉起服务、自动清理 mock 残留，91 项） |
| `npm run test:due` | 回归：截止日期（28 项） |
| `npm run test:layout` | 回归：排版不变量（10 项） |
| `npm run test:sort` | 回归：排序弹出菜单（34 项） |
| `npm run test:sync` | 回归：云端同步（19 项，自起 mock + 独立服务） |

前端是原生 JS，**没有构建步骤**：改完 `css/`、`js/`、`index.html` 刷新即生效。只有改了 `build/cm6-entry.js` 才需要 `npm run build:cm`。

## 发布流程

版本号写在 `package.json`（同步改 `CHANGELOG.md`），然后：

```bash
git tag v1.2.0
git push origin v1.2.0
```

推标签会触发 `.github/workflows/release.yml`：在 macOS runner 上打 arm64 + x64 两份
`.dmg` / `.zip`，并自动挂到对应 Release 上（`--publish onTag`）。

想先试打包、暂时不发布：Actions →「打包发布」→ Run workflow，
产物在当次运行页的 Artifacts 里下载。

**为什么 Mac 包必须由 CI 打**：electron-builder 在非 macOS 上会直接报
`Build for macOS is supported only on macOS`，Windows / Linux 本机打不出来。

**关于签名**：现在 `mac.identity = null`，不签名也不公证，用户首次打开会被 Gatekeeper 拦
（绕过办法见 README）。要正式签名需要 Apple 开发者账号（99 美元/年），拿到后在仓库 Secrets
配 `CSC_LINK` / `CSC_KEY_PASSWORD` 与 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
`APPLE_TEAM_ID`，再把 `mac.identity` 改成证书名称、`gatekeeperAssess` 改回 `true`。

## 回归测试

四组端到端用例，基于 Playwright + 系统 Edge，共 91 项断言。

日常直接用 `npm test`：它会自己拉起 `:8642` 服务（已有一个在跑就复用，跑完不关别人的），
依次跑完四组，最后汇总成败。**不用先手动 `npm run web`**。

浏览器由 `scripts/lib/browser.js` 统一解析，两个环境变量可覆盖：

| 变量 | 作用 |
| --- | --- |
| `JIANJI_BROWSER` | 浏览器可执行文件路径。缺省用系统 Edge |
| `JIANJI_HEADLESS=1` | 无头模式。本地默认有头（方便肉眼复核排版），CI 必须开 |

```bash
npm test                    # 本地，有头
JIANJI_HEADLESS=1 npm test  # CI / 不想被窗口打扰
```

`main` / `dev` 上的 push 和 PR 都会触发 `.github/workflows/ci.yml`（Windows 镜像自带 Edge），
失败会直接挡住合并。

> `npm run dist` 每次都会重建 `dist/win-unpacked/`（约 333 MB）和 `dist/builder-debug.yml`。
> 想保持目录干净，顺序是「先清 → 再打包 → 打包后再清一次」。

### 跑之前的两件事

1. **不要留着指向本地 mock 的同步配置** —— 留着它，页面一启动就去连已经关掉的 mock S3，拿 502，「无控制台错误」这条断言必挂。
   `npm test` 会自动识别并挪走这类配置（端点落在回环地址 **且** 凭证为 `test`），不用手工处理。
   两个坑：`server.js` 的 `readJson()` 在主档缺失时会回退读 `${file}.bak`，只清主档会被 `.bak` 原样复活；
   另外 `regression-sync` 每次挑的空闲端口不固定（9121、9129…），按端口匹配不可靠。
   指向真实云端的配置不会被自动挪动 —— 那种情况请先自行备份，否则页面启动就会去连你的真实云端。
2. **强制展开侧栏**：`sidebarCollapsed` 是用户偏好，为 `true` 时侧栏整体 `visibility:hidden`，合成点击点不到其中的模式键 / 排序键。套件在 goto 后执行：

   ```js
   await page.evaluate(() => document.body.classList.remove('sidebar-collapsed'));
   ```

   只改 body class，不写回存档。新套件凡是要点侧栏内元素，都要带这一步。

### 写用例时的两个陷阱（都真实踩过）

**一、Playwright 的 `newContext()` 在本环境不隔离 `localStorage`。**
每个新建的 context 打开本页都能看到完整数据 —— 只隔离 cookie / storage partition，`localStorage` 是共享的。所以 `addInitScript(() => localStorage.clear())` 清不干净：页面启动阶段自己会再次写入，清空被覆盖。

**二、真正的持久层是服务端的 `data/notes.json`，它才是首屏状态的来源。**
要造确定性数据，得改服务端存档：

```js
await fetch('http://127.0.0.1:8642/api/notes', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ notes: [...], tasks: [], lists: [], settings: {}, deleted: [], savedAt: Date.now() }),
});
```

注意 `PUT /api/notes` 在 `autoSync` 开启时会**顺带把存档推到 S3** —— 要造「两端不一致」的场景必须先 `setAutoSync(false)`。

### 还原逻辑的绝对红线

**任何情况下都不 `unlink` 用户的 `data/` 文件。**

上一版写的是「备份不存在 → 说明原本没有 → 删掉我们造出来的」。这个推理是错的：备份不存在**同样可能**意味着「备份读取失败」，于是一次异常就把用户存档直接删了。正确写法是给「原本不存在」单独留一个标记文件（`xxx.absent`），还原时只做「有备份就写回 / 有 absent 标记就跳过」，其余情况一律报错并保持不动。这套流程已两次避免/暴露真实事故，别简化它。

### 断言要「证伪」而不是「证真」

三处失败案例都源于**我自己写错了期望值**，而非代码有缺陷 —— 定位方式是：先证明「产物侧的观测值」，再回头怀疑断言。

| 失败的断言 | 实际情况 | 教训 |
| --- | --- | --- |
| `排序偏好已持久化到 localStorage('jianji.prefs')` | 存储键是 `jianji-notes-v2`，且 `sort` 嵌在 `settings` 里 | 先读代码确认键名，别照着惯例猜 |
| `待办视图排序按钮右对齐` | 待办视图用的是另一套页签容器 `#taskFilters`（`data-tfilter`），排序控件**按设计**只属于笔记视图 | 「应该两个视图都有」是我脑补的需求 |
| `按标题升序 = Gamma, 阿尔法, 贝塔` | `localeCompare(…,'zh')` 下汉字**排在拉丁字母之前**，正确顺序是 `阿尔法, 贝塔, Gamma` | 涉及排序/编码的比较，先在 Node 里跑一遍确认行为 |

另有两条常见误报来源：

- **固定 `waitForTimeout` 等落盘**：服务端写盘有防抖，`createList()` 一路要 `renderTaskPanel()` + 插入重命名 input，实测 ~220 ms，固定等 900 ms 仍偶发假 FAIL。**断言服务端状态一律轮询**（30 × 200 ms）。
- **选择器拿不到元素被静默跳过**：模式按钮的 `data-mode` 是 `tasks`（复数）。写成 `task` 时 `querySelector` 返回 null，被 `if (t) t.click()` 吞掉，表现为「点了没反应」。写 UI 探针时取不到元素要立刻报错，别用 `if (el)` 静默跳过。

## 视觉约定（改 UI 前先读）

- **图标**：全站统一 24 网格、圆头圆角、1.7 描边，由 `js/app.js` 顶部的 `svg()` 助手集中定义（文档 / 钩子清单 / 文件夹 / 加号 / 铅笔 / 图钉 / 星标 / 垃圾桶 / 勾 / 信笺），不再零散拼字符
- **勾选框**：列表行与正文 widget 都是「圆角方块」，尺寸与描边同源，勾线为描边动画渐显
- **左侧栏左基准统一 14px**：`.side-head` / `.filters` / `#taskFilters` / `.tag-bar` 共用一个基准，几个选择器的 padding 必须一致。反例（踩过三轮）：
  - 第一轮：`#taskFilters` 写 `padding: 0 12px 8px`、`#filters` 完全没写 —— 任务视图页签缩进 12px、笔记视图贴边 0px；且 0px 比相邻 `.tag-bar`（14px）靠左一整格，表现为「页签溢出侧栏左沿」。
  - 第二轮：排序下拉容器同样漏了 —— 夹在两个 14px 基准元素中间显得偏左；**再叠上 `select` 自身的 `padding-left: 8px`**，下拉文字落在 22.8px，与页签的 28.8px 差 6px。
  - 第三轮：索性**放弃原生 `select`**，排序控件改为右对齐的图标按钮，彻底不再参与左基准计算。
  - 结论：**给这类「带自身内边距的控件」设左基准时，内边距要一并归零**，否则容器对齐了、内容还是歪的。
  - `.tk-quick` 用 **margin 而非 padding** —— 它自带边框与底色，缩进必须作用在外框上。
  > `.note-list` 是例外，它的 10px 不比齐 14px —— `.note-item` 卡片自带内边距，对其外框反而会让卡片左右不对称。**容器和文本容器的左基准本就该不同，这是设计而非 bug。**
- **任务详情左基准是硬不变量**：标题、元信息条色点、备注图标、工具栏图标、正文首行共用一条竖线，由 `.task-body` 上的 `--check-col` / `--check-gap` / `--text-inset` 推导，不写魔法数字。曾因桌面端「返回列表」按钮常亮把这条线顶开 48px（34px 按钮 + 10px gap + 4px），回归套件立刻抓到。最终方案是返回键只在 `body.sidebar-collapsed` 时亮出。
- **排序控件是自绘弹出菜单**（`.sort-menu`）：原生 select 的箭头由系统绘制、宽高受字体影响，塞进 28px 高的页签行里怎么调都脏。触发器是 26×26 图标按钮 `#sortBtn`，靠 `margin-left: auto` 钉在页签行最右端；选中态用 `.active` + `aria-checked`，勾选图标靠 `visibility` 切换（不用 `display`，避免占位跳动）；交互三件套：点子项即选中并关闭、点外部关闭、`Esc` 关闭（并入全局 Escape 链，优先级排在 `#newPop` 之后）。
- **`syncSortMenu()` 必须无条件调用且排在 `bindEvents()` 之前**：它只**读** `state.sort` 去点亮菜单、绝不反向改写。若沿用「`if (state.settings.sort) syncSortMenu()`」，当存档没带 `settings.sort` 时菜单可能被其它路径点亮成别的项 —— **用户首屏看到的排序项与实际排序不一致**，直到手动点一次才对齐。
- **新建菜单有两处入口，靠 `NEW_MENUS` 表驱动**：顶栏 `#newMenu/#newBtn/#newPop`（全局三项）+ 侧栏底栏右下角 `#sideNew/#sideNewBtn/#sideNewPop`。
  侧栏那项带 `followsMode: true` —— 笔记模式下点击**直接 `createNote()`**，待办模式下才弹菜单，且菜单里**只有任务/清单两项**。语义靠 `syncSideNewMode()` 同步 `aria-haspopup` / `aria-label` / `title`，它挂在 `renderSideFoot()` 末尾。**切分栏时必须 `closeAllNewPops()`**，否则挂着的任务菜单会在笔记分栏里继续响应。顶栏主按钮保持三项不变（那是全局入口）。
  - **互斥必须写在 `toggleNewPop()` 里**：两个按钮的点击都 `stopPropagation`，document 级「点外部」收不到通知，不显式关另一个就会出现两个菜单同时挂着。
  - **CSS 覆盖必须排在被覆盖的基础规则之后**（同权重后写生效）。`.side-new-pop` 最初写在 `.side-foot` 旁边（478 行），而 `.new-pop` 基础规则在 1102 行 → `top: auto` / `width` 被盖回去，变成 `top` 与 `bottom` 同时有效 → 高度被压成 14px（菜单展开但只剩一条缝）。
  - 向上展开用 `top: auto; bottom: calc(100% + 8px)` + `pop-up` 动画（从 `translateY(6px)` 进入，与向下展开的 `pop-in` 方向相反）。底栏在侧栏最底部，向下必被裁。
- **焦点归属由调用方决定，不要一律抢**：`createTask({ focus })` 的三种取值见函数注释。反例：原先无条件 `if (!title) $('#taskTitle').focus()`，于是「点左侧清单头的 +」会建一个空任务并把焦点甩到右侧详情面板，用户以为左侧快速添加栏没反应（其实字打进了右边的标题框）。
- **重建 DOM 的容器要保护 IME 组字状态**：`#taskLists` 的 `innerHTML` 重建会连带替换 `#tkQuick`。中文输入法正在组字时替换，会让拼音串丢失、候选框失去锚点而漂到屏幕角落。两道防线：① `compositionstart` / `compositionend` 期间**跳过渲染**并登记 `taskPanelRenderPending`，组字结束后补渲染一次；② 渲染前若焦点在 `#tkQuick`，保存「值 + 光标区间」后还原（`setSelectionRange` 可能抛错，需 try/catch）。
  > 焦点丢失比组字中断好查（`document.activeElement` 一看就知道），**但组字中断时焦点看着还在、就是打不出字**，是最难自查的一类。
- **日期控件必须是「真控件」**：不要用透明 `<input type="date">` 铺满自定义 chip 当点击垫片 —— 一旦弹出日历再按 `Esc` 取消，原生段会脱离激活态，之后方向键与数字键被静默丢弃，且 `Esc` 被日历弹层吃掉、JS 收不到通知。空值的 `yyyy/mm/日` 画在 shadow DOM 里，`color:transparent` / `font-size:0` / `display:none` 全部无效，占位文案只能靠不透明底色盖住。
- **宽屏布局分三层**：① `.app` 外壳**不加 `max-width`**，流式填满窗口；② `.page` 纸张**弹性**变宽（上限 `--doc-col`）；③ `--measure` 才是正文**文本栏宽**。三者都在 `.editor` 上定义。反例：给外壳写 `max-width: 1400px`，最大化后左右各空 256px；给纸张写死 `760px`，编辑器 1550px 时左右各空 395px。
- **正文宽度约束必须挂在 `.cm-content` 上**：纸张里的 `p` / `h1` / `table` 都是 CodeMirror 运行时生成的，静态 DOM 里只有一个 `div.cm-editor`。写 `.page p { max-width }` 这类选择器**永远命中不到**。
- **验对齐要比「外框」不要比「内容沿」**：头部三条（`.editor-top` / `.meta-row` / `.toolbar`）自带 padding，它们和纸张对齐的是**边框盒**。拿 `rect.left + paddingLeft` 去比会看到 14/12/18px 的差，误判成错位 —— 那其实是设计缩进。
- **Toast**：默认 3000 ms；`mouseenter` 暂停**必须配 `mouseleave` 重启**（只 `clearTimeout` 不重启 = 光标路过一次就永不消失，删完条目光标常正好停在原按钮附近）；`dismiss()` 里除 `animationend` 还要 `setTimeout(() => el.remove(), 400)` 兜底（reduced-motion / 元素不可见时 animationend 不来）。
- **主题双写与启动裁决**：`applyTheme()` 必须双写 `localStorage[THEME_KEY]` 与 `state.settings.theme`（后者变了才 `persist()`）；`init()` 两处 settings 合并都要裁决——`readPref(THEME_KEY)` 有值时**以本地偏好为准**，因为 Electron 的 900ms 防抖推送在关窗时极易丢失。
