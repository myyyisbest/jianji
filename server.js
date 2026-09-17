/* ============================================================
   素笺 · 后端服务（零依赖，Node >= 18）
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

function getS3Config() { return readJson(CONFIG_FILE); }

async function pushToS3() {
  const cfg = getS3Config();
  if (!cfg) return { ok: false, error: '尚未配置 S3' };
  const data = readJson(NOTES_FILE);
  if (!data) return { ok: false, error: '本地暂无笔记存档' };
  const r = await s3Request('PUT', cfg, { body: JSON.stringify(data) });
  if (r.status === 200) return { ok: true, uploadedAt: Date.now(), object: `${cfg.bucket}/${cfg.objectKey || DEFAULT_OBJECT}` };
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
        return send(res, 200, { ok: true, notes: d ? (d.notes || []).length : 0, s3: !!getS3Config() });
      }

      /* 笔记存档 */
      if (req.method === 'GET' && p === '/api/notes') {
        const d = readJson(NOTES_FILE);
        return send(res, 200, {
          ok: true,
          notes: d ? d.notes : null,
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
          settings: data.settings || {},
          deleted: Array.isArray(data.deleted) ? data.deleted : [],
          savedAt: Date.now(),
        };
        writeJson(NOTES_FILE, pkg);
        const cfg = getS3Config();
        const cloud = { enabled: !!cfg, autoSync: !!(cfg && cfg.autoSync) };
        if (cfg && cfg.autoSync) {
          try { Object.assign(cloud, await pushToS3()); } catch (e) { cloud.pushed = false; cloud.error = e.message; }
        }
        return send(res, 200, { ok: true, cloud });
      }

      /* S3 配置 */
      if (req.method === 'GET' && p === '/api/config') {
        return send(res, 200, { ok: true, config: getS3Config() });
      }

      if (req.method === 'PUT' && p === '/api/config') {
        let c;
        try { c = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { ok: false, error: 'JSON 无效' }); }
        const clean = {
          endpoint: String(c.endpoint || '').trim(),
          region: String(c.region || '').trim(),
          bucket: String(c.bucket || '').trim(),
          accessKeyId: String(c.accessKeyId || '').trim(),
          secretAccessKey: String(c.secretAccessKey || '').trim(),
          objectKey: String(c.objectKey || DEFAULT_OBJECT).trim().replace(/^\/+/, ''),
          autoSync: !!c.autoSync,
        };
        if (!/^https?:\/\//.test(clean.endpoint)) clean.endpoint = 'https://' + clean.endpoint;
        if (!clean.endpoint || !clean.bucket || !clean.accessKeyId || !clean.secretAccessKey) {
          return send(res, 400, { ok: false, error: 'Endpoint / Bucket / Access Key ID / Secret Access Key 为必填' });
        }
        writeJson(CONFIG_FILE, clean);
        return send(res, 200, { ok: true, config: clean });
      }

      /* 云端存档只读（前端拿去与本地合并，不直接覆盖服务器） */
      if (req.method === 'GET' && p === '/api/sync/remote') {
        const cfg = getS3Config();
        if (!cfg) return send(res, 400, { ok: false, error: '尚未配置 S3' });
        try {
          const r = await s3Request('GET', cfg);
          if (r.status === 404) return send(res, 404, { ok: false, error: '云端暂无存档' });
          if (r.status !== 200) return send(res, 502, { ok: false, error: `S3 返回 ${r.status}` });
          let data;
          try { data = JSON.parse(r.body.toString('utf8')); } catch { return send(res, 502, { ok: false, error: '云端存档不是有效的 JSON' }); }
          if (!data || !Array.isArray(data.notes)) return send(res, 502, { ok: false, error: '云端存档格式不正确' });
          return send(res, 200, { ok: true, archive: { notes: data.notes, settings: data.settings || {}, deleted: data.deleted || [], savedAt: data.savedAt || 0 } });
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      /* 连接测试：凭证 → 桶权限 → 对象可读性，逐级定位问题 */
      if (req.method === 'POST' && p === '/api/config/test') {
        const cfg = getS3Config();
        if (!cfg) return send(res, 400, { ok: false, error: '尚未保存配置，请先填写并点击「保存配置」' });
        try {
          // 1) 列桶：验证凭证有效性
          const list = await s3Request('GET', cfg, { list: true });
          if (list.status !== 200) {
            const code = (list.body.toString().match(/<Code>([^<]+)/) || [])[1] || '';
            return send(res, 502, { ok: false, error: `凭证校验未通过（${list.status} ${code}）：请检查 Access Key ID 与 Secret Key 是否正确、密钥是否被禁用` });
          }
          const buckets = [...list.body.toString().matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);

          // 2) 读对象：区分「桶不存在/无权限」与「正常」
          const probe = await s3Request('GET', cfg);
          if (probe.status === 404) {
            return send(res, 200, { ok: true, message: `连接成功：凭证有效，桶「${cfg.bucket}」可正常读写（云端暂无存档，推送一次即可）` });
          }
          if (probe.status === 200) {
            return send(res, 200, { ok: true, message: `连接成功：凭证有效，桶「${cfg.bucket}」访问正常，云端已有存档` });
          }
          if (probe.status === 403) {
            return send(res, 200, {
              ok: false,
              error: `凭证有效，但无法访问桶「${cfg.bucket}」（AccessDenied）：通常是该桶未授权给密钥所属的子用户，或桶名有误。${buckets.length ? '你的 Key 可用的桶：' + buckets.join('、') : ''}`,
              buckets,
            });
          }
          return send(res, 502, { ok: false, error: `读取对象失败（${probe.status}）：${probe.body.toString('utf8').slice(0, 150)}` });
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      /* 同步 */
      if (req.method === 'POST' && p === '/api/sync/push') {
        try {
          const r = await pushToS3();
          return send(res, r.ok ? 200 : 502, r);
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      if (req.method === 'POST' && p === '/api/sync/pull') {
        const cfg = getS3Config();
        if (!cfg) return send(res, 400, { ok: false, error: '尚未配置 S3' });
        try {
          const r = await s3Request('GET', cfg);
          if (r.status === 404) return send(res, 404, { ok: false, error: '云端还没有存档，请先「推送到云端」' });
          if (r.status !== 200) return send(res, 502, { ok: false, error: `S3 返回 ${r.status}` });
          let data;
          try { data = JSON.parse(r.body.toString('utf8')); } catch { return send(res, 502, { ok: false, error: '云端存档不是有效的 JSON' }); }
          if (!data || !Array.isArray(data.notes)) return send(res, 502, { ok: false, error: '云端存档格式不正确' });
          writeJson(NOTES_FILE, { notes: data.notes, savedAt: Date.now() });
          return send(res, 200, { ok: true, notes: data.notes, count: data.notes.length });
        } catch (e) { return send(res, 502, { ok: false, error: e.message }); }
      }

      return send(res, 404, { ok: false, error: '未知接口' });
    }

    serveStatic(p, res);
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

ensureDataDir();
server.listen(PORT, HOST, () => {
  console.log(`素笺服务已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
