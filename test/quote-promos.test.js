// quotePoint with CEME promotions, against a fake ceme-v2 (fetch is stubbed,
// nothing leaves the machine). Checks the rules in src/promos.js end to end:
// a promotion for every customer goes into its option's total and can change
// the headline; a new-customer one never changes a price, only shows as a tip;
// neither shows away from its network.
import { test, before, after, describe } from 'node:test';
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

// With tariff_ids: Enable is the cheapest tariff around, and the user doesn't
// have it. Not popular, so it's only ever the cheaper tip. These sessions cost
// cents, so no real offer in offers/ can undercut them, whatever it charges.
const HELD_SIM = {
  ...SIM,
  data: [
    quote('enable-bt-simples', 'Enable Mobility', 'Tarifa Simples', 0.05, { popular: false }),
    quote('edp-bt-socio', 'EDP Comercial', 'Sócios', 0.06, { popular: false, bundle: true }),
    quote('luzboa-bt-novo', 'Luzboa', 'Adesão', 0.07, { popular: false, newCustomers: true }),
    quote('edp-bt-cartoedp', 'EDP Comercial', 'Cartão EDP', 0.09),
  ],
};
// The tariff the user lacks has a promotion for every customer at Powerdot.
const TIP_PROMO = { ...MIIO_PROMO, id: 'enable-powerdot-2026' };
const TIP_PROMO_SIM = { ...SIM, data: [quote('enable-bt-simples', 'Enable Mobility', 'Tarifa Simples', 0.05, { popular: false, promos: [TIP_PROMO] }), quote('edp-bt-cartoedp', 'EDP Comercial', 'Cartão EDP', 0.09)] };
// Only tariffs dearer than any direct offer: the offers are what's left to win.
const DEAR_SIM = { ...SIM, data: [quote('edp-bt-cartoedp', 'EDP Comercial', 'Cartão EDP', 5000)] };

let quotePoint, sim = SIM;
before(async () => {
  globalThis.fetch = async (url) => {
    const body = String(url).endsWith('/v1/session') ? { token: 't', expires_in: 3600 } : sim;
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

test('outside MOBI.E: a live socket with no fees keeps its static NAP price', async () => {
  const p = { id: 'p1', kw: 250, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.3 };
  const s = { ...site('ZZZZ'), operator: 'Someone' };
  const liveWith = fees => ({ get: () => ({ status: 'available', fees }) });
  const kept = await quotePoint({ site: s, point: p }, car, { at, lang: 'en', live: liveWith([]) });
  assert.equal(kept.status, 'available');
  assert.equal(kept.options.find(o => o.kind === 'opc_direct').eurPerKwhExVat, 0.3);
  const live = await quotePoint({ site: s, point: p }, car, { at, lang: 'en', live: liveWith([{ policy: 'pricePerDeliveryUnit', eur: 0.4 }]) });
  assert.equal(live.options.find(o => o.kind === 'opc_direct').eurPerKwhExVat, 0.4, 'the live price still wins');
  // Live fees that aren't per kWh say the static price no longer holds.
  for (const policy of ['pricePerChargingTime', 'flatRate']) {
    const other = await quotePoint({ site: s, point: p }, car, { at, lang: 'en', live: liveWith([{ policy, eur: 0.1 }]) });
    assert.equal(other.options.find(o => o.kind === 'opc_direct'), undefined, policy);
  }
});

test('Tesla: the NAP price is its app price with VAT in, and the only one', async () => {
  const tesla = { id: 'p1', kw: 250, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.3 };
  const q = await quotePoint({ site: { ...site('TSLA'), operator: 'Tesla' }, point: tesla }, car, { at, lang: 'en' });
  assert.ok(!q.options.some(o => o.kind === 'direct'), "manual.json disables the blog's network-wide Tesla prices");
  const nap = q.options.find(o => o.kind === 'opc_direct');
  assert.equal(nap.total, r2(0.3 * q.session.kwhBilled), 'offers/nap-notes.json: VAT already in, none added');
  assert.equal(nap.eurPerKwh, 0.3);
  assert.equal(nap.napVatIncluded, true);
  assert.match(nap.label, /app, or a bank card/);
  assert.equal(nap.peakPrice, true, 'the NAP has only the daily peak');
  assert.match(nap.note, /highest price of the day/);
  assert.equal(q.best.kind, 'opc_direct');
  assert.ok(q.assumptions.some(a => a.includes('with VAT included')));
  assert.ok(q.assumptions.some(a => a.includes('time of day') && a.includes('no public source')));
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

test('ad hoc says how you pay as far as the site\'s data says: card at the charger, the phone, or both', async () => {
  const p = { id: 'a1', kw: 22, dc: false, connector: 'T2', regime: 'sem_ceme', opc: { AD_HOC_PAYMENT: { energy: [0.28] } } };
  const label = async extra => (await quotePoint({ site: { ...site('HIGH'), operator: 'X', ...extra }, point: p }, car, { at, lang: 'en' })).best;
  assert.match((await label({})).label, /Bank card \/ QR/, 'no payment data: stays vague');
  assert.match((await label({ payment: ['apps', 'rfid'] })).label, /phone.*no card terminal/, 'a NAP list without cards: the phone');
  assert.match((await label({ payment: ['apps', 'creditCard'] })).label, /Bank card at the charger/);
  const both = await label({ payment: ['apps'], osm: { cards: true } });
  assert.match(both.label, /Bank card at the charger/, 'a yes from either source counts');
  assert.match(both.note, /disagree/);
});

test('rank: MOBI.E and outside MOBI.E share one list, the price decides', async () => {
  const { rank } = await import('../src/quote.js');
  const cont = { id: 'c1', kw: 50, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.05 };
  const ranked = await rank([{ site: site('HORZ'), points: [point], km: 1 }, { site: { ...site('XXXX'), operator: 'X' }, points: [cont], km: 2 }], car, { at, lang: 'en' });
  assert.ok(Array.isArray(ranked));
  assert.deepEqual(ranked.map(q => q.regime), ['sem_ceme', 'mobie']);
});

describe('with tariff_ids, best is what the user can pay with', () => {
  before(() => { sim = HELD_SIM; });
  after(() => { sim = SIM; });
  // Another day than the tests above: ceme.js caches by time and kWh.
  const day = new Date('2026-11-11T12:00:00Z');
  const lowFee = { ...point, opc: { REGULAR: { flat: [0.01], energy: [], time: [] } } };
  const held = (opts, p = lowFee) => quotePoint({ site: site('QQQQ'), point: p }, car, { at: day, lang: 'en', ...opts });

  test('a cheaper tariff they do not hold is a tip, not best', async () => {
    const q = await held({ tariffIds: ['edp-bt-cartoedp'] });
    assert.equal(q.best.tariffId, 'edp-bt-cartoedp');
    assert.equal(q.best.total, q.total.eur, 'best is the price the headline states');
    const tip = q.options.find(o => o.cheaperElsewhere);
    assert.equal(tip.tariffId, 'enable-bt-simples');
    assert.equal(tip.notYours, true);
    assert.match(tip.note, /switch to it first/);
    assert.ok(tip.total < q.best.total);
  });

  test('a tip that also needs another contract says so', async () => {
    const q = await held({ tariffIds: ['edp-bt-cartoedp'] });
    assert.match(q.options.find(o => o.tariffId === 'enable-bt-simples').note, /switch to it first\.$/);
    sim = { ...HELD_SIM, data: HELD_SIM.data.map(d => d.id === 'enable-bt-simples' ? { ...d, bundle: true } : d) };
    const c = await held({ tariffIds: ['edp-bt-cartoedp'], at: new Date('2026-11-25T12:00:00Z') });
    sim = HELD_SIM;
    assert.match(c.options.find(o => o.cheaperElsewhere).note, /and it needs another contract/);
  });

  test('the tip says so in Portuguese too', async () => {
    const q = await held({ tariffIds: ['edp-bt-cartoedp'], lang: 'pt' });
    assert.match(q.options.find(o => o.cheaperElsewhere).note, /mudar para ele primeiro/);
  });

  test('without tariff_ids, the cheapest tariff anyone can sign up to stays best, nothing tagged', async () => {
    const q = await held({});
    assert.equal(q.best.tariffId, 'enable-bt-simples');
    assert.equal(q.best.cheaperElsewhere, true);
    assert.equal(q.headline.tariffId, 'edp-bt-cartoedp');
    assert.ok(!q.options.some(o => o.notYours || o.listed));
  });

  test('a tariff of theirs with conditions counts, even when it is the only one', async () => {
    const socio = await held({ tariffIds: ['edp-bt-socio'] });
    assert.equal(socio.best.tariffId, 'edp-bt-socio');
    assert.equal(socio.best.total, socio.total.eur);
    assert.equal(socio.best.requiresOtherContract, true, 'still true, and still shown');
    const novo = await held({ tariffIds: ['luzboa-bt-novo'] });
    assert.equal(novo.best.tariffId, 'luzboa-bt-novo');
    assert.equal(novo.best.total, novo.total.eur);
    assert.equal(novo.best.newCustomersOnly, true, 'still true, and still shown');
  });

  test('ad hoc still beats their tariffs: anyone can use it now', async () => {
    const q = await held({ tariffIds: ['edp-bt-cartoedp'] }, { ...lowFee, opc: { ...lowFee.opc, AD_HOC_PAYMENT: { energy: [0.0001] } } });
    assert.equal(q.best.kind, 'adhoc');
  });

  describe('a promotion on the tip', () => {
    before(() => { sim = TIP_PROMO_SIM; });
    after(() => { sim = HELD_SIM; });

    test('is not claimed as applied: it is in no price the user pays', async () => {
      const q = await quotePoint({ site: site('HORZ'), point }, car, { at: new Date('2026-11-13T12:00:00Z'), lang: 'en', tariffIds: ['edp-bt-cartoedp'] });
      assert.deepEqual(q.options.find(o => o.notYours).promos, [TIP_PROMO.id]);
      assert.ok(!q.assumptions.some(a => a.includes('Enable Mobility at Powerdot')));
      assert.equal(q.promos.find(p => p.id === TIP_PROMO.id).applied, false);
    });
  });

  describe('direct offers', () => {
    before(() => { sim = DEAR_SIM; });
    after(() => { sim = HELD_SIM; });
    const dearDay = new Date('2026-11-12T12:00:00Z');

    test('tariff_ids says nothing about apps: best is the same with or without them', async () => {
      const mine = await held({ at: dearDay, tariffIds: ['edp-bt-cartoedp'] });
      const open = await held({ at: dearDay });
      assert.deepEqual(mine.best, open.best);
      assert.ok(!mine.options.some(o => o.notYours));
    });

    test('outside MOBI.E: the NAP price still counts', async () => {
      const nap = { id: 'p', kw: 50, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice: 0.3 };
      const q = await quotePoint({ site: { ...site('XXXX'), operator: 'X' }, point: nap }, car, { at: dearDay, lang: 'en', tariffIds: ['edp-bt-cartoedp'] });
      assert.equal(q.best.kind, 'opc_direct');
      assert.equal(q.total.eur, q.best.total);
    });

    test('with their tariff unknown here, the other ways to pay are untouched', async () => {
      const q = await held({ at: dearDay, tariffIds: ['nobody-bt-nada'] });
      assert.equal(q.total, null);
      assert.ok(!q.options.some(o => o.kind === 'ceme' || o.notYours));
    });
  });

  test('without the operator fee, their tariff is not a complete price: never best', async () => {
    const q = await held({ tariffIds: ['edp-bt-cartoedp'] }, { ...point, opc: {} });
    assert.equal(q.total.complete, false);
    assert.notEqual(q.best?.kind, 'ceme');
  });

  test('rank: a charger is placed by their price, not by a tariff they lack', async () => {
    const { rank } = await import('../src/quote.js');
    const opts = { at: day, lang: 'en', tariffIds: ['edp-bt-cartoedp'] };
    const mine = await held(opts);
    const tip = mine.options.find(o => o.cheaperElsewhere);
    // Between the tip and the user's real price at the MOBI.E charger.
    const napPrice = (tip.total + mine.total.eur) / 2 / (1.23 * mine.session.kwhBilled);
    const outside = { id: 'c1', kw: 50, dc: true, connector: 'CCS', regime: 'sem_ceme', napPrice };
    const ranked = await rank([{ site: site('QQQQ'), points: [lowFee], km: 1 }, { site: { ...site('XXXX'), operator: 'X' }, points: [outside], km: 2 }], car, opts);
    assert.deepEqual(ranked.map(q => q.regime), ['sem_ceme', 'mobie']);
  });
});
