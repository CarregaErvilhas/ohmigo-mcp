// The OPC fee: what the charge point operator charges for using the charger.
//
// On MOBI.E a session has two separate bills folded into one invoice:
//   - the energy, sold by your CEME (your card/app company), priced by ceme-v2;
//   - the use of the charger, set by the OPC (the charger's owner). That's here.
//
// MOBI.E publishes each socket's OPC fee as a list of components:
//   - flat:   € per session          ("€ 0.26 /charge")
//   - energy: € per kWh              ("€ 0.10 /kWh")
//   - time:   € per minute, in tiers ("€ 0.18 /min após 30 min" = after minute 30)
// A plan is the same thing as JSON: { flat: [0.26], energy: [0.1],
// time: [{ eur: 0.18, from: 30, to: null }] }. Each component is a LIST
// because a few sockets publish two values for it with nothing to tell them
// apart. So every result is a { low, high } range; for most sockets they match.
//
// These prices come without VAT. VAT applies to the whole invoice
// (mobie.pt/custo-do-carregamento), so the caller (quote.js) adds it.
// The same goes for every price MOBI.E and the NAP publish: the ad hoc
// price and the NAP's price for chargers outside MOBI.E too (confirmed with
// the NAP; MOBI.E's 0.51 €/kWh ad hoc at IONITY x 1.23 is IONITY's own 0.63).

import { translator } from './i18n.js';

// VAT as a multiplier (1.23 = 23 %): lower on Madeira and the Azores.
// ceme-v2 owns this table (REGIONS in its engine/regions.js) and sends it
// with every tariff (`vat`), which is what the CEME prices use. This copy is
// for the prices that don't go through ceme-v2: chargers outside MOBI.E,
// the ad hoc price, and everything while ceme-v2 is down.
export const REGION_VAT = { CONT: 1.23, MAD: 1.22, AZO: 1.16 };
export const vatFor = region => REGION_VAT[region] ?? REGION_VAT.CONT;

// € for `minutes` of charging under a list of per-minute tiers.
//
// Tiers are marginal, like tax brackets: "0.2 €/min after 60 min" charges only
// the minutes past 60. A tier that starts later overrides an open-ended
// earlier one: "0 /min" + "0.18 /min after 30 min" is free for 30 minutes,
// then 0.18. Only tiers with the SAME start are truly ambiguous; there `low`
// takes the cheapest and `high` the dearest.
//
// How: cut the session at every tier boundary, then price each slice with the
// tier that covers its middle.
export function timeCost(tiers, minutes) {
  if (!tiers?.length || minutes <= 0) return { low: 0, high: 0 };
  const cuts = new Set([0, minutes]);
  for (const t of tiers) {
    if (t.from > 0 && t.from < minutes) cuts.add(t.from);
    if (t.to != null && t.to > 0 && t.to < minutes) cuts.add(t.to);
  }
  const xs = [...cuts].sort((a, b) => a - b);
  let low = 0, high = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1], mid = (a + b) / 2;
    const live = tiers.filter(t => t.from <= mid && (t.to == null || mid < t.to));
    if (!live.length) continue;
    const latest = Math.max(...live.map(t => t.from));
    const covering = live.filter(t => t.from === latest).map(t => t.eur);
    low += (b - a) * Math.min(...covering);
    high += (b - a) * Math.max(...covering);
  }
  return { low, high };
}

const range = (vals, f) => vals?.length
  ? { low: Math.min(...vals.map(f)), high: Math.max(...vals.map(f)) }
  : { low: 0, high: 0 };

// Total OPC fee (without VAT) for a session of `kwh` and `minutes`.
// Parking tiers are ignored: they charge for staying plugged in after the car
// is full, and the estimate assumes the driver unplugs at the target %.
export function opcCost(plan, { kwh, minutes }) {
  const flat = range(plan.flat, v => v);
  const energy = range(plan.energy, v => v * kwh);
  const time = timeCost(plan.time, minutes);
  return {
    low: flat.low + energy.low + time.low,
    high: flat.high + energy.high + time.high,
    parts: { flat, energy, time },
  };
}

// The plan as one readable line, e.g. "0.3 €/charge + 0.13 €/min (excl. VAT)".
export function describePlan(plan, t = translator('en')) {
  const out = [];
  const n = v => t.num(v);
  const or = ` ${t('plan.or')} `;
  if (plan.flat?.some(v => v > 0)) out.push(plan.flat.map(v => `${n(v)} ${t('plan.charge')}`).join(or));
  if (plan.energy?.some(v => v > 0)) out.push(plan.energy.map(v => `${n(v)} €/kWh`).join(or));
  for (const tier of plan.time || []) {
    if (tier.eur === 0) continue;
    let s = `${n(tier.eur)} €/min`;
    if (tier.from > 0) s += ` ${t('plan.after', { min: n(tier.from) })}`;
    if (tier.to != null) s += ` ${t('plan.until', { min: n(tier.to) })}`;
    out.push(s);
  }
  if (!out.length) return t('plan.free');
  return `${out.join(' + ')} ${t('plan.exVat')}`;
}
