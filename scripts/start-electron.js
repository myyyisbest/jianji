/* 简记 · Electron 启动脚本（npm start 入口）
   某些 Electron 系 IDE（如 WorkBuddy / VSCode 系）会向子进程注入
   ELECTRON_RUN_AS_NODE=1，导致 electron 退化为纯 Node 而无法启动应用。
   这里在 spawn 前显式删除该变量，保证任何终端下 `npm start` 都能正常开窗。 */
'use strict';

const { spawn } = require('child_process');
const electronBin = require('electron');   // electron 包导出二进制绝对路径

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ['.'], { stdio: 'inherit', env });
child.on('close', code => process.exit(code ?? 0));
