/* ============================================================
   简记 · preload（预加载脚本）
   ------------------------------------------------------------
   这个文件是渲染进程与主进程之间**唯一**的通道。

   为什么需要它：主进程的 webPreferences 开了
     contextIsolation: true / nodeIntegration: false / sandbox: true
   这三项是安全基线，必须全开；代价是页面里既没有 require、也没有 ipcRenderer，
   主进程 webContents.send() 发过来的消息页面根本收不到。

   preload 是唯一一个「既能碰页面、又能碰部分 Electron API」的文件。
   它做的事**不是把 ipcRenderer 交给页面**（那等于把沙箱拆了），
   而是通过 contextBridge 暴露一份**白名单**：只有这里列出的方法，页面才够得着。

   注意：本应用的主体功能走的是内嵌 HTTP 后端（127.0.0.1:随机端口），
   不走 IPC。这里只桥接「本来就无法用 HTTP 表达」的桌面能力（托盘菜单动作、
   平台信息）。两种通道并存是刻意的，不是历史包袱。
   ============================================================ */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /* 是否运行在 Electron 里。网页模式下为 undefined，
     前端可以用 `if (window.desktop)` 做渐进增强，不必写两套代码。 */
  isElectron: true,
  platform: process.platform,

  /* 订阅主进程的「新建笔记」动作（来自托盘右键菜单）。
     返回值是取消订阅函数，组件卸载/页面销毁时应当调用，避免监听器泄漏。 */
  onNewNote(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = () => callback();
    ipcRenderer.on('new-note', handler);
    return () => ipcRenderer.removeListener('new-note', handler);
  },
});
