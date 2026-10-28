// The MCP server: tools, the instructions the agent gets on connect, and the
// MCP Apps view that renders results inline in Claude/ChatGPT.
//
// Stateless by design: we store nothing about the user. Car, battery and
// favourite tariff live in the agent's memory and come in on every call.

import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { tariffs } from './ceme.js';
import { quotePoint, rank, tariffKey } from './quote.js';
import { viewHtml } from './view.js';

const VIEW_URI = 'ui://carrega/results.html';

export const INSTRUCTIONS = `Estimates what an EV charging session costs on Portugal's public network (MOBI.E): the CEME energy tariff + the charger operator (OPC) fee + taxes, and finds the cheapest charger near a place or along a route.

Before calling a cost tool, make sure you know (ask only for what you don't have or don't remember):
1. Where: the user's location (lat/lon), a town name, or a route (list of waypoints from origin to destination).
2. The car model. Look up its USABLE battery capacity in kWh and its max AC and DC charging power in kW yourself (web search or your knowledge); don't ask the user for these numbers unless you can't find them. Pass them as battery_kwh, car_ac_kw, car_dc_kw.
3. Current battery % (start_pct).
4. Target battery % (target_pct). Default 80 if the user doesn't say; above 80% DC charging gets slow and per-minute fees add up.
5. Whether they're in a hurry. The cheapest option is often a slow AC socket that takes hours; on a trip, pass max_minutes (e.g. 45) or dc_only.
6. Optional: their CEME tariff (the card/app they pay with). Call list_ceme_tariffs to resolve a name like "EDP" or "Via Verde" to a tariff_id. Without one, prices use the cheapest tariff available at each charger.
7. Optional: when they will charge (at, ISO 8601). Prices change between off-peak (vazio) and peak hours. Default is now.

This server stores nothing about the user. Remember the car, battery capacity, charging limits and favourite tariff yourself (if your app has memory) so you don't ask again next time.

When presenting results: give the total in euros and the duration, name the tariff used, and mention the main assumptions (charging losses, estimated duration, per-minute fees). Charger status comes from a periodic snapshot, not live: tell the user to confirm availability in their CEME app. Costs are estimates; the operator's and CEME's published prices on the day prevail.`;

const Car = {
  battery_kwh: z.number().positive().max(250).describe('Usable battery capacity in kWh (look it up from the car model)'),
  start_pct: z.number().min(0).max(100).describe('Current state of charge, %'),
  target_pct: z.number().min(1).max(100).default(80).describe('Target state of charge, % (default 80)'),
  car_ac_kw: z.number().positive().max(43).optional().describe("Car's max AC charging power, kW (on-board charger)"),
  car_dc_kw: z.number().positive().max(500).optional().describe("Car's max DC charging power, kW"),
  tariff_id: z.string().optional().describe("User's CEME tariff id from list_ceme_tariffs; omit to use the cheapest available"),
  at: z.string().datetime({ offset: true }).optional().describe('When the charge starts, ISO 8601 (default now)'),
};

const Where = {
  lat: z.number().min(30).max(43).optional().describe('Latitude of the user or search centre'),
  lon: z.number().min(-32).max(-6).optional().describe('Longitude of the user or search centre'),
  place: z.string().optional().describe('Town/municipality name, used when lat/lon are unknown (e.g. "Leiria")'),
  radius_km: z.number().positive().max(50).default(5).describe('Search radius around lat/lon or place'),
  route: z.array(z.object({ lat: z.number(), lon: z.number() })).min(2).max(200).optional()
    .describe('Waypoints from origin to destination; searches along this line instead of around a point'),
  corridor_km: z.number().positive().max(20).default(2).describe('Max distance from the route, km'),
};

const Filter = {
  min_kw: z.number().positive().optional().describe('Minimum charger power, kW'),
  connectors: z.array(z.enum(['T2', 'CCS', 'CHADEMO', 'SCHUKO'])).optional().describe('Acceptable plug types'),
  dc_only: z.boolean().optional().describe('Only DC (fast) chargers'),
};

const maxMinutes = z.number().positive().optional()
  .describe('Drop chargers whose estimated session takes longer than this. Slow AC sockets are often cheapest but take hours; set this when the user is on a trip or in a hurry.');

const car = a => ({ batteryKwh: a.battery_kwh, startPct: a.start_pct, targetPct: a.target_pct, acKw: a.car_ac_kw, dcKw: a.car_dc_kw });

const err = msg => ({ isError: true, content: [{ type: 'text', text: msg }] });
const ok = (data, text) => ({ structuredContent: data, content: [{ type: 'text', text: text ?? JSON.stringify(data) }] });

function resolveWhere(ds, a) {
  if (a.route) return { route: a.route, corridorKm: a.corridor_km };
  if (a.lat != null && a.lon != null) return { near: { lat: a.lat, lon: a.lon }, radiusKm: a.radius_km };
  if (a.place) {
    const p = ds.resolvePlace(a.place);
    if (!p) return { error: `No chargers found in a place called "${a.place}". Pass lat/lon instead.` };
    return { near: p, radiusKm: a.radius_km, resolvedPlace: { name: a.place, lat: p.lat, lon: p.lon } };
  }
  return { error: 'Give lat+lon, place, or route.' };
}

const rnd = x => x == null ? undefined : Math.round(x * 10) / 10;

const meta = ds => ({ dataAsOf: ds.generatedAt, statusSnapshot: ds.statusSnapshot });

export function createServer(ds) {
  const server = new McpServer({ name: 'carrega', title: 'Carrega: EV charging costs in Portugal', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('list_ceme_tariffs', {
    title: 'List CEME tariffs',
    description: 'Lists the CEME (EV charging electricity retailer) tariffs on MOBI.E, to resolve the card/app the user pays with to a tariff_id. Filter by name.',
    inputSchema: z.object({ query: z.string().optional().describe('Text to match in the CEME or tariff name, e.g. "edp", "galp", "via verde"') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query }) => {
    const all = await tariffs();
    const q = (query || '').toLowerCase();
    // One row per tariff, not per voltage: the BT/MT variant is picked per charger.
    const seen = new Map();
    for (const t of all.data ?? all) {
      const key = tariffKey(t.id);
      const name = `${t.ceme_name ?? t.ceme} ${t.name}`;
      if (q && !name.toLowerCase().includes(q)) continue;
      if (!seen.has(key)) seen.set(key, { tariff_id: t.id, ceme: t.ceme_name ?? t.ceme, name: t.name, kind: t.kind, schedule: t.schedule, cycle: t.cycle, requiresOtherContract: !!t.bundle });
    }
    const rows = [...seen.values()];
    return ok({ count: rows.length, tariffs: rows.slice(0, 60) });
  });

  server.registerTool('find_chargers', {
    title: 'Find chargers',
    description: 'Finds public EV charge points near a location or along a route, with power, plug type and the operator fee. No cost estimate; use find_cheapest_charging for that.',
    inputSchema: z.object({ ...Where, ...Filter, limit: z.number().int().positive().max(50).default(15) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async a => {
    const w = resolveWhere(ds, a);
    if (w.error) return err(w.error);
    const { total, results } = ds.search({ ...w, minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only, limit: a.limit });
    return ok({
      ...meta(ds), resolvedPlace: w.resolvedPlace, total,
      sites: results.map(r => ({
        siteId: r.site.id, code: r.site.code, operator: r.site.operator, address: r.site.address, city: r.site.city,
        lat: r.site.lat, lon: r.site.lon, km: rnd(r.km), offRouteKm: rnd(r.offRouteKm), alongKm: rnd(r.alongKm),
        points: r.points.map(p => ({ pointId: p.id, kw: p.kw, connector: p.connector, dc: p.dc, regime: p.regime, statusAtSnapshot: p.status })),
      })),
    });
  });

  registerAppTool(server, 'find_cheapest_charging', {
    title: 'Find cheapest charging',
    description: 'Ranks chargers near a location or along a route by the estimated total cost of the session (energy + operator fee + taxes), for the user\'s car and battery levels.',
    inputSchema: z.object({ ...Where, ...Filter, ...Car, max_minutes: maxMinutes, limit: z.number().int().positive().max(30).default(10) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI } },
  }, async a => {
    const w = resolveWhere(ds, a);
    if (w.error) return err(w.error);
    if (a.target_pct <= a.start_pct) return err('target_pct must be above start_pct.');
    const { total, results } = ds.search({ ...w, minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only, limit: Infinity });
    if (!results.length) return err('No chargers match. Widen radius_km/corridor_km or relax the filters.');
    const ranked = await rank(results, car(a), { at: a.at ? new Date(a.at) : undefined, tariffId: a.tariff_id, maxMinutes: a.max_minutes });
    if (!ranked.length) return err(`No charger here can do it in ${a.max_minutes} min. Raise max_minutes or widen the search.`);
    const top = ranked.slice(0, a.limit);
    for (const q of top) { q.km = rnd(q.km); q.offRouteKm = rnd(q.offRouteKm); q.alongKm = rnd(q.alongKm); }
    const data = { kind: 'ranking', ...meta(ds), resolvedPlace: w.resolvedPlace, searched: total, results: top };
    const lines = top.map((q, i) => `${i + 1}. ${q.total ? (q.total.complete ? '' : '>= ') + q.total.eur.toFixed(2) + ' €' : 'n/a'} · ${q.session.minutes} min · ${q.operator ?? ''} ${q.address ?? ''}, ${q.city ?? ''} (${q.kw} kW ${q.connector}) [${q.pointId}]`);
    return ok(data, `${lines.join('\n')}\n\n${JSON.stringify(data)}`);
  });

  registerAppTool(server, 'estimate_charging_cost', {
    title: 'Estimate charging cost',
    description: 'Estimated cost and duration of a session at one charge point (point_id from find_chargers / find_cheapest_charging), with the full breakdown.',
    inputSchema: z.object({ point_id: z.string().describe('Charge point id, e.g. "LSB-01482-1"'), ...Car }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI } },
  }, async a => {
    const hit = ds.pointById.get(a.point_id);
    if (!hit) return err(`Unknown point_id ${a.point_id}. Use find_chargers to get ids.`);
    if (a.target_pct <= a.start_pct) return err('target_pct must be above start_pct.');
    const q = await quotePoint(hit, car(a), { at: a.at ? new Date(a.at) : undefined, tariffId: a.tariff_id });
    return ok({ kind: 'single', ...meta(ds), results: [q] });
  });

  registerAppResource(server, 'Charging results', VIEW_URI, {
    description: 'Inline view of charging cost results',
  }, async () => ({
    contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: await viewHtml(), _meta: { ui: { prefersBorder: true } } }],
  }));

  return server;
}
