# 04 — Direct offers

On MOBI.E the usual way to pay is a CEME card or app: the CEME's energy plus
the operator's fee. But many chargers also take other ways to pay, and they're
often cheaper:

- a **walk-up** card terminal (TPA) or QR code at the charger, no account;
- the **operator's own app or subscription** (IONITY Power, Atlante GO...);
- **roaming apps (eMSPs)** like Electroverse, Elli or Electromaps, which work
  on some networks at their own flat price.

In ohmigo these are options of kind `direct` ([02](02-cost-math.md)).

A discount a **CEME** gives at one network (LUZiGÁS cheaper at Powerdot, miio
one cutting Powerdot's fee) is not a direct offer: you still pay with the CEME
card or app. Those live in ceme-v2, next to the tariffs (`PROMOS` in its
`seed-data.js`), and only borrow `networks.json` from here to find the
chargers ([02](02-cost-math.md), "CEME promotions").

## Why not from the NAP?

We checked. In the NAP, `brandsAccepted` is the same 54 CEME codes at every
MOBI.E charger, and `brandsAcceptedText` is always empty. So the NAP only
tells you whether a charger is on MOBI.E at all, not who else sells there or
at what price. MOBI.E's tariff file has the ad hoc (bank card) price per
socket, and nothing else.

## Where the prices come from

```
 custofinal.blogspot.com  "Preços (finais) kWh Portugal"
   │  a new post every few weeks: final €/kWh with VAT, per power band
   ▼
 scripts/scrape-offers.mjs     (weekly, .github/workflows/offers.yml)
   │  reads the newest post through Blogger's JSON feed
   │  maps each "Postos" label to NAP operator ids (offers/networks.json)
   ▼
 offers/custofinal.json        a pull request when it changes; a person merges it
   +
 offers/manual.json            hand-made corrections and additions (they win)
   ▼
 src/offers.js                 loaded at boot
```

**The blog** is the best public list we know: kept up to date by its author,
Alexandre Moleiro, who lets us use it as long as we credit him. Prices are
final with VAT, one column per power band (AC ≤7.4, AC 11-22, DC ≤50,
100, 120, 150, 180, >180). We credit it in every price we show (the `note`
names the source). The author publishes a **new post** for each update, so
the scraper reads Blogger's feed and takes the newest post that has the price
table, instead of a fixed URL.

**The weekly job** (`.github/workflows/offers.yml`, Mondays, or by hand from
the Actions tab):
1. scrapes, then runs `npm test`;
2. if `offers/custofinal.json` changed, opens a **pull request** with the
   scrape log. Nothing reaches users until someone merges it;
3. if the scrape fails (blog moved, layout changed, feed down), opens an
   **issue**, and the old prices stay.

The parser is strict on purpose. An unknown column header, a table without a
caption, or zero rows make it fail, rather than quietly publish prices in the
wrong columns.

## Matching offers to chargers: `offers/networks.json`

The blog says where each offer works in its "Postos" column ("Ionity",
"Iberdrola BP Pulse", "Rede Mobi.E"...). `networks.json` translates each label
into NAP operator ids:

```json
"Ionity":        { "operatorIds": ["IONY"] },
"Galp":          { "operatorIds": ["GLPP", "GLPG"] },
"Rede Mobi.E":   { "scope": "mobie" },
"Alguns Mobi.E": { "scope": "unknown", "why": "'some MOBI.E chargers': the blog doesn't say which" }
```

- `scope: "mobie"`: every charger on MOBI.E.
- `scope: "unknown"`: we can't tell which chargers, so the offer is left out.
- A label the file doesn't know: the scrape still works, leaves those rows out,
  and the pull request lists them as **unmapped**. Add them (the operator id is
  in `npm run offers:gaps` or the dataset), and the next run picks them up.

When a provider has a row for a specific network AND a MOBI.E-wide row (the
blog lists "Electroverse @ Rede Mobi.E" and "Electroverse @ Ionity"), the
specific one wins at that network's chargers.

## Corrections and additions: `offers/manual.json`

Never edit `custofinal.json` by hand: the next scrape would overwrite it.
Use `manual.json`:

```json
{ "id": "ionity-tpa-ionity", "prices": { "dcMax": 0.63 },
  "source": "https://...", "checkedAt": "2026-10-28", "why": "IONITY's own announcement" }
```

- **Same `id` as a scraped offer**: overrides the fields you list. Prices
  merge band by band, so you can fix one column. Ids look like
  `provider-plan-network`; copy them from `custofinal.json`.
- **`"disable": true`**: removes a scraped offer.
- **New `id`**: adds an offer. Then every field is needed: `label`,
  `provider`, `plan`, `network`, `scope`, `walkUp`, `subscription`, `fee`,
  `prices`, `source`, `checkedAt`.

Every entry needs a `source` (https) and the `checkedAt` date you read it.
After 90 days, users are told the price may be out of date.

## Finding what's missing

```bash
npm run offers:gaps
```

This lists operators whose sites show signs of selling directly, meaning the
NAP lists card, NFC, pinpad or website payment, or MOBI.E has an ad hoc price,
but no offer is scoped to them. Biggest first. Either add them to
`manual.json` from the operator's own price page, or tell the blog's author.
It also lists stale entries.

## Run it yourself

```bash
npm run offers:scrape -- --check   # parse the newest post, write nothing
npm run offers:scrape              # update offers/custofinal.json
npm test                           # validates all three files
```

## Limits

- Only per-kWh prices. An offer that charges per minute or per session
  doesn't fit yet.
- One price per power band for a whole network. Sites priced differently
  within one network can't be told apart.
- "Alguns Mobi.E" offers are left out until someone knows which chargers
  they mean.
- **Island VAT.** The blog's prices carry mainland VAT (23 %). Madeira and
  the Azores have lower VAT, and nobody says whether these apps charge less
  there. On island chargers each direct option keeps its price, gets
  `vatUnverified: true`, and its note tells the user to confirm it.
- The blog is one person's work. If it stops, the weekly job keeps the last
  prices and `isStale` starts warning users after 90 days.
