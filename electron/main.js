/* ============================================================
   简记 · Electron 主进程
   - 进程内启动同一个零依赖后端（server.js），随机端口 + 仅本机回环
   - 前端代码零改动：渲染进程仍然 fetch('/api/...')，只是 base 变成 127.0.0.1:随机端口
   - 数据目录切换到系统用户数据目录（Windows: %APPDATA%/简记/data）
   ============================================================ */
'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell } = require('electron');

let server = null;
let mainWindow = null;
let tray = null;

/* 应用名必须在 whenReady 之前定好：
   - Windows 任务栏与 AppUserModelID 挂钩，不设的话进程归属于 electron.exe
   - app.getPath('userData') 由 app.name 推导，不设会落到 %APPDATA%/Electron，
     多个 Electron 项目开发态会共用同一目录、数据互相污染
   注意：开发态任务栏图标仍显示 Electron 默认图 —— 那一格取的是 exe 内嵌图标资源，
   进程运行时改不了，只有打包成 简记.exe 后才正确。这是 Electron 的已知限制，不是配置问题。 */
app.setName('简记');
if (process.platform === 'win32') app.setAppUserModelId('com.jianji.notes');

/* 应用图标。打包后走 resources 里的 icon.ico / icon.png；
   开发态回落到仓库里的 png，保证 npm start 时任务栏图标也是简记而不是 Electron 默认图标。
   .ico 优先：Windows 会从中按 DPI 挑最合适的那一档（本文件内嵌 256/180/512），
   比单张 png 在高 DPI 缩放下更清晰。 */
function resolveIcon() {
  const fs = require('fs');
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, '..', 'icon', 'jianji-icon.ico'),
    path.join(__dirname, '..', 'icon', 'jianji-icon-256.png'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略探测失败 */ }
  }
  return undefined;
}

/* 托盘图标分 light / dark 两套，按系统主题切换。
   原因：托盘区面积只有 16~24px，单色图标不可能同时适配浅色和深色托盘条 ——
   实测白色笔在浅色条上完全消失、深色笔在深色条上完全消失。这是物理限制。
   做法同 VS Code / Docker Desktop：监听 nativeTheme 变化，动态 setImage。
   dark.ico 里是白笔，给深色托盘条用；light.ico 里是深笔，给浅色托盘条用。 */
function resolveTrayIcon(dark) {
  const fs = require('fs');
  const name = dark ? 'jianji-tray-dark.ico' : 'jianji-tray-light.ico';
  const candidates = [
    path.join(process.resourcesPath || '', name),
    path.join(__dirname, '..', 'icon', name),
    // .ico 缺失时退到 32px PNG，避免托盘整个空掉
    path.join(__dirname, '..', 'icon', dark ? 'jianji-tray-32-dark.png' : 'jianji-tray-32-light.png'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略探测失败 */ }
  }
  return undefined;
}

function createTray() {
  const iconPath = resolveTrayIcon(nativeTheme.shouldUseDarkColors);
  if (!iconPath) {
    console.warn('[jianji] 未找到托盘图标，托盘功能跳过（先跑 scripts/make-icon.py 生成）');
    return;
  }
  // 用 createFromPath 而非直接传路径字符串：返回的 NativeImage 才能可靠地
  // 在 setImage 里热替换，且开发态也能正确读到仓库里的图标
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('简记');

  const rebuildMenu = () => {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: mainWindow && mainWindow.isVisible() ? '隐藏窗口' : '显示窗口',
        click: () => toggleWindow(),
      },
      { label: '新建笔记', click: () => focusWindowAndSend('new-note') },
      { type: 'separator' },
      { label: '退出简记', click: () => { app.quit(); } },
    ]));
  };

  // 左键单击托盘图标：切换窗口显隐（Windows 惯例）
  tray.on('click', () => toggleWindow());
  tray.on('right-click', () => rebuildMenu());
  rebuildMenu();

  // 系统主题变化时换图，否则深色任务栏下托盘图标会消失
  nativeTheme.on('updated', () => {
    if (!tray) return;
    const next = resolveTrayIcon(nativeTheme.shouldUseDarkColors);
    if (next) tray.setImage(nativeImage.createFromPath(next));
  });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

/* 把「新建笔记」这类动作交给渲染进程。
   这里刻意用 webContents.send 而不是让主进程直接改数据 ——
   数据层归前端管（含撤销栈、自动保存），主进程越权写文件会造成两套状态。 */
function focusWindowAndSend(channel) {
  if (!mainWindow) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send(channel);
}

async function createWindow() {
  // 桌面端数据存到系统用户数据目录，避免与应用代码混在一起
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');
  console.log('[jianji] userData =', app.getPath('userData'));

  // 在进程内启动后端：port 0 = 随机可用端口，127.0.0.1 = 不暴露到局域网
  const { start } = require('../server.js');
  server = start({ port: 0, host: '127.0.0.1', quiet: true });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  console.log('[jianji] 内嵌后端已启动: http://127.0.0.1:' + port);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    autoHideMenuBar: true,
    backgroundColor: '#faf9f5',
    title: '简记',
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 笔记里的外链交给系统浏览器，不在应用内开窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  /* 禁止窗口内导航。本应用是单页应用，页面内一切跳转都不是预期行为；
     若渲染层被注入恶意内容（XSS 防线失守），导航是把它带去攻击者页面的
     最直接手段。仅放行后端自身（随机回环端口）的地址。 */
  const allowedOrigin = `http://127.0.0.1:${port}`;
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(allowedOrigin + '/') && url !== allowedOrigin) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (e, code, desc) =>
    console.error('[jianji] 页面加载失败:', code, desc));
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  console.log('[jianji] 窗口已加载页面');
}

process.on('uncaughtException', e => console.error('[jianji] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[jianji] unhandledRejection:', e));

/* 单实例锁。必须在 whenReady 之前申请。
   为什么必须有：数据写死在 userData/data/notes.json，两个实例同时跑会各自持有
   内存副本并互相覆盖，造成静默丢数据；托盘应用还会出现两个托盘图标。 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 拿不到锁说明已有实例在跑，直接退出，把焦点交给那边
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户又双击了一次图标：把已有窗口拉到前台，而不是开新窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    app.on('activate', () => {          // macOS：点 Dock 图标且无窗口时重建
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  /* Windows / Linux 关掉窗口即退出。
     若想改成「关闭后驻留托盘」，把下面两行换成不调 app.quit()，
     并在 createWindow 里给 mainWindow 加 'close' 拦截（preventDefault + hide）。 */
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (tray) { tray.destroy(); tray = null; }
  if (server) server.close();
});
