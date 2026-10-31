// The MCP server itself: the tools an AI assistant can call, the instructions
// it reads when it connects, and the inline results view.
//
// MCP (Model Context Protocol) in one paragraph: an assistant like ChatGPT or
// Claude connects to this server, reads `INSTRUCTIONS` and the list of tools
// (name + description + JSON schema of the arguments), and then decides on
// its own when to call them. A tool call is a JSON-RPC request; we answer with
// `structuredContent` (JSON for the assistant to read) plus a text version:
// a few summary lines and the same JSON, for clients that only read text. The schemas below are written as much for the assistant as for the
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
import { expandMonthKwh, promos, tariffs } from './ceme.js';
import { clusterPlaces, directionLabel, sameStation, serviceAreas, sideFor } from './direction.js';
import { pickLang, translator } from './i18n.js';
import { napPlan } from './live.js';
import { AUDIENCES, forAudiences, napNote, OFFERS, offersAt } from './offers.js';
import { cardPayment } from './data.js';
import { siteOpen } from './hours.js';
import { describePlan } from './opc.js';
import { byBest, quotePoint, rank, tariffKey } from './quote.js';
import { fold } from './lookup.js';
import { logged } from './stats.js';
import { SITE_URL } from './site.js';
import { VERSION } from './version.js';
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

Finding the charger the user means: nobody knows a charger's id, so never ask for one. When the user names a charger ("the Continente in Leiria", "IONITY Mealhada", "the Galp on the A1 at Pombal", "the charger at Lidl in Coimbra") or reads its code off the sticker ("LRA-00156"), call lookup_charger with their words as query, plus lat/lon if you know where they are. It returns what the NAP publishes about that site (every socket's power, plug and live status, the operator fee, the walk-up price, direct offers; the operator fee, walk-up and NAP prices there come without VAT, as published, while estimate_charging_cost adds the region's VAT; napPriceWithVat marks an operator that publishes it with VAT in) and, in "osm", what the OpenStreetMap community mapped there: the place's name, the brand (often who owns the chargers, or the shop or car park they're at), opening hours, access, parking fee, "underground" car park. "operator" (from the NAP) is the OPC that runs the charger and bills its fee; the owner can be someone else: Lidl's chargers are owned by Lidl and operated by Galp, so the NAP says Galp and OSM says Lidl. Both are right; say who operates it, and credit OpenStreetMap when you use its data. Each site's "missing" lists the user's words it lacks: if the best sites still miss some, say so instead of presenting them as the one the user meant, and ask or try fewer words. If several sites fit, list them briefly (operator, address, town) and ask which one. For the cost there, pass its siteId as site to estimate_charging_cost (point_id only when the user picked one socket).

Lists and socket details: to list who operates chargers ("which OPCs are there?", "who runs the chargers in Madeira?", "who has 800 V chargers?"), call list_operators; it covers every operator with chargers on the NAP (MOBI.E and outside it), not the DGEG registry, so say so if asked about licensing. To list chargers by a property across the whole country ("every charger above 500 V", "all IONITY sites"), call find_chargers with the filter and no place; it says how many match and returns the most powerful first (narrow with region or query for the rest). Each socket has kw, volts and amps: OpenStreetMap's (read off the charger by the community) where they differ from the NAP's, with the NAP's in napKw/napVolts/napAmps; otherwise the operator's declaration on the NAP, where 750 or 600 V on a DC socket is often a placeholder. Say which source a number comes from when it matters. "level" (BTN, BTE, MT) is the grid connection's voltage level, which picks the energy tariff, not the socket's voltage: never present it as the socket voltage.

Before the user goes: "cable" false on a socket means it has no cable fixed to it, so the user must bring their own (Type 2 cable for AC); mention it whenever you suggest an AC socket. "openNow" and "hours" (NAP and OpenStreetMap, in OpenStreetMap syntax) say if the site is open; a charger in a car park that closes is unusable at night, so say so, and pass open_now to leave closed ones out. "cardPayment" true means a bank card works at the charger itself (terminal or contactless), false means it doesn't; card_payment filters on it. "locationDescription" (and osm.level, osm.covered) says where it is inside the car park ("Piso -1"). "support" is who to call or email when the charger doesn't start. osm.manufacturer/model name the charger hardware and osm.capacity how many cars can charge at once, when mapped. When the notes say two sources disagree (hours, card), pass that on instead of picking one.

Motorways: a service area usually has one charger site on each side of the road, and the driver can only reach the one on their side; both often share a name and even an address. When a result says so (directionNeeded, or an error asking for the direction), ask the user which way they're driving (where they're heading) unless they already said, then call again with towards (that town, or its lat/lon). The server picks the side from the direction the site says it serves, or else from the right-hand rule; in that case an assumption tells the user to check the signs: pass it on. On a route (route argument) the far side is left out when the sites say which way they serve; otherwise both sides can show up, so name the direction when you present one.

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
- "adhoc": bank card / QR code at the charger, no CEME. Always mention it when present: it's what someone without a CEME card pays. MOBI.E publishes it without VAT; the total has the region's VAT added;
- "direct": paying outside the CEME system: a card terminal (TPA) or QR at the charger, the operator's own app or subscription (IONITY Power, Atlante GO...), or a roaming app (Electroverse, Elli, Electromaps...). Final prices with VAT, from a public price list (see note and checked date). Subscriptions show a monthly/yearly fee that is NOT included in the session total; say so. When you quote one of these prices, credit its source (named in the note): for the blog, name its author, Alexandre Moleiro. On Madeira and the Azores they carry vatUnverified: the list uses mainland VAT, so tell the user to confirm the price;
- "opc_direct": chargers outside MOBI.E (Continente, Tesla...): this charger's own price as the NAP publishes it, paid to the operator through its app or card without a subscription. The NAP publishes it without VAT (eurPerKwhExVat); total and eurPerKwh have the region's VAT added (23 % on the mainland, less on Madeira and the Azores). A few operators publish it with VAT in (napVatIncluded, Tesla): then eurPerKwh is the NAP's number. It's ranked like any other price. When the same charger also has "direct" offers (network-wide prices), show both: they can differ. When the assumptions say the price changes with the time of day, tell the user it's the peak price and the app can be cheaper at other hours.
MOBI.E chargers and those outside it come in one ranking; no network is preferred, the price decides (regime "sem_ceme" marks the ones outside MOBI.E, with no CEME).
CEME promotions: some CEMEs give a discount only at one network (e.g. a CEME's energy cheaper at Powerdot chargers, or a subscription that cuts the operator fee there). A result's "promos" lists the ones at that charger, each with label, total (this session with it), saving, until and note:
- applied: true means it's for every customer of that tariff and is already in that option's total (the option carries "promos" and, for operator-fee discounts, opcDiscountPct). Say the price includes it and until when.
- newCustomers: true means it only holds for people who sign up during the promotion (maxHours: how long it lasts after signing up). It is never in any total. Mention it as a tip ("if you're new to X, signing up by <until> would make this session cost <total>"), never as the price.
- target FINAL is an all-in price (operator fee and VAT included) that the CEME charges at its network instead of energy + operator fee; the option carries opcIncluded. It replaces the usual sum even where that would be lower: say so if it costs more.

Monthly free kWh (promos with target KWH_GRATIS, e.g. a CEME giving its electricity clients the first kWh of each month free, on any charger): this server stores nothing, so YOU keep the count, per tariff and per calendar month (Portugal time). Keep a running log in your memory of the user's sessions: date, tariff_id, kWh. Add one when the user says they charged (ask for the kWh on the invoice/app if they know it; otherwise use the session.kwhBilled of the estimate they followed) and start again from zero on the 1st of each month. On every cost call, pass month_kwh: { tariff_id: kWh charged so far this month } for the tariffs that have such a promotion. With it, the option's total already uses the free kWh still left (freeKwhLeft), and applied is true. Without it, monthKwhKnown is false and the promotion is only a tip priced as if no free kWh were used yet: if you don't know the count, ask the user how many sessions and roughly how many kWh they've charged with that card this month, rather than guessing.
Tariffs only for new sign-ups (newCustomersOnly: true on a tariff or an option, usually a dated campaign with until = its last day): someone who's already a client of that CEME can't get it. It is never the headline or "best" unless the user passed it in tariff_ids (then they have it). When it is cheaper, mention it as a tip ("if you're not a X client yet, signing up by <until> gets <price>"), never as the price.
Prices for one group only (audience on a tariff or an option: a company's employees, ride-hailing drivers; the groups are listed in the audiences argument): they are hidden unless you pass audiences. Pass a group only when the driver told you they belong to it ("trabalho na EDP", "sou colaborador da Powerdot", "sou motorista Uber") or you remember they did; never infer it. When they say only "sou colaborador" or "I'm an employee", ask of which company. An option with audience is for that group only: say so ("price for EDP employees").

Chargers are ranked by "best": the cheapest option anyone can use now (no subscription, no other contract, not a new-sign-ups-only tariff). Lead with it, and point out when a subscription or another CEME would be cheaper. Every result carries all its ways to pay in "options", usually more than you show: always tell the user there are more (subscriptions, other CEMEs, apps) and offer to list them.

Peak prices (peakPrice on an option, napPriceIsPeak in lookup_charger; today Tesla Superchargers): the operator's price changes during the day, but on the NAP it publishes one fixed value, the highest of the day, and there is no public source with the price at each hour. Always tell the driver, in plain words: the price shown is the most it can cost at that charger (congestion fees aside), it's usually much cheaper at night and off-peak, and only the operator's app shows the price for their hour. Never present it as the price they will pay, and when it decides a ranking, say a peak-priced charger may well be cheaper at their time.

Time of day matters: a session lasts minutes to hours, and the energy price can change while it runs (peak to off-peak "vazio" hours, the wholesale OMIE price every 15 minutes for indexed tariffs, even a clock change). The server prices the session quarter-hour by quarter-hour from its start (at, default now) to its estimated end; session.startLocal/endLocal give the window. A CEME option with kwhByPeriod crossed periods: mention it when it changes the picture (e.g. "starting 30 min later puts most of it in off-peak"). If the user asks how a price was built, or why it changes with the time, call again with detail: true and explain the timeline (when the kWh go in and, per tariff, each stretch's period, price and OMIE; quarters that look the same are merged into one run).

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

QA MODE: this is a test server. Results include "timeline" and "debug". When you answer, also show the session window, the timeline of the headline tariff and anything in "debug" that looks wrong, so the tester can check the math. Each charger comes with up to ${QA_SHOWN} tariffs by default: list them all, not just the top 3.`;

const Detail = {
  detail: z.boolean().optional().describe('Include the timeline: when the kWh are delivered and, for each CEME tariff shown, its period (vazio/fora de vazio), price and OMIE over the session (quarter-hours that look the same are merged into runs). Use when the user asks how the price was built. In a ranking, only the first results carry it.'),
};

// Prices only some people can get (offers/audiences.json). Never guessed:
// only what the driver said about themselves.
const Audience = {
  audiences: z.array(z.enum(Object.keys(AUDIENCES))).max(10).optional()
    .describe(`Groups the driver said they belong to, which unlock prices only they can get: ${Object.entries(AUDIENCES).map(([id, a]) => `${id} = ${a.en}`).join('; ')}. Only when the driver said so in this conversation or you remember they did; never guess it from their car, job or location. Omit otherwise.`),
};

const Lang = {
  lang: z.string().max(20).optional().describe('The user\'s language, e.g. "pt", "pt-PT", "en". Portuguese gets Portuguese text; anything else English.'),
};

// `at` beyond this is a bug in the caller (1970, 2099), not a plan: nobody
// plans a charge a year out, and the past only matters for "what did that
// cost" a few days back. Checked per call, so a long-running server moves
// the window with the clock.
const AT_PAST_DAYS = 7, AT_AHEAD_DAYS = 365;
const inWindow = s => {
  const ms = Date.parse(s) - Date.now();
  return ms >= -AT_PAST_DAYS * 86_400_000 && ms <= AT_AHEAD_DAYS * 86_400_000;
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
  at: z.string().datetime({ offset: true }).optional()
    .refine(inWindow, `at must be between ${AT_PAST_DAYS} days ago and ${AT_AHEAD_DAYS} days ahead`)
    .describe(`When the charge starts, ISO 8601 (default now; from ${AT_PAST_DAYS} days ago to ${AT_AHEAD_DAYS} days ahead)`),
  month_kwh: z.record(z.string().max(64), z.number().min(0).max(100000)).optional()
    .describe("kWh the user already charged in the current calendar month with each of their tariffs, keyed by tariff_id, e.g. {\"goldenergy-bt-clientesgold\": 12.4}. From your own count of their sessions (see the instructions on monthly free kWh). Omit when unknown."),
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

const Towards = {
  towards: z.union([z.string().max(100), z.object({ lat: z.number().min(30).max(43), lon: z.number().min(-32).max(-6) })]).optional()
    .describe('Where the user is driving to: a town (e.g. "Lisboa") or lat/lon. Picks the side of a motorway service area they can reach; ask the user when a result says the direction is needed'),
};

// `towards` as a point and a name for the sentences, or an error.
function resolveTowards(ds, towards, t) {
  if (towards == null) return null;
  if (typeof towards !== 'string') return { point: towards, name: `${towards.lat}, ${towards.lon}` };
  const p = ds.resolvePlace(towards);
  return p ? { point: p, name: towards } : { error: placeError(ds, towards, t), code: 'place' };
}

// A service area's sides, one line each, for the question to the user.
const sidesList = area => area.map(pl => `${placeLine(pl)} · ${directionLabel(pl[0].site) ?? '?'}`).join('\n');

// One place (sites at the same spot), one line: every operator there, so the
// assistant never has to guess who runs a site it wasn't shown.
function placeLine(pl) {
  const [h] = pl;
  const ops = [...new Set(pl.map(x => x.site.operator).filter(Boolean))];
  const more = pl.length > 1 ? ` (+${pl.length - 1}: ${pl.slice(1, 4).map(x => x.site.id).join(', ')}${pl.length > 4 ? ', …' : ''})` : '';
  return `${h.site.id}${more}: ${ops.join(' + ') || '?'}, ${h.site.address ?? ''}, ${h.site.city ?? ''} (${h.site.lat}, ${h.site.lon})`;
}

const Filter = {
  min_kw: z.number().positive().optional().describe('Minimum charger power, kW'),
  connectors: z.array(z.enum(['T2', 'CCS', 'CHADEMO', 'SCHUKO'])).optional().describe('Acceptable plug types'),
  dc_only: z.boolean().optional().describe('Only DC (fast) chargers'),
  min_voltage: z.number().int().positive().max(1500).optional().describe('Minimum socket voltage, V (e.g. 800 for cars with an 800 V battery): OpenStreetMap\'s where mapped, else what the operator declares on the NAP'),
  card_payment: z.boolean().optional().describe('Only chargers where a bank card works at the charger itself (card terminal / contactless), per the NAP or OpenStreetMap'),
  cable_attached: z.boolean().optional().describe('true: only sockets with the cable fixed to the charger; false: only sockets where the user brings their own cable'),
  open_now: z.boolean().optional().describe('Leave out chargers whose opening hours say they are closed now (or at `at`, when given), e.g. in a car park that closes at night'),
};

// The Filter arguments, as Dataset.pointFilter takes them.
const filterOf = a => ({
  minKw: a.min_kw, connectors: a.connectors, dcOnly: a.dc_only, minVoltage: a.min_voltage,
  cardPayment: a.card_payment, cable: a.cable_attached, openAt: a.open_now ? (a.at ? new Date(a.at) : new Date()) : undefined,
});

// One socket's power, voltage, current and cable. kw/volts/amps are
// OpenStreetMap's where it differs from the NAP (see data.js); napKw/
// napVolts/napAmps then say what the NAP declares.
const socketFields = p => ({
  kw: p.kw, ...(p.napKw !== undefined && { napKw: p.napKw }),
  volts: p.v ?? undefined, ...(p.napV !== undefined && { napVolts: p.napV }),
  amps: p.a ?? undefined, ...(p.napA !== undefined && { napAmps: p.napA }),
  cable: p.cable ?? undefined,
});
const fromOsm = p => p.napKw !== undefined || p.napV !== undefined || p.napA !== undefined;

// What a driver wants to know about the site before going, and the notes it
// needs: opening hours (and whether it's open at `at`), where it is in the car
// park, whether a bank card works, who to call. Each fact says its source.
function siteFacts(site, t, at = new Date()) {
  const hours = siteOpen(site, at);
  const card = cardPayment(site);
  const notes = [];
  if (hours.disagree) notes.push(t('note.hoursDisagree', { site: site.id, nap: hours.nap, osm: hours.osm }));
  if (card.disagree) notes.push(t('note.cardDisagree', { site: site.id, napYes: card.nap }));
  const phone = site.phone ?? site.osm?.phone;
  return {
    facts: {
      name: site.name ?? undefined,
      hours: hours.nap || hours.osm ? { nap: hours.nap ?? undefined, osm: hours.osm ?? undefined } : undefined,
      openNow: hours.open ?? undefined,
      locationDescription: site.locationDescription ?? undefined,
      cardPayment: card.value ?? undefined,
      support: phone || site.osm?.email ? { phone, email: site.osm?.email } : undefined,
    },
    notes,
  };
}

// What a voltage filter needs said: the values are declared, not measured,
// or (older dataset) the filter did nothing.
const voltageNotes = (ds, a, t) => a.min_voltage == null ? [] : [t(ds.hasVoltage ? 'assume.voltage' : 'note.noVoltage')];

const Region = {
  region: z.enum(['CONT', 'MAD', 'AZO']).optional().describe('Only this region: CONT (mainland), MAD (Madeira), AZO (Azores)'),
};

const maxMinutes = z.number().positive().optional()
  .describe('Drop chargers whose estimated session takes longer than this. Slow AC sockets are often cheapest but take hours; set this when the user is on a trip or in a hurry.');

const car = a => ({
  batteryKwh: a.battery_kwh, startPct: a.start_pct, targetPct: a.target_pct,
  acKw: a.car_ac_kw, dcKw: a.car_dc_kw, dc10to80Minutes: a.dc_10_80_minutes, curve: a.charge_curve,
});

// A business error (no such place, which side of the motorway...). The text
// is what the assistant acts on; structuredContent lets the inline view show
// it instead of an empty list.
const err = (msg, code = 'error') => ({ isError: true, structuredContent: { kind: 'error', code, message: msg }, content: [{ type: 'text', text: msg }] });
// structuredContent is the answer, but several assistants (Claude's apps
// among them) only hand the model the text. So the text carries the same
// JSON, after a few summary lines: with the lines alone, those assistants saw
// one price per charger, none of the other ways to pay, assumptions or fees.
// The MCP spec asks for this too. Payload is kept down elsewhere (merged
// timeline, timeline only on the first results), not by thinning the text.
const ok = (data, summary) => ({ structuredContent: data, content: [{ type: 'text', text: `${summary ? `${summary}\n\n` : ''}${JSON.stringify(data)}` }] });

// The language for this call: the `lang` argument, else the locale some
// clients put in the request metadata (ChatGPT sends "openai/locale").
const langOf = (a, ctx) => pickLang(a.lang, ctx?.mcpReq?._meta?.['openai/locale']);

// `everywhere`: with no place, search the whole country when a filter keeps
// the list meaningful ("every charger above 500 V"). Only find_chargers does
// that; a cost ranking of the whole country would price thousands of sockets.
function resolveWhere(ds, a, t, { everywhere = false } = {}) {
  // A text filter: the sites the words describe ("IONITY"), searched only
  // where the other arguments say.
  let only, town;
  if (a.query) {
    const r = ds.lookup(a.query, { limit: Infinity });
    const full = r.results.filter(h => !h.missing?.length);
    if (!full.length) return { error: t('err.lookup', { query: a.query }), code: 'lookup' };
    only = new Set(full.map(h => h.site.id));
    town = r.town;
  }
  if (a.route) return { route: a.route, corridorKm: a.corridor_km, only };
  if (a.lat != null && a.lon != null) return { near: { lat: a.lat, lon: a.lon }, radiusKm: a.radius_km, only };
  const name = a.place ?? town;
  if (name) {
    const p = ds.resolvePlace(name);
    if (!p) return { error: placeError(ds, name, t), code: 'place' };
    return { near: p, radiusKm: a.radius_km, only, resolvedPlace: { name, lat: p.lat, lon: p.lon } };
  }
  if (!everywhere) return { error: t('err.where'), code: 'where' };
  const filtered = a.query || a.region || a.min_kw != null || a.min_voltage != null || a.connectors?.length || a.dc_only
    || a.card_payment != null || a.cable_attached != null || a.open_now;
  return filtered ? { only, everywhere: true } : { error: t('err.whereOrFilter'), code: 'where' };
}

// "No such place", or the towns it could be.
function placeError(ds, name, t) {
  const c = ds.placeCandidates(name);
  return c.length > 1 ? t('err.placeWhich', { place: name, towns: c.join('; ') }) : t('err.place', { place: name });
}

// Everything the data says about one site, for lookup_charger. Sockets that
// are the same (power, plug, fee) are grouped, with a count per live status:
// a car park with 10 identical T2s reads as one line, not ten.
function siteCard(h, live, t, audiences = [], notes = []) {
  const { site } = h;
  const { facts, notes: siteNotes } = siteFacts(site, t);
  notes.push(...siteNotes);
  if (h.points.some(fromOsm)) notes.push(t('note.osmSockets'));
  // Most NAP prices come without VAT; offers/nap-notes.json names the
  // operators that publish theirs with it (Tesla).
  const vatIn = !!napNote(site)?.vatIncluded;
  const peak = !!napNote(site)?.timeOfUse;
  const groups = new Map();
  for (const p of h.points) {
    const lp = live.get(site.id, p.id);
    const fee = p.opc?.REGULAR ?? (lp && napPlan(lp.fees));
    const fromNap = !p.opc?.REGULAR;
    const napPrice = p.regime === 'sem_ceme' ? (lp?.fees.find(f => f.policy === 'pricePerDeliveryUnit')?.eur ?? p.napPrice) : undefined;
    const card = {
      ...socketFields(p), connector: p.connector, dc: p.dc, level: p.level ?? undefined, regime: p.regime,
      operatorFee: fee ? describePlan(fee, t, { vatIncluded: fromNap && vatIn }) : undefined,
      operatorFeeSource: fee ? (fromNap ? 'nap' : 'mobie') : undefined,
      adHoc: p.opc?.AD_HOC_PAYMENT ? describePlan(p.opc.AD_HOC_PAYMENT, t) : undefined,
      ...(vatIn ? { napPriceWithVat: napPrice } : { napPriceExVat: napPrice }),
      ...(peak && napPrice != null && { napPriceIsPeak: true }),
      direct: offersAt(site, p, audiences).map(({ offer, eurPerKwh }) => ({ label: offer.label, eurPerKwh, sessionEur: offer.sessionEur, audience: offer.audience, walkUp: !!offer.walkUp || undefined, subscription: !!offer.subscription || undefined })),
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
    direction: h.direction ?? undefined, otherSide: h.otherSide,
    ...facts,
    payment: site.payment?.length ? site.payment : undefined,
    osm: site.osm,
    sockets: [...groups.values()].sort((a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0) || (b.kw ?? 0) - (a.kw ?? 0)),
  };
}

const rnd = x => x == null ? undefined : Math.round(x * 10) / 10;

// What a support question needs to reproduce an answer: which server, which
// data, which live copy.
const meta = (ds, live, lang) => ({ version: VERSION, lang, dataAsOf: ds.generatedAt, live: liveMeta(live), ...(QA && { qa: true }) });
const liveMeta = live => { const { publishedAt, checkedAt, fresh, refreshing, points, error } = live.info(); return { publishedAt, checkedAt, fresh, refreshing, points, error }; };

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
function pointsFor(ds, live, a, t) {
  if (a.point_id) {
    const hit = ds.findPoint(a.point_id);
    if (hit) return [hit];
    if (!a.site) return { error: t('err.point', { id: a.point_id }), code: 'point' };
  }
  if (!a.site) return { error: t('err.which'), code: 'which' };
  const r = ds.lookup(a.site, { limit: Infinity, ...filterOf(a) });
  if (!r.results.length || r.results[0].missing?.length) return { error: t('err.lookup', { query: a.site }), code: 'lookup' };
  // Several sites in the same spot are one place to the driver (a service
  // area often has one NAP site per charger). Words can fit several places:
  // the assistant has to ask which. The two sides of one motorway service
  // area are a different question: which way the driver is going.
  const areas = serviceAreas(clusterPlaces(r.results));
  if (areas.length > 1) {
    const list = areas.slice(0, 6).map(([first, ...sides]) => `${placeLine(first)}${sides.length ? ` ${t('several.sides')}` : ''}`).join('\n');
    return { error: `${t('err.several', { query: a.site, n: areas.length })}\n${list}`, code: 'several' };
  }
  let [places] = areas;
  const assumptions = [];
  if (places.length > 1) {
    const towards = resolveTowards(ds, a.towards, t);
    if (towards?.error) return towards;
    if (!towards) return { error: `${t('err.direction', { query: a.site })}\n${sidesList(places)}`, code: 'direction' };
    const pick = sideFor(places, { from: places[0][0].site, to: towards.point }, name => ds.resolvePlace(name));
    // When the direction doesn't settle it, both sides are priced: the driver
    // will see on the signs which one they're at.
    if (!pick) assumptions.push(t('assume.bothSides', { to: towards.name }));
    else {
      places = pick.places;
      assumptions.push(pick.by === 'label' ? t('assume.sideLabel', { label: pick.label, to: towards.name }) : t('assume.side', { to: towards.name }));
    }
  }
  const sites = places.flat();
  // An id or code names one site. Its operator's other sites in the same
  // spot are the rest of that station, so they come too, unless the user
  // named one socket.
  if (sites.length === 1 && sites[0].score === Infinity && sites[0].socket == null && sites[0].site.operatorId) {
    const [h] = sites;
    const ok = ds.pointFilter(filterOf(a));
    for (const site of ds.sites) {
      if (site === h.site || !sameStation(h.site, site)) continue;
      const points = site.points.filter(p => ok(p, site));
      if (points.length) sites.push({ site, points });
    }
  }
  if (sites.length > 1) assumptions.push(t('assume.sites', { n: sites.length }));
  const free = (site, p) => live.get(site.id, p.id)?.status === 'available';
  const kinds = new Map();
  for (const h of sites) {
    let points = h.points;
    if (h.socket != null) {
      const named = points.filter(p => Number(p.id.split(/[-.]/).pop()) === h.socket);
      if (named.length) points = named;
    }
    for (const point of points) {
      const key = canonical([point.kw, point.cable, point.connector, point.dc, point.level, point.regime, point.opc, point.napPrice, h.site.operatorId]);
      const cur = kinds.get(key);
      if (!cur || (!free(cur.site, cur.point) && free(h.site, point))) kinds.set(key, { site: h.site, point });
    }
  }
  return Object.assign([...kinds.values()], { assumptions });
}

// month_kwh needs the tariff list; without ceme-v2 the free kWh just don't
// apply (and the CEME prices are flagged as missing anyway).
const monthKwh = a => expandMonthKwh(a.month_kwh, tariffKey).catch(e => { if (e.ceme) return null; throw e; });

// What a ranking quotes. A car park with ten identical T2s prices the same
// ten times, so each site keeps one socket per kind (the one most likely
// free): that halves a 5 km search in Lisbon. And a 50 km radius still has
// ~4,000 kinds, so sites are taken nearest first (to the centre, or to the
// route) until MAX_RANKED_POINTS; the response says when that cut bit.
const MAX_RANKED_POINTS = 2000;
const DETAIL_IN_RANKING = 3;
const STATUS_RANK = { available: 0, unknown: 1 };
function rankCandidates(results, live, route) {
  const near = route ? [...results].sort((x, y) => x.offRouteKm - y.offRouteKm) : results;
  const candidates = [];
  let points = 0;
  for (const r of near) {
    const score = p => STATUS_RANK[live.get(r.site.id, p.id)?.status ?? 'unknown'] ?? 2;
    const kinds = new Map();
    for (const p of r.points) {
      const key = canonical([p.kw, p.cable, p.connector, p.dc, p.level, p.regime, p.opc, p.napPrice]);
      const cur = kinds.get(key);
      if (!cur || score(p) < score(cur)) kinds.set(key, p);
    }
    if (points + kinds.size > MAX_RANKED_POINTS && candidates.length) break;
    points += kinds.size;
    candidates.push({ ...r, points: [...kinds.values()] });
  }
  return { candidates, truncated: candidates.length < results.length };
}

// `getDataset` instead of the dataset itself: server.js swaps in a fresh copy
// every few hours, and each request should see the current one.
export function createServer(getDataset, live) {
  const server = new McpServer({ name: 'ohmigo', title: 'Ohmigo: EV charging costs in Portugal', version: VERSION, websiteUrl: SITE_URL,
    icons: [{ src: `${SITE_URL}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] }, { src: `${SITE_URL}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }] },
  { instructions: INSTRUCTIONS + (QA ? QA_NOTE : '') });
  // Every tool (registerAppTool goes through registerTool too) is timed and
  // counted, see stats.js.
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => register(name, config, logged(name, handler));

  server.registerTool('list_ceme_tariffs', {
    title: 'List CEME tariffs',
    description: 'Lists the CEME (EV charging electricity retailer) tariffs used on MOBI.E chargers, to resolve the card/app the user pays with to a tariff_id. Filter by name. Also lists the CEMEs\' current promotions at specific charging networks.',
    inputSchema: z.object({ query: z.string().optional().describe('Text to match in the CEME or tariff name, e.g. "edp", "galp", "via verde"'), ...Audience, ...Lang }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, audiences, lang: l }, ctx) => {
    const t = translator(langOf({ lang: l }, ctx));
    // A ceme-v2 without /v1/promos still lists the tariffs.
    let all, current;
    try { [all, current] = await Promise.all([tariffs(), promos().catch(() => ({ data: [] }))]); }
    catch (e) { if (e.ceme) return err(t('err.tariffs'), 'ceme'); throw e; }
    const q = (query || '').toLowerCase();
    // One row per tariff, not per voltage: the BT/MT variant is picked per charger.
    const seen = new Map();
    for (const t of all.data ?? all) {
      const key = tariffKey(t.id);
      const name = `${t.ceme_name ?? t.ceme} ${t.name}`;
      if (q && !name.toLowerCase().includes(q)) continue;
      if (!forAudiences(t, audiences)) continue;
      // ceme-v2's valid_to is exclusive (the day the campaign is gone).
      const until = t.version?.valid_to ? new Date(Date.parse(t.version.valid_to) - 864e5).toISOString().slice(0, 10) : null;
      if (!seen.has(key)) seen.set(key, { tariff_id: t.id, ceme: t.ceme_name ?? t.ceme, name: t.name, kind: t.kind, schedule: t.schedule, cycle: t.cycle, requiresOtherContract: !!t.bundle && !t.audience,
        ...(t.audience && { audience: t.audience }), ...(t.new_customers && { newCustomersOnly: true }), ...(until && { until }) });
    }
    const rows = [...seen.values()];
    // Promotions of the CEMEs that matched, as ceme-v2 publishes them (its
    // `name` is Portuguese; the cost tools give translated labels).
    const cemes = new Set(rows.map(r => r.ceme));
    const names = new Map((all.data ?? all).map(t => [t.ceme_id, t.ceme_name]));
    const promoRows = (current.data ?? []).filter(p => !q || cemes.has(names.get(p.ceme)))
      .map(p => ({ id: p.id, ceme: names.get(p.ceme) ?? p.ceme, name: p.name, network: p.network, target: p.target,
        ...(p.eurKwh != null && { eurKwh: p.eurKwh }), ...(p.pct != null && { pct: p.pct }),
        ...(p.freeKwh != null && { freeKwhPerMonth: p.freeKwh }),
      from: p.from, until: p.to, active: p.active, newCustomers: p.newCustomers, tariffIds: p.tariffs, url: p.url }));
    const shown = rows.slice(0, 60);
    return ok({ version: VERSION, count: rows.length, tariffs: shown, ...(promoRows.length && { promos: promoRows }) },
      `${rows.length} tariffs${promoRows.length ? `, ${promoRows.length} promotions` : ''}:\n${shown.map(r => `${r.tariff_id}: ${r.ceme} · ${r.name}${r.requiresOtherContract ? ' (needs another contract)' : ''}${r.newCustomersOnly ? ' (new sign-ups only)' : ''}${r.until ? ` (until ${r.until})` : ''}`).join('\n')}`);
  });

  server.registerTool('lookup_charger', {
    title: 'Look up a charger',
    description: 'Finds a specific charger the way the user names it: the code on its sticker ("LRA-00156"), operator or brand plus town ("Continente Leiria", "IONITY Mealhada"), the shop or place it is at, or its address. Returns everything published about it: each socket\'s power, plug, live status, operator fee, walk-up (ad hoc) price and direct offers, plus OpenStreetMap details. Use its siteId as site in estimate_charging_cost.',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('What the user calls the charger, in their words: code, operator/brand, place, town, address'),
      lat: Where.lat, lon: Where.lon,
      radius_km: z.number().positive().max(300).optional().describe('With lat/lon: only sites this close'),
      ...Towards, ...Filter, ...Audience, ...Lang,
      limit: z.number().int().positive().max(20).default(5),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    const near = a.lat != null && a.lon != null ? { lat: a.lat, lon: a.lon } : undefined;
    const towards = resolveTowards(ds, a.towards, t);
    if (towards?.error) return err(towards.error, towards.code);
    const r = ds.lookup(a.query, { near, radiusKm: a.radius_km, limit: Infinity, ...filterOf(a) });
    if (!r.results.length) return err(t('err.lookup', { query: a.query }), 'lookup');
    // Motorway service areas among the results: with a direction, keep the
    // side the driver can reach; without one, flag them so the assistant asks.
    let results = r.results;
    const notes = [];
    let directionNeeded = false;
    for (const area of serviceAreas(clusterPlaces(results))) {
      if (area.length < 2) continue;
      const sides = area.map(pl => pl[0].site.id);
      for (const pl of area) for (const h of pl) { h.direction = directionLabel(h.site); h.otherSide = sides.filter(id => id !== pl[0].site.id); }
      if (!towards) { directionNeeded = true; continue; }
      const pick = sideFor(area, { from: area[0][0].site, to: towards.point }, name => ds.resolvePlace(name));
      if (!pick) { notes.push(t('assume.bothSides', { to: towards.name })); continue; }
      const far = new Set(area.filter(pl => !pick.places.includes(pl)).flat());
      results = results.filter(h => !far.has(h));
      for (const h of pick.places.flat()) delete h.otherSide;
      notes.push(pick.by === 'label' ? t('assume.sideLabel', { label: pick.label, to: towards.name }) : t('assume.side', { to: towards.name }));
    }
    if (directionNeeded) notes.push(t('note.direction'));
    notes.push(...voltageNotes(ds, a, t));
    if (results[0].missing?.length) notes.unshift(t('note.partial', { words: results[0].missing.join(', ') }));
    await withLive(live, ctx, t);
    const cards = results.slice(0, a.limit).map(h => siteCard(h, live, t, a.audiences, notes));
    if (results.slice(0, a.limit).some(h => napNote(h.site)?.timeOfUse)) notes.push(t('assume.napTimeOfUse'));
    return ok({
      ...meta(ds, live, lang), query: a.query, total: results.length,
      notes: notes.length ? [...new Set(notes)] : undefined, directionNeeded: directionNeeded || undefined,
      orderedFrom: near ? undefined : r.town,
      sites: cards,
      // OpenStreetMap's licence (ODbL) asks for this wherever its data shows.
      credit: r.results.some(h => h.site.osm) ? t('credit.osm') : undefined,
    }, [...notes, ...cards.map(c => `${c.siteId}: ${c.operator ?? '?'}, ${c.address ?? ''}, ${c.city ?? ''} · ${c.sockets.map(g => `${g.count}× ${g.kw ?? '?'} kW ${g.connector}`).join(', ')}`)].join('\n'));
  });

  server.registerTool('find_chargers', {
    title: 'Find chargers',
    description: 'Finds public EV charge points near a location, along a route, or in the whole country when a filter is given (e.g. every charger with min_voltage 800, every IONITY site, card_payment), with power, voltage, plug type, fixed cable, opening hours, bank card payment and live status. No cost estimate; use find_cheapest_charging for that. For one charger the user names, use lookup_charger.',
    inputSchema: z.object({ ...Where, ...Filter, ...Region, ...Lang, limit: z.number().int().positive().max(100).default(15) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    const w = resolveWhere(ds, a, t, { everywhere: true });
    if (w.error) return err(w.error, w.code);
    const { everywhere, ...where } = w;
    const { total, results } = ds.search({ ...where, ...filterOf(a), region: a.region, limit: a.limit });
    if (!results.length) return err(t('err.noMatch'), 'noMatch');
    await withLive(live, ctx, t);
    const notes = [
      ...(everywhere ? [t('note.nationwide', { shown: results.length, total })] : []),
      ...voltageNotes(ds, a, t),
    ];
    const facts = results.map(r => siteFacts(r.site, t));
    notes.push(...facts.flatMap(f => f.notes));
    if (results.some(r => r.points.some(fromOsm))) notes.push(t('note.osmSockets'));
    const maxOf = (r, k) => Math.max(...r.points.map(p => p[k] ?? 0)) || '?';
    const text = results.map(r => `${r.site.id}: ${r.site.operator ?? '?'}, ${r.site.address ?? ''}, ${r.site.city ?? ''}${r.km != null ? ` · ${rnd(r.km)} km` : ''} · ${r.points.length} sockets, max ${maxOf(r, 'kw')} kW${ds.hasVoltage ? `, ${maxOf(r, 'v')} V` : ''}`).join('\n');
    return ok({
      ...meta(ds, live, lang), resolvedPlace: w.resolvedPlace, wholeCountry: everywhere || undefined, total,
      ...(notes.length && { notes: [...new Set(notes)] }),
      credit: results.some(r => r.site.osm) ? t('credit.osm') : undefined,
      sites: results.map((r, i) => ({
        siteId: r.site.id, code: r.site.code, operator: r.site.operator, address: r.site.address, city: r.site.city, region: r.site.region,
        place: r.site.osm?.name ?? r.site.osm?.brand,
        lat: r.site.lat, lon: r.site.lon, km: rnd(r.km), offRouteKm: rnd(r.offRouteKm), alongKm: rnd(r.alongKm),
        ...facts[i].facts,
        access: r.site.osm?.access, parkingFee: r.site.osm?.parkingFee,
        points: r.points.map(p => ({
          pointId: `${r.site.id}/${p.id}`, ...socketFields(p), connector: p.connector, dc: p.dc, regime: p.regime,
          status: live.get(r.site.id, p.id)?.status ?? null, adHocPayment: !!p.opc?.AD_HOC_PAYMENT,
        })),
      })),
    }, [...new Set(notes), `${total} sites:`, text].join('\n'));
  });

  server.registerTool('list_operators', {
    title: 'List charger operators',
    description: 'Lists the companies that operate public EV chargers in Portugal (OPCs on MOBI.E and the operators outside it, as the NAP publishes them), biggest first: sites, sockets, DC sockets, max power and voltage, regions, and whether they are on MOBI.E. Filters narrow it to the operators with such chargers ("who runs 800 V chargers in Madeira?").',
    inputSchema: z.object({
      query: z.string().max(100).optional().describe('Only operators whose name or NAP operatorId contains this, e.g. "galp", "IONY"'),
      ...Filter, ...Region, ...Lang,
      limit: z.number().int().positive().max(300).default(100),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    let ops = ds.operators({ ...filterOf(a), region: a.region });
    if (a.query) {
      const q = fold(a.query);
      ops = ops.filter(o => [o.operatorId, o.name, ...(o.otherNames ?? [])].some(n => n && fold(n).includes(q)));
    }
    if (!ops.length) return err(t('err.noMatch'), 'noMatch');
    // The operator's own prices (app, subscription, card at the charger) from
    // offers/, by label: the details come with each charger's options.
    const shown = ops.slice(0, a.limit).map(o => {
      const direct = [...new Set(OFFERS.filter(x => o.operatorId && x.scope?.operatorIds?.includes(o.operatorId)).map(x => x.label))];
      return { ...o, directOffers: direct.length ? direct : undefined };
    });
    const notes = [t('note.operators'), ...voltageNotes(ds, a, t)];
    return ok({ ...meta(ds, live, lang), total: ops.length, notes, operators: shown },
      [...notes, `${ops.length} operators:`, ...shown.map(o => `${o.operatorId ?? '-'}: ${o.name} · ${o.sites} sites, ${o.points} sockets (${o.dcPoints} DC), max ${o.maxKw ?? '?'} kW`)].join('\n'));
  });

  registerAppTool(server, 'find_cheapest_charging', {
    title: 'Find cheapest charging',
    description: 'Ranks chargers near a location or along a route by the estimated total cost of the session (energy + operator fee + taxes), for the user\'s car and battery levels. Every charger lists all the ways to pay.',
    inputSchema: z.object({
      ...Where, ...Filter, ...Car, ...Audience, ...Detail, ...Lang, max_minutes: maxMinutes,
      available_only: z.boolean().default(true).describe('Skip chargers the live feed reports as charging, out of order or blocked'),
      limit: z.number().int().positive().max(30).default(10),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI } },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    const w = resolveWhere(ds, a, t);
    if (w.error) return err(w.error, w.code);
    if (a.target_pct <= a.start_pct) return err(t('err.target'), 'target');
    await withLive(live, ctx, t);
    const { total, results } = ds.search({ ...w, ...filterOf(a), limit: Infinity });
    if (!results.length) return err(t('err.noMatch'), 'noMatch');
    const { candidates, truncated } = rankCandidates(results, live, w.route != null);
    const ranked = await rank(candidates, car(a), {
      at: a.at ? new Date(a.at) : undefined, tariffIds: a.tariff_ids, shown: a.tariffs_shown, live, lang, audiences: a.audiences,
      monthKwh: await monthKwh(a),
      maxMinutes: a.max_minutes, availableOnly: a.available_only, detail: !!a.detail, qa: QA,
    });
    if (!ranked.length) return err(t('err.noneLeft'), 'noneLeft');
    const top = ranked.slice(0, a.limit);
    // Any MOBI.E socket without its CEME price was ranked on its other
    // prices only (or last): say so even when the top rows are all outside
    // MOBI.E.
    const cemeDown = ranked.some(q => q.cemeUnavailable);
    if (cemeDown && !top.some(q => q.best)) return err(t('err.pricing'), 'ceme');
    for (const [i, q] of top.entries()) {
      q.km = rnd(q.km); q.offRouteKm = rnd(q.offRouteKm); q.alongKm = rnd(q.alongKm);
      // The timeline is for "how was this price built", a question about one
      // charger: ten of them were ~100 KB. The first few keep it.
      if (i >= DETAIL_IN_RANKING) delete q.timeline;
    }
    const notes = [
      ...(cemeDown ? [t('note.noCeme')] : []),
      ...voltageNotes(ds, a, t),
      ...(truncated ? [t('note.truncated', { n: candidates.length, total })] : []),
      ...(a.detail && top.length > DETAIL_IN_RANKING ? [t('note.detailTop', { n: DETAIL_IN_RANKING })] : []),
    ];
    const data = { kind: 'ranking', ...meta(ds, live, lang), resolvedPlace: w.resolvedPlace, searched: total, quoted: candidates.length,
      ...(truncated && { truncated: true }), ...(cemeDown && { cemeUnavailable: true }), ...(notes.length && { notes }), results: top };
    // Summary lines on top of the JSON in the text (see ok).
    const lines = top.map((q, i) => `${i + 1}. ${q.best ? (q.best.peakPrice ? '<= ' : '') + q.best.total.toFixed(2) + ' € · ' + q.best.label + (q.options?.length > 1 ? ` (+${q.options.length - 1} more ways to pay)` : '') : q.total ? '>= ' + q.total.eur.toFixed(2) + ' €' : 'n/a'} · ${q.session.minutes} min · ${q.operator ?? ''} ${q.address ?? ''}, ${q.city ?? ''} (${q.kw} kW ${q.connector}) [${q.pointId}]`);
    return ok(data, [...notes, ...lines].join('\n'));
  });

  registerAppTool(server, 'estimate_charging_cost', {
    title: 'Estimate charging cost',
    description: 'Estimated cost and duration of a session at one charger (site: siteId from lookup_charger or the other tools, or the code/name the user gave) or one socket (point_id), with the full breakdown and every way to pay. With site, each different kind of socket there is priced, cheapest first.',
    inputSchema: z.object({
      site: z.string().max(200).optional().describe('The charger: siteId from lookup_charger/find_chargers (e.g. "GLP-LRA-00156"), its code ("LRA-00156"), or the user\'s words if they name one site'),
      point_id: z.string().optional().describe('One socket, "SITE/POINT" as returned by the other tools, e.g. "GLP-LRA-00156/LRA-00156-02". Only when the user picked a socket; otherwise use site'),
      ...Towards, ...Filter, ...Car, ...Audience, ...Detail, ...Lang,
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: VIEW_URI } },
  }, async (a, ctx) => {
    const ds = getDataset();
    const lang = langOf(a, ctx), t = translator(lang);
    if (a.target_pct <= a.start_pct) return err(t('err.target'), 'target');
    await withLive(live, ctx, t);
    const targets = pointsFor(ds, live, a, t);
    if (targets.error) return err(targets.error, targets.code);
    const assumptions = [...(targets.assumptions ?? []), ...voltageNotes(ds, a, t)];
    const opts = { at: a.at ? new Date(a.at) : undefined, tariffIds: a.tariff_ids, shown: a.tariffs_shown, live, lang, audiences: a.audiences, detail: !!a.detail, qa: QA, simCache: new Map(),
      monthKwh: await monthKwh(a) };
    // Quoting is cheap once the first one has called ceme-v2 (simCache), so
    // every kind is priced and the cheapest are kept.
    const results = (await Promise.all(targets.map(hit => quotePoint(hit, car(a), opts)))).sort(byBest).slice(0, MAX_KINDS);
    for (const q of results) q.assumptions.push(...assumptions);
    const cemeDown = results.some(q => q.cemeUnavailable);
    if (cemeDown && !results.some(q => q.best)) return err(t('err.pricing'), 'ceme');
    const lines = results.map(q => `${q.best ? `${q.best.peakPrice ? '<= ' : ''}${q.best.total.toFixed(2)} € · ${q.best.label}` : q.total ? `>= ${q.total.eur.toFixed(2)} €` : 'n/a'} · ${q.session.minutes} min · ${q.kw} kW ${q.connector} [${q.pointId}]`);
    return ok({ kind: 'single', ...meta(ds, live, lang), ...(cemeDown && { cemeUnavailable: true, notes: [t('note.noCeme')] }), results },
      [...(cemeDown ? [t('note.noCeme')] : []), ...lines].join('\n'));
  });

  registerAppResource(server, 'Charging results', VIEW_URI, {
    description: 'Inline view of charging cost results',
  }, async () => ({
    contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: await viewHtml(), _meta: { ui: { prefersBorder: true } } }],
  }));

  return server;
}
