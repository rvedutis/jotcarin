'use strict';
// Writes the Taskule shortcuts with the app's ID (AppUserModelID) so Windows groups a pinned
// taskbar icon and the running window as one button. Run by scripts/package-app.js:
//   electron electron/shortcuts.js <path to Taskule.exe> [--no-new]
// Creates/replaces the Start menu and Desktop shortcuts (unless --no-new) and fixes any
// existing taskbar pin that points at Taskule.exe.
const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'local.taskule.app'; // keep in sync with electron/main.js

app.whenReady().then(() => {
  const exe = process.argv.find((a) => /Taskule\.exe$/i.test(a));
  const makeNew = !process.argv.includes('--no-new');
  if (!exe || !fs.existsSync(exe)) { console.error('Taskule.exe not found'); app.exit(1); return; }
  const opts = {
    target: exe,
    cwd: path.dirname(exe),
    description: 'Taskule notes and to-dos',
    icon: exe,
    iconIndex: 0,
    appUserModelId: APP_ID,
  };
  let failed = false;
  const write = (lnk, operation) => {
    const ok = shell.writeShortcutLink(lnk, operation, opts);
    console.log(`  ${ok ? 'shortcut' : 'FAILED  '}: ${lnk}`);
    if (!ok) failed = true;
  };

  if (makeNew) {
    const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    write(path.join(startMenu, 'Taskule.lnk'), 'create');
    write(path.join(app.getPath('desktop'), 'Taskule.lnk'), 'create');
    // Shortcuts from the app's earlier names (Jotcairn, Actionbase) point at an app that no longer exists.
    for (const old of ['Jotcairn.lnk', 'Actionbase.lnk'].flatMap((n) => [path.join(startMenu, n), path.join(app.getPath('desktop'), n)])) {
      try { if (fs.existsSync(old)) { fs.unlinkSync(old); console.log(`  removed old shortcut: ${old}`); } } catch { /* leave it */ }
    }
  }
  // Existing taskbar pins to Taskule.exe: add the app ID ('update' keeps the pin in place).
  const pinned = path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  try {
    for (const f of fs.readdirSync(pinned)) {
      if (!/\.lnk$/i.test(f)) continue;
      const lnk = path.join(pinned, f);
      try {
        const cur = shell.readShortcutLink(lnk);
        if (path.resolve(cur.target).toLowerCase() === path.resolve(exe).toLowerCase() && cur.appUserModelId !== APP_ID) write(lnk, 'update');
      } catch { /* not a readable shortcut */ }
    }
  } catch { /* no pinned folder */ }
  app.exit(failed ? 1 : 0);
});
