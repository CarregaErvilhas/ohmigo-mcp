// The three kinds of price, and the NAP's number on MOBI.E sockets with no
// tariff there, kept apart (quote.js feePlan): the operator's fee is added to
// a CEME's energy, the ad hoc price and the price outside MOBI.E have the
// energy in them and are never added to one, and the NAP's number says it may
// count the energy twice. Against a fake ceme-v2 (fetch is stubbed).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Dataset } from '../src/data.js';

const SIM = {
  at: '2026-11-10T12:00:00.000Z', kwh: 30, profile: { slices: 1, withSpot: 0 },
  data: [{ id: 'edp-bt-cartoedp', ceme: 'EDP Comercial', name: 'Cartão EDP', voltage: 'BT', kind: 'FIXED', period: 'FORA_VAZIO', totalEur: 8, vat: 1.23, popular: true, bundle: false }],
};
let quotePoint, feePlan;
before(async () => {
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).endsWith('/v1/session') ? { token: 't', expires_in: 3600 } : SIM),
    { status: 200, headers: { 'content-type': 'application/json' } });
  ({ quotePoint, feePlan } = await import('../src/quote.js'));
});

const site = { id: 'ZZZZ-1', code: 'X', operatorId: 'ZZZZ', operator: 'Someone', region: 'CONT', lat: 39, lon: -9 };
const car = { batteryKwh: 60, startPct: 20, targetPct: 70, dcKw: 100 };
const at = new Date('2026-11-10T12:00:00Z');
const r2 = x => Math.round(x * 100) / 100;
const noLive = { get: () => null };
const liveWith = fees => ({ get: () => ({ status: 'available', fees }) });
const dc = extra => ({ id: '1', kw: 50, dc: true, connector: 'CCS', level: 'BTN', ...extra });
const REGULAR = { flat: [0.26], energy: [0.1], time: [{ eur: 0.02, from: 0, to: null }] };
const AD_HOC = { flat: [0.5], energy: [0.5], time: [{ eur: 0.05, from: 0, to: null }] };

test('price kinds: the OPC fee goes on the CEME energy, labelled as a fee without energy', async () => {
  const q = await quotePoint({ site, point: dc({ regime: 'mobie', opc: { REGULAR } }) }, car, { at, lang: 'pt', live: noLive });
  assert.equal(q.opc.source, 'mobie');
  assert.equal(q.opc.priceType, 'opc_fee');
  assert.equal(q.opc.includesEnergy, false);
  assert.equal(q.opc.priceLabel, 'Taxa do operador (OPC), sem energia');
  assert.equal(q.total.complete, true);
  assert.equal(q.total.mayCountEnergyTwice, undefined);
  assert.equal(q.headline.total, r2(8 + q.opc.eurWithVat), 'the CEME total plus the fee with VAT');
});

test('price kinds: the ad hoc price is its own option, every component, never on a CEME', async () => {
  const q = await quotePoint({ site, point: dc({ regime: 'mobie', opc: { REGULAR, AD_HOC_PAYMENT: AD_HOC } }) }, car, { at, lang: 'en', live: noLive });
  const adhoc = q.options.find(o => o.kind === 'adhoc');
  const minutes = q.session.pluggedMinutes ?? q.session.minutes;
  const want = (0.5 + 0.5 * q.session.kwhBilled + 0.05 * minutes) * 1.23;
  assert.ok(Math.abs(adhoc.total - want) < 0.05, `${adhoc.total} vs ${want}: flat + energy + time, with VAT`);
  assert.equal(adhoc.priceType, 'adhoc');
  assert.equal(adhoc.includesEnergy, true);
  assert.equal(adhoc.priceLabel, 'No contract (ad hoc), energy included');
  assert.match(adhoc.note, /energy included/);
  // The CEME options carry the REGULAR fee only.
  assert.equal(q.opc.priceType, 'opc_fee');
  assert.equal(q.headline.total, r2(8 + q.opc.eurWithVat));
});

test('price kinds: outside MOBI.E the NAP price is one price with energy', async () => {
  const q = await quotePoint({ site, point: dc({ regime: 'sem_ceme', napPrice: 0.3 }) }, car, { at, lang: 'pt', live: noLive });
  const nap = q.options.find(o => o.kind === 'opc_direct');
  assert.equal(nap.priceType, 'outside');
  assert.equal(nap.includesEnergy, true);
  assert.equal(nap.priceLabel, 'Fora da MOBI.E, preço único com energia');
  assert.equal(q.opc, undefined, 'no CEME, no operator fee on top');
});

test('price kinds: no tariff on MOBI.E, the live NAP price says it may count the energy twice', async () => {
  const live = liveWith([{ policy: 'pricePerDeliveryUnit', eur: 0.3 }]);
  const q = await quotePoint({ site, point: dc({ regime: 'mobie_sem_tarifa', napFees: { kwh: 0.9 } }) }, car, { at, lang: 'pt', live });
  assert.equal(q.opc.source, 'nap', 'the live feed wins over the dataset copy');
  assert.equal(q.opc.priceType, 'nap');
  assert.equal(q.opc.includesEnergy, null);
  assert.equal(q.opc.priceLabel, 'Preço segundo o PAN, sem tarifa na MOBI.E (pode já incluir a energia)');
  assert.equal(q.opc.eurExVat, r2(0.3 * q.session.kwhBilled));
  assert.equal(q.total.mayCountEnergyTwice, true);
  assert.equal(q.total.complete, true, 'still ranked: it is the dearest reading');
  assert.ok(q.assumptions.some(a => a.includes('contar a energia duas vezes')));
});

test('price kinds: napFees stands in when the live feed has nothing for the socket', async () => {
  const q = await quotePoint({ site, point: dc({ regime: 'mobie_sem_tarifa', napFees: { kwh: 0.1, min: 0.02, flat: 0.26 } }) }, car, { at, lang: 'en', live: noLive });
  assert.equal(q.opc.source, 'napStatic');
  assert.equal(q.opc.priceType, 'nap');
  assert.deepEqual(Object.keys(q.opc.parts).sort(), ['energy', 'flat', 'time']);
  assert.equal(q.opc.parts.flat, 0.26);
  assert.ok(q.opc.parts.time > 0);
  assert.ok(q.assumptions.some(a => a.includes("dataset's copy")));
  assert.equal(q.total.mayCountEnergyTwice, true);
});

test('price kinds: without napFees and with no live fee, nothing changes from before', async () => {
  const q = await quotePoint({ site, point: dc({ regime: 'mobie_sem_tarifa' }) }, car, { at, lang: 'en', live: noLive });
  assert.equal(q.opc.source, null);
  assert.equal(q.opc.tariff, null);
  assert.equal(q.total.complete, false);
  assert.ok(q.assumptions.some(a => a.startsWith('operator fee not published')));
  assert.equal(q.total.mayCountEnergyTwice, undefined);
});

test('price kinds: where MOBI.E has only an ad hoc price, the NAP number is not a fee', async () => {
  const live = liveWith([{ policy: 'pricePerDeliveryUnit', eur: 0.5 }]);
  const { plan, adhocOnly } = feePlan(dc({ regime: 'mobie_sem_tarifa', opc: { AD_HOC_PAYMENT: AD_HOC } }), live.get());
  assert.equal(plan, null);
  assert.equal(adhocOnly, true);
  const q = await quotePoint({ site, point: dc({ regime: 'mobie_sem_tarifa', opc: { AD_HOC_PAYMENT: AD_HOC } }) }, car, { at, lang: 'en', live });
  assert.equal(q.headline.total, 8, 'the ad hoc 0.50 is not added to the CEME energy');
  assert.ok(q.assumptions.some(a => a.includes('only its ad hoc price')));
  assert.ok(q.options.some(o => o.kind === 'adhoc'));
});

test('price kinds: clean keeps sane napFees keys and drops the rest', () => {
  const load = napFees => new Dataset({ sites: [{ id: 'S', code: 'S', region: 'CONT', lat: 39, lon: -9, points: [{ id: '1', kw: 22, regime: 'mobie_sem_tarifa', napFees }] }] }).sites[0].points[0];
  assert.deepEqual(load({ kwh: 0.1, min: 0.02, flat: 0.26 }).napFees, { kwh: 0.1, min: 0.02, flat: 0.26 });
  assert.deepEqual(load({ kwh: 30, min: 0.02, note: 'pay here' }).napFees, { min: 0.02 }, 'a price in cents and an unknown key go');
  assert.equal('napFees' in load({ kwh: -1 }), false);
  assert.equal('napFees' in load('0.1'), false);
  assert.equal('napFees' in load(undefined), false);
});

test('price kinds: sockets with different napFees are never priced as one', async () => {
  const { socketKindKey } = await import('../src/mcp.js');
  const p = napFees => dc({ regime: 'mobie_sem_tarifa', napFees });
  assert.notEqual(socketKindKey(site, p({ kwh: 0.1 })), socketKindKey(site, p({ kwh: 0.3 })));
  assert.equal(socketKindKey(site, p(undefined)), socketKindKey(site, dc({ regime: 'mobie_sem_tarifa' })));
});

test('price kinds: outside MOBI.E the live NAP fee is typed outside, never as the NAP price on MOBI.E', () => {
  const live = liveWith([{ policy: 'pricePerDeliveryUnit', eur: 0.3 }]);
  const f = feePlan(dc({ regime: 'sem_ceme', napPrice: 0.3 }), live.get());
  assert.equal(f.type, 'outside');
  assert.deepEqual(f.plan, { energy: [0.3] });
  assert.equal(feePlan(dc({ regime: 'sem_ceme', napPrice: 0.3 }), null).plan, null);
});

test('price kinds: CEME options priced with the NAP number carry the flag too', async () => {
  const q = await quotePoint({ site, point: dc({ regime: 'mobie_sem_tarifa', napFees: { kwh: 0.2 } }) }, car, { at, lang: 'en', live: noLive });
  assert.ok(q.options.filter(o => o.kind === 'ceme').every(o => o.mayCountEnergyTwice));
  const plain = await quotePoint({ site, point: dc({ regime: 'mobie', opc: { REGULAR } }) }, car, { at, lang: 'en', live: noLive });
  assert.ok(plain.options.every(o => !o.mayCountEnergyTwice));
});
