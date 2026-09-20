/* 细节审美回归：确认截止日期重构没弄坏上一轮的排版不变量
   （左对齐基准、行数判定、图标完整性、子步骤已移除） */
const { chromium } = require('playwright-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const results = [];
const ok = (n, c, d = '') => { results.push({ n, c, d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  → ' + d : ''}`); };

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: false });
  const page = await (await b.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto('http://127.0.0.1:8642', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  /* 侧栏折叠是用户偏好（存档可能带 sidebarCollapsed:true），
     本套件测的是排版不变量 —— 只改 body class 强制展开，不写回存档。 */
  await page.evaluate(() => document.body.classList.remove('sidebar-collapsed'));
  await page.waitForTimeout(200);
  await page.click('#modeSwitch .mode-btn[data-mode="tasks"]');
  await page.waitForTimeout(400);
  await page.locator('#taskLists .tk-item:not(.agg)').first().click();
  await page.waitForTimeout(500);

  /* ---- 1. metabar 单行：用「垂直中心是否落进同一行带」判定。
     坑一：align-items:center 下子元素高度不同（chip 24px / 清除按钮 22px / 文字 15px），
           直接比 top 会误判成多行。
     坑二：tm-spacer 是 flex:1 的撑开元素，高度为 0，区间重叠判定的除数会变 0 而恒假。
     所以按中心点归并。 ---- */
  const chips = await page.locator('.task-metabar > *').evaluateAll(els =>
    els.filter(e => getComputedStyle(e).display !== 'none')
      .map(e => { const r = e.getBoundingClientRect(); return { mid: r.top + r.height / 2, h: r.height, cls: e.className, id: e.id }; }));
  const rows = [];
  for (const c of chips) {
    const hit = rows.find(r => Math.abs(r.mid - c.mid) < 16);   // 同一行内中心点不超过 16px
    if (hit) { hit.mid = (hit.mid * hit.n + c.mid) / (hit.n + 1); hit.n++; }
    else rows.push({ mid: c.mid, n: 1 });
  }
  ok('metabar 元素在同一行', rows.length === 1, `行数=${rows.length} 元素=${chips.length}`);

  /* ---- 2. 左对齐基准（取「内容左边缘」= box.left + padding-left，不是 border box） ---- */
  const align = await page.evaluate(() => {
    const contentLeft = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return +(r.left + (parseFloat(cs.paddingLeft) || 0)).toFixed(1);
    };
    return {
      titleInput: contentLeft('#taskTitle'),
      noteIcon: contentLeft('.task-note-head .tnh-icon'),
      firstTool: contentLeft('.task-toolbar .tool'),
    };
  });
  const vals = Object.values(align);
  const span = Math.max(...vals) - Math.min(...vals);
  ok('标题/备注图标/工具栏左基准一致', span <= 1, `跨度 ${span}px ${JSON.stringify(align)}`);

  /* 编辑器是刻意比标题左 6px 的，单独断言，别混进上面那组 */
  const cmLeft = await page.evaluate(() => {
    const e = document.querySelector('.task-scroll .cm-host');
    return +e.getBoundingClientRect().left.toFixed(1);
  });
  ok('编辑器内容与标题基准差 6px（设计值）', Math.abs((align.titleInput - cmLeft) - 6) <= 1,
    `标题=${align.titleInput} 编辑器=${cmLeft} 差=${(align.titleInput - cmLeft).toFixed(1)}`);

  /* ---- 3. 子步骤功能已移除（按用户要求，不要再加回来） ---- */
  const stepsInDom = await page.locator('#taskBody [class*="step"], #taskBody [id*="step"]').count();
  ok('任务详情里没有子步骤 UI', stepsInDom === 0, `匹配=${stepsInDom}`);
  const stepsInJs = await page.evaluate(() => {
    return typeof window.steps !== 'undefined' || typeof window.substeps !== 'undefined';
  });
  ok('没有全局子步骤状态', stepsInJs === false);

  /* ---- 4. metabar 里的 svg 图标都应正常渲染（没有被挤压成 0） ---- */
  const icons = await page.locator('.task-metabar .mt-chip svg').evaluateAll(els =>
    els.map(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { w: Math.round(r.width), h: Math.round(r.height), stroke: cs.stroke, color: cs.color }; }));
  const badIcons = icons.filter(i => i.w < 8 || i.h < 8);
  ok('metabar 图标尺寸正常', badIcons.length === 0, `共 ${icons.length} 个，异常 ${badIcons.length}`);

  /* ---- 5. 清理按钮在有日期时与 chip 同高、对齐 ---- */
  await page.evaluate(() => { const i = document.querySelector('#taskDue'); i.value = '2026-12-01'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(350);
  const clearGeo = await page.locator('#taskDueClear').evaluate(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; });
  const chipGeo = await page.locator('.mt-date').evaluate(e => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), top: Math.round(r.top) }; });
  ok('清除按钮与日期 chip 垂直居中对齐', Math.abs((clearGeo.top + clearGeo.h / 2) - (chipGeo.top + chipGeo.h / 2)) <= 2,
    `clear 中心=${(clearGeo.top + clearGeo.h / 2).toFixed(1)} chip 中心=${(chipGeo.top + chipGeo.h / 2).toFixed(1)}`);

  /* ---- 6. 任务标题区不再是「简单框线」：标题输入应无边框 ---- */
  const titleStyle = await page.locator('#taskTitle').evaluate(e => {
    const cs = getComputedStyle(e);
    return { border: cs.border, borderBottom: cs.borderBottomWidth, bg: cs.backgroundColor };
  });
  ok('标题输入无独立框线', titleStyle.borderBottom === '0px' && titleStyle.border.startsWith('0px'), JSON.stringify(titleStyle));

  /* ---- 7. 深色主题下也正常 ---- */
  await page.click('#' + (await page.locator('[data-theme-toggle], #themeBtn, #themeToggle').first().getAttribute('id').catch(() => 'x'))).catch(() => {});
  const themeOk = await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    const i = document.querySelector('#taskDue');
    const cs = getComputedStyle(i);
    return { theme: document.documentElement.dataset.theme, color: cs.color, visible: cs.opacity === '1' && cs.visibility === 'visible' };
  });
  ok('深色主题下日期控件仍可见', themeOk.visible === true, JSON.stringify(themeOk));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  ok('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净');

  await page.screenshot({ path: '.tmp-polish.png' });
  const pass = results.filter(r => r.c).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  await b.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
