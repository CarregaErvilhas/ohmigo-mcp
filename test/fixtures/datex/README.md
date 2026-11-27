# DATEX II parser fixtures

A small synthetic copy of the two NAP DATEX II feeds, with the output every parser of them should produce. Three repos parse these feeds on their own: the collector (status and static), ohmigo-mcp (status) and nap-dashboard (status and static). Each keeps a copy of this folder in its tests and runs its parser over it.

Nothing here is real NAP data. Every site, point, station and operator id, name, place, number and timestamp is invented.

## Files

- `status.xml`: an `evActualStatus` payload.
- `static.xml`: an `evChargingInfra` payload.
- `expected.json`: the normalised output for both, in a neutral shape that no parser produces natively. Each repo's test maps its own output to it, changing shape and types only, never values.
- `SHA256SUMS`: the checksum of every other file here.

## The copies must stay byte-identical

The folder exists three times, and each repo's test checks `SHA256SUMS` and fails on any file it doesn't list. To change it, change all three copies in step, then regenerate the sums in each:

```sh
shasum -a 256 README.md expected.json static.xml status.xml > SHA256SUMS
```

## Neutral shape

`status.points` and `static.points` are keyed `SITE/POINT`, because point ids repeat across sites. `static.sites` is keyed by site id.

- Status entry: `status` and `fees` (`[{ policy, eur }]`, `eur` a number, in document order).
- Site: the trimmed text of each field, `null` when absent. `lat` and `lon` stay strings, so no parser's float formatting gets in the way. `vehicles` and `auth` are sorted and de-duplicated.
- Point: `availablePowerW` and each connector's `powerW`, `volts` and `amps` are numbers, in W, V and A as the feed publishes them. `connectors` is in document order, `[]` when there are none.

Fields only one parser emits stay out: phone, `lastUpdated`, `brandsAccepted`, accessibility, NUTS codes, station ids, energy-mix index, currency.

## Cases

Status (`status.xml`):

| Point | Case | Expected |
| --- | --- | --- |
| `QA0001/1` | two fees in two overrides | both fees, in order |
| `QA0001/2` | status padded with whitespace | trimmed |
| `QA0001/3` | flat fee | `flatRate` |
| `QA0002/1` | same point id as `QA0001/1` | its own entry |
| `QA0002/4` | status outside the known set | `other` |
| `QA0002/5` | empty `<status/>` | `other` |
| `QA0002/6` | no `<status>` element | `other` |
| `QA0002/7` | one `rates` with two pricing policies | both fees |
| `QA0002/8` | empty `<minimumDeliveryFee/>` | no fee (empty is not zero) |
| `QA0002/9` | fee that is not a number | no fee |
| `QA0002/10` | the same point twice | one entry, the later one |
| (no reference) | point with no id | dropped |
| `QA0002/A/B` | slash in a point id | dropped, `SITE/POINT` would be ambiguous |
| `Z1` | site with no reference | dropped, not keyed under another site |
| `QA0003/1` | a `publicationTime` inside a site | ignored, only the payload's own counts |

The known statuses are `available`, `charging`, `unknown`, `outOfOrder`, `inoperative`, `blocked` and `planned`. Anything else becomes `other`, never `unknown`, because `unknown` counts as usable.

Static (`static.xml`):

| Entry | Case | Expected |
| --- | --- | --- |
| `QS0001` | every field filled, open all hours, two stations, non-ASCII name | `24/7`, points from both stations |
| `QS0001` | street after another address line | the `street` line |
| `QS0001` | location description in en and pt, untidy whitespace | the pt one, whitespace collapsed |
| `QS0001` | repeated vehicle type | de-duplicated |
| `QS0001/P1` | two connectors, power `50000.0` | both, numbers |
| `QS0001/P2` | no connectors | `[]` |
| `QS0001/P3` | `connectorType` `other` with `otherConnector` MCS | `mcs` |
| `QS0002` | no site `externalIdentifier`, its point has one | `null`, not the point's |
| `QS0002` | name in en then pt, untidy whitespace | the first value, whitespace collapsed |
| `QS0002` | city whose first value is empty | the first non-empty value |
| `QS0002` | Mo-Fr and Sa periods, Sa ending 23:59 | `Mo-Fr 08:00-20:00; Sa 09:00-24:00; Su off` |
| `QS0002/P1` | same point id as `QS0001/P1` | its own entry |
| `QS0003` | hours with no period | `null` |
| `QS0003/P/9` | slash in a point id | dropped |

## Known differences

Where a parser disagrees with `expected.json` today, its repo's test lists the difference and marks it as expected to fail, with the reason. Fixing the behaviour is a separate change. When one is fixed, the test fails until the entry is removed from that list.
