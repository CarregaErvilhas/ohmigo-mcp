// Distances on the Earth's surface. Its own module so data.js and
// direction.js can both use it without importing each other.

const R_KM = 6371;
export const rad = d => d * Math.PI / 180;

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
