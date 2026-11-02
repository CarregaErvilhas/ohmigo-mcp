// A CEME tariff that a direct offer bills instead (manual.json `cemeTariffs`):
// myAtlante's CEME tariff only prices AC sockets, and on DC the same app
// charges its flat price. A driver who holds myAtlante gets that price as
// theirs on DC, not "none of your tariffs apply". Fake ceme-v2, nothing
// leaves the machine.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { OFFERS } from '../src/offers.js';

const PARTS = { energyTar: 6, energy: 3.6, tar: 2.4, iec: 0.03, activation: 0.11, support: 0, base: 6.14, vatEur: 1.41 };
const tariff = (id, name, extra = {}) => ({ id, ceme: 'Atlante', name, voltage: 'MT', kind: 'FIXED', period: 'FORA_VAZIO', totalEur: 7.55, vat: 1.23, popular: false, bundle: false, parts: PARTS, notes: 'AC_DC_FLAT', ...extra });
const SIM = {
  at: '2026-11-10T12:00:00.000Z', kwh: 30, profile: { slices: 1, withSpot: 0 },
  data: [
    tariff('atlante-mt-myatlanteac', 'myAtlante (AC)'),
    { ...tariff('edp-mt-cartoedp', 'Cartão EDP'), ceme: 'EDP', notes: null, totalEur: 9 },
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

const fee = { REGULAR: { flat: [0.25], energy: [0.25], time: [] } };
const dc = { id: '1', kw: 100, dc: true, connector: 'CCS', regime: 'mobie', level: 'MT', opc: fee };
const ac = { id: '2', kw: 22, dc: false, connector: 'T2', regime: 'mobie', level: 'MT', opc: fee };
const site = { id: 'ATL-1', code: 'X', operatorId: 'ATLA', operator: 'Atlante', region: 'CONT', lat: 38.78, lon: -9.18 };
const car = { batteryKwh: 60, startPct: 20, targetPct: 70, dcKw: 100, acKw: 11 };
const at = new Date('2026-11-10T12:00:00Z');
const APP = 'atlante-app-myatlante-rede-mobi-e';

test('DC: the myAtlante holder gets the app flat price as their total', async () => {
  const q = await quotePoint({ site, point: dc }, car, { at, lang: 'en', tariffIds: ['atlante-mt-myatlanteac'] });
  const app = q.options.find(o => o.offerId === APP);
  assert.equal(app.listed, true);
  assert.equal(app.viaTariff, true);
  assert.deepEqual(q.total, { eur: app.total, low: app.total, high: app.total, complete: true });
  assert.match(q.note, /same app has its own price here/);
  assert.ok(!q.options.some(o => o.tariffId === 'atlante-mt-myatlanteac'), 'the AC tariff still never prices DC');
});

test('DC: the link is per card, any voltage or cycle of the tariff id', async () => {
  const q = await quotePoint({ site, point: dc }, car, { at, lang: 'en', tariffIds: ['atlante-bt-myatlanteac-2'] });
  assert.equal(q.options.find(o => o.offerId === APP).viaTariff, true);
});

test('DC: myAtlante Business is not tied to the app price (it has its own)', async () => {
  const q = await quotePoint({ site, point: dc }, car, { at, lang: 'en', tariffIds: ['atlante-mt-myatlantebus'] });
  assert.ok(!q.options.find(o => o.offerId === APP).viaTariff);
});

const BUS = 'atlante-app-myatlante-business-';
const other = { ...site, id: 'PRIO-1', operatorId: 'PRIO', operator: 'Prio' };

test('DC: a Business holder gets 0.45 at Atlante and 0.49 elsewhere, as their total', async () => {
  const opts = { at, lang: 'en', tariffIds: ['atlante-mt-myatlantebus'] };
  const own = await quotePoint({ site, point: dc }, car, opts);
  const bus = own.options.find(o => o.offerId === `${BUS}atlante`);
  assert.equal(bus.eurPerKwh, 0.45);
  assert.equal(bus.viaTariff, true);
  assert.equal(own.total.eur, bus.total);
  assert.ok(!own.options.some(o => o.offerId === `${BUS}rede-mobi-e`), "the network's own row replaces the MOBI.E-wide one");
  const away = await quotePoint({ site: other, point: dc }, car, opts);
  assert.equal(away.options.find(o => o.offerId === `${BUS}rede-mobi-e`).eurPerKwh, 0.49);
});

test('DC: the Business price is hidden from drivers who do not hold it', async () => {
  for (const tariffIds of [undefined, ['atlante-mt-myatlanteac']]) {
    const q = await quotePoint({ site, point: dc }, car, { at, lang: 'en', tariffIds });
    assert.ok(!q.options.some(o => o.offerId?.startsWith(BUS)), String(tariffIds));
  }
});

test('DC: a driver without myAtlante sees the app price as just another offer', async () => {
  const q = await quotePoint({ site, point: dc }, car, { at, lang: 'en', tariffIds: ['edp-mt-cartoedp'] });
  const app = q.options.find(o => o.offerId === APP);
  assert.ok(!app.listed && !app.viaTariff);
  assert.equal(q.headline.tariffId, 'edp-mt-cartoedp');
});

test('DC: with only an unrelated tariff missing, still "none of your tariffs apply"', async () => {
  const q = await quotePoint({ site, point: dc }, car, { at, lang: 'en', tariffIds: ['nobody-mt-nothing'] });
  assert.equal(q.total, null);
  assert.match(q.note, /None of the user's tariffs/);
});

test('AC: myAtlante prices through its CEME tariff and the app flat price is not there', async () => {
  const q = await quotePoint({ site, point: ac }, car, { at, lang: 'en', tariffIds: ['atlante-mt-myatlanteac'] });
  assert.equal(q.headline.tariffId, 'atlante-mt-myatlanteac');
  assert.ok(!q.options.some(o => o.offerId === APP));
});

// cemeTariffs are matched by card key: the tariff id without its voltage
// segment or cycle number, so one entry covers bt/mt and every cycle.
test('offers: cemeTariffs are card keys', () => {
  for (const o of OFFERS.filter(x => x.cemeTariffs)) {
    for (const k of o.cemeTariffs) assert.doesNotMatch(k, /-(bt|mt)(-|$)|-\d+$/, `${o.id}: ${k}`);
  }
});
