// The data behind the tools, laid out for a person (GET /dados).
//
// The tools answer one question at a time, so from the outside it's hard to
// see what ohmigo actually knows: which tariffs and promotions ceme-v2 sends,
// which direct offers came from the blog or manual.json, what fee each
// operator charges. This module gathers the same inputs the tools use, with
// no extra math: CEME prices come from ceme-v2 as is, OPC fees are the
// dataset's plans in words (opc.js), direct offers are offers.js's OFFERS.

import { simulate, promos } from './ceme.js';
import { operatorKey } from './data.js';
import { NAP_NOTES, OFFERS, SOURCE, isStale, offersAt } from './offers.js';
import { describePlan } from './opc.js';
import { translator } from './i18n.js';
import { NETWORKS } from './promos.js';
import { VERSION } from './version.js';

const t = translator('pt');
// ~19k sockets share a few hundred fee plans: describe each one once.
const described = new Map();
const plan = p => {
  if (!p) return null;
  const k = JSON.stringify(p);
  if (!described.has(k)) described.set(k, describePlan(p, t));
  return described.get(k);
};

// One operator: what its chargers are and what they charge. Fee plans are
// grouped (most operators publish a handful for thousands of sockets).
// `key` is what /dados/postos.json takes: sites with no operatorId have one too.
function operators(ds) {
  const ops = new Map();
  for (const s of ds.sites) {
    const key = operatorKey(s);
    const o = ops.get(key) ?? {
      key, id: s.operatorId, name: s.operator ?? t('operator.unnamed'), website: s.website, sites: 0, inferred: 0, points: 0, dc: 0, maxKw: 0,
      regimes: {}, payment: new Set(), plans: new Map(), adhoc: new Map(), napPrices: [],
    };
    o.sites++;
    if (s.operatorInferred) o.inferred++;
    for (const m of s.payment || []) o.payment.add(m);
    for (const p of s.points) {
      o.points++;
      if (p.dc) o.dc++;
      o.maxKw = Math.max(o.maxKw, p.kw || 0);
      o.regimes[p.regime] = (o.regimes[p.regime] || 0) + 1;
      const reg = plan(p.opc?.REGULAR), ah = plan(p.opc?.AD_HOC_PAYMENT);
      if (reg) o.plans.set(reg, (o.plans.get(reg) || 0) + 1);
      if (ah) o.adhoc.set(ah, (o.adhoc.get(ah) || 0) + 1);
      if (p.napPrice != null) o.napPrices.push(p.napPrice);
    }
    ops.set(key, o);
  }
  const top = m => [...m].sort((a, b) => b[1] - a[1]).map(([desc, n]) => ({ desc, n }));
  return [...ops.values()].map(o => ({
    ...o, payment: [...o.payment], plans: top(o.plans), adhoc: top(o.adhoc),
    napPrice: o.napPrices.length ? { min: Math.min(...o.napPrices), max: Math.max(...o.napPrices) } : null,
    napPrices: undefined,
    offers: OFFERS.filter(x => x.scope.operatorIds?.includes(o.id)).map(x => x.id),
    note: NAP_NOTES.find(n => n.scope.operatorIds?.includes(o.id)) ?? null,
  })).sort((a, b) => b.points - a.points);
}

// The summary page. ceme-v2 lists tariffs with their prices only inside a
// simulation, so we ask for any session (20 kWh, now) and keep just what
// doesn't depend on when: the per-period prices of fixed tariffs and the
// activation fee. An indexed tariff's price follows the OMIE quarter-hour and
// a session's total follows the time-of-day period, so neither goes in: the
// page is cached for hours.
//
// Memoized per dataset for 5 min (ceme.js's own cache TTL): the CDN is the
// main cache, this one is for requests that reach the origin directly.
let memo = null; // { ds, at, value }
export function dump(ds) {
  if (memo && memo.ds === ds && Date.now() - memo.at < 5 * 60_000) return memo.value;
  // A result with a ceme-v2 error isn't kept: the next request tries again.
  const value = build(ds).then(d => { if (d.partial) memo = null; return d; }, e => { memo = null; throw e; });
  memo = { ds, at: Date.now(), value };
  return value;
}

async function build(ds) {
  const [sim, pr] = await Promise.all([
    simulate({ kwh: 20 }).catch(e => ({ error: e.message })),
    promos().catch(e => ({ error: e.message })),
  ]);
  const regimes = {};
  for (const s of ds.sites) for (const p of s.points) regimes[p.regime] = (regimes[p.regime] || 0) + 1;
  return {
    partial: !!(sim.error || pr.error),
    version: VERSION, dataAsOf: ds.generatedAt, now: new Date().toISOString(),
    counts: { sites: ds.sites.length, points: Object.values(regimes).reduce((a, b) => a + b, 0), regimes },
    ceme: sim.error ? { error: sim.error } : {
      region: sim.region,
      tariffs: sim.data.map(x => ({
        id: x.id, legacyId: x.legacy_id, ceme: x.ceme, name: x.name, kind: x.kind, voltage: x.voltage,
        schedule: x.schedule, cycle: x.cycle, bundle: x.bundle, popular: x.popular, notes: x.notes,
        prices: x.kind === 'INDEXED' ? null : x.prices, activation: x.activation,
        validFrom: x.valid_from, estimated: x.estimated, url: x.source_url, promos: (x.promos || []).map(p => p.id),
      })).sort((a, b) => a.ceme.localeCompare(b.ceme, 'pt') || a.name.localeCompare(b.name, 'pt') || a.voltage.localeCompare(b.voltage)),
    },
    promos: pr.error ? { error: pr.error } : (pr.data ?? pr),
    offers: { source: SOURCE, list: OFFERS.map(o => ({ ...o, stale: isStale(o) })), orphans: OFFERS.orphans },
    napNotes: NAP_NOTES,
    networks: NETWORKS,
    operators: operators(ds),
  };
}

// Every charger of one operator (its `key`), socket by socket, with the direct offers
// that apply there (the same offersAt the cost tools use).
export function chargers(ds, key) {
  return ds.sites.filter(s => operatorKey(s) === key).map(s => ({
    id: s.id, code: s.code, city: s.city, address: s.address, region: s.region, payment: s.payment,
    name: s.osm?.name ?? null,
    points: s.points.map(p => ({
      id: p.id, kw: p.kw, connector: p.connector, dc: p.dc, level: p.level, regime: p.regime,
      opc: plan(p.opc?.REGULAR), adhoc: plan(p.opc?.AD_HOC_PAYMENT), napPrice: p.napPrice ?? null,
      offers: offersAt(s, p).map(x => ({ id: x.offer.id, label: x.offer.label, eurPerKwh: x.eurPerKwh })),
    })),
  }));
}
