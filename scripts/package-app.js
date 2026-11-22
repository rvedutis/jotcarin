// Build the Windows desktop app (dist\Jotcairn-win32-x64\Jotcairn.exe) and add
// Start menu + Desktop shortcuts to it.
//   npm run app:build                 build + shortcuts
//   npm run app:build -- --no-shortcuts
// The app keeps using this folder's data\ — the same notes as the browser version.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const APP_DIR = path.join(OUT, 'Jotcairn-win32-x64');
const EXE = path.join(APP_DIR, 'Jotcairn.exe');
const CONFIG = path.join(ROOT, 'electron', 'config.json');

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'PowerShell failed').trim());
  return r.stdout.trim();
}

function appIsRunning() {
  try { return /Jotcairn\.exe/i.test(ps(`Get-Process -Name Jotcairn -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }`)); } catch { return false; }
}

/** Make dest match src: overwrite files in place, add new ones, remove ones that are gone. */
function syncInto(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const want = new Set(fs.readdirSync(src));
  for (const name of fs.readdirSync(dest)) {
    if (!want.has(name)) fs.rmSync(path.join(dest, name), { recursive: true, force: true });
  }
  for (const name of want) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) {
      if (fs.existsSync(d) && !fs.statSync(d).isDirectory()) fs.rmSync(d, { force: true });
      syncInto(s, d);
    } else {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) fs.rmSync(d, { recursive: true, force: true });
      fs.copyFileSync(s, d); // overwrites the existing file rather than deleting it
    }
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This builds the Windows app; run it on Windows.');
  if (appIsRunning()) throw new Error('Jotcairn is running. Quit it (right-click its tray icon → Quit Jotcairn), then run this again.');
  const pkg = require(path.join(ROOT, 'package.json'));

  // Tell the packaged app where the notes live (this folder's data\).
  fs.writeFileSync(CONFIG, JSON.stringify({ dataDir: path.join(ROOT, 'data') }, null, 2) + '\n');

  const { packager } = require('@electron/packager');
  console.log('Building Jotcairn.exe …');
  // Build into a staging folder, then update the app folder in place: deleting Jotcairn.exe
  // (as a plain rebuild would) makes Windows drop your taskbar pin.
  const STAGING = path.join(OUT, '.staging');
  fs.rmSync(STAGING, { recursive: true, force: true });
  await packager({
    dir: ROOT,
    out: STAGING,
    name: 'Jotcairn',
    executableName: 'Jotcairn',
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: false,
    prune: true,
    icon: path.join(ROOT, 'electron', 'icon.ico'),
    appVersion: pkg.version,
    appCopyright: '',
    win32metadata: { CompanyName: 'Jotcairn', FileDescription: 'Jotcairn', ProductName: 'Jotcairn', InternalName: 'Jotcairn' },
    ignore: [
      /^\/data(\/|$)/, /^\/dist(\/|$)/, /^\/editor(\/|$)/, /^\/test(\/|$)/, /^\/\.claude(\/|$)/,
      /^\/scripts\/jotcairn-server\.cmd$/, /^\/electron\/(make-icon|shortcuts)\.js$/, /^\/README\.md$/, /^\/\.gitignore$/,
    ],
  });
  syncInto(path.join(STAGING, 'Jotcairn-win32-x64'), APP_DIR);
  fs.rmSync(STAGING, { recursive: true, force: true });
  // The build from before the app was renamed (Actionbase) is no longer used.
  const oldBuild = path.join(OUT, 'Actionbase-win32-x64');
  if (fs.existsSync(oldBuild)) { fs.rmSync(oldBuild, { recursive: true, force: true }); console.log('Removed the old Actionbase build.'); }
  console.log(`Built: ${EXE}`);

  // Shortcuts are written by Electron so they carry the app's ID (see electron/shortcuts.js).
  // A taskbar pin to Jotcairn.exe is always fixed up, even with --no-shortcuts.
  const noNew = process.argv.includes('--no-shortcuts');
  const electronExe = require('electron'); // path to the dev Electron binary
  const r = spawnSync(electronExe, [path.join(ROOT, 'electron', 'shortcuts.js'), EXE, ...(noNew ? ['--no-new'] : [])], { encoding: 'utf8', windowsHide: true });
  process.stdout.write((r.stdout || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => `${l}\n`).join(''));
  if (r.status !== 0) throw new Error(`Couldn't write the shortcuts: ${(r.stderr || '').trim()}`);
  console.log(noNew ? `\nDone. Run ${EXE}` : '\nDone. Open Jotcairn from the Start menu, Desktop or taskbar.');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
