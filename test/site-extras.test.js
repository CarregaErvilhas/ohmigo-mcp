// What a driver wants to know about a site beyond the price: whether it is
// underground, what is near, how often it breaks and when it is busy, and which
// socket to pick when one charger is shared (nap-dashboard writes these fields).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dataset } from '../src/data.js';
import { chargerUnits, siteHistory } from '../src/mcp.js';

const busy = (from, to, v) => Array.from({ length: 24 }, (_, h) => (h >= from && h < to ? v : 5));
const site = extra => ({
  id: 'S', code: 'S', lat: 38.7, lon: -9.1, region: 'CONT', city: 'Lisboa', operator: 'X', operatorId: 'XX',
  points: [
    { id: '1', kw: 300, dc: true, unit: 0, model: 0 }, { id: '2', kw: 300, dc: true, unit: 0, model: 0 },
    { id: '3', kw: 300, dc: true, unit: 1, model: 0 }, { id: '4', kw: 300, dc: true, unit: 1, model: 0 },
  ],
  models: [{ name: 'Alpitronic HYC300', variants: [{ totalKw: 300, maxV: 1000, cars: [[1, 200, 300], [2, 150, 150]] }] }],
  ...extra,
});
const load = extra => new Dataset({ sites: [site(extra)] }).sites[0];

test('site extras: bad values from the dataset are dropped', () => {
  const s = load({
    underground: 'maybe', nearby: [{ type: 'cafe', n: 2, m: 40, name: 'Café' }, { type: 'casino', n: 1, m: 10 }, { type: 'toilets', n: 1, m: 999 }],
    history: { down: 3.2, days: 13, busy: { wd: busy(9, 12, 80), we: [1, 2] } },
    osm: { checkDate: '2025-02-15', name: 'X' },
  });
  assert.equal(s.underground, undefined);
  assert.deepEqual(s.nearby, [{ type: 'cafe', n: 2, m: 40, name: 'Café' }]);
  assert.equal(s.history.down, 3.2);
  assert.equal(s.history.busy, undefined, 'a weekend row that is not 24 hours drops the busy block');
  assert.equal(s.osm.checkDate, '2025-02-15');
  assert.equal(load({ osm: { checkDate: 'ontem', name: 'X' } }).osm.checkDate, undefined);
  assert.equal(load({ history: { days: 0, down: 1 } }).history, undefined);
});

test('site extras: history says how busy it is at the hour asked, and the quietest hours', () => {
  const s = load({ history: { down: 1.5, days: 13.2, busy: { wd: busy(9, 12, 80), we: busy(0, 24, 10) } } });
  // Tuesday 10:30 in Lisbon (winter: UTC).
  const h = siteHistory(s, new Date('2026-11-24T10:30:00Z'));
  assert.equal(h.outOfOrderPct, 1.5);
  assert.equal(h.days, 13);
  assert.equal(h.busyPctAtHour, 80);
  assert.equal(h.atHour, 10);
  assert.equal(h.dayType, 'weekday');
  assert.deepEqual(h.weekday, { quietest: [7, 8, 12, 13, 14, 15], quietestPct: 5, busiest: [9, 10, 11], busiestPct: 80 });
  assert.equal(h.weekend.quietestPct, 10);
  assert.equal(siteHistory(s, new Date('2026-11-28T10:30:00Z')).busyPctAtHour, 10, 'Saturday reads the weekend row');
});

test('site extras: with one charger busy, the free one is the pick, and the two-car figure is said', () => {
  const s = load({});
  const live = { get: (_, id) => ({ status: id === '1' ? 'charging' : 'available' }) };
  const u = chargerUnits(s, live);
  assert.deepEqual(u.chargers.map(c => [c.charger, c.charging, c.free, c.kwEachTwoCars]), [['A', 1, 1, 150], ['B', 0, 2, 150]]);
  assert.deepEqual(u.pickCharger, ['B']);
  // Nobody charging: nothing to pick.
  assert.equal(chargerUnits(s, { get: () => ({ status: 'available' }) }).pickCharger, undefined);
  // A socket with a broken unit id loses it.
  const bad = new Dataset({ sites: [site({})] });
  assert.ok(bad.sites[0].points.every(p => Number.isInteger(p.unit)));
});

test('site extras: list_operators says which charger models a network uses', () => {
  const ds = new Dataset({ sites: [site({}), { ...site({}), id: 'T', code: 'T' }] });
  const [o] = ds.operators();
  assert.deepEqual(o.chargerModels, [{ name: 'Alpitronic HYC300', sites: 2 }]);
});
