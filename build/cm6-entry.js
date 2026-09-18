/* ============================================================
   CodeMirror 6 打包入口 —— 生成 vendor/cm6.js（IIFE，全局 CM6）

   简记的编辑区 = CM6 内核 + Lezer Markdown 语法树 + 自研 livePreview 扩展。

   livePreview 借鉴 Obsidian Live Preview 的做法：
     · 文档模型始终是纯 Markdown 文本（编辑器里真的存着 `**粗体**` 这些字符）
     · 用 Decoration.replace 把语法标记（#、**、`、>、链接方括号…）藏起来
     · 用 Decoration.mark / Decoration.line 给内容套样式
     · 表格用 replace + widget 整块渲染成真正的 <table>
     · 光标 / 选区进入某个节点时，该节点的装饰自动撤销，源码重新显形
   ============================================================ */
'use strict';

import { EditorState, Prec, Compartment, EditorSelection, StateField } from '@codemirror/state';
import {
  EditorView, keymap, ViewPlugin, Decoration, WidgetType, ViewUpdate,
  drawSelection, dropCursor, highlightActiveLine, highlightSpecialChars, placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll, toggleComment } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle, indentUnit, indentOnInput,
  bracketMatching, syntaxTree, foldGutter, foldKeymap,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Table, TaskList, Strikethrough, Autolink } from '@lezer/markdown';

/* ------------------------------------------------------------
   1. 常量
   ------------------------------------------------------------ */

// 纯粹「藏起来」的标记
const HIDE_TAGS = new Set([
  'EmphasisMark', 'CodeMark', 'LinkMark', 'StrikethroughMark', 'URL',
  'HeaderMark', 'QuoteMark', 'CodeInfo',
]);

/* 选区是否与节点范围相交（相交则保留源码原样，方便就地编辑） */
function intersects(state, from, to) {
  const sel = state.selection;
  for (const r of sel.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/* 安全地创建元素（只用 textContent，天然防 XSS） */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ------------------------------------------------------------
   2. 任务勾选框 widget
   ------------------------------------------------------------ */
class CheckboxWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(other) { return other.checked === this.checked && other.pos === this.pos; }
  toDOM(view) {
    const box = el('span', 'cm-md-checkbox' + (this.checked ? ' checked' : ''));
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const line = view.state.doc.lineAt(this.pos);
      const m = /^(\s*(?:[-*+]\s+)?\[)([ xX])(\])/.exec(line.text);
      if (!m) return;
      const caretDelta = view.state.selection.main.empty
        ? view.state.selection.main.from - line.from
        : 0;
      const insert = line.text.slice(0, m[1].length) +
        (m[2] === ' ' ? 'x' : ' ') + line.text.slice(m[1].length + 1);
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + caretDelta },
        userEvent: 'input.toggleTask',
      });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

/* ------------------------------------------------------------
   3. 表格 widget
   ------------------------------------------------------------ */
function collectTableRows(doc, from, to) {
  const rows = [];
  let pos = from;
  for (;;) {
    const line = doc.lineAt(pos);
    const raw = line.text.trim();
    const cells = /^\|/.test(raw)
      ? raw.replace(/^\|/, '').replace(/\|$/, '').split('|')
      : raw.split('|');
    rows.push(cells.map(c => c.trim()));
    if (line.to >= to) break;
    pos = line.to + 1;
    if (pos > doc.length) break;
  }
  return rows;
}

class TableWidget extends WidgetType {
  constructor(rows) { super(); this.rows = rows; this.key = JSON.stringify(rows); }
  eq(o) { return o instanceof TableWidget && o.key === this.key; }
  toDOM() {
    const wrap = el('div', 'cm-md-table');
    wrap.setAttribute('contenteditable', 'false');
    const hasHeader = this.rows.length >= 2 && /^:?-{2,}:?$/.test((this.rows[1][0] || '').replace(/\s/g, ''));
    const aligns = hasHeader ? this.rows[1].map(c => {
      const s = c.replace(/\s/g, '');
      if (/^:-+:$/.test(s)) return 'center';
      if (/-+:$/.test(s)) return 'right';
      return 'left';
    }) : null;
    const body = hasHeader ? [this.rows[0], ...this.rows.slice(2)] : this.rows;

    const table = el('table');
    body.forEach((cells, i) => {
      const tr = el('tr');
      cells.forEach((c, j) => {
        const cell = el(i === 0 && hasHeader ? 'th' : 'td');
        if (aligns && aligns[j]) cell.style.textAlign = aligns[j];
        cell.textContent = c;
        tr.appendChild(cell);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    return wrap;
  }
  get estimatedHeight() { return -1; }
  ignoreEvent() { return false; }
}

/* ------------------------------------------------------------
   4. 分割线 widget
   ------------------------------------------------------------ */
class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return el('div', 'cm-md-hr'); }
}

/* ------------------------------------------------------------
   5. 核心：遍历语法树生成装饰
   ------------------------------------------------------------ */
/* 找出所有「已渲染为块」的表格范围：这些区间由 StateField 整块替换，
   ViewPlugin 不能再往里面放任何装饰，否则会撞 RangeError */
function renderedTableRanges(state) {
  const out = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return;
      if (intersects(state, node.from, node.to)) return;   // 光标在表里 → 保留源码，不渲染
      out.push([state.doc.lineAt(node.from).from, state.doc.lineAt(Math.min(node.to, state.doc.length)).to]);
    },
  });
  return out;
}

function inAny(ranges, from, to) {
  for (const [a, b] of ranges) if (from < b && to > a) return true;
  return false;
}

/* ---- 块级装饰：必须来自 StateField（CM6 禁止 ViewPlugin 替换换行） ---- */
function buildBlockDecorations(state) {
  const parts = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Table') return;
      if (intersects(state, node.from, node.to)) return false;
      const rows = collectTableRows(state.doc, node.from, node.to);
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(Math.min(node.to, state.doc.length));
      parts.push(Decoration.replace({ widget: new TableWidget(rows) }).range(first.from, last.to));
      return false;
    },
  });
  return Decoration.set(parts, true);
}

const blockField = StateField.define({
  create(state) { return buildBlockDecorations(state); },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && syntaxTree(tr.startState) === syntaxTree(tr.state)) return value;
    return buildBlockDecorations(tr.state);
  },
  provide: f => EditorView.decorations.from(f),
});

/* ---- 行内装饰：藏在 ViewPlugin 里，只处理不跨行的部分 ---- */
function buildDecorations(view) {
  const state = view.state;
  const tree = syntaxTree(state);
  const tables = renderedTableRanges(state);
  const parts = [];
  const pushed = new Set();

  const hide = (from, to, spec) => {
    if (to <= from) return;
    const key = `${from}:${to}:${spec ? 'w' : 'h'}`;
    if (pushed.has(key)) return;
    pushed.add(key);
    parts.push(Decoration.replace(spec || {}).range(from, to));
  };

  for (const range of view.visibleRanges) {
    tree.iterate({
      from: range.from, to: range.to,
      enter(node) {
        const name = node.name;

        /* 表格已整块渲染 → 其子树由 StateField 负责，这里全部跳过 */
        if (name === 'Table') {
          if (intersects(state, node.from, node.to)) return;
          return false;
        }

        /* --- 标题：整行套样式 --- */
        const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(name);
        if (heading) {
          if (inAny(tables, node.from, node.to)) return;
          const ln = state.doc.lineAt(node.from);
          const key = 'line' + ln.number;
          if (!pushed.has(key)) {
            pushed.add(key);
            parts.push(Decoration.line({ class: 'cm-md-h' + heading[1] }).range(ln.from));
          }
          return;
        }

        /* --- 引用：整块行左侧加竖线 --- */
        if (name === 'Blockquote') {
          const a = state.doc.lineAt(node.from).number;
          const b = state.doc.lineAt(Math.min(node.to, state.doc.length)).number;
          for (let i = a; i <= b; i++) {
            const ln = state.doc.line(i);
            if (inAny(tables, ln.from, ln.to)) continue;
            const key = 'q' + i;
            if (pushed.has(key)) continue;
            pushed.add(key);
            parts.push(Decoration.line({ class: 'cm-md-quote' }).range(ln.from));
          }
          return;
        }

        /* --- 分割线 --- */
        if (name === 'HorizontalRule') {
          if (!intersects(state, node.from, node.to) && !inAny(tables, node.from, node.to)) {
            hide(node.from, node.to, { widget: new RuleWidget() });
          }
          return;
        }

        /* --- 任务勾选框 --- */
        if (name === 'TaskMarker') {
          if (intersects(state, node.from, node.to) || inAny(tables, node.from, node.to)) return;
          hide(node.from, node.to, {
            widget: new CheckboxWidget(state.sliceDoc(node.from, node.to) === '[x]', node.from),
          });
          return;
        }

        if (!HIDE_TAGS.has(name)) return;

        /* '#' / '>' 后面紧跟的那个空格一并吃掉，视觉上才像渲染结果 */
        let end = node.to;
        if (name === 'HeaderMark' || name === 'QuoteMark') {
          if (state.sliceDoc(end, end + 1) === ' ') end += 1;
        }
        if (intersects(state, node.from, end) || inAny(tables, node.from, end)) return;
        hide(node.from, end, null);
      },
    });

    /* --- 内容样式 --- */
    const STYLE = {
      StrongEmphasis: 'cm-md-strong',
      Emphasis: 'cm-md-em',
      Strikethrough: 'cm-md-strike',
      InlineCode: 'cm-md-code',
      Link: 'cm-md-link',
    };
    tree.iterate({
      from: range.from, to: range.to,
      enter(node) {
        if (node.name === 'Table') { if (!intersects(state, node.from, node.to)) return false; return; }
        const cls = STYLE[node.name];
        if (!cls) return;
        if (intersects(state, node.from, node.to)) return;
        if (inAny(tables, node.from, node.to)) return;
        parts.push(Decoration.mark({ class: cls }).range(node.from, node.to));
      },
    });
  }

  return Decoration.set(parts, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: v => v.decorations },
);

/* ------------------------------------------------------------
   6. 代码块语法高亮（正文保持纯色，只在 ``` 代码块里生效）
   ------------------------------------------------------------ */
const mdHighlight = HighlightStyle.define([
  { tag: t.heading, class: 'cm-tok-heading' },
  { tag: t.strong, class: 'cm-tok-strong' },
  { tag: t.emphasis, class: 'cm-tok-em' },
  { tag: t.strikethrough, class: 'cm-tok-strike' },
  { tag: t.link, class: 'cm-tok-link' },
  { tag: t.url, class: 'cm-tok-url' },
  { tag: t.monospace, class: 'cm-tok-mono' },
  { tag: t.keyword, class: 'cm-tok-keyword' },
  { tag: t.string, class: 'cm-tok-string' },
  { tag: t.comment, class: 'cm-tok-comment', fontStyle: 'italic' },
  { tag: t.number, class: 'cm-tok-number' },
  { tag: t.bool, class: 'cm-tok-number' },
  { tag: t.processingInstruction, class: 'cm-tok-markup' },
]);

/* GFM：表格 / 任务列表 / 删除线 / 自动链接 */
const gfmMarkdown = () => markdown({
  base: markdownLanguage,
  extensions: [Table, TaskList, Strikethrough, Autolink],
});

/* 括号自动配对删除的最小实现（避免引入 autocomplete 包） */
const pairBackspace = keymap.of([{
  key: 'Backspace',
  run: (v) => {
    const { state } = v;
    const r = state.selection.main;
    if (!r.empty || r.from === 0) return false;
    const PAIRS = { '(': ')', '[': ']', '{': '}' };
    const before = state.sliceDoc(r.from - 1, r.from);
    const after = state.sliceDoc(r.from, r.from + 1);
    if (PAIRS[before] && PAIRS[before] === after) {
      v.dispatch({ changes: { from: r.from - 1, to: r.from + 1, insert: '' }, selection: { anchor: r.from - 1 } });
      return true;
    }
    return false;
  },
}]);

/* ------------------------------------------------------------
   7. 对外导出
   ------------------------------------------------------------ */
function baseExtensions({ placeholderText = '开始书写…' } = {}) {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    pairBackspace,
    highlightActiveLine(),
    highlightSpecialChars(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    gfmMarkdown(),
    syntaxHighlighting(mdHighlight),
    blockField,
    livePreview,
    indentUnit.of('    '),
    placeholder(placeholderText),
  ];
}

export {
  EditorState, EditorView, EditorSelection, ViewPlugin, Decoration,
  keymap, history, indentWithTab, Compartment, Prec, ViewUpdate,
  undo, redo, selectAll, toggleComment,
  baseExtensions, gfmMarkdown, livePreview, syntaxTree, foldGutter, foldKeymap,
};
