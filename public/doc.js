// Helpers for note documents (TipTap/ProseMirror JSON), usable without an editor instance.
import { esc } from './markdown.js';
import { formatDate, todayISO, DATE_LABEL_RE, parseLabel, findDatesInText } from './dates.js';

/** Copy of the doc with written dates ("Mar 6, 2026", "06/10/2025") turned into date tags. */
export function tagDatesInDoc(doc) {
  const copy = structuredClone(doc);
  let count = 0;
  const walk = (node, inCode) => {
    if (!node.content) return;
    const code = inCode || node.type === 'codeBlock';
    const out = [];
    for (const child of node.content) {
      const skip = code || child.type !== 'text' || (child.marks || []).some((m) => m.type === 'code' || m.type === 'link');
      const hits = skip ? [] : findDatesInText(child.text || '');
      if (!hits.length) { walk(child, code); out.push(child); continue; }
      let last = 0;
      for (const h of hits) {
        if (h.index > last) out.push({ ...child, text: child.text.slice(last, h.index) });
        out.push({ type: 'date', attrs: { date: h.iso } });
        last = h.index + h.length;
        count++;
      }
      if (last < child.text.length) out.push({ ...child, text: child.text.slice(last) });
    }
    node.content = out;
  };
  walk(copy, false);
  return { doc: copy, count };
}

export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

/** Parse stored note content. Returns null for legacy (markdown) content that needs migrating. */
export function parseDoc(content) {
  if (!content) return EMPTY_DOC;
  if (content[0] !== '{') return null;
  try {
    const d = JSON.parse(content);
    return d && d.type === 'doc' ? d : null;
  } catch { return null; }
}

function inlineText(nodes) {
  let s = '';
  for (const n of nodes || []) {
    if (n.type === 'text') s += n.text || '';
    else if (n.type === 'date') s += formatDate(n.attrs?.date);
    else if (n.type === 'hardBreak') s += ' ';
  }
  return s;
}

const LISTS = new Set(['taskList', 'bulletList', 'orderedList']);

/**
 * A to-do's parts. Its title is the first line; its details are the lines written under it
 * inside the same to-do (before any sub-list); its due date is an attribute of the to-do.
 * Details are editable as plain text only when they're plain paragraphs.
 */
function taskParts(item) {
  const [first, ...rest] = item.content || [];
  const bodyBlocks = rest.filter((c) => !LISTS.has(c.type));
  const bodyEditable = bodyBlocks.every((c) => c.type === 'paragraph' && (c.content || []).every((x) => x.type === 'text' || x.type === 'date' || x.type === 'hardBreak'));
  const body = bodyBlocks.map((c) => (c.type === 'paragraph' ? inlineText(c.content) : docText({ type: 'doc', content: [c] }))).join('\n').replace(/\s+$/, '');
  return { first: first?.type === 'paragraph' ? first : null, body, bodyEditable };
}

/** Every to-do in document order: { index, done, text, nodes, body, bodyEditable, due }. */
export function docTasks(doc) {
  const out = [];
  const walk = (n) => {
    if (n.type === 'taskItem') {
      const { first, body, bodyEditable } = taskParts(n);
      out.push({
        index: out.length,
        done: !!n.attrs?.checked,
        text: inlineText(first?.content).trim(),
        nodes: first?.content || [],
        body,
        bodyEditable,
        due: /^\d{4}-\d{2}-\d{2}$/.test(n.attrs?.due || '') ? n.attrs.due : null,
      });
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

/** Plain text → inline nodes, turning written date labels ("Fri, Nov 13, 2026") back into date tags. */
export function textToInline(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(DATE_LABEL_RE)) {
    const iso = parseLabel(m[0]);
    if (!iso) continue;
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'date', attrs: { date: iso } });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/**
 * Copy of the doc with to-do #index changed: `title` (plain text; date labels become tags),
 * `body` (plain text, one paragraph per line), `due` (YYYY-MM-DD or null). Returns null if
 * the to-do isn't there, or its details hold rich content (edit those in the note).
 */
export function updateTask(doc, index, { title, body, due } = {}) {
  const copy = structuredClone(doc);
  const path = findTaskPath(copy, index);
  if (!path) return null;
  const item = path[path.length - 1];
  item.content = item.content?.length ? item.content : [{ type: 'paragraph' }];
  if (item.content[0].type !== 'paragraph') item.content.unshift({ type: 'paragraph' });
  if (due !== undefined) item.attrs = { ...(item.attrs || {}), due: due || null };
  if (title !== undefined) {
    const inline = textToInline(String(title).replace(/\s+/g, ' ').trim());
    item.content[0] = inline.length ? { ...item.content[0], content: inline } : { type: 'paragraph', ...(item.content[0].attrs ? { attrs: item.content[0].attrs } : {}) };
  }
  if (body !== undefined) {
    if (!taskParts(item).bodyEditable) return null;
    const lists = item.content.slice(1).filter((c) => LISTS.has(c.type));
    const lines = String(body).replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
    const paras = lines.length === 1 && !lines[0] ? [] : lines.map((l) => {
      const inline = textToInline(l);
      return inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' };
    });
    item.content = [item.content[0], ...paras, ...lists];
  }
  return copy;
}

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'listItem', 'taskItem', 'blockquote', 'horizontalRule', 'tableCell', 'tableHeader']);
/** Plain text (for search, snippets and word counts). */
export function docText(doc) {
  const parts = [];
  const walk = (n) => {
    if (n.type === 'text') { parts.push(n.text || ''); return; }
    if (n.type === 'date') { parts.push(formatDate(n.attrs?.date)); return; }
    if (n.type === 'hardBreak') { parts.push('\n'); return; }
    n.content?.forEach(walk);
    if (BLOCKS.has(n.type)) parts.push('\n');
  };
  walk(doc);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function findTaskPath(doc, index) {
  let n = 0;
  let found = null;
  const walk = (node, stack) => {
    if (found) return;
    if (node.type === 'taskItem') {
      if (n === index) { found = [...stack, node]; return; }
      n++;
    }
    for (const c of node.content || []) walk(c, [...stack, node]);
  };
  walk(doc, []);
  return found;
}

/** Return a copy of the doc with to-do #index set to done/undone. */
export function setTaskChecked(doc, index, done) {
  const copy = structuredClone(doc);
  const path = findTaskPath(copy, index);
  if (!path) return null;
  const item = path[path.length - 1];
  item.attrs = { ...(item.attrs || {}), checked: !!done };
  return copy;
}

/** Return a copy of the doc with to-do #index (and anything nested under it) removed. */
export function removeTask(doc, index) {
  const copy = structuredClone(doc);
  const path = findTaskPath(copy, index);
  if (!path) return null;
  // Remove the node, then clean up any container left empty (lists can't be empty).
  for (let i = path.length - 1; i > 0; i--) {
    const node = path[i];
    const parent = path[i - 1];
    parent.content.splice(parent.content.indexOf(node), 1);
    if (parent.content.length) break;
    if (parent.type === 'doc' || parent.type === 'blockquote') { parent.content.push({ type: 'paragraph' }); break; }
    if (parent.type === 'taskItem' || parent.type === 'listItem') { parent.content.push({ type: 'paragraph' }); break; }
  }
  return copy;
}

const safeColor = (c) => (/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(String(c || '').trim()) ? String(c).trim() : null);
const safeHref = (u) => (/^(https?:|mailto:|tel:|#|\/)/i.test(u || '') ? u : '#');

function dateChipHtml(iso, { done } = {}) {
  let cls = 'date-chip';
  if (!done) {
    const today = todayISO();
    if (iso < today) cls += ' past';
    else if (iso === today) cls += ' today';
  }
  return `<span class="${cls}" data-date="${esc(iso)}">${esc(formatDate(iso))}</span>`;
}

/** Inline content (one paragraph) → HTML for the to-do list. Overdue/today dates are highlighted unless done. */
export function inlineHtml(nodes, { done = false } = {}) {
  let h = '';
  for (const n of nodes || []) {
    if (n.type === 'date') { h += dateChipHtml(n.attrs?.date, { done }); continue; }
    if (n.type === 'hardBreak') { h += ' '; continue; }
    if (n.type !== 'text') continue;
    let t = esc(n.text || '');
    for (const m of n.marks || []) {
      if (m.type === 'bold') t = `<strong>${t}</strong>`;
      else if (m.type === 'italic') t = `<em>${t}</em>`;
      else if (m.type === 'strike') t = `<s>${t}</s>`;
      else if (m.type === 'underline') t = `<u>${t}</u>`;
      else if (m.type === 'code') t = `<code>${t}</code>`;
      else if (m.type === 'highlight') t = `<mark${safeColor(m.attrs?.color) ? ` style="background-color:${safeColor(m.attrs.color)}"` : ''}>${t}</mark>`;
      else if (m.type === 'textStyle' && safeColor(m.attrs?.color)) t = `<span style="color:${safeColor(m.attrs.color)}">${t}</span>`;
      else if (m.type === 'link') t = `<a href="${esc(safeHref(m.attrs?.href))}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    }
    h += t;
  }
  return h;
}

/** Plain-text task (standalone tasks): escape, and show inserted dates as chips. */
export function plainTaskHtml(text, { done = false } = {}) {
  let h = '';
  let last = 0;
  for (const m of text.matchAll(DATE_LABEL_RE)) {
    const iso = parseLabel(m[0]);
    if (!iso) continue;
    h += esc(text.slice(last, m.index)) + dateChipHtml(iso, { done });
    last = m.index + m[0].length;
  }
  return h + esc(text.slice(last));
}
