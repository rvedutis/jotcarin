// Export everything to Word (.docx), Markdown (.zip) or PDF — generated in the browser.
// Bundled to public/vendor/export.js and loaded only when you export.
import { zipSync, strToU8 } from 'fflate';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell,
  WidthType, ImageRun, LevelFormat, AlignmentType, BorderStyle, ShadingType, Footer, PageNumber,
} from 'docx';
import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';
import { formatDate, todayISO } from '/dates.js';
import { parseDoc, docTasks } from '/doc.js';

pdfMake.addVirtualFileSystem(pdfFonts);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const noteTitle = (n) => (n.title || '').trim() || 'Untitled';

// ------------------------------------------------------------------ shared model
const isBlank = (n) => n.type === 'paragraph' && !(n.content || []).some((c) => c.type !== 'text' || c.text.trim());
/** Drop empty lines at the start and end of a note (they only cause stray blank pages). */
function trimDoc(doc) {
  const content = [...(doc.content || [])];
  while (content.length && isBlank(content[content.length - 1])) content.pop();
  while (content.length && isBlank(content[0])) content.shift();
  return { ...doc, content };
}

const SCRATCHPAD_ID = 'scratchpad'; // the permanent quick-capture note (listed first)

/**
 * data: { folders, notes, tasks, legacyToDoc } → ordered sections:
 * [{ path: ['Work','Meetings'] | [], notes: [{ note, doc }] }]
 */
function buildModel({ folders, notes, tasks, legacyToDoc }) {
  const kids = new Map();
  const notesBy = new Map();
  const fmap = new Map(folders.map((f) => [f.id, f]));
  for (const f of folders) {
    const k = f.parentId && fmap.has(f.parentId) ? f.parentId : null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(f);
  }
  let noteCount = 0;
  for (const n of notes) {
    const doc = trimDoc(parseDoc(n.content) ?? legacyToDoc(n.content));
    if (n.id === SCRATCHPAD_ID && !doc.content?.length) continue; // an empty Scratchpad isn't worth a page
    const k = n.folderId && fmap.has(n.folderId) ? n.folderId : null;
    if (!notesBy.has(k)) notesBy.set(k, []);
    notesBy.get(k).push({ note: n, doc });
    noteCount++;
  }
  const sections = [];
  const walk = (pid, path) => {
    const ns = (notesBy.get(pid) || []).sort((a, b) =>
      (b.note.id === SCRATCHPAD_ID) - (a.note.id === SCRATCHPAD_ID) || collator.compare(noteTitle(a.note), noteTitle(b.note)));
    if (ns.length) sections.push({ path, notes: ns });
    for (const f of (kids.get(pid) || []).sort((a, b) => collator.compare(a.name, b.name))) walk(f.id, [...path, f.name]);
  };
  walk(null, []);

  // To-dos, grouped the same way as the app's To-dos page
  const sa = [...tasks];
  const groups = { open: [], done: [] };
  const so = sa.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt);
  const sd = sa.filter((t) => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  if (so.length) groups.open.push({ title: 'Standalone tasks', tasks: so.map((t) => ({ text: t.text, nodes: null, done: false, due: t.due || null, body: t.body || '' })) });
  if (sd.length) groups.done.push({ title: 'Standalone tasks', tasks: sd.map((t) => ({ text: t.text, nodes: null, done: true, due: t.due || null, body: t.body || '' })) });
  for (const s of sections) {
    for (const { note, doc } of s.notes) {
      const ts = docTasks(doc).filter((t) => t.text);
      const title = [...s.path, noteTitle(note)].join(' / ');
      const o = ts.filter((t) => !t.done);
      const d = ts.filter((t) => t.done);
      if (o.length) groups.open.push({ title, tasks: o });
      if (d.length) groups.done.push({ title, tasks: d });
    }
  }
  return { sections, todos: groups, noteCount };
}

/** Load every image used, once: bytes + size, converted to PNG when a format needs it. */
async function loadImages(model, onProgress) {
  const srcs = new Set();
  const walk = (n) => { if (n.type === 'image' && n.attrs?.src) srcs.add(n.attrs.src); n.content?.forEach(walk); };
  for (const s of model.sections) for (const { doc } of s.notes) walk(doc);
  const out = new Map();
  let i = 0;
  for (const src of srcs) {
    onProgress?.(`Loading images ${++i}/${srcs.size}…`);
    try {
      const blob = await (await fetch(src)).blob();
      const bmp = await createImageBitmap(blob);
      let type = (blob.type.split('/')[1] || '').replace('jpeg', 'jpg');
      const original = new Uint8Array(await blob.arrayBuffer());
      const originalExt = (src.split('.').pop() || type).toLowerCase();
      let bytes = original;
      if (!['png', 'jpg'].includes(type)) {
        // GIF/WebP/AVIF/BMP → PNG so Word and PDF can embed it
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        const png = await new Promise((r) => c.toBlob(r, 'image/png'));
        bytes = new Uint8Array(await png.arrayBuffer());
        type = 'png';
      }
      let bin = '';
      for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
      out.set(src, {
        bytes, type, width: bmp.width, height: bmp.height,
        dataURL: `data:image/${type === 'jpg' ? 'jpeg' : 'png'};base64,${btoa(bin)}`,
        original, originalExt,
      });
      bmp.close?.();
    } catch { /* missing image: skipped */ }
  }
  return out;
}

/** Display size in px for an image node (respects resizing), capped to the page width. */
function imageSize(node, img, maxPx) {
  let w = Number(node.attrs?.width) || img.width;
  let h = Number(node.attrs?.height) || Math.round(w * (img.height / img.width));
  if (!node.attrs?.height) h = Math.round(w * (img.height / img.width));
  if (w > maxPx) { h = Math.round(h * (maxPx / w)); w = maxPx; }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

const stamp = () => todayISO();
const exportTitle = () => `Taskule export — ${formatDate(todayISO())}`;

// ------------------------------------------------------------------ Markdown (.zip)
const mdEscape = (s) => s.replace(/([\\`*_[\]<>|])/g, '\\$1');
function mdInline(nodes) {
  let out = '';
  for (const n of nodes || []) {
    if (n.type === 'date') { out += formatDate(n.attrs?.date); continue; }
    if (n.type === 'hardBreak') { out += '  \n'; continue; }
    if (n.type !== 'text') continue;
    const marks = n.marks || [];
    const has = (t) => marks.find((m) => m.type === t);
    let t = has('code') ? `\`${n.text}\`` : mdEscape(n.text || '');
    if (!has('code')) {
      // keep surrounding spaces outside the markers
      const lead = t.match(/^\s*/)[0];
      const trail = t.slice(lead.length).match(/\s*$/)[0];
      let core = t.slice(lead.length, t.length - trail.length);
      if (core) {
        if (has('bold')) core = `**${core}**`;
        if (has('italic')) core = `*${core}*`;
        if (has('strike')) core = `~~${core}~~`;
        if (has('underline')) core = `<u>${core}</u>`;
        if (has('highlight')) core = `<mark>${core}</mark>`;
      }
      t = lead + core + trail;
    }
    const link = has('link');
    if (link?.attrs?.href) t = `[${t}](${link.attrs.href})`;
    out += t;
  }
  return out;
}

function mdBlocks(nodes, ctx, indent = '') {
  const parts = [];
  for (const n of nodes || []) {
    switch (n.type) {
      case 'paragraph': parts.push(indent + mdInline(n.content)); break;
      case 'heading': parts.push(`${indent}${'#'.repeat(Math.min(6, (n.attrs?.level || 1) + 1))} ${mdInline(n.content)}`); break;
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        let num = n.attrs?.start || 1;
        const lines = [];
        for (const item of n.content || []) {
          const marker = n.type === 'bulletList' ? '- ' : n.type === 'orderedList' ? `${num++}. ` : `- [${item.attrs?.checked ? 'x' : ' '}] `;
          const [first, ...rest] = item.content || [];
          const firstText = first?.type === 'paragraph' ? mdInline(first.content) : '';
          lines.push(indent + marker + firstText + (n.type === 'taskList' && item.attrs?.due ? ` *(due ${formatDate(item.attrs.due)})*` : ''));
          const restNodes = first?.type === 'paragraph' ? rest : item.content || [];
          if (restNodes.length) lines.push(mdBlocks(restNodes, ctx, `${indent}${' '.repeat(marker.length)}`).replace(/\n\n/g, '\n'));
        }
        parts.push(lines.join('\n'));
        break;
      }
      case 'blockquote': parts.push(mdBlocks(n.content, ctx).split('\n').map((l) => `${indent}> ${l}`.trimEnd()).join('\n')); break;
      case 'codeBlock': parts.push(`${indent}\`\`\`${n.attrs?.language || ''}\n${(n.content || []).map((t) => t.text).join('')}\n${indent}\`\`\``); break;
      case 'horizontalRule': parts.push(`${indent}---`); break;
      case 'image': {
        const img = ctx.images.get(n.attrs?.src);
        if (img) {
          const file = ctx.addImage(n.attrs.src, img);
          parts.push(`${indent}![${mdEscape(n.attrs?.alt || '')}](${ctx.up}images/${file})`);
        }
        break;
      }
      case 'table': {
        const rows = (n.content || []).map((row) => (row.content || []).map((cell) => (cell.content || [])
          .map((b) => (b.type === 'paragraph' || b.type === 'heading' ? mdInline(b.content) : mdBlocks([b], ctx).replace(/\n/g, '<br>')))
          .join('<br>').replace(/\|/g, '\\|') || ' '));
        if (!rows.length) break;
        const width = Math.max(...rows.map((r) => r.length));
        const line = (r) => `${indent}| ${Array.from({ length: width }, (_, i) => r[i] ?? ' ').join(' | ')} |`;
        parts.push([line(rows[0]), `${indent}|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n'));
        break;
      }
      default:
        if (n.content) parts.push(mdBlocks(n.content, ctx, indent));
    }
  }
  return parts.filter((p) => p !== undefined).join('\n\n');
}

const safeName = (s) => (s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled').replace(/[. ]+$/, '');

export async function exportMarkdown(data, onProgress) {
  const model = buildModel(data);
  const images = await loadImages(model, onProgress);
  onProgress?.('Writing Markdown…');
  const root = `Taskule ${stamp()}`;
  const files = {};
  const imageFiles = new Map();
  const addImage = (src, img) => {
    if (!imageFiles.has(src)) {
      const base = safeName((src.split('/').pop() || 'image').replace(/\.[^.]+$/, ''));
      const name = `${base}.${img.originalExt}`;
      imageFiles.set(src, name);
      files[`${root}/images/${name}`] = [img.original, { level: 0 }]; // images are already compressed
    }
    return imageFiles.get(src);
  };
  const used = new Set();
  for (const s of model.sections) {
    const dir = [root, ...s.path.map(safeName)].join('/');
    for (const { note, doc } of s.notes) {
      let name = safeName(noteTitle(note));
      let k = 2;
      while (used.has(`${dir}/${name}.md`.toLowerCase())) name = `${safeName(noteTitle(note))} (${k++})`;
      used.add(`${dir}/${name}.md`.toLowerCase());
      const ctx = { images, addImage, up: '../'.repeat(s.path.length) };
      const body = mdBlocks(doc.content, ctx);
      const meta = `*Last edited ${formatDate(todayISO(new Date(note.updatedAt)))}*`;
      files[`${dir}/${name}.md`] = strToU8(`# ${noteTitle(note)}\n\n${meta}\n\n${body.replace(/\s+$/, '')}\n`);
    }
  }
  // To-dos summary
  const todoLines = [`# To-dos`, '', `*Exported ${formatDate(todayISO())}*`, ''];
  for (const [label, list] of [['Open', model.todos.open], ['Completed', model.todos.done]]) {
    todoLines.push(`## ${label}`, '');
    if (!list.length) todoLines.push('_None_', '');
    for (const g of list) {
      todoLines.push(`### ${mdEscape(g.title)}`, '');
      for (const t of g.tasks) {
        todoLines.push(`- [${t.done ? 'x' : ' '}] ${t.nodes ? mdInline(t.nodes) : mdEscape(t.text)}${t.due ? ` *(due ${formatDate(t.due)})*` : ''}`);
        for (const line of (t.body || '').split('\n').filter((l) => l.trim())) todoLines.push(`      ${mdEscape(line)}`);
      }
      todoLines.push('');
    }
  }
  files[`${root}/To-dos.md`] = strToU8(todoLines.join('\n'));
  const zip = zipSync(files, { level: 6 });
  return { blob: new Blob([zip], { type: 'application/zip' }), filename: `taskule-markdown-${stamp()}.zip` };
}

// ------------------------------------------------------------------ Word (.docx)
const hex = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (m) return m[1].toUpperCase();
  const r = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(String(c || ''));
  return r ? r.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
};

function docxRuns(nodes, base = {}) {
  const runs = [];
  for (const n of nodes || []) {
    if (n.type === 'date') { runs.push(new TextRun({ ...base, text: formatDate(n.attrs?.date), color: '2A52CC', bold: true })); continue; }
    if (n.type === 'hardBreak') { runs.push(new TextRun({ ...base, text: '', break: 1 })); continue; }
    if (n.type !== 'text') continue;
    const marks = n.marks || [];
    const has = (t) => marks.find((m) => m.type === t);
    const opts = { ...base, text: n.text || '' };
    if (has('bold')) opts.bold = true;
    if (has('italic')) opts.italics = true;
    if (has('underline')) opts.underline = {};
    if (has('strike')) opts.strike = true;
    if (has('code')) { opts.font = 'Consolas'; opts.shading = { type: ShadingType.CLEAR, fill: 'EEF0F6', color: 'auto' }; }
    const hl = has('highlight');
    if (hl) opts.shading = { type: ShadingType.CLEAR, fill: hex(hl.attrs?.color) || 'FDE68A', color: 'auto' };
    const col = has('textStyle');
    if (col && hex(col.attrs?.color)) opts.color = hex(col.attrs.color);
    const link = has('link');
    if (link?.attrs?.href) {
      runs.push(new ExternalHyperlink({ link: link.attrs.href, children: [new TextRun({ ...opts, style: 'Hyperlink' })] }));
    } else {
      runs.push(new TextRun(opts));
    }
  }
  return runs;
}

const DOCX_MAX_IMG = 620; // px, ~6.5in
function docxBlocks(nodes, ctx, level = 0) {
  const out = [];
  for (const n of nodes || []) {
    switch (n.type) {
      case 'paragraph': out.push(new Paragraph({ children: docxRuns(n.content), indent: level ? { left: 360 * level } : undefined, spacing: { after: 120 } })); break;
      case 'heading': {
        const lvl = Math.min(6, (n.attrs?.level || 1) + 2);
        out.push(new Paragraph({ heading: HeadingLevel[`HEADING_${lvl}`], children: docxRuns(n.content) }));
        break;
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        const instance = n.type === 'orderedList' ? ++ctx.listInstance : 0;
        for (const item of n.content || []) {
          const [first, ...rest] = item.content || [];
          const firstRuns = first?.type === 'paragraph' ? docxRuns(first.content, item.attrs?.checked ? { color: '6C7389' } : {}) : [];
          if (n.type === 'taskList') {
            out.push(new Paragraph({
              children: [new TextRun({ text: item.attrs?.checked ? '☒  ' : '☐  ', font: 'Segoe UI Symbol' }), ...firstRuns,
                ...(item.attrs?.due ? [new TextRun({ text: `  (due ${formatDate(item.attrs.due)})`, color: '6C7389' })] : [])],
              indent: { left: 360 * (level + 1), hanging: 300 },
              spacing: { after: 60 },
            }));
          } else {
            out.push(new Paragraph({
              children: firstRuns,
              numbering: n.type === 'bulletList' ? { reference: 'bullets', level: Math.min(level, 8) } : { reference: 'numbers', level: Math.min(level, 8), instance },
              spacing: { after: 60 },
            }));
          }
          const restNodes = first?.type === 'paragraph' ? rest : item.content || [];
          out.push(...docxBlocks(restNodes, ctx, level + 1));
        }
        break;
      }
      case 'blockquote':
        out.push(...docxBlocks(n.content, ctx, level + 1));
        break;
      case 'codeBlock': {
        const text = (n.content || []).map((t) => t.text).join('');
        out.push(new Paragraph({
          children: text.split('\n').flatMap((line, i) => [new TextRun({ text: line, font: 'Consolas', size: 19, break: i ? 1 : 0 })]),
          shading: { type: ShadingType.CLEAR, fill: 'F4F5FA', color: 'auto' },
          indent: { left: 360 * level },
          spacing: { after: 120 },
        }));
        break;
      }
      case 'horizontalRule':
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D3D8E6', space: 1 } }, spacing: { after: 120 } }));
        break;
      case 'image': {
        const img = ctx.images.get(n.attrs?.src);
        if (!img) break;
        const { w, h } = imageSize(n, img, DOCX_MAX_IMG - 24 * level);
        out.push(new Paragraph({ children: [new ImageRun({ type: img.type, data: img.bytes, transformation: { width: w, height: h } })], spacing: { after: 120 } }));
        break;
      }
      case 'table': {
        const rows = (n.content || []).map((row) => new TableRow({
          children: (row.content || []).map((cell) => new TableCell({
            children: (() => { const c = docxBlocks(cell.content, ctx, 0); return c.length ? c : [new Paragraph('')]; })(),
            shading: cell.type === 'tableHeader' ? { type: ShadingType.CLEAR, fill: 'F2F4FA', color: 'auto' } : undefined,
            columnSpan: cell.attrs?.colspan > 1 ? cell.attrs.colspan : undefined,
            rowSpan: cell.attrs?.rowspan > 1 ? cell.attrs.rowspan : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          })),
        }));
        if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }), new Paragraph({ children: [], spacing: { after: 60 } }));
        break;
      }
      default:
        if (n.content) out.push(...docxBlocks(n.content, ctx, level));
    }
  }
  return out;
}

const bulletLevels = Array.from({ length: 9 }, (_, i) => ({
  level: i, format: LevelFormat.BULLET, text: ['•', '◦', '▪'][i % 3], alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: 360 * (i + 1), hanging: 260 } } },
}));
const numberLevels = Array.from({ length: 9 }, (_, i) => ({
  level: i, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][i % 3], text: `%${i + 1}.`, alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: 360 * (i + 1), hanging: 300 } } },
}));

export async function exportWord(data, onProgress) {
  const model = buildModel(data);
  const images = await loadImages(model, onProgress);
  onProgress?.('Writing Word document…');
  const ctx = { images, listInstance: 0 };
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Taskule')] }),
    new Paragraph({ children: [new TextRun({ text: `Exported ${formatDate(todayISO())} · ${model.noteCount} notes`, color: '6C7389' })], spacing: { after: 240 } }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('To-dos')] }),
  ];
  for (const [label, list] of [['Open', model.todos.open], ['Completed', model.todos.done]]) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(label)] }));
    if (!list.length) children.push(new Paragraph({ children: [new TextRun({ text: 'None', italics: true, color: '6C7389' })] }));
    for (const g of list) {
      children.push(new Paragraph({ children: [new TextRun({ text: g.title, bold: true })], spacing: { before: 120, after: 60 } }));
      for (const t of g.tasks) {
        children.push(new Paragraph({
          children: [new TextRun({ text: t.done ? '☒  ' : '☐  ', font: 'Segoe UI Symbol' }), ...(t.nodes ? docxRuns(t.nodes) : [new TextRun(t.text)]),
            ...(t.due ? [new TextRun({ text: `  (due ${formatDate(t.due)})`, color: '6C7389' })] : [])],
          indent: { left: 360, hanging: 300 },
          spacing: { after: 40 },
        }));
        for (const line of (t.body || '').split('\n').filter((l) => l.trim())) {
          children.push(new Paragraph({ children: [new TextRun({ text: line, color: '444B62', size: 20 })], indent: { left: 660 }, spacing: { after: 20 } }));
        }
      }
    }
  }
  for (const s of model.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(s.path.length ? s.path.join(' / ') : 'Notes')] }));
    s.notes.forEach(({ note, doc }) => {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(noteTitle(note))] }));
      children.push(new Paragraph({ children: [new TextRun({ text: `Last edited ${formatDate(todayISO(new Date(note.updatedAt)))}`, italics: true, color: '9AA1B5', size: 18 })], spacing: { after: 120 } }));
      children.push(...docxBlocks(doc.content, ctx));
    });
  }
  const document = new Document({
    creator: 'Taskule',
    title: exportTitle(),
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [],
    },
    numbering: { config: [{ reference: 'bullets', levels: bulletLevels }, { reference: 'numbers', levels: numberLevels }] },
    sections: [{
      properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], color: '9AA1B5', size: 18 })] })] }) },
      children,
    }],
  });
  const blob = await Packer.toBlob(document);
  return { blob, filename: `taskule-${stamp()}.docx` };
}

// ------------------------------------------------------------------ PDF
const PDF_WIDTH = 504; // pt: letter width minus 54pt margins
const pdfColor = (c) => { const h = hex(c); return h ? `#${h}` : undefined; };
const box = (checked) => `<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.6" y="0.6" width="8.8" height="8.8" rx="2" fill="${checked ? '#17945c' : '#ffffff'}" stroke="${checked ? '#17945c' : '#9aa1b5'}" stroke-width="1"/>${checked ? '<path d="M2.6 5.2 L4.3 6.9 L7.5 3.4" stroke="#ffffff" stroke-width="1.4" fill="none"/>' : ''}</svg>`;

function pdfInline(nodes, base = {}) {
  const out = [];
  for (const n of nodes || []) {
    if (n.type === 'date') { out.push({ ...base, text: formatDate(n.attrs?.date), color: '#2a52cc', bold: true }); continue; }
    if (n.type === 'hardBreak') { out.push({ ...base, text: '\n' }); continue; }
    if (n.type !== 'text') continue;
    const marks = n.marks || [];
    const has = (t) => marks.find((m) => m.type === t);
    const r = { ...base, text: n.text || '' };
    if (has('bold')) r.bold = true;
    if (has('italic')) r.italics = true;
    const deco = [];
    if (has('underline')) deco.push('underline');
    if (has('strike')) deco.push('lineThrough');
    if (deco.length) r.decoration = deco.length === 1 ? deco[0] : deco;
    if (has('code')) { r.background = '#eef0f6'; r.fontSize = 9.5; }
    const hl = has('highlight');
    if (hl) r.background = pdfColor(hl.attrs?.color) || '#fde68a';
    const col = has('textStyle');
    if (col && pdfColor(col.attrs?.color)) r.color = pdfColor(col.attrs.color);
    const link = has('link');
    if (link?.attrs?.href) { r.link = link.attrs.href; r.color = r.color || '#2a52cc'; r.decoration = r.decoration || 'underline'; }
    out.push(r);
  }
  return out.length ? out : [{ text: ' ' }];
}

const UL_TYPES = ['disc', 'circle', 'square'];
const OL_TYPES = ['decimal', 'lower-alpha', 'lower-roman'];
function pdfBlocks(nodes, ctx, width = PDF_WIDTH, depth = 0) {
  const out = [];
  for (const n of nodes || []) {
    switch (n.type) {
      case 'paragraph': out.push({ text: pdfInline(n.content), margin: [0, 0, 0, 6] }); break;
      case 'heading': out.push({ text: pdfInline(n.content), style: `nh${Math.min(3, n.attrs?.level || 1)}` }); break;
      case 'bulletList':
      case 'orderedList': {
        const items = (n.content || []).map((item) => {
          const [first, ...rest] = item.content || [];
          const stack = [];
          if (first?.type === 'paragraph') stack.push({ text: pdfInline(first.content) });
          stack.push(...pdfBlocks(first?.type === 'paragraph' ? rest : item.content || [], ctx, width - 16, depth + 1));
          return { stack, margin: [0, 0, 0, 2] };
        });
        const margin = depth ? [0, 2, 0, 0] : [0, 0, 0, 6]; // nested lists sit tight under their item
        out.push(n.type === 'bulletList'
          ? { ul: items, type: UL_TYPES[depth % 3], margin }
          : { ol: items, type: OL_TYPES[depth % 3], start: n.attrs?.start || 1, margin });
        break;
      }
      case 'taskList': {
        for (const item of n.content || []) {
          const done = !!item.attrs?.checked;
          const [first, ...rest] = item.content || [];
          const stack = [];
          if (first?.type === 'paragraph') {
            const due = item.attrs?.due ? [{ text: `  (due ${formatDate(item.attrs.due)})`, color: '#6c7389' }] : [];
            stack.push({ text: [...pdfInline(first.content, done ? { color: '#6c7389' } : {}), ...due] });
          }
          stack.push(...pdfBlocks(first?.type === 'paragraph' ? rest : item.content || [], ctx, width - 16, depth + 1));
          out.push({ columns: [{ svg: box(done), width: 10, margin: [0, 2.5, 0, 0] }, { stack, width: '*' }], columnGap: 6, margin: [0, 0, 0, 3] });
        }
        if (!depth) out.push({ text: '', margin: [0, 0, 0, 3] });
        break;
      }
      case 'blockquote':
        out.push({
          table: { widths: ['*'], body: [[{ stack: pdfBlocks(n.content, ctx, width - 14), color: '#444b62' }]] },
          layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 2.5 : 0), vLineColor: () => '#c8b8f5', paddingLeft: () => 10, paddingTop: () => 2, paddingBottom: () => 0 },
          margin: [0, 0, 0, 6],
        });
        break;
      case 'codeBlock':
        out.push({
          table: { widths: ['*'], body: [[{ text: (n.content || []).map((t) => t.text).join(''), fontSize: 9, preserveLeadingSpaces: true }]] },
          layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#e3e6ef', vLineColor: () => '#e3e6ef', fillColor: () => '#f4f5fa', paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
          margin: [0, 0, 0, 8],
        });
        break;
      case 'horizontalRule':
        out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.6, lineColor: '#d3d8e6' }], margin: [0, 6, 0, 10] });
        break;
      case 'image': {
        const img = ctx.images.get(n.attrs?.src);
        if (!img) break;
        const { w } = imageSize(n, img, width / 0.75);
        out.push({ image: img.dataURL, width: Math.min(width, w * 0.75), margin: [0, 2, 0, 8] });
        break;
      }
      case 'table': {
        const rows = (n.content || []).map((row) => (row.content || []).map((cell) => ({
          stack: pdfBlocks(cell.content, ctx, width / Math.max(1, (row.content || []).length)),
          fillColor: cell.type === 'tableHeader' ? '#f2f4fa' : undefined,
          bold: cell.type === 'tableHeader' ? true : undefined,
          colSpan: cell.attrs?.colspan > 1 ? cell.attrs.colspan : undefined,
          rowSpan: cell.attrs?.rowspan > 1 ? cell.attrs.rowspan : undefined,
        })));
        if (!rows.length) break;
        const cols = Math.max(...rows.map((r) => r.reduce((a, c) => a + (c.colSpan || 1), 0)));
        // pdfmake needs placeholders for spanned cells
        const body = rows.map((r) => {
          const cells = [];
          for (const c of r) { cells.push(c); for (let k = 1; k < (c.colSpan || 1); k++) cells.push({}); }
          while (cells.length < cols) cells.push({ text: '' });
          return cells;
        });
        out.push({
          table: { widths: Array(cols).fill('*'), body, headerRows: (n.content?.[0]?.content || []).every((c) => c.type === 'tableHeader') ? 1 : 0 },
          layout: { hLineColor: () => '#d3d8e6', vLineColor: () => '#d3d8e6', hLineWidth: () => 0.6, vLineWidth: () => 0.6, paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 4, paddingBottom: () => 2 },
          margin: [0, 0, 0, 8],
        });
        break;
      }
      default:
        if (n.content) out.push(...pdfBlocks(n.content, ctx, width));
    }
  }
  return out;
}

export async function exportPdf(data, onProgress) {
  const model = buildModel(data);
  const images = await loadImages(model, onProgress);
  onProgress?.('Writing PDF…');
  const ctx = { images };
  const content = [
    { text: 'Taskule', style: 'title' },
    { text: `Exported ${formatDate(todayISO())} · ${model.noteCount} notes`, color: '#6c7389', margin: [0, 0, 0, 18] },
    { text: 'To-dos', style: 'h1' },
  ];
  for (const [label, list] of [['Open', model.todos.open], ['Completed', model.todos.done]]) {
    content.push({ text: label, style: 'h2' });
    if (!list.length) content.push({ text: 'None', italics: true, color: '#6c7389', margin: [0, 0, 0, 6] });
    for (const g of list) {
      content.push({ text: g.title, bold: true, margin: [0, 6, 0, 3] });
      for (const t of g.tasks) {
        const base = t.done ? { color: '#6c7389' } : {};
        const due = t.due ? [{ text: `  (due ${formatDate(t.due)})`, color: '#6c7389' }] : [];
        const details = (t.body || '').split('\n').filter((l) => l.trim()).map((l) => ({ text: l, color: '#444b62', fontSize: 9.5 }));
        content.push({ columns: [{ svg: box(t.done), width: 10, margin: [0, 2.5, 0, 0] }, { stack: [{ text: [...(t.nodes ? pdfInline(t.nodes, base) : [{ ...base, text: t.text }]), ...due] }, ...details], width: '*' }], columnGap: 6, margin: [8, 0, 0, 3] });
      }
    }
  }
  for (const s of model.sections) {
    content.push({ text: s.path.length ? s.path.join(' / ') : 'Notes', style: 'h1', pageBreak: 'before' });
    for (const { note, doc } of s.notes) {
      content.push({ text: noteTitle(note), style: 'h2' });
      content.push({ text: `Last edited ${formatDate(todayISO(new Date(note.updatedAt)))}`, italics: true, color: '#9aa1b5', fontSize: 8.5, margin: [0, 0, 0, 8] });
      content.push(...pdfBlocks(doc.content, ctx));
    }
  }
  const def = {
    info: { title: exportTitle(), creator: 'Taskule' },
    pageSize: 'LETTER',
    pageMargins: [54, 54, 54, 54],
    content,
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: 'center', color: '#9aa1b5', fontSize: 8, margin: [0, 20, 0, 0] }),
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25, color: '#1a1f30' },
    styles: {
      title: { fontSize: 26, bold: true, margin: [0, 0, 0, 4] },
      h1: { fontSize: 18, bold: true, color: '#2a52cc', margin: [0, 8, 0, 8] },
      h2: { fontSize: 14, bold: true, margin: [0, 12, 0, 2] },
      nh1: { fontSize: 13, bold: true, margin: [0, 8, 0, 4] },
      nh2: { fontSize: 12, bold: true, margin: [0, 6, 0, 3] },
      nh3: { fontSize: 11, bold: true, margin: [0, 6, 0, 3] },
    },
  };
  const blob = await pdfMake.createPdf(def).getBlob();
  return { blob, filename: `taskule-${stamp()}.pdf` };
}
