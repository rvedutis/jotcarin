'use strict';
// Renders the Taskule icon (blue→purple tile with a check mark) to icon.png and icon.ico.
//   npx electron electron/make-icon.js
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3563e9"/><stop offset="1" stop-color="#7a4fe0"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <path d="M74 132l36 36 74-78" fill="none" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/** ICO file holding PNG images (supported by Windows Vista and later). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  if (img.getSize().width !== 256) img = img.resize({ width: 256, height: 256, quality: 'best' });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((size) => ({ size, data: (size === 256 ? img : img.resize({ width: size, height: size, quality: 'best' })).toPNG() }));
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico(pngs));
  console.log('Wrote electron/icon.png and electron/icon.ico');
  app.quit();
});
