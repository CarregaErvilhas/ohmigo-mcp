// The Voltaria knowledge base is a git submodule (voltaria/). Without it
// checked out these tests skip; CI checks it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFacts, getGuide, topics, VOLTARIA_AVAILABLE } from '../src/voltaria.js';

const skip = !VOLTARIA_AVAILABLE && 'voltaria/ submodule not checked out';

test('voltaria: a topic is looked up, never joined into a path', { skip }, () => {
  for (const bad of ['../README', '../../package', 'a/b', '', '.', 'INCENTIVOS'])
    assert.throws(() => getGuide(bad), /Unknown guide/);
  for (const bad of ['../package', '..', 'x/../incentives'])
    assert.throws(() => getFacts(bad, 'x'), /Unknown facts topic/);
});

test('voltaria: every listed guide loads', { skip }, () => {
  const { guides } = topics();
  assert.ok(guides.length > 0);
  for (const g of guides) assert.ok(getGuide(g).content.length > 0);
});

test('voltaria: facts match on every word, flag ended ones, hide future ones', { skip }, () => {
  const { facts } = topics();
  const t = facts[0];
  const all = getFacts(t, '');
  assert.ok(all.length > 0);
  assert.deepEqual(getFacts(t, 'zzzzqqqq'), []);
  const long = new Date('2100-01-01');
  assert.ok(getFacts(t, '', 'pt', long).every(f => f.ended === !!f.validTo));
  assert.ok(getFacts(t, '', 'pt', new Date('1990-01-01')).length < all.length || all.every(f => !f.validFrom));
});
