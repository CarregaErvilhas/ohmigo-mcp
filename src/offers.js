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
// see bandFor() in offers-parse.js. Where an offer also bills per minute
// (`perMinute`, a list of bands) the blog gives no rate, so there it has no
// price: perMinuteAt() names it instead, and the estimates say it's left out.
// A rate someone read in the provider's app goes in manual.json as
// `minuteEur: { <band>: €/min }`, for just the bands it was seen at; then
// those bands are priced again, the minutes included.

import { readFileSync } from 'node:fs';
import { bandFor, bandPrice } from './offers-parse.js';
import { REGION_TZ } from './profile.js';
import { onNetwork } from './promos.js';

export const STALE_DAYS = 90;

const read = name => JSON.parse(readFileSync(new URL(`../offers/${name}`, import.meta.url), 'utf8'));

// Applies manual.json on top of the scraped offers: same id = override the
// listed fields (prices merge band by band), `disable` = drop, `add: true` =
// a new offer. An override or disable whose id isn't in the scrape (a typo,
// or the blog renamed the slug) is skipped and reported in `orphans`, never
// turned into a half-filled offer; test/offers.test.js fails on any, so the
// weekly scrape PR shows it. Skipped rather than thrown: a scrape that drops
// an offer must not stop the server from booting.
export function mergeOffers(scraped, manual) {
  const byId = new Map(scraped.map(o => [o.id, { ...o }]));
  const orphans = [];
  for (const m of manual) {
    const { why, disable, add, ...fields } = m;
    const base = byId.get(m.id);
    if (add) {
      if (base) orphans.push(`${m.id}: "add" but the scrape has it (make it an override)`);
      else byId.set(m.id, { ...fields, origin: 'manual' });
    } else if (!base) orphans.push(`${m.id}: ${disable ? 'disable' : 'override'} matches no scraped offer`);
    else if (disable) byId.delete(m.id);
    else byId.set(m.id, { ...base, ...fields, prices: { ...base.prices, ...fields.prices }, origin: 'manual' });
  }
  return Object.assign([...byId.values()], { orphans });
}

// Loaded once at boot: a change to the files means a redeploy, which is also
// what makes it go through review.
const scraped = read('custofinal.json');
export const SOURCE = scraped.source;
export const OFFERS = mergeOffers(scraped.offers, read('manual.json').offers);
for (const o of OFFERS.orphans) console.warn('[ohmigo] offers/manual.json:', o);

const mobieWide = OFFERS.filter(o => o.scope.mobie);
const byOperator = new Map();
for (const o of OFFERS) for (const id of o.scope.operatorIds || []) {
  if (!byOperator.has(id)) byOperator.set(id, []);
  byOperator.get(id).push(o);
}

// Prices only some people can get (offers/audiences.json): an offer or a
// CEME tariff with an `audience` is hidden unless the driver said they
// belong to it. Without this, an EDP employee's price would headline every
// EDP charger for everyone.
export const AUDIENCES = read('audiences.json').audiences;
export const forAudiences = (x, audiences = []) => !x.audience || audiences.includes(x.audience);

// Notes that the NAP's own price for some chargers is wrong (offers/nap-notes.json,
// hand-made like manual.json). Outside MOBI.E the NAP's price is shown as the
// operator's price unless a note here says otherwise; scope by operator id or
// by site id.
export const NAP_NOTES = read('nap-notes.json').notes;
export const noteFor = (notes, site) => notes.find(n =>
  n.scope.siteIds?.includes(site.id) || n.scope.operatorIds?.includes(site.operatorId)) ?? null;
export const napNote = site => noteFor(NAP_NOTES, site);

export function isStale(offer, now = new Date()) {
  return (now - new Date(offer.checkedAt)) / 86_400_000 > STALE_DAYS;
}

// A launch promotion ends on a set day (Telpark's 15 % until 31 Dec), and
// the regular price starts the day after: manual.json gives the two as two
// offers, one with `until`, one with `from` (both YYYY-MM-DD, inclusive, the
// charge's civil day where the charger is). Picked by the day the charge
// starts, so a trip planned for January gets January's price.
const dayFmt = new Map();
export function civilDay(at, region) {
  const tz = REGION_TZ[region] || REGION_TZ.CONT;
  if (!dayFmt.has(tz)) dayFmt.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return dayFmt.get(tz).format(at);
}
export const activeOn = (offer, day) => (!offer.from || day >= offer.from) && (!offer.until || day <= offer.until);

// The offers that apply at this charge point on the day of `at`, each with
// its €/kWh for the point's power band. MOBI.E-wide offers only apply to chargers on MOBI.E,
// and a provider's row for this specific network replaces its MOBI.E-wide
// row (the blog lists "Electroverse @ Rede Mobi.E" AND "Electroverse @ Ionity").
// Offers for an audience the driver didn't claim are left out.
// Each with eurPerMin when it bills per minute at this power.
export function offersAt(site, point, audiences = [], at = new Date()) {
  const band = bandFor(point);
  return candidates(site, point, audiences, at)
    .filter(offer => !unpricedMinutes(offer, band))
    .map(offer => ({ offer, eurPerKwh: bandPrice(offer.prices, band), ...(offer.minuteEur?.[band] && { eurPerMin: offer.minuteEur[band] }), ...extras(offer, site, at) }))
    .filter(x => x.eurPerKwh != null);
}

// What an offer gives besides its price, on the day of the charge. Neither
// changes the total, so each one comes with the sentence that says so.
//   cashback   part of what you pay comes back as credit in the provider's
//              app, to spend on later charges (Atlante's ChargeBack, paid in
//              GreenGems). manual.json lists `cashback` as rows of { pct,
//              network?, from?, until?, spendAt }: the first row active that
//              day whose network (a label of networks.json, none = any
//              charger) holds this site wins, so a campaign that doubles it
//              for a few days goes first. Credit isn't money: you only get it
//              back by charging there again, so it's never off the total.
//   signupFee  a lower subscription fee for whoever signs up between `from`
//              and `until` (`locked`: kept while the subscription stays on).
//              Only a tip: the fee is never in the total, and the driver who
//              already pays the regular one doesn't get it. Shown up to its
//              last day.
function extras(offer, site, at) {
  const day = civilDay(at, site.region);
  const cashback = (offer.cashback || []).find(c => activeOn(c, day) && onNetwork(site, c.network ?? null));
  const signup = offer.signupFee && day <= offer.signupFee.until ? offer.signupFee : null;
  return { ...(cashback && { cashback }), ...(signup && { signupFee: signup }) };
}

// Billed per minute at this power, and nobody has given us the rate.
export const unpricedMinutes = (offer, band) => !!offer.perMinute?.includes(band) && offer.minuteEur?.[band] == null;

// The offers that apply here but bill per minute on top of the kWh at this
// power, at a rate nobody publishes: [{ offer }]. Same rules as offersAt().
export function perMinuteAt(site, point, audiences = [], at = new Date()) {
  const band = bandFor(point);
  return candidates(site, point, audiences, at)
    .filter(offer => unpricedMinutes(offer, band))
    .map(offer => ({ offer }));
}

function candidates(site, point, audiences, at) {
  if (!bandFor(point)) return [];
  const day = civilDay(at, site.region);
  const own = (byOperator.get(site.operatorId) || []).filter(o => activeOn(o, day));
  const ownLabels = new Set(own.map(o => o.label));
  const wide = point.regime !== 'sem_ceme' ? mobieWide.filter(o => !ownLabels.has(o.label) && activeOn(o, day)) : [];
  return [...own, ...wide].filter(o => forAudiences(o, audiences));
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
