'use strict';
/**
 * Taskule desktop app (Electron).
 *
 * Opens the Taskule web app in its own window. If an Taskule server is already
 * running on the port (for example the one started at Windows login), the window uses
 * it; otherwise the app starts its own server and stops it again when you quit.
 * The password lock lives in the server, so it applies here and in a browser alike.
 */
const { app, BrowserWindow, Menu, Tray, dialog, shell, session, utilityProcess, screen, nativeTheme, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.PORT) || 4747;
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'icon.png');
const TRAY_ICON = path.join(__dirname, 'icon.ico');
// Must match the ID written into the Start menu / Desktop / taskbar shortcuts (electron/shortcuts.js),
// or Windows shows the running window as a separate taskbar button from a pinned shortcut.
const APP_ID = 'local.taskule.app';

app.setName('Taskule');
app.setAppUserModelId(APP_ID);

// The app used to be called Jotcairn, and before that Actionbase. On first launch after a
// rename, carry the newest old profile over (window size, spelling dictionary, settings, and
// the unsaved-edits journal in browser storage). The old folders are left in place.
try {
  const newDir = app.getPath('userData');
  const oldDir = ['Jotcairn', 'Actionbase'].map((n) => path.join(app.getPath('appData'), n)).find((d) => fs.existsSync(d));
  if (!fs.existsSync(newDir) && oldDir) fs.cpSync(oldDir, newDir, { recursive: true });
} catch (err) { console.error('Taskule: could not copy the old app profile:', err.message); }

/** Where your notes live. The packaged app is told the project's data folder at build time. */
function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    if (cfg.dataDir) return cfg.dataDir;
  } catch { /* not packaged by scripts/package-app.js */ }
  return path.join(ROOT, 'data');
}

// ---------------------------------------------------------------- server
let server = null; // the server this app started (null when using one that was already running)
let quitting = false;
let serverRestarts = 0;

/** 'taskule' if Taskule answers on the port, 'other' if something else does, 'none' if nothing. */
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/session', headers: { Host: `localhost:${PORT}` }, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve('unlocked' in JSON.parse(body) ? 'taskule' : 'other'); } catch { resolve('other'); }
      });
    });
    req.on('error', () => resolve('none'));
    req.on('timeout', () => { req.destroy(); resolve('none'); });
  });
}

function startServer() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.createWriteStream(path.join(dir, 'server.log'), { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} started by the Taskule app\n`);
  server = utilityProcess.fork(path.join(ROOT, 'server.js'), [], {
    serviceName: 'Taskule server',
    stdio: 'pipe',
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, NODE_NO_WARNINGS: '1' },
  });
  server.stdout?.pipe(log, { end: false });
  server.stderr?.pipe(log, { end: false });
  server.on('exit', (code) => {
    log.write(`--- server exited (code ${code})\n`);
    server = null;
    if (quitting) return;
    // Keep it alive: the window keeps your edits and retries until the server is back.
    if (serverRestarts++ < 5) setTimeout(() => { if (!quitting) ensureServer().catch(() => {}); }, 1000);
  });
}

/**
 * Watchdog: every few seconds make sure an Taskule server is answering. If none is (the
 * background one was stopped or crashed), start our own — the window shows "editing paused"
 * until it's back, and picks up where it left off.
 */
let healing = false;
function watchServer() {
  setInterval(async () => {
    if (quitting || healing || server) return; // our own server is restarted by its exit handler
    if ((await probe()) !== 'none') return;
    healing = true;
    try {
      serverRestarts = 0;
      await ensureServer();
    } catch (err) {
      console.error('Taskule: could not restart the server:', err.message);
    } finally { healing = false; }
  }, 5000).unref?.();
}

async function ensureServer() {
  let state = await probe();
  if (state === 'taskule') return;
  if (state === 'other') throw new Error(`Port ${PORT} is being used by another program, so Taskule can't start.`);
  startServer();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    state = await probe();
    if (state === 'taskule') return;
  }
  throw new Error(`The Taskule server didn't start. Details are in ${path.join(dataDir(), 'server.log')}.`);
}

// ---------------------------------------------------------------- window state
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // Only reuse the saved position if it is still on a connected screen.
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      s.x < a.x + a.width - 100 && s.x + s.width > a.x + 100 && s.y >= a.y - 10 && s.y < a.y + a.height - 100);
    return visible ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch { return { width: 1280, height: 840 }; }
}
function saveBounds(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* not important */ }
}

// ---------------------------------------------------------------- window
let win = null;

function isAppUrl(url) {
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
}
function openExternal(url) {
  if (/^(https?:|mailto:|tel:)/i.test(url)) shell.openExternal(url);
}

function contextMenu(params) {
  const wc = win.webContents;
  const items = [];
  if (params.misspelledWord) {
    for (const s of params.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    items.push({ type: 'separator' });
  }
  if (params.linkURL && !isAppUrl(params.linkURL)) {
    items.push({ label: 'Open link in browser', click: () => openExternal(params.linkURL) });
    items.push({ label: 'Copy link', click: () => require('electron').clipboard.writeText(params.linkURL) });
    items.push({ type: 'separator' });
  }
  if (params.mediaType === 'image') {
    items.push({ label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) });
    items.push({ type: 'separator' });
  }
  const f = params.editFlags;
  if (params.isEditable) {
    items.push({ label: 'Undo', role: 'undo', enabled: f.canUndo }, { label: 'Redo', role: 'redo', enabled: f.canRedo }, { type: 'separator' });
    items.push({ label: 'Cut', role: 'cut', enabled: f.canCut });
  }
  if (params.isEditable || params.selectionText) items.push({ label: 'Copy', role: 'copy', enabled: f.canCopy });
  if (params.isEditable) {
    items.push({ label: 'Paste', role: 'paste', enabled: f.canPaste });
    items.push({ label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: f.canPaste });
  }
  if (params.isEditable || params.selectionText) items.push({ type: 'separator' }, { label: 'Select all', role: 'selectAll', enabled: f.canSelectAll });
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Taskule',
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#13151c' : '#f5f6fb', // matches the theme until the page draws
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (bounds.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (startHidden) { startHidden = false; return; } // started with Windows: wait in the tray
    win.show();
  });

  const wc = win.webContents;

  // Links: anything outside the app opens in your normal browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) wc.executeJavaScript(`location.href = ${JSON.stringify(url)}`).catch(() => {});
    else openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) { e.preventDefault(); openExternal(url); }
  });

  wc.on('context-menu', (_e, params) => contextMenu(params));

  // Keyboard: zoom, reload, full screen, developer tools (there is no menu bar, so Alt+N stays the app's).
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (mod && (key === '=' || key === '+')) { wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4)); e.preventDefault(); }
    else if (mod && key === '-') { wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)); e.preventDefault(); }
    else if (mod && key === '0') { wc.setZoomLevel(0); e.preventDefault(); }
    else if (key === 'f5' || (mod && key === 'r' && !input.shift && !input.alt)) { wc.reload(); e.preventDefault(); }
    else if (key === 'f11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (key === 'f12' || (mod && input.shift && key === 'i')) { wc.toggleDevTools(); e.preventDefault(); }
  });

  // A reload while saves are still in flight: ask instead of silently refusing.
  wc.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Leave anyway', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'Taskule',
      message: 'Some changes are still saving.',
      detail: 'Unsaved note edits are kept and will be saved the next time Taskule opens.',
    });
    if (choice === 0) e.preventDefault();
  });

  // The X button hides the window to the system tray; the app keeps running.
  // Quitting (tray menu → Quit, Windows sign-out/shutdown) goes through quitApp().
  win.on('close', (e) => {
    saveBounds(win);
    if (quitting) return;
    e.preventDefault();
    wc.executeJavaScript('window.__taskuleFlush && window.__taskuleFlush()').catch(() => {});
    win.hide();
    trayHint();
  });
  // Windows is signing out or shutting down: let the window close instead of hiding.
  win.on('query-session-end', () => { quitting = true; });
  win.on('session-end', () => { quitting = true; });
  win.on('closed', () => { win = null; });

  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'error', buttons: ['Reload', 'Quit'], defaultId: 0, title: 'Taskule',
      message: 'Taskule stopped unexpectedly.', detail: 'Reloading is safe — unsaved note edits are kept.',
    });
    if (choice === 0) wc.reload(); else app.quit();
  });

  win.loadURL(`${ORIGIN}/`);
}

// ---------------------------------------------------------------- quick capture + start with Windows
/**
 * Alt+Win+Space anywhere in Windows brings Taskule forward with the cursor on a fresh line in
 * the Scratchpad. It works whenever Taskule is running (also hidden in the tray), so by default
 * Taskule starts with Windows, quietly in the tray (tray menu → "Start with Windows" to turn off).
 */
const HOTKEY = 'Alt+Super+Space';
const HOTKEY_LABEL = 'Alt+Win+Space';
let startHidden = process.argv.includes('--hidden');
let hotkeyOk = false;
// Only the installed app manages the Windows startup entry (not dev runs or test copies).
const MANAGES_LOGIN = app.isPackaged && !process.env.DATA_DIR && !process.env.TASKULE_NO_LOGIN_ITEM;

function quickCapture() {
  showWindow();
  if (!win) return;
  win.webContents.focus();
  win.webContents.executeJavaScript('window.__taskuleQuickCapture && window.__taskuleQuickCapture()').catch(() => {});
}
function registerHotkey() {
  try { hotkeyOk = globalShortcut.register(HOTKEY, quickCapture); } catch { hotkeyOk = false; }
  if (!hotkeyOk) console.error(`Taskule: ${HOTKEY_LABEL} is already taken by Windows or another app, so quick capture is off.`);
}
const loginArgs = ['--hidden'];
function startsWithWindows() { return MANAGES_LOGIN && app.getLoginItemSettings({ args: loginArgs }).openAtLogin; }
function setStartWithWindows(on) {
  if (!MANAGES_LOGIN) return;
  app.setLoginItemSettings({ openAtLogin: on, args: loginArgs });
  refreshTrayMenu();
}
/** First run of a version with quick capture: start with Windows, so the hotkey is always there. */
function defaultStartWithWindows() {
  if (!MANAGES_LOGIN) return;
  const flag = path.join(app.getPath('userData'), 'start-with-windows-set');
  if (fs.existsSync(flag)) return;
  setStartWithWindows(true);
  try { fs.writeFileSync(flag, new Date().toISOString()); } catch { /* asked again next time; harmless */ }
}

// ---------------------------------------------------------------- tray
let tray = null;

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function lockApp() {
  if (!win) return;
  win.webContents.executeJavaScript('window.__taskuleLock && window.__taskuleLock()').catch(() => {});
  showWindow();
}

/** Quit for real: save everything first; if that can't happen, ask. */
let quitInProgress = false;
async function quitApp() {
  if (quitInProgress) return;
  quitInProgress = true;
  if (win && !win.isDestroyed()) {
    let saved = true;
    try {
      saved = await Promise.race([
        win.webContents.executeJavaScript('window.__taskuleFlush ? window.__taskuleFlush(4000) : true'),
        new Promise((r) => setTimeout(() => r(false), 6000)),
      ]);
    } catch { saved = true; /* page not loaded: nothing to save */ }
    if (!saved && win && !win.isDestroyed()) {
      showWindow();
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Quit anyway', 'Keep running'],
        defaultId: 1,
        cancelId: 1,
        title: 'Taskule',
        message: 'Some changes haven’t saved yet.',
        detail: 'Taskule can’t reach its server right now. Unsaved note edits are kept and will be saved the next time it opens; other recent changes may be lost.',
      });
      if (choice === 1) { quitInProgress = false; return; }
    }
  }
  quitting = true;
  app.quit();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip(hotkeyOk ? `Taskule — ${HOTKEY_LABEL} for the Scratchpad` : 'Taskule');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Taskule', click: showWindow },
    { label: `Quick capture to Scratchpad${hotkeyOk ? `  (${HOTKEY_LABEL})` : ''}`, click: quickCapture },
    { label: 'Lock', click: lockApp },
    { type: 'separator' },
    ...(MANAGES_LOGIN ? [{ label: 'Start with Windows', type: 'checkbox', checked: startsWithWindows(), click: (mi) => setStartWithWindows(mi.checked) }, { type: 'separator' }] : []),
    { label: 'Quit Taskule', click: () => { quitApp(); } },
  ]));
}
function createTray() {
  tray = new Tray(TRAY_ICON);
  refreshTrayMenu();
  tray.on('click', showWindow);
}

/** The first time the window goes to the tray, say where it went. */
function trayHint() {
  const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
  if (fs.existsSync(flag) || !tray) return;
  try { fs.writeFileSync(flag, new Date().toISOString()); } catch { /* show it again next time; harmless */ }
  tray.displayBalloon({
    iconType: 'custom',
    icon: ICON,
    title: 'Taskule is still running',
    content: 'It’s in the system tray. Click the icon to open it, or right-click it to quit.',
  });
}

// For automated tests over --inspect (main process only; web pages can't reach this).
global.__taskule = { showWindow, lockApp, quitApp, quickCapture, get hotkeyOk() { return hotkeyOk; }, get tray() { return tray; }, get win() { return win; } };

// ---------------------------------------------------------------- app lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening Taskule again (shortcut, taskbar, Start menu) brings back the running window.
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    const ses = session.defaultSession;
    // Every time the app opens, it asks for the password again (if one is set).
    await ses.cookies.remove(ORIGIN, 'tk_session').catch(() => {});
    // The app needs no camera, microphone, location, notifications, etc.
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
    ses.setSpellCheckerLanguages(['en-US']);
    // Downloads (Word / Markdown / PDF / backup): ask where to save, starting in Downloads.
    ses.on('will-download', (_e, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });

    try {
      await ensureServer();
    } catch (err) {
      dialog.showErrorBox('Taskule couldn’t start', err.message);
      app.quit();
      return;
    }
    registerHotkey();
    defaultStartWithWindows();
    createTray();
    createWindow();
    watchServer();
    if (!hotkeyOk && !startHidden) tray?.displayBalloon({ iconType: 'warning', title: 'Quick capture is off', content: `${HOTKEY_LABEL} is already used by Windows or another app.` });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (server) server.kill(); });
}
