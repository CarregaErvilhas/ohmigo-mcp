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

// The guides as MCP skills (SEP-2640): what a client that supports the
// extension sees, over an in-memory pair, no HTTP.
test('voltaria: every guide is served as a skill whose SKILL.md matches its digest', { skip }, async () => {
  const { createHash } = await import('node:crypto');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Dataset } = await import('../src/data.js');
  const { LiveStatus } = await import('../src/live.js');
  const { createServer } = await import('../src/mcp.js');
  const ds = new Dataset(JSON.parse(readFileSync(new URL('fixtures/chargers.json', import.meta.url), 'utf8')));
  const server = createServer(() => ds, new LiveStatus());
  const [client, side] = InMemoryTransport.createLinkedPair();
  await server.connect(side);
  const replies = new Map();
  client.onmessage = m => { if (m.id !== undefined) replies.get(m.id)?.(m); };
  let id = 0;
  const rpc = (method, params = {}) => new Promise(resolve => { const n = ++id; replies.set(n, resolve); client.send({ jsonrpc: '2.0', id: n, method, params }); });
  await client.start();
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'skills', version: '0' } });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.ok(init.result.capabilities.extensions?.['io.modelcontextprotocol/skills'], 'skills extension not declared');

  const { result } = await rpc('skills/list');
  const names = topics().guides.map(g => g.topic);
  assert.deepEqual(result.skills.map(s => s.frontmatter.name).sort(), names);
  for (const s of result.skills) {
    assert.equal(s.uri, `skill://voltaria/${s.frontmatter.name}/SKILL.md`);
    const read = await rpc('resources/read', { uri: s.uri });
    const text = read.result.contents[0].text;
    assert.equal(text, getGuide(s.frontmatter.name).content);
    const md = s.resources.find(r => r.uri === s.uri);
    assert.equal(md.digest, 'sha256:' + createHash('sha256').update(text).digest('hex'));
  }
  const bad = await rpc('skills/get', { uri: 'skill://voltaria/../package/SKILL.md' });
  assert.equal(bad.error?.code, -32602);
  await server.close();
});
