// OPC fee (the charge point operator's usage fee) for one session.
//
// MOBI.E publishes per socket a list of components: flat €/charge, €/kWh and
// €/min tiers ("após 30 min", "até 45 min"). A few sockets publish two values
// for the same component with nothing to tell them apart, so every result is
// a { low, high } range; for most sockets low === high.
//
// Prices are published without VAT; VAT is applied on the whole invoice
// (mobie.pt/custo-do-carregamento), so the caller adds it.

// Integrates €/min tiers over [0, minutes). Tiers are marginal: "0.2 €/min
// após 60 min" charges only the minutes after 60. A tier that starts later
// overrides an open-ended earlier one: "0 /min" + "0.18 /min após 30 min" is
// free for 30 minutes, then 0.18. Only tiers with the same start are truly
// ambiguous; there low takes the cheapest and high the dearest.
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

// plan: { flat?: number[], energy?: number[], time?: tier[], parking?: tier[] }
// Parking tiers are ignored: they charge for staying plugged after the car is
// full, and the estimate assumes the driver unplugs at the target.
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

// One-line description of the tariff, for the agent to show the user.
export function describePlan(plan) {
  const out = [];
  const fmt = v => v.toLocaleString('en', { maximumFractionDigits: 4 });
  if (plan.flat?.some(v => v > 0)) out.push(plan.flat.map(v => `${fmt(v)} €/charge`).join(' or '));
  if (plan.energy?.some(v => v > 0)) out.push(plan.energy.map(v => `${fmt(v)} €/kWh`).join(' or '));
  for (const t of plan.time || []) {
    if (t.eur === 0) continue;
    let s = `${fmt(t.eur)} €/min`;
    if (t.from > 0) s += ` after ${fmt(t.from)} min`;
    if (t.to != null) s += ` until ${fmt(t.to)} min`;
    out.push(s);
  }
  return out.length ? out.join(' + ') + ' (excl. VAT)' : 'free (no OPC fee)';
}
