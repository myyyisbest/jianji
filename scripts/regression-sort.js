/* 排序控件回归：确认自绘弹出菜单（.sort-menu）取代原生 select 后
   位置、对齐、交互、无障碍属性与持久化都正确 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:8642';
const NOTES_FILE = path.join(__dirname, '..', 'data', 'notes.json');
const results = [];
const ok = (n, c, d = '') => { results.push({ n, c, d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  → ' + d : ''}`); };

/* 隔离与善后。
   坑一：本环境里 Playwright 的 newContext() **不隔离 localStorage** ——
        每个新 context 打开本页都能看到完整数据，且页面启动阶段自己会写 localStorage，
        所以 addInitScript(() => localStorage.clear()) 会被页面的写入覆盖，清不干净。
   坑二：真正的持久层是服务端的 data/notes.json（GET/PUT /api/notes），它决定首屏状态。
   坑三：覆盖它对**用户是破坏性的** —— 上一版脚本直接把用户的 3 篇种子笔记冲掉了。
   所以这里：跑前把原档另存到 .tmp-，无论成败都在 finally 里原样写回。 */
const BACKUP = path.join(__dirname, '..', '.tmp-notes-backup.json');

function backupArchive() {
  if (fs.existsSync(NOTES_FILE)) fs.copyFileSync(NOTES_FILE, BACKUP);
  else fs.writeFileSync(BACKUP, '');
}

function restoreArchive() {
  if (!fs.existsSync(BACKUP)) return;
  const raw = fs.readFileSync(BACKUP);
  if (raw.length) fs.writeFileSync(NOTES_FILE, raw);
}

async function seedFixture() {
  const notes = [
    { id: 'n-a', title: '阿尔法', content: 'A', tags: [], pinned: false, fav: false, createdAt: 1700000001000, updatedAt: 1700000001000 },
    { id: 'n-b', title: '贝塔', content: 'B', tags: [], pinned: false, fav: false, createdAt: 1700000002000, updatedAt: 1700000002000 },
    { id: 'n-c', title: 'Gamma', content: 'C', tags: [], pinned: false, fav: false, createdAt: 1700000003000, updatedAt: 1700000003000 },
  ];
  const r = await fetch(`${BASE}/api/notes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes, tasks: [], lists: [], settings: { theme: 'light' }, deleted: [], savedAt: Date.now() }),
  });
  if (!r.ok) throw new Error(`seed 失败: HTTP ${r.status}`);
}

(async () => {
  backupArchive();
  await seedFixture();

  const b = await chromium.launch({ executablePath: EDGE, headless: false });
  const page = await (await b.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  /* 侧栏折叠是用户偏好（存档可能带 sidebarCollapsed:true，整栏 visibility:hidden），
     排序控件在侧栏里 —— 只改 body class 强制展开，不写回存档。 */
  await page.evaluate(() => document.body.classList.remove('sidebar-collapsed'));
  await page.waitForTimeout(200);

  /* ---- 1. 原生 select 已彻底移除 ---- */
  ok('DOM 里没有 #sortSelect', await page.locator('#sortSelect').count() === 0);

  /* ---- 2. 位置：排序按钮与「置顶」页签同一行，且在其右侧 ---- */
  const geo = await page.evaluate(() => {
    const g = sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), cy: +(r.top + r.height / 2).toFixed(1), w: Math.round(r.width), h: Math.round(r.height) }; };
    return { all: g('.filter[data-filter="all"]'), pin: g('.filter[data-filter="pinned"]'), btn: g('#sortBtn'), filters: g('#filters') };
  });
  ok('排序按钮存在且已渲染', !!geo.btn && geo.btn.w > 0, JSON.stringify(geo.btn));
  ok('排序按钮在「置顶」右侧', geo.btn && geo.pin && geo.btn.l > geo.pin.r, `置顶右=${geo.pin.r} 按钮左=${geo.btn.l}`);
  ok('排序按钮与页签垂直居中同一行', Math.abs(geo.btn.cy - geo.pin.cy) <= 2, `按钮中心=${geo.btn.cy} 置顶中心=${geo.pin.cy}`);

  /* ---- 3. 右对齐：按钮右边缘贴合 .filters 内容右边缘 ---- */
  const alignRight = await page.evaluate(() => {
    const f = document.querySelector('#filters');
    const cs = getComputedStyle(f);
    const contentRight = f.getBoundingClientRect().right - (parseFloat(cs.paddingRight) || 0);
    const btn = document.querySelector('#sortBtn').getBoundingClientRect();
    return { contentRight: +contentRight.toFixed(1), btnRight: +btn.right.toFixed(1) };
  });
  ok('排序按钮右对齐到内容右边缘', Math.abs(alignRight.contentRight - alignRight.btnRight) <= 1,
    `内容右=${alignRight.contentRight} 按钮右=${alignRight.btnRight}`);

  /* ---- 4. 弹出菜单默认关闭 ---- */
  ok('弹出菜单默认关闭', await page.locator('#sortPop').isHidden());

  /* ---- 4b. 点击按钮须能真正切到「打开」。
     这里盯的是「点外部关闭」监听器的 bug：它用 e.target.closest('#sortMenu') 判断是否点在控件内，
     若外层容器忘了写 id="sortMenu"，closest 永远返回 null —— 于是 document 级监听器
     会把按钮自己的这次点击也当成「点外部」，先关闭再由按钮监听器重新打开。
     表现是「偶尔要按两下才开」或「开了又立刻关」，很难复现。
     直接用 dispatchEvent 走原生冒泡路径（而非 Playwright 的合成点击），能稳定暴露它。 ---- */
  const toggleOnce = await page.evaluate(() => {
    const btn = document.querySelector('#sortBtn');
    const pop = document.querySelector('#sortPop');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { hidden: pop.hidden, expanded: btn.getAttribute('aria-expanded') };
  });
  ok('单次点击即可打开（外部点击监听器未误关）',
    toggleOnce.hidden === false && toggleOnce.expanded === 'true',
    `hidden=${toggleOnce.hidden} aria-expanded=${toggleOnce.expanded}`);
  /* 再点一次应关闭 */
  const toggleTwice = await page.evaluate(() => {
    const btn = document.querySelector('#sortBtn');
    const pop = document.querySelector('#sortPop');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { hidden: pop.hidden, expanded: btn.getAttribute('aria-expanded') };
  });
  ok('再次点击可关闭（开合幂等）',
    toggleTwice.hidden === true && toggleTwice.expanded === 'false',
    `hidden=${toggleTwice.hidden} aria-expanded=${toggleTwice.expanded}`);

  /* 确认容器 id 存在，否则上面的 closest 判断失效 */
  ok('排序控件有外层 id=sortMenu（外部点击判定依赖）',
    await page.locator('#sortMenu').count() === 1);

  /* ---- 4c. 点击弹出层自身的 padding 不应关闭。
     这是 id="sortMenu" 真正的用处：按钮上的点击被 stopPropagation 挡住了，
     所以漏写 id 不会影响按钮；但点在弹出层 5px 内边距上（视觉上属于菜单的一部分，
     用户很自然会点）时没有任何东西拦截冒泡，document 监听器就会误判成「点外部」而关闭。
     这个缺陷在 id 缺失时 100% 复现，所以断言用「点内边距后仍打开」来守。 ---- */
  await page.click('#sortBtn');
  await page.waitForTimeout(250);
  const popBox = await page.locator('#sortPop').boundingBox();
  await page.mouse.click(popBox.x + 3, popBox.y + 3);
  await page.waitForTimeout(250);
  ok('点击弹出层内边距不会误关闭', await page.locator('#sortPop').isVisible());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  /* ---- 5. 点击按钮打开，aria-expanded 同步 ---- */
  await page.click('#sortBtn');
  await page.waitForTimeout(250);
  ok('点击按钮后菜单打开', await page.locator('#sortPop').isVisible());
  ok('aria-expanded 变为 true', await page.getAttribute('#sortBtn', 'aria-expanded') === 'true');

  /* ---- 6. 菜单项数量与文案 ---- */
  const opts = await page.locator('#sortPop .sort-opt').evaluateAll(els =>
    els.map(e => ({ sort: e.dataset.sort, text: e.textContent.trim(), active: e.classList.contains('active'), checked: e.getAttribute('aria-checked') })));
  ok('三个排序选项齐全', opts.length === 3, opts.map(o => o.sort).join(','));
  ok('fixture 未指定 sort 时默认选中「按更新时间」',
    opts.find(o => o.sort === 'updated')?.active === true,
    `点亮=${opts.filter(o => o.active).map(o => o.sort).join(',') || '无'}`);

  /* ---- 7. 菜单锚定在按钮下方，且不超出视口 ---- */
  const popGeo = await page.evaluate(() => {
    const p = document.querySelector('#sortPop').getBoundingClientRect();
    const btn = document.querySelector('#sortBtn').getBoundingClientRect();
    return { top: +p.top.toFixed(1), right: +p.right.toFixed(1), btnBottom: +btn.bottom.toFixed(1), btnRight: +btn.right.toFixed(1), vw: innerWidth, w: Math.round(p.width), h: Math.round(p.height) };
  });
  ok('菜单锚定在按钮下方', popGeo.top >= popGeo.btnBottom, `菜单顶=${popGeo.top} 按钮底=${popGeo.btnBottom}`);
  ok('菜单右边缘与按钮右边缘对齐', Math.abs(popGeo.right - popGeo.btnRight) <= 1, `菜单右=${popGeo.right} 按钮右=${popGeo.btnRight}`);
  ok('菜单未溢出右边界', popGeo.right <= popGeo.vw, `菜单右=${popGeo.right} 视口宽=${popGeo.vw}`);
  ok('菜单有实际尺寸', popGeo.w > 100 && popGeo.h > 80, `${popGeo.w}x${popGeo.h}`);

  /* ---- 8. 选中「按标题」→ 关闭 + 状态落库 + 列表重排 ---- */
  await page.click('#sortPop .sort-opt[data-sort="title"]');
  await page.waitForTimeout(400);
  ok('选中后菜单关闭', await page.locator('#sortPop').isHidden());
  const afterPick = await page.evaluate(() => ({
    expanded: document.querySelector('#sortBtn').getAttribute('aria-expanded'),
    active: document.querySelector('#sortPop .sort-opt.active')?.dataset.sort,
    checked: document.querySelector('#sortPop .sort-opt[data-sort="title"]').getAttribute('aria-checked'),
  }));
  ok('选中项 active 已切换', afterPick.active === 'title', JSON.stringify(afterPick));
  ok('aria-expanded 复位为 false', afterPick.expanded === 'false');
  ok('选中项 aria-checked=true', afterPick.checked === 'true');

  /* 偏好落在存档包 jianji-notes-v2.settings.sort 里（不是扁平 prefs 键） */
  const persisted = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('jianji-notes-v2') || '{}')?.settings?.sort ?? null; } catch { return null; }
  });
  ok('排序偏好已持久化到存档包', persisted === 'title', `实际=${persisted}`);

  /* ---- 9. 真正改变了排序结果：localeCompare('zh') 下汉字排在拉丁字母之前 ---- */
  const titlesNow = await page.locator('#noteList .ni-title').evaluateAll(els => els.map(e => e.textContent.trim()));
  ok('fixture 三条笔记已渲染', titlesNow.length === 3, `实际=${titlesNow.length} ${titlesNow.join(' | ')}`);
  ok('列表已按标题升序重排（汉字先于拉丁字母）',
    JSON.stringify(titlesNow) === JSON.stringify(['阿尔法', '贝塔', 'Gamma']),
    titlesNow.join(' | '));

  /* ---- 9b. 切回「按创建时间」应变为升序（createdAt 反序） ---- */
  await page.click('#sortBtn');
  await page.waitForTimeout(200);
  await page.click('#sortPop .sort-opt[data-sort="created"]');
  await page.waitForTimeout(400);
  const byCreated = await page.locator('#noteList .ni-title').evaluateAll(els => els.map(e => e.textContent.trim()));
  ok('切到按创建时间后重排', JSON.stringify(byCreated) === JSON.stringify(['Gamma', '贝塔', '阿尔法']), byCreated.join(' | '));

  /* ---- 10. 点击外部关闭 ---- */
  await page.click('#sortBtn');
  await page.waitForTimeout(200);
  await page.mouse.click(900, 600);
  await page.waitForTimeout(250);
  ok('点击外部关闭菜单', await page.locator('#sortPop').isHidden());

  /* ---- 11. Esc 关闭 ---- */
  await page.click('#sortBtn');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 关闭菜单', await page.locator('#sortPop').isHidden());

  /* ---- 12. 重复点击同一个选项不应触发多余渲染（幂等） ---- */
  await page.click('#sortBtn');
  await page.waitForTimeout(200);
  await page.click('#sortPop .sort-opt[data-sort="title"]');
  await page.waitForTimeout(300);
  const stable = await page.evaluate(() => document.querySelector('#sortPop .sort-opt.active')?.dataset.sort);
  ok('重复选中保持稳定', stable === 'title', `当前=${stable}`);

  /* ---- 13. 深色主题下按钮与菜单可见 ---- */
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(200);
  await page.click('#sortBtn');
  await page.waitForTimeout(250);
  const dark = await page.evaluate(() => {
    const btn = getComputedStyle(document.querySelector('#sortBtn'));
    const pop = document.querySelector('#sortPop').getBoundingClientRect();
    return { color: btn.color, visible: pop.width > 0 && pop.height > 0, bg: getComputedStyle(document.querySelector('#sortPop')).backgroundColor };
  });
  ok('深色主题下菜单正常渲染', dark.visible === true, JSON.stringify(dark));
  await page.screenshot({ path: '.tmp-sort-dark.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForTimeout(200);

  /* 待办视图用的是另一套页签容器（#taskFilters + data-tfilter），排序控件只属于笔记视图。
     这里断言两件事：① 排序控件不泄漏到待办视图；② 待办页签本就不受本次改动影响、仍单行左对齐。 */
  await page.click('#modeSwitch .mode-btn[data-mode="tasks"]');
  await page.waitForTimeout(500);
  const taskProbe = await page.evaluate(() => {
    const f = document.querySelector('#taskFilters');
    const cs = getComputedStyle(f);
    const rows = [...f.querySelectorAll('.filter')].map(e => e.getBoundingClientRect());
    return {
      sortBtnVisible: (document.querySelector('#sortBtn')?.getBoundingClientRect().width ?? 0) > 0,
      contentLeft: +(f.getBoundingClientRect().left + (parseFloat(cs.paddingLeft) || 0)).toFixed(1),
      firstTabLeft: +rows[0].left.toFixed(1),
      rows: [...new Set(rows.map(r => Math.round(r.top + r.height / 2)))].length,
    };
  });
  ok('排序控件未泄漏到待办视图（按设计）', taskProbe.sortBtnVisible === false);
  ok('待办页签仍单行', taskProbe.rows === 1, `行数=${taskProbe.rows}`);
  ok('待办页签左基准仍为 28.8（上一轮修复未被破坏）',
    Math.abs(taskProbe.firstTabLeft - 28.8) <= 1, `首个页签左=${taskProbe.firstTabLeft}`);

  await page.screenshot({ path: '.tmp-sort-light.png' });
  ok('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净');

  const pass = results.filter(r => r.c).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  await b.close();
  restoreArchive();
  try { if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP); } catch { }
  console.log('已还原原始存档');
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.error('崩了:', e);
  restoreArchive();
  try { if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP); } catch { }
  console.log('已还原原始存档');
  process.exit(2);
});
