/* ============================================================
   简记 · 笔记 + 待办
   ------------------------------------------------------------
   编辑内核：CodeMirror 6（vendor/cm6.js）+ 自研 livePreview 扩展
     · 笔记正文与任务备注一律以 Markdown 文本为唯一数据源
     · 语法标记由 Decoration 隐藏/替换，光标进入节点时源码自动显形
   数据模型：
     notes  { id, title, content(md), tags[], pinned, favorite, createdAt, updatedAt, manualTitle }
     tasks  { id, listId, title, content(md), done, due, priority, starred, createdAt, updatedAt, doneAt }
     lists  { id, name, color, collapsed }
   ============================================================ */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* 存储键。应用从「素笺」更名为「简记」，键名一并前移，
   但旧键必须原样保留在 LEGACY_KEYS 里 —— 否则老用户升级后
   会看到一份空白的笔记库，这是不可接受的数据事故。
   迁移是「读旧写新」：首次启动把旧键数据搬到新键，旧键不删（留作回滚保险）。 */
const STORAGE_KEY = 'jianji-notes-v2';
const LEGACY_KEYS = ['sujian-notes-v2', 'sujian-notes-v1', 'liulin-notes-v1'];
const THEME_KEY = 'jianji-theme';
const SIDEBAR_KEY = 'jianji-sidebar-collapsed';
/* 偏好类键（主题 / 侧栏折叠）没有迁移流程，改名等于把用户设置静默重置，
   所以显式列一份旧键做一次性读取回退。 */
const LEGACY_PREF_KEYS = { 'jianji-theme': 'sujian-theme', 'jianji-sidebar-collapsed': 'sujian-sidebar-collapsed' };
const INBOX = 'inbox';

const state = {
  notes: [],
  tasks: [],
  lists: [],
  mode: 'notes',                 // notes | tasks
  selectedId: null,              // 当前笔记
  selectedTaskId: null,          // 当前任务
  filter: { kind: 'all', tag: null },
  tfilter: 'all',
  activeListId: null,            // 快速添加任务时的目标清单
  query: '',
  sort: 'updated',
  settings: {
    theme: 'light',
    sidebarCollapsed: false,
    autoPull: true,
    collapsedLists: [],
  },
  deleted: [],                   // [{ id, kind, deletedAt }]
  savedAt: 0,
};

let saveTimer = null;
let listTimer = null;
let cloudTimer = null;

/* ============================================================
   后端 API
   ============================================================ */
const Backend = {
  online: false,
  syncConfigured: false,
  async health() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      this.online = r.ok;
      if (r.ok) { const d = await r.json().catch(() => ({})); this.syncConfigured = !!d.sync; }
    } catch { this.online = false; this.syncConfigured = false; }
    return this.online;
  },
  async getArchive() {
    try {
      const r = await fetch('/api/notes', { cache: 'no-store' });
      this.online = r.ok;
      if (!r.ok) return null;
      return await r.json();
    } catch { this.online = false; return null; }
  },
  async saveArchive(archive) {
    try {
      const r = await fetch('/api/notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(archive),
      });
      this.online = r.ok;
      return r.ok;
    } catch { this.online = false; return false; }
  },
  async getConfig() {
    try { const r = await fetch('/api/config', { cache: 'no-store' }); if (!r.ok) return null; return (await r.json()).config; }
    catch { return null; }
  },
  async saveConfig(cfg) {
    try {
      const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok && d.ok, error: d.error };
    } catch { return { ok: false, error: '无法连接后端' }; }
  },
  async test() {
    try { return await (await fetch('/api/config/test', { method: 'POST' })).json(); }
    catch { return { ok: false, error: '无法连接后端' }; }
  },
  async remoteArchive() {
    try {
      const r = await fetch('/api/sync/remote', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok && d.ok, archive: d.archive, error: d.error };
    } catch { return { ok: false, error: '无法连接后端' }; }
  },
  async push() {
    try { return await (await fetch('/api/sync/push', { method: 'POST' })).json(); }
    catch { return { ok: false, error: '无法连接后端' }; }
  },
};

function refreshCloudDot() {
  const dot = $('#cloudDot');
  if (!dot) return;
  const cloud = Backend.online && Backend.syncConfigured;
  dot.dataset.state = cloud ? 'cloud' : (Backend.online ? 'on' : 'off');
  dot.title = cloud ? '云端同步已配置，保存即上传'
    : Backend.online ? '后端已连接，数据保存在本机' : '后端未连接，数据仅在浏览器本地';
}

/* ============================================================
   工具
   ============================================================ */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Markdown → 纯文本（摘要 / 搜索 / 字数共用） */
function mdToText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')       // 标题
    .replace(/^\s{0,3}>\s?/gm, '')            // 引用
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, '')// 任务项
    .replace(/^\s*[-*+]\s+/gm, '')            // 列表
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')          // 表格分隔
    .replace(/\|/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接
    .replace(/(\*\*|__|\*|_|~~|==|`)/g, '')   // 行内标记
    .replace(/^\s*([-*_]\s*){3,}$/gm, '')     // 分割线
    .replace(/\s+/g, ' ')
    .trim();
}

/* 由正文首行推导标题 */
function deriveTitle(md) {
  const line = String(md || '').split('\n').map(s => s.trim()).find(Boolean);
  if (!line) return '';
  return line.replace(/^#{1,6}\s+/, '').replace(/^>\s+/, '').slice(0, 40);
}

function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const same = a => a.toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (same(now)) return `今天 ${hm}`;
  if (same(yest)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDue(s) {
  const [y, m, dd] = s.split('-').map(Number);
  const d = new Date(y, m - 1, dd), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 864e5);
  if (diff === 0) return { text: '今天', cls: 'due-today' };
  if (diff === 1) return { text: '明天', cls: '' };
  if (diff === -1) return { text: '昨天', cls: 'over' };
  if (diff < 0) return { text: `${m}月${dd}日`, cls: 'over' };
  if (diff <= 7) return { text: `${diff} 天后`, cls: '' };
  return { text: `${m}月${dd}日`, cls: '' };
}

/* 截止日期的可视文本。原生 date input 被铺透明当作「选择器触发层」，
   真正显示给用户的是这个 span——这样才能既控字体又要回原生日历 */
function fmtDueLabel(due) {
  if (!due) return { text: '设置日期', empty: true, cls: '' };
  const [y, m, dd] = due.split('-').map(Number);
  if (!y || !m || !dd) return { text: due, empty: false, cls: '' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(y, m - 1, dd) - today) / 864e5);
  if (diff === 0) return { text: '今天', empty: false, cls: 'due-today' };
  if (diff === 1) return { text: '明天', empty: false, cls: '' };
  if (diff === -1) return { text: '昨天', empty: false, cls: 'over' };
  const cls = diff < 0 ? 'over' : '';
  if (Math.abs(diff) <= 7) {
    return { text: diff > 0 ? `${diff} 天后` : `${m}月${dd}日`, empty: false, cls };
  }
  return { text: `${y}年${m}月${dd}日`, empty: false, cls };
}

/* 截止日期的状态同步。
   日期文本由原生 <input type="date"> 自己渲染，这里只维护：
     - chip 上的 has-due 状态类（控制自定义占位是否收起、清除按钮是否出现）
   fmtDueLabel 仍保留：侧栏副行沿用 fmtDue 的相对文案，两者口径要对齐。 */
function syncDueText(due) {
  const wrap = $('.mt-date');
  if (wrap) wrap.classList.toggle('has-due', !!due);
  /* 清空按钮只在真的有日期时出现，避免空态多一个灰色方块 */
  const clr = $('#taskDueClear');
  if (clr) clr.hidden = !due;
}

/* ============================================================
   存储 / 迁移
   ============================================================ */
function load() {
  for (const key of [STORAGE_KEY, ...LEGACY_KEYS]) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { /* noop */ }
    if (!raw) continue;
    try {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.notes)) {
        /* 命中旧键：立刻写一份到新键，完成迁移。
           旧键保留不删 —— 万一新版本有问题，回滚旧版本仍能读到数据。 */
        if (key !== STORAGE_KEY) {
          try { localStorage.setItem(STORAGE_KEY, raw); } catch { /* 存储满则下次再试 */ }
        }
        return d;
      }
    } catch { /* 数据损坏，尝试下一个键 */ }
  }
  return null;
}

/* 偏好读取：先看新键，再回退旧键。返回 null 表示从未设置过。 */
function readPref(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
    const legacy = LEGACY_PREF_KEYS[key];
    if (legacy) {
      const lv = localStorage.getItem(legacy);
      if (lv !== null) {
        localStorage.setItem(key, lv);   // 迁移到新键，旧键留存
        return lv;
      }
    }
  } catch { /* noop */ }
  return null;
}

function currentArchive() {
  return {
    notes: state.notes, tasks: state.tasks, lists: state.lists,
    settings: state.settings, deleted: state.deleted, savedAt: Date.now(),
  };
}

function persist({ cloud = true } = {}) {
  try {
    const pkg = currentArchive();
    state.savedAt = pkg.savedAt;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pkg));
  } catch { /* 存储已满等情况静默失败 */ }
  if (cloud) scheduleCloudSave();
}

function scheduleCloudSave() {
  if (!Backend.online) { setStatus('saved'); return; }
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(async () => {
    const ok = await Backend.saveArchive(currentArchive());
    setStatus(ok && Backend.syncConfigured ? 'cloud' : 'saved');
    refreshCloudDot();
  }, 900);
}

function scheduleSave() {
  setStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persist(); }, 500);
}

/* 旧存档迁移：HTML 富文本 → Markdown；补齐 tasks / lists */
function migrate(raw) {
  const notes = [];
  for (const n of (raw.notes || [])) {
    let md = n.content;
    if (n.format === 'md') { md = n.content || ''; }
    else if (md && /<[a-z]+\b/i.test(md)) { md = htmlToMd(md); }
    notes.push({
      id: n.id || uid(),
      title: n.title || '',
      content: md || '',
      tags: Array.isArray(n.tags) ? n.tags : [],
      pinned: !!n.pinned,
      favorite: !!n.favorite,
      manualTitle: !!n.manualTitle,
      createdAt: n.createdAt || Date.now(),
      updatedAt: n.updatedAt || Date.now(),
    });
  }

  let lists = Array.isArray(raw.lists) ? raw.lists.map(l => ({
    id: l.id || uid(), name: l.name || '清单', color: l.color || 0, collapsed: !!l.collapsed,
  })) : [];
  const tasks = (raw.tasks || []).map(t => ({
    id: t.id || uid(),
    listId: t.listId || (lists[0] && lists[0].id) || INBOX,
    title: t.title || '',
    content: t.content || '',
    done: !!t.done,
    due: t.due || '',
    priority: Number(t.priority) || 0,
    starred: !!t.starred,
    createdAt: t.createdAt || Date.now(),
    updatedAt: t.updatedAt || Date.now(),
    doneAt: t.doneAt || 0,
  }));

  if (!lists.some(l => l.id === INBOX)) {
    lists = [{ id: INBOX, name: '收件箱', color: 0, collapsed: false }, ...lists];
  }
  if (!lists.length) lists = [{ id: INBOX, name: '收件箱', color: 0, collapsed: false }];

  const deleted = (raw.deleted || []).map(t => ({ id: t.id, kind: t.kind || 'note', deletedAt: t.deletedAt || Date.now() }));
  return { notes, tasks, lists, deleted };
}

/* ============================================================
   示例数据
   ============================================================ */
function seed() {
  const now = Date.now(), H = 36e5, D = 864e5;
  const lists = [
    { id: INBOX, name: '收件箱', color: 0, collapsed: false },
    { id: uid(), name: '工作', color: 1, collapsed: false },
    { id: uid(), name: '生活', color: 2, collapsed: false },
  ];
  const t = (title, opt = {}) => ({
    id: uid(), title, done: false, due: '', priority: 0, starred: false,
    content: '', createdAt: now, updatedAt: now, doneAt: 0, ...opt,
  });
  const tasks = [
    t('体验「任务」模块：试着点开这条任务写点备注', { listId: lists[0].id, starred: true, due: todayStr(), content: '这里就是任务的**备注**，支持与笔记完全一样的 Markdown 即写即渲染。\n\n- 可以记背景\n- 贴代码片段\n- 放参考资料链接' }),
    t('整理本周周报', { listId: lists[1].id, priority: 2, due: todayStr(new Date(now + 2 * D)) }),
    t('给团队演示简记的同步链路', { listId: lists[1].id, priority: 1 }),
    t('周末买菜清单', { listId: lists[2].id, priority: 0 }),
    t('已完成的样子长这样', { listId: lists[0].id, done: true, doneAt: now - H }),
  ];

  const notes = [
    {
      id: uid(), title: '欢迎使用简记 ✨', tags: ['指南'], pinned: true, favorite: true,
      createdAt: now - 2 * H, updatedAt: now - 2 * H, manualTitle: true,
      content: `# 你好，欢迎来到简记

这是一款把**笔记**和**待办**放在一起的本地小工具：数据存在你自己手里，可用 WebDAV 或 S3 同步。

## 编辑器

正文是纯 Markdown，但**语法符号会自动隐身**，你看到的就是排版后的样子——和 Obsidian 的即时预览一样：
- 输入 \`# \` + 空格 → 立刻变标题（H1~H4 都支持）
- 输入 \`**加粗**\`、\`~~删除线~~\`、\`==高亮==\`、\\\`代码\\\` → 闭合即渲染
- 输入 \`- [ ] \` → 待办勾选框，直接点方框就能打勾
- 输入 \`| 列 | 列 |\` 或点工具栏最后一个按钮 → 表格，光标离开表格会渲染成真正的表格

- [ ] 试着点一下左边的方框
- [x] 打勾之后会变灰，并自动汇总进「任务 → 笔记中的待办」

| 操作 | 快捷键 |
| --- | --- |
| 搜索 | Ctrl K |
| 新建笔记 | Ctrl Alt N |
| 新建任务 | Ctrl Alt T |

> 光标移进某一行，那行的 Markdown 源码会自动显形，方便直接改；移出来又变回排版。

## 任务

右上角「新建 → 新建任务」，可以设**清单（分类）**、截止日、优先级，再写一段 Markdown 备注。左侧「任务」页里清单可以折叠。

\`\`\`js
// 代码块同样支持
const hello = '简记';
\`\`\`

---

祝书写愉快。`,
    },
    {
      id: uid(), title: '云端同步小贴士', tags: ['指南'], createdAt: now - D, updatedAt: now - 10 * H, manualTitle: true,
      content: `## 两种同步后端：S3 或 WebDAV

打开右上角 **设置**，在「云端同步」里任选一种：

- **S3 对象存储**：AWS S3 / Cloudflare R2 / MinIO 等，填 Endpoint、Region、Bucket 与密钥
- **WebDAV**：坚果云 / Nextcloud / 群晖等，填地址、用户名与应用密码、存档路径

1. 开启 **保存即上传** 后，每次保存都会自动上传存档
2. 开启 **多端自动同步** 后，各设备按「较新修改胜出」自动合并，删除也会同步传播

> 笔记、任务、清单、标签、偏好全部在同一个存档里同步。`,
    },
    {
      id: uid(), title: '阅读摘抄', tags: ['阅读'], favorite: true, createdAt: now - 3 * D, updatedAt: now - 2 * D, manualTitle: true,
      content: `## 本周摘抄

> 我们塑造了工具，此后工具塑造我们。

—— 麦克卢汉

> 简单比复杂更难，你必须努力让你的想法变得清晰明了。

—— Steve Jobs

---

聚沙成塔，集腋成裘。`,
    },
  ];
  return { notes, tasks, lists };
}

/* ============================================================
   筛选
   ============================================================ */
function visibleNotes() {
  let arr = [...state.notes];
  const f = state.filter;
  if (f.kind === 'fav') arr = arr.filter(n => n.favorite);
  else if (f.kind === 'pinned') arr = arr.filter(n => n.pinned);
  else if (f.kind === 'tag') arr = arr.filter(n => n.tags.includes(f.tag));

  if (state.query) {
    const q = state.query.toLowerCase();
    arr = arr.filter(n =>
      (displayTitle(n) || '').toLowerCase().includes(q) ||
      mdToText(n.content).toLowerCase().includes(q));
  }

  arr.sort((a, b) => {
    if (state.sort === 'title') return (displayTitle(a) || '无题').localeCompare(displayTitle(b) || '无题', 'zh');
    if (state.sort === 'created') return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });
  arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return arr;
}

function displayTitle(n) {
  return n.manualTitle ? n.title : (n.title || deriveTitle(n.content));
}

function visibleTasks() {
  const today = todayStr();
  const week = todayStr(new Date(Date.now() + 7 * 864e5));
  let arr = [...state.tasks];
  switch (state.tfilter) {
    case 'today': arr = arr.filter(t => !t.done && t.due && t.due <= today); break;
    case 'star': arr = arr.filter(t => !t.done && t.starred); break;
    case 'week': arr = arr.filter(t => !t.done && t.due && t.due <= week); break;
    case 'done': arr = arr.filter(t => t.done); break;
    default: arr = arr.filter(t => !t.done); break;
  }
  if (state.query) {
    const q = state.query.toLowerCase();
    arr = arr.filter(t => (t.title || '').toLowerCase().includes(q) || mdToText(t.content).toLowerCase().includes(q));
  }
  return arr;
}

const selectedNote = () => state.notes.find(n => n.id === state.selectedId) || null;
const selectedTask = () => state.tasks.find(n => n.id === state.selectedTaskId) || null;
const note = id => state.notes.find(n => n.id === id);
const task = id => state.tasks.find(n => n.id === id);
const list = id => state.lists.find(l => l.id === id) || state.lists[0];

/* ============================================================
   CodeMirror 编辑器
   ============================================================ */
const CM = window.CM6;   // 注意：不能叫 CM6——打包产物用 var 声明了同名全局变量
let noteView = null, taskView = null;

/* 两个编辑器实例：一个负责笔记正文，一个负责任务备注 */
function ensureViews() {
  if (noteView) return;
  noteView = makeView($('#noteCm'), '开始书写，灵感即刻凝结…', onNoteChanged);
  taskView = makeView($('#taskCm'), '为这条任务补一段背景、清单或参考…', onTaskChanged);
}

function makeView(parent, ph, onDocChange) {
  return new CM.EditorView({
    state: CM.EditorState.create({
      doc: '',
      extensions: [
        ...CM.baseExtensions({ placeholderText: ph }),
        // 工具栏提示里写的 Ctrl/⌘ B、I 在这里兑现（baseExtensions 的默认键位不含它们）
        CM.Prec.highest(CM.keymap.of([
          { key: 'Mod-b', run: v => runCmd(v, 'bold') },
          { key: 'Mod-i', run: v => runCmd(v, 'italic') },
        ])),
        CM.EditorView.updateListener.of(u => { if (u.docChanged) onDocChange(); }),
      ],
    }),
    parent,
  });
}

function setDoc(view, text) {
  if (!view) return;
  if (view.state.doc.toString() === text) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    // 光标落到文末而不是第 0 位：否则刚打开笔记，光标所在的标题行会把 '#' 显示出来
    selection: { anchor: text.length },
  });
}

const activeView = () => ($('#taskBody').hidden === false ? taskView : noteView);

/* ============================================================
   渲染：侧栏
   ============================================================ */
/* ------------------------------------------------------------
   图标：统一 24 网格、圆头圆角、1.7 描边（与 design token 同源）
   ------------------------------------------------------------ */
const svg = d => `<svg viewBox="0 0 24 24">${d}</svg>`;

/* 笔记 / 文档 */
const ICON_DOC = svg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10A1.5 1.5 0 0 0 18.5 19V8.5z"/><path d="M13.5 3.5V8.5h5"/><path d="M9 12.5h6"/><path d="M9 16h4"/>');
/* 任务 / 打钩清单 */
const ICON_TODO = svg('<path d="M3.6 6.9 5.3 8.6l2.6-2.8"/><path d="M3.6 12.4 5.3 14.1l2.6-2.8"/><path d="M3.6 17.9 5.3 19.6l2.6-2.8"/><path d="M11.5 7h9"/><path d="M11.5 12.5h9"/><path d="M11.5 18h5.5"/>');
const ICON_PLUS = svg('<path d="M12 5.5v13"/><path d="M5.5 12h13"/>');
const ICON_PEN = svg('<path d="M14.2 4.6l5.2 5.2"/><path d="M15.4 3.4 19 7a1.4 1.4 0 0 1 0 2l-9.6 9.6-4.4 1.4 1.4-4.4L16 6a1.4 1.4 0 0 0 0-2z"/><path d="M5 20.5h14"/>');
const ICON_PIN = svg('<path d="M12 16.5V21"/><path d="M8.4 3.5h7.2l-.9 6.3 3.3 3.2v1.5H6v-1.5l3.3-3.2-.9-6.3z"/>');
const ICON_STAR = svg('<path d="m12 3.8 2.4 5 5.5.8-4 3.9.9 5.5-4.8-2.6-4.8 2.6.9-5.5-4-3.9 5.5-.8 2.4-5z"/>');
const ICON_TRASH = svg('<path d="M4.5 6.5h15"/><path d="M9.5 6.5v-2h5v2"/><path d="M6.5 6.5 7.4 20.5h9.2l.9-14"/>');
const ICON_CHECK = svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>');
/* 有备注：一张「信笺」，右上角折角 + 两行字，和正文里的 ICON_DOC 同族但更方正 */
const ICON_NOTE = svg('<path d="M5.5 6.2A1.2 1.2 0 0 1 6.7 5h10.6A1.2 1.2 0 0 1 18.5 6.2v11.6A1.2 1.2 0 0 1 17.3 19H6.7a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M8.6 9.2h6.8"/><path d="M8.6 12.2h6.8"/><path d="M8.6 15.2h4.2"/>');
const ICON_FOLDER = svg('<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.6l1.7 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 19 18.2H5a1.5 1.5 0 0 1-1.5-1.5z"/>');

function renderSidebar(animate = false) {
  if (state.mode === 'tasks') renderTaskPanel(animate);
  else renderNoteList(animate);
  renderSideFoot();
  $('#panelNotes').hidden = state.mode !== 'notes';
  $('#panelTasks').hidden = state.mode !== 'tasks';
  $$('#modeSwitch .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
}

function renderSideFoot() {
  const el = $('#sideFoot');
  const cloudHint = Backend.syncConfigured && Backend.online ? ' · 云端同步已开启' : ' · 保存在本机';
  if (state.mode === 'notes') {
    el.textContent = `${state.notes.length} 条笔记${cloudHint}`;
  } else {
    const open = state.tasks.filter(t => !t.done).length;
    el.textContent = `${open} 项未完成 · ${state.tasks.length - open} 已完成${cloudHint}`;
  }
  updateTaskBadge();
}

function renderNoteList(animate = false) {
  const listEl = $('#noteList');
  listEl.classList.toggle('no-anim', !animate);
  const arr = visibleNotes();

  const html = arr.length ? arr.map((n, i) => {
    const snippet = mdToText(n.content) || '（暂无内容）';
    const flags = (n.pinned ? `<span class="ni-flag pin" title="已置顶">${ICON_PIN}</span>` : '') +
      (n.favorite ? `<span class="ni-flag star" title="已收藏">${ICON_STAR}</span>` : '');
    const tags = n.tags.map(t => `<span class="ni-tag">#${escapeHtml(t)}</span>`).join('');
    return `
      <div class="note-item ${n.id === state.selectedId ? 'active' : ''}" style="--i:${i}" data-id="${n.id}">
        <div class="ni-top">${flags}<span class="ni-title">${escapeHtml(displayTitle(n)) || '无题笔记'}</span><span class="ni-time">${fmtTime(n.updatedAt)}</span></div>
        <div class="ni-snippet">${escapeHtml(snippet)}</div>
        <div class="ni-tags">${tags}</div>
        <button class="ni-del" title="删除">${ICON_TRASH}</button>
      </div>`;
  }).join('') : `<div class="list-empty">${state.query ? '没有找到匹配的笔记 🔍' : '这里空空如也，新建一篇吧'}</div>`;

  if (listEl.innerHTML !== html) listEl.innerHTML = html;
}

/* ---------------- 任务面板 ---------------- */
const LIST_COLORS = ['--accent', '--star', '--ok', '#7d8cb3', '#b37d9a', '#8a9a7b'];

function taskRow(t) {
  const due = t.due ? fmtDue(t.due) : null;
  /* 星标在右侧有专用按钮，这里不再重复渲染；副行只放「截止日 + 有备注」两项元信息 */
  const note = t.content.trim() ? `<span class="tk-hasnote" title="有备注">${ICON_NOTE}</span>` : '';
  const sub = due || note
    ? `<div class="tk-sub">${due ? `<span class="tk-due ${due.cls}">${due.text}</span>` : ''}${note}</div>`
    : '';
  return `
    <div class="tk-item ${t.done ? 'done' : ''} ${t.id === state.selectedTaskId ? 'active' : ''}" data-id="${t.id}">
      <span class="tk-check" title="${t.done ? '标记为未完成' : '标记为完成'}">${ICON_CHECK}</span>
      <div class="tk-main">
        <div class="tk-title">${escapeHtml(t.title) || '<i>未命名任务</i>'}</div>
        ${sub}
      </div>
      <button class="tk-star ${t.starred ? 'on' : ''}" title="${t.starred ? '取消重要' : '标记重要'}">${ICON_STAR}</button>
    </div>`;
}

function renderTaskPanel(animate = false) {
  const box = $('#taskLists');
  const visible = visibleTasks();

  /* 按清单分组 */
  const groups = state.lists.map(l => {
    const items = visible.filter(t => t.listId === l.id);
    items.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (!!a.starred !== !!b.starred) return b.starred ? -1 : 1;
      if (!!a.due !== !!b.due) return a.due ? -1 : 1;
      if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
      return (b.priority || 0) - (a.priority || 0);
    });
    return { list: l, items };
  }).filter(g => g.items.length || !state.query);

  let html = `
    <div class="tk-quick">
      <span class="tk-plus">${ICON_PLUS}</span>
      <input id="tkQuick" type="text" placeholder="添加任务…" autocomplete="off" spellcheck="false">
    </div>`;

  for (const g of groups) {
    const collapsed = g.list.collapsed;
    html += `
      <div class="tk-group ${collapsed ? 'collapsed' : ''}" data-list="${g.list.id}">
        <div class="tk-group-head">
          <button class="tk-caret" title="${collapsed ? '展开' : '折叠'}">
            <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
          </button>
          <button class="tk-dot" style="background:var(${LIST_COLORS[g.list.color % LIST_COLORS.length]})" title="换个颜色"></button>
          <span class="tk-name">${escapeHtml(g.list.name)}</span>
          <span class="tk-count">${g.items.length}</span>
          <span class="tk-ops">
            <button class="tk-op" data-act="add" title="在此清单新建任务">${ICON_PLUS}</button>
            <button class="tk-op" data-act="rename" title="重命名">${ICON_PEN}</button>
            <button class="tk-op danger" data-act="del" title="删除清单">${ICON_TRASH}</button>
          </span>
        </div>
        <div class="tk-group-body">${g.items.map(taskRow).join('')}
          ${g.items.length ? '' : '<div class="tk-empty">这个清单还没有任务</div>'}
        </div>
      </div>`;
  }

  /* 笔记里的 - [ ] 聚合（可折叠） */
  const agg = collectNoteTodos();
  const aggOpen = (t) => (!t.due || t.due <= (state.tfilter === 'week' ? week : today));
  if (agg.groups.length) {
    const collapsed = !!state.settings.todosCollapsed;
    const items = agg.groups.filter(g => {
      if (state.tfilter === 'done') return g.items.every(i => i.checked);
      if (state.tfilter === 'all') return true;
      return g.items.some(i => !i.checked);
    });
    if (items.length || !state.query) {
      html += `
      <div class="tk-group ${collapsed ? 'collapsed' : ''}" data-list="__notes">
        <div class="tk-group-head agg">
          <button class="tk-caret"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>
          <span class="tk-aggicon">${ICON_NOTE}</span>
          <span class="tk-name">笔记中的待办</span>
          <span class="tk-count">${agg.total - agg.done}</span>
        </div>
        <div class="tk-group-body">
          ${items.map(g => `
            <div class="tk-aggnote" data-note="${g.noteId}">
              <span class="tk-aggtitle">${escapeHtml(g.title)}</span>
              <span class="tk-aggcnt">${g.items.filter(i => !i.checked).length}/${g.items.length}</span>
            </div>
            ${g.items.filter(i => state.tfilter === 'done' ? true : !i.checked).map(i => `
              <div class="tk-item agg" data-notetodo="${g.noteId}" data-idx="${i.idx}">
                <span class="tk-check"></span>
                <div class="tk-main"><div class="tk-title">${escapeHtml(i.text)}</div></div>
              </div>`).join('')}
          `).join('')}
        </div>
      </div>`;
    }
  }

  if (box.innerHTML !== html) box.innerHTML = html;
  $$('#taskFilters .filter').forEach(b => b.classList.toggle('active', b.dataset.tfilter === state.tfilter));
}

/* 汇总所有笔记 Markdown 里的 - [ ] 项 */
function collectNoteTodos() {
  const groups = [];
  let total = 0, done = 0;
  for (const n of [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const lines = String(n.content || '').split('\n');
    const items = [];
    /* ordinal 必须是「第几个待办」，与 toggleNoteTodo 的计数口径一致；
       行号会在笔记含标题/正文时错位，不能拿来做下标 */
    let ordinal = -1;
    lines.forEach((line) => {
      const m = /^\s*[-*+]\s+\[([ xX])\]\s*(.+)$/.exec(line);
      if (m) {
        ordinal++;
        items.push({ idx: ordinal, text: m[2].trim(), checked: m[1].toLowerCase() === 'x' });
      }
    });
    if (!items.length) continue;
    total += items.length;
    done += items.filter(i => i.checked).length;
    if (state.query) {
      const q = state.query.toLowerCase();
      const keep = items.filter(i => i.text.toLowerCase().includes(q) || displayTitle(n).toLowerCase().includes(q));
      if (!keep.length) continue;
      groups.push({ noteId: n.id, title: displayTitle(n), items: keep });
    } else {
      groups.push({ noteId: n.id, title: displayTitle(n), items });
    }
  }
  return { groups, total, done };
}

function renderTags() {
  const counts = new Map();
  state.notes.forEach(n => n.tags.forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));

  const bar = $('#tagBar');
  bar.innerHTML = tags.length
    ? `<button class="tag-chip" data-clear style="${state.filter.kind === 'tag' ? '' : 'display:none'}">✕ 清除筛选</button>` +
      tags.map(([t, c]) => `<button class="tag-chip ${state.filter.kind === 'tag' && state.filter.tag === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}<span class="cnt">${c}</span></button>`).join('')
    : '';
  bar.style.display = tags.length ? '' : 'none';
}

/* ============================================================
   渲染：编辑器
   ============================================================ */
let currentNoteRef = null;   // 正在被 noteView 编辑的笔记引用（避免回写错对象）

function showEmpty() {
  $('#editorEmpty').hidden = false;
  $('#editorBody').hidden = true;
  $('#taskBody').hidden = true;
}

function renderEditor(animate = true) {
  ensureViews();
  const n = selectedNote();
  if (!n) { showEmpty(); currentNoteRef = null; return; }
  $('#editorEmpty').hidden = true;
  $('#taskBody').hidden = true;
  $('#editorBody').hidden = false;

  currentNoteRef = n;
  $('#titleInput').value = n.manualTitle ? n.title : displayTitle(n);
  setDoc(noteView, n.content || '');
  noteView.requestMeasure();     // 从隐藏态恢复后需要重新测量，否则行高与装饰可能错位
  renderMeta(n);
  if (animate) replaySwap([$('#titleInput'), $('.meta-row'), $('#noteCm')]);
}

function renderMeta(n) {
  $('#tagChips').innerHTML = n.tags.map(t =>
    `<span class="meta-chip">#${escapeHtml(t)}<button class="x" data-tag="${escapeHtml(t)}" title="移除标签">×</button></span>`).join('');
  $('#wordCount').textContent = `${countWords(n)} 字`;
  $('#updatedTime').textContent = `更新于 ${fmtTime(n.updatedAt)}`;
  $('#pinBtn').classList.toggle('on', !!n.pinned);
  $('#favBtn').classList.toggle('on', !!n.favorite);
}

function countWords(n) { return mdToText(n.content).replace(/\s/g, '').length; }

function setStatus(mode) {
  const el = $('#saveStatus');
  if (!el) return;
  el.classList.toggle('saving', mode === 'saving');
  el.classList.toggle('cloud', mode === 'cloud');
  const cloud = Backend.online && Backend.syncConfigured;
  el.textContent = mode === 'saving' ? '保存中…'
    : mode === 'cloud' ? '已同步云端'
      : (Backend.online ? '已存到本机' : '仅存在浏览器');
  el.title = cloud ? '本地已保存，并已上传到云端存储'
    : Backend.online ? '后端已连接，数据写入本机存档'
      : '后端未启动，数据暂存在浏览器 localStorage';
}

function replaySwap(els) {
  els.forEach(el => { if (!el) return; el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); });
}

/* ---------------- 文档变更 ---------------- */
function onNoteChanged() {
  const n = currentNoteRef;
  if (!n) return;
  const md = noteView.state.doc.toString();
  if (md === n.content) return;
  n.content = md;
  n.updatedAt = Date.now();
  if (!n.manualTitle) $('#titleInput').value = displayTitle(n);
  scheduleSave();
  $('#wordCount').textContent = `${countWords(n)} 字`;
  $('#updatedTime').textContent = `更新于 ${fmtTime(n.updatedAt)}`;
  clearTimeout(listTimer);
  listTimer = setTimeout(() => { renderNoteList(); renderSideFoot(); }, 400);
}

function onTaskChanged() {
  const t = selectedTask();
  if (!t) return;
  const md = taskView.state.doc.toString();
  if (md === t.content) return;
  t.content = md;
  t.updatedAt = Date.now();
  scheduleSave();
  clearTimeout(listTimer);
  listTimer = setTimeout(() => renderTaskPanel(), 400);
}

/* ============================================================
   任务详情
   ============================================================ */
function renderTaskDetail() {
  ensureViews();
  const t = selectedTask();
  if (!t) { if (state.mode === 'notes') renderEditor(); else showEmpty(); return; }
  $('#editorEmpty').hidden = true;
  $('#editorBody').hidden = true;
  $('#taskBody').hidden = false;

  $('#taskTitle').value = t.title || '';
  $('#taskDone').classList.toggle('on', t.done);
  $('#taskDone').setAttribute('aria-checked', t.done ? 'true' : 'false');
  $('#taskStarBtn').classList.toggle('on', t.starred);
  const body = $('#taskBody');
  body.classList.toggle('is-done', t.done);
  body.classList.toggle('is-starred', !!t.starred);
  $('#taskDue').value = t.due || '';
  syncDueText(t.due);
  $('#taskPriority').value = String(t.priority || 0);
  $('#taskTime').textContent = t.done && t.doneAt ? `完成于 ${fmtTime(t.doneAt)}` : `创建于 ${fmtTime(t.createdAt)}`;

  /* 颜色圆点与所属清单联动，和侧栏的分组色一一对应 */
  const cur = state.lists.find(l => l.id === t.listId) || state.lists[0];
  const swatch = $('#taskListSwatch');
  if (swatch && cur) swatch.style.background = `var(${LIST_COLORS[cur.color % LIST_COLORS.length]})`;

  const sel = $('#taskListSel');
  sel.innerHTML = state.lists.map(l => `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
  sel.value = t.listId;

  setDoc(taskView, t.content || '');
  taskView.requestMeasure();
}

/* ============================================================
   动作：笔记
   ============================================================ */
function selectNote(id, { focusTitle = false } = {}) {
  state.selectedTaskId = null;
  state.selectedId = id;
  renderSidebar();
  renderEditor();
  closeMobileSidebar();
  if (focusTitle) $('#titleInput').focus();
}

function createNote() {
  const n = {
    id: uid(), title: '', content: '', manualTitle: false,
    tags: state.filter.kind === 'tag' ? [state.filter.tag] : [],
    pinned: false, favorite: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.notes.unshift(n);
  state.mode = 'notes';
  persist();
  renderTags();
  selectNote(n.id, { focusTitle: true });
  setDoc(noteView, '');
  noteView.focus();
}

function deleteNote(id) {
  const idx = state.notes.findIndex(n => n.id === id);
  if (idx < 0) return;
  const [n] = state.notes.splice(idx, 1);
  state.deleted = state.deleted.filter(t => !(t.id === id && t.kind === 'note'));
  state.deleted.push({ id, kind: 'note', deletedAt: Date.now() });

  if (state.selectedId === id) state.selectedId = null;
  persist();
  renderTags();
  const next = visibleNotes()[0];
  if (next) selectNote(next.id); else { renderSidebar(); showEmpty(); }

  toast(`已删除「${displayTitle(n) || '无题笔记'}」`, {
    action: '撤销',
    onAction: () => {
      state.deleted = state.deleted.filter(t => !(t.id === id && t.kind === 'note'));
      state.notes.splice(Math.min(idx, state.notes.length), 0, n);
      n.updatedAt = Date.now();
      persist(); renderTags(); selectNote(n.id);
    },
  });
}

/* ============================================================
   动作：任务
   ============================================================ */
function ensureInbox() {
  if (!state.lists.some(l => l.id === INBOX)) {
    state.lists.unshift({ id: INBOX, name: '收件箱', color: 0, collapsed: false });
  }
  return INBOX;
}

function createTask({ title = '', listId = null } = {}) {
  ensureInbox();
  const t = {
    id: uid(), title, listId: listId || state.activeListId || INBOX,
    content: '', done: false, due: '', priority: 0, starred: false,
    createdAt: Date.now(), updatedAt: Date.now(), doneAt: 0,
  };
  state.tasks.push(t);
  state.mode = 'tasks';
  persist();
  selectTask(t.id);
  renderSidebar();
  if (!title) $('#taskTitle').focus();
  return t;
}

function selectTask(id) {
  state.selectedId = null;
  state.selectedTaskId = id;
  if (state.mode !== 'tasks') state.mode = 'tasks';
  renderSidebar();
  renderTaskDetail();
  closeMobileSidebar();
}

function deleteTask(id) {
  const idx = state.tasks.findIndex(t => t.id === id);
  if (idx < 0) return;
  const [t] = state.tasks.splice(idx, 1);
  state.deleted = state.deleted.filter(x => !(x.id === id && x.kind === 'task'));
  state.deleted.push({ id, kind: 'task', deletedAt: Date.now() });
  if (state.selectedTaskId === id) state.selectedTaskId = null;
  persist();
  const next = visibleTasks()[0];
  if (next) selectTask(next.id); else renderSidebar(), showEmpty();

  toast(`已删除任务「${t.title || '未命名'}」`, {
    action: '撤销',
    onAction: () => {
      state.deleted = state.deleted.filter(x => !(x.id === id && x.kind === 'task'));
      state.tasks.splice(Math.min(idx, state.tasks.length), 0, t);
      persist(); selectTask(t.id);
    },
  });
}

function updateTask(patch, { rerender = true, skip = false } = {}) {
  const t = selectedTask();
  if (!t) return;
  Object.assign(t, patch);
  t.updatedAt = Date.now();
  scheduleSave();
  if (rerender && !skip) renderTaskPanel();
  /* 侧栏列表也必须同步：改标题/截止日会直接反映在行内副行上，
     不重绘就会出现「详情区已经变了、左侧还是旧值」的割裂状态 */
  if (state.mode === 'tasks') renderTaskPanel();
  renderSideFoot();
}

function toggleTaskDone(id) {
  const t = task(id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : 0;
  t.updatedAt = t.doneAt || Date.now();
  persist();
  if (state.selectedTaskId === id) {
    $('#taskDone').classList.toggle('on', t.done);
    $('#taskDone').setAttribute('aria-checked', t.done ? 'true' : 'false');
    $('#taskBody').classList.toggle('is-done', t.done);
    $('#taskTime').textContent = t.done && t.doneAt ? `完成于 ${fmtTime(t.doneAt)}` : `创建于 ${fmtTime(t.createdAt)}`;
  }
  renderTaskPanel();
  renderSideFoot();
}

function toggleNoteTodo(noteId, idx) {
  const n = note(noteId);
  if (!n) return;
  const lines = n.content.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[-*+]\s+\[([ xX])\]\s*/.test(lines[i])) {
      seen++;
      if (seen === idx) {
        lines[i] = lines[i].replace(/\[([ xX])\]/, m => m[1] === ' ' ? '[x]' : '[ ]');
        break;
      }
    }
  }
  n.content = lines.join('\n');
  n.updatedAt = Date.now();
  persist();
  if (state.selectedId === noteId) setDoc(noteView, n.content);
  renderTaskPanel();
}

/* 清单 */
function createList() {
  const l = { id: uid(), name: '新清单', color: state.lists.length % LIST_COLORS.length, collapsed: false };
  state.lists.push(l);
  persist();
  renderTaskPanel();
  const head = $(`.tk-group[data-list="${l.id}"] .tk-name`);
  if (head) startRenameList(l.id, head);
}

function startRenameList(id, nameEl) {
  const l = list(id);
  if (!l || !nameEl) return;
  /* 幂等：已经有输入框在编辑这个清单时，聚焦即可，避免把自己替换掉后失焦提交 */
  const existing = nameEl.parentElement && nameEl.parentElement.querySelector('.tk-rename');
  if (existing) { existing.focus(); existing.select(); return; }
  const input = document.createElement('input');
  input.className = 'tk-rename';
  input.value = l.name;
  input.dataset.prev = l.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    l.name = v || input.dataset.prev || '清单';
    persist();
    renderTaskPanel();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { input.value = input.dataset.prev; commit(); }
  });
}

function deleteList(id) {
  if (id === INBOX) { toast('「收件箱」是默认清单，不能删除'); return; }
  const l = list(id);
  const cnt = state.tasks.filter(t => t.listId === id).length;
  if (!confirm(`删除清单「${l.name}」？其中 ${cnt} 个任务将一并删除。`)) return;
  state.tasks.filter(t => t.listId === id).forEach(t => {
    state.deleted.push({ id: t.id, kind: 'task', deletedAt: Date.now() });
  });
  state.tasks = state.tasks.filter(t => t.listId !== id);
  state.lists = state.lists.filter(x => x.id !== id);
  ensureInbox();
  if (state.selectedTaskId && !state.tasks.some(t => t.id === state.selectedTaskId)) {
    state.selectedTaskId = null;
    showEmpty();
  }
  persist();
  renderTaskPanel();
  toast(`已删除清单「${l.name}」`);
}

/* ============================================================
   Markdown 编辑命令（工具栏）
   ============================================================ */
function viewReplaceRange(view, from, to, insert, selFrom, selTo) {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: selFrom ?? (from + insert.length), head: selTo ?? undefined },
    scrollIntoView: true,
  });
  view.focus();
}

function toggleInline(view, marker) {
  const { state: st } = view;
  const changes = [];
  let shift = 0;
  for (const r of st.selection.ranges) {
    const text = st.sliceDoc(r.from, r.to);
    if (text) {
      // 已包裹 → 去掉
      const before = st.sliceDoc(Math.max(0, r.from - marker.length), r.from);
      const after = st.sliceDoc(r.to, Math.min(st.doc.length, r.to + marker.length));
      if (before === marker && after === marker) {
        changes.push({ from: r.from - marker.length, to: r.from, insert: '' });
        changes.push({ from: r.to, to: r.to + marker.length, insert: '' });
        shift -= marker.length * 2;
        continue;
      }
      changes.push({ from: r.from, insert: marker });
      changes.push({ from: r.to, insert: marker });
      shift += marker.length * 2;
    } else {
      const line = st.doc.lineAt(r.from);
      const m = new RegExp(`^(\\s*)((?:[-*+]|\\d+\\.)\\s+(?:\\[[ xX]\\]\\s+)?)?`);
      const mm = m.exec(line.text);
      const prefixLen = mm ? mm[0].length : 0;
      const body = line.text.slice(prefixLen);
      const len = marker.length;
      const hasOpen = body.startsWith(marker);
      const hasClose = body.endsWith(marker) && body.length > len;
      let newBody;
      if (hasOpen && hasClose) newBody = body.slice(len, -len);
      else newBody = marker + body + marker;
      changes.push({ from: line.from, to: line.to, insert: line.text.slice(0, prefixLen) + newBody });
    }
  }
  // 不显式传 selection：让 CM6 自动把当前选区映射过变更，避免长度变化后越界
  view.dispatch({ changes });
  view.focus();
}

function eachSelectedLine(view, fn) {
  const { state: st } = view;
  const a = st.doc.lineAt(st.selection.main.from).number;
  const b = st.doc.lineAt(st.selection.main.to).number;
  const chunks = [];
  for (let i = a; i <= b; i++) {
    const line = st.doc.line(i);
    chunks.push({ ...fn(line.text), from: line.from, to: line.to });
  }
  view.dispatch({ changes: chunks.map(c => ({ from: c.from, to: c.to, insert: c.insert })) });
  view.focus();
}

function toggleLinePrefix(view, re, make, { rewrite = null } = {}) {
  eachSelectedLine(view, (text) => {
    const m = re.exec(text);
    if (m) {
      const idx = text.indexOf(m[0]);
      // 已经是同一种前缀 → 取消；其他前缀 → 先清掉再套新的
      const stripped = text.slice(0, idx) + text.slice(idx + m[0].length);
      if (!rewrite) return { insert: stripped };
      return { insert: make(stripped) };
    }
    return { insert: make(text) };
  });
}

function runCmd(view, cmd) {
  const { state: st } = view;
  switch (cmd) {
    case 'bold': toggleInline(view, '**'); return true;
    case 'italic': toggleInline(view, '*'); return true;
    case 'strike': toggleInline(view, '~~'); return true;
    case 'mark': toggleInline(view, '=='); return true;
    case 'code': toggleInline(view, '`'); return true;
    case 'link': {
      const r = st.selection.main;
      const text = st.sliceDoc(r.from, r.to) || '链接文字';
      const insert = `[${text}](url)`;
      viewReplaceRange(view, r.from, r.to, insert, r.from + insert.length - 4, r.from + insert.length - 1);
      return true;
    }
    case 'ul': toggleLinePrefix(view, /^(\s*)[-*+]\s+/, (s) => `- ${s}`); return true;
    case 'ol': {
      let i = 0;
      eachSelectedLine(view, (text) => {
        i++;
        return { insert: `${i}. ${text.replace(/^(\s*)([-*+]|\d+\.)\s+/, '')}` };
      });
      return true;
    }
    case 'task': toggleLinePrefix(view, /^(\s*)[-*+]\s+\[[ xX]\]\s+/, (s) => `- [ ] ${s}`); return true;
    case 'quote': toggleLinePrefix(view, /^(\s*)>\s+/, (s) => `> ${s}`); return true;
    case 'h1': case 'h2': case 'h3': case 'h4': case 'p': {
      const mark = cmd === 'p' ? '' : '#'.repeat(Number(cmd[1])) + ' ';
      eachSelectedLine(view, (text) => ({ insert: mark + text.replace(/^\s{0,3}#{1,6}\s+/, '') }));
      return true;
    }
    case 'fence': {
      const r = st.selection.main;
      const sel = st.sliceDoc(r.from, r.to);
      const insert = sel ? `\`\`\`\n${sel}\n\`\`\`` : '```\n\n```';
      viewReplaceRange(view, r.from, r.to, insert, r.from + 4, r.from + 4);
      return true;
    }
    case 'hr': {
      const r = st.selection.main;
      const line = st.doc.lineAt(r.to);
      const insert = '\n\n---\n\n';
      viewReplaceRange(view, line.to, line.to, insert, line.to + insert.length);
      return true;
    }
    case 'table': {
      const r = st.selection.main;
      const line = st.doc.lineAt(r.to);
      const prefix = (line.text.trim() !== '' || line.to < st.doc.length) ? '\n\n' : '';
      const tpl = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |';
      const insert = prefix + tpl + '\n';
      const from = line.to;
      view.dispatch({
        changes: { from, to: from, insert },
        selection: { anchor: from + prefix.length + 2, head: from + prefix.length + 5 },
        scrollIntoView: true,
      });
      view.focus();
      return true;
    }
    default: return false;
  }
}

/* ============================================================
   Toast / 主题
   ============================================================ */
function toast(msg, { action, onAction } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${escapeHtml(msg)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-act';
    btn.textContent = action;
    btn.addEventListener('click', () => { onAction?.(); dismiss(); });
    el.appendChild(btn);
  }
  $('#toastWrap').appendChild(el);
  let timer = setTimeout(dismiss, 4500);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  function dismiss() {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }
}

function applyTheme(theme, { animate = false } = {}) {
  const root = document.documentElement;
  if (animate && theme !== root.dataset.theme) {
    root.classList.add('theme-fade');
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => root.classList.remove('theme-fade'), 600);
  }
  root.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* noop */ }
}

/* ============================================================
   设置面板 / 同步
   ============================================================ */
function openSettings() { $('#settingsModal').hidden = false; renderBackendStatus(); fillConfigForm(); }
function closeSettings() { $('#settingsModal').hidden = true; }

async function renderBackendStatus() {
  const el = $('#backendStatus');
  el.classList.remove('on');
  el.innerHTML = '<b>正在连接后端…</b>';
  const on = await Backend.health();
  refreshCloudDot();
  el.classList.toggle('on', on);
  el.innerHTML = on
    ? (Backend.syncConfigured ? '<b>后端已连接</b>· 云端同步已配置，保存即上传'
      : '<b>后端已连接</b>· 数据写入本机存档（配置云端同步后才会上传）')
    : '<b>后端未连接</b>· 请先启动 server.js，当前数据仅在浏览器本地';
}

let syncType = 's3';
function setSyncType(type) {
  syncType = type === 'webdav' ? 'webdav' : 's3';
  $$('#syncType .sync-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === syncType));
  $('#cfgS3').hidden = syncType !== 's3';
  $('#cfgWebdav').hidden = syncType !== 'webdav';
}

async function fillConfigForm() {
  const c = await Backend.getConfig();
  setSyncType(c?.type || 's3');
  $('#cfgEndpoint').value = c?.s3?.endpoint || '';
  $('#cfgRegion').value = c?.s3?.region || '';
  $('#cfgBucket').value = c?.s3?.bucket || '';
  $('#cfgAccessKey').value = c?.s3?.accessKeyId || '';
  $('#cfgSecret').value = c?.s3?.secretAccessKey || '';
  $('#cfgObject').value = c?.s3?.objectKey || '';
  $('#cfgWdEndpoint').value = c?.webdav?.endpoint || '';
  $('#cfgWdUser').value = c?.webdav?.username || '';
  $('#cfgWdPass').value = c?.webdav?.password || '';
  $('#cfgWdPath').value = c?.webdav?.remotePath || '';
  $('#cfgAutoSync').checked = !!(c && c.autoSync);
  $('#cfgAutoPull').checked = state.settings.autoPull !== false;
}

function configFromForm() {
  return {
    type: syncType,
    autoSync: $('#cfgAutoSync').checked,
    s3: {
      endpoint: $('#cfgEndpoint').value.trim(),
      region: $('#cfgRegion').value.trim(),
      bucket: $('#cfgBucket').value.trim(),
      accessKeyId: $('#cfgAccessKey').value.trim(),
      secretAccessKey: $('#cfgSecret').value,
      objectKey: $('#cfgObject').value.trim() || 'notes.json',
    },
    webdav: {
      endpoint: $('#cfgWdEndpoint').value.trim(),
      username: $('#cfgWdUser').value.trim(),
      password: $('#cfgWdPass').value,
      remotePath: $('#cfgWdPath').value.trim() || '/notes.json',
    },
  };
}

async function saveConfigFromForm() {
  const r = await Backend.saveConfig(configFromForm());
  toast(r.ok ? '同步配置已保存' : `保存失败：${r.error || '未知错误'}`);
  await Backend.health();
  refreshCloudDot();
  setStatus('saved');
  renderSideFoot();
  if (r.ok) await testConnection();
}

async function testConnection() {
  const el = $('#cfgTestResult');
  el.hidden = false;
  el.className = 'test-result';
  el.textContent = '正在测试连接…';
  const r = await Backend.test();
  el.classList.add(r.ok ? 'ok' : 'err');
  el.textContent = r.ok ? ('✓ ' + (r.message || '连接成功')) : ('✗ ' + (r.error || '未知错误'));
}

async function pushCloud() {
  const r = await Backend.push();
  if (r.ok) { toast('已推送到云端'); setStatus('cloud'); }
  else toast(`推送失败：${r.error || '未知错误'}`);
}

/* ---------------- 多端合并 ---------------- */
function mergeCollection(localArr, remoteArr, tombs, kind) {
  const map = new Map(localArr.map(x => [x.id, x]));
  let changed = 0;
  for (const r of (remoteArr || [])) {
    const l = map.get(r.id);
    if (!l) { map.set(r.id, r); changed++; }
    else if ((r.updatedAt || 0) > (l.updatedAt || 0)) { map.set(r.id, r); changed++; }
  }
  for (const [id, t] of tombs) {
    if (t.kind !== kind) continue;
    const x = map.get(id);
    if (x && (x.updatedAt || 0) <= (t.deletedAt || 0)) { map.delete(id); changed++; }
  }
  return { arr: [...map.values()], changed };
}

function mergeArchives(local, remote) {
  const tombs = new Map();
  for (const t of [...(local.deleted || []), ...(remote.deleted || [])]) {
    const cur = tombs.get(t.id);
    const tt = { ...t, kind: t.kind || 'note' };
    if (!cur || (tt.deletedAt || 0) >= (cur.deletedAt || 0)) tombs.set(t.id, tt);
  }
  const n = mergeCollection(local.notes, remote.notes, tombs, 'note');
  const k = mergeCollection(local.tasks, remote.tasks, tombs, 'task');
  const c = mergeCollection(local.lists, remote.lists, new Map(), 'list');

  const settings = (remote.savedAt || 0) > (local.savedAt || 0)
    ? { ...local.settings, ...(remote.settings || {}) }
    : { ...remote.settings, ...local.settings };

  return {
    notes: n.arr, tasks: k.arr, lists: c.arr,
    deleted: [...tombs.values()], settings,
    changed: n.changed + k.changed + c.changed,
  };
}

function applySettings(s) {
  if (!s) return;
  if (s.theme && s.theme !== document.documentElement.dataset.theme) applyTheme(s.theme, { animate: true });
  if (s.sort && s.sort !== state.sort) { state.sort = s.sort; $('#sortSelect').value = s.sort; }
  if (typeof s.sidebarCollapsed === 'boolean') {
    document.body.classList.toggle('sidebar-collapsed', s.sidebarCollapsed);
    try { localStorage.setItem(SIDEBAR_KEY, s.sidebarCollapsed ? '1' : '0'); } catch { /* noop */ }
  }
}

function applyArchive(pkg) {
  const m = migrate(pkg);
  state.notes = m.notes;
  state.tasks = m.tasks;
  state.lists = m.lists;
  state.deleted = m.deleted;
}

function restoreSelection() {
  if (state.mode === 'tasks') {
    const keep = state.selectedTaskId && state.tasks.some(t => t.id === state.selectedTaskId);
    if (!keep) {
      state.selectedTaskId = visibleTasks()[0]?.id || null;
      renderSidebar();
      if (state.selectedTaskId) renderTaskDetail(); else showEmpty();
    } else renderTaskDetail();
  } else {
    const keep = state.selectedId && state.notes.some(n => n.id === state.selectedId);
    if (!keep) {
      state.selectedId = visibleNotes()[0]?.id || null;
      renderSidebar();
      if (state.selectedId) renderEditor(); else showEmpty();
    } else renderEditor();
  }
}

async function pullCloud() {
  const r = await Backend.remoteArchive();
  if (!r.ok) { toast(`拉取失败：${r.error || '未知错误'}`); return; }
  const merged = mergeArchives(currentArchive(), r.archive);
  state.notes = merged.notes; state.tasks = merged.tasks; state.lists = merged.lists;
  state.deleted = merged.deleted; state.settings = merged.settings;
  applySettings(state.settings);
  persist();
  renderTags();
  restoreSelection();
  toast(merged.changed ? `已与云端合并：${merged.changed} 处更新` : '本地与云端已是一致');
}

const PULL_INTERVAL_MS = Math.max(5, Number(new URLSearchParams(location.search).get('pullSec')) * 1000 || 60000);
let autoPullTimer = null;
function startAutoPull() {
  clearInterval(autoPullTimer);
  if (!state.settings.autoPull || !Backend.online || !Backend.syncConfigured) return;
  autoPullTimer = setInterval(autoPullTick, PULL_INTERVAL_MS);
}

async function autoPullTick() {
  if (!Backend.online || !state.settings.autoPull || !Backend.syncConfigured) return;
  try {
    const r = await Backend.remoteArchive();
    if (!r.ok) return;
    const merged = mergeArchives(currentArchive(), r.archive);
    if (!merged.changed) return;
    state.notes = merged.notes; state.tasks = merged.tasks; state.lists = merged.lists;
    state.deleted = merged.deleted; state.settings = merged.settings;
    applySettings(state.settings);
    persist();
    renderTags();
    restoreSelection();
  } catch (e) { console.warn('autoPullTick 失败：', e); }
}

/* ============================================================
   移动端侧栏
   ============================================================ */
function openMobileSidebar() {
  $('#sidebar').classList.add('open');
  const scrim = $('#scrim');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('show'));
}
function closeMobileSidebar() {
  $('#sidebar').classList.remove('open');
  const scrim = $('#scrim');
  scrim.classList.remove('show');
  setTimeout(() => { if (!scrim.classList.contains('show')) scrim.hidden = true; }, 320);
}

/* ============================================================
   导出
   ============================================================ */
function exportMarkdown() {
  const n = selectedNote();
  if (!n) return;
  const lines = [];
  const title = displayTitle(n);
  if (title) lines.push(`# ${title}\n`);
  if (n.tags.length) lines.push(n.tags.map(t => `\`#${t}\``).join(' ') + '\n');
  lines.push(n.content.trim() + '\n');
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(title || '无题笔记').replace(/[\\/:*?"<>|]/g, '_')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出为 Markdown 📄');
}

/* ============================================================
   HTML → Markdown（旧存档迁移用）
   ============================================================ */
function htmlToMd(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  return convertChildren(root).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim() + '\n';
}
function convertChildren(node) { return [...node.childNodes].map(convertNode).join(''); }
function convertNode(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return '';
  const el = node;
  const inner = () => convertChildren(el);
  switch (el.tagName) {
    case 'H1': return `\n# ${inner().trim()}\n\n`;
    case 'H2': return `\n## ${inner().trim()}\n\n`;
    case 'H3': return `\n### ${inner().trim()}\n\n`;
    case 'H4': case 'H5': case 'H6': return `\n#### ${inner().trim()}\n\n`;
    case 'B': case 'STRONG': { const t = inner().trim(); return t ? `**${t}**` : ''; }
    case 'I': case 'EM': { const t = inner().trim(); return t ? `*${t}*` : ''; }
    case 'S': case 'STRIKE': case 'DEL': { const t = inner().trim(); return t ? `~~${t}~~` : ''; }
    case 'MARK': { const t = inner().trim(); return t ? `==${t}==` : t; }
    case 'U': return inner();
    case 'CODE': { const t = inner(); return t.includes('`') ? t : `\`${t}\``; }
    case 'PRE': return `\n\`\`\`\n${el.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
    case 'BLOCKQUOTE': return '\n' + inner().trim().split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    case 'UL': case 'OL': return '\n' + listMd(el, el.tagName === 'OL') + '\n';
    case 'HR': return '\n---\n\n';
    case 'BR': return '\n';
    case 'A': return `[${inner().trim()}](${el.getAttribute('href') || ''})`;
    case 'DIV': case 'P': return `\n${inner().trim()}\n\n`;
    default: return inner();
  }
}
function listMd(listEl, ordered) {
  let i = 1;
  const out = [];
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    let text = convertChildren(li);
    if (listEl.classList.contains('checklist')) {
      const t = (li.querySelector('.text') || li).textContent.trim();
      out.push(`- [${li.dataset.checked === 'true' ? 'x' : ' '}] ${t}`);
      continue;
    }
    if (li.classList.contains('checklist') || li.querySelector('.tick')) continue;
    text = text.replace(/\n+/g, ' ').trim();
    out.push(ordered ? `${i++}. ${text}` : `- ${text}`);
  }
  return out.join('\n');
}

/* ============================================================
   事件绑定
   ============================================================ */
function toggleNewPop(show) {
  const pop = $('#newPop');
  const open = show === undefined ? pop.hidden : show;
  pop.hidden = !open;
  $('#newBtn').setAttribute('aria-expanded', String(open));
}

function bindEvents() {
  /* 新建下拉 */
  $('#newBtn').addEventListener('click', e => { e.stopPropagation(); toggleNewPop(); });
  $('#newPop').addEventListener('click', e => {
    const b = e.target.closest('[data-new]');
    if (!b) return;
    toggleNewPop(false);
    if (b.dataset.new === 'note') createNote();
    else if (b.dataset.new === 'task') createTask();
    else createList();
  });
  document.addEventListener('click', e => {
    if (!$('#newPop').hidden && !e.target.closest('#newMenu')) toggleNewPop(false);
  });

  $('#menuBtn').addEventListener('click', openMobileSidebar);
  $('#scrim').addEventListener('click', closeMobileSidebar);
  $('#backBtn').addEventListener('click', () => { state.selectedId = null; renderSidebar(); showEmpty(); openMobileSidebar(); });
  $('#taskBackBtn').addEventListener('click', () => { state.selectedTaskId = null; renderSidebar(); showEmpty(); openMobileSidebar(); });

  $('#collapseBtn').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    state.settings.sidebarCollapsed = collapsed;
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch { /* noop */ }
    persist();
  });

  /* 模式切换 */
  $('#modeSwitch').addEventListener('click', e => {
    const b = e.target.closest('.mode-btn');
    if (!b) return;
    state.mode = b.dataset.mode;
    renderSidebar();
    if (state.mode === 'tasks') {
      if (state.selectedTaskId) renderTaskDetail();
      else showEmpty();
    } else {
      if (state.selectedId) renderEditor();
      else showEmpty();
    }
  });

  /* 设置面板 */
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeSettings(); });
  $('#syncType').addEventListener('click', e => {
    const btn = e.target.closest('.sync-type-btn');
    if (btn) setSyncType(btn.dataset.type);
  });
  $('#cfgSave').addEventListener('click', saveConfigFromForm);
  $('#cfgTest').addEventListener('click', testConnection);
  $('#cfgAutoPull').addEventListener('change', e => {
    state.settings.autoPull = e.target.checked;
    persist();
    startAutoPull();
    toast(e.target.checked ? '已开启自动多端同步' : '已关闭自动多端同步');
  });
  $('#cfgPush').addEventListener('click', pushCloud);
  $('#cfgPull').addEventListener('click', pullCloud);

  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, { animate: true });
    state.settings.theme = next;
    persist();
  });

  const search = $('#searchInput');
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    renderSidebar(true);
    if (state.mode === 'tasks' && state.selectedTaskId && !visibleTasks().some(t => t.id === state.selectedTaskId)) {
      state.selectedTaskId = null; showEmpty();
    }
  });

  $('#sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    state.settings.sort = e.target.value;
    persist();
    renderNoteList(true);
  });

  $('#filters').addEventListener('click', e => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    state.filter = { kind: btn.dataset.filter, tag: null };
    syncFilterButtons();
    renderNoteList(true);
  });

  $('#taskFilters').addEventListener('click', e => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    state.tfilter = btn.dataset.tfilter;
    renderTaskPanel(true);
    if (state.selectedTaskId && !visibleTasks().some(t => t.id === state.selectedTaskId)) {
      state.selectedTaskId = null; showEmpty();
    }
  });

  $('#tagBar').addEventListener('click', e => {
    const clear = e.target.closest('[data-clear]');
    const chip = e.target.closest('[data-tag]');
    if (clear) state.filter = { kind: 'all', tag: null };
    else if (chip) {
      const t = chip.dataset.tag;
      const on = state.filter.kind === 'tag' && state.filter.tag === t;
      state.filter = on ? { kind: 'all', tag: null } : { kind: 'tag', tag: t };
    } else return;
    syncFilterButtons();
    renderTags();
    renderNoteList(true);
  });

  /* 笔记列表 */
  $('#noteList').addEventListener('click', e => {
    const del = e.target.closest('.ni-del');
    if (del) { deleteNote(del.closest('.note-item').dataset.id); return; }
    const item = e.target.closest('.note-item');
    if (item) selectNote(item.dataset.id);
  });

  /* 任务面板 */
  $('#taskLists').addEventListener('click', e => {
    const head = e.target.closest('.tk-group-head');
    const group = e.target.closest('.tk-group');

    if (head) {
      const act = e.target.closest('.tk-op')?.dataset.act;
      if (act === 'add') { state.activeListId = group.dataset.list === '__notes' ? INBOX : group.dataset.list; createTask({ listId: state.activeListId }); return; }
      if (act === 'rename' && group.dataset.list !== '__notes') { startRenameList(group.dataset.list, head.querySelector('.tk-name')); return; }
      if (act === 'del' && group.dataset.list !== '__notes') { deleteList(group.dataset.list); return; }
      if (e.target.closest('.tk-rename')) return;    // 正在重命名时不折叠
      if (e.target.closest('.tk-dot')) {
        const li = state.lists.find(x => x.id === group.dataset.list);
        if (li) { li.color = (li.color + 1) % LIST_COLORS.length; persist(); renderTaskPanel(); }
        return;
      }
      // 折叠 / 展开
      if (group.dataset.list === '__notes') {
        state.settings.todosCollapsed = !group.classList.contains('collapsed');
      } else {
        const li = state.lists.find(x => x.id === group.dataset.list);
        if (li) li.collapsed = !group.classList.contains('collapsed');
      }
      persist();
      group.classList.toggle('collapsed');
      return;
    }

    const aggNote = e.target.closest('.tk-aggnote');
    if (aggNote) {
      state.mode = 'notes';
      selectNote(aggNote.dataset.note);
      return;
    }

    const aggItem = e.target.closest('.tk-item.agg');
    if (aggItem) {
      if (e.target.closest('.tk-check')) {
        toggleNoteTodo(aggItem.dataset.notetodo, Number(aggItem.dataset.idx));
      } else {
        state.mode = 'notes';
        selectNote(aggItem.dataset.notetodo);
      }
      return;
    }

    const item = e.target.closest('.tk-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.tk-check')) { toggleTaskDone(id); return; }
    if (e.target.closest('.tk-star')) {
      const t = task(id); if (t) { t.starred = !t.starred; t.updatedAt = Date.now(); persist(); renderTaskPanel(); }
      return;
    }
    selectTask(id);
  });

  $('#taskLists').addEventListener('keydown', e => {
    if (e.target.id === 'tkQuick' && e.key === 'Enter') {
      const v = e.target.value.trim();
      if (!v) return;
      const groupPath = e.target.closest('.tk-group');
      e.target.value = '';
      createTask({ title: v, listId: groupPath && groupPath.dataset.list !== '__notes' ? groupPath.dataset.list : (state.activeListId || INBOX) });
    }
  });

  /* 编辑器：标题 */
  $('#titleInput').addEventListener('input', () => {
    const n = selectedNote();
    if (!n) return;
    n.title = $('#titleInput').value;
    n.manualTitle = true;
    n.updatedAt = Date.now();
    scheduleSave();
    clearTimeout(listTimer);
    listTimer = setTimeout(() => { renderNoteList(); renderSideFoot(); }, 400);
  });

  /* 工具栏 */
  $$('#noteToolbar, #taskToolbar').forEach(bar => {
    bar.addEventListener('mousedown', e => e.preventDefault());
    bar.addEventListener('click', e => {
      const btn = e.target.closest('.tool');
      if (!btn) return;
      const view = bar.id === 'taskToolbar' ? taskView : noteView;
      const cmd = btn.dataset.cmd || btn.dataset.block;
      if (cmd === 'undo') { CM.undo(view); view.focus(); return; }
      if (cmd === 'redo') { CM.redo(view); view.focus(); return; }
      if (cmd === 'clear') { clearFormat(view); return; }
      runCmd(view, cmd);
    });
  });

  /* 任务详情 */
  $('#taskDone').addEventListener('click', () => selectedTask() && toggleTaskDone(selectedTask().id));
  $('#taskTitle').addEventListener('input', e => updateTask({ title: e.target.value }));
  $('#taskStarBtn').addEventListener('click', () => {
    const t = selectedTask(); if (!t) return;
    updateTask({ starred: !t.starred });
    $('#taskStarBtn').classList.toggle('on', t.starred);
  });
  /* 截止日期用原生 <input type="date"> 直接暴露给用户。
     两个事件都要接：方向键 / 日历里点选只派发 input，敲完整日期才派发 change；
     只监听 change 会让「改了值但没提交」变成静默故障。 */
  $('#taskDue').addEventListener('input', e => {
    updateTask({ due: e.target.value }, { rerender: false });
    syncDueText(e.target.value);
  });
  $('#taskDue').addEventListener('change', e => {
    updateTask({ due: e.target.value }, { rerender: false });
    syncDueText(e.target.value);
  });
  /* 清除截止日：原生 date input 没有「退格即清空」，必须给显式出口 */
  $('#taskDueClear').addEventListener('click', () => {
    $('#taskDue').value = '';
    updateTask({ due: '' }, { rerender: false });
    syncDueText('');
  });
  /* 点日期控件的任意位置都唤起原生日历。
     原因：Edge 里 date input 的日历图标横跨整个控件宽度，点击会落到这个
     inline-block 覆盖层上、而不是「日期段」上；此时方向键被丢弃、直接敲数字也不进值
     （裸控件同样如此，属原生行为）。用户只会觉得「这个输入框点进去没法用」。
     主动 showPicker() 把日历打开，用户就能在日历里正常选日期——这是最省事也最符合
     直觉的入口。必须放在 click 里同步调用，showPicker 需要用户手势上下文。 */
  $('#taskDue').addEventListener('click', e => {
    if (e.target.dataset.picking === '1') return;   // 日历已开着，别反复弹
    e.target.dataset.picking = '1';
    setTimeout(() => { delete e.target.dataset.picking; }, 400);
    try { e.target.showPicker(); } catch { /* 非安全上下文或浏览器不支持，静默降级 */ }
  });
  $('#taskPriority').addEventListener('change', e => updateTask({ priority: Number(e.target.value) }));
  $('#taskListSel').addEventListener('change', e => {
    updateTask({ listId: e.target.value });
    renderTaskDetail();
  });
  $('#taskDelBtn').addEventListener('click', () => state.selectedTaskId && deleteTask(state.selectedTaskId));

  /* 标签 */
  $('#tagInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.value.trim()) { addTag(e.target.value); e.target.value = ''; }
  });
  $('#tagChips').addEventListener('click', e => {
    const x = e.target.closest('.x');
    if (x) removeTag(x.dataset.tag);
  });

  /* 编辑器动作 */
  $('#pinBtn').addEventListener('click', () => toggleFlag('pinned'));
  $('#favBtn').addEventListener('click', () => toggleFlag('favorite'));
  $('#exportBtn').addEventListener('click', exportMarkdown);
  $('#deleteBtn').addEventListener('click', () => state.selectedId && deleteNote(state.selectedId));

  /* 快捷键 */
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#searchInput').focus();
      $('#searchInput').select();
    } else if (mod && e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault(); createNote();
    } else if (mod && e.altKey && e.key.toLowerCase() === 't') {
      e.preventDefault(); createTask();
    } else if (mod && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault(); persist(); toast('已保存');
    } else if (e.key === 'Escape') {
      if (!$('#settingsModal').hidden) { closeSettings(); return; }
      if (!$('#newPop').hidden) { toggleNewPop(false); return; }
      if (document.activeElement === $('#searchInput')) {
        $('#searchInput').value = ''; state.query = '';
        renderSidebar(); $('#searchInput').blur();
      }
    }
  });

  window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); persist({ cloud: false }); });
}

function clearFormat(view) {
  const { state: st } = view;
  const changes = [];
  for (const r of st.selection.ranges) {
    const text = st.sliceDoc(r.from, r.to);
    changes.push({ from: r.from, to: r.to, insert: text.replace(/(\*\*|__|\*|_|~~|==|`)/g, '') });
  }
  if (changes.length) view.dispatch({ changes });
}

function syncFilterButtons() {
  $$('#filters .filter').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter.kind));
}

function toggleFlag(field) {
  const n = selectedNote();
  if (!n) return;
  n[field] = !n[field];
  n.updatedAt = Date.now();
  persist();
  renderMeta(n);
  renderNoteList();
}

function addTag(raw) {
  const n = selectedNote();
  const t = raw.trim().replace(/^#/, '').slice(0, 12);
  if (!n || !t) return;
  if (n.tags.some(x => x.toLowerCase() === t.toLowerCase())) return;
  n.tags.push(t);
  n.updatedAt = Date.now();
  persist();
  renderMeta(n);
  renderTags();
  renderNoteList();
}

function removeTag(tag) {
  const n = selectedNote();
  if (!n) return;
  n.tags = n.tags.filter(t => t !== tag);
  if (state.filter.kind === 'tag' && state.filter.tag === tag && !n.tags.includes(tag)) {
    state.filter = { kind: 'all', tag: null };
    syncFilterButtons();
  }
  n.updatedAt = Date.now();
  persist();
  renderMeta(n);
  renderTags();
  renderNoteList();
}

/* ============================================================
   启动
   ============================================================ */
async function init() {
  let theme = 'light';
  try {
    theme = readPref(THEME_KEY) ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch { /* noop */ }
  const themeParam = new URLSearchParams(location.search).get('theme');
  if (themeParam === 'dark' || themeParam === 'light') theme = themeParam;

  const saved = load();
  const initial = saved ? migrate(saved) : seed();
  state.notes = initial.notes;
  state.tasks = initial.tasks;
  state.lists = initial.lists;
  state.deleted = saved ? (saved.deleted || []).map(t => ({ ...t, kind: t.kind || 'note' })) : [];

  if (saved && saved.settings) state.settings = { ...state.settings, ...saved.settings };
  state.savedAt = (saved && saved.savedAt) || 0;
  if (themeParam) state.settings.theme = themeParam;
  /* 「本地偏好 > 存档默认值」的优先级。
     存档里带了 settings.theme 时它只是「存档时刻的快照」，
     而 localStorage 里的是「本机此刻的选择」——一台机器上用户刚切了深色，
     不能因为云端 / 后端的旧存档又给切回去。所以仅在存档没给值时才回落到本地偏好。 */
  if (!saved || !saved.settings || !saved.settings.theme) state.settings.theme = theme;
  if (state.settings.sort) state.sort = state.settings.sort;
  applyTheme(state.settings.theme);

  try {
    if (state.settings.sidebarCollapsed || readPref(SIDEBAR_KEY) === '1') document.body.classList.add('sidebar-collapsed');
  } catch { /* noop */ }
  if (state.settings.sort) $('#sortSelect').value = state.settings.sort;

  ensureViews();
  bindEvents();
  renderTags();
  syncFilterButtons();
  renderSidebar(true);
  const first = visibleNotes()[0];
  if (first) selectNote(first.id); else showEmpty();

  const online = await Backend.health();
  refreshCloudDot();
  if (online) {
    const pkg = await Backend.getArchive();
    if (pkg && Array.isArray(pkg.notes) && (pkg.notes.length || (pkg.tasks || []).length)) {
      const m = migrate(pkg);
      state.notes = m.notes; state.tasks = m.tasks; state.lists = m.lists;
      if (pkg.settings) { state.settings = { ...state.settings, ...pkg.settings }; applySettings(state.settings); }
      state.deleted = m.deleted;
      persist({ cloud: false });
      renderTags();
      restoreSelection();
    } else if (state.notes.length || state.tasks.length) {
      scheduleCloudSave();
    }
    if (state.settings.autoPull !== false && Backend.syncConfigured) {
      autoPullTick();
      startAutoPull();
    }
  }
  setStatus('saved');
  updateTaskBadge();
}

function updateTaskBadge() {
  const n = state.tasks.filter(t => !t.done).length;
  $('#taskBadge').textContent = n ? String(n) : '';
  $('#taskBadge').hidden = !n;
}

init();
