# 05 — The dataset

"The dataset" is the slow-changing half of the data: where each charger is,
its plugs, power and voltage level, how the site lets you pay, and the
operator fees from MOBI.E's tariff file. It's one JSON file, served gzipped
(the URL is `DEFAULT_URL` in `src/data.js`).

It is nap-dashboard's network model: the site at nap.ocarroeletrico.com
reads the same file for what it shows about each charger, and checks on every
refresh that it does (`scripts/model_parity.py` there). So a fix to how a
charger's power, fees or regime are worked out goes into nap-dashboard, once,
and both see it.

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
- **Refused** (a file that downloaded fine but looks broken): the server
  keeps the copy it has, logs why, and `/healthz` lists
  `dataset: last update refused` until a later file passes.

### What counts as a broken file

A downloaded file replaces a good one with nobody looking, so `Dataset.load`
(`src/data.js`) holds it to more than "right schema, some sites":

- at most `MAX_DATASET_BYTES`, so a runaway download can't fill memory;
- at least `MIN_SITES` sites, even at boot, when there's nothing to compare
  with: a near-empty file fails the boot instead of serving;
- on a reload, at least `MIN_RATIO` of the sites and of the points of the copy
  in memory, so a truncated file can't swap thousands of chargers for a
  handful. The ratio matches AmpereArchive's collector.

A local file (`DATASET_PATH`, `data/chargers.json`) skips the floor and the
ratio: tests and development use small ones on purpose.

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
      "id": "ALB-00019-01", "kw": 350, "a": 500, "cable": true,
      "connector": "CCS", "dc": true, "phases": null,
      "level": "MT", "regime": "mobie", "v": 1000, "napV": 920,
      "opc": { "REGULAR": { "energy": [0.51], "time": [{ "eur": 0.0813, "from": 60, "to": 560 }] },
               "AD_HOC_PAYMENT": { "energy": [0.51] } }
    }]
  }]
}
```

- `region`: `CONT`, `MAD` or `AZO`; it decides VAT and off-peak hours in ceme-v2.
- `connector`: the plug (`CCS`, `T2`...). The NAP leaves some blank, which
  arrives as the text `"nan"`; `src/clean.js` turns it into `null`.
- `v`, `a`: the connector's voltage (V) and max current (A): the operator's
  declaration on the NAP, or OpenStreetMap's where it corrects it (below).
  Optional: datasets built before nap-dashboard published them have neither,
  and then ohmigo ignores `min_voltage` and says so. Mostly declared, not
  measured: some DC sockets carry a placeholder (750 or 600 V), which is why
  every answer filtered by voltage carries a sentence saying so.
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
- `napKw`, `napV`, `napA`, `napCable` (point): present only where
  OpenStreetMap corrected the NAP. The community reads kW/V/A off the
  charger's plate (the OSM socket of the same plug type at the site with the
  nearest power), so they are usually more right than the NAP's declaration
  (DC sockets declaring a 750 V placeholder, powers that V×I can't give), and
  nap-dashboard puts them in `kw`/`v`/`a`/`cable`, keeping the NAP's value
  here (`null` when the NAP declared none). Filters, the session duration and
  the price band all use the corrected value, and every answer that does says
  so. nap-dashboard ignores an OSM number that isn't believable (out of range,
  or too far from a believable NAP value: `osm_tags.sane_osm` there).
  The point's `osm` (what OSM said, where it differs from the NAP) is in the
  file too; `src/clean.js` drops it on load, since nothing here reads it.
- `osmSame` (point): the fields (`kw`, `v`, `a`) where OpenStreetMap agrees
  with the NAP. With `napA`, it tells a value checked on the charger from one
  only the operator declared: `src/data.js` turns it into `ampsSource`
  (`osm` or `nap`), which every `kwAt400V`/`kwForCar` carries. Optional:
  older files don't have it, and then every current not corrected by OSM
  reads as `nap`.
- `level`: the voltage level of the site's grid connection (`BTN`, `BTE`,
  `MT`), which picks the BT or MT version of each CEME tariff. Not the
  socket's voltage (that's `v`).
- `regime`: `mobie` (on MOBI.E, fee in the file), `mobie_sem_tarifa` (on
  MOBI.E, missing from the file; ohmigo uses the NAP's fees), `sem_ceme`
  (outside MOBI.E).
- `opc`: the plans described in [02](02-cost-math.md), in MOBI.E's raw form,
  per-minute tiers included.
- `issues` (point): what nap-dashboard's NAP-only checks found on this socket
  (`tensao_placeholder`: a 750/600 V placeholder on a DC connector;
  `trifasico_sem_3p`: declared three-phase with single-phase voltage and
  power). Optional. ohmigo doesn't read it yet: an answer that used it would
  need its sentences in `src/i18n.js` and an evals run.
- `osm`: what OpenStreetMap has for the site, joined by the MOBI.E code in
  its `ref` tag (only when the OSM element is within 1 km of the NAP's
  coordinates). Optional, and so is every field in it: `name`, `brand`,
  `operator`, `openingHours`, `location` (`underground`...), `access`,
  `parkingFee`, `maxstay`, `level` (floor), `covered`, `indoor`, `phone`,
  `email`, `manufacturer`, `model`, `hardware`, `capacity` (cars at once), `payment` (the
  `payment:*`/`authentication:*` methods tagged yes) and `cards` (true/false
  when OSM says whether a bank card works at the charger; `cardPayment` in
  `src/data.js` combines it with the NAP's `payment`). Its `brand`/`operator` are often the chargers' owner
  or the shop they're at (Lidl owns its chargers, Galp operates them), not
  the OPC that bills the fee (that's the site's `operator`).
  `lookup_charger` searches it and shows it ([01](01-how-it-works.md)).
  `hardware` lists every charger mapped at the site ("Alpitronic HYC_150",
  "Efacec QC45"), most common first; `manufacturer`/`model` are only the
  commonest one, kept for older readers.
  `src/clean.js` keeps only the fields the code or a driver uses: `payment`
  stays in the file but never reaches an answer; `hardware` (or, from an
  older file, `manufacturer` + `model`) reaches `lookup_charger`, which also
  finds a site by it ("Alpitronic Porto").
  `wheelchair` (yes / limited / no: can a wheelchair user reach the
  charger), `sharedKw` (the total a charger gives when its sockets share it:
  with another car plugged in, each gets less; `lookup_charger` says so) and
  `oldRefs` + `oldOperator` (the codes and operator the site had before: the
  old sticker may still be on the charger, so `lookup_charger` and
  `estimate_charging_cost` find the site by them and say the operator
  changed). `fixme` (the community's open questions, "Verificar se aceita
  pagamento com cartão bancário") reaches `lookup_charger` short and few,
  with a note to present them as things to check on site, never as facts,
  and to send whoever checks to the mappers' Telegram group (`FIXME_FEEDBACK`
  in `src/i18n.js`).
- `accessibility`: the NAP's own DATEX II accessibility values, `|`-joined
  ("disabilityAccessible"). `wheelchair()` in `src/data.js` reads it first,
  then OpenStreetMap's `wheelchair`; the `wheelchair` filter keeps yes and
  limited.
- `places`: the named places from OpenStreetMap the site is in or right
  beside, most important first: `[{ "name": "MarShopping", "type": "mall",
  "osm": "way/191497844", "m": 24 }]`. `m` is metres to the place's outline
  (0 = inside). OSM never says which mall a charger belongs to, so
  nap-dashboard works it out (`scripts/osm_places.py` there: point in polygon,
  a small radius that depends on the type). That's why a charger can be "at"
  a mall and actually be in the street beside it, and why the assistant is
  told to say "at or beside". Optional; `src/clean.js` lists the types and
  limits it accepts. `lookup_charger` searches the names, so "Mar Shopping"
  finds the chargers there though none is named so.
- `schema`: bumped by nap-dashboard when the format changes incompatibly.
  ohmigo refuses a schema it doesn't know, rather than misreading it.

## Third-party text

Anyone with an OpenStreetMap account can edit what ends up in `osm` and
`places`, and
operators type the NAP's text by hand, so neither is trusted as it stands.
When a file loads, `cleanSite` (`src/clean.js`) runs before anything reads it:
free text loses control and format characters and gets a length cap, phones,
emails and websites that don't fit their shape are removed (the field is
absent), and every tool, sentence and search sees the result. `npm test`
holds this in `test/third-party.test.js`.

The limits sit well above real values. Each load logs one line with what they
hit (`[ohmigo] third-party limits: cut address 2, dropped osm.phone 1`): if
those are real values, raise the limit in `src/clean.js`.

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
