// Every sentence exists in both languages, and the Portuguese one really is
// Portuguese (decimal comma, PAN instead of NAP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, pickLang, translator } from '../src/i18n.js';
import { describePlan } from '../src/opc.js';
import { estimateSession } from '../src/charging.js';
import { gaps, isStale, offersFor, OPERATOR_OFFERS } from '../src/operators.js';

test('i18n: en and pt have the same keys', () => {
  assert.deepEqual(Object.keys(MESSAGES.pt).sort(), Object.keys(MESSAGES.en).sort());
});

test('i18n: pickLang maps any pt-* to pt, the rest to en, first hint wins', () => {
  assert.equal(pickLang('pt-PT'), 'pt');
  assert.equal(pickLang('pt-BR'), 'pt');
  assert.equal(pickLang('es'), 'en');
  assert.equal(pickLang(undefined, 'pt-PT'), 'pt');
  assert.equal(pickLang(), 'en');
});

test('i18n: progress message names the NAP / PAN', () => {
  assert.match(translator('en')('progress.live'), /NAP/);
  assert.match(translator('pt')('progress.live'), /PAN/);
});

test('i18n: plans and assumptions come out in Portuguese', () => {
  const t = translator('pt');
  assert.equal(describePlan({ flat: [0.26], time: [{ eur: 0.18, from: 30, to: null }] }, t),
    '0,26 €/carregamento + 0,18 €/min após 30 min (sem IVA)');
  const s = estimateSession({ kw: 50, dc: true }, { batteryKwh: 60, startPct: 20 }, t);
  assert.match(s.assumptions[0], /perdas/);
});

test('operators: offers are matched by the NAP operator id, not the name', () => {
  assert.equal(offersFor({ operatorId: 'IONY', operator: 'whatever' }).id, 'ionity');
  assert.equal(offersFor({ operatorId: 'GLPP', operator: 'IONITY' }), null);
  assert.equal(offersFor({ operator: 'IONITY GmbH' }), null, 'no operatorId, no match');
});

// The offers file is edited by hand, so the test is its validator.
test('operators: offers file is well-formed', () => {
  const ids = new Set(), opIds = new Set();
  for (const o of OPERATOR_OFFERS) {
    assert.match(o.id, /^[a-z0-9-]+$/, 'id: lowercase slug');
    assert.ok(!ids.has(o.id), `duplicate id ${o.id}`); ids.add(o.id);
    assert.ok(o.operator && o.operatorIds?.length, `${o.id}: operator and operatorIds`);
    for (const x of o.operatorIds) { assert.ok(!opIds.has(x), `operator id ${x} in two entries`); opIds.add(x); }
    assert.match(o.source, /^https:\/\//, `${o.id}: source must be a https URL`);
    assert.match(o.checkedAt, /^\d{4}-\d{2}-\d{2}$/, `${o.id}: checkedAt YYYY-MM-DD`);
    assert.ok(new Date(o.checkedAt) <= new Date(), `${o.id}: checkedAt in the future`);
    assert.ok(o.plans.length, `${o.id}: at least one plan`);
    assert.ok(o.plans.filter(p => p.walkUp).length <= 1, `${o.id}: at most one walk-up plan`);
    for (const p of o.plans) {
      assert.ok(p.id && p.name?.en && p.name?.pt, `${o.id}: plan id and en/pt names`);
      assert.ok(p.eurPerKwh > 0 && p.eurPerKwh < 3, `${p.id}: eurPerKwh looks wrong`);
      if (p.fee) assert.ok(p.fee.eur > 0 && ['month', 'year'].includes(p.fee.per), `${p.id}: fee { eur, per: month|year }`);
    }
  }
});

test('operators: gaps lists unlisted operators with direct-payment signals', () => {
  const site = (operatorId, payment, adhoc) => ({ operatorId, operator: operatorId, payment, points: [{ opc: adhoc ? { AD_HOC_PAYMENT: {} } : {} }] });
  const g = gaps([site('IONY', ['creditCard'], true), site('AAA', ['apps', 'creditCard']), site('AAA', ['apps']), site('BBB', ['apps', 'rfid']), site('CCC', ['apps'], true)]);
  assert.deepEqual(g.map(o => [o.operatorId, o.sites, o.card, o.adhoc]), [['AAA', 2, 1, 0], ['CCC', 1, 0, 1]]);
});

test('operators: an old entry is flagged stale', () => {
  assert.equal(isStale({ checkedAt: '2026-01-01' }, new Date('2026-10-28')), true);
  assert.equal(isStale({ checkedAt: '2026-10-01' }, new Date('2026-10-28')), false);
});
