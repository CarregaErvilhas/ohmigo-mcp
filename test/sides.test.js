// A search near a place marks the two sides of a motorway service area
// (markSides in src/mcp.js): the direction each says it serves, the side
// across the road, and which one a driver coming from the search centre
// reaches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dataset } from '../src/data.js';
import { translator } from '../src/i18n.js';
import { markSides } from '../src/mcp.js';

const site = (id, lat, lon, name, address = 'CEPSA - A22, VIA DO INFANTE DE SAGRES km 97') =>
  ({ id, code: id.slice(4), city: 'Olhão', region: 'CONT', lat, lon, name, address, points: [{ id: '1', kw: 300, connector: 'CCS', dc: true }] });
// The Cepsa/Moeve pair on the A22 at Olhão (2026-10-31 dataset), and a
// charger in Tavira.
const ds = new Dataset({ schema: 1, generatedAt: 'x', sites: [
  site('CPS-OLH-00047', 37.124626, -7.770512, 'A22 OLHÃO (OLH-VRA)'),
  site('CPS-OLH-00048', 37.12606, -7.771144, 'A22 OLHÃO (VRA-OLH)'),
  site('ENB-TVR-00031', 37.13085, -7.63698, 'Enable Mobility', 'R. Alm. Cândido dos Reis 247'),
] });
const tavira = { point: { lat: 37.1294, lon: -7.6446 }, name: 'Tavira' };
const hits = ids => ids.map(id => ({ site: ds.siteById.get(id) }));

test('sides: each side says its direction and the side across the road', () => {
  const h = hits(['ENB-TVR-00031', 'CPS-OLH-00047', 'CPS-OLH-00048']);
  const { notes } = markSides(ds, h, translator('pt'), null);
  assert.equal(h[0].otherSide, undefined, 'not on a motorway');
  assert.equal(h[1].direction, 'OLH-VRA');
  assert.deepEqual(h[1].otherSide, ['CPS-OLH-00048']);
  assert.deepEqual(h[2].otherSide, ['CPS-OLH-00047']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /otherSide/);
});

test('sides: the other side is found even when the limit cut it', () => {
  const h = hits(['CPS-OLH-00047']);
  const { twins } = markSides(ds, h, translator('en'), null);
  assert.deepEqual([...twins], ['CPS-OLH-00048']);
  assert.deepEqual(h[0].otherSide, ['CPS-OLH-00048']);
});

test('sides: coming from Tavira, a driver reaches the side towards Olhão', () => {
  // Driving west, the service area on the right (north) is VRA-OLH.
  const { notes } = markSides(ds, hits(['CPS-OLH-00047', 'CPS-OLH-00048']), translator('en'), tavira);
  const from = notes.find(n => n.startsWith('Coming from Tavira'));
  assert.ok(from, notes.join('\n'));
  assert.match(from, /reaches CPS-OLH-00048 \(VRA-OLH\); CPS-OLH-00047 \(OLH-VRA\) is across/);
  assert.match(from, /check the signs/, 'a guess from the map says so');
  // Searching right next to it there is no way in to go by.
  const here = { point: { lat: 37.125, lon: -7.771 }, name: 'here' };
  assert.ok(!markSides(ds, hits(['CPS-OLH-00047', 'CPS-OLH-00048']), translator('en'), here).notes.some(n => n.startsWith('Coming from')));
});
