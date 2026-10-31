// The eval harness (evals/) runs with a model, outside npm test. What can be
// checked without one is checked here: the matchers grade.mjs relies on, and
// that every case in cases.json is well formed, so a broken case shows up now
// and not in the middle of a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callMatches, checkCase, checkJudge, dated, matchValue } from '../evals/lib.mjs';

const { cases } = JSON.parse(readFileSync(new URL('../evals/cases.json', import.meta.url), 'utf8'));
const TOOLS = ['list_ceme_tariffs', 'lookup_charger', 'find_chargers', 'list_operators', 'find_cheapest_charging', 'estimate_charging_cost'];

test('evals: matchers', () => {
  assert.equal(matchValue(undefined, false), true);
  assert.equal(matchValue('x', true), true);
  assert.equal(matchValue(52, [48, 56]), true);
  assert.equal(matchValue('52', [48, 56]), false);
  assert.equal(matchValue(['viaverde-bt-x'], 'viaverde-'), true);
  assert.equal(matchValue({ 'goldenergy-bt-clientesgold': 12 }, 'goldenergy[^"]*":12(\\.0+)?[,}]'), true);
  assert.equal(matchValue({ 'goldenergy-bt-clientesgold': 120 }, 'goldenergy[^"]*":12(\\.0+)?[,}]'), false);
  assert.equal(matchValue(undefined, 'x'), false);
  const call = { tool: 'estimate_charging_cost', args: { site: 'LRA-00156', lang: 'pt' }, isError: true };
  assert.equal(callMatches(call, { tool: 'estimate_charging_cost|lookup_charger', args: { site: 'lra-00156' } }), true);
  assert.equal(callMatches(call, { tool: 'estimate', args: {} }), false, 'tool matches the whole name');
  assert.equal(callMatches(call, { tool: 'estimate_charging_cost', ok: true }), false, 'ok skips errors');
  assert.equal(callMatches(call, { args: { '*': '"lang":"pt"' } }), true);
});

test('evals: a case is graded on calls and answer, judge verdicts on yes/no/n/a', () => {
  const calls = [{ tool: 'list_ceme_tariffs', args: { lang: 'pt' } }, { tool: 'estimate_charging_cost', args: { lang: 'pt', audiences: ['edp-staff'] } }];
  const r = checkCase({
    calls: [{ tool: 'list_ceme_tariffs' }], noCalls: [{ args: { audiences: true } }],
    every: { args: { lang: '^pt' } }, answer: { match: ['€'], noMatch: ['identificador'] },
  }, calls, 'Custa 5 €.');
  assert.deepEqual(r.map(x => x.pass), [true, false, true, true, true]);
  assert.match(r[1].got, /edp-staff/);
  assert.deepEqual(checkJudge(['a', 'b', 'c', 'd'], { 1: 'yes', 2: 'n/a', 3: 'No' }).map(x => x.pass), [true, true, false, null]);
  assert.equal(checkCase({ answer: { noMatch: ['x'] } }, [], null)[0].pass, false, 'no answer never passes');
});

test('evals: {{month}} and {{year}} become the current ones, in Portuguese', () => {
  assert.equal(dated('em {{month}} de {{year}}', new Date('2026-10-31T12:00:00Z')), 'em outubro de 2026');
});

test('evals: every case is well formed', () => {
  const ids = new Set();
  for (const c of cases) {
    assert.match(c.id, /^[a-z0-9-]+$/, c.id);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.why && c.message, `${c.id}: why and message`);
    const e = c.expect ?? {};
    const exps = [...(e.calls ?? []), ...(e.noCalls ?? []), ...(e.every ? [e.every] : [])];
    assert.ok(exps.length || e.answer || e.judge?.length, `${c.id}: expects nothing`);
    for (const x of exps) {
      // Every tool a case names exists, so a renamed tool fails here.
      if (x.tool) for (const name of x.tool.split('|')) assert.ok(TOOLS.includes(name), `${c.id}: unknown tool ${name}`);
      for (const [k, m] of Object.entries(x.args ?? {})) {
        if (typeof m === 'string') new RegExp(m, 'i');
        else assert.ok(typeof m === 'boolean' || (Array.isArray(m) && m.length === 2 && m.every(n => typeof n === 'number')), `${c.id}: bad matcher for ${k}`);
      }
    }
    for (const re of [...(e.answer?.match ?? []), ...(e.answer?.noMatch ?? [])]) new RegExp(re, 'i');
    for (const r of c.requires ?? []) assert.ok(r.site || r.tariff != null || r.promo != null, `${c.id}: requirement ${JSON.stringify(r)}`);
  }
});
