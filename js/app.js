/* ============================================================
   素笺 · 简洁云端笔记
   应用逻辑：笔记增删改查 / 搜索 / 标签 / 主题 / 富文本编辑
   ============================================================ */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const STORAGE_KEY = 'sujian-notes-v1';
const LEGACY_KEY = 'liulin-notes-v1';   // 旧版（琉璃笔记）数据键，用于迁移
const THEME_KEY = 'sujian-theme';
const SIDEBAR_KEY = 'sujian-sidebar-collapsed';

const state = {
  notes: [],
  selectedId: null,
  filter: { kind: 'all', tag: null },   // all | fav | pinned | tag
  query: '',
  sort: 'updated',
  // 随存档多端同步的偏好与删除记录（墓碑）
  settings: { theme: 'light', sidebarCollapsed: false, autoPull: true },
  deleted: [],          // [{ id, deletedAt }]
  savedAt: 0,           // 本地存档最后保存时间，合并时比较新旧
};

let saveTimer = null;
let listTimer = null;
let cloudTimer = null;

/* ---------------- 后端 API ---------------- */
const Backend = {
  online: false,
  async health() {
    try { const r = await fetch('/api/health', { cache: 'no-store' }); this.online = r.ok; }
    catch { this.online = false; }
    return this.online;
  },
  async getNotes() {
    try {
      const r = await fetch('/api/notes', { cache: 'no-store' });
      this.online = r.ok;
      if (!r.ok) return null;
      return await r.json();   // { notes, settings, deleted, savedAt }
    } catch { this.online = false; return null; }
  },
  async saveNotes(archive) {
    try {
      const r = await fetch('/api/notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(archive),   // 完整存档：notes + settings + deleted
      });
      this.online = r.ok;
      return r.ok;
    } catch { this.online = false; return false; }
  },
  async getConfig() {
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()).config;
    } catch { return null; }
  },
  async saveConfig(cfg) {
    try {
      const r = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok && d.ok, error: d.error };
    } catch { return { ok: false, error: '无法连接后端' }; }
  },
  async test() {
    try {
      const r = await fetch('/api/config/test', { method: 'POST' });
      return await r.json();
    } catch { return { ok: false, error: '无法连接后端' }; }
  },
  async remoteArchive() {
    try {
      const r = await fetch('/api/sync/remote', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok && d.ok, archive: d.archive, error: d.error };
    } catch { return { ok: false, error: '无法连接后端' }; }
  },
  async push() {
    try {
      const r = await fetch('/api/sync/push', { method: 'POST' });
      return await r.json();
    } catch { return { ok: false, error: '无法连接后端' }; }
  },
  async pull() {
    try {
      const r = await fetch('/api/sync/pull', { method: 'POST' });
      return { status: r.status, data: await r.json() };
    } catch { return { status: 0, data: { ok: false, error: '无法连接后端' } }; }
  },
};

function refreshCloudDot() {
  const dot = $('#cloudDot');
  if (!dot) return;
  dot.dataset.state = Backend.online ? 'on' : 'off';
  dot.title = Backend.online ? '后端已连接，笔记保存在服务器' : '后端未连接，笔记仅保存在浏览器本地';
}

/* ---------------- 工具 ---------------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function htmlToText(html) {
  const t = document.createElement('div');
  t.innerHTML = html || '';
  return t.textContent.replace(/\s+/g, ' ').trim();
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

/* ---------------- 存储 ---------------- */
function load() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) raw = localStorage.getItem(LEGACY_KEY);   // 迁移旧版（琉璃笔记）数据
    if (raw) {
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.notes)) {
        return {
          notes: data.notes,
          settings: data.settings || null,
          deleted: data.deleted || [],
          savedAt: data.savedAt || 0,
        };
      }
    }
  } catch (e) { /* 数据损坏时重新播种 */ }
  return null;
}

/* 当前完整存档（笔记 + 偏好 + 删除墓碑） */
function currentArchive() {
  return { notes: state.notes, settings: state.settings, deleted: state.deleted, savedAt: Date.now() };
}

function persist({ cloud = true } = {}) {
  try {
    const pkg = currentArchive();
    state.savedAt = pkg.savedAt;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pkg));
  } catch (e) { /* 存储已满等情况静默失败 */ }
  if (cloud) scheduleCloudSave();
}

function scheduleCloudSave() {
  if (!Backend.online) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(async () => {
    const ok = await Backend.saveNotes(currentArchive());
    setStatus(ok ? 'saved' : 'local');
    refreshCloudDot();
  }, 900);
}

/* ---------------- 示例数据 ---------------- */
function seedNotes() {
  const now = Date.now(), H = 36e5, D = 864e5;
  return [
    {
      id: uid(), title: '欢迎使用素笺 ✨', tags: ['指南'], pinned: true, favorite: true,
      createdAt: now - 2 * H, updatedAt: now - 2 * H,
      content: [
        '<h1>你好，欢迎来到素笺</h1>',
        '<p>这是一款 <b>简洁风格</b> 的云端笔记应用：本地自动保存，也可同步到自己的 S3 存储。</p>',
        '<h2>你可以这样使用它</h2>',
        '<ul><li>点击右上角 <b>＋ 新建笔记</b>，即刻开始书写</li><li>用顶部 <mark>搜索框</mark> 全文检索（快捷键 <code>Ctrl K</code>）</li><li>给笔记打上 <b>标签</b>、<b>置顶</b> 或 <b>收藏</b></li><li>右上角按钮一键切换 <b>明暗主题</b>，左侧按钮收起列表</li></ul>',
        '<h2>试试待办清单</h2>',
        '<ul class="checklist"><li data-checked="true"><span class="tick" contenteditable="false"></span><span class="text">体验基本书写功能</span></li><li data-checked="false"><span class="tick" contenteditable="false"></span><span class="text">写下第一篇笔记</span></li><li data-checked="false"><span class="tick" contenteditable="false"></span><span class="text">在设置里配置 S3 同步</span></li></ul>',
        '<blockquote><p>启动 <code>node server.js</code> 后，笔记自动保存到服务器；在「设置」中填入 S3 配置，即可推送到云端或从云端拉取最新存档。</p></blockquote>',
      ].join(''),
    },
    {
      id: uid(), title: 'S3 同步小贴士', tags: ['指南'], pinned: false, favorite: false,
      createdAt: now - 1 * D, updatedAt: now - 10 * H,
      content: [
        '<h2>把笔记存到你自己的桶里</h2>',
        '<p>打开右上角 <b>设置</b>，填入 S3 配置即可：</p>',
        '<ul><li><b>Endpoint</b>：如 <code>https://s3.us-east-1.amazonaws.com</code>，R2 / MinIO 填对应端点</li><li><b>Region / Bucket / 密钥</b>：从云服务商控制台获取</li><li>开启 <b>自动同步</b> 后，每次保存都会自动上传存档</li></ul>',
        '<blockquote><p>「从云端拉取」会用云端存档覆盖本地，适合多设备间切换。</p></blockquote>',
        '<p>数据链路：<b>浏览器</b> → <code>node server.js</code>（本地 <code>data/notes.json</code>）→ <b>你的 S3 桶</b>。</p>',
      ].join(''),
    },
    {
      id: uid(), title: '今日待办', tags: ['生活'], pinned: false, favorite: false,
      createdAt: now - 5 * H, updatedAt: now - 4 * H,
      content: [
        '<p>今天想完成的三件小事：</p>',
        '<ul class="checklist"><li data-checked="false"><span class="tick" contenteditable="false"></span><span class="text">晨跑 30 分钟</span></li><li data-checked="false"><span class="tick" contenteditable="false"></span><span class="text">读完《设计中的设计》第二章</span></li><li data-checked="false"><span class="tick" contenteditable="false"></span><span class="text">给素笺提一个新点子 ✍️</span></li></ul>',
        '<p><i>细水长流，日拱一卒。</i></p>',
      ].join(''),
    },
    {
      id: uid(), title: '阅读摘抄', tags: ['阅读'], pinned: false, favorite: true,
      createdAt: now - 3 * D, updatedAt: now - 2 * D,
      content: [
        '<h2>本周摘抄</h2>',
        '<blockquote><p>我们塑造了工具，此后工具塑造我们。</p></blockquote>',
        '<p>—— 麦克卢汉</p>',
        '<blockquote><p>简单比复杂更难，你必须努力让你的想法变得清晰明了。</p></blockquote>',
        '<p>—— Steve Jobs</p>',
        '<hr><p>聚沙成塔，集腋成裘。</p>',
      ].join(''),
    },
  ];
}

/* ---------------- 数据筛选 ---------------- */
function visibleNotes() {
  let arr = [...state.notes];
  const f = state.filter;
  if (f.kind === 'fav') arr = arr.filter(n => n.favorite);
  else if (f.kind === 'pinned') arr = arr.filter(n => n.pinned);
  else if (f.kind === 'tag') arr = arr.filter(n => n.tags.includes(f.tag));

  if (state.query) {
    const q = state.query.toLowerCase();
    arr = arr.filter(n =>
      (n.title || '').toLowerCase().includes(q) || htmlToText(n.content).toLowerCase().includes(q));
  }

  arr.sort((a, b) => {
    if (state.sort === 'title') return (a.title || '无题').localeCompare(b.title || '无题', 'zh');
    if (state.sort === 'created') return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });
  arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return arr;
}

const selectedNote = () => state.notes.find(n => n.id === state.selectedId) || null;

/* ---------------- 渲染：侧栏 ---------------- */
const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M12 16.5V21"/><path d="M8.4 3.5h7.2l-.9 6.3 3.3 3.2v1.5H6v-1.5l3.3-3.2-.9-6.3z"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24"><path d="m12 3.8 2.4 5 5.5.8-4 3.9.9 5.5-4.8-2.6-4.8 2.6.9-5.5-4-3.9 5.5-.8 2.4-5z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M4.5 6.5h15"/><path d="M9.5 6.5v-2h5v2"/><path d="M6.5 6.5 7.4 20.5h9.2l.9-14"/></svg>';

function renderList(animate = false) {
  const listEl = $('#noteList');
  const arr = visibleNotes();
  listEl.classList.toggle('no-anim', !animate);

  let html;
  if (!arr.length) {
    html = `<div class="list-empty">${state.query ? '没有找到匹配的笔记 🔍' : '这里空空如也，新建一篇吧'}</div>`;
  } else {
    html = arr.map((n, i) => {
      const snippet = htmlToText(n.content) || '（暂无内容）';
      const flags =
        (n.pinned ? `<span class="ni-flag pin" title="已置顶">${ICON_PIN}</span>` : '') +
        (n.favorite ? `<span class="ni-flag star" title="已收藏">${ICON_STAR}</span>` : '');
      const tags = n.tags.map(t => `<span class="ni-tag">#${escapeHtml(t)}</span>`).join('');
      return `
      <div class="note-item ${n.id === state.selectedId ? 'active' : ''}" style="--i:${i}" data-id="${n.id}">
        <div class="ni-top">${flags}<span class="ni-title">${escapeHtml(n.title) || '无题笔记'}</span><span class="ni-time">${fmtTime(n.updatedAt)}</span></div>
        <div class="ni-snippet">${escapeHtml(snippet)}</div>
        <div class="ni-tags">${tags}</div>
        <button class="ni-del" title="删除">${ICON_TRASH}</button>
      </div>`;
    }).join('');
  }

  // 内容没变化时不重建，避免动画重播与闪现
  if (listEl.innerHTML !== html) listEl.innerHTML = html;
  $('#sideFoot').textContent = `共 ${state.notes.length} 条笔记 · 本地自动保存`;
}

function renderTags() {
  const counts = new Map();
  state.notes.forEach(n => n.tags.forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));

  const bar = $('#tagBar');
  bar.innerHTML = tags.length
    ? `<span class="tag-chip" data-clear style="${state.filter.kind === 'tag' ? '' : 'display:none'}">✕ 清除筛选</span>` + tags.map(([t, c]) =>
      `<button class="tag-chip ${state.filter.kind === 'tag' && state.filter.tag === t ? 'active' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}<span class="cnt">${c}</span></button>`).join('')
    : '';
  $('#tagBar').style.display = tags.length ? '' : 'none';
}

/* ---------------- 渲染：编辑器 ---------------- */
function renderEditor(animate = true) {
  const note = selectedNote();
  $('#editorEmpty').hidden = !!note;
  $('#editorBody').hidden = !note;
  if (!note) {
    if (animate) replaySwap([$('#editorEmpty')]);
    return;
  }

  $('#titleInput').value = note.title || '';
  const page = $('#contentInput');
  page.innerHTML = note.content || '';
  page.classList.toggle('is-empty', pageIsEmpty(page));
  renderMeta(note);
  if (animate) replaySwap([$('#titleInput'), $('.meta-row'), page]);
}

/* 重新触发切换过渡动画 */
function replaySwap(els) {
  els.forEach(el => {
    el.classList.remove('swap');
    void el.offsetWidth;
    el.classList.add('swap');
  });
}

function renderMeta(note) {
  $('#tagChips').innerHTML = note.tags.map(t =>
    `<span class="meta-chip">#${escapeHtml(t)}<button class="x" data-tag="${escapeHtml(t)}" title="移除标签">×</button></span>`).join('');
  $('#wordCount').textContent = `${countWords(note)} 字`;
  $('#updatedTime').textContent = `更新于 ${fmtTime(note.updatedAt)}`;
  $('#pinBtn').classList.toggle('on', !!note.pinned);
  $('#favBtn').classList.toggle('on', !!note.favorite);
}

function countWords(note) {
  return htmlToText(note.content).replace(/\s/g, '').length;
}

function pageIsEmpty(page) {
  return !page.textContent.trim() && !page.querySelector('img,pre,ul,ol,blockquote,hr,h1,h2,h3');
}

function setStatus(mode) {
  const el = $('#saveStatus');
  el.classList.toggle('saving', mode === 'saving');
  el.classList.toggle('local', mode === 'local');
  el.textContent = mode === 'saving' ? '保存中…'
    : mode === 'local' ? '仅本地'
      : (Backend.online ? '已同步' : '已保存');
}

/* ---------------- 动作 ---------------- */
function selectNote(id, { focusTitle = false } = {}) {
  state.selectedId = id;
  renderList();
  renderEditor();
  closeMobileSidebar();
  if (focusTitle) $('#titleInput').focus();
}

function createNote() {
  const n = {
    id: uid(), title: '', content: '',
    tags: state.filter.kind === 'tag' ? [state.filter.tag] : [],
    pinned: false, favorite: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  state.notes.unshift(n);
  persist();
  renderTags();
  selectNote(n.id, { focusTitle: true });
}

function deleteNote(id) {
  const idx = state.notes.findIndex(n => n.id === id);
  if (idx < 0) return;
  const [note] = state.notes.splice(idx, 1);
  const tomb = { id, deletedAt: Date.now() };
  state.deleted = state.deleted.filter(t => t.id !== id);
  state.deleted.push(tomb);

  if (state.selectedId === id) {
    state.selectedId = visibleNotes()[0]?.id ?? null;
  }
  persist();
  renderTags();
  selectNote(state.selectedId);
  if (!state.selectedId) { renderList(); renderEditor(); }

  toast(`已删除「${note.title || '无题笔记'}」`, {
    action: '撤销',
    onAction: () => {
      state.deleted = state.deleted.filter(t => t.id !== id);   // 撤销时移除墓碑
      state.notes.splice(Math.min(idx, state.notes.length), 0, note);
      note.updatedAt = Date.now();
      persist();
      renderTags();
      selectNote(note.id);
    },
  });
}

function toggleFlag(field) {
  const note = selectedNote();
  if (!note) return;
  note[field] = !note[field];
  note.updatedAt = Date.now();
  persist();
  renderMeta(note);
  renderList();
}

function addTag(raw) {
  const note = selectedNote();
  const t = raw.trim().replace(/^#/, '').slice(0, 12);
  if (!note || !t) return;
  if (note.tags.some(x => x.toLowerCase() === t.toLowerCase())) return;
  note.tags.push(t);
  note.updatedAt = Date.now();
  persist();
  renderMeta(note);
  renderTags();
  renderList();
}

function removeTag(tag) {
  const note = selectedNote();
  if (!note) return;
  note.tags = note.tags.filter(t => t !== tag);
  if (state.filter.kind === 'tag' && state.filter.tag === tag && !note.tags.includes(tag)) {
    state.filter = { kind: 'all', tag: null };
    syncFilterButtons();
  }
  note.updatedAt = Date.now();
  persist();
  renderMeta(note);
  renderTags();
  renderList();
}

/* ---------------- 富文本 ---------------- */
function exec(cmd, val = null) {
  const page = $('#contentInput');
  page.focus();
  document.execCommand(cmd, false, val);
  handleInput();
  updateToolbarState();
}

function insertChecklist() {
  exec('insertHTML',
    '<ul class="checklist"><li data-checked="false"><span class="tick" contenteditable="false"></span><span class="text">待办事项</span></li></ul><p><br></p>');
}

function handleInput() {
  const note = selectedNote();
  if (!note) return;
  const page = $('#contentInput');
  note.title = $('#titleInput').value;
  note.content = page.innerHTML;
  note.updatedAt = Date.now();

  setStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    persist();                                   // 本地 + 调度云端保存
    if (!Backend.online) setStatus('saved');     // 离线时本地落盘即完成
  }, 500);

  page.classList.toggle('is-empty', pageIsEmpty(page));
  $('#wordCount').textContent = `${countWords(note)} 字`;
  $('#updatedTime').textContent = `更新于 ${fmtTime(note.updatedAt)}`;

  clearTimeout(listTimer);
  listTimer = setTimeout(renderList, 350);
}

function updateToolbarState() {
  if ($('#editorBody').hidden) return;
  const page = $('#contentInput');
  if (!page.contains(document.getSelection()?.anchorNode)) return;

  $$('#toolbar [data-cmd="bold"],#toolbar [data-cmd="italic"],#toolbar [data-cmd="underline"],#toolbar [data-cmd="strikeThrough"]').forEach(btn => {
    try { btn.classList.toggle('active', document.queryCommandState(btn.dataset.cmd)); } catch (e) { /* noop */ }
  });

  let block = '';
  try { block = (document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, ''); } catch (e) { /* noop */ }
  $$('#toolbar [data-block]').forEach(btn => btn.classList.toggle('active', btn.dataset.block === block));
}

/* ---------------- 导出 Markdown ---------------- */
function htmlToMd(html) {
  const root = document.createElement('div');
  root.innerHTML = html || '';
  const body = convertChildren(root).replace(/\n{3,}/g, '\n\n').trim();
  return body + '\n';
}

function convertChildren(node) {
  return [...node.childNodes].map(convertNode).join('');
}

function convertNode(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return '';
  const el = node;
  const inner = () => convertChildren(el);
  switch (el.tagName) {
    case 'H1': return `\n# ${inner().trim()}\n\n`;
    case 'H2': return `\n## ${inner().trim()}\n\n`;
    case 'H3': return `\n### ${inner().trim()}\n\n`;
    case 'B': case 'STRONG': { const t = inner().trim(); return t ? `**${t}**` : ''; }
    case 'I': case 'EM': { const t = inner().trim(); return t ? `*${t}*` : ''; }
    case 'S': case 'STRIKE': case 'DEL': { const t = inner().trim(); return t ? `~~${t}~~` : ''; }
    case 'U': return inner();
    case 'MARK': return `==${inner().trim()}==`;
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

function listMd(list, ordered) {
  let i = 1;
  const out = [];
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue;
    const text = convertChildren(li).replace(/\n+/g, ' ').trim();
    if (list.classList.contains('checklist')) {
      out.push(`- [${li.dataset.checked === 'true' ? 'x' : ' '}] ${text}`);
    } else {
      out.push(ordered ? `${i++}. ${text}` : `- ${text}`);
    }
  }
  return out.join('\n');
}

function exportMarkdown() {
  const note = selectedNote();
  if (!note) return;
  const lines = [];
  if (note.title) lines.push(`# ${note.title}\n`);
  if (note.tags.length) lines.push(note.tags.map(t => `\`#${t}\``).join(' ') + '\n');
  lines.push(htmlToMd(note.content));
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(note.title || '无题笔记').replace(/[\\/:*?"<>|]/g, '_')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出为 Markdown 📄');
}

/* ---------------- Toast ---------------- */
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

/* ---------------- 主题 ---------------- */
function applyTheme(theme, { animate = false } = {}) {
  const root = document.documentElement;
  if (animate && theme !== root.dataset.theme) {
    root.classList.add('theme-fade');
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => root.classList.remove('theme-fade'), 600);
  }
  root.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* noop */ }
}

/* ---------------- 设置面板 ---------------- */
function openSettings() {
  $('#settingsModal').hidden = false;
  renderBackendStatus();
  fillConfigForm();
}

function closeSettings() { $('#settingsModal').hidden = true; }

async function renderBackendStatus() {
  const el = $('#backendStatus');
  el.classList.remove('on');
  el.innerHTML = '<b>正在连接后端…</b>';
  const on = await Backend.health();
  refreshCloudDot();
  el.classList.toggle('on', on);
  el.innerHTML = on
    ? '<b>后端已连接</b>· 笔记自动保存到服务器 data/notes.json'
    : '<b>后端未连接</b>· 请先启动 server.js，当前笔记仅保存在浏览器本地';
}

async function fillConfigForm() {
  const c = await Backend.getConfig();
  $('#cfgEndpoint').value = c?.endpoint || '';
  $('#cfgRegion').value = c?.region || '';
  $('#cfgBucket').value = c?.bucket || '';
  $('#cfgAccessKey').value = c?.accessKeyId || '';
  $('#cfgSecret').value = c?.secretAccessKey || '';
  $('#cfgObject').value = c?.objectKey || '';
  $('#cfgAutoSync').checked = !!(c && c.autoSync);
  $('#cfgAutoPull').checked = state.settings.autoPull !== false;
}

function configFromForm() {
  return {
    endpoint: $('#cfgEndpoint').value.trim(),
    region: $('#cfgRegion').value.trim(),
    bucket: $('#cfgBucket').value.trim(),
    accessKeyId: $('#cfgAccessKey').value.trim(),
    secretAccessKey: $('#cfgSecret').value,
    objectKey: $('#cfgObject').value.trim() || 'notes.json',
    autoSync: $('#cfgAutoSync').checked,
  };
}

async function saveConfigFromForm() {
  const r = await Backend.saveConfig(configFromForm());
  toast(r.ok ? 'S3 配置已保存' : `保存失败：${r.error || '未知错误'}`);
  if (r.ok) await testConnection();
}

/* 连接测试：凭证 → 桶权限 → 对象可读性，后端逐级诊断 */
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
  if (r.ok) toast('已推送到云端');
  else toast(`推送失败：${r.error || '未知错误'}`);
}

/* ---------------- 多端同步：按笔记合并 ---------------- */

/* local / remote: { notes, deleted, settings, savedAt }
   笔记按 id 逐条取 updatedAt 更新的一方；删除以墓碑传播；偏好取存档较新一方的 */
function mergeArchives(local, remote) {
  const map = new Map(local.notes.map(n => [n.id, n]));
  let changed = 0;
  for (const rn of (remote.notes || [])) {
    const ln = map.get(rn.id);
    if (!ln) { map.set(rn.id, rn); changed++; }
    else if ((rn.updatedAt || 0) > (ln.updatedAt || 0)) { map.set(rn.id, rn); changed++; }
  }
  const tombs = new Map();
  for (const t of [...(local.deleted || []), ...(remote.deleted || [])]) {
    const cur = tombs.get(t.id);
    if (!cur || (t.deletedAt || 0) >= (cur.deletedAt || 0)) tombs.set(t.id, t);
  }
  for (const [id, t] of tombs) {
    const n = map.get(id);
    if (n && (n.updatedAt || 0) <= (t.deletedAt || 0)) { map.delete(id); changed++; }
  }
  const settings = (remote.savedAt || 0) > (local.savedAt || 0)
    ? { ...local.settings, ...(remote.settings || {}) }
    : { ...remote.settings, ...local.settings };
  return { notes: [...map.values()], deleted: [...tombs.values()], settings, changed };
}

/* 应用合并后的偏好（主题 / 排序 / 侧栏） */
function applySettings(s) {
  if (!s) return;
  if (s.theme && s.theme !== document.documentElement.dataset.theme) applyTheme(s.theme, { animate: true });
  if (s.sort && s.sort !== state.sort) { state.sort = s.sort; $('#sortSelect').value = s.sort; }
  if (typeof s.sidebarCollapsed === 'boolean') {
    document.body.classList.toggle('sidebar-collapsed', s.sidebarCollapsed);
    try { localStorage.setItem(SIDEBAR_KEY, s.sidebarCollapsed ? '1' : '0'); } catch (e) { /* noop */ }
  }
}

/* 从云端拉取存档并与本地合并；合并结果会回传云端，使各端收敛 */
async function pullCloud() {
  const r = await Backend.remoteArchive();
  if (!r.ok) { toast(`拉取失败：${r.error || '未知错误'}`); return; }
  const merged = mergeArchives(
    { notes: state.notes, deleted: state.deleted, settings: state.settings, savedAt: state.savedAt },
    r.archive,
  );
  state.notes = merged.notes;
  state.deleted = merged.deleted;
  state.settings = merged.settings;
  applySettings(state.settings);
  persist();   // 回传合并结果（含上传）
  renderTags();
  const keep = state.selectedId && state.notes.some(n => n.id === state.selectedId) ? state.selectedId : null;
  state.selectedId = keep ?? (visibleNotes()[0]?.id ?? null);
  renderList(true);
  renderEditor();
  toast(merged.changed ? `已与云端合并：${merged.changed} 处更新` : '本地与云端已是一致');
}

/* ---------------- 多端自动同步 ---------------- */
const PULL_INTERVAL_MS = Math.max(5, Number(new URLSearchParams(location.search).get('pullSec')) * 1000 || 60000);
let autoPullTimer = null;

function startAutoPull() {
  clearInterval(autoPullTimer);
  if (!state.settings.autoPull || !Backend.online) return;
  autoPullTimer = setInterval(autoPullTick, PULL_INTERVAL_MS);
}

async function autoPullTick() {
  if (!Backend.online || !state.settings.autoPull) return;
  try {
    const r = await Backend.remoteArchive();
    if (!r.ok) return;
    const merged = mergeArchives(
      { notes: state.notes, deleted: state.deleted, settings: state.settings, savedAt: state.savedAt },
      r.archive,
    );
    if (!merged.changed) return;
    state.notes = merged.notes;
    state.deleted = merged.deleted;
    state.settings = merged.settings;
    applySettings(state.settings);
    persist();               // 合并结果回传云端，其他端随之收敛
    renderTags();
    const keep = state.selectedId && state.notes.some(n => n.id === state.selectedId) ? state.selectedId : null;
    state.selectedId = keep ?? (visibleNotes()[0]?.id ?? null);
    renderList();
    renderEditor(false);
    if (keep !== state.selectedId) selectNote(state.selectedId);
  } catch (e) { console.warn('autoPullTick 失败：', e); }
}

/* ---------------- 移动端侧栏 ---------------- */
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

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('#newBtn').addEventListener('click', createNote);
  $('#menuBtn').addEventListener('click', openMobileSidebar);
  $('#scrim').addEventListener('click', closeMobileSidebar);
  $('#backBtn').addEventListener('click', () => {
    state.selectedId = null;
    renderList();
    renderEditor();
    openMobileSidebar();
  });

  // 侧栏收起 / 展开（桌面）
  $('#collapseBtn').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    state.settings.sidebarCollapsed = collapsed;
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) { /* noop */ }
    persist();   // 偏好随存档多端同步
  });

  // 设置面板
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeSettings(); });
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
    persist();   // 偏好随存档多端同步
  });

  const search = $('#searchInput');
  search.addEventListener('input', () => { state.query = search.value.trim(); renderList(true); });

  $('#sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    state.settings.sort = e.target.value;
    persist();
    renderList(true);
  });

  $('#filters').addEventListener('click', e => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    state.filter = { kind: btn.dataset.filter, tag: null };
    syncFilterButtons();
    renderList(true);
  });

  $('#tagBar').addEventListener('click', e => {
    const clear = e.target.closest('[data-clear]');
    const chip = e.target.closest('[data-tag]');
    if (clear) {
      state.filter = { kind: 'all', tag: null };
    } else if (chip) {
      const t = chip.dataset.tag;
      const on = state.filter.kind === 'tag' && state.filter.tag === t;
      state.filter = on ? { kind: 'all', tag: null } : { kind: 'tag', tag: t };
    } else return;
    syncFilterButtons();
    renderTags();
    renderList(true);
  });

  // 列表：选中 / 删除
  $('#noteList').addEventListener('click', e => {
    const del = e.target.closest('.ni-del');
    if (del) { deleteNote(del.closest('.note-item').dataset.id); return; }
    const item = e.target.closest('.note-item');
    if (item) selectNote(item.dataset.id);
  });

  // 编辑器：标题与正文
  $('#titleInput').addEventListener('input', handleInput);
  const page = $('#contentInput');
  page.addEventListener('input', handleInput);
  page.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); exec('insertHTML', '&nbsp;&nbsp;&nbsp;&nbsp;'); }
  });
  // 待办勾选
  page.addEventListener('click', e => {
    const li = e.target.closest('.checklist li');
    if (!li || !e.target.closest('.tick')) return;
    li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true';
    handleInput();
  });

  // 工具栏（mousedown 防止编辑区失焦丢失选区）
  $('#toolbar').addEventListener('mousedown', e => e.preventDefault());
  $('#toolbar').addEventListener('click', e => {
    const btn = e.target.closest('.tool');
    if (!btn) return;
    if (btn.dataset.act === 'checklist') insertChecklist();
    else if (btn.dataset.cmd === 'hilite') exec('hiliteColor', 'rgba(251,191,36,.4)');
    else if (btn.dataset.cmd) exec(btn.dataset.cmd);
    else if (btn.dataset.block) exec('formatBlock', btn.dataset.block);
  });

  document.addEventListener('selectionchange', () => {
    if ($('#editorBody').hidden) return;
    requestAnimationFrame(updateToolbarState);
  });

  // 标签
  $('#tagInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      addTag(e.target.value);
      e.target.value = '';
    }
  });
  $('#tagChips').addEventListener('click', e => {
    const x = e.target.closest('.x');
    if (x) removeTag(x.dataset.tag);
  });

  // 编辑器动作
  $('#pinBtn').addEventListener('click', () => toggleFlag('pinned'));
  $('#favBtn').addEventListener('click', () => toggleFlag('favorite'));
  $('#exportBtn').addEventListener('click', exportMarkdown);
  $('#deleteBtn').addEventListener('click', () => state.selectedId && deleteNote(state.selectedId));

  // 快捷键
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (mod && e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createNote();
    } else if (e.key === 'Escape') {
      if (!$('#settingsModal').hidden) { closeSettings(); return; }
      if (document.activeElement === search) {
        search.value = '';
        state.query = '';
        renderList();
        search.blur();
      }
    }
  });
}

function syncFilterButtons() {
  $$('#filters .filter').forEach(b =>
    b.classList.toggle('active', b.dataset.filter === state.filter.kind));
}

/* ---------------- 启动 ---------------- */
async function init() {
  let theme = 'light';
  try {
    theme = localStorage.getItem(THEME_KEY) ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (e) { /* noop */ }
  const themeParam = new URLSearchParams(location.search).get('theme');
  if (themeParam === 'dark' || themeParam === 'light') theme = themeParam;

  const saved = load();
  state.notes = saved ? saved.notes : seedNotes();
  if (saved) {
    if (saved.settings) state.settings = { ...state.settings, ...saved.settings };
    state.deleted = saved.deleted || [];
    state.savedAt = saved.savedAt || 0;
  }
  if (themeParam) state.settings.theme = themeParam;
  if (!state.settings.theme) state.settings.theme = theme;
  if (state.settings.sort) { state.sort = state.settings.sort; }
  applyTheme(state.settings.theme);

  try { if (state.settings.sidebarCollapsed || localStorage.getItem(SIDEBAR_KEY) === '1') document.body.classList.add('sidebar-collapsed'); } catch (e) { /* noop */ }
  if (state.settings.sort) $('#sortSelect').value = state.settings.sort;

  bindEvents();
  renderTags();
  syncFilterButtons();
  const first = visibleNotes()[0];
  if (first) selectNote(first.id);
  renderList(true);

  // 后端可用时，以服务器存档为准刷新本地
  const online = await Backend.health();
  refreshCloudDot();
  if (online) {
    const pkg = await Backend.getNotes();
    if (pkg && pkg.notes && pkg.notes.length) {
      state.notes = pkg.notes;
      if (pkg.settings) { state.settings = { ...state.settings, ...pkg.settings }; applySettings(state.settings); }
      state.deleted = pkg.deleted || [];
      persist({ cloud: false });
      renderTags();
      const keep = state.selectedId && state.notes.some(n => n.id === state.selectedId) ? state.selectedId : null;
      state.selectedId = keep ?? (visibleNotes()[0]?.id ?? null);
      renderList(true);
      renderEditor();
      if (!keep) selectNote(state.selectedId);
    } else if (state.notes.length) {
      scheduleCloudSave();   // 把本地 / 示例数据推到服务器
    }
    if (state.settings.autoPull !== false) {
      autoPullTick();        // 启动即与云端对齐
      startAutoPull();       // 之后定时保持多端收敛
    }
  }
  setStatus('saved');
}

init();
