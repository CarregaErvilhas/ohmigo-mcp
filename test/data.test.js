// Dataset filters that don't need the server: the voltage filter on a
// dataset with and without voltages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSession } from '../src/charging.js';
import { cardPayment, Dataset } from '../src/data.js';
import { offersAt } from '../src/offers.js';

const site = (id, points) => ({ id, code: id, lat: 39.7, lon: -8.8, region: 'CONT', city: 'Leiria', operator: 'X', operatorId: 'XX', points });

test('data: min_voltage keeps declared voltages at or above it, and drops undeclared ones', () => {
  const ds = new Dataset({ sites: [site('A', [{ id: '1', kw: 350, v: 920, dc: true }, { id: '2', kw: 22, v: 400 }, { id: '3', kw: 50, dc: true }])] });
  assert.equal(ds.hasVoltage, true);
  const { results } = ds.search({ minVoltage: 900 });
  assert.deepEqual(results[0].points.map(p => p.id), ['1']);
});

test('data: a dataset without voltages ignores min_voltage instead of dropping everything', () => {
  const ds = new Dataset({ sites: [site('A', [{ id: '1', kw: 350, dc: true }])] });
  assert.equal(ds.hasVoltage, false);
  assert.equal(ds.search({ minVoltage: 800 }).total, 1);
});

test('data: the whole-country search puts the most powerful sites first', () => {
  const ds = new Dataset({ sites: [site('A', [{ id: '1', kw: 22 }]), site('B', [{ id: '1', kw: 150 }])] });
  assert.deepEqual(ds.search({ limit: 10 }).results.map(r => r.site.id), ['B', 'A']);
});

test('data: operators group by operatorId and keep the most common name', () => {
  const ds = new Dataset({ sites: [
    { ...site('A', [{ id: '1', kw: 50, dc: true, regime: 'mobie' }]), operator: 'Atlante, S.A.', operatorId: 'ATLA' },
    { ...site('B', [{ id: '1', kw: 22, regime: 'mobie' }]), operator: 'ATLANTE', operatorId: 'ATLA' },
    { ...site('C', [{ id: '1', kw: 22, regime: 'mobie' }]), operator: 'ATLANTE', operatorId: 'ATLA' },
  ] });
  const [o] = ds.operators();
  assert.equal(o.name, 'ATLANTE');
  assert.deepEqual(o.otherNames, ['Atlante, S.A.']);
  assert.equal(o.sites, 3);
  assert.equal(o.dcPoints, 1);
});

test('data: OpenStreetMap\'s kW/V/A replace the NAP\'s, which stay in napKw/napV/napA', () => {
  const ds = new Dataset({ sites: [site('A', [{ id: '1', kw: 187.5, v: 750, a: 250, dc: true, osm: { kw: 150, v: 1000 } }])] });
  const [p] = ds.sites[0].points;
  assert.deepEqual([p.kw, p.napKw, p.v, p.napV, p.a, p.napA], [150, 187.5, 1000, 750, 250, undefined]);
  assert.equal(ds.search({ minVoltage: 900 }).total, 1);
});

test('data: bank card at the charger, from the NAP and OpenStreetMap', () => {
  assert.deepEqual(cardPayment({ payment: ['apps', 'creditCard'] }), { value: true, nap: true, osm: null, disagree: false });
  assert.deepEqual(cardPayment({ payment: ['apps'], osm: { cards: true } }), { value: true, nap: false, osm: true, disagree: true });
  assert.deepEqual(cardPayment({ payment: ['apps'], osm: { cards: false } }), { value: false, nap: false, osm: false, disagree: false });
  assert.equal(cardPayment({}).value, null);
});

test('data: a socket with 0 kW or less is unknown power, and OpenStreetMap only replaces it with a real figure', () => {
  const ds = new Dataset({ sites: [site('A', [
    { id: '1', kw: 0, dc: true }, { id: '2', kw: -5 }, { id: '3', kw: 0, dc: true, osm: { kw: 150 } }, { id: '4', kw: 22, osm: { kw: 0 } },
  ])] });
  assert.deepEqual(ds.sites[0].points.map(p => p.kw), [null, null, 150, 22]);
  assert.equal(ds.sites[0].points[3].napKw, undefined);
  assert.equal(ds.sites[0].points[2].napKw, null, 'the NAP\'s 0 kW was a blank');
  const [p] = ds.sites[0].points;
  // No power, no band: the same socket at 50 kW has offers on the same network.
  const at = { operatorId: 'XX' };
  assert.ok(offersAt(at, { kw: 50, dc: true, regime: 'mobie' }).length > 0);
  assert.deepEqual(offersAt(at, p), []);
  const s = estimateSession(p, { batteryKwh: 60, startPct: 20, targetPct: 80 });
  assert.ok(Number.isFinite(s.minutes) && s.minutes > 0);
  assert.deepEqual(s.assumptions, estimateSession({ kw: null, dc: true }, { batteryKwh: 60, startPct: 20, targetPct: 80 }).assumptions);
});

test('data: with the car\'s voltage, min_kw and the whole-country order use the power a DC socket gives that car', () => {
  // A: 400 kW, 600 A (240 kW at 400 V). B: 300 kW, 1000 A... at 400 V, 300 kW.
  const ds = new Dataset({ sites: [
    site('A', [{ id: '1', kw: 400, v: 1000, a: 600, dc: true }]),
    site('B', [{ id: '1', kw: 300, v: 920, a: 1000, dc: true }]),
    site('C', [{ id: '1', kw: 120, v: 1000, a: 200, dc: true }]),
  ] });
  assert.deepEqual(ds.search({}).results.map(r => r.site.id), ['A', 'B', 'C']);
  assert.deepEqual(ds.search({ carVolts: 400 }).results.map(r => r.site.id), ['B', 'A', 'C']);
  assert.deepEqual(ds.search({ carVolts: 800 }).results.map(r => r.site.id), ['A', 'B', 'C']);
  assert.deepEqual(ds.search({ minKw: 100 }).results.map(r => r.site.id), ['A', 'B', 'C']);
  assert.deepEqual(ds.search({ minKw: 100, carVolts: 400 }).results.map(r => r.site.id), ['B', 'A']);
});

test('data: the duration uses what the socket gives the car at its voltage, and says so', () => {
  const p = { kw: 400, v: 1000, a: 600, dc: true };
  const car = { batteryKwh: 77, startPct: 10, targetPct: 80, dcKw: 400 };
  const v800 = estimateSession(p, { ...car, volts: 800 }), v400 = estimateSession(p, { ...car, volts: 400 });
  assert.equal(v800.peakKw, 400);
  assert.equal(v400.peakKw, 240);
  assert.ok(v400.minutes > v800.minutes);
  assert.ok(v400.assumptions.some(x => /at most 240 kW, not its 400 kW nameplate: 600 A × 400 V/.test(x)), v400.assumptions.join('\n'));
  assert.ok(!v800.assumptions.some(x => /nameplate/.test(x)));
  // A car that takes less than the socket gives it: the car is the limit, not said.
  assert.ok(!estimateSession(p, { ...car, dcKw: 175, volts: 400 }).assumptions.some(x => /nameplate/.test(x)));
  const boosted = estimateSession({ kw: 50, v: 500, a: 125, dc: true }, { ...car, volts: 800 });
  assert.ok(boosted.assumptions.some(x => /steps the voltage up/.test(x)));
});
