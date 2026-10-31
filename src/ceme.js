// Client for the ceme-v2 API (https://ceme.ocarroeletrico.com/api).
//
// ceme-v2 is a sibling project that prices the ENERGY part of a MOBI.E
// session for every CEME tariff: the tariff's price per kWh (with the grid fee,
// TAR), the electricity tax (IEC), the per-session activation fee (EGME) and
// VAT. For "indexed" tariffs that follow the wholesale market (OMIE), it uses
// the market price of the exact quarter-hour of the charge. That's a lot of
// fiddly rules (time zones, daylight saving, island VAT), so we never redo
// them here: one POST /v1/simulate returns every tariff, cheapest first.
//
// Auth: X-API-Key (CEME_API_KEY) in production. Without a key we fall back to
// an anonymous web session, which is rate-limited per IP: fine for local dev,
// not for a shared server.

import { createHash } from 'node:crypto';
import { limiter } from './limit.js';
import { QUARTER_MS } from './profile.js';

const BASE = (process.env.CEME_API_URL || 'https://ceme.ocarroeletrico.com').replace(/\/$/, '');
const KEY = process.env.CEME_API_KEY || null;
export const TTL_MS = 5 * 60_000;

let session = null; // { token, until }
let authing = null; // the session request in flight, shared by concurrent calls

// The cache. An entry stays past TTL_MS as the last good answer for its key:
// a call then asks ceme-v2 again, and only falls back on it after a 429.
//   key -> { at, value, bytes, pending }: `value` the last good reply (from
//   `at`, `bytes` of JSON), `pending` the request in flight, shared by whoever
//   asks meanwhile.
// A reply to /v1/simulate carries every tariff. The limits below are on its
// JSON; parsed, it takes a few times that in memory.
const MAX_CACHE_ENTRIES = 500;
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
// With `detail` a reply repeats every quarter-hour for every tariff: a long
// slow session can reach megabytes, and only someone asking how a price was
// built wants it, so a repeat is unlikely. A short session's is worth keeping.
export const MAX_DETAIL_CACHE_BYTES = 256 * 1024;
// A session's key lists its slices, up to ~10 KB for the longest one. Past this
// the key is a digest, so it costs the cache a few bytes.
const MAX_KEY_CHARS = 200;
// How old a last good answer can be and still stand in during a 429. The key
// fixes the session and the quarter-hours, so only a tariff or promotion edited
// in that hour, or OMIE prices published since, can make it wrong; the result
// says how old it is (assume.cemeStale in quote.js).
export const STALE_MS = 60 * 60_000;
const cache = new Map();
let cacheBytes = 0;

// A spent quota (HTTP 429) isn't an outage: ceme-v2 is fine, and the breaker
// would turn CEME prices off for everyone over a limit that clears by itself.
// So a 429 stays out of the breaker. No call goes out until Retry-After has
// passed, and it's bounded: at least a moment, so a burst doesn't keep hitting
// the limit, and at most two minutes, so one odd header can't switch prices off
// for a day. Without a usable header, half of a per-minute window.
export const RETRY_AFTER_MIN_MS = 1000;
export const RETRY_AFTER_MAX_MS = 120_000;
export const RETRY_AFTER_DEFAULT_MS = 30_000;
let quotaUntil = 0;

// How many calls go to ceme-v2 at once, across every user of this process. All
// of them share one API key and its requests per minute, so this smooths a
// burst into that limit. 6 lets a ranking finish its usual 20-30 calls in a few
// round trips.
export const MAX_CONCURRENT = 6;
// What one ranking may spend, and how many run at once per process (quote.js
// enforces both). A ranking asks once per distinct charging speed: 20-32 near
// Lisbon or Porto on the real dataset, depending on the car. 40 leaves those
// alone and stops a search over every speed there is (72 nationwide).
export const MAX_SIMS_PER_CALL = 40;
export const MAX_RANKINGS = 3;
// How many wait for a place: every call the rankings running at once can make,
// so they never shed each other's calls, plus room for the single estimates
// that arrive during a burst of them.
const ROOM_FOR_ESTIMATES = 20;
export const MAX_QUEUED = MAX_RANKINGS * MAX_SIMS_PER_CALL + ROOM_FOR_ESTIMATES;

// Circuit breaker: after BREAKER_FAILURES failures in a row, calls fail at
// once for BREAKER_MS instead of each waiting up to 10 s for an answer that
// isn't coming (and piling retries on a ceme-v2 that's already struggling).
// One success closes it.
const BREAKER_FAILURES = 3;
const BREAKER_MS = 45_000;
const breaker = { failures: 0, until: 0 };
const inFuture = t => (t > Date.now() ? new Date(t).toISOString() : null);
export const cemeHealth = () => ({
  failures: breaker.failures, openUntil: inFuture(breaker.until), rateLimitedUntil: inFuture(quotaUntil),
  cache: { entries: cache.size, bytes: cacheBytes },
});

// Every error from here is tagged, so the tools can answer without the
// energy price instead of failing the whole call.
const unavailable = (msg, cause) => Object.assign(new Error(msg, { cause }), { ceme: true });
// `refused`: the call never reached ceme-v2 because this server held it back,
// so the tools mustn't say the pricing service didn't answer.
const refused = (msg, extra) => Object.assign(unavailable(msg), { refused: true }, extra);
const rateLimited = path => refused(`ceme-v2 ${path}: rate limited`, { rateLimited: true });
const gate = limiter({
  concurrent: MAX_CONCURRENT, queued: MAX_QUEUED,
  full: () => refused('ceme-v2: too many calls waiting'),
  gone: () => refused('ceme-v2: the request was abandoned'),
});

// Retry-After is seconds or an HTTP date.
function retryAfterMs(header) {
  const text = header?.trim();
  if (!text) return RETRY_AFTER_DEFAULT_MS;
  const ms = /^-?\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - Date.now();
  if (Number.isNaN(ms)) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

// Replies racing the first 429 can bring their own: the latest wait wins.
function hitQuota(r, path) {
  quotaUntil = Math.max(quotaUntil, Date.now() + retryAfterMs(r.headers.get('retry-after')));
  r.body?.cancel().catch(() => {});
  return rateLimited(path);
}

function authHeaders() {
  if (KEY) return { 'x-api-key': KEY };
  if (session && session.until >= Date.now()) return { authorization: `Bearer ${session.token}` };
  authing ??= fetch(`${BASE}/v1/session`, { method: 'POST', signal: AbortSignal.timeout(10_000) })
    .then(async r => {
      if (r.status === 429) throw hitQuota(r, '/v1/session');
      if (!r.ok) throw new Error(`ceme-v2 session: HTTP ${r.status}`);
      const { token, expires_in } = await r.json();
      session = { token, until: Date.now() + (expires_in - 60) * 1000 };
      return { authorization: `Bearer ${token}` };
    })
    .finally(() => { authing = null; });
  return authing;
}

function refuseIfOff(path) {
  if (Date.now() < breaker.until) throw unavailable(`ceme-v2 ${path}: temporarily unavailable`);
  if (Date.now() < quotaUntil) throw rateLimited(path);
}

// Checked again after the wait: the breaker may have opened, or the quota run
// out, while this call stood in line. -> { data, bytes }
async function call(path, init = {}, signal) {
  refuseIfOff(path);
  return gate(() => { refuseIfOff(path); return attempt(path, init); }, signal);
}

async function attempt(path, init) {
  try {
    let r = await send(path, init);
    // An expired anonymous session: get a new one and try once more (the
    // body is a string, so it can be sent again).
    if (r.status === 401 && !KEY) { session = null; r = await send(path, init); }
    if (r.status === 401 && !KEY) session = null;
    if (r.status === 429) throw hitQuota(r, path);
    // A 4xx is our request's fault, not ceme-v2 being down: it answered.
    const down = r.status >= 500;
    if (!down) breaker.failures = 0;
    if (!r.ok) throw Object.assign(new Error(`ceme-v2 ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`), { answered: !down });
    const text = await r.text();
    return { data: JSON.parse(text), bytes: Buffer.byteLength(text) };
  } catch (e) {
    if (e.rateLimited) throw e;
    if (!e.answered && ++breaker.failures >= BREAKER_FAILURES) breaker.until = Date.now() + BREAKER_MS;
    throw unavailable(e.message, e);
  }
}

async function send(path, init) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(await authHeaders()), ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
}

function forget(key) {
  const entry = cache.get(key);
  if (!entry) return;
  cacheBytes -= entry.bytes;
  cache.delete(key);
}

// Oldest first: a refreshed entry goes back to the end (see cached).
function evict() {
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) forget(cache.keys().next().value);
}

// A copy of the last good answer that says so. A reply can be a bare list, which
// keeps it as a property: JSON won't show it, whoever reads the list will.
const stale = ({ value, at }) => Object.assign(Array.isArray(value) ? [...value] : { ...value }, { staleSince: at });

const cacheKey = key => (key.length > MAX_KEY_CHARS ? `#${createHash('sha256').update(key).digest('base64url')}` : key);
const isFresh = entry => Date.now() - entry.at < TTL_MS;

function cached(fullKey, fn, { maxBytes = MAX_CACHE_BYTES } = {}) {
  const key = cacheKey(fullKey);
  const hit = cache.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && isFresh(hit)) return Promise.resolve(hit.value);
  const entry = hit ?? { at: 0, value: undefined, bytes: 0, pending: null };
  entry.pending = fn().then(({ data, bytes }) => {
    forget(key);
    const size = bytes + key.length;
    if (size <= maxBytes) {
      cache.set(key, Object.assign(entry, { at: Date.now(), value: data, bytes: size, pending: null }));
      cacheBytes += size;
      evict();
    }
    return data;
  }, e => {
    entry.pending = null;
    if (entry.value === undefined) { if (cache.get(key) === entry) cache.delete(key); throw e; }
    if (e.rateLimited && Date.now() - entry.at < STALE_MS) return stale(entry);
    throw e;
  });
  if (!hit) { cache.set(key, entry); evict(); }
  return entry.pending;
}

// All tariffs quoted for a session, cheapest first.
//
// With `profile` (the session cut into quarter-hour slices, see profile.js),
// ceme-v2 prices every slice at its own off-peak/peak period, OMIE quarter,
// losses and TAR day. We still send `kwh` and `at` (the sum and the start):
// a ceme-v2 that doesn't know `profile` yet ignores it and prices the whole
// session at the start, and the reply then has no `profile` field, which
// quote.js turns into an assumption.
//
// Without a profile, kWh is rounded to 0.1 and `at` to the quarter-hour so
// nearby requests share a cache entry (the quarter-hour is the OMIE unit).
// With one, the key is the profile itself: points with the same power and
// start share it, so a ranking needs one call per distinct charging speed.
// The slices go out exactly as they came, and the key is exact: kWh or start,
// anything else could be another total. So a session spanning quarter-hours
// that starts a minute later is a new entry and a new call.
//   detail: ask for each tariff's per-slice breakdown (period, price, OMIE).
//   monthKwh: what the user already charged this month per tariff, for
//   free-kWh promotions (see expandMonthKwh). Part of the cache key.
function simRequest({ kwh, at = new Date(), region = 'CONT', profile = null, detail = false, monthKwh = null }) {
  const mk = monthKwh && Object.keys(monthKwh).length ? monthKwh : null;
  const mkKey = mk ? JSON.stringify(Object.entries(mk).sort()) : '';
  if (profile?.length) {
    const slices = profile.map(({ at, kwh }) => ({ at, kwh }));
    const sum = slices.reduce((a, x) => a + x.kwh, 0);
    return {
      key: `simp|${region}|${detail ? 1 : 0}|${mkKey}|${slices.map(x => `${x.at}=${x.kwh}`).join(',')}`,
      body: { kwh: Math.round(sum * 1000) / 1000, at: slices[0].at, region, useSpot: true, profile: slices, detail, ...(mk && { monthKwh: mk }) },
      maxBytes: detail ? MAX_DETAIL_CACHE_BYTES : MAX_CACHE_BYTES,
    };
  }
  const k = Math.max(0.1, Math.round(kwh * 10) / 10);
  const q = new Date(Math.floor(at.getTime() / QUARTER_MS) * QUARTER_MS).toISOString();
  return { key: `sim|${region}|${mkKey}|${k}|${q}`, body: { kwh: k, at: q, region, useSpot: true, ...(mk && { monthKwh: mk }) } };
}

// `signal`: a call still in line when the request is abandoned never goes out.
export function simulate(args) {
  const { key, body, maxBytes } = simRequest(args);
  return cached(key, () => call('/v1/simulate', { method: 'POST', body: JSON.stringify(body) }, args.signal), { maxBytes });
}

// Would simulate() answer without a new call to ceme-v2? (a ranking's cap only
// counts the calls that really go out)
export function isCovered(args) {
  const hit = cache.get(cacheKey(simRequest(args).key));
  return !!hit && (!!hit.pending || isFresh(hit));
}

// The assistant says how much the user charged this month with each of their
// tariffs, by the tariff_id list_ceme_tariffs gave it: one voltage variant
// ("goldenergy-bt-clientesgold"). A charger may use the other one (MT), so
// every variant of the same tariff gets the same count. `key` is quote.js's
// tariffKey, passed in to keep this module free of quote.js.
export async function expandMonthKwh(monthKwh, key) {
  if (!monthKwh || !Object.keys(monthKwh).length) return null;
  const all = await tariffs();
  const want = new Map(Object.entries(monthKwh).map(([id, kwh]) => [key(id), kwh]));
  const out = {};
  for (const t of all.data ?? all) if (want.has(key(t.id))) out[t.id] = want.get(key(t.id));
  return Object.keys(out).length ? out : null;
}

export function tariffs() {
  return cached('tariffs', () => call('/v1/tariffs'));
}

// CEME promotions that haven't ended yet (each with `active` = already on).
// The cost tools get them per tariff from simulate; this is for listing.
export function promos() {
  return cached('promos', () => call('/v1/promos'));
}

// MOBI.E voltage level of the socket -> the CEME tariff variant that applies.
export const tariffVoltage = level => (level === 'MT' ? 'MT' : 'BT');

// Tariffs that can be used at this point. AC_DC_FLAT tariffs (Atlante's "(AC)"
// ones) only price AC sockets; on DC the CEME bundles the OPC fee into another
// price that ceme-v2 doesn't model.
export function applicable(quotes, { level, dc }) {
  const v = tariffVoltage(level);
  return quotes.filter(t => t.voltage === v && !(dc && t.notes === 'AC_DC_FLAT'));
}
