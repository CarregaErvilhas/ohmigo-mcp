// How the ceme-v2 client behaves under load: a spent quota isn't an outage, the
// calls wait in a small line, and the cache can't grow without bound. A stub
// fetch stands in for ceme-v2, so nothing leaves the machine.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.CEME_API_URL = 'http://ceme.test';
process.env.CEME_API_KEY = 'k';

// ceme.js keeps its breaker and cache in the module: each test gets a new copy.
let copies = 0;
const fresh = () => import(`../src/ceme.js?copy=${++copies}`);

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const SIM = { at: 'x', data: [{ id: 'a' }] };
const tooMany = headers => new Response('quota', { status: 429, headers });
const stub = fn => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body && JSON.parse(init.body) }); return fn(calls.length, init); };
  return calls;
};
const at = i => new Date(Date.UTC(2026, 10, 10, 12, 0) + i * 900_000);
const NOW = Date.UTC(2026, 10, 10, 12, 0);

afterEach(() => mock.timers.reset());

test('a 429 with Retry-After does not count toward the breaker', async () => {
  const { simulate, cemeHealth } = await fresh();
  const calls = stub(() => tooMany({ 'retry-after': '7' }));
  const before = Date.now();
  for (let i = 0; i < 6; i++) await assert.rejects(simulate({ kwh: 10, at: at(i) }), e => e.ceme === true);
  const h = cemeHealth();
  assert.equal(h.failures, 0);
  assert.equal(h.openUntil, null);
  assert.ok(Date.parse(h.rateLimitedUntil) >= before + 7000 - 50);
  assert.equal(calls.length, 1, 'waits for Retry-After instead of asking again');
});

test('calls resume once Retry-After has passed', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const { simulate, cemeHealth } = await fresh();
  let limited = true;
  const calls = stub(() => limited ? tooMany({ 'retry-after': '7' }) : json(SIM));
  await assert.rejects(simulate({ kwh: 10, at: at(0) }));
  limited = false;
  mock.timers.tick(6000);
  await assert.rejects(simulate({ kwh: 10, at: at(0) }));
  assert.equal(calls.length, 1);
  mock.timers.tick(1100);
  assert.deepEqual(await simulate({ kwh: 10, at: at(0) }), SIM);
  assert.equal(calls.length, 2);
  assert.equal(cemeHealth().rateLimitedUntil, null);
});

test('Retry-After is bounded, and reads either form', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const until = async header => {
    const { simulate, cemeHealth } = await fresh();
    stub(() => tooMany(header === null ? {} : { 'retry-after': header }));
    await assert.rejects(simulate({ kwh: 10 }));
    return Date.parse(cemeHealth().rateLimitedUntil) - NOW;
  };
  const { RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS, RETRY_AFTER_DEFAULT_MS } = await fresh();
  assert.equal(await until('86400'), RETRY_AFTER_MAX_MS, 'one bad header must not turn CEME prices off for a day');
  assert.equal(await until('0'), RETRY_AFTER_MIN_MS);
  assert.equal(await until('-5'), RETRY_AFTER_MIN_MS);
  assert.equal(await until(null), RETRY_AFTER_DEFAULT_MS);
  assert.equal(await until('soon'), RETRY_AFTER_DEFAULT_MS);
  assert.equal(await until(new Date(NOW + 20_000).toUTCString()), 20_000);
});

test('an anonymous session that hits 429 is not an outage either', async () => {
  const key = process.env.CEME_API_KEY;
  delete process.env.CEME_API_KEY;
  const { simulate, cemeHealth } = await fresh();
  process.env.CEME_API_KEY = key;
  const calls = stub(() => tooMany({ 'retry-after': '7' }));
  for (let i = 0; i < 4; i++) await assert.rejects(simulate({ kwh: 10, at: at(i) }), e => e.ceme === true);
  assert.equal(calls.length, 1);
  assert.equal(cemeHealth().failures, 0);
  assert.equal(cemeHealth().openUntil, null);
});

test('on a 429 the last good answer for that key is served, marked', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const { simulate, tariffs, TTL_MS } = await fresh();
  let limited = false;
  const calls = stub(() => limited ? tooMany({ 'retry-after': '30' }) : json(SIM));
  await simulate({ kwh: 10, at: at(0) });
  mock.timers.tick(TTL_MS + 1000);
  limited = true;
  const served = await simulate({ kwh: 10, at: at(0) });
  assert.deepEqual(served.data, SIM.data);
  assert.equal(served.staleSince, NOW, 'quote.js has to be able to say how old it is');
  assert.equal(calls.length, 2);
  // Inside the Retry-After window it doesn't ask at all, and still answers.
  assert.deepEqual((await simulate({ kwh: 10, at: at(0) })).data, SIM.data);
  assert.equal(calls.length, 2);
  // Nothing good for another key: that one fails.
  await assert.rejects(simulate({ kwh: 11, at: at(0) }), e => e.ceme === true);
  // Other cached calls get the same treatment.
  await assert.rejects(tariffs(), e => e.ceme === true);
});

test('the last good answer stops being served once it is too old', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const { simulate, STALE_MS } = await fresh();
  let limited = false;
  stub(() => limited ? tooMany({ 'retry-after': '30' }) : json(SIM));
  await simulate({ kwh: 10, at: at(0) });
  mock.timers.tick(STALE_MS + 1000);
  limited = true;
  await assert.rejects(simulate({ kwh: 10, at: at(0) }), e => e.ceme === true);
});

test('5xx and timeouts still open the breaker, and are not answered from the old copy', async () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const { simulate, cemeHealth, TTL_MS } = await fresh();
  let down = false;
  const calls = stub(() => { if (down) return new Response('oops', { status: 503 }); return json(SIM); });
  await simulate({ kwh: 10, at: at(0) });
  mock.timers.tick(TTL_MS + 1000);
  down = true;
  for (let i = 0; i < 3; i++) await assert.rejects(simulate({ kwh: 10, at: at(0) }), e => e.ceme === true);
  assert.ok(cemeHealth().openUntil, 'three failures in a row open it');
  const n = calls.length;
  await assert.rejects(simulate({ kwh: 10, at: at(0) }));
  assert.equal(calls.length, n, 'open: no more calls');
});

test('a thrown fetch (timeout) still counts toward the breaker', async () => {
  const { simulate, cemeHealth } = await fresh();
  stub(() => { throw new DOMException('timed out', 'TimeoutError'); });
  for (let i = 0; i < 3; i++) await assert.rejects(simulate({ kwh: 10, at: at(i) }), e => e.ceme === true);
  assert.ok(cemeHealth().openUntil);
});

// A stub whose answers the test releases by hand.
function gated() {
  const waiting = [];
  let active = 0, peak = 0;
  const calls = stub(async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => waiting.push(resolve));
    active--;
    return json(SIM);
  });
  return { calls, peak: () => peak, release: () => waiting.shift()?.(), waiting };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('concurrency never exceeds the limit, and the line is first come first served', async () => {
  const { simulate, MAX_CONCURRENT, MAX_QUEUED } = await fresh();
  const g = gated();
  const total = MAX_CONCURRENT + Math.min(MAX_QUEUED, 10);
  const all = Array.from({ length: total }, (_, i) => simulate({ kwh: i + 1, at: at(0) }));
  await settle();
  assert.equal(g.calls.length, MAX_CONCURRENT);
  while (g.waiting.length) { g.release(); await settle(); await settle(); }
  await Promise.all(all);
  assert.equal(g.peak(), MAX_CONCURRENT);
  assert.deepEqual(g.calls.map(c => c.body.kwh), Array.from({ length: total }, (_, i) => i + 1));
});

test('past the queue a call fails as unavailable, and the breaker stays out of it', async () => {
  const { simulate, cemeHealth, MAX_CONCURRENT, MAX_QUEUED } = await fresh();
  const g = gated();
  const room = MAX_CONCURRENT + MAX_QUEUED;
  const accepted = Array.from({ length: room }, (_, i) => simulate({ kwh: i + 1, at: at(0) }));
  await settle();
  for (let i = 0; i < 5; i++) await assert.rejects(simulate({ kwh: 1000 + i, at: at(0) }), e => e.ceme === true);
  assert.equal(cemeHealth().failures, 0);
  assert.equal(cemeHealth().openUntil, null);
  while (g.waiting.length) { g.release(); await settle(); await settle(); }
  await Promise.all(accepted); // the ones in line were not disturbed
  assert.equal(g.calls.length, room);
});

test('a call that waited in line checks the breaker before it goes out', async () => {
  const { simulate, MAX_CONCURRENT } = await fresh();
  const calls = [];
  let fail;
  globalThis.fetch = (url, init) => { calls.push(init.body); return new Promise((_, reject) => { fail = [...(fail ?? []), reject]; }); };
  const first = Array.from({ length: MAX_CONCURRENT }, (_, i) => simulate({ kwh: i + 1, at: at(0) }).catch(e => e));
  const queued = simulate({ kwh: 99, at: at(0) }).catch(e => e);
  await settle();
  for (const reject of fail) reject(new Error('boom'));
  await Promise.all(first);
  assert.equal((await queued).ceme, true);
  assert.equal(calls.length, MAX_CONCURRENT);
});

test('the cache is capped by total bytes, oldest out first', async () => {
  const { simulate, cemeHealth, MAX_CACHE_BYTES } = await fresh();
  const reply = JSON.stringify({ at: 'x', data: [], pad: 'x'.repeat(1024 * 1024) });
  const calls = stub(() => new Response(reply));
  const n = Math.ceil(MAX_CACHE_BYTES / reply.length) + 5;
  for (let i = 0; i < n; i++) await simulate({ kwh: i + 1, at: at(0) });
  const { bytes, entries } = cemeHealth().cache;
  assert.ok(bytes <= MAX_CACHE_BYTES, `${bytes} bytes kept`);
  assert.ok(entries < n);
  assert.ok(bytes > MAX_CACHE_BYTES / 2, 'evicts what it must, not everything');
  const after = calls.length;
  await simulate({ kwh: n, at: at(0) }); // newest: still there
  assert.equal(calls.length, after);
  await simulate({ kwh: 1, at: at(0) }); // oldest: gone
  assert.equal(calls.length, after + 1);
});

test('a reply larger than the whole cache is answered, not kept', async () => {
  const { simulate, cemeHealth, MAX_CACHE_BYTES } = await fresh();
  stub(() => new Response(JSON.stringify({ at: 'x', data: [], pad: 'x'.repeat(MAX_CACHE_BYTES + 1) })));
  assert.equal((await simulate({ kwh: 10, at: at(0) })).at, 'x');
  assert.equal(cemeHealth().cache.bytes, 0);
});

const slices = (kwh, n = 1, from = '2026-11-10T12:07:00.000Z') => Array.from({ length: n }, (_, i) => ({ at: new Date(Date.parse(from) + i * 900_000).toISOString(), kwh }));

test('detail replies past the small limit are not kept', async () => {
  const { simulate, MAX_DETAIL_CACHE_BYTES } = await fresh();
  const big = JSON.stringify({ at: 'x', data: [], pad: 'x'.repeat(MAX_DETAIL_CACHE_BYTES) });
  const calls = stub(() => new Response(big));
  await simulate({ kwh: 10, profile: slices(10), detail: true });
  await simulate({ kwh: 10, profile: slices(10), detail: true });
  assert.equal(calls.length, 2);
  // The same size without detail is kept.
  await simulate({ kwh: 10, profile: slices(10) });
  await simulate({ kwh: 10, profile: slices(10) });
  assert.equal(calls.length, 3);
});

test('small detail replies are kept, apart from the ones without detail', async () => {
  const { simulate } = await fresh();
  const calls = stub(() => json(SIM));
  await simulate({ kwh: 10, profile: slices(10), detail: true });
  await simulate({ kwh: 10, profile: slices(10), detail: true });
  assert.equal(calls.length, 1);
  await simulate({ kwh: 10, profile: slices(10) });
  assert.equal(calls.length, 2);
});

test('concurrent identical calls still share one request, even a detail too big to keep', async () => {
  const { simulate, MAX_DETAIL_CACHE_BYTES } = await fresh();
  const big = JSON.stringify({ at: 'x', data: [], pad: 'x'.repeat(MAX_DETAIL_CACHE_BYTES) });
  const calls = stub(() => new Response(big));
  await Promise.all([1, 2, 3].map(() => simulate({ kwh: 10, profile: slices(10), detail: true })));
  assert.equal(calls.length, 1);
});

test('long keys are hashed: the cache holds a digest, and different sessions stay different', async () => {
  const { simulate, cemeHealth } = await fresh();
  const calls = stub(() => json(SIM));
  const long = slices(1.25, 288);
  const other = long.map((s, i) => i === 287 ? { ...s, kwh: 1.26 } : s);
  await simulate({ kwh: 360, profile: long });
  await simulate({ kwh: 360, profile: long });
  assert.equal(calls.length, 1);
  await simulate({ kwh: 360, profile: other });
  assert.equal(calls.length, 2);
  const perEntry = cemeHealth().cache.bytes / cemeHealth().cache.entries;
  assert.ok(perEntry < JSON.stringify(SIM).length + 200, `${perEntry} bytes per entry: the key is not in there whole`);
});

test('one-slice sessions inside a quarter-hour share an entry; the slices are sent as they are', async () => {
  const { simulate } = await fresh();
  const calls = stub(() => json(SIM));
  await simulate({ kwh: 5, profile: [{ at: '2026-11-10T12:07:00.000Z', kwh: 5 }] });
  await simulate({ kwh: 5, profile: [{ at: '2026-11-10T12:11:00.000Z', kwh: 5 }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.profile[0].at, '2026-11-10T12:07:00.000Z', 'never rewritten on the way out');
});

test('what could price differently never shares an entry', async () => {
  const { simulate } = await fresh();
  const calls = stub(() => json(SIM));
  const one = (at, kwh) => simulate({ kwh, profile: [{ at, kwh }] });
  await one('2026-11-10T12:07:00.000Z', 5);
  await one('2026-11-10T12:16:00.000Z', 5); // next quarter-hour: another OMIE price
  assert.equal(calls.length, 2);
  await one('2026-11-10T12:07:00.000Z', 5.0001); // any other kWh is another total
  assert.equal(calls.length, 3);
  await simulate({ kwh: 5, region: 'MAD', profile: [{ at: '2026-11-10T12:07:00.000Z', kwh: 5 }] });
  assert.equal(calls.length, 4);
  await simulate({ kwh: 5, monthKwh: { a: 1 }, profile: [{ at: '2026-11-10T12:07:00.000Z', kwh: 5 }] });
  assert.equal(calls.length, 5);
  // Later slices are on quarter boundaries already and stay exact.
  await simulate({ kwh: 10, profile: [{ at: '2026-11-10T12:07:00.000Z', kwh: 5 }, { at: '2026-11-10T12:15:00.000Z', kwh: 5 }] });
  await simulate({ kwh: 10, profile: [{ at: '2026-11-10T12:07:00.000Z', kwh: 5 }, { at: '2026-11-10T12:30:00.000Z', kwh: 5 }] });
  assert.equal(calls.length, 7);
});

test('tariffs still lists when promos fail: every cached call returns a promise', async () => {
  const { promos, tariffs } = await fresh();
  stub(() => json({ data: [] }));
  await tariffs();
  await assert.doesNotReject(tariffs().catch(() => null));
  await assert.doesNotReject(promos().catch(() => null));
  assert.equal(typeof tariffs().catch, 'function', 'a cache hit too');
});
