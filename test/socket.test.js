import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translator } from '../src/i18n.js';
import { gridOf, kwForCar, plugLabel, usableKw } from '../src/socket.js';

const en = translator('en'), pt = translator('pt');

test('plugLabel says which plug to use, and when to bring a cable', () => {
  assert.match(plugLabel({ connector: 'CCS', dc: true, cable: true }, en), /CCS \(Combo 2\).*DC/);
  assert.match(plugLabel({ connector: 'T2', cable: false }, en), /Type 2, AC, no cable here: bring your own/);
  assert.match(plugLabel({ connector: 'T2', cable: true }, en), /cable attached/);
  assert.equal(plugLabel({ connector: 'T2' }, en), 'Type 2, AC');
  assert.match(plugLabel({ connector: 'CHADEMO', dc: true }, en), /only for cars with a CHAdeMO port/);
  assert.match(plugLabel({ connector: 'SCHUKO' }, pt), /Schuko/);
  // The NAP leaves some blank: "nan" in the dataset.
  assert.match(plugLabel({ connector: 'nan' }, en), /not published/);
  assert.match(plugLabel({ connector: 'T2', cable: false }, pt), /leva o teu/);
});

test('gridOf says BT or MT on MOBI.E, and nothing outside it', () => {
  assert.deepEqual(gridOf({ regime: 'mobie', level: 'MT' }, en).tar, 'MT');
  assert.match(gridOf({ regime: 'mobie', level: 'MT' }, en).gridLabel, /medium voltage \(MT\).*MT\) TAR/);
  // BTN and BTE are low voltage: both pay the BT TAR, as ceme.js picks it.
  for (const level of ['BTN', 'BTE', 'BT']) assert.equal(gridOf({ regime: 'mobie', level }, en).tar, 'BT', level);
  const unknown = gridOf({ regime: 'mobie_sem_tarifa', level: null }, pt);
  assert.equal(unknown.tar, 'BT');
  assert.equal(unknown.level, undefined);
  assert.match(unknown.gridLabel, /não publicado/);
  assert.deepEqual(gridOf({ regime: 'sem_ceme', level: null }, en), {});
});

test('kwForCar: a DC socket gives a car its amps × the car\'s battery volts, capped by its kW', () => {
  // ABT-00039 (Abrantes, IONITY): 400 kW, 1000 V, 600 A on OpenStreetMap.
  const ionity = { kw: 400, v: 1000, a: 600, dc: true };
  assert.deepEqual(kwForCar(ionity, 400), { kw: 240, limited: true, volts: 400, boosted: false });
  assert.deepEqual(kwForCar(ionity, 800), { kw: 400, limited: false, volts: 800, boosted: false });
  // A 500 V socket and an 800 V car: the car boosts, at the socket's volts.
  assert.deepEqual(kwForCar({ kw: 50, v: 500, a: 125, dc: true }, 800), { kw: 50, limited: false, volts: 500, boosted: true });
  assert.deepEqual(kwForCar({ kw: 90, v: 1000, a: 200, dc: true }, 400), { kw: 80, limited: true, volts: 400, boosted: false });
  // No voltage on the socket: the car's.
  assert.equal(kwForCar({ kw: 150, a: 200, dc: true }, 400).kw, 80);
  // AC (the on-board charger limits it), unknown amps, no car: nothing.
  assert.equal(kwForCar({ kw: 22, v: 400, a: 32, dc: false }, 400), null);
  assert.equal(kwForCar({ kw: 150, v: 1000, dc: true }, 400), null);
  assert.equal(kwForCar(ionity, undefined), null);
  assert.equal(usableKw(ionity, 400), 240);
  assert.equal(usableKw(ionity), 400);
});
