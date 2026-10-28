// How much energy a session bills and how long it takes.
//
// This is an estimate, and every assumption is returned with the result so the
// agent can say it out loud. Real sessions depend on the car's charging curve,
// battery temperature and how many cars share the charger.

export const DEFAULTS = {
  targetPct: 80,
  // Losses between the meter and the battery. AC goes through the car's
  // on-board charger, which loses more than a DC charger's rectifier.
  acEfficiency: 0.88,
  dcEfficiency: 0.93,
  // Used only when the agent couldn't find the car's limits.
  carAcKw: 11,
  carDcKw: 100,
  // DC power falls as the battery fills. Average power as a share of the peak
  // the car and charger can agree on, below and above 80 % state of charge.
  dcShareBelow80: 0.7,
  dcShareAbove80: 0.3,
  // AC power stays almost flat until the very end.
  acShare: 0.95,
  // A charger rarely delivers its full nameplate power for a whole session.
  chargerShare: 0.95,
};

export function batteryKwhNeeded({ batteryKwh, startPct, targetPct = DEFAULTS.targetPct }) {
  return Math.max(0, batteryKwh * (targetPct - startPct) / 100);
}

// point: { kw, dc, phases }
// car: { batteryKwh, startPct, targetPct, acKw, dcKw, dc10to80Minutes, curve: [{ soc, kw }] }
export function estimateSession(point, car) {
  const assumptions = [];
  const target = car.targetPct ?? DEFAULTS.targetPct;
  const toBattery = batteryKwhNeeded({ ...car, targetPct: target });
  const eff = point.dc ? DEFAULTS.dcEfficiency : DEFAULTS.acEfficiency;
  const kwh = toBattery / eff;
  assumptions.push(`${Math.round((1 - eff) * 100)}% charging losses (${point.dc ? 'DC' : 'AC'}), billed at the meter`);

  let carKw = point.dc ? car.dcKw : car.acKw;
  const dcKnown = point.dc && (car.curve?.length >= 2 || car.dc10to80Minutes);
  if (carKw == null && dcKnown) carKw = Infinity; // the curve/10-80 time carries the car's limit
  else if (carKw == null) {
    carKw = point.dc ? DEFAULTS.carDcKw : DEFAULTS.carAcKw;
    assumptions.push(`car's max ${point.dc ? 'DC' : 'AC'} power unknown, assumed ${carKw} kW`);
  }
  const chargerKw = point.kw ?? (Number.isFinite(carKw) ? carKw : DEFAULTS.carDcKw);
  if (point.kw == null) assumptions.push('charger power not published, assumed the car limit');
  const peak = Math.min(chargerKw, carKw);

  let minutes;
  if (point.dc && car.curve?.length >= 2) {
    // The car's own curve (kW at each SoC), capped by the charger. Integrated
    // in 1 % steps; the curve is battery-side power, so time uses battery kWh.
    const pts = [...car.curve].sort((a, b) => a.soc - b.soc);
    const kwAt = soc => {
      if (soc <= pts[0].soc) return pts[0].kw;
      for (let i = 1; i < pts.length; i++) {
        if (soc <= pts[i].soc) {
          const a = pts[i - 1], b = pts[i];
          return a.kw + (b.kw - a.kw) * (soc - a.soc) / (b.soc - a.soc);
        }
      }
      return pts.at(-1).kw;
    };
    minutes = 0;
    for (let s = car.startPct; s < target; s += 1) {
      const step = Math.min(1, target - s);
      const kw = Math.max(1, Math.min(kwAt(s + step / 2), chargerKw));
      minutes += car.batteryKwh * step / 100 / kw * 60;
    }
    assumptions.push(`duration from the car's charging curve, capped at the charger's ${chargerKw} kW`);
  } else if (point.dc) {
    // Average power below and above 80 %. With the car's published 10-80 %
    // time we know its real average; otherwise a share of the peak.
    let below, above;
    if (car.dc10to80Minutes) {
      const carAvg = car.batteryKwh * 0.7 / (car.dc10to80Minutes / 60);
      below = Math.min(carAvg, chargerKw * DEFAULTS.chargerShare);
      above = Math.min(carAvg * DEFAULTS.dcShareAbove80 / DEFAULTS.dcShareBelow80, chargerKw * DEFAULTS.chargerShare);
      assumptions.push(`DC average ${Math.round(below)} kW up to 80% (from the car's ${car.dc10to80Minutes} min 10-80% time${below < carAvg ? ', capped by the charger' : ''}), ${Math.round(above)} kW above`);
    } else {
      below = peak * DEFAULTS.dcShareBelow80;
      above = peak * DEFAULTS.dcShareAbove80;
      assumptions.push(`DC average ${Math.round(DEFAULTS.dcShareBelow80 * 100)}% of ${peak} kW up to 80%, ${Math.round(DEFAULTS.dcShareAbove80 * 100)}% above (generic curve)`);
    }
    // Split the session at 80 % and charge each part at its average power.
    const start = car.startPct;
    const share = Math.max(0, Math.min(target, 80) - start) / (target - start || 1);
    minutes = (kwh * share / below + kwh * (1 - share) / above) * 60;
  } else {
    minutes = kwh / (peak * DEFAULTS.acShare) * 60;
  }
  if (!(toBattery > 0)) minutes = 0;
  return { kwh, batteryKwh: toBattery, minutes, peakKw: Number.isFinite(peak) ? peak : chargerKw, targetPct: target, assumptions };
}
