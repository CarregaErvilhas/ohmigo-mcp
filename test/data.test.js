// Dataset filters that don't need the server: the voltage filter on a
// dataset with and without voltages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dataset } from '../src/data.js';

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
