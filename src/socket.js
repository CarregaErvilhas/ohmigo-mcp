// What a driver has to know about one socket before plugging in: which plug
// it takes, and which grid it hangs from (BT or MT).
//
// The plug: the dataset says "CCS", "T2", "CHADEMO"... (nap-dashboard maps
// the NAP's DATEX II names to these). A driver needs more than the code: a
// Type 2 socket with no cable means bringing their own cable, and a CHAdeMO
// plug only fits cars that have that port, and which port a car has depends
// on its exact version (the Nissan Leaf had CHAdeMO until the 2026 one, which
// has CCS2). So every answer carries `plug`, one
// sentence that says what to plug in.
//
// The grid: MOBI.E publishes each socket's voltage level, BTN/BTE (low
// voltage) or MT (medium voltage). It's not the socket's volts: it's how the
// charger is connected to the grid, and it picks the TAR (network access
// tariff) the CEME bills, BT or MT, so the same CEME tariff costs less at an
// MT charger. Outside MOBI.E (sem_ceme) there's no CEME and no TAR: the
// operator's price is the price, so no grid is shown.

import { tariffVoltage } from './ceme.js';

// Plug codes the dataset uses that the sentences know. Anything else (the NAP
// leaves some blank, which arrives as "nan") reads as unknown.
const PLUGS = new Set(['CCS', 'CCS1', 'T2', 'T1', 'CHADEMO', 'SCHUKO', 'CEE']);
// AC sockets where the cable matters: with no cable attached, the driver
// brings their own.
const CABLE_MATTERS = new Set(['T2', 'T1']);

// The sentence that says which plug to use at this socket.
export function plugLabel(point, t) {
  const c = PLUGS.has(point.connector) ? point.connector : null;
  if (!c) return t('plug.unknown');
  const base = t(`plug.${c}`);
  if (!CABLE_MATTERS.has(c) || point.cable == null) return base;
  return `${base}, ${t(point.cable ? 'plug.cableAttached' : 'plug.bringCable')}`;
}

// The grid a MOBI.E socket is connected to, and the TAR that follows:
// { level: "BTN" | "BTE" | "MT" | null, tar: "BT" | "MT", gridLabel }.
// Nothing outside MOBI.E.
export function gridOf(point, t) {
  if (point.regime === 'sem_ceme') return {};
  const tar = tariffVoltage(point.level);
  const known = ['BTN', 'BTE', 'MT'].includes(point.level) ? point.level : point.level === 'BT' ? 'BT' : null;
  return { level: point.level ?? undefined, tar, gridLabel: t(known ? `grid.${known}` : 'grid.unknown') };
}

// The power a DC socket can give one car, from the car's battery voltage.
//
// A DC charger's nameplate kW is what it gives at the top of its voltage
// range. What reaches the car is volts × amps, and the volts are the car's
// battery's: about 400 V for most cars, about 800 V for some (Porsche Taycan,
// Hyundai Ioniq 5, Kia EV6...). The amps are capped by the charger and its
// cable. So a 400 kW socket rated 600 A gives a 400 V car at most
// 600 A × 400 V = 240 kW, while an 800 V car can take the full 400 kW.
// The socket can't go above its own max voltage either: an 800 V car on a
// 500 V charger only charges because the car steps the voltage up (a
// "booster", which most 800 V cars have), at the charger's volts.
//
// AC is different: the car's on-board charger converts, and car_ac_kw is
// already its limit. So only DC, and only when the socket's amps are known.
// -> { kw, limited, volts, boosted } or null.
export function kwForCar(point, carVolts) {
  if (!point.dc || !(carVolts > 0) || !(point.a > 0)) return null;
  const volts = point.v > 0 ? Math.min(point.v, carVolts) : carVolts;
  const byAmps = Math.round(point.a * volts / 100) / 10;
  const limited = point.kw == null || byAmps < point.kw;
  return { kw: limited ? byAmps : point.kw, limited, volts, boosted: point.v > 0 && point.v < carVolts };
}

// The kW a filter or an ordering should use: the car's, when it applies.
export const usableKw = (point, carVolts) => kwForCar(point, carVolts)?.kw ?? point.kw;
