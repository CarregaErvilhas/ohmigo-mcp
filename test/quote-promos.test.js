// quotePoint with CEME promotions, against a fake ceme-v2 (fetch is stubbed,
// nothing leaves the machine). Checks the rules in src/promos.js end to end:
// a promotion for every customer goes into its option's total and can change
// the headline; a new-customer one never changes a price, only shows as a tip;
// neither shows away from its network.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const quote = (id, ceme, name, totalEur, extra = {}) => ({
  id, ceme, name, voltage: 'BT', kind: 'FIXED', period: 'FORA_VAZIO', totalEur, vat: 1.23, popular: true, bundle: false, ...extra,
});
const LUZ_PROMO = { id: 'luzigas-powerdot-2026-10', network: 'Powerdot', target: 'ENERGIA', eurKwh: 0.12, totalEur: 4, newCustomers: true, maxHours: 168, from: '2026-10-29', to: '2026-11-28', url: 'https://example.pt', checked: '2026-10-29' };
const MIIO_PROMO = { id: 'miio-powerdot-2026-02', network: 'Powerdot', target: 'OPC', pct: 45, newCustomers: false, from: '2026-02-03', to: '2026-12-31', url: 'https://example.pt', checked: '2026-10-29' };
const UVE_PROMO = { id: 'edp-uve-2026-09', network: 'EDP', target: 'FINAL', eurKwh: 0.47, newCustomers: false, from: '2026-09-01', to: '2026-12-31', url: 'https://example.pt', checked: '2026-10-29' };
const SIM = {
  at: '2026-11-10T12:00:00.000Z', kwh: 30, profile: { slices: 1, withSpot: 0 },
  data: [
    quote('luzigas-ceme-bt', 'LUZiGÁS', 'Indexado', 8, { promos: [LUZ_PROMO] }),
    quote('miio-bt-miioonebi', 'miio', 'miio one', 8.5, { bundle: true, popular: false, promos: [MIIO_PROMO] }),
    quote('miio-bt-miiobihor', 'miio', 'miio sem subscrição', 10),
    // A FINAL total is whatever ceme-v2 says (kWh × price); a fixed 12 €
    // keeps the test independent of the session estimate.
    quote('edp-bt-cartoedp-2', 'EDP Comercial', 'Associados UVE', 7, { bundle: true, popular: false, promos: [{ ...UVE_PROMO, totalEur: 12 }] }),
  ],
};

let quotePoint;
before(async () => {
  globalThis.fetch = async (url) => {
    const body = String(url).endsWith('/v1/session') ? { token: 't', expires_in: 3600 } : SIM;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  ({ quotePoint } = await import('../src/quote.js'));
});

// A 50 kW DC socket with a 1 € flat + 0.20 €/kWh operator fee (excl. VAT).
const point = { id: '1', kw: 50, dc: true, connector: 'CCS', regime: 'mobie', level: 'BTN', opc: { REGULAR: { flat: [1], energy: [0.2], time: [] } } };
const site = (operatorId) => ({ id: `${operatorId}-1`, code: 'X', operatorId, operator: operatorId, region: 'CONT', lat: 39, lon: -9 });
const car = { batteryKwh: 60, startPct: 20, targetPct: 70, dcKw: 100 };
const at = new Date('2026-11-10T12:00:00Z');
const r2 = x => Math.round(x * 100) / 100;

test('miio one at Powerdot: 45 % off the operator fee, in the total, and it becomes the headline', async () => {
  const q = await quotePoint({ site: site('HORZ'), point }, car, { at, tariffIds: ['miio-bt-miioonebi', 'miio-bt-miiobihor'], lang: 'en' });
  const fee = 1 + 0.2 * q.session.kwhBilled;
  const one = q.options.find(o => o.tariffId === 'miio-bt-miioonebi');
  assert.equal(one.total, r2(8.5 + fee * 0.55 * 1.23));
  assert.equal(one.opcDiscountPct, 45);
  assert.deepEqual(one.promos, [MIIO_PROMO.id]);
  assert.equal(q.options.find(o => o.tariffId === 'miio-bt-miiobihor').total, r2(10 + fee * 1.23));
  assert.equal(q.headline.tariffId, 'miio-bt-miioonebi');
  assert.equal(q.total.eur, one.total);
  assert.equal(q.opc.eurWithVat, r2(fee * 1.23), "the operator's fee itself is unchanged");
  assert.ok(q.assumptions.some(a => a.includes('miio at Powerdot: −45% on the operator fee')));
  assert.equal(q.promos.find(p => p.id === MIIO_PROMO.id).applied, true);
});

test('LUZiGÁS new-customer promotion: a tip, never in a total', async () => {
  const q = await quotePoint({ site: site('HORZ'), point }, car, { at, lang: 'pt' });
  const fee = 1 + 0.2 * q.session.kwhBilled;
  assert.equal(q.headline.tariffId, 'luzigas-ceme-bt');
  assert.equal(q.headline.total, r2(8 + fee * 1.23), 'priced without the discount');
  const tip = q.promos.find(p => p.id === LUZ_PROMO.id);
  assert.equal(tip.applied, false);
  assert.equal(tip.total, r2(4 + fee * 1.23));
  assert.equal(tip.saving, 4);
  assert.match(tip.note, /clientes novos/);
  assert.ok(!q.assumptions.some(a => a.includes('LUZiGÁS')));
});

test('away from Powerdot: no promotions at all', async () => {
  const q = await quotePoint({ site: site('GLPP'), point }, car, { at, tariffIds: ['miio-bt-miioonebi'], lang: 'en' });
  const fee = 1 + 0.2 * q.session.kwhBilled;
  assert.equal(q.promos, undefined);
  assert.equal(q.headline.total, r2(8.5 + fee * 1.23));
  assert.equal(q.headline.promos, undefined);
});

test('EDP × UVE at an EDP charger: the all-in price is the total, operator fee inside', async () => {
  const q = await quotePoint({ site: site('EDPC'), point }, car, { at, tariffIds: ['edp-bt-cartoedp-2'], lang: 'pt' });
  assert.equal(q.headline.total, 12);
  assert.equal(q.headline.opcIncluded, true);
  assert.equal(q.headline.energyEur, null);
  assert.ok(q.assumptions.some(a => a.includes('0,47 €/kWh tudo incluído')));
  const away = await quotePoint({ site: site('GLPP'), point }, car, { at, tariffIds: ['edp-bt-cartoedp-2'], lang: 'pt' });
  assert.equal(away.headline.total, r2(7 + (1 + 0.2 * away.session.kwhBilled) * 1.23), 'not at Galp');
});

test('outside MOBI.E: the NAP site price, plus VAT, is ranked like any other', async () => {
  const p = { id: 'p1', kw: 250, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.3 };
  const q = await quotePoint({ site: { ...site('ZZZZ'), operator: 'Someone' }, point: p }, car, { at, lang: 'en' });
  const nap = q.options.find(o => o.kind === 'opc_direct');
  assert.equal(nap.total, r2(0.3 * 1.23 * q.session.kwhBilled), 'NAP price (excl. VAT) x VAT x billed kWh');
  assert.equal(nap.eurPerKwh, 0.369);
  assert.equal(nap.eurPerKwhExVat, 0.3);
  assert.match(nap.label, /no subscription/);
  assert.equal(q.best.kind, 'opc_direct');
  assert.equal(q.total.complete, true);
  assert.ok(q.assumptions.some(a => a.includes("operator's price from the NAP") && a.includes('(23 %)')));
});

test('Tesla: the NAP price is its app price with VAT in, and the only one', async () => {
  const tesla = { id: 'p1', kw: 250, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.3 };
  const q = await quotePoint({ site: { ...site('TSLA'), operator: 'Tesla' }, point: tesla }, car, { at, lang: 'en' });
  assert.ok(!q.options.some(o => o.kind === 'direct'), "manual.json disables the blog's network-wide Tesla prices");
  const nap = q.options.find(o => o.kind === 'opc_direct');
  assert.equal(nap.total, r2(0.3 * q.session.kwhBilled), 'offers/nap-notes.json: VAT already in, none added');
  assert.equal(nap.eurPerKwh, 0.3);
  assert.equal(nap.napVatIncluded, true);
  assert.equal(q.best.kind, 'opc_direct');
  assert.ok(q.assumptions.some(a => a.includes('with VAT included')));
  assert.ok(q.assumptions.some(a => a.includes('time of day')));
  assert.ok(!q.assumptions.some(a => a.includes('(23 %)')));
});

test('outside MOBI.E on the islands: the NAP price takes the island VAT', async () => {
  const p = { id: 'p1', kw: 250, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.3 };
  for (const [region, vat] of [['MAD', 1.22], ['AZO', 1.16]]) {
    const q = await quotePoint({ site: { ...site('ZZZZ'), operator: 'Someone', region }, point: p }, car, { at, lang: 'pt' });
    const nap = q.options.find(o => o.kind === 'opc_direct');
    assert.equal(nap.total, r2(0.3 * vat * q.session.kwhBilled), region);
    assert.ok(q.assumptions.some(a => a.includes(`(${Math.round((vat - 1) * 100)} %)`)), region);
  }
});

test('outside MOBI.E with a MOBI.E ad hoc price: says bank card / QR, and stands in without the NAP price', async () => {
  const opc = { AD_HOC_PAYMENT: { energy: [0.28] } };
  const hgp = { ...site('HIGH'), operator: 'HighGreenPower' };
  const q = await quotePoint({ site: hgp, point: { id: 'h1', kw: 22, dc: false, connector: 'T2', regime: 'sem_ceme', napPrice: 0.28, opc } }, car, { at, lang: 'en' });
  assert.equal(q.best.kind, 'opc_direct');
  assert.match(q.best.label, /Bank card \/ QR/);
  const off = await quotePoint({ site: hgp, point: { id: 'h2', kw: 22, dc: false, connector: 'T2', regime: 'sem_ceme', opc } }, car, { at, lang: 'en' });
  assert.equal(off.best.kind, 'adhoc');
  assert.equal(off.best.total, r2(0.28 * off.session.kwhBilled * 1.23), 'MOBI.E ad hoc price + VAT');
  const azo = await quotePoint({ site: { ...hgp, region: 'AZO' }, point: { id: 'h2', kw: 22, dc: false, connector: 'T2', regime: 'sem_ceme', opc } }, car, { at, lang: 'en' });
  assert.equal(azo.best.total, r2(0.28 * azo.session.kwhBilled * 1.16), 'island VAT');
});

test('rank: MOBI.E and outside MOBI.E share one list, the price decides', async () => {
  const { rank } = await import('../src/quote.js');
  const cont = { id: 'c1', kw: 50, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.05 };
  const ranked = await rank([{ site: site('HORZ'), points: [point], km: 1 }, { site: { ...site('XXXX'), operator: 'X' }, points: [cont], km: 2 }], car, { at, lang: 'en' });
  assert.ok(Array.isArray(ranked));
  assert.deepEqual(ranked.map(q => q.regime), ['sem_ceme', 'mobie']);
});
