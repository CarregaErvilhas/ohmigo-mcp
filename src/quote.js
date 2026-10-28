// Total cost of a session at a charge point: CEME energy part (from ceme-v2)
// + OPC fee (MOBI.E's tariff file, or the NAP live feed as a fallback) + VAT
// on the OPC fee.

import { applicable, simulate } from './ceme.js';
import { estimateSession } from './charging.js';
import { napPlan } from './live.js';
import { describePlan, opcCost } from './opc.js';

const r2 = x => Math.round(x * 100) / 100;

// "edp-bt-cartoedp-4" -> "edp-mt-cartoedp-4" when the socket is MT. Tariff ids
// are `ceme-voltage-name`, and the user's tariffs come in either voltage.
export const tariffKey = id => id.replace(/-(bt|mt)-/, '-');

const POPULAR_SHOWN = 3;

// Which CEME tariffs to price at this point, cheapest first.
//   - The user's own tariffs (cards/subscriptions they told their agent
//     about): all of them that apply here.
//   - Otherwise the top 3 of ceme-v2's "popular" filter. The headline is the
//     cheapest one without conditions, so a price that needs another contract
//     (home energy client, member...) never shows up as "the" price.
// Tariffs with the same price and name (e.g. the same card in two cycles) are
// shown once.
export function pickTariffs(quotes, point, tariffIds) {
  const ok = applicable(quotes, point);
  const best = ok[0] || null;
  let options;
  if (tariffIds?.length) {
    const want = new Set(tariffIds.map(tariffKey));
    options = ok.filter(t => want.has(tariffKey(t.id)));
    const headline = options[0] || null;
    return { options, headline, best, missing: !options.length };
  }
  const seen = new Set();
  options = ok.filter(t => {
    if (!t.popular) return false;
    const k = `${t.ceme}|${t.name}|${t.totalEur}`;
    return !seen.has(k) && seen.add(k);
  }).slice(0, POPULAR_SHOWN);
  const headline = options.find(t => !t.bundle) || ok.find(t => !t.bundle) || best;
  return { options, headline, best, missing: false };
}

const tariffSummary = t => t && {
  id: t.id, ceme: t.ceme, name: t.name, kind: t.kind, period: t.period,
  requiresOtherContract: !!t.bundle, energyEur: t.totalEur, eurPerKwh: t.eurKwhNoIva,
};

// The OPC fee plan for a point and where it came from.
function feePlan(point, live) {
  if (point.opc?.REGULAR) return { plan: point.opc.REGULAR, source: 'mobie' };
  const lp = live && napPlan(live.fees);
  if (lp) return { plan: lp, source: 'nap' };
  return { plan: null, source: null };
}

// Quotes one point. `simCache` lets a caller ranking many points share the
// ceme-v2 call: the billed kWh only depends on AC vs DC efficiency.
export async function quotePoint({ site, point }, car, { at, tariffIds, live, simCache = new Map() } = {}) {
  const session = estimateSession(point, car);
  const lp = live?.get(point.id) ?? null;
  const base = {
    pointId: point.id, siteId: site.id, code: site.code,
    operator: site.operator, address: site.address, city: site.city,
    lat: site.lat, lon: site.lon, region: site.region,
    kw: point.kw, connector: point.connector, dc: point.dc, regime: point.regime,
    status: lp?.status ?? null,
    session: {
      kwhBilled: r2(session.kwh), kwhToBattery: r2(session.batteryKwh),
      minutes: Math.round(session.minutes), peakKw: session.peakKw, targetPct: session.targetPct,
    },
    assumptions: [...session.assumptions],
  };

  if (point.regime === 'sem_ceme') {
    // Outside MOBI.E (Continente, Tesla...): no CEME, the operator bills
    // directly. NAP has one pricePerDeliveryUnit with nothing saying whether
    // it's the final price. We estimate as if it were a final €/kWh and mark
    // it, never mixing it into the MOBI.E ranking.
    const nap = lp ? lp.fees.find(f => f.policy === 'pricePerDeliveryUnit')?.eur : point.napPrice;
    base.total = nap != null ? { eur: r2(nap * session.kwh), complete: false, asterisk: true } : null;
    base.note = 'Outside MOBI.E: pay the operator directly (their app/card), no CEME. '
      + (nap != null ? `* Estimate assumes NAP's ${nap} is a final €/kWh price incl. VAT; NAP doesn't declare what it covers.` : 'No price published.');
    return base;
  }

  const key = `${base.region}|${Math.round(session.kwh * 10)}`;
  if (!simCache.has(key)) simCache.set(key, simulate({ kwh: session.kwh, at, region: base.region }));
  const sim = await simCache.get(key);
  const t = pickTariffs(sim.data, point, tariffIds);
  const ceme = t.headline;
  if (!ceme) {
    base.total = null;
    base.note = t.missing ? 'None of the user\'s tariffs apply at this socket.' : 'No CEME tariff applies to this socket.';
    return base;
  }
  if (point.level == null) base.assumptions.push('socket voltage level unknown, priced as low voltage (BT)');

  const vat = ceme.vat; // the region's VAT multiplier, e.g. 1.23
  const { plan, source } = feePlan(point, lp);
  let opc = { low: 0, high: 0, parts: null };
  if (plan) opc = opcCost(plan, { kwh: session.kwh, minutes: session.minutes });
  else base.assumptions.push('operator fee not published (MOBI.E file or NAP); total excludes it');
  if (source === 'nap') base.assumptions.push('operator fee from the NAP live feed: rounded to the cent, no time tiers');
  if (opc.low !== opc.high) base.assumptions.push('two values published for one fee component; showing the range');
  if (plan?.time?.length) base.assumptions.push('per-minute fee counted until the target %, unplugging right away');

  const withOpc = tt => r2(tt.totalEur + opc.high * vat);
  const low = r2(ceme.totalEur + opc.low * vat), high = withOpc(ceme);
  // complete: false when the operator fee is unknown, so the total is only
  // the energy part. Rankings put these after the complete ones.
  base.total = { eur: high, low, high, complete: !!plan };
  base.eurPerKwh = session.batteryKwh > 0 ? r2(high / session.batteryKwh) : null;
  base.energy = { tariff: tariffSummary(ceme), eur: ceme.totalEur };
  base.tariffOptions = t.options.map(o => ({ ...tariffSummary(o), total: withOpc(o) }));
  base.opc = {
    tariff: plan ? describePlan(plan) : null, source,
    eurExVat: r2(opc.high), eurWithVat: r2(opc.high * vat),
    parts: opc.parts && Object.fromEntries(Object.entries(opc.parts).map(([k, v]) => [k, r2(v.high)])),
  };
  base.omieSpotEurKwh = sim.omieSpot?.eurKwh ?? null;
  base.pricedAt = sim.at;
  if (t.best && !t.options.some(o => o.id === t.best.id) && t.best.totalEur < ceme.totalEur) {
    base.cheaperTariff = { ...tariffSummary(t.best), total: withOpc(t.best) };
  }
  const adhoc = point.opc?.AD_HOC_PAYMENT;
  if (adhoc) {
    const a = opcCost(adhoc, { kwh: session.kwh, minutes: session.minutes });
    base.adHoc = { tariff: describePlan(adhoc).replace(' (excl. VAT)', ''), eur: r2(a.high), note: 'pay by bank card at the charger, no CEME; MOBI.E does not say if this price includes VAT' };
  }
  return base;
}

// Statuses where a car can plug in now. "unknown" stays in (a lot of the
// network reports it), the rest are out.
const USABLE = new Set(['available', 'unknown', null]);

// Totals missing the operator fee go after complete ones, and points with no
// total at all go last.
const sortKey = q => !q.total ? Infinity : q.total.complete ? q.total.eur : 1e6 + q.total.eur;

// Ranks MOBI.E sites by total cost (upper end of the range), one row per site
// (its cheapest point). Sites outside MOBI.E come back in `outsideMobie`,
// ranked apart: their price is an asterisked guess, not comparable.
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
