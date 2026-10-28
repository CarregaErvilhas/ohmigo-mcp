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

## 1b. When each kWh goes in (`profile.js`)

A session takes minutes to hours, and the energy price can change while it
runs:

- a **bi-hourly** tariff has an off-peak price ("vazio", nights and weekends)
  and a peak one ("fora de vazio"). Plug in at 21:30 on a slow AC charger and
  the first half hour is peak, the rest off-peak;
- an **indexed** tariff follows the wholesale price (OMIE), which changes
  every 15 minutes;
- a session past midnight can land on a day with a new grid fee (TAR), and
  one on the last Sunday of March or October crosses a clock change.

So `charging.js` also returns the session as `segments`: stretches of
constant power, back to back (one per 1 % with a curve; below and above 80 %
on DC; one on AC). `profile.js` lays them out from the start time (`at`,
default now, rounded down to the minute) and cuts them at every quarter-hour
(:00, :15, :30, :45 UTC), giving the kWh delivered in each quarter. That list
goes to ceme-v2 as `profile`, and **ceme-v2 prices each slice** at its own
period, OMIE quarter, losses and TAR day. ohmigo never works out a period or
an OMIE price itself; that math stays in ceme-v2, with its tests for the
clock changes, Saturdays and the islands.

Everything is in UTC instants, so the clock changes need no special case:
in October the 01:00-02:00 hour happens twice, and a 60-minute session that
spans it still has four quarters. Local times are only for showing
(`session.startLocal`/`endLocal`, and the `utcOffset` next to each slice in
the timeline, so the repeated hour isn't ambiguous).

What the driver gets:

- always: the window (`session.start`/`end`, and the local times), an
  assumption saying the energy was priced quarter by quarter in that window,
  and `kwhByPeriod` on each CEME option whose session crossed periods (each
  tariff has its own cycle, so one can cross and another not);
- with `detail: true` on the tool: `timeline`, every quarter's kWh and
  power, and for each CEME tariff shown, the period, price (excl. VAT) and
  OMIE of each quarter (`omieSpot: false` means that quarter's OMIE wasn't
  published yet, so ceme-v2 used the period's average);
- in QA mode (`OHMIGO_QA=1`, [06](06-run-and-deploy.md)): the timeline on
  every result, plus `debug` with the segments, the profile sent and what
  ceme-v2 said about it.

If ceme-v2 answers without a `profile` field (a version that doesn't know
it), the session was priced at its start; the assumption says so.

Limits: the start time is a guess unless the user gives one, OMIE for
tomorrow only exists after the day-ahead market publishes (early afternoon),
and the operator fee doesn't depend on the clock (MOBI.E's tariff file has no
time-of-day fees).

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
