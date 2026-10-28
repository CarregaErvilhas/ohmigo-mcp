// What a session costs at one charger, for every way the user could pay.
//
// This is where the pieces meet:
//   charging.js  -> how many kWh and minutes
//   ceme.js      -> the energy part, from ceme-v2 (one call, all CEME tariffs)
//   opc.js       -> the charger operator's fee
//   operators.js -> operators' own direct prices (offers/operator-offers.json)
//   live.js      -> live status and, as a fallback, the operator fee from the NAP
//
// Each way to pay becomes one entry in `options`, tagged with a `kind`:
//   ceme         pay through a CEME card/app on MOBI.E:
//                ceme-v2's total (energy + TAR + taxes + VAT) + OPC fee + VAT on it
//   adhoc        bank card / QR at the charger, no CEME: MOBI.E's AD_HOC_PAYMENT price
//   operator     the operator's own app / walk-up / subscription (offers/operator-offers.json)
//   opc_direct   chargers outside MOBI.E (Continente, Tesla): the NAP's single
//                price, with an asterisk because nobody says what it covers
// New ways to pay (CEME subscriptions, eMSP flat prices) slot in as new kinds.
//
// Two summary fields:
//   headline  the CEME option shown first (the user's cheapest tariff, or the
//             cheapest popular one that needs no other contract).
//   best      the cheapest option ANYONE can pay right now: no subscription
//             fee, no other contract, no asterisk. Chargers are ranked by it,
//             so an IONITY whose own app beats every CEME ranks where it should.

import { applicable, simulate } from './ceme.js';
import { estimateSession } from './charging.js';
import { translator } from './i18n.js';
import { napPlan } from './live.js';
import { describePlan, opcCost } from './opc.js';
import { isStale, offersFor } from './operators.js';

const r2 = x => Math.round(x * 100) / 100;

// ceme-v2 tariff ids are `ceme-voltage-name`, e.g. "edp-bt-cartoedp-4". Each
// tariff exists twice, for low (bt) and medium (mt) voltage chargers, and the
// user doesn't care which. Dropping the voltage gives the "same tariff" key.
export const tariffKey = id => id.replace(/-(bt|mt)-/, '-');

export const DEFAULT_SHOWN = 3;

// Which CEME tariffs to price at this point, cheapest first.
//   - The user's own tariffs (cards/subscriptions they told their assistant
//     about): every one of them that applies here.
//   - Otherwise the top `shown` of ceme-v2's "popular" filter. The headline is
//     the cheapest one without conditions, so a price that needs another
//     contract (home electricity client, club member...) is never "the" price.
// The same card in two cycles often has the same price: shown once.
export function pickTariffs(quotes, point, tariffIds, shown = DEFAULT_SHOWN) {
  const ok = applicable(quotes, point);
  const best = ok[0] || null;
  if (tariffIds?.length) {
    const want = new Set(tariffIds.map(tariffKey));
    const options = ok.filter(t => want.has(tariffKey(t.id)));
    return { options, headline: options[0] || null, best, missing: !options.length };
  }
  const seen = new Set();
  const options = ok.filter(t => {
    if (!t.popular) return false;
    const k = `${t.ceme}|${t.name}|${t.totalEur}`;
    return !seen.has(k) && seen.add(k);
  }).slice(0, shown);
  const headline = options.find(t => !t.bundle) || ok.find(t => !t.bundle) || best;
  return { options, headline, best, missing: false };
}

const cemeOption = (t, opcWithVat) => ({
  kind: 'ceme', label: `${t.ceme} · ${t.name}`, total: r2(t.totalEur + opcWithVat),
  tariffId: t.id, ceme: t.ceme, name: t.name, tariffKind: t.kind, period: t.period,
  requiresOtherContract: !!t.bundle, energyEur: t.totalEur,
});

// The OPC fee plan for a point and where it came from. MOBI.E's tariff file
// first (it has the per-minute tiers); the NAP live feed when the socket is
// missing from it.
function feePlan(point, live) {
  if (point.opc?.REGULAR) return { plan: point.opc.REGULAR, source: 'mobie' };
  const lp = live && napPlan(live.fees);
  if (lp) return { plan: lp, source: 'nap' };
  return { plan: null, source: null };
}

function adhocOption(point, session, t) {
  const plan = point.opc?.AD_HOC_PAYMENT;
  if (!plan) return null;
  const c = opcCost(plan, { kwh: session.kwh, minutes: session.minutes });
  return {
    kind: 'adhoc', label: t('option.adhoc'),
    total: r2(c.high), low: r2(c.low), high: r2(c.high),
    tariff: describePlan(plan, t, { vat: false }),
    note: t('option.adhoc.note'),
  };
}

// The operator's own plans: kWh x price. A subscription's fee is listed, not
// added, since it's shared by every session in the month/year.
function operatorOptions(offer, session, t) {
  return offer.plans.map(p => ({
    kind: 'operator', planId: p.id, label: p.name[t.lang] || p.name.en,
    total: r2(p.eurPerKwh * session.kwh), eurPerKwh: p.eurPerKwh, walkUp: !!p.walkUp,
    subscription: p.fee ? { ...p.fee, text: t('option.operatorPlan.fee', p.fee) } : null,
    note: t('option.operatorPlan.note', { source: offer.source, checked: offer.checkedAt })
      + (isStale(offer) ? ` ${t('option.operatorPlan.stale')}` : ''),
    stale: isStale(offer),
  }));
}

// Quotes one point. `simCache` lets a caller ranking many points share the
// ceme-v2 call: the billed kWh only differs between AC and DC (different
// losses), so a whole ranking needs one or two calls.
export async function quotePoint({ site, point }, car, { at, tariffIds, shown, live, lang, simCache = new Map() } = {}) {
  const t = translator(lang);
  const session = estimateSession(point, car, t);
  const lp = live?.get(site.id, point.id) ?? null;
  const base = {
    pointId: `${site.id}/${point.id}`, siteId: site.id, code: site.code,
    operator: site.operator, address: site.address, city: site.city,
    lat: site.lat, lon: site.lon, region: site.region,
    kw: point.kw, connector: point.connector, dc: point.dc, regime: point.regime,
    status: lp?.status ?? null,
    session: {
      kwhBilled: r2(session.kwh), kwhToBattery: r2(session.batteryKwh),
      minutes: Math.round(session.minutes), peakKw: session.peakKw, targetPct: session.targetPct,
    },
    assumptions: [...session.assumptions],
    options: [],
  };
  const offer = offersFor(site);

  if (point.regime === 'sem_ceme') {
    // Outside MOBI.E: no CEME, the operator bills directly. The NAP has one
    // pricePerDeliveryUnit with nothing saying whether it's the final price.
    // We estimate as if it were a final €/kWh and mark it, and the ranking
    // never mixes these with MOBI.E.
    const nap = lp ? lp.fees.find(f => f.policy === 'pricePerDeliveryUnit')?.eur : point.napPrice;
    if (offer) base.options.push(...operatorOptions(offer, session, t));
    else if (nap != null) {
      base.options.push({ kind: 'opc_direct', label: t('option.opcDirect', { operator: site.operator ?? 'Operator' }),
        total: r2(nap * session.kwh), asterisk: true, note: t('option.opcDirect.note', { price: t.num(nap) }) });
    }
    const first = base.options[0];
    base.total = first ? { eur: first.total, complete: false, asterisk: first.kind === 'opc_direct' } : null;
    base.best = bestOption(base.options, null);
    base.note = t('note.outside');
    return base;
  }

  // An operator whose own walk-up price is in the offers file replaces
  // MOBI.E's ad-hoc price: the operator's announcement is the better source
  // (IONITY: MOBI.E's file says 0.51 €/kWh, IONITY itself says 0.63).
  const ownWalkUp = offer?.plans.some(p => p.walkUp);
  const adhoc = ownWalkUp ? null : adhocOption(point, session, t);
  const key = `${base.region}|${Math.round(session.kwh * 10)}`;
  if (!simCache.has(key)) simCache.set(key, simulate({ kwh: session.kwh, at, region: base.region }));
  const sim = await simCache.get(key);
  const picked = pickTariffs(sim.data, point, tariffIds, shown);
  const ceme = picked.headline;
  const extras = [...(adhoc ? [adhoc] : []), ...(offer ? operatorOptions(offer, session, t) : [])];
  if (!ceme) {
    base.total = null;
    base.note = picked.missing ? t('note.noUserTariff') : t('note.noTariff');
    base.options.push(...extras);
    base.best = bestOption(base.options, null);
    return base;
  }
  if (point.level == null) base.assumptions.push(t('assume.levelUnknown'));

  const vat = ceme.vat; // the region's VAT multiplier, e.g. 1.23 on the mainland
  const { plan, source } = feePlan(point, lp);
  let opc = { low: 0, high: 0, parts: null };
  if (plan) opc = opcCost(plan, { kwh: session.kwh, minutes: session.minutes });
  else base.assumptions.push(t('assume.noFee'));
  if (source === 'nap') base.assumptions.push(t('assume.napFee'));
  if (opc.low !== opc.high) base.assumptions.push(t('assume.feeRange'));
  if (plan?.time?.length) base.assumptions.push(t('assume.perMinute'));

  const opcVat = opc.high * vat;
  const low = r2(ceme.totalEur + opc.low * vat), high = r2(ceme.totalEur + opcVat);
  // complete: false when the operator fee is unknown, so the total is only
  // the energy part. Rankings put these after the complete ones.
  base.total = { eur: high, low, high, complete: !!plan };
  base.eurPerKwh = session.batteryKwh > 0 ? r2(high / session.batteryKwh) : null;
  base.headline = cemeOption(ceme, opcVat);
  base.opc = {
    tariff: plan ? describePlan(plan, t) : null, source,
    eurExVat: r2(opc.high), eurWithVat: r2(opcVat),
    parts: opc.parts && Object.fromEntries(Object.entries(opc.parts).map(([k, v]) => [k, r2(v.high)])),
  };
  base.options = picked.options.map(o => cemeOption(o, opcVat));
  if (!base.options.some(o => o.tariffId === ceme.id)) base.options.unshift(base.headline);
  if (picked.best && !picked.options.some(o => o.id === picked.best.id) && picked.best.totalEur < ceme.totalEur) {
    base.options.push({ ...cemeOption(picked.best, opcVat), cheaperElsewhere: true });
  }
  base.options.push(...extras);
  base.best = bestOption(base.options, base.total);
  base.omieSpotEurKwh = sim.omieSpot?.eurKwh ?? null;
  base.pricedAt = sim.at;
  return base;
}

// The cheapest option open to anyone. A CEME option only counts when its
// total is complete (operator fee known).
function bestOption(options, total) {
  const open = options.filter(o => !o.requiresOtherContract && !o.subscription && !o.asterisk
    && (o.kind !== 'ceme' || total?.complete));
  return open.reduce((a, o) => (a && a.total <= o.total ? a : o), null);
}

// Statuses where a car can plug in now. "unknown" stays in (a lot of the
// network reports it), the rest are out.
const USABLE = new Set(['available', 'unknown', null]);

// Ranked by `best`. Without one (operator fee unknown, or only a guessed
// price), the energy-only total goes after all the complete ones, and points
// with no price at all go last.
const sortKey = q => q.best ? q.best.total : q.total ? 1e6 + q.total.eur : Infinity;

// Ranks MOBI.E sites by `best` (see sortKey), one row
// per site (its cheapest point). Sites outside MOBI.E come back in
// `outsideMobie`, ranked apart: their price is a guess or the operator's own.
export async function rank(candidates, car, opts = {}) {
  const simCache = new Map();
  const all = await Promise.all(candidates.flatMap(({ site, points, ...dist }) =>
    points.map(point => quotePoint({ site, point }, car, { ...opts, simCache }).then(q => ({ ...q, ...dist })))));
  let quotes = opts.maxMinutes ? all.filter(q => q.session.minutes <= opts.maxMinutes) : all;
  if (opts.availableOnly) quotes = quotes.filter(q => USABLE.has(q.status));
  const best = list => {
    const bySite = new Map();
    for (const q of list) {
      const cur = bySite.get(q.siteId);
      if (!cur || sortKey(q) < sortKey(cur)) bySite.set(q.siteId, q);
    }
    return [...bySite.values()].sort((a, b) => sortKey(a) - sortKey(b));
  };
  return {
    mobie: best(quotes.filter(q => q.regime !== 'sem_ceme')),
    outsideMobie: best(quotes.filter(q => q.regime === 'sem_ceme')),
  };
}
