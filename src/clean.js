// Limits on third-party text, applied once when a dataset loads.
//
// Part of every answer is text nobody here wrote: operators type it into the
// NAP, and anyone with an OpenStreetMap account can edit a node, which the
// weekly dataset then carries to the assistant. A bad edit can't be spotted,
// but it can be kept small: a known set of OSM fields, each with a shape and a
// length. Text that fits passes as published, and a website comes out as the
// URL parser writes it. A contact or a URL that doesn't fit is dropped (the
// field is absent, never repaired by a guess).
//
// Dataset's constructor calls cleanSite before anything reads the site, so the
// search index, every tool and the sentences in assumptions and notes all see
// the same limited text. Whatever it cuts or drops is counted, and Dataset.check
// logs the counts in one line: a real value hitting a limit shows up there.

// Comfortably above the longest real values, so that a cut means something is
// wrong: docs/05-dataset.md has what each field holds.
const NAME_MAX = 120;
const PLACE_MAX = 200;
const HOURS_MAX = 300; // a weekly schedule with two ranges a day is ~200
const TAG_MAX = 30; // OSM tag values: "customers", "unlimited", "-1"
const PHONE_MAX = 50; // two numbers: OSM lists them with a ';'
const EMAIL_MAX = 100;
const WEBSITE_MAX = 200;
const CAPACITY_MAX = 200; // cars charging at once

// Whitespace, listed: what counts as a space is not left to \s, which turns
// U+FEFF (an invisible format character) into one and skips NEL (U+0085).
const SPACES = /[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;
// What can't be seen: \p{C} is control and format characters, private-use and
// unassigned code points and lone surrogates; Default_Ignorable is what fonts
// draw as nothing (variation selectors, soft hyphens), and the three others
// are blank letters that aren't in either. They hide words from a reader.
// U+FE0F stays: it turns a symbol into its emoji.
const INVISIBLE = /[[\p{C}\p{Default_Ignorable_Code_Point}⠀ㅤﾠ]--️]/gv;

// A cut ends on a word when one ends near it, and shows with "…". The "…" also
// keeps opening hours honest: parseHours can't read it, so hours that were cut
// read as unknown, not as a week with its last days missing.
// onCut: called when the text didn't fit.
export function cleanText(value, max, onCut) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(SPACES, ' ').replace(INVISIBLE, '').replace(/ +/g, ' ').trim();
  if (text.length <= max) return text || undefined;
  onCut?.();
  const cut = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, ''); // not half an emoji
  const space = cut.lastIndexOf(' ');
  return `${space > max * 2 / 3 ? cut.slice(0, space) : cut}…`;
}

const text = max => (value, onCut) => cleanText(value, max, onCut);
// A short code that can't be dropped: operatorId, regime. Absent, an operatorId
// would make a site look unnamed to lendOperators, and a regime would price it
// as MOBI.E with no assumption saying so. Capped, it stays what it was: a code
// nothing here knows, handled as today.
const code = max => (value, onCut) => cleanText(String(value), max, onCut) ?? '?';

// One value, or a few with ';' between them, which is how OSM lists a second
// phone or email. All of them have to fit, or none is passed on.
const contact = (shape, max) => value => {
  const s = cleanText(value, Infinity);
  return s && s.length <= max && s.split(';').every(x => shape.test(x.trim())) ? s : undefined;
};
const PHONE = /^\(?\+?(?:[ ()-]*\d){6,15}[ ()-]*$/; // 15: the most digits a phone number has
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}$/i;
const phone = contact(PHONE, PHONE_MAX);
const email = contact(EMAIL, EMAIL_MAX);

// Only http(s), without a login in it ("https://bank.pt@evil.example/" goes to
// evil.example) or characters that could close the markup it lands in. /dados
// links to it, and the assistant may offer it as a link. Normalised by URL, so
// what passes is what a browser would open.
function website(value) {
  const s = cleanText(value, Infinity);
  if (!s || s.length > WEBSITE_MAX || /[\s<>"`]/.test(s) || !URL.canParse(s)) return undefined;
  const { protocol, username, password, href } = new URL(s);
  return (protocol === 'http:' || protocol === 'https:') && !username && !password ? href : undefined;
}

// The grid level picks a tariff version ("MT"): blank is fine, the quote says so.
const OPERATOR_ID_MAX = 12; // real ones have 4 characters
const gridLevel = v => typeof v === 'string' && /^[A-Z]{2,3}$/.test(v) ? v : undefined;

const NAP_FIELDS = {
  name: text(NAME_MAX), operator: text(NAME_MAX), city: text(NAME_MAX),
  address: text(PLACE_MAX), locationDescription: text(PLACE_MAX),
  hours: text(HOURS_MAX), phone, website, operatorId: code(OPERATOR_ID_MAX),
};

// What the code reads or a driver acts on. Anything else OSM has (a `note`, a
// `description`, a key added next year) doesn't reach the answers until
// someone adds it here. Left out, though nap-dashboard sends them:
// manufacturer and model (free text nothing reads) and payment (raw OSM tag
// names; `cards` and the NAP's `payment` already say how to pay).
const OSM_FIELDS = {
  name: text(NAME_MAX), brand: text(NAME_MAX), operator: text(NAME_MAX),
  openingHours: text(HOURS_MAX), phone, email,
  access: text(TAG_MAX), parkingFee: text(TAG_MAX), maxstay: text(TAG_MAX),
  location: text(TAG_MAX), level: text(TAG_MAX), covered: text(TAG_MAX), indoor: text(TAG_MAX),
  cards: v => typeof v === 'boolean' ? v : undefined,
  capacity: v => Number.isInteger(v) && v > 0 && v <= CAPACITY_MAX ? v : undefined,
};

const count = (report, what) => { report[what] = (report[what] ?? 0) + 1; };

// A field through its check: the value to keep, or undefined, and the count.
function checked(clean, value, field, report) {
  if (value == null) return value;
  const v = clean(value, () => count(report, `cut ${field}`));
  if (v === undefined) count(report, `dropped ${field}`);
  return v;
}

// What an OSM number on a socket has to be for data.js to believe it over the
// NAP. It decides filters and the session time, so a typo or a bad edit must
// not get through, but OSM is there to correct the NAP, so the check can't
// demand it be close:
//   max    no public socket goes past this. Also tells a NAP value that can't
//          be right (300 000 V, in the wrong unit): nothing to compare with.
//   ratio  how far from a believable NAP value OSM can be. It stops garbage,
//          not corrections, so it's wide: a NAP 3.7 on a 22 kW socket, 50 on a
//          350 kW one or 500 A on a 25 kW one are what OSM is there to fix.
const OSM_NUMBERS = { kw: { max: 1000, ratio: 20 }, v: { max: 1500, ratio: 10 }, a: { max: 1500, ratio: 10 } };

function saneOsmNumber(key, value, nap) {
  const { max, ratio } = OSM_NUMBERS[key];
  const sane = x => Number.isFinite(x) && x > 0 && x <= max;
  if (!sane(value)) return false;
  return !sane(nap) || Math.max(value / nap, nap / value) <= ratio;
}

function cleanPoint(p, report) {
  // A blank level is how the NAP's blanks already arrive; the quote says so.
  if (p.level != null) p.level = checked(gridLevel, p.level, 'point.level', report) ?? null;
  if (p.regime != null) p.regime = checked(code(TAG_MAX), p.regime, 'point.regime', report);
  if (p.osm == null) return;
  const osm = {};
  for (const k of Object.keys(OSM_NUMBERS)) {
    if (p.osm[k] == null) continue;
    if (saneOsmNumber(k, p.osm[k], p[k])) osm[k] = p.osm[k];
    else count(report, `ignored point.osm.${k}`);
  }
  if (Object.keys(osm).length) p.osm = osm;
  else delete p.osm;
}

// `report` collects what was cut, dropped or ignored: { "cut address": 2 }.
export function cleanSite(s, report = {}) {
  for (const [k, clean] of Object.entries(NAP_FIELDS)) {
    if (s[k] == null) continue; // the NAP left it blank: still blank
    const v = checked(clean, s[k], k, report);
    if (v === undefined) delete s[k];
    else s[k] = v;
  }
  // The NAP's own vocabulary (apps, rfid, creditCard...): words, not sentences.
  if (s.payment != null && !Array.isArray(s.payment)) count(report, 'dropped payment');
  s.payment = (Array.isArray(s.payment) ? s.payment : []).filter(m => {
    const word = typeof m === 'string' && /^\w{1,30}$/.test(m);
    if (!word) count(report, 'dropped payment');
    return word;
  });
  if (s.osm != null) {
    const osm = {};
    for (const [k, clean] of Object.entries(OSM_FIELDS)) {
      const v = checked(clean, s.osm[k], `osm.${k}`, report);
      if (v != null) osm[k] = v;
    }
    if (Object.keys(osm).length) s.osm = osm;
    else delete s.osm;
  }
  for (const p of s.points) cleanPoint(p, report);
}

// One line for the log: which limits the data hit, most hit first.
export function reportLine(report) {
  const rows = Object.entries(report).sort((a, b) => b[1] - a[1]).map(([what, n]) => `${what} ${n}`);
  return `[ohmigo] third-party limits: ${rows.join(', ') || 'nothing cut, dropped or ignored'}`;
}
