// Direct offers: what you pay at a charger OUTSIDE the CEME system.
//
// On MOBI.E the usual way to pay is a CEME card or app (energy) plus the
// operator's fee. But many chargers also take other ways, often cheaper:
//   - a walk-up card terminal (TPA) or QR code at the charger, no account;
//   - the operator's own app or subscription (IONITY Power, Atlante GO...);
//   - roaming apps (eMSPs) like Electroverse, Elli or Electromaps, which work
//     on some networks at their own price.
// No open data publishes these prices. We check the NAP: its brandsAccepted
// list is the same 54 CEMEs at every MOBI.E charger and its brandsAcceptedText
// is empty, so it only tells you whether a charger is on MOBI.E at all.
//
// So the offers come from two files in offers/:
//   custofinal.json  scraped every week from the blog "Preços (finais) kWh
//                    Portugal" (scripts/scrape-offers.mjs), which keeps a
//                    table of these prices per power band;
//   manual.json      hand-made corrections and additions, which win.
// networks.json says which chargers each offer applies to (by NAP operator
// id, or every MOBI.E charger).
//
// Prices are final (VAT included) per kWh, and depend on the charger's power:
// see bandFor() in offers-parse.js.

import { readFileSync } from 'node:fs';
import { bandFor } from './offers-parse.js';

export const STALE_DAYS = 90;

const read = name => JSON.parse(readFileSync(new URL(`../offers/${name}`, import.meta.url), 'utf8'));

// Applies manual.json on top of the scraped offers: same id = override the
// listed fields (prices merge band by band), `disable` = drop, new id = add.
export function mergeOffers(scraped, manual) {
  const byId = new Map(scraped.map(o => [o.id, { ...o }]));
  for (const m of manual) {
    const { why, disable, ...fields } = m;
    if (disable) { byId.delete(m.id); continue; }
    const base = byId.get(m.id);
    if (base) byId.set(m.id, { ...base, ...fields, prices: { ...base.prices, ...fields.prices }, origin: 'manual' });
    else byId.set(m.id, { ...fields, origin: 'manual' });
  }
  return [...byId.values()];
}

// Loaded once at boot: a change to the files means a redeploy, which is also
// what makes it go through review.
const scraped = read('custofinal.json');
export const SOURCE = scraped.source;
export const OFFERS = mergeOffers(scraped.offers, read('manual.json').offers);

const mobieWide = OFFERS.filter(o => o.scope.mobie);
const byOperator = new Map();
for (const o of OFFERS) for (const id of o.scope.operatorIds || []) {
  if (!byOperator.has(id)) byOperator.set(id, []);
  byOperator.get(id).push(o);
}

// Notes that the NAP's own price for some chargers is wrong (offers/nap-notes.json,
// hand-made like manual.json). Outside MOBI.E the NAP's price is shown as the
// operator's price unless a note here says otherwise; scope by operator id or
// by site id.
const NAP_NOTES = read('nap-notes.json').notes;
export const noteFor = (notes, site) => notes.find(n =>
  n.scope.siteIds?.includes(site.id) || n.scope.operatorIds?.includes(site.operatorId)) ?? null;
export const napNote = site => noteFor(NAP_NOTES, site);

export function isStale(offer, now = new Date()) {
  return (now - new Date(offer.checkedAt)) / 86_400_000 > STALE_DAYS;
}

// The offers that apply at this charge point, each with its €/kWh for the
// point's power band. MOBI.E-wide offers only apply to chargers on MOBI.E,
// and a provider's row for this specific network replaces its MOBI.E-wide
// row (the blog lists "Electroverse @ Rede Mobi.E" AND "Electroverse @ Ionity").
export function offersAt(site, point) {
  const band = bandFor(point);
  if (!band) return [];
  const own = byOperator.get(site.operatorId) || [];
  const ownLabels = new Set(own.map(o => o.label));
  const wide = point.regime !== 'sem_ceme' ? mobieWide.filter(o => !ownLabels.has(o.label)) : [];
  return [...own, ...wide]
    .map(offer => ({ offer, eurPerKwh: offer.prices[band] ?? offer.prices.all ?? null }))
    .filter(x => x.eurPerKwh != null);
}

// Does the operator of this site have its own walk-up price here? Then that
// price replaces MOBI.E's ad hoc one (the published offer is more current).
export const ownWalkUp = (site, at) => at.some(x => x.offer.walkUp && x.offer.scope.operatorIds?.includes(site.operatorId));

// Payment methods (from the NAP) that let you pay at the charger without a
// CEME account.
const DIRECT_PAYMENT = new Set(['creditCard', 'debitCard', 'nfc', 'pinpad', 'website']);

// Operators that show signs of selling directly but have no offer scoped to
// them, biggest first. Signals, per site: `card` = the NAP lists card / NFC /
// pinpad / website payment; `adhoc` = MOBI.E's file has an ad hoc price.
// Worth sending to the blog's author, or adding to manual.json.
export function gaps(sites) {
  const ops = new Map();
  for (const s of sites) {
    if (!s.operatorId || byOperator.has(s.operatorId)) continue;
    const o = ops.get(s.operatorId) || { operatorId: s.operatorId, names: new Set(), sites: 0, card: 0, adhoc: 0, website: null };
    o.sites++;
    if (s.operator) o.names.add(s.operator);
    if (s.payment?.some(m => DIRECT_PAYMENT.has(m))) o.card++;
    if (s.points.some(p => p.opc?.AD_HOC_PAYMENT)) o.adhoc++;
    o.website ||= s.website || null;
    ops.set(s.operatorId, o);
  }
  return [...ops.values()]
    .filter(o => o.card || o.adhoc)
    .map(o => ({ ...o, names: [...o.names] }))
    .sort((a, b) => b.sites - a.sites);
}
