// Which side of a motorway service area the driver can reach (src/direction.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dataset } from '../src/data.js';
import { clusterPlaces, directionLabel, onMotorway, PAIR_KM, samePlace, sameStation, serviceAreas, sideFor } from '../src/direction.js';
import { haversineKm } from '../src/geo.js';

// Every pair of motorway sites the data labels with the direction it serves
// (NAP addresses, OSM names), as of the 2026-10-28 dataset: [the side for
// driving north to south, the side for south to north].
const PAIRS = [
  [['CPS-FND-00013', 40.190132, -7.487972], ['CPS-FND-00014', 40.190865, -7.486648]],
  [['CPS-ABT-00017', 39.48615, -8.158823], ['CPS-ABT-00018', 39.48479, -8.155295]],
  [['GLG-VVR-00003', 39.573067, -7.782295], ['GLG-VVR-00002', 39.573654, -7.782657]],
  [['EDP-CNT-00007', 40.331776, -8.493878], ['EDP-CNT-00025', 40.33426, -8.49234]],
  [['EDP-GDL-00008', 38.16718, -8.492163], ['EDP-GDL-00009', 38.16717, -8.49087]],
  [['REP-VNG-00159', 41.085262, -8.619112], ['REP-VNG-00158', 41.084366, -8.619093]],
  [['IOY-ADV-00017', 37.53586, -8.184742], ['IOY-ADV-00018', 37.536327, -8.182924]],
  [['IOY-BCL-00027', 41.60547, -8.551002], ['IOY-BCL-00028', 41.604244, -8.549764]],
  [['IOY-CTB-00037', 39.88776, -7.488116], ['IOY-CTB-00038', 39.88832, -7.486825]],
  [['IOY-LRA-00115', 39.712784, -8.711451], ['IOY-LRA-00116', 39.712917, -8.70963]],
  [['EDP-ETR-00020', 40.755245, -8.536434], ['EDP-ETR-00018', 40.755383, -8.53526]],
  [['ATL-BCL-00046', 41.502457, -8.658127], ['ATL-BCL-00047', 41.500984, -8.659249]],
  [['ATL-VPA-00006', 41.50401, -7.720713], ['ATL-VPA-00007', 41.502827, -7.719275]],
  [['ATL-LOU-00012', 41.30481, -8.262411], ['ATL-LOU-00013', 41.301445, -8.262449]],
];
const mk = ([id, lat, lon], address = 'A1 km 100') => ({ id, lat, lon, address });
const south = s => ({ from: s, to: { lat: s.lat - 1, lon: s.lon } });
const north = s => ({ from: s, to: { lat: s.lat + 1, lon: s.lon } });
const ids = pick => pick && pick.places.flat().map(h => h.site.id);

test('direction: the right-hand rule never picks the wrong side of a labelled pair', () => {
  let decided = 0;
  for (const [ns, sn] of PAIRS) {
    const places = [[{ site: mk(ns) }], [{ site: mk(sn) }]];
    for (const [heading, want] of [[south(places[0][0].site), ns[0]], [north(places[0][0].site), sn[0]]]) {
      const pick = sideFor(places, heading);
      if (!pick) continue;
      decided++;
      assert.equal(pick.by, 'geometry');
      assert.deepEqual(ids(pick), [want], `${ns[0]} / ${sn[0]}`);
    }
  }
  // It's a guess, so it holds back on staggered twins, but still decides most.
  assert.ok(decided >= PAIRS.length, `decided ${decided} of ${PAIRS.length * 2}`);
});

test('direction: a published direction beats the geometry', () => {
  // The staggered pair at Vila Velha de Ródão: the geometry can't tell.
  const [ns, sn] = PAIRS[2];
  const places = [[{ site: mk(ns, 'A23 N/S') }], [{ site: mk(sn, 'A23 S/N') }]];
  assert.deepEqual(ids(sideFor(places, south(places[0][0].site))), [ns[0]]);
  assert.deepEqual(ids(sideFor(places, north(places[0][0].site))), [sn[0]]);
  assert.equal(sideFor(places, north(places[0][0].site)).label, 'S/N');
  // Faro is south and a bit east of Almodôvar: still the N-S side.
  const [a, b] = PAIRS[6];
  const alm = [[{ site: mk(a, 'Área de Serviço de Almodôvar N/S, km 193 A2') }], [{ site: mk(b, 'Área de Serviço de Almodôvar S/N, km 193 A2') }]];
  assert.deepEqual(ids(sideFor(alm, { from: alm[0][0].site, to: { lat: 37.0194, lon: -7.9304 } })), ['IOY-ADV-00017']);
});

test('direction: "sentido <town>" is resolved to a direction', () => {
  const places = [[{ site: mk(['X-1', 39.5, -8.5], 'A1 sentido Lisboa') }], [{ site: mk(['X-2', 39.5, -8.499], 'A1 sentido Porto') }]];
  const town = name => ({ lisboa: { lat: 38.72, lon: -9.14 }, porto: { lat: 41.15, lon: -8.61 } })[name.toLowerCase()];
  assert.deepEqual(ids(sideFor(places, { from: places[0][0].site, to: { lat: 38.0, lon: -8.8 } }, town)), ['X-1']);
  assert.equal(directionLabel(places[1][0].site), 'sentido Porto');
});

test('direction: the two sides are never one place, one side is', () => {
  const [a, b] = PAIRS[6]; // 169 m apart
  assert.equal(samePlace(mk(a, 'A2 N/S'), mk(b, 'A2 S/N')), false);
  assert.equal(samePlace(mk(a, 'A2 N/S'), { ...mk(b, 'A2 N/S') }), true);
  // Unlabelled twins 72 m apart (Vila Velha de Ródão) vs one side's chargers
  // 43 m apart (Pombal).
  assert.equal(samePlace(mk(PAIRS[2][0]), mk(PAIRS[2][1])), false);
  assert.equal(samePlace(mk(['P-1', 40.011963, -8.599879]), mk(['P-2', 40.012344, -8.59997])), true);
  // In town, 200 m is still the same car park.
  assert.equal(samePlace({ id: 'C-1', lat: 39.75, lon: -8.80, address: 'Rua X' }, { id: 'C-2', lat: 39.7518, lon: -8.80, address: 'Rua X' }), true);
});

test('direction: service areas group the sides; other places stay apart', () => {
  const hits = [mk(PAIRS[6][0], 'A2 N/S'), mk(PAIRS[6][1], 'A2 S/N'), { id: 'T-1', lat: 37.54, lon: -8.18, address: 'Rua da Vila' }].map(site => ({ site }));
  const areas = serviceAreas(clusterPlaces(hits));
  assert.deepEqual(areas.map(a => a.length), [2, 1]);
});

test('direction: a route keeps only the side it drives past', () => {
  const sites = [
    { ...mk(PAIRS[6][0], 'Área de Serviço de Almodôvar N/S, km 193 A2'), region: 'CONT', operator: 'IONITY GmbH', points: [{ id: '1', kw: 350, connector: 'CCS', dc: true }] },
    { ...mk(PAIRS[6][1], 'Área de Serviço de Almodôvar S/N, km 193 A2'), region: 'CONT', operator: 'IONITY GmbH', points: [{ id: '1', kw: 350, connector: 'CCS', dc: true }] },
  ];
  const ds = new Dataset({ schema: 1, generatedAt: 'x', sites });
  const down = [{ lat: 37.9, lon: -8.1838 }, { lat: 37.1, lon: -8.1838 }];
  assert.deepEqual(ds.search({ route: down, corridorKm: 2 }).results.map(r => r.site.id), ['IOY-ADV-00017']);
  assert.deepEqual(ds.search({ route: [...down].reverse(), corridorKm: 2 }).results.map(r => r.site.id), ['IOY-ADV-00018']);
  // Near a point (no direction), both stay.
  assert.equal(ds.search({ near: sites[0], radiusKm: 1 }).results.length, 2);
});

test('samePlace: in town, two operators at different addresses are two places', () => {
  // Colombo's Capwatt car park and a Galp on the avenue, 64 m apart.
  const cap = { id: 'CAP-LSB-00380', operatorId: 'CAPW', lat: 38.75454, lon: -9.18871, address: 'CC Colombo - Piso -3 Zona Laranja' };
  const glp = { id: 'GLP-LSB-00517', operatorId: 'GLPP', lat: 38.75428, lon: -9.18806, address: 'AV. LUSÍADA' };
  assert.equal(samePlace(cap, glp), false);
  assert.equal(samePlace(cap, { ...glp, operatorId: 'CAPW' }), true, 'one operator: one station spread over sites');
  assert.equal(samePlace(cap, { ...glp, address: 'CC Colombo - Piso -3 Zona Laranja' }), true, 'same address');
  assert.equal(samePlace(cap, { ...glp, lat: 38.75440, lon: -9.18840 }), true, 'within 60 m');
});

test('sameStation: the same operator down the road at another address is another charger', () => {
  const a = { id: 'G-1', operatorId: 'GLPP', lat: 39.7469, lon: -8.8157, address: 'Avenida 25 de Abril' };
  assert.equal(sameStation(a, { id: 'G-2', operatorId: 'GLPP', lat: 39.7487, lon: -8.8157, address: 'Rua X' }), false, '200 m, other address');
  assert.equal(sameStation(a, { id: 'G-3', operatorId: 'GLPP', lat: 39.7487, lon: -8.8157, address: 'Avenida 25 de Abril' }), true);
  assert.equal(sameStation(a, { id: 'G-4', operatorId: 'GLPP', lat: 39.7472, lon: -8.8157, address: 'Rua X' }), true, '33 m');
  assert.equal(sameStation(a, { id: 'E-1', operatorId: 'EDPC', lat: 39.7470, lon: -8.8157, address: 'Avenida 25 de Abril' }), false);
});

// A small generator, so a failure repeats.
const random = seed => () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;

test('clusterPlaces and serviceAreas compare each site with its neighbours, not with every site', () => {
  const r = random(1);
  let reads = 0;
  const sites = Array.from({ length: 2000 }, (_, i) => {
    const lat = 38 + r() * 3;
    return { id: `S-${i}`, lon: -9 + r() * 2, operatorId: `O${i}`, address: i % 2 ? `A1 km ${i}` : `Rua ${i}`, get lat() { reads++; return lat; } };
  });
  const places = clusterPlaces(sites.map(site => ({ site })));
  serviceAreas(places);
  // Every site against every other would be millions.
  assert.ok(reads < sites.length * 200, `${reads} coordinate reads for ${sites.length} sites`);
});

test('clusterPlaces and serviceAreas group the same way as comparing every pair', () => {
  // What they did before the grid: the first place or group that fits.
  const clusterAll = hits => {
    const places = [];
    for (const h of hits) {
      const place = places.find(pl => samePlace(pl[0].site, h.site));
      if (place) place.push(h); else places.push([h]);
    }
    return places;
  };
  const areasAll = places => {
    const groups = [];
    for (const pl of places) {
      const g = onMotorway(pl[0].site) && groups.find(g => onMotorway(g[0][0].site) && haversineKm(g[0][0].site, pl[0].site) <= PAIR_KM);
      if (g) g.push(pl); else groups.push([pl]);
    }
    return groups;
  };
  const shape = x => JSON.stringify(x, (k, v) => k === 'site' ? v.id : v);
  // Tight clumps, so sites sit at every distance around the limits, in the
  // far north too (the data has stray coordinates), where a degree of
  // longitude is short.
  for (const [seed, lat0, lon0] of [[1, 38.7, -9.1], [2, 41.1, -8.6], [3, 66.2, -18.1], [4, 37, -8.05]]) {
    const r = random(seed);
    const hits = Array.from({ length: 1500 }, (_, i) => {
      const clump = Math.floor(r() * 40);
      return { site: {
        id: `S-${i}`, operatorId: `O${Math.floor(r() * 3)}`,
        lat: lat0 + (clump % 7) * 0.03 + (r() - 0.5) * 0.02,
        lon: lon0 + Math.floor(clump / 7) * 0.03 + (r() - 0.5) * 0.02,
        address: r() < 0.5 ? `A${clump % 3 + 1} km ${clump}` : `Rua ${clump}`,
      } };
    });
    const places = clusterPlaces(hits);
    assert.equal(shape(places), shape(clusterAll(hits)), `places, seed ${seed}`);
    assert.equal(shape(serviceAreas(places)), shape(areasAll(places)), `areas, seed ${seed}`);
  }
});
