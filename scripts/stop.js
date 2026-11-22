// Stop the Jotcairn server listening on PORT (default 4747) — useful when it runs hidden.
//   npm run stop
// If it was started by the auto-start launcher (which restarts it if it stops), the launcher
// is stopped too.
'use strict';
const { execSync, spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4747;

function pidsOnPort() {
  if (process.platform === 'win32') {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    return [...new Set(out.split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c[0] === 'TCP' && /:(\d+)$/.exec(c[1])?.[1] === String(PORT) && c[3] === 'LISTENING')
      .map((c) => Number(c[4])))];
  }
  try { return execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; }
}

/** The auto-start launcher (cmd.exe running jotcairn-server.cmd) that owns this process, if any. */
function launcherOf(pid) {
  const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $q = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; if ($q -and $q.CommandLine -match '(jotcairn|actionbase)-server\\.cmd') { $q.ProcessId } }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  const n = Number((r.stdout || '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

const pids = pidsOnPort();
if (!pids.length) {
  console.log(`Nothing is running on port ${PORT}.`);
} else {
  for (const pid of pids) {
    // SQLite (WAL mode) is safe to stop at any point; the app keeps unsaved edits until it's back.
    if (process.platform === 'win32') {
      const launcher = launcherOf(pid);
      // /T stops the launcher and the server together, so it isn't restarted.
      execSync(`taskkill /PID ${launcher || pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    console.log(`Stopped Jotcairn (process ${pid}) on port ${PORT}.`);
  }
}
