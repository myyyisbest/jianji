/* 本地 Mock WebDAV（仅用于自测同步链路）
   用法: node scripts/mock-webdav.js  → 监听 :9700，Basic Auth 固定 u:p */
'use strict';
const http = require('http');

const PORT = Number(process.env.PORT) || 9700;
const AUTH = 'Basic ' + Buffer.from('u:p').toString('base64');
const files = new Map();
const dirs = new Set(['/']);

function parentDir(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

http.createServer((req, res) => {
  if (req.headers.authorization !== AUTH) { res.writeHead(401); res.end(); return; }
  const key = decodeURIComponent(req.url);
  const readBody = () => new Promise(r => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks)));
  });

  if (req.method === 'PROPFIND') {
    res.writeHead(207, { 'content-type': 'application/xml' });
    res.end('<?xml version="1.0"?><multistatus/>');
  } else if (req.method === 'MKCOL') {
    dirs.add(key.endsWith('/') ? key : key + '/');
    console.log(`[mock-webdav] MKCOL ${key}`);
    res.writeHead(201); res.end();
  } else if (req.method === 'PUT') {
    if (!dirs.has(parentDir(key) === '/' ? '/' : parentDir(key) + '/')) {
      console.log(`[mock-webdav] PUT  ${key} -> 409 (父目录不存在)`);
      res.writeHead(409); res.end(); return;
    }
    readBody().then(body => {
      files.set(key, body);
      console.log(`[mock-webdav] PUT  ${key} (${body.length} bytes)`);
      res.writeHead(201); res.end();
    });
  } else if (req.method === 'GET') {
    const v = files.get(key);
    if (!v) { res.writeHead(404); res.end(); return; }
    console.log(`[mock-webdav] GET  ${key}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(v);
  } else {
    res.writeHead(405); res.end();
  }
}).listen(PORT, () => console.log(`[mock-webdav] listening on http://localhost:${PORT} (auth u:p)`));
