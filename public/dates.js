// Natural-language date parsing. All dates are calendar dates (no time) and
// "today" is determined in US Eastern time (EST/EDT), whatever the machine's timezone.

export const TIME_ZONE = 'America/New_York';
const DAY = 86400000;

const pad = (n) => String(n).padStart(2, '0');
const toISO = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const fromISO = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const make = (y, m, d) => { const t = Date.UTC(y, m - 1, d); const x = new Date(t); return x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? t : null; };
const addDays = (t, n) => t + n * DAY;
function addMonths(t, n) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last));
}

/** Today's date in Eastern time, as YYYY-MM-DD. */
export function todayISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** "Thu, Nov 13, 2026" */
export function formatDate(iso) {
  const t = fromISO(iso);
  return Number.isFinite(t) ? LABEL.format(new Date(t)) : iso;
}
export const DATE_LABEL_RE = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b/g;
/** Inverse of formatDate (used to recognise dates inside plain-text tasks). */
export function parseLabel(label) {
  const m = /^\w{3}, (\w{3}) (\d{1,2}), (\d{4})$/.exec(label);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  const t = mo && make(+m[3], mo, +m[2]);
  return t == null ? null : toISO(t);
}

/** Days from today (negative = past). */
export function daysFromToday(iso, today = todayISO()) {
  return Math.round((fromISO(iso) - fromISO(today)) / DAY);
}

/** "Today", "Tomorrow", "in 3 days", "2 weeks ago" … */
export function relativeLabel(iso, today = todayISO()) {
  const n = daysFromToday(iso, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  const a = Math.abs(n);
  let s;
  if (a < 14) s = `${a} days`;
  else if (a < 60) s = `${Math.round(a / 7)} weeks`;
  else if (a < 365) s = `${Math.round(a / 30.44)} months`;
  else { const y = Math.round(a / 365.25); s = `${y} year${y === 1 ? '' : 's'}`; }
  return n > 0 ? `in ${s}` : `${s} ago`;
}

// ------------------------------------------------------------------ vocabulary
const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, couple: 2, 'a couple': 2, 'a couple of': 2, few: 3, 'a few': 3,
};
const UNITS = {
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w',
  fortnight: 'f', fortnights: 'f',
  m: 'm', mo: 'm', mos: 'm', mth: 'm', mths: 'm', month: 'm', months: 'm',
  y: 'y', yr: 'y', yrs: 'y', year: 'y', years: 'y',
};
const WD = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
const MO = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const NUM = `\\d{1,4}|${Object.keys(NUMBERS).sort((a, b) => b.length - a.length).join('|')}`;
const UNIT = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
const ORD = '(?:st|nd|rd|th)?';

function shift(t, n, unit) {
  if (unit === 'd') return addDays(t, n);
  if (unit === 'w') return addDays(t, 7 * n);
  if (unit === 'f') return addDays(t, 14 * n);
  if (unit === 'm') return addMonths(t, n);
  return addMonths(t, 12 * n);
}
const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUMBERS[s]);

/** Pick the occurrence of month/day closest to today (so "Feb 1" in November means next February). */
function nearestYear(today, m, d) {
  const y = new Date(today).getUTCFullYear();
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const t = make(yy, m, d);
    if (t == null) continue;
    if (best == null || Math.abs(t - today) < Math.abs(best - today) || (Math.abs(t - today) === Math.abs(best - today) && t > best)) best = t;
  }
  return best;
}
function fullYear(s) {
  if (s == null) return null;
  const n = Number(s);
  return s.length <= 2 ? 2000 + n : n;
}

/**
 * Parse one phrase exactly. Returns an array of candidates [{ iso, note? }] — usually one,
 * two when the phrase is genuinely ambiguous (e.g. "next thursday").
 */
export function parseExact(input, today = todayISO()) {
  const T = fromISO(today);
  let q = String(input).toLowerCase().replace(/[.,!?;]+$/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(/^(on|by|due|the) /, '').replace(/^the /, '');
  const one = (t, note) => (t == null ? [] : [{ iso: toISO(t), note }]);
  let m;

  if (/^(today|now|date|tod|tdy|this day)$/.test(q)) return one(T);
  if (/^(tomorrow|tmr|tmrw|tmw|tom|tomorow|tommorow|tommorrow)$/.test(q)) return one(addDays(T, 1));
  if (/^(yesterday|yday|yest|ystd)$/.test(q)) return one(addDays(T, -1));
  if (/^(day after tomorrow|overmorrow)$/.test(q)) return one(addDays(T, 2));
  if (/^day before yesterday$/.test(q)) return one(addDays(T, -2));

  const dow = new Date(T).getUTCDay();
  // weekdays
  if ((m = new RegExp(`^(?:(this|next|last|past|previous|prev|coming|upcoming) )?(${WD})$`).exec(q))) {
    const wd = WEEKDAYS[m[2]];
    const mod = m[1] || '';
    if (/^(last|past|previous|prev)$/.test(mod)) return one(addDays(T, -(((dow - wd + 7) % 7) || 7)));
    if (mod === 'next') {
      const first = addDays(T, ((wd - dow + 7) % 7) || 7);
      return [{ iso: toISO(first) }, { iso: toISO(addDays(first, 7)), note: 'the week after' }];
    }
    return one(addDays(T, (wd - dow + 7) % 7));
  }
  // "thursday next week", "next week thursday"
  if ((m = new RegExp(`^(${WD}) (next|last|this) week$`).exec(q)) || (m = new RegExp(`^(next|last|this) week (${WD})$`).exec(q))) {
    const [wdName, which] = WEEKDAYS[m[1]] !== undefined ? [m[1], m[2]] : [m[2], m[1]];
    const monday = addDays(T, -((dow + 6) % 7));
    const base = which === 'next' ? addDays(monday, 7) : which === 'last' ? addDays(monday, -7) : monday;
    return one(addDays(base, (WEEKDAYS[wdName] + 6) % 7));
  }

  if ((m = /^(next|last|past|previous|this) (week|month|year)$/.test(q) && /^(\w+) (\w+)$/.exec(q))) {
    if (m[1] === 'this') return m[2] === 'week' ? one(T) : [];
    const n = m[1] === 'next' ? 1 : -1;
    return one(shift(T, n, m[2][0] === 'w' ? 'w' : m[2][0] === 'm' ? 'm' : 'y'));
  }
  if (/^(this |the )?weekend$/.test(q)) return one(dow === 6 || dow === 0 ? T : addDays(T, 6 - dow));
  if (q === 'next weekend') return one(addDays(T, (dow === 6 ? 7 : dow === 0 ? 6 : 6 - dow + 7)));
  if (/^(end of (the )?month|eom)$/.test(q)) return one(addDays(addMonths(Date.UTC(new Date(T).getUTCFullYear(), new Date(T).getUTCMonth(), 1), 1), -1));
  if (/^(end of (the )?week|eow)$/.test(q)) return one(addDays(T, (5 - dow + 7) % 7));
  if (/^(end of (the )?year|eoy)$/.test(q)) return one(Date.UTC(new Date(T).getUTCFullYear(), 11, 31));
  if (/^(start|beginning) of next month$/.test(q)) return one(Date.UTC(new Date(T).getUTCFullYear(), new Date(T).getUTCMonth() + 1, 1));

  // relative offsets: "in 3 days", "2 weeks from now", "3d", "+2w", "a month ago"
  if ((m = new RegExp(`^(?:in )?(${NUM}) ?(${UNIT})(?: (from now|from today|later|ahead|out|hence))?$`).exec(q))) {
    const n = num(m[1]);
    if (n != null && n <= 3650) return one(shift(T, n, UNITS[m[2]]));
  }
  if ((m = new RegExp(`^(${NUM}) ?(${UNIT}) (ago|back|before|earlier|prior)$`).exec(q))) {
    const n = num(m[1]);
    if (n != null && n <= 3650) return one(shift(T, -n, UNITS[m[2]]));
  }
  if ((m = new RegExp(`^([+-]) ?(\\d{1,4}) ?(${UNIT})?$`).exec(q))) {
    return one(shift(T, (m[1] === '-' ? -1 : 1) * Number(m[2]), UNITS[m[3]] || 'd'));
  }

  // absolute dates; allow a leading weekday ("thu nov 19")
  q = q.replace(new RegExp(`^(?:${WD}) (?=\\S)`), '');
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q))) return one(make(+m[1], +m[2], +m[3]));
  if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(q))) {
    const y = fullYear(m[3]);
    return one(y ? make(y, +m[1], +m[2]) : nearestYear(T, +m[1], +m[2]));
  }
  if ((m = new RegExp(`^(${MO}) (\\d{1,2})${ORD}(?: (\\d{4}))?$`).exec(q)) ||
      (m = new RegExp(`^(\\d{1,2})${ORD} (?:of )?(${MO})(?: (\\d{4}))?$`).exec(q))) {
    const [mo, d] = MONTHS[m[1]] ? [MONTHS[m[1]], +m[2]] : [MONTHS[m[2]], +m[1]];
    return one(m[3] ? make(+m[3], mo, d) : nearestYear(T, mo, d));
  }
  if ((m = /^(\d{1,2})(st|nd|rd|th)$/.exec(q))) {
    // "the 20th" → whichever 20th (last, this or next month) is closest to today
    const base = new Date(T);
    const opts = [-1, 0, 1].map((k) => {
      const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + k, 1));
      return make(first.getUTCFullYear(), first.getUTCMonth() + 1, +m[1]);
    }).filter((t) => t != null);
    opts.sort((a, b) => Math.abs(a - T) - Math.abs(b - T) || b - a);
    return one(opts[0] ?? null);
  }
  return [];
}

// Phrases offered as you type ("@to" → Today, Tomorrow).
const WEEK_ORDER = [...WEEKDAY_NAMES.slice(1), WEEKDAY_NAMES[0]]; // Monday first
const PHRASES = [
  'today', 'tomorrow', 'yesterday',
  'next week', 'last week', 'next month', 'last month', 'this weekend', 'next weekend',
  ...WEEK_ORDER,
  ...WEEK_ORDER.map((w) => `next ${w}`),
  ...WEEK_ORDER.map((w) => `last ${w}`),
  'end of month', 'end of week', 'in 2 days', 'in 1 week', 'in 2 weeks', 'in 1 month',
];

/**
 * Suggestions for an @-query: exact parse first, then phrases that start with the query.
 * Each item: { iso, label, phrase, hint }.
 */
export function suggestDates(query, today = todayISO(), limit = 6) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, ' ').trimStart();
  const out = [];
  const seen = new Set();
  const push = (c, phrase) => {
    if (seen.has(c.iso) || out.length >= limit) return;
    seen.add(c.iso);
    out.push({ iso: c.iso, label: formatDate(c.iso), phrase, hint: c.note || relativeLabel(c.iso, today) });
  };
  if (!q.trim()) {
    for (const p of ['today', 'tomorrow', 'yesterday', 'next monday']) push(parseExact(p, today)[0], p);
    return out;
  }
  for (const c of parseExact(q, today)) push(c, q.trim());
  if (q.trim().length >= 1) {
    for (const p of PHRASES) {
      if (p !== q.trim() && p.startsWith(q.trim())) for (const c of parseExact(p, today).slice(0, 1)) push(c, p);
    }
  }
  return out;
}

// ------------------------------------------------------------------ dates inside text
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DOW_RE = String.raw`(?:(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day|nesday|sday|urday)?\.?,?\s+)?`;
const TEXT_DATE_PATTERNS = [
  // "Mar 6, 2026", "Friday, March 6th 2026", "Fri, Nov 13, 2026"
  { re: new RegExp(String.raw`\b${DOW_RE}${MONTH_RE}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, 'gi'), get: (m) => [m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], m[2]] },
  // "6 March 2026", "6th of Mar, 2026"
  { re: new RegExp(String.raw`\b${DOW_RE}(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_RE}\.?,?\s+(\d{4})\b`, 'gi'), get: (m) => [m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], m[1]] },
  // "06/10/2025", "6-10-2025" (US month/day/year)
  { re: /\b(\d{1,2})([/-])(\d{1,2})\2(\d{4})\b/g, get: (m) => [m[4], m[1], m[3]] },
  // "2026-03-06"
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, get: (m) => [m[1], m[2], m[3]] },
];

/**
 * Find full dates (with a year) inside free text. Returns [{ index, length, iso }] in order,
 * non-overlapping. Year-less dates are ignored on purpose to avoid false positives.
 */
export function findDatesInText(text) {
  const found = [];
  for (const { re, get } of TEXT_DATE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const [y, mo, d] = get(m).map(Number);
      const t = y >= 1900 && y <= 2200 ? make(y, mo, d) : null;
      if (t == null) continue;
      const hit = { index: m.index, length: m[0].length, iso: toISO(t) };
      if (!found.some((f) => hit.index < f.index + f.length && f.index < hit.index + hit.length)) found.push(hit);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}
