// Which operators probably sell directly (own app, card at the charger) but
// have no entry in offers/operator-offers.json yet. Run it after each weekly
// dataset, research the top ones, and add them (docs/04-operator-offers.md).
//
//   npm run offers:gaps            (uses data/chargers.json or DATASET_URL)
import { Dataset } from '../src/data.js';
import { gaps, isStale, OPERATOR_OFFERS } from '../src/operators.js';

const ds = await Dataset.load();
const rows = gaps(ds.sites);
console.log(`Dataset of ${ds.generatedAt}: ${rows.length} operators with direct-payment signals and no offers entry.\n`);
console.log('operatorId  sites  card  adhoc  name / website');
for (const o of rows) {
  console.log(`${o.operatorId.padEnd(10)} ${String(o.sites).padStart(6)} ${String(o.card).padStart(5)} ${String(o.adhoc).padStart(6)}  ${o.names.join(' | ')}${o.website ? '  ' + o.website : ''}`);
}
const stale = OPERATOR_OFFERS.filter(o => isStale(o));
if (stale.length) console.log(`\nStale entries (re-check the source): ${stale.map(o => `${o.id} (${o.checkedAt})`).join(', ')}`);
