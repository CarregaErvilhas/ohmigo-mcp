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
