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

// What each target takes off, in words. Also the list of targets we can price.
const AMOUNT = {
  ENERGIA: (p, t) => t('promo.energy', { eur: t.num(p.eurKwh, 4, 2) }),
  OPC: (p, t) => t('promo.opc', { pct: t.num(p.pct, 1) }),
  FINAL: (p, t) => t('promo.final', { eur: t.num(p.eurKwh, 4, 2) }),
  KWH_GRATIS: (p, t) => t('promo.free', { kwh: t.num(p.freeKwh, 1) }),
};

// A target this code can't price (ceme-v2 added one first) is skipped: the
// tariff still has its price, only without that promotion (unpricedHere is
// what lets the estimate say so). One warning per target, or every quote
// would repeat it.
const warned = new Set();
function knownTarget(p) {
  if (Object.hasOwn(AMOUNT, p.target)) return true;
  if (!warned.has(p.target)) {
    warned.add(p.target);
    console.warn(`[ohmigo] CEME promotion ${p.id} skipped: unknown target ${p.target}`);
  }
  return false;
}

// The promotions of one ceme-v2 tariff quote that hold at this site.
export const promosHere = (quote, site, networks) => (quote.promos || []).filter(p => knownTarget(p) && onNetwork(site, p.network, networks));

// Could a promotion we skipped have changed this tariff's total here? Not a
// new-customer one: those are in no total anyway.
export const unpricedHere = (quote, site, networks) => (quote.promos || [])
  .some(p => !Object.hasOwn(AMOUNT, p.target) && !p.newCustomers && onNetwork(site, p.network, networks));

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
// `applied` is the promotions that took effect, and the only ones anyone may
// say are in the price: the others lost to one of these, or changed nothing
// (free kWh all used, a discount on an operator fee nobody publishes).
export function withPromos(promos, { energyEur, opc, vat }) {
  const lowest = (list, from) => list.filter(p => p.totalEur != null).reduce((m, p) => (p.totalEur < (m?.totalEur ?? from) ? p : m), null);
  const final = lowest(promos.filter(p => p.target === 'FINAL'), Infinity);
  if (final) return { energyEur: null, opcPct: 0, final: true, low: final.totalEur, high: final.totalEur, applied: [final] };
  const energy = lowest(promos.filter(p => p.target === 'ENERGIA' || p.target === 'KWH_GRATIS'), energyEur);
  const fee = opc.high > 0 ? promos.filter(p => p.target === 'OPC' && p.pct > 0).reduce((m, p) => (p.pct > (m?.pct ?? 0) ? p : m), null) : null;
  const eur = energy?.totalEur ?? energyEur, pct = fee?.pct ?? 0;
  const k = 1 - Math.min(pct, 100) / 100;
  return { energyEur: eur, opcPct: pct, low: r2(eur + opc.low * k * vat), high: r2(eur + opc.high * k * vat), applied: [energy, fee].filter(Boolean) };
}

// The promotion as the assistant sees it, with its label and note in the
// user's language (ceme-v2's own `name` is Portuguese only).
//   total      this session at this charger: with the promotion, or, when
//              it's applied, beaten or run out, the tariff's actual price
//   saving     what this promotion alone takes off the tariff, so the rows
//              of a stacked price add up to what the option saves; 0 if beaten
//   applied    took effect in the total of this tariff's option
//   beaten     it doesn't add to what's already in this tariff's price, so
//              it changes nothing there (the rest of its notes would mislead)
export function promoOut(p, { quote, total, saving, applied, beaten }, t) {
  const amount = AMOUNT[p.target](p, t);
  const tariff = `${quote.ceme} · ${quote.name}`;
  const notes = [p.newCustomers
    ? t('promo.note.new', { until: p.to, hours: p.maxHours })
    : t(p.network ? 'promo.note.all' : 'promo.note.allAny', { until: p.to, tariff })];
  if (beaten) notes.push(t('promo.note.beaten'));
  if (p.target === 'FINAL' && !beaten) notes.push(t('promo.note.final'));
  if (p.target === 'KWH_GRATIS' && !beaten) {
    notes.push(!p.monthKwhKnown ? t('promo.note.freeUnknown', { free: t.num(p.freeKwh, 1) })
      : p.freeKwhLeft === 0 ? t('promo.note.freeSpent', { free: t.num(p.freeKwh, 1) })
      : t('promo.note.freeLeft', { left: t.num(p.freeKwhLeft, 2), free: t.num(p.freeKwh, 1) }));
  }
  return {
    id: p.id, ceme: quote.ceme, tariffId: quote.id, tariffName: quote.name, requiresOtherContract: !!quote.bundle,
    label: p.network ? t('promo.label', { ceme: quote.ceme, network: p.network, amount }) : t('promo.labelAny', { ceme: quote.ceme, amount }),
    target: p.target, network: p.network ?? null,
    ...(p.eurKwh != null && { eurKwh: p.eurKwh }), ...(p.pct != null && { pct: p.pct }),
    ...(p.target === 'KWH_GRATIS' && { freeKwh: p.freeKwh, freeKwhLeft: p.freeKwhLeft, monthKwhKnown: !!p.monthKwhKnown }),
    total, saving, newCustomers: !!p.newCustomers, maxHours: p.maxHours ?? null,
    from: p.from, until: p.to ?? null, url: p.url, checked: p.checked, applied,
    note: notes.join('; '),
  };
}

// Every promotion that holds at this charger, among the tariffs that apply to
// the socket, as tips: one row per promotion, cheapest first. When a
// promotion covers several tariffs, the row shows, in this order: the tariff
// it took effect on (so the row is the price the user pays), one of the
// options shown (so the tip matches the price above it), one that needs no
// other contract (a new customer of a CEME isn't its home-energy client
// yet), the cheapest.
//   quotes   ceme-v2 quotes that apply to this socket (ceme.js applicable)
//   applied  Map: promotion id -> tariff ids whose shown total it took
//            effect in (withPromos' `applied`)
//   shown    tariff ids of the CEME options shown
export function promoTips(quotes, site, { opc, vat, applied = new Map(), shown = new Set(), networks }, t) {
  const inTotal = (p, q) => !!applied.get(p.id)?.has(q.id);
  const best = new Map();
  for (const q of quotes) {
    const ctx = { energyEur: q.totalEur, opc, vat };
    const here = promosHere(q, site, networks);
    if (!here.length) continue;
    const customers = here.filter(appliesToCustomers);
    const plain = withPromos([], ctx).high;
    const price = withPromos(customers, ctx).high; // the option's total (quote.js cemeOption)
    for (const p of here) {
      const alone = withPromos([p], ctx).high;
      const saves = plain - alone > 0;
      // A promotion that saves nothing here (an OPC discount where the fee
      // is unknown, an all-in price above the usual sum, free kWh already
      // used) is left out, unless it's in a shown total, or it's free kWh
      // run out on a shown tariff: the user needs to see why the price is
      // what it is.
      const spent = p.target === 'KWH_GRATIS' && p.monthKwhKnown && p.freeKwhLeft === 0 && shown.has(q.id);
      if (!saves && !inTotal(p, q) && !spent) continue;
      // Would it take effect next to what's already in this tariff's price?
      // A new-customer or uncounted free-kWh tip joins them to find out: it
      // goes last, so a tie stays with the promotion already in.
      // An all-in price replaces the rest, so it can win and still cost more
      // than what's in the price: that's no saving either.
      const dearer = p.target === 'FINAL' && !inTotal(p, q) && alone >= price;
      const beaten = saves && (dearer || !withPromos(customers.includes(p) ? customers : [...customers, p], ctx).applied.includes(p));
      const total = inTotal(p, q) || beaten || spent ? price : alone;
      const saving = beaten ? 0 : r2(plain - alone);
      const cur = best.get(p.id);
      const rank = x => [inTotal(p, x) ? 0 : 1, shown.has(x.id) ? 0 : 1, x.bundle ? 1 : 0];
      const [a, b] = cur ? [rank(q), rank(cur.q)] : [];
      const first = a?.findIndex((x, i) => x !== b[i]);
      const better = !cur || (first >= 0 ? a[first] < b[first] : total < cur.total);
      if (better) best.set(p.id, { p, q, total, saving, beaten });
    }
  }
  // At one price, the promotion that made it comes before those beaten by it.
  return [...best.values()]
    .sort((a, b) => a.total - b.total || inTotal(b.p, b.q) - inTotal(a.p, a.q))
    .map(({ p, q, total, saving, beaten }) => promoOut(p, { quote: q, total, saving, applied: inTotal(p, q), beaten }, t));
}
