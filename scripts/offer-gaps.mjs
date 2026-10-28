// Which operators probably sell directly (card at the charger, own app) but
// have no offer scoped to them in offers/ yet. Research the top ones and add
// them to offers/manual.json, or tell the blog's author (docs/04-operator-offers.md).
//
//   npm run offers:gaps            (uses data/chargers.json or DATASET_URL)
import { Dataset } from '../src/data.js';
import { gaps, isStale, OFFERS } from '../src/offers.js';

const ds = await Dataset.load();
const rows = gaps(ds.sites);
console.log(`Dataset of ${ds.generatedAt}: ${rows.length} operators with direct-payment signals and no offer scoped to them.\n`);
console.log('operatorId  sites  card  adhoc  name / website');
for (const o of rows) {
  console.log(`${o.operatorId.padEnd(10)} ${String(o.sites).padStart(6)} ${String(o.card).padStart(5)} ${String(o.adhoc).padStart(6)}  ${o.names.join(' | ')}${o.website ? '  ' + o.website : ''}`);
}
const stale = OFFERS.filter(o => isStale(o));
if (stale.length) console.log(`\nStale entries (re-check the source): ${stale.map(o => `${o.id} (${o.checkedAt})`).join(', ')}`);
