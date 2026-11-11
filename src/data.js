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
// hours...), when the community mapped it with the MOBI.E code. `places`:
// the shopping centres, hospitals, car parks... whose outline holds the site or
// lies a few metres from it ({ name, type, osm, m }: m = metres to its edge, 0
// = inside), worked out by nap-dashboard; OSM doesn't say which a charger is at.
// All of this is third-party text and numbers: see clean.js for what's kept.
//
// The sites fit in memory easily, and the linear scan that filters them per
// query takes a few milliseconds, so that scan has no spatial index. Grouping
// what it found into places does: see mapSquares in direction.js.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cleanSite, reportLine } from './clean.js';

import { clusterPlaces, serviceAreas, sideFor } from './direction.js';
import { haversineKm, routeDistance } from './geo.js';
import { siteOpen } from './hours.js';
import { Index, lendOperators, operatorKey } from './lookup.js';
import { revalidate } from './live.js';

// Guards on a downloaded dataset (Dataset.load). The real file is ~10 MB with
// ~9k sites; a truncated or tampered one must not replace it.
export const MAX_DATASET_BYTES = 64 * 1024 * 1024;
export const MIN_SITES = 1000;
// Same ratio as AmpereArchive's collector (minRatio): a weekly rebuild never
// loses half the network, a broken one does.
export const MIN_RATIO = 0.5;

// A download the guards turned down: the copy in memory stays, and /healthz says so.
export class DatasetRefused extends Error {}

function notShrunk(raw, previous) {
  const sites = Array.isArray(raw.sites) ? raw.sites : [];
  const count = list => list.reduce((n, s) => n + (Array.isArray(s?.points) ? s.points.length : 0), 0);
  for (const [what, got, had] of [['sites', sites.length, previous.sites.length], ['points', count(sites), count(previous.sites)]]) {
    if (had > 0 && got < had * MIN_RATIO) throw new DatasetRefused(`dataset has only ${got} ${what}, ${had} in memory (under ${Math.round(MIN_RATIO * 100)}%)`);
  }
}

// Reads a response body up to `max` bytes, stopping the download past that.
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length')) > max) throw new DatasetRefused(`dataset over ${max} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) { await res.body.cancel?.().catch(() => {}); throw new DatasetRefused(`dataset over ${max} bytes`); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
import { usableKw } from './socket.js';
import { fold } from './text.js';

// How many site ids list_operators names per operator with no OPC fee on file.
const NO_OPC_TARIFF_MAX = 20;

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
    // First: everything below, and every tool, reads the limited text.
    this.cleaned = {};
    for (const s of this.sites) cleanSite(s, this.cleaned);
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
        // Only the believable ones are still here (clean.js).
        for (const [k, nap] of [['kw', 'napKw'], ['v', 'napV'], ['a', 'napA']]) {
          if (p.osm?.[k] > 0 && p[nap] === undefined) { p[nap] = p[k] ?? null; p[k] = p.osm[k]; }
        }
        // OpenStreetMap also says whether the Type 2 socket has a fixed cable
        // (socket:type2_cable) or is a socket you bring your own cable to
        // (socket:type2). The NAP's connectorFormat can be wrong, so OSM
        // replaces it too, keeping the NAP's value in napCable.
        if (typeof p.osm?.cable === 'boolean' && p.osm.cable !== p.cable) {
          p.napCable = p.cable ?? null; p.cable = p.osm.cable;
        }
        // Where the max current comes from: OpenStreetMap (it corrected the
        // NAP, or confirmed it: osmSame) or only the operator's declaration.
        // A DC socket's amps decide what a 400 V car gets (socket.js), so the
        // answers say which.
        if (p.a > 0) p.ampsSource = p.napA !== undefined || p.osmSame?.includes('a') ? 'osm' : 'nap';
        // Same for the cable: seen on the charger (OpenStreetMap) or only the
        // operator's declaration (NAP).
        if (p.cable != null) p.cableSource = p.napCable !== undefined || p.osmSame?.includes('cable') ? 'osm' : 'nap';
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
  //
  // A downloaded file is held to more than a local one, because it replaces
  // a good copy without anybody looking: at most MAX_DATASET_BYTES, at least
  // MIN_SITES sites, and, against `previous` (the copy in memory), at least
  // MIN_RATIO of its sites and points. Failing those throws a DatasetRefused.
  // Local files skip the floor and the ratio: tests and development use tiny
  // ones on purpose.
  static async load({ etag, timeoutMs = 60_000, previous } = {}) {
    const path = process.env.DATASET_PATH || (process.env.DATASET_URL ? null : localFile());
    if (path) return Dataset.check(JSON.parse(await readFile(path, 'utf8')));
    const url = process.env.DATASET_URL || DEFAULT_URL;
    const res = await fetch(url, { headers: etag ? revalidate(etag) : {}, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`dataset ${url}: HTTP ${res.status}`);
    const raw = JSON.parse(await readCapped(res, MAX_DATASET_BYTES));
    if (previous) notShrunk(raw, previous);
    const ds = Dataset.check(raw, { minSites: MIN_SITES });
    ds.etag = res.headers.get('etag');
    return ds;
  }

  // Refuses a file from a format we don't know, instead of misreading it.
  static check(raw, { minSites = 1 } = {}) {
    const schema = raw.schema ?? 1;
    if (schema !== SCHEMA) throw new Error(`dataset schema ${schema}, this server reads ${SCHEMA}`);
    if (!Array.isArray(raw.sites) || !raw.sites.length) throw new Error('dataset has no sites');
    if (raw.sites.length < minSites) throw new DatasetRefused(`dataset has only ${raw.sites.length} sites, under the floor of ${minSites}`);
    const ds = new Dataset(raw);
    console.log(reportLine(ds.cleaned));
    return ds;
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

  // A town as a service area's direction label writes it ("Lisboa", "LIS",
  // "OLH"; direction.js): a three-letter abbreviation is first read as the
  // municipality of the MOBI.E codes ("OLH-00047" is in Olhão), then like
  // any place name. null when it can't be placed (VRA, POR: several towns).
  resolveSignTown(name) {
    const code = String(name).trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code)) {
      if (!this.codeCities) {
        this.codeCities = new Map();
        for (const s of this.sites) {
          const c = s.code?.match(/^([A-Z]{3})-\d/)?.[1];
          if (!c || !s.city) continue;
          if (!this.codeCities.has(c)) this.codeCities.set(c, new Set());
          this.codeCities.get(c).add(s.city);
        }
      }
      const cities = this.codeCities.get(code);
      if (cities?.size === 1) return this.resolvePlace([...cities][0]);
    }
    return this.resolvePlace(name);
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
  //   wheelchair   only sites the operator or OpenStreetMap say a wheelchair
  //                user can reach (yes or limited); few say anything
  //   cable        true: the cable is fixed to the charger; false: a socket
  //   openAt       a Date: only sites not known to be closed then (unknown
  //                hours pass: most sites have them, and a guess would hide
  //                chargers that are open)
  // `hide`: plugs left out when `connectors` isn't given (the tools hide
  // CHAdeMO from drivers who didn't say their car has that port).
  // `carVolts`: the car's battery voltage. minKw then reads the power a DC
  // socket can give that car (amps × volts, socket.js), not its nameplate:
  // "150 kW for my 400 V car" must not keep a 200 A socket (80 kW).
  pointFilter({ minKw, connectors, hide, dcOnly, minVoltage, cardPayment: card, cable, openAt, carVolts, wheelchair: wc } = {}) {
    const cs = connectors?.length ? new Set(connectors) : null;
    const hidden = !cs && hide?.length ? new Set(hide) : null;
    const minV = this.hasVoltage ? minVoltage : null;
    const siteOk = new Map();
    const siteFits = s => {
      if (!siteOk.has(s)) siteOk.set(s, (!card || cardPayment(s).value === true) && (!wc || ['yes', 'limited'].includes(wheelchair(s))) && (!openAt || siteOpen(s, openAt).open !== false));
      return siteOk.get(s);
    };
    return (p, s) => (minKw == null || (usableKw(p, carVolts) ?? 0) >= minKw)
      && (!cs || cs.has(p.connector))
      && (!hidden || !hidden.has(p.connector))
      && (!dcOnly || p.dc)
      && (minV == null || (p.v ?? 0) >= minV)
      && (cable == null || p.cable === cable)
      && (!s || siteFits(s));
  }

  // Sites near a point or along a route, nearest first (or in route order),
  // each with only the points that pass the filter. With neither, the whole
  // country ("every charger above 500 V"), most powerful first: for the car,
  // when filter.carVolts is given ("the most powerful chargers for a 400 V
  // car" are not the ones with the biggest nameplate).
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
    const maxKw = r => Math.max(...r.points.map(p => usableKw(p, filter.carVolts) ?? 0));
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
  // `noOpcTariffSites`: the sites with a socket on MOBI.E whose operator fee
  // is missing from MOBI.E's file (regime mobie_sem_tarifa, priced with the
  // NAP's fee), so a count in `regimes` leads somewhere: lookup_charger takes
  // the id. Only the first few: a long list would be noise, the count stays.
  operators({ region, ...filter } = {}) {
    const ok = this.pointFilter(filter);
    const by = new Map();
    for (const s of this.sites) {
      if (region && s.region !== region) continue;
      const points = s.points.filter(p => ok(p, s));
      if (!points.length) continue;
      const key = operatorKey(s);
      let o = by.get(key);
      if (!o) by.set(key, o = { operatorId: s.operatorId ?? undefined, names: new Map(), websites: new Set(), sites: 0, inferredSites: 0, points: 0, dcPoints: 0, maxKw: 0, maxV: 0, regions: {}, regimes: {}, noOpcTariff: [] });
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
      if (points.some(p => p.regime === 'mobie_sem_tarifa')) o.noOpcTariff.push(s.id);
    }
    return [...by.values()].map(o => {
      const names = [...o.names].sort((x, y) => y[1] - x[1]).map(([n]) => n);
      return {
        operatorId: o.operatorId, name: names[0] ?? o.lentName ?? '?', otherNames: names.length > 1 ? names.slice(1) : undefined,
        website: [...o.websites][0], sites: o.sites, inferredSites: o.inferredSites || undefined, points: o.points, dcPoints: o.dcPoints,
        maxKw: o.maxKw || undefined, maxVoltage: o.maxV || undefined, regions: o.regions, regimes: o.regimes,
        noOpcTariffSites: o.noOpcTariff.length ? o.noOpcTariff.sort().slice(0, NO_OPC_TARIFF_MAX) : undefined,
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
      const pick = sideFor(area, area[0][0].seg, name => this.resolveSignTown(name), { geometry: false });
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
// Can a wheelchair user reach the charger? The NAP's DATEX II accessibility
// (the operator's word, almost never published) says yes; otherwise
// OpenStreetMap's wheelchair tag: yes, limited or no. null: nobody says.
const NAP_ACCESSIBLE = ['wheelChairAccessible', 'disabilityAccessible', 'barrierFreeAccessible'];
export function wheelchair(site) {
  if (NAP_ACCESSIBLE.some(v => site.accessibility?.split('|').includes(v))) return 'yes';
  return site.osm?.wheelchair ?? null;
}

const NAP_CARD = new Set(['creditCard', 'debitCard', 'pinpad', 'nfc']);
export function cardPayment(site) {
  const nap = site.payment?.length ? site.payment.some(m => NAP_CARD.has(m)) : null;
  const osm = typeof site.osm?.cards === 'boolean' ? site.osm.cards : null;
  const value = nap === true || osm === true ? true : nap === false || osm === false ? false : null;
  return { value, nap, osm, disagree: nap !== null && osm !== null && nap !== osm };
}
