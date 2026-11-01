// How much energy a charging session bills, and how long it takes.
//
// Two numbers drive the whole bill:
//   - kWh billed: what the charger's meter counts. It's more than what ends
//     up in the battery, because some energy turns into heat on the way.
//   - minutes: some operators charge per minute, so a slow session costs more.
//
// Both are ESTIMATES. A real session depends on the car's charging curve,
// battery temperature, and whether another car shares the charger. That's
// why every guess we make goes into `assumptions`, which the AI assistant
// shows the user next to the price.
//
// Quick vocabulary (more in docs/00-glossary.md):
//   - kW is power (how fast), kWh is energy (how much). 50 kW for 1 hour = 50 kWh.
//   - SoC, "state of charge": the battery %, what the car's dashboard shows.
//   - AC chargers (slow, 3.7-22 kW) feed the car's own on-board charger,
//     so the car limits the speed. DC chargers (fast, 50-400 kW) feed the
//     battery directly, and slow down as the battery fills up.

import { translator } from './i18n.js';
import { kwForCar } from './socket.js';

export const DEFAULTS = {
  // Charging past 80 % on DC is slow, and per-minute fees add up, so 80 % is
  // what most drivers do on a trip.
  targetPct: 80,
  // Share of the metered energy that reaches the battery. AC loses more, in
  // the car's on-board charger; on DC the conversion happens in the charger,
  // mostly before the meter.
  acEfficiency: 0.88,
  dcEfficiency: 0.93,
  // Used only when the assistant couldn't find the car's limits.
  carAcKw: 11,
  carDcKw: 100,
  // Generic DC curve: average power as a share of the peak, below and above
  // 80 % SoC. Real cars vary a lot, which is why we ask for the 10-80 % time.
  dcShareBelow80: 0.7,
  dcShareAbove80: 0.3,
  // AC power stays almost flat until the very end.
  acShare: 0.95,
  // A charger rarely delivers its full nameplate power for a whole session.
  chargerShare: 0.95,
};

// kWh that have to go INTO the battery to go from start % to target %.
export function batteryKwhNeeded({ batteryKwh, startPct, targetPct = DEFAULTS.targetPct }) {
  return Math.max(0, batteryKwh * (targetPct - startPct) / 100);
}

// Linear interpolation on the car's curve: kW at a given SoC.
function curveKwAt(points, soc) {
  if (soc <= points[0].soc) return points[0].kw;
  for (let i = 1; i < points.length; i++) {
    if (soc <= points[i].soc) {
      const a = points[i - 1], b = points[i];
      return a.kw + (b.kw - a.kw) * (soc - a.soc) / (b.soc - a.soc);
    }
  }
  return points.at(-1).kw;
}

// point: { kw, dc, v, a } (from the dataset)
// car:   { batteryKwh, volts, startPct, targetPct, acKw, dcKw, dc10to80Minutes, curve: [{ soc, kw }] }
// t:     translator from i18n.js, for the assumption sentences
//
// The more the assistant knows about the car, the better the duration:
//   1. curve (kW at each SoC)      -> integrate it, 1 % at a time
//   2. dc10to80Minutes             -> the car's real average speed below 80 %
//   3. nothing                     -> generic shares of the peak power
//
// Besides the totals it returns `segments`: the session as consecutive
// stretches of constant power, [{ minutes, kwh }] (billed kWh). The energy
// price changes with the clock (off-peak hours, OMIE every 15 minutes), so
// profile.js lays these out from the start time to know which kWh fall when.
export function estimateSession(point, car, t = translator('en')) {
  const assumptions = [];
  const target = car.targetPct ?? DEFAULTS.targetPct;
  const toBattery = batteryKwhNeeded({ ...car, targetPct: target });
  const eff = point.dc ? DEFAULTS.dcEfficiency : DEFAULTS.acEfficiency;
  const kwh = toBattery / eff;
  assumptions.push(t('assume.losses', { pct: Math.round((1 - eff) * 100), kind: point.dc ? 'DC' : 'AC' }));

  // The session runs at the slower of car and charger.
  let carKw = point.dc ? car.dcKw : car.acKw;
  const dcKnown = point.dc && (car.curve?.length >= 2 || car.dc10to80Minutes);
  if (carKw == null && dcKnown) carKw = Infinity; // the curve / 10-80 % time already carry the car's limit
  else if (carKw == null) {
    carKw = point.dc ? DEFAULTS.carDcKw : DEFAULTS.carAcKw;
    assumptions.push(t('assume.carLimitUnknown', { kind: point.dc ? 'DC' : 'AC', kw: carKw }));
  }
  // On DC, the socket's amps at the car's battery voltage can be well under
  // its nameplate (socket.js): that, not the nameplate, caps the session.
  const forCar = kwForCar(point, car.volts);
  const socketKw = forCar?.kw ?? point.kw;
  const chargerKw = socketKw ?? (Number.isFinite(carKw) ? carKw : DEFAULTS.carDcKw);
  if (socketKw == null) assumptions.push(t('assume.chargerKwUnknown'));
  // Said only when it's what slows the session, not the car.
  else if (forCar?.limited && forCar.kw < carKw) assumptions.push(t('assume.kwForCar', { kw: forCar.kw, nameplate: point.kw, amps: point.a, volts: forCar.volts, carVolts: car.volts }));
  if (forCar?.boosted) assumptions.push(t('assume.boosted', { volts: point.v, carVolts: car.volts }));
  const peak = Math.min(chargerKw, carKw);

  let minutes;
  const segments = [];
  if (point.dc && car.curve?.length >= 2) {
    // The curve is battery-side power, so time uses battery kWh, not billed.
    const pts = [...car.curve].sort((a, b) => a.soc - b.soc);
    minutes = 0;
    for (let s = car.startPct; s < target; s += 1) {
      const step = Math.min(1, target - s);
      const kw = Math.max(1, Math.min(curveKwAt(pts, s + step / 2), chargerKw));
      const m = car.batteryKwh * step / 100 / kw * 60;
      minutes += m;
      segments.push({ minutes: m, kwh: car.batteryKwh * step / 100 / eff });
    }
    assumptions.push(t('assume.curve', { kw: chargerKw }));
  } else if (point.dc) {
    let below, above;
    if (car.dc10to80Minutes) {
      // 10 -> 80 % is 70 % of the battery: that energy over the published
      // time is the car's real average power on a fast enough charger, at the
      // battery. The split below works in billed kWh and the charger's limit
      // is at the meter too, so this goes up by the losses to the meter's
      // side: billed kWh / this power gives back the published time.
      const carAvg = car.batteryKwh * 0.7 / (car.dc10to80Minutes / 60) / eff;
      below = Math.min(carAvg, chargerKw * DEFAULTS.chargerShare);
      above = Math.min(carAvg * DEFAULTS.dcShareAbove80 / DEFAULTS.dcShareBelow80, chargerKw * DEFAULTS.chargerShare);
      assumptions.push(t('assume.dc1080', { below: Math.round(below), mins: car.dc10to80Minutes, capped: below < carAvg, above: Math.round(above) }));
    } else {
      below = peak * DEFAULTS.dcShareBelow80;
      above = peak * DEFAULTS.dcShareAbove80;
      assumptions.push(t('assume.dcGeneric', { shareBelow: Math.round(DEFAULTS.dcShareBelow80 * 100), peak, shareAbove: Math.round(DEFAULTS.dcShareAbove80 * 100) }));
    }
    // Split the session at 80 % and charge each part at its average power.
    const share = Math.max(0, Math.min(target, 80) - car.startPct) / (target - car.startPct || 1);
    const m1 = kwh * share / below * 60, m2 = kwh * (1 - share) / above * 60;
    minutes = m1 + m2;
    segments.push({ minutes: m1, kwh: kwh * share }, { minutes: m2, kwh: kwh * (1 - share) });
  } else {
    minutes = kwh / (peak * DEFAULTS.acShare) * 60;
    segments.push({ minutes, kwh });
    assumptions.push(t('assume.acAverage', { share: Math.round(DEFAULTS.acShare * 100), peak: t.num(peak, 1) }));
  }
  if (!(toBattery > 0)) { minutes = 0; segments.length = 0; }
  return {
    kwh, batteryKwh: toBattery, minutes, peakKw: Number.isFinite(peak) ? peak : chargerKw, targetPct: target, assumptions,
    segments: segments.filter(x => x.kwh > 0 && x.minutes > 0),
  };
}
