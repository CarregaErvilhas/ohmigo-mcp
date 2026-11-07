// The Voltaria knowledge base is a git submodule (voltaria/). Without it
// checked out these tests skip; CI checks it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// The guides are written in the voltaria repo and name ohmigo's tools in
// asides like "(no ohmigo: `ev_rules_portugal` com `topic: \"incentives\"`)".
// A rename here doesn't reach them: they once named get_facts, which never
// existed, with a facts topic that didn't either. Tool names come from the
// registrations in src/mcp.js; topics from what is on disk.
test('voltaria: the tools and topics the guides name in "no ohmigo" asides exist', { skip }, () => {
  const src = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  const tools = new Set([...src.matchAll(/(?:registerTool\(|registerAppTool\(server, )'([a-z_]+)'/g)].map(m => m[1]));
  const { guides, facts } = topics();
  const known = new Set([...facts, ...guides.map(g => g.topic)]);
  for (const { topic } of guides) {
    for (const [aside] of getGuide(topic).content.matchAll(/no ohmigo:[^)]*\)/g)) {
      for (const [, name] of aside.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(tools.has(name), `${topic}: "${name}" is not an ohmigo tool`);
      for (const [, t] of aside.matchAll(/topic: "([^"]+)"/g)) assert.ok(known.has(t), `${topic}: topic "${t}" doesn't exist`);
    }
  }
});
