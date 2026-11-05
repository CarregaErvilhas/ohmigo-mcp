// Takes the repetition out of a pricing answer before it goes to the
// assistant. Everything in a tool result sits in the assistant's context for
// the rest of the conversation, and a ranking repeats a lot: the same car and
// start time give every charger the same assumptions, a promotion valid at any
// MOBI.E charger comes back whole at each one, and `headline` is usually a
// copy of `best`. Left in, about a third of a ranking is text the assistant
// has already read.
//
// The sentences stay sentences: the assistant follows "12 % charging losses"
// better than a code it would have to look up. What changes is where they
// sit:
//   assumptions  the ones every result has, said once at the top. Each result
//                keeps only its own. Only with two or more results: one
//                charger's answer is unchanged.
//   promos       a promotion that shows up at several chargers keeps, in each
//                result, its id, label and whatever differs there (total,
//                saving...). The fields that are equal everywhere sit once in
//                the top-level `promos`, by id.
//   sources      the source of the "direct" prices (the custofinal blog), once,
//                where an option names it (`source`).
//   best         whole, once: the option it is leaves `options`, which then
//                lists the other ways to pay.
//   headline     left out when it's `best`; otherwise it's one of the
//                options, named by `headlineTariffId`.
//   options      a CEME option's label is already "CEME · tariff", so `ceme`
//                and `name` go; flags that are false (requiresOtherContract,
//                walkUp, stale, no subscription) go too: absent means no.
//   driverNote   written for the driver, not for the assistant (quote.js,
//                promos.js). It goes in the result's `_meta`, which the
//                results page (ui/results.html) receives and the assistant
//                doesn't read.
//
// slim(data) changes the results in place and returns
// { data, meta }: the answer for the assistant, and the _meta for the page
// (null when there's nothing in it).

import { SOURCE } from './offers.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// `best` and `headline` are copies of options (quote.js): keep one of each.
function oneCopy(q) {
  const opts = q.options ?? [];
  if (q.best) {
    const i = opts.findIndex(o => same(o, q.best));
    if (i >= 0) opts.splice(i, 1);
  }
  if (q.headline) {
    if (!same(q.headline, q.best) && q.headline.tariffId && opts.some(o => same(o, q.headline))) q.headlineTariffId = q.headline.tariffId;
    else if (!same(q.headline, q.best)) return; // not an option: keep it whole
    delete q.headline;
  }
}

// What an option says twice, or says as "no".
const FALSE = { requiresOtherContract: false, walkUp: false, stale: false, subscription: null };
function trim(o) {
  if (!o) return;
  if (o.kind === 'ceme' && o.label === `${o.ceme} · ${o.name}`) { delete o.ceme; delete o.name; }
  for (const [k, v] of Object.entries(FALSE)) if (Object.hasOwn(o, k) && o[k] === v) delete o[k];
}

// Assumptions that every result has, in the order of the first one.
function commonAssumptions(results) {
  if (results.length < 2) return [];
  const [first, ...rest] = results.map(q => q.assumptions ?? []);
  return [...new Set(first)].filter(a => rest.every(list => list.includes(a)));
}

// The driver's notes, by point: { [pointId]: { note, promos: { [id]: text } } }.
function driverNotes(results) {
  const out = {};
  for (const q of results) {
    const d = {};
    if (q.driverNote) d.note = q.driverNote;
    delete q.driverNote;
    for (const p of q.promos ?? []) {
      if (p.driverNote) (d.promos ??= {})[p.id] = p.driverNote;
      delete p.driverNote;
    }
    if (Object.keys(d).length) out[q.pointId] = d;
  }
  return out;
}

// Promotion rows by id, across results. A row keeps `id` and `label` always:
// the assistant reads the label where it reads the price.
const KEEP = new Set(['id', 'label']);
function sharedPromos(results) {
  const byId = new Map();
  for (const q of results) for (const p of q.promos ?? []) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
  const out = {};
  for (const [id, rows] of byId) {
    if (rows.length < 2) continue;
    const shared = Object.keys(rows[0]).filter(k => !KEEP.has(k) && rows.every(r => Object.hasOwn(r, k) && same(r[k], rows[0][k])));
    if (!shared.length) continue;
    out[id] = Object.fromEntries(shared.map(k => [k, rows[0][k]]));
    for (const r of rows) for (const k of shared) delete r[k];
  }
  return out;
}

export function slim(data) {
  const { results = [], ...head } = data;
  // First, before a promotion's fields move to the top.
  const notes = driverNotes(results);
  const common = commonAssumptions(results);
  if (common.length) for (const q of results) q.assumptions = q.assumptions.filter(a => !common.includes(a));
  const promos = sharedPromos(results);
  for (const q of results) {
    oneCopy(q);
    for (const o of [q.best, q.headline, ...(q.options ?? [])]) trim(o);
  }
  const fromBlog = results.some(q => (q.options ?? []).some(o => o.source === 'custofinal'));
  return {
    data: {
      ...head,
      ...(common.length && { assumptions: common }),
      ...(fromBlog && { sources: { custofinal: `${SOURCE.name} (${SOURCE.author}), ${SOURCE.blog}` } }),
      ...(Object.keys(promos).length && { promos }),
      results,
    },
    meta: Object.keys(notes).length ? { driverNotes: notes } : null,
  };
}
