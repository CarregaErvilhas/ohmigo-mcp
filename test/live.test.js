// When a request waits for the live feed, and when it answers at once with
// the copy it has. The feed is a stub: LiveStatus gets a fake fetch, and the
// whole-server tests a local HTTP server standing in for MOBI.E, so nothing
// here depends on the real 38 MB download.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveStatus } from '../src/live.js';
import { liveNotes } from '../src/mcp.js';

// A valid feed: enough points to pass the sanity check, plus `statuses`
// ({ 'SITE/POINT': status }).
const feed = (statuses = {}) => {
  const entry = (site, point, status) => `<ns3:energyInfrastructureSiteStatus><ns2:reference id="${site}"/><ns3:refillPointStatus><ns2:reference id="${point}"/><ns3:status>${status}</ns3:status></ns3:refillPointStatus></ns3:energyInfrastructureSiteStatus>`;
  return '<?xml version="1.0"?><ns4:payload xmlns="http://datex2.eu/schema/3/common" xmlns:ns2="f" xmlns:ns3="e" xmlns:ns4="p"><publicationTime>2026-10-31T10:00:00Z</publicationTime>'
    + Array.from({ length: 1000 }, (_, i) => entry(`S${i}`, '1', 'available')).join('')
    + Object.entries(statuses).map(([k, v]) => entry(...k.split('/'), v)).join('')
    + '</ns4:payload>';
};

function stubFetch({ delayMs = 0, fail = false } = {}) {
  const stub = { calls: 0, delayMs, fail };
  stub.impl = async () => {
    stub.calls++;
    await new Promise(r => setTimeout(r, stub.delayMs));
    if (stub.fail) return { status: 503, ok: false, headers: new Headers() };
    return { status: 200, ok: true, headers: new Headers(), body: [new TextEncoder().encode(feed())] };
  };
  return stub;
}

const HOUR = 3_600_000;
// A LiveStatus whose copy was fetched `ageMs` ago and went out of the TTL.
async function withCopy(ageMs, { delayMs = 0, ...opts } = {}) {
  const stub = stubFetch();
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: 5_000, fetchImpl: stub.impl, ...opts });
  await live.ensure();
  live.fetchedAt -= ageMs;
  live.freshUntil = 0;
  stub.calls = 0;
  stub.delayMs = delayMs;
  return { live, stub };
}
const timed = async f => { const t0 = Date.now(); await f(); return Date.now() - t0; };

test('live: a copy past the TTL but usable answers at once and refreshes once behind it', async () => {
  const { live, stub } = await withCopy(20 * 60_000, { delayMs: 200 });
  let waits = 0;
  const ms = await timed(() => live.ensure({ onWait: () => waits++ }));
  assert.ok(ms < 100, `answered in ${ms} ms`);
  assert.equal(waits, 0, 'no "getting live status" message: nobody is waiting');
  assert.equal(stub.calls, 1);
  assert.equal(live.info().fresh, false, 'flagged');
  assert.equal(live.info().refreshing, true, 'flagged');
  await live.ensure();
  assert.equal(stub.calls, 1, 'the next caller does not start another');
  await live.running;
  assert.equal(live.info().fresh, true);
  assert.equal(live.info().refreshing, false);
});

test('live: with no copy at all, a request waits for the download', async () => {
  const stub = stubFetch({ delayMs: 100 });
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: 5_000, fetchImpl: stub.impl });
  let waits = 0;
  await live.ensure({ onWait: () => waits++ });
  assert.equal(waits, 1);
  assert.equal(live.points.size, 1000);
  assert.equal(live.info().fresh, true);
});

test('live: a copy past the usable age makes the request wait', async () => {
  const { live, stub } = await withCopy(2 * HOUR, { delayMs: 100, maxStaleMs: HOUR });
  let waits = 0;
  await live.ensure({ onWait: () => waits++ });
  assert.equal(waits, 1);
  assert.equal(stub.calls, 1);
  assert.equal(live.info().fresh, true, 'the wait brought the new copy');
});

test('live: a too-old copy still only waits up to the budget', async () => {
  const { live } = await withCopy(2 * HOUR, { delayMs: 300, maxStaleMs: HOUR, waitMs: 30 });
  const ms = await timed(() => live.ensure());
  assert.ok(ms < 200, `answered in ${ms} ms`);
  assert.equal(live.info().fresh, false);
  await live.running;
});

test('live: the usable age is configurable, 0 means always wait', async () => {
  const { live } = await withCopy(1000, { delayMs: 50, maxStaleMs: 0 });
  await live.ensure();
  assert.equal(live.info().fresh, true);
});

test('live: concurrent requests share one refresh, usable copy or not', async () => {
  const stale = await withCopy(20 * 60_000, { delayMs: 50 });
  await Promise.all(Array.from({ length: 5 }, () => stale.live.ensure()));
  assert.equal(stale.stub.calls, 1);
  await stale.live.running;
  const old = await withCopy(2 * HOUR, { delayMs: 50, maxStaleMs: HOUR });
  await Promise.all(Array.from({ length: 5 }, () => old.live.ensure()));
  assert.equal(old.stub.calls, 1);
});

test('live: a failed background refresh keeps the copy and backs off as before', async () => {
  const { live, stub } = await withCopy(20 * 60_000);
  stub.fail = true;
  await live.ensure();
  await live.running;
  assert.equal(live.points.size, 1000, 'the copy stays');
  assert.equal(live.info().failures, 1);
  assert.ok(live.info().retryAt);
  await live.ensure();
  assert.equal(stub.calls, 1, 'no new download during the backoff');
});

test('live: a snapshot keeps the copy and the flags the request started with', async () => {
  const { live } = await withCopy(20 * 60_000, { delayMs: 20 });
  await live.ensure();
  const before = live.points;
  const seen = live.snapshot();
  await live.running;
  assert.notEqual(live.points, before, 'the refresh brought a new copy');
  assert.equal(live.info().fresh, true);
  // An answer built from the old copy must not say it's fresh.
  assert.equal(seen.info().fresh, false);
  assert.equal(seen.info().refreshing, true);
  assert.deepEqual(seen.get('S1', '1'), before.get('S1/1'));
  assert.equal(seen.get('nope', '1'), null);
});

// The whole server, with a local feed that counts its downloads.
let feedServer, server, base, dir;
let feedHits = 0, feedDelayMs = 0;

before(async () => {
  const site = (id, extra) => ({ id, code: id, lat: 39.74, lon: -8.81, region: 'CONT', city: 'Leiria', address: 'Rua 1', operator: 'Op', operatorId: 'OP', ...extra });
  const t2 = id => ({ id, kw: 22, connector: 'T2', dc: false, regime: 'sem_ceme', napPrice: 0.5 });
  const ccs = { id: '1', kw: 350, connector: 'CCS', dc: true, regime: 'sem_ceme', napPrice: 0.5 };
  // Two sides of a motorway service area: asking for it needs a direction.
  const side = (id, lat, lon, address) => site(id, { lat, lon, city: 'Almodôvar', address, operator: 'IONITY GmbH', operatorId: 'IONY', points: [ccs] });
  dir = mkdtempSync(join(tmpdir(), 'ohmigo-live-'));
  const data = join(dir, 'chargers.json');
  writeFileSync(data, JSON.stringify({ schema: 1, generatedAt: '2026-10-28T00:00:00Z', sites: [
    site('TWO-1', { points: [t2('a'), t2('b')] }),
    side('IOY-ADV-00017', 37.53586, -8.184742, 'Área de Serviço de Almodôvar N/S, km 193 A2'),
    side('IOY-ADV-00018', 37.536327, -8.182924, 'Área de Serviço de Almodôvar S/N, km 193 A2'),
  ] }));

  // Socket a is taken, b is free: the free one has to be the one quoted.
  const body = feed({ 'TWO-1/a': 'charging', 'TWO-1/b': 'available' });
  feedServer = createServer((req, res) => {
    feedHits++;
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(body); }, feedDelayMs);
  }).listen(0, '127.0.0.1');
  await once(feedServer, 'listening');

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_PATH: data, CEME_API_URL: 'http://127.0.0.1:9', CEME_API_KEY: '',
      NAP_STATUS_URL: `http://127.0.0.1:${feedServer.address().port}/live`, LIVE_WARMUP: '0', LIVE_WAIT_SECONDS: '5',
      // Every copy is past the TTL at once, and usable.
      LIVE_TTL_SECONDS: '0', LIVE_MAX_STALE_SECONDS: '3600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  base = await new Promise((resolve, reject) => {
    server.stdout.on('data', () => { const m = out.match(/http:\/\/(\S+?)\/mcp/); if (m) resolve(`http://${m[1]}`); });
    server.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
});

after(() => { server.kill('SIGKILL'); feedServer.closeAllConnections(); feedServer.close(); rmSync(dir, { recursive: true, force: true }); });

async function call(name, args) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const msgs = (await r.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  return msgs.find(m => m.id === 1).result;
}

const car = { battery_kwh: 58, start_pct: 20, lang: 'en' };
const idle = async () => { while ((await fetch(`${base}/healthz`).then(r => r.json())).live.refreshing) await new Promise(r => setTimeout(r, 10)); };

// These run first: they prove no download starts, with no copy in memory.
test('http: estimate_charging_cost errors that need no live data do not touch the feed', async () => {
  for (const args of [{}, { point_id: 'NOPE/1' }, { site: 'zzzzqqq' }, { site: 'Almodôvar' }]) {
    const r = await call('estimate_charging_cost', { ...args, ...car });
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(feedHits, 0);
});

test('http: estimate_charging_cost still waits for the first copy and shows the free socket of identical ones', async () => {
  feedDelayMs = 100;
  const r = await call('estimate_charging_cost', { site: 'TWO-1', ...car });
  assert.equal(feedHits, 1);
  assert.equal(r.structuredContent.live.points, 1002);
  assert.deepEqual(r.structuredContent.results.map(q => q.pointId), ['TWO-1/b']);
});

test('note: a fresh copy has no age to mention, and neither does no copy', () => {
  const notesWith = fresh => liveNotes({ info: () => fresh }, key => key);
  assert.deepEqual(notesWith({ fresh: true, checkedAt: new Date().toISOString() }), []);
  assert.deepEqual(notesWith({ fresh: false, checkedAt: null }), []);
  assert.deepEqual(notesWith({ fresh: false, checkedAt: new Date(Date.now() - 20 * 60_000).toISOString() }), ['note.liveAge']);
});

test('http: a usable stale copy answers at once, flagged and with its age, in both languages', async () => {
  await idle();
  feedDelayMs = 2_000;
  for (const [lang, words] of [['en', /last checked \d+ min ago/], ['pt', /há \d+ min/]]) {
    const t0 = Date.now();
    const r = await call('find_chargers', { place: 'Leiria', lang });
    assert.ok(Date.now() - t0 < 1000, 'did not wait for the 2 s feed');
    const { live, notes } = r.structuredContent;
    assert.equal(live.fresh, false);
    assert.equal(live.refreshing, true);
    assert.ok(notes.some(n => words.test(n)), JSON.stringify(notes));
  }
  const hits = feedHits;
  for (const [tool, args] of [['estimate_charging_cost', { site: 'TWO-1', ...car }], ['find_cheapest_charging', { place: 'Leiria', ...car }], ['lookup_charger', { query: 'TWO-1', lang: 'en' }]]) {
    const r = await call(tool, args);
    assert.ok(r.structuredContent.notes.some(n => /last checked/.test(n)), tool);
    assert.match(r.content[0].text, /last checked/, tool);
  }
  assert.equal(feedHits, hits, 'all of them shared the one refresh');
});
