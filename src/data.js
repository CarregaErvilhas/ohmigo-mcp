// The charger dataset and the geographic searches on it.
//
// "The dataset" is the part of the network that changes slowly: where each
// charger is, its plugs and power, and the operator fees MOBI.E publishes.
// nap-dashboard builds it once a week (scripts/ohmigo_dataset.py over there)
// and publishes it at DEFAULT_URL. Things that change by the minute (is the
// charger free?) are NOT here: live.js reads them from the NAP when asked.
//
// Shape (one JSON file, ~6 MB):
//   { schema, generatedAt, sites: [{ id, code, lat, lon, region, city, address,
//     operator, points: [{ id, kw, connector, dc, phases, level, regime, opc }] }] }
//
// ~9k sites fit in memory easily, and a linear scan per query takes a few
// milliseconds, so there's no spatial index.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_URL = 'https://nap.ocarroeletrico.com/ohmigo/chargers.json';
// The dataset format this code understands. nap-dashboard bumps SCHEMA in
// ohmigo_dataset.py when the format changes incompatibly.
const SCHEMA = 1;

const localFile = () => {
  const p = fileURLToPath(new URL('../data/chargers.json', import.meta.url));
  return existsSync(p) ? p : null;
};

const R_KM = 6371;
const rad = d => d * Math.PI / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

// Distance from p to the polyline, and how far along it (km from the start)
// the closest point is. Uses a local equirectangular projection per segment,
// which is accurate to well under 1 % at Portugal's latitudes and segment sizes.
export function routeDistance(p, route) {
  let best = { km: Infinity, alongKm: 0 };
  let walked = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const kx = Math.cos(rad((a.lat + b.lat) / 2)) * R_KM * Math.PI / 180, ky = R_KM * Math.PI / 180;
    const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky;
    const px = (p.lon - a.lon) * kx, py = (p.lat - a.lat) * ky;
    const len2 = bx * bx + by * by;
    const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const km = Math.hypot(px - t * bx, py - t * by);
    const seg = Math.sqrt(len2);
    if (km < best.km) best = { km, alongKm: walked + t * seg };
    walked += seg;
  }
  return best;
}

const fold = s => (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export class Dataset {
  constructor(raw) {
    this.generatedAt = raw.generatedAt;
    this.sites = raw.sites;
    this.siteById = new Map();
    this.pointById = new Map();
    for (const s of this.sites) {
      this.siteById.set(s.id, s);
      for (const p of s.points) {
        // A point id is only unique within its site ("19" exists on several
        // sites), so the key is "SITE/POINT". The bare id also resolves when
        // it happens to be unique.
        this.pointById.set(`${s.id}/${p.id}`, { site: s, point: p });
        const bare = this.pointById.get(p.id);
        this.pointById.set(p.id, bare === undefined ? { site: s, point: p } : null);
      }
    }
  }

  // "SITE/POINT", or a bare point id when it's unique. null when unknown or
  // ambiguous.
  findPoint(id) {
    return this.pointById.get(id) || null;
  }

  // Where the dataset comes from, in order:
  //   DATASET_PATH  a local file (development)
  //   DATASET_URL   a URL (production; defaults to the Pages copy)
  //   data/chargers.json, if present (development)
  // `etag` makes the request conditional: when the file didn't change, the
  // server answers 304 with no body and this returns null (keep what you have).
  static async load({ etag } = {}) {
    const path = process.env.DATASET_PATH || (process.env.DATASET_URL ? null : localFile());
    if (path) return Dataset.check(JSON.parse(await readFile(path, 'utf8')));
    const url = process.env.DATASET_URL || DEFAULT_URL;
    const res = await fetch(url, { headers: etag ? { 'if-none-match': etag } : {}, signal: AbortSignal.timeout(60_000) });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`dataset ${url}: HTTP ${res.status}`);
    const ds = Dataset.check(await res.json());
    ds.etag = res.headers.get('etag');
    return ds;
  }

  // Refuses a file from a format we don't know, instead of misreading it.
  static check(raw) {
    const schema = raw.schema ?? 1;
    if (schema !== SCHEMA) throw new Error(`dataset schema ${schema}, this server reads ${SCHEMA}`);
    if (!Array.isArray(raw.sites) || !raw.sites.length) throw new Error('dataset has no sites');
    return new Dataset(raw);
  }

  // Centre of the sites in a municipality/city, for "near Leiria" without
  // coordinates. Matches NAP's `city` field, accent- and case-insensitive.
  resolvePlace(name) {
    const q = fold(name);
    let hits = this.sites.filter(s => fold(s.city) === q);
    if (!hits.length) hits = this.sites.filter(s => fold(s.city).includes(q) || fold(s.address).includes(q));
    if (!hits.length) return null;
    const lat = hits.reduce((a, s) => a + s.lat, 0) / hits.length;
    const lon = hits.reduce((a, s) => a + s.lon, 0) / hits.length;
    return { lat, lon, matchedSites: hits.length };
  }

  pointFilter({ minKw, connectors, dcOnly } = {}) {
    const cs = connectors?.length ? new Set(connectors.map(c => c.toUpperCase())) : null;
    return p => (minKw == null || (p.kw ?? 0) >= minKw)
      && (!cs || cs.has(p.connector))
      && (!dcOnly || p.dc);
  }

  // Sites near a point or along a route, nearest first (or in route order),
  // each with only the points that pass the filter.
  search({ near, radiusKm = 5, route, corridorKm = 2, limit = 20, ...filter }) {
    const ok = this.pointFilter(filter);
    const out = [];
    for (const s of this.sites) {
      let dist;
      if (route) {
        const d = routeDistance(s, route);
        if (d.km > corridorKm) continue;
        dist = { offRouteKm: d.km, alongKm: d.alongKm };
      } else {
        const km = haversineKm(near, s);
        if (km > radiusKm) continue;
        dist = { km };
      }
      const points = s.points.filter(ok);
      if (points.length) out.push({ site: s, points, ...dist });
    }
    out.sort(route ? (a, b) => a.alongKm - b.alongKm : (a, b) => a.km - b.km);
    return { total: out.length, results: out.slice(0, limit) };
  }
}
