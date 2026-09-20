# 架构说明

> 面向维护者。想快速跑起来请看 [README](../README.md)。

## 整体形态

简记刻意只维护**一套前端 + 一个后端**，Web 与桌面两种形态共用它们：

```
┌─────────────────────────────────────────────────────────┐
│  index.html + css/ + js/（原生 JS，无框架、无构建步骤）  │
│  编辑器：CodeMirror 6（vendor/cm6.js，esbuild 产物）      │
└───────────────┬─────────────────────────┬───────────────┘
                │ fetch('/api/...')        │ window.desktop.*
                ▼                          ▼
    ┌───────────────────────┐   ┌────────────────────────┐
    │ server.js（零依赖）    │   │ electron/preload.js    │
    │ 静态服务 + REST API    │   │ contextBridge 白名单   │
    │ + S3 SigV4 + WebDAV    │   └───────────┬────────────┘
    └───────────┬───────────┘               │ ipcRenderer
                │                           ▼
                │                 ┌──────────────────────┐
                │                 │ electron/main.js     │
                │                 │ 窗口 / 托盘 / 单实例锁 │
                ▼                 └──────────────────────┘
        data/notes.json（唯一持久层）
```

关键点：**`data/notes.json` 才是持久层**。浏览器 localStorage 只是页面运行起来后的缓存，首屏状态来自服务端存档。

## 两条桌面通道（内嵌 HTTP 与 IPC）

并存是刻意的，不是历史包袱。

| | 内嵌 HTTP 后端 | preload + IPC |
| --- | --- | --- |
| 入口 | `fetch('/api/...')` → `127.0.0.1:随机端口` | `window.desktop.xxx()` |
| 承载能力 | 笔记 CRUD、同步、静态资源 | 托盘菜单动作、平台信息 |
| Web 形态 | ✅ 天然支持（同一套代码） | ❌ 浏览器里没有 `window.desktop` |
| 适合 | 有服务端语义的应用、Web/桌面双形态 | 原生对话框、托盘、注册表、系统通知 |

**为什么不合并成一条**：内嵌 HTTP 正是简记能做到双形态的原因。若把数据层也搬到 IPC，网页端就要写两套逻辑或加适配层。反过来，像「另存为」这种要弹原生对话框的能力 HTTP 永远表达不了。

**前端如何择路**：`electron/preload.js` 注入 `window.desktop`，网页模式下它是 `undefined`，所以渐进增强即可：

```js
if (window.desktop) {
  window.desktop.onNewNote(() => createNote());   // 桌面专属能力
}
```

### preload 的职责边界

`preload.js` 是唯一「既能碰页面、又能碰部分 Electron API」的文件，但它**不是把 `ipcRenderer` 交给页面**——那等于把沙箱拆了。它通过 `contextBridge` 暴露一份白名单：

```js
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
  onNewNote(callback) { /* 只有这一个方法，页面拿不到 ipcRenderer 本身 */ },
});
```

页面因此能 `window.desktop.onNewNote(...)`，却拿不到 `window.require` / `window.process` / `window.ipcRenderer`。**这三项必须保持 `undefined`**，是安全基线是否守住的判据（回归测试就断言这一点）。

### 主进程不越权写数据

托盘的「新建笔记」由主进程 `webContents.send('new-note')` 通知前端，**而不是主进程直接改 `notes.json`**。原因：数据层归前端管（含撤销栈、自动保存、多端合并），主进程越权写文件会造成两套状态互相覆盖。主进程只负责「发信号」和「管窗口」。

## 桌面端初始化顺序（硬约束）

`electron/main.js` 顶部这几行**必须在 `app.whenReady()` 之前**，顺序不能动：

```js
app.setName('简记');                                    // ① 决定 userData 路径
if (process.platform === 'win32') app.setAppUserModelId('com.jianji.notes');  // ② 与 build.appId 一致
const gotLock = app.requestSingleInstanceLock();        // ③ 单实例锁
```

- **不设 `setName` 的后果**：`app.getName()` 返回 `"Electron"`，`app.getPath('userData')` 落到 `%APPDATA%\Electron`。**多个 Electron 项目并行开发时会共用同一目录，数据互相污染。**
- **单实例锁为什么必须有**：数据写死在 `userData/data/notes.json`。两个实例同时跑会各自持有内存副本并互相覆盖，**造成静默丢数据**；托盘应用还会出现两个托盘图标。
- **开发态任务栏图标仍是 Electron 默认图** —— 那一格取的是 exe 内嵌图标资源，进程运行时改不了，只有打包成 `简记.exe` 后才正确。这是 Electron 的已知限制，不是配置问题。传 `new BrowserWindow({ icon })` 只能改窗口左上角的小图标。

## Markdown 即时预览

编辑器不做「源码 / 预览」切换，输入即刻渲染。

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

> 重新打包编辑器内核：`npm run build:cm`（esbuild iife → `vendor/cm6.js`）。该产物已入库，保证 clone 下来即可运行。

## 数据结构

服务端存档（`data/notes.json`）是一个扁平对象：

```jsonc
{
  "notes":  [{ id, title, content /* Markdown */, tags, pinned, favorite, manualTitle, createdAt, updatedAt }],
  "tasks":  [{ id, listId, title, content, done, due, priority /* 0-2 */, starred, createdAt, updatedAt, doneAt }],
  "lists":  [{ id, name, color, collapsed }],   // id 为 "inbox" 的是默认收件箱
  "settings": { theme, sidebarCollapsed, autoPull, collapsedLists, sort },
  "deleted": [{ id, kind, deletedAt }],          // 墓碑，见 SYNC.md
  "savedAt": 1789000000000
}
```

前端 `state` 是它的内存镜像，变更后 `persist()` 防抖写回。

## 存储键迁移（更名历史）

应用由「素笺」更名为「简记」时，localStorage 键同步前移。为避免老用户升级后看到空笔记库，`js/app.js` 保留了完整回退链，**首次启动自动迁移、旧键不删**（留作回滚保险）：

| 用途 | 新键 | 兼容读取的旧键 |
| --- | --- | --- |
| 笔记存档 | `jianji-notes-v2` | `sujian-notes-v2` → `sujian-notes-v1` → `liulin-notes-v1` |
| 主题 | `jianji-theme` | `sujian-theme` |
| 侧栏折叠 | `jianji-sidebar-collapsed` | `sujian-sidebar-collapsed` |

主题优先级：URL `?theme=` > 存档 `settings.theme` > 本地偏好键。存档里的主题是「存档时刻的快照」，本机偏好代表用户此刻的选择。

## 图标体系

`icon/` 全由 `scripts/make-icon.py` **生成**，不要手改产物：

```bash
python scripts/make-icon.py     # 需 Pillow：pip install pillow
```

图形是一支斜置的「签字笔」：深炭圆角底 + 奶油白笔身 + 笔尖处的强调橙墨点。配色直接取自 `css/style.css` 主题变量（`#21201c` / `#faf9f5` / `#d97757`），所以图标和界面是同一套色。

- `jianji-icon.ico` —— Windows 打包必须用 `.ico`。NSIS 读 PNG 会直接报 `Error while loading icon ... invalid icon file` 并中止构建（electron-builder 不会自动转换）。内嵌 16/24/32/48/64/128/256 七档。
- `jianji-icon-256.png` —— 经 `extraResources` 落到 `resources/icon.png`，供运行时 `resolveIcon()` 使用。
- `jianji-icon.svg` —— 矢量版，网页 favicon 首选。
- `jianji-icon-16/32.png` —— favicon 位图兜底（小尺寸要单独出图，缩 180 会糊）。
- `jianji-icon-180.png` —— apple-touch-icon。

### 托盘图标必须两套（硬约束）

`jianji-tray-light.ico` / `jianji-tray-dark.ico`，各含 16/20/24/32 四档。

托盘区只有 16~24px，单色图标不可能同时适配浅色和深色托盘条：

| 方案 | 浅色托盘条 | 深色托盘条 |
| --- | --- | --- |
| 白色笔身 | **完全消失** | 清晰 |
| 深色笔身 | 清晰 | **完全消失** |
| 去掉墨点的纯色 | **消失** | 一根白线，认不出是简记 |

这是物理限制，调色解决不了。所以按 VS Code / Docker Desktop 的通行做法，运行期监听 `nativeTheme`，在两套之间 `setImage` 切换（见 `electron/main.js`）。

托盘图标还有三点与应用图标不同：

1. **不要深色圆角方底** —— 托盘区里带底的方块就是一块糊掉的黑斑，还会和相邻图标打架。
2. **保留橙色墨点** —— 它是整套视觉唯一的识别锚点，深浅两种底上都出得来。
3. **用 `.ico` 而非 PNG** —— Windows 托盘按 DPI 挑档，ico 内嵌多档才不糊。

> 网页里的 logo 与 `.ico` 同源：`index.html` 里 `.brand-logo` / `.empty-logo` 的 SVG 坐标是从 `make-icon.py` 的同一组几何参数算出来的。改图形时两边一起改，否则应用内 logo 会和任务栏图标对不上。
