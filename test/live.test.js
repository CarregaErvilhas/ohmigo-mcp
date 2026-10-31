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
const feed = (statuses = {}, publishedAt = new Date().toISOString()) => {
  const entry = (site, point, status) => `<ns3:energyInfrastructureSiteStatus><ns2:reference id="${site}"/><ns3:refillPointStatus><ns2:reference id="${point}"/><ns3:status>${status}</ns3:status></ns3:refillPointStatus></ns3:energyInfrastructureSiteStatus>`;
  return `<?xml version="1.0"?><ns4:payload xmlns="http://datex2.eu/schema/3/common" xmlns:ns2="f" xmlns:ns3="e" xmlns:ns4="p"><publicationTime>${publishedAt}</publicationTime>`
    + Array.from({ length: 1000 }, (_, i) => entry(`S${i}`, '1', 'available')).join('')
    + Object.entries(statuses).map(([k, v]) => entry(...k.split('/'), v)).join('')
    + '</ns4:payload>';
};

// The download finishes when the test says so, not after some delay: while
// it's held, a request that returns can only have not waited for it.
const gate = () => {
  const g = { hold() { g.held = Promise.withResolvers(); }, release() { g.held?.resolve(); g.held = null; } };
  return g;
};

function stubFetch() {
  const stub = gate();
  Object.assign(stub, { calls: 0, fail: false, notModified: false, publishedAt: undefined });
  stub.impl = async () => {
    stub.calls++;
    await stub.held?.promise;
    if (stub.fail) return { status: 503, ok: false, headers: new Headers() };
    if (stub.notModified) return { status: 304, ok: false, headers: new Headers() };
    return { status: 200, ok: true, headers: new Headers({ etag: 'v1' }), body: [new TextEncoder().encode(feed({}, stub.publishedAt))] };
  };
  return stub;
}

const HOUR = 3_600_000;
// Far longer than the tests' timeout: a request that would wait hangs, and
// "answers at once" fails on that, not on a stopwatch.
const LONG_WAIT = 60_000;
const limit = { timeout: 5_000 };
// A LiveStatus whose copy was fetched `ageMs` ago and went out of the TTL.
async function withCopy(ageMs, opts = {}) {
  const stub = stubFetch();
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: LONG_WAIT, fetchImpl: stub.impl, ...opts });
  await live.ensure();
  live.fetchedAt -= ageMs;
  live.freshUntil = 0;
  stub.calls = 0;
  return { live, stub };
}
// Still running once everything that could finish now has.
const pending = async p => {
  let done = false;
  p.then(() => { done = true; });
  await new Promise(r => setImmediate(r));
  return !done;
};

test('live: a copy past the TTL but usable answers at once and refreshes once behind it', limit, async () => {
  const { live, stub } = await withCopy(20 * 60_000);
  stub.hold();
  let waits = 0;
  await live.ensure({ onWait: () => waits++ });
  assert.equal(waits, 0, 'no "getting live status" message: nobody is waiting');
  assert.equal(stub.calls, 1);
  assert.equal(live.info().fresh, false, 'flagged');
  assert.equal(live.info().refreshing, true, 'flagged');
  await live.ensure();
  assert.equal(stub.calls, 1, 'the next caller does not start another');
  stub.release();
  await live.running;
  assert.equal(live.info().fresh, true);
  assert.equal(live.info().refreshing, false);
});

test('live: with no copy at all, a request waits for the download', limit, async () => {
  const stub = stubFetch();
  stub.hold();
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: LONG_WAIT, fetchImpl: stub.impl });
  let waits = 0;
  const asked = live.ensure({ onWait: () => waits++ });
  assert.equal(await pending(asked), true);
  assert.equal(waits, 1);
  stub.release();
  await asked;
  assert.equal(live.points.size, 1000);
  assert.equal(live.info().fresh, true);
});

test('live: a copy past the usable age makes the request wait', limit, async () => {
  const { live, stub } = await withCopy(2 * HOUR, { maxStaleMs: HOUR });
  stub.hold();
  let waits = 0;
  const asked = live.ensure({ onWait: () => waits++ });
  assert.equal(await pending(asked), true);
  assert.equal(waits, 1);
  assert.equal(stub.calls, 1);
  stub.release();
  await asked;
  assert.equal(live.info().fresh, true, 'the wait brought the new copy');
});

test('live: a too-old copy still only waits up to the budget', limit, async () => {
  const { live, stub } = await withCopy(2 * HOUR, { maxStaleMs: HOUR, waitMs: 1 });
  stub.hold();
  await live.ensure();
  assert.equal(live.info().fresh, false);
  assert.equal(live.info().refreshing, true, 'gave up on the download, which goes on');
  stub.release();
  await live.running;
});

test('live: the usable age is configurable, 0 means always wait', limit, async () => {
  const { live, stub } = await withCopy(1000, { maxStaleMs: 0 });
  stub.hold();
  const asked = live.ensure();
  assert.equal(await pending(asked), true);
  stub.release();
  await asked;
  assert.equal(live.info().fresh, true);
});

test('live: concurrent requests share one refresh, usable copy or not', limit, async () => {
  const stale = await withCopy(20 * 60_000);
  stale.stub.hold();
  await Promise.all(Array.from({ length: 5 }, () => stale.live.ensure()));
  assert.equal(stale.stub.calls, 1);
  stale.stub.release();
  await stale.live.running;
  const old = await withCopy(2 * HOUR, { maxStaleMs: HOUR });
  old.stub.hold();
  const asked = Promise.all(Array.from({ length: 5 }, () => old.live.ensure()));
  assert.equal(await pending(asked), true);
  old.stub.release();
  await asked;
  assert.equal(old.stub.calls, 1);
});

test('live: a failed background refresh keeps the copy and backs off as before', limit, async () => {
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

test('live: a snapshot keeps the copy and the flags the request started with', limit, async () => {
  const { live, stub } = await withCopy(20 * 60_000);
  stub.hold();
  await live.ensure();
  const before = live.points;
  const seen = live.snapshot();
  stub.release();
  await live.running;
  assert.notEqual(live.points, before, 'the refresh brought a new copy');
  assert.equal(live.info().fresh, true);
  // An answer built from the old copy must not say it's fresh.
  assert.equal(seen.info().fresh, false);
  assert.equal(seen.info().refreshing, true);
  assert.deepEqual(seen.get('S1', '1'), before.get('S1/1'));
  assert.equal(seen.get('nope', '1'), null);
});

const key = k => k;
const noteMin = live => { let min; liveNotes(live, (k, v) => { min = v.min; return k; }); return min; };

test('note: a just-published copy has no age to mention, and neither does no copy', limit, async () => {
  const stub = stubFetch();
  const live = new LiveStatus({ ttlMs: 60_000, waitMs: LONG_WAIT, fetchImpl: stub.impl });
  assert.deepEqual(liveNotes(live.snapshot(), key), [], 'no copy');
  await live.ensure();
  assert.deepEqual(liveNotes(live.snapshot(), key), [], 'fresh');
});

test('note: the age counts from when the data was published, not from our last check', limit, async () => {
  const { live } = await withCopy(5 * 60_000);
  live.publicationTime = new Date(Date.now() - 40 * 60_000).toISOString();
  const min = noteMin(live.snapshot());
  assert.ok(min >= 40 && min <= 41, String(min));
});

test('note: a stalled publisher shows even though every 304 keeps our copy fresh', limit, async () => {
  const stub = stubFetch();
  stub.publishedAt = new Date(Date.now() - 2 * HOUR).toISOString();
  const live = new LiveStatus({ ttlMs: 60_000, maxStaleMs: 0, waitMs: LONG_WAIT, fetchImpl: stub.impl });
  await live.ensure();
  stub.notModified = true;
  live.freshUntil = 0;
  await live.ensure();
  assert.equal(stub.calls, 2);
  assert.equal(live.info().fresh, true, 'the 304 counts as a good check');
  assert.deepEqual(liveNotes(live.snapshot(), key), ['note.liveAge']);
  assert.ok(noteMin(live.snapshot()) >= 120);
});

test('note: a publication time that does not parse falls back on our last check', limit, async () => {
  const { live } = await withCopy(20 * 60_000);
  live.publicationTime = 'T';
  assert.ok(noteMin(live.snapshot()) >= 20);
});

// The whole server, with a local feed that counts its downloads.
let feedServer, server, base, dir;
const feedGate = gate();
let feedHits = 0;

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
    // Elsewhere, so a search there finds only this one, taken.
    site('BUSY-1', { lat: 37.02, lon: -7.93, city: 'Faro', points: [t2('a')] }),
    side('IOY-ADV-00017', 37.53586, -8.184742, 'Área de Serviço de Almodôvar N/S, km 193 A2'),
    side('IOY-ADV-00018', 37.536327, -8.182924, 'Área de Serviço de Almodôvar S/N, km 193 A2'),
  ] }));

  // Socket a is taken, b is free: the free one has to be the one quoted.
  const body = feed({ 'TWO-1/a': 'charging', 'TWO-1/b': 'available', 'BUSY-1/a': 'charging' });
  feedServer = createServer(async (req, res) => {
    // Local tools probe open ports: only the server's own requests count.
    if (req.url !== '/live') { res.writeHead(404); return res.end(); }
    feedHits++;
    await feedGate.held?.promise;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(body);
  }).listen(0, '127.0.0.1');
  await once(feedServer, 'listening');

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_PATH: data, CEME_API_URL: 'http://127.0.0.1:9', CEME_API_KEY: '',
      NAP_STATUS_URL: `http://127.0.0.1:${feedServer.address().port}/live`, LIVE_WARMUP: '0', LIVE_WAIT_SECONDS: '60',
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

after(() => { feedGate.release(); server.kill('SIGKILL'); feedServer.closeAllConnections(); feedServer.close(); rmSync(dir, { recursive: true, force: true }); });

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
test('http: errors that need no live data do not touch the feed', limit, async () => {
  for (const [args, code] of [[{}, 'which'], [{ point_id: 'NOPE/1' }, 'point'], [{ site: 'zzzzqqq' }, 'lookup'], [{ site: 'Almodôvar' }, 'direction']]) {
    const r = await call('estimate_charging_cost', { ...args, ...car });
    assert.equal(r.structuredContent.code, code, JSON.stringify(args));
  }
  const r = await call('find_cheapest_charging', { place: 'Leiria', min_kw: 1000, ...car });
  assert.equal(r.structuredContent.code, 'noMatch');
  assert.equal(feedHits, 0);
});

test('http: estimate_charging_cost still waits for the first copy and shows the free socket of identical ones', limit, async () => {
  const r = await call('estimate_charging_cost', { site: 'TWO-1', ...car });
  assert.equal(feedHits, 1);
  assert.equal(r.structuredContent.live.points, 1003);
  assert.deepEqual(r.structuredContent.results.map(q => q.pointId), ['TWO-1/b']);
});

test('http: a usable stale copy answers at once, flagged and with its age, in both languages', limit, async () => {
  await idle();
  feedGate.hold();
  for (const [lang, words] of [['en', /published \d+ min ago/], ['pt', /publicados há \d+ min/]]) {
    const r = await call('find_chargers', { place: 'Leiria', lang });
    const { live, notes } = r.structuredContent;
    assert.equal(live.fresh, false);
    assert.equal(live.refreshing, true);
    assert.ok(notes.some(n => words.test(n)), JSON.stringify(notes));
  }
  const hits = feedHits;
  for (const [tool, args] of [['estimate_charging_cost', { site: 'TWO-1', ...car }], ['find_cheapest_charging', { place: 'Leiria', ...car }], ['lookup_charger', { query: 'TWO-1', lang: 'en' }]]) {
    const r = await call(tool, args);
    assert.ok(r.structuredContent.notes.some(n => /published \d+ min ago/.test(n)), tool);
    assert.match(r.content[0].text, /published \d+ min ago/, tool);
  }
  assert.equal(feedHits, hits, 'all of them shared the one refresh');
  feedGate.release();
});

test('http: when an old copy leaves no charger, the error says how old it is', limit, async () => {
  await idle();
  const r = await call('find_cheapest_charging', { place: 'Faro', ...car });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'noneLeft');
  assert.match(r.structuredContent.notes.join(), /published \d+ min ago/);
  assert.match(r.content[0].text, /published \d+ min ago/);
  assert.doesNotMatch(r.structuredContent.message, /min ago/, 'the view prints message to the driver');
  await idle();
});
