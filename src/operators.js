// Prices charger operators sell directly, outside MOBI.E.
//
// Many chargers on MOBI.E can ALSO be paid straight to the operator: its own
// app, a walk-up price at the charger, or a subscription (IONITY, Powerdot,
// Atlante, Iberdrola | bp pulse...). The list keeps growing, and no open data
// publishes those prices: the NAP lists the same 54 CEME brands at every
// MOBI.E charger, and MOBI.E's tariff file only has the bank-card (ad hoc)
// price. So they live in offers/operator-offers.json, a file people maintain
// by hand, reviewed like code.
//
// What the data DOES tell us is which operators probably sell directly:
// sites that take bank cards / NFC / a website (the NAP's payment methods), or
// have an ad hoc price in MOBI.E's file, or publish a website. That's how
// `gaps()` finds operators missing from the file (`npm run offers:gaps`).
//
// Operators are matched by the NAP's operator_id (IONY, HORZ, ATLA...), not
// by name: Atlante alone appears under 7 spellings, all with id ATLA.
//
// The file goes stale. Every entry carries `source` and `checkedAt`, both
// shown to the user, and an entry older than STALE_DAYS is flagged as
// possibly out of date (still shown: an old price beats no price, as long as
// the user knows).

import { readFileSync } from 'node:fs';

export const STALE_DAYS = 90;

const FILE = new URL('../offers/operator-offers.json', import.meta.url);

// Loaded once at boot: changing the file means a redeploy, which is also
// what makes the change go through review.
export const OPERATOR_OFFERS = JSON.parse(readFileSync(FILE, 'utf8')).operators;

const byId = new Map();
for (const o of OPERATOR_OFFERS) for (const id of o.operatorIds) byId.set(id, o);

export function offersFor(site) {
  return (site?.operatorId && byId.get(site.operatorId)) || null;
}

export function isStale(offer, now = new Date()) {
  return (now - new Date(offer.checkedAt)) / 86_400_000 > STALE_DAYS;
}

// Payment methods (from the NAP) that let you pay at the charger without a
// CEME account.
const DIRECT_PAYMENT = new Set(['creditCard', 'debitCard', 'nfc', 'pinpad', 'website']);

// Operators that show signs of selling directly but have no entry in the
// file, biggest first. Signals, per site:
//   card     the NAP says you can pay with a card / NFC / pinpad / website
//   adhoc    MOBI.E's file has an ad hoc price for one of its sockets
//   website  the operator publishes a website (weak: most CEMEs do too)
export function gaps(sites) {
  const ops = new Map();
  for (const s of sites) {
    if (!s.operatorId || byId.has(s.operatorId)) continue;
    const o = ops.get(s.operatorId) || { operatorId: s.operatorId, names: new Set(), sites: 0, card: 0, adhoc: 0, website: null };
    o.sites++;
    if (s.operator) o.names.add(s.operator);
    if (s.payment?.some(m => DIRECT_PAYMENT.has(m))) o.card++;
    if (s.points.some(p => p.opc?.AD_HOC_PAYMENT)) o.adhoc++;
    o.website ||= s.website || null;
    ops.set(s.operatorId, o);
  }
  return [...ops.values()]
    .filter(o => o.card || o.adhoc)
    .map(o => ({ ...o, names: [...o.names] }))
    .sort((a, b) => b.sites - a.sites);
}
