# 素笺（sujian-notes）服务器部署与配置说明

> **本文档的读者**：协助用户在服务器上部署、配置和维护本应用的 AI 助手。
> 请按本文档执行操作；遇到报错时参考「常见问题」章节定位。

## 1. 项目概况

- 这是什么：一款自托管的在线笔记 Web 应用（前端 + 后端一体）。
- 技术形态：**单文件 Node.js 服务**（`server.js`），同时提供静态页面和 HTTP API。
- 关键约束（影响部署方案选择）：
  - **零 npm 依赖**：不需要 `npm install`，不需要构建步骤。
  - **无数据库**：笔记存储为单个 JSON 文件（`data/notes.json`）。
  - **资源占用极低**：常驻内存约 30-50 MB，单核 CPU 即可，1核1G 的服务器完全够用。
- 运行要求：**Node.js >= 18**（仅此一项）。

## 2. 文件结构

```
sujian-notes/
├── server.js           # 后端服务（启动入口）
├── index.html          # 前端页面
├── css/style.css       # 样式
├── js/app.js           # 前端逻辑
├── scripts/mock-s3.js  # 本地 Mock S3（仅开发调试用，服务器上不需要运行）
├── data/               # 运行时自动生成：notes.json（笔记）、s3-config.json（S3配置）
└── AI-DEPLOY.md        # 本文档
```

## 3. 部署步骤

### 3.1 检查 Node 版本

```bash
node --version   # 需要 v18 及以上
```

若无 Node 或版本过低（Debian/Ubuntu 示例）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
```

（其他发行版请用对应包管理器安装 Node 18+。）

### 3.2 启动

先临时前台运行验证：

```bash
cd /path/to/sujian-notes
node server.js
# 看到输出「素笺服务已启动: http://localhost:8642」即成功，Ctrl+C 退出
```

环境变量（可选）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8642` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只允许本机访问可改为 `127.0.0.1` |
| `DATA_DIR` | `./data` | 数据目录（笔记与配置存放处） |

### 3.3 用 systemd 守护（推荐，内存开销最低）

创建 `/etc/systemd/system/sujian.service`：

```ini
[Unit]
Description=Sujian Notes
After=network.target

[Service]
Type=simple
# 建议改为普通用户运行；该用户需对应用目录有写权限（data/ 目录）
User=www-data
WorkingDirectory=/path/to/sujian-notes
ExecStart=/usr/bin/node server.js
Environment=PORT=8642
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sujian
systemctl status sujian        # 确认 active (running)
```

验证：`curl http://127.0.0.1:8642/api/health` 应返回 `{"ok":true,...}`。

> 不想用 systemd 也可用 `pm2 start server.js --name sujian`，但 pm2 本身占内存，低配服务器优先 systemd。

### 3.4 放行端口

- 云服务器请在**控制台安全组**放行 TCP `8642`（或自定义端口）。
- 服务器本机防火墙：`sudo ufw allow 8642/tcp`（如有启用 ufw）。

### 3.5（可选）Nginx 反向代理 + HTTPS

应用自身可直接通过 `http://服务器IP:8642` 访问。如需域名 + HTTPS：

```nginx
server {
    listen 80;
    server_name notes.example.com;

    location / {
        proxy_pass http://127.0.0.1:8642;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

HTTPS 证书：`sudo certbot --nginx -d notes.example.com`（需已安装 certbot）。

## 4. 数据与备份

- 笔记数据：`data/notes.json` —— 全部笔记（标题/内容/标签/置顶等）都在这一个文件里。
- S3 配置：`data/s3-config.json` —— **含密钥，注意文件权限（建议 600），不要提交到公开仓库**。
- 备份 = 复制 `data/` 目录；恢复 = 放回 `data/` 并重启服务。
- 应用更新/升级：直接覆盖 `server.js / index.html / css / js` 后 `systemctl restart sujian`，`data/` 不受影响。

## 5. S3 云备份配置（可选功能）

用途：把笔记存档自动备份到用户自己的 S3 兼容对象存储。**在线笔记场景非必需**（浏览器访问同一后端即为多端共享）。

配置入口：网页右上角「设置」→「S3 云端存储」。

| 字段 | 说明 |
| --- | --- |
| Endpoint | S3 兼容端点，如 AWS `https://s3.us-east-1.amazonaws.com`、又拍云 Bitiful `https://s3.bitiful.net`、Cloudflare R2 `https://<accountid>.r2.cloudflarestorage.com`、MinIO 自建地址 |
| Region | 区域；Bitiful 填 `cn-east-1`，R2 填 `auto` 或 `us-east-1`，AWS 填桶所在区域 |
| Bucket | 桶名。**注意**：密钥所属账号/子用户必须有该桶权限，否则报 403 |
| Access Key / Secret | 对象存储的密钥 |
| 对象名 | 存档文件名，默认 `notes.json` |
| 保存即上传 | 每次保存笔记自动上传存档 |
| 多端自动同步 | 定时合并云端变更（供未来本地 App 多端场景使用；在线单后端部署**无需开启**） |

排障：点「测试连接」，后端会逐级诊断并给出明确原因：

- `凭证校验未通过` → Access Key / Secret 错误或被禁用
- `凭证有效，但无法访问桶 ×××` → 桶名错误，或桶未授权给密钥所属的子用户（Bitiful 常见，需在控制台把桶授权给密钥对应的子用户）
- `连接成功` → 可正常推送/拉取

已知兼容性：AWS S3、Bitiful、R2、MinIO 等支持 AWS SigV4 签名的服务均可；阿里云 OSS 请使用其 S3 兼容端点并确认密钥已开启兼容鉴权。

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动报 `Cannot find module` | 启动目录不对，须在应用根目录执行 `node server.js`，或确认文件完整 |
| `EADDRINUSE` 端口被占用 | 换端口：`PORT=9000 node server.js`，或找出占用进程 `ss -tlnp | grep 8642` |
| 外网无法访问 | 安全组未放行端口；或 HOST 被设为 127.0.0.1 |
| 页面能开但右上角圆点是灰色 | 后端未连通（页面是以 file:// 直接打开，或服务未运行）；部署到服务器后通过 http 地址访问即为绿色 |
| 保存状态显示「仅本地」 | 后端暂不可达，笔记只存在浏览器里；恢复后端后刷新页面会以服务器存档为准 |
| 推送 S3 报 403 | 见第 5 节排障 |

## 7. 安全建议

- 服务本身无鉴权，任何知道地址的人都能读写笔记。公网部署建议：仅局域网/内网使用，或置于 Nginx 后加 Basic Auth / VPN 访问。
- `data/s3-config.json` 含对象存储密钥，控制文件权限（`chmod 600`）。
- 建议 HTTPS（见 3.5）。

## 8. 给 AI 的操作提示

- 修改配置后重启：`sudo systemctl restart sujian`。
- 查看运行日志：`journalctl -u sujian -n 50 --no-pager`。
- 检查 API 是否正常：`curl -s http://127.0.0.1:8642/api/health`。
- 用户的笔记数据在 `data/notes.json`，操作前如需改动请先备份该文件。
