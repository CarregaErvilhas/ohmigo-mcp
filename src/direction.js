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

import { haversineKm } from './geo.js';
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
const MOTORWAY = /\b(?:a|ic|ip)\d{1,2}\b|\bi[cp]\s\d{1,2}\b|\barea de servic[oi]\b/;
// "A 22" with a space also reads as a door number: "40 a 48" (a range, lower
// case or after a number), "Avenida das Laranjeiras A 2", "Lote 12, A 14". So
// it takes capitals, nothing before it that gives the text a door, and a sign
// that it's a road: it stands alone, or comes with a km, a "sentido", "junto
// à", "acesso", brackets or the A22's name. Unfolded text, so the boundary
// has to know "Ç" is a letter ("PRAÇA 25").
const SPACED_A = /(?<![\p{L}\d])(?<!\d\s)A \d{1,2}(?![\p{L}\d])/u;
const HAS_DOOR = /\b(?:rua|av|avenida|travessa|tv|largo|praca|praceta|alameda|lote|lt|bloco|bairro|urbanizacao|urb)\b|\br\./;
const ROAD_SIGN = /\bkm\s?\d|\bsentido\b|\bjunto\b|\bacesso\b|\(|\bvia do infante\b/;
function namesMotorway(text) {
  const folded = fold(text);
  if (MOTORWAY.test(folded)) return true;
  const m = text.match(SPACED_A);
  return !!m && !HAS_DOOR.test(fold(text.slice(0, m.index))) && (ROAD_SIGN.test(folded) || folded === fold(m[0]));
}
export const onMotorway = site => [site.address, site.osm?.name].some(t => t && namesMotorway(t));

// The direction a site says it serves, as published: "N/S", "S-N", "sentido
// Lisboa". null when it doesn't say. Compass pairs only in capitals: nobody
// writes them in lower case. "S/N" is also sem número (no door number), the
// usual ending of a Portuguese address, so in an address it only counts as
// south to north when that address is on a motorway: an OSM name saying "A1"
// doesn't explain a door in the address. An OSM name has no door numbers.
const LABEL = /\b(?<from>[NSEO])\s?[-/]\s?(?<to>[NSEO])\b|\b(?:[Ss]entido|SENTIDO)\s+(?<town>[^,;()]+)/g;
function parseLabel(site) {
  for (const text of [site.osm?.name, site.address]) {
    for (const m of text?.matchAll(LABEL) ?? []) {
      const { from, to, town } = m.groups;
      if (text === site.address && from === 'S' && to === 'N' && !namesMotorway(text)) continue;
      return { text: m[0].trim(), from, to, town: town?.trim() };
    }
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

// Groups hits ({ site, ... }) into places (samePlace as the place's first
// site).
export function clusterPlaces(hits) {
  const places = [];
  for (const h of hits) {
    const place = places.find(pl => samePlace(pl[0].site, h.site));
    if (place) place.push(h); else places.push([h]);
  }
  return places;
}

// Groups places into service areas: motorway places within PAIR_KM of each
// other. A group with more than one place is a service area with sides.
export function serviceAreas(places) {
  const groups = [];
  for (const pl of places) {
    const g = onMotorway(pl[0].site)
      && groups.find(g => onMotorway(g[0][0].site) && haversineKm(g[0][0].site, pl[0].site) <= PAIR_KM);
    if (g) g.push(pl); else groups.push([pl]);
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
