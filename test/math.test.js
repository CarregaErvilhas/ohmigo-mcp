import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeCost, opcCost, describePlan } from '../src/opc.js';
import { estimateSession, batteryKwhNeeded } from '../src/charging.js';
import { haversineKm, routeDistance } from '../src/data.js';
import { tariffKey } from '../src/quote.js';
import { applicable } from '../src/ceme.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('timeCost: flat per-minute rate', () => {
  const r = timeCost([{ eur: 0.1, from: 0, to: null }], 30);
  close(r.low, 3); close(r.high, 3);
});

test('timeCost: free then paid after 30 min charges only the extra minutes', () => {
  const tiers = [{ eur: 0, from: 0, to: null }, { eur: 0.18, from: 30, to: null }];
  const r = timeCost(tiers, 50);
  close(r.low, 20 * 0.18); close(r.high, 20 * 0.18);
});

test('timeCost: two rates with the same start are a range', () => {
  const r = timeCost([{ eur: 0.034, from: 0, to: null }, { eur: 0.037, from: 0, to: null }], 10);
  close(r.low, 0.34); close(r.high, 0.37);
});

test('timeCost: até/após tiers split cleanly', () => {
  const tiers = [{ eur: 0.03, from: 0, to: 120 }, { eur: 0.08, from: 120.0166, to: null }];
  const r = timeCost(tiers, 150);
  close(r.low, 120 * 0.03 + (150 - 120.0166) * 0.08, 1e-6);
  close(r.low, r.high, 1e-12);
});

test('timeCost: session shorter than the threshold pays nothing extra', () => {
  close(timeCost([{ eur: 0.2, from: 60, to: null }], 45).high, 0);
});

test('opcCost: flat + energy + time, duplicate values become a range', () => {
  const r = opcCost({ flat: [0.2608], energy: [0.1, 0], time: [{ eur: 0.05, from: 240, to: null }] }, { kwh: 20, minutes: 300 });
  close(r.low, 0.2608 + 0 + 60 * 0.05, 1e-9);
  close(r.high, 0.2608 + 2 + 60 * 0.05, 1e-9);
});

test('describePlan skips zero components', () => {
  assert.equal(describePlan({ flat: [0], time: [{ eur: 0, from: 0, to: null }] }), 'free (no OPC fee)');
  assert.equal(describePlan({ energy: [0.31] }), '0.31 €/kWh (excl. VAT)');
});

test('batteryKwhNeeded defaults to 80 %', () => {
  close(batteryKwhNeeded({ batteryKwh: 60, startPct: 20 }), 36);
});

test('estimateSession AC: limited by the slower of car and socket, with losses', () => {
  const s = estimateSession({ kw: 22, dc: false }, { batteryKwh: 50, startPct: 20, targetPct: 80, acKw: 7.4 });
  close(s.batteryKwh, 30);
  close(s.kwh, 30 / 0.88, 1e-9);
  assert.equal(s.peakKw, 7.4);
  close(s.minutes, (30 / 0.88) / (7.4 * 0.95) * 60, 1e-9);
});

test('estimateSession DC: slower above 80 %', () => {
  const to80 = estimateSession({ kw: 150, dc: true }, { batteryKwh: 60, startPct: 20, targetPct: 80, dcKw: 100 });
  const to100 = estimateSession({ kw: 150, dc: true }, { batteryKwh: 60, startPct: 20, targetPct: 100, dcKw: 100 });
  // The last 20 % (12 kWh) takes longer than 12/48 of the first 60 %.
  assert.ok(to100.minutes - to80.minutes > to80.minutes * 12 / 36 * (0.7 / 0.3) * 0.99);
  assert.ok(to80.assumptions.some(a => a.includes('DC average')));
});

test('estimateSession records unknown car limits as assumptions', () => {
  const s = estimateSession({ kw: 50, dc: true }, { batteryKwh: 40, startPct: 10, targetPct: 80 });
  assert.equal(s.peakKw, 50);
  assert.ok(s.assumptions.some(a => a.includes('unknown')));
});

test('haversine Lisbon-Porto is ~274 km', () => {
  const d = haversineKm({ lat: 38.7223, lon: -9.1393 }, { lat: 41.1579, lon: -8.6291 });
  assert.ok(d > 270 && d < 280, String(d));
});

test('routeDistance: off-route distance and position along the route', () => {
  const route = [{ lat: 39, lon: -9 }, { lat: 40, lon: -9 }];
  const d = routeDistance({ lat: 39.5, lon: -8.99 }, route);
  assert.ok(Math.abs(d.km - 0.86) < 0.02, String(d.km));
  assert.ok(Math.abs(d.alongKm - 55.6) < 0.5, String(d.alongKm));
});

test('tariffKey ignores the voltage segment', () => {
  assert.equal(tariffKey('edp-bt-cartoedp-4'), tariffKey('edp-mt-cartoedp-4'));
  assert.notEqual(tariffKey('edp-bt-cartoedp-4'), tariffKey('edp-bt-cartoedp-11'));
});

test('applicable: voltage variant per socket, AC-only tariffs dropped on DC', () => {
  const q = [
    { id: 'a-bt-x', voltage: 'BT' }, { id: 'a-mt-x', voltage: 'MT' },
    { id: 'atl-mt-ac', voltage: 'MT', notes: 'AC_DC_FLAT' },
  ];
  assert.deepEqual(applicable(q, { level: 'MT', dc: true }).map(t => t.id), ['a-mt-x']);
  assert.deepEqual(applicable(q, { level: 'MT', dc: false }).map(t => t.id), ['a-mt-x', 'atl-mt-ac']);
  assert.deepEqual(applicable(q, { level: 'BTE', dc: false }).map(t => t.id), ['a-bt-x']);
});
