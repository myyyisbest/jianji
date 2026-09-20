# 云同步

> 面向维护者。用户视角的操作步骤见 [README](../README.md#-云端同步)。

## 存档与配置

一次同步的是一个**整体存档**：

```jsonc
{ "notes": [...], "tasks": [...], "lists": [...], "settings": {...}, "deleted": [...], "savedAt": 1789000000000 }
```

- S3 存档对象默认 `notes.json`
- WebDAV 存档路径默认 `/notes.json`（父目录不存在时自动逐级 MKCOL）
- S3 走 AWS SigV4 直连，兼容一切 SigV4 服务；WebDAV 走 Basic Auth，兼容坚果云、Nextcloud、群晖

同步配置存在 `data/s3-config.json`（**明文**，见 [SECURITY.md](SECURITY.md) 的已知取舍），两种类型的配置可分别留存，切换 `type` 即可。

## 合并规则：只有两条

`mergeArchives(local, remote)` 是**条目级**的：

1. 同一个 `id`：`updatedAt` 较新的一方胜出
2. 删除不做物理移除，而是往 `deleted` 里写一条墓碑 `{id, kind, deletedAt}`；
   合并时若某条目的 `updatedAt <= 墓碑.deletedAt`，就把该条目删掉

## 墓碑带来一个必然结果：删除是永久且粘性的

云端那条数据的 `updatedAt` 必然早于「你删除它的时刻」，所以每次合并都会重新命中墓碑判定、把它再删一次 —— 这就是**「删掉之后再也拉不回来」**的根因。

普通合并尊重这个语义是对的（多端删除需要传播），但必须留逃生通道，于是有了：

**「从云端恢复」**（设置面板，需点击两次确认）：丢弃墓碑、以云端为准覆盖本地。
实现要点是**先把 `deleted` 里「云端存在的 id」过滤掉** —— 墓碑若留着，下一轮合并会立刻把刚恢复的内容再删一次，等于白恢复。只清这些 id、不动其他墓碑，是为了不把本机其他删除意图一起推翻。

## 启动顺序：必须先探云端，再决定是否推送

`init()` 里的顺序曾经是「`seed()` → `scheduleCloudSave()` → `autoPullTick()`」，这在**云端有数据、本地存档被清空**时是灾难性的：

```
PUT  bucket/notes.json (309 bytes)   ← 云端本来有真实数据
（本地存档被清空 → 触发 seed() 重建示例）
PUT  bucket/notes.json (4812 bytes)  ← 示例内容把云端真实数据覆盖了
GET  bucket/notes.json               ← 才轮到 pull
```

修法：本地有内容、而后端存档为空时，**先 `await autoPullTick()` 探一次云端**，只有确认云端也为空（或未配置同步）才允许推送；云端不可达时明确告知用户「本次未上传，以免覆盖云端数据」。

## 合并完必须 `renderSidebar()`

`pullCloud()` / `autoPullTick()` 原先只调 `restoreSelection()`。而 `restoreSelection()` 仅在**当前选中项失效时**才补一次 `renderSidebar()` —— 选中项还有效时，侧栏列表一个节点都不会重建。表现就是「数据其实拉下来了，但界面没变」，极易被误认为「拉取功能坏了」。

两条路径统一走 `applyMerged()`，由它负责 `persist()` + `renderSidebar()` + `renderTags()` + `restoreSelection()`。

## 失败不再静默

`autoPullTick()` 以前在 `!r.ok` 时直接 `return`，后端挂掉或云端不可达时用户毫无感知。现在会提示一次（用 `autoPullWarned` 闸门避免每 60 秒刷屏，下次成功后复位）。

`saveConfigFromForm()` 保存配置后也会调 `startAutoPull(true)` 重建定时器 —— 否则 `Backend.syncConfigured` 只在启动时更新过，改完配置必须刷新页面自动同步才生效。

> `let autoPullWarned` 曾写在 `autoPullTick()` **之后**。`let` 会提升到作用域顶部但处于暂时性死区，函数一被调用就抛 `ReferenceError`，而错误被 `try/catch` 的 `console.warn` 吞掉，表现只是「提示没出现」。**声明必须排在首次使用之前。**

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（笔记数 / 任务数 / 是否配置同步） |
| GET | `/api/notes` | 读取本地存档（含 tasks / lists / settings / deleted） |
| PUT | `/api/notes` | 覆盖保存，autoSync 时顺带推送 |
| GET | `/api/config` | 读取同步配置 `{type, s3, webdav, autoSync}` |
| PUT | `/api/config` | 保存同步配置（按 type 校验必填项） |
| POST | `/api/config/test` | 连接诊断（按类型逐级检查凭证与存档） |
| GET | `/api/sync/remote` | 只读云端存档（供前端合并） |
| POST | `/api/sync/push` | 本地 → 云端 |
| POST | `/api/sync/pull` | 云端 → 本地（保留 settings / deleted） |

请求体上限：`PUT /api/notes` 32 MB，`PUT /api/config` 256 KB，超限返回 413 并断开连接。

> `/api/health` 的 `sync` 字段是「当前类型 endpoint 非空」，不是「配置文件存在」—— `getSyncConfig()` 会把空文件补成 endpoint 为空的 s3 配置。

## 本地自测

```bash
node scripts/mock-s3.js       # Mock S3（:9121，不做签名校验）
node scripts/mock-webdav.js   # Mock WebDAV（:9700，Basic Auth 固定 u:p）
```

`npm run test:sync` 会自行拉起 mock S3 与一个独立端口的 `server.js`，不需要预先起服务。
