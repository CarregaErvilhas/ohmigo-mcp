// Reads the price tables from the "Preços (finais) kWh Portugal" blog
// (custofinal.blogspot.com) into offers ohmigo can price with.
//
// Why this blog: no open data publishes what operators and roaming apps
// (eMSPs) charge outside the CEME system: walk-up card terminals (TPA), QR
// codes, apps like Electroverse or Elli, subscriptions like IONITY Power. The
// blog's author keeps a table of them, final prices with VAT, per charging
// power band, and publishes a new post every few weeks.
//
// Each post has two tables, told apart by their <caption>:
//   "Sem promoções ou subscrições pagas"  -> pay as you go
//   "Subscrições pagas"                    -> subscriptions (fee in the plan name)
// Columns: "Operador - Plano" | "Postos" (which chargers it works at) | one
// €/kWh price per power band (AC ≤7.4, AC 11..22, DC ≤50 ... DC >180). An empty
// cell means the offer doesn't apply at that power.
//
// This file only parses. scripts/scrape-offers.mjs fetches the post and
// writes offers/custofinal.json; src/offers.js loads it.
//
// The parser is strict on purpose: an unknown column header, a missing
// caption, zero rows, a price cell that isn't a number or a row that fails
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

// The price post to read: the newest by publication date, of the posts with
// the blog's tables. Not by `updated`: an author fixing a typo in a months-old
// post would make its old prices look like the latest ones. Any such table
// counts, not only one that parses: a new post in a new layout has to fail in
// parseTables, not fall back quietly to last month's prices.
export function newestPost(entries) {
  return entries
    .filter(e => /class="[^"]*\bevtable\b/.test(e.content?.$t || ''))
    .sort((a, b) => Date.parse(b.published.$t) - Date.parse(a.published.$t))[0];
}

// One price cell, "0,41" -> 0.41. Empty (or missing) means not offered at this
// power; anything else that isn't a number is a table we can't read.
function priceOf(cell = '', name) {
  if (!cell) return null;
  const v = cell.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`offer ${JSON.stringify(name)}: price "${cell}" is not a number`);
  return Number(v);
}

// Header label -> band key. The bands are the blog's; see bandFor().
export const BANDS = {
  '≤7.4': 'ac7', '11..22': 'ac22',
  '≤50': 'dc50', '100': 'dc100', '120': 'dc120', '150': 'dc150', '180': 'dc180', '>180': 'dcMax',
};

const decode = s => s
  .replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&le;/g, '≤').replace(/&ge;/g, '≥').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const cells = rowHtml => [...rowHtml.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => decode(m[1]));

// The bodies of the post's price tables. The blog also has a small "price vs
// fuel" scale table with the same class; price tables are the ones with an
// "Operador" column.
const priceTables = html => [...html.matchAll(/<table\b[^>]*class="[^"]*evtable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)]
  .map(m => m[1]).filter(t => /Operador/i.test(t));

// html: the post body. Returns [{ caption, kind, bands: [key...], rows: [{ name, network, prices: { key: number|null } }] }]
export function parseTables(html) {
  const out = [];
  for (const t of priceTables(html)) {
    const caption = decode(t.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || '');
    if (!caption) throw new Error('price table without a caption');
    const kind = /subscri[çc][õo]es pagas/i.test(caption) && !/sem\b/i.test(caption) ? 'subscription' : 'payg';
    const head = t.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1];
    if (!head) throw new Error(`table "${caption}": no <thead>`);
    // The band labels are the cells of the LAST header row.
    const headRows = [...head.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => cells(m[1]));
    const bands = headRows.at(-1).map(label => {
      const key = BANDS[label];
      if (!key) throw new Error(`table "${caption}": unknown power band "${label}"`);
      return key;
    });
    const body = t.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || '';
    // Cells map to bands by position, so a merged one would shift the prices.
    if (/<t[hd]\b[^>]*\b(?:col|row)span=/i.test(body)) throw new Error('a price row has merged cells');
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => cells(m[1])).filter(r => r.length >= 2 && r[0]);
    if (!rows.length) throw new Error(`table "${caption}": no rows`);
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
        return { name, network, prices: Object.fromEntries(bands.map((k, i) => [k, priceOf(vals[i], name)])) };
      }),
    });
  }
  if (!out.length) throw new Error('no price tables found');
  return out;
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
  if (!point.dc) return kw <= 7.4 ? 'ac7' : 'ac22';
  if (kw <= 50) return 'dc50';
  if (kw <= 100) return 'dc100';
  if (kw <= 120) return 'dc120';
  if (kw <= 150) return 'dc150';
  if (kw <= 180) return 'dc180';
  return 'dcMax';
}
