// Change the Jotcairn password.
//   npm run set-password -- "new password"
// Everyone who is unlocked right now will be asked for the new password.
// (To start over instead, delete data/password.json: the lock screen then asks you to create one.)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'password.json');
const pw = process.argv[2];
if (typeof pw !== 'string' || pw.length < 3) {
  console.log('Usage: npm run set-password -- "new password"   (at least 3 characters)');
  process.exit(1);
}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
fs.mkdirSync(DATA_DIR, { recursive: true });
const tmp = `${FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify({ salt, hash }, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, FILE);
console.log('Password changed. It takes effect right away, no restart needed.');
