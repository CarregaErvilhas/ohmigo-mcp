// quotePoint with detail: each CEME option carries ceme-v2's bill line by
// line (`components`), and only with detail. Fake ceme-v2, nothing leaves the
// machine.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const PARTS = { energyTar: 8.1, energy: 6.4, tar: 1.7, iec: 0.03, activation: 0.11, support: 0, base: 8.24, vatEur: 1.9 };
const SIM = {
  at: '2026-11-10T12:00:00.000Z', kwh: 30, profile: { slices: 1, withSpot: 0 },
  data: [
    { id: 'a-bt-x', ceme: 'A', name: 'X', voltage: 'BT', kind: 'FIXED', period: 'FORA_VAZIO', totalEur: 10.14, vat: 1.23, popular: true, bundle: false, parts: PARTS, egme_legal: 0.1088, activation_stale: true },
    { id: 'b-bt-y', ceme: 'B', name: 'Y', voltage: 'BT', kind: 'FIXED', period: 'FORA_VAZIO', totalEur: 11, vat: 1.23, popular: true, bundle: false, parts: PARTS,
      promos: [{ id: 'b-promo', network: 'EDP', target: 'ENERGIA', eurKwh: 0.1, totalEur: 7, newCustomers: false, from: '2026-01-01', to: '2026-12-31', url: 'https://example.pt', checked: '2026-10-29' }] },
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

const point = { id: '1', kw: 50, dc: true, connector: 'CCS', regime: 'mobie', level: 'BTN', opc: { REGULAR: { flat: [1], energy: [0.2], time: [] } } };
const site = { id: 'EDPC-1', code: 'X', operatorId: 'EDPC', operator: 'EDPC', region: 'CONT', lat: 39, lon: -9 };
const car = { batteryKwh: 60, startPct: 20, targetPct: 70, dcKw: 100 };
const at = new Date('2026-11-10T12:00:00Z');

test('detail: the CEME bill line by line, as ceme-v2 sent it', async () => {
  const q = await quotePoint({ site, point }, car, { at, detail: true, lang: 'en', tariffIds: ['a-bt-x'] });
  const o = q.options.find(x => x.tariffId === 'a-bt-x');
  assert.deepEqual(o.components, { ...PARTS, total: 10.14, egmeLegal: 0.1088, activationStale: true });
  assert.equal(Math.round((PARTS.energyTar + PARTS.iec + PARTS.activation + PARTS.support) * 100) / 100, PARTS.base);
});

test('detail: with a promotion in the total the lines are flagged as without it', async () => {
  const q = await quotePoint({ site, point }, car, { at, detail: true, lang: 'en', tariffIds: ['b-bt-y'] });
  const o = q.options.find(x => x.tariffId === 'b-bt-y');
  assert.equal(o.energyEur, 7);
  assert.equal(o.components.promoApplied, true);
});

test('no detail: no components', async () => {
  const q = await quotePoint({ site, point }, car, { at, lang: 'en', tariffIds: ['a-bt-x'] });
  assert.ok(q.options.every(o => !('components' in o)));
});
