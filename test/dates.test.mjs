import { parseExact, suggestDates, todayISO, formatDate, parseLabel, relativeLabel } from '../public/dates.js';
import assert from 'node:assert/strict';
const T = '2026-11-13'; // Friday
const p = (q) => parseExact(q, T).map((c) => c.iso);
const cases = {
  'today': ['2026-11-13'], 'date': ['2026-11-13'], 'Today!': ['2026-11-13'],
  'tomorrow': ['2026-11-14'], 'tmrw': ['2026-11-14'], 'yesterday': ['2026-11-12'],
  'day after tomorrow': ['2026-11-15'], 'day before yesterday': ['2026-11-11'],
  'last thursday': ['2026-11-12'], 'last friday': ['2026-11-06'], 'last Monday': ['2026-11-09'],
  'thursday': ['2026-11-19'], 'friday': ['2026-11-13'], 'this saturday': ['2026-11-14'], 'sat': ['2026-11-14'],
  'next thursday': ['2026-11-19', '2026-11-26'], 'next friday': ['2026-11-20', '2026-11-27'], 'next mon': ['2026-11-16', '2026-11-23'],
  'thursday next week': ['2026-11-19'], 'next week tuesday': ['2026-11-17'], 'monday last week': ['2026-11-02'],
  'next week': ['2026-11-20'], 'last week': ['2026-11-06'], 'next month': ['2026-12-13'], 'last year': ['2025-11-13'],
  'in 3 days': ['2026-11-16'], '3 days': ['2026-11-16'], 'in a week': ['2026-11-20'], 'in two weeks': ['2026-11-27'],
  '2 weeks from now': ['2026-11-27'], '3 days ago': ['2026-11-10'], 'a month ago': ['2026-10-13'], '+5': ['2026-11-18'],
  '-1w': ['2026-11-06'], '10d': ['2026-11-23'], 'in a couple of days': ['2026-11-15'], 'a couple days ago': ['2026-11-11'],
  'nov 20': ['2026-11-20'], 'November 20th': ['2026-11-20'], '20th of november': ['2026-11-20'], 'dec 25 2027': ['2027-12-25'],
  'feb 1': ['2027-02-01'], 'march 3': ['2027-03-03'], 'oct 1': ['2026-10-01'], 'jan 31, 2025': ['2025-01-31'],
  '11/20': ['2026-11-20'], '11/20/26': ['2026-11-20'], '2/30': [], '2026-12-01': ['2026-12-01'], 'thu nov 19': ['2026-11-19'],
  '20th': ['2026-11-20'], '1st': ['2026-11-01'], '28th': ['2026-11-28'], '31st': ['2026-10-31'],
  'end of month': ['2026-11-30'], 'eow': ['2026-11-13'], 'this weekend': ['2026-11-14'], 'next weekend': ['2026-11-21'],
  'banana': [], 'thursday meeting': [], '': [],
};
let fail = 0;
for (const [q, want] of Object.entries(cases)) {
  const got = p(q);
  try { assert.deepEqual(got, want); } catch { fail++; console.log(`FAIL ${JSON.stringify(q)} → ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); }
}
// suggestions
const s = (q) => suggestDates(q, T).map((x) => `${x.phrase}=${x.iso}`);
console.log('@        ', s(''));
console.log('@to     ', s('to'));
console.log('@la     ', s('la'));
console.log('@last th', s('last th'));
console.log('@next th', suggestDates('next th', T).map((x) => `${x.phrase}=${x.iso} (${x.hint})`));
assert.equal(formatDate('2026-11-13'), 'Fri, Nov 13, 2026');
assert.equal(parseLabel('Fri, Nov 13, 2026'), '2026-11-13');
assert.equal(relativeLabel('2026-11-27', T), 'in 2 weeks');
// Eastern-time "today": 2026-11-14 03:00 UTC is still Nov 13 in New York (EST, UTC-5)
assert.equal(todayISO(new Date('2026-11-14T03:00:00Z')), '2026-11-13');
assert.equal(todayISO(new Date('2026-11-14T05:30:00Z')), '2026-11-14');
// summer (EDT, UTC-4): 2026-07-04 03:30Z is still Jul 3 in NY; 04:30Z is Jul 4
assert.equal(todayISO(new Date('2026-07-04T03:30:00Z')), '2026-07-03');
assert.equal(todayISO(new Date('2026-07-04T04:30:00Z')), '2026-07-04');
console.log(fail ? `${fail} FAILED` : `all ${Object.keys(cases).length} parse cases + tz checks passed`);
if (fail) process.exit(1);

// ---- dates inside pasted text
import { findDatesInText } from '../public/dates.js';
const f = (s) => findDatesInText(s).map((d) => `${s.slice(d.index, d.index + d.length)}=${d.iso}`);
const textCases = {
  'Kickoff was Mar 6, 2026 and review 06/10/2025.': ['Mar 6, 2026=2026-03-06', '06/10/2025=2025-06-10'],
  'Due Friday, March 6th 2026!': ['Friday, March 6th 2026=2026-03-06'],
  'Thu, Nov 13, 2026': ['Thu, Nov 13, 2026=2026-11-13'],
  'on 6 March 2026 and 2026-12-01': ['6 March 2026=2026-03-06', '2026-12-01=2026-12-01'],
  'September 30, 2025': ['September 30, 2025=2025-09-30'],
  'version 1/2/3, score 10/10, 13/45/2025, Feb 30, 2026, Mar 6': [],
  'phone 555-12-2025x': [],
};
let tfail = 0;
for (const [s, want] of Object.entries(textCases)) {
  const got = f(s);
  try { assert.deepEqual(got, want); } catch { tfail++; console.log(`FAIL text ${JSON.stringify(s)} → ${JSON.stringify(got)}`); }
}
console.log(tfail ? `${tfail} text cases FAILED` : `all ${Object.keys(textCases).length} in-text date cases passed`);
if (tfail) process.exit(1);
