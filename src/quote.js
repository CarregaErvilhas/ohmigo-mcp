// What a session costs at one charger, for every way the user could pay.
//
// This is where the pieces meet:
//   charging.js  -> how many kWh and minutes
//   profile.js   -> when each kWh is delivered (quarter-hour slices)
//   ceme.js      -> the energy part, from ceme-v2 (one call, all CEME tariffs,
//                   each slice priced at its own period and OMIE quarter)
//   opc.js       -> the charger operator's fee
//   offers.js    -> walk-up, operator app, eMSP and subscription prices (offers/)
//   promos.js    -> CEME promotions at this charger's network (from ceme-v2)
//   live.js      -> live status and, as a fallback, the operator fee from the NAP
//
// Each way to pay becomes one entry in `options`, tagged with a `kind`:
//   ceme         pay through a CEME card/app on MOBI.E:
//                ceme-v2's total (energy + TAR + taxes + VAT) + OPC fee + VAT on it
//   adhoc        bank card / QR at the charger, no CEME: MOBI.E's AD_HOC_PAYMENT price
//                + the region's VAT
//   direct       anything outside the CEME system: a walk-up card terminal or
//                QR, the operator's own app or subscription, a roaming app
//                (Electroverse, Elli...). From offers/ (see src/offers.js).
//   opc_direct   chargers outside MOBI.E (Continente, Tesla...): the NAP's
//                price for this site + the region's VAT; next to any direct
//                offers, never instead. offers/nap-notes.json can drop it,
//                or say the operator publishes it with VAT in (Tesla).
// MOBI.E and the NAP publish every price without VAT (opc.js), so each of
// these adds the VAT of the charger's region: 23 % on the mainland, less on
// Madeira and the Azores.
// New ways to pay (CEME subscriptions, eMSP flat prices) slot in as new kinds.
//
// Two summary fields:
//   headline  the CEME option shown first (the user's cheapest tariff, or the
//             cheapest popular one that needs no other contract).
//   best      the cheapest option ANYONE can pay right now: no subscription
//             fee, no other contract. Chargers are ranked by it,
//             so an IONITY whose own app beats every CEME ranks where it should.

import { applicable, simulate } from './ceme.js';
import { estimateSession } from './charging.js';
import { localOffset, localTime, REGION_TZ, sessionProfile } from './profile.js';
import { translator } from './i18n.js';
import { napPlan } from './live.js';
import { describePlan, opcCost, vatFor } from './opc.js';
import { isStale, napNote, offersAt, ownWalkUp, SOURCE } from './offers.js';
import { appliesToCustomers, promosHere, promoTips, withPromos } from './promos.js';

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 10_000) / 10_000;
const pct = (vat, t) => t.num(r4((vat - 1) * 100), 1);

// ceme-v2 tariff ids carry the voltage as one dash-separated segment, in the
// middle ("edp-bt-cartoedp-4") or at the end ("luzigas-ceme-bt"). A tariff
// can exist twice, for low (bt) and medium (mt) voltage chargers, and the
// user doesn't care which. Dropping the voltage gives the "same tariff" key.
export const tariffKey = id => id.replace(/-(bt|mt)(?=-|$)/, '');

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

// One CEME tariff as a way to pay here: ceme-v2's energy total plus the
// operator fee with VAT, with the tariff's promotions for every customer at
// this network already in (promos.js; new-customer ones never are). An
// all-in promotion (FINAL) replaces the sum: energyEur is null and
// opcIncluded says the operator fee is inside the total.
// kwhByPeriod is there when the session crosses periods for this tariff
// (each tariff has its own cycle, so one session can cross for one and not
// for another): { VAZIO: 12.4, FORA_VAZIO: 20.1 }.
//   opc: { low, high } operator fee excl. VAT; vat: the region's multiplier
function cemeOption(t, { site, opc, vat }) {
  const promos = promosHere(t, site).filter(appliesToCustomers);
  const w = withPromos(promos, { energyEur: t.totalEur, opc, vat });
  return {
    kind: 'ceme', label: `${t.ceme} · ${t.name}`, total: w.high,
    ...(w.low !== w.high && { low: w.low }),
    tariffId: t.id, ceme: t.ceme, name: t.name, tariffKind: t.kind, period: t.period,
    ...(t.kwhByPeriod && Object.keys(t.kwhByPeriod).length > 1 && { kwhByPeriod: t.kwhByPeriod }),
    requiresOtherContract: !!t.bundle, energyEur: w.energyEur,
    ...(promos.length && { promos: promos.map(p => p.id), ...(w.opcPct && { opcDiscountPct: w.opcPct }), ...(w.final && { opcIncluded: true }) }),
  };
}

// The story of a session, for a driver (or a QA run) who asks how the price
// was built: when the kWh go in, and for each CEME tariff shown, the period,
// price and OMIE over time. Quarter-hours that look the same are merged into
// one run (from-to, how many quarters, their kWh): a 9-hour AC session at one
// price is one line, not 36 (~20 KB per result before). A run breaks when the
// power, the period, the price, the OMIE or the UTC offset changes, so
// indexed tariffs (OMIE every quarter) and the October repeated hour still
// show quarter by quarter.
function timeline(region, slices, tariffs, sim) {
  const local = (at, minutes = 0) => localTime(new Date(Date.parse(at) + minutes * 60_000), region);
  const runs = (items, same) => {
    const out = [];
    items.forEach((x, i) => {
      const s = slices[i];
      const row = { ...x, utcOffset: localOffset(s.at, region) };
      const last = out[out.length - 1];
      if (last && same(last, row) && last.utcOffset === row.utcOffset) {
        last.to = local(s.at, s.minutes); last.quarters++; last.kwh = r4(last.kwh + s.kwh);
      } else out.push({ from: local(s.at), to: local(s.at, s.minutes), utcOffset: row.utcOffset, quarters: 1, kwh: s.kwh, ...x });
    });
    return out;
  };
  return {
    timeZone: REGION_TZ[region] || REGION_TZ.CONT,
    omieQuartersKnown: sim.profile ? `${sim.profile.withSpot}/${sim.profile.slices}` : null,
    quarters: slices.length,
    slices: runs(slices.map(s => ({ kw: s.kw })), (a, b) => a.kw === b.kw),
    tariffs: tariffs.filter(Boolean).map(t => ({
      tariffId: t.id, label: `${t.ceme} · ${t.name}`,
      runs: runs((t.slices || []).slice(0, slices.length).map(x => ({ period: x.period, eurKwhExVat: x.final,
        ...(x.omie != null && { omieEurKwh: Math.round(x.omie * 1e5) / 1e5, omieSpot: x.omieSpot }) })),
      (a, b) => a.period === b.period && a.eurKwhExVat === b.eurKwhExVat && a.omieEurKwh === b.omieEurKwh && a.omieSpot === b.omieSpot),
    })),
  };
}

// The OPC fee plan for a point and where it came from. MOBI.E's tariff file
// first (it has the per-minute tiers); the NAP live feed when the socket is
// missing from it.
function feePlan(point, live) {
  if (point.opc?.REGULAR) return { plan: point.opc.REGULAR, source: 'mobie' };
  const lp = live && napPlan(live.fees);
  if (lp) return { plan: lp, source: 'nap' };
  return { plan: null, source: null };
}

// MOBI.E's ad hoc price, which comes without VAT like its operator fees.
function adhocOption(point, session, t, region) {
  const plan = point.opc?.AD_HOC_PAYMENT;
  if (!plan) return null;
  const vat = vatFor(region);
  const c = opcCost(plan, { kwh: session.kwh, minutes: session.minutes });
  return {
    kind: 'adhoc', label: t('option.adhoc'),
    total: r2(c.high * vat), low: r2(c.low * vat), high: r2(c.high * vat),
    tariff: describePlan(plan, t),
    note: t('option.adhoc.note', { vat: pct(vat, t) }),
  };
}

// Direct offers at this point: kWh x the offer's price for the point's power
// band. A subscription's fee is listed, not added, since one fee covers every
// session in the month/year. These prices are final with mainland VAT (23 %);
// on the islands (lower VAT) nobody tells us whether they change, so we show
// them as they are and say so.
function directOptions(direct, session, t, region) {
  const island = region && region !== 'CONT';
  return direct.map(({ offer, eurPerKwh }) => ({
    kind: 'direct', offerId: offer.id, label: offer.label, provider: offer.provider,
    total: r2(eurPerKwh * session.kwh), eurPerKwh, walkUp: !!offer.walkUp,
    subscription: offer.subscription ? { ...(offer.fee || {}), text: offer.fee ? t('option.fee', offer.fee) : t('option.feeUnknown') } : null,
    note: t('option.direct.note', { source: offer.origin === 'custofinal' ? `${SOURCE.name} (${SOURCE.author}), ${SOURCE.blog}` : offer.source, checked: offer.checkedAt })
      + (offer.walkUp ? ` ${t('option.walkUp')}` : '')
      + (isStale(offer) ? ` ${t('option.stale')}` : '')
      + (island ? ` ${t('option.islandVat')}` : ''),
    stale: isStale(offer), vatUnverified: island || undefined,
  })).sort((a, b) => a.total - b.total);
}

// Quotes one point. `simCache` lets a caller ranking many points share the
// ceme-v2 call: the billed kWh only differs between AC and DC (different
// losses), so a whole ranking needs one or two calls.
//   detail: add `timeline` (when the kWh go in, and the period and price
//           over time for each tariff shown). qa: also `debug` (what went to
//           ceme-v2 and what came back).
//   monthKwh: { ceme-v2 tariff id: kWh the user already charged with it this
//           month }, for free-kWh promotions (see ceme.js expandMonthKwh).
export async function quotePoint({ site, point }, car, { at, tariffIds, shown, live, lang, detail = false, qa = false, monthKwh = null, simCache = new Map() } = {}) {
  const t = translator(lang);
  const session = estimateSession(point, car, t);
  // The session starts at `at` (or now), to the minute so points share the
  // ceme-v2 call, and runs for `minutes`.
  const start = new Date(Math.floor((at ?? new Date()).getTime() / 60_000) * 60_000);
  const end = new Date(start.getTime() + session.minutes * 60_000);
  const slices = sessionProfile(session.segments, start);
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
      start: start.toISOString(), end: end.toISOString(),
      startLocal: localTime(start, site.region), endLocal: localTime(end, site.region),
    },
    assumptions: [...session.assumptions],
    options: [],
  };
  const direct = offersAt(site, point);

  if (point.regime === 'sem_ceme') {
    // Outside MOBI.E: no CEME, the operator bills directly. The NAP has one
    // pricePerDeliveryUnit per point, without VAT like every NAP price; we
    // take it plus the region's VAT as the operator's whole €/kWh (an
    // assumption, stated) and rank it like any other price, unless
    // offers/nap-notes.json says it's wrong for this charger, or that this
    // operator publishes it with VAT in (then no VAT is added). It sits next to
    // the direct offers, not instead of them: an offer is one price for the
    // whole network, the NAP's is this site's (Tesla's vary by site).
    // When MOBI.E also lists an AD_HOC_PAYMENT price for the socket, that's
    // the same walk-up price (HighGreenPower: 0.28 in both): it says how to
    // pay (bank card / QR, no app or account) and stands in when the live
    // feed is down.
    const nap = lp ? lp.fees.find(f => f.policy === 'pricePerDeliveryUnit')?.eur : point.napPrice;
    const vat = vatFor(base.region);
    const note = napNote(site);
    const wrong = note && !note.vatIncluded && !note.timeOfUse;
    const walkUp = !!point.opc?.AD_HOC_PAYMENT;
    base.options.push(...directOptions(direct, session, t, base.region));
    if (nap != null && wrong) base.assumptions.push(t('assume.napWrong', { why: note.why }));
    else if (nap != null) {
      const label = walkUp ? t('option.opcDirect.walkUp', { operator: site.operator || '' })
        : site.operator ? t('option.opcDirect', { operator: site.operator }) : t('option.opcDirect.noName');
      // Tesla's NAP price is what its app shows, VAT in: adding VAT again
      // put it above Tesla's own card terminal price.
      const withVat = note?.vatIncluded ? nap : nap * vat;
      base.options.push({ kind: 'opc_direct', label,
        total: r2(withVat * session.kwh), eurPerKwh: r4(withVat), eurPerKwhExVat: r4(withVat / vat),
        ...(note?.vatIncluded && { napVatIncluded: true }),
        note: note?.vatIncluded ? t('option.opcDirect.noteVatIn', { price: t.num(nap) }) : t('option.opcDirect.note', { price: t.num(nap), vat: pct(vat, t) }) });
      base.assumptions.push(note?.vatIncluded ? t('assume.napVatIn') : t('assume.napPrice', { vat: pct(vat, t) }));
      if (note?.timeOfUse) base.assumptions.push(t('assume.napTimeOfUse'));
    } else if (walkUp) {
      base.options.push(adhocOption(point, session, t, base.region));
    }
    base.options.sort((a, b) => a.total - b.total);
    const first = base.options[0];
    base.total = first ? { eur: first.total, complete: true } : null;
    base.best = bestOption(base.options, null);
    base.note = t('note.outside');
    return base;
  }

  // An operator whose own walk-up price is in the offers replaces MOBI.E's
  // ad hoc price here: it's the operator's own word, and can be newer than
  // MOBI.E's file (IONITY: 0.51 €/kWh there, 0.63 with VAT, the same as its
  // own price today).
  const adhoc = ownWalkUp(site, direct) ? null : adhocOption(point, session, t, base.region);
  const want = detail || qa;
  const key = `${base.region}|${want ? 1 : 0}|${slices.map(x => `${x.at}=${x.kwh}`).join(',') || `${start.toISOString()}=${session.kwh}`}`;
  if (!simCache.has(key)) simCache.set(key, simulate({ kwh: session.kwh, at: start, region: base.region, profile: slices, detail: want, monthKwh }));
  let sim;
  try {
    sim = await simCache.get(key);
  } catch (e) {
    if (!e.ceme) throw e;
    // ceme-v2 is down: the CEME prices are missing, but the walk-up price,
    // the direct offers and the status didn't come from it. Answer with
    // those, flagged, and never pass a partial total off as complete.
    base.total = null;
    base.cemeUnavailable = true;
    base.note = t('note.noCeme');
    base.options.push(...(adhoc ? [adhoc] : []), ...directOptions(direct, session, t, base.region));
    base.options.sort((a, b) => a.total - b.total);
    base.best = bestOption(base.options, null);
    return base;
  }
  // A ceme-v2 without profile support priced everything at the start.
  base.assumptions.push(sim.profile
    ? t('assume.window', { from: base.session.startLocal, to: base.session.endLocal })
    : t('assume.startOnly', { from: base.session.startLocal }));
  const picked = pickTariffs(sim.data, point, tariffIds, shown);
  const ceme = picked.headline;
  const extras = [...(adhoc ? [adhoc] : []), ...directOptions(direct, session, t, base.region)];
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

  const ctx = { site, opc, vat };
  const shownOpts = picked.options.map(o => cemeOption(o, ctx));
  // The headline, now that promotions may have changed the order: with the
  // user's tariffs, the cheapest of them; otherwise the cheapest shown one
  // that needs no other contract (pickTariffs' pick when none qualifies).
  // Without promotions this is pickTariffs' headline: every option pays the
  // same operator fee, so the energy order is the total order.
  const cheapest = list => list.reduce((a, o) => (a && a.total <= o.total ? a : o), null);
  const head = (tariffIds?.length ? cheapest(shownOpts) : cheapest(shownOpts.filter(o => !o.requiresOtherContract)))
    ?? cemeOption(ceme, ctx);
  // complete: false when the operator fee is unknown, so the total is only
  // the energy part. Rankings put these after the complete ones.
  base.total = { eur: head.total, low: head.low ?? head.total, high: head.total, complete: !!plan };
  base.eurPerKwh = session.batteryKwh > 0 ? r2(head.total / session.batteryKwh) : null;
  base.headline = head;
  base.opc = {
    tariff: plan ? describePlan(plan, t) : null, source,
    eurExVat: r2(opc.high), eurWithVat: r2(opc.high * vat),
    parts: opc.parts && Object.fromEntries(Object.entries(opc.parts).map(([k, v]) => [k, r2(v.high)])),
  };
  base.options = shownOpts;
  if (!base.options.some(o => o.tariffId === head.tariffId)) base.options.unshift(head);
  if (picked.best && !picked.options.some(o => o.id === picked.best.id)) {
    const b = cemeOption(picked.best, ctx);
    if (b.total < head.total) base.options.push({ ...b, cheaperElsewhere: true });
  }
  // Promotions: the ones already in a shown total get an assumption; all of
  // them at this network (new-customer ones included) are listed as tips.
  const applied = new Set(base.options.flatMap(o => o.promos || []));
  const shownIds = new Set(base.options.map(o => o.tariffId));
  const tips = promoTips(applicable(sim.data, point), site, { opc, vat, applied, shown: shownIds }, t);
  for (const p of tips) if (p.applied) base.assumptions.push(t('assume.promo', { label: p.label, until: p.until }));
  if (tips.length) base.promos = tips;
  base.options.push(...extras);
  base.best = bestOption(base.options, base.total);
  base.omieSpotEurKwh = sim.omieSpot?.eurKwh ?? null;
  base.pricedAt = sim.at;
  if (want) {
    // Same order as the options the driver sees.
    const byId = new Map(sim.data.map(q => [q.id, q]));
    const shown = [...new Set(base.options.filter(o => o.kind === 'ceme').map(o => o.tariffId))].map(id => byId.get(id));
    base.timeline = timeline(base.region, slices, shown, sim);
  }
  if (qa) base.debug = { segments: session.segments, profileSent: slices, ceme: { at: sim.at, kwh: sim.kwh, profile: sim.profile ?? null, omieSpot: sim.omieSpot ?? null }, feeSource: source, feePlan: plan };
  return base;
}

// The cheapest option open to anyone. A CEME option only counts when its
// total is complete (operator fee known).
function bestOption(options, total) {
  const open = options.filter(o => !o.requiresOtherContract && !o.subscription
    && (o.kind !== 'ceme' || total?.complete));
  return open.reduce((a, o) => (a && a.total <= o.total ? a : o), null);
}

// Statuses where a car can plug in now. "unknown" stays in (a lot of the
// network reports it), the rest are out.
const USABLE = new Set(['available', 'unknown', null]);

// Ranked by `best`. Without one (operator fee unknown, or only prices that
// need a subscription or another contract), the energy-only total goes after
// all the complete ones, and points with no price at all go last.
const sortKey = q => q.best ? q.best.total : q.total ? 1e6 + q.total.eur : Infinity;
export const byBest = (a, b) => sortKey(a) - sortKey(b);

// Ranks sites by `best` (see sortKey), one row per site (its cheapest
// point). MOBI.E and the networks outside it share one list: no network is
// preferred, the price decides.
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
  return best(quotes);
}
