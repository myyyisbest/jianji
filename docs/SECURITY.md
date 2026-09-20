# 安全模型

> 2026-09 全面审查后加固。改服务器代码前先读。

## 前提：后端是零鉴权的

`server.js` 没有任何登录态。这是本地单用户应用的取舍，**因此暴露面必须收到最小**。

| 防线 | 说明 |
| --- | --- |
| 默认仅监听回环 | `HOST` 默认 `127.0.0.1`（原为 `0.0.0.0` —— 局域网内任何设备都能拿到明文 S3/WebDAV 凭据、覆盖你的笔记）。确需局域网访问：`HOST=0.0.0.0 node server.js`，自担风险 |
| 请求体大小限制 | `/api/notes` 32 MB、`/api/config` 256 KB，超限返回 413 并断开连接（原先无上限，一个超大 POST 就能吃满进程内存） |
| 存档原子写入 | `writeJson` 先写 `.tmp` 再 `rename`，崩溃/断电不会留下半截 JSON；覆盖前把上一版留为 `notes.json.bak` |
| 主档损坏自动回退 | `readJson` 主档解析失败时回退 `.bak`，避免「半截 JSON → `seed()` 静默重建 → 用户存档被顶掉」的事故链 |
| 静态路径越界判定 | `path.relative(ROOT, fp).startsWith('..')`（原为 `startsWith(ROOT)` 前缀匹配，兄弟目录如 `sujian-notes-evil` 可绕过） |
| CSP | `index.html` 加 `Content-Security-Policy`：脚本仅限同源，即便未来出现 XSS 也无法执行外部脚本。**别往页面里加内联 `<script>` 或 CDN 脚本** |
| Electron 导航锁死 | `will-navigate` 只放行后端自身（随机回环端口），其余导航一律拒绝并转交系统浏览器 |
| preload 白名单 | `contextBridge` 只暴露 `desktop.isElectron` / `platform` / `onNewNote`。页面拿不到 `window.require` / `window.process` / `window.ipcRenderer` —— 这三项保持 `undefined` 是安全基线的判据，回归测试有断言 |

## 数据安全三层兜底

云端存档（S3/WebDAV）→ 服务端 `notes.json.bak`（上一版已知良好）→ `localStorage` 缓存。

前端 localStorage 写满时会限频提示（10 分钟一次），不再静默丢失。

> `.bak` 是「上一版」不是「最后可用版」：坏值写入后 `.bak` 会继承它。单层 `.bak` 够用，但别把它当干净备份用于「恢复已知良好状态」。

## 已知取舍

- **同步凭据以明文存在 `data/s3-config.json`**。本地单用户场景下，加密只会带来虚假的安全感（密钥同样要落在同台机器上）。真正的防护是「默认只监听回环 + `data/` 已 gitignore」。
  **请勿将 `data/` 提交到仓库。**
- **后端零鉴权**：见上。如果你要把它部署到多用户环境，这套模型不适用。

## 报告漏洞

请通过 GitHub Issue 提交（涉及敏感信息的，先脱敏描述，细节可私信）。
