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
const { MAX_RANKINGS, MAX_RANKINGS_QUEUED, MAX_SIMS_PER_CALL, RANK_CHUNK, rank } = await import('../src/quote.js');
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

test('a ranking stops at the cap of distinct ceme-v2 calls and says where', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return answer(b); };
  const n = MAX_SIMS_PER_CALL + 25;
  const ranked = await rank(speeds(n), car, { at: when(), lang: 'en' });
  assert.equal(bodies.length, MAX_SIMS_PER_CALL);
  assert.equal(ranked.sitesPriced, MAX_SIMS_PER_CALL);
  assert.equal(ranked.length, MAX_SIMS_PER_CALL);
  assert.deepEqual([...new Set(ranked.map(q => q.siteId))].sort(), speeds(MAX_SIMS_PER_CALL).map(c => c.site.id).sort(), 'the nearest ones');
  assert.ok(ranked.every(q => q.total), 'what it did price, it priced in full');
});

test('sockets at a speed already asked for cost nothing, so nothing is cut', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return answer(b); };
  const n = MAX_SIMS_PER_CALL * 3;
  const ranked = await rank(Array.from({ length: n }, (_, i) => site(i, [point(`P${i}`, 7.4)])), car, { at: when(), lang: 'en' });
  assert.equal(bodies.length, 1);
  assert.equal(ranked.sitesPriced, n);
  assert.equal(ranked.length, n);
});

test('a site cut part-way is left out whole: its cheapest socket may be the one not priced', async () => {
  globalThis.fetch = async (url, init) => answer(JSON.parse(init.body));
  const list = speeds(MAX_SIMS_PER_CALL);
  list.push(site(MAX_SIMS_PER_CALL, [point('same', 3), point('new', 40)]));
  const ranked = await rank(list, car, { at: when(), lang: 'en' });
  assert.equal(ranked.sitesPriced, MAX_SIMS_PER_CALL);
  assert.ok(!ranked.some(q => q.siteId === `S-${MAX_SIMS_PER_CALL}`));
});

test('the first site is never cut, so a ranking always has something to show', async () => {
  globalThis.fetch = async (url, init) => answer(JSON.parse(init.body));
  const points = Array.from({ length: MAX_SIMS_PER_CALL + 3 }, (_, i) => point(`P${i}`, 3 + i * 0.1));
  const ranked = await rank([site(0, points), site(1, [point('next', 2)])], car, { at: when(), lang: 'en' });
  assert.equal(ranked.sitesPriced, 1);
  assert.equal(ranked.length, 1);
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
  const waiting = [];
  let started = 0;
  globalThis.fetch = async (url, init) => { started++; await new Promise(r => waiting.push(r)); return answer(JSON.parse(init.body)); };
  const tick = () => new Promise(r => setImmediate(r));
  const order = [];
  const room = MAX_RANKINGS + MAX_RANKINGS_QUEUED;
  // A different speed each, so no two share a ceme-v2 call.
  const all = Array.from({ length: room }, (_, i) => rank([site(i, [point(`P${i}`, 3 + i)])], car, { at: when(), lang: 'en' }).then(() => order.push(i)));
  await tick(); await tick();
  assert.equal(started, MAX_RANKINGS);
  await assert.rejects(rank(speeds(1), car, { at: when(), lang: 'en' }), e => e.busy === true);
  while (order.length < room) { waiting.shift()?.(); await tick(); await tick(); await tick(); }
  await Promise.all(all);
  assert.deepEqual(order, Array.from({ length: room }, (_, i) => i), 'first come, first served');
});

test('a ranking that fails gives its place back', async () => {
  globalThis.fetch = async (url, init) => answer(JSON.parse(init.body));
  const broken = { get: () => { throw new Error('boom'); } };
  for (let i = 0; i < MAX_RANKINGS + 2; i++) await assert.rejects(rank(speeds(1), car, { at: when(), lang: 'en', live: broken }), /boom/);
  assert.equal((await rank(speeds(1), car, { at: when(), lang: 'en' })).length, 1);
});

test('a price served from the last good answer says so, with its age', async () => {
  const seven = Date.now() - 7 * 60_000;
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); return new Response(JSON.stringify({ ...REPLY(b), staleSince: seven }), { status: 200 }); };
  for (const lang of ['en', 'pt']) {
    const [q] = await rank(speeds(1), car, { at: when(), lang });
    assert.ok(q.assumptions.includes(translator(lang)('assume.cemeStale', { minutes: 7 })), q.assumptions.join(' | '));
  }
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
  const call = async (args, id = 1) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
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
    assert.ok(d.notes.includes(translator('pt')('note.truncated', { n: MAX_SIMS_PER_CALL, total: MAX_SIMS_PER_CALL + 10 })));
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
