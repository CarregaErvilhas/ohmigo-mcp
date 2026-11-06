// The Voltaria knowledge base is a git submodule (voltaria/). Without it
// checked out these tests skip; CI checks it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptionOf, getFacts, getGuide, topics, VOLTARIA_AVAILABLE } from '../src/voltaria.js';

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
  for (const { topic } of guides) assert.ok(getGuide(topic).content.length > 0);
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

// The topic list is all the assistant sees before choosing a guide.
test('voltaria: every guide has a description that says when to use it', { skip }, () => {
  for (const { topic, description } of topics().guides) {
    assert.ok(description.length >= 100, `${topic}: description too short or missing`);
    assert.match(description, /\bUsa\b/, `${topic}: says nothing about when to use it`);
  }
});

test('voltaria: descriptionOf reads quoted and plain frontmatter, and nothing else', () => {
  assert.equal(descriptionOf('---\nname: x\ndescription: "a \\"b\\" c"\n---\nbody'), 'a "b" c');
  assert.equal(descriptionOf('---\ndescription: plain\n---\n'), 'plain');
  assert.equal(descriptionOf('no frontmatter\ndescription: x'), '');
});
