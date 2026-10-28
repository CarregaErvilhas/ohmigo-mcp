# ohmigo

Your charging amigo: "ohm" + "amigo".

An MCP server that answers "how much will this charge cost?" and "where's the
cheapest charger near me / on my route?" for Portugal's public EV network
(MOBI.E). It works in developer agents and in chat apps (Claude, ChatGPT): the
cost tools ship an [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
view that renders the results inline.

It's stateless and stores nothing about the user. The agent remembers the car,
battery and favourite tariff, and sends them on every call. The server's
`instructions` tell the agent what to ask and what to look up itself (usable
battery capacity and max AC/DC power from the car model).

## Where the numbers come from

| Part of the bill | Source |
|---|---|
| CEME energy tariff + TAR + IEC + EGME + VAT | [ceme-v2](../ceme-v2) `POST /v1/simulate`, called over HTTP. Indexed tariffs are priced at the OMIE quarter-hour of the charge. |
| OPC fee (€/charge, €/kWh, €/min tiers) | MOBI.E tariff file, parsed by `scripts/build_dataset.py`; NAP live feed as fallback (cents, no tiers) |
| Charger status (available, in use, out of order) | NAP live feed, polled in the background (`src/live.js`) |
| Charger location, power, plug, voltage level | NAP (DATEX II), via the [nap-dashboard](../nap-dashboard) pipeline |
| Session energy and duration | `src/charging.js`: from the car's charging curve or published 10-80 % time when the agent passes them, a generic curve otherwise |

Total = CEME total (already includes VAT) + OPC fee × the region's VAT. MOBI.E
says VAT applies to the whole invoice, so the OPC fee is treated as published
without VAT.

## Tools

- `list_ceme_tariffs`: resolve "EDP" / "Via Verde" to a `tariff_id`.
- `find_chargers`: chargers near a point/town or along a route, no costs.
- `find_cheapest_charging` (with UI): ranks sites by session cost for the car,
  skipping chargers the live feed reports as busy or broken. Chargers outside
  MOBI.E come back apart in `outsideMobie`.
- `estimate_charging_cost` (with UI): one charge point, full breakdown.

## Tariffs

With `tariff_ids` (the cards/subscriptions the user has), each charger is
priced with the cheapest of them. Without, the result shows the top 3 of
ceme-v2's "popular" tariffs, headlined by the cheapest that needs no other
contract. A cheaper tariff outside that set comes back as `cheaperTariff`.

## Live status

MOBI.E's status feed is one ~38 MB XML file with no gzip or byte ranges
(about 13 s to download). User requests never touch it: one background
poller per process fetches it with `If-None-Match` (304 when unchanged),
stream-parses it (~0.2 s) and keeps a point -> status/fees map. Every
response says when MOBI.E published the data and whether it's fresh.

## Run locally

Node 24. Build the dataset from a nap-dashboard checkout whose pipeline has
run (`fetch_data.sh` + `nap_etl.py`):

```sh
npm ci
../nap-dashboard/venv/bin/python scripts/build_dataset.py ../nap-dashboard/data data/chargers.json
npm test
npm start                         # http://127.0.0.1:3002/mcp
node scripts/call.mjs find_cheapest_charging '{"place":"Leiria","battery_kwh":58,"start_pct":20}'
```

Without `CEME_API_KEY` the server borrows an anonymous ceme-v2 web session,
which is rate-limited per IP (60/min). That's fine for development but not for a shared server.

| Env | Default | |
|---|---|---|
| `PORT` / `HOST` | `3002` / `127.0.0.1` | Zerops needs `HOST=0.0.0.0` |
| `CEME_API_URL` | `https://ceme.ocarroeletrico.com` | |
| `CEME_API_KEY` | none | ceme-v2 third-party key |
| `DATASET_URL` | none | fetch `chargers.json` at boot and every 6 h |
| `DATASET_PATH` | `data/chargers.json` | used when `DATASET_URL` is unset |
| `NAP_POLL_SECONDS` | `180` | live feed poll interval; `NAP_POLL=0` turns polling off |
| `NAP_STATUS_URL` | MOBI.E's `evActualStatus` | |

## Known limits

- **Status is minutes old**, not instant. A charger can be taken on the way.
- **Duration is modelled**, not measured. Without the car's curve or 10-80 %
  time, DC averages 70 % of peak up to 80 % and 30 % above. Per-minute OPC
  fees depend on it.
- **MOBI.E sockets missing from the tariff file** use the NAP live fees. If
  neither has a fee, the total is energy-only, marked `complete: false` and
  ranked after complete ones.
- **~1,400 points are outside MOBI.E** (`sem_ceme`: Continente, Tesla). NAP
  gives one price with no declared meaning; the estimate assumes it's a final
  €/kWh price, is marked with an asterisk and is never ranked with MOBI.E.
- Some sockets publish two values for the same fee. Those come back as a
  `low`/`high` range.
