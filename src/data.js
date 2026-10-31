// The charger dataset and the geographic searches on it.
//
// "The dataset" is the part of the network that changes slowly: where each
// charger is, its plugs and power, and the operator fees MOBI.E publishes.
// nap-dashboard builds it once a week (scripts/ohmigo_dataset.py over there)
// and publishes it at DEFAULT_URL. Things that change by the minute (is the
// charger free?) are NOT here: live.js reads them from the NAP when asked.
//
// Shape (one JSON file):
//   { schema, generatedAt, sites: [{ id, code, lat, lon, region, city, address,
//     operator, operatorId, name?, hours?, locationDescription?, phone?, osm?,
//     points: [{ id, kw, v, a, cable, connector, dc, phases, level, regime, opc, osm? }] }] }
// `v`/`a` are the connector's voltage and max current as the operator
// declares them on the NAP; `level` is the grid's voltage level (BTN/BTE/MT),
// which picks the TAR, not the socket's voltage. `cable`: the cable is fixed
// to the charger (false: bring your own). A point's `osm` holds the kW/V/A
// OpenStreetMap has for that socket where they differ from the NAP's.
// `osm` is what OpenStreetMap adds about the site (its name, brand, opening
// hours...), when the community mapped it with the MOBI.E code.
//
// The sites fit in memory easily, and the linear scan that filters them per
// query takes a few milliseconds, so that scan has no spatial index. Grouping
// what it found into places does: see mapSquares in direction.js.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { clusterPlaces, serviceAreas, sideFor } from './direction.js';
import { haversineKm, routeDistance } from './geo.js';
import { siteOpen } from './hours.js';
import { Index, lendOperators, operatorKey } from './lookup.js';
import { fold } from './text.js';

export const DEFAULT_URL = 'https://nap.ocarroeletrico.com/ohmigo/chargers.json';
// The dataset format this code understands. nap-dashboard bumps SCHEMA in
// ohmigo_dataset.py when the format changes incompatibly.
const SCHEMA = 1;
// resolvePlace: shortest name it tries, and the share of all sites past which
// a partial match is too generic to be a place (Lisboa, the biggest city, is
// ~10 %).
const MIN_PLACE = 3;
// No town has a name this long, and placeHits' cost grows fast with the length.
const MAX_PLACE_CHARS = 200;
const MAX_PLACE_SHARE = 0.15;

const localFile = () => {
  const p = fileURLToPath(new URL('../data/chargers.json', import.meta.url));
  return existsSync(p) ? p : null;
};

export class Dataset {
  constructor(raw) {
    this.generatedAt = raw.generatedAt;
    this.sites = raw.sites;
    lendOperators(this.sites);
    this.siteById = new Map();
    this.pointById = new Map();
    for (const s of this.sites) {
      this.siteById.set(s.id, s);
      for (const p of s.points) {
        // A socket can't deliver 0 kW: in the data that's a blank, not a
        // measurement. Blank here, so the duration, the price band and the
        // answers all read it as unknown power.
        if (p.kw <= 0) p.kw = null;
        // OpenStreetMap's kW/V/A are read off the charger's plate by the
        // community and are usually more right than the NAP's declaration
        // (DC sockets declaring a 750 V placeholder, powers V×I can't give).
        // So they replace it everywhere (filters, duration, price band); the
        // NAP's value stays in napKw/napV/napA for the answers to show.
        for (const [k, nap] of [['kw', 'napKw'], ['v', 'napV'], ['a', 'napA']]) {
          if (p.osm?.[k] > 0 && p[nap] === undefined) { p[nap] = p[k] ?? null; p[k] = p.osm[k]; }
        }
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
    // Datasets built before nap-dashboard published v/a have no voltages:
    // there, a voltage filter would drop every charger, so it's ignored (and
    // the tools say so).
    this.hasVoltage = this.sites.some(s => s.points.some(p => p.v != null));
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
  static async load({ etag, timeoutMs = 60_000 } = {}) {
    const path = process.env.DATASET_PATH || (process.env.DATASET_URL ? null : localFile());
    if (path) return Dataset.check(JSON.parse(await readFile(path, 'utf8')));
    const url = process.env.DATASET_URL || DEFAULT_URL;
    const res = await fetch(url, { headers: etag ? { 'if-none-match': etag } : {}, signal: AbortSignal.timeout(timeoutMs) });
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
  // coordinates. Matches NAP's `city` field, accent- and case-insensitive:
  //   1. the city exactly;
  //   2. else cities with a word starting with it ("viana do" -> Viana do
  //      Castelo), only when that's one city: "santa" fits a dozen, and their
  //      average would be a point in none of them;
  //   3. else (4+ letters) a word of the address in one town ("Meadela").
  // Never a substring anywhere: "por" used to match every address with
  // "por" in it and centre the search in the Atlantic off Nazaré.
  // null when nothing (or too much) matches; placeCandidates says which.
  resolvePlace(name) {
    const hits = this.placeHits(name);
    if (!hits || new Set(hits.map(s => fold(s.city))).size > 1) return null;
    const lat = hits.reduce((a, s) => a + s.lat, 0) / hits.length;
    const lon = hits.reduce((a, s) => a + s.lon, 0) / hits.length;
    return { lat, lon, matchedSites: hits.length };
  }

  // The towns a name could be, when resolvePlace can't pick one (up to 8).
  placeCandidates(name) {
    const hits = this.placeHits(name) ?? [];
    return [...new Set(hits.map(s => s.city).filter(Boolean))].slice(0, 8);
  }

  placeHits(name) {
    // Punctuation around the name isn't part of it: "Leiria." is Leiria.
    const clean = text => fold(text).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    const full = clean(String(name).slice(0, MAX_PLACE_CHARS));
    // "Leiria, Portugal" or "Leiria (Pombal)": the town is the first part.
    const q = clean(full.split(/[,(]/)[0]);
    if (q.length < MIN_PLACE) return null;
    const words = text => fold(text).split(/[^a-z0-9]+/).filter(Boolean);
    const prefix = text => {
      const w = words(text), qs = q.split(/[^a-z0-9]+/);
      // Every word of the query starts a word of the text, in order.
      for (let i = 0; i + qs.length <= w.length; i++) if (qs.every((x, j) => w[i + j].startsWith(x))) return true;
      return false;
    };
    // Some NAP cities carry their own comma ("Lagoa, Faro" and "Lagoa, Azores").
    // Cleaned on both sides: a city can end in punctuation too.
    let hits = this.sites.filter(s => clean(s.city ?? '') === full);
    if (!hits.length) hits = this.sites.filter(s => clean(s.city ?? '') === q);
    if (hits.length) return hits;
    hits = this.sites.filter(s => prefix(s.city ?? ''));
    if (!hits.length && q.length >= 4) {
      hits = this.sites.filter(s => prefix(s.address ?? ''));
      // An address word all over the country ("avenida") is not a place.
      if (new Set(hits.map(s => fold(s.city))).size > 2) hits = [];
    }
    if (!hits.length || hits.length > Math.max(50, this.sites.length * MAX_PLACE_SHARE)) return null;
    return hits;
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
      const points = h.site.points.filter(p => ok(p, h.site));
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

  // A socket with no declared voltage fails a voltage filter: unknown is not
  // "above 500 V".
  // Site-level filters ride along, so the function takes the site too:
  //   cardPayment  only sites where a bank card is known to work at the charger
  //   cable        true: the cable is fixed to the charger; false: a socket
  //   openAt       a Date: only sites not known to be closed then (unknown
  //                hours pass: most sites have them, and a guess would hide
  //                chargers that are open)
  pointFilter({ minKw, connectors, dcOnly, minVoltage, cardPayment: card, cable, openAt } = {}) {
    const cs = connectors?.length ? new Set(connectors.map(c => c.toUpperCase())) : null;
    const minV = this.hasVoltage ? minVoltage : null;
    const siteOk = new Map();
    const siteFits = s => {
      if (!siteOk.has(s)) siteOk.set(s, (!card || cardPayment(s).value === true) && (!openAt || siteOpen(s, openAt).open !== false));
      return siteOk.get(s);
    };
    return (p, s) => (minKw == null || (p.kw ?? 0) >= minKw)
      && (!cs || cs.has(p.connector))
      && (!dcOnly || p.dc)
      && (minV == null || (p.v ?? 0) >= minV)
      && (cable == null || p.cable === cable)
      && (!s || siteFits(s));
  }

  // Sites near a point or along a route, nearest first (or in route order),
  // each with only the points that pass the filter. With neither, the whole
  // country ("every charger above 500 V"), most powerful first.
  // `only`: a Set of site ids to keep (a text filter, from lookup()).
  search({ near, radiusKm = 5, route, corridorKm = 2, limit = 20, only, region, ...filter }) {
    const ok = this.pointFilter(filter);
    const out = [];
    for (const s of this.sites) {
      if (only && !only.has(s.id)) continue;
      if (region && s.region !== region) continue;
      let dist;
      if (route) {
        const d = routeDistance(s, route);
        if (d.km > corridorKm) continue;
        dist = { offRouteKm: d.km, alongKm: d.alongKm, seg: d.seg };
      } else if (near) {
        const km = haversineKm(near, s);
        if (km > radiusKm) continue;
        dist = { km };
      }
      const points = s.points.filter(p => ok(p, s));
      if (points.length) out.push({ site: s, points, ...dist });
    }
    const maxKw = r => Math.max(...r.points.map(p => p.kw ?? 0));
    out.sort(route ? (a, b) => a.alongKm - b.alongKm
      : near ? (a, b) => a.km - b.km
      : (a, b) => maxKw(b) - maxKw(a) || a.site.id.localeCompare(b.site.id));
    const kept = route ? this.ourSide(out) : out;
    for (const r of kept) delete r.seg;
    return { total: kept.length, results: kept.slice(0, limit) };
  }

  // Who operates the network (the OPCs, plus the operators outside MOBI.E),
  // as the NAP publishes it, biggest first. Grouped by operatorId: the name
  // is not a key (Atlante appears with 7 spellings), so each operator gets
  // its most common spelling and the others in `otherNames`. Sites without
  // an operatorId group by name. `inferredSites`: how many of its sites the
  // NAP left nameless and the id prefix attributes to it (lookup.js).
  operators({ region, ...filter } = {}) {
    const ok = this.pointFilter(filter);
    const by = new Map();
    for (const s of this.sites) {
      if (region && s.region !== region) continue;
      const points = s.points.filter(p => ok(p, s));
      if (!points.length) continue;
      const key = operatorKey(s);
      let o = by.get(key);
      if (!o) by.set(key, o = { operatorId: s.operatorId ?? undefined, names: new Map(), websites: new Set(), sites: 0, inferredSites: 0, points: 0, dcPoints: 0, maxKw: 0, maxV: 0, regions: {}, regimes: {} });
      // A lent name isn't a spelling the NAP published, so it doesn't vote; it
      // only names an operator whose sites here are all inferred (a region
      // or filter can leave just those).
      if (s.operatorInferred) o.lentName ??= s.operator;
      else if (s.operator) o.names.set(s.operator, (o.names.get(s.operator) || 0) + 1);
      if (s.website) o.websites.add(s.website);
      o.sites++;
      if (s.operatorInferred) o.inferredSites++;
      o.regions[s.region] = (o.regions[s.region] || 0) + 1;
      for (const p of points) {
        o.points++;
        if (p.dc) o.dcPoints++;
        o.maxKw = Math.max(o.maxKw, p.kw ?? 0);
        o.maxV = Math.max(o.maxV, p.v ?? 0);
        o.regimes[p.regime] = (o.regimes[p.regime] || 0) + 1;
      }
    }
    return [...by.values()].map(o => {
      const names = [...o.names].sort((x, y) => y[1] - x[1]).map(([n]) => n);
      return {
        operatorId: o.operatorId, name: names[0] ?? o.lentName ?? '?', otherNames: names.length > 1 ? names.slice(1) : undefined,
        website: [...o.websites][0], sites: o.sites, inferredSites: o.inferredSites || undefined, points: o.points, dcPoints: o.dcPoints,
        maxKw: o.maxKw || undefined, maxVoltage: o.maxV || undefined, regions: o.regions, regimes: o.regimes,
      };
    }).sort((x, y) => y.sites - x.sites || x.name.localeCompare(y.name));
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

// Can you pay with a bank card at the charger itself? Two sources:
//   the NAP's authentication methods (creditCard, debitCard, pinpad, nfc):
//     a declared list, so a list without them is a "no";
//   OpenStreetMap's payment:cards/contactless... (site.osm.cards): yes or no
//     when the community tagged it, absent otherwise.
// Yes when either says yes (a terminal one source missed is still there);
// `disagree` when they contradict, so the answer can say "check on site".
const NAP_CARD = new Set(['creditCard', 'debitCard', 'pinpad', 'nfc']);
export function cardPayment(site) {
  const nap = site.payment?.length ? site.payment.some(m => NAP_CARD.has(m)) : null;
  const osm = typeof site.osm?.cards === 'boolean' ? site.osm.cards : null;
  const value = nap === true || osm === true ? true : nap === false || osm === false ? false : null;
  return { value, nap, osm, disagree: nap !== null && osm !== null && nap !== osm };
}
