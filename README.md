# ohmigo MCP

Your charging amigo: "ohm" + "amigo".

An MCP server that answers two questions about every public EV charger in
Portugal, on every network published on the National Access Point (NAP):
MOBI.E and the ones outside it (Tesla, Continente...). From inside ChatGPT,
Claude or any other AI assistant:

- **How much will this charge cost?**
- **Where's the cheapest place to charge near me, or on my way?**

You tell your assistant where you are and what you drive. It looks up the
car's battery and charging speed, asks your battery %, and calls ohmigo.
ohmigo answers with the total cost and duration at each charger, for every
way you could pay there: your CEME card, a bank card at the charger, or the
operator's own app or subscription. Chat apps that support MCP Apps also show
the results as a small inline page.

ohmigo stores nothing about you. Your assistant remembers your car and cards
and sends them with each question.

**New to EV charging in Portugal?** Read the [glossary](docs/00-glossary.md)
first: CEME, OPC, MOBI.E, NAP and the rest.

## What the price includes

| Part | Source |
|---|---|
| Energy from the CEME (with TAR, IEC, activation fee, VAT) | [ceme-v2](https://ceme.ocarroeletrico.com/api), queried live |
| The charger operator's fee (per session, per kWh, per minute) | MOBI.E's tariff file; the NAP live feed when it's missing |
| Bank card / QR price at the charger | MOBI.E's tariff file |
| Walk-up (TPA/QR), operator app, roaming app and subscription prices | scraped weekly, with permission, from Alexandre Moleiro's [Preços (finais) kWh Portugal](https://custofinal.blogspot.com) into [`offers/`](offers/), with hand corrections |
| Whether the charger is free right now | the NAP live feed |
| Energy and duration of your session | estimated from your car's specs ([02](docs/02-cost-math.md)) |

Everything is an estimate, and every assumption comes back with the price so
the assistant can tell you.

## Docs

1. [Glossary](docs/00-glossary.md): the vocabulary
2. [How it works](docs/01-how-it-works.md): the big picture and a request step by step
3. [The cost math](docs/02-cost-math.md): energy, time, fees, ways to pay, ranking
4. [Live status](docs/03-live-status.md): the 38 MB feed and how we tame it
5. [Direct offers](docs/04-operator-offers.md): walk-up, apps, subscriptions; the weekly scrape
6. [The dataset](docs/05-dataset.md): where the charger data comes from
7. [Run, connect, deploy](docs/06-run-and-deploy.md)

## Quick start

Node.js 24:

```bash
npm ci
npm test
npm start                 # http://127.0.0.1:3002/mcp
node scripts/call.mjs find_cheapest_charging '{"place":"Leiria","battery_kwh":58,"start_pct":20}'
```

## Tools

| Tool | What it does |
|---|---|
| `find_cheapest_charging` | ranks chargers near a place or along a route by session cost (with inline view) |
| `estimate_charging_cost` | one charger (by site, code or name), full breakdown, every way to pay (with inline view) |
| `lookup_charger` | finds the charger the user names ("Continente Leiria", "LRA-00156", "o Lidl de Coimbra") and returns everything the data has on it |
| `find_chargers` | chargers near a place, along a route, or in the whole country by filter (power, voltage, plug, operator, bank card, fixed cable, open now), with live status, no prices |
| `list_operators` | the companies that operate chargers on the NAP, biggest first, with their sites, sockets, power, voltage and regions |
| `list_ceme_tariffs` | turns "EDP" or "Via Verde" into tariff ids |

## Known limits

- **The energy price follows the clock.** Each quarter-hour of the session
  is priced at its own off-peak/peak period and OMIE price, from the start
  time the assistant passes (default now). Ask for `detail` to see it
  quarter by quarter ([02](docs/02-cost-math.md)).
- **Durations are modelled**, not measured. Without the car's curve or 10-80 %
  time, they're rough.
- **Live data can be old.** A recent copy of the feed answers at once while a
  newer one downloads, up to the age set by `LIVE_MAX_STALE_SECONDS`, and the
  answer says how old it is. Only the first question after a long quiet spell
  waits for the download ([03](docs/03-live-status.md)).
- **Some MOBI.E chargers publish no operator fee anywhere.** Their price is
  energy only, shown as "≥".
- **Chargers outside MOBI.E** (Continente, Tesla) are priced from the NAP's
  per-site price plus the region's VAT (the NAP publishes prices without
  VAT), next to any offers for that network. `offers/nap-notes.json` drops a
  NAP price known to be wrong.
- **Direct offers come from one public price list.** Each one shows its
  source and date; `npm run offers:gaps` shows operators with no offer yet.
