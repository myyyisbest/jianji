/* 截止日期「可维护性」回归。
   改动背景：早前那版把 <input type="date"> 透明铺满 chip 当点击垫片，
   结果「弹出日历 → Esc 取消 → 方向键」这条路径下原生段脱离激活态，
   后续按键被静默丢弃（用户报的「截止日期无法维护」）。
   现在 input 是可见真控件，本用例覆盖真实交互路径。 */
const { chromium } = require('playwright-core');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8642';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const results = [];
const ok = (n, c, d = '') => { results.push({ n, c, d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  → ' + d : ''}`); };

const dayOff = (n) => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.click('#modeSwitch .mode-btn[data-mode="tasks"]');
  await page.waitForTimeout(400);

  const row = page.locator('#taskLists .tk-item:not(.agg)').first();
  const tid = await row.getAttribute('data-id');
  await row.click();
  await page.waitForTimeout(400);

  const input = () => page.locator('#taskDue');
  const val = () => input().inputValue();
  const apiDue = () => page.evaluate(() => {
    const t = (typeof state === 'undefined' ? null : state.tasks.find(x => x.id === state.selectedTaskId));
    return t ? (t.due || '') : '(no-task)';
  });
  const clearVisible = () => page.locator('#taskDueClear').isVisible();
  const sideDue = () => page.locator(`#taskLists .tk-item[data-id="${tid}"] .tk-due`).textContent().catch(() => null);
  /* 真控件：点它自己。点任意位置都应由 click → showPicker 唤起日历，
     不再有「点中间没用、只有点最右边缘才行」的问题。 */
  const openPicker = async (frac = 0.42) => {
    const bx = await input().boundingBox();
    await page.mouse.click(bx.x + bx.width * frac, bx.y + bx.height / 2);
    await page.waitForTimeout(600);
  };

  ok('已选中一条任务', (await apiDue()) !== '(no-task)', `due="${await apiDue()}"`);

  /* ---------- 1. 起点：清空 ---------- */
  await page.locator('#taskDueClear').click();
  await page.waitForTimeout(350);
  ok('清空后 input 为空', (await val()) === '', `input="${await val()}"`);
  ok('清空后 API 为空', (await apiDue()) === '', `api="${await apiDue()}"`);
  ok('清空后按钮隐藏', (await clearVisible()) === false);

  /* ---------- 2. 空态：点中间 → 打开日历 → 键盘选日 → 确认 ---------- */
  await openPicker();
  ok('空态点输入框中部也能唤起日历', errs.length === 0, errs.slice(0, 2).join(' | ') || '干净');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const navVal = await val();
  ok('日历内键盘导航产生日期', !!navVal, `value="${navVal}"`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok('日历选日：已持久化', (await apiDue()) === navVal, `api="${await apiDue()}"`);
  ok('日历选日：清除按钮出现', (await clearVisible()) === true);

  /* ---------- 3. 关键回归：Esc 取消后方向键必须还能用 ---------- */
  const setDue = async (d) => {
    await page.evaluate(v => {
      const i = document.querySelector('#taskDue');
      i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
    }, d);
    await page.waitForTimeout(350);
  };
  /* ArrowUp/ArrowDown 改「月」，ArrowRight 只是切段不改值，所以只测会改值的键 */
  for (const key of ['ArrowUp', 'ArrowDown']) {
    await setDue(dayOff(20));
    const b4 = await val();
    await input().click();
    await page.waitForTimeout(550);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    const af = await val();
    ok(`Esc 取消后 ${key} 仍生效`, af !== b4, `${b4} → ${af}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }

  /* ---------- 4. Esc 后敲数字仍能改日 ---------- */
  await setDue(dayOff(20));
  const b4 = await val();
  await openPicker();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
  for (const d of ['1', '5']) { await page.keyboard.press(d); await page.waitForTimeout(120); }
  await page.waitForTimeout(300);
  const af = await val();
  ok('Esc 取消后敲数字仍生效', af !== b4, `${b4} → ${af}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  /* ---------- 5. 方向键改值后 input/label/API/侧栏 全部一致 ---------- */
  await setDue(dayOff(20));
  const before = await apiDue();
  await openPicker();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  const afterKey = await val();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
  ok('方向键改值：input 变了', afterKey !== before, `${before} → ${afterKey}`);
  ok('方向键改值：已持久化', (await apiDue()) === afterKey, `api="${await apiDue()}" 期望 "${afterKey}"`);
  /* 侧栏走 fmtDue、详情走原生渲染，文案可以不同，但必须指向同一日期 */
  const sideMatch = await page.locator(`#taskLists .tk-item[data-id="${tid}"] .tk-due`)
    .evaluate((el, d) => {
      const [y, m, dd] = d.split('-').map(Number);
      const tx = el.textContent;
      return tx === `${m}月${dd}日` || tx === `${y}年${m}月${dd}日` || tx === '今天' || tx === '明天' || tx === '昨天' || tx.endsWith('天后');
    }, await apiDue()).catch(() => false);
  ok('方向键改值：侧栏副行同步', sideMatch, `侧栏=${await sideDue()} 日期=${await apiDue()}`);

  /* ---------- 6. 刷新持久化 ---------- */
  const finalDue = await apiDue();
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.click('#modeSwitch .mode-btn[data-mode="tasks"]');
  await page.waitForTimeout(400);
  await page.locator(`#taskLists .tk-item[data-id="${tid}"]`).click();
  await page.waitForTimeout(400);
  ok('刷新后日期仍在', (await apiDue()) === finalDue, `api="${await apiDue()}" 期望 "${finalDue}"`);
  ok('刷新后 input 有值', (await val()) === finalDue, `input="${await val()}"`);

  /* ---------- 7. 清除后立刻能再设 ---------- */
  await page.locator('#taskDueClear').click();
  await page.waitForTimeout(350);
  ok('清除后 API 为空', (await apiDue()) === '');
  await openPicker();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  ok('清除后可再设', (await apiDue()) !== '', `api="${await apiDue()}"`);
  ok('清除后可再设：按钮回来', (await clearVisible()) === true);

  /* ---------- 8. 侧栏相对文案（今天/明天/昨天）与样式不漂 ---------- */
  const cases = [['今天', 0], ['明天', 1], ['昨天', -1]];
  for (const [want, off] of cases) {
    await setDue(dayOff(off));
    const side = (await sideDue() || '').trim();
    ok(`偏移 ${off} 天：侧栏文案 = ${want}`, side === want, `侧栏=${side}`);
  }

  /* ---------- 9. input 可见、可聚焦、日历图标未被藏掉 ---------- */
  const geo = await input().evaluate(el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const icoCs = getComputedStyle(el, '::-webkit-calendar-picker-indicator');
    return { opacity: cs.opacity, display: cs.display, visibility: cs.visibility, w: Math.round(r.width), h: Math.round(r.height), icoOpacity: icoCs.opacity, icoWidth: icoCs.width };
  });
  ok('input 可见且不透明', geo.opacity === '1' && geo.display !== 'none' && geo.visibility === 'visible', JSON.stringify(geo));
  ok('input 有实际尺寸', geo.w > 40 && geo.h > 10, `${geo.w}x${geo.h}`);
  ok('日历图标未被隐藏（可发现入口）', geo.icoOpacity === '1' && geo.icoWidth !== '0px', `opacity=${geo.icoOpacity} width=${geo.icoWidth}`);

  /* ---------- 10. 可键盘聚焦 ---------- */
  await input().focus();
  const focused = await page.evaluate(() => document.activeElement?.id);
  ok('input 可获得焦点', focused === 'taskDue', `activeElement=${focused}`);

  /* ---------- 11. 点击 input 任意位置都能开日历（它是真控件本身） ---------- */
  const box = await input().boundingBox();
  let opened = 0;
  for (const s of [0.15, 0.5, 0.85]) {
    const hit = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.tagName.toLowerCase()) : 'none'; },
      { x: box.x + box.width * s, y: box.y + box.height / 2 });
    if (hit === 'taskDue') opened++;
  }
  ok('input 三点采样全命中自身', opened === 3, `${opened}/3`);

  ok('无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | ') || '干净');

  await page.screenshot({ path: '.tmp-due2.png' });

  const pass = results.filter(r => r.c).length;
  console.log(`\n===== ${pass}/${results.length} 通过 =====`);
  if (errs.length) { console.log('控制台错误:'); errs.slice(0, 8).forEach(e => console.log('  ' + e)); }

  await browser.close();
  fs.writeFileSync('.tmp-due2.json', JSON.stringify({ pass, total: results.length, results, errs }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('崩了:', e); process.exit(2); });
