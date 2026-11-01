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
