'use strict';
/* 回归测试总入口 —— 一条命令跑完四套用例。
 *
 * 为什么需要它：四套用例对服务的依赖不一样，手工跑很容易漏。
 *   - due / layout / sort 需要 8642 上已经有服务在跑
 *   - sync 自己会 spawn 8662（应用）+ 9121（假 S3），跟上面那个服务不能混用
 * 这个脚本负责拉起 / 复用 / 收尾服务，然后依次跑完，最后汇总成败。
 *
 * 用法：
 *   npm test                    # 本地，有头模式（沿用既有习惯，方便肉眼复核排版）
 *   JIANJI_HEADLESS=1 npm test  # CI，无头模式
 *
 * 浏览器由 scripts/lib/browser.js 统一解析（JIANJI_BROWSER / JIANJI_HEADLESS）。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8642;
const CONFIG_FILE = path.join(ROOT, 'data', 's3-config.json');

/* 依赖外部服务的三套 */
const WITH_SERVER = [
  'regression-due-date.js',
  'regression-layout.js',
  'regression-sort.js',
];
/* 自带服务的一套 */
const STANDALONE = ['regression-sync.js'];

/* 上一轮跑完会残留一份指向本地 mock 的同步配置（regression-sync 会还原，
   但页面在收尾前又写了一次）。带着它启动时，应用一上来就去连已经关掉的
   mock S3（127.0.0.1:9121），拿 502，于是三套用例的「无控制台错误」必挂 ——
   表现为 npm test 只有第一次能过。
   开始前把明确指向 mock 的配置挪走；指向真实云端的配置一律不碰。 */
const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+/;

/* 判定一份同步配置是不是测试残留。
   不能只匹配端口：regression-sync 每次会挑一个空闲端口（9121、9129…），
   写死端口列表必然漏。也不能只判 loopback：用户可能真把 MinIO 跑在本机。
   两条同时成立才算 mock —— 端点落在回环地址，且凭证就是 mock 用的 'test'。 */
function isMockConfig(raw) {
  let c;
  try { c = JSON.parse(raw); } catch { return false; }
  const endpoints = [(c.s3 || {}).endpoint, (c.webdav || {}).endpoint].filter(Boolean);
  if (!endpoints.length) return false;
  if (!endpoints.every((e) => LOOPBACK.test(String(e)))) return false;
  const creds = [(c.s3 || {}).secretAccessKey, (c.webdav || {}).password].filter(Boolean);
  return creds.length > 0 && creds.every((k) => k === 'test');
}

function quarantineMockConfig() {
  /* .bak 也要一起挪走：server.js 的 readJson() 在主档缺失时会回退读
     `${file}.bak`，只挪主档的话配置会被 .bak 原样复活 —— sync 依旧是 true，
     页面照旧去连已经关掉的 mock，502 照旧出现。 */
  const moved = [];
  for (const file of [CONFIG_FILE, `${CONFIG_FILE}.bak`]) {
    if (!fs.existsSync(file)) continue;
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!isMockConfig(raw)) continue;
    const dest = path.join(ROOT, `.tmp-sync-config-${Date.now()}-${path.basename(file)}`);
    fs.renameSync(file, dest);
    moved.push(path.relative(ROOT, dest));
  }
  if (moved.length) {
    console.log(`检测到上一轮残留的 mock 同步配置，已移出到 ${moved.join('、')}`);
  }
}

function health() {
  return new Promise((resolve) => {
    const req = require('http').get(
      { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 800 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(res.statusCode === 200));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await health()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function runSuite(file) {
  console.log(`\n──────── ${file} ────────`);
  const r = spawnSync(process.execPath, [path.join('scripts', file)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  return { file, ok: r.status === 0, code: r.status };
}

(async () => {
  quarantineMockConfig();

  let server = null;
  const alreadyUp = await health();

  if (!alreadyUp) {
    console.log(`启动本地服务 :${PORT} …`);
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
    });
    if (!(await waitForServer(20000))) {
      console.error(`服务未能在 20s 内就绪（端口 ${PORT}）。`);
      server.kill();
      process.exit(2);
    }
  } else {
    console.log(`复用已在运行的 :${PORT} 服务。`);
  }

  const results = [];
  try {
    for (const f of WITH_SERVER) results.push(runSuite(f));
  } finally {
    /* 自己拉起的才收尾；复用的不动，免得打断开发者正在跑的实例 */
    if (server) server.kill();
  }

  for (const f of STANDALONE) results.push(runSuite(f));

  const failed = results.filter((r) => !r.ok);
  console.log('\n════════ 汇总 ════════');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}${r.ok ? '' : `  (exit ${r.code})`}`);
  }
  console.log(`${results.length - failed.length}/${results.length} 套通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('跑测试时崩了:', e);
  process.exit(2);
});
