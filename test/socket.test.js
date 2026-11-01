import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translator } from '../src/i18n.js';
import { gridOf, plugLabel } from '../src/socket.js';

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
