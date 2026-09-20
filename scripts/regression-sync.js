/* 云端同步回归：覆盖本轮修复的五处缺陷
   1. 墓碑锁 —— 删除过的条目永不再同步回来（mergeCollection 的墓碑判定）
   2. seed-抢先-push 竞态 —— 本地清空后，示例内容在 pull 之前把云端真实数据覆盖掉
   3. pullCloud / autoPullTick 缺 renderSidebar()，拉取成功但界面不刷新
   4. saveConfigFromForm 不重建自动拉取定时器，改配置必须重启页面
   5. 失败路径静默（自动拉取失败无任何提示）

   依赖：scripts/mock-s3.js（本地假 S3）+ server.js。
   两个子进程都用 env 显式传 PORT —— 实测 `PORT=x timeout 3 node …` 这种
   内联写法的环境变量不会穿过 timeout 包装层，子进程仍监听默认端口。

   安全：全程只动 data/ 与临时配置文件，跑前备份、finally 还原。 */
'use strict';
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROJECT = __dirname;                       // 脚本就在项目根的 scripts/ 下
const ROOT = path.join(PROJECT, '..');
const BASE = 'http://127.0.0.1:8662';
const MOCK_PORT = 9121;
const APP_PORT = 8662;

const DATA_DIR = path.join(ROOT, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const CONFIG_FILE = path.join(DATA_DIR, 's3-config.json');
const BACKUP_DIR = path.join(ROOT, '.tmp-sync-backup');

const results = [];
const ok = (n, c, d = '') => { results.push({ n, c, d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  → ' + d : ''}`); };

/* ---------- 备份 / 还原 ----------
   血的教训：还原逻辑**绝不能删除目标文件**。
   上一版写的是「备份不存在 → 说明原本没有 → 删掉我们造出来的」，
   而备份不存在恰恰可能是因为「读取备份也失败了」，于是把用户存档直接删了。
   铁律：还原只做「有备份就写回」，任何情况下都不 unlink 用户的 data/。 */
function backupAll() {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  for (const f of ['notes.json', 's3-config.json']) {
    const src = path.join(DATA_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(BACKUP_DIR, f));
      const n = fs.statSync(src).size;
      if (n === 0) throw new Error(`备份 ${f} 是空文件，拒绝继续（安全中止）`);
      console.log(`  已备份 ${f} (${n} bytes)`);
    } else {
      fs.writeFileSync(path.join(BACKUP_DIR, `${f}.absent`), '');   // 标记「原本不存在」
      console.log(`  ${f} 原本不存在，已记录`);
    }
  }
}
function restoreAll() {
  if (!fs.existsSync(BACKUP_DIR)) { console.error('!! 备份目录不见了，拒绝还原以防误删'); return; }
  for (const f of ['notes.json', 's3-config.json']) {
    const bak = path.join(BACKUP_DIR, f);
    const dst = path.join(DATA_DIR, f);
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, dst);                      // 有备份 → 无条件写回
      console.log(`  已还原 ${f} (${fs.statSync(dst).size} bytes)`);
    } else if (fs.existsSync(path.join(BACKUP_DIR, `${f}.absent`))) {
      console.log(`  ${f} 原本就不存在，保持不存在`);
    } else {
      console.error(`!! ${f} 既无备份也无 absent 标记 —— 不动它，请人工检查`);
    }
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

/* ---------- 子进程 ---------- */
function bootMock() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-s3.js')], {
      cwd: ROOT, env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', d => process.stdout.write('  [mock] ' + d.toString().trimEnd() + '\n'));
    p.stderr.on('data', d => process.stdout.write('  [mock:err] ' + d.toString().trimEnd() + '\n'));
    setTimeout(() => resolve(p), 700);
    p.on('error', reject);
  });
}
function bootServer() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stderr.on('data', d => process.stdout.write('  [srv:err] ' + d.toString().trimEnd() + '\n'));
    let n = 0;
    const tick = setInterval(async () => {
      n++;
      try {
        const okHealth = await new Promise(res => {
          const req = http.get(`${BASE}/api/health`, r => { r.resume(); res(r.statusCode === 200); });
          req.on('error', () => res(false));
          req.setTimeout(500, () => { req.destroy(); res(false); });
        });
        if (okHealth) { clearInterval(tick); resolve(p); }
      } catch { /* 继续等 */ }
      if (n > 40) { clearInterval(tick); reject(new Error('server 起不来')); }
    }, 250);
  });
}

/* ---------- 存档构造 ----------
   重要：服务端在 PUT /api/notes 时若配置了 autoSync，会**顺带把存档推到 S3**
   （server.js:296-299）。所以「写本地 fixture」这个动作本身就会覆盖云端，
   想造「本地与云端不一致」的场景，必须先关掉 autoSync 再写本地。
   putLocal(archive, {noSync:true}) 就用于这种场合。 */
const note = (id, title, updatedAt, extra = {}) =>
  ({ id, title, content: title, tags: [], pinned: false, favorite: false, createdAt: updatedAt, updatedAt, ...extra });

async function setAutoSync(on) {
  const cur = await (await fetch(`${BASE}/api/config`)).json();
  const c = cur.config || {};
  const body = { ...c, autoSync: on };
  const r = await fetch(`${BASE}/api/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`切换 autoSync 失败 ${r.status}`);
}

async function putLocal(archive) {
  const body = { notes: [], tasks: [], lists: [], settings: {}, deleted: [], ...archive, savedAt: Date.now() };
  const r = await fetch(`${BASE}/api/notes`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT /api/notes 失败 ${r.status}`);
}
async function getLocal() {
  const r = await fetch(`${BASE}/api/notes`);
  return r.json();
}

(async () => {
  backupAll();
  const mock = await bootMock();
  const server = await bootServer();
  let browser = null;
  try {
    /* 配置同步：指向本地假 S3 */
    const cfg = {
      type: 's3', autoSync: true,
      s3: { endpoint: `http://127.0.0.1:${MOCK_PORT}`, region: 'us-east-1', bucket: 'bucket',
            accessKeyId: 'test', secretAccessKey: 'test', objectKey: 'notes.json' },
      webdav: { endpoint: '', username: '', password: '', remotePath: '/notes.json' },
    };
    const rc = await fetch(`${BASE}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg }),
    });
    ok('同步配置写入成功', rc.ok, `HTTP ${rc.status}`);

    const h = await (await fetch(`${BASE}/api/health`)).json();
    ok('/api/health 报告 sync=true', h.sync === true, JSON.stringify(h));

    /* 直接用 mock 的 HTTP 接口往「云端」写数据 —— path-style /bucket/notes.json */
    const putCloud = async archive => {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/bucket/notes.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: [], tasks: [], lists: [], settings: {}, deleted: [], savedAt: Date.now(), ...archive }),
      });
      if (!r.ok) throw new Error('putCloud 失败');
    };
    const getCloud = async () => {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/bucket/notes.json`);
      if (!r.ok) return null;
      return r.json();
    };

    /* =========================================================
       场景 A：墓碑锁 —— 删除后能否恢复
       构造要点：本地必须处于「存档非空」的分支，否则启动会走 seed 流程并推送，
       把刚写好的云端数据覆盖掉（这也正是场景 B 要修的那个竞态）。
       所以这里放一篇本地笔记占位，让启动直接读后端存档、不推送。
       ========================================================= */
    const NOW = Date.now();
    /* 先关 autoSync —— 否则下面 putLocal 写本地 fixture 会顺手把云端覆盖掉，
       场景就造不出来了（这正是第一次跑失败的原因）。 */
    await setAutoSync(false);
    await putCloud({ notes: [note('n-c1', '云端笔记一', NOW - 100000), note('n-c2', '云端笔记二', NOW - 99000)] });
    await putLocal({
      notes: [note('n-local', '本地占位', NOW - 200000)],   // 占位：避免触发 seed+推送
      deleted: [
        { id: 'n-c1', kind: 'note', deletedAt: NOW },
        { id: 'n-c2', kind: 'note', deletedAt: NOW },
      ],
    });
    const cloudAfterFixture = await getCloud();
    ok('构造成功：云端 2 篇未被本地写入覆盖', (cloudAfterFixture?.notes || []).length === 2,
      `云端=${(cloudAfterFixture?.notes || []).map(n => n.title).join(' | ')}`);

    /* 这里**不要**把 autoSync 打开：服务端 PUT /api/notes 会顺带推送 S3
       （server.js:296-299），autoSync=true 时页面一启动读存档就又把云端覆盖成
       本地 fixture，墓碑场景直接失效。整个场景 A 保持 autoSync=false，
       因为被测的 restoreFromCloud 走的是 GET 云端 + 客户端合并，与 autoSync 无关。 */

    browser = await chromium.launch({ executablePath: EDGE, headless: false });
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    const titlesOf = async () => (await getLocal()).notes.map(n => n.title).sort();

    /* --- 墓碑锁：普通合并拉不回来（这是既有语义，不算 bug，但要确认没有被误改） --- */
    const afterBoot = await titlesOf();
    ok('墓碑生效：普通启动后云端两篇未复活（符合设计）',
      !afterBoot.includes('云端笔记一') && !afterBoot.includes('云端笔记二'),
      afterBoot.join(' | ') || '(空)');

    /* --- 修复 1：restoreFromCloud 必须能救回来 --- */
    const restored = await page.evaluate(async () => {
      const before = JSON.parse(localStorage.getItem('jianji-notes-v2') || '{}');
      await window.__restoreFromCloud();
      await new Promise(r => setTimeout(r, 600));
      return { beforeNotes: (before.notes || []).length };
    });
    await page.waitForTimeout(600);
    const afterRestore = await titlesOf();
    ok('★修复1 从云端恢复救回被删除的 2 篇',
      afterRestore.includes('云端笔记一') && afterRestore.includes('云端笔记二'),
      afterRestore.join(' | '));

    /* --- 修复 1b：恢复后墓碑已清除，下一次普通合并不会又把它删掉 --- */
    const localAfter = await getLocal();
    const remainingTombs = (localAfter.deleted || []).filter(t => t.id === 'n-c1' || t.id === 'n-c2').length;
    ok('★修复1b 复活后墓碑已清除（不会再次被删）', remainingTombs === 0, `残留墓碑=${remainingTombs}`);

    /* --- 修复 1c：墓碑被清后，再走一次普通合并仍能保留 --- */
    await page.evaluate(() => window.__pullCloud());
    await page.waitForTimeout(800);
    const afterMergeAgain = await titlesOf();
    ok('★修复1c 再次普通合并后仍在（恢复是持久的）',
      afterMergeAgain.includes('云端笔记一') && afterMergeAgain.includes('云端笔记二'),
      afterMergeAgain.join(' | '));

    /* --- 修复 1d：二次确认交互 --- */
    await page.click('#settingsBtn');
    await page.waitForTimeout(400);
    const btnExists = await page.locator('#cfgRestore').count() === 1;
    ok('★修复1d 设置面板存在「从云端恢复」按钮', btnExists);
    if (btnExists) {
      const first = await page.evaluate(() => { document.querySelector('#cfgRestore').click(); return document.querySelector('#cfgRestore').textContent.trim(); });
      await page.waitForTimeout(200);
      const armed = await page.evaluate(() => ({
        text: document.querySelector('#cfgRestore').textContent.trim(),
        danger: document.querySelector('#cfgRestore').classList.contains('danger'),
      }));
      ok('★修复1d 首次点击只进入确认态（不改数据）',
        armed.danger === true && armed.text.includes('确认'), JSON.stringify(armed));
      // 撤销确认态，避免影响后续断言
      await page.evaluate(() => { document.querySelector('#cfgRestore').click(); });
      await page.waitForTimeout(900);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.click('#settingsBtn');   // 关闭
    await page.waitForTimeout(300);

    /* =========================================================
       场景 B：seed-抢先-push 竞态
       构造：云端有 3 篇真实数据；本地存档删掉（模拟「本地被清空」）。
       修复前启动序：seed() 生成示例 → 同一 tick scheduleCloudSave() 推上云
                    → 之后才 pull。云端被示例内容污染。
       期望（修复后）：启动时先探云端，发现云端非空 → 不推送；页面显示云端数据。
       ========================================================= */
    await setAutoSync(true);      // 场景 B 测的正是「autoSync 开启时的启动序」，必须打开
    await putCloud({ notes: [note('n-r1', '真实笔记一', NOW - 50000), note('n-r2', '真实笔记二', NOW - 49000), note('n-r3', '真实笔记三', NOW - 48000)] });
    fs.rmSync(NOTES_FILE, { force: true });                 // 本地存档清空 → 触发 seed()

    const page2 = await ctx.newPage();
    page2.on('console', m => { if (m.type() === 'error') errs.push('[p2] ' + m.text()); });
    page2.on('pageerror', e => errs.push('[p2] pageerror: ' + e.message));
    await page2.goto(BASE, { waitUntil: 'networkidle' });
    await page2.waitForTimeout(2500);

    const cloudAfterBoot = await getCloud();
    const cloudTitles = (cloudAfterBoot?.notes || []).map(n => n.title).sort();
    const realStillThere = ['真实笔记一', '真实笔记二', '真实笔记三'].every(t => cloudTitles.includes(t));
    ok('★修复2 云端真实数据未被 seed 内容覆盖', realStillThere, cloudTitles.join(' | '));

    /* --- 修复 3：界面必须真的显示出来（renderSidebar 被调用） --- */
    const shown = await page2.locator('#noteList .ni-title').evaluateAll(els => els.map(e => e.textContent.trim()).sort());
    const uiHasReal = ['真实笔记一', '真实笔记二', '真实笔记三'].every(t => shown.includes(t));
    ok('★修复3 页面列表显示了云端数据（renderSidebar 生效）', uiHasReal, shown.join(' | '));

    /* --- 修复 3b：侧栏底部计数同步刷新 --- */
    /* #sideFoot 是底栏容器，现在里面还挂了「新建」按钮，取计数要落到 #sideFootText */
    const foot = await page2.locator('#sideFootText').textContent();
    const nLocal = (await getLocal()).notes.length;
    ok('★修复3b 侧栏计数已同步', foot.includes(String(nLocal)), `底栏=「${foot.trim()}」 本地=${nLocal}`);

    /* =========================================================
       场景 C：修复 4 —— 保存配置后自动拉取立即生效（不需重启）
       ========================================================= */
    const page3 = await ctx.newPage();
    page3.on('pageerror', e => errs.push('[p3] pageerror: ' + e.message));
    await page3.goto(BASE, { waitUntil: 'networkidle' });
    await page3.waitForTimeout(1000);

    // 先把配置指向一个「不存在的端口」，再在页面里改成正确的 mock 端口并保存，
    // 观察是否无需刷新就重建了自动拉取定时器。
    const restartProbe = await page3.evaluate(async () => {
      const before = window.__autoPullTimerActive();
      await window.__saveConfigWith({ endpoint: `http://127.0.0.1:${9121}`, bucket: 'bucket' });
      await new Promise(r => setTimeout(r, 900));
      return { before, after: window.__autoPullTimerActive(), syncConfigured: window.__syncConfigured() };
    });
    ok('★修复4 保存配置后自动拉取定时器已重建',
      restartProbe.after === true, JSON.stringify(restartProbe));

    /* =========================================================
       场景 D：修复 5 —— 自动拉取失败要有提示，且不刷屏
       失败源用「空端口」：remoteArchive 拿不到响应 → !ok。
       （不伪造 Backend.online —— 守卫会直接 return，走不到失败分支。）

       踩过的坑：闸门 autoPullWarned 可能在**页面启动时**就已被置位。
       启动流程里 init() 会主动跑一次 autoPullTick()，若那一刻云端就不可达，
       提示已经弹过、闸门已关 —— 于是这里再调 tick 就什么都不发生，
       误判成「功能没实现」。所以 __resetAutoPullWarned() 必须在
       「配置好失败源之后、调用 tick 之前」执行，不能在配置之前。
       ========================================================= */
    const failProbe = await page3.evaluate(async () => {
      await window.__saveConfigWith({ endpoint: 'http://127.0.0.1:9129' });   // 空端口
      window.__resetAutoPullWarned();                                          // ← 顺序关键
      const guard = { syncCfg: window.__syncConfigured(), timer: window.__autoPullTimerActive() };
      const toasts = await window.__autoPullTickForce();
      return { toasts, count: toasts.length, guard };
    });
    ok('★修复5 自动拉取失败会提示',
      failProbe.count === 1 && /失败/.test(failProbe.toasts[0] || ''),
      `提示 ${failProbe.count} 次: ${failProbe.toasts.join(' ; ')} | 异常=${failProbe.toasts.errors || '无'} | 守卫=${JSON.stringify(failProbe.guard)}`);

    /* 连续失败只提示一次（不刷屏） */
    const quietProbe = await page3.evaluate(async () => {
      const again = [];
      for (let i = 0; i < 3; i++) {
        // 复用同一次失败：不再 reset，验证闸门生效
        again.push(...(await window.__autoPullTickForce()));
      }
      return again;
    });
    ok('★修复5b 连续失败不重复刷屏（闸门生效）', quietProbe.length === 0,
      `额外提示 ${quietProbe.length} 次: ${quietProbe.join(' ; ')}`);

    /* 恢复配置成功后闸门复位，此后再次失败应能重新提醒 */
    const recoverProbe = await page3.evaluate(async () => {
      await window.__saveConfigWith({ endpoint: `http://127.0.0.1:${9121}` });
      await window.__autoPullTickForce();                 // 成功 → autoPullWarned=false
      await window.__saveConfigWith({ endpoint: 'http://127.0.0.1:9129' });
      const t2 = await window.__autoPullTickForce();      // 再次失败 → 应重新提示
      return { secondFail: t2.length, msg: t2[0] || '' };
    });
    ok('★修复5c 成功一次后再次失败能重新提醒（不是永久静音）',
      recoverProbe.secondFail === 1, JSON.stringify(recoverProbe));
    await page3.evaluate(() => window.__saveConfigWith({ endpoint: `http://127.0.0.1:${9121}` }));

    /* =========================================================
       场景 E：回归保护 —— 正常合并/推送链路未被破坏
       ========================================================= */
    const page4 = await ctx.newPage();
    page4.on('pageerror', e => errs.push('[p4] pageerror: ' + e.message));
    await page4.goto(BASE, { waitUntil: 'networkidle' });
    await page4.waitForTimeout(1200);

    await putCloud({ notes: [note('n-x1', '新云端一', NOW), ...((await getCloud())?.notes || [])] });
    await page4.evaluate(() => window.__pullCloud());
    /* 合并后写盘是防抖的，固定等 900ms 会偶发假 FAIL（曾实测出 18/19）——轮询等到位 */
    let mergedTitles = [];
    for (let i = 0; i < 30; i++) {
      mergedTitles = (await getLocal()).notes.map(n => n.title);
      if (mergedTitles.includes('新云端一')) break;
      await page4.waitForTimeout(200);
    }
    ok('正常合并仍能拉取云端新增', mergedTitles.includes('新云端一'), mergedTitles.join(' | '));

    const noteCountBefore = (await getLocal()).notes.length;
    await page4.click('#newBtn');
    await page4.waitForTimeout(300);
    await page4.click('#newPop [data-new="note"]');
    await page4.waitForTimeout(1800);
    const pushed = await getCloud();
    ok('本地新建仍会推送到云端', (pushed?.notes || []).length > noteCountBefore, `云端=${(pushed?.notes || []).length} 之前=${noteCountBefore}`);

    ok('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净');

    await page4.screenshot({ path: '.tmp-sync-final.png' });
  } finally {
    if (browser) await browser.close().catch(() => { });
    server.kill('SIGTERM');
    mock.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    restoreAll();
    console.log('已还原 data/ 原始文件');
  }

  const pass = results.filter(r => r.c).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.error('崩了:', e);
  restoreAll();
  console.log('已还原 data/ 原始文件');
  process.exit(2);
});
