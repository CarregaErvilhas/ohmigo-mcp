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
import { MAX_SESSION_HOURS } from './profile.js';
import { logged } from './stats.js';
import { SITE_URL } from './site.js';
import { VERSION } from './version.js';
import { viewHtml } from './view.js';

const VIEW_URI = 'ui://ohmigo/results.html';

// Read by the assistant when it connects. It's a prompt, not docs: it tells
// the assistant what to ask the user, what to look up itself, and how to
// present the results honestly.
//
// It goes into the assistant's context in every conversation, used or not,
// and some clients cut it: Claude Code keeps only the first INSTRUCTIONS_MAX
// characters (test/mcp.test.js holds it to that). So only what applies across
// tools lives here. What one tool needs goes in that tool's description or
// its arguments' (clients that load tools on demand only read those when the
// tool is about to be used), and what one result needs goes in the result
// itself (assumptions, notes, each option's note), which every client passes
// on and costs nothing when it doesn't apply.
export const INSTRUCTIONS_MAX = 4096;
export const INSTRUCTIONS = `Prices EV charging at every public charger in Portugal on the NAP ("PAN" in Portuguese): MOBI.E chargers (CEME energy + charger operator (OPC) fee + taxes) and those outside MOBI.E (Tesla, Continente...), paid to the operator. Finds the cheapest charger near a place or on a route; lists chargers and operators.

Language: answer in the user's language and pass it as lang on every call; text comes back in Portuguese or English, translate it for any other language.

Who's who on MOBI.E (don't mix them up): the CEME sells the energy (the user's card/app) and sets its price. The OPC operates a PUBLIC charger (IONITY, Powerdot, Galp...) and bills a fee on top; every charger here has one. A DPC holds a PRIVATE charger connected to MOBI.E (home wallbox, condo garage, company car park): not an operator, no OPC fee, not in the NAP, so ohmigo can't list or price it; a session there costs the user's CEME tariff (list_ceme_tariffs) plus the EGME fee and taxes. Never call an OPC a DPC or the reverse.

Never ask for a charger id: when the user names a charger (brand or operator + town, a shop, an address, the code on its sticker), call lookup_charger with their words, then pass its siteId as site to estimate_charging_cost. At a motorway service area, when a result asks for the direction, ask where the user is heading.

"level" (BTN, BTE, MT) is the grid connection, never the socket's voltage (that's volts). Before the user goes, mention what applies: "cable" false = they bring their own cable (say it whenever you suggest an AC socket); "openNow" false or "hours": a car park that closes is unusable then; "cardPayment", "locationDescription" (where in the car park), "support" (who to call if it won't start).

Before a cost call: look up the car's specs yourself (usable battery, max AC/DC kW, published DC 10-80% minutes, the DC curve if you find it); don't ask the user for them. Ask only for what you don't know: battery % now, target % (default 80), and whether they're in a hurry (the cheapest is often a slow AC socket: pass max_minutes or dc_only on a trip). If they pay with CEME cards/apps, resolve them with list_ceme_tariffs and pass all the ones they hold as tariff_ids. ohmigo stores nothing: remember the car, its specs and the user's tariffs yourself, and for monthly free-kWh promotions the kWh they charged per tariff this month (month_kwh).

Presenting: lead with "best", the cheapest option the user can use now: total in €, duration, how to pay, main assumptions. Every charger has more ways to pay in "options": other CEMEs, "adhoc" (no CEME card needed; its label says if by card at the charger or on the phone: always mention it), "direct" (operator apps, subscriptions, roaming apps; a subscription's fee is not in the total) and "opc_direct" (the operator's NAP price outside MOBI.E). Say there are more and offer to list them; point out when a subscription or another CEME is cheaper. MOBI.E and other networks share one ranking: the price decides.
Pass on the result's assumptions and notes and each option's note: they flag peak prices (the most it can cost; usually much less off-peak), promotions in or out of the total, stale or island-VAT prices, sources that disagree. Tariffs and promotions for new sign-ups only (newCustomersOnly, newCustomers) are tips for non-clients ("signing up by <until> gets <price>"), never the price. Prices for one group (audience) are only for drivers who said they belong to it, now or before (your memory counts): never infer a group, and say whom the price is for.
Credit your sources: OpenStreetMap for "osm" data; for "direct" prices, the source in the note (for the blog, its author, Alexandre Moleiro).

Live status comes from the NAP; if live.fresh is false, say it may be stale. Costs are estimates; the operator's and CEME's prices on the day prevail.`;

// Argument schemas, shared by the tools. zod turns them into the JSON Schema
// the assistant sees, and validates what it sends back.
// QA mode (OHMIGO_QA=1, never in production): every result carries the
// timeline and a `debug` block with what was sent to ceme-v2 and what came
// back, and the assistant is told to show it. For testing and debugging.
export const QA = process.env.OHMIGO_QA === '1';
// In QA, show more tariffs per charger by default, to check more of the math.
const QA_SHOWN = 10;
export const QA_NOTE = `

QA MODE (test server): results carry "timeline" and "debug". Also show the session window, the headline tariff's timeline and anything in "debug" that looks wrong, so the tester can check the math; list all of each charger's tariffs (up to ${QA_SHOWN}), not just 3.`;

const Detail = {
  detail: z.boolean().optional().describe("Add the timeline (kWh, period, price and OMIE over the session) and each CEME option's \"components\" (its bill line by line) when the user asks how the price was built. In a ranking only the first results carry it."),
};

// Prices only some people can get (offers/audiences.json). Never guessed:
// only what the driver said about themselves.
const Audience = {
  audiences: z.array(z.enum(Object.keys(AUDIENCES))).max(10).optional()
    .describe(`Groups the driver said they belong to (now or earlier), for prices only they get: ${Object.entries(AUDIENCES).map(([id, a]) => `${id} = ${a.en}`).join('; ')}. Never guess; "I'm an employee" alone: ask which company.`),
};

const Lang = {
  lang: z.string().max(20).optional().describe('The user\'s language, e.g. "pt", "en"'),
};

// `at` beyond this is a bug in the caller (1970, 2099), not a plan: nobody
// plans a charge a year out, and the past only matters for "what did that
// cost" a few days back. Checked per call, so a long-running server moves
// the window with the clock.
const AT_PAST_DAYS = 7, AT_AHEAD_DAYS = 365;
// ISO 8601 with a UTC offset ("Z" or "+01:00"), checked by hand: zod's
// .datetime() puts a ~300-character regex in the JSON Schema of every tool
// that has `at`, which the assistant reads and never needs.
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const inWindow = s => {
  const ms = Date.parse(s) - Date.now();
  return ms >= -AT_PAST_DAYS * 86_400_000 && ms <= AT_AHEAD_DAYS * 86_400_000;
};

// The least a car takes, kW. AC charging can't go below 6 A on one phase
// (1.4 kW under IEC 61851) and DC chargers start well above that, so this
// only turns away figures that aren't a car's. charging.js floors a curve at
// the same 1 kW.
const MIN_CAR_KW = 1;

const Car = {
  battery_kwh: z.number().positive().max(250).describe('Usable battery capacity, kWh (look it up from the car model)'),
  start_pct: z.number().min(0).max(100).describe('Battery now, %'),
  target_pct: z.number().min(1).max(100).default(80).describe('Target battery, % (default 80; DC slows down above it)'),
  car_ac_kw: z.number().min(MIN_CAR_KW).max(43).optional().describe("Car's max AC power, kW (on-board charger)"),
  car_dc_kw: z.number().min(MIN_CAR_KW).max(500).optional().describe("Car's max DC power, kW"),
  dc_10_80_minutes: z.number().positive().max(300).optional().describe("Car's published DC 10-80% time, minutes: makes the duration far better than the generic curve"),
  charge_curve: z.array(z.object({ soc: z.number().min(0).max(100), kw: z.number().positive().max(500) })).min(2).max(101).optional()
    .describe("Car's DC charging curve, kW at each state of charge %, e.g. [{soc:10,kw:150},{soc:80,kw:60}]"),
  tariff_ids: z.array(z.string().max(100)).max(20).optional().describe("The user's CEME tariffs (ids from list_ceme_tariffs), only those they hold: each charger uses the cheapest. Omit for the popular ones"),
  tariffs_shown: z.number().int().min(1).max(20).default(QA ? QA_SHOWN : 3).describe('Without tariff_ids: popular tariffs per charger'),
  at: z.string().max(40).refine(s => ISO_OFFSET.test(s) && !Number.isNaN(Date.parse(s)), 'at must be ISO 8601 with a UTC offset, e.g. 2026-05-01T18:30:00+01:00')
    .refine(inWindow, `at must be between ${AT_PAST_DAYS} days ago and ${AT_AHEAD_DAYS} days ahead`).optional()
    .describe(`When the charge starts, ISO 8601 with offset (default now; ${AT_PAST_DAYS} days back to ${AT_AHEAD_DAYS} ahead). Energy prices change between peak and off-peak (vazio) hours`),
  month_kwh: z.record(z.string().max(64), z.number().min(0).max(100000)).optional()
    .describe('Tariffs with a monthly free-kWh promotion: kWh charged with each this calendar month (Portugal time), by tariff_id, e.g. {"goldenergy-bt-clientesgold": 12.4}. Keep your own log of the user\'s sessions (kWh from their invoice/app, else the kwhBilled you estimated), reset on the 1st; with no count, ask'),
};

const Where = {
  lat: z.number().min(30).max(43).optional().describe('Latitude of the user or search centre'),
  lon: z.number().min(-32).max(-6).optional().describe('Longitude of the user or search centre'),
  place: z.string().max(200).optional().describe('Town or municipality, when lat/lon are unknown (e.g. "Leiria"). Only towns and NAP addresses: for a shopping centre, street or service area, pass lat/lon'),
  radius_km: z.number().positive().max(50).default(5).describe('Search radius, km'),
  route: z.array(z.object({ lat: z.number(), lon: z.number() })).min(2).max(200).optional()
    .describe('Waypoints from origin to destination, to search along the route instead'),
  corridor_km: z.number().positive().max(20).default(2).describe('Max distance from the route, km'),
  query: z.string().max(200).optional().describe('Only chargers whose operator, brand, name or address match these words, e.g. "IONITY", "Lidl"; a town in it is the place when none is given'),
};

const Towards = {
  towards: z.union([z.string().max(100), z.object({ lat: z.number().min(30).max(43), lon: z.number().min(-32).max(-6) })]).optional()
    .describe('Where the driver is heading, a town or lat/lon: picks the side of a motorway service area they can reach'),
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
  min_voltage: z.number().int().positive().max(1500).optional().describe('Minimum socket voltage, V (e.g. 800 for an 800 V car)'),
  card_payment: z.boolean().optional().describe('Only chargers where a bank card works at the charger itself (terminal or contactless)'),
  cable_attached: z.boolean().optional().describe('true: only sockets with a fixed cable; false: only those where the user brings one'),
  open_now: z.boolean().optional().describe('Leave out chargers closed now (or at `at`) by their opening hours'),
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
  if (site.operatorInferred) notes.push(t('assume.operatorInferred', { operator: site.operator }));
  const phone = site.phone ?? site.osm?.phone;
  return {
    facts: {
      operatorInferred: site.operatorInferred,
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
  .describe('Drop chargers whose session takes longer, minutes: slow AC is often cheapest but takes hours, so set it on a trip or in a hurry');

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
    || a.card_payment === true || a.cable_attached != null || a.open_now;
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

// A socket in a summary line. The NAP leaves power and plug blank on some
// sockets: kw arrives as null and connector as the text "nan".
const socketLine = q => `${q.kw ?? '?'} kW ${q.connector === 'nan' ? '?' : q.connector ?? '?'}`;

const rnd = x => x == null ? undefined : Math.round(x * 10) / 10;

// A cost answer leads with one price, and assistants tend to stop there: the
// evals caught them leaving out every other way to pay. When a charger has
// more than its best, the result itself says so.
// A tariff the user would have to switch to (notYours) isn't a way to pay yet.
const waysToPay = q => (q.options ?? []).filter(o => !o.notYours).length;
export const moreWays = (results, t) => results.some(q => waysToPay(q) > 1) ? [t('note.moreWays')] : [];

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
      // operatorInferred: a socket on a lent site must not merge into a named
      // sibling's, or its assumption goes with it.
      const key = canonical([point.kw, point.cable, point.connector, point.dc, point.level, point.regime, point.opc, point.napPrice, h.site.operatorId, !!h.site.operatorInferred]);
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

// Rows list_ceme_tariffs returns: the assistant is looking for one card, not
// reading a catalogue. The result says when this cut bit.
const MAX_TARIFFS = 60;

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
    description: 'Lists the CEME tariffs (the EV charging cards/apps of the electricity retailers on MOBI.E, Portugal), to turn what the user pays with ("EDP", "Via Verde") into tariff_ids for the cost tools. Also lists the CEMEs\' current promotions at specific charging networks.',
    inputSchema: z.object({ query: z.string().max(200).optional().describe('CEME or tariff name, e.g. "edp", "via verde"'), ...Audience, ...Lang }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ query, audiences, lang: l }, ctx) => {
    const t = translator(langOf({ lang: l }, ctx));
    // A ceme-v2 without /v1/promos still lists the tariffs.
    let all, current;
    try { [all, current] = await Promise.all([tariffs(), promos().catch(() => ({ data: [] }))]); }
    catch (e) { if (e.ceme) return err(t('err.tariffs'), 'ceme'); throw e; }
    const q = fold(query);
    // One row per tariff, not per voltage: the BT/MT variant is picked per charger.
    const seen = new Map();
    for (const t of all.data ?? all) {
      const key = tariffKey(t.id);
      const name = `${t.ceme_name ?? t.ceme} ${t.name}`;
      if (q && !fold(name).includes(q)) continue;
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
    const shown = rows.slice(0, MAX_TARIFFS);
    const notes = rows.length > shown.length ? [t('note.tariffsCut', { n: shown.length, total: rows.length, narrowed: !!q })] : [];
    return ok({ version: VERSION, count: rows.length, ...(notes.length && { notes }), tariffs: shown, ...(promoRows.length && { promos: promoRows }) },
      `${[...notes, ''].join('\n')}${rows.length} tariffs${promoRows.length ? `, ${promoRows.length} promotions` : ''}:\n${shown.map(r => `${r.tariff_id}: ${r.ceme} · ${r.name}${r.requiresOtherContract ? ' (needs another contract)' : ''}${r.newCustomersOnly ? ' (new sign-ups only)' : ''}${r.until ? ` (until ${r.until})` : ''}`).join('\n')}`);
  });

  server.registerTool('lookup_charger', {
    title: 'Look up a charger',
    description: 'Finds one public EV charger in Portugal the way the user names it: the code on its sticker ("LRA-00156"), operator or brand plus town ("Continente Leiria", "IONITY Mealhada"), the shop or place it is at, or its address. Returns what is published about it: each socket\'s power, plug, live status, operator fee, walk-up (ad hoc) price and direct offers, as published (mostly without VAT; estimate_charging_cost gives final prices), plus OpenStreetMap details in "osm". The NAP "operator" runs the charger and bills its fee; OSM\'s brand is often the owner or the shop (Lidl\'s chargers are run by Galp): say who operates it and credit OpenStreetMap. "missing" lists the user\'s words a site lacks: don\'t present it as their charger without saying so. If several fit, ask which (operator, address, town). For the cost, pass its siteId as site to estimate_charging_cost.',
    inputSchema: z.object({
      query: z.string().min(1).max(200).describe('The user\'s words for the charger: code, operator/brand, place, town, address'),
      lat: Where.lat, lon: Where.lon,
      radius_km: z.number().positive().max(300).optional().describe('With lat/lon: only sites this close, km'),
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
    }, [...new Set(notes), ...cards.map(c => `${c.siteId}: ${c.operator ?? '?'}, ${c.address ?? ''}, ${c.city ?? ''} · ${c.sockets.map(g => `${g.count}× ${socketLine(g)}`).join(', ')}`)].join('\n'));
  });

  server.registerTool('find_chargers', {
    title: 'Find chargers',
    description: 'Lists public EV chargers in Portugal near a place, along a route, or in the whole country when a filter is given (every 800 V charger, every IONITY site, card_payment), with power, voltage, plug, fixed cable, opening hours, bank card payment and live status per socket. No prices: for costs use find_cheapest_charging; for one charger the user names, lookup_charger.',
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
    description: 'Lists the companies that operate public EV chargers in Portugal (OPCs on MOBI.E and the operators outside it, as the NAP publishes them), biggest first: sites, sockets, DC sockets, max power and voltage, regions, and whether they are on MOBI.E. Filters narrow it to the operators with such chargers ("who runs 800 V chargers in Madeira?"). Use it for "how many operators are there" too, even when the user says licensed: it is the operators with chargers on the NAP, not the DGEG\'s licensing registry, so say that.',
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
    const notes = [t('note.operators'), ...voltageNotes(ds, a, t),
      ...shown.filter(o => o.inferredSites).map(o => t('note.operatorsInferred', { operator: o.name, n: o.inferredSites }))];
    return ok({ ...meta(ds, live, lang), total: ops.length, notes, operators: shown },
      [...notes, `${ops.length} operators:`, ...shown.map(o => `${o.operatorId ?? '-'}: ${o.name} · ${o.sites} sites, ${o.points} sockets (${o.dcPoints} DC), max ${o.maxKw ?? '?'} kW`)].join('\n'));
  });

  registerAppTool(server, 'find_cheapest_charging', {
    title: 'Find cheapest charging',
    description: 'Ranks public EV chargers in Portugal near a place or along a route by the estimated cost of the user\'s charging session (energy + operator fee + taxes; MOBI.E and other networks in one list), for their car and battery levels. Each result has "best", the cheapest way to pay the user can use now, and every way to pay in "options".',
    inputSchema: z.object({
      ...Where, ...Filter, ...Car, ...Audience, ...Detail, ...Lang, max_minutes: maxMinutes,
      available_only: z.boolean().default(true).describe('Skip chargers reported busy, out of order or blocked'),
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
    const tooLong = { hours: MAX_SESSION_HOURS, n: ranked.tooLong };
    // err.tooLong only when no socket could be priced at all: with any priced
    // socket dropped by a filter, raising the filter is the advice.
    if (!ranked.length) return ranked.nonePriced ? err(t('err.tooLong', tooLong), 'tooLong') : err(t('err.noneLeft'), 'noneLeft');
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
      if (i >= DETAIL_IN_RANKING) {
        delete q.timeline;
        for (const o of q.options) delete o.components;
      }
    }
    const notes = [
      ...(cemeDown ? [t('note.noCeme')] : []),
      ...voltageNotes(ds, a, t),
      ...(truncated ? [t('note.truncated', { n: candidates.length, total })] : []),
      ...(ranked.tooLong ? [t('note.tooLong', tooLong)] : []),
      ...(a.detail && top.length > DETAIL_IN_RANKING ? [t('note.detailTop', { n: DETAIL_IN_RANKING })] : []),
      ...moreWays(top, t),
    ];
    const data = { kind: 'ranking', ...meta(ds, live, lang), resolvedPlace: w.resolvedPlace, searched: total, quoted: candidates.length,
      ...(truncated && { truncated: true }), ...(cemeDown && { cemeUnavailable: true }), ...(notes.length && { notes }), results: top };
    // Summary lines on top of the JSON in the text (see ok).
    const lines = top.map((q, i) => `${i + 1}. ${q.best ? (q.best.peakPrice ? '<= ' : '') + q.best.total.toFixed(2) + ' € · ' + q.best.label + (waysToPay(q) > 1 ? ` (+${waysToPay(q) - 1} more ways to pay)` : '') : q.total ? '>= ' + q.total.eur.toFixed(2) + ' €' : 'n/a'} · ${q.session.minutes} min · ${q.operator ?? ''} ${q.address ?? ''}, ${q.city ?? ''} (${socketLine(q)}) [${q.pointId}]`);
    return ok(data, [...notes, ...lines].join('\n'));
  });

  registerAppTool(server, 'estimate_charging_cost', {
    title: 'Estimate charging cost',
    description: 'Estimated cost and duration of a charging session at one public EV charger in Portugal (site) or one socket (point_id), with the full breakdown and every way to pay. Each kind of socket at the site is priced, cheapest first.',
    inputSchema: z.object({
      site: z.string().max(200).optional().describe('The charger: siteId from lookup_charger or the other tools (e.g. "GLP-LRA-00156"), its sticker code ("LRA-00156"), or the user\'s words for one site'),
      point_id: z.string().max(200).optional().describe('One socket, "SITE/POINT"; only when the user picked one'),
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
    const quoted = await Promise.all(targets.map(hit => quotePoint(hit, car(a), opts)));
    const priced = quoted.filter(Boolean);
    const tooLong = { hours: MAX_SESSION_HOURS, n: quoted.length - priced.length };
    if (!priced.length) return err(t('err.tooLong', tooLong), 'tooLong');
    const results = priced.sort(byBest).slice(0, MAX_KINDS);
    for (const q of results) q.assumptions.push(...assumptions);
    const cemeDown = results.some(q => q.cemeUnavailable);
    if (cemeDown && !results.some(q => q.best)) return err(t('err.pricing'), 'ceme');
    const lines = results.map(q => `${q.best ? `${q.best.peakPrice ? '<= ' : ''}${q.best.total.toFixed(2)} € · ${q.best.label}` : q.total ? `>= ${q.total.eur.toFixed(2)} €` : 'n/a'} · ${q.session.minutes} min · ${socketLine(q)} [${q.pointId}]`);
    const notes = [...(cemeDown ? [t('note.noCeme')] : []), ...(tooLong.n ? [t('note.tooLong', tooLong)] : []), ...moreWays(results, t)];
    return ok({ kind: 'single', ...meta(ds, live, lang), ...(cemeDown && { cemeUnavailable: true }), ...(notes.length && { notes }), results },
      [...notes, ...lines].join('\n'));
  });

  registerAppResource(server, 'Charging results', VIEW_URI, {
    description: 'Inline view of charging cost results',
  }, async () => ({
    contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: await viewHtml(), _meta: { ui: { prefersBorder: true } } }],
  }));

  return server;
}
