// slim.js: what a pricing answer says once instead of once per charger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slim } from '../src/slim.js';

const opt = (over = {}) => ({ kind: 'ceme', tariffId: 'a-bt-x', label: 'A · X', total: 5, ...over });
const promo = (over = {}) => ({ id: 'gold', label: 'Gold: 7 kWh free', note: 'for every Gold customer', url: 'https://x.pt', total: 4, saving: 1, applied: false, ...over });
const result = (id, over = {}) => {
  const best = opt();
  return { pointId: `${id}/1`, assumptions: ['losses', `own ${id}`], options: [best], best, headline: { ...best }, ...over };
};

test('slim: assumptions every result has are said once, at the top', () => {
  const { data } = slim({ kind: 'ranking', results: [result('A'), result('B')] });
  assert.deepEqual(data.assumptions, ['losses']);
  assert.deepEqual(data.results.map(q => q.assumptions), [['own A'], ['own B']]);
  assert.deepEqual(Object.keys(data).slice(-2), ['assumptions', 'results'], 'read before the results');
});

test('slim: one result keeps its own assumptions', () => {
  const { data } = slim({ kind: 'single', results: [result('A')] });
  assert.equal(data.assumptions, undefined);
  assert.deepEqual(data.results[0].assumptions, ['losses', 'own A']);
});

test('slim: a promotion at several chargers keeps what differs in each, the rest once', () => {
  const { data } = slim({ results: [result('A', { promos: [promo()] }), result('B', { promos: [promo({ total: 6, saving: 2 })] }), result('C')] });
  assert.deepEqual(data.promos, { gold: { note: 'for every Gold customer', url: 'https://x.pt', applied: false } });
  assert.deepEqual(data.results[0].promos, [{ id: 'gold', label: 'Gold: 7 kWh free', total: 4, saving: 1 }]);
  assert.deepEqual(data.results[1].promos, [{ id: 'gold', label: 'Gold: 7 kWh free', total: 6, saving: 2 }]);
  // At one charger only: whole, where it is.
  const one = slim({ results: [result('A', { promos: [promo()] }), result('B')] }).data;
  assert.equal(one.promos, undefined);
  assert.deepEqual(one.results[0].promos, [promo()]);
});

test('slim: headline goes when it is best, stays when it differs', () => {
  const other = result('B');
  other.headline = opt({ tariffId: 'b-bt-y', total: 6 });
  const { data } = slim({ results: [result('A'), other] });
  assert.equal(data.results[0].headline, undefined);
  assert.equal(data.results[1].headline.tariffId, 'b-bt-y');
});

test('slim: the blog is named once, in sources', () => {
  const direct = { kind: 'direct', label: 'App', total: 4, source: 'custofinal', checked: '2026-10-14' };
  const { data } = slim({ results: [result('A', { options: [opt(), direct] })] });
  assert.match(data.sources.custofinal, /Alexandre Moleiro/);
  assert.equal(slim({ results: [result('A')] }).data.sources, undefined);
});

test('slim: the driver\'s notes go to _meta, out of what the assistant reads', () => {
  const q = result('A', { note: 'Say so to the user.', driverNote: 'Try again later.', promos: [promo({ driverNote: 'tell the assistant' })] });
  const { data, meta } = slim({ results: [q, result('B', { promos: [promo({ driverNote: 'tell the assistant' })] })] });
  assert.doesNotMatch(JSON.stringify(data), /driverNote|Try again later|tell the assistant/);
  assert.deepEqual(meta.driverNotes['A/1'], { note: 'Try again later.', promos: { gold: 'tell the assistant' } });
  assert.deepEqual(meta.driverNotes['B/1'], { promos: { gold: 'tell the assistant' } });
  assert.equal(slim({ results: [result('A')] }).meta, null);
});

test('slim: best leaves options, a headline that isn\'t best is named by its tariff', () => {
  const head = opt({ tariffId: 'b-bt-y', label: 'B · Y', ceme: 'B', name: 'Y', total: 6, requiresOtherContract: false });
  const direct = { kind: 'direct', label: 'App', total: 4, walkUp: false, subscription: null, stale: false, source: 'custofinal' };
  const q = { pointId: 'A/1', assumptions: [], options: [head, { ...direct }], best: { ...direct }, headline: { ...head } };
  const { data: { results: [r] } } = slim({ results: [q] });
  assert.deepEqual(r.best, { kind: 'direct', label: 'App', total: 4, source: 'custofinal' });
  assert.deepEqual(r.options, [{ kind: 'ceme', tariffId: 'b-bt-y', label: 'B · Y', total: 6, requiresOtherContract: false }], 'no copy of best; ceme, name and false flags gone, but not requiresOtherContract');
  assert.equal(r.headline, undefined);
  assert.equal(r.headlineTariffId, 'b-bt-y');
});
