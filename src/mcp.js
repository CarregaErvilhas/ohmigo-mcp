// The MCP server itself: the tools an AI assistant can call, the instructions
// it reads when it connects, and the inline results view.
//
// MCP (Model Context Protocol) in one paragraph: an assistant like ChatGPT or
// Claude connects to this server, reads `INSTRUCTIONS` and the list of tools
// (name + description + JSON schema of the arguments), and then decides on
// its own when to call them. A tool call is a JSON-RPC request; we answer with
// `structuredContent` (JSON for the assistant to read) plus a short text
// version. The schemas below are written as much for the assistant as for the
// code: the `.describe()` text is what tells it what to send.
//
// MCP Apps: two tools also point at a `ui://` HTML resource (ui/results.html).
// Chat apps that support it render that page inline, next to the answer.
//
// Stateless by design: we store nothing about the user. Car, battery and
// tariffs live in the assistant's memory and come in on every call.

import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { tariffs } from './ceme.js';
import { haversineKm } from './data.js';
import { pickLang, translator } from './i18n.js';
import { napPlan } from './live.js';
import { offersAt } from './offers.js';
import { describePlan } from './opc.js';
import { byBest, quotePoint, rank, tariffKey } from './quote.js';
import { viewHtml } from './view.js';

const VIEW_URI = 'ui://ohmigo/results.html';

// Read once by the assistant when it connects. It's a prompt, not docs: it
// tells the assistant what to ask the user, what to look up itself, and how to
// present the results honestly.
export const INSTRUCTIONS = `Estimates what an EV charging session costs at any public charger in Portugal, on every network published on the NAP (National Access Point, "PAN" in Portuguese): MOBI.E chargers (CEME energy tariff + charger operator (OPC) fee + taxes) and chargers outside MOBI.E (Tesla, Continente...) paid to the operator directly. Finds the cheapest charger near a place or along a route.

Language: always answer the user in the language they write in. Pass lang with their language (e.g. "pt" or "en") on every call; the server's labels, assumptions and progress messages come back in Portuguese or English, and you translate them for any other language.

Who's who on MOBI.E (don't mix these up):
- CEME: who the user buys the energy from (their card/app). Sets the energy price.
- OPC (Operador de Ponto de Carregamento): the company that operates a PUBLIC charger (IONITY, Powerdot, Galp...). Charges the usage fee on top of the energy. Every charger this server returns has an OPC.
- DPC (Detentor de Ponto de Carregamento): the holder of a PRIVATE-access charger connected to MOBI.E: a home wallbox, a condominium garage, a company car park for its staff or fleet. It is not an operator, there is no OPC behind it and no OPC fee: the session costs only the CEME energy, the EGME fee and taxes. Only its owner's authorized users can charge there. DPC chargers are not in the public data (NAP), so this server never lists or prices them. "DPC" is not a kind of OPC, not a payment option and not a field in the results; don't call an OPC a DPC or the reverse. If the user charges at a DPC charger (home, work, condo), say that ohmigo can't price it and that the cost is their CEME tariff (list_ceme_tariffs shows it) without any operator fee.

Finding the charger the user means: nobody knows a charger's id, so never ask for one. When the user names a charger ("the Continente in Leiria", "IONITY Mealhada", "the Galp on the A1 at Pombal", "the charger at Lidl in Coimbra") or reads its code off the sticker ("LRA-00156"), call lookup_charger with their words as query, plus lat/lon if you know where they are. It returns what the NAP publishes about that site (every socket's power, plug and live status, the operator fee, the walk-up price, direct offers) and, in "osm", what the OpenStreetMap community mapped there: the place's name or the shop it's at (brand), opening hours, access, parking fee, "underground" car park. "operator" is who runs and bills the charger (from the NAP); osm.brand/osm.operator are often the shop or car park (a Galp charger at a Lidl), so don't mix them up, and credit OpenStreetMap when you use them. Each site's "missing" lists the user's words it lacks: if the best sites still miss some, say so instead of presenting them as the one the user meant, and ask or try fewer words. If several sites fit, list them briefly (operator, address, town) and ask which one. For the cost there, pass its siteId as site to estimate_charging_cost (point_id only when the user picked one socket).

Before calling a cost tool, make sure you know (ask only for what you don't have or don't remember):
1. Where: the user's location (lat/lon), a town name, or a route (list of waypoints from origin to destination); or the charger itself (above). For a place that isn't a town (a shopping centre, a street, a motorway service area), use its lat/lon from your own knowledge or a search; place only knows towns and addresses on the NAP.
2. The car model. Look up yourself (web search or your knowledge) its USABLE battery capacity (battery_kwh), max AC power (car_ac_kw), max DC power (car_dc_kw) and its published DC 10-80% charging time in minutes (dc_10_80_minutes), which makes the duration estimate far better than the generic curve. If you find the car's DC charging curve (kW at each state of charge), pass it as charge_curve. Don't ask the user for these numbers unless you can't find them.
3. Current battery % (start_pct).
4. Target battery % (target_pct). Default 80 if the user doesn't say; above 80% DC charging gets slow and per-minute fees add up.
5. Whether they're in a hurry. The cheapest option is often a slow AC socket that takes hours; on a trip, pass max_minutes (e.g. 45) or dc_only.
6. Optional: the CEME tariffs they have (the cards/apps/subscriptions they pay with; some users have several). Call list_ceme_tariffs to resolve names like "EDP" or "Via Verde" to tariff_ids and pass them all; each charger is priced with the cheapest of them. Without tariff_ids, results show the top 3 popular tariffs (tariffs_shown for more), headlined by the cheapest that needs no other contract.
7. Optional: when they will charge (at, ISO 8601). Prices change between off-peak (vazio) and peak hours. Default is now.

This server stores nothing about the user. Remember the car, its charging specs and the user's tariffs yourself (if your app has memory) so you don't ask again next time.

When presenting results: give the total in euros and the duration, name the tariff used, and mention the main assumptions (charging losses, estimated duration, per-minute fees). Each charger lists every way to pay in options:
- "ceme": a CEME card/app on MOBI.E;
- "adhoc": bank card / QR code at the charger, no CEME. Always mention it when present: it's what someone without a CEME card pays;
- "direct": paying outside the CEME system: a card terminal (TPA) or QR at the charger, the operator's own app or subscription (IONITY Power, Atlante GO...), or a roaming app (Electroverse, Elli, Electromaps...). Final prices with VAT, from a public price list (see note and checked date). Subscriptions show a monthly/yearly fee that is NOT included in the session total; say so. When you quote one of these prices, credit its source (named in the note): for the blog, name its author, Alexandre Moleiro. On Madeira and the Azores they carry vatUnverified: the list uses mainland VAT, so tell the user to confirm the price;
- "opc_direct": chargers outside MOBI.E (Continente, Tesla...), listed apart in outsideMobie. Their price is an asterisked guess, say so.
Chargers are ranked by "best": the cheapest option anyone can use now (no subscription, no other contract). Lead with it, and point out when a subscription or another CEME would be cheaper. Every result carries all its ways to pay in "options", usually more than you show: always tell the user there are more (subscriptions, other CEMEs, apps) and offer to list them.

Time of day matters: a session lasts minutes to hours, and the energy price can change while it runs (peak to off-peak "vazio" hours, the wholesale OMIE price every 15 minutes for indexed tariffs, even a clock change). The server prices the session quarter-hour by quarter-hour from its start (at, default now) to its estimated end; session.startLocal/endLocal give the window. A CEME option with kwhByPeriod crossed periods: mention it when it changes the picture (e.g. "starting 30 min later puts most of it in off-peak"). If the user asks how a price was built, or why it changes with the time, call again with detail: true and explain the timeline (each quarter-hour's kWh, period, price and OMIE).

Charger status comes from the NAP's live feed; live.publishedAt says when it was published. The feed is a large file fetched on demand, so the first call after a few quiet minutes can take ~20-30 s. If live.fresh is false or live.publishedAt is null, say status may be stale or unknown. A charger can still be taken by the time they arrive. Costs are estimates; the operator's and CEME's published prices on the day prevail.`;

// Argument schemas, shared by the tools. zod turns them into the JSON Schema
// the assistant sees, and validates what it sends back.
// QA mode (OHMIGO_QA=1, never in production): every result carries the
// timeline and a `debug` block with what was sent to ceme-v2 and what came
// back, and the assistant is told to show it. For testing and debugging.
export const QA = process.env.OHMIGO_QA === '1';
// In QA, show more tariffs per charger by default, to check more of the math.
const QA_SHOWN = 10;
const QA_NOTE = `

QA MODE: this is a test server. Results include "timeline" and "debug". When you answer, also show the session window, the per-quarter timeline of the headline tariff and anything in "debug" that looks wrong, so the tester can check the math. Each charger comes with up to ${QA_SHOWN} tariffs by default: list them all, not just the top 3.`;

const Detail = {
  detail: z.boolean().optional().describe('Include the quarter-hour timeline: when each kWh is delivered and, for each CEME tariff shown, its period (vazio/fora de vazio), price and OMIE per quarter. Use when the user asks how the price was built.'),
};

const Lang = {
  lang: z.string().max(20).optional().describe('The user\'s language, e.g. "pt", "pt-PT", "en". Portuguese gets Portuguese text; anything else English.'),
};

const Car = {
  battery_kwh: z.number().positive().max(250).describe('Usable battery capacity in kWh (look it up from the car model)'),
  start_pct: z.number().min(0).max(100).describe('Current state of charge, %'),
  target_pct: z.number().min(1).max(100).default(80).describe('Target state of charge, % (default 80)'),
  car_ac_kw: z.number().positive().max(43).optional().describe("Car's max AC charging power, kW (on-board charger)"),
  car_dc_kw: z.number().positive().max(500).optional().describe("Car's max DC charging power, kW"),
  dc_10_80_minutes: z.number().positive().max(300).optional().describe("Car's published DC 10-80% charging time, minutes"),
  charge_curve: z.array(z.object({ soc: z.number().min(0).max(100), kw: z.number().positive().max(500) })).min(2).max(101).optional()
    .describe("Car's DC charging curve: power (kW) at state of charge (%), e.g. [{soc:10,kw:150},{soc:50,kw:110},{soc:80,kw:60}]"),
  tariff_ids: z.array(z.string()).max(20).optional().describe("The user's CEME tariff ids from list_ceme_tariffs; omit to show the top popular ones"),
  tariffs_shown: z.number().int().min(1).max(20).default(QA ? QA_SHOWN : 3).describe('Without tariff_ids: how many popular tariffs to show per charger'),
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
  query: z.string().max(200).optional().describe('Only chargers whose operator, brand, name or address matches these words, e.g. "IONITY", "Continente", "Lidl". A town in it is used as the place when no lat/lon/place/route is given'),
};

const Filter = {
  min_kw: z.number().positive().optional().describe('Minimum charger power, kW'),
  connectors: z.array(z.enum(['T2', 'CCS', 'CHADEMO', 'SCHUKO'])).optional().describe('Acceptable plug types'),
  dc_only: z.boolean().optional().describe('Only DC (fast) chargers'),
};

const maxMinutes = z.number().positive().optional()
  .describe('Drop chargers whose estimated session takes longer than this. Slow AC sockets are often cheapest but take hours; set this when the user is on a trip or in a hurry.');

const car = a => ({
  batteryKwh: a.battery_kwh, startPct: a.start_pct, targetPct: a.target_pct,
  acKw: a.car_ac_kw, dcKw: a.car_dc_kw, dc10to80Minutes: a.dc_10_80_minutes, curve: a.charge_curve,
});

const err = msg => ({ isError: true, content: [{ type: 'text', text: msg }] });
const ok = (data, text) => ({ structuredContent: data, content: [{ type: 'text', text: text ?? JSON.stringify(data) }] });

// The language for this call: the `lang` argument, else the locale some
// clients put in the request metadata (ChatGPT sends "openai/locale").
const langOf = (a, ctx) => pickLang(a.lang, ctx?.mcpReq?._meta?.['openai/locale']);

function resolveWhere(ds, a, t) {
  // A text filter: the sites the words describe ("IONITY"), searched only
  // where the other arguments say.
  let only, town;
  if (a.query) {
    const r = ds.lookup(a.query, { limit: Infinity });
    const full = r.results.filter(h => !h.missing?.length);
    if (!full.length) return { error: t('err.lookup', { query: a.query }) };
    only = new Set(full.map(h => h.site.id));
    town = r.town;
  }
  if (a.route) return { route: a.route, corridorKm: a.corridor_km, only };
  if (a.lat != null && a.lon != null) return { near: { lat: a.lat, lon: a.lon }, radiusKm: a.radius_km, only };
  const name = a.place ?? town;
  if (name) {
    const p = ds.resolvePlace(name);
    if (!p) return { error: t('err.place', { place: name }) };
    return { near: p, radiusKm: a.radius_km, only, resolvedPlace: { name, lat: p.lat, lon: p.lon } };
  }
  return { error: t('err.where') };
}

// Everything the data says about one site, for lookup_charger. Sockets that
// are the same (power, plug, fee) are grouped, with a count per live status:
// a car park with 10 identical T2s reads as one line, not ten.
function siteCard(h, live, t) {
  const { site } = h;
  const groups = new Map();
  for (const p of h.points) {
    const lp = live.get(site.id, p.id);
    const fee = p.opc?.REGULAR ?? (lp && napPlan(lp.fees));
    const card = {
      kw: p.kw, connector: p.connector, dc: p.dc, level: p.level ?? undefined, regime: p.regime,
      operatorFee: fee ? describePlan(fee, t) : undefined,
      operatorFeeSource: fee ? (p.opc?.REGULAR ? 'mobie' : 'nap') : undefined,
      adHoc: p.opc?.AD_HOC_PAYMENT ? describePlan(p.opc.AD_HOC_PAYMENT, t, { vat: false }) : undefined,
      napPrice: p.regime === 'sem_ceme' ? (lp?.fees.find(f => f.policy === 'pricePerDeliveryUnit')?.eur ?? p.napPrice) : undefined,
      direct: offersAt(site, p).map(({ offer, eurPerKwh }) => ({ label: offer.label, eurPerKwh, walkUp: !!offer.walkUp || undefined, subscription: !!offer.subscription || undefined })),
    };
    const key = JSON.stringify(card);
    if (!groups.has(key)) groups.set(key, { ...card, count: 0, status: {}, pointIds: [] });
    const g = groups.get(key);
    const status = lp?.status ?? 'unknown';
    g.count++;
    g.status[status] = (g.status[status] || 0) + 1;
    g.pointIds.push(`${site.id}/${p.id}`);
    // The socket number the user read off the charger ("LRA-00156-02").
    if (h.socket != null && Number(p.id.split(/[-.]/).pop()) === h.socket) g.named = true;
  }
  return {
    siteId: site.id, code: site.code, operator: site.operator, operatorId: site.operatorId ?? undefined,
    website: site.website ?? undefined, address: site.address, city: site.city, region: site.region,
    lat: site.lat, lon: site.lon, km: rnd(h.km), matched: h.matched, missing: h.missing?.length ? h.missing : undefined,
    payment: site.payment?.length ? site.payment : undefined,
    osm: site.osm,
    sockets: [...groups.values()].sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0) || (b.kw ?? 0) - (a.kw ?? 0)),
  };
}

const rnd = x => x == null ? undefined : Math.round(x * 10) / 10;

const meta = (ds, live, lang) => ({ lang, dataAsOf: ds.generatedAt, live: live.info(), ...(QA && { qa: true }) });

// Brings live status up to date before answering. If that means downloading
// the feed, tell the client why the answer is taking a while: a progress
// notification, which chat apps show as a status line (only when the client
// asked for progress by sending a progressToken).
async function withLive(live, ctx, t) {
  const token = ctx?.mcpReq?._meta?.progressToken;
  await live.ensure({
    onWait: () => token != null && ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken: token, progress: 0, message: t('progress.live') },
    }).catch(() => {}),
  });
}

// The sockets estimate_charging_cost prices: the one point_id, or one of each
// kind at the place (same power, plug and fee price the same, so 10 identical
// T2s are quoted once; MAX_KINDS cheapest are returned). Live status picks
// which of the identical ones shows: a free one if there is one.
const MAX_KINDS = 8;
// JSON with object keys sorted: the dataset lists a socket's plans in no
// fixed order, and two sockets with the same fees must give the same key.
const canonical = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const SAME_PLACE_KM = 0.25;
function pointsFor(ds, live, a, t) {
  if (a.point_id) {
    const hit = ds.findPoint(a.point_id);
    if (hit) return [hit];
    if (!a.site) return { error: t('err.point', { id: a.point_id }) };
  }
  if (!a.site) return { error: t('err.which') };
  const r = ds.lookup(a.site, { limit: Infinity, minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only });
  if (!r.results.length || r.results[0].missing?.length) return { error: t('err.lookup', { query: a.site }) };
  // Several sites in the same spot are one place to the driver: a motorway
  // service area often has one NAP site per charger. Words can fit several
  // places; then the assistant has to ask which.
  const places = [];
  for (const h of r.results) {
    const place = places.find(pl => haversineKm(pl[0].site, h.site) <= SAME_PLACE_KM);
    if (place) place.push(h); else places.push([h]);
  }
  if (places.length > 1) {
    const list = places.slice(0, 6).map(([h, ...more]) => `${h.site.id}${more.length ? ` (+${more.length})` : ''}: ${h.site.operator ?? ''}, ${h.site.address ?? ''}, ${h.site.city ?? ''} (${h.site.lat}, ${h.site.lon})`).join('\n');
    return { error: `${t('err.several', { query: a.site, n: places.length })}\n${list}` };
  }
  const sites = places[0];
  // An id or code names one site. Its operator's other sites in the same
  // spot are the rest of that station, so they come too, unless the user
  // named one socket.
  if (sites.length === 1 && sites[0].score === Infinity && sites[0].socket == null && sites[0].site.operatorId) {
    const [h] = sites;
    const ok = ds.pointFilter({ minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only });
    for (const site of ds.sites) {
      if (site === h.site || site.operatorId !== h.site.operatorId || haversineKm(site, h.site) > SAME_PLACE_KM) continue;
      const points = site.points.filter(ok);
      if (points.length) sites.push({ site, points });
    }
  }
  const free = (site, p) => live.get(site.id, p.id)?.status === 'available';
  const kinds = new Map();
  for (const h of sites) {
    let points = h.points;
    if (h.socket != null) {
      const named = points.filter(p => Number(p.id.split(/[-.]/).pop()) === h.socket);
      if (named.length) points = named;
    }
    for (const point of points) {
      const key = canonical([point.kw, point.connector, point.dc, point.level, point.regime, point.opc, point.napPrice, h.site.operatorId]);
      const cur = kinds.get(key);
      if (!cur || (!free(cur.site, cur.point) && free(h.site, point))) kinds.set(key, { site: h.site, point });
    }
  }
  return [...kinds.values()];
}

// `getDataset` instead of the dataset itself: server.js swaps in a fresh copy
// every few hours, and each request should see the current one.
export function createServer(getDataset, live) {
  const server = new McpServer({ name: 'ohmigo', title: 'Ohmigo: EV charging costs in Portugal', version: '0.1.0' }, { instructions: INSTRUCTIONS + (QA ? QA_NOTE : '') });

  server.registerTool('list_ceme_tariffs', {
    title: 'List CEME tariffs',
    description: 'Lists the CEME (EV charging electricity retailer) tariffs used on MOBI.E chargers, to resolve the card/app the user pays with to a tariff_id. Filter by name.',
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

  server.registerTool('lookup_charger', {
    title: 'Look up a charger',
    description: 'Finds a specific charger the way the user names it: the code on its sticker ("LRA-00156"), operator or brand plus town ("Continente Leiria", "IONITY Mealhada"), the shop or place it is at, or its address. Returns everything published about it: each socket\'s power, plug, live status, operator fee, walk-up (ad hoc) price and direct offers, plus OpenStreetMap details. Use its siteId as site in estimate_charging_cost.',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('What the user calls the charger, in their words: code, operator/brand, place, town, address'),
      lat: Where.lat, lon: Where.lon,
      radius_km: z.number().positive().max(300).optional().describe('With lat/lon: only sites this close'),
      ...Filter, ...Lang,
      limit: z.number().int().positive().max(20).default(5),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    const near = a.lat != null && a.lon != null ? { lat: a.lat, lon: a.lon } : undefined;
    const r = ds.lookup(a.query, { near, radiusKm: a.radius_km, limit: a.limit, minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only });
    if (!r.results.length) return err(t('err.lookup', { query: a.query }));
    await withLive(live, ctx, t);
    return ok({
      ...meta(ds, live, lang), query: a.query, total: r.total,
      note: r.results[0].missing?.length ? t('note.partial', { words: r.results[0].missing.join(', ') }) : undefined,
      orderedFrom: near ? undefined : r.town,
      sites: r.results.map(h => siteCard(h, live, t)),
      // OpenStreetMap's licence (ODbL) asks for this wherever its data shows.
      credit: r.results.some(h => h.site.osm) ? t('credit.osm') : undefined,
    });
  });

  server.registerTool('find_chargers', {
    title: 'Find chargers',
    description: 'Finds public EV charge points near a location or along a route, with power, plug type and live status. No cost estimate; use find_cheapest_charging for that. For one charger the user names, use lookup_charger.',
    inputSchema: z.object({ ...Where, ...Filter, ...Lang, limit: z.number().int().positive().max(50).default(15) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    const w = resolveWhere(ds, a, t);
    if (w.error) return err(w.error);
    const { total, results } = ds.search({ ...w, minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only, limit: a.limit });
    if (!results.length) return err(t('err.noMatch'));
    await withLive(live, ctx, t);
    return ok({
      ...meta(ds, live, lang), resolvedPlace: w.resolvedPlace, total,
      sites: results.map(r => ({
        siteId: r.site.id, code: r.site.code, operator: r.site.operator, address: r.site.address, city: r.site.city,
        place: r.site.osm?.name ?? r.site.osm?.brand,
        lat: r.site.lat, lon: r.site.lon, km: rnd(r.km), offRouteKm: rnd(r.offRouteKm), alongKm: rnd(r.alongKm),
        points: r.points.map(p => ({
          pointId: `${r.site.id}/${p.id}`, kw: p.kw, connector: p.connector, dc: p.dc, regime: p.regime,
          status: live.get(r.site.id, p.id)?.status ?? null, adHocPayment: !!p.opc?.AD_HOC_PAYMENT,
        })),
      })),
    });
  });

  registerAppTool(server, 'find_cheapest_charging', {
    title: 'Find cheapest charging',
    description: 'Ranks chargers near a location or along a route by the estimated total cost of the session (energy + operator fee + taxes), for the user\'s car and battery levels. Every charger lists all the ways to pay.',
    inputSchema: z.object({
      ...Where, ...Filter, ...Car, ...Detail, ...Lang, max_minutes: maxMinutes,
      available_only: z.boolean().default(true).describe('Skip chargers the live feed reports as charging, out of order or blocked'),
      limit: z.number().int().positive().max(30).default(10),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI } },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    const w = resolveWhere(ds, a, t);
    if (w.error) return err(w.error);
    if (a.target_pct <= a.start_pct) return err(t('err.target'));
    await withLive(live, ctx, t);
    const { total, results } = ds.search({ ...w, minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only, limit: Infinity });
    if (!results.length) return err(t('err.noMatch'));
    const { mobie, outsideMobie } = await rank(results, car(a), {
      at: a.at ? new Date(a.at) : undefined, tariffIds: a.tariff_ids, shown: a.tariffs_shown, live, lang,
      maxMinutes: a.max_minutes, availableOnly: a.available_only, detail: !!a.detail, qa: QA,
    });
    if (!mobie.length && !outsideMobie.length) return err(t('err.noneLeft'));
    const top = mobie.slice(0, a.limit);
    const outside = outsideMobie.slice(0, 3);
    for (const q of [...top, ...outside]) { q.km = rnd(q.km); q.offRouteKm = rnd(q.offRouteKm); q.alongKm = rnd(q.alongKm); }
    const data = { kind: 'ranking', ...meta(ds, live, lang), resolvedPlace: w.resolvedPlace, searched: total, results: top, outsideMobie: outside };
    // The text version, for clients that ignore structuredContent.
    const lines = top.map((q, i) => `${i + 1}. ${q.best ? q.best.total.toFixed(2) + ' € · ' + q.best.label + (q.options?.length > 1 ? ` (+${q.options.length - 1} more ways to pay)` : '') : q.total ? '>= ' + q.total.eur.toFixed(2) + ' €' : 'n/a'} · ${q.session.minutes} min · ${q.operator ?? ''} ${q.address ?? ''}, ${q.city ?? ''} (${q.kw} kW ${q.connector}) [${q.pointId}]`);
    return ok(data, `${lines.join('\n')}\n\n${JSON.stringify(data)}`);
  });

  registerAppTool(server, 'estimate_charging_cost', {
    title: 'Estimate charging cost',
    description: 'Estimated cost and duration of a session at one charger (site: siteId from lookup_charger or the other tools, or the code/name the user gave) or one socket (point_id), with the full breakdown and every way to pay. With site, each different kind of socket there is priced, cheapest first.',
    inputSchema: z.object({
      site: z.string().max(200).optional().describe('The charger: siteId from lookup_charger/find_chargers (e.g. "GLP-LRA-00156"), its code ("LRA-00156"), or the user\'s words if they name one site'),
      point_id: z.string().optional().describe('One socket, "SITE/POINT" as returned by the other tools, e.g. "GLP-LRA-00156/LRA-00156-02". Only when the user picked a socket; otherwise use site'),
      ...Filter, ...Car, ...Detail, ...Lang,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI } },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    if (a.target_pct <= a.start_pct) return err(t('err.target'));
    await withLive(live, ctx, t);
    const targets = pointsFor(ds, live, a, t);
    if (targets.error) return err(targets.error);
    const opts = { at: a.at ? new Date(a.at) : undefined, tariffIds: a.tariff_ids, shown: a.tariffs_shown, live, lang, detail: !!a.detail, qa: QA, simCache: new Map() };
    // Quoting is cheap once the first one has called ceme-v2 (simCache), so
    // every kind is priced and the cheapest are kept.
    const results = (await Promise.all(targets.map(hit => quotePoint(hit, car(a), opts)))).sort(byBest).slice(0, MAX_KINDS);
    return ok({ kind: 'single', ...meta(ds, live, lang), results });
  });

  registerAppResource(server, 'Charging results', VIEW_URI, {
    description: 'Inline view of charging cost results',
  }, async () => ({
    contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: await viewHtml(), _meta: { ui: { prefersBorder: true } } }],
  }));

  return server;
}
