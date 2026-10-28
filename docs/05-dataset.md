# 05 — The dataset

"The dataset" is the slow-changing half of the data: where each charger is,
its plugs, power and voltage level, how the site lets you pay, and the
operator fees from MOBI.E's tariff file. It's one JSON file, about 6 MB
(~520 KB gzipped).

What's **not** in it: live status (changes by the minute, see
[03](03-live-status.md)), CEME prices (ceme-v2's job), and operator direct
offers (`offers/`, see [04](04-operator-offers.md)).

## Where it comes from

```
 Monday 06:00 UTC, nap-dashboard's refresh.yml
   │  downloads the NAP static XML (~170 MB) and MOBI.E's tariff CSV
   │  runs its pipeline, then scripts/ohmigo_dataset.py
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
  bytes, and nothing else happens. Over a week that's 27 tiny requests.
- **Changed** (once a week): the server downloads the new file (~520 KB
  compressed), checks it, and swaps it in. Requests already running finish on
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
    "points": [{
      "id": "ALB-00019-01", "kw": 350, "connector": "CCS", "dc": true, "phases": null,
      "level": "MT", "regime": "mobie",
      "opc": { "REGULAR": { "energy": [0.51], "time": [{ "eur": 0.0813, "from": 60, "to": 560 }] },
               "AD_HOC_PAYMENT": { "energy": [0.51] } }
    }]
  }]
}
```

- `region`: `CONT`, `MAD` or `AZO`; it decides VAT and off-peak hours in ceme-v2.
- `level`: the socket's voltage level (`BTN`, `BTE`, `MT`), which picks the
  BT or MT version of each CEME tariff.
- `regime`: `mobie` (on MOBI.E, fee in the file), `mobie_sem_tarifa` (on
  MOBI.E, missing from the file; ohmigo uses the NAP's fees), `sem_ceme`
  (outside MOBI.E).
- `opc`: the plans described in [02](02-cost-math.md), in MOBI.E's raw form,
  per-minute tiers included.
- `schema`: bumped by nap-dashboard when the format changes incompatibly.
  ohmigo refuses a schema it doesn't know, rather than misreading it.

## Building it locally

From a nap-dashboard checkout whose pipeline has run (`fetch_data.sh` +
`nap_etl.py`):

```bash
../nap-dashboard/venv/bin/python ../nap-dashboard/scripts/ohmigo_dataset.py ../nap-dashboard/data data/chargers.json
```

With `data/chargers.json` present, the server uses it instead of the Pages
copy.
