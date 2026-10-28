// Total cost of a session at a charge point: CEME energy part (from ceme-v2)
// + OPC fee (from MOBI.E's tariff file) + VAT on the OPC fee.

import { applicable, simulate } from './ceme.js';
import { estimateSession } from './charging.js';
import { describePlan, opcCost } from './opc.js';

const r2 = x => Math.round(x * 100) / 100;

// "edp-bt-cartoedp-4" -> "edp-mt-cartoedp-4" when the socket is MT. Tariff ids
// are `ceme-voltage-name`, and the user's favourite comes in either voltage.
export const tariffKey = id => id.replace(/-(bt|mt)-/, '-');

function pickTariffs(quotes, point, tariffId) {
  const ok = applicable(quotes, point);
  return {
    chosen: tariffId ? ok.find(t => tariffKey(t.id) === tariffKey(tariffId)) || null : null,
    best: ok[0] || null,
    bestNoConditions: ok.find(t => !t.bundle) || null,
  };
}

const tariffSummary = t => t && {
  id: t.id, ceme: t.ceme, name: t.name, kind: t.kind, period: t.period,
  requiresOtherContract: !!t.bundle, energyEur: t.totalEur, eurPerKwh: t.eurKwhNoIva,
};

// Quotes one point. `simByKwh` lets a caller ranking many points share the
// ceme-v2 call: the billed kWh only depends on AC vs DC efficiency.
export async function quotePoint({ site, point }, car, { at, tariffId, simCache = new Map() } = {}) {
  const session = estimateSession(point, car);
  const base = {
    pointId: point.id, siteId: site.id, code: site.code,
    operator: site.operator, address: site.address, city: site.city,
    lat: site.lat, lon: site.lon, region: site.region,
    kw: point.kw, connector: point.connector, dc: point.dc, regime: point.regime,
    statusAtSnapshot: point.status ?? null,
    session: {
      kwhBilled: r2(session.kwh), kwhToBattery: r2(session.batteryKwh),
      minutes: Math.round(session.minutes), peakKw: session.peakKw, targetPct: session.targetPct,
    },
    assumptions: [...session.assumptions],
  };

  if (point.regime === 'sem_ceme') {
    base.total = null;
    base.note = 'Outside MOBI.E roaming: pay the operator directly. '
      + (point.napPrice != null ? `NAP lists ${point.napPrice} (unit and whether it includes VAT are not declared).` : 'No price published.');
    return base;
  }

  const key = `${base.region}|${Math.round(session.kwh * 10)}`;
  if (!simCache.has(key)) simCache.set(key, simulate({ kwh: session.kwh, at, region: base.region }));
  const sim = await simCache.get(key);
  const t = pickTariffs(sim.data, point, tariffId);
  // Without a favourite, default to the cheapest tariff anyone can sign up
  // for; one that needs another contract (home energy client, member...) is
  // shown as an alternative, not used as the headline price.
  const ceme = t.chosen || t.bestNoConditions || t.best;
  if (!ceme) {
    base.total = null;
    base.note = 'No CEME tariff applies to this socket.';
    return base;
  }
  if (tariffId && !t.chosen) base.assumptions.push(`tariff ${tariffId} not available here, used the cheapest without conditions instead`);
  if (point.level == null) base.assumptions.push('socket voltage level unknown, priced as low voltage (BT)');

  const vat = ceme.vat; // the region's VAT multiplier, e.g. 1.23
  const plan = point.opc?.REGULAR;
  let opc = { low: 0, high: 0, parts: null };
  if (plan) opc = opcCost(plan, { kwh: session.kwh, minutes: session.minutes });
  else base.assumptions.push('operator fee not published in MOBI.E\'s tariff file; total excludes it');
  if (opc.low !== opc.high) base.assumptions.push('MOBI.E publishes two values for one fee component; showing the range');
  if (plan?.time?.length) base.assumptions.push('per-minute fee counted until the target %, unplugging right away');

  const low = r2(ceme.totalEur + opc.low * vat), high = r2(ceme.totalEur + opc.high * vat);
  // complete: false when the operator fee is unknown, so the total is only
  // the energy part. Rankings put these after the complete ones.
  base.total = { eur: high, low, high, complete: !!plan };
  base.eurPerKwh = session.batteryKwh > 0 ? r2(high / session.batteryKwh) : null;
  base.energy = { tariff: tariffSummary(ceme), eur: ceme.totalEur };
  base.opc = {
    tariff: plan ? describePlan(plan) : null,
    eurExVat: r2(opc.high), eurWithVat: r2(opc.high * vat),
    parts: opc.parts && Object.fromEntries(Object.entries(opc.parts).map(([k, v]) => [k, r2(v.high)])),
  };
  base.omieSpotEurKwh = sim.omieSpot?.eurKwh ?? null;
  base.pricedAt = sim.at;
  if (t.best && t.best.id !== ceme.id && t.best.totalEur < ceme.totalEur) {
    base.cheaperTariff = { ...tariffSummary(t.best), total: r2(t.best.totalEur + opc.high * vat) };
  }
  const adhoc = point.opc?.AD_HOC_PAYMENT;
  if (adhoc) {
    const a = opcCost(adhoc, { kwh: session.kwh, minutes: session.minutes });
    base.adHoc = { tariff: describePlan(adhoc).replace(' (excl. VAT)', ''), eur: r2(a.high), note: 'pay by bank card at the charger, no CEME; MOBI.E does not say if this price includes VAT' };
  }
  return base;
}

// Ranks the points of several sites by total cost (upper end of the range).
// Totals missing the operator fee go after complete ones, and points with no
// total at all (outside MOBI.E, no tariff) go last.
const sortKey = q => !q.total ? Infinity : q.total.complete ? q.total.eur : 1e6 + q.total.eur;

export async function rank(candidates, car, opts = {}) {
  const simCache = new Map();
  const all = await Promise.all(candidates.flatMap(({ site, points, ...dist }) =>
    points.map(point => quotePoint({ site, point }, car, { ...opts, simCache }).then(q => ({ ...q, ...dist })))));
  const quotes = opts.maxMinutes ? all.filter(q => q.session.minutes <= opts.maxMinutes) : all;
  // One row per site: its cheapest point.
  const bySite = new Map();
  for (const q of quotes) {
    const cur = bySite.get(q.siteId);
    if (!cur || sortKey(q) < sortKey(cur)) bySite.set(q.siteId, q);
  }
  return [...bySite.values()].sort((a, b) => sortKey(a) - sortKey(b));
}
