// Limits on third-party text, applied once when a dataset loads.
//
// Part of every answer is text nobody here wrote: operators type it into the
// NAP, and anyone with an OpenStreetMap account can edit a node, which the
// weekly dataset then carries to the assistant. A bad edit can't be spotted,
// but it can be kept small: a known set of OSM fields, each with a shape and a
// length. Values that fit pass exactly as published. A contact or a URL that
// doesn't fit is dropped (the field is absent, never repaired by a guess).
//
// Dataset's constructor calls cleanSite before anything reads the site, so the
// search index, every tool and the sentences in assumptions and notes all see
// the same limited text.

// Comfortably above the longest real values, so that a cut means something is
// wrong: docs/05-dataset.md has what each field holds.
const NAME_MAX = 120;
const PLACE_MAX = 200;
const HOURS_MAX = 100;
const TAG_MAX = 30; // OSM tag values: "customers", "unlimited", "-1"
const PHONE_MAX = 50; // two numbers: OSM lists them with a ';'
const EMAIL_MAX = 100;
const WEBSITE_MAX = 200;
const CAPACITY_MAX = 200; // cars charging at once

// Control and format characters (\p{Cc}, \p{Cf}) can't be seen: they hide
// words from a reader (zero-width spaces, right-to-left overrides) or start
// new lines. Whitespace ones become spaces, the others go.
// A cut ends on a word when one ends near it, and shows with "…". The "…" also
// keeps opening hours honest: parseHours can't read it, so hours that were cut
// read as unknown, not as a week with its last days missing.
export function cleanText(value, max) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/(?!\s)[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text || undefined;
  const cut = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, ''); // not half an emoji
  const space = cut.lastIndexOf(' ');
  return `${space > max * 2 / 3 ? cut.slice(0, space) : cut}…`;
}

const text = max => value => cleanText(value, max);

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
// evil.example). /dados links to it, and the assistant may offer it as a link.
function website(value) {
  const s = cleanText(value, Infinity);
  if (!s || s.length > WEBSITE_MAX || /\s/.test(s) || !URL.canParse(s)) return undefined;
  const { protocol, username, password } = new URL(s);
  return (protocol === 'http:' || protocol === 'https:') && !username && !password ? s : undefined;
}

const NAP_FIELDS = {
  name: text(NAME_MAX), operator: text(NAME_MAX), city: text(NAME_MAX),
  address: text(PLACE_MAX), locationDescription: text(PLACE_MAX),
  hours: text(HOURS_MAX), phone, website,
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

function pick(fields, from) {
  const out = {};
  for (const [k, clean] of Object.entries(fields)) {
    const v = clean(from[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// What an OSM number on a socket has to be for data.js to believe it over the
// NAP. It decides filters and the session time, so a typo or a bad edit must
// not get through, but OSM is there to correct the NAP, so the check can't
// demand it be close:
//   max    no public socket goes past this. Also tells a NAP value that can't
//          be right (300 000 V, in the wrong unit): nothing to compare with.
//   ratio  how far from a believable NAP value OSM can be. kW declarations
//          are close to the plate. V and A are often placeholders (500 A on a
//          25 kW socket whose plate says 63), so they get more room.
const OSM_NUMBERS = { kw: { max: 1000, ratio: 5 }, v: { max: 1500, ratio: 10 }, a: { max: 1500, ratio: 10 } };

function saneOsmNumber(key, value, nap) {
  const { max, ratio } = OSM_NUMBERS[key];
  const sane = x => Number.isFinite(x) && x > 0 && x <= max;
  if (!sane(value)) return false;
  return !sane(nap) || Math.max(value / nap, nap / value) <= ratio;
}

function cleanPoint(p) {
  if (p.osm == null) return;
  const osm = {};
  for (const k of Object.keys(OSM_NUMBERS)) if (saneOsmNumber(k, p.osm[k], p[k])) osm[k] = p.osm[k];
  if (Object.keys(osm).length) p.osm = osm;
  else delete p.osm;
}

export function cleanSite(s) {
  for (const [k, clean] of Object.entries(NAP_FIELDS)) {
    if (s[k] == null) continue; // the NAP left it blank: still blank
    const v = clean(s[k]);
    if (v === undefined) delete s[k];
    else s[k] = v;
  }
  // The NAP's own vocabulary (apps, rfid, creditCard...): words, not sentences.
  if (Array.isArray(s.payment)) s.payment = s.payment.filter(m => typeof m === 'string' && /^\w{1,30}$/.test(m));
  if (s.osm != null) {
    const osm = pick(OSM_FIELDS, s.osm);
    if (Object.keys(osm).length) s.osm = osm;
    else delete s.osm;
  }
  s.points.forEach(cleanPoint);
}
