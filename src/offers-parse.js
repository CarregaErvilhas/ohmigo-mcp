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
// caption or zero rows throw, so a change in the blog's layout fails the
// weekly job loudly instead of quietly publishing wrong prices.

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

// html: the post body. Returns [{ caption, kind, bands: [key...], rows: [{ name, network, prices: { key: number|null } }] }]
export function parseTables(html) {
  const tables = [...html.matchAll(/<table\b[^>]*class="[^"]*evtable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi)].map(m => m[1]);
  const out = [];
  for (const t of tables) {
    // The blog also has a small "price vs fuel" scale table with the same
    // class. Price tables are the ones with an "Operador" column.
    if (!/Operador/i.test(t)) continue;
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
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => cells(m[1])).filter(r => r.length >= 2 && r[0]);
    if (!rows.length) throw new Error(`table "${caption}": no rows`);
    out.push({
      caption, kind, bands,
      rows: rows.map(([name, network, ...vals]) => ({
        name, network,
        // Some rows stop early (no trailing empty cells): missing = not offered.
        prices: Object.fromEntries(bands.map((k, i) => {
          const v = (vals[i] || '').replace(',', '.');
          return [k, v && Number.isFinite(Number(v)) ? Number(v) : null];
        })),
      })),
    });
  }
  if (!out.length) throw new Error('no price tables found');
  return out;
}

const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
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
export function toOffers(tables, networks, source) {
  const net = new Map(Object.entries(networks).map(([k, v]) => [fold(k), v]));
  const offers = [], unmapped = new Set(), skipped = [];
  for (const t of tables) {
    for (const r of t.rows) {
      const where = net.get(fold(r.network));
      if (!where) { unmapped.add(r.network); continue; }
      if (where.scope === 'unknown') { skipped.push(`${r.name} @ ${r.network}`); continue; }
      const { provider, plan } = splitName(r.name);
      const fee = t.kind === 'subscription' ? feeOf(r.name) : null;
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
