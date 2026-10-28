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

const BASE = (process.env.CEME_API_URL || 'https://ceme.ocarroeletrico.com').replace(/\/$/, '');
const KEY = process.env.CEME_API_KEY || null;
const TTL_MS = 5 * 60_000;

let session = null; // { token, until }
const cache = new Map(); // key -> { at, value | promise }

async function authHeaders() {
  if (KEY) return { 'x-api-key': KEY };
  if (!session || session.until < Date.now()) {
    const r = await fetch(`${BASE}/v1/session`, { method: 'POST' });
    if (!r.ok) throw new Error(`ceme-v2 session: HTTP ${r.status}`);
    const { token, expires_in } = await r.json();
    session = { token, until: Date.now() + (expires_in - 60) * 1000 };
  }
  return { authorization: `Bearer ${session.token}` };
}

async function call(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(await authHeaders()), ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 401 && !KEY) session = null;
  if (!r.ok) throw new Error(`ceme-v2 ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = fn().catch(e => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

// All tariffs quoted for `kwh` at instant `at`, cheapest first. kWh is rounded
// to 0.1 and `at` to the quarter-hour so nearby requests share a cache entry;
// the quarter-hour is the OMIE pricing unit, so that rounding is exact.
export function simulate({ kwh, at = new Date(), region = 'CONT' }) {
  const k = Math.max(0.1, Math.round(kwh * 10) / 10);
  const q = new Date(Math.floor(at.getTime() / 900_000) * 900_000);
  return cached(`sim|${region}|${k}|${q.toISOString()}`, () => call('/v1/simulate', {
    method: 'POST',
    body: JSON.stringify({ kwh: k, at: q.toISOString(), region, useSpot: true }),
  }));
}

export function tariffs() {
  return cached('tariffs', () => call('/v1/tariffs'));
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
