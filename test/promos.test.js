import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onNetwork, promosHere, promoTips, withPromos } from '../src/promos.js';
import { translator } from '../src/i18n.js';

// What ceme-v2 sends in each tariff's `promos` (see its docs/04).
const luzigas = { id: 'luzigas-powerdot-2026-10', network: 'Powerdot', target: 'ENERGIA', eurKwh: 0.12, totalEur: 4.1, newCustomers: true, maxHours: 168, from: '2026-10-29', to: '2026-11-28', url: 'https://example.pt', checked: '2026-10-29' };
const miioOne = { id: 'miio-powerdot-2026-02', network: 'Powerdot', target: 'OPC', pct: 45, newCustomers: false, from: '2026-02-03', to: '2026-12-31', url: 'https://example.pt', checked: '2026-10-29' };
const powerdot = { operatorId: 'HORZ' };
const galp = { operatorId: 'GLPP' };

test('onNetwork: by the operator ids in offers/networks.json', () => {
  assert.equal(onNetwork(powerdot, 'Powerdot'), true);
  assert.equal(onNetwork(galp, 'Powerdot'), false);
  assert.equal(onNetwork(galp, 'Rede Mobi.E'), true, 'scope mobie = every MOBI.E charger');
  assert.equal(onNetwork(powerdot, 'Alguns Mobi.E'), false, "scope unknown: can't tell which, so none");
  assert.equal(onNetwork(powerdot, 'Rede Inventada'), false, 'a label networks.json lacks matches nothing');
});

test('promosHere: only the ones at this network', () => {
  const q = { promos: [luzigas, { ...miioOne, network: 'Ionity' }] };
  assert.deepEqual(promosHere(q, powerdot).map(p => p.id), [luzigas.id]);
  assert.deepEqual(promosHere({}, powerdot), [], 'a ceme-v2 without promos');
});

test('withPromos: energy takes the lowest total, OPC the biggest %, and they stack', () => {
  const opc = { low: 2, high: 4 }, vat = 1.23;
  assert.deepEqual(withPromos([], { energyEur: 10, opc, vat }), { energyEur: 10, opcPct: 0, low: 12.46, high: 14.92 });
  const e = withPromos([luzigas, { ...luzigas, totalEur: 5 }], { energyEur: 10, opc, vat });
  assert.equal(e.energyEur, 4.1);
  const o = withPromos([miioOne, { ...miioOne, pct: 10 }], { energyEur: 10, opc, vat });
  assert.equal(o.opcPct, 45);
  assert.equal(o.high, Math.round((10 + 4 * 0.55 * 1.23) * 100) / 100);
  const both = withPromos([luzigas, miioOne], { energyEur: 10, opc, vat });
  assert.equal(both.high, Math.round((4.1 + 4 * 0.55 * 1.23) * 100) / 100);
});

test('promoTips: one row per promotion at its cheapest tariff, with labels in both languages', () => {
  const quotes = [
    { id: 'luzigas-ceme-bt', ceme: 'LUZiGÁS', name: 'Indexado', totalEur: 9, promos: [{ ...luzigas, totalEur: 4 }] },
    { id: 'luzigas-k0010-bt', ceme: 'LUZiGÁS', name: 'K=0,010', totalEur: 8, promos: [{ ...luzigas, totalEur: 3.5 }] },
    { id: 'miio-bt-miioonebi', ceme: 'miio', name: 'miio one', totalEur: 7, promos: [miioOne] },
  ];
  const ctx = { opc: { low: 3, high: 3 }, vat: 1.23, applied: new Set([miioOne.id]) };
  const en = promoTips(quotes, powerdot, ctx, translator('en'));
  // Cheapest first: LUZiGÁS 3.50 + 3.69 = 7.19 €, miio one 7 + 2.03 = 9.03 €.
  assert.deepEqual(en.map(p => [p.id, p.tariffId]), [[luzigas.id, 'luzigas-k0010-bt'], [miioOne.id, 'miio-bt-miioonebi']]);
  const [l, m] = en;
  assert.equal(m.applied, true);
  assert.equal(m.saving, Math.round(3 * 0.45 * 1.23 * 100) / 100);
  assert.equal(l.applied, false);
  assert.equal(l.total, Math.round((3.5 + 3 * 1.23) * 100) / 100);
  assert.equal(l.label, 'LUZiGÁS at Powerdot: −0.12 €/kWh on energy');
  assert.match(l.note, /new customers only/);
  const pt = promoTips(quotes, powerdot, ctx, translator('pt'));
  assert.equal(pt[0].label, 'LUZiGÁS nos postos Powerdot: −0,12 €/kWh na energia');
  assert.equal(pt[1].label, 'miio nos postos Powerdot: −45% na tarifa do operador');
  assert.deepEqual(promoTips(quotes, galp, ctx, translator('en')), [], 'not at Galp');
});

test('promoTips: prefers a tariff that needs no other contract, even if dearer', () => {
  const quotes = [
    { id: 'luzigas-casa-bt', ceme: 'LUZiGÁS', name: 'Cliente Casa', totalEur: 6, bundle: true, promos: [{ ...luzigas, totalEur: 2 }] },
    { id: 'luzigas-ceme-bt', ceme: 'LUZiGÁS', name: 'Cliente CEME', totalEur: 9, promos: [{ ...luzigas, totalEur: 4 }] },
  ];
  const [tip] = promoTips(quotes, powerdot, { opc: { low: 1, high: 1 }, vat: 1.23 }, translator('en'));
  assert.equal(tip.tariffId, 'luzigas-ceme-bt');
  assert.equal(tip.requiresOtherContract, false);
  const [only] = promoTips(quotes.slice(0, 1), powerdot, { opc: { low: 1, high: 1 }, vat: 1.23 }, translator('en'));
  assert.equal(only.requiresOtherContract, true, 'falls back to one that does');
});

test('promoTips: an OPC discount where the fee is unknown saves nothing and is left out', () => {
  const quotes = [{ id: 'miio-bt-miioonebi', ceme: 'miio', name: 'miio one', totalEur: 7, promos: [miioOne] }];
  assert.deepEqual(promoTips(quotes, powerdot, { opc: { low: 0, high: 0 }, vat: 1.23 }, translator('en')), []);
});
