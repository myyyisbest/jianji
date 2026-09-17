/* 本地 Mock S3（仅用于自测同步链路，不做签名校验）
   用法: node scripts/mock-s3.js  → 监听 :9000，path-style /bucket/key */
'use strict';
const http = require('http');

const PORT = Number(process.env.PORT) || 9000;
const store = new Map();

http.createServer((req, res) => {
  const key = decodeURIComponent(req.url.replace(/^\/+/, ''));
  if (req.method === 'PUT') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      store.set(key, body);
      console.log(`[mock-s3] PUT  ${key} (${body.length} bytes)`);
      res.writeHead(200, { etag: '"' + require('crypto').createHash('md5').update(body).digest('hex') + '"' });
      res.end();
    });
  } else if (req.method === 'GET') {
    const v = store.get(key);
    if (!v) { res.writeHead(404); res.end(); return; }
    console.log(`[mock-s3] GET  ${key}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(v);
  } else if (req.method === 'HEAD') {
    res.writeHead(store.has(key) ? 200 : 404);
    res.end();
  } else {
    res.writeHead(400);
    res.end('mock-s3 仅支持 GET/PUT/HEAD');
  }
}).listen(PORT, () => console.log(`[mock-s3] listening on http://localhost:${PORT}`));
