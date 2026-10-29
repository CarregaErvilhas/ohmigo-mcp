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
3. **`src/live.js`** makes sure the live status is less than 5 minutes old.
   If it isn't, it downloads the NAP feed while the user sees a progress
   message ([03](03-live-status.md)).
4. **`src/data.js`** finds every site within the radius, or along the route,
   and keeps the plugs that pass the filters.
5. **`src/quote.js`** prices every plug:
   - **`src/charging.js`**: how many kWh the meter will count, and how long it takes;
   - **`src/profile.js`**: when each of those kWh goes in, cut into quarter-hours;
   - **`src/ceme.js`**: one call to ceme-v2 for every CEME tariff's energy price,
     each quarter at its own off-peak/peak period and OMIE price;
   - **`src/opc.js`**: the operator's fee for that energy and time;
   - **`src/offers.js`**: walk-up, app, eMSP and subscription prices that apply here.

   Each way to pay becomes one entry in `options` ([02](02-cost-math.md)).
6. Still in `quote.js`, `rank` drops busy or broken chargers, keeps the
   cheapest plug per site, and sorts sites by `best`: the cheapest option
   anyone can use.
7. `mcp.js` returns the top results as `structuredContent`. Chat apps that
   support **MCP Apps** also load `ui/results.html` (built by `src/view.js`)
   and show it inline.

## Files

| File | What it does |
|---|---|
| `src/server.js` | HTTP server, boot, health check, landing page, weekly dataset swap |
| `src/mcp.js` | Tools, argument schemas, the instructions the assistant reads |
| `src/i18n.js` | Every user-facing sentence, in English and Portuguese |
| `src/data.js` | Loads the dataset; searches by distance and along a route |
| `src/lookup.js` | Finds a charger by what the user calls it: code, operator or brand, OSM name, town, address |
| `src/live.js` | Live status from the NAP: on-demand download, cache, parser |
| `src/quote.js` | Prices one plug for every way to pay; ranks plugs |
| `src/charging.js` | Session energy and duration, as constant-power segments |
| `src/profile.js` | Lays the session on the clock: kWh per quarter-hour, local times |
| `src/opc.js` | Operator fee math (flat, per kWh, per-minute tiers) |
| `src/ceme.js` | Client for ceme-v2's API, with a cache |
| `src/offers.js` | Loads the direct offers, picks the ones for a charger; finds missing operators |
| `src/offers-parse.js` | Parses the custofinal blog's price tables |
| `src/view.js` | Builds the inline results page with the MCP Apps bridge |
| `ui/results.html` | The inline results page |
| `site/index.html` | The landing page at `/`: what ohmigo is and how to install it, in both languages |
| `offers/custofinal.json` | Direct offers scraped from the blog (generated) |
| `offers/manual.json` | Hand-made corrections and additions to it |
| `offers/networks.json` | Which chargers each blog network label means |
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
  `osm` block from nap-dashboard (OpenStreetMap's name, brand, operator: the
  shop or car park it's at), town and address. A word matches the start of a
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
