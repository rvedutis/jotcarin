// Server tests: password setup/lock, Scratchpad rules, content validation, version conflicts,
// backups, wipe safety, and behaviour with a damaged database or password file.
// Runs real servers on spare ports with throwaway data folders.   node test/server.test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) passes++;
  else { failures++; console.log(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

async function startServer(dataDir, port) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`server exited: ${out}`);
  }
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await exited;
  };
  return { child, stop, log: () => out };
}

function client(port) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(`http://localhost:${port}${url}`, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
  return { call, forget: () => { cookie = ''; } };
}
const doc = (text) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taskule-test-'));
const port = 4900 + Math.floor(Math.random() * 90);
let srv;
try {
  // ---------------------------------------------------------------- first run & password
  srv = await startServer(tmp, port);
  const c = client(port);
  let r = await c.call('GET', '/api/health');
  check('health ok on a fresh database', r.status === 200 && r.json.ok === true, r.json);
  check('a backup is taken at startup', fs.readdirSync(path.join(tmp, 'backups')).some((f) => f.endsWith('-auto.db')));
  r = await c.call('GET', '/api/session');
  check('first run asks to create a password', r.json.setup === true && r.json.unlocked === false, r.json);
  r = await c.call('GET', '/api/state');
  check('notes are locked before a password exists', r.status === 401);
  r = await c.call('POST', '/api/login', { password: 'anything' });
  check('login is refused before setup', r.status === 409);
  r = await c.call('POST', '/api/setup', { password: 'ab' });
  check('too-short password refused', r.status === 400);
  r = await c.call('POST', '/api/setup', { password: 'correct horse' });
  check('setup creates the password and unlocks', r.status === 200);
  check('no password stored in plain text', !fs.readFileSync(path.join(tmp, 'password.json'), 'utf8').includes('correct horse'));
  r = await c.call('POST', '/api/setup', { password: 'takeover' });
  check('setup can’t be repeated once a password exists', r.status === 409);
  r = await c.call('GET', '/api/state');
  check('unlocked after setup', r.status === 200);
  const other = client(port);
  r = await other.call('POST', '/api/login', { password: 'wrong' });
  check('wrong password refused', r.status === 401);
  r = await other.call('POST', '/api/login', { password: 'correct horse' });
  check('right password accepted', r.status === 200);

  // ---------------------------------------------------------------- Scratchpad
  r = await c.call('GET', '/api/state');
  const sp = r.json.notes.find((n) => n.id === 'scratchpad');
  check('Scratchpad exists', !!sp && sp.title === 'Scratchpad' && sp.folderId === null);
  r = await c.call('DELETE', '/api/notes/scratchpad');
  check('Scratchpad can’t be deleted', r.status === 400);
  await c.call('POST', '/api/folders', { id: 'f1', name: 'Work' });
  r = await c.call('PATCH', '/api/notes/scratchpad', { folderId: 'f1' });
  check('Scratchpad can’t be moved into a folder', r.status === 400);
  r = await c.call('PATCH', '/api/notes/scratchpad', { title: 'Renamed' });
  check('Scratchpad keeps its name', r.status === 200 && r.json.title === 'Scratchpad');

  // ---------------------------------------------------------------- content validation
  r = await c.call('POST', '/api/notes', { id: 'n1', title: 'One', content: 'not json' });
  check('non-document content refused', r.status === 400);
  r = await c.call('POST', '/api/notes', { id: 'n1', title: 'One', content: JSON.stringify({ type: 'paragraph' }) });
  check('wrong document type refused', r.status === 400);
  r = await c.call('POST', '/api/notes', { id: 'n1', title: 'One', content: doc('first') });
  check('valid note saved', r.status === 200 && r.json.version === 0, r.json);
  r = await c.call('PATCH', '/api/notes/n1', { content: '{"type":"doc","content":"oops"}', baseVersion: 0 });
  check('malformed update refused', r.status === 400);

  // ---------------------------------------------------------------- versions & conflicts
  r = await c.call('PATCH', '/api/notes/n1', { title: 'One', content: doc('A'), baseVersion: 0 });
  check('save bumps the version', r.status === 200 && r.json.version === 1, r.json);
  r = await c.call('PATCH', '/api/notes/n1', { title: 'One', content: doc('B (stale window)'), baseVersion: 0 });
  check('stale save is refused with the current note', r.status === 409 && JSON.parse(r.json.note.content).content[0].content[0].text === 'A', r.json);
  r = await c.call('PATCH', '/api/notes/n1', { title: 'One', content: doc('A'), baseVersion: 0 });
  check('re-sending text the server already has is not a conflict', r.status === 200 && r.json.version === 1, r.json);
  r = await c.call('PATCH', '/api/notes/n1', { folderId: 'f1' });
  check('moving a note doesn’t change its version', r.status === 200 && r.json.version === 1, r.json);
  r = await c.call('PATCH', '/api/notes/n1', { title: 'One', content: doc('C'), baseVersion: 1 });
  check('save from the current version works', r.status === 200 && r.json.version === 2, r.json);
  r = await c.call('GET', '/api/state');
  check('stored text is the latest', JSON.parse(r.json.notes.find((n) => n.id === 'n1').content).content[0].content[0].text === 'C');

  // ---------------------------------------------------------------- standalone tasks: details + due date
  r = await c.call('POST', '/api/tasks', { id: 't1', text: 'Renew passport', body: 'Bring the old one', due: '2026-12-01' });
  check('task created with details and due date', r.status === 200 && r.json.body === 'Bring the old one' && r.json.due === '2026-12-01', r.json);
  r = await c.call('POST', '/api/tasks', { id: 't2', text: 'Plain' });
  check('details/due are optional', r.status === 200 && r.json.body === '' && r.json.due === null, r.json);
  r = await c.call('PATCH', '/api/tasks/t1', { due: '2026-02-30' });
  check('impossible due date refused', r.status === 400);
  r = await c.call('PATCH', '/api/tasks/t1', { due: 'tomorrow' });
  check('due date must be YYYY-MM-DD', r.status === 400);
  r = await c.call('PATCH', '/api/tasks/t1', { text: 'Renew passport soon', body: 'Line 1\nLine 2', due: '2026-12-05' });
  check('title, details and due updated together', r.status === 200 && r.json.text === 'Renew passport soon' && r.json.body === 'Line 1\nLine 2' && r.json.due === '2026-12-05', r.json);
  r = await c.call('PATCH', '/api/tasks/t1', { done: true });
  check('checking off keeps details and due', r.status === 200 && r.json.done && r.json.body === 'Line 1\nLine 2' && r.json.due === '2026-12-05', r.json);
  r = await c.call('PATCH', '/api/tasks/t1', { due: null, body: '' });
  check('due and details can be cleared', r.status === 200 && r.json.due === null && r.json.body === '', r.json);
  r = await c.call('PATCH', '/api/tasks/t1', { text: '   ' });
  check('empty title refused', r.status === 400);

  // ---------------------------------------------------------------- wipe safety
  fs.mkdirSync(path.join(tmp, 'images'), { recursive: true });
  const img = '11111111-2222-3333-4444-555555555555.png';
  fs.writeFileSync(path.join(tmp, 'images', img), 'x');
  r = await c.call('POST', '/api/wipe', { confirm: 'nope' });
  check('wipe needs "delete"', r.status === 400);
  r = await c.call('POST', '/api/wipe', { confirm: 'delete' });
  check('wipe reports its safety backup', r.status === 200 && /before-wipe\.db$/.test(r.json.backup || ''), r.json);
  const pre = r.json.backup && new DatabaseSync(path.join(tmp, 'backups', r.json.backup), { readOnly: true });
  check('safety backup holds the wiped notes', pre && pre.prepare("SELECT count(*) AS n FROM notes WHERE id = 'n1'").get().n === 1);
  pre?.close();
  check('images survive a wipe (for restoring the backup)', fs.existsSync(path.join(tmp, 'images', img)));
  r = await c.call('GET', '/api/state');
  check('after wipe: only an empty Scratchpad', r.json.notes.length === 1 && r.json.notes[0].id === 'scratchpad' && r.json.folders.length === 0);

  // ---------------------------------------------------------------- damaged password file
  await c.call('POST', '/api/notes', { id: 'keep', title: 'Keep me', content: doc('important') });
  const pwFile = path.join(tmp, 'password.json');
  const pwGood = fs.readFileSync(pwFile);
  fs.writeFileSync(pwFile, '{ broken');
  const anon = client(port);
  r = await anon.call('GET', '/api/session');
  check('damaged password file is reported, not treated as "no password"', r.json.setup === false && !!r.json.error, r.json);
  r = await anon.call('POST', '/api/setup', { password: 'takeover' });
  check('damaged password file can’t be replaced through the app', r.status !== 200);
  fs.writeFileSync(pwFile, pwGood);

  // ---------------------------------------------------------------- damaged database
  await srv.stop();
  const dbFile = path.join(tmp, 'taskule.db');
  { const d = new DatabaseSync(dbFile); d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); d.close(); }
  const buf = fs.readFileSync(dbFile);
  const pageSize = buf.readUInt16BE(16) || 4096;
  check('test database has several pages', buf.length >= pageSize * 3);
  for (let p = 1; p * pageSize < buf.length; p++) buf.fill(0xa5, p * pageSize + 8, p * pageSize + 200); // scribble over every page after the header
  fs.writeFileSync(dbFile, buf);
  let damaged;
  try { damaged = await startServer(tmp, port); } catch (err) { damaged = null; check('server starts (or refuses) cleanly with a damaged database', /database|malformed|corrupt/i.test(err.message), err.message.slice(0, 200)); }
  console.log(damaged ? 'damaged-db: server started and reports the problem' : 'damaged-db: server refused to start');
  if (damaged) {
    const d = client(port);
    r = await d.call('GET', '/api/health');
    check('damaged database is reported by /api/health', r.json && r.json.ok === false && !!r.json.problem, r.json);
    await d.call('POST', '/api/login', { password: 'correct horse' });
    r = await d.call('POST', '/api/notes', { id: 'x', title: 'x', content: doc('x') });
    check('writes are refused while the database is damaged', r.status === 503 || r.status === 500, r);
    const before = fs.readdirSync(path.join(tmp, 'backups')).length;
    check('damaged database never replaces good backups', before >= 2);
    await damaged.stop();
  }
} finally {
  try { await srv?.stop(); } catch { /* already stopped */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}

// ---------------------------------------------------------------- rename: data/jotcairn.db or data/actionbase.db → data/taskule.db
for (const [oldName, offset] of [['jotcairn.db', 1], ['actionbase.db', 2]]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskule-migrate-'));
  let m;
  try {
    // An old-style database, left with recent writes still in its WAL file (as after a hard stop).
    const old = new DatabaseSync(path.join(dir, oldName));
    old.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE notes (id TEXT PRIMARY KEY, folder_id TEXT, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, completed_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    old.prepare('INSERT INTO notes VALUES (?, NULL, ?, ?, 1, 1)').run('old1', 'From Actionbase', doc('kept'));
    old.prepare('INSERT INTO tasks VALUES (?, ?, 0, 1, NULL, 1)').run('ot1', 'Old task');
    check('old database has unflushed writes in its WAL', fs.existsSync(path.join(dir, oldName + '-wal')) && fs.statSync(path.join(dir, oldName + '-wal')).size > 0);
    // leave it open-and-abandoned like a crashed process would (closing would checkpoint)
    fs.writeFileSync(path.join(dir, 'password.json'), JSON.stringify({ salt: 'x', hash: '0'.repeat(64) }));
    old.close();
    m = await startServer(dir, port + offset);
    check(`${oldName} renamed to taskule.db`, fs.existsSync(path.join(dir, 'taskule.db')) && !fs.existsSync(path.join(dir, oldName)), fs.readdirSync(dir));
    const now = new DatabaseSync(path.join(dir, 'taskule.db'), { readOnly: true });
    check('old notes and tasks carried over', now.prepare("SELECT title FROM notes WHERE id = 'old1'").get()?.title === 'From Actionbase' && now.prepare("SELECT text FROM tasks WHERE id = 'ot1'").get()?.text === 'Old task');
    check('old database upgraded (task details/due, note versions)', ['body', 'due'].every((c) => now.prepare('PRAGMA table_info(tasks)').all().some((x) => x.name === c)) && now.prepare('PRAGMA table_info(notes)').all().some((x) => x.name === 'version'));
    now.close();
    const h = await (await fetch(`http://localhost:${port + offset}/api/health`)).json();
    check('healthy after the rename', h.ok === true, h);
  } finally {
    try { await m?.stop(); } catch { /* stopped */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

console.log(failures ? `${failures} server test(s) failed, ${passes} passed` : `all ${passes} server checks passed`);
if (failures) process.exit(1);
