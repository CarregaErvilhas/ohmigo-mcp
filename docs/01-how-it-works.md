# 01 — How it works

Words in **bold** are in the [glossary](00-glossary.md).

## The big picture

```
 user: "where's the cheapest place to charge near Leiria?"
   │
   ▼
 AI assistant (ChatGPT / Claude / ...)        remembers the car, the user's cards
   │  asks what's missing, looks up the car's specs
   │  calls find_cheapest_charging { place, battery_kwh, start_pct, lang, ... }
   ▼
 ohmigo (this repo)
   ├── dataset: sites, plugs, power, OPC fees     ◄── nap-dashboard, weekly
   ├── live status (+ NAP fees as a fallback)     ◄── NAP dynamic feed, on demand
   ├── CEME energy prices                         ◄── ceme-v2 API
   └── direct offers (TPA, apps, subscriptions)   ◄── offers/, scraped weekly + manual
   │
   ▼
 JSON (+ an inline results page) back to the assistant, which answers the user
```

ohmigo stores **nothing about the user**. No accounts, no logins, no
database. The car, the battery size and the user's CEME cards live in the
assistant's memory and arrive with every call. That keeps the server simple,
cheap to run, and private by construction.

## A request, step by step

Follow one `find_cheapest_charging` call through the code:

1. **`src/server.js`** receives `POST /mcp`, creates a fresh MCP server
   object for this request, and hands it the request.
2. **`src/mcp.js`** validates the arguments against the zod schema, picks the
   language (`lang`), and turns "Leiria" into coordinates
   (`Dataset.resolvePlace`).
3. **`src/live.js`** makes sure the live status is less than 15 minutes old.
   If it isn't, it downloads the NAP feed while the user sees a progress
   message ([03](03-live-status.md)).
4. **`src/data.js`** finds every site within the radius, or along the route,
   and keeps the plugs that pass the filters. `mcp.js` keeps one plug per
   kind per site (ten identical T2s price the same) and, on a wide search,
   only the nearest sites up to a cap; the result says `truncated` when that
   bit.
5. **`src/quote.js`** prices every plug:
   - **`src/charging.js`**: how many kWh the meter will count, and how long it takes;
   - **`src/profile.js`**: when each of those kWh goes in, cut into quarter-hours;
   - **`src/ceme.js`**: one call to ceme-v2 for every CEME tariff's energy price,
     each quarter at its own off-peak/peak period and OMIE price;
   - **`src/opc.js`**: the operator's fee for that energy and time;
   - **`src/offers.js`**: walk-up, app, eMSP and subscription prices that apply here;
   - **`src/promos.js`**: the CEME promotions (from ceme-v2) that hold at this charger's network.

   Each way to pay becomes one entry in `options` ([02](02-cost-math.md)).
6. Still in `quote.js`, `rank` drops busy or broken chargers, keeps the
   cheapest plug per site, and sorts sites by `best`: the cheapest option
   the user can use or, with `tariff_ids`, a tariff the user listed, and never
   a CEME tariff they didn't list.
   If ceme-v2 doesn't answer, plugs on MOBI.E come back without a CEME total
   (`cemeUnavailable`) and the other ways to pay still rank.
7. `mcp.js` returns the top results as `structuredContent`, and the same
   JSON as text (after a few summary lines) for clients that only pass the
   text to the model. Chat apps that
   support **MCP Apps** also load `ui/results.html` (built by `src/view.js`)
   and show it inline.

## What the assistant reads

Before it calls anything, the assistant gets the server's `INSTRUCTIONS` and
the tool list (names, descriptions, argument schemas), all in `src/mcp.js`.
Both sit in its context in every conversation where ohmigo is connected,
whether the user asks about charging or not, and some clients cut the
instructions short. So you put each piece of guidance in the narrowest place
it applies:

- **`INSTRUCTIONS`**: only what holds across tools (who's who on MOBI.E, never
  ask for a charger id, what to look up yourself, how to present a price).
  `INSTRUCTIONS_MAX` is its budget and `test/mcp.test.js` enforces it.
- **A tool's description, or an argument's `.describe()`**: what only that
  tool or argument needs. Clients that load tools on demand only read these
  when the tool is about to be used, so this text costs nothing until then.
  Each description names the domain ("EV", "Portugal"), because that's what
  those clients search to find the tool.
- **The result** (`assumptions`, `notes`, an option's `note`, through
  `src/i18n.js`): what holds only for some answers (a peak price, a promotion
  for new customers, a missing direction). It shows up exactly when it
  applies, and every client passes it on.

The tool list has a budget too (`TOOLS_MAX_CHARS` in `test/http.test.js`).
When it bites, trim before you raise it, and prefer one more argument on an
existing tool over a new tool that does almost the same thing.

Whether a model actually follows all this is what `evals/` checks: a model
plays the assistant against a local server, and its tool calls and replies are
graded ([evals/README.md](../evals/README.md)).

## Files

| File | What it does |
|---|---|
| `src/server.js` | HTTP server, boot, health check, landing page, weekly dataset swap |
| `src/mcp.js` | Tools, argument schemas, the instructions the assistant reads |
| `src/i18n.js` | Every user-facing sentence, in English and Portuguese |
| `src/data.js` | Loads the dataset; searches by distance, along a route or the whole country; town names to coordinates; the operator list (`list_operators`) |
| `src/geo.js` | Distances: haversine, distance to a route |
| `src/hours.js` | Opening hours (NAP and OpenStreetMap, both in OSM syntax): is the site open at a given moment |
| `src/lookup.js` | Finds a charger by what the user calls it: code, operator or brand, OSM name, town, address |
| `src/direction.js` | Motorway service areas: which side the driver can reach, from where they're heading |
| `src/live.js` | Live status from the NAP: on-demand download, cache, parser |
| `src/quote.js` | Prices one plug for every way to pay; ranks plugs |
| `src/charging.js` | Session energy and duration, as constant-power segments |
| `src/profile.js` | Lays the session on the clock: kWh per quarter-hour, local times |
| `src/opc.js` | Operator fee math (flat, per kWh, per-minute tiers) |
| `src/ceme.js` | Client for ceme-v2's API, with a cache and a circuit breaker |
| `src/offers.js` | Loads the direct offers, picks the ones for a charger; finds missing operators |
| `src/promos.js` | CEME promotions at one network: which hold at a charger, and what they do to the price |
| `src/offers-parse.js` | Parses the custofinal blog's price tables |
| `src/view.js` | Builds the inline results page with the MCP Apps bridge |
| `src/dump.js` | The data behind the tools for people (`/dados`): CEME tariffs and promotions, direct offers, operators and their fees, per charger on demand |
| `src/stats.js` | One log line per tool call, counters for `/healthz` |
| `src/version.js` | The version, read from `package.json` |
| `ui/results.html` | The inline results page |
| `site/index.html` | The landing page: what ohmigo is and how to install it, every sentence in both languages |
| `src/site.js` | Renders the landing page on the server, Portuguese at `/` and English at `/en`, with the tags search engines read (canonical, hreflang, Open Graph, JSON-LD) and `/sitemap.xml` |
| `site/og.png` | The image link previews show (WhatsApp, Facebook, X) |
| `site/dados.html` | `/dados`: browse what `src/dump.js` returns. Public, `noindex`, cached by Cloudflare (Cache Rule on the zone, TTLs from the headers in `src/server.js`); Portuguese only |
| `offers/custofinal.json` | Direct offers scraped from the blog (generated) |
| `offers/manual.json` | Hand-made corrections and additions to it |
| `offers/audiences.json` | Groups with prices of their own (employees, ride-hailing drivers), hidden unless the driver claims one |
| `offers/networks.json` | Which chargers each network label means (blog offers and CEME promotions) |
| `scripts/call.mjs` | Dev helper: call a tool from the terminal |
| `scripts/scrape-offers.mjs` | Weekly scrape of the blog (`.github/workflows/offers.yml`) |
| `scripts/offer-gaps.mjs` | Lists operators that probably sell directly and have no offer |
| `test/` | `npm test` |

## Finding the charger the user means

Nobody knows a charger's id. People say "the Continente in Leiria", "IONITY
Mealhada", "the Lidl in Coimbra", or read the code off the sticker
("LRA-00156"). `lookup_charger` takes those words (`src/lookup.js`):

- **A code** finds its site however it's written: with or without the
  operator prefix (`GLP-LRA-00156`), MOBI.E's (`MOBI-LRA-00156`), the leading
  zeros, or the socket number (`LRA-00156-02`). Ids that aren't MOBI.E codes
  (Tesla's UUIDs, Continente's `0001PL0002`) match whole.
- **Words** must all appear in what the site is known by: the NAP's operator,
  the network labels in `offers/networks.json` ("Powerdot" for `HORZ`), the
  `osm` block from nap-dashboard (OpenStreetMap's name, brand, operator:
  often the chargers' owner or the shop they're at), town and address. A word matches the start of a
  site word, and longer words forgive one typo. Words like "posto", "area de
  servico" or "near" are ignored.
- A **town** in the words orders the matches by distance to it, so "IONITY
  Mealhada" lists the IONITY sites nearest Mealhada when there's none in it.
  When no site has every word, each result says which words it lacks
  (`missing`), and the assistant is told not to pass it off as the one.

`estimate_charging_cost` takes the same text as `site`. Several NAP sites in
one spot (a motorway service area often has one per charger) are one place to
the driver and are priced together; matches in different places come back as
a question for the user. The other two search tools take the words as `query`,
a filter on top of the place or route ("Continente" near Leiria).

**Who operates vs who owns.** The NAP's operator is the OPC that runs the
charger and bills its fee. The owner can be someone else: Lidl's chargers are
owned by Lidl and operated by Galp, so the NAP says Galp and OSM's brand says
Lidl. Both are right, and both are searchable.

**Sites the NAP leaves nameless.** Some operators publish part of their sites
with neither `operator` nor `operatorId` (Continente's `CNT-0001PL0002`). When
you load a dataset, `lendOperators` (`src/lookup.js`) gives such a site the
operator of its id prefix, if the named sites with that prefix all have one
operator, and marks it `operatorInferred`. From there on it's that operator's
site for search, offers, promotions, labels, `list_operators` and `/dados`;
the answers say the operator was inferred (`assume.operatorInferred`). A site
with nobody to lend it a name stays nameless: on `/dados` those share one row.

## Motorways: which side of the road

A motorway service area usually has a charger site on each side of the road,
and a driver can only reach the one on their side. Both often share a name
and even an address in the NAP, so what tells them apart is where the driver
is heading (`src/direction.js`):

- **Without a direction**, `estimate_charging_cost` doesn't guess: it answers
  with the sides and tells the assistant to ask the user which way they're
  going, then call again with `towards` (a town or lat/lon).
  `lookup_charger` flags the pair (`directionNeeded`, `otherSide`).
- **With a direction**, the side is the one whose published direction
  agrees ("N/S", "S-N", "sentido Lisboa", in the NAP address or the OSM
  name; off a motorway "S/N" means sem número, so there only "sentido …"
  counts). Without one, the **right-hand rule**: Portugal drives on the right,
  so the service area to the right of the travel direction. That's a guess
  from coordinates, so it only decides when one side is clearly to the right,
  and the result carries an assumption telling the user to check the signs.
  When it can't decide, both sides are priced.
- **On a route**, the far side is dropped only when the sites publish their
  direction. Routes are often a few waypoints, too coarse for twins a hundred
  metres apart.

The rule is checked against every pair the data labels
(`test/direction.test.js`). Because twins can stand closer together than two
chargers of one car park, motorway sites only count as one place when their
labels agree or they're a few dozen metres apart (`samePlace`).

## Design decisions worth knowing

**Why not compute the energy price here?** ceme-v2 already does it, with
indexed tariffs, time zones, daylight saving and island VAT. Doing it twice
means two places to fix every bug, so ohmigo calls its API.

**Why no auth?** The data is public and nothing is stored. A login would only
add friction for people trying it in a chat app. If ohmigo ever stores
something per user, that changes.

**Why fetch live status on demand instead of polling?** Traffic is low, and a
poller would download 38 MB every few minutes for nobody ([03](03-live-status.md)).

**Why one JSON file for the dataset, not a database?** ~9k sites fit in
memory in a few MB, and a search is a few milliseconds of looping. A database
would be one more service to run, for no gain.

**Why does the assistant send `lang`?** Some of our text reaches the user
almost word for word (assumptions, payment labels, the progress message, the
inline page). We write it in Portuguese and English; for any other language
the assistant translates it.
