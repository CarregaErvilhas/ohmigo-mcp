// When each kWh of a session is delivered, on the clock.
//
// A CEME's energy price isn't one number for the whole session:
//   - bi-hourly tariffs have an off-peak ("vazio") and a peak ("fora de
//     vazio") price, and a slow session can start in one and end in the other;
//   - indexed tariffs follow the wholesale price (OMIE), which changes every
//     15 minutes;
//   - a session past midnight can fall on a day with a new grid fee (TAR), and
//     one on the last Sunday of March or October crosses a clock change.
//
// So we don't send ceme-v2 "40 kWh at 21:30". We send the session cut into
// slices, one per OMIE quarter-hour (:00, :15, :30, :45 UTC), each with the
// kWh delivered in it, and ceme-v2 prices every slice at its own period,
// OMIE, losses and TAR (its `profile` input). All in UTC instants: periods are
// worked out by ceme-v2 in the region's time zone, so clock changes need no
// special case here.

const QUARTER_MS = 15 * 60_000;

// Time zone of each region, for showing local times to the driver.
export const REGION_TZ = { CONT: 'Europe/Lisbon', MAD: 'Atlantic/Madeira', AZO: 'Atlantic/Azores' };

// segments: [{ minutes, kwh }] at constant power, back to back (charging.js)
// start:    Date when the session starts
// -> [{ at: ISO, kwh, minutes, kw }], one slice per quarter-hour touched.
//    The first starts at `start` itself, the others on quarter boundaries.
export function sessionProfile(segments, start) {
  const out = [];
  let t = start.getTime();
  let slice = { at: t, kwh: 0, ms: 0 };
  for (const seg of segments) {
    const end = t + seg.minutes * 60_000;
    const kwhPerMs = seg.kwh / (end - t);
    while (t < end) {
      const boundary = (Math.floor(t / QUARTER_MS) + 1) * QUARTER_MS;
      const stop = Math.min(end, boundary);
      slice.kwh += kwhPerMs * (stop - t);
      slice.ms += stop - t;
      t = stop;
      if (t === boundary) {
        out.push(slice);
        slice = { at: t, kwh: 0, ms: 0 };
      }
    }
  }
  if (slice.ms > 0) out.push(slice);
  return out
    .filter(s => s.kwh > 0)
    .map(s => ({
      at: new Date(s.at).toISOString(),
      kwh: Math.round(s.kwh * 10_000) / 10_000,
      minutes: Math.round(s.ms / 6_000) / 10,
      kw: Math.round(s.kwh / (s.ms / 3_600_000) * 10) / 10, // average power in the slice
    }));
}

// "21:45" in the region's own time zone.
const fmt = new Map();
export function localTime(at, region = 'CONT') {
  const tz = REGION_TZ[region] || REGION_TZ.CONT;
  if (!fmt.has(tz)) fmt.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  return fmt.get(tz).format(new Date(at));
}

// "+01:00": the region's UTC offset at that instant. Shown next to local
// times so the hour repeated in October (01:00-02:00 twice) isn't ambiguous.
const off = new Map();
export function localOffset(at, region = 'CONT') {
  const tz = REGION_TZ[region] || REGION_TZ.CONT;
  if (!off.has(tz)) off.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'longOffset' }));
  const name = off.get(tz).formatToParts(new Date(at)).find(p => p.type === 'timeZoneName').value;
  return name === 'GMT' ? '+00:00' : name.replace('GMT', '');
}
