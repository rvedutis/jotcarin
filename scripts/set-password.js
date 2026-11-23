// Set, change or remove the Taskule password from the command line (the same as Settings → Password).
//   npm run set-password -- "new password"     set or change it (stored hashed)
//   npm run set-password -- --none             remove it: Taskule opens without a password
// Everyone who is unlocked right now will be asked for the new password.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'password.json');
const arg = process.argv[2];
if (arg === '--none') {
  try { fs.unlinkSync(FILE); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  console.log('Password removed: Taskule now opens without a password.');
  process.exit(0);
}
if (typeof arg !== 'string' || arg.length < 3) {
  console.log('Usage: npm run set-password -- "new password"   (at least 3 characters)');
  console.log('   or: npm run set-password -- --none           (no password: Taskule opens without one)');
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(arg, salt, 32).toString('hex');
fs.mkdirSync(DATA_DIR, { recursive: true });
const tmp = `${FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify({ salt, hash }, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, FILE);
console.log('Password set. It takes effect right away, no restart needed.');
