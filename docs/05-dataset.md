# 05 — The dataset

"The dataset" is the slow-changing half of the data: where each charger is,
its plugs, power and voltage level, how the site lets you pay, and the
operator fees from MOBI.E's tariff file. It's one JSON file, served gzipped
(the URL is `DEFAULT_URL` in `src/data.js`).

What's **not** in it: live status (changes by the minute, see
[03](03-live-status.md)), CEME prices (ceme-v2's job), and operator direct
offers (`offers/`, see [04](04-operator-offers.md)).

## Where it comes from

```
 Monday 06:00 UTC, nap-dashboard's refresh.yml
   │  downloads the NAP static XML and MOBI.E's tariff CSV
   │  runs its pipeline (including the OpenStreetMap dump), then scripts/ohmigo_dataset.py
   │  uploads the result as the "ohmigo-dataset" Actions artifact
   ▼
 nap-dashboard's pages.yml
   │  copies the newest one next to the dashboard
   ▼
 https://nap.ocarroeletrico.com/ohmigo/chargers.json      (GitHub Pages, a CDN)
   │
   ▼
 ohmigo: loaded at boot, re-checked every 6 hours
```

The builder lives in nap-dashboard because that's where the raw files and the
weekly job already are. ohmigo only downloads the result.

## Why "every 6 hours" if it changes once a week?

The server can run for weeks without a restart, so it needs a way to notice
Monday's new file. Every 6 hours (`DATASET_CHECK_HOURS`) it asks Pages "has
this changed?", sending the `ETag` of the copy it has:

- **Unchanged** (most checks): Pages answers `304 Not Modified`, a few hundred
  bytes, and nothing else happens.
- **Changed** (once a week): the server downloads the new file,
  checks it, and swaps it in. Requests already running finish on
  the old copy.
- **Failed** (Pages down, bad file): the server keeps the copy it has and
  tries again 6 hours later.

So the new data shows up at most 6 hours after Monday's refresh, for almost no
traffic. A shorter interval would be fine too. Longer would just mean a later
Monday.

## The format

```json
{
  "schema": 1,
  "generatedAt": "2026-10-28T16:55:50+00:00",
  "sites": [{
    "id": "IOY-ALB-00019", "code": "ALB-00019",
    "lat": 40.6779, "lon": -8.472228, "region": "CONT",
    "city": "Albergaria-a-Velha", "address": "...",
    "operator": "IONITY GmbH", "operatorId": "IONY", "website": "https://ionity.eu",
    "payment": ["apps", "rfid"],
    "name": "IONITY Albergaria", "hours": "24/7", "phone": "...",
    "locationDescription": "Parque Exterior",
    "osm": { "name": "IONITY Albergaria", "brand": "IONITY", "operator": "IONITY",
             "openingHours": "24/7", "access": "yes", "parkingFee": "no",
             "payment": ["app", "membership_card"], "cards": false,
             "phone": "...", "manufacturer": "Tritium", "capacity": 4 },
    "points": [{
      "id": "ALB-00019-01", "kw": 350, "v": 920, "a": 500, "cable": true,
      "connector": "CCS", "dc": true, "phases": null,
      "level": "MT", "regime": "mobie", "osm": { "v": 1000 },
      "opc": { "REGULAR": { "energy": [0.51], "time": [{ "eur": 0.0813, "from": 60, "to": 560 }] },
               "AD_HOC_PAYMENT": { "energy": [0.51] } }
    }]
  }]
}
```

- `region`: `CONT`, `MAD` or `AZO`; it decides VAT and off-peak hours in ceme-v2.
- `v`, `a`: the connector's voltage (V) and max current (A), as the operator
  declares them on the NAP. Optional: datasets built before nap-dashboard
  published them have neither, and then ohmigo ignores `min_voltage` and says
  so. Declared, not measured: some DC sockets carry a placeholder (750 or
  600 V), which is why every answer filtered by voltage carries a sentence
  saying so.
- `cable`: `true` when the cable is fixed to the charger, `false` when it's a
  socket and the driver brings their own (the NAP's `connectorFormat`).
- `operator`, `operatorId`: as the NAP publishes them, which can be neither.
  `src/lookup.js` then fills them from the site's id prefix when it loads the
  file and adds `operatorInferred` (see
  [01](01-how-it-works.md#finding-the-charger-the-user-means)).
- `name`, `hours`, `locationDescription`, `phone` (site): the operator's name
  for the site ("Auchan Cascais"), its opening hours (nap-dashboard converts
  the NAP's DATEX II into OpenStreetMap's `opening_hours` syntax, so
  `src/hours.js` reads both sources the same way), where the charger is in
  the car park ("Parque Coberto - Piso -1") and the operator's phone. Each is
  there only when the NAP has it.
- `osm` (point): the kW/V/A OpenStreetMap has for this socket (the OSM socket
  of the same plug type at the site with the nearest power), only the fields
  that differ from the NAP's. The community reads them off the charger's
  plate, so they are usually more right than the NAP's declaration (DC
  sockets declaring a 750 V placeholder, powers that V×I can't give).
  `src/data.js` puts them in `kw`/`v`/`a` when it loads the file and keeps the
  NAP's in `napKw`/`napV`/`napA`: filters, the session duration and the price
  band all use OSM's, and every answer that does says so.
- `level`: the voltage level of the site's grid connection (`BTN`, `BTE`,
  `MT`), which picks the BT or MT version of each CEME tariff. Not the
  socket's voltage (that's `v`).
- `regime`: `mobie` (on MOBI.E, fee in the file), `mobie_sem_tarifa` (on
  MOBI.E, missing from the file; ohmigo uses the NAP's fees), `sem_ceme`
  (outside MOBI.E).
- `opc`: the plans described in [02](02-cost-math.md), in MOBI.E's raw form,
  per-minute tiers included.
- `osm`: what OpenStreetMap has for the site, joined by the MOBI.E code in
  its `ref` tag (only when the OSM element is within 1 km of the NAP's
  coordinates). Optional, and so is every field in it: `name`, `brand`,
  `operator`, `openingHours`, `location` (`underground`...), `access`,
  `parkingFee`, `maxstay`, `level` (floor), `covered`, `indoor`, `phone`,
  `email`, `manufacturer`, `model`, `capacity` (cars at once), `payment` (the
  `payment:*`/`authentication:*` methods tagged yes) and `cards` (true/false
  when OSM says whether a bank card works at the charger; `cardPayment` in
  `src/data.js` combines it with the NAP's `payment`). Its `brand`/`operator` are often the chargers' owner
  or the shop they're at (Lidl owns its chargers, Galp operates them), not
  the OPC that bills the fee (that's the site's `operator`).
  `lookup_charger` searches it and shows it ([01](01-how-it-works.md)).
- `schema`: bumped by nap-dashboard when the format changes incompatibly.
  ohmigo refuses a schema it doesn't know, rather than misreading it.

## Building it locally

From a nap-dashboard checkout whose pipeline has run (`fetch_data.sh` +
`nap_etl.py`):

```bash
npm run build:data
# = ../nap-dashboard/venv/bin/python ../nap-dashboard/scripts/ohmigo_dataset.py ../nap-dashboard/data data/chargers.json
```

The builder needs pandas, hence nap-dashboard's venv.

With `data/chargers.json` present, the server uses it instead of the Pages
copy.
