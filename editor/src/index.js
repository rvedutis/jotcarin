// Rich-text editor for Taskule, built on TipTap (ProseMirror).
// Bundled to public/vendor/editor.js by `npm run build:editor`.
import { Editor, Node, Extension, mergeAttributes, generateJSON } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import Suggestion from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import { cleanPastedHTML, looksLikeMarkdown } from './paste.js';
import Image from '@tiptap/extension-image';
import { ImageLocalizer, insertImageFiles, imageFilesFrom } from './images.js';
// Shared with the app at runtime (kept external so there is one copy).
import { formatDate, todayISO, findDatesInText } from '/dates.js';
import { AtPopup, atItems, parseAtQuery, matchCommands } from '/datepopup.js';
import { renderForEditor } from '/markdown.js';

export { cleanPastedHTML, insertImageFiles };

const escapeHTML = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Commands offered after typing "@". "date" switches to date suggestions ("@date next fri"). */
const AT_COMMANDS = [
  { id: 'date', label: 'Date', icon: 'date', hint: 'today, next fri, nov 20…', aliases: ['day', 'when'] },
  { id: 'todo', label: 'To-do', icon: 'todo', hint: 'checkbox', aliases: ['task', 'checkbox', 'check'], run: (c) => c.toggleTaskList() },
  { id: 'image', label: 'Image', icon: 'image', hint: 'upload a picture', aliases: ['img', 'picture', 'photo', 'screenshot'] },
  { id: 'table', label: 'Table', icon: 'table', hint: '3 × 3', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  { id: 'link', label: 'Link', icon: 'link', hint: 'Ctrl+K', aliases: ['url'] },
  { id: 'h1', label: 'Heading 1', icon: 'heading', aliases: ['heading', 'title'], run: (c) => c.setHeading({ level: 1 }) },
  { id: 'h2', label: 'Heading 2', icon: 'heading', aliases: ['heading', 'subheading'], run: (c) => c.setHeading({ level: 2 }) },
  { id: 'h3', label: 'Heading 3', icon: 'heading', aliases: ['heading'], run: (c) => c.setHeading({ level: 3 }) },
  { id: 'bullet', label: 'Bulleted list', icon: 'bullet', aliases: ['list', 'ul'], run: (c) => c.toggleBulletList() },
  { id: 'numbered', label: 'Numbered list', icon: 'numbered', aliases: ['ol', 'number', 'list'], run: (c) => c.toggleOrderedList() },
  { id: 'quote', label: 'Quote', icon: 'quote', aliases: ['blockquote'], run: (c) => c.toggleBlockquote() },
  { id: 'code', label: 'Code block', icon: 'code', aliases: ['codeblock'], run: (c) => c.toggleCodeBlock() },
  { id: 'divider', label: 'Divider', icon: 'divider', aliases: ['hr', 'line', 'rule'], run: (c) => c.setHorizontalRule() },
];

/** Find an "@query" that starts at a word boundary right before the cursor. */
function matchAtQuery({ $position }) {
  const before = $position.nodeBefore;
  if (!before?.isText) return null;
  const text = before.text;
  const at = text.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'“‘]/.test(text[at - 1])) return null; // not part of an email address
  const query = text.slice(at + 1);
  if (query.length > 40 || /^\s/.test(query) || /\s{2}/.test(query) || query.split(' ').length > 6) return null;
  // Outside "@date …", only stay active while the text could still be a command (so @mentions stay plain).
  const p = parseAtQuery(query);
  if (p.mode === 'commands' && !matchCommands(AT_COMMANDS, p.commandQuery).length) return null;
  const from = $position.pos - text.length + at;
  return { range: { from, to: $position.pos }, query, text: `@${query}` };
}

const atMenuKey = new PluginKey('atMenu');

/** The "@" menu: commands, and dates under "@date". */
const AtMenu = Extension.create({
  name: 'atMenu',
  addOptions() { return { onImageRequest: null, onLinkShortcut: null }; },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [Suggestion({
      editor: this.editor,
      pluginKey: atMenuKey,
      char: '@',
      allowSpaces: true,
      allowedPrefixes: null,
      decorationClass: 'date-query',
      findSuggestionMatch: matchAtQuery,
      items: ({ query }) => atItems(query, AT_COMMANDS).items,
      command: ({ editor, range, props: item }) => {
        if (item.kind === 'date') {
          editor.chain().focus().insertContentAt(range, [{ type: 'date', attrs: { date: item.iso } }, { type: 'text', text: ' ' }]).run();
          return;
        }
        if (item.id === 'date') { editor.chain().focus().insertContentAt(range, '@date ').run(); return; }
        editor.chain().focus().deleteRange(range).run();
        if (item.id === 'image') { opts.onImageRequest?.(); return; }
        if (item.id === 'link') { opts.onLinkShortcut?.(); return; }
        item.run?.(editor.chain().focus()).run();
      },
      render: () => {
        let popup = null;
        let command = null;
        const sync = (props) => {
          command = props.command;
          popup.update(atItems(props.query, AT_COMMANDS), props.clientRect?.());
        };
        return {
          onStart: (props) => { popup = new AtPopup({ onPick: (item) => command?.(item) }); sync(props); },
          onUpdate: (props) => sync(props),
          onKeyDown: ({ event }) => (event.key === 'Escape' ? (popup?.hide(), true) : !!popup?.onKeyDown(event)),
          onExit: () => { popup?.destroy(); popup = null; },
        };
      },
    })];
  },
});

export const DateChip = Node.create({
  name: 'date',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      date: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-date'),
        renderHTML: (attrs) => ({ 'data-date': attrs.date }),
      },
    };
  },
  parseHTML() { return [{ tag: 'span[data-type="date"]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': 'date', class: 'date-chip' }, HTMLAttributes), formatDate(node.attrs.date)];
  },
  renderText({ node }) { return formatDate(node.attrs.date); },

  addCommands() {
    return {
      insertDate: (iso) => ({ chain }) => chain().insertContent([{ type: 'date', attrs: { date: iso } }, { type: 'text', text: ' ' }]).run(),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-;': () => this.editor.commands.insertDate(todayISO()) };
  },
  addProseMirrorPlugins() {
    // Highlight overdue (red) and today's (green) dates inside open to-dos, matching the to-do list.
    const dueDates = new Plugin({
      key: new PluginKey('dueDates'),
      props: {
        decorations(state) {
          const today = todayISO();
          const decos = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'date') return true;
            const iso = node.attrs.date;
            if (!iso || iso > today) return false;
            const $pos = state.doc.resolve(pos);
            for (let d = $pos.depth; d > 0; d--) {
              const anc = $pos.node(d);
              if (anc.type.name === 'taskItem') {
                if (!anc.attrs.checked) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: iso < today ? 'past' : 'today' }));
                break;
              }
            }
            return false;
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    });
    return [dueDates];
  },
});

/**
 * To-dos can carry a due date (set from the Tasks panel). It's stored on the to-do and shown
 * at the end of its first line; clicking it opens that task in the Tasks panel.
 * A new to-do made by pressing Enter doesn't inherit it.
 */
const DueTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      due: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el) => (/^\d{4}-\d{2}-\d{2}$/.test(el.getAttribute('data-due') || '') ? el.getAttribute('data-due') : null),
        renderHTML: (attrs) => (attrs.due ? { 'data-due': attrs.due } : {}),
      },
      // When the to-do was added and last changed (ms since 1970). 0 = from before these were
      // recorded (unknown). A new to-do made with Enter starts fresh rather than copying them.
      created: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el) => (/^\d+$/.test(el.getAttribute('data-created') || '') ? Number(el.getAttribute('data-created')) : null),
        renderHTML: (attrs) => (attrs.created ? { 'data-created': String(attrs.created) } : {}),
      },
      edited: {
        default: null,
        keepOnSplit: false,
        parseHTML: (el) => (/^\d+$/.test(el.getAttribute('data-edited') || '') ? Number(el.getAttribute('data-edited')) : null),
        renderHTML: (attrs) => (attrs.edited ? { 'data-edited': String(attrs.edited) } : {}),
      },
    };
  },
});

/**
 * Stamps to-dos: a new one gets "created" (and "edited") = now; changing a to-do's text
 * updates its "edited" (at most once a minute). Loading content from storage
 * (setContent without an update) is never treated as an edit.
 */
function taskStamps() {
  const key = new PluginKey('taskStamps');
  return new Plugin({
    key,
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged) || trs.some((t) => t.getMeta(key) || t.getMeta('preventUpdate'))) return null;
      const now = Date.now();
      const touched = new Set();
      // Positions in the final document that these transactions changed.
      trs.forEach((t, k) => {
        if (!t.docChanged) return;
        t.mapping.maps.forEach((map, i) => {
          map.forEach((_oS, _oE, nS, nE) => {
            let from = nS;
            let to = nE;
            const rest = [t.mapping.slice(i + 1), ...trs.slice(k + 1).map((x) => x.mapping)];
            for (const m of rest) { from = m.map(from, -1); to = m.map(to, 1); }
            for (const p of [from, to]) {
              const $p = state.doc.resolve(Math.max(0, Math.min(p, state.doc.content.size)));
              for (let d = $p.depth; d > 0; d--) {
                if ($p.node(d).type.name === 'taskItem') { touched.add($p.before(d)); break; } // innermost to-do only
              }
            }
          });
        });
      });
      const tr = state.tr;
      let changed = false;
      state.doc.descendants((node, pos) => {
        if (node.type.name !== 'taskItem') return true;
        const a = node.attrs;
        if (a.created == null) {
          tr.setNodeMarkup(pos, undefined, { ...a, created: now, edited: now });
          changed = true;
        } else if (touched.has(pos) && (!a.edited || now - a.edited > 60_000)) {
          tr.setNodeMarkup(pos, undefined, { ...a, edited: now });
          changed = true;
        }
        return true;
      });
      if (!changed) return null;
      tr.setMeta(key, true);
      return tr;
    },
  });
}

function dueBadges(onTaskOpen) {
  return new Plugin({
    key: new PluginKey('taskDue'),
    props: {
      decorations(state) {
        const today = todayISO();
        const decos = [];
        let index = -1;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'taskItem') return true;
          index++;
          const iso = node.attrs.due;
          const first = node.firstChild;
          if (!iso || !first || first.type.name !== 'paragraph') return true;
          const at = pos + 1 + first.nodeSize - 1; // end of the to-do's first line
          const i = index;
          const cls = `task-due${node.attrs.checked ? ' done' : iso < today ? ' past' : iso === today ? ' today' : ''}`;
          decos.push(Decoration.widget(at, () => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = cls;
            el.contentEditable = 'false';
            el.title = 'Due date — click to change it in the Tasks panel';
            el.textContent = `Due ${formatDate(iso)}`;
            el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onTaskOpen?.(i); });
            return el;
          }, { side: 1, ignoreSelection: true, key: `due-${i}-${iso}-${cls}` }));
          return true;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

/** Ctrl/Cmd+Enter toggles the to-do at the cursor (or turns the line into one). */
const TaskShortcuts = Extension.create({
  name: 'taskShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': ({ editor }) => {
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name === 'taskItem') {
            const pos = $from.before(d);
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
            return true;
          }
        }
        return editor.commands.toggleTaskList();
      },
    };
  },
});

function extensions({ placeholder = '', onLinkShortcut, onImageRequest, onImageError, onTaskOpen } = {}) {
  const exts = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
      },
    }),
    TaskList,
    DueTaskItem.configure({ nested: true }),
    Extension.create({ name: 'taskDueBadges', addProseMirrorPlugins: () => [dueBadges(onTaskOpen), taskStamps()] }),
    Table.configure({ resizable: false, renderWrapper: true }),
    TableRow,
    TableHeader,
    TableCell,
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    Image.configure({
      inline: false,
      allowBase64: true, // pasted data: images are uploaded and swapped for a stored copy
      resize: { enabled: true, directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], minWidth: 40, minHeight: 24, alwaysPreserveAspectRatio: true },
    }),
    ImageLocalizer.configure({ onError: onImageError }),
    DateChip,
    AtMenu.configure({ onImageRequest, onLinkShortcut }),
    TaskShortcuts,
    Placeholder.configure({ placeholder }),
  ];
  if (onLinkShortcut) {
    exts.push(Extension.create({
      name: 'linkShortcut',
      addKeyboardShortcuts() { return { 'Mod-k': () => { onLinkShortcut(); return true; } }; },
    }));
  }
  return exts;
}

export function createNoteEditor({ element, content, placeholder, onUpdate, onLinkShortcut, onSelectionChange, onImageRequest, onImageError, onTaskOpen }) {
  let plainPaste = false; // Ctrl+Shift+V pastes plain text, without Markdown conversion
  let editor = null;
  editor = new Editor({
    element,
    extensions: extensions({ placeholder, onLinkShortcut, onImageRequest, onImageError, onTaskOpen }),
    content: content || '',
    autofocus: false,
    editorProps: {
      attributes: { class: 'rich', spellcheck: 'true', 'aria-label': 'Note body' },
      // Google Docs / Word / web pages: turn their inline-CSS formatting into real formatting.
      transformPastedHTML: (html) => {
        try { return cleanPastedHTML(html); } catch (err) { console.warn('paste cleanup failed', err); return html; }
      },
      handleKeyDown(view, event) {
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
          plainPaste = true;
          setTimeout(() => { plainPaste = false; }, 500);
        }
        return false;
      },
      handlePaste(view, event) {
        const cd = event.clipboardData;
        if (!cd) return false;
        // Pasted image files (screenshots, "Copy image") are stored locally and inserted.
        const files = imageFilesFrom(cd);
        if (files.length) {
          insertImageFiles(editor, files, null, onImageError);
          return true;
        }
        if (plainPaste || [...cd.types].includes('text/html')) return false;
        if (view.state.selection.$from.parent.type.spec.code) return false; // inside a code block
        // Plain text: Markdown (e.g. Google Docs "Copy as Markdown") becomes formatted, and dates become date tags.
        const text = cd.getData('text/plain');
        const md = looksLikeMarkdown(text);
        if (!md && !findDatesInText(text).length) return false;
        const html = md ? renderForEditor(text) : text.replace(/\r\n?/g, '\n').split('\n').map((l) => `<p>${escapeHTML(l)}</p>`).join('');
        editor.commands.insertContent(cleanPastedHTML(html));
        return true;
      },
      handleDrop(view, event, slice, moved) {
        if (moved) return false;
        const files = imageFilesFrom(event.dataTransfer);
        if (!files.length) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
        insertImageFiles(editor, files, pos, onImageError);
        return true;
      },
      handleClick(view, pos, event) {
        // Ctrl/Cmd+click opens links (plain click just places the cursor).
        const a = event.target.closest?.('a[href]');
        if (a && (event.ctrlKey || event.metaKey)) { window.open(a.href, '_blank', 'noopener'); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => onUpdate?.(e),
    onSelectionUpdate: ({ editor: e }) => onSelectionChange?.(e),
    onTransaction: ({ editor: e }) => onSelectionChange?.(e),
  });
  return editor;
}

/** Convert HTML (e.g. legacy markdown rendered to HTML) into a document JSON. */
export function htmlToDoc(html) {
  return generateJSON(html, extensions());
}

function scrollSelectionIntoView(editor) {
  requestAnimationFrame(() => {
    try {
      const { node } = editor.view.domAtPos(editor.state.selection.from);
      const el = node.nodeType === 1 ? node : node.parentElement;
      el?.scrollIntoView({ block: 'center' });
    } catch { /* ignore */ }
  });
}

/** Select the first occurrence of any search term. */
export function selectFirstMatch(editor, terms) {
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'date') {
      const label = formatDate(node.attrs.date).toLowerCase();
      if (terms.some((t) => label.includes(t))) found = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    if (!node.isText) return true;
    const lower = node.text.toLowerCase();
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i !== -1 && (!found || pos + i < found.from)) found = { from: pos + i, to: pos + i + t.length };
    }
    return false;
  });
  if (found) editor.commands.setTextSelection(found);
  editor.view.focus();
  if (found) scrollSelectionIntoView(editor);
}

/** Put the cursor at the end of the n-th to-do (document order). */
export function selectTask(editor, index) {
  let n = 0;
  let target = null;
  editor.state.doc.descendants((node, pos) => {
    if (target != null) return false;
    if (node.type.name === 'taskItem') {
      if (n === index) {
        const para = node.firstChild;
        target = pos + 1 + (para ? para.nodeSize - 1 : 0);
        return false;
      }
      n++;
    }
    return true;
  });
  if (target != null) editor.commands.setTextSelection(target);
  editor.view.focus();
  if (target != null) scrollSelectionIntoView(editor);
}
