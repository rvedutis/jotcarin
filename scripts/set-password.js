// Change the Taskule password.
//   npm run set-password -- "new password"     a fixed password (stored hashed)
//   npm run set-password -- --date             the password is always today's date as mmddyyyy
//                                              (US Eastern time), e.g. 11232026
// Everyone who is unlocked right now will be asked for the new password.
// (To start over instead, delete data/password.json: the lock screen then asks you to create one.)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'password.json');
const arg = process.argv[2];
let record;
if (arg === '--date') {
  record = { mode: 'date' };
} else if (typeof arg === 'string' && arg.length >= 3) {
  const salt = crypto.randomBytes(16).toString('hex');
  record = { salt, hash: crypto.scryptSync(arg, salt, 32).toString('hex') };
} else {
  console.log('Usage: npm run set-password -- "new password"   (at least 3 characters)');
  console.log('   or: npm run set-password -- --date           (password = today\'s date, mmddyyyy, US Eastern)');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const tmp = `${FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, FILE);
console.log(arg === '--date'
  ? 'Password set to date mode: from now on it is today\'s date as mmddyyyy (US Eastern time). Takes effect right away.'
  : 'Password changed. It takes effect right away, no restart needed.');
