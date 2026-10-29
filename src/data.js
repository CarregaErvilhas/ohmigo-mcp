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
//     operator, osm?, points: [{ id, kw, connector, dc, phases, level, regime, opc }] }] }
// `osm` is what OpenStreetMap adds about the site (its name, brand, opening
// hours...), when the community mapped it with the MOBI.E code.
//
// ~9k sites fit in memory easily, and a linear scan per query takes a few
// milliseconds, so there's no spatial index.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { clusterPlaces, serviceAreas, sideFor } from './direction.js';
import { fold, Index } from './lookup.js';

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

// Distance from p to the polyline, how far along it (km from the start) the
// closest point is, and the segment it's closest to (the direction of travel
// there). Uses a local equirectangular projection per segment,
// which is accurate to well under 1 % at Portugal's latitudes and segment sizes.
export function routeDistance(p, route) {
  let best = { km: Infinity, alongKm: 0, seg: null };
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
    if (km < best.km) best = { km, alongKm: walked + t * seg, seg: { from: a, to: b } };
    walked += seg;
  }
  return best;
}

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
    // ~150 ms, so it's built here (at boot and on the weekly swap), not on
    // somebody's first question.
    this.index = new Index(this.sites);
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
    // "Leiria, Portugal" or "Leiria (Pombal)": the town is the first part.
    const q = fold(name.split(/[,(]/)[0]);
    if (!q) return null;
    let hits = this.sites.filter(s => fold(s.city) === q);
    if (!hits.length) hits = this.sites.filter(s => fold(s.city).includes(q) || fold(s.address).includes(q));
    if (!hits.length) return null;
    const lat = hits.reduce((a, s) => a + s.lat, 0) / hits.length;
    const lon = hits.reduce((a, s) => a + s.lon, 0) / hits.length;
    return { lat, lon, matchedSites: hits.length };
  }

  // Sites by what the user calls them (see lookup.js), best match first and,
  // among equally good ones, nearest to `near` when given. Points that fail
  // the filter are dropped, and so are sites left with none.
  lookup(query, { near, radiusKm, limit = 5, ...filter } = {}) {
    const hits = this.index.find(query);
    // Without coordinates, a town in the query orders the results by
    // distance to it (only ordering: the radius needs real coordinates).
    const town = near ? null : this.index.townIn(query);
    const centre = near ?? (town && this.resolvePlace(town));
    const ok = this.pointFilter(filter);
    let out = [];
    for (const h of hits) {
      const points = h.site.points.filter(ok);
      if (!points.length) continue;
      const km = centre ? haversineKm(centre, h.site) : undefined;
      if (near && radiusKm != null && km > radiusKm) continue;
      out.push({ ...h, points, km });
    }
    // Equally good matches: the ones that matched on who runs the charger or
    // its name before the ones that only matched on the town, then nearest.
    const strong = h => h.matched.some(f => f !== 'city' && f !== 'address') ? 0 : 1;
    out.sort((a, b) => b.score - a.score || strong(a) - strong(b) || (a.km ?? 0) - (b.km ?? 0) || a.site.id.localeCompare(b.site.id));
    const total = out.length;
    out = out.slice(0, limit);
    return { total, town: town ?? undefined, results: out };
  }

  pointFilter({ minKw, connectors, dcOnly } = {}) {
    const cs = connectors?.length ? new Set(connectors.map(c => c.toUpperCase())) : null;
    return p => (minKw == null || (p.kw ?? 0) >= minKw)
      && (!cs || cs.has(p.connector))
      && (!dcOnly || p.dc);
  }

  // Sites near a point or along a route, nearest first (or in route order),
  // each with only the points that pass the filter.
  // `only`: a Set of site ids to keep (a text filter, from lookup()).
  search({ near, radiusKm = 5, route, corridorKm = 2, limit = 20, only, ...filter }) {
    const ok = this.pointFilter(filter);
    const out = [];
    for (const s of this.sites) {
      if (only && !only.has(s.id)) continue;
      let dist;
      if (route) {
        const d = routeDistance(s, route);
        if (d.km > corridorKm) continue;
        dist = { offRouteKm: d.km, alongKm: d.alongKm, seg: d.seg };
      } else {
        const km = haversineKm(near, s);
        if (km > radiusKm) continue;
        dist = { km };
      }
      const points = s.points.filter(ok);
      if (points.length) out.push({ site: s, points, ...dist });
    }
    out.sort(route ? (a, b) => a.alongKm - b.alongKm : (a, b) => a.km - b.km);
    const kept = route ? this.ourSide(out) : out;
    for (const r of kept) delete r.seg;
    return { total: kept.length, results: kept.slice(0, limit) };
  }

  // Along a route the direction of travel is known, so the far side of a
  // motorway service area (across the road) goes, when the sites say which
  // way they serve. Not by the right-hand rule: a route is often a few
  // waypoints, and its segments don't follow the road closely enough for
  // twins only a hundred metres apart. Then both sides stay. See direction.js.
  ourSide(results) {
    const drop = new Set();
    for (const area of serviceAreas(clusterPlaces(results))) {
      if (area.length < 2) continue;
      const pick = sideFor(area, area[0][0].seg, name => this.resolvePlace(name), { geometry: false });
      if (pick) for (const pl of area) if (!pick.places.includes(pl)) pl.forEach(h => drop.add(h));
    }
    return results.filter(r => !drop.has(r));
  }
}
