import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeCost, opcCost, describePlan } from '../src/opc.js';
import { estimateSession, batteryKwhNeeded } from '../src/charging.js';
import { haversineKm, routeDistance } from '../src/geo.js';
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
  assert.equal(describePlan({ flat: [0], time: [{ eur: 0, from: 0, to: null }] }), 'free (no operator fee)');
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
  // Some ids end with the voltage (Luzigás indexed tariffs).
  assert.equal(tariffKey('luzigas-ceme-bt'), tariffKey('luzigas-ceme-mt'));
  assert.notEqual(tariffKey('luzigas-ceme-bt'), tariffKey('luzigas-casa-bt'));
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

import { pickTariffs } from '../src/quote.js';
import { napPlan, parseStatus } from '../src/live.js';

test('estimateSession: dc_10_80_minutes sets the DC average, capped by the charger', () => {
  // 70 % of 60 kWh in 30 min = 84 kW average.
  const fast = estimateSession({ kw: 150, dc: true }, { batteryKwh: 60, startPct: 10, targetPct: 80, dc10to80Minutes: 30 });
  close(fast.minutes, (42 / 0.93) / 84 * 60, 1e-9);
  const slowCharger = estimateSession({ kw: 50, dc: true }, { batteryKwh: 60, startPct: 10, targetPct: 80, dc10to80Minutes: 30 });
  close(slowCharger.minutes, (42 / 0.93) / (50 * 0.95) * 60, 1e-9);
  assert.ok(!fast.assumptions.some(a => a.includes('unknown')));
});

test('estimateSession: charging curve integrates kW over SoC', () => {
  const flat = estimateSession({ kw: 300, dc: true }, { batteryKwh: 100, startPct: 20, targetPct: 60, curve: [{ soc: 0, kw: 100 }, { soc: 100, kw: 100 }] });
  close(flat.minutes, 40 / 100 * 60, 1e-9);
  const capped = estimateSession({ kw: 50, dc: true }, { batteryKwh: 100, startPct: 20, targetPct: 60, curve: [{ soc: 0, kw: 100 }, { soc: 100, kw: 100 }] });
  close(capped.minutes, 40 / 50 * 60, 1e-9);
});

const q = (id, totalEur, extra = {}) => ({ id, voltage: 'BT', totalEur, ceme: id.split('-')[0], name: id, ...extra });

test('pickTariffs: user tariffs, cheapest of them is the headline', () => {
  const quotes = [q('a-bt-x', 5), q('b-bt-y', 6), q('c-bt-z', 7)];
  const t = pickTariffs(quotes, { level: 'BTN', dc: false }, ['c-mt-z', 'b-mt-y']);
  assert.deepEqual(t.options.map(o => o.id), ['b-bt-y', 'c-bt-z']);
  assert.equal(t.headline.id, 'b-bt-y');
  assert.equal(t.best.id, 'a-bt-x');
});

test('pickTariffs: user tariff whose id ends with the voltage matches the other variant', () => {
  // list_ceme_tariffs hands out the BT id; an MT charger is priced with the MT one.
  const quotes = [q('luzigas-ceme-mt', 5, { voltage: 'MT' }), q('luzigas-ceme-bt', 5)];
  const t = pickTariffs(quotes, { level: 'MT', dc: true }, ['luzigas-ceme-bt']);
  assert.equal(t.headline.id, 'luzigas-ceme-mt');
  assert.equal(t.missing, false);
});

test('pickTariffs: default is top 3 popular, headline skips ones needing another contract', () => {
  const quotes = [
    q('a-bt-x', 4, { popular: true, bundle: true }), q('b-bt-y', 5), q('c-bt-z', 6, { popular: true }),
    q('d-bt-w', 6, { popular: true }), q('d-bt-w-2', 6, { popular: true, name: 'd-bt-w' }), q('e-bt-v', 7, { popular: true }),
  ];
  const t = pickTariffs(quotes, { level: 'BTN', dc: false });
  assert.deepEqual(t.options.map(o => o.id), ['a-bt-x', 'c-bt-z', 'd-bt-w']);
  assert.equal(t.headline.id, 'c-bt-z');
  assert.deepEqual(pickTariffs(quotes, { level: 'BTN', dc: false }, null, 4).options.map(o => o.id), ['a-bt-x', 'c-bt-z', 'd-bt-w', 'e-bt-v']);
});

test('napPlan maps NAP policies to the MOBI.E plan shape', () => {
  assert.deepEqual(napPlan([
    { policy: 'pricePerDeliveryUnit', eur: 0.28 }, { policy: 'pricePerChargingTime', eur: 0.05 }, { policy: 'flatRate', eur: 0.11 },
  ]), { energy: [0.28], time: [{ eur: 0.05, from: 0, to: null }], flat: [0.11] });
  assert.equal(napPlan([]), null);
});

test('parseStatus reads point ids, status and fees from a DATEX II stream', async () => {
  const xml = `<?xml version="1.0"?><ns4:payload xmlns="http://datex2.eu/schema/3/common" xmlns:ns2="f" xmlns:ns3="e" xmlns:ns4="p">
  <publicationTime>2026-10-28T16:35:04Z</publicationTime>
  <ns3:energyInfrastructureSiteStatus><ns2:reference id="SITE-1"/><ns3:energyInfrastructureStationStatus><ns2:reference id="SITE-1"/>
  <ns3:refillPointStatus><ns2:reference id="P-1"/><ns3:status>charging</ns3:status>
  <ns3:electricEnergyMixOverride><ns3:rates><ns2:energyPricingPolicy><ns3:pricingPolicy>flatRate</ns3:pricingPolicy><ns3:minimumDeliveryFee>0.26</ns3:minimumDeliveryFee></ns2:energyPricingPolicy>
  <ns2:overallPeriod><overallStartTime>2025-01-01T00:00:00Z</overallStartTime></ns2:overallPeriod></ns3:rates></ns3:electricEnergyMixOverride>
  </ns3:refillPointStatus></ns3:energyInfrastructureStationStatus></ns3:energyInfrastructureSiteStatus></ns4:payload>`;
  // Split mid-tag to prove chunk boundaries don't matter.
  const enc = new TextEncoder();
  const chunks = [enc.encode(xml.slice(0, 333)), enc.encode(xml.slice(333))];
  const { publicationTime, points } = await parseStatus(chunks);
  assert.equal(publicationTime, '2026-10-28T16:35:04Z');
  assert.deepEqual(points.get('SITE-1/P-1'), { status: 'charging', fees: [{ policy: 'flatRate', eur: 0.26 }] });
  assert.equal(points.size, 1);
});

import { LiveStatus } from '../src/live.js';

const FEED = `<?xml version="1.0"?><ns4:payload xmlns="http://datex2.eu/schema/3/common" xmlns:ns2="f" xmlns:ns3="e" xmlns:ns4="p"><publicationTime>T</publicationTime>`
  + Array.from({ length: 1000 }, (_, i) => `<ns3:energyInfrastructureSiteStatus><ns2:reference id="S${i}"/><ns3:refillPointStatus><ns2:reference id="1"/><ns3:status>available</ns3:status></ns3:refillPointStatus></ns3:energyInfrastructureSiteStatus>`).join('')
  + '</ns4:payload>';

function fakeFetch({ delayMs = 0 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(init.headers);
    await new Promise(r => setTimeout(r, delayMs));
    if (init.headers['if-none-match'] === 'v1') return { status: 304, ok: false, headers: new Headers() };
    return { status: 200, ok: true, headers: new Headers({ etag: 'v1' }), body: [new TextEncoder().encode(FEED)] };
  };
  return { impl, calls };
}

test('live: same point id on two sites stays two points', async () => {
  const { points } = await parseStatus([new TextEncoder().encode(FEED)]);
  assert.equal(points.size, 1000);
  assert.ok(points.get('S0/1') && points.get('S999/1'));
});

test('live: fetched on demand, shared by concurrent callers, cached within the TTL', async () => {
  const f = fakeFetch({ delayMs: 20 });
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: 1000, fetchImpl: f.impl });
  let waits = 0;
  await Promise.all([live.ensure({ onWait: () => waits++ }), live.ensure(), live.ensure()]);
  assert.equal(f.calls.length, 1, 'one download for three callers');
  assert.equal(waits, 1);
  assert.equal(live.get('S5', '1').status, 'available');
  await live.ensure({ onWait: () => waits++ });
  assert.equal(f.calls.length, 1, 'within the TTL: no request at all');
  assert.equal(waits, 1);
});

test('live: past the TTL, revalidates with the ETag', async () => {
  const f = fakeFetch();
  const live = new LiveStatus({ ttlMs: 0, waitMs: 1000, fetchImpl: f.impl });
  await live.ensure();
  await live.ensure();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]['if-none-match'], 'v1');
  assert.equal(live.points.size, 1000, '304 keeps the data');
});

test('live: a slow feed does not hold the caller past the wait budget', async () => {
  const f = fakeFetch({ delayMs: 300 });
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: 30, fetchImpl: f.impl });
  const t0 = Date.now();
  await live.ensure();
  assert.ok(Date.now() - t0 < 200, 'returned on the budget');
  assert.equal(live.points.size, 0);
  assert.equal(live.info().refreshing, true);
  await live.refresh();
  assert.equal(live.points.size, 1000, 'the refresh finished for the next caller');
});

test('live: a truncated download is retried once', async () => {
  let n = 0;
  const impl = async () => {
    n++;
    const text = n === 1 ? FEED.slice(0, FEED.length / 2) : FEED;
    return { status: 200, ok: true, headers: new Headers({ etag: 'v1' }), body: [new TextEncoder().encode(text)] };
  };
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: 1000, fetchImpl: impl });
  await live.ensure();
  assert.equal(n, 2);
  assert.equal(live.points.size, 1000);
  assert.equal(live.info().error, null);
});

test('live: a feed that is down backs off instead of downloading on every request', async () => {
  let n = 0;
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: 1000, fetchImpl: async () => { n++; return { status: 503, ok: false, headers: new Headers() }; } });
  for (let i = 0; i < 10; i++) await live.ensure();
  assert.equal(n, 1, 'an HTTP error is not retried at once, and the next calls wait for the backoff');
  const info = live.info();
  assert.equal(info.failures, 1);
  assert.ok(info.retryAt, 'retryAt says when it tries again');
  // Past the backoff, the next request tries again and recovers.
  live.retryAt = 0;
  live.fetch = fakeFetch().impl;
  await live.ensure();
  assert.equal(live.points.size, 1000);
  assert.equal(live.info().failures, 0);
  assert.equal(live.info().retryAt, null);
});

test('live: the TTL has jitter, within ±10 %', async () => {
  const live = new LiveStatus({ ttlMs: 100_000, waitMs: 1000, fetchImpl: fakeFetch().impl });
  await live.ensure();
  const ttl = live.freshUntil - live.fetchedAt;
  assert.ok(ttl >= 90_000 && ttl <= 110_000, String(ttl));
});
