// Start the Taskule server automatically when you log in to Windows (hidden, no window).
//   npm run autostart:on      install (also starts it now if it isn't running)
//   npm run autostart:off     remove
//   npm run autostart:status  show what's set up
//
// The Startup entry is a shortcut that runs wscript.exe explicitly, so it works even when
// .vbs files are set to open in an editor (as they are on some PCs).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4747;
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(__dirname, 'taskule-server.cmd');
const HIDDEN = path.join(__dirname, 'taskule-server.vbs');

if (process.platform !== 'win32') {
  console.log('Auto-start setup is for Windows. On macOS/Linux, run "npm start" from a login item or service instead.');
  process.exit(1);
}
const STARTUP_DIR = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const STARTUP_LINK = path.join(STARTUP_DIR, 'Taskule server.lnk');
// Startup entries left by older versions: the script itself in Startup, and those from the
// app's earlier names (Jotcairn, Actionbase).
const LEGACY = ['Taskule.vbs', 'Jotcairn server.lnk', 'Jotcairn.vbs', 'Actionbase server.lnk', 'Actionbase.vbs'].map((n) => path.join(STARTUP_DIR, n));
const OLD_FILES = ['jotcairn-server.cmd', 'jotcairn-server.vbs', 'actionbase-server.cmd', 'actionbase-server.vbs'].map((n) => path.join(__dirname, n));
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

/** Is a Taskule server answering? (/api/session answers even while locked.) */
function isRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/session', headers: { Host: `localhost:${PORT}` }, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(res.statusCode === 200 && 'unlocked' in JSON.parse(body)); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'PowerShell failed').trim());
  return r.stdout;
}
const q = (s) => `'${s.replace(/'/g, "''")}'`;

function install() {
  // .cmd: run the server from the project folder, appending output to data\server.log.
  // If it ever stops unexpectedly it's started again (after 60s if another server already
  // has the port, e.g. the desktop app's own). `npm run stop` stops this loop too.
  fs.writeFileSync(LAUNCHER, [
    '@echo off',
    'rem Starts the Taskule server and keeps it running. Used by the Windows Startup entry (npm run autostart:on).',
    `cd /d "${ROOT}"`,
    'if not exist data mkdir data',
    'set /a quick=0',
    ':run',
    `echo --- %DATE% %TIME% starting (auto-start) >> "data\\server.log"`,
    `"${process.execPath}" --disable-warning=ExperimentalWarning server.js >> "data\\server.log" 2>&1`,
    'if %ERRORLEVEL%==3 (',
    '  ping -n 61 127.0.0.1 >nul',
    '  goto run',
    ')',
    'set /a quick+=1',
    `if %quick% GTR 30 (echo --- %DATE% %TIME% stopped restarting after 30 failures >> "data\\server.log" & exit /b 1)`,
    'ping -n 4 127.0.0.1 >nul',
    'goto run',
    '',
  ].join('\r\n'));
  // .vbs: runs the .cmd with no visible window
  fs.writeFileSync(HIDDEN, [
    "' Starts the Taskule server with no window. Created by npm run autostart:on.",
    `CreateObject("WScript.Shell").Run """${LAUNCHER}""", 0, False`,
    '',
  ].join('\r\n'));
  // Startup shortcut: wscript.exe <the .vbs>
  ps([
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(STARTUP_LINK)})`,
    `$s.TargetPath = ${q(WSCRIPT)}`,
    `$s.Arguments = ${q(`"${HIDDEN}"`)}`,
    `$s.WorkingDirectory = ${q(ROOT)}`,
    "$s.Description = 'Starts the Taskule notes server (hidden). Remove with: npm run autostart:off'",
    '$s.Save()',
  ].join('; '));
  for (const f of [...LEGACY, ...OLD_FILES]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

/**
 * Start it now, fully independent of this terminal: ask Windows (WMI) to launch it, so
 * closing this window/session can't take the server down with it.
 */
function startNow() {
  const cmdLine = `"${WSCRIPT}" "${HIDDEN}"`;
  ps(`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(cmdLine)}; CurrentDirectory = ${q(ROOT)} } | Out-Null`);
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'on') {
    install();
    console.log(`Auto-start installed:\n  ${STARTUP_LINK}\n  → runs the server hidden at every login (log: data\\server.log)`);
    if (await isRunning()) {
      console.log(`Taskule is already running on http://localhost:${PORT} — leaving it as is.`);
    } else {
      startNow();
      for (let i = 0; i < 20 && !(await isRunning()); i++) await new Promise((r) => setTimeout(r, 500));
      console.log((await isRunning()) ? `Started: http://localhost:${PORT}` : 'Started the launcher, but the server isn\'t answering yet — check data\\server.log.');
    }
  } else if (cmd === 'off') {
    let had = false;
    for (const f of [STARTUP_LINK, ...LEGACY]) if (fs.existsSync(f)) { fs.unlinkSync(f); had = true; }
    console.log(had ? 'Auto-start removed. (A server that is running now keeps running — use "npm run stop" to stop it.)' : 'Auto-start was not set up.');
  } else {
    const on = fs.existsSync(STARTUP_LINK);
    console.log(`Auto-start: ${on ? `on (${STARTUP_LINK})` : LEGACY.some((f) => fs.existsSync(f)) ? 'old setup — run "npm run autostart:on" to update it' : 'off'}`);
    console.log(`Server:     ${(await isRunning()) ? `running on http://localhost:${PORT}` : 'not running'}`);
  }
}
main().catch((err) => { console.error(err.message); process.exit(1); });
