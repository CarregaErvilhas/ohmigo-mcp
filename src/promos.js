// CEME promotions that only hold on one charging network.
//
// Some CEMEs strike deals with a charger operator (OPC): LUZiGÁS takes
// 0.12 €/kWh off its energy price at Powerdot chargers for new customers,
// miio one takes 45 % off Powerdot's own fee. These are CEME offers, so they
// live in ceme-v2 (PROMOS in its seed-data.js), next to the tariffs, and
// ceme-v2 does the energy math. But ceme-v2 prices a session without knowing
// the charger, so it can't tell whether a promotion applies: each tariff
// comes back with its `promos`, tagged with a network name, and this module
// decides, per charger, which of them hold here.
//
// A promotion's `network` is a label like "Powerdot", the same labels as
// offers/networks.json, which maps each one to NAP operator ids. So adding a
// promotion for a new network is a data change in ceme-v2 (plus a line in
// networks.json if the label is new), never code here.
//
// Two kinds, and they're treated differently:
//   - for every customer of the tariff (newCustomers false): the user who
//     pays with that tariff gets it on every session at that network, so it
//     goes into the option's total;
//   - for new customers only (newCustomers true, often for a few days after
//     signing up): almost nobody qualifies, so it never changes a price. It
//     is listed as a tip, with what this session would cost if you did.
//
// Two targets:
//   ENERGIA  ceme-v2 sends `totalEur`: the CEME part of the session with the
//            discount already in (energy + TAR - discount, then IEC, EGME, VAT);
//   OPC      `pct` off the operator's fee, which ohmigo computes (opc.js), so
//            we apply it here.

import { readFileSync } from 'node:fs';

const NETWORKS = JSON.parse(readFileSync(new URL('../offers/networks.json', import.meta.url), 'utf8')).networks;

const r2 = x => Math.round(x * 100) / 100;

// Is this site on the network a promotion names? An unknown label, or one we
// can't pin to operators (scope "unknown"), matches nothing: better to miss a
// discount than to promise one that isn't there.
export function onNetwork(site, network, networks = NETWORKS) {
  const n = networks[network];
  if (!n) return false;
  if (n.scope === 'mobie') return true;
  return !!n.operatorIds?.includes(site.operatorId);
}

// The promotions of one ceme-v2 tariff quote that hold at this site.
export const promosHere = (quote, site, networks) => (quote.promos || []).filter(p => onNetwork(site, p.network, networks));

// What a session costs with a set of promotions on top of one tariff.
//   energyEur  ceme-v2's total for the tariff (energy part, VAT included)
//   opc        { low, high } operator fee, excl. VAT (opc.js)
//   vat        the region's VAT multiplier
// Energy discounts don't stack (each `totalEur` is computed alone, so take the
// lowest); OPC discounts don't either (take the biggest). An energy and an
// OPC discount do stack: they cut different lines of the bill.
export function withPromos(promos, { energyEur, opc, vat }) {
  const energy = promos.filter(p => p.target === 'ENERGIA' && p.totalEur != null)
    .reduce((m, p) => Math.min(m, p.totalEur), energyEur);
  const pct = promos.filter(p => p.target === 'OPC' && p.pct > 0).reduce((m, p) => Math.max(m, p.pct), 0);
  const k = 1 - Math.min(pct, 100) / 100;
  return { energyEur: energy, opcPct: pct, low: r2(energy + opc.low * k * vat), high: r2(energy + opc.high * k * vat) };
}

// The promotion as the assistant sees it, with its label and note in the
// user's language (ceme-v2's own `name` is Portuguese only).
//   total      this session at this charger with the promotion
//   saving     against the same tariff without it
//   applied    already in the total of one of the options shown
export function promoOut(p, { quote, total, saving, applied }, t) {
  const amount = p.target === 'ENERGIA'
    ? t('promo.energy', { eur: t.num(p.eurKwh, 4) })
    : t('promo.opc', { pct: t.num(p.pct, 1) });
  return {
    id: p.id, ceme: quote.ceme, tariffId: quote.id, tariffName: quote.name, requiresOtherContract: !!quote.bundle,
    label: t('promo.label', { ceme: quote.ceme, network: p.network, amount }),
    target: p.target, ...(p.eurKwh != null && { eurKwh: p.eurKwh }), ...(p.pct != null && { pct: p.pct }),
    total, saving, newCustomers: !!p.newCustomers, maxHours: p.maxHours ?? null,
    from: p.from, until: p.to, url: p.url, checked: p.checked, applied,
    note: p.newCustomers
      ? t('promo.note.new', { until: p.to, hours: p.maxHours })
      : t('promo.note.all', { until: p.to, tariff: `${quote.ceme} · ${quote.name}` }),
  };
}

// Every promotion that holds at this charger, among the tariffs that apply to
// the socket, as tips: one row per promotion, cheapest first. When a
// promotion covers several tariffs, the row shows the cheapest one that needs
// no other contract (a new customer of a CEME isn't its home-energy client
// yet), and only falls back to one that does.
//   quotes   ceme-v2 quotes that apply to this socket (ceme.js applicable)
//   applied  ids of the promotions already in a shown option's total
export function promoTips(quotes, site, { opc, vat, applied = new Set(), networks }, t) {
  const best = new Map();
  for (const q of quotes) {
    for (const p of promosHere(q, site, networks)) {
      const plain = withPromos([], { energyEur: q.totalEur, opc, vat }).high;
      const total = withPromos([p], { energyEur: q.totalEur, opc, vat }).high;
      // An OPC discount at a charger whose fee we don't know saves nothing
      // we can show: leave it out rather than list a 0 € saving.
      if (!(plain - total > 0)) continue;
      const cur = best.get(p.id);
      const better = !cur || (!!q.bundle !== !!cur.q.bundle ? !q.bundle : total < cur.total);
      if (better) best.set(p.id, { p, q, total, saving: r2(plain - total) });
    }
  }
  return [...best.values()]
    .sort((a, b) => a.total - b.total)
    .map(({ p, q, total, saving }) => promoOut(p, { quote: q, total, saving, applied: applied.has(p.id) }, t));
}
