// What ui/results.html prints for a tool result. Real server output goes
// through the same harness in test/http.test.js; these payloads cover the
// cases the fixture dataset doesn't have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderView } from './view-harness.js';

const row = over => ({
  pointId: 'S/P', operator: 'Op', address: 'Rua', city: 'Faro', kw: 50, connector: 'CCS2', dc: true, regime: 'mobie',
  session: { minutes: 30, kwhBilled: 30 }, assumptions: [], options: [], ...over,
});

const noCard = { kind: 'adhoc', label: 'No CEME: paid on your phone (QR code or website at the charger); no card terminal is listed here', total: 9, note: 'ad hoc note' };
const opc = { kind: 'opc_direct', label: 'Tesla direct: their app, or a bank card at the charger\'s terminal, no subscription', total: 12, peakPrice: true, note: 'peak note' };

test('view: ad hoc and operator options show the server\'s label, in its language', () => {
  const adhocPt = { ...noCard, label: 'Sem CEME: pagas no telemóvel (QR code ou site no posto); não há terminal de cartão indicado aqui' };
  const [en] = renderView({ lang: 'en', results: [row({ options: [noCard, { ...opc, peakPrice: false }], best: noCard })] });
  assert.match(en, /<\/span> No CEME: paid on your phone/, 'option list');
  assert.match(en, /<dt>No CEME: paid on your phone/, 'breakdown');
  assert.match(en, /<dt>Tesla direct: their app/, 'breakdown');
  assert.doesNotMatch(en, /Card \/ QR|Operator direct/);
  const [pt] = renderView({ lang: 'pt', results: [row({ options: [adhocPt], best: adhocPt })] });
  assert.match(pt, /<\/span> Sem CEME: pagas no telemóvel/);
  assert.match(pt, /<dt>Sem CEME: pagas no telemóvel/);
  assert.doesNotMatch(pt, /Cartão \/ QR/);
});

test('view: a label can\'t inject markup', () => {
  const o = { ...noCard, label: '<img src=x>' };
  const [r] = renderView({ lang: 'en', results: [row({ options: [o], best: o })] });
  assert.doesNotMatch(r, /<img/);
});

test('view: a peak price is a ceiling, in the price column and the option list', () => {
  for (const [lang, price] of [['en', '12.00 €'], ['pt', '12,00 €']]) {
    const [r] = renderView({ lang, results: [row({ options: [opc], best: opc })] });
    assert.ok(r.includes(`<div class="eur">≤ ${price}`), 'price column');
    assert.ok(r.includes(`<span>≤ ${price}</span>`), 'option list');
  }
  const plain = { ...opc, peakPrice: undefined };
  const [r] = renderView({ lang: 'en', results: [row({ options: [plain], best: plain })] });
  assert.doesNotMatch(r, /≤/);
});

test('view: the first row is highlighted by best, not by the CEME total', () => {
  const noTotal = row({ total: null, best: noCard, options: [noCard] });
  assert.match(renderView({ lang: 'en', results: [noTotal, noTotal] })[0], /^ best"/);
  assert.doesNotMatch(renderView({ lang: 'en', results: [noTotal, noTotal] })[1], /^ best"/);
  // An energy-only total, with the operator fee unknown, is no best price.
  const partial = row({ total: { eur: 5, low: 5, high: 5, complete: false }, best: null });
  assert.doesNotMatch(renderView({ lang: 'en', results: [partial] })[0], /^ best"/);
});

test('view: a socket with no published power or plug reads "?"', () => {
  const [unknown] = renderView({ lang: 'en', results: [row({ kw: null, connector: 'nan' })] });
  assert.match(unknown, /\? kW \? · /);
  assert.doesNotMatch(unknown, /nan/);
  // No plug known: neither AC nor DC is claimed, whatever dc says.
  assert.match(renderView({ lang: 'en', results: [row({ connector: null })] })[0], /50 kW \? · /);
  assert.match(renderView({ lang: 'en', results: [row({ connector: 'nan', dc: false })] })[0], /50 kW \? · /);
  assert.match(renderView({ lang: 'en', results: [row({})] })[0], /50 kW CCS2 DC · /);
  assert.match(renderView({ lang: 'en', results: [row({ dc: false })] })[0], /50 kW CCS2 AC · /);
});

test('view: with ceme-v2 down a banner sits above the rows, in the answer\'s language', () => {
  const outside = row({ regime: 'sem_ceme', best: noCard, options: [noCard] });
  assert.match(renderView({ lang: 'en', cemeUnavailable: true, results: [outside] }).above, /class="banner">CEME prices are unavailable/);
  assert.match(renderView({ lang: 'pt', cemeUnavailable: true, results: [outside] }).above, /class="banner">Os preços CEME não estão disponíveis/);
  assert.equal(renderView({ lang: 'en', results: [outside] }).above, '');
});

test('view: the driver gets driverNote, never the note written for the assistant', () => {
  const promo = { label: 'Gold', total: 4, note: 'priced as is: pass month_kwh', driverNote: 'priced as is' };
  const [r] = renderView({ lang: 'en', results: [row({ note: 'Say so to the user.', driverNote: 'Try again later.', promos: [promo] })] });
  assert.match(r, /Try again later\./);
  assert.match(r, /Gold: 4\.00 € · priced as is</);
  assert.doesNotMatch(r, /Say so|month_kwh/);
  assert.match(renderView({ lang: 'en', results: [row({ note: 'Outside MOBI.E.' })] })[0], /Outside MOBI\.E\./);
});
