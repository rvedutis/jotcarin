import { findDatesInText } from '/dates.js';

// Normalises pasted HTML (Google Docs, Word, web pages) into clean, semantic HTML
// the editor understands: inline CSS styles become <strong>/<em>/<u>/<s>/<mark>,
// Google Docs' flat/odd list nesting is rebuilt, and checklists become to-dos.

const BLOCK_SEL = 'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,table,tr,td,th,blockquote,pre';
const UNCHECKED = '☐□❏▢◻⬜';
const CHECKED = '☑☒✅✓✔■⬛';
const BOX_PREFIX = new RegExp(`^[\\s\\u00a0]*([${UNCHECKED}${CHECKED}])[\\s\\u00a0]*`);

const unwrap = (el) => el.replaceWith(...el.childNodes);

function parseColor(c) {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (s === 'transparent' || s === 'inherit' || s === 'initial' || s === 'currentcolor') return null;
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    let a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  return null;
}
const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** A highlight worth keeping: visible and not white. */
function highlightColor(bg) {
  const c = parseColor(bg);
  if (!c || c.a < 0.1) return null;
  if (c.r > 240 && c.g > 240 && c.b > 240) return null;
  return toHex(c);
}
/** A text colour worth keeping: actually coloured (black/greys are the default look). */
function textColor(col) {
  const c = parseColor(col);
  if (!c || c.a < 0.1) return null;
  if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 40) return null;
  return toHex(c);
}

function firstTextNode(el) {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) if (n.nodeValue.trim()) return n;
  return null;
}
/** If an element's text starts with a checkbox character, strip it and say whether it was ticked. */
function takeBoxPrefix(el) {
  const t = firstTextNode(el);
  const m = t && BOX_PREFIX.exec(t.nodeValue);
  if (!m) return null;
  t.nodeValue = t.nodeValue.slice(m[0].length);
  return CHECKED.includes(m[1]);
}

function markTask(li, checked) {
  li.setAttribute('data-type', 'taskItem');
  li.setAttribute('data-checked', String(!!checked));
}

/**
 * Google Docs puts nested lists as siblings (<ul><li/><ul><li/></ul></ul>) and marks depth with
 * aria-level. Rebuild proper nesting for every run of adjacent lists that carries aria-level.
 */
function rebuildLeveledLists(doc) {
  const outer = [...doc.body.querySelectorAll('ul,ol')].filter((l) => !l.parentElement.closest('ul,ol'));
  const seen = new Set();
  for (const first of outer) {
    if (seen.has(first)) continue;
    const run = [first];
    seen.add(first);
    let next = first.nextElementSibling;
    while (next && (next.tagName === 'UL' || next.tagName === 'OL')) { run.push(next); seen.add(next); next = next.nextElementSibling; }

    const items = [];
    const collect = (list, depth) => {
      for (const ch of [...list.children]) {
        if (ch.tagName === 'LI') {
          const kind = ch.getAttribute('data-type') === 'taskItem' ? 'task' : list.tagName === 'OL' ? 'ol' : 'ul';
          items.push({ li: ch, level: Number(ch.getAttribute('aria-level')) || depth, kind });
        } else if (ch.tagName === 'UL' || ch.tagName === 'OL') {
          collect(ch, depth + 1);
        }
      }
    };
    run.forEach((l) => collect(l, 1));
    if (!items.some((it) => it.li.hasAttribute('aria-level'))) continue; // not Google Docs style

    const out = doc.createDocumentFragment();
    const stack = [{ level: 0, li: null }];
    for (const it of items) {
      while (stack.length > 1 && stack[stack.length - 1].level > it.level) stack.pop();
      let top = stack[stack.length - 1];
      if (top.level === it.level && top.kind === it.kind) {
        top.list.appendChild(it.li);
        top.li = it.li;
        continue;
      }
      if (top.level === it.level) { stack.pop(); top = stack[stack.length - 1]; }
      const list = doc.createElement(it.kind === 'ol' ? 'ol' : 'ul');
      if (it.kind === 'task') list.setAttribute('data-type', 'taskList');
      (top.li || out).appendChild(list);
      list.appendChild(it.li);
      stack.push({ level: it.level, kind: it.kind, list, li: it.li });
    }
    run[0].before(out);
    run.forEach((l) => l.remove());
  }
}

/** Turn inline CSS (Google Docs/Word style) into semantic tags. */
function stylesToTags(doc) {
  for (const el of [...doc.body.querySelectorAll('[style]')]) {
    const st = el.style;
    const tag = el.tagName;
    // Only inline content: don't turn whole table cells / list items into marks.
    const hasBlocks = el.matches(BLOCK_SEL) && el.querySelector(BLOCK_SEL);
    if (!hasBlocks) {
      const wraps = [];
      const fw = (st.fontWeight || '').toLowerCase();
      const isHeading = /^H[1-6]$/.test(tag) || el.closest('h1,h2,h3,h4,h5,h6');
      if (!isHeading && (fw === 'bold' || fw === 'bolder' || Number(fw) >= 600)) wraps.push(['strong']);
      if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') wraps.push(['em']);
      const deco = `${st.textDecorationLine || ''} ${st.textDecoration || ''}`;
      if (/underline/.test(deco) && !el.closest('a')) wraps.push(['u']);
      if (/line-through/.test(deco) && !el.closest('li[data-checked="true"]')) wraps.push(['s']);
      const hl = highlightColor(st.backgroundColor);
      if (hl && !/^(TD|TH|TR|TABLE)$/.test(tag)) wraps.push(['mark', { 'data-color': hl }]);
      const col = textColor(st.color);
      if (col && !el.closest('a')) wraps.push(['span', { 'data-ab-color': col }]);
      if (st.verticalAlign === 'super') wraps.push(['sup']);
      if (st.verticalAlign === 'sub') wraps.push(['sub']);
      if (wraps.length) {
        let inner = null;
        let outerMost = null;
        for (const [name, attrs] of wraps) {
          const w = doc.createElement(name);
          for (const [k, v] of Object.entries(attrs || {})) w.setAttribute(k, v);
          if (inner) inner.appendChild(w); else outerMost = w;
          inner = w;
        }
        inner.append(...el.childNodes);
        el.appendChild(outerMost);
      }
    }
    el.removeAttribute('style');
  }
  // colours are re-applied as a clean, single property the editor's colour extension reads
  for (const s of doc.body.querySelectorAll('span[data-ab-color]')) {
    s.setAttribute('style', `color: ${s.getAttribute('data-ab-color')}`);
    s.removeAttribute('data-ab-color');
  }
}

/** Turn full dates written in text ("Mar 6, 2026", "06/10/2025") into date tags. */
function datesToTags(doc) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('a,code,pre,[data-type="date"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const hits = findDatesInText(text);
    if (!hits.length) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const h of hits) {
      if (h.index > last) frag.append(text.slice(last, h.index));
      const chip = doc.createElement('span');
      chip.setAttribute('data-type', 'date');
      chip.setAttribute('data-date', h.iso);
      chip.textContent = text.slice(h.index, h.index + h.length);
      frag.append(chip);
      last = h.index + h.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

export function cleanPastedHTML(html) {
  // Copy/paste inside the editor itself is already clean.
  if (html.includes('data-pm-slice')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  body.querySelectorAll('meta,style,script,link,title,colgroup,col,svg,video,audio,iframe,object,button,input:not([type=checkbox])').forEach((e) => e.remove());
  // Images: keep real pictures; drop Google Docs' checkbox icons, tracking pixels and unsafe sources.
  body.querySelectorAll('picture source').forEach((e) => e.remove());
  for (const img of [...body.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    const w = parseFloat(img.getAttribute('width') || img.style.width) || 0;
    const h = parseFloat(img.getAttribute('height') || img.style.height) || 0;
    const isIcon = img.getAttribute('aria-roledescription') === 'checkbox' || img.closest('li[role=checkbox], li[aria-checked]') || (w && w < 24 && h && h < 24);
    if (isIcon || !/^(https?:|data:image\/(png|jpe?g|gif|webp|avif|bmp);)/i.test(src)) { img.remove(); continue; }
    if (w >= 24) img.setAttribute('width', String(Math.round(w)));
  }
  try { body.querySelectorAll('o\\:p').forEach((e) => e.remove()); } catch { /* Word-only tag */ }

  // Google Docs wraps the whole selection in <b style="font-weight:normal" id="docs-internal-guid-…">
  body.querySelectorAll('b,strong').forEach((b) => {
    const fw = (b.style.fontWeight || '').toLowerCase();
    if (b.id?.startsWith('docs-internal-guid') || fw === 'normal' || (Number(fw) > 0 && Number(fw) < 600)) unwrap(b);
  });

  // Google redirect links → real destination
  body.querySelectorAll('a[href]').forEach((a) => {
    try {
      const u = new URL(a.getAttribute('href'), 'https://x.invalid');
      if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q')) a.setAttribute('href', u.searchParams.get('q'));
    } catch { /* leave as is */ }
  });

  // Headings: the editor has 3 levels; Docs "Title"/"Subtitle" styles
  body.querySelectorAll('h4,h5,h6').forEach((h) => { const n = doc.createElement('h3'); n.append(...h.childNodes); h.replaceWith(n); });
  body.querySelectorAll('p.title, p.subtitle').forEach((p) => { const n = doc.createElement(p.classList.contains('title') ? 'h1' : 'h2'); n.append(...p.childNodes); p.replaceWith(n); });

  // Checklists: Docs uses role="checkbox"/aria-checked; others use ☐ / ☑ characters or <input type=checkbox>.
  for (const li of body.querySelectorAll('li')) {
    if (li.getAttribute('data-type') === 'taskItem') continue;
    let checked = null;
    if (li.getAttribute('role') === 'checkbox' || li.hasAttribute('aria-checked')) checked = li.getAttribute('aria-checked') === 'true';
    const box = li.querySelector(':scope > input[type=checkbox], :scope > label > input[type=checkbox], :scope > p > input[type=checkbox]');
    if (box) { checked = box.hasAttribute('checked'); box.remove(); }
    const prefix = takeBoxPrefix(li);
    if (checked == null && prefix != null) checked = prefix;
    if (checked != null) markTask(li, checked);
  }
  body.querySelectorAll('input').forEach((e) => e.remove());
  // Paragraphs that start with ☐/☑ (outside lists) become to-do lists.
  for (const p of [...body.querySelectorAll('p')]) {
    if (p.closest('li')) continue;
    const checked = takeBoxPrefix(p);
    if (checked == null) continue;
    const li = doc.createElement('li');
    markTask(li, checked);
    const prev = p.previousElementSibling;
    let list;
    if (prev && prev.tagName === 'UL' && prev.getAttribute('data-type') === 'taskList' && prev.hasAttribute('data-ab-made')) list = prev;
    else { list = doc.createElement('ul'); list.setAttribute('data-type', 'taskList'); list.setAttribute('data-ab-made', ''); p.before(list); }
    list.appendChild(li);
    li.appendChild(p);
  }

  rebuildLeveledLists(doc);

  // Any remaining list placed directly inside a list belongs to the previous item.
  let stray;
  while ((stray = body.querySelector('ul > ul, ul > ol, ol > ul, ol > ol'))) {
    const prev = stray.previousElementSibling;
    if (prev && prev.tagName === 'LI') prev.appendChild(stray);
    else { const li = doc.createElement('li'); stray.replaceWith(li); li.appendChild(stray); }
  }

  // A list containing to-dos is a to-do list (and must be a <ul>).
  for (const list of [...body.querySelectorAll('ul,ol')]) {
    const items = [...list.children].filter((c) => c.tagName === 'LI');
    if (!items.some((li) => li.getAttribute('data-type') === 'taskItem') && list.getAttribute('data-type') !== 'taskList') continue;
    let ul = list;
    if (list.tagName === 'OL') { ul = doc.createElement('ul'); ul.append(...list.childNodes); list.replaceWith(ul); }
    ul.setAttribute('data-type', 'taskList');
    ul.removeAttribute('data-ab-made');
    for (const li of items) if (li.getAttribute('data-type') !== 'taskItem') markTask(li, false);
  }

  stylesToTags(doc);

  // Strip presentational attributes; keep only what carries meaning.
  datesToTags(doc);

  const KEEP = new Set(['href', 'data-type', 'data-checked', 'data-color', 'data-date', 'colspan', 'rowspan', 'start', 'style']);
  const KEEP_IMG = new Set(['src', 'alt', 'width']);
  for (const el of body.querySelectorAll('*')) {
    const keep = el.tagName === 'IMG' ? KEEP_IMG : KEEP;
    for (const { name } of [...el.attributes]) if (!keep.has(name)) el.removeAttribute(name);
    if (el.hasAttribute('style') && !(el.tagName === 'SPAN' && /^color: #[0-9a-f]{6}$/.test(el.getAttribute('style')))) el.removeAttribute('style');
  }
  // Google Docs marks empty lines with bare <br> between blocks — the editor already spaces paragraphs.
  for (const br of [...body.querySelectorAll('br')]) if (br.parentElement === body) br.remove();
  return body.innerHTML;
}

/** Does plain text look like Markdown worth converting? */
export function looksLikeMarkdown(text) {
  if (!text || !text.includes('\n') && text.length < 3) return false;
  return /^\s{0,3}(#{1,6}\s|[-*+]\s+\S|\d{1,3}[.)]\s+\S|>\s|```|\|.+\|\s*$)/m.test(text)
    || /\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\s]+\)/.test(text);
}
