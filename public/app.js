import { renderForEditor, esc } from './markdown.js';
import { parseDoc, docTasks, docText, setTaskChecked, removeTask, updateTask, inlineHtml, plainTaskHtml, tagDatesInDoc, markUndatedTasks } from './doc.js';
import { formatDate, todayISO, daysFromToday, parseExact, suggestDates } from './dates.js';
import { attachDateAutocomplete } from './datepopup.js';
import { createNoteEditor, htmlToDoc, selectFirstMatch, selectTask, insertImageFiles } from './vendor/editor.js';

/* =====================================================================
   Utilities
   ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function uid() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* insecure context */ }
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Names of things this app keeps in browser storage. */
const KEYS = {
  unsaved: 'tk:unsaved', last: 'tk:last', expanded: 'tk:expanded', showCompleted: 'tk:showCompleted',
  sidebarPinned: 'tk:sidebarPinned', tasksPinned: 'tk:tasksPinned', theme: 'tk:theme', shortcuts: 'tk:shortcuts',
  sidebarWidth: 'tk:sidebarWidth', tasksWidth: 'tk:tasksWidth', boardFilter: 'tk:boardFilter',
};
// One-time carry-over from the app's earlier names — Jotcairn ("jc:" keys) and Actionbase ("ab:") —
// including the journal of unsaved edits. The newest old value wins; old keys are removed once copied.
try {
  for (const key of Object.values(KEYS)) {
    for (const prefix of ['jc:', 'ab:']) {
      const old = prefix + key.slice(3);
      const v = localStorage.getItem(old);
      if (v === null) continue;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, v);
      localStorage.removeItem(old);
    }
  }
} catch { /* storage unavailable */ }
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* =====================================================================
   Password lock. With no password set, Taskule is simply open. With one
   (Settings → Password), the server refuses every API call (401) until
   you unlock; any request that hits a 401 waits for the lock screen and
   is then retried, so nothing you typed is lost if the lock appears mid-edit.
   ===================================================================== */
const nativeFetch = window.fetch.bind(window);
/** Whether a password is set (known from the server; updated by Settings). */
const security = { hasPassword: false };
const lock = {
  waiting: null,
  /** Show the lock screen; resolves once the right password is entered. */
  require() {
    if (this.waiting) return this.waiting;
    this.waiting = new Promise((resolve) => {
      const screen = $('#lock');
      const form = $('#lock-form');
      const input = $('#lock-password');
      const err = $('#lock-error');
      const btn = $('#lock-submit');
      $('#app').inert = true;
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      screen.hidden = false;
      input.value = '';
      input.classList.remove('bad');
      err.textContent = '';
      nativeFetch('/api/session', { cache: 'no-store' }).then((r) => r.json()).then((st) => { if (st.error) err.textContent = st.error; }).catch(() => {});
      setTimeout(() => input.focus());
      input.oninput = () => { input.classList.remove('bad'); err.textContent = ''; };
      const fail = (msg) => {
        err.textContent = msg;
        input.classList.add('bad');
        input.select();
        form.classList.remove('shake');
        void form.offsetWidth; // restart the animation
        form.classList.add('shake');
      };
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Unlocking…';
        try {
          const res = await nativeFetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: input.value }),
          });
          if (res.ok) {
            screen.hidden = true;
            $('#app').inert = health.state !== 'ok'; // still covered if the server is down
            form.onsubmit = null;
            this.waiting = null;
            resolve();
            if (booted && pendingQuickCapture) { pendingQuickCapture = false; setTimeout(() => openScratchpad({ newLine: true })); }
            return;
          }
          const msg = (await res.json().catch(() => null))?.error;
          fail(res.status === 401 ? 'That password isn’t right. Try again.' : msg || `Couldn’t unlock (error ${res.status}).`);
        } catch {
          err.textContent = 'Can’t reach the Taskule server. Is it running?';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Unlock';
        }
      };
    });
    return this.waiting;
  },
  /** Lock now: save anything pending, end the session, and reload into the lock screen. */
  async now() {
    if (!security.hasPassword) {
      toast('Taskule has no password, so there’s nothing to lock. Set one in Settings → Password.', { action: 'Settings', onAction: () => settingsDialog() });
      return;
    }
    flushNotes();
    await Promise.race([sync.idle(), sleep(5000)]);
    try { await nativeFetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* reload locks anyway if the cookie is gone */ }
    location.reload();
  },
};
function isLockedApi(input) {
  try {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/api/') && u.pathname !== '/api/login';
  } catch { return false; }
}
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  if (res.status !== 401 || !isLockedApi(input)) return res;
  await lock.require();
  // The original timeout may have run out while the lock screen was up.
  const retryInit = init?.signal?.aborted ? { ...init, signal: undefined } : init;
  return nativeFetch(input, retryInit);
};

/* =====================================================================
   Icons
   ===================================================================== */
const P = {
  chevron: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  folderPlus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  note: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  notePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  move: '<path d="M15 14l5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  listOrdered: '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  listTodo: '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  quote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
  minus: '<path d="M5 12h14"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  board: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  panelRightClose: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>',
  panelRightOpen: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  panelClose: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  panelOpen: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  text: '<path d="M17 6H3"/><path d="M21 12H3"/><path d="M15.1 18H3"/>',
  sticky: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
  moveOut: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="m15 3 6 0 0 6"/><path d="M10 14 21 3"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  arrow: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
  codeBlock: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  sparkle: '<path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m5.6 5.6 2.1 2.1"/><path d="m16.3 16.3 2.1 2.1"/><path d="m5.6 18.4 2.1-2.1"/><path d="m16.3 7.7 2.1-2.1"/>',
};
const I = new Proxy({}, { get: (_, k) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[k] || ''}</svg>` });

/* =====================================================================
   State
   ===================================================================== */
const S = {
  folders: new Map(),
  notes: new Map(),
  tasks: new Map(),
  view: { type: 'loading' },
  selectedFolderId: null,
  expanded: new Set(store.get(KEYS.expanded, [])),
  showCompleted: store.get(KEYS.showCompleted, true),
  renaming: null, // folder id being renamed inline
  treeDirty: false,
};
const saveExpanded = () => store.set(KEYS.expanded, [...S.expanded]);
const normalize = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

function applyState(d) {
  S.folders = new Map(d.folders.map((f) => [f.id, f]));
  S.notes = new Map(d.notes.map((n) => [n.id, { ...n, content: normalize(n.content) }]));
  S.tasks = new Map(d.tasks.map((t) => [t.id, t]));
  for (const id of [...S.expanded]) if (!S.folders.has(id)) S.expanded.delete(id);
  if (S.selectedFolderId && !S.folders.has(S.selectedFolderId)) S.selectedFolderId = null;
}

const noteTitle = (n) => (n.title || '').trim() || 'Untitled';
/** The permanent quick-capture note: pinned above the folders, can't be moved, renamed or deleted. */
const SCRATCH = 'scratchpad';
const isScratch = (id) => id === SCRATCH;
const HOME = `#/note/${SCRATCH}`;
function folderChain(fid) {
  const out = [];
  let f = S.folders.get(fid);
  for (let guard = 0; f && guard < 200; guard++) { out.unshift(f); f = S.folders.get(f.parentId); }
  return out;
}
const folderPath = (fid) => folderChain(fid).map((f) => f.name).join(' / ');
function isFolderWithin(fid, ancestorId) {
  let f = S.folders.get(fid);
  for (let guard = 0; f && guard < 200; guard++) {
    if (f.id === ancestorId) return true;
    f = S.folders.get(f.parentId);
  }
  return false;
}
function notesUnder(fid) { return [...S.notes.values()].filter((n) => n.folderId && isFolderWithin(n.folderId, fid)); }

/** Convert a legacy markdown note into a rich-text document. */
function legacyToDoc(markdown) {
  try { return htmlToDoc(renderForEditor(markdown)); } catch { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }] }; }
}

// Parsed document, to-dos and plain text per note — recomputed only when the content changes.
const docCache = new Map();
function noteInfo(note) {
  const c = docCache.get(note.id);
  if (c && c.content === note.content) return c;
  const doc = parseDoc(note.content) ?? legacyToDoc(note.content);
  const info = { content: note.content, doc, tasks: docTasks(doc), text: docText(doc) };
  docCache.set(note.id, info);
  return info;
}
/** To-dos with text (empty checkboxes are ignored). Each keeps its document index. */
const noteTasks = (note) => noteInfo(note).tasks.filter((t) => t.text);
function findNoteTask(note, index, text) {
  const tasks = noteTasks(note);
  return tasks.find((t) => t.index === index && t.text === text) || tasks.find((t) => t.text === text) || null;
}
/**
 * Sidebar order: items you've arranged (they have a position) first, in that order; the rest
 * after them alphabetically. Folders are listed before notes at each level.
 */
const byOrder = (name) => (a, b) => ((a.position ?? Infinity) - (b.position ?? Infinity)) || collator.compare(name(a), name(b)) || ((a.createdAt || 0) - (b.createdAt || 0));
const parentOf = (kind, x) => {
  const p = kind === 'folder' ? x.parentId : x.folderId;
  return p && S.folders.has(p) ? p : null;
};
function childFolders(pid) { return [...S.folders.values()].filter((x) => parentOf('folder', x) === (pid || null)).sort(byOrder((x) => x.name)); }
function childNotes(fid) { return [...S.notes.values()].filter((x) => !isScratch(x.id) && parentOf('note', x) === (fid || null)).sort(byOrder(noteTitle)); }
/** Notes in sidebar order (Scratchpad first): folders depth-first, each folder's notes after its subfolders' as shown. */
function treeOrderNotes() {
  const out = [];
  const walk = (pid) => {
    for (const fo of childFolders(pid)) walk(fo.id);
    out.push(...childNotes(pid));
  };
  if (S.notes.has(SCRATCH)) out.push(S.notes.get(SCRATCH));
  walk(null);
  return out;
}

/**
 * Put a folder or note at a spot in the sidebar: inside `parentId`, before/after `refId`
 * (or at the end). Positions are renumbered for that list and saved; a change of folder is
 * saved with it.
 */
function placeItem(kind, id, parentId, refId = null, where = 'end') {
  const item = kind === 'folder' ? S.folders.get(id) : S.notes.get(id);
  if (!item || (kind === 'note' && isScratch(id))) return false;
  parentId = parentId || null;
  if (kind === 'folder' && parentId && (parentId === id || isFolderWithin(parentId, id))) {
    toast("A folder can't go inside itself", { type: 'error' });
    return false;
  }
  const siblings = (kind === 'folder' ? childFolders(parentId) : childNotes(parentId)).filter((x) => x.id !== id);
  let idx = siblings.length;
  if (refId) {
    const i = siblings.findIndex((x) => x.id === refId);
    if (i >= 0) idx = where === 'before' ? i : i + 1;
  }
  const order = [...siblings.slice(0, idx), item, ...siblings.slice(idx)];
  const moved = parentOf(kind, item) !== parentId;
  flushNotes();
  if (moved) {
    if (kind === 'folder') item.parentId = parentId; else item.folderId = parentId;
    if (parentId) { S.expanded.add(parentId); saveExpanded(); }
  }
  order.forEach((x, i) => {
    const pos = (i + 1) * 1024;
    const isItem = x.id === id;
    if (x.position === pos && !(isItem && moved)) return;
    x.position = pos;
    const body = isItem && moved ? { [kind === 'folder' ? 'parentId' : 'folderId']: parentId, position: pos } : { position: pos };
    sync.push({ method: 'PATCH', url: `/api/${kind === 'folder' ? 'folders' : 'notes'}/${x.id}`, body });
  });
  if (kind === 'note' && moved && S.view.type === 'note' && S.view.id === id) { S.selectedFolderId = parentId; renderCrumbs(); }
  refreshAll();
  return true;
}

/** Move up/down one place among its siblings (right-click menu, Alt+↑/↓). */
function nudgeItem(kind, id, dir) {
  const item = kind === 'folder' ? S.folders.get(id) : S.notes.get(id);
  if (!item) return;
  const pid = parentOf(kind, item);
  const sibs = kind === 'folder' ? childFolders(pid) : childNotes(pid);
  const i = sibs.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  placeItem(kind, id, pid, sibs[j].id, dir < 0 ? 'before' : 'after');
  setTimeout(() => $(`.tree-row[data-kind="${kind}"][data-id="${id}"]`)?.focus());
}

function sortedNotes() { return treeOrderNotes(); }

/* =====================================================================
   Sync — a single ordered queue of writes with retry. Nothing is lost
   if the server blips; writes are replayed in order once it is back.
   ===================================================================== */
const sync = {
  queue: [],
  busy: false,
  failures: 0,
  seq: 0, // bumps on every local mutation
  dirtyNotes: new Set(),
  noteTimer: null,

  push(op) {
    this.seq++;
    const tail = this.queue[this.queue.length - 1];
    if (op.key && tail && tail.key === op.key && !tail.inFlight) {
      tail.body = op.body; // coalesce consecutive saves of the same thing
      tail.journal = op.journal;
    } else {
      this.queue.push(op);
    }
    updateStatus();
    this.run();
  },

  async run() {
    if (this.busy) return;
    this.busy = true;
    let needResync = false;
    while (this.queue.length) {
      const op = this.queue[0];
      op.inFlight = true;
      let serverError = null;
      try {
        let payload = op.body;
        // Text saves say which version they were based on, so they can't overwrite newer text
        // saved from another window (the server answers 409 instead).
        if (op.versioned && payload) payload = { ...payload, baseVersion: S.notes.get(op.noteId)?.version ?? 0 };
        const body = payload === undefined ? undefined : JSON.stringify(payload);
        const res = await fetch(op.url, {
          method: op.method,
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(20000), // a hung request must never block the queue
        });
        if (res.ok) {
          this.queue.shift();
          this.failures = 0;
          health.saveOk();
          if (op.noteId) {
            const row = await res.json().catch(() => null);
            const n = S.notes.get(op.noteId);
            if (n && Number.isInteger(row?.version)) n.version = row.version;
          }
          if (op.journal) journal.clear(op.journal.id, op.journal.at);
          updateStatus();
          continue;
        }
        const errBody = await res.json().catch(() => null);
        const msg = errBody?.error || `Request failed (${res.status})`;
        if (res.status >= 500 || res.status === 408 || res.status === 429) { serverError = msg; throw new Error(msg); }
        this.queue.shift();
        if (res.status === 409 && op.noteId && errBody?.note) {
          resolveConflict(op.noteId, errBody.note);
          continue;
        }
        if (res.status === 404 && op.method === 'DELETE') continue; // already gone
        if (op.noteId && op.versioned) {
          // A note's text was refused. Never throw the text away: it stays on screen and in
          // this computer's unsaved-changes journal, and you're told plainly.
          const n = S.notes.get(op.noteId);
          toast(`Couldn’t save “${n ? noteTitle(n) : 'a note'}”: ${msg}. Your text is still here — copy it somewhere safe before closing.`, { type: 'error', sticky: true });
          continue;
        }
        // Any other refused change won't fix itself by retrying — tell you, and reload from the server.
        toast(`A change couldn’t be saved: ${msg}`, { type: 'error', sticky: true });
        needResync = true;
      } catch {
        op.inFlight = false;
        this.failures++;
        health.saveFailed(serverError ? 'server' : 'network', serverError);
        updateStatus();
        // Local server: retry quickly (1s, 2s, then every 3s) — and immediately on focus/click/online.
        await this.waitRetry(Math.min(1000 * 2 ** (this.failures - 1), 3000));
      }
    }
    this.busy = false;
    updateStatus();
    if (needResync) resync(true);
  },

  waitRetry(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
    });
  },
  retryNow() { this.wake?.(); },

  get pending() { return this.queue.length > 0 || this.dirtyNotes.size > 0; },

  idle() {
    return new Promise((resolve) => {
      const check = () => (!this.pending ? resolve() : setTimeout(check, 50));
      check();
    });
  },
};

/**
 * The server refused a save because the note was changed somewhere else (another window or
 * tab) since this window loaded it. Keep both: the other version stays as the note, and the
 * text from this window becomes a new note next to it. Nothing is overwritten or lost.
 */
function resolveConflict(noteId, server) {
  const local = S.notes.get(noteId);
  if (!local) return;
  sync.queue = sync.queue.filter((o) => o.inFlight || o.noteId !== noteId);
  sync.dirtyNotes.delete(noteId);
  const mine = { title: local.title, content: local.content, folderId: local.folderId };
  Object.assign(local, { title: server.title, content: normalize(server.content), version: server.version, updatedAt: server.updatedAt, folderId: server.folderId });
  journal.clear(noteId);
  if (S.view.type === 'note' && S.view.id === noteId) {
    loadIntoEditor(local);
    const t = $('#note-title');
    if (t) t.value = local.title;
    updateNoteFoot();
  }
  if (mine.content !== local.content || mine.title !== local.title) {
    const now = Date.now();
    const copy = {
      id: uid(),
      folderId: isScratch(noteId) ? null : (mine.folderId && S.folders.has(mine.folderId) ? mine.folderId : null),
      title: `${(mine.title || '').trim() || 'Untitled'} (my copy ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`.slice(0, 500),
      content: mine.content,
      createdAt: now,
      updatedAt: now,
    };
    S.notes.set(copy.id, copy);
    sync.push({ method: 'POST', url: '/api/notes', body: { id: copy.id, folderId: copy.folderId, title: copy.title, content: copy.content } });
    toast(`“${noteTitle(local)}” was changed in another window while you were editing it here. That version is kept, and your edits were saved as “${copy.title}”.`, {
      type: 'error', sticky: true, action: 'Open my copy', onAction: () => navigate(`#/note/${copy.id}`),
    });
  }
  refreshAll();
}

/* =====================================================================
   Health — Taskule must never let you type into something that can't
   save. The server is checked every few seconds (and right away when a
   save fails). If it can't be reached, saving keeps failing, or the
   database reports a problem, the app is covered and editing is paused
   until it's fixed. Unsaved text is kept on this computer meanwhile.
   ===================================================================== */
const health = {
  state: 'ok', // ok | down (can't reach) | failing (reachable, saves fail) | db (database problem)
  fails: 0,
  saveFails: 0,
  detail: '',
  timer: null,
  warnedBackup: null,
  start() {
    $('#outage-retry').addEventListener('click', () => { this.check(); sync.retryNow(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.schedule(200); });
    this.schedule(3000);
  },
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), ms);
  },
  async check() {
    clearTimeout(this.timer);
    let report = null;
    let err = '';
    try {
      const r = await nativeFetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (r.ok) report = await r.json();
      else err = `The server answered with error ${r.status}`;
    } catch (e) {
      err = e?.name === 'TimeoutError' ? 'The server didn’t answer in time.' : 'No connection to the server.';
    }
    if (report?.ok) {
      this.fails = 0;
      if (this.state === 'down' || this.state === 'db') this.set('ok');
    } else if (report) {
      this.set('db', report.problem || 'The database reported a problem.');
    } else {
      this.fails++;
      if (this.fails >= 2) this.set('down', err);
    }
    if (report?.backupProblem && report.backupProblem !== this.warnedBackup) {
      this.warnedBackup = report.backupProblem;
      toast(`${report.backupProblem}. Your notes are fine, but take a manual backup (Download → Database backup) and check the server log.`, { type: 'error', sticky: true });
    }
    const healthy = this.state === 'ok';
    this.schedule(!healthy || this.fails ? 1500 : document.visibilityState === 'visible' ? 5000 : 20000);
  },
  /** From the save queue: a save failed (network = no answer; server = it answered with an error). */
  saveFailed(kind, msg) {
    if (kind === 'network') {
      this.schedule(300); // confirm quickly with a health check
      return;
    }
    this.saveFails++;
    if (this.saveFails >= 3) this.set('failing', msg);
  },
  saveOk() {
    this.saveFails = 0;
    if (this.state === 'failing') this.set('ok');
  },
  set(state, detail = '') {
    const was = this.state;
    this.state = state;
    this.detail = detail;
    const box = $('#outage');
    if (state === 'ok') {
      box.hidden = true;
      $('#app').inert = !$('#lock').hidden;
      if (was !== 'ok') {
        sync.retryNow();
        resync();
        toast('Reconnected — saving resumed.', { type: 'success' });
      }
      return;
    }
    if (was === 'ok') {
      flushNotes(); // whatever was just typed goes into the queue and this computer's journal
      editor?.view.dom.blur();
      closeMenu();
    }
    const electron = /Electron/i.test(navigator.userAgent);
    const copy = {
      down: ['Can’t reach the Taskule server',
        `Editing is paused so nothing you type gets lost. Unsaved changes are kept on this computer and will be saved as soon as the server is back. ${electron ? 'Taskule is trying to restart it.' : 'Make sure it’s running (open the Taskule app, or run npm start).'}`],
      failing: ['Changes aren’t saving',
        'The server is running, but saving keeps failing. Editing is paused so nothing gets lost; unsaved changes are kept on this computer and will be saved once this is fixed.'],
      db: ['Your database needs attention',
        'Taskule found a problem with its database file and has stopped saving to protect your notes. Don’t delete anything. Automatic backups are in the data/backups folder — see “Restoring a backup” in the README.'],
    }[state];
    $('#outage-title').textContent = copy[0];
    $('#outage-text').textContent = copy[1];
    $('#outage-detail').textContent = detail ? `Details: ${detail}` : '';
    $('#outage').classList.toggle('severe', state === 'db');
    box.hidden = false;
    $('#app').inert = true;
    updateStatus();
  },
};

function markNoteDirty(id, { immediate = false } = {}) {
  sync.seq++;
  sync.dirtyNotes.add(id);
  clearTimeout(sync.noteTimer);
  if (immediate) flushNotes();
  else sync.noteTimer = setTimeout(flushNotes, 400);
  updateStatus();
}
function flushNotes() {
  clearTimeout(sync.noteTimer);
  const ids = [...sync.dirtyNotes];
  sync.dirtyNotes.clear();
  for (const id of ids) {
    const n = S.notes.get(id);
    if (!n) continue;
    const at = journal.save(id, n.title, n.content);
    sync.push({ method: 'PATCH', url: `/api/notes/${id}`, body: { title: n.title, content: n.content }, key: `note:${id}`, noteId: id, versioned: true, journal: { id, at } });
  }
  updateStatus();
}

/**
 * Unsaved note edits are also kept in this browser until the server confirms them,
 * so closing or reloading the tab while the server is unreachable loses nothing.
 */
const journal = {
  KEY: KEYS.unsaved,
  read() { const v = store.get(this.KEY, {}); return v && typeof v === 'object' ? v : {}; },
  save(id, title, content) {
    const all = this.read();
    const at = Date.now();
    all[id] = { title, content, at };
    store.set(this.KEY, all);
    return at;
  },
  clear(id, upTo = Infinity) {
    const all = this.read();
    if (all[id] && all[id].at <= upTo) { delete all[id]; store.set(this.KEY, all); }
  },
  clearAll() { store.del(this.KEY); },
};

/** On load: re-apply any edits the server never confirmed (newer than what it has). */
function recoverUnsavedEdits() {
  const all = journal.read();
  const recovered = [];
  for (const [id, e] of Object.entries(all)) {
    const n = S.notes.get(id);
    if (!n || typeof e?.content !== 'string' || (n.updatedAt || 0) >= e.at) { journal.clear(id); continue; }
    if (n.content === e.content && n.title === e.title) { journal.clear(id); continue; }
    n.title = e.title;
    n.content = e.content;
    n.updatedAt = e.at;
    markNoteDirty(id, { immediate: true });
    recovered.push(noteTitle(n));
  }
  if (recovered.length) toast(`Recovered unsaved changes to ${recovered.map((t) => `“${t}”`).join(', ')}`, { type: 'success', timeout: 6000 });
}

function updateStatus() {
  const el = $('#save-status');
  if (!el) return;
  const label = $('.label', el);
  el.classList.remove('saving', 'error');
  el.title = '';
  if (sync.failures > 0) {
    el.classList.add('error');
    label.textContent = 'Can’t reach the server — retrying…';
    el.title = 'Your changes are kept in this browser and will save as soon as the Taskule server is reachable. Click to retry now.';
  } else if (sync.pending) {
    el.classList.add('saving');
    label.textContent = 'Saving…';
  } else {
    label.textContent = 'All changes saved';
  }
}

async function fetchState() {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Pull fresh state from the server (e.g. when you come back to the tab). Never clobbers unsaved local edits. */
async function resync(force = false) {
  if (sync.pending && !force) return;
  const seq = sync.seq;
  let data;
  try { data = await fetchState(); } catch { return; }
  if (sync.seq !== seq || sync.pending) return; // something changed locally meanwhile — keep local
  const openId = S.view.type === 'note' ? S.view.id : null;
  applyState(data);
  if (openId && !S.notes.has(openId)) { navigate(HOME); return; }
  if (openId) {
    const n = S.notes.get(openId);
    const title = $('#note-title');
    loadIntoEditor(n);
    if (title && document.activeElement !== title && title.value !== n.title) title.value = n.title;
    updateNoteFoot();
  }
  refreshAll();
}

/* =====================================================================
   Mutations
   ===================================================================== */
function createFolder(parentId, name = 'New folder') {
  const now = Date.now();
  const f = { id: uid(), parentId: parentId || null, name, createdAt: now, updatedAt: now };
  S.folders.set(f.id, f);
  if (parentId) { S.expanded.add(parentId); saveExpanded(); }
  sync.push({ method: 'POST', url: '/api/folders', body: { id: f.id, parentId: f.parentId, name: f.name } });
  return f;
}
function renameFolder(id, name) {
  const f = S.folders.get(id);
  name = name.trim().slice(0, 200);
  if (!f || !name || name === f.name) return;
  f.name = name;
  sync.push({ method: 'PATCH', url: `/api/folders/${id}`, body: { name } });
  refreshAll();
}
function moveFolder(id, parentId) {
  const f = S.folders.get(id);
  parentId = parentId || null;
  if (!f || f.parentId === parentId) return;
  if (parentId && isFolderWithin(parentId, id)) { toast("A folder can't go inside itself", { type: 'error' }); return; }
  f.parentId = parentId;
  if (parentId) { S.expanded.add(parentId); saveExpanded(); }
  f.position = null; // goes to the end of its new folder
  sync.push({ method: 'PATCH', url: `/api/folders/${id}`, body: { parentId, position: null } });
  refreshAll();
  toast(`Moved “${f.name}” to ${parentId ? `“${S.folders.get(parentId).name}”` : 'top level'}`);
}
async function deleteFolder(id) {
  const f = S.folders.get(id);
  if (!f) return;
  const notes = notesUnder(id);
  const subs = [...S.folders.values()].filter((x) => x.id !== id && isFolderWithin(x.id, id));
  const taskCount = notes.reduce((a, n) => a + noteTasks(n).length, 0);
  const parts = [];
  if (subs.length) parts.push(plural(subs.length, 'subfolder'));
  if (notes.length) parts.push(plural(notes.length, 'note'));
  if (taskCount) parts.push(plural(taskCount, 'task'));
  const ok = await confirmDialog({
    title: `Delete “${f.name}”?`,
    body: parts.length
      ? `<p>This also permanently deletes <strong>${parts.join(', ')}</strong> inside it.</p>`
      : '<p>This folder is empty.</p>',
    confirm: 'Delete folder',
  });
  if (!ok) return;
  for (const n of notes) { sync.dirtyNotes.delete(n.id); journal.clear(n.id); S.notes.delete(n.id); }
  for (const s of subs) { S.folders.delete(s.id); S.expanded.delete(s.id); }
  S.folders.delete(id);
  S.expanded.delete(id);
  saveExpanded();
  if (S.selectedFolderId && !S.folders.has(S.selectedFolderId)) S.selectedFolderId = f.parentId || null;
  sync.push({ method: 'DELETE', url: `/api/folders/${id}` });
  if (S.view.type === 'note' && !S.notes.has(S.view.id)) navigate(HOME);
  refreshAll();
  toast(`Deleted “${f.name}”`);
}

function createNote(folderId = S.selectedFolderId) {
  flushNotes();
  if (folderId && !S.folders.has(folderId)) folderId = null;
  const now = Date.now();
  const n = { id: uid(), folderId: folderId || null, title: '', content: '', createdAt: now, updatedAt: now };
  S.notes.set(n.id, n);
  if (folderId) { S.expanded.add(folderId); saveExpanded(); }
  sync.push({ method: 'POST', url: '/api/notes', body: { id: n.id, folderId: n.folderId, title: '', content: '' } });
  navigate(`#/note/${n.id}`, { focusTitle: true });
  return n;
}
function moveNote(id, folderId) {
  const n = S.notes.get(id);
  folderId = folderId || null;
  if (!n || n.folderId === folderId || isScratch(id)) return;
  flushNotes();
  n.folderId = folderId;
  if (folderId) { S.expanded.add(folderId); saveExpanded(); }
  n.position = null; // goes to the end of its new folder
  sync.push({ method: 'PATCH', url: `/api/notes/${id}`, body: { folderId, position: null } });
  if (S.view.type === 'note' && S.view.id === id) { S.selectedFolderId = folderId; renderCrumbs(); }
  refreshAll();
  toast(`Moved “${noteTitle(n)}” to ${folderId ? `“${S.folders.get(folderId).name}”` : 'top level'}`);
}
async function deleteNote(id) {
  const n = S.notes.get(id);
  if (!n || isScratch(id)) return;
  const tc = noteTasks(n).length;
  const ok = await confirmDialog({
    title: `Delete “${noteTitle(n)}”?`,
    body: `<p>The note${tc ? ` and its <strong>${plural(tc, 'task')}</strong>` : ''} will be permanently deleted.</p>`,
    confirm: 'Delete note',
  });
  if (!ok) return;
  sync.dirtyNotes.delete(id);
  journal.clear(id);
  S.notes.delete(id);
  sync.push({ method: 'DELETE', url: `/api/notes/${id}` });
  if (S.view.type === 'note' && S.view.id === id) navigate(HOME);
  refreshAll();
  toast(`Deleted “${noteTitle(n)}”`);
}

/** If this note is open, make the editor show its current content (without echoing an update). */
/* ------------------------------------------------------------- Scratchpad */
/** Open the Scratchpad, ready to type. `newLine`: start a fresh line at the end (Alt+S). */
/** Quick capture: a fresh empty line at the very top of the Scratchpad, with the cursor on it. */
function newLineAtTop(ed) {
  const first = ed.state.doc.firstChild;
  const empty = first && first.type.name === 'paragraph' && first.content.size === 0;
  if (!empty) ed.chain().insertContentAt(0, { type: 'paragraph' }).run();
  ed.commands.setTextSelection(1);
  ed.view.focus();
  const sc = $('#editor-scroll');
  if (sc) sc.scrollTop = 0;
}

function openScratchpad({ newLine = false } = {}) {
  if (!S.notes.has(SCRATCH)) { resync(true).then(() => { if (S.notes.has(SCRATCH)) openScratchpad({ newLine }); }); return; }
  if (S.view.type === 'note' && isScratch(S.view.id) && editor) {
    closeSidebar();
    if (newLine) { newLineAtTop(editor); return; }
    editor.commands.focus('end');
    editor.view.focus();
    return;
  }
  navigate(`#/note/${SCRATCH}`, { newLine });
}

/** The lines to move: whole lines covered by the selection (or the cursor's line). */
function scratchSelection() {
  const { state } = editor;
  const sel = state.selection;
  let from = sel.from;
  let to = sel.to;
  if (sel.node) { /* a selected image etc.: exactly that node */ } else {
    if (sel.$from.parent.isTextblock) from = sel.$from.start();
    if (sel.$to.parent.isTextblock) to = sel.$to.end();
  }
  const slice = state.doc.slice(from, to);
  // The slice holds content at the depth both ends share (text, list items…). Re-wrap it in the
  // same blocks it came from (paragraph, task item, list…) so it stands on its own in another note.
  const $from = state.doc.resolve(from);
  let nodes = slice.content.toJSON() || [];
  for (let d = $from.sharedDepth(to); d >= 1; d--) {
    const anc = $from.node(d);
    nodes = [{ type: anc.type.name, ...(Object.keys(anc.attrs).length ? { attrs: { ...anc.attrs } } : {}), content: nodes }];
  }
  const text = slice.content.textBetween(0, slice.content.size, '\n', ' ').trim();
  let hasMedia = false;
  slice.content.descendants((node) => { if (node.type.name === 'image') hasMedia = true; });
  return { from, to, nodes, text, empty: !text && !hasMedia };
}

function moveOutDialog() {
  if (!editor || !isScratch(S.view.id)) return;
  flushNotes();
  const pick = scratchSelection();
  if (pick.empty) {
    toast('Put the cursor on a line, or select some lines, to move them into a note.');
    editor.view.focus();
    return;
  }
  const folder = S.selectedFolderId && S.folders.get(S.selectedFolderId);
  const firstLine = pick.text.split('\n')[0].trim().slice(0, 80);
  const targets = [...S.notes.values()].filter((n) => !isScratch(n.id)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const lineCount = pick.text ? pick.text.split('\n').filter((l) => l.trim()).length : 0;
  const what = lineCount === 1 ? 'this line' : lineCount ? `these ${lineCount} lines` : 'this';

  const rows = (q) => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = (n) => terms.every((t) => `${noteTitle(n)} ${folderPath(n.folderId)}`.toLowerCase().includes(t));
    const list = targets.filter(match);
    let h = `<button type="button" class="new" data-target="new">${I.notePlus}<span class="np-title">New note${firstLine ? `: “${esc(firstLine)}”` : ''}</span><span class="np-path">${folder ? esc(folderPath(folder.id)) : 'Top level'}</span></button>`;
    h += list.map((n) => `<button type="button" data-target="${n.id}">${I.note}<span class="np-title">${esc(noteTitle(n))}</span><span class="np-path">${esc(folderPath(n.folderId))}</span></button>`).join('');
    if (!list.length && terms.length) h += '<div class="np-empty">No notes match.</div>';
    return h;
  };

  openDialog({
    title: `Move ${what} to…`,
    icon: I.moveOut,
    iconClass: 'green',
    body: `<div class="move-preview">${esc(pick.text.slice(0, 400)) || '(image)'}</div>
      <input class="note-pick-search" id="np-search" placeholder="Find a note…" autocomplete="off" spellcheck="false" aria-label="Find a note">
      <div class="note-pick" id="np-list">${rows('')}</div>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }],
    onMount: (d) => {
      const input = $('#np-search', d);
      const list = $('#np-list', d);
      let kb = 0;
      const mark = () => {
        const btns = $$('button', list);
        kb = Math.max(0, Math.min(kb, btns.length - 1));
        btns.forEach((b, i) => b.classList.toggle('kb', i === kb));
        btns[kb]?.scrollIntoView({ block: 'nearest' });
      };
      const choose = (b) => {
        if (!b) return;
        d.close('moved');
        moveScratchTo(pick, b.dataset.target === 'new' ? null : b.dataset.target, { title: firstLine, folderId: folder ? folder.id : null });
      };
      input.addEventListener('input', () => { list.innerHTML = rows(input.value); kb = input.value.trim() ? 1 : 0; mark(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); kb++; mark(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); kb--; mark(); }
        else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); choose($$('button', list)[kb]); }
      });
      list.addEventListener('click', (e) => choose(e.target.closest('button[data-target]')));
      d.addEventListener('close', () => { if (d.returnValue !== 'moved') setTimeout(() => editor?.view.focus()); }, { once: true });
      mark();
      input.focus();
    },
  });
}

/** Move the picked Scratchpad lines to the end of a note (or a new note), with Undo. */
function moveScratchTo(pick, targetId, { title, folderId }) {
  const scratch = S.notes.get(SCRATCH);
  if (!editor || !scratch || !isScratch(S.view.id)) return;
  let target = targetId ? S.notes.get(targetId) : null;
  if (targetId && !target) { toast('That note no longer exists', { type: 'error' }); return; }

  // Build the target's new document first, and check it, before touching the Scratchpad.
  const base = target ? structuredClone(noteInfo(target).doc) : { type: 'doc', content: [] };
  const blank = (node) => node.type === 'paragraph' && !(node.content || []).length;
  base.content = base.content || [];
  while (base.content.length && blank(base.content[base.content.length - 1])) base.content.pop();
  for (const node of pick.nodes) {
    // A moved list joins a list of the same kind at the end of the note instead of starting a new one.
    const last = base.content[base.content.length - 1];
    if (last && last.type === node.type && ['taskList', 'bulletList', 'orderedList'].includes(node.type)) {
      last.content = [...(last.content || []), ...(node.content || [])];
    } else {
      base.content.push(node);
    }
  }
  try { editor.schema.nodeFromJSON(base).check(); } catch (err) {
    console.error('Move to note: invalid result', err, base);
    toast('Couldn’t move that selection — try selecting whole lines.', { type: 'error' });
    return;
  }

  const prevScratch = scratch.content;
  const prevTarget = target ? target.content : null;
  editor.chain().command(({ tr }) => {
    tr.deleteRange(pick.from, pick.to);
    // Don't leave an empty line, empty to-do or empty list behind where the moved lines were:
    // remove the outermost block around that spot that's now empty.
    const $p = tr.doc.resolve(Math.min(tr.mapping.map(pick.from), tr.doc.content.size));
    const isEmpty = (node) => {
      if (node.textContent.length) return false;
      let media = false;
      node.descendants((c) => { if (c.isLeaf && !c.isText && c.type.name !== 'hardBreak') media = true; });
      return !media;
    };
    let depth = 0;
    for (let d = $p.depth; d >= 1 && isEmpty($p.node(d)); d--) depth = d;
    if (depth && !(depth === 1 && tr.doc.childCount === 1)) tr.delete($p.before(depth), $p.after(depth));
    return true;
  }).run();
  const afterScratch = S.notes.get(SCRATCH).content;
  markNoteDirty(SCRATCH, { immediate: true });

  const newContent = JSON.stringify(base);
  if (target) {
    setNoteContent(target.id, newContent);
  } else {
    if (folderId && !S.folders.has(folderId)) folderId = null;
    const now = Date.now();
    target = { id: uid(), folderId, title: title || '', content: newContent, createdAt: now, updatedAt: now };
    S.notes.set(target.id, target);
    if (folderId) { S.expanded.add(folderId); saveExpanded(); }
    sync.push({ method: 'POST', url: '/api/notes', body: { id: target.id, folderId, title: target.title, content: newContent } });
    refreshAll();
  }
  const movedTo = target;
  editor.view.focus();
  toast(`Moved to “${noteTitle(movedTo)}”`, {
    type: 'success',
    action: 'Undo',
    timeout: 8000,
    onAction: () => {
      const sp = S.notes.get(SCRATCH);
      const t = S.notes.get(movedTo.id);
      if (!sp || sp.content !== afterScratch || (t && t.content !== newContent)) {
        toast('Can’t undo — the Scratchpad or that note has changed since.', { type: 'error' });
        return;
      }
      setNoteContent(SCRATCH, prevScratch);
      if (prevTarget === null) {
        if (t) {
          sync.dirtyNotes.delete(t.id);
          journal.clear(t.id);
          S.notes.delete(t.id);
          sync.push({ method: 'DELETE', url: `/api/notes/${t.id}` });
        }
      } else if (t) {
        setNoteContent(t.id, prevTarget);
      }
      refreshAll();
    },
  });
}

async function clearScratchpad() {
  const sp = S.notes.get(SCRATCH);
  if (!sp) return;
  const open = noteTasks(sp).filter((t) => !t.done).length;
  const ok = await confirmDialog({
    title: 'Clear the Scratchpad?',
    body: `<p>Everything in the Scratchpad will be removed${open ? `, including <strong>${plural(open, 'open to-do')}</strong>` : ''}. You can undo this right after.</p>`,
    confirm: 'Clear',
  });
  if (!ok) return;
  const prev = sp.content;
  setNoteContent(SCRATCH, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }));
  toast('Scratchpad cleared', { action: 'Undo', timeout: 8000, onAction: () => setNoteContent(SCRATCH, prev) });
  if (isScratch(S.view.id)) editor?.view.focus();
}

function loadIntoEditor(n) {
  if (!editor || S.view.type !== 'note' || S.view.id !== n.id) return;
  if (JSON.stringify(editor.getJSON()) === n.content) return;
  editor.commands.setContent(noteInfo(n).doc, { emitUpdate: false });
}

/** Replace a note's content from outside the editor (e.g. the to-do list). */
function setNoteContent(id, content, { render = true } = {}) {
  const n = S.notes.get(id);
  if (!n) return;
  n.content = content;
  n.updatedAt = Date.now();
  if (S.view.type === 'note' && S.view.id === id) {
    loadIntoEditor(n);
    updateNoteFoot();
  }
  markNoteDirty(id, { immediate: true });
  if (render) refreshAll();
  else { renderTree(); renderTodoCount(); }
}
function setStandaloneDone(t, done) {
  if (t.done === done) return;
  t.done = done;
  t.completedAt = done ? Date.now() : null;
  sync.push({ method: 'PATCH', url: `/api/tasks/${t.id}`, body: { done } });
}
function deleteStandalone(t) {
  S.tasks.delete(t.id);
  sync.push({ method: 'DELETE', url: `/api/tasks/${t.id}` });
  refreshAll();
  toast('Task deleted', {
    action: 'Undo',
    onAction: () => {
      S.tasks.set(t.id, t);
      sync.push({ method: 'POST', url: '/api/tasks', body: { id: t.id, text: t.text, done: t.done, createdAt: t.createdAt, completedAt: t.completedAt } });
      refreshAll();
    },
  });
}

/* =====================================================================
   Routing & views
   ===================================================================== */
const main = $('#main');
let navOpts = {};

function navigate(hash, opts = {}) {
  navOpts = opts;
  closeSidebar();
  // Render synchronously so keystrokes right after an action (e.g. Alt+N then typing) land in the new view.
  if (location.hash !== hash) history.pushState(null, '', hash);
  route();
}

function route() {
  const opts = navOpts;
  navOpts = {};
  flushNotes();
  const m = /^#\/note\/([\w-]+)$/.exec(location.hash);
  const search = $('#search');
  if (location.hash === '#/board') {
    if (search.value && !opts.keepSearch) search.value = '';
    if (S.view.type === 'board') { renderBoard(); return; }
    showBoard();
    return;
  }
  if (m && S.notes.has(m[1])) {
    if (search.value && !opts.keepSearch) search.value = '';
    if (S.view.type === 'note' && S.view.id === m[1] && !opts.focusTitle && !opts.find && opts.task == null) { renderTree(); return; }
    openNote(m[1], opts);
  } else {
    if (m) {
      // Unknown note — maybe created in another tab. Refresh, then open it if it exists.
      const id = m[1];
      resync().then(() => { if (S.notes.has(id) && !(S.view.type === 'note' && S.view.id === id)) navigate(`#/note/${id}`); });
    }
    if (location.hash === '#/todos') tasksPanel.open(); // old link to the to-do page
    history.replaceState(null, '', HOME);
    if (search.value && !opts.keepSearch) search.value = '';
    if (!S.notes.has(SCRATCH)) { main.innerHTML = '<div class="welcome"><p class="page-sub">Loading…</p></div>'; return; }
    if (S.view.type === 'note' && S.view.id === SCRATCH) { renderTree(); return; }
    openNote(SCRATCH, opts);
  }
}

const viewCleanups = [];
function setView(v) {
  while (viewCleanups.length) { try { viewCleanups.pop()(); } catch { /* ignore */ } }
  S.view = v;
  $('#tp-board')?.classList.toggle('on', v.type === 'board');
  $('#tp-board')?.setAttribute('aria-pressed', String(v.type === 'board'));
  if (v.type === 'note') store.set(KEYS.last, location.hash);
  document.title = v.type === 'note' ? `${noteTitle(S.notes.get(v.id))} · Taskule` : v.type === 'search' ? 'Search · Taskule' : v.type === 'board' ? 'Board · Taskule' : 'Taskule';
}

function mobileBar(title) {
  return `<div class="mobile-bar"><button class="icon-btn" data-open-sidebar title="Menu">${I.menu}</button><strong>${esc(title)}</strong></div>`;
}

function refreshAll() {
  renderTree();
  renderTodoCount();
  renderTaskPanel();
  if (S.view.type === 'board') renderBoard();
  if (S.view.type === 'search') renderSearchResults();
  else if (S.view.type === 'note') renderCrumbs();
}
const refreshSoon = debounce(refreshAll, 150);

/* ------------------------------------------------------------- sidebar tree */
function renderTodoCount() {
  let open = 0;
  for (const t of S.tasks.values()) if (!t.done) open++;
  for (const n of S.notes.values()) for (const t of noteTasks(n)) if (!t.done) open++;
  $('#tp-count').textContent = open ? String(open) : '';
  $('#tp-handle-count').textContent = open ? String(open) : '';
}

function renderTree() {
  const tree = $('#tree');
  if (S.renaming) { S.treeDirty = true; return; }
  S.treeDirty = false;
  const kids = new Map();
  const notesBy = new Map();
  for (const f of S.folders.values()) {
    const k = f.parentId && S.folders.has(f.parentId) ? f.parentId : null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(f);
  }
  for (const n of S.notes.values()) {
    if (isScratch(n.id)) continue; // shown as its own pinned row at the top of the tree
    const k = n.folderId && S.folders.has(n.folderId) ? n.folderId : null;
    if (!notesBy.has(k)) notesBy.set(k, []);
    notesBy.get(k).push(n);
  }
  const activeNote = S.view.type === 'note' ? S.view.id : null;
  const countDeep = (fid) => (notesBy.get(fid)?.length || 0) + (kids.get(fid) || []).reduce((a, f) => a + countDeep(f.id), 0);

  const level = (pid, depth) => {
    let h = '';
    const folders = (kids.get(pid) || []).sort(byOrder((x) => x.name));
    for (const f of folders) {
      const open = S.expanded.has(f.id);
      const count = countDeep(f.id);
      h += `<div class="tree-row folder${S.selectedFolderId === f.id ? ' selected' : ''}" data-kind="folder" data-id="${f.id}" draggable="true" tabindex="0" role="treeitem" aria-expanded="${open}" style="--depth:${depth}">
        <span class="twisty${open ? ' open' : ''}">${I.chevron}</span>
        <span class="row-icon">${open ? I.folderOpen : I.folder}</span>
        <span class="row-label">${esc(f.name)}</span>
        <span class="row-count">${count || ''}</span>
        <span class="row-actions">
          <button class="icon-btn sm accent-blue" data-tact="new-note" title="New note in “${esc(f.name)}”" tabindex="-1">${I.plus}</button>
          <button class="icon-btn sm" data-tact="menu" title="More actions" tabindex="-1">${I.more}</button>
        </span>
      </div>`;
      if (open) h += level(f.id, depth + 1);
    }
    const notes = (notesBy.get(pid) || []).sort(byOrder(noteTitle));
    for (const n of notes) {
      const open = noteTasks(n).filter((t) => !t.done).length;
      h += `<div class="tree-row note${activeNote === n.id ? ' active' : ''}" data-kind="note" data-id="${n.id}" draggable="true" tabindex="0" role="treeitem" style="--depth:${depth}">
        <span class="twisty-spacer"></span>
        <span class="row-icon">${I.note}</span>
        <span class="row-label${n.title.trim() ? '' : ' untitled'}">${esc(noteTitle(n))}</span>
        ${open ? `<span class="row-badge" title="${plural(open, 'open task')}">${open}</span>` : ''}
        <span class="row-actions"><button class="icon-btn sm" data-tact="menu" title="More actions" tabindex="-1">${I.more}</button></span>
      </div>`;
    }
    return h;
  };
  const html = level(null, 0);
  const sp = S.notes.get(SCRATCH);
  const spOpen = sp ? noteTasks(sp).filter((t) => !t.done).length : 0;
  const scratchRow = sp ? `<div class="tree-row scratch-row${activeNote === SCRATCH ? ' active' : ''}" data-kind="scratch" data-id="${SCRATCH}" tabindex="0" role="treeitem" title="Scratchpad: quick notes and to-dos to sort later${esc(shortcuts.hint('scratch'))}">
      <span class="row-icon">${I.sticky}</span>
      <span class="row-label">Scratchpad</span>
      ${spOpen ? `<span class="row-badge" title="${plural(spOpen, 'open to-do')}">${spOpen}</span>` : ''}
      <span class="scratch-pin" title="Always at the top">${I.pin}</span>
    </div>` : '';
  tree.innerHTML = scratchRow + (html || `<div class="tree-empty">No notes yet.<br><button data-tact="first-note">Create your first note</button></div>`);
  $('#tree-root').classList.toggle('selected', !S.selectedFolderId);
  const target = S.selectedFolderId ? S.folders.get(S.selectedFolderId)?.name : null;
  $('#new-note').title = target ? `New note in “${target}”${shortcuts.hint('newNote')}` : `New note${shortcuts.hint('newNote')}`;
  $('#new-folder').title = target ? `New folder in “${target}”` : 'New folder';
}

function toggleFolder(id, force) {
  const open = force ?? !S.expanded.has(id);
  if (open) S.expanded.add(id); else S.expanded.delete(id);
  saveExpanded();
}

function startRenameFolder(id, { isNew = false } = {}) {
  const row = $(`.tree-row.folder[data-id="${id}"]`);
  const f = S.folders.get(id);
  if (!row || !f) return;
  const label = $('.row-label', row);
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = f.name;
  input.maxLength = 200;
  label.replaceWith(input);
  row.draggable = false;
  S.renaming = id;
  input.focus();
  input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    S.renaming = null;
    if (save && input.value.trim()) renameFolder(id, input.value);
    renderTree();
    if (isNew) $(`.tree-row.folder[data-id="${id}"]`)?.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

function newFolderAction(parentId = S.selectedFolderId) {
  if (parentId && !S.folders.has(parentId)) parentId = null;
  const f = createFolder(parentId);
  S.selectedFolderId = f.id;
  if (S.view.type === 'note') { /* keep the note open; just show the new folder */ }
  renderTree();
  startRenameFolder(f.id, { isNew: true });
  $(`.tree-row.folder[data-id="${f.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

function rowMenu(row, at) {
  const { kind, id } = row.dataset;
  const item = kind === 'folder' ? S.folders.get(id) : S.notes.get(id);
  const sibs = item ? (kind === 'folder' ? childFolders(parentOf('folder', item)) : childNotes(parentOf('note', item))) : [];
  const at0 = sibs.findIndex((x) => x.id === id);
  const order = [
    ...(at0 > 0 ? [{ label: 'Move up', icon: I.arrowUp, run: () => nudgeItem(kind, id, -1) }] : []),
    ...(at0 >= 0 && at0 < sibs.length - 1 ? [{ label: 'Move down', icon: I.arrowDown, run: () => nudgeItem(kind, id, 1) }] : []),
  ];
  const items0 = kind === 'folder'
    ? [
      { label: 'New note here', icon: I.notePlus, run: () => createNote(id) },
      { label: 'New subfolder', icon: I.folderPlus, run: () => newFolderAction(id) },
      'sep',
      { label: 'Rename', icon: I.pencil, run: () => startRenameFolder(id) },
      { label: 'Move to…', icon: I.move, run: () => moveDialog('folder', id) },
      'sep',
      { label: 'Delete folder', icon: I.trash, danger: true, run: () => deleteFolder(id) },
    ]
    : [
      { label: 'Open', icon: I.note, run: () => navigate(`#/note/${id}`) },
      { label: 'Rename', icon: I.pencil, run: () => navigate(`#/note/${id}`, { focusTitle: true }) },
      { label: 'Move to…', icon: I.move, run: () => moveDialog('note', id) },
      'sep',
      { label: 'Delete note', icon: I.trash, danger: true, run: () => deleteNote(id) },
    ];
  // Move up/down sit right after "Move to…"
  const k = items0.findIndex((x) => x !== 'sep' && x.label === 'Move to…');
  const items = [...items0.slice(0, k + 1), ...order, ...items0.slice(k + 1)];
  row.classList.add('menu-open');
  showMenu(at, items, () => row.classList.remove('menu-open'));
}

function setupTree() {
  const tree = $('#tree');
  tree.addEventListener('click', (e) => {
    const tact = e.target.closest('[data-tact]')?.dataset.tact;
    if (tact === 'first-note') { createNote(null); return; }
    const row = e.target.closest('.tree-row');
    if (!row || S.renaming === row.dataset.id) return;
    const { kind, id } = row.dataset;
    if (kind === 'scratch') { openScratchpad(); return; }
    if (tact === 'menu') {
      const r = e.target.closest('button').getBoundingClientRect();
      rowMenu(row, { x: r.left, y: r.bottom + 4 });
      return;
    }
    if (tact === 'new-note') { createNote(id); return; }
    if (kind === 'folder') {
      toggleFolder(id);
      S.selectedFolderId = id;
      if (S.view.type === 'note') { /* folder click while a note is open just selects/expands */ }
      renderTree();
      $(`.tree-row.folder[data-id="${id}"]`)?.focus({ preventScroll: true });
    } else {
      navigate(`#/note/${id}`);
    }
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tree-row.folder');
    if (row && !e.target.closest('[data-tact]')) startRenameFolder(row.dataset.id);
  });
  tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row || S.renaming || row.dataset.kind === 'scratch') return;
    e.preventDefault();
    rowMenu(row, { x: e.clientX, y: e.clientY });
  });
  tree.addEventListener('keydown', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row || e.target !== row) return;
    const rows = $$('.tree-row', tree);
    const i = rows.indexOf(row);
    const { kind, id } = row.dataset;
    if (kind === 'scratch' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openScratchpad(); return; }
    if (kind === 'scratch' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; // pinned: no move/rename/delete
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); nudgeItem(kind, id, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); rows[i + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[i - 1]?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    else if (e.key === 'ArrowRight' && kind === 'folder' && !S.expanded.has(id)) { toggleFolder(id, true); renderTree(); $(`.tree-row[data-id="${id}"]`)?.focus(); }
    else if (e.key === 'ArrowLeft' && kind === 'folder' && S.expanded.has(id)) { toggleFolder(id, false); renderTree(); $(`.tree-row[data-id="${id}"]`)?.focus(); }
    else if (e.key === 'F2' && kind === 'folder') { e.preventDefault(); startRenameFolder(id); }
    else if (e.key === 'Delete') { e.preventDefault(); kind === 'folder' ? deleteFolder(id) : deleteNote(id); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = row.getBoundingClientRect(); rowMenu(row, { x: r.left + 40, y: r.bottom }); }
  });

  // ---- drag & drop
  // Drop on the top or bottom edge of a row to put the item before/after it; drop on the
  // middle of a folder to put it inside; drop on empty space for the end of the top level.
  // Folders stay above notes, so a note dropped on a folder goes into it.
  let drag = null;
  let hoverTimer = null;
  const DT = 'application/x-taskule';
  const clearMarks = () => {
    $$('.drop-target, .drop-before, .drop-after', tree).forEach((el) => el.classList.remove('drop-target', 'drop-before', 'drop-after'));
    tree.classList.remove('drop-root');
  };
  /** Where a drop at this point would go: { parent, ref, where, row, cls } or null. */
  const dropAt = (e) => {
    if (!drag) return null;
    const row = e.target.closest('.tree-row');
    if (row?.dataset.kind === 'scratch') return null; // the Scratchpad stays pinned at the top
    if (!row) return { parent: null, ref: null, where: 'end', row: null, cls: 'root' };
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const over = { kind: row.dataset.kind, id: row.dataset.id };
    let res;
    if (drag.kind === 'note') {
      if (over.kind === 'note') {
        res = { parent: S.notes.get(over.id)?.folderId || null, ref: over.id, where: y < 0.5 ? 'before' : 'after' };
      } else {
        res = { parent: over.id, ref: null, where: 'end', into: true };
      }
    } else if (over.kind === 'folder') {
      const zone = y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'into';
      res = zone === 'into'
        ? { parent: over.id, ref: null, where: 'end', into: true }
        : { parent: S.folders.get(over.id)?.parentId || null, ref: over.id, where: zone };
    } else {
      const parent = S.notes.get(over.id)?.folderId || null;
      res = { parent, ref: null, where: 'end', into: true, markId: parent };
    }
    if (res.ref === drag.id) return null; // onto itself
    if (drag.kind === 'folder' && res.parent && (res.parent === drag.id || isFolderWithin(res.parent, drag.id))) return null;
    const mark = res.into ? (res.markId !== undefined ? (res.markId ? $(`.tree-row.folder[data-id="${res.markId}"]`, tree) : null) : row) : row;
    return { ...res, row: mark, cls: res.into ? (mark ? 'drop-target' : 'root') : `drop-${res.where}` };
  };
  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.tree-row');
    if (!row || S.renaming || row.dataset.kind === 'scratch') { e.preventDefault(); return; }
    drag = { kind: row.dataset.kind, id: row.dataset.id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DT, `${drag.kind}:${drag.id}`);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  tree.addEventListener('dragover', (e) => {
    if (drag && !e.dataTransfer.types.includes(DT)) drag = null; // stale state from a cancelled drag
    if (!drag) return;
    const d = dropAt(e);
    clearMarks();
    if (!d) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (d.cls === 'root') tree.classList.add('drop-root');
    else d.row?.classList.add(d.cls);
    // Hovering the middle of a closed folder opens it.
    if (d.cls === 'drop-target' && d.row?.dataset.kind === 'folder' && !S.expanded.has(d.parent)) {
      if (hoverTimer?.id !== d.parent) {
        clearTimeout(hoverTimer?.t);
        const target = d.parent;
        hoverTimer = { id: target, t: setTimeout(() => { toggleFolder(target, true); renderTree(); }, 700) };
      }
    } else if (hoverTimer) { clearTimeout(hoverTimer.t); hoverTimer = null; }
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) clearMarks(); });
  tree.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const d = dropAt(e);
    const it = drag;
    drag = null;
    clearMarks();
    if (d) placeItem(it.kind, it.id, d.parent, d.ref, d.where);
  });
  tree.addEventListener('dragend', () => {
    drag = null;
    clearTimeout(hoverTimer?.t);
    hoverTimer = null;
    clearMarks();
    $$('.dragging', tree).forEach((el) => el.classList.remove('dragging'));
  });

  // The "Notes" heading is also a drop target: end of the top level.
  const rootBtn = $('#tree-root');
  rootBtn.addEventListener('dragover', (e) => { if (drag && !e.dataTransfer.types.includes(DT)) drag = null; if (drag) { e.preventDefault(); rootBtn.classList.add('selected'); } });
  rootBtn.addEventListener('dragleave', () => rootBtn.classList.toggle('selected', !S.selectedFolderId));
  rootBtn.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const it = drag;
    drag = null;
    rootBtn.classList.toggle('selected', !S.selectedFolderId);
    placeItem(it.kind, it.id, null);
  });
}

/* ------------------------------------------------------------- tasks panel */
/*
 * Every task in one place, in a panel on the right: standalone tasks plus every to-do in
 * every note (grouped by note), with a Completed section. Titles, details and due dates are
 * edited right in the panel. Pin it open, or close it and peek by hovering the Tasks button.
 */
function collectTasks() {
  const all = [...S.tasks.values()];
  const open = { standalone: all.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt), notes: [] };
  const done = { standalone: all.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)), notes: [] };
  for (const n of sortedNotes()) {
    const ts = noteTasks(n);
    const o = ts.filter((t) => !t.done);
    const d = ts.filter((t) => t.done);
    if (o.length) open.notes.push({ note: n, tasks: o });
    if (d.length) done.notes.push({ note: n, tasks: d });
  }
  const count = (g) => g.standalone.length + g.notes.reduce((a, x) => a + x.tasks.length, 0);
  return { open, done, openCount: count(open), doneCount: count(done) };
}

/** Short "added" label: "today", "yesterday", "Nov 20", or "Nov 20, 2025" for another year. */
function addedLabel(ms) {
  const iso = todayISO(new Date(ms));
  const n = daysFromToday(iso);
  if (n === 0) return 'today';
  if (n === -1) return 'yesterday';
  const label = formatDate(iso).replace(/^\w{3}, /, '');
  return iso.slice(0, 4) === todayISO().slice(0, 4) ? label.replace(/, \d{4}$/, '') : label;
}
const fullStamp = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** The ghosted "Added …" label for a task (with exact added/edited times on hover); '' if unknown. */
function addedHtml(created, edited) {
  if (!created) return '';
  let tip = `Added ${fullStamp(created)}`;
  if (edited && edited - created > 60_000) tip += `\nLast changed ${fullStamp(edited)}`;
  return `<span class="tp-added" title="${esc(tip)}">Added ${esc(addedLabel(created))}</span>`;
}

/** "Today", "Tomorrow", "Yesterday", or "Fri, Nov 20" (year shown only when it isn't this year). */
function dueLabel(iso) {
  const n = daysFromToday(iso);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  const label = formatDate(iso);
  return iso.slice(0, 4) === todayISO().slice(0, 4) ? label.replace(/, \d{4}$/, '') : label;
}
const dueClass = (iso) => (iso < todayISO() ? 'past' : iso === todayISO() ? 'today' : '');

/** A task row for search results (read-only list on the Search page). */
function taskRow(t, { kind, note, terms, source }) {
  const attrs = kind === 's'
    ? `data-kind="s" data-id="${t.id}"`
    : `data-kind="n" data-note="${note.id}" data-index="${t.index}" data-text="${esc(t.text)}"`;
  const text = terms ? highlight(t.text, terms) : kind === 's' ? plainTaskHtml(t.text, { done: t.done }) : inlineHtml(t.nodes, { done: t.done });
  let meta = '';
  if (source) {
    meta = kind === 's'
      ? '<div class="task-meta">Standalone task</div>'
      : `<div class="task-meta">in <button data-act="open-note" data-note="${note.id}">${esc(noteTitle(note))}</button></div>`;
  }
  return `<li class="task${t.done ? ' done' : ''}" ${attrs}>
    <button class="check" role="checkbox" aria-checked="${t.done}" data-act="toggle" title="${t.done ? 'Mark as not done' : 'Mark as done'}">${I.check}</button>
    <div class="task-body"><span class="task-text">${text || '&nbsp;'}</span>${meta}</div>
    <div class="task-actions">
      <button class="icon-btn sm" data-act="edit" title="Show in Tasks panel">${I.pencil}</button>
      <button class="icon-btn sm danger" data-act="delete" title="Delete">${I.trash}</button>
    </div>
  </li>`;
}

/** Board column of a task: 'todo' | 'doing' | 'done' (Done = checked). */
const stageOf = (t) => (t.done ? 'done' : t.stage === 'doing' ? 'doing' : 'todo');
const STAGES = [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done']];
const stageLabel = (st) => STAGES.find(([k]) => k === st)[1];
function stageChip(t) {
  if (t.done) return '';
  const st = stageOf(t);
  return `<button type="button" class="tp-stage ${st}" data-act="stage" title="Column on the board: ${stageLabel(st)} (click to move)">${stageLabel(st)}</button>`;
}

function tpRow(t, { kind, note, from = false }) {
  const attrs = kind === 's'
    ? `data-kind="s" data-id="${t.id}"`
    : `data-kind="n" data-note="${note.id}" data-index="${t.index}" data-text="${esc(t.text)}"`;
  const titleHtml = kind === 's' ? plainTaskHtml(t.text, { done: t.done }) : inlineHtml(t.nodes, { done: t.done });
  const body = t.body || '';
  const details = kind === 'n' && !t.bodyEditable
    ? `<div class="tp-details-ro">${esc(body)} <button type="button" data-act="open-task">Edit in note</button></div>`
    : `<textarea class="tp-details${body ? '' : ' empty'}" rows="1" maxlength="100000" placeholder="Add details" aria-label="Details">${esc(body)}</textarea>`;
  const due = t.due
    ? `<button type="button" class="tp-due ${dueClass(t.due)}" data-act="due" title="Due ${esc(formatDate(t.due))} — click to change">${I.calendar}<span>${esc(dueLabel(t.due))}</span></button>`
    : '';
  const canAddDetails = !body && !(kind === 'n' && !t.bodyEditable);
  return `<li class="tp-task${t.done ? ' done' : ''}" ${attrs}>
    <button class="check" role="checkbox" aria-checked="${t.done}" data-act="toggle" title="${t.done ? 'Mark as not done' : 'Mark as done'}">${I.check}</button>
    <div class="tp-main">
      <div class="tp-title" contenteditable="plaintext-only" spellcheck="true" role="textbox" aria-label="Task" data-plain="${esc(t.text)}">${titleHtml}</div>
      ${from ? `<div class="tp-from">${kind === 'n' ? `in <button type="button" data-act="open-note" data-note="${note.id}">${esc(noteTitle(note))}</button>` : 'Standalone task'}</div>` : ''}
      ${details}
      <div class="tp-meta">${stageChip(t)}${due}${kind === 's' ? addedHtml(t.createdAt, t.updatedAt) : addedHtml(t.created, t.edited)}</div>
    </div>
    <div class="tp-actions">
      ${canAddDetails ? `<button type="button" class="icon-btn sm" data-act="add-details" title="Add details">${I.text}</button>` : ''}
      ${t.due ? '' : `<button type="button" class="icon-btn sm" data-act="due" title="Add a due date">${I.calendar}</button>`}
      ${kind === 'n' ? `<button type="button" class="icon-btn sm" data-act="open-task" title="Show in “${esc(noteTitle(note))}”">${I.arrow}</button>` : ''}
      <button type="button" class="icon-btn sm danger" data-act="delete" title="Delete">${I.trash}</button>
    </div>
  </li>`;
}

function tpGroups(g) {
  let h = '';
  if (g.standalone.length) {
    h += `<div class="group">
      <div class="group-head"><span class="group-icon purple">${I.inbox}</span><span class="group-title">Standalone tasks</span><span class="group-count">${g.standalone.length}</span></div>
      <ul class="task-list">${g.standalone.map((t) => tpRow(t, { kind: 's' })).join('')}</ul>
    </div>`;
  }
  for (const { note, tasks } of g.notes) {
    const path = folderPath(note.folderId);
    h += `<div class="group">
      <button type="button" class="group-head" data-act="open-note" data-note="${note.id}" title="Open “${esc(noteTitle(note))}”">
        ${isScratch(note.id) ? `<span class="group-icon green">${I.sticky}</span>` : `<span class="group-icon blue">${I.note}</span>`}
        <span class="group-title">${esc(noteTitle(note))}</span>
        <span class="group-path">${path ? esc(path) : ''}</span>
        <span class="group-count">${tasks.length}</span>
      </button>
      <ul class="task-list">${tasks.map((t) => tpRow(t, { kind: 'n', note })).join('')}</ul>
    </div>`;
  }
  return h;
}

/**
 * Open tasks with a due date coming up, at the top of the panel: Overdue, Today, Tomorrow,
 * Later this week (through Sunday). A group only appears when it has something in it.
 * The tasks also stay in their usual group below, so each note's list stays complete.
 */
function dueSoonHtml(open) {
  const today = todayISO();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const toSunday = (7 - dow) % 7;
  const buckets = { overdue: [], today: [], tomorrow: [], week: [] };
  const add = (t, extra) => {
    if (!t.due) return;
    const n = daysFromToday(t.due, today);
    const b = n < 0 ? 'overdue' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= toSunday ? 'week' : null;
    if (b) buckets[b].push({ t, ...extra });
  };
  for (const t of open.standalone) add(t, { kind: 's' });
  for (const { note, tasks } of open.notes) for (const t of tasks) add(t, { kind: 'n', note });
  const groups = [
    ['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Later this week'],
  ].filter(([k]) => buckets[k].length);
  if (!groups.length) return '';
  return `<section class="tp-soon" aria-label="Due soon">${groups.map(([k, label]) => {
    const items = buckets[k].sort((a, b) => a.t.due.localeCompare(b.t.due) || collator.compare(a.t.text, b.t.text));
    return `<div class="tp-soon-group ${k}">
      <div class="tp-soon-head"><span class="dot"></span>${label}<span class="n">${items.length}</span></div>
      <ul class="task-list">${items.map((x) => tpRow(x.t, { kind: x.kind, note: x.note, from: true })).join('')}</ul>
    </div>`;
  }).join('')}</section>`;
}

/** Is something in the panel being edited right now? (Then re-rendering waits until it's done.) */
function taskEditing() {
  const a = document.activeElement;
  return (a && a.closest?.('.tp-task') && (a.classList.contains('tp-title') || a.classList.contains('tp-details'))) || !$('#due-pop').hidden;
}
/** Redraw everything that lists tasks (the panel, and the board when it's open). */
function renderTaskViews() { renderTaskPanel(); renderBoard(); }

function renderTaskPanel() {
  const box = $('#tp-body');
  if (!box) return;
  if (taskEditing()) { tasksPanel.dirty = true; return; }
  tasksPanel.dirty = false;
  const c = collectTasks();
  if (!c.openCount && !c.doneCount) {
    box.innerHTML = `<div class="tp-empty">No tasks yet.<br>Add one above, or type <code>[ ]</code> at the start of a line in any note — it shows up here, grouped by note.</div>`;
    return;
  }
  let h = dueSoonHtml(c.open);
  h += `<section class="section">
    <h3 class="section-head open">Open <span class="pill">${c.openCount}</span></h3>
    ${c.openCount ? tpGroups(c.open) : `<div class="all-clear">${I.check} All caught up</div>`}
  </section>`;
  if (c.doneCount) {
    h += `<section class="section done-section">
      <button type="button" class="section-head completed${S.showCompleted ? ' expanded' : ''}" data-act="toggle-completed" aria-expanded="${S.showCompleted}">
        <span class="chev">${I.chevron}</span>Completed <span class="pill">${c.doneCount}</span>
      </button>
      ${S.showCompleted ? tpGroups(c.done) : ''}
    </section>`;
  }
  box.innerHTML = h;
  $$('.tp-details', box).forEach(autosize);
}
const renderTaskPanelSoon = debounce(() => { renderTaskViews(); renderTodoCount(); }, 320);
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; }

function resolveRow(li) {
  if (!li) return null;
  if (li.dataset.kind === 's') {
    const t = S.tasks.get(li.dataset.id);
    return t ? { kind: 's', task: t, done: t.done, text: t.text } : null;
  }
  const note = S.notes.get(li.dataset.note);
  if (!note) return null;
  const t = findNoteTask(note, Number(li.dataset.index), li.dataset.text);
  return t ? { kind: 'n', note, t, done: t.done, text: t.text } : null;
}

function toggleRow(li) {
  const r = resolveRow(li);
  if (!r) { toast('That task changed — the list was refreshed.'); refreshAll(); return; }
  const done = !r.done;
  if (r.kind === 's') {
    setStandaloneDone(r.task, done);
  } else {
    const doc = setTaskChecked(noteInfo(r.note).doc, r.t.index, done);
    if (!doc) { toast('That task changed — the list was refreshed.'); refreshAll(); return; }
    setNoteContent(r.note.id, JSON.stringify(doc), { render: false });
    li.dataset.index = String(r.t.index);
  }
  li.classList.add(done ? 'completing' : 'reopening');
  $('.check', li).setAttribute('aria-checked', String(done));
  renderTodoCount();
  renderTaskPanelSoon(); // short delay so the check is visible before it moves sections
  if (S.view.type === 'search') setTimeout(renderSearchResults, 320);
}

function deleteRow(li) {
  const r = resolveRow(li);
  if (!r) { refreshAll(); return; }
  if (r.kind === 's') { deleteStandalone(r.task); return; }
  const n = r.note;
  const doc = removeTask(noteInfo(n).doc, r.t.index);
  if (!doc) { refreshAll(); return; }
  const before = n.content;
  const countBefore = noteInfo(n).tasks.length;
  setNoteContent(n.id, JSON.stringify(doc));
  const after = n.content;
  const subs = countBefore - noteInfo(n).tasks.length - 1;
  toast(`${subs > 0 ? `Task and ${plural(subs, 'sub-task')}` : 'Task'} removed from “${noteTitle(n)}”`, {
    action: 'Undo',
    onAction: () => {
      const cur = S.notes.get(n.id);
      if (!cur) return;
      if (cur.content !== after) { toast('The note has changed since — open it to restore the task.', { type: 'error' }); return; }
      setNoteContent(n.id, before);
    },
  });
}

/**
 * Save a change made in the panel. `patch`: { title?, body?, due? }.
 * Standalone tasks are saved to the server; note to-dos are changed inside their note.
 */
function commitTask(li, patch) {
  const r = resolveRow(li);
  if (!r) { toast('That task changed somewhere else — the list was refreshed.', { type: 'error' }); refreshAll(); return false; }
  if (r.kind === 's') {
    const t = r.task;
    if (patch.stage !== undefined) {
      const wasDone = t.done;
      t.done = patch.stage === 'done';
      if (patch.stage !== 'done') t.stage = patch.stage;
      if (t.done !== wasDone) t.completedAt = t.done ? Date.now() : null;
    }
    if (patch.title !== undefined) t.text = patch.title;
    if (patch.body !== undefined) t.body = patch.body;
    if (patch.due !== undefined) t.due = patch.due || null;
    t.updatedAt = Date.now();
    sync.push({ method: 'PATCH', url: `/api/tasks/${t.id}`, body: { text: t.text, body: t.body || '', due: t.due || null, stage: t.stage === 'doing' ? 'doing' : 'todo', done: !!t.done }, key: `task:${t.id}` });
  } else {
    const doc = updateTask(noteInfo(r.note).doc, r.t.index, patch);
    if (!doc) {
      toast('Those details include formatting, so edit them in the note.', { type: 'error', action: 'Open note', onAction: () => navigate(`#/note/${r.note.id}`, { task: r.t.index }) });
      return false;
    }
    setNoteContent(r.note.id, JSON.stringify(doc), { render: false });
    const now = noteTasks(r.note).find((x) => x.index === r.t.index);
    if (now) li.dataset.text = now.text;
  }
  renderTodoCount();
  return true;
}

/** Move a task to a board column (To do / Doing / Done). */
function moveToStage(li, st) {
  const r = resolveRow(li);
  if (!r) { refreshAll(); return; }
  const from = r.kind === 's' ? stageOf(r.task) : stageOf(r.t);
  if (from === st) return;
  if (!commitTask(li, { stage: st })) return;
  if (st === 'done' || from === 'done') li.classList.add(st === 'done' ? 'completing' : 'reopening');
  renderTodoCount();
  renderTaskPanelSoon();
}
function stageMenu(li, anchor) {
  const r = resolveRow(li);
  if (!r) return;
  const cur = r.kind === 's' ? stageOf(r.task) : stageOf(r.t);
  const a = (anchor || li).getBoundingClientRect();
  showMenu({ x: a.left, y: a.bottom + 4 }, STAGES.map(([k, label]) => ({
    label: k === cur ? `${label}  ✓` : label, icon: k === 'done' ? I.check : k === 'doing' ? I.board : I.listTodo, run: () => moveToStage(li, k),
  })));
}

function addTask(text) {
  text = text.trim().slice(0, 2000);
  if (!text) return;
  const now = Date.now();
  const t = { id: uid(), text, body: '', due: null, stage: 'todo', done: false, createdAt: now, completedAt: null, updatedAt: now };
  S.tasks.set(t.id, t);
  sync.push({ method: 'POST', url: '/api/tasks', body: { id: t.id, text } });
  refreshAll();
}

/** Open the panel and bring a task into view (optionally opening its due-date picker). */
function revealTask(selector, { due = false, focus = false, stage = false } = {}) {
  tasksPanel.open();
  let li = $(`#tp-body ${selector}`);
  if (!li && !S.showCompleted) {
    S.showCompleted = true;
    store.set(KEYS.showCompleted, true);
    renderTaskPanel();
    li = $(`#tp-body ${selector}`);
  }
  if (!li) return;
  li.scrollIntoView({ block: 'nearest' });
  li.classList.remove('flash');
  void li.offsetWidth;
  li.classList.add('flash');
  if (due) duePicker.open(li, $('.tp-due', li));
  else if (stage) stageMenu(li, $('.tp-stage', li));
  else if (focus) $('.tp-title', li)?.focus();
}

const tasksPanel = {
  pinned: store.get(KEYS.tasksPinned, true) !== false,
  hovering: false,
  timer: null,
  dirty: false,
  apply() {
    const app = $('#app');
    app.classList.toggle('tp-closed', !this.pinned);
    if (this.pinned) app.classList.remove('tp-peek');
    const closing = this.pinned || !isDesktop();
    $('#tp-pin').innerHTML = closing ? I.panelRightClose : I.pin;
    $('#tp-pin').title = closing ? `Hide the Tasks panel — hover the button at top right to see it again${shortcuts.hint('toggleTasks')}` : `Keep the Tasks panel open${shortcuts.hint('toggleTasks')}`;
    $('#tp-pin').setAttribute('aria-label', closing ? 'Hide the Tasks panel' : 'Keep the Tasks panel open');
  },
  visible() {
    const app = $('#app');
    return isDesktop() ? this.pinned || app.classList.contains('tp-peek') : app.classList.contains('tp-open-mobile');
  },
  setPinned(on) {
    this.pinned = on;
    store.set(KEYS.tasksPinned, on);
    this.apply();
    if (!on && this.hovering) this.peek(true);
  },
  peek(on) {
    clearTimeout(this.timer);
    if (this.pinned || !isDesktop()) return;
    $('#app').classList.toggle('tp-peek', on);
    this.apply();
  },
  maybeHide(delay = 300) {
    clearTimeout(this.timer);
    if (this.pinned || !isDesktop()) return;
    this.timer = setTimeout(() => {
      const busy = this.hovering || $('#taskpanel').contains(document.activeElement) || !$('#due-pop').hidden || !$('#menu').hidden || $('#dialog').open;
      if (!busy) { $('#app').classList.remove('tp-peek'); this.apply(); }
    }, delay);
  },
  open({ focusAdd = false } = {}) {
    if (!isDesktop()) $('#app').classList.add('tp-open-mobile');
    else if (!this.pinned) this.setPinned(true);
    this.apply();
    renderTaskPanel();
    if (focusAdd) $('#add-task-input').focus();
  },
  close() {
    $('#app').classList.remove('tp-open-mobile', 'tp-peek');
    if (isDesktop()) this.setPinned(false);
    this.apply();
  },
  toggle() { if (this.visible() && (this.pinned || !isDesktop())) this.close(); else this.open(); },
  setup() {
    $('.tp-icon').innerHTML = I.checkSquare;
    $('.tp-handle-icon').innerHTML = I.panelRightOpen;
    $('#add-task-form .add-icon').innerHTML = I.plus;
    this.apply();
    const enter = () => { this.hovering = true; this.peek(true); };
    const leave = () => { this.hovering = false; this.maybeHide(); };
    for (const el of [$('#taskpanel'), $('#tp-handle')]) {
      el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') enter(); });
      el.addEventListener('pointerleave', leave);
    }
    $('#tp-handle').addEventListener('click', () => this.open());
    $('#tp-pin').addEventListener('click', () => (this.pinned || !isDesktop() ? this.close() : this.setPinned(true)));
    $('#tp-scrim').addEventListener('click', () => this.close());
    $('#taskpanel').addEventListener('focusin', () => this.peek(true));
    $('#taskpanel').addEventListener('focusout', () => this.maybeHide(150));
    document.addEventListener('pointerdown', (e) => {
      if (this.pinned || !$('#app').classList.contains('tp-peek')) return;
      if (e.target.closest('#taskpanel, #tp-handle, #due-pop, #menu, #dialog')) return;
      $('#app').classList.remove('tp-peek');
      this.apply();
    }, true);
    addEventListener('resize', () => this.apply());

    // Add a standalone task
    const ac = attachDateAutocomplete($('#add-task-input'));
    void ac;
    $('#add-task-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#add-task-input');
      addTask(input.value);
      input.value = '';
      input.focus();
    });

    wireTaskList($('#tp-body'));
    $('#tp-board').innerHTML = `${I.board}<span>View as board</span>`;
    $('#tp-board').addEventListener('click', () => (S.view.type === 'board' ? navigate(store.get(KEYS.last, HOME)) : navigate('#/board')));
  },
};

/**
 * Clicks and inline editing for a list of tasks (the Tasks panel, or the board): check off,
 * delete, due date, column, details, and editing titles and details in place.
 */
function wireTaskList(body) {
  body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !body.contains(el)) return;
    const li = el.closest('.tp-task');
    switch (el.dataset.act) {
      case 'toggle': toggleRow(li); break;
      case 'delete': deleteRow(li); break;
      case 'due': duePicker.open(li, $('.tp-due', li) || el); break;
      case 'stage': stageMenu(li, el); break;
      case 'card-menu': cardMenu(li, el); break;
      case 'add-details': {
        li.classList.add('adding');
        $('.tp-details', li)?.focus();
        break;
      }
      case 'open-note': navigate(`#/note/${el.dataset.note}`); break;
      case 'open-task': {
        const r = resolveRow(li);
        if (r?.kind === 'n') navigate(`#/note/${r.note.id}`, { task: r.t.index });
        break;
      }
      case 'toggle-completed':
        S.showCompleted = !S.showCompleted;
        store.set(KEYS.showCompleted, S.showCompleted);
        renderTaskPanel();
        break;
      default: break;
    }
  });

  // ---- inline editing: title
  body.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el.classList?.contains('tp-title') && !el.dataset.editing) {
      el.dataset.editing = '1';
      el.closest('[draggable]')?.setAttribute('draggable', 'false'); // a card being edited doesn't drag
      el.textContent = el.dataset.plain; // edit as plain text (dates appear as "Fri, Nov 20, 2026")
      const sel = getSelection();
      sel.selectAllChildren(el);
      sel.collapseToEnd();
    }
  });
  body.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.classList?.contains('tp-title')) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); el.dataset.cancel = '1'; el.blur(); }
      e.stopPropagation(); // don't trigger app shortcuts while typing
    } else if (el.classList?.contains('tp-details')) {
      if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
      e.stopPropagation();
    }
  });
  body.addEventListener('focusout', (e) => {
    const el = e.target;
    const li = el.closest?.('.tp-task');
    if (el.classList?.contains('tp-title')) {
      const cancel = el.dataset.cancel === '1';
      delete el.dataset.cancel;
      delete el.dataset.editing;
      const v = el.textContent.replace(/\s+/g, ' ').trim();
      if (!cancel && v && v !== el.dataset.plain && li) {
        if (commitTask(li, { title: v })) el.dataset.plain = v;
      }
      setTimeout(() => { if (!taskEditing()) renderTaskViews(); });
    } else if (el.classList?.contains('tp-details')) {
      li?.classList.remove('adding');
      clearTimeout(el._save);
      if (li && el.dataset.changed) { delete el.dataset.changed; commitTask(li, { body: el.value }); }
      setTimeout(() => { if (!taskEditing()) renderTaskViews(); });
    }
  });
  // ---- inline editing: details (saved as you type, and when you leave the box)
  body.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.classList?.contains('tp-details')) return;
    el.classList.toggle('empty', !el.value);
    autosize(el);
    el.dataset.changed = '1';
    clearTimeout(el._save);
    el._save = setTimeout(() => {
      const li = el.closest('.tp-task');
      if (li && el.dataset.changed) { delete el.dataset.changed; commitTask(li, { body: el.value }); }
    }, 700);
  });
}

/* ------------------------------------------------------------- board view */
/**
 * The same tasks as columns: To do, Doing, Done. Drag a card to another column (or use its
 * menu); check it off to send it to Done. Edits happen right on the card, like in the list.
 */
const BOARD_DONE_LIMIT = 40;
function boardCard(t, { kind, note }) {
  const attrs = kind === 's'
    ? `data-kind="s" data-id="${t.id}"`
    : `data-kind="n" data-note="${note.id}" data-index="${t.index}" data-text="${esc(t.text)}"`;
  const titleHtml = kind === 's' ? plainTaskHtml(t.text, { done: t.done }) : inlineHtml(t.nodes, { done: t.done });
  const body = (t.body || '').trim();
  const due = t.due ? `<button type="button" class="tp-due ${dueClass(t.due)}" data-act="due" title="Due ${esc(formatDate(t.due))} — click to change">${I.calendar}<span>${esc(dueLabel(t.due))}</span></button>` : '';
  return `<li class="tp-task board-card${t.done ? ' done' : ''}" ${attrs} draggable="true">
    <div class="bc-top">
      <button class="check" role="checkbox" aria-checked="${t.done}" data-act="toggle" title="${t.done ? 'Mark as not done' : 'Mark as done'}">${I.check}</button>
      <div class="tp-title" contenteditable="plaintext-only" spellcheck="true" role="textbox" aria-label="Task" data-plain="${esc(t.text)}">${titleHtml}</div>
      <button type="button" class="icon-btn sm bc-more" data-act="card-menu" title="Move, open or delete">${I.more}</button>
    </div>
    ${body ? `<div class="bc-details">${esc(body)}</div>` : ''}
    <div class="tp-meta">${kind === 'n' ? `<button type="button" class="bc-from" data-act="open-note" data-note="${note.id}">${isScratch(note.id) ? I.sticky : I.note}<span>${esc(noteTitle(note))}</span></button>` : `<span class="bc-from standalone">${I.inbox}<span>Standalone</span></span>`}${due}${kind === 's' ? addedHtml(t.createdAt, t.updatedAt) : addedHtml(t.created, t.edited)}</div>
  </li>`;
}
function cardMenu(li, anchor) {
  const r = resolveRow(li);
  if (!r) return;
  const cur = r.kind === 's' ? stageOf(r.task) : stageOf(r.t);
  const a = anchor.getBoundingClientRect();
  showMenu({ x: a.right - 200, y: a.bottom + 4 }, [
    ...STAGES.filter(([k]) => k !== cur).map(([k, label]) => ({ label: `Move to ${label}`, icon: k === 'done' ? I.check : I.board, run: () => moveToStage(li, k) })),
    ...(r.kind === 'n' ? [{ label: `Open “${noteTitle(r.note)}”`, icon: I.note, run: () => navigate(`#/note/${r.note.id}`, { task: r.t.index }) }] : []),
    { label: 'Edit details in the Tasks panel', icon: I.text, run: () => revealTask(r.kind === 's' ? `[data-kind="s"][data-id="${r.task.id}"]` : `[data-kind="n"][data-note="${r.note.id}"][data-index="${r.t.index}"]`, { focus: true }) },
    'sep',
    { label: 'Delete', icon: I.trash, danger: true, run: () => deleteRow(li) },
  ]);
}

/** Which tasks the board shows: all, standalone only, or one note's. */
function boardSources(c) {
  const notes = new Map();
  for (const g of [...c.open.notes, ...c.done.notes]) notes.set(g.note.id, g.note);
  return [...notes.values()];
}
function renderBoard() {
  const root = $('#board');
  if (!root || S.view.type !== 'board') return;
  if (taskEditing() || root.dataset.dragging) { tasksPanel.dirty = true; return; }
  const c = collectTasks();
  const filter = store.get(KEYS.boardFilter, '');
  const want = (kind, note) => !filter || (filter === 's' ? kind === 's' : kind === 'n' && note.id === filter);
  const cols = { todo: [], doing: [], done: [] };
  for (const t of c.open.standalone) if (want('s')) cols[stageOf(t)].push({ t, kind: 's' });
  for (const { note, tasks } of c.open.notes) for (const t of tasks) if (want('n', note)) cols[stageOf(t)].push({ t, kind: 'n', note });
  for (const t of c.done.standalone) if (want('s')) cols.done.push({ t, kind: 's', when: t.completedAt || t.updatedAt || 0 });
  for (const { note, tasks } of c.done.notes) for (const t of tasks) if (want('n', note)) cols.done.push({ t, kind: 'n', note, when: t.edited || 0 });
  const added = (x) => (x.kind === 's' ? x.t.createdAt : x.t.created) || 0;
  const openOrder = (a, b) => (a.t.due || '9999').localeCompare(b.t.due || '9999') || added(b) - added(a);
  cols.todo.sort(openOrder);
  cols.doing.sort(openOrder);
  cols.done.sort((a, b) => b.when - a.when);
  const doneTotal = cols.done.length;
  cols.done = cols.done.slice(0, BOARD_DONE_LIMIT);

  const sel = $('#board-filter');
  const sources = boardSources(c);
  if (filter && filter !== 's' && !sources.some((n) => n.id === filter)) store.set(KEYS.boardFilter, '');
  sel.innerHTML = `<option value="">All tasks</option><option value="s">Standalone tasks</option>${sources.map((n) => `<option value="${n.id}">${esc(noteTitle(n))}</option>`).join('')}`;
  sel.value = store.get(KEYS.boardFilter, '');
  $('#board-sub').textContent = `${cols.todo.length} to do · ${cols.doing.length} doing · ${doneTotal} done`;

  for (const [k] of STAGES) {
    const list = $(`.board-col[data-stage="${k}"] .board-list`, root);
    $(`.board-col[data-stage="${k}"] .bcol-count`, root).textContent = k === 'done' ? String(doneTotal) : String(cols[k].length);
    list.innerHTML = cols[k].length
      ? cols[k].map((x) => boardCard(x.t, x)).join('') + (k === 'done' && doneTotal > cols.done.length ? `<li class="board-more">${doneTotal - cols.done.length} older in Completed (Tasks panel)</li>` : '')
      : `<li class="board-empty">${k === 'todo' ? 'Nothing to do here' : k === 'doing' ? 'Drag a card here when you start it' : 'Finished tasks land here'}</li>`;
  }
}
function showBoard() {
  teardownNote();
  setView({ type: 'board' });
  main.innerHTML = `${mobileBar('Board')}
    <div class="board-view" id="board">
      <header class="board-head">
        <div class="page-icon purple">${I.board}</div>
        <div class="board-titles"><h1>Board</h1><p class="page-sub" id="board-sub"></p></div>
        <label class="board-filter-wrap">Show <select id="board-filter" aria-label="Which tasks"></select></label>
        <button type="button" class="btn" id="board-close">${I.panelClose}<span>Back to notes</span></button>
      </header>
      <div class="board-cols">
        ${STAGES.map(([k, label]) => `<section class="board-col ${k}" data-stage="${k}">
          <h2 class="bcol-head"><span class="dot"></span>${label}<span class="bcol-count"></span></h2>
          <ul class="board-list"></ul>
        </section>`).join('')}
      </div>
    </div>`;
  const root = $('#board');
  wireTaskList(root);
  $('#board-filter').addEventListener('change', (e) => { store.set(KEYS.boardFilter, e.target.value); renderBoard(); });
  $('#board-close').addEventListener('click', () => navigate(store.get(KEYS.last, HOME)));
  // ---- drag a card to another column
  let dragged = null;
  root.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.board-card');
    if (!card) return;
    dragged = card;
    root.dataset.dragging = '1';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-taskule-card', '1');
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  root.addEventListener('dragover', (e) => {
    const col = e.target.closest('.board-col');
    if (!dragged || !col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    $$('.board-col.drop', root).forEach((x) => x !== col && x.classList.remove('drop'));
    col.classList.add('drop');
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) $$('.board-col.drop', root).forEach((x) => x.classList.remove('drop')); });
  root.addEventListener('drop', (e) => {
    const col = e.target.closest('.board-col');
    if (!dragged || !col) return;
    e.preventDefault();
    const card = dragged;
    dragged = null;
    delete root.dataset.dragging;
    $$('.board-col.drop', root).forEach((x) => x.classList.remove('drop'));
    moveToStage(card, col.dataset.stage);
    renderBoard();
  });
  root.addEventListener('dragend', () => {
    dragged = null;
    delete root.dataset.dragging;
    $$('.board-col.drop, .board-card.dragging', root).forEach((x) => x.classList.remove('drop', 'dragging'));
    renderBoard();
  });
  renderTree();
  renderBoard();
  $('#tp-board')?.classList.add('on');
}

/** The due-date picker:/** The due-date picker: type plain English ("next fri"), pick a suggestion, or use the calendar. */
const duePicker = {
  li: null,
  kb: 0,
  open(li, anchor) {
    const r = resolveRow(li);
    if (!r) return;
    this.li = li;
    const cur = r.kind === 's' ? r.task.due : r.t.due;
    const pop = $('#due-pop');
    pop.hidden = false;
    $('#due-input').value = '';
    $('#due-native').value = cur || '';
    $('#due-clear').hidden = !cur;
    this.suggest('');
    const a = (anchor || li).getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(a.left, innerWidth - w - 8);
    let top = a.bottom + 6;
    if (top + h > innerHeight - 8) top = Math.max(8, a.top - h - 6);
    left = Math.max(8, left);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    $('#due-input').focus();
  },
  close() {
    $('#due-pop').hidden = true;
    this.li = null;
    setTimeout(() => { if (!taskEditing()) renderTaskPanel(); tasksPanel.maybeHide(); });
  },
  pick(iso) {
    const li = this.li;
    this.close();
    if (li && li.isConnected) commitTask(li, { due: iso || null });
    renderTaskPanel();
  },
  suggest(q) {
    let items;
    if (!q.trim()) {
      items = ['today', 'tomorrow', 'next monday', 'in 1 week'].flatMap((p) => parseExact(p).slice(0, 1).map((c) => ({ iso: c.iso, label: formatDate(c.iso), hint: p === 'next monday' ? 'Next Monday' : p === 'in 1 week' ? 'In a week' : p[0].toUpperCase() + p.slice(1) })));
    } else {
      items = suggestDates(q);
    }
    this.items = items;
    this.kb = 0;
    $('#due-sugg').innerHTML = items.length
      ? items.map((s, i) => `<button type="button" data-iso="${s.iso}" class="${i === 0 ? 'kb' : ''}"><span>${esc(s.label)}</span><span>${esc(s.hint || '')}</span></button>`).join('')
      : '<div class="none">No date recognised — try “next friday” or “12/1”.</div>';
  },
  setup() {
    const input = $('#due-input');
    input.addEventListener('input', () => this.suggest(input.value));
    input.addEventListener('keydown', (e) => {
      const btns = $$('#due-sugg button');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.kb = Math.max(0, Math.min(btns.length - 1, this.kb + (e.key === 'ArrowDown' ? 1 : -1)));
        btns.forEach((b, i) => b.classList.toggle('kb', i === this.kb));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (btns[this.kb]) this.pick(btns[this.kb].dataset.iso);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const li = this.li;
        this.close();
        if (li) $('.tp-due', li)?.focus();
      }
      e.stopPropagation();
    });
    $('#due-sugg').addEventListener('click', (e) => { const b = e.target.closest('button[data-iso]'); if (b) this.pick(b.dataset.iso); });
    $('#due-native').addEventListener('change', (e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) this.pick(e.target.value); });
    $('#due-clear').addEventListener('click', () => this.pick(null));
    document.addEventListener('pointerdown', (e) => {
      if (!$('#due-pop').hidden && !e.target.closest('#due-pop')) this.close();
    }, true);
  },
};

function setupMainDelegation() {
  main.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-sidebar]')) { openSidebar(); return; }
    const el = e.target.closest('[data-act]');
    if (!el || !main.contains(el)) return;
    const li = el.closest('.task');
    switch (el.dataset.act) {
      case 'toggle': toggleRow(li); break;
      case 'edit': {
        const r = resolveRow(li);
        if (r?.kind === 's') revealTask(`[data-kind="s"][data-id="${r.task.id}"]`, { focus: true });
        else if (r) navigate(`#/note/${r.note.id}`, { task: r.t.index });
        break;
      }
      case 'delete': deleteRow(li); break;
      case 'open-note': navigate(`#/note/${el.dataset.note}`); break;
      case 'open-note-match': navigate(`#/note/${el.dataset.note}`, { find: currentTerms() }); break;
      case 'reveal-folder': revealFolder(el.dataset.id); break;
      case 'new-note': createNote(); break;
      default: break;
    }
  });
}

/* ------------------------------------------------------------- search */
function currentTerms() {
  return $('#search').value.toLowerCase().split(/\s+/).filter(Boolean);
}

function highlight(text, terms) {
  if (!terms?.length) return esc(text);
  const lower = text.toLowerCase();
  const ranges = [];
  for (const term of terms) {
    let i = lower.indexOf(term);
    while (i !== -1) { ranges.push([i, i + term.length]); i = lower.indexOf(term, i + term.length); }
  }
  if (!ranges.length) return esc(text);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  let out = '';
  let pos = 0;
  for (const [a, b] of merged) { out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>'; pos = b; }
  return out + esc(text.slice(pos));
}

function snippet(content, terms) {
  const lower = content.toLowerCase();
  let idx = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i !== -1 && (idx === -1 || i < idx)) idx = i; }
  if (idx === -1) return content.slice(0, 140).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + 100);
  return (start > 0 ? '…' : '') + content.slice(start, end).replace(/\s+/g, ' ').trim() + (end < content.length ? '…' : '');
}

function showSearch() {
  if (S.view.type !== 'search') {
    flushNotes();
    teardownNote();
    setView({ type: 'search' });
    main.innerHTML = `${mobileBar('Search')}
      <div class="page">
        <header class="page-head">
          <div class="page-icon blue">${I.search}</div>
          <div><h1>Search</h1><p class="page-sub" id="search-sub"></p></div>
        </header>
        <div id="search-results"></div>
      </div>`;
    renderTree();
  }
  renderSearchResults();
}

function renderSearchResults() {
  const box = $('#search-results');
  if (!box) return;
  if ($('.task-edit', box)) return;
  const terms = currentTerms();
  if (!terms.length) { box.innerHTML = ''; return; }
  const all = (hay) => { const h = hay.toLowerCase(); return terms.every((t) => h.includes(t)); };

  const notes = [];
  for (const n of S.notes.values()) {
    const path = folderPath(n.folderId);
    if (!all(`${n.title}\n${noteInfo(n).text}\n${path}`)) continue;
    const titleHits = terms.filter((t) => n.title.toLowerCase().includes(t)).length;
    notes.push({ n, path, score: titleHits * 10 + (n.updatedAt || 0) / 1e13 });
  }
  notes.sort((a, b) => b.score - a.score);

  const tasks = [];
  for (const t of S.tasks.values()) if (all(t.text)) tasks.push({ t, kind: 's' });
  for (const n of sortedNotes()) for (const t of noteTasks(n)) if (all(t.text)) tasks.push({ t, kind: 'n', note: n });
  tasks.sort((a, b) => a.t.done - b.t.done);

  const folders = [...S.folders.values()].filter((f) => all(f.name)).sort((a, b) => collator.compare(a.name, b.name));

  const total = notes.length + tasks.length + folders.length;
  $('#search-sub').innerHTML = `${plural(total, 'result')} for “${esc($('#search').value.trim())}”`;
  if (!total) {
    box.innerHTML = `<div class="empty"><div class="empty-icon" style="background:var(--blue-soft);color:var(--blue)">${I.search}</div><h3>No matches</h3><p>Try fewer or different words.</p></div>`;
    return;
  }
  let h = '';
  if (notes.length) {
    h += `<section class="section"><h2 class="section-head">Notes <span class="pill">${notes.length}</span></h2><div class="group">`;
    for (const { n, path } of notes.slice(0, 100)) {
      const snip = snippet(noteInfo(n).text, terms);
      h += `<button class="result" data-act="open-note-match" data-note="${n.id}">
        <div class="result-title"><span class="group-icon">${I.note}</span><span>${highlight(noteTitle(n), terms)}</span>${path ? `<span class="result-path">${highlight(path, terms)}</span>` : ''}</div>
        ${snip ? `<div class="result-snippet">${highlight(snip, terms)}</div>` : ''}
      </button>`;
    }
    h += '</div></section>';
  }
  if (tasks.length) {
    h += `<section class="section"><h2 class="section-head">Tasks <span class="pill">${tasks.length}</span></h2><div class="group"><ul class="task-list">`;
    h += tasks.slice(0, 200).map(({ t, kind, note }) => taskRow(t, { kind, note, terms, source: true })).join('');
    h += '</ul></div></section>';
  }
  if (folders.length) {
    h += `<section class="section"><h2 class="section-head">Folders <span class="pill">${folders.length}</span></h2><div class="group">`;
    for (const f of folders) {
      const parent = folderPath(f.parentId);
      h += `<button class="result" data-act="reveal-folder" data-id="${f.id}"><div class="result-title"><span class="group-icon" style="color:var(--muted)">${I.folder}</span><span>${highlight(f.name, terms)}</span>${parent ? `<span class="result-path">${esc(parent)}</span>` : ''}</div></button>`;
    }
    h += '</div></section>';
  }
  box.innerHTML = h;
}

function revealFolder(id) {
  for (const f of folderChain(id)) S.expanded.add(f.id);
  saveExpanded();
  S.selectedFolderId = id;
  renderTree();
  const row = $(`.tree-row.folder[data-id="${id}"]`);
  openSidebar();
  row?.scrollIntoView({ block: 'center' });
  row?.focus({ preventScroll: true });
}

function setupSearch() {
  const input = $('#search');
  const run = debounce(() => {
    if (input.value.trim()) showSearch();
    else if (S.view.type === 'search') route();
  }, 120);
  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (input.value.trim() && S.view.type !== 'search') showSearch(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      input.value = '';
      run.cancel();
      if (S.view.type === 'search') route();
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run.cancel();
      if (input.value.trim()) showSearch();
      $('#search-results [data-act]')?.focus();
    } else if (e.key === 'ArrowDown') {
      const first = $('#search-results [data-act]');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  // Typing "search" by mistake? the native clear (x) button fires 'search'
  input.addEventListener('search', () => { if (!input.value) run(); });
}

/* ------------------------------------------------------------- note editor */
let editor = null; // the active rich-text editor (only while a note is open)
let toolbarFrame = 0;

function teardownNote() {
  if (!editor) return;
  try { editor.destroy(); } catch { /* ignore */ }
  editor = null;
}

const TOOLBAR = [
  { id: 'paragraph', html: '¶', title: 'Normal text', run: (e) => e.chain().focus().setParagraph().run(), on: (e) => e.isActive('paragraph') && !e.isActive('taskItem') && !e.isActive('listItem') },
  { id: 'h1', html: 'H1', title: 'Heading 1 (Ctrl+Alt+1)', run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), on: (e) => e.isActive('heading', { level: 1 }) },
  { id: 'h2', html: 'H2', title: 'Heading 2 (Ctrl+Alt+2)', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), on: (e) => e.isActive('heading', { level: 2 }) },
  { id: 'h3', html: 'H3', title: 'Heading 3 (Ctrl+Alt+3)', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), on: (e) => e.isActive('heading', { level: 3 }) },
  'sep',
  { id: 'bold', icon: 'bold', title: 'Bold (Ctrl+B)', run: (e) => e.chain().focus().toggleBold().run(), on: (e) => e.isActive('bold') },
  { id: 'italic', icon: 'italic', title: 'Italic (Ctrl+I)', run: (e) => e.chain().focus().toggleItalic().run(), on: (e) => e.isActive('italic') },
  { id: 'underline', icon: 'underline', title: 'Underline (Ctrl+U)', run: (e) => e.chain().focus().toggleUnderline().run(), on: (e) => e.isActive('underline') },
  { id: 'strike', icon: 'strike', title: 'Strikethrough (Ctrl+Shift+S)', run: (e) => e.chain().focus().toggleStrike().run(), on: (e) => e.isActive('strike') },
  { id: 'code', icon: 'code', title: 'Inline code (Ctrl+E)', run: (e) => e.chain().focus().toggleCode().run(), on: (e) => e.isActive('code') },
  { id: 'link', icon: 'link', title: 'Link (Ctrl+K)', run: () => linkDialog(), on: (e) => e.isActive('link') },
  { id: 'highlight', icon: 'highlighter', title: 'Highlight (Ctrl+Shift+H)', run: (e) => (e.isActive('highlight') ? e.chain().focus().unsetHighlight().run() : e.chain().focus().setHighlight({ color: '#fde68a' }).run()), on: (e) => e.isActive('highlight') },
  { id: 'clear', icon: 'eraser', title: 'Clear formatting (bold, colors, highlights…)', run: (e) => e.chain().focus().unsetAllMarks().run() },
  'sep',
  { id: 'bullet', icon: 'list', title: 'Bulleted list (Ctrl+Shift+8)', run: (e) => e.chain().focus().toggleBulletList().run(), on: (e) => e.isActive('bulletList') },
  { id: 'ordered', icon: 'listOrdered', title: 'Numbered list (Ctrl+Shift+7)', run: (e) => e.chain().focus().toggleOrderedList().run(), on: (e) => e.isActive('orderedList') },
  { id: 'quote', icon: 'quote', title: 'Quote (Ctrl+Shift+B)', run: (e) => e.chain().focus().toggleBlockquote().run(), on: (e) => e.isActive('blockquote') },
  { id: 'codeblock', icon: 'codeBlock', title: 'Code block', run: (e) => e.chain().focus().toggleCodeBlock().run(), on: (e) => e.isActive('codeBlock') },
  { id: 'hr', icon: 'minus', title: 'Divider', run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: 'image', icon: 'image', title: 'Insert image — or paste / drag one in. Drag the corners to resize.', run: () => pickImages() },
  { id: 'table', icon: 'table', title: 'Table — inside a table, opens row/column options', run: (e, btn) => tableAction(e, btn), on: (e) => e.isActive('table') },
  'sep',
  { id: 'task', icon: 'listTodo', label: 'To-do', cls: 'task-btn', title: 'To-do list — or type [ ] at the start of a line. Ctrl+Enter checks it off.', run: (e) => e.chain().focus().toggleTaskList().run(), on: (e) => e.isActive('taskList') },
  { id: 'date', icon: 'calendar', label: 'Date', cls: 'date-btn', title: 'Insert a date — or type @date then “today”, “tomorrow”, “last thu”… (Ctrl+; inserts today)', run: (e) => startDateQuery(e) },
];

function tableAction(e, btn) {
  if (!e.isActive('table')) {
    e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    return;
  }
  const r = btn.getBoundingClientRect();
  const cmd = (fn) => () => { fn(e.chain().focus()).run(); e.view.focus(); };
  showMenu({ x: r.left, y: r.bottom + 4 }, [
    { label: 'Add row above', icon: I.plus, run: cmd((c) => c.addRowBefore()) },
    { label: 'Add row below', icon: I.plus, run: cmd((c) => c.addRowAfter()) },
    { label: 'Add column left', icon: I.plus, run: cmd((c) => c.addColumnBefore()) },
    { label: 'Add column right', icon: I.plus, run: cmd((c) => c.addColumnAfter()) },
    'sep',
    { label: 'Toggle header row', icon: I.table, run: cmd((c) => c.toggleHeaderRow()) },
    'sep',
    { label: 'Delete row', icon: I.minus, danger: true, run: cmd((c) => c.deleteRow()) },
    { label: 'Delete column', icon: I.minus, danger: true, run: cmd((c) => c.deleteColumn()) },
    { label: 'Delete table', icon: I.trash, danger: true, run: cmd((c) => c.deleteTable()) },
  ]);
}

function pickImages() {
  if (!editor) return;
  const ed = editor;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp';
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = [...input.files];
    if (files.length && editor === ed) insertImageFiles(ed, files, null, (msg) => toast(msg, { type: 'error', timeout: 9000 }));
  });
  input.click();
}

/** Turn written dates ("Mar 6, 2026", "06/10/2025") already in a note into date tags. */
function tagDatesInNote(id) {
  const n = S.notes.get(id);
  if (!n) return;
  flushNotes();
  const { doc, count } = tagDatesInDoc(noteInfo(n).doc);
  if (!count) { toast('No full dates (with a year) found in this note.'); return; }
  const before = n.content;
  setNoteContent(id, JSON.stringify(doc));
  const after = n.content;
  toast(`Tagged ${plural(count, 'date')}`, {
    action: 'Undo',
    onAction: () => {
      const cur = S.notes.get(id);
      if (cur && cur.content === after) setNoteContent(id, before);
    },
  });
}

function startDateQuery(e) {
  const { from } = e.state.selection;
  const prev = from > 1 ? e.state.doc.textBetween(from - 1, from, '\n', '\n') : '';
  e.chain().focus().insertContent(`${prev && !/\s/.test(prev) ? ' ' : ''}@date `).run();
}

function toolbarHtml() {
  return TOOLBAR.map((b) => (b === 'sep'
    ? '<span class="tb-sep"></span>'
    : `<button class="tb ${b.cls || ''}" type="button" data-cmd="${b.id}" title="${esc(b.title)}" aria-label="${esc(b.title)}">${b.icon ? I[b.icon] : b.html}${b.label ? `<span>${b.label}</span>` : ''}</button>`)).join('');
}

function syncToolbar() {
  cancelAnimationFrame(toolbarFrame);
  toolbarFrame = requestAnimationFrame(() => {
    if (!editor) return;
    for (const btn of $$('#toolbar [data-cmd]')) {
      const def = TOOLBAR.find((b) => b.id === btn.dataset.cmd);
      if (def?.on) btn.classList.toggle('on', !!def.on(editor));
    }
  });
}

async function linkDialog() {
  if (!editor) return;
  const ed = editor;
  const prev = ed.getAttributes('link').href || '';
  // Closing a <dialog> refocuses the editor with the caret at the top, so remember where it was.
  const { from, to } = ed.state.selection;
  const v = await openDialog({
    title: prev ? 'Edit link' : 'Add link',
    icon: I.link,
    iconClass: 'blue',
    body: `<input class="dlg-input" id="link-url" placeholder="https://example.com" autocomplete="off" spellcheck="false" value="${esc(prev)}">`,
    buttons: [
      ...(prev ? [{ label: 'Remove link', value: 'remove' }] : []),
      { label: 'Cancel', value: 'cancel' },
      { label: 'Apply', value: 'ok', cls: 'btn-blue' },
    ],
    onMount: (d) => {
      const input = $('#link-url', d);
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); d.close('ok'); } });
    },
  });
  if (editor !== ed || ed.isDestroyed) return;
  const size = ed.state.doc.content.size;
  const at = () => ed.chain().focus().setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
  if (v === 'remove') { at().extendMarkRange('link').unsetLink().run(); return; }
  if (v !== 'ok') { at().run(); return; }
  let url = ($('#link-url')?.value || '').trim();
  if (!url) { at().extendMarkRange('link').unsetLink().run(); return; }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[/#]/.test(url)) url = `https://${url}`;
  if (!/^(https?:|mailto:|tel:|[/#])/i.test(url)) { toast('That link type isn’t allowed', { type: 'error' }); at().run(); return; }
  if (from === to && !prev) {
    at().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).unsetMark('link').insertContent(' ').run();
  } else {
    at().extendMarkRange('link').setLink({ href: url }).run();
  }
}

function updateNoteFoot() {
  const foot = $('#note-foot');
  if (!foot || S.view.type !== 'note') return;
  const n = S.notes.get(S.view.id);
  if (!n) return;
  const info = noteInfo(n);
  const ts = info.tasks.filter((t) => t.text);
  const open = ts.filter((t) => !t.done).length;
  const words = (info.text.match(/\S+/g) || []).length;
  foot.innerHTML = `<span>${plural(words, 'word')}</span>${ts.length ? `<span class="foot-tasks">${open} open · ${ts.length - open} done</span>` : ''}<span class="spacer"></span><span class="foot-tips"><kbd>[ ]</kbd> to-do · <kbd>@date</kbd> date · <kbd>@</kbd> more</span><span title="Created ${esc(fullStamp(n.createdAt))}
Last edited ${esc(fullStamp(n.updatedAt))}">Created ${esc(addedLabel(n.createdAt))} · Edited ${timeAgo(n.updatedAt)}</span>`;
}
const updateFootSoon = debounce(updateNoteFoot, 300);

function renderCrumbs() {
  const box = $('#crumbs');
  if (!box || S.view.type !== 'note') return;
  const n = S.notes.get(S.view.id);
  if (isScratch(S.view.id)) {
    box.innerHTML = '<span class="scratch-hint">Quick capture — jot notes and to-dos here, then move them into a note when you’re ready.</span>';
    return;
  }
  const chain = folderChain(n?.folderId);
  box.innerHTML = chain.length
    ? chain.map((f) => `<button data-crumb="${f.id}">${esc(f.name)}</button>`).join('<span class="sep">/</span>')
    : '<span>Top level</span>';
}

function openNote(id, opts = {}) {
  teardownNote();
  const n = S.notes.get(id);
  const scratch = isScratch(id);
  setView({ type: 'note', id });
  if (!scratch) S.selectedFolderId = n.folderId || null;
  for (const f of folderChain(n.folderId)) S.expanded.add(f.id);
  saveExpanded();
  main.innerHTML = `
    <div class="note-view${scratch ? ' scratch-view' : ''}" id="note-view">
      ${mobileBar(noteTitle(n))}
      <div class="note-head">
        <div class="crumbs" id="crumbs"></div>
        <div class="title-row">
          ${scratch
            ? `<h1 class="note-title static"><span class="scratch-badge">${I.sticky}</span>Scratchpad</h1>
               <button class="btn-move-out" id="move-out" type="button" title="Move the selected lines (or the current line) into another note${esc(shortcuts.hint('moveOut'))}">${I.moveOut}<span>Move to note…</span></button>`
            : '<input id="note-title" class="note-title" placeholder="Untitled" maxlength="500" autocomplete="off" aria-label="Note title">'}
          <button class="icon-btn" id="note-menu" title="More actions">${I.more}</button>
        </div>
      </div>
      <div class="toolbar" id="toolbar">${toolbarHtml()}<span class="tb-hint">Saves automatically</span></div>
      <div class="editor-scroll" id="editor-scroll"><div class="editor-host" id="editor-host"></div></div>
      <div class="note-foot" id="note-foot"></div>
    </div>`;

  const title = $('#note-title'); // null for the Scratchpad (fixed title)
  if (title) title.value = n.title;
  editor = createNoteEditor({
    element: $('#editor-host'),
    content: noteInfo(n).doc,
    placeholder: scratch
      ? `Jot anything — meeting notes, ideas, [ ] to-dos. Select lines and ${shortcuts.get('moveOut') ? `press ${shortcuts.get('moveOut')}` : 'click Move to note'} to move them into a note.`
      : 'Start writing…  Type [ ] for a to-do, @date for a date, @ for more',
    onUpdate: (e) => {
      const cur = S.notes.get(id);
      if (!cur || S.view.type !== 'note' || S.view.id !== id) return;
      cur.content = JSON.stringify(e.getJSON());
      cur.updatedAt = Date.now();
      markNoteDirty(id);
      updateFootSoon();
      refreshSoon();
    },
    onLinkShortcut: linkDialog,
    onImageRequest: pickImages,
    onImageError: (msg) => toast(msg, { type: 'error', timeout: 9000 }),
    onSelectionChange: syncToolbar,
    onTaskOpen: (index, what) => revealTask(`[data-kind="n"][data-note="${id}"][data-index="${index}"]`, what === 'stage' ? { stage: true } : { due: true }),
  });
  editor.on('blur', flushNotes);
  renderCrumbs();
  updateNoteFoot();
  syncToolbar();
  renderTree();
  $(`.tree-row.note[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });

  // ---- events
  title?.addEventListener('input', () => {
    const cur = S.notes.get(id);
    if (!cur) return;
    cur.title = title.value;
    cur.updatedAt = Date.now();
    markNoteDirty(id);
    document.title = `${noteTitle(cur)} · Taskule`;
    refreshSoon();
  });
  title?.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === 'ArrowDown') && !e.isComposing) {
      e.preventDefault();
      if (!editor) return;
      editor.commands.focus('start');
      editor.view.focus(); // synchronous, so keystrokes typed right after Enter land in the body
    }
  });
  title?.addEventListener('blur', flushNotes);
  if (scratch) {
    $('#move-out').addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection
    $('#move-out').addEventListener('click', () => moveOutDialog());
  }

  const tb = $('#toolbar');
  tb.addEventListener('mousedown', (e) => { if (e.target.closest('[data-cmd]')) e.preventDefault(); });
  tb.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    const def = b && TOOLBAR.find((x) => x.id === b.dataset.cmd);
    if (def && editor) def.run(editor, b);
  });
  // Clicking the empty space below the text puts the cursor at the end.
  $('#editor-scroll').addEventListener('mousedown', (e) => {
    if (editor && (e.target.id === 'editor-scroll' || e.target.id === 'editor-host')) {
      e.preventDefault();
      editor.commands.focus('end');
      editor.view.focus();
    }
  });
  $('#crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-crumb]');
    if (b) revealFolder(b.dataset.crumb);
  });
  $('#note-menu').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (scratch) {
      showMenu({ x: r.right - 220, y: r.bottom + 4 }, [
        { label: 'Move selection to note…', icon: I.moveOut, run: () => moveOutDialog() },
        { label: 'Tag dates in Scratchpad', icon: I.calendar, run: () => tagDatesInNote(id) },
        'sep',
        { label: 'Clear Scratchpad…', icon: I.eraser, danger: true, run: () => clearScratchpad() },
      ]);
      return;
    }
    showMenu({ x: r.right - 200, y: r.bottom + 4 }, [
      { label: 'Move to…', icon: I.move, run: () => moveDialog('note', id) },
      { label: 'New note in same folder', icon: I.notePlus, run: () => createNote(S.notes.get(id)?.folderId) },
      { label: 'Tag dates in this note', icon: I.calendar, run: () => tagDatesInNote(id) },
      'sep',
      { label: 'Delete note', icon: I.trash, danger: true, run: () => deleteNote(id) },
    ]);
  });

  // ---- initial focus
  if (scratch && opts.find == null && opts.task == null) {
    if (opts.newLine) {
      newLineAtTop(editor); // quick capture: new line at the top, ready to type
    } else {
      editor.commands.focus('end');
      editor.view.focus();
      $('#editor-scroll').scrollTop = $('#editor-scroll').scrollHeight;
    }
  } else if (opts.focusTitle && title) {
    title.focus();
    title.select();
  } else if (opts.find?.length) {
    const ed = editor;
    setTimeout(() => { if (editor === ed) selectFirstMatch(ed, opts.find); }); // after the triggering click finishes
  } else if (opts.task != null) {
    const ed = editor;
    setTimeout(() => { if (editor === ed) selectTask(ed, opts.task); });
  } else if (!n.title && noteInfo(n).text === '') {
    title?.focus();
  }
}

/* =====================================================================
   Menu, dialogs, toasts
   ===================================================================== */
let menuCleanup = null;
function closeMenu() {
  const m = $('#menu');
  if (m.hidden) return;
  m.hidden = true;
  m.innerHTML = '';
  menuCleanup?.();
  menuCleanup = null;
  sidebar.maybeHide(); // a menu opened from the peeking sidebar kept it open
}
function showMenu(at, items, onClose) {
  closeMenu();
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => (it === 'sep'
    ? '<div class="menu-sep"></div>'
    : `<button class="menu-item${it.danger ? ' danger' : ''}" role="menuitem" data-i="${i}">${it.icon || ''}<span>${esc(it.label)}</span></button>`)).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(at.x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, at.y + r.height > innerHeight - 8 ? at.y - r.height - 8 : at.y)}px`;
  const buttons = $$('.menu-item', m);
  buttons[0]?.focus();
  const onClick = (e) => {
    const b = e.target.closest('.menu-item');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it.run();
  };
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    else if (e.key === 'Tab') { closeMenu(); }
  };
  const onDown = (e) => { if (!m.contains(e.target)) closeMenu(); };
  m.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  menuCleanup = () => {
    m.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
    onClose?.();
  };
}

function openDialog({ title, icon, iconClass, body, buttons, onMount }) {
  const dlg = $('#dialog');
  if (dlg.open) dlg.close('');
  dlg.innerHTML = `<form method="dialog" class="dlg">
    <h2>${icon ? `<span class="dlg-icon ${iconClass || ''}">${icon}</span>` : ''}<span>${esc(title)}</span></h2>
    <div class="dlg-body">${body || ''}</div>
    ${buttons?.length ? `<div class="dlg-actions">${buttons.map((b) => `<button class="btn ${b.cls || ''}" value="${b.value}" ${b.disabled ? 'disabled' : ''} ${b.id ? `id="${b.id}"` : ''}>${b.label}</button>`).join('')}</div>` : ''}
  </form>`;
  dlg.returnValue = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { resolve(dlg.returnValue); sidebar.maybeHide(); }, { once: true });
    dlg.showModal();
    onMount?.(dlg);
  });
}

async function confirmDialog({ title, body, confirm = 'Delete' }) {
  const v = await openDialog({
    title, body, icon: I.trash, iconClass: 'red',
    buttons: [{ label: 'Cancel', value: 'cancel', id: 'dlg-cancel' }, { label: confirm, value: 'ok', cls: 'btn-red' }],
    onMount: (d) => $('#dlg-cancel', d).focus(),
  });
  return v === 'ok';
}

function moveDialog(kind, id) {
  const item = kind === 'folder' ? S.folders.get(id) : S.notes.get(id);
  if (!item) return;
  const current = kind === 'folder' ? item.parentId || null : item.folderId || null;
  const kids = new Map();
  for (const f of S.folders.values()) {
    const k = f.parentId || null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(f);
  }
  let rows = `<button type="button" data-target="" ${current === null ? 'disabled' : ''}>${I.inbox}<span>Top level</span>${current === null ? '<span class="here">current</span>' : ''}</button>`;
  const walk = (pid, depth) => {
    for (const f of (kids.get(pid) || []).sort((a, b) => collator.compare(a.name, b.name))) {
      const invalid = kind === 'folder' && (f.id === id || isFolderWithin(f.id, id));
      const isHere = f.id === current;
      rows += `<button type="button" data-target="${f.id}" style="--depth:${depth}" ${invalid || isHere ? 'disabled' : ''}>${I.folder}<span>${esc(f.name)}</span>${isHere ? '<span class="here">current</span>' : ''}</button>`;
      if (!(kind === 'folder' && f.id === id)) walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  const name = kind === 'folder' ? item.name : noteTitle(item);
  openDialog({
    title: `Move “${name}”`,
    icon: I.move,
    iconClass: 'blue',
    body: `<p>Choose a destination:</p><div class="folder-pick">${rows}</div>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }],
    onMount: (d) => {
      $('.folder-pick', d).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-target]');
        if (!b || b.disabled) return;
        d.close('moved');
        const target = b.dataset.target || null;
        if (kind === 'folder') moveFolder(id, target); else moveNote(id, target);
      });
      $('.folder-pick button:not(:disabled)', d)?.focus();
    },
  });
}

async function wipeDialog() {
  const taskCount = S.tasks.size + [...S.notes.values()].reduce((a, n) => a + noteTasks(n).length, 0);
  const v = await openDialog({
    title: 'Wipe the entire database?',
    icon: I.alert,
    iconClass: 'red',
    body: `<p>This deletes <strong>everything</strong> from Taskule. A safety copy of the database is saved to <code>data/backups</code> first, so it can be restored by hand if you change your mind.</p>
      <div class="wipe-stats"><span>${plural(S.notes.size, 'note')}</span><span>${plural(S.folders.size, 'folder')}</span><span>${plural(taskCount, 'task')}</span></div>
      <p>Type <strong>delete</strong> to confirm.</p>
      <input class="dlg-input danger" id="wipe-input" autocomplete="off" spellcheck="false" placeholder="delete" aria-label="Type delete to confirm">`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Wipe everything', value: 'wipe', cls: 'btn-red', disabled: true, id: 'wipe-confirm' }],
    onMount: (d) => {
      const input = $('#wipe-input', d);
      const btn = $('#wipe-confirm', d);
      const valid = () => input.value.trim().toLowerCase() === 'delete';
      input.addEventListener('input', () => { btn.disabled = !valid(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); if (valid()) d.close('wipe'); }
      });
      input.focus();
    },
  });
  if (v !== 'wipe') return;
  flushNotes();
  await Promise.race([sync.idle(), sleep(8000)]);
  let wiped = {};
  try {
    const res = await fetch('/api/wipe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'delete' }) });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
    wiped = await res.json().catch(() => ({}));
  } catch (err) {
    toast(`Wipe failed: ${err.message}`, { type: 'error', sticky: true });
    return;
  }
  journal.clearAll();
  const now = Date.now();
  applyState({ folders: [], notes: [{ id: SCRATCH, folderId: null, title: 'Scratchpad', content: '', createdAt: now, updatedAt: now }], tasks: [] });
  S.expanded.clear();
  saveExpanded();
  S.selectedFolderId = null;
  docCache.clear();
  $('#search').value = '';
  navigate(HOME);
  refreshAll();
  toast(wiped.backup ? `Database wiped. A safety copy was saved first: data/backups/${wiped.backup}` : 'Database wiped. Fresh start!', { type: 'success', timeout: 9000 });
}

/** A toast that stays up while work is in progress. */
function progressToast(msg) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="spin"></span><span class="msg"></span>`;
  $('.msg', el).textContent = msg;
  box.appendChild(el);
  const close = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); };
  return {
    update: (m) => { $('.msg', el).textContent = m; },
    done: (m) => { close(); toast(m, { type: 'success' }); },
    fail: (m) => { close(); toast(m, { type: 'error', timeout: 8000 }); },
  };
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const EXPORTS = [
  { id: 'word', icon: 'note', cls: 'xo-blue', title: 'Word document (.docx)', sub: 'Everything in one formatted document — opens in Word, Google Docs, Pages' },
  { id: 'markdown', icon: 'code', cls: 'xo-purple', title: 'Markdown (.zip)', sub: 'One .md file per note in your folder structure, plus images' },
  { id: 'pdf', icon: 'printer', cls: 'xo-red', title: 'PDF (.pdf)', sub: 'A print-ready copy of everything' },
  { id: 'backup', icon: 'database', cls: 'xo-green', title: 'Database backup (.zip)', sub: 'Exact copy of your database and images, for restoring Taskule' },
];

async function downloadDialog() {
  const v = await openDialog({
    title: 'Download a copy of everything',
    icon: I.download,
    iconClass: 'blue',
    body: `<p>Includes all ${plural(S.notes.size, 'note')}, folders and to-dos.</p>
      <div class="export-options">${EXPORTS.map((x) => `<button type="button" class="export-opt" data-export="${x.id}">
        <span class="xo-icon ${x.cls}">${I[x.icon]}</span>
        <span class="xo-text"><span class="xo-title">${x.title}</span><span class="xo-sub">${x.sub}</span></span>
      </button>`).join('')}</div>
      <p class="backup-note" id="backup-note"></p>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }],
    onMount: (d) => {
      nativeFetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((h) => {
        const el = $('#backup-note', d);
        if (!el) return;
        el.textContent = h.backupProblem
          ? `⚠ ${h.backupProblem}`
          : h.lastBackupAt ? `Automatic backups are on — the last one was ${timeAgo(h.lastBackupAt)} (kept in data/backups).` : 'Automatic backups are on.';
        el.classList.toggle('bad', !!h.backupProblem);
      }).catch(() => {});
      $('.export-options', d).addEventListener('click', (e) => {
        const b = e.target.closest('[data-export]');
        if (b) d.close(b.dataset.export);
      });
      $('.export-opt', d).focus();
    },
  });
  if (EXPORTS.some((x) => x.id === v)) runExport(v);
}

let exporting = false;
async function runExport(kind) {
  if (exporting) { toast('An export is already running…'); return; }
  exporting = true;
  const label = EXPORTS.find((x) => x.id === kind).title;
  const t = progressToast(`Preparing ${label}…`);
  try {
    flushNotes();
    await Promise.race([sync.idle(), sleep(8000)]); // make sure the latest edits are included
    if (kind === 'backup') {
      const res = await fetch('/api/backup', { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'taskule-backup.zip';
      saveBlob(await res.blob(), name);
      t.done(`Downloaded ${name}`);
      return;
    }
    const mod = await import('./vendor/export.js');
    const fn = { word: mod.exportWord, markdown: mod.exportMarkdown, pdf: mod.exportPdf }[kind];
    const data = { folders: [...S.folders.values()], notes: [...S.notes.values()], tasks: [...S.tasks.values()], legacyToDoc };
    const { blob, filename } = await fn(data, (m) => t.update(m));
    saveBlob(blob, filename);
    t.done(`Downloaded ${filename}`);
  } catch (err) {
    console.error(err);
    t.fail(`Download failed: ${err.message}`);
  } finally {
    exporting = false;
  }
}

/** A short message at the bottom. `sticky`: stays until closed (for problems you must not miss). */
function toast(msg, { type = 'info', action, onAction, timeout, sticky = false } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}${sticky ? ' sticky' : ''}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="t-action">${esc(action)}</button>` : ''}${sticky ? `<button type="button" class="t-close" title="Dismiss" aria-label="Dismiss">${I.x}</button>` : ''}`;
  box.appendChild(el);
  // Make room by dropping the oldest ordinary messages, never a sticky one.
  const plain = [...box.children].filter((c) => !c.classList.contains('sticky'));
  while (plain.length && box.children.length > 4) plain.shift().remove();
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  };
  if (action) $('.t-action', el).addEventListener('click', () => { dismiss(); onAction?.(); });
  if (sticky) $('.t-close', el).addEventListener('click', dismiss);
  else setTimeout(dismiss, timeout ?? (action ? 6000 : type === 'error' ? 8000 : 2600));
  return dismiss;
}

/* =====================================================================
   Settings: colour theme and keyboard shortcuts. Kept in this browser /
   app profile (they're personal preferences, not part of your notes).
   ===================================================================== */
const theme = {
  pref() { const p = store.get(KEYS.theme, 'system'); return ['light', 'dark', 'system'].includes(p) ? p : 'system'; },
  apply() {
    const p = this.pref();
    const dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  },
  set(p) { store.set(KEYS.theme, p); this.apply(); },
  setup() {
    this.apply();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.apply());
  },
};

/** App shortcuts you can change in Settings. Editor formatting keys (Ctrl+B …) stay fixed. */
const SHORTCUTS = [
  { id: 'newNote', label: 'New note', def: 'Alt+N' },
  { id: 'scratch', label: 'Open the Scratchpad', hint: 'new line at the top, ready to type', def: 'Alt+S' },
  { id: 'tasks', label: 'Add a task', hint: 'opens the Tasks panel', def: 'Alt+T' },
  { id: 'toggleTasks', label: 'Show / hide the Tasks panel', def: 'Ctrl+]' },
  { id: 'sidebar', label: 'Show / hide the sidebar', def: 'Ctrl+\\' },
  { id: 'search', label: 'Search', hint: '/ also works when you’re not typing', def: 'Ctrl+Shift+F' },
  { id: 'moveOut', label: 'Move lines to a note', hint: 'in the Scratchpad', def: 'Ctrl+Shift+M' },
  { id: 'settings', label: 'Settings', def: 'Ctrl+,' },
  { id: 'lock', label: 'Lock Taskule', def: '' },
];
// Keys the editor, the browser or the desktop app already use — not available for app shortcuts.
const RESERVED = new Set([
  'Ctrl+A', 'Ctrl+B', 'Ctrl+C', 'Ctrl+E', 'Ctrl+I', 'Ctrl+K', 'Ctrl+R', 'Ctrl+S', 'Ctrl+U', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Y', 'Ctrl+Z',
  'Ctrl+Shift+Z', 'Ctrl+Shift+V', 'Ctrl+Shift+S', 'Ctrl+Shift+H', 'Ctrl+Shift+B', 'Ctrl+Shift+I', 'Ctrl+Shift+7', 'Ctrl+Shift+8', 'Ctrl+Shift+9',
  'Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3', 'Ctrl+Enter', 'Ctrl+;', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0', 'Ctrl+Shift+=',
  'F5', 'F11', 'F12', 'Alt+F4', 'Ctrl+W', 'Ctrl+P', 'Ctrl+F',
]);
const KEY_NAMES = {
  Backslash: '\\', Slash: '/', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  Backquote: '`', Space: 'Space', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};
/** The key combination of a key press, e.g. "Ctrl+Shift+M" (by physical key, so it works on any keyboard layout). */
function comboOf(e) {
  const c = e.code || '';
  if (/^(Shift|Control|Alt|Meta|OS)/.test(c) || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  let key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^Numpad\d$/.test(c) ? c.slice(6) : /^F\d{1,2}$/.test(c) ? c : KEY_NAMES[c];
  if (!key) key = e.key && e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!key) return null;
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}
const shortcuts = {
  map: {},
  load() {
    const saved = store.get(KEYS.shortcuts, {});
    this.map = {};
    for (const s of SHORTCUTS) this.map[s.id] = typeof saved?.[s.id] === 'string' ? saved[s.id] : s.def;
  },
  get(id) { return this.map[id] ?? ''; },
  /** " (Alt+N)" for tooltips, or "" when the action has no shortcut. */
  hint(id) { return this.get(id) ? ` (${this.get(id)})` : ''; },
  match(e) {
    const combo = comboOf(e);
    if (!combo) return null;
    return SHORTCUTS.find((s) => this.map[s.id] && this.map[s.id] === combo)?.id || null;
  },
  set(id, combo) {
    this.map[id] = combo;
    const custom = {};
    for (const s of SHORTCUTS) if (this.map[s.id] !== s.def) custom[s.id] = this.map[s.id];
    store.set(KEYS.shortcuts, custom);
    refreshShortcutHints();
  },
  /** Why a combination can't be used, or null if it can. */
  problem(combo) {
    if (RESERVED.has(combo)) return `${combo} is already used by the editor or the app window.`;
    const mods = combo.split('+').slice(0, -1);
    const key = combo.split('+').pop();
    if (!mods.includes('Ctrl') && !mods.includes('Alt') && !/^F\d{1,2}$/.test(key)) return 'Use Ctrl or Alt (or a function key), so it doesn’t clash with typing.';
    if (['Tab', 'Enter', 'Esc', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right'].includes(key)) return `${key} is needed for editing.`;
    return null;
  },
};

function runShortcut(id) {
  switch (id) {
    case 'newNote': createNote(); break;
    case 'scratch': openScratchpad({ newLine: true }); break;
    case 'tasks': tasksPanel.open({ focusAdd: true }); break;
    case 'toggleTasks': tasksPanel.toggle(); break;
    case 'sidebar': sidebar.toggle(); break;
    case 'search': openSidebar(); $('#search').focus(); $('#search').select(); break;
    case 'moveOut': moveOutDialog(); break;
    case 'settings': settingsDialog(); break;
    case 'lock': lock.now(); break;
    default: break;
  }
}

/** Tooltips and hints that mention a shortcut follow your settings. */
function refreshShortcutHints() {
  const set = (sel, text) => { const el = $(sel); if (el) el.title = text; };
  set('#sb-handle', `Show the sidebar — click to keep it open${shortcuts.hint('sidebar')}`);
  set('#tp-handle', `Tasks — click to keep the panel open${shortcuts.hint('toggleTasks')}`);
  set('#settings-btn', `Settings${shortcuts.hint('settings')}`);
  set('#lock-now', `Lock Taskule (asks for the password again)${shortcuts.hint('lock')}`);
  set('#move-out', `Move the selected lines (or the current line) into another note${shortcuts.hint('moveOut')}`);
  if (typeof sidebar !== 'undefined' && $('#sidebar-pin')) sidebar.apply();
  if (typeof tasksPanel !== 'undefined' && $('#tp-pin')) tasksPanel.apply();
  if (S.notes) renderTree();
}

/** Settings → Password: set one (Taskule then asks for it when it opens), change it, or remove it. */
function passwordSettings(d) {
  let mode = null; // 'set' | 'change' | 'remove'
  const el = (id) => $(`#${id}`, d);
  const msg = (text, ok = true) => { el('pw-msg').textContent = text; el('pw-msg').classList.toggle('ok', ok); };
  const draw = () => {
    el('pw-state').textContent = security.hasPassword
      ? 'Taskule asks for a password when it opens.'
      : 'No password: Taskule opens without asking for one.';
    el('pw-actions').innerHTML = mode ? '' : security.hasPassword
      ? '<button type="button" class="btn" data-pw="change">Change password…</button><button type="button" class="btn btn-red-outline" data-pw="remove">Remove password…</button>'
      : '<button type="button" class="btn btn-blue" data-pw="set">Set a password…</button>';
    el('pw-form').hidden = !mode;
    el('pw-current').hidden = !(mode === 'change' || mode === 'remove');
    el('pw-new').hidden = el('pw-confirm').hidden = mode === 'remove';
    el('pw-save').textContent = mode === 'remove' ? 'Remove password' : 'Save password';
    el('pw-save').classList.toggle('btn-red', mode === 'remove');
    el('pw-save').classList.toggle('btn-blue', mode !== 'remove');
  };
  const start = (m) => {
    mode = m;
    for (const id of ['pw-current', 'pw-new', 'pw-confirm']) el(id).value = '';
    msg(m === 'remove' ? 'Enter your current password to remove it.' : '');
    draw();
    (m === 'set' ? el('pw-new') : el('pw-current')).focus();
  };
  const save = async () => {
    const body = {};
    if (mode !== 'set') body.current = el('pw-current').value;
    if (mode === 'remove') body.password = null;
    else {
      if (el('pw-new').value.length < 3) { msg('Use at least 3 characters.', false); el('pw-new').focus(); return; }
      if (el('pw-new').value !== el('pw-confirm').value) { msg('The two new passwords don’t match.', false); el('pw-confirm').focus(); return; }
      body.password = el('pw-new').value;
    }
    el('pw-save').disabled = true;
    try {
      const res = await nativeFetch('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { msg(out.error || `Couldn’t save (error ${res.status}).`, false); el('pw-current').select(); return; }
      security.hasPassword = out.open === false;
      const done = mode;
      mode = null;
      draw();
      msg(done === 'remove' ? 'Password removed. Taskule now opens without one.'
        : done === 'set' ? 'Password set. Taskule will ask for it the next time it opens (this window stays unlocked).'
          : 'Password changed. Other open windows will ask for the new one.');
    } catch {
      msg('Can’t reach the Taskule server.', false);
    } finally {
      el('pw-save').disabled = false;
    }
  };
  d.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pw]');
    if (b) start(b.dataset.pw);
    else if (e.target.id === 'pw-save') save();
    else if (e.target.id === 'pw-cancel') { mode = null; msg(''); draw(); }
  });
  // Enter saves (instead of closing the dialog)
  el('pw-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  });
  draw();
  nativeFetch('/api/session', { cache: 'no-store' }).then((r) => r.json()).then((st) => {
    if (typeof st.open === 'boolean' && !mode) { security.hasPassword = !st.open; draw(); }
  }).catch(() => {});
}

function settingsDialog() {
  if ($('#dialog').open) return;
  const themes = [['light', 'Light', 'sw-light'], ['dark', 'Dark', 'sw-dark'], ['system', 'Match system', 'sw-system']];
  const rows = () => SHORTCUTS.map((s) => {
    const k = shortcuts.get(s.id);
    return `<div class="key-row${k !== s.def ? ' changed' : ''}" data-id="${s.id}">
      <span class="k-label">${esc(s.label)}${s.hint ? `<small>${esc(s.hint)}</small>` : ''}</span>
      <button type="button" class="key-btn${k ? '' : ' none'}" data-act="record" title="Click, then press the new keys">${k ? esc(k) : 'Not set'}</button>
      <button type="button" class="key-reset" data-act="reset" title="Back to ${esc(s.def || 'not set')}">Reset</button>
    </div>`;
  }).join('');
  let recording = null; // shortcut id being recorded
  openDialog({
    title: 'Settings',
    icon: I.settings,
    iconClass: 'blue',
    body: `<div class="set-section"><h3>Appearance</h3>
        <div class="theme-pick">${themes.map(([id, label, sw]) => `<button type="button" class="theme-opt${theme.pref() === id ? ' on' : ''}" data-theme="${id}" aria-pressed="${theme.pref() === id}">
          <span class="theme-swatch ${sw}"><i class="s1"></i><i class="s2"><b></b><b style="width:70%"></b><b style="width:45%"></b></i></span>${label}</button>`).join('')}</div>
      </div>
      <div class="set-section"><h3>Password</h3>
        <p class="pw-state" id="pw-state"></p>
        <div class="pw-actions" id="pw-actions"></div>
        <div class="pw-form" id="pw-form" hidden>
          <input type="password" id="pw-current" placeholder="Current password" autocomplete="current-password" aria-label="Current password">
          <input type="password" id="pw-new" placeholder="New password (at least 3 characters)" autocomplete="new-password" aria-label="New password">
          <input type="password" id="pw-confirm" placeholder="Type the new password again" autocomplete="new-password" aria-label="Confirm new password">
          <div class="pw-buttons"><button type="button" class="btn btn-blue" id="pw-save">Save</button><button type="button" class="btn" id="pw-cancel">Cancel</button></div>
        </div>
        <p class="key-msg ok" id="pw-msg"></p>
      </div>
      <div class="set-section"><h3>Keyboard shortcuts</h3>
        <div class="keys" id="keys">${rows()}</div>
        <p class="key-msg ok" id="key-msg">Click a shortcut, then press the new keys. Backspace removes it, Esc cancels.</p>
        <p class="fixed-keys">Always available: <kbd>/</kbd> search · <kbd>Ctrl+S</kbd> save now · <kbd>Ctrl+Shift+V</kbd> paste plain text · editor formatting like <kbd>Ctrl+B</kbd>, <kbd>Ctrl+K</kbd>, <kbd>Ctrl+;</kbd> (today's date) and <kbd>Ctrl+Enter</kbd> (check a to-do). In the desktop app: <kbd>Ctrl +</kbd>/<kbd>Ctrl -</kbd> zoom, <kbd>F11</kbd> full screen.</p>
        <button type="button" class="btn" id="keys-reset-all">Reset all shortcuts</button>
      </div>`,
    buttons: [{ label: 'Done', value: 'done', cls: 'btn-blue' }],
    onMount: (d) => {
      $('.dlg', d).classList.add('settings');
      passwordSettings(d);
      const msg = (text, ok = false) => { const m = $('#key-msg', d); m.textContent = text; m.classList.toggle('ok', ok); };
      const redraw = () => { $('#keys', d).innerHTML = rows(); };
      const stop = () => { recording = null; redraw(); };
      d.addEventListener('click', (e) => {
        const t = e.target.closest('.theme-opt'); // (not just [data-theme]: <html> carries that attribute too)
        if (t) {
          theme.set(t.dataset.theme);
          $$('.theme-opt', d).forEach((b) => { b.classList.toggle('on', b === t); b.setAttribute('aria-pressed', String(b === t)); });
          return;
        }
        const row = e.target.closest('.key-row');
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (row && act === 'record') {
          redraw();
          recording = row.dataset.id;
          const btn = $(`.key-row[data-id="${recording}"] .key-btn`, d);
          btn.classList.add('recording');
          btn.classList.remove('none');
          btn.textContent = 'Press keys…';
          btn.focus();
          msg('Press the new keys (Backspace removes it, Esc cancels).', true);
        } else if (row && act === 'reset') {
          const s = SHORTCUTS.find((x) => x.id === row.dataset.id);
          const other = s.def && SHORTCUTS.find((x) => x.id !== s.id && shortcuts.get(x.id) === s.def);
          if (other) shortcuts.set(other.id, '');
          shortcuts.set(s.id, s.def);
          stop();
          msg(other ? `${s.def} is back on “${s.label}”; “${other.label}” no longer has a shortcut.` : `“${s.label}” is back to ${s.def || 'no shortcut'}.`, !other);
        } else if (e.target.id === 'keys-reset-all') {
          for (const s of SHORTCUTS) shortcuts.set(s.id, s.def);
          stop();
          msg('All shortcuts are back to their defaults.', true);
        } else if (recording && !e.target.closest('.key-btn')) {
          stop();
          msg('Click a shortcut, then press the new keys. Backspace removes it, Esc cancels.', true);
        }
      });
      d.addEventListener('keydown', (e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stop(); msg('Unchanged.', true); return; }
        const s = SHORTCUTS.find((x) => x.id === recording);
        if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey) {
          shortcuts.set(s.id, '');
          stop();
          msg(`“${s.label}” no longer has a shortcut.`, true);
          return;
        }
        const combo = comboOf(e);
        if (!combo) return; // just a modifier so far
        const problem = shortcuts.problem(combo);
        if (problem) { msg(problem); return; }
        const other = SHORTCUTS.find((x) => x.id !== s.id && shortcuts.get(x.id) === combo);
        if (other) shortcuts.set(other.id, '');
        shortcuts.set(s.id, combo);
        stop();
        msg(other ? `${combo} now does “${s.label}”; “${other.label}” no longer has a shortcut.` : `${combo} now does “${s.label}”.`, !other);
      }, true);
      // Esc while recording cancels the recording, not the dialog.
      d.addEventListener('cancel', (e) => { if (recording) e.preventDefault(); });
    },
  });
}

/* =====================================================================
   Sidebar: on phones it slides over the page. On desktop it's either
   pinned open, or collapsed — then hovering the left edge (or the
   button) shows it, and it stays while you're using it.
   ===================================================================== */
const isDesktop = () => innerWidth > 760;
function openSidebar() {
  if (!isDesktop()) $('#app').classList.add('sidebar-open');
  else if (!sidebar.pinned) sidebar.peek(true);
}
function closeSidebar() { $('#app').classList.remove('sidebar-open'); }

/**
 * Drag the inner edge of the sidebar or the Tasks panel to resize it (arrow keys work when the
 * edge has focus; double-click resets). Widths are remembered. Each panel keeps a sensible
 * minimum, and the page in the middle always keeps at least MAIN_MIN pixels.
 */
const panelSizes = {
  MAIN_MIN: 380,
  panels: {
    sidebar: { cssVar: '--sidebar-w', key: KEYS.sidebarWidth, def: 284, min: 210, max: 520, el: '#sidebar', handle: '#sb-resizer', side: 'left' },
    tasks: { cssVar: '--tasks-w', key: KEYS.tasksWidth, def: 360, min: 280, max: 640, el: '#taskpanel', handle: '#tp-resizer', side: 'right' },
  },
  width(name) { return $(this.panels[name].el).getBoundingClientRect().width || this.panels[name].def; },
  /** Largest width this panel can take right now without squeezing the page below MAIN_MIN. */
  maxFor(name) {
    const p = this.panels[name];
    const other = name === 'sidebar' ? 'tasks' : 'sidebar';
    const otherTakesSpace = other === 'sidebar' ? sidebar.pinned : tasksPanel.pinned;
    const room = innerWidth - this.MAIN_MIN - (otherTakesSpace ? this.width(other) : 0);
    return Math.max(p.min, Math.min(p.max, room));
  },
  set(name, w, { save = true } = {}) {
    const p = this.panels[name];
    const clamped = Math.round(Math.max(p.min, Math.min(this.maxFor(name), w)));
    document.documentElement.style.setProperty(p.cssVar, `${clamped}px`);
    const h = $(p.handle);
    h.setAttribute('aria-valuenow', String(clamped));
    h.setAttribute('aria-valuemin', String(p.min));
    h.setAttribute('aria-valuemax', String(this.maxFor(name)));
    if (save) store.set(p.key, clamped);
    return clamped;
  },
  setup() {
    for (const [name, p] of Object.entries(this.panels)) {
      const saved = Number(store.get(p.key, p.def));
      this.set(name, Number.isFinite(saved) ? saved : p.def, { save: false });
      const h = $(p.handle);
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !isDesktop()) return;
        e.preventDefault();
        try { h.setPointerCapture(e.pointerId); } catch { /* keep going without capture */ }
        h.classList.add('active');
        document.body.classList.add('resizing');
        const move = (ev) => this.set(name, p.side === 'left' ? ev.clientX : innerWidth - ev.clientX, { save: false });
        const up = (ev) => {
          try { h.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          h.removeEventListener('pointercancel', up);
          h.classList.remove('active');
          document.body.classList.remove('resizing');
          this.set(name, this.width(name));
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      h.addEventListener('dblclick', () => this.set(name, p.def));
      h.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 48 : 16;
        const grow = p.side === 'left' ? 'ArrowRight' : 'ArrowLeft';
        const shrink = p.side === 'left' ? 'ArrowLeft' : 'ArrowRight';
        if (e.key === grow) { e.preventDefault(); this.set(name, this.width(name) + step); }
        else if (e.key === shrink) { e.preventDefault(); this.set(name, this.width(name) - step); }
        else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); this.set(name, p.def); }
      });
    }
    // A smaller window: keep both panels within bounds (without forgetting your preferred width).
    addEventListener('resize', () => {
      for (const [name, p] of Object.entries(this.panels)) this.set(name, Number(store.get(p.key, p.def)) || p.def, { save: false });
    });
  },
};

const sidebar = {
  pinned: store.get(KEYS.sidebarPinned, true) !== false,
  hovering: false,
  timer: null,
  apply() {
    const app = $('#app');
    app.classList.toggle('sb-collapsed', !this.pinned);
    if (this.pinned) app.classList.remove('sb-peek');
    const btn = $('#sidebar-pin');
    btn.innerHTML = this.pinned ? I.panelClose : I.pin;
    btn.title = this.pinned ? `Hide the sidebar — hover the left edge to see it again${shortcuts.hint('sidebar')}` : `Keep the sidebar open${shortcuts.hint('sidebar')}`;
    btn.setAttribute('aria-label', this.pinned ? 'Hide the sidebar' : 'Keep the sidebar open');
  },
  toggle() { if (isDesktop()) this.setPinned(!this.pinned); else if ($('#app').classList.contains('sidebar-open')) closeSidebar(); else openSidebar(); },
  setPinned(on) {
    this.pinned = on;
    store.set(KEYS.sidebarPinned, on);
    this.apply();
    // Just collapsed while the mouse is over it: keep showing it until the mouse leaves.
    if (!on && this.hovering) this.peek(true);
  },
  peek(on) {
    clearTimeout(this.timer);
    if (this.pinned || !isDesktop()) return;
    $('#app').classList.toggle('sb-peek', on);
  },
  /** Hide the peeking sidebar unless the mouse is over it or you're using it (typing, menu, dialog). */
  maybeHide(delay = 300) {
    clearTimeout(this.timer);
    if (this.pinned) return;
    this.timer = setTimeout(() => {
      const busy = this.hovering || $('#sidebar').contains(document.activeElement) || !$('#menu').hidden || $('#dialog').open || S.renaming;
      if (!busy) $('#app').classList.remove('sb-peek');
    }, delay);
  },
  setup() {
    $('#sb-handle').innerHTML = I.panelOpen;
    this.apply();
    const enter = () => { this.hovering = true; this.peek(true); };
    const leave = () => { this.hovering = false; this.maybeHide(); };
    for (const el of [$('#sidebar'), $('#sb-edge'), $('#sb-handle')]) {
      el.addEventListener('pointerenter', enter);
      el.addEventListener('pointerleave', leave);
    }
    $('#sidebar-pin').addEventListener('click', () => this.setPinned(!this.pinned));
    $('#sb-handle').addEventListener('click', () => this.setPinned(true));
    $('#sidebar').addEventListener('focusin', () => this.peek(true));
    $('#sidebar').addEventListener('focusout', () => this.maybeHide(150));
    // Clicking in the page puts the peeking sidebar away, even if something in it had focus.
    document.addEventListener('pointerdown', (e) => {
      if (this.pinned || !$('#app').classList.contains('sb-peek')) return;
      if (e.target.closest('#sidebar, #sb-handle, #sb-edge, #menu, #dialog')) return;
      $('#app').classList.remove('sb-peek');
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.pinned && $('#app').classList.contains('sb-peek') && $('#sidebar').contains(document.activeElement) && $('#menu').hidden && !S.renaming) {
        document.activeElement.blur();
        $('#app').classList.remove('sb-peek');
      }
    });
    addEventListener('resize', () => this.apply());
  },
};

/* =====================================================================
   Boot
   ===================================================================== */
function setupChrome() {
  shortcuts.load();
  theme.setup();
  sidebar.setup();
  panelSizes.setup();
  tasksPanel.setup();
  duePicker.setup();
  $('.search-icon').innerHTML = I.search;
  $('#new-folder').innerHTML = I.folderPlus;
  $('#new-note').innerHTML = I.notePlus;
  $('#sidebar-close').innerHTML = I.x;

  $('#settings-btn').innerHTML = I.settings;
  $('#settings-btn').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu({ x: r.left, y: r.top - 4 }, [
      { label: 'Settings…', icon: I.settings, run: () => settingsDialog() },
      { label: 'Download a copy…', icon: I.download, run: () => downloadDialog() },
      ...(security.hasPassword ? [{ label: 'Lock now', icon: I.lock, run: () => lock.now() }] : []),
      'sep',
      { label: 'Wipe database…', icon: I.trash, danger: true, run: () => wipeDialog() },
    ]);
  });
  refreshShortcutHints();
  $('#new-note').addEventListener('click', () => createNote());
  $('#new-folder').addEventListener('click', () => newFolderAction());
  $('#tree-root').addEventListener('click', () => { S.selectedFolderId = null; renderTree(); });
  $('#save-status').addEventListener('click', () => sync.retryNow());
  $('#sidebar-close').addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
    if ($('#dialog').open) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      flushNotes();
      return;
    }
    if ((e.key === '/' || (e.code === 'Slash' && !e.shiftKey)) && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      runShortcut('search');
      return;
    }
    if (!$('#lock').hidden || health.state !== 'ok') return;
    const id = shortcuts.match(e);
    if (!id) return;
    if (id === 'moveOut' && !(S.view.type === 'note' && isScratch(S.view.id))) return;
    e.preventDefault();
    e.stopPropagation();
    runShortcut(id);
  }, true);
  // Another window changed the theme or shortcuts: follow along.
  window.addEventListener('storage', (e) => {
    if (e.key === KEYS.theme) theme.apply();
    if (e.key === KEYS.shortcuts) { shortcuts.load(); refreshShortcutHints(); }
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  // Used by the desktop app before it closes: save everything, report whether it all made it.
  window.__taskuleFlush = async (ms = 4000) => {
    flushNotes();
    await Promise.race([sync.idle(), sleep(ms)]);
    return !sync.pending;
  };
  window.__taskuleLock = () => lock.now(); // desktop app: tray menu → Lock
  // Desktop app: Alt+Win+Space from anywhere in Windows. Locked? Unlock first, then it continues.
  window.__taskuleQuickCapture = () => {
    if (!$('#lock').hidden || !booted) {
      pendingQuickCapture = true;
      setTimeout(() => $('#lock-password')?.focus());
      return;
    }
    $('#dialog').open && $('#dialog').close();
    closeMenu();
    openScratchpad({ newLine: true });
  };
  window.addEventListener('beforeunload', (e) => {
    flushNotes();
    if (sync.pending) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    flushNotes();
    // The page is going away: send everything still waiting, with keepalive so it survives unload.
    const waiting = sync.queue.filter((op) => !op.inFlight);
    sync.queue = sync.queue.filter((op) => op.inFlight);
    for (const op of waiting) {
      const body = op.body === undefined ? undefined : JSON.stringify(op.body);
      fetch(op.url, { method: op.method, headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNotes();
    else { sync.retryNow(); resync(); }
  });
  window.addEventListener('focus', () => { sync.retryNow(); resync(); });
  window.addEventListener('online', () => sync.retryNow());
  // Keep "Edited 3m ago" and "Completed 2h ago" fresh.
  setInterval(() => { updateNoteFoot(); }, 30000);
}

/** To-dos saved before creation dates were recorded are marked "unknown" once, so only new ones get today's date. */
function markOldTasksUndated() {
  for (const n of S.notes.values()) {
    if (!n.content.includes('"taskItem"')) continue;
    const doc = parseDoc(n.content);
    if (!doc) continue;
    const { doc: marked, count } = markUndatedTasks(doc);
    if (!count) continue;
    n.content = JSON.stringify(marked);
    sync.dirtyNotes.add(n.id);
  }
  flushNotes();
}

/** Notes written with the old markdown editor are converted to rich text once, and saved. */
function migrateLegacyNotes() {
  let count = 0;
  for (const n of S.notes.values()) {
    if (parseDoc(n.content) !== null) continue;
    n.content = JSON.stringify(legacyToDoc(n.content));
    sync.dirtyNotes.add(n.id);
    count++;
  }
  if (count) {
    flushNotes();
    toast(`Converted ${plural(count, 'note')} to the new editor`, { type: 'success' });
  }
}

let booted = false;
let pendingQuickCapture = false;
async function boot() {
  setupChrome();
  setupTree();
  setupMainDelegation();
  setupSearch();
  // Ask for the password up front (rather than after a failed load) when this session isn't unlocked yet.
  try {
    const s = await (await nativeFetch('/api/session', { cache: 'no-store' })).json();
    security.hasPassword = s?.open === false;
    if (s?.unlocked === false) await lock.require();
  } catch { /* server unreachable: the retry loop below shows that */ }
  main.innerHTML = '<div class="welcome"><p class="page-sub">Loading…</p></div>';
  for (let attempt = 0; ; attempt++) {
    try {
      applyState(await fetchState());
      break;
    } catch {
      main.innerHTML = `<div class="welcome"><div class="empty"><div class="empty-icon" style="background:var(--red-soft);color:var(--red)">${I.alert}</div><h3>Can't reach the server</h3><p>Is <code>npm start</code> running? Retrying…</p></div></div>`;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
    }
  }
  migrateLegacyNotes();
  markOldTasksUndated();
  recoverUnsavedEdits();
  health.start();
  // Taskule always opens on the Scratchpad (a link straight to a note still opens that note).
  if (!location.hash || location.hash === '#') history.replaceState(null, '', HOME);
  renderTodoCount();
  renderTaskPanel();
  route();
  booted = true;
  if (pendingQuickCapture) { pendingQuickCapture = false; openScratchpad({ newLine: true }); }
}

boot();
