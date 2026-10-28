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
};

export function batteryKwhNeeded({ batteryKwh, startPct, targetPct = DEFAULTS.targetPct }) {
  return Math.max(0, batteryKwh * (targetPct - startPct) / 100);
}

// point: { kw, dc, phases }. car: { batteryKwh, startPct, targetPct, acKw, dcKw }
export function estimateSession(point, car) {
  const assumptions = [];
  const target = car.targetPct ?? DEFAULTS.targetPct;
  const toBattery = batteryKwhNeeded({ ...car, targetPct: target });
  const eff = point.dc ? DEFAULTS.dcEfficiency : DEFAULTS.acEfficiency;
  const kwh = toBattery / eff;
  assumptions.push(`${Math.round((1 - eff) * 100)}% charging losses (${point.dc ? 'DC' : 'AC'}), billed at the meter`);

  let carKw = point.dc ? car.dcKw : car.acKw;
  if (carKw == null) {
    carKw = point.dc ? DEFAULTS.carDcKw : DEFAULTS.carAcKw;
    assumptions.push(`car's max ${point.dc ? 'DC' : 'AC'} power unknown, assumed ${carKw} kW`);
  }
  const chargerKw = point.kw ?? carKw;
  if (point.kw == null) assumptions.push('charger power not published, assumed the car limit');
  const peak = Math.min(chargerKw, carKw);

  let minutes;
  if (point.dc) {
    // Split the session at 80 % and charge each part at its average power.
    const start = car.startPct;
    const below = Math.max(0, Math.min(target, 80) - start) / (target - start || 1);
    minutes = (kwh * below / (peak * DEFAULTS.dcShareBelow80) + kwh * (1 - below) / (peak * DEFAULTS.dcShareAbove80)) * 60;
    assumptions.push(`DC average ${Math.round(DEFAULTS.dcShareBelow80 * 100)}% of ${peak} kW up to 80%, ${Math.round(DEFAULTS.dcShareAbove80 * 100)}% above`);
  } else {
    minutes = kwh / (peak * DEFAULTS.acShare) * 60;
  }
  if (!(toBattery > 0)) minutes = 0;
  return { kwh, batteryKwh: toBattery, minutes, peakKw: peak, targetPct: target, assumptions };
}
