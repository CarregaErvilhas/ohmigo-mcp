# carrega-mcp

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
| OPC fee (€/charge, €/kWh, €/min tiers) | MOBI.E tariff file, parsed by `scripts/build_dataset.py` |
| Charger location, power, plug, voltage level | NAP (DATEX II), via the [nap-dashboard](../nap-dashboard) pipeline |
| Session energy and duration | `src/charging.js`: an estimate, with its assumptions returned to the agent |

Total = CEME total (already includes VAT) + OPC fee × the region's VAT. MOBI.E
says VAT applies to the whole invoice, so the OPC fee is treated as published
without VAT.

## Tools

- `list_ceme_tariffs`: resolve "EDP" / "Via Verde" to a `tariff_id`.
- `find_chargers`: chargers near a point/town or along a route, no costs.
- `find_cheapest_charging` (with UI): ranks sites by session cost for the car.
- `estimate_charging_cost` (with UI): one charge point, full breakdown.

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

## Known limits

- **Charger status is a weekly snapshot**, not live. The agent is told to say so.
- **Duration is modelled**, not measured: DC averages 70 % of peak up to 80 %
  and 30 % above. Per-minute OPC fees depend on it.
- **~1,100 MOBI.E sockets have no OPC tariff** in the file. Their totals are
  energy-only, marked `complete: false` and ranked after complete ones.
- **~1,400 points are outside MOBI.E** (`sem_ceme`). NAP gives one price with
  no declared unit or VAT treatment, so there's no total for them.
- Some sockets publish two values for the same fee. Those come back as a
  `low`/`high` range.
