// Motorway service areas come in pairs, one on each side of the road, and a
// driver can only reach the one on their side: the other is across the
// motorway. Both sides often have the same name and even the same address in
// the NAP ("(A1) KM 166,7 - LISBOA/PORTO" on both sides at Pombal), so what
// tells them apart is the direction the driver is going. Without it, the
// assistant has to ask.
//
// With a direction, the side is picked by:
//   1. the direction the site says it serves, when it says ("N/S" = driving
//      north to south, "S-N", "sentido Lisboa", "(OLH-VRA)" = from Olhão
//      towards Vila Real de Santo António), in the OSM name, the NAP name or
//      the NAP address. That's what the operator or the mappers wrote:
//      reliable, when the towns in it can be placed on the map.
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
const MOTORWAY = /\b(?:a|ic|ip)\s?\d{1,2}\b|\barea de servic[oi]\b/;
export const onMotorway = site => MOTORWAY.test(fold(`${site.address ?? ''} ${site.name ?? ''} ${site.osm?.name ?? ''}`));

// The direction a site says it serves, as published, in one of three forms:
//   - compass points: "N/S", "S-N", "sentido Norte - Sul", "O/E";
//   - "sentido" and a town, or two (from-to): "sentido Lisboa", "sentido
//     Marateca - Caia", "Sentido Elvas/Badajoz";
//   - two towns in brackets, from and to: "(LIS/POR)", "(OLH-VRA)",
//     "(MOITA/MONTIJO)". Brackets only: "(A1) KM 166,7 - LISBOA/PORTO" is
//     the road, on both sides of it.
// The towns are often road-sign abbreviations (VRA, not the VRS of the
// MOBI.E codes), so placing them is sideFor's `town`, and it may fail: the
// label still goes to the driver as written. null when it doesn't say.
const POINT = { n: 'N', norte: 'N', s: 'S', sul: 'S', e: 'E', este: 'E', o: 'O', oeste: 'O' };
const COMPASS_LABEL = /\b(norte|sul|este|oeste|[nseo])\s?[-/]\s?(norte|sul|este|oeste|[nseo])\b/i;
const SENTIDO = /\bsentido\s+([^,;()]+)/i;
const BRACKETS = /\(\s*([^\d()/-]{3,}?)\s*[-/]\s*([^\d()/-]{3,}?)\s*\)/;
// "Lisboa 1", "E80 3", "A2 KM 111": a town ends before the first word with a
// digit in it (pump numbers, roads).
const townPart = text => text.replace(/\s+\S*\d.*$/, '').trim();
function parseText(text) {
  let m = text.match(COMPASS_LABEL);
  if (m) return { text: m[0].trim(), from: POINT[m[1].toLowerCase()], to: POINT[m[2].toLowerCase()] };
  if ((m = text.match(SENTIDO))) {
    const towns = townPart(m[1]).split(/\s*[-/]\s*/).filter(Boolean);
    if (towns.length === 1) return { text: `sentido ${towns[0]}`, town: towns[0] };
    if (towns.length === 2) return { text: `sentido ${towns.join('-')}`, fromTown: towns[0], toTown: towns[1] };
  }
  if ((m = text.match(BRACKETS))) return { text: `${m[1].trim()}-${m[2].trim()}`, fromTown: m[1].trim(), toTown: m[2].trim() };
  return null;
}
function parseLabel(site) {
  for (const text of [site.osm?.name, site.name, site.address]) {
    const l = text && parseText(text);
    if (l) return l;
  }
  return null;
}
export const directionLabel = site => parseLabel(site)?.text ?? null;

const heading = l => l?.from && l?.to ? l.from + l.to : l?.town ? fold(l.town) : l?.toTown ? `${fold(l.fromTown)}>${fold(l.toTown)}` : null;

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
const FAR_TOWN_KM = 15;

// Which places of one service area serve a driver going `heading`
// ({ from, to }: two points, only the direction between them matters).
// `town(name)` places the towns of a label ("sentido Lisboa", the LIS and
// POR of "(LIS/POR)") on the map, or returns null. `geometry: false` skips
// the right-hand rule. Returns { places, by: 'label' | 'geometry', label,
// oppositeOf } or null when it can't tell.
export function sideFor(places, heading, town = () => null, { geometry = true } = {}) {
  const d = unit(xy(heading.to, heading.from));
  if (!d || places.length < 2) return null;
  const centre = {
    lat: places.reduce((a, pl) => a + pl[0].site.lat, 0) / places.length,
    lon: places.reduce((a, pl) => a + pl[0].site.lon, 0) / places.length,
  };
  // 1. What each side says it serves: +1 our way, -1 the other, 0 unknown.
  // A town further than FAR_TOWN_KM gives a direction on its own ("sentido
  // Lisboa", or the far end of "(LIS/POR)"); a nearer one only with the
  // other end (the "OLH" of "(OLH-VRA)" is the town the area is named after:
  // from the area to it is no direction at all).
  const far = p => p && haversineKm(p, centre) >= FAR_TOWN_KM ? p : null;
  const says = places.map(pl => {
    const l = parseLabel(pl[0].site);
    let v = null;
    if (l?.from && l?.to && l.from !== l.to) v = unit({ x: COMPASS[l.to].x - COMPASS[l.from].x, y: COMPASS[l.to].y - COMPASS[l.from].y });
    else if (l?.town) { const p = far(town(l.town)); if (p) v = unit(xy(p, centre)); }
    else if (l?.toTown) {
      const a = town(l.fromTown), b = town(l.toTown);
      v = a && b ? unit(xy(b, a)) : far(b) ? unit(xy(b, centre)) : far(a) ? unit(xy(centre, a)) : null;
    }
    if (!v) return 0;
    const cos = v.x * d.x + v.y * d.y;
    return cos > CLEAR ? 1 : cos < -CLEAR ? -1 : 0;
  });
  let ours = places.filter((_, i) => says[i] === 1);
  // Two sides, one says it serves the other way and the other says nothing
  // we can place ("(POR/LIS)" with Porto ambiguous): ours is the other one.
  if (!ours.length && places.length === 2 && says.includes(-1)) ours = places.filter((_, i) => says[i] !== -1);
  if (ours.length && ours.length < places.length) {
    // `label`: what our side says; `oppositeOf`: what the other side says,
    // when ours says nothing usable.
    const own = parseLabel(ours[0][0].site)?.text ?? null;
    const other = places.find(pl => !ours.includes(pl));
    return own ? { places: ours, by: 'label', label: own }
      : { places: ours, by: 'label', label: null, oppositeOf: parseLabel(other[0].site).text };
  }
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
