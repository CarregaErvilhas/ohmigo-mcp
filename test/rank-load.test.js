// What one ranking may cost: a cap on distinct ceme-v2 calls, a few rankings at
// once per process, and turns for the event loop while it prices. Stub ceme-v2
// (fetch in this process, a local server for the end-to-end ones): nothing
// leaves the machine.
import { test, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realFetch = globalThis.fetch;
process.env.CEME_API_URL = 'http://ceme.test';
process.env.CEME_API_KEY = 'k';
const { MAX_RANKINGS, MAX_RANKINGS_QUEUED, MAX_SIMS_PER_CALL, RANK_CHUNK, rank, rankingSlot } = await import('../src/quote.js');
const { translator } = await import('../src/i18n.js');

const REPLY = b => ({ at: b.at, kwh: b.kwh, profile: { slices: b.profile.length, withSpot: 0 }, data: [
  { id: 'a-bt-x', ceme: 'A', name: 'X', voltage: 'BT', kind: 'FIXED', period: 'FORA_VAZIO', totalEur: b.kwh * 0.2, vat: 1.23, popular: true, bundle: false },
] });
const answer = body => new Response(JSON.stringify(REPLY(body)), { status: 200 });

const point = (id, kw) => ({ id, kw, dc: false, connector: 'T2', regime: 'mobie', level: 'BTN', opc: { REGULAR: { flat: [0], energy: [0.1], time: [] } } });
const site = (i, points) => ({ site: { id: `S-${i}`, code: `C${i}`, operator: 'O', operatorId: 'O', region: 'CONT', lat: 38.7, lon: -9.1 }, points, km: i });
const car = { batteryKwh: 60, startPct: 20, targetPct: 80, acKw: 22 };
// The cache outlives each test, so each one prices its own hour.
let hours = 0;
const when = () => new Date(Date.UTC(2026, 10, 10, 12) + ++hours * 3_600_000);
// One site per charging speed: every one needs its own ceme-v2 call.
const speeds = n => Array.from({ length: n }, (_, i) => site(i, [point(`P${i}`, 3 + i * 0.1)]));

afterEach(() => mock.timers.reset());

const outside = (id, kw) => ({ id, kw, dc: false, connector: 'T2', regime: 'sem_ceme', napPrice: 0.3 });
const counting = () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return answer(b); };
  return bodies;
};

test('past the cap only the sockets needing a new call are left out, and it says how many', async () => {
  const bodies = counting();
  const n = MAX_SIMS_PER_CALL + 25;
  const ranked = await rank(speeds(n), car, { at: when(), lang: 'en' });
  assert.equal(bodies.length, MAX_SIMS_PER_CALL);
  assert.equal(ranked.socketsLeftOut, 25);
  assert.equal(ranked.sitesPriced, MAX_SIMS_PER_CALL);
  assert.deepEqual(ranked.map(q => q.siteId).sort(), speeds(MAX_SIMS_PER_CALL).map(c => c.site.id).sort(), 'the nearest speeds');
  assert.ok(ranked.every(q => q.total), 'what it did price, it priced in full');
});

test('the cap keeps every site that needs no new call, however far', async () => {
  const bodies = counting();
  const list = speeds(MAX_SIMS_PER_CALL + 5);
  const far = list.length;
  list.push(site(far, [outside('tesla', 150)])); // outside MOBI.E: no ceme-v2 call
  list.push(site(far + 1, [point('same', 3)])); // a speed already fetched
  list.push(site(far + 2, [point('kept', 3), point('new', 40)])); // half and half
  const ranked = await rank(list, car, { at: when(), lang: 'en' });
  assert.equal(bodies.length, MAX_SIMS_PER_CALL);
  const ids = ranked.map(q => q.siteId);
  for (const i of [far, far + 1, far + 2]) assert.ok(ids.includes(`S-${i}`), `S-${i}`);
  assert.equal(ranked.socketsLeftOut, 6);
  assert.equal(ranked.find(q => q.siteId === `S-${far + 2}`).pointId, `S-${far + 2}/kept`);
});

test('a socket the filters drop spends no call', async () => {
  const bodies = counting();
  const busy = new Map(Array.from({ length: MAX_SIMS_PER_CALL + 5 }, (_, i) => [`S-${i}`, 'charging']));
  const live = { get: id => ({ status: busy.get(id) ?? 'available' }) };
  const list = speeds(MAX_SIMS_PER_CALL + 5);
  list.push(site(900, [point('free', 44)]));
  const ranked = await rank(list, { ...car, acKw: 43 }, { at: when(), lang: 'en', live, availableOnly: true });
  assert.equal(bodies.length, 1);
  assert.deepEqual(ranked.map(q => q.siteId), ['S-900']);
  assert.equal(ranked.socketsLeftOut, 0);
  const slow = await rank(speeds(5), car, { at: when(), lang: 'en', maxMinutes: 1 });
  assert.equal(bodies.length, 1, 'too slow for max_minutes: no call either');
  assert.equal(slow.length, 0);
  assert.equal(slow.nonePriced, false, 'the filter did that, and noneLeft says so');
});

test('replies the cache already has do not count toward the cap', async () => {
  const bodies = counting();
  const t = when();
  await rank(speeds(MAX_SIMS_PER_CALL), car, { at: t, lang: 'en' });
  const n = bodies.length;
  const ranked = await rank(speeds(MAX_SIMS_PER_CALL + 10), car, { at: t, lang: 'en' });
  assert.equal(bodies.length, n + 10);
  assert.equal(ranked.socketsLeftOut, 0);
});

test('sockets at a speed already asked for cost nothing, so nothing is cut', async () => {
  const bodies = counting();
  const n = MAX_SIMS_PER_CALL * 3;
  const ranked = await rank(Array.from({ length: n }, (_, i) => site(i, [point(`P${i}`, 7.4)])), car, { at: when(), lang: 'en' });
  assert.equal(bodies.length, 1);
  assert.equal(ranked.sitesPriced, n);
  assert.equal(ranked.length, n);
});

test('the cap never empties a ranking, even with more speeds than calls at one site', async () => {
  counting();
  const points = Array.from({ length: MAX_SIMS_PER_CALL + 3 }, (_, i) => point(`P${i}`, 3 + i * 0.1));
  const ranked = await rank([site(0, points)], car, { at: when(), lang: 'en' });
  assert.equal(ranked.length, 1);
  assert.equal(ranked.socketsLeftOut, 3);
});

test('every ceme-v2 call starts before any socket is priced', async () => {
  const held = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); await new Promise(r => held.push(r)); return answer(b); };
  const list = Array.from({ length: RANK_CHUNK * 3 }, (_, i) => site(i, [point(`P${i}`, 3 + (i % 5))]));
  const running = rank(list, car, { at: when(), lang: 'en' });
  for (let i = 0; i < 20 && held.length < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(held.length, 5, 'all five speeds are in flight together, though they span the chunks');
  for (const go of held) go();
  assert.equal((await running).length, list.length);
});

test('a ranking stops when its request is abandoned', async () => {
  const bodies = counting();
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(rank(speeds(5), car, { at: when(), lang: 'en', signal: stop.signal }));
  assert.equal(bodies.length, 0);
  await assert.rejects(rankingSlot(stop.signal, () => assert.fail('must not run')));
});

test('a ranking abandoned in line gives up its place without running', async () => {
  const release = [];
  const taken = Array.from({ length: MAX_RANKINGS }, () => rankingSlot(undefined, () => new Promise(r => release.push(r))));
  const stop = new AbortController();
  let ran = false;
  const waiting = rankingSlot(stop.signal, () => { ran = true; });
  const others = Array.from({ length: MAX_RANKINGS_QUEUED - 1 }, () => rankingSlot(undefined, async () => {}));
  stop.abort();
  await assert.rejects(waiting);
  // The place it left is free for someone else, and the line still runs.
  const next = rankingSlot(undefined, async () => 'ran');
  for (const go of release) go();
  await Promise.all([...taken, ...others]);
  assert.equal(await next, 'ran');
  assert.equal(ran, false);
});

test('a ranking prices every socket at the same instant, however long it takes', async () => {
  // Without `at`, each quote read the clock: past a minute boundary between
  // chunks the slices change and every speed needs a second ceme-v2 call.
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 10, 12, 0, 59) });
  const bodies = [];
  globalThis.fetch = async (url, init) => { mock.timers.tick(5000); const b = JSON.parse(init.body); bodies.push(b); return answer(b); };
  const list = Array.from({ length: RANK_CHUNK * 3 }, (_, i) => site(i, [point(`P${i}`, i < RANK_CHUNK * 2 ? 7.4 : 11)]));
  await rank(list, car, { lang: 'en' });
  assert.equal(bodies.length, 2);
  assert.equal(new Set(bodies.map(b => b.at)).size, 1);
});

test('a ranking gives the event loop turns while it prices', async () => {
  globalThis.fetch = async (url, init) => answer(JSON.parse(init.body));
  let turns = 0, running = true;
  const tick = () => { turns++; if (running) setImmediate(tick); };
  setImmediate(tick);
  await rank(Array.from({ length: RANK_CHUNK * 6 }, (_, i) => site(i, [point(`P${i}`, 7.4)])), car, { at: when(), lang: 'en' });
  running = false;
  assert.ok(turns >= 5, `${turns} turns`);
});

test('only a few rankings run at once, the rest wait in line, and past the line it refuses', async () => {
  const release = [];
  let started = 0;
  const order = [];
  const tick = () => new Promise(r => setImmediate(r));
  const room = MAX_RANKINGS + MAX_RANKINGS_QUEUED;
  const all = Array.from({ length: room }, (_, i) => rankingSlot(undefined, async () => { started++; await new Promise(r => release.push(r)); order.push(i); }));
  await tick();
  assert.equal(started, MAX_RANKINGS);
  await assert.rejects(rankingSlot(undefined, async () => {}), e => e.busy === true);
  while (order.length < room) { release.shift()?.(); await tick(); await tick(); }
  await Promise.all(all);
  assert.deepEqual(order, Array.from({ length: room }, (_, i) => i), 'first come, first served');
});

test('a ranking that fails gives its place back', async () => {
  for (let i = 0; i < MAX_RANKINGS + 2; i++) await assert.rejects(rankingSlot(undefined, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await rankingSlot(undefined, async () => 'free'), 'free');
});

test('a price served from the last good answer says so, with its age', async () => {
  const seven = Date.now() - 6.5 * 60_000; // rounded up: "7 min"
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); return new Response(JSON.stringify({ ...REPLY(b), staleSince: seven }), { status: 200 }); };
  for (const lang of ['en', 'pt']) {
    const [q] = await rank(speeds(1), car, { at: when(), lang });
    assert.ok(q.assumptions.includes(translator(lang)('assume.cemeStale', { minutes: 7 })), q.assumptions.join(' | '));
  }
});

test('a CEME price held back by this server never says the service did not answer', () => {
  for (const lang of ['en', 'pt']) {
    const t = translator(lang);
    for (const key of ['note.cemeBusy', 'note.cemeBusy.driver', 'err.pricingBusy', 'err.tariffsBusy']) assert.doesNotMatch(t(key), /didn't answer|não respondeu/);
  }
});

test('the cut note says only what happened', () => {
  const t = translator('en');
  assert.doesNotMatch(t('note.truncated', { n: 10, total: 10, sockets: 3 }), /nearest of/);
  assert.match(t('note.truncated', { n: 10, total: 10, sockets: 3 }), /^3 kinds/);
  assert.doesNotMatch(t('note.truncated', { n: 5, total: 10, sockets: 0 }), /left out/);
});

// End to end: the cut and the refusal as the assistant sees them.
const tmp = mkdtempSync(join(tmpdir(), 'ohmigo-rank-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function serve() {
  const held = [];
  const state = { hold: false, simulates: 0, release() { state.hold = false; for (const r of held.splice(0)) r(); } };
  const ceme = createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      state.simulates++;
      if (state.hold) await new Promise(r => held.push(r));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(REPLY(JSON.parse(raw))));
    });
  }).listen(0, '127.0.0.1');
  await once(ceme, 'listening');
  const sites = Array.from({ length: MAX_SIMS_PER_CALL + 10 }, (_, i) => ({ id: `S-${i}`, code: `C${i}`, lat: 38.7 + i * 0.001, lon: -9.1, region: 'CONT', city: 'Lisboa', address: `Rua ${i}`, operator: 'Op', operatorId: 'OP', points: [{ ...point(`P${i}`, 3 + i * 0.1), phases: 1 }] }));
  const dataset = join(tmp, 'chargers.json');
  writeFileSync(dataset, JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), sites }));
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_PATH: dataset, CEME_API_URL: `http://127.0.0.1:${ceme.address().port}`, CEME_API_KEY: 'k', NAP_STATUS_URL: 'http://127.0.0.1:9/live', LIVE_WARMUP: '0', LIVE_WAIT_SECONDS: '1', HEALTHZ_TOKEN: '' },
  });
  let out = '';
  const base = await new Promise((resolve, reject) => {
    proc.stdout.on('data', c => { out += c; const m = out.match(/http:\/\/(\S+?)\/mcp/); if (m) resolve(`http://${m[1]}`); });
    proc.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
  const call = async (args, id = 1, signal) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'find_cheapest_charging', arguments: args } }),
    });
    const text = await r.text();
    const msgs = r.headers.get('content-type')?.includes('text/event-stream')
      ? text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))) : [JSON.parse(text)];
    return msgs.find(m => m.id === id).result;
  };
  return { call, state, stop() { proc.removeAllListeners('exit'); proc.kill('SIGKILL'); ceme.close(); } };
}

const ARGS = { lat: 38.7, lon: -9.1, radius_km: 20, battery_kwh: 60, start_pct: 20, car_ac_kw: 22, available_only: false, lang: 'pt' };

test('end to end: the ranking reports the cut through the existing note', async () => {
  // The real fetch: the stub above would answer for the server's ceme-v2.
  globalThis.fetch = realFetch;
  const s = await serve();
  try {
    const { structuredContent: d, isError } = await s.call(ARGS);
    assert.ok(!isError);
    assert.equal(s.state.simulates, MAX_SIMS_PER_CALL);
    assert.equal(d.truncated, true);
    assert.equal(d.quoted, MAX_SIMS_PER_CALL);
    assert.equal(d.searched, MAX_SIMS_PER_CALL + 10);
    assert.equal(d.socketsLeftOut, 10);
    assert.ok(d.notes.includes(translator('pt')('note.truncated', { n: MAX_SIMS_PER_CALL + 10, total: MAX_SIMS_PER_CALL + 10, sockets: 10 })));
  } finally { s.stop(); }
});

test('end to end: past the line of rankings the tool says to try again', async () => {
  globalThis.fetch = realFetch;
  const s = await serve();
  try {
    await s.call({ ...ARGS, radius_km: 0.3 }); // the live feed wait, once, so the next ones race only each other
    s.state.hold = true;
    const room = MAX_RANKINGS + MAX_RANKINGS_QUEUED;
    const inLine = Array.from({ length: room }, (_, i) => s.call({ ...ARGS, radius_km: 0.3, start_pct: 21 + i }, i + 10));
    await new Promise(r => setTimeout(r, 150));
    const refused = await s.call({ ...ARGS, radius_km: 0.3, start_pct: 60 }, 99);
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, translator('pt')('err.busy'));
    s.state.release();
    const results = await Promise.all(inLine);
    assert.ok(results.every(r => !r.isError));
  } finally { s.state.release(); s.stop(); }
});

test('end to end: a client that hangs up costs no more ceme-v2 calls', async () => {
  globalThis.fetch = realFetch;
  const s = await serve();
  try {
    await s.call({ ...ARGS, radius_km: 0.3 });
    s.state.hold = true;
    s.state.simulates = 0;
    const stop = new AbortController();
    const gone = s.call({ ...ARGS, start_pct: 25 }, 7, stop.signal).catch(() => null);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(s.state.simulates > 0, 'it started');
    const before = s.state.simulates;
    stop.abort();
    await gone;
    await new Promise(r => setTimeout(r, 100));
    s.state.release();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(s.state.simulates, before, 'what was still in line never went out');
  } finally { s.state.release(); s.stop(); }
});
