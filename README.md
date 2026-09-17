# 素笺 · 简洁云端笔记

一款 **简洁风格**（暖米白 / 暖深色双主题）的云端笔记应用：前端零依赖，后端为单文件 Node 服务，支持笔记本地持久化与 **S3 云端同步**（AWS SigV4 直连，兼容 AWS S3 / Cloudflare R2 / MinIO 等）。

## ✨ 特性

- **界面**：暖米白 / 暖深色双主题、衬线标题、赤陶橙强调色，左侧列表可一键收起，移动端抽屉式布局
- **富文本编辑**：标题 / 加粗 / 斜体 / 下划线 / 删除线 / 高亮 / 列表 / 待办清单 / 引用 / 代码块
- **笔记管理**：自动保存、全文搜索、置顶、收藏、删除撤销（5 秒内）、按时间 / 标题排序、导出 Markdown
- **后端持久化**：`node server.js` 后笔记自动保存到服务器 `data/notes.json`
- **S3 云同步**：在「设置」中配置 S3，支持自动同步、手动推送 / 从云端拉取最新存档
- **快捷键**：`Ctrl/⌘ K` 搜索 · `Ctrl/⌘ Alt N` 新建 · `Esc` 关闭弹窗

## 🚀 运行

```bash
cd project
node server.js
# 默认 http://localhost:8642（PORT / HOST 环境变量可改）
```

不做后端、直接双击 `index.html` 也能用，此时笔记仅保存在浏览器 localStorage（界面会提示「后端未连接」）。

## ☁️ S3 同步

1. 启动后端，点击顶栏「设置」
2. 填写 Endpoint / Region / Bucket / Access Key / Secret（兼容一切支持 SigV4 的 S3 服务）
3. 开启「自动同步」：每次保存笔记自动上传；也可手动「推送到云端」/「从云端拉取」

- 存档对象默认为 `notes.json`（可自定义）
- 「从云端拉取」会用云端存档**覆盖**本地，适合多设备同步
- 数据链路：浏览器 → `server.js`（`data/notes.json`）→ 你的 S3 桶

本地自测同步链路（无需真实 S3）：

```bash
node scripts/mock-s3.js    # 起一个 Mock S3（:9000，不做签名校验）
# 设置中填：Endpoint http://localhost:9000，Bucket 任意
```

> 注意：对真实 S3 而言密钥保存在服务器 `data/s3-config.json`，请勿将 `data/` 提交到公共仓库。

## 📁 结构

```
project/
├── index.html          # 页面结构（含设置弹窗）
├── css/style.css       # 简洁风格设计系统（双主题）
├── js/app.js           # 前端逻辑（编辑器 / 后端 API / S3 设置）
├── server.js           # 零依赖 Node 后端（静态服务 + API + SigV4）
├── scripts/mock-s3.js  # 本地 Mock S3（自测同步用）
└── data/               # 运行时生成：notes.json、s3-config.json
```

## 🔌 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（笔记数 / 是否配置 S3） |
| GET | `/api/notes` | 读取本地存档 |
| PUT | `/api/notes` | 覆盖保存 `{notes: []}`，autoSync 时顺带推送 |
| GET | `/api/config` | 读取 S3 配置 |
| PUT | `/api/config` | 保存 S3 配置 |
| POST | `/api/sync/push` | 本地 → S3 |
| POST | `/api/sync/pull` | S3 → 本地（覆盖并返回） |
