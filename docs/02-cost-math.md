# 02 — The cost math

How ohmigo turns "77 kWh battery, 15 % → 80 %, this charger" into euros. The
code is in `src/charging.js`, `src/opc.js` and `src/quote.js`. Prices are never
copied into this doc. They live in the data, in ceme-v2, or in `offers/`.

## 1. Energy and time (`charging.js`)

**Energy into the battery** = capacity × (target % − start %).
For example, 77 kWh × (80 − 15) % = 50 kWh.

**Energy the meter counts** is more than that, because some of it turns into
heat (losses). We divide by an efficiency, a bit lower on AC than on DC (see
`DEFAULTS` in `charging.js`). You pay for what the meter counts.

**Time** matters because some operators charge per minute. The session runs
at the slower of car and charger. How we estimate it depends on what the
assistant found out about the car:

1. **Charging curve** (kW at each SoC): we walk it 1 % at a time, capped by
   the charger. This is the best case.
2. **10-80 % time**: 70 % of the battery charged in that many minutes gives
   the car's real average speed below 80 %. Above 80 % we assume it drops.
3. **Nothing**: a share of the peak power below 80 % and a smaller share
   above. A rough guess.

AC sessions are simpler: the power stays nearly flat until the end.

Every guess goes into `assumptions`, in the user's language, so the assistant
can say things like "this assumes 7 % losses and a 28-minute 10-80 % time".

## 2. The operator fee (`opc.js`)

MOBI.E publishes each socket's OPC fee as components:

| Component | Looks like | Charged |
|---|---|---|
| flat | `€ 0.26 /charge` | once per session |
| energy | `€ 0.10 /kWh` | × kWh counted by the meter |
| time | `€ 0.18 /min após 30 min` | per minute, in tiers |

**Tiers work like tax brackets.** "0 €/min" plus "0.18 €/min after 30 min"
means the first 30 minutes are free and you pay 0.18 € for each minute after
that. `timeCost` cuts the session at every tier boundary and prices each
slice.

**Some sockets publish two values for one component**, with nothing to say
which one is right. We return both ends as `low` / `high` and say so.

**These fees come without VAT.** VAT applies to the whole invoice, so
`quote.js` multiplies the fee by the region's VAT.

Where the fee comes from, in order:
1. MOBI.E's tariff file (in the dataset), which has the per-minute tiers;
2. the NAP live feed, which is rounded to the cent and has no tiers, but
   covers chargers missing from the file;
3. neither: the total is energy only, marked `complete: false`, and ranked
   after the complete ones.

## 3. Every way to pay (`quote.js`)

Each plug gets `options`, one entry per way to pay:

**`ceme`** — total = ceme-v2's total for that tariff (energy + TAR + IEC +
EGME + VAT) + OPC fee × VAT. ceme-v2 quotes every tariff in one call, and we
keep the ones that fit this plug:
- the right voltage version (BT or MT, from the socket's voltage level);
- no AC-only tariffs on DC chargers (Atlante's "(AC)" tariffs);
- if the user gave their `tariff_ids`, only those; otherwise the top 3 (or
  `tariffs_shown`) of ceme-v2's "popular" list.

**`adhoc`** — bank card / QR at the charger: MOBI.E's `AD_HOC_PAYMENT` price.
We assume it includes VAT, since it's a consumer price, but MOBI.E doesn't
say so.

**`direct`** — walk-up card terminal or QR, the operator's own app or
subscription, or a roaming app ([04](04-operator-offers.md)): kWh × the
offer's price for this charger's power band. Prices are final, with VAT.
Subscription fees are listed next to the price, not added, because one monthly
fee covers every session that month. If the charger's own operator has a
walk-up offer priced for this band, it replaces MOBI.E's ad hoc price.

**`opc_direct`** — chargers outside MOBI.E (Continente, Tesla) with no direct
offer: the NAP's single price × kWh, with an asterisk. The NAP
doesn't say whether that number is the final price, so these are never ranked
against MOBI.E.

Two summary fields:
- **`headline`**: the first CEME option (the user's cheapest tariff, or the
  cheapest popular one that needs no other contract);
- **`best`**: the cheapest option anyone can use right now, meaning no
  subscription, no other contract and no asterisk. **The ranking sorts by
  `best`.** That's how an IONITY whose own app beats every CEME ends up where
  it belongs.

## 4. Ranking (`quote.js`, `rank`)

1. Price every plug of every site in range.
2. Drop sessions longer than `max_minutes`, and plugs the live feed reports
   as in use, out of order or blocked (`available_only`).
3. Keep the cheapest plug per site.
4. Sort by `best`. Sites outside MOBI.E go in a separate `outsideMobie` list.

## What can be wrong, and how the user finds out

| Risk | What the user sees |
|---|---|
| Car specs guessed | an assumption line naming the guess |
| Operator fee unknown | "≥" before the price, `complete: false` |
| Two values published for one fee | a price range |
| Price outside MOBI.E | an asterisk and a note |
| Direct offers from a price list | the source and the date it was checked; "may be out of date" after 90 days |
| Live status stale | `live.fresh: false`, said in the footer |
