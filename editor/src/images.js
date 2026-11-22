// Images: upload pasted/dropped files, and copy external images (e.g. Google Docs'
// googleusercontent links, data: URIs) into local storage so notes never depend on them.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

const MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const isStored = (src) => /^\/images\/[\w.-]+$/.test(src || '');

/** Image files on a clipboard/drag DataTransfer. */
export function imageFilesFrom(dt) {
  if (!dt) return [];
  let files = [...(dt.files || [])];
  if (!files.length && dt.items) {
    files = [...dt.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
  }
  return files.filter((f) => IMAGE_TYPES.test(f.type));
}

async function readError(res) {
  const data = await res.json().catch(() => ({}));
  return data.error || `HTTP ${res.status}`;
}

export async function uploadImage(blob) {
  if (blob.size > MAX_BYTES) throw new Error('That image is larger than 15 MB.');
  const res = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()).url;
}

async function storeExternal(src) {
  if (/^(data|blob):/i.test(src)) return uploadImage(await (await fetch(src)).blob());
  const res = await fetch('/api/images/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: src }) });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()).url;
}

/** Upload image files and insert them (at `pos`, or at the cursor). */
export async function insertImageFiles(editor, files, pos = null, onError = null) {
  for (const file of files) {
    try {
      const src = await uploadImage(file);
      if (editor.isDestroyed) return;
      const node = { type: 'image', attrs: { src, alt: '' } };
      if (pos != null) {
        editor.chain().focus().insertContentAt(pos, node).run();
        pos = null; // further files follow the first one
      } else {
        editor.chain().focus().insertContent(node).run();
      }
    } catch (err) {
      onError?.(`Couldn't add the image: ${err.message}`);
    }
  }
}

// Shared across editor instances so a slow import still completes after switching notes.
const stored = new Map(); // external src -> local url
const inflight = new Map(); // external src -> Promise<local url>
const failed = new Set();

export const ImageLocalizer = Extension.create({
  name: 'imageLocalizer',
  addOptions() { return { onError: null }; },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { onError } = this.options;
    const waiting = new Set();

    const swap = (from, to) => {
      if (editor.isDestroyed) return;
      const { tr } = editor.state;
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === 'image' && n.attrs.src === from) tr.setNodeMarkup(pos, undefined, { ...n.attrs, src: to });
      });
      if (tr.docChanged) editor.view.dispatch(tr.setMeta('addToHistory', false));
    };

    const scan = () => {
      if (editor.isDestroyed) return;
      const external = new Set();
      editor.state.doc.descendants((n) => {
        const src = n.type.name === 'image' ? n.attrs.src : null;
        if (src && !isStored(src) && !failed.has(src)) external.add(src);
      });
      for (const src of external) {
        if (stored.has(src)) { swap(src, stored.get(src)); continue; }
        if (waiting.has(src)) continue;
        waiting.add(src);
        let job = inflight.get(src);
        if (!job) {
          job = storeExternal(src).then((url) => { stored.set(src, url); return url; });
          inflight.set(src, job);
          job.catch(() => {}).finally(() => inflight.delete(src));
        }
        job.then((url) => swap(src, url))
          .catch((err) => {
            if (failed.has(src)) return;
            failed.add(src);
            onError?.(`An image couldn't be saved locally (${err.message}). It still shows for now, but may stop loading — copy that image on its own and paste it.`);
          })
          .finally(() => waiting.delete(src));
      }
    };

    return [new Plugin({
      key: new PluginKey('imageLocalizer'),
      view: () => {
        setTimeout(scan);
        return { update: (view, prev) => { if (!prev.doc.eq(view.state.doc)) scan(); } };
      },
    })];
  },
});
