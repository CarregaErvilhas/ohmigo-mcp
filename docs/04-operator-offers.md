# 04 — Operator offers

Many chargers on MOBI.E can also be paid straight to the operator: its own
app, a walk-up price at the charger, or a subscription. IONITY is one
example, and dozens of other operators show the same signs in the data
(`npm run offers:gaps`). The list keeps growing. Sometimes the operator's own price beats every
CEME by a lot: on MOBI.E you pay the CEME's energy AND the operator's fee,
while the operator's app sells you both in one price.

**No open data publishes these prices.** We checked:
- the NAP lists the same 54 CEME brands at every MOBI.E charger, so it can't
  tell you which operator also sells directly;
- MOBI.E's tariff file has the bank card (ad hoc) price, but nothing about
  operator apps or subscriptions.

So they live in **`offers/operator-offers.json`**, maintained by hand and
reviewed in pull requests like code.

## What the data can do: find who's missing

The NAP *does* say how each site lets you pay (card, NFC, pinpad, website),
and MOBI.E's file says which sockets have an ad hoc price. Those are good hints
that an operator sells directly. This command lists every operator with those
hints that isn't in the file yet, biggest first:

```bash
npm run offers:gaps
```

It also lists entries that haven't been checked for 90 days. Run it after the
weekly dataset comes out and work from the top.

## Adding or updating an operator

1. Find the operator's **official** price page or announcement. Prices on
   forums or comparison sites go stale without anyone noticing.
2. Find its `operatorId`: the first column of `npm run offers:gaps`, or the
   `operatorId` of one of its sites in the dataset. Use the id, not the name.
   Names come in many spellings; ids don't.
3. Add (or edit) an entry:

```json
{
  "id": "ionity",
  "operator": "IONITY",
  "operatorIds": ["IONY"],
  "source": "https://...the page you read...",
  "checkedAt": "2026-10-28",
  "plans": [
    { "id": "ionity-direct", "name": { "en": "IONITY walk-up (card/QR, no account)", "pt": "IONITY sem registo (cartão/QR)" }, "eurPerKwh": 0.63, "walkUp": true },
    { "id": "ionity-power", "name": { "en": "IONITY Power", "pt": "IONITY Power" }, "eurPerKwh": 0.37, "fee": { "eur": 11.99, "per": "month" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | lowercase slug, unique in the file |
| `operator` | display name |
| `operatorIds` | the NAP operator ids this offer applies to (one operator can have several) |
| `source` | the https page the prices came from |
| `checkedAt` | the day you checked that page (YYYY-MM-DD) |
| `plans[].eurPerKwh` | price per kWh, **with VAT** (what the driver pays) |
| `plans[].walkUp` | `true` for the plan anyone can use at the charger with a bank card and no account. At most one per operator. It replaces MOBI.E's ad hoc price for this operator. |
| `plans[].fee` | subscription: `{ "eur": 11.99, "per": "month" }` or `"year"` |
| `plans[].name` | `en` and `pt`, both required |

4. Run `npm test`. The test suite validates the file (unique ids, a https
   source, a date that isn't in the future, plausible prices, en/pt names).
5. Open a pull request. Once merged, the deploy picks it up.

**When prices change**, update the numbers **and** `checkedAt`. A changed
price with an old date looks stale to the user.

## Limits of the format today

- Only per-kWh prices. Operators that charge per minute or per session
  directly would need new fields (the `plan` shape from `src/opc.js` would
  fit).
- One price for all of an operator's sites. If an operator prices sites
  differently, add a list of site ids to the entry when that day comes.
- "From" prices: most operators say prices can vary a few cents by site. The
  user is told.
