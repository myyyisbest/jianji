/* ============================================================
   简记 · Electron 主进程
   - 进程内启动同一个零依赖后端（server.js），随机端口 + 仅本机回环
   - 前端代码零改动：渲染进程仍然 fetch('/api/...')，只是 base 变成 127.0.0.1:随机端口
   - 数据目录切换到系统用户数据目录（Windows: %APPDATA%/简记/data）
   ============================================================ */
'use strict';

const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

let server = null;
let mainWindow = null;

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

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-fail-load', (e, code, desc) =>
    console.error('[jianji] 页面加载失败:', code, desc));
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  console.log('[jianji] 窗口已加载页面');
}

process.on('uncaughtException', e => console.error('[jianji] uncaughtException:', e));
process.on('unhandledRejection', e => console.error('[jianji] unhandledRejection:', e));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {          // macOS：点 Dock 图标且无窗口时重建
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (server) server.close();
});
