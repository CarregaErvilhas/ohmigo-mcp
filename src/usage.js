// How each site has been used: nap-dashboard's per-site history
// (scripts/site_history.py there), rebuilt every hour from the AmpereArchive
// and published next to the dataset as data/sites/<xx>.json.gz, 256 files.
// A site's file is the FNV-1a hash of its NAP id, mod 256 (shardOf; the
// site's uso.js and site_history.shard_of hash the same way).
//
// Each socket has buckets [cells, charging, available, down]: cells is how many
// socket-hours had a status read, the other three are hundredths of a cell. So
// charging / cells is already a percentage, and buckets of different sockets
// add up. `w` is the last 4 weeks by local weekday x hour (Monday 0:00 first),
// `d` the last 30 local days. An hour nobody read is no cell at all, never 0 %.
//
// lookup_charger asks for the few sites it shows. A file is fetched on demand,
// turned at once into one small summary per site (the shape siteHistory reads)
// and dropped: the 256 files hold ~90 MB of JSON, the summaries a few MB.
import { gunzipSync } from 'node:zlib';
import { DEFAULT_URL } from './data.js';

const TTL_MS = Number(process.env.SITE_USAGE_TTL_SECONDS || 3600) * 1000;
// A file that failed is not asked for again for a while.
const RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = Number(process.env.SITE_USAGE_TIMEOUT_MS || 4000);
const MAX_BYTES = 3 * 1024 * 1024;   // pages.yml refuses bigger files
const SHARDS = 256;
// Below this many days with a read, the history says nothing (as the dataset's did).
const MIN_DAYS = 7;
// An hour of the weekday x hour profile needs about two days behind it per socket.
const MIN_DAYS_PER_HOUR = 2;

export const defaultUrl = () => process.env.SITE_USAGE_URL
  || new URL('/data/sites/', process.env.DATASET_URL || DEFAULT_URL).href;

// FNV-1a 32 over the UTF-8 bytes, mod 256, two hex digits.
export function shardOf(id) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(String(id), 'utf8')) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % SHARDS).toString(16).padStart(2, '0');
}

const okBucket = b => Array.isArray(b) && b.length === 4 && b.every(v => Number.isFinite(v) && v >= 0) && b[0] > 0;
const pct = (part, cells) => Math.round((part / cells) * 10) / 10;

// One site of a file -> { days, down, busy: { wd, we }, tz }, or undefined.
// days and down cover the same 4 weeks as the profile.
export function summarise(entry, heatDays = 28) {
  const points = Object.values(entry?.p ?? {});
  if (!points.length) return undefined;
  const nd = Math.max(0, ...points.map(p => (Array.isArray(p.d) ? p.d.length : 0)));
  const from = Math.max(0, nd - heatDays);
  let days = 0, cells = 0, down = 0;
  for (let i = from; i < nd; i++) {
    let any = false;
    for (const p of points) {
      const b = p.d?.[i];
      if (!okBucket(b)) continue;
      any = true; cells += b[0]; down += b[3];
    }
    if (any) days++;
  }
  if (days < MIN_DAYS || !cells) return undefined;
  const wd = Array(24).fill(0).map(() => [0, 0]), we = Array(24).fill(0).map(() => [0, 0]);
  let sockets = 0;
  for (const p of points) {
    if (!Array.isArray(p.w)) continue;
    let seen = false;
    p.w.forEach((b, i) => {
      if (i >= 7 * 24 || !okBucket(b)) return;
      seen = true;
      const row = Math.floor(i / 24) < 5 ? wd : we;
      row[i % 24][0] += b[0]; row[i % 24][1] += b[1];
    });
    if (seen) sockets++;
  }
  const row = r => r.map(([n, c]) => (n > 0 && n >= MIN_DAYS_PER_HOUR * sockets ? pct(c, n) : null));
  const busy = sockets ? { wd: row(wd), we: row(we) } : undefined;
  return {
    days, down: pct(down, cells),
    ...(busy && (busy.wd.some(v => v != null) || busy.we.some(v => v != null)) && { busy }),
    ...(typeof entry.tz === 'string' && { tz: entry.tz }),
  };
}

export class SiteUsage {
  constructor({ baseUrl = defaultUrl(), fetchImpl = fetch, ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.shards = new Map();   // xx -> { until, sites: Map(id -> summary) } | { until, failed: true }
    this.pending = new Map();  // xx -> Promise
  }

  async loadShard(xx) {
    const res = await this.fetch(new URL(`${xx}.json.gz`, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`site usage ${xx}: HTTP ${res.status}`);
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > MAX_BYTES) throw new Error(`site usage ${xx}: too large`);
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    // GitHub Pages serves .json.gz as a gzip file, not as gzip-encoded JSON.
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: 64 * MAX_BYTES }) : buf;
    const obj = JSON.parse(raw.toString('utf8'));
    if (obj?.v !== 1 || typeof obj.sites !== 'object' || obj.sites === null) throw new Error(`site usage ${xx}: unexpected shape`);
    const heatDays = Number.isInteger(obj.heat?.days) && obj.heat.days > 0 ? obj.heat.days : 28;
    const sites = new Map();
    for (const [id, entry] of Object.entries(obj.sites)) {
      const s = summarise(entry, heatDays);
      if (s) sites.set(id, s);
    }
    return { until: Date.now() + this.ttlMs, sites, generatedAt: obj.generatedAt };
  }

  shard(xx) {
    const have = this.shards.get(xx);
    if (have && Date.now() < have.until) return Promise.resolve(have);
    if (this.pending.has(xx)) return this.pending.get(xx);
    const p = this.loadShard(xx)
      .catch(e => {
        console.warn(`[ohmigo] ${e.message}`);
        // A copy past its TTL still answers until a new one comes in.
        return have && !have.failed ? { ...have, until: Date.now() + RETRY_MS } : { until: Date.now() + RETRY_MS, failed: true };
      })
      .then(s => { this.shards.set(xx, s); this.pending.delete(xx); return s; });
    this.pending.set(xx, p);
    return p;
  }

  // Map(siteId -> summary) for the ids asked; a site whose file failed, or
  // the file lacks, is just not in it.
  async get(ids) {
    const out = new Map();
    const want = [...new Set(ids)];
    const shards = await Promise.all([...new Set(want.map(shardOf))].map(xx => this.shard(xx).then(s => [xx, s])));
    const by = new Map(shards);
    for (const id of want) {
      const s = by.get(shardOf(id))?.sites?.get(id);
      if (s) out.set(id, s);
    }
    return out;
  }
}
