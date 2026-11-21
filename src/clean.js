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
  // DATEX II accessibility values, '|'-joined: words only (data.js reads them).
  accessibility: v => typeof v === 'string' && /^\w{1,40}(\|\w{1,40}){0,5}$/.test(v) ? v : undefined,
};

// What the code reads or a driver acts on. Anything else OSM has (a `note`, a
// `description`, a key added next year) doesn't reach the answers until
// someone adds it here. Left out, though nap-dashboard sends them: payment
// (raw OSM tag names; `cards` and the NAP's `payment` already say how to pay),
// and manufacturer and model, which reach the answers as `hardware` (below).
const OSM_FIELDS = {
  name: text(NAME_MAX), brand: text(NAME_MAX), operator: text(NAME_MAX),
  openingHours: text(HOURS_MAX), phone, email,
  access: text(TAG_MAX), parkingFee: text(TAG_MAX), maxstay: text(TAG_MAX),
  location: text(TAG_MAX), level: text(TAG_MAX), covered: text(TAG_MAX), indoor: text(TAG_MAX),
  cards: v => typeof v === 'boolean' ? v : undefined,
  wheelchair: v => ['yes', 'limited', 'no'].includes(v) ? v : undefined,
  // The total a charger gives when its sockets share it (2 × 300 kW on a
  // 300 kW cabinet): with another car plugged in, each gets less.
  sharedKw: v => Number.isFinite(v) && v > 0 && v <= 1000 ? v : undefined,
  // Codes the site had before ("ABF-00049") and who ran it: the old sticker
  // may still be on the charger, so lookup_charger finds it by them.
  oldRefs: v => {
    const codes = Array.isArray(v) ? v.filter(c => typeof c === 'string' && /^[A-Z0-9-]{4,20}$/.test(c)).slice(0, 10) : [];
    return codes.length ? codes : undefined;
  },
  oldOperator: text(NAME_MAX),
  // The community's open questions about the charger ("Verificar se aceita
  // pagamento com cartão bancário"): free text, so short, few, and only ever
  // shown as something to check on site (note.osmFixme), never as a fact.
  fixme: v => {
    const notes = Array.isArray(v) ? v.map(x => cleanText(x, FIXME_MAX)).filter(Boolean).slice(0, 3) : [];
    return notes.length ? notes : undefined;
  },
  capacity: v => Number.isInteger(v) && v > 0 && v <= CAPACITY_MAX ? v : undefined,
  // The last time someone checked the charger on site (OSM check_date).
  checkDate: v => typeof v === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v) ? v : undefined,
};

// Every charger at the site, as mapped on OSM ("Alpitronic HYC_150", "Efacec
// QC45"), most common first: the driver asks for them ("is it an Alpitronic?")
// and lookup_charger finds a site by them. nap-dashboard sends `hardware`; an
// older file only has the commonest manufacturer and model, so that's the one.
const FIXME_MAX = 160; // the longest today has 120 characters
const HARDWARE_MAX = 80; // the longest label today has 38 characters
const HARDWARE_COUNT = 10; // the most a site has today is 2

function hardwareLabels(osm) {
  if (Array.isArray(osm.hardware)) return osm.hardware;
  const make = typeof osm.manufacturer === 'string' ? osm.manufacturer.trim() : '';
  const model = typeof osm.model === 'string' ? osm.model.trim() : '';
  const label = (model.toLowerCase().startsWith(make.toLowerCase()) ? [model] : [make, model]).filter(Boolean).join(' ');
  return label ? [label] : [];
}

function cleanHardware(osm, report) {
  if (osm.hardware != null && !Array.isArray(osm.hardware)) count(report, 'dropped osm.hardware');
  const out = [];
  for (const h of hardwareLabels(osm)) {
    const v = checked(text(HARDWARE_MAX), h, 'osm.hardware', report);
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length > HARDWARE_COUNT) count(report, 'cut osm.hardware');
  return out.slice(0, HARDWARE_COUNT);
}

const count = (report, what) => { report[what] = (report[what] ?? 0) + 1; };

// A field through its check: the value to keep, or undefined, and the count.
function checked(clean, value, field, report) {
  if (value == null) return value;
  const v = clean(value, () => count(report, `cut ${field}`));
  if (v === undefined) count(report, `dropped ${field}`);
  return v;
}

// 0-5 €: the dearest real fee is around 1.2 €/kWh; a typo in the NAP (a
// price in cents) should not become a 30 € charge.
const FEE_MAX = 5;
const fee = v => Number.isFinite(v) && v >= 0 && v <= FEE_MAX;
function napFees(v, report) {
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (['kwh', 'min', 'flat'].includes(k) && fee(x)) out[k] = x;
    else count(report, 'dropped point.napFees key');
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanPoint(p, report) {
  // A blank level is how the NAP's blanks already arrive; the quote says so.
  if (p.level != null) p.level = checked(gridLevel, p.level, 'point.level', report) ?? null;
  if (p.regime != null) p.regime = checked(code(TAG_MAX), p.regime, 'point.regime', report);
  // A plug the NAP left blank arrives as the text "nan" (pandas' blank,
  // written as a string upstream). It is no plug: null, like a blank level,
  // so the answers and filters never show or match the word.
  if (typeof p.connector === 'string' && /^(nan|none|null)?$/i.test(p.connector.trim())) p.connector = null;
  // The NAP's fees for a MOBI.E socket MOBI.E has no tariff for (regime
  // mobie_sem_tarifa): { kwh, min, flat }, each optional, € without VAT. The
  // live feed's own numbers win (quote.js feePlan); these stand in when it has
  // none. A key that isn't a sane price is dropped, and an empty object goes.
  if (p.napFees != null) p.napFees = checked(v => napFees(v, report), p.napFees, 'point.napFees', report);
  if (p.napFees === undefined) delete p.napFees;
  // A socket's `osm` is what OpenStreetMap said about it where that differs
  // from the NAP. nap-dashboard has already applied what was believable to
  // kw/v/a/cable (the NAP's value stays in napKw/napV/napA/napCable), so
  // nothing here reads it: third-party numbers nobody uses are not kept.
  delete p.osm;
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
    const hardware = cleanHardware(s.osm, report);
    if (hardware.length) osm.hardware = hardware;
    if (Object.keys(osm).length) s.osm = osm;
    else delete s.osm;
  }
  cleanPlaces(s, report);
  cleanModels(s, report);
  s.photos = cleanPhotos(s.photos, PHOTOS_MAX, report);
  if (!s.photos) delete s.photos;
  // Underground car park, and who says so: 'osm' or 'nap'.
  if (s.underground != null && !['osm', 'nap'].includes(s.underground)) { count(report, 'dropped underground'); delete s.underground; }
  cleanNearby(s, report);
  cleanHistory(s, report);
  for (const p of s.points) {
    cleanPoint(p, report);
    // Which charger of the site this socket is on (OSM's posts): sockets with
    // the same `unit` share its power.
    if (p.unit != null && !(Number.isInteger(p.unit) && p.unit >= 0 && p.unit < 100)) { count(report, 'dropped point.unit'); delete p.unit; }
    // Which of the site's charger models this socket is (an index into models).
    if (p.model != null && !(Number.isInteger(p.model) && p.model >= 0 && p.model < (s.models?.length ?? 0))) {
      if (s.models) count(report, 'dropped point.model');
      delete p.model;
    }
  }
}

// The charger models at the site: nap-dashboard joins the make and model the
// community maps on OpenStreetMap to Alexandre Moleiro's list of charger
// models (its charger_models.py). Each version: total kW, max volts and amps,
// and `cars`, [[cars plugged in, kW each at 400 V, kW each at 800 V], ...]:
// what the plate doesn't say (a "300 kW" gives a 400 V car 200 kW, and 150
// with a second car). Numbers out of range drop the version; a model with no
// version left goes.
const MODELS_MAX = 4;
const VARIANTS_MAX = 6;
const PHOTOS_MAX = 4;
const num = max => v => (Number.isFinite(v) && v > 0 && v <= max ? v : undefined);
const VARIANT_FIELDS = {
  totalKw: num(1500), acKw: num(50), acSockets: v => (Number.isInteger(v) && v > 0 && v <= 8 ? v : undefined),
  maxV: num(1500), maxA: num(1500), boostA: num(1500), batteryKwh: num(2000),
  exclusive: v => (v === true ? true : undefined), cable: v => (typeof v === 'boolean' ? v : undefined),
};
function cleanVariant(v) {
  if (!v || typeof v !== 'object') return undefined;
  const out = {};
  for (const [k, f] of Object.entries(VARIANT_FIELDS)) {
    const x = f(v[k]);
    if (x !== undefined) out[k] = x;
  }
  if (Array.isArray(v.cars)) {
    const kw = x => (x == null ? null : num(1000)(x));
    const cars = v.cars.slice(0, 12).filter(c => Array.isArray(c) && Number.isInteger(c[0]) && c[0] >= 1 && c[0] <= 12
      && kw(c[1]) !== undefined && kw(c[2]) !== undefined && (c[1] != null || c[2] != null))
      .map(c => [c[0], c[1] ?? null, c[2] ?? null]);
    if (cars.length) out.cars = cars;
  }
  return out.cars || out.acKw ? out : undefined;
}
function cleanModels(s, report) {
  if (s.models == null) return;
  const out = [];
  for (const m of Array.isArray(s.models) ? s.models.slice(0, MODELS_MAX) : []) {
    const name = cleanText(m?.name, NAME_MAX, () => count(report, 'cut models.name'));
    const variants = (Array.isArray(m?.variants) ? m.variants.slice(0, VARIANTS_MAX) : []).map(cleanVariant).filter(Boolean);
    if (!name || !variants.length) { count(report, 'dropped models'); continue; }
    const photo = cleanPhotos(m.photo ? [m.photo] : [], 1, report)?.[0];
    out.push({ name, variants, ...(photo && { photo }) });
  }
  if (out.length) s.models = out;
  else delete s.models;
}

// What is near the charger for the wait (nap-dashboard's osm_places.nearby_for):
// per type, how many within 150 m, the nearest's distance and name.
const NEARBY_TYPES = new Set(['cafe', 'restaurant', 'fast_food', 'toilets', 'shop', 'fuel']);
function cleanNearby(s, report) {
  if (s.nearby == null) return;
  const out = [];
  for (const x of Array.isArray(s.nearby) ? s.nearby.slice(0, 10) : []) {
    const ok = x && NEARBY_TYPES.has(x.type) && Number.isInteger(x.n) && x.n > 0 && x.n <= 500
      && Number.isInteger(x.m) && x.m >= 0 && x.m <= 200;
    if (!ok) { count(report, 'dropped nearby'); continue; }
    const name = cleanText(x.name, NAME_MAX) || undefined;
    out.push({ type: x.type, n: x.n, m: x.m, ...(name && { name }) });
  }
  if (out.length) s.nearby = out;
  else delete s.nearby;
}

// The site's history in the AmpereArchive (nap-dashboard's archive_stats.site_stats):
// % of the time out of order and occupancy per local hour, weekdays (wd) and
// weekends (we), over `days` days. Operator-declared status, not measured.
function cleanHistory(s, report) {
  const h = s.history;
  if (h == null) return;
  const pct = v => (Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined);
  const row = r => (Array.isArray(r) && r.length === 24 && r.every(v => v === null || pct(v) !== undefined) ? r : undefined);
  const days = Number.isFinite(h?.days) && h.days > 0 && h.days <= 400 ? h.days : undefined;
  const out = { down: pct(h?.down), days, busy: h?.busy && row(h.busy.wd) && row(h.busy.we) ? { wd: h.busy.wd, we: h.busy.we } : undefined };
  if (!days || (out.down === undefined && !out.busy)) { count(report, 'dropped history'); delete s.history; return; }
  s.history = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// Photos (nap-dashboard's charger_photos.py): a thumbnail it publishes next
// to the dataset (`src`, photos/<16 hex>.jpg), or only a link (Mapillary),
// with the author, the licence and the original's page, which the licence
// asks to credit. A photo whose source is not a plain https link goes.
const PHOTO_SRC = /^photos\/[0-9a-f]{16}\.jpg$/;
function cleanPhotos(list, max, report) {
  if (list == null) return undefined;
  const out = [];
  for (const x of Array.isArray(list) ? list.slice(0, 10) : []) {
    if (out.length >= max) break;
    const src = typeof x?.src === 'string' && PHOTO_SRC.test(x.src) ? x.src : undefined;
    let page;
    try { page = typeof x?.page === 'string' && new URL(x.page).protocol === 'https:' && x.page.length <= 300 ? x.page : undefined; } catch { page = undefined; }
    if (!src && !page) { count(report, 'dropped photos'); continue; }
    const credit = cleanText(x.credit, NAME_MAX) || undefined;
    const license = cleanText(x.license, TAG_MAX) || undefined;
    const taken = typeof x.taken === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.taken) ? x.taken : undefined;
    out.push(Object.fromEntries(Object.entries({ src, page, credit, license, taken }).filter(([, v]) => v !== undefined)));
  }
  return out.length ? out : undefined;
}

// The places a site is at (a shopping centre, a hospital...): OpenStreetMap
// names, so as open to edits as `osm`. A known set of types, an OSM element id,
// a distance in metres and a name that fits; anything else is dropped, and
// a site with no valid place has no `places`.
const PLACE_TYPES = new Set(['mall', 'hospital', 'university', 'airport', 'stadium', 'retail', 'supermarket', 'parking', 'hotel']);
const PLACES_MAX = 3;
const PLACE_DISTANCE_MAX = 1000;
function cleanPlaces(s, report) {
  if (s.places == null) return;
  const out = [];
  for (const x of Array.isArray(s.places) ? s.places.slice(0, 20) : []) {
    if (out.length >= PLACES_MAX) break;
    const name = cleanText(x?.name, NAME_MAX, () => count(report, 'cut places.name'));
    const ok = name && PLACE_TYPES.has(x.type) && /^(node|way|relation)\/\d{1,12}$/.test(x.osm)
      && Number.isInteger(x.m) && x.m >= 0 && x.m <= PLACE_DISTANCE_MAX;
    if (ok) out.push({ name, type: x.type, osm: x.osm, m: x.m });
    else count(report, 'dropped places');
  }
  if (out.length) s.places = out;
  else delete s.places;
}

// One line for the log: which limits the data hit, most hit first.
export function reportLine(report) {
  const rows = Object.entries(report).sort((a, b) => b[1] - a[1]).map(([what, n]) => `${what} ${n}`);
  return `[ohmigo] third-party limits: ${rows.join(', ') || 'nothing cut, dropped or ignored'}`;
}
