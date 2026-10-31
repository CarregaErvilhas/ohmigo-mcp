// CEME promotions, most of them on one charging network.
//
// Some CEMEs strike deals with a charger operator (OPC): LUZiGÁS takes
// 0.12 €/kWh off its promotional tariff at Powerdot chargers for new sign-ups,
// miio one takes 45 % off Powerdot's own fee, EDP charges UVE members one
// all-in price on its own network. Others hold anywhere: GoldEnergy gives its
// electricity clients the first 7 kWh of each month. These are CEME offers,
// so they live in ceme-v2 (PROMOS in its seed-data.js), next to the tariffs,
// and ceme-v2 does the math. But ceme-v2 prices a session without knowing
// the charger, so it can't tell whether a promotion applies: each tariff
// comes back with its `promos`, tagged with a network name (or none: any
// MOBI.E charger), and this module decides, per charger, which hold here.
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
// Four targets:
//   ENERGIA     ceme-v2 sends `totalEur`: the CEME part of the session with
//               the discount already in (energy + TAR - discount, then IEC,
//               EGME, VAT);
//   OPC         `pct` off the operator's fee, which ohmigo computes (opc.js),
//               so we apply it here;
//   FINAL       ceme-v2 sends `totalEur` for the WHOLE session, operator fee
//               included: it replaces the CEME + OPC sum. It's what you're
//               billed, so it applies even where the usual sum is lower;
//   KWH_GRATIS  the first `freeKwh` of each calendar month are free. ohmigo
//               stores nothing, so the assistant tells us how much the user
//               already charged this month (`month_kwh`), we pass it to
//               ceme-v2, and its `totalEur` has the free kWh still left at the
//               start of this session. Only applied when that count came in
//               (`monthKwhKnown`); otherwise it's a tip, like a new-customer
//               promotion, priced as if none were used yet.

import { readFileSync } from 'node:fs';

export const NETWORKS = JSON.parse(readFileSync(new URL('../offers/networks.json', import.meta.url), 'utf8')).networks;

const r2 = x => Math.round(x * 100) / 100;

// Is this site on the network a promotion names? An unknown label, or one we
// can't pin to operators (scope "unknown"), matches nothing: better to miss a
// discount than to promise one that isn't there.
export function onNetwork(site, network, networks = NETWORKS) {
  if (network == null) return true; // any MOBI.E charger
  const n = networks[network];
  if (!n) return false;
  if (n.scope === 'mobie') return true;
  return !!n.operatorIds?.includes(site.operatorId);
}

// The promotions of one ceme-v2 tariff quote that hold at this site.
export const promosHere = (quote, site, networks) => (quote.promos || []).filter(p => onNetwork(site, p.network, networks));

// Does a promotion go into the option's total for whoever pays with that
// tariff? Not a new-customer one, and not free kWh we can't count.
export const appliesToCustomers = p => !p.newCustomers && (p.target !== 'KWH_GRATIS' || p.monthKwhKnown);

// What a session costs with a set of promotions on top of one tariff.
//   energyEur  ceme-v2's total for the tariff (energy part, VAT included)
//   opc        { low, high } operator fee, excl. VAT (opc.js)
//   vat        the region's VAT multiplier
// Energy discounts (and free kWh) don't stack: each `totalEur` is computed
// alone, so take the lowest. OPC discounts don't either (take the biggest).
// An energy and an OPC discount do stack: they cut different lines of the
// bill. A FINAL price replaces the whole bill, so it wins over the rest
// (the lowest, if two).
export function withPromos(promos, { energyEur, opc, vat }) {
  const final = promos.filter(p => p.target === 'FINAL' && p.totalEur != null);
  if (final.length) {
    const total = Math.min(...final.map(p => p.totalEur));
    return { energyEur: null, opcPct: 0, final: true, low: total, high: total };
  }
  const energy = promos.filter(p => (p.target === 'ENERGIA' || p.target === 'KWH_GRATIS') && p.totalEur != null)
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
//   driverNote the note for ui/results.html, when `note` tells the assistant
//              what to do
export function promoOut(p, { quote, total, saving, applied }, t) {
  const amount = {
    ENERGIA: () => t('promo.energy', { eur: t.num(p.eurKwh, 4, 2) }),
    OPC: () => t('promo.opc', { pct: t.num(p.pct, 1) }),
    FINAL: () => t('promo.final', { eur: t.num(p.eurKwh, 4, 2) }),
    KWH_GRATIS: () => t('promo.free', { kwh: t.num(p.freeKwh, 1) }),
  }[p.target]();
  const tariff = `${quote.ceme} · ${quote.name}`;
  const notes = [p.newCustomers
    ? t('promo.note.new', { until: p.to, hours: p.maxHours })
    : t(p.network ? 'promo.note.all' : 'promo.note.allAny', { until: p.to, tariff })];
  if (p.target === 'FINAL') notes.push(t('promo.note.final'));
  if (p.target === 'KWH_GRATIS') {
    notes.push(p.monthKwhKnown
      ? t('promo.note.freeLeft', { left: t.num(p.freeKwhLeft, 2), free: t.num(p.freeKwh, 1) })
      : t('promo.note.freeUnknown', { free: t.num(p.freeKwh, 1) }));
  }
  return {
    id: p.id, ceme: quote.ceme, tariffId: quote.id, tariffName: quote.name, requiresOtherContract: !!quote.bundle,
    label: p.network ? t('promo.label', { ceme: quote.ceme, network: p.network, amount }) : t('promo.labelAny', { ceme: quote.ceme, amount }),
    target: p.target, network: p.network ?? null,
    ...(p.eurKwh != null && { eurKwh: p.eurKwh }), ...(p.pct != null && { pct: p.pct }),
    ...(p.target === 'KWH_GRATIS' && { freeKwh: p.freeKwh, freeKwhLeft: p.freeKwhLeft, monthKwhKnown: !!p.monthKwhKnown }),
    total, saving, newCustomers: !!p.newCustomers, maxHours: p.maxHours ?? null,
    from: p.from, until: p.to, url: p.url, checked: p.checked, applied,
    note: notes.join('; '),
    ...(p.target === 'KWH_GRATIS' && !p.monthKwhKnown && { driverNote: [...notes.slice(0, -1), t('promo.note.freeUnknown.driver', { free: t.num(p.freeKwh, 1) })].join('; ') }),
  };
}

// Every promotion that holds at this charger, among the tariffs that apply to
// the socket, as tips: one row per promotion, cheapest first. When a
// promotion covers several tariffs, the row shows, in this order: one of the
// options shown (so the tip matches the price above it), one that needs no
// other contract (a new customer of a CEME isn't its home-energy client
// yet), the cheapest.
//   quotes   ceme-v2 quotes that apply to this socket (ceme.js applicable)
//   applied  ids of the promotions already in a shown option's total
//   shown    tariff ids of the CEME options shown
export function promoTips(quotes, site, { opc, vat, applied = new Set(), shown = new Set(), networks }, t) {
  const best = new Map();
  for (const q of quotes) {
    for (const p of promosHere(q, site, networks)) {
      const plain = withPromos([], { energyEur: q.totalEur, opc, vat }).high;
      const total = withPromos([p], { energyEur: q.totalEur, opc, vat }).high;
      // A promotion that saves nothing here (an OPC discount where the fee
      // is unknown, an all-in price above the usual sum, free kWh already
      // used) is left out, unless it's already in a shown total: then the
      // user needs to see why the price is what it is.
      if (!(plain - total > 0) && !applied.has(p.id)) continue;
      const cur = best.get(p.id);
      const rank = x => [shown.has(x.id) ? 0 : 1, x.bundle ? 1 : 0];
      const [a, b] = cur ? [rank(q), rank(cur.q)] : [];
      const better = !cur || (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : total < cur.total);
      if (better) best.set(p.id, { p, q, total, saving: r2(plain - total) });
    }
  }
  return [...best.values()]
    .sort((a, b) => a.total - b.total)
    .map(({ p, q, total, saving }) => promoOut(p, { quote: q, total, saving, applied: applied.has(p.id) }, t));
}
