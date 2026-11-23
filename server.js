'use strict';
/**
 * Taskule — local notes + to-dos server.
 * Zero dependencies: Node's built-in http + node:sqlite (Node >= 22.13).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 20 * 1024 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;
const IMAGES_DIR = path.join(DATA_DIR, 'images');

// ---------------------------------------------------------------- password
// Taskule is open (no password) until you set one in Settings. With a password set, it's locked
// until you enter it; unlocking sets a session cookie, so you're asked again each time you reopen
// the app or browser. The password is stored hashed (scrypt) in data/password.json.
const PASSWORD_FILE = path.join(DATA_DIR, 'password.json');
const SESSION_COOKIE = 'tk_session';
const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000; // a session is also refused after 30 days

/** The stored password hash; null when no password is set (open). Throws if the file is unreadable. */
function passwordRecord() {
  let raw;
  try { raw = fs.readFileSync(PASSWORD_FILE, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new HttpError(500, 'Can’t read the password file');
  }
  let rec;
  try { rec = JSON.parse(raw); } catch { rec = null; }
  // A damaged password file must never fall back to "no password" (that would unlock everything).
  if (!rec || typeof rec.salt !== 'string' || !/^[0-9a-f]{64}$/.test(rec.hash)) {
    throw new HttpError(500, 'The password file is damaged. Delete data/password.json to open Taskule, then set a new password in Settings.');
  }
  return rec;
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function writePasswordFile(rec) {
  const tmp = `${PASSWORD_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, PASSWORD_FILE); // atomic: never a half-written password file
}
function passwordMatches(pw) {
  if (typeof pw !== 'string' || pw.length > 1000) return false;
  const rec = passwordRecord();
  if (!rec) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, rec.salt, 32), Buffer.from(rec.hash, 'hex'));
}
/** An earlier version could use a date-based password. That option is gone: it's retired once, which leaves Taskule open until a password is set in Settings. */
function retireOldPasswordMode() {
  try {
    const rec = JSON.parse(fs.readFileSync(PASSWORD_FILE, 'utf8'));
    if (rec && rec.mode === 'date') {
      fs.unlinkSync(PASSWORD_FILE);
      console.log(`[${new Date().toISOString()}] The date-based password option was removed; Taskule is open until a password is set in Settings.`);
    }
  } catch { /* no file, or a normal/damaged one: left as is */ }
}

/** Signing key for session cookies. Kept on disk so a server restart doesn't lock you out mid-edit. */
function sessionKey() {
  const file = path.join(DATA_DIR, 'session.key');
  try {
    const k = fs.readFileSync(file);
    if (k.length >= 32) return k;
  } catch { /* create below */ }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, k, { mode: 0o600 });
  return k;
}
let SESSION_KEY; // loaded after DATA_DIR exists

function signSession(issued) {
  // Changing the password invalidates every existing session (the hash is part of the signature).
  const rec = passwordRecord();
  if (!rec) return null;
  return crypto.createHmac('sha256', SESSION_KEY).update(`${issued}.${rec.hash}`).digest('base64url');
}
function newSessionToken() {
  const issued = Date.now();
  return `${issued}.${signSession(issued)}`;
}
/** May this request see your notes? Always, when no password is set; otherwise it needs a valid session cookie. */
function sessionValid(req) {
  if (passwordRecord() === null) return true; // open: no password set
  const m = /(?:^|;\s*)tk_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [issuedStr, sig] = m[1].split('.');
  const issued = Number(issuedStr);
  if (!Number.isFinite(issued) || !sig || Date.now() - issued > SESSION_MAX_AGE || issued > Date.now() + 60000) return false;
  const expected = signSession(issued);
  if (!expected) return false;
  const want = Buffer.from(expected);
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function sessionCookie(value, maxAge) {
  // No Max-Age/Expires on login: a session cookie, gone when the app or browser closes.
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${maxAge === 0 ? '; Max-Age=0' : ''}`;
}

// ---------------------------------------------------------------- database
/**
 * The app used to be called Jotcairn (data/jotcairn.db), and before that Actionbase
 * (data/actionbase.db). On the first start after a rename, fold any pending writes into the
 * old file (WAL checkpoint), close it, and rename it to taskule.db. Nothing is copied or
 * rewritten, so nothing can be lost; if any step fails the server stops with a clear message
 * and the old file is left exactly as it was.
 */
const OLD_DB_NAMES = ['jotcairn.db', 'actionbase.db']; // newest first
function migrateOldDatabaseName() {
  if (fs.existsSync(DB_FILE)) return;
  const oldName = OLD_DB_NAMES.find((n) => fs.existsSync(path.join(DATA_DIR, n)));
  if (!oldName) return;
  const oldFile = path.join(DATA_DIR, oldName);
  try {
    const old = new DatabaseSync(oldFile);
    old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    old.close();
    for (const ext of ['-wal', '-shm']) {
      const side = oldFile + ext;
      if (fs.existsSync(side) && fs.statSync(side).size === 0) fs.unlinkSync(side);
    }
    if (fs.existsSync(oldFile + '-wal')) throw new Error('its write-ahead log could not be folded in');
    fs.renameSync(oldFile, DB_FILE);
    console.log(`[${new Date().toISOString()}] Renamed data/${oldName} to data/taskule.db (app renamed to Taskule).`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Couldn't rename data/${oldName} to data/taskule.db: ${err.message}. Nothing was changed. Close anything using the database and start again.`);
    process.exit(1);
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });
SESSION_KEY = sessionKey();
retireOldPasswordMode();
const DB_FILE = path.join(DATA_DIR, 'taskule.db');
migrateOldDatabaseName();
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;  -- every saved change is on disk before we say "saved" (survives power loss)
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    folder_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    done         INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
  CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);
`);
// Schema upgrades (each adds a column once). If the file is damaged these can fail; the
// integrity check below then reports it instead of the server refusing to start.
function addColumn(table, col, def) {
  try {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  } catch (err) { console.error(`[${new Date().toISOString()}] Couldn't upgrade ${table}.${col}: ${err.message}`); }
}
addColumn('tasks', 'body', "TEXT NOT NULL DEFAULT ''"); // standalone task details
addColumn('tasks', 'due', 'TEXT');                       // standalone task due date (YYYY-MM-DD)
addColumn('notes', 'version', 'INTEGER NOT NULL DEFAULT 0'); // bumped on every text change, so a stale window can't overwrite newer text
addColumn('folders', 'position', 'REAL'); // your own order in the sidebar (null = after ordered ones, by name)
addColumn('notes', 'position', 'REAL');

// ---------------------------------------------------------------- database health
// quick_check reads the whole file and verifies its structure. If it ever fails, the server
// stops accepting changes (so a damaged file isn't made worse) and the app says so loudly.
const dbHealth = { ok: true, problem: null, checkedAt: 0 };
function checkDatabase() {
  try {
    const rows = db.prepare('PRAGMA quick_check').all();
    const result = rows.map((r) => Object.values(r)[0]).join('; ');
    dbHealth.ok = result === 'ok';
    dbHealth.problem = dbHealth.ok ? null : `Integrity check failed: ${result.slice(0, 300)}`;
  } catch (err) {
    dbHealth.ok = false;
    dbHealth.problem = `Integrity check couldn't run: ${err.message}`;
  }
  dbHealth.checkedAt = Date.now();
  if (!dbHealth.ok) console.error(`[${new Date().toISOString()}] DATABASE PROBLEM — saving is disabled. ${dbHealth.problem}`);
  return dbHealth.ok;
}
checkDatabase();
setInterval(checkDatabase, 6 * 3600 * 1000).unref();

function healthReport() {
  let ok = dbHealth.ok;
  let problem = dbHealth.problem;
  if (ok) {
    try {
      db.prepare('SELECT 1').get();
      if (!fs.existsSync(DB_FILE)) { ok = false; problem = 'The database file is missing from the data folder.'; }
    } catch (err) { ok = false; problem = `The database isn't responding: ${err.message}`; }
  }
  return { ok, db: ok ? 'ok' : 'problem', problem, lastBackupAt: backups.lastAt, backupProblem: backups.problem };
}
function requireHealthyDb() {
  if (!dbHealth.ok) throw new HttpError(503, `Saving is disabled: ${dbHealth.problem}`);
}

// ---------------------------------------------------------------- automatic backups
// A verified copy of the database is kept in data/backups: at startup (if the newest is older
// than 12 hours), once a day while running, and always right before a wipe. The newest 20 are kept.
const backups = { lastAt: null, problem: null };
const BACKUP_KEEP = 20;
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^(taskule|jotcairn|actionbase)-.*\.db$/.test(f)) // (backups made under the app's earlier names count too)
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  } catch { return []; }
}
/** Snapshot the database to data/backups and check the copy opens and is intact. Returns its path. */
function backupNow(reason = 'auto') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `taskule-${stamp()}-${reason}.db`);
  try {
    db.prepare('VACUUM INTO ?').run(file);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const res = copy.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]).join('; ');
      if (res !== 'ok') throw new Error(`backup failed its integrity check (${res.slice(0, 200)})`);
    } finally { copy.close(); }
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
    backups.problem = `Automatic backup failed: ${err.message}`;
    console.error(`[${new Date().toISOString()}] ${backups.problem}`);
    throw err;
  }
  backups.lastAt = Date.now();
  backups.problem = null;
  for (const old of listBackups().slice(BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.f)); } catch { /* try again next time */ }
  }
  return file;
}
function backupIfDue(maxAgeMs) {
  const newest = listBackups()[0];
  backups.lastAt = newest ? newest.t : null;
  if (!dbHealth.ok) return; // never let a damaged database push good backups out
  if (newest && Date.now() - newest.t < maxAgeMs) return;
  try { backupNow('auto'); } catch { /* recorded in backups.problem and shown in the app */ }
}

function tx(fn) {
  requireHealthyDb(); // never write to a database that failed its integrity check
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

const q = {
  allFolders: db.prepare('SELECT * FROM folders'),
  allNotes: db.prepare('SELECT * FROM notes'),
  allTasks: db.prepare('SELECT * FROM tasks'),
  getFolder: db.prepare('SELECT * FROM folders WHERE id = ?'),
  getNote: db.prepare('SELECT * FROM notes WHERE id = ?'),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  insFolder: db.prepare(`INSERT INTO folders (id, parent_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`),
  insNote: db.prepare(`INSERT INTO notes (id, folder_id, title, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`),
  insTask: db.prepare(`INSERT INTO tasks (id, text, done, created_at, completed_at, updated_at, body, due)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`),
  updFolder: db.prepare('UPDATE folders SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?'),
  updNote: db.prepare('UPDATE notes SET folder_id = ?, title = ?, content = ?, updated_at = ?, version = ? WHERE id = ?'),
  updTask: db.prepare('UPDATE tasks SET text = ?, done = ?, completed_at = ?, updated_at = ?, body = ?, due = ? WHERE id = ?'),
  delFolder: db.prepare('DELETE FROM folders WHERE id = ?'),
  delNote: db.prepare('DELETE FROM notes WHERE id = ?'),
  delTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  setFolderPos: db.prepare('UPDATE folders SET position = ? WHERE id = ?'),
  setNotePos: db.prepare('UPDATE notes SET position = ? WHERE id = ?'),
  isDescendant: db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM folders WHERE id = ?
      UNION ALL
      SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
    ) SELECT 1 AS hit FROM sub WHERE id = ? LIMIT 1`),
};

// The Scratchpad: one permanent note pinned above the folders, for quick capture in meetings.
// It always exists, can't be deleted, moved into a folder or renamed.
const SCRATCHPAD_ID = 'scratchpad';
const SCRATCHPAD_TITLE = 'Scratchpad';
function ensureScratchpad() {
  const now = Date.now();
  q.insNote.run(SCRATCHPAD_ID, null, SCRATCHPAD_TITLE, '', now, now);
}
if (dbHealth.ok) ensureScratchpad();
backupIfDue(12 * 3600 * 1000);
setInterval(() => backupIfDue(24 * 3600 * 1000), 3600 * 1000).unref();

const toFolder = (r) => r && ({ id: r.id, parentId: r.parent_id, name: r.name, position: r.position ?? null, createdAt: r.created_at, updatedAt: r.updated_at });
const toNote = (r) => r && ({ id: r.id, folderId: r.folder_id, title: r.title, content: r.content, position: r.position ?? null, createdAt: r.created_at, updatedAt: r.updated_at, version: r.version || 0 });
const toTask = (r) => r && ({ id: r.id, text: r.text, body: r.body || '', due: r.due || null, done: !!r.done, createdAt: r.created_at, completedAt: r.completed_at, updatedAt: r.updated_at });

// ---------------------------------------------------------------- validation
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function id(v, field = 'id') {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new HttpError(400, `Invalid ${field}`);
  return v;
}
function optId(v, field) { return v === null || v === undefined ? null : id(v, field); }
function str(v, field, max, { allowEmpty = true } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  if (!allowEmpty && !v.trim()) throw new HttpError(400, `${field} cannot be empty`);
  return v;
}
/** Note content must be an editor document (JSON) — never store something the app can't open. */
function noteContent(v) {
  const content = str(v, 'content', 10_000_000);
  if (content === '') return content;
  let doc;
  try { doc = JSON.parse(content); } catch { throw new HttpError(400, 'Note content isn’t a valid document'); }
  if (!doc || doc.type !== 'doc' || (doc.content !== undefined && !Array.isArray(doc.content))) {
    throw new HttpError(400, 'Note content isn’t a valid document');
  }
  return content;
}
/** A due date: null to clear, or a real calendar date as YYYY-MM-DD. */
function dueDate(v) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new HttpError(400, 'That due date doesn’t exist');
  return v;
}
/** A sidebar position: null (unordered) or a finite number. */
function position(v) {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, 'position must be a number or null');
  return v;
}
function ts(v, fallback) { return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback; }
function requireFolder(fid) {
  if (fid !== null && !q.getFolder.get(fid)) throw new HttpError(404, 'Folder not found');
}

// ---------------------------------------------------------------- handlers
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/state$/, () => ({
  folders: q.allFolders.all().map(toFolder),
  notes: q.allNotes.all().map(toNote),
  tasks: q.allTasks.all().map(toTask),
}));

// folders
route('POST', /^\/api\/folders$/, (_, b) => tx(() => {
  const fid = id(b.id);
  const parentId = optId(b.parentId, 'parentId');
  const name = str(b.name, 'name', 200, { allowEmpty: false }).trim();
  requireFolder(parentId);
  const now = Date.now();
  q.insFolder.run(fid, parentId, name, ts(b.createdAt, now), now);
  return toFolder(q.getFolder.get(fid));
}));

route('PATCH', /^\/api\/folders\/([^/]+)$/, ([fid], b) => tx(() => {
  id(fid);
  const cur = q.getFolder.get(fid);
  if (!cur) throw new HttpError(404, 'Folder not found');
  const name = b.name !== undefined ? str(b.name, 'name', 200, { allowEmpty: false }).trim() : cur.name;
  let parentId = cur.parent_id;
  if (b.parentId !== undefined) {
    parentId = optId(b.parentId, 'parentId');
    requireFolder(parentId);
    if (parentId !== null && q.isDescendant.get(fid, parentId)) {
      throw new HttpError(409, 'A folder cannot be moved into itself');
    }
  }
  q.updFolder.run(parentId, name, Date.now(), fid);
  if (b.position !== undefined) q.setFolderPos.run(position(b.position), fid);
  return toFolder(q.getFolder.get(fid));
}));

route('DELETE', /^\/api\/folders\/([^/]+)$/, ([fid]) => tx(() => {
  q.delFolder.run(id(fid)); // cascades to subfolders + notes
  return { ok: true };
}));

// notes
route('POST', /^\/api\/notes$/, (_, b) => tx(() => {
  const nid = id(b.id);
  const folderId = optId(b.folderId, 'folderId');
  const title = b.title === undefined ? '' : str(b.title, 'title', 500);
  const content = b.content === undefined ? '' : noteContent(b.content);
  requireFolder(folderId);
  const now = Date.now();
  q.insNote.run(nid, folderId, title, content, ts(b.createdAt, now), now);
  return toNote(q.getNote.get(nid));
}));

route('PATCH', /^\/api\/notes\/([^/]+)$/, ([nid], b) => tx(() => {
  id(nid);
  const cur = q.getNote.get(nid);
  if (!cur) throw new HttpError(404, 'Note not found');
  let title = b.title !== undefined ? str(b.title, 'title', 500) : cur.title;
  const content = b.content !== undefined ? noteContent(b.content) : cur.content;
  let folderId = cur.folder_id;
  if (nid === SCRATCHPAD_ID) {
    if (b.folderId !== undefined && b.folderId !== null) throw new HttpError(400, 'The Scratchpad can’t be moved into a folder');
    title = SCRATCHPAD_TITLE;
  } else if (b.folderId !== undefined) {
    folderId = optId(b.folderId, 'folderId');
    requireFolder(folderId);
  }
  const version = cur.version || 0;
  const textChanged = title !== cur.title || content !== cur.content;
  // Someone else (another window or tab) saved different text since this copy was loaded:
  // refuse rather than silently overwrite it — the app then keeps both versions.
  // (Re-sending text the server already has, e.g. a retry after a lost reply, is not a conflict.)
  if (textChanged && Number.isInteger(b.baseVersion) && b.baseVersion !== version) {
    throw new HttpError(409, 'This note was changed somewhere else', { note: toNote(cur) });
  }
  // Only a change to the title or text counts as an edit (moving or reordering doesn't).
  q.updNote.run(folderId, title, content, textChanged ? Date.now() : cur.updated_at, textChanged ? version + 1 : version, nid);
  if (b.position !== undefined) q.setNotePos.run(position(b.position), nid);
  const row = toNote(q.getNote.get(nid));
  delete row.content; // client already has it; keep responses small
  return row;
}));

route('DELETE', /^\/api\/notes\/([^/]+)$/, ([nid]) => tx(() => {
  if (id(nid) === SCRATCHPAD_ID) throw new HttpError(400, 'The Scratchpad can’t be deleted');
  q.delNote.run(nid);
  return { ok: true };
}));

// standalone tasks
route('POST', /^\/api\/tasks$/, (_, b) => tx(() => {
  const tid = id(b.id);
  const text = str(b.text, 'text', 2000, { allowEmpty: false }).trim();
  const body = b.body === undefined ? '' : str(b.body, 'body', 100_000);
  const due = b.due === undefined ? null : dueDate(b.due);
  const done = !!b.done;
  const now = Date.now();
  q.insTask.run(tid, text, done ? 1 : 0, ts(b.createdAt, now), done ? ts(b.completedAt, now) : null, now, body, due);
  return toTask(q.getTask.get(tid));
}));

route('PATCH', /^\/api\/tasks\/([^/]+)$/, ([tid], b) => tx(() => {
  id(tid);
  const cur = q.getTask.get(tid);
  if (!cur) throw new HttpError(404, 'Task not found');
  const text = b.text !== undefined ? str(b.text, 'text', 2000, { allowEmpty: false }).trim() : cur.text;
  const body = b.body !== undefined ? str(b.body, 'body', 100_000) : cur.body || '';
  const due = b.due !== undefined ? dueDate(b.due) : cur.due || null;
  let done = !!cur.done;
  let completedAt = cur.completed_at;
  if (b.done !== undefined) {
    const next = !!b.done;
    if (next !== done) completedAt = next ? Date.now() : null;
    done = next;
  }
  q.updTask.run(text, done ? 1 : 0, completedAt, Date.now(), body, due, tid);
  return toTask(q.getTask.get(tid));
}));

route('DELETE', /^\/api\/tasks\/([^/]+)$/, ([tid]) => tx(() => {
  q.delTask.run(id(tid));
  return { ok: true };
}));

// wipe everything
route('POST', /^\/api\/wipe$/, (_, b) => {
  if (typeof b.confirm !== 'string' || b.confirm.trim().toLowerCase() !== 'delete') {
    throw new HttpError(400, 'Type "delete" to confirm');
  }
  requireHealthyDb();
  // Always keep a copy of what's about to be wiped. No backup, no wipe.
  let saved;
  try { saved = backupNow('before-wipe'); } catch (err) {
    throw new HttpError(500, `Couldn’t make a safety backup first, so nothing was deleted (${err.message})`);
  }
  tx(() => {
    db.exec('DELETE FROM notes; DELETE FROM tasks; DELETE FROM folders;');
    ensureScratchpad(); // starts again, empty
  });
  try { db.exec('VACUUM'); } catch { /* best effort */ }
  // Image files stay for now (unused ones are cleaned up after 30 days), so the safety
  // backup can be restored with its pictures.
  return { ok: true, backup: path.basename(saved) };
});

// ---------------------------------------------------------------- images
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const IMAGE_FILE_RE = /^[a-f0-9-]{36}\.(png|jpg|gif|webp|avif|bmp)$/;

/** Identify an image by its bytes (never trust the declared type; SVG is deliberately not accepted). */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (head.slice(4, 12) === 'ftypavif' || head.slice(4, 12) === 'ftypavis') return 'avif';
  if (head.startsWith('BM')) return 'bmp';
  return null;
}

function saveImage(buf) {
  const ext = sniffImage(buf);
  if (!ext) throw new HttpError(415, 'That file isn’t a supported image (PNG, JPEG, GIF, WebP, AVIF or BMP).');
  const name = `${crypto.randomUUID()}.${ext}`;
  const tmp = path.join(IMAGES_DIR, `.${name}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(IMAGES_DIR, name));
  return { url: `/images/${name}` };
}

/** Block requests to this machine / the local network (a pasted page could point anywhere). */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function downloadImage(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new HttpError(400, 'Invalid image address'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Only http(s) images can be imported');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new HttpError(502, 'Couldn’t reach the image host');
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, 'Images on local network addresses can’t be imported');
    let res;
    try {
      res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Taskule/1.0 (local notes app)', Accept: 'image/*' } });
    } catch { throw new HttpError(502, 'Couldn’t download the image'); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    if (!res.ok) throw new HttpError(502, `The image host refused (HTTP ${res.status}) — it may need you to be signed in`);
    if (Number(res.headers.get('content-length')) > MAX_IMAGE) throw new HttpError(413, 'Image is larger than 15 MB');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_IMAGE) throw new HttpError(413, 'Image is larger than 15 MB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new HttpError(502, 'Too many redirects');
}

route('POST', /^\/api\/images\/import$/, async (_, b) => {
  const url = str(b.url, 'url', 20000);
  return saveImage(await downloadImage(url));
});

// ---------------------------------------------------------------- backup (.zip: database snapshot + images)
const zlib = require('node:zlib');

/** Minimal ZIP writer (deflate for compressible data, store for images). */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data, store } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const body = store ? data : zlib.deflateRawSync(data, { level: 6 });
    const method = store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function createBackup() {
  const tmp = path.join(DATA_DIR, `.backup-${crypto.randomUUID()}.db`);
  try {
    // A consistent, compacted copy of the live database (safe while the app is running).
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const entries = [{ name: 'taskule.db', data: fs.readFileSync(tmp) }];
    for (const f of fs.readdirSync(IMAGES_DIR)) {
      if (IMAGE_FILE_RE.test(f)) entries.push({ name: `images/${f}`, data: fs.readFileSync(path.join(IMAGES_DIR, f)), store: true });
    }
    const counts = db.prepare('SELECT (SELECT COUNT(*) FROM notes) n, (SELECT COUNT(*) FROM folders) f, (SELECT COUNT(*) FROM tasks) t').get();
    entries.push({
      name: 'RESTORE.txt',
      data: Buffer.from([
        `Taskule backup — ${new Date().toString()}`,
        [[counts.n, 'note'], [counts.f, 'folder'], [counts.t, 'standalone task'], [entries.length - 1, 'image']].map(([k, w]) => `${k} ${w}${k === 1 ? '' : 's'}`).join(', ') + '.',
        '',
        'To restore:',
        '  1. Stop Taskule (Ctrl+C in its terminal).',
        '  2. In the Taskule folder, rename the existing "data" folder (e.g. to "data-old").',
        '  3. Create a new "data" folder and copy taskule.db and the images folder from this zip into it.',
        '  4. Start Taskule again (npm start).',
        '',
      ].join('\r\n')),
    });
    return buildZip(entries);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Remove image files no note refers to any more (kept for a week, so undo/deleted notes have a grace period). */
/**
 * Delete image files no note has used for 30 days in a row. The clock starts when an image is
 * first seen unused (tracked in images/.unused.json), so undo, a restored backup, or the
 * pre-wipe backup still finds its pictures for a month.
 */
const UNUSED_IMAGE_DAYS = 30;
function collectUnusedImages() {
  if (!dbHealth.ok) return; // a damaged database could make every image look unused
  try {
    const used = new Set();
    for (const { content } of db.prepare('SELECT content FROM notes').all()) {
      for (const m of content.matchAll(/\/images\/([a-f0-9-]{36}\.[a-z]+)/g)) used.add(m[1]);
    }
    const ledgerFile = path.join(IMAGES_DIR, '.unused.json');
    let ledger = {};
    try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) || {}; } catch { /* start fresh */ }
    const now = Date.now();
    const next = {};
    for (const f of fs.readdirSync(IMAGES_DIR)) {
      if (!IMAGE_FILE_RE.test(f) || used.has(f)) continue;
      const since = Number(ledger[f]) || now;
      if (now - since > UNUSED_IMAGE_DAYS * 86400000) {
        try { fs.unlinkSync(path.join(IMAGES_DIR, f)); } catch { next[f] = since; }
      } else {
        next[f] = since;
      }
    }
    fs.writeFileSync(ledgerFile, JSON.stringify(next));
  } catch (err) { console.warn('image cleanup skipped:', err.message); }
}
collectUnusedImages();
setInterval(collectUnusedImages, 24 * 3600000).unref();

// ---------------------------------------------------------------- http plumbing
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, { raw = false, limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { const buf = Buffer.concat(chunks); resolve(raw ? buf : buf.toString('utf8')); });
    req.on('error', reject);
  });
}

const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

async function handleApi(req, res, pathname) {
  // Defend the local API against other websites in your browser (CSRF / DNS rebinding).
  if (LOOPBACK && !LOCAL_HOST_RE.test(req.headers.host || '')) throw new HttpError(403, 'Forbidden host');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin request blocked');

  // Health check (no password needed; says nothing about your notes). The app polls it so it
  // can stop you typing into something that can't save.
  if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, healthReport());

  // Lock screen: the only API calls allowed before you've entered the password.
  if (pathname === '/api/session' && req.method === 'GET') {
    let open;
    try { open = passwordRecord() === null; } catch (err) { return sendJson(res, 200, { unlocked: false, open: false, error: err.message }); }
    return sendJson(res, 200, { unlocked: open || sessionValid(req), open });
  }
  const readJson = async () => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON');
    try { return JSON.parse(await readBody(req, { limit: 10000 })) || {}; } catch { throw new HttpError(400, 'Malformed JSON'); }
  };
  const ok = (extra = {}, cookie) => send(res, 200, JSON.stringify({ ok: true, ...extra }), { 'Content-Type': 'application/json; charset=utf-8', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
  if (pathname === '/api/login' && req.method === 'POST') {
    const { password } = await readJson();
    if (passwordRecord() === null) return ok({ open: true });
    if (!passwordMatches(password)) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      throw new HttpError(401, 'Wrong password');
    }
    return ok({}, sessionCookie(newSessionToken()));
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    return send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sessionCookie('', 0) });
  }
  if (!sessionValid(req)) throw new HttpError(401, 'Locked');

  // Settings → Password: set one (from open), change it, or remove it (back to open).
  // Changing or removing needs the current password. The window making the change stays unlocked.
  if (pathname === '/api/password' && req.method === 'POST') {
    const { current, password } = await readJson();
    const had = passwordRecord() !== null;
    if (had && !passwordMatches(current)) {
      await new Promise((r) => setTimeout(r, 600));
      throw new HttpError(403, 'The current password isn’t right');
    }
    if (password === null) {
      try { fs.unlinkSync(PASSWORD_FILE); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      return ok({ open: true }, sessionCookie('', 0));
    }
    if (typeof password !== 'string' || password.length < 3 || password.length > 1000) throw new HttpError(400, 'Use at least 3 characters');
    writePasswordFile(hashPassword(password));
    return ok({ open: false }, sessionCookie(newSessionToken()));
  }

  // Image upload: raw bytes with an image/* content type (which also forces a CORS preflight).
  if (req.method === 'POST' && pathname === '/api/images') {
    if (!/^image\//i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected an image');
    return sendJson(res, 200, saveImage(await readBody(req, { raw: true, limit: MAX_IMAGE })));
  }

  if (req.method === 'GET' && pathname === '/api/backup') {
    const zip = createBackup();
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return send(res, 200, zip, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="taskule-backup-${stamp}.zip"`,
      'Content-Length': zip.length,
    });
  }

  let body = {};
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON');
    const raw = await readBody(req);
    if (raw) {
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Malformed JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
    }
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(pathname);
    if (m) return sendJson(res, 200, await r.handler(m.slice(1).map(decodeURIComponent), body));
  }
  throw new HttpError(404, 'Not found');
}

function serveImage(req, res, name) {
  if (!IMAGE_FILE_RE.test(name)) return send(res, 404, 'Not found');
  let allowed = false;
  try { allowed = sessionValid(req); } catch { allowed = false; } // damaged password file: refuse, never open
  if (!allowed) return send(res, 401, 'Locked', { 'Cache-Control': 'no-store' });
  fs.readFile(path.join(IMAGES_DIR, name), (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, req.method === 'HEAD' ? undefined : buf, {
      'Content-Type': IMAGE_MIME[name.split('.').pop()],
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file;
  try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel))); } catch { return send(res, 400, 'Bad path'); }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback for unknown non-asset routes
      if (!path.extname(rel)) file = path.join(PUBLIC_DIR, 'index.html');
      else return send(res, 404, 'Not found');
    }
    fs.readFile(file, (err2, buf) => {
      if (err2) return send(res, 404, 'Not found');
      send(res, 200, req.method === 'HEAD' ? undefined : buf, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { return send(res, 400, 'Bad request'); }
  if (pathname.startsWith('/images/')) return serveImage(req, res, pathname.slice(8));
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  try {
    await handleApi(req, res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error', ...(err.extra || {}) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  [${new Date().toISOString()}] Taskule is running →  http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}\n  Data: ${DB_FILE}\n  Database check: ${dbHealth.ok ? 'ok' : dbHealth.problem}\n`);
});
server.on('error', (err) => {
  // Exit code 3 = "another server already has the port" (the Windows launcher waits longer then).
  if (err.code === 'EADDRINUSE') { console.error(`[${new Date().toISOString()}] Port ${PORT} is in use. Try: PORT=4848 npm start`); process.exit(3); }
  console.error(err);
  process.exit(1);
});

// One bad request must never take the server (and your ability to save) down with it.
// Everything that matters lives in SQLite, so logging and carrying on is safe.
process.on('uncaughtException', (err) => console.error(`[${new Date().toISOString()}] Unexpected error (server keeps running):`, err));
process.on('unhandledRejection', (err) => console.error(`[${new Date().toISOString()}] Unexpected async error (server keeps running):`, err));

function shutdown() {
  server.close();
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
