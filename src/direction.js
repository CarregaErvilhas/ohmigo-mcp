// Motorway service areas come in pairs, one on each side of the road, and a
// driver can only reach the one on their side: the other is across the
// motorway. Both sides often have the same name and even the same address in
// the NAP ("(A1) KM 166,7 - LISBOA/PORTO" on both sides at Pombal), so what
// tells them apart is the direction the driver is going. Without it, the
// assistant has to ask.
//
// With a direction, the side is picked by:
//   1. the direction the site says it serves, when it says ("N/S" = driving
//      north to south, "S-N", "sentido Lisboa"), in the NAP address or the
//      OSM name. That's what the operator or the mappers wrote: reliable.
//   2. otherwise, the right-hand rule: Portugal drives on the right, so a
//      service area sits to the right of the carriageway it serves. It's a
//      guess from coordinates. The twins are sometimes staggered along the
//      road rather than across it, so it only decides when one side is
//      clearly to the right (GEOMETRY_CLEAR, tuned on the pairs the data
//      labels: none decided wrong), and says so in an assumption telling the
//      user to check the signs.

import { haversineKm, rad } from './geo.js';
import { fold } from './lookup.js';

// Sites this close count as one place to the driver (a service area often has
// one NAP site per charger). On a motorway the two sides can be closer than
// that (72 m apart at Vila Velha de Ródão), so there it takes a published
// direction that agrees, or MOTORWAY_PLACE_KM (one side's chargers at Pombal
// spread over 43 m).
export const SAME_PLACE_KM = 0.25;
const MOTORWAY_PLACE_KM = 0.06;
// In town, 250 m is a whole street: two car parks with different operators
// (Colombo's Capwatt and a Galp across the avenue, 64 m apart) are not one
// place. There it takes URBAN_PLACE_KM, or the same operator (one station
// spread over several NAP sites), address or OSM name.
export const URBAN_PLACE_KM = 0.06;
// Places this close, all on a motorway, are taken for the sides of one
// service area.
export const PAIR_KM = 2;

// A motorway or expressway in the address or OSM name: "A1", "IC2", "IP3",
// "área de serviço". Not a bare "km": national roads ("EN1 km 152") have no
// separate carriageways, you just cross.
const MOTORWAY = /\b(?:a|ic|ip)\s?\d{1,2}\b|\barea de servic[oi]\b/;
export const onMotorway = site => MOTORWAY.test(fold(`${site.address ?? ''} ${site.osm?.name ?? ''}`));

// The direction a site says it serves, as published: "N/S", "S-N", "sentido
// Lisboa". null when it doesn't say.
const LABEL = /\b([NSEO])\s?[-/]\s?([NSEO])\b|\bsentido\s+([^,;()]+)/i;
function parseLabel(site) {
  for (const text of [site.osm?.name, site.address]) {
    const m = text?.match(LABEL);
    if (m) return { text: m[0].trim(), from: m[1]?.toUpperCase(), to: m[2]?.toUpperCase(), town: m[3]?.trim() };
  }
  return null;
}
export const directionLabel = site => parseLabel(site)?.text ?? null;

const heading = l => l?.from && l?.to ? l.from + l.to : l?.town ? fold(l.town) : null;

// Could a driver walk from one charger to the other: same place?
export function samePlace(a, b) {
  const km = haversineKm(a, b);
  if (km > SAME_PLACE_KM) return false;
  const la = heading(parseLabel(a)), lb = heading(parseLabel(b));
  if (la && lb) return la === lb;
  if (onMotorway(a) || onMotorway(b)) return km <= MOTORWAY_PLACE_KM;
  return km <= URBAN_PLACE_KM || (a.operatorId != null && a.operatorId === b.operatorId) || sameSpot(a, b);
}

const sameSpot = (a, b) => (!!a.address && fold(a.address) === fold(b.address ?? ''))
  || (!!a.osm?.name && a.osm.name === b.osm?.name);

// Is b part of the same station as a (same operator, same car park)? Stricter
// than samePlace, for adding a site's neighbours to a quote: the same
// operator 200 m down the road at another address is another charger.
export const sameStation = (a, b) => a.operatorId === b.operatorId && samePlace(a, b)
  && (haversineKm(a, b) <= URBAN_PLACE_KM || sameSpot(a, b) || onMotorway(a));

// Things filed by map square, so a broad lookup (thousands of hits) compares
// each site with its neighbours instead of with every place so far. Squares
// are at least `km` wide on every side, so whatever is within `km` of a point
// is in its square or one of the eight around it. A degree of longitude
// shrinks towards the poles, so the width comes from the point furthest from
// the equator (the data has stray coordinates well north of Portugal).
const KM_PER_DEGREE = 110; // a bit under the real 111.2: squares err on wide
function mapSquares(points, km) {
  const north = points.reduce((m, p) => Math.abs(p.lat) > m ? Math.abs(p.lat) : m, 0);
  const latDeg = km / KM_PER_DEGREE, lonDeg = latDeg / Math.max(Math.cos(rad(north)), 0.01);
  const squares = new Map();
  const y = p => Math.floor(p.lat / latDeg), x = p => Math.floor(p.lon / lonDeg);
  let added = 0;
  return {
    add(p, item) {
      const key = `${y(p)}/${x(p)}`;
      if (!squares.has(key)) squares.set(key, []);
      squares.get(key).push({ item, order: added++ });
    },
    // What's filed around p, oldest first: callers want the first that fits.
    near(p) {
      const out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...squares.get(`${y(p) + dy}/${x(p) + dx}`) ?? []);
      return out.sort((a, b) => a.order - b.order).map(e => e.item);
    },
  };
}

// Groups hits ({ site, ... }) into places (samePlace as the place's first
// site).
export function clusterPlaces(hits) {
  const places = [], firsts = mapSquares(hits.map(h => h.site), SAME_PLACE_KM);
  for (const h of hits) {
    const place = firsts.near(h.site).find(pl => samePlace(pl[0].site, h.site));
    if (place) place.push(h);
    else { places.push([h]); firsts.add(h.site, places.at(-1)); }
  }
  return places;
}

// Groups places into service areas: motorway places within PAIR_KM of each
// other. A group with more than one place is a service area with sides.
export function serviceAreas(places) {
  const groups = [], firsts = mapSquares(places.map(pl => pl[0].site), PAIR_KM);
  for (const pl of places) {
    const [{ site }] = pl, motorway = onMotorway(site);
    const g = motorway && firsts.near(site).find(g => haversineKm(g[0][0].site, site) <= PAIR_KM);
    if (g) g.push(pl);
    else { groups.push([pl]); if (motorway) firsts.add(site, groups.at(-1)); }
  }
  return groups;
}

// Flat x/y in km around a point; fine over the few km compared here.
const xy = (p, o) => ({ x: (p.lon - o.lon) * 111.32 * Math.cos(o.lat * Math.PI / 180), y: (p.lat - o.lat) * 110.57 });
const unit = v => { const n = Math.hypot(v.x, v.y); return n ? { x: v.x / n, y: v.y / n } : null; };
const COMPASS = { N: { x: 0, y: 1 }, S: { x: 0, y: -1 }, E: { x: 1, y: 0 }, O: { x: -1, y: 0 } };

// How clearly a label must agree with the travel direction (cosine), and how
// clearly a side must be to the right of it (sine) for the right-hand rule.
const CLEAR = 0.3;
const GEOMETRY_CLEAR = 0.55;

// Which places of one service area serve a driver going `heading`
// ({ from, to }: two points, only the direction between them matters).
// `town(name)` resolves "sentido Lisboa" to a point. `geometry: false` skips
// the right-hand rule. Returns { places, by: 'label' | 'geometry', label } or
// null when it can't tell.
export function sideFor(places, heading, town = () => null, { geometry = true } = {}) {
  const d = unit(xy(heading.to, heading.from));
  if (!d || places.length < 2) return null;
  const centre = {
    lat: places.reduce((a, pl) => a + pl[0].site.lat, 0) / places.length,
    lon: places.reduce((a, pl) => a + pl[0].site.lon, 0) / places.length,
  };
  // 1. What each side says it serves: +1 our way, -1 the other, 0 unknown.
  const says = places.map(pl => {
    const l = parseLabel(pl[0].site);
    let v = null;
    if (l?.from && l?.to && l.from !== l.to) v = unit({ x: COMPASS[l.to].x - COMPASS[l.from].x, y: COMPASS[l.to].y - COMPASS[l.from].y });
    else if (l?.town) { const p = town(l.town); if (p) v = unit(xy(p, centre)); }
    if (!v) return 0;
    const cos = v.x * d.x + v.y * d.y;
    return cos > CLEAR ? 1 : cos < -CLEAR ? -1 : 0;
  });
  const ours = places.filter((_, i) => says[i] === 1);
  if (ours.length && ours.length < places.length) return { places: ours, by: 'label', label: parseLabel(ours[0][0].site).text };
  if (!geometry) return null;
  // 2. The right-hand rule: cross product of the travel direction and the
  // place's offset from the centre (negative = right).
  const side = places.map(pl => {
    const v = unit(xy(pl[0].site, centre));
    return v ? d.x * v.y - d.y * v.x : 0;
  });
  if (side.some(s => Math.abs(s) < GEOMETRY_CLEAR)) return null;
  const right = places.filter((_, i) => side[i] < 0);
  return right.length && right.length < places.length ? { places: right, by: 'geometry' } : null;
}
