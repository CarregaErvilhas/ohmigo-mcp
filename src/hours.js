// Opening hours: is this charger open at a given moment?
//
// Two sources say when a site is open, both in OpenStreetMap's opening_hours
// syntax (nap-dashboard converts the NAP's DATEX II into it):
//   site.hours       what the operator declares on the NAP
//   site.osm.openingHours  what the OpenStreetMap community mapped
// Most NAP sites say "24/7", often as a default: a supermarket car park that
// closes at 21:00 still says 24/7 there, while OSM has its real hours. So a
// site counts as open only when every source that has hours says so.
//
// The parser covers what Portuguese chargers use: "24/7", "Mo-Fr 08:00-22:00;
// Sa 09:00-13:00", "Mo-Su 00:00-02:00,08:00-24:00", "09:00-21:00" (every
// day), "Su off", ranges past midnight ("22:00-02:00"). Anything else (public
// holidays, months, "sunrise") makes the answer unknown (null), never a guess.

import { QUARTER_MS, REGION_TZ } from './profile.js';

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
const DAYSPEC = new RegExp(`^(${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*)(?:\\s+(.*))?$`);
const RANGE = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

// "Mo-Fr 08:00-22:00; Sa 09:00-13:00" -> 7 lists of [from, to) minutes, Monday
// first, or null when the text says something this parser doesn't know.
export function parseHours(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const week = DAYS.map(() => []);
  const spill = DAYS.map(() => []);
  for (const raw of text.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;
    if (rule === '24/7') { week.forEach((d, i) => { week[i] = [[0, 1440]]; }); continue; }
    let days = [0, 1, 2, 3, 4, 5, 6], rest = rule;
    const m = rule.match(DAYSPEC);
    if (m) {
      days = [];
      for (const part of m[1].split(',')) {
        const [a, b = a] = part.split('-').map(d => DAYS.indexOf(d));
        for (let i = a; ; i = (i + 1) % 7) { days.push(i); if (i === b) break; }
      }
      rest = (m[2] ?? '').trim();
    }
    let ranges;
    if (rest === '' && m) ranges = [[0, 1440]]; // "Sa" alone: open all day
    else if (rest === 'off' || rest === 'closed') ranges = [];
    else {
      ranges = [];
      for (const r of rest.split(',')) {
        const x = r.trim().match(RANGE);
        if (!x) return null;
        const from = +x[1] * 60 + +x[2], to = +x[3] * 60 + +x[4];
        if (from > 1440 || to > 1440) return null;
        ranges.push([from, to]);
      }
    }
    // A later rule replaces what an earlier one said about the same days.
    for (const d of days) {
      week[d] = [];
      spill[(d + 1) % 7] = spill[(d + 1) % 7].filter(s => s.from !== d);
      for (const [from, to] of ranges) {
        if (to > from) week[d].push([from, to]);
        else { // past midnight: until `to` the next day
          week[d].push([from, 1440]);
          if (to > 0) spill[(d + 1) % 7].push({ from: d, range: [0, to] });
        }
      }
    }
  }
  return week.map((d, i) => [...d, ...spill[i].map(s => s.range)]);
}

const fmt = new Map();
function localDayMinute(at, region) {
  const tz = REGION_TZ[region] || REGION_TZ.CONT;
  if (!fmt.has(tz)) fmt.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const p = Object.fromEntries(fmt.get(tz).formatToParts(at).map(x => [x.type, x.value]));
  return { day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), minute: +p.hour * 60 + +p.minute };
}

// true/false, or null when the text can't be read.
export function isOpen(text, at, region) {
  const week = parseHours(text);
  if (!week) return null;
  const { day, minute } = localDayMinute(at, region);
  return week[day].some(([a, b]) => minute >= a && minute < b);
}

// What a site's hours say at `at`: open (true/false/null), both texts, and
// whether the two sources answer differently right then.
export function siteOpen(site, at = new Date()) {
  const nap = site.hours ?? null, osm = site.osm?.openingHours ?? null;
  const answers = [nap, osm].map(h => isOpen(h, at, site.region)).filter(x => x !== null);
  const open = answers.length ? answers.every(Boolean) : null;
  return { open, nap, osm, disagree: answers.length === 2 && answers[0] !== answers[1] };
}

// How many calendar days after `from` is `to`, in the site's time zone. Weekday
// arithmetic: a closure the assumption talks about is under a week away.
export function daysLater(from, to, region) {
  return (localDayMinute(to, region).day - localDayMinute(from, region).day + 7) % 7;
}

// A session is [start, end): one that ends exactly at closing time fits, the
// driver just has to leave. Returns the first minute of it the site's hours
// call closed, or null. Checking only the end isn't enough: a slow AC session
// from 20:00 to 10:00 is open at both ends of a car park shut all night.
//
// This samples every quarter of an hour, then finds the exact minute. A gap
// shorter than 15 minutes between two samples can be missed; opening hours
// with one that short are not expected. Intersecting the parsed ranges would
// be exact, but has to carry two sources, spill past midnight and clock
// changes. 24/7 and unreadable hours can't close a session: never a guess, and
// the common case skips the walk.
const MINUTE_MS = 60_000;
const neverCloses = text => text === '24/7' || !parseHours(text);
export function closesDuring(site, start, end) {
  if (neverCloses(site.hours) && neverCloses(site.osm?.openingHours)) return null;
  // The end to the minute, as the sentences show it: 21:00:20 reads 21:00.
  const first = start.getTime(), last = Math.floor(end.getTime() / MINUTE_MS) * MINUTE_MS - 1;
  if (last < first) return null;
  const closed = t => siteOpen(site, new Date(t)).open === false;
  let open = null; // the last sample seen open
  for (let t = first; ; t = Math.min(t + QUARTER_MS, last)) {
    if (closed(t)) {
      for (let m = open === null ? t : open + MINUTE_MS; m < t; m += MINUTE_MS) {
        if (closed(m)) { t = m; break; }
      }
      return new Date(Math.floor(t / MINUTE_MS) * MINUTE_MS);
    }
    if (t === last) return null;
    open = t;
  }
}
