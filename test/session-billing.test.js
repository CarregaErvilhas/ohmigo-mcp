// A tariff the CEME bills by the session's average OMIE (ceme-v2's
// `billing: 'MEDIA_SESSAO'`, LUZiGÁS), against a fake ceme-v2: the total is
// ceme-v2's (the bill), the option says how it's billed, and with `detail` it
// carries the load-curve price beside it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const quote = (id, ceme, name, totalEur, extra = {}) => ({
  id, ceme, name, voltage: 'BT', kind: 'INDEXED', period: 'VAZIO', totalEur, vat: 1.23, popular: true, bundle: false, ...extra,
});
const SESSION = { eurKwh: 0.148914, hours: 22, from: '2026-09-27T11:00:00.000Z', to: '2026-09-28T09:00:00.000Z', loss: 0.1387 };
const luz = (extra = {}) => quote('luzigas-ceme-bt', 'LUZiGÁS', 'Indexado', 7.5, { billing: 'MEDIA_SESSAO', sessionOmie: SESSION, curve: { totalEur: 2.97, eurKwhNoIva: 0.11, parts: {} }, ...extra });
const SIM = {
  at: '2026-11-10T12:00:00.000Z', kwh: 30, profile: { slices: 4, withSpot: 4 },
  data: [quote('meo-dinamica-bt', 'MEO', 'Dinâmica', 5.34), luz()],
};

let quotePoint, sim = SIM;
before(async () => {
  globalThis.fetch = async (url) => {
    const body = String(url).endsWith('/v1/session') ? { token: 't', expires_in: 3600 } : sim;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  ({ quotePoint } = await import('../src/quote.js'));
});

// A 22 kW AC socket with a 1 € flat operator fee (excl. VAT).
const point = { id: '1', kw: 22, dc: false, connector: 'T2', regime: 'mobie', level: 'BTN', opc: { REGULAR: { flat: [1], energy: [], time: [] } } };
const site = { id: 'X-1', code: 'X', operatorId: 'X', operator: 'X', region: 'CONT', lat: 39, lon: -9 };
const car = { batteryKwh: 60, startPct: 20, targetPct: 50, acKw: 11 };
const ids = ['luzigas-ceme-bt', 'meo-dinamica-bt'];
const r2 = x => Math.round(x * 100) / 100;

test('the total is the session average, with a note; the load curve only with detail', async () => {
  sim = SIM;
  const q = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T13:00:00Z'), tariffIds: ids, lang: 'en' });
  const o = q.options.find(x => x.tariffId === 'luzigas-ceme-bt');
  assert.equal(o.total, r2(7.5 + 1.23));
  assert.equal(o.billing, 'sessionAverage');
  assert.equal(o.sessionOmieEurKwh, 0.1489);
  assert.match(o.note, /average of the hourly price over every hour the car is plugged in/);
  assert.match(o.note, /0\.1489 €\/kWh over these 22 h/);
  assert.match(o.note, /unplug when charging ends/);
  assert.doesNotMatch(o.note, /load curve/);
  assert.equal(o.byLoadCurve, undefined);
  // Other tariffs: no billing note.
  const meo = q.options.find(x => x.tariffId === 'meo-dinamica-bt');
  assert.equal(meo.billing, undefined);
  assert.equal(meo.note, undefined);

  const d = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T13:00:00Z'), tariffIds: ids, lang: 'pt', detail: true });
  const od = d.options.find(x => x.tariffId === 'luzigas-ceme-bt');
  assert.deepEqual(od.byLoadCurve, { total: r2(2.97 + 1.23), energyEur: 2.97 });
  assert.match(od.note, /média simples do preço de cada hora/);
  assert.match(od.note, /Pela curva de carga .* seria 4,20 €/);
});

test("ceme-v2 lacked some hours' OMIE: the load curve, and the note says the bill can differ", async () => {
  sim = { ...SIM, data: [luz({ sessionOmie: undefined, curve: undefined, totalEur: 3 })] };
  const q = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T14:00:00Z'), tariffIds: ['luzigas-ceme-bt'], lang: 'en', detail: true });
  const o = q.options.find(x => x.tariffId === 'luzigas-ceme-bt');
  assert.equal(o.total, r2(3 + 1.23));
  assert.equal(o.billing, 'sessionAverage');
  assert.match(o.note, /isn't published yet, so this total follows the load curve/);
  assert.equal(o.byLoadCurve, undefined);
});
