// Reads the price tables from the "Preços (finais) kWh Portugal" blog
// (custofinal.blogspot.com) into offers ohmigo can price with.
//
// Why this blog: no open data publishes what operators and roaming apps
// (eMSPs) charge outside the CEME system: walk-up card terminals (TPA), QR
// codes, apps like Electroverse or Elli, subscriptions like IONITY Power. The
// blog's author keeps a table of them, final prices with VAT, per charging
// power band, and publishes a new post every few weeks.
//
// A price list post has two tables, told apart by their <caption>:
//   "Sem promoções ou subscrições pagas"  -> pay as you go
//   "Subscrições pagas"                    -> subscriptions (fee in the plan name)
// Columns: "Operador - Plano" | "Postos" (which chargers it works at) | one
// €/kWh price per power band (AC ≤7.4, AC 11..22, DC ≤50 ... DC >180). An empty
// cell means the offer doesn't apply at that power.
//
// Between two price lists the author sometimes posts a notice about one
// provider: one table, no caption, the provider's name in a cell spanning its
// rows (rowspan), finer AC bands (11 / 22 / 43) and, where the provider bills
// per minute on top of the kWh, a "⚡️+🕘" cell instead of a price (the
// Electroverse notice of 22 Nov 2026). The notice's rows replace that
// provider's pay-as-you-go rows of the list; see pricePosts() and
// applyNotices().
//
// This file only parses. scripts/scrape-offers.mjs fetches the post and
// writes offers/custofinal.json; src/offers.js loads it.
//
// The parser is strict on purpose: an unknown column header, a price list
// table without a caption, zero rows, a price cell that isn't a number or a row that fails
// offerProblems() throw, so a change in the blog's layout (or a typo in it)
// fails the weekly job loudly instead of quietly publishing wrong prices.

import { fold } from './text.js';

// Where every scraped offer must come from.
export const BLOG_HOST = 'custofinal.blogspot.com';

// What a final price can plausibly be, in €/kWh. Wide on purpose: this is not
// a judgement on the market, it catches a lost decimal comma (41 for 0,41) or
// a wrong unit. A person still reads every price change in the pull request.
export const MIN_EUR_PER_KWH = 0.05;
export const MAX_EUR_PER_KWH = 2;
// The same idea for a price per minute (minuteEur, from manual.json).
export const MAX_EUR_PER_MIN = 1;
// Labels are shown to assistants and to people, so one that's suddenly a
// paragraph isn't an operator name any more.
export const MAX_LABEL_LENGTH = 100;

// Control characters, invisible format characters (a right-to-left override
// makes text read differently from what it says), the brackets of a tag that
// survived decoding, or an entity decode() doesn't know.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}<>]|&[#\w]+;/u;

// Everything wrong with an offer, as sentences (none = sane). Checks only the
// fields it's given: the parser and toOffers() each pass the part they check,
// and a manual.json override lists just what it changes. `hosts`: where its source may be.
export function offerProblems(offer, hosts = [BLOG_HOST]) {
  const problems = [];
  for (const field of ['label', 'provider', 'plan', 'network']) {
    const text = offer[field];
    if (text == null) continue;
    if (typeof text !== 'string') problems.push(`${field} is not text`);
    else if (text.length > MAX_LABEL_LENGTH) problems.push(`${field} is too long (${text.length}, at most ${MAX_LABEL_LENGTH})`);
    else if (UNSAFE_TEXT.test(text)) problems.push(`${field} ${JSON.stringify(text)} has control or format characters, angle brackets or entities`);
  }
  if ('perMinute' in offer && !(Array.isArray(offer.perMinute) && offer.perMinute.every(b => BAND_KEYS.has(b)))) {
    problems.push(`perMinute ${JSON.stringify(offer.perMinute)} is not a list of power bands`);
  }
  for (const [band, eur] of Object.entries(offer.minuteEur || {})) {
    if (!BAND_KEYS.has(band)) problems.push(`minuteEur: "${band}" is not a power band`);
    if (!(typeof eur === 'number' && eur > 0 && eur <= MAX_EUR_PER_MIN)) problems.push(`minuteEur.${band} ${eur} is not between 0 and ${MAX_EUR_PER_MIN} €/min`);
  }
  for (const [band, price] of Object.entries(offer.prices || {})) {
    if (price === null) continue;
    if (typeof price !== 'number' || !(price >= MIN_EUR_PER_KWH && price <= MAX_EUR_PER_KWH)) {
      problems.push(`${band} price ${price} is out of bounds (${MIN_EUR_PER_KWH} to ${MAX_EUR_PER_KWH} €/kWh)`);
    }
  }
  if ('source' in offer) {
    const url = URL.parse(offer.source);
    if (url?.protocol !== 'https:' || !hosts.includes(url.host)) problems.push(`source ${offer.source} is not https on ${hosts.join(' or ')}`);
  }
  return problems;
}

function assertSane(offer) {
  const problems = offerProblems(offer);
  if (problems.length) throw new Error(`offer ${JSON.stringify(offer.label)}: ${problems.join('; ')}`);
}

const hasTable = e => /class="[^"]*\bevtable\b/.test(e.content?.$t || '');
// A price list has the pay-as-you-go table, by its caption; a notice doesn't.
const isPriceList = e => /<caption\b[^>]*>[^<]*Sem promo[çc][õo]es/i.test(e.content?.$t || '');
const published = e => Date.parse(e.published.$t);

// The posts to read: the newest price list, and the posts with the blog's
// tables published after it (notices, oldest first). By publication date, not
// by `updated`: an author fixing a typo in a months-old post would make its
// old prices look like the latest ones. Any newer post with such a table
// counts as a notice, not only one that parses: a new post in a new layout has
// to fail in parseTables or applyNotices, not fall back quietly to last
// month's prices.
export function pricePosts(entries) {
  const list = entries.filter(isPriceList).sort((a, b) => published(b) - published(a))[0];
  if (!list) return { list: undefined, notices: [] };
  const notices = entries.filter(e => hasTable(e) && e !== list && published(e) > published(list))
    .sort((a, b) => published(a) - published(b));
  return { list, notices };
}

// A notice's cell for "kWh + minutes" ("⚡️+🕘"): billed per minute on top of the
// energy, at a rate the blog doesn't give.
const PER_MINUTE = /🕘/u;

// One price cell, "0,41" -> 0.41. Empty (or missing) means not offered at this
// power; anything else that isn't a number is a table we can't read.
function priceOf(cell = '', name) {
  if (!cell || PER_MINUTE.test(cell)) return null;
  const v = cell.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`offer ${JSON.stringify(name)}: price "${cell}" is not a number`);
  return Number(v);
}

// Header label -> band key. The bands are the blog's; see bandFor(). The
// price list has one column for all AC above 7.4 kW ("11..22", key ac22); a
// notice splits it into 11, 22 and 43 (ac11, ac22, ac43), and an offer without
// ac11 or ac43 uses its ac22 price there (bandPrice()).
export const BANDS = {
  '≤7.4': 'ac7', '11..22': 'ac22', '11': 'ac11', '22': 'ac22', '43': 'ac43',
  '≤50': 'dc50', '100': 'dc100', '120': 'dc120', '150': 'dc150', '180': 'dc180', '>180': 'dcMax',
};
const BAND_KEYS = new Set(Object.values(BANDS));

const decode = s => s
  .replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&le;/g, '≤').replace(/&ge;/g, '≥').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const cells = rowHtml => [...rowHtml.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => decode(m[1]));

// The body rows as lists of cell texts. Cells map to bands by position, so a
// merged cell would shift the prices: the only one allowed is a notice's
// provider name spanning its rows (rowspan on the first cell), which is
// copied into each of them. Any other rowspan or colspan throws.
function bodyRows(body) {
  const out = [];
  let carry = null; // { name, left }
  for (const [, row] of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const raw = [...row.matchAll(/<t[hd]\b([^>]*)>([\s\S]*?)<\/t[hd]>/gi)];
    raw.forEach(([, attrs], i) => {
      if (/\bcolspan=/i.test(attrs) || (/\browspan=/i.test(attrs) && (i > 0 || carry))) throw new Error('a price row has merged cells');
    });
    const texts = raw.map(m => decode(m[2]));
    if (carry) {
      texts.unshift(carry.name);
      if (--carry.left === 0) carry = null;
    } else {
      const span = Number(raw[0]?.[1].match(/\browspan="?(\d+)/i)?.[1] || 1);
      if (span > 1) carry = { name: texts[0], left: span - 1 };
    }
    out.push(texts);
  }
  if (carry) throw new Error(`"${carry.name}" spans more rows than the table has`);
  return out;
}

// The bodies of the post's price tables. The blog also has a small "price vs
// fuel" scale table with the same class; price tables are the ones with an
// "Operador" column.
const priceTables = html => [...html.matchAll(/<table\b[^>]*class="[^"]*evtable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)]
  .map(m => m[1]).filter(t => /Operador/i.test(t));

// html: the post body. Returns [{ caption, kind, bands: [key...], rows: [{ name, network, prices: { key: number|null }, perMinute?: [key...] }] }]
// notice: the post is a notice (pricePosts()), whose table has no caption and
// is pay as you go; a price list's tables must have one.
export function parseTables(html, { notice = false } = {}) {
  const out = [];
  for (const t of priceTables(html)) {
    const caption = decode(t.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || '');
    if (!caption && !notice) throw new Error('price table without a caption');
    const kind = /subscri[çc][õo]es pagas/i.test(caption) && !/sem\b/i.test(caption) ? 'subscription' : 'payg';
    const name = caption || 'notice';
    const head = t.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1];
    if (!head) throw new Error(`table "${name}": no <thead>`);
    // The band labels are the cells of the LAST header row.
    const headRows = [...head.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => cells(m[1]));
    const bands = headRows.at(-1).map(label => {
      const key = BANDS[label];
      if (!key) throw new Error(`table "${name}": unknown power band "${label}"`);
      return key;
    });
    if (new Set(bands).size !== bands.length) throw new Error(`table "${name}": a power band twice`);
    const body = t.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || '';
    const rows = bodyRows(body).filter(r => r.length >= 2 && r[0]);
    if (!rows.length) throw new Error(`table "${name}": no rows`);
    out.push({
      caption, kind, bands,
      rows: rows.map(([name, network, ...vals]) => {
        // Some rows stop early (no trailing empty cells): missing = not offered.
        // Too many cells can't be read: we couldn't tell which one is extra,
        // so the prices could land in the wrong power bands.
        if (vals.length > bands.length) throw new Error(`offer ${JSON.stringify(name)}: ${vals.length} price cells for ${bands.length} power bands`);
        // Labels are checked on every row: the ones toOffers() leaves out still
        // reach the pull request through `unmapped` and `skipped`.
        assertSane({ label: name, network });
        // A notice is pay as you go: a fee in a name means a subscription,
        // which we couldn't tell apart from the list's own subscription rows.
        if (notice && feeOf(name)) throw new Error(`notice: offer ${JSON.stringify(name)} has a fee in its name`);
        const perMinute = bands.filter((k, i) => PER_MINUTE.test(vals[i] || ''));
        return { name, network, prices: Object.fromEntries(bands.map((k, i) => [k, priceOf(vals[i], name)])), ...(perMinute.length && { perMinute }) };
      }),
    });
  }
  if (!out.length) throw new Error('no price tables found');
  return out;
}

// Lays the notices over the price list. posts: [{ tables, source }], the
// list first, then the notices oldest first (pricePosts()). Each notice's rows
// replace every pay-as-you-go row with the same "Operador - Plano" label in
// the posts before it; the provider's subscription rows stay. Every label in
// a notice must already be a pay-as-you-go label there: anything else is a
// new kind of post, which a person has to read. Returns the same list with
// the replaced rows taken out, plus what each notice replaced, for the log.
export function applyNotices([list, ...notices]) {
  const out = [{ ...list }];
  const replaced = [];
  for (const n of notices) {
    const labels = new Set(n.tables.flatMap(t => t.rows.map(r => fold(r.name))));
    const known = new Set(out.flatMap(p => p.tables.filter(t => t.kind === 'payg').flatMap(t => t.rows.map(r => fold(r.name)))));
    for (const l of labels) if (!known.has(l)) throw new Error(`notice ${n.source.url}: "${l}" is not a pay-as-you-go offer of the price list`);
    for (const p of out) p.tables = p.tables.map(t => t.kind !== 'payg' ? t : { ...t, rows: t.rows.filter(r => !labels.has(fold(r.name))) });
    out.push({ ...n });
    replaced.push({ url: n.source.url, labels: [...new Set(n.tables.flatMap(t => t.rows.map(r => r.name)))] });
  }
  return { posts: out, replaced };
}

const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "Atlante - App MyAtlante" -> { provider: "Atlante", plan: "App MyAtlante" }
// "Electroverse"            -> { provider: "Electroverse", plan: "" }
function splitName(name) {
  const i = name.indexOf(' - ');
  return i < 0 ? { provider: name, plan: '' } : { provider: name.slice(0, i).trim(), plan: name.slice(i + 3).trim() };
}

// "Atlante GO 8€/mês" -> { eur: 8, per: 'month' }
function feeOf(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*€\s*\/\s*(m[eê]s|ano)/i);
  return m ? { eur: Number(m[1].replace(',', '.')), per: /ano/i.test(m[2]) ? 'year' : 'month' } : null;
}

// Turns the parsed tables into offers, using networks.json to say which
// chargers each "Postos" label means. Labels missing from networks.json are
// returned in `unmapped` and left out: a human has to say what they mean.
// Only rows that ship get their prices checked, so a typo in a row left out
// doesn't hold back the rest of the update.
export function toOffers(tables, networks, source) {
  const [badSource] = offerProblems({ source: source.url });
  if (badSource) throw new Error(badSource);
  const net = new Map(Object.entries(networks).map(([k, v]) => [fold(k), v]));
  const offers = [], unmapped = new Set(), skipped = [];
  for (const t of tables) {
    for (const r of t.rows) {
      const where = net.get(fold(r.network));
      if (!where) { unmapped.add(r.network); continue; }
      if (where.scope === 'unknown') { skipped.push(`${r.name} @ ${r.network}`); continue; }
      const { provider, plan } = splitName(r.name);
      const fee = t.kind === 'subscription' ? feeOf(r.name) : null;
      assertSane({ label: r.name, prices: r.prices });
      offers.push({
        id: slug(`${r.name} ${r.network}`),
        label: r.name, provider, plan, network: r.network,
        scope: where.scope === 'mobie' ? { mobie: true } : { operatorIds: where.operatorIds },
        // TPA = card terminal at the charger, QR = scan and pay: no account.
        walkUp: /\b(TPA|QR ?code)\b/i.test(plan),
        subscription: t.kind === 'subscription',
        fee,
        prices: r.prices,
        ...(r.perMinute && { perMinute: r.perMinute }),
        source: source.url, checkedAt: source.checkedAt, origin: source.origin,
      });
    }
  }
  return { offers, unmapped: [...unmapped], skipped };
}

// The blog's band for a charge point.
export function bandFor(point) {
  const kw = point.kw;
  if (kw == null) return null;
  // 11.04 / 22.08 kW (16 / 32 A three-phase) count as 11 / 22.
  if (!point.dc) return kw <= 7.4 ? 'ac7' : kw <= 11.5 ? 'ac11' : kw <= 22.5 ? 'ac22' : 'ac43';
  if (kw <= 50) return 'dc50';
  if (kw <= 100) return 'dc100';
  if (kw <= 120) return 'dc120';
  if (kw <= 150) return 'dc150';
  if (kw <= 180) return 'dc180';
  return 'dcMax';
}

// An offer's price in a band: null = not offered there. ac11 and ac43 are
// only in notices; an offer that doesn't list them (the price list's
// "11..22" column, manual.json) uses its ac22 price, as before they existed.
export function bandPrice(prices, band) {
  const own = band in prices ? prices[band] : band === 'ac11' || band === 'ac43' ? prices.ac22 : undefined;
  return own ?? prices.all ?? null;
}
