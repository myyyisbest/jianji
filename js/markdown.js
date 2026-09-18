/* ============================================================
   简记 · Markdown 渲染器（零依赖，浏览器 / Node 双端可用）
   - 浏览器：挂载到全局 JianjiMD.render(md) -> HTML 字符串
   - Node：  const { render } = require('./markdown.js')

   支持语法（与编辑器富文本能力一一对应，可双向转换）：
     # / ## / ###        标题（H1-H3）
     **粗体** *斜体* ~~删除线~~ ==高亮== `行内代码`
     - / 1.              无序 / 有序列表
     - [ ] / - [x]       待办清单（结构与编辑器 checklist 一致）
     >                   引用块
     ```                 代码块
     ---                 分割线
     [文字](https://…)    链接（仅 http/https/mailto，其他协议降级为 #）
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JianjiMD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 行内代码的占位哨兵。
     早期版本直接用裸 \u0000 包夹序号，导致源码里出现真实 NUL 字节：
     git 判定文件为 binary（diff / blame / code review 全部失效），
     任何一次「复制粘贴 → 编辑器过滤控制字符」都会把哨兵抹掉，
     且 NUL 在部分日志管道里会被截断。改用可打印字符组合，
     既保持「原文几乎不可能命中」的占位特性，又能安全参与文本流。 */
  const SENTINEL = '\u0001\u0001JI\u0001\u0001';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- 行内语法 ---------------- */
  function renderInline(text) {
    // 先保护行内代码，避免其中的符号被其他规则误伤
    const codes = [];
    let t = String(text).replace(/`([^`\n]+)`/g, (m, g1) => {
      codes.push(g1);
      return SENTINEL + (codes.length - 1) + SENTINEL;
    });

    t = escapeHtml(t);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    t = t.replace(/==([^=]+)==/g, '<mark>$1</mark>');
    t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, txt, href) => {
      const safe = /^(https?:|mailto:)/i.test(href) ? href : '#';
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    });

    // 还原行内代码（哨兵用 RegExp 构造，避免字面量里的控制字符被转义歧义）
    t = t.replace(new RegExp(SENTINEL + '(\\d+)' + SENTINEL, 'g'), (m, i) => `<code>${escapeHtml(codes[+i])}</code>`);
    return t;
  }

  /* ---------------- 列表 ---------------- */
  // 匹配：无序 "- "/"* "，有序 "1. "，待办 "- [ ] " / "- [x] "
  const RE_UL = /^\s*[-*]\s+/;
  const RE_OL = /^\s*\d+\.\s+/;
  const RE_TASK = /^\s*[-*]\s+\[([ xX])\]\s+/;

  function renderList(lines, i) {
    const first = lines[i];
    const ordered = RE_OL.test(first) && !RE_UL.test(first);
    const items = [];
    let j = i;
    let hasTask = false;

    while (j < lines.length) {
      const line = lines[j];
      const task = line.match(RE_TASK);
      if (task) {
        hasTask = true;
        items.push({ checked: task[1].toLowerCase() === 'x', text: line.slice(task[0].length) });
        j++; continue;
      }
      if (!ordered && RE_UL.test(line)) { items.push({ text: line.replace(RE_UL, '') }); j++; continue; }
      if (ordered && RE_OL.test(line)) { items.push({ text: line.replace(RE_OL, '') }); j++; continue; }
      break;
    }

    if (hasTask) {
      const html = items.map(it =>
        `<li data-checked="${it.checked ? 'true' : 'false'}">` +
        `<span class="tick" contenteditable="false"></span>` +
        `<span class="text">${renderInline(it.text)}</span></li>`).join('');
      return { html: `<ul class="checklist">${html}</ul>`, next: j };
    }
    const tag = ordered ? 'ol' : 'ul';
    const html = items.map(it => `<li>${renderInline(it.text)}</li>`).join('');
    return { html: `<${tag}>${html}</${tag}>`, next: j };
  }

  /* ---------------- 主渲染 ---------------- */
  function render(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 空行
      if (!line.trim()) { i++; continue; }

      // 代码块 ```
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;   // 跳过收尾 ```
        out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        out.push(`<h${level}>${renderInline(h[2].trim())}</h${level}>`);
        i++; continue;
      }

      // 分割线
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // 引用块（连续 > 行合并为一个 blockquote）
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote><p>${buf.map(renderInline).join('<br>')}</p></blockquote>`);
        continue;
      }

      // 列表 / 待办
      if (RE_UL.test(line) || RE_OL.test(line)) {
        const r = renderList(lines, i);
        out.push(r.html);
        i = r.next;
        continue;
      }

      // 段落：连续非空行合并，行内换行转 <br>
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*```/.test(lines[i]) && !/^(#{1,3})\s+/.test(lines[i]) &&
             !/^\s*>\s?/.test(lines[i]) && !RE_UL.test(lines[i]) && !RE_OL.test(lines[i]) &&
             !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${buf.map(renderInline).join('<br>')}</p>`);
    }

    return out.join('');
  }

  return { render, renderInline, escapeHtml };
});
