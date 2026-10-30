// Direct offers: the blog parser, the manual overrides, and which offers
// apply at a charger. The fixture is a made-up table in the blog's layout,
// not a copy of the blog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bandFor, parseTables, toOffers } from '../src/offers-parse.js';
import { AUDIENCES, gaps, isStale, mergeOffers, noteFor, OFFERS, offersAt, ownWalkUp } from '../src/offers.js';

const HEAD = `<thead><tr><th rowspan="2">Operador - Plano</th><th rowspan="2">Postos</th><th colspan="2">AC</th><th colspan="6">DC</th></tr>
<tr><th>&le;7.4</th><th>11..22</th><th>≤50</th><th>100</th><th>120</th><th>150</th><th>180</th><th>&gt;180</th></tr></thead>`;
const FIXTURE = `<p>intro</p>
<table class="evtable"><caption>Preços por kWh — Sem promoções ou subscrições pagas</caption>${HEAD}<tbody>
<tr><td>Acme - TPA</td><td>Acme</td><td></td><td></td><td>0,60</td><td>0,70</td></tr>
<tr><td>Roamy</td><td>Rede Mobi.E</td><td>0,41</td><td>0,42</td><td>0,60</td><td>0,72</td><td>0,72</td><td>0,72</td><td>0,79</td><td>0,79</td></tr>
<tr><td>Somewhere - App</td><td>Alguns Mobi.E</td><td></td><td></td><td>0,5</td></tr>
<tr><td>Newco - QRCode</td><td>Newco</td><td>0,49</td></tr>
</tbody></table>
<table class="evtable"><caption>Preços por kWh — Subscrições pagas</caption>${HEAD}<tbody>
<tr><td>Acme - Plus 8€/mês</td><td>Acme</td><td></td><td></td><td>0,49</td><td>0,49</td><td>0,49</td><td>0,49</td><td>0,49</td><td>0,49</td></tr>
</tbody></table>
<table class="evtable evtable-scale"><tr><th>Preço kWh</th><td>0,30</td></tr></table>`;
const NETS = { 'Rede Mobi.E': { scope: 'mobie' }, 'Alguns Mobi.E': { scope: 'unknown' }, Acme: { operatorIds: ['ACME'] } };

test('parser: both tables, bands from the header, short rows, entities', () => {
  const t = parseTables(FIXTURE);
  assert.deepEqual(t.map(x => [x.kind, x.rows.length]), [['payg', 4], ['subscription', 1]]);
  assert.deepEqual(t[0].bands, ['ac7', 'ac22', 'dc50', 'dc100', 'dc120', 'dc150', 'dc180', 'dcMax']);
  assert.deepEqual(t[0].rows[0].prices, { ac7: null, ac22: null, dc50: 0.6, dc100: 0.7, dc120: null, dc150: null, dc180: null, dcMax: null });
});

test('parser: a layout change fails loudly', () => {
  assert.throws(() => parseTables(FIXTURE.replace('<th>120</th>', '<th>125</th>')), /unknown power band "125"/);
  assert.throws(() => parseTables('<p>no tables</p>'), /no price tables/);
});

test('toOffers: scope from networks.json, walk-up, fees, unmapped and unknown labels', () => {
  const r = toOffers(parseTables(FIXTURE), NETS, { url: 'u', checkedAt: '2026-10-14', origin: 'custofinal' });
  const by = Object.fromEntries(r.offers.map(o => [o.id, o]));
  assert.deepEqual(Object.keys(by).sort(), ['acme-plus-8-mes-acme', 'acme-tpa-acme', 'roamy-rede-mobi-e']);
  assert.equal(by['acme-tpa-acme'].walkUp, true);
  assert.deepEqual(by['acme-tpa-acme'].scope, { operatorIds: ['ACME'] });
  assert.deepEqual(by['roamy-rede-mobi-e'].scope, { mobie: true });
  assert.deepEqual(by['acme-plus-8-mes-acme'].fee, { eur: 8, per: 'month' });
  assert.equal(by['acme-plus-8-mes-acme'].subscription, true);
  assert.deepEqual(r.unmapped, ['Newco']);
  assert.deepEqual(r.skipped, ['Somewhere - App @ Alguns Mobi.E']);
});

test('bandFor: the blog power bands', () => {
  const b = (kw, dc) => bandFor({ kw, dc });
  assert.deepEqual([b(3.7, false), b(7.4, false), b(22, false), b(50, true), b(60, true), b(120, true), b(150, true), b(175, true), b(350, true), b(null, true)],
    ['ac7', 'ac7', 'ac22', 'dc50', 'dc100', 'dc120', 'dc150', 'dc180', 'dcMax', null]);
});

test('mergeOffers: manual overrides fields and prices band by band, adds, disables', () => {
  const scraped = [
    { id: 'a', label: 'A', prices: { dc50: 0.5, dcMax: 0.6 }, origin: 'custofinal' },
    { id: 'b', label: 'B', prices: { dc50: 0.4 }, origin: 'custofinal' },
  ];
  const merged = mergeOffers(scraped, [
    { id: 'a', prices: { dcMax: 0.63 }, why: 'official' },
    { id: 'b', disable: true },
    { id: 'c', add: true, label: 'C', prices: { dc50: 0.3 } },
  ]);
  assert.deepEqual(merged.map(o => [o.id, o.prices, o.origin]), [
    ['a', { dc50: 0.5, dcMax: 0.63 }, 'manual'],
    ['c', { dc50: 0.3 }, 'manual'],
  ]);
  assert.deepEqual(merged.orphans, []);
});

test('mergeOffers: a typo in an id is reported, never a phantom offer', () => {
  const scraped = [{ id: 'a', label: 'A', prices: { dc50: 0.5 } }];
  const merged = mergeOffers(scraped, [
    { id: 'a-typo', prices: { dc50: 0.4 } },
    { id: 'gone', disable: true },
    { id: 'a', add: true, label: 'A2', prices: { dc50: 0.1 } },
  ]);
  assert.deepEqual(merged.map(o => o.id), ['a']);
  assert.equal(merged[0].label, 'A', 'an "add" never replaces a scraped offer');
  assert.equal(merged.orphans.length, 3);
  assert.match(merged.orphans.join('\n'), /a-typo.*override/);
  assert.match(merged.orphans.join('\n'), /gone.*disable/);
});

test('offers/manual.json: every override and disable still matches the scrape', () => {
  assert.deepEqual(OFFERS.orphans, [], 'fix the id in offers/manual.json, or drop the entry');
});

test('offersAt: operator offers + MOBI.E-wide ones, priced for the band', () => {
  const ionity = { id: 'IOY-X', operatorId: 'IONY' };
  const at = offersAt(ionity, { kw: 350, dc: true, regime: 'mobie' });
  const ids = at.map(x => x.offer.id);
  assert.ok(ids.includes('ionity-tpa-ionity') && ids.includes('ionity-app-ionity'));
  assert.equal(at.find(x => x.offer.id === 'ionity-tpa-ionity').eurPerKwh, 0.63, 'manual.json wins over the blog');
  assert.ok(at.some(x => x.offer.scope.mobie), 'MOBI.E-wide offers apply at a MOBI.E charger');
  const labels = at.map(x => x.offer.label);
  assert.equal(labels.length, new Set(labels).size, 'a network-specific row replaces the same provider\'s MOBI.E-wide row');
  assert.equal(ownWalkUp(ionity, at), true);
  // Outside MOBI.E, MOBI.E-wide offers don't apply: Tesla, whose own blog
  // rows manual.json disables, gets none.
  assert.deepEqual(offersAt({ operatorId: 'TSLA' }, { kw: 250, dc: true, regime: 'sem_ceme' }), []);
  // An offer without a price for this band is not offered here.
  assert.ok(!offersAt(ionity, { kw: 22, dc: false, regime: 'mobie' }).some(x => x.offer.id === 'ionity-tpa-ionity'));
});

test('gaps: operators with direct-payment signals and no scoped offer', () => {
  const site = (operatorId, payment, adhoc) => ({ operatorId, operator: operatorId, payment, points: [{ opc: adhoc ? { AD_HOC_PAYMENT: {} } : {} }] });
  const g = gaps([site('IONY', ['creditCard'], true), site('AAA', ['apps', 'creditCard']), site('AAA', ['apps']), site('BBB', ['apps', 'rfid']), site('CCC', ['apps'], true)]);
  assert.deepEqual(g.map(o => [o.operatorId, o.sites, o.card, o.adhoc]), [['AAA', 2, 1, 0], ['CCC', 1, 0, 1]]);
});

test('isStale after 90 days', () => {
  assert.equal(isStale({ checkedAt: '2026-01-01' }, new Date('2026-10-28')), true);
  assert.equal(isStale({ checkedAt: '2026-10-01' }, new Date('2026-10-28')), false);
});

// The offers files are edited by hand (manual.json, networks.json) or by a
// bot (custofinal.json), so the tests are their validator.
test('offers files are well-formed', () => {
  const ids = new Set();
  for (const o of OFFERS) {
    assert.ok(!ids.has(o.id), `duplicate id ${o.id}`); ids.add(o.id);
    assert.ok(o.label && o.provider, `${o.id}: label and provider`);
    assert.ok(o.scope?.mobie === true || o.scope?.operatorIds?.length, `${o.id}: scope`);
    assert.match(o.source, /^https:\/\//, `${o.id}: https source`);
    assert.match(o.checkedAt, /^\d{4}-\d{2}-\d{2}$/, `${o.id}: checkedAt YYYY-MM-DD`);
    assert.ok(new Date(o.checkedAt) <= new Date(), `${o.id}: checkedAt in the future`);
    const prices = Object.values(o.prices).filter(v => v != null);
    assert.ok(prices.length, `${o.id}: at least one price`);
    for (const v of prices) assert.ok(v > 0 && v < 3, `${o.id}: ${v} €/kWh looks wrong`);
    if (o.subscription && o.fee) assert.ok(o.fee.eur > 0 && ['month', 'year'].includes(o.fee.per), `${o.id}: fee`);
  }
  const manual = JSON.parse(readFileSync(new URL('../offers/manual.json', import.meta.url), 'utf8')).offers;
  for (const m of manual) {
    assert.ok(m.id && (m.disable || (m.source && m.checkedAt)), `manual ${m.id}: source and checkedAt`);
  }
  const custofinal = JSON.parse(readFileSync(new URL('../offers/custofinal.json', import.meta.url), 'utf8'));
  assert.deepEqual(custofinal.unmapped, [], 'custofinal.json has unmapped networks: add them to offers/networks.json');
});

test('noteFor: a NAP-price note matches by operator or by site', () => {
  const notes = [{ scope: { operatorIds: ['CONT'] }, why: 'a' }, { scope: { siteIds: ['TSL-1'] }, why: 'b' }];
  assert.equal(noteFor(notes, { id: 'CONT-9', operatorId: 'CONT' })?.why, 'a');
  assert.equal(noteFor(notes, { id: 'TSL-1', operatorId: 'TSLA' })?.why, 'b');
  assert.equal(noteFor(notes, { id: 'TSL-2', operatorId: 'TSLA' }), null);
});

test('nap-notes.json: every note is scoped and sourced', () => {
  const { notes } = JSON.parse(readFileSync(new URL('../offers/nap-notes.json', import.meta.url), 'utf8'));
  for (const n of notes) {
    assert.ok(n.scope?.operatorIds?.length || n.scope?.siteIds?.length, JSON.stringify(n.scope));
    assert.ok(n.why && /^https:\/\//.test(n.source) && /^\d{4}-\d{2}-\d{2}$/.test(n.checkedAt), n.why);
  }
});

test('audience offers: hidden unless the driver claims the group; ids exist', () => {
  for (const o of OFFERS) if (o.audience) assert.ok(AUDIENCES[o.audience], `${o.id}: unknown audience ${o.audience}`);
  for (const [id, a] of Object.entries(AUDIENCES)) assert.ok(a.en && a.pt, id);
  const powerdot = { operatorId: 'HORZ' }, dc = { kw: 150, dc: true, regime: 'mobie' };
  const ids = audiences => offersAt(powerdot, dc, audiences).map(x => x.offer.id);
  assert.ok(!ids().includes('powerdot-uber-driver-powerdot'));
  assert.ok(!ids(['edp-staff']).includes('powerdot-uber-driver-powerdot'));
  const uber = offersAt(powerdot, dc, ['uber-driver']).find(x => x.offer.id === 'powerdot-uber-driver-powerdot');
  assert.equal(uber.eurPerKwh, 0.41);
  // The offers for everyone are still there.
  assert.deepEqual(ids().filter(id => id !== 'powerdot-uber-driver-powerdot'), ids(['uber-driver']).filter(id => id !== 'powerdot-uber-driver-powerdot'));
});

test('per-session fee: in the total, said in the note; staff offer is half of Electroverse', async () => {
  const { directOptionsForTest } = await import('../src/quote.js');
  const powerdot = { operatorId: 'HORZ' }, dc = { kw: 150, dc: true, regime: 'mobie' };
  const staff = offersAt(powerdot, dc, ['powerdot-staff']).find(x => x.offer.id === 'electroverse-powerdot-staff-powerdot');
  const ev = offersAt(powerdot, dc).find(x => x.offer.id === 'electroverse-rede-mobi-e');
  assert.equal(staff.eurPerKwh, ev.eurPerKwh / 2);
  const [o] = directOptionsForTest([staff], { kwh: 38.71 }, 'pt', 'CONT');
  assert.equal(o.total, 14.24); // 38,71 × 0,36 + 0,30
  assert.equal(o.audience, 'powerdot-staff');
  assert.match(o.note, /0,30 € por sessão/);
});
