// The "@" popup, shared by the rich editor and plain text inputs.
// "@" opens a menu of commands; "@date …" switches to natural-language date suggestions.
import { suggestDates, formatDate, todayISO } from './dates.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (p) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
export const AT_ICONS = {
  date: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>'),
  todo: svg('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>'),
  table: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  heading: svg('<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>'),
  bullet: svg('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
  numbered: svg('<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  quote: svg('<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>'),
  divider: svg('<path d="M5 12h14"/>'),
  code: svg('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  highlight: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
};

/** Split an @-query into either a command search or a date query ("date next fri"). */
export function parseAtQuery(query) {
  const q = String(query || '').replace(/^\s+/, '');
  const m = /^date(?:\s+(.*)|\s*)$/i.exec(q);
  if (m) return { mode: 'date', dateQuery: m[1] || '' };
  return { mode: 'commands', commandQuery: q.toLowerCase() };
}

/** Filter a command list ({ id, label, hint, aliases }) by what was typed after "@". */
export function matchCommands(commands, q) {
  if (/\s/.test(q)) return [];
  if (!q) return commands;
  // Rank: name starts with it > an alias does > name contains it.
  const named = commands.filter((c) => c.id.startsWith(q) || c.label.toLowerCase().startsWith(q));
  const aliased = commands.filter((c) => !named.includes(c) && (c.aliases || []).some((w) => w.startsWith(q)));
  const contains = commands.filter((c) => !named.includes(c) && !aliased.includes(c) && c.label.toLowerCase().includes(q));
  return [...named, ...aliased, ...contains];
}

/** Items for an @-query: commands, or (after "@date") date suggestions. */
export function atItems(query, commands) {
  const p = parseAtQuery(query);
  if (p.mode === 'date') {
    return { mode: 'date', query: p.dateQuery, items: suggestDates(p.dateQuery).map((d) => ({ ...d, kind: 'date' })) };
  }
  return { mode: 'commands', query: p.commandQuery, items: matchCommands(commands, p.commandQuery).map((c) => ({ ...c, kind: 'command' })) };
}

export class AtPopup {
  constructor({ onPick }) {
    this.onPick = onPick;
    this.items = [];
    this.index = 0;
    this.mode = 'commands';
    this.query = '';
    this.el = document.createElement('div');
    this.el.className = 'date-pop';
    this.el.setAttribute('role', 'listbox');
    this.el.hidden = true;
    document.body.appendChild(this.el);
    // mousedown (not click) so the editor/input never loses focus
    this.el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const b = e.target.closest('[data-i]');
      if (b) this.pick(Number(b.dataset.i));
    });
    this.el.addEventListener('mousemove', (e) => {
      const b = e.target.closest('[data-i]');
      if (b && Number(b.dataset.i) !== this.index) { this.index = Number(b.dataset.i); this.render(); }
    });
  }

  update({ items, mode, query }, rect) {
    const key = (it) => it.iso || it.id;
    const sameList = mode === this.mode && items.length === this.items.length && items.every((it, i) => key(it) === key(this.items[i]));
    this.items = items;
    this.mode = mode;
    this.query = query ?? '';
    if (!sameList) this.index = 0;
    this.render();
    if (rect) this.position(rect);
  }

  render() {
    const q = this.query.trim();
    if (!this.items.length) {
      // In date mode, coach on short queries; in command mode just get out of the way.
      if (this.mode !== 'date' || !q || q.length > 20) { this.hide(); return; }
      this.el.innerHTML = `<div class="date-pop-head">${AT_ICONS.date}<span>No date matches “${esc(q)}”</span></div>
        <div class="date-pop-help">Try <b>today</b>, <b>tomorrow</b>, <b>last thu</b>, <b>next fri</b>, <b>in 3 days</b>, <b>nov 20</b>, <b>11/20</b></div>`;
      this.el.hidden = false;
      return;
    }
    const head = this.mode === 'date'
      ? `${AT_ICONS.date}<span>${q ? 'Insert date' : 'Insert date — keep typing: “tomorrow”, “next fri”, “nov 20”…'}</span>`
      : `<span class="at-sign">@</span><span>Insert…</span>`;
    const rows = this.items.map((it, i) => (it.kind === 'date'
      ? `<div class="date-opt${i === this.index ? ' on' : ''}" role="option" aria-selected="${i === this.index}" data-i="${i}">
          <span class="date-opt-label">${esc(it.label)}</span><span class="date-opt-hint">${esc(it.hint)}</span></div>`
      : `<div class="date-opt cmd${i === this.index ? ' on' : ''}" role="option" aria-selected="${i === this.index}" data-i="${i}">
          <span class="cmd-icon">${AT_ICONS[it.icon] || ''}</span><span class="date-opt-label">${esc(it.label)}</span><span class="date-opt-hint">${esc(it.hint || '')}</span></div>`)).join('');
    const foot = `<div class="date-pop-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> ${this.mode === 'date' ? 'insert' : 'select'}</span><span><kbd>Esc</kbd> dismiss</span>${this.mode === 'date' ? '<span class="tz">Eastern time</span>' : ''}</div>`;
    this.el.innerHTML = `<div class="date-pop-head">${head}</div><div class="date-pop-list">${rows}</div>${foot}`;
    this.el.hidden = false;
    this.el.querySelector('.date-opt.on')?.scrollIntoView({ block: 'nearest' });
  }

  position(rect) {
    const el = this.el;
    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 200;
    const left = Math.max(8, Math.min(rect.left, innerWidth - w - 8));
    let top = rect.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /** Returns true if the key was handled. */
  onKeyDown(e) {
    if (this.el.hidden || !this.items.length) return false;
    if (e.key === 'ArrowDown') { this.index = (this.index + 1) % this.items.length; this.render(); return true; }
    if (e.key === 'ArrowUp') { this.index = (this.index - 1 + this.items.length) % this.items.length; this.render(); return true; }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) { this.pick(this.index); return true; }
    return false;
  }

  get visible() { return !this.el.hidden; }
  pick(i) { const it = this.items[i]; if (it) this.onPick(it); }
  hide() { this.el.hidden = true; }
  destroy() { this.el.remove(); }
}

const INPUT_COMMANDS = [{ id: 'date', label: 'Date', icon: 'date', hint: 'then type: today, next fri, nov 20…' }];

/**
 * Add "@date" autocomplete (and Ctrl+; for today) to a plain <input>.
 * Dates are inserted as text like "Fri, Nov 13, 2026" (shown as date tags in the to-do list).
 */
export function attachDateAutocomplete(input) {
  let dismissedAt = -1;
  let match = null;
  const replaceMatch = (text) => {
    const v = input.value;
    input.value = v.slice(0, match.start) + text + v.slice(match.end);
    const caret = match.start + text.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const popup = new AtPopup({
    onPick: (item) => {
      if (!match) return;
      if (item.kind === 'command') { replaceMatch('@date '); return; } // only "date" exists here
      popup.hide();
      replaceMatch(`${formatDate(item.iso)} `);
      match = null;
    },
  });

  const caretRect = (pos) => {
    const r = input.getBoundingClientRect();
    const cs = getComputedStyle(input);
    const ctx = (caretRect.ctx ||= document.createElement('canvas').getContext('2d'));
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const x = r.left + parseFloat(cs.paddingLeft) + ctx.measureText(input.value.slice(0, pos)).width - input.scrollLeft;
    return { left: Math.min(x, r.right - 20), right: x, top: r.top, bottom: r.bottom };
  };

  const check = () => {
    const pos = input.selectionStart;
    if (pos == null || pos !== input.selectionEnd) { popup.hide(); match = null; return; }
    const before = input.value.slice(0, pos);
    const m = /(^|[\s([{"'“‘])@([^@\n]{0,40})$/.exec(before);
    if (!m || /^\s/.test(m[2]) || /\s{2}/.test(m[2])) { popup.hide(); match = null; dismissedAt = -1; return; }
    const start = pos - m[2].length - 1;
    if (start === dismissedAt) { popup.hide(); return; }
    match = { start, end: pos };
    popup.update(atItems(m[2], INPUT_COMMANDS), caretRect(start));
  };

  input.addEventListener('input', check);
  input.addEventListener('click', check);
  input.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) check(); });
  input.addEventListener('blur', () => { popup.hide(); match = null; });
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ';') {
      e.preventDefault();
      input.setRangeText(`${formatDate(todayISO())} `, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (!popup.visible || !match) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      dismissedAt = match.start;
      popup.hide();
      return;
    }
    if (popup.onKeyDown(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  return { destroy: () => popup.destroy() };
}
