'use strict';
/* 浏览器启动配置的唯一来源。
 *
 * 背景：四个回归脚本原先各自写死 Windows 上 Edge 的路径，并强制 headless:false。
 * 结果是这套用例只能在作者本机跑 —— 换台机器、或者上 CI 必然失败，
 * 于是回归套件形同虚设（写了 60+ 条断言，但只有手动执行才算数）。
 *
 * 现在统一到这里。本地行为完全不变，CI 通过两个环境变量覆盖：
 *
 *   JIANJI_BROWSER    浏览器可执行文件路径。缺省依次尝试：本机 Edge
 *   JIANJI_HEADLESS=1 无头模式。CI 上没有交互桌面，必须开
 *
 * 注意 playwright-core 不自带浏览器（这是它和 playwright 的区别），
 * 可执行文件必须显式指定。
 */
const fs = require('fs');

const DEFAULT_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function resolveBrowser() {
  if (process.env.JIANJI_BROWSER) return process.env.JIANJI_BROWSER;
  if (fs.existsSync(DEFAULT_EDGE)) return DEFAULT_EDGE;
  return null;
}

const executablePath = resolveBrowser();
const headless = process.env.JIANJI_HEADLESS === '1';

function launch(chromium, extra) {
  if (!executablePath) {
    throw new Error(
      '找不到可用的浏览器。\n' +
      '  设置 JIANJI_BROWSER=<浏览器可执行文件路径> 来指定，或在 Windows 上安装 Edge。\n' +
      '  playwright-core 不自带浏览器，必须显式给出可执行文件。'
    );
  }
  return chromium.launch(Object.assign({ executablePath, headless }, extra));
}

module.exports = { launch, executablePath, headless };
