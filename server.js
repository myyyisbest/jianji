/* ============================================================
   简记 · 后端服务（零依赖，Node >= 18）
   - 笔记持久化到本地 data/notes.json
   - S3 云端同步（AWS SigV4 签名，兼容 AWS S3 / R2 / MinIO 等）
   API:
     GET  /api/health        健康检查
     GET  /api/notes         读取本地笔记存档
     PUT  /api/notes         覆盖保存笔记（配置了自动同步时顺带推到 S3）
     GET  /api/config        读取 S3 配置
     PUT  /api/config        保存 S3 配置
     POST /api/sync/push     本地 -> S3
     POST /api/sync/pull     S3 -> 本地（并返回数据）
   ============================================================ */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8642;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const CONFIG_FILE = path.join(DATA_DIR, 's3-config.json');
const DEFAULT_OBJECT = 'notes.json';

/* ---------------- 文件读写 ---------------- */
function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, data) { ensureDataDir(); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

/* ---------------- AWS SigV4 ---------------- */
const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, buf) => crypto.createHmac('sha256', key).update(buf).digest();

function s3Request(method, cfg, { body = null, list = false } = {}) {
  return new Promise((resolve, reject) => {
    let endpoint;
    try { endpoint = new URL(cfg.endpoint); } catch { return reject(new Error('Endpoint 无效')); }
    const hostHeader = endpoint.host;                 // 非默认端口会自动带上
    const port = endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80);
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    const objectKey = (cfg.objectKey || DEFAULT_OBJECT).replace(/^\/+/, '');
    // list 模式：GET /（列出凭证账号下所有桶，用于连接诊断）
    const canonicalUri = list
      ? (basePath || '/')
      : `${basePath}/${cfg.bucket}/${objectKey}`.replace(/\/{2,}/g, '/');

    const payload = body === null ? '' : body;
    const payloadHash = sha256hex(payload);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const region = cfg.region || 'us-east-1';
    const service = 's3';

    // 仅参与签名的头；content-length 属于传输头，按 AWS SDK 惯例不签名（只发送）
    const headers = {
      host: hostHeader,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };

    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map(h => `${h}:${headers[h]}\n`).join('');
    const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

    const kDate = hmac('AWS4' + cfg.secretAccessKey, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const sendHeaders = { ...headers, Authorization: authorization };
    if (body !== null) sendHeaders['content-length'] = Buffer.byteLength(payload);

    const req = (endpoint.protocol === 'https:' ? https : http).request({
      method,
      host: endpoint.hostname,
      port,
      path: canonicalUri,
      headers: sendHeaders,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('S3 请求超时')));
    if (body !== null) req.write(payload);
    req.end();
  });
}

/* ---------------- 同步配置（S3 / WebDAV 双后端） ---------------- */
/* 存储结构：{ type: 's3'|'webdav', autoSync, s3: {...}, webdav: {...} }
   旧版平铺 S3 配置读取时自动迁移，无需手动处理 */
function getSyncConfig() {
  const raw = readJson(CONFIG_FILE);
  if (!raw) return null;
  if ((raw.type === 's3' || raw.type === 'webdav') && (raw.s3 || raw.webdav)) return raw;
  // 旧格式：平铺 S3 字段
  return {
    type: 's3',
    autoSync: !!raw.autoSync,
    s3: {
      endpoint: raw.endpoint || '',
      region: raw.region || '',
      bucket: raw.bucket || '',
      accessKeyId: raw.accessKeyId || '',
      secretAccessKey: raw.secretAccessKey || '',
      objectKey: raw.objectKey || DEFAULT_OBJECT,
    },
    webdav: null,
  };
}

function activeSync(cfg) {
  if (!cfg) return null;
  if (cfg.type === 'webdav') return cfg.webdav ? { kind: 'webdav', c: cfg.webdav } : null;
  return cfg.s3 ? { kind: 's3', c: cfg.s3 } : null;
}

/* ---------------- WebDAV 客户端（Basic Auth） ---------------- */
function webdavRequest(method, wd, { body = null, path: rel, depth } = {}) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(wd.endpoint); } catch { return reject(new Error('WebDAV 地址无效')); }
    if (rel === undefined) rel = wd.remotePath || '/' + DEFAULT_OBJECT;
    const fullPath = (base.pathname.replace(/\/+$/, '') + '/' + String(rel).replace(/^\/+/, '')).replace(/\/{2,}/g, '/') || '/';

    const headers = {
      Authorization: 'Basic ' + Buffer.from(`${wd.username}:${wd.password}`).toString('base64'),
    };
    if (depth !== undefined) headers.Depth = String(depth);
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = (base.protocol === 'https:' ? https : http).request({
      method,
      host: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: fullPath,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('WebDAV 请求超时')));
    if (body !== null) req.write(body);
    req.end();
  });
}

/* 逐级 MKCOL 创建存档路径的父目录（405/409 视为已存在，忽略） */
async function webdavEnsureDirs(wd) {
  const segs = String(wd.remotePath || '/' + DEFAULT_OBJECT).replace(/^\/+/, '').split('/').slice(0, -1);
  let cur = '';
  for (const s of segs) {
    cur += '/' + s;
    await webdavRequest('MKCOL', wd, { path: cur }).catch(() => null);
  }
}

async function webdavPush(wd) {
  const data = readJson(NOTES_FILE);
  if (!data) return { ok: false, error: '本地暂无笔记存档' };
  const body = JSON.stringify(data);
  let r = await webdavRequest('PUT', wd, { body });
  if (r.status === 409) {                       // 父目录不存在
    await webdavEnsureDirs(wd);
    r = await webdavRequest('PUT', wd, { body });
  }
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, uploadedAt: Date.now(), object: wd.remotePath || '/' + DEFAULT_OBJECT };
  }
  return { ok: false, error: `WebDAV 返回 ${r.status}：${r.body.toString('utf8').slice(0, 200)}` };
}

async function webdavGet(wd) {
  const r = await webdavRequest('GET', wd);
  if (r.status === 404) return { status: 404 };
  if (r.status !== 200) return { status: r.status, error: `WebDAV 返回 ${r.status}` };
  try {
    const data = JSON.parse(r.body.toString('utf8'));
    if (!data || !Array.isArray(data.notes)) return { status: 200, error: '云端存档格式不正确' };
    return { status: 200, data };
  } catch { return { status: 200, error: '云端存档不是有效的 JSON' }; }
}

/* ---------------- 统一推送（按配置类型分发） ---------------- */
async function pushRemote() {
  const cfg = getSyncConfig();
  if (!cfg) return { ok: false, error: '尚未配置云端同步' };
  const act = activeSync(cfg);
  if (!act) return { ok: false, error: `尚未配置 ${cfg.type === 'webdav' ? 'WebDAV' : 'S3'}` };
  if (act.kind === 'webdav') return webdavPush(act.c);
  const data = readJson(NOTES_FILE);
  if (!data) return { ok: false, error: '本地暂无笔记存档' };
  const r = await s3Request('PUT', act.c, { body: JSON.stringify(data) });
  if (r.status === 200) return { ok: true, uploadedAt: Date.now(), object: `${act.c.bucket}/${act.c.objectKey || DEFAULT_OBJECT}` };
  return { ok: false, error: `S3 返回 ${r.status}：${r.body.toString('utf8').slice(0, 200)}` };
}

/* ---------------- HTTP 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, data, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(data) ? data : (typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(fp, (err, buf) => {
    if (err) return send(res, 404, 'Not Found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(fp)] || 'application/octet-stream');
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (p.startsWith('/api/')) {
      /* 健康检查 */
      if (req.method === 'GET' && p === '/api/health') {
        const d = readJson(NOTES_FILE);
        return send(res, 200, {
          ok: true,
          notes: d ? (d.notes || []).length : 0,
          tasks: d ? (d.tasks || []).length : 0,
          sync: !!getSyncConfig(),
        });
      }

      /* 存档读取（笔记 + 任务 + 清单 + 偏好 + 删除墓碑） */
      if (req.method === 'GET' && p === '/api/notes') {
        const d = readJson(NOTES_FILE);
        return send(res, 200, {
          ok: true,
          notes: d ? d.notes : null,
          tasks: d ? (d.tasks || []) : [],
          lists: d ? (d.lists || []) : [],
          settings: d ? (d.settings || null) : null,
          deleted: d ? (d.deleted || []) : [],
          savedAt: d ? d.savedAt : null,
        });
      }

      if (req.method === 'PUT' && p === '/api/notes') {
        let data;
        try { data = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { ok: false, error: 'JSON 无效' }); }
        if (!data || !Array.isArray(data.notes)) return send(res, 400, { ok: false, error: '格式应为 {notes: []}' });
        const pkg = {
          notes: data.notes,
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
          lists: Array.isArray(data.lists) ? data.lists : [],
          settings: data.settings || {},
          deleted: Array.isArray(data.deleted) ? data.deleted : [],
          savedAt: Date.now(),
        };
        writeJson(NOTES_FILE, pkg);
        const cfg = getSyncConfig();
        const cloud = { enabled: !!cfg, autoSync: !!(cfg && cfg.autoSync) };
        if (cfg && cfg.autoSync) {
          try { Object.assign(cloud, await pushRemote()); } catch (e) { cloud.pushed = false; cloud.error = e.message; }
        }
        return send(res, 200, { ok: true, cloud });
      }

      /* 同步配置（S3 / WebDAV） */
      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, { ok: true, config: getSyncConfig() });
      }

      if (req.method === 'PUT' && p === '/api/config') {
        let c;
        try { c = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { ok: false, error: 'JSON 无效' }); }
        const type = c.type === 'webdav' ? 'webdav' : 's3';
        const prev = getSyncConfig() || {};
        const clean = { type, autoSync: !!c.autoSync };

        if (c.s3 || prev.s3) {
          const s = c.s3 || prev.s3 || {};
          const s3 = {
            endpoint: String(s.endpoint || '').trim(),
            region: String(s.region || '').trim(),
            bucket: String(s.bucket || '').trim(),
            accessKeyId: String(s.accessKeyId || '').trim(),
            secretAccessKey: String(s.secretAccessKey || '').trim(),
            objectKey: String(s.objectKey || DEFAULT_OBJECT).trim().replace(/^\/+/, ''),
          };
          if (s3.endpoint && !/^https?:\/\//.test(s3.endpoint)) s3.endpoint = 'https://' + s3.endpoint;
          clean.s3 = s3;
        }
        if (c.webdav || prev.webdav) {
          const w = c.webdav || prev.webdav || {};
          const webdav = {
            endpoint: String(w.endpoint || '').trim(),
            username: String(w.username || '').trim(),
            password: String(w.password || ''),
            remotePath: ('/' + String(w.remotePath || DEFAULT_OBJECT).trim().replace(/^\/+/, '')),
          };
          if (webdav.endpoint && !/^https?:\/\//.test(webdav.endpoint)) webdav.endpoint = 'https://' + webdav.endpoint;
          clean.webdav = webdav;
        }

        // 只校验当前启用类型的必填项，另一种配置允许留空暂存
        if (type === 's3') {
          const s = clean.s3 || {};
          if (!s.endpoint || !s.bucket || !s.accessKeyId || !s.secretAccessKey) {
            return send(res, 400, { ok: false, error: 'S3：Endpoint / Bucket / Access Key ID / Secret Access Key 为必填' });
          }
        } else {
          const w = clean.webdav || {};
          if (!w.endpoint || !w.username || !w.password) {
            return send(res, 400, { ok: false, error: 'WebDAV：地址 / 用户名 / 密码（或应用密码）为必填' });
          }
        }
        writeJson(CONFIG_FILE, clean);
        return send(res, 200, { ok: true, config: clean });
      }

      /* 云端存档只读（前端拿去与本地合并，不直接覆盖服务器） */
      if (req.method === 'GET' && p === '/api/sync/remote') {
        const cfg = getSyncConfig();
        if (!cfg) return send(res, 400, { ok: false, error: '尚未配置云端同步' });
        const act = activeSync(cfg);
        if (!act) return send(res, 400, { ok: false, error: '同步配置不完整' });
        try {
          let data, status;
          if (act.kind === 'webdav') {
            const r = await webdavGet(act.c);
            status = r.status;
            if (r.error) return send(res, r.status === 404 ? 404 : 502, { ok: false, error: r.error });
            data = r.data;
          } else {
            const r = await s3Request('GET', act.c);
            status = r.status;
            if (r.status === 404) return send(res, 404, { ok: false, error: '云端暂无存档' });
            if (r.status !== 200) return send(res, 502, { ok: false, error: `S3 返回 ${r.status}` });
            try { data = JSON.parse(r.body.toString('utf8')); } catch { return send(res, 502, { ok: false, error: '云端存档不是有效的 JSON' }); }
            if (!data || !Array.isArray(data.notes)) return send(res, 502, { ok: false, error: '云端存档格式不正确' });
          }
          if (status === 404) return send(res, 404, { ok: false, error: '云端暂无存档' });
          return send(res, 200, {
            ok: true,
            archive: {
              notes: data.notes,
              tasks: data.tasks || [],
              lists: data.lists || [],
              settings: data.settings || {},
              deleted: data.deleted || [],
              savedAt: data.savedAt || 0,
            },
          });
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      /* 连接测试：按类型分发（S3 逐级诊断 / WebDAV 两级诊断） */
      if (req.method === 'POST' && p === '/api/config/test') {
        const cfg = getSyncConfig();
        if (!cfg) return send(res, 400, { ok: false, error: '尚未保存配置，请先填写并点击「保存配置」' });
        const act = activeSync(cfg);
        if (!act) return send(res, 400, { ok: false, error: '同步配置不完整' });

        if (act.kind === 'webdav') {
          try {
            const wd = act.c;
            // 1) PROPFIND Depth:0 验证服务与凭证（部分服务器不支持则降级到直接 GET）
            try {
              const p = await webdavRequest('PROPFIND', wd, { path: '/', depth: 0 });
              if (p.status === 401 || p.status === 403) {
                return send(res, 502, { ok: false, error: `凭证校验未通过（${p.status}）：请检查用户名与密码/应用密码` });
              }
            } catch (e) { /* PROPFIND 不可用属正常，继续用 GET 判断 */ }
            // 2) GET 目标存档
            const g = await webdavGet(wd);
            if (g.status === 200 && !g.error) {
              return send(res, 200, { ok: true, message: '连接成功：凭证有效，云端已有存档' });
            }
            if (g.status === 404) {
              return send(res, 200, { ok: true, message: '连接成功：凭证有效，云端暂无存档（推送一次即可）' });
            }
            if (g.status === 401 || g.status === 403) {
              return send(res, 502, { ok: false, error: `凭证校验未通过（${g.status}）：请检查用户名与密码/应用密码` });
            }
            return send(res, 502, { ok: false, error: g.error || `WebDAV 返回 ${g.status}` });
          } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
        }

        try {
          const s3 = act.c;
          // 1) 列桶：验证凭证有效性
          const list = await s3Request('GET', s3, { list: true });
          if (list.status !== 200) {
            const code = (list.body.toString().match(/<Code>([^<]+)/) || [])[1] || '';
            return send(res, 502, { ok: false, error: `凭证校验未通过（${list.status} ${code}）：请检查 Access Key ID 与 Secret Key 是否正确、密钥是否被禁用` });
          }
          const buckets = [...list.body.toString().matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);

          // 2) 读对象：区分「桶不存在/无权限」与「正常」
          const probe = await s3Request('GET', s3);
          if (probe.status === 404) {
            return send(res, 200, { ok: true, message: `连接成功：凭证有效，桶「${s3.bucket}」可正常读写（云端暂无存档，推送一次即可）` });
          }
          if (probe.status === 200) {
            return send(res, 200, { ok: true, message: `连接成功：凭证有效，桶「${s3.bucket}」访问正常，云端已有存档` });
          }
          if (probe.status === 403) {
            return send(res, 200, {
              ok: false,
              error: `凭证有效，但无法访问桶「${s3.bucket}」（AccessDenied）：通常是该桶未授权给密钥所属的子用户，或桶名有误。${buckets.length ? '你的 Key 可用的桶：' + buckets.join('、') : ''}`,
              buckets,
            });
          }
          return send(res, 502, { ok: false, error: `读取对象失败（${probe.status}）：${probe.body.toString('utf8').slice(0, 150)}` });
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      /* 同步 */
      if (req.method === 'POST' && p === '/api/sync/push') {
        try {
          const r = await pushRemote();
          return send(res, r.ok ? 200 : 502, r);
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      if (req.method === 'POST' && p === '/api/sync/pull') {
        const cfg = getSyncConfig();
        if (!cfg) return send(res, 400, { ok: false, error: '尚未配置云端同步' });
        const act = activeSync(cfg);
        if (!act) return send(res, 400, { ok: false, error: '同步配置不完整' });
        try {
          let data;
          if (act.kind === 'webdav') {
            const r = await webdavGet(act.c);
            if (r.status === 404) return send(res, 404, { ok: false, error: '云端还没有存档，请先「推送到云端」' });
            if (r.error) return send(res, 502, { ok: false, error: r.error });
            data = r.data;
          } else {
            const r = await s3Request('GET', act.c);
            if (r.status === 404) return send(res, 404, { ok: false, error: '云端还没有存档，请先「推送到云端」' });
            if (r.status !== 200) return send(res, 502, { ok: false, error: `S3 返回 ${r.status}` });
            try { data = JSON.parse(r.body.toString('utf8')); } catch { return send(res, 502, { ok: false, error: '云端存档不是有效的 JSON' }); }
            if (!data || !Array.isArray(data.notes)) return send(res, 502, { ok: false, error: '云端存档格式不正确' });
          }
          writeJson(NOTES_FILE, {
            notes: data.notes,
            tasks: data.tasks || [],
            lists: data.lists || [],
            settings: data.settings || {},
            deleted: data.deleted || [],
            savedAt: Date.now(),
          });
          return send(res, 200, { ok: true, notes: data.notes, tasks: data.tasks || [], count: data.notes.length });
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      return send(res, 404, { ok: false, error: '未知接口' });
    }

    serveStatic(p, res);
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

/* ---------------- 启动 ---------------- */
/* 两种使用方式：
   1) 直接运行：node server.js        —— 监听 PORT/HOST 环境变量（默认 8642 / 0.0.0.0）
   2) 被 Electron 主进程 require      —— start({ port: 0, host: '127.0.0.1' })，随机端口仅本机回环 */
function start({ port, host, quiet } = {}) {
  ensureDataDir();
  const listenPort = port === undefined ? PORT : port;   // 显式传 0 表示随机端口
  const listenHost = host === undefined ? HOST : host;
  server.listen(listenPort, listenHost, () => {
    if (!quiet) {
      console.log(`简记服务已启动: http://localhost:${server.address().port}`);
      console.log(`数据目录: ${DATA_DIR}`);
    }
  });
  return server;
}

if (require.main === module) start();

module.exports = { start, DATA_DIR, NOTES_FILE, CONFIG_FILE };
