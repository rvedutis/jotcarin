// Small, safe markdown renderer + task-list helpers.
// All input is HTML-escaped before formatting is applied.

export const TASK_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\](?:([ \t]+)(.*))?$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^\s*>/;

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Find every `- [ ] task` line (outside code fences). Line numbers are 0-based. */
export function parseTasks(content) {
  const lines = content.split('\n');
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE_RE.exec(l);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = TASK_RE.exec(l);
    if (m) out.push({ line: i, pre: m[1], done: m[2] !== ' ', gap: m[3] || ' ', text: m[4] || '', raw: l });
  }
  return out;
}

/** Return new content with the task on `t.line` rewritten. */
export function setTaskLine(content, t, { done = t.done, text = t.text } = {}) {
  const lines = content.split('\n');
  lines[t.line] = `${t.pre}[${done ? 'x' : ' '}]${t.gap}${text}`;
  return lines.join('\n');
}

// ------------------------------------------------------------------ inline
function safeUrl(url) {
  const u = url.trim();
  if (/^(https?:|mailto:|tel:)/i.test(u) || /^[#/.]/.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '#'; // javascript:, data:, etc.
  return 'https://' + u;
}

export function inline(text, { links = true } = {}) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = text.replace(/\u0000/g, '');

  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  // backslash escapes: \* \_ \# … are literal characters
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, ch) => hold(esc(ch)));
  if (links) {
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) =>
      hold(`<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${inline(label, { links: false })}</a>`));
    s = s.replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/g, (url) =>
      hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
  }
  s = esc(s);
  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/\*(?=\S)([^*]*?\S)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[+i]);
}

// ------------------------------------------------------------------ blocks
const indentWidth = (ws) => ws.replace(/\t/g, '    ').length;
const isBlockStart = (l) => FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l);

// GFM tables: a row of cells followed by a |---|---| separator line
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]);
const splitRow = (l) => {
  const cells = [];
  let cur = '';
  const s = l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (s[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
};

let forEditor = false;
/** Render markdown as HTML the rich-text editor can import (used to migrate old notes). */
export function renderForEditor(src) {
  forEditor = true;
  try { return render(src); } finally { forEditor = false; }
}

export function render(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  return renderBlocks(lines, 0, true);
}

function renderBlocks(lines, offset, interactive) {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = FENCE_RE.exec(line);
    if (m) {
      const ch = m[1][0];
      const buf = [];
      i++;
      while (i < lines.length) {
        const f = FENCE_RE.exec(lines[i]);
        if (f && f[1][0] === ch && !lines[i].trim().slice(f[1].length).trim()) { i++; break; }
        buf.push(lines[i]);
        i++;
      }
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }

    if ((m = HEADING_RE.exec(line))) {
      const lvl = m[1].length;
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
      i++;
      continue;
    }

    if (HR_RE.test(line)) { html += '<hr>'; i++; continue; }

    if (isTableStart(lines, i)) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      const width = Math.max(...rows.map((r) => r.length));
      html += `<table><tbody>${rows.map((r, ri) => `<tr>${Array.from({ length: width }, (_, ci) => {
        const tag = ri === 0 ? 'th' : 'td';
        return `<${tag}><p>${inline(r[ci] ?? '')}</p></${tag}>`;
      }).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const start = i;
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) { buf.push(lines[i].replace(/^\s*>[ \t]?/, '')); i++; }
      html += `<blockquote>${renderBlocks(buf, offset + start, false)}</blockquote>`;
      continue;
    }

    if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const lm = LIST_RE.exec(l);
        if (lm) {
          items.push({ indent: indentWidth(lm[1]), marker: lm[2], text: lm[3].replace(/\s+$/, ''), line: offset + i, extra: [] });
          i++;
          continue;
        }
        if (!l.trim()) {
          // A blank line continues the list only if another list item follows.
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && LIST_RE.test(lines[j])) { i = j; continue; }
          break;
        }
        if (/^\s+\S/.test(l) && items.length && !isBlockStart(l)) {
          items[items.length - 1].extra.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      html += renderList(items, interactive);
      continue;
    }

    // paragraph
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && (isBlockStart(lines[i]) || isTableStart(lines, i)))) {
      buf.push(inline(lines[i].trim()));
      i++;
      if (buf.length === 1 && isBlockStart(lines[i - 1])) break; // safety: never loop on a block start
    }
    html += `<p>${buf.join('<br>')}</p>`;
  }
  return html;
}

function renderList(items, interactive) {
  const root = { indent: -1, children: [] };
  const stack = [root];
  for (const it of items) {
    it.children = [];
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].children.push(it);
    stack.push(it);
  }
  return renderChildren(root.children, interactive);
}

function renderChildren(children, interactive) {
  let html = '';
  let k = 0;
  while (k < children.length) {
    const isTask = (c) => /^\[[ xX]\](?:[ \t]|$)/.test(c.text);
    const kind = (c) => (forEditor && isTask(c) ? 'task' : /\d/.test(c.marker) ? 'ol' : 'ul');
    const groupKind = kind(children[k]);
    const ordered = groupKind === 'ol';
    const group = [];
    while (k < children.length && kind(children[k]) === groupKind) group.push(children[k++]);
    const hasTask = group.some(isTask);
    if (groupKind === 'task') {
      html += `<ul data-type="taskList">${group.map((it) => renderItem(it, interactive)).join('')}</ul>`;
      continue;
    }
    const start = ordered ? parseInt(group[0].marker, 10) : 1;
    const tag = ordered ? 'ol' : 'ul';
    html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}${hasTask ? ' class="has-tasks"' : ''}>`;
    for (const it of group) html += renderItem(it, interactive);
    html += `</${tag}>`;
  }
  return html;
}

function renderItem(it, interactive) {
  const tm = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(it.text);
  const extra = it.extra.length ? '<br>' + it.extra.map((e) => inline(e)).join('<br>') : '';
  const kids = it.children.length ? renderChildren(it.children, interactive) : '';
  if (forEditor) {
    return tm
      ? `<li data-type="taskItem" data-checked="${tm[1] !== ' '}"><p>${inline(tm[2] || '')}${extra}</p>${kids}</li>`
      : `<li><p>${inline(it.text)}${extra}</p>${kids}</li>`;
  }
  if (tm) {
    const done = tm[1] !== ' ';
    return `<li class="task-item${done ? ' done' : ''}"><span class="md-check"><input type="checkbox" data-line="${it.line}"${done ? ' checked' : ''}${interactive ? '' : ' disabled'}><span>${inline(tm[2] || '')}${extra}</span></span>${kids}</li>`;
  }
  return `<li>${inline(it.text)}${extra}${kids}</li>`;
}
