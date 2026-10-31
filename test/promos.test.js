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
  assert.deepEqual(withPromos([], { energyEur: 10, opc, vat }), { energyEur: 10, opcPct: 0, low: 12.46, high: 14.92, applied: [] });
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
  const ctx = { opc: { low: 3, high: 3 }, vat: 1.23, applied: new Map([[miioOne.id, new Set(['miio-bt-miioonebi'])]]) };
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

const uve = { id: 'edp-uve-2026-09', network: 'EDP', target: 'FINAL', eurKwh: 0.47, totalEur: 14.1, newCustomers: false, from: '2026-09-01', to: '2026-12-31', url: 'https://example.pt', checked: '2026-10-29' };
const gold = (extra) => ({ id: 'goldenergy-7kwh', network: null, target: 'KWH_GRATIS', freeKwh: 7, totalEur: 6, newCustomers: false, from: '2026-10-29', to: '2026-12-31', url: 'https://example.pt', checked: '2026-10-29', ...extra });

test('withPromos: an all-in price replaces energy + fee, and beats the other promotions', () => {
  const w = withPromos([miioOne, uve], { energyEur: 10, opc: { low: 1, high: 3 }, vat: 1.23 });
  assert.deepEqual(w, { energyEur: null, opcPct: 0, final: true, low: 14.1, high: 14.1, applied: [uve] });
});

test('withPromos: applied names only the promotions that moved the total', () => {
  const opc = { low: 2, high: 4 }, vat = 1.23;
  const ids = (promos, o = opc, energyEur = 10) => withPromos(promos, { energyEur, opc: o, vat }).applied.map(p => p.id);
  const dear = { ...luzigas, id: 'dear', totalEur: 5 };
  assert.deepEqual(ids([dear, luzigas]), [luzigas.id], 'two energy discounts: the lowest total only');
  assert.deepEqual(ids([{ ...dear, id: 'twin', totalEur: 4.1 }, luzigas]), ['twin'], 'a tie: one of them, not both');
  assert.deepEqual(ids([{ ...miioOne, id: 'small', pct: 10 }, miioOne]), [miioOne.id], 'two OPC discounts: the biggest only');
  assert.deepEqual(ids([luzigas, miioOne]), [luzigas.id, miioOne.id], 'energy and OPC cut different lines');
  assert.deepEqual(ids([luzigas, miioOne, { ...uve, id: 'dearer', totalEur: 20 }, uve]), [uve.id], 'the lowest all-in price replaces the rest');
  assert.deepEqual(ids([uve], opc, 1), [uve.id], 'an all-in price counts even above the usual sum: it is the bill');
  assert.deepEqual(ids([{ ...luzigas, totalEur: 10 }]), [], 'no lower than the tariff: nothing to claim');
  assert.deepEqual(ids([{ ...uve, totalEur: null }]), [], 'an all-in price without a total is not in the bill');
  const noFee = withPromos([miioOne], { energyEur: 10, opc: { low: 0, high: 0 }, vat });
  assert.deepEqual([noFee.applied, noFee.opcPct], [[], 0], 'no operator fee: nothing to discount');
});

test('an unknown target is skipped, with one warning per target', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const seen = target => warn.mock.calls.filter(c => c.arguments.join(' ').includes(target)).length;
  const odd = { ...miioOne, id: 'odd', target: 'CASHBACK' };
  assert.deepEqual(promosHere({ promos: [odd, miioOne, { ...odd, id: 'odd2' }] }, powerdot).map(p => p.id), [miioOne.id]);
  promosHere({ promos: [odd] }, powerdot);
  promosHere({ promos: [{ ...odd, target: 'constructor' }] }, powerdot);
  assert.equal(seen('CASHBACK'), 1);
  assert.equal(seen('constructor'), 1, 'not a known target, whatever Object.prototype says');
  const quotes = [{ id: 'miio-bt-miioonebi', ceme: 'miio', name: 'miio one', totalEur: 7, promos: [odd, miioOne] }];
  const tips = promoTips(quotes, powerdot, { opc: { low: 3, high: 3 }, vat: 1.23 }, translator('en'));
  assert.deepEqual(tips.map(p => p.id), [miioOne.id]);
});

test('a promotion with no end date never reads "until null"', () => {
  const quotes = [
    { id: 'a', ceme: 'miio', name: 'miio one', totalEur: 7, promos: [{ ...miioOne, to: null }] },
    { id: 'b', ceme: 'Gold', name: 'Clientes', totalEur: 7, promos: [gold({ to: null, monthKwhKnown: true, freeKwhLeft: 2 })] },
    { id: 'c', ceme: 'LUZiGÁS', name: 'Indexado', totalEur: 9, promos: [{ ...luzigas, id: 'new-open', to: null }] },
    { id: 'd', ceme: 'LUZiGÁS', name: 'Sem prazo', totalEur: 9, promos: [{ ...luzigas, id: 'new-bare', to: null, maxHours: null }] },
  ];
  const cases = [
    ['en', /null|undefined|until|sign up by/, 'new customers only: the discount lasts 168 h after signing up. Not in any total', 'new customers only. Not in any total'],
    ['pt', /null|undefined|até/, 'só para clientes novos: o desconto dura 168 h após a adesão. Não entra em nenhum total', 'só para clientes novos. Não entra em nenhum total'],
  ];
  for (const [lang, none, open, bare] of cases) {
    const t = translator(lang);
    const tips = promoTips(quotes, powerdot, { opc: { low: 3, high: 3 }, vat: 1.23 }, t);
    assert.equal(tips.length, 4);
    for (const p of tips) {
      assert.doesNotMatch(p.note, none, p.id);
      assert.equal(p.until, null);
      assert.doesNotMatch(t('assume.promo', { label: p.label, until: p.until }), /null|undefined|until|\(até/);
    }
    assert.equal(tips.find(p => p.id === 'new-open').note, open);
    assert.equal(tips.find(p => p.id === 'new-bare').note, bare);
  }
  assert.match(translator('en')('assume.promo', { label: 'X', until: '2026-12-31' }), /\(until 2026-12-31\)$/);
  assert.match(translator('pt')('promo.note.new', { until: '2026-12-31', hours: 168 }), /adesão até 2026-12-31, e o desconto dura 168 h/);
});

test('promoTips: a promotion beaten on its own tariff says so instead of offering a saving on top', () => {
  const small = { ...luzigas, id: 'small', newCustomers: false, totalEur: 6 };
  const big = { ...small, id: 'big', totalEur: 5 };
  const quotes = [{ id: 'a', ceme: 'miio', name: 'miio one', totalEur: 7, promos: [small, big] }];
  const ctx = { opc: { low: 1, high: 1 }, vat: 1.23, applied: new Map([['big', new Set(['a'])]]), shown: new Set(['a']) };
  for (const [lang, re] of [['en', /it doesn't add to the promotion already in this price/], ['pt', /não se soma à promoção que já está neste preço/]]) {
    const tips = promoTips(quotes, powerdot, ctx, translator(lang));
    assert.deepEqual(tips.map(p => [p.id, p.applied]), [['big', true], ['small', false]]);
    assert.doesNotMatch(tips[0].note, re);
    assert.match(tips[1].note, re);
    assert.equal(tips[1].total, tips[0].total, 'the price itself, no competing total');
    assert.equal(tips[1].saving, 0);
  }
});

test('promoTips: an all-in price that won, dearer than the sum, beats a discount; a lost all-in price has no all-in note', () => {
  const opc = { low: 1, high: 1 }, vat = 1.23;
  const energy = { ...luzigas, id: 'energy', newCustomers: false, totalEur: 6 };
  const allIn = { ...uve, network: 'Powerdot', id: 'all-in', totalEur: 10 };
  const cheapAllIn = { ...allIn, id: 'cheap-all-in', totalEur: 7 };
  const dearAllIn = { ...allIn, id: 'dear-all-in', totalEur: 7.5 };
  const tip = promos => promoTips([{ id: 'a', ceme: 'X', name: 'Y', totalEur: 7, promos }], powerdot, { opc, vat, applied: new Map([[promos.at(-1).id, new Set(['a'])]]), shown: new Set(['a']) }, translator('en'));
  const [won, lost] = tip([energy, allIn]);
  assert.deepEqual([won.id, won.total, won.applied], ['all-in', 10, true]);
  assert.deepEqual([lost.id, lost.total, lost.saving, lost.applied], ['energy', 10, 0, false]);
  assert.match(lost.note, /already in this price/);
  assert.doesNotMatch(lost.note, /better/);
  const rows = tip([dearAllIn, cheapAllIn]);
  const dear = rows.find(p => p.id === 'dear-all-in');
  assert.deepEqual([dear.total, dear.saving], [7, 0]);
  assert.match(dear.note, /already in this price/);
  assert.doesNotMatch(dear.note, /replaces the usual/);
  assert.match(rows.find(p => p.id === 'cheap-all-in').note, /replaces the usual/);
});

test('promoTips: a new-customer or uncounted free-kWh tip is beaten only by what it would not stack with', () => {
  const opc = { low: 1, high: 1 }, vat = 1.23;
  const inPrice = { ...luzigas, id: 'in-price', newCustomers: false, totalEur: 5 };
  const newSmall = { ...luzigas, id: 'new-small', totalEur: 6 };
  const newBig = { ...luzigas, id: 'new-big', totalEur: 4 };
  const uncounted = gold({ id: 'uncounted', monthKwhKnown: false, freeKwhLeft: 7, totalEur: 6 });
  const ctx = { opc, vat, applied: new Map([['in-price', new Set(['a'])]]), shown: new Set(['a']) };
  const rows = promoTips([{ id: 'a', ceme: 'X', name: 'Y', totalEur: 7, promos: [inPrice, newSmall, newBig, uncounted, { ...miioOne, id: 'new-opc', newCustomers: true }] }], powerdot, ctx, translator('en'));
  const row = id => rows.find(p => p.id === id);
  assert.match(row('new-small').note, /new customers only.*already in this price/);
  assert.deepEqual([row('new-small').total, row('new-small').saving], [row('in-price').total, 0]);
  assert.doesNotMatch(row('new-big').note, /already in this price/, 'cheaper than what is in: it would win');
  assert.doesNotMatch(row('new-opc').note, /already in this price/, 'energy and OPC stack');
  assert.match(row('uncounted').note, /already in this price/);
  assert.doesNotMatch(row('uncounted').note, /pass month_kwh/, 'the count would not change it');
});

test('promoTips: a row with applied true is the tariff it applied on, not a cheaper one', () => {
  const quotes = [
    { id: 'tip', ceme: 'Enable', name: 'Simples', totalEur: 5, promos: [miioOne] },
    { id: 'mine', ceme: 'miio', name: 'miio one', totalEur: 9, promos: [miioOne] },
  ];
  const [row] = promoTips(quotes, powerdot, { opc: { low: 3, high: 3 }, vat: 1.23, applied: new Map([[miioOne.id, new Set(['mine'])]]), shown: new Set(['tip', 'mine']) }, translator('en'));
  assert.deepEqual([row.tariffId, row.applied], ['mine', true]);
});

test('free kWh: any MOBI.E charger; in the total only when the month count came in', async () => {
  const { appliesToCustomers } = await import('../src/promos.js');
  assert.equal(onNetwork(galp, null), true);
  assert.equal(appliesToCustomers(gold({ monthKwhKnown: false, freeKwhLeft: 7 })), false);
  assert.equal(appliesToCustomers(gold({ monthKwhKnown: true, freeKwhLeft: 2 })), true);
  const q = { id: 'goldenergy-bt-clientesgold', ceme: 'GoldEnergy', name: 'Clientes', totalEur: 8, bundle: true };
  const ctx = { opc: { low: 1, high: 1 }, vat: 1.23 };
  const [unknown] = promoTips([{ ...q, promos: [gold({ monthKwhKnown: false, freeKwhLeft: 7 })] }], galp, ctx, translator('en'));
  assert.equal(unknown.label, 'GoldEnergy: first 7 kWh of each month free');
  assert.deepEqual([unknown.freeKwhLeft, unknown.monthKwhKnown, unknown.saving], [7, false, 2]);
  assert.match(unknown.note, /pass month_kwh/);
  const [known] = promoTips([{ ...q, promos: [gold({ monthKwhKnown: true, freeKwhLeft: 2, totalEur: 7.4 })] }], galp, ctx, translator('pt'));
  assert.match(known.note, /restam 2 dos 7 kWh grátis/);
  // All seven used: saves nothing, so no tip... unless the tariff is shown:
  // then the user needs to see why no free kWh came off. Never as applied.
  const used = [{ ...q, promos: [gold({ monthKwhKnown: true, freeKwhLeft: 0, totalEur: 8 })] }];
  assert.deepEqual(promoTips(used, galp, ctx, translator('en')), []);
  const [spent] = promoTips(used, galp, { ...ctx, shown: new Set([q.id]) }, translator('en'));
  assert.equal(spent.applied, false);
  assert.match(spent.note, /all of this month's 7 free kWh are used, so none come off this session/);
  assert.doesNotMatch(spent.note, /used first/);
  const [gasto] = promoTips(used, galp, { ...ctx, shown: new Set([q.id]) }, translator('pt'));
  assert.match(gasto.note, /os 7 kWh grátis deste mês já foram todos gastos, por isso nenhum sai deste carregamento/);
  // Free kWh left but no saving here isn't "run out": no row, nothing to explain.
  const idle = [{ ...q, promos: [gold({ monthKwhKnown: true, freeKwhLeft: 2, totalEur: 8 })] }];
  assert.deepEqual(promoTips(idle, galp, { ...ctx, shown: new Set([q.id]) }, translator('en')), []);
});

test('promoTips: a tariff shown above wins, so the tip matches the price', () => {
  const quotes = [
    { id: 'edp-bt-cartoedp-4', ceme: 'EDP', name: 'UVE 30%', totalEur: 6, bundle: true, promos: [{ ...uve, totalEur: 14 }] },
    { id: 'edp-bt-cartoedp-2', ceme: 'EDP', name: 'UVE 10%', totalEur: 7, bundle: true, promos: [{ ...uve, totalEur: 14 }] },
  ];
  const [tip] = promoTips(quotes, { operatorId: 'EDPC' }, { opc: { low: 10, high: 10 }, vat: 1.23, shown: new Set(['edp-bt-cartoedp-2']) }, translator('pt'));
  assert.equal(tip.tariffId, 'edp-bt-cartoedp-2');
  assert.equal(tip.label, 'EDP nos postos EDP: 0,47 €/kWh tudo incluído (tarifa do operador e IVA incluídos)');
  assert.match(tip.note, /nesta rede, até 2026-12-31; substitui/);
});
