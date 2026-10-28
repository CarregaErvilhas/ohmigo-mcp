// The charger dataset (built by scripts/build_dataset.py from the NAP and
// MOBI.E files) and the geographic queries on it. ~9k sites fit in memory and
// a linear scan per query is a few milliseconds, so there's no spatial index.

import { readFile } from 'node:fs/promises';

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
    this.statusSnapshot = raw.statusSnapshot;
    this.sites = raw.sites;
    this.siteById = new Map();
    this.pointById = new Map();
    for (const s of this.sites) {
      this.siteById.set(s.id, s);
      for (const p of s.points) this.pointById.set(p.id, { site: s, point: p });
    }
  }

  static async load() {
    const url = process.env.DATASET_URL;
    const raw = url
      ? await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).json()
      : JSON.parse(await readFile(process.env.DATASET_PATH || new URL('../data/chargers.json', import.meta.url), 'utf8'));
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
