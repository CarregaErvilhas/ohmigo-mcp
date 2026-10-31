// Every sentence exists in both languages, and the Portuguese one really is
// Portuguese (decimal comma, PAN instead of NAP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, pickLang, translator } from '../src/i18n.js';
import { describePlan } from '../src/opc.js';
import { estimateSession } from '../src/charging.js';

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

test('i18n: kW in the Portuguese summaries has a decimal comma, and "?" stays', () => {
  const t = translator('pt');
  assert.equal(t('summary.sockets', { n: 2, kw: 7.4 }), '2 tomadas, máx. 7,4 kW');
  assert.equal(t('summary.sockets', { n: 1, kw: '?' }), '1 tomada, máx. ? kW');
  assert.equal(t('summary.operatorSize', { sites: 2, points: 3, dc: 1, kw: 22.5 }), '2 locais, 3 tomadas (1 DC), máx. 22,5 kW');
  assert.equal(t('summary.operatorSize', { sites: 1, points: 1, dc: 0, kw: '?' }), '1 local, 1 tomada (0 DC), máx. ? kW');
});
