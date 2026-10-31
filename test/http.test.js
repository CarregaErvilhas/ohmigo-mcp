// The whole server over HTTP: src/server.js started as a process, with a
// small dataset (test/fixtures) and a fake ceme-v2, called the way an MCP
// client calls it. Covers what the unit tests can't: the tool handlers, the
// response shapes, /healthz, the shutdown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moreWays } from '../src/mcp.js';

let ceme, cemeDown = false, cheapTip = false, server, base, serverLog = '';
// Enough rows to pass list_ceme_tariffs' cut, under a name with an accent.
const manyTariffs = Array.from({ length: 70 }, (_, i) => ({ id: `luzigas-bt-${i}`, ceme: 'LZG', ceme_id: 'LZG', ceme_name: 'Luzigás', name: `Plano ${i}`, kind: 'FIXED' }));

before(async () => {
  // Fake ceme-v2: one tariff, priced at 0.2 €/kWh.
  ceme = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (cemeDown) { res.writeHead(503); return res.end('down'); }
      const send = x => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
      if (req.url === '/v1/session') return send({ token: 't', expires_in: 3600 });
      if (req.url === '/v1/tariffs') return send({ data: [{ id: 'edp-bt-x', ceme: 'EDPC', ceme_id: 'EDPC', ceme_name: 'EDP', name: 'Stub', kind: 'FIXED' }, ...manyTariffs] });
      if (req.url === '/v1/promos') return send({ data: [] });
      const b = JSON.parse(body || '{}');
      send({
        at: b.at, kwh: b.kwh, region: b.region, omieSpot: null,
        data: [
          // The fixture's MOBI.E sockets are medium voltage.
          ...(cheapTip ? [
            { id: 'nope-mt-y', ceme: 'Nope', name: 'Cheap', voltage: 'MT', popular: false, bundle: false, totalEur: 0.01, vat: 1.23, period: 'UNICO', kind: 'FIXED' },
            { id: 'edp-mt-x', ceme: 'EDP', name: 'Stub', voltage: 'MT', popular: true, bundle: false, totalEur: b.kwh * 0.2, vat: 1.23, period: 'UNICO', kind: 'FIXED' },
          ] : []),
          { id: 'edp-bt-x', ceme: 'EDP', name: 'Stub', voltage: 'BT', popular: true, bundle: false, totalEur: b.kwh * 0.2, vat: 1.23, period: 'UNICO', kind: 'FIXED' },
        ],
        ...(b.profile && { profile: { slices: b.profile.length, withSpot: 0 } }),
      });
    });
  }).listen(0, '127.0.0.1');
  await once(ceme, 'listening');

  ({ proc: server, url: base } = await boot());
});

after(() => { server.kill('SIGKILL'); ceme.close(); });

async function boot(dataset = 'test/fixtures/chargers.json') {
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_PATH: dataset,
      CEME_API_URL: `http://127.0.0.1:${ceme.address().port}`, CEME_API_KEY: '',
      NAP_STATUS_URL: 'http://127.0.0.1:9/live', LIVE_WARMUP: '0', LIVE_WAIT_SECONDS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', c => { out += c; });
  proc.stderr.on('data', c => { serverLog += c; });
  const url = await new Promise((resolve, reject) => {
    proc.stdout.on('data', () => { const m = out.match(/http:\/\/(\S+?)\/mcp/); if (m) resolve(`http://${m[1]}`); });
    proc.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return { proc, url };
}

async function call(name, args, url = base) {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? {} : { name, arguments: args } }),
  });
  const msgs = (await r.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  return msgs.find(m => m.id === 1).result;
}

const car = { battery_kwh: 58, start_pct: 20 };

// fetch() cleans a URL up before sending it, so odd request targets need a
// socket. Sends `head`, then `body` if any, and resolves with what came back
// by the time the server closes the connection.
function rawRequest(head, body = '') {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const socket = connect(Number(port), hostname);
    let got = '';
    socket.on('data', c => { got += c; });
    // The server may close while we're still writing; what it sent still counts.
    socket.on('error', e => { if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') reject(e); });
    socket.on('close', () => resolve(got));
    socket.setTimeout(5_000, () => socket.destroy());
    socket.write(`${head}\r\n\r\n${body}`);
  });
}
const get = target => rawRequest(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close`);

test('http: every tool is read-only and talks to the outside world', async () => {
  const { tools } = await call('tools/list');
  assert.equal(tools.length, 6);
  for (const t of tools) assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: true }, t.name);
});

// The tool list is in the assistant's context in every conversation, used or
// not. Raising this is a decision, not a fix: first trim descriptions or merge
// tools (src/mcp.js says where guidance belongs). Six tools; list_operators
// and the socket filters (voltage, card, cable, hours) took it from 18 000.
const TOOLS_MAX_CHARS = 20_500;

test('http: the tool list stays small, and every tool says what it is for so tool search finds it', async () => {
  const { tools } = await call('tools/list');
  const n = JSON.stringify(tools).length;
  assert.ok(n <= TOOLS_MAX_CHARS, `tools/list is ${n} characters, budget ${TOOLS_MAX_CHARS}`);
  // Clients that load tools on demand match the user's request against names
  // and descriptions: each one names the domain in its own words.
  for (const t of tools) assert.match(t.description, /\bEV\b.*\bPortugal\b|\bPortugal\b.*\bEV\b/s, t.name);
});

test('http: the plug filter offers the plugs the dataset has, not an unknown one', async () => {
  const { tools } = await call('tools/list');
  const { enum: plugs } = tools.find(t => t.name === 'find_chargers').inputSchema.properties.connectors.items;
  assert.deepEqual(plugs, ['T2', 'CCS', 'CHADEMO', 'iec60309x2single16']);
  // Every tool with the filter says what a domestic plug maps to.
  const filtered = tools.filter(t => t.inputSchema.properties.connectors);
  assert.equal(filtered.length, 5);
  for (const t of filtered) assert.match(t.inputSchema.properties.connectors.description, /iec60309x2single16.*Schuko/, t.name);
});

test('http: with tariff_ids, a tariff the user lacks is a tip in both cost tools', async () => {
  cheapTip = true;
  try {
    // A battery no other test uses: ceme.js caches by time and kWh.
    const args = { battery_kwh: 61, start_pct: 20, tariff_ids: ['edp-bt-x'], lang: 'en' };
    const asked = [await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...args }), await call('find_cheapest_charging', { place: 'Leiria', limit: 20, ...args })];
    for (const r of asked) {
      const q = r.structuredContent.results.find(x => x.options.some(o => o.tariffId === 'nope-mt-y'));
      const tip = q.options.find(o => o.tariffId === 'nope-mt-y');
      assert.equal(tip.cheaperElsewhere, true);
      assert.equal(tip.notYours, true);
      assert.match(tip.note, /switch to it first/);
      assert.notEqual(q.best?.tariffId, 'nope-mt-y');
    }
    // The summary line counts ways to pay, and the tip isn't one yet.
    const ranked = asked[1];
    const q = ranked.structuredContent.results.find(x => x.options.some(o => o.notYours));
    const line = ranked.content[0].text.split('\n').find(l => l.includes(`[${q.pointId}]`));
    assert.ok(line.includes(`(+${q.options.length - 2} more ways to pay)`), line);
    const open = await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...args, tariff_ids: undefined, battery_kwh: 62 });
    const options = open.structuredContent.results.flatMap(q => q.options);
    assert.ok(options.some(o => o.cheaperElsewhere), 'the tip is there');
    assert.ok(!options.some(o => o.notYours), 'without tariff_ids nothing is tagged');
  } finally { cheapTip = false; }
});

test('the more-ways note does not count a tariff the user would have to switch to', () => {
  const t = key => key;
  assert.deepEqual(moreWays([{ options: [{ total: 1 }, { total: 2, notYours: true }] }], t), []);
  assert.deepEqual(moreWays([{ options: [{ total: 1 }, { total: 2 }] }], t), ['note.moreWays']);
});

test('http: estimate_charging_cost answers with structuredContent, and the text carries it too for text-only clients', async () => {
  const r = await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...car });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.kind, 'single');
  assert.match(r.structuredContent.version, /^\d+\.\d+\.\d+$/);
  assert.ok(r.structuredContent.results.length >= 1);
  // Clients that only read the text must still see every way to pay.
  const text = r.content[0].text;
  const json = JSON.parse(text.slice(text.indexOf('\n\n{') + 2));
  assert.deepEqual(json, r.structuredContent);
  assert.ok(json.results[0].options.length > 1);
  assert.ok(json.notes.some(n => /more ways to pay/.test(n)), 'says there are more ways to pay');
  // The NAP lists no card method here but OpenStreetMap tags a terminal: a
  // yes from either counts, and the option says the sources disagree.
  const adhoc = json.results.flatMap(q => q.options).find(o => o.kind === 'adhoc');
  assert.match(adhoc.label, /bank card at the charger/i);
  assert.match(adhoc.note, /disagree/);
});

test('http: find_cheapest_charging ranks MOBI.E and the networks outside it', async () => {
  const r = await call('find_cheapest_charging', { place: 'Leiria', ...car });
  const d = r.structuredContent;
  assert.equal(d.kind, 'ranking');
  assert.equal(d.quoted, 4);
  assert.equal(d.truncated, undefined);
  assert.ok(d.results.some(q => q.regime === 'sem_ceme') && d.results.some(q => q.regime === 'mobie'));
  assert.ok(JSON.stringify(r).length < 30_000);
});

test('http: a business error carries structuredContent for the view', async () => {
  const r = await call('find_chargers', { place: 'Atlantis' });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.kind, 'error');
  assert.equal(r.structuredContent.code, 'place');
  assert.equal(r.structuredContent.message, r.content[0].text);
});

test('http: find_chargers filters by declared voltage and says the values are declared', async () => {
  const r = await call('find_chargers', { place: 'Leiria', min_voltage: 800, lang: 'en' });
  const d = r.structuredContent;
  const points = d.sites.flatMap(s => s.points);
  assert.ok(points.length > 0);
  assert.ok(points.every(p => p.volts >= 800 && p.dc), JSON.stringify(points));
  assert.ok(d.notes.some(n => /declares/.test(n)));
});

test('http: find_chargers searches the whole country only when a filter keeps the list meaningful', async () => {
  const r = await call('find_chargers', { min_voltage: 900 });
  const d = r.structuredContent;
  assert.equal(d.wholeCountry, true);
  // Sockets with no declared voltage (the Lisbon T2) never pass.
  assert.deepEqual(d.sites.map(s => s.siteId), ['CNT-9648PR0002', 'GLP-LRA-00156']);
  const none = await call('find_chargers', {});
  assert.equal(none.isError, true);
  assert.equal(none.structuredContent.code, 'where');
  // pointFilter ignores card_payment: false, so it can't stand in for a place.
  const noCard = await call('find_chargers', { card_payment: false });
  assert.equal(noCard.isError, true);
  assert.equal(noCard.structuredContent.code, 'where');
  assert.match(noCard.content[0].text, /card_payment: true/);
  // A cost ranking still needs a place.
  const cheap = await call('find_cheapest_charging', { min_voltage: 900, ...car });
  assert.equal(cheap.structuredContent.code, 'where');
});

test('http: list_operators groups the NAP operators and narrows by filter and name', async () => {
  const all = (await call('list_operators', {})).structuredContent;
  // By size, then by name; EDPC is the EDP-FAR socket-poor site (components
  // tests), the nameless row is ZZZ-FAR's "no operator anywhere" site.
  assert.deepEqual(all.operators.map(o => [o.operatorId, o.sites]), [['CONT', 4], ['GLPP', 2], [undefined, 1], ['EDPC', 1]]);
  assert.equal(all.operators[0].maxVoltage, 1000);
  assert.ok(all.notes.length >= 1);
  // OpenStreetMap's 1000 V replaces the NAP's 920 V on Galp's CCS.
  assert.deepEqual((await call('list_operators', { min_voltage: 950 })).structuredContent.operators.map(o => o.operatorId), ['GLPP', 'CONT']);
  const fast = (await call('list_operators', { min_kw: 140 })).structuredContent;
  assert.deepEqual(fast.operators.map(o => o.operatorId), ['CONT']);
  const galp = (await call('list_operators', { query: 'galp' })).structuredContent;
  assert.deepEqual(galp.operators.map(o => o.operatorId), ['GLPP']);
});

test('http: lookup_charger finds a site by its NAP name and tells the driver what to know before going', async () => {
  const d = (await call('lookup_charger', { query: 'Marrazes', lang: 'en' })).structuredContent;
  const [c] = d.sites;
  assert.equal(c.siteId, 'GLP-LRA-00156');
  assert.equal(c.name, 'Galp Marrazes');
  assert.deepEqual(c.hours, { nap: '24/7', osm: '24/7' });
  assert.equal(c.openNow, true);
  assert.equal(c.cardPayment, true);
  assert.deepEqual(c.support, { phone: '800222222' });
  assert.equal(c.osm.manufacturer, 'Efacec');
  // The NAP lists no card, OSM says there's a terminal: the answer says so.
  assert.ok(d.notes.some(n => /GLP-LRA-00156.*bank card/.test(n)));
  const ccs = c.sockets.find(g => g.connector === 'CCS');
  assert.equal(ccs.volts, 1000);
  assert.equal(ccs.napVolts, 920);
  assert.equal(ccs.cable, true);
  assert.equal(c.sockets.find(g => g.connector === 'T2').cable, false);
  assert.ok(d.notes.some(n => /OpenStreetMap/.test(n)));
});

test('http: find_chargers filters by bank card, fixed cable and opening hours', async () => {
  const card = (await call('find_chargers', { place: 'Leiria', card_payment: true })).structuredContent;
  assert.deepEqual(card.sites.map(s => s.siteId).sort(), ['CNT-9648PR0002', 'GLP-LRA-00156']);
  const own = (await call('find_chargers', { place: 'Leiria', cable_attached: false })).structuredContent;
  assert.ok(own.sites.flatMap(s => s.points).every(p => p.cable === false));
  // Continente's T2 car park closes at 21:00 (Lisbon), so at 23:00 it's out.
  const night = (await call('find_cheapest_charging', { place: 'Leiria', open_now: true, at: nextLisbon(23), battery_kwh: 58, start_pct: 20 })).structuredContent;
  assert.ok(!night.results.some(q => q.siteId === 'CNT-9648PL0001'));
  const noon = (await call('find_cheapest_charging', { place: 'Leiria', open_now: true, at: nextLisbon(12), battery_kwh: 58, start_pct: 20 })).structuredContent;
  assert.ok(noon.results.some(q => q.siteId === 'CNT-9648PL0001'));
});

test('http: an estimate on OpenStreetMap power says so', async () => {
  const r = (await call('estimate_charging_cost', { point_id: 'CNT-9648PR0002/9648PR0002.01', battery_kwh: 58, start_pct: 20, lang: 'en' })).structuredContent;
  const [q] = r.results;
  assert.equal(q.kw, 150);
  assert.equal(q.napKw, 120);
  assert.ok(q.assumptions.some(x => /OpenStreetMap/.test(x)));
});

// The next time it's `hour`:00 in Lisbon, as an ISO instant (within the
// window the cost tools accept).
function nextLisbon(hour) {
  const now = new Date();
  for (let h = 1; h <= 48; h++) {
    const at = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000 + (h - 1) * 3_600_000);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', hourCycle: 'h23' }).format(at);
    if (Number(local) === hour) return at.toISOString();
  }
  throw new Error('no such hour');
}

test('http: at outside the window is refused', async () => {
  const r = await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...car, at: '1970-01-01T00:00:00Z' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /7 days ago and 365 days ahead/);
  const ok = await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...car, at: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  assert.equal(ok.isError, undefined);
});

test('http: /dados with ceme-v2 down goes out without tariffs, cached 1 min only', async () => {
  // Two failed calls (simulate, promos): under the circuit breaker's three,
  // and a partial result isn't memoized, so the next test gets a fresh one.
  cemeDown = true;
  try {
    const r = await fetch(`${base}/dados.json`);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=60, s-maxage=60');
    const d = await r.json();
    assert.equal(d.partial, true);
    assert.ok(d.ceme.error);
    assert.equal(d.counts.sites, 8);
  } finally { cemeDown = false; }
});

test('http: /dados is public, cacheable, unindexed, and has nothing that depends on the hour', async () => {
  const page = await fetch(`${base}/dados`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('cache-control'), /s-maxage=3600/);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal(page.headers.get('cache-tag'), 'ohmigo-dados');

  const r = await fetch(`${base}/dados.json`);
  assert.match(r.headers.get('cache-control'), /s-maxage=3600/);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  const d = await r.json();
  assert.equal(d.partial, false);
  assert.equal(d.counts.sites, 8);
  assert.deepEqual(d.ceme.tariffs.map(t => t.id), ['edp-bt-x']);
  assert.equal('totalEur' in d.ceme.tariffs[0], false);
  assert.ok(d.operators.some(o => o.id === 'CONT'));
  assert.ok(d.offers.list.length > 0);

  const postos = await (await fetch(`${base}/dados/postos.json?op=CONT`)).json();
  assert.deepEqual(postos.map(s => s.id).sort(), ['CNT-0001PL0002', 'CNT-9648PL0001', 'CNT-9648PL0003', 'CNT-9648PR0002']);
});

test('http: a site the NAP left nameless is its id prefix\'s operator everywhere, and says so', async () => {
  const named = (await call('lookup_charger', { query: 'CNT-9648PL0001' })).structuredContent.sites[0];
  const lent = (await call('lookup_charger', { query: 'CNT-0001PL0002', lang: 'en' })).structuredContent;
  const [card] = lent.sites;
  assert.equal(card.operator, named.operator);
  assert.equal(card.operatorId, 'CONT');
  assert.equal(card.operatorInferred, true);
  assert.equal(named.operatorInferred, undefined);
  assert.deepEqual(card.sockets[0].direct.map(x => x.label), named.sockets[0].direct.map(x => x.label));
  assert.ok(card.sockets[0].direct.length > 0);
  assert.ok(lent.notes.some(n => /inferred/.test(n) && n.includes(named.operator)));

  const q = (await call('estimate_charging_cost', { point_id: 'CNT-0001PL0002/0001PL0002.01', battery_kwh: 58, start_pct: 20, lang: 'en' })).structuredContent;
  assert.equal(q.results[0].operatorInferred, true);
  assert.ok(q.results[0].assumptions.some(a => /inferred/.test(a)));
  assert.ok(!q.results[0].options.some(o => /names no operator/.test(o.label)));

  const found = (await call('find_chargers', { query: 'Continente', lang: 'en' })).structuredContent;
  assert.equal(found.sites.find(s => s.siteId === 'CNT-0001PL0002').operatorInferred, true);
  assert.ok(found.notes.some(n => /inferred/.test(n)));

  const ops = (await call('list_operators', { query: 'continente', lang: 'en' })).structuredContent;
  assert.deepEqual(ops.operators.map(o => [o.operatorId, o.sites, o.inferredSites]), [['CONT', 4, 2]]);
  assert.ok(ops.notes.some(n => n.includes("2 of Modelo Continente Hipermercados, S.A.'s sites (inferredSites)")));
  assert.ok(!ops.notes.some(n => n.includes('(operatorInferred)')));
  const glp = (await call('list_operators', { query: 'galp', lang: 'en' })).structuredContent;
  assert.ok(!glp.notes.some(n => /inferred/.test(n)));
});

test('http: an inferred socket stays apart from its named sibling, so its assumption survives', async () => {
  const { results } = (await call('estimate_charging_cost', { site: 'CNT-9648PL0003', battery_kwh: 58, start_pct: 20, lang: 'en', at: '2026-11-02T12:00:00Z' })).structuredContent;
  const lent = results.filter(q => q.siteId === 'CNT-9648PL0003');
  assert.ok(lent.length >= 1);
  assert.ok(lent.every(q => q.assumptions.some(a => /inferred/.test(a))));
  assert.ok(results.some(q => q.siteId === 'CNT-9648PL0001' && !q.operatorInferred));
});

test('http: lookup_charger says each note once in its text', async () => {
  const r = await call('lookup_charger', { query: 'Continente', limit: 10, lang: 'en' });
  assert.ok(r.structuredContent.sites.filter(s => s.operatorInferred).length >= 2);
  const summary = r.content[0].text.split('\n\n')[0];
  assert.equal(summary.split('\n').filter(l => /inferred/.test(l)).length, 1);
});

test('http: a site with nobody to lend it an operator stays nameless, and /dados still lists it', async () => {
  const [card] = (await call('lookup_charger', { query: 'ZZZ-FAR-00001' })).structuredContent.sites;
  assert.equal(card.operator, null);
  assert.equal(card.operatorInferred, undefined);

  const { operators } = await (await fetch(`${base}/dados.json`)).json();
  const row = operators.find(o => !o.id);
  assert.equal(row.sites, 1);
  assert.ok(row.name);
  const cont = operators.find(o => o.id === 'CONT');
  assert.equal(cont.inferred, 2);
  assert.equal(cont.inferredNote, '2 locais sem operador no PAN, atribuídos pelo prefixo do id');
  // The nameless first site of a group doesn't leave the row nameless.
  assert.equal(cont.name, 'Modelo Continente Hipermercados, S.A.');
  const postos = await (await fetch(`${base}/dados/postos.json?op=${encodeURIComponent(row.key)}`)).json();
  assert.deepEqual(postos.map(s => s.id), ['ZZZ-FAR-00001']);
  // No key, no chargers: not every nameless site by accident.
  assert.deepEqual(await (await fetch(`${base}/dados/postos.json`)).json(), []);
});

// The order of the next tests matters: the server keeps the tariff list for
// minutes, so this one has to come before anything that fetches it, and three
// failures in a row stop all calls to ceme-v2 for a while, so the full outage
// test has to come after everything that needs ceme-v2.
test('http: with ceme-v2 down, list_ceme_tariffs says so in plain words', async () => {
  cemeDown = true;
  try {
    const t = await call('list_ceme_tariffs', {});
    assert.equal(t.isError, true);
    assert.equal(t.structuredContent.code, 'ceme');
    assert.doesNotMatch(t.content[0].text, /fetch failed|HTTP 503/);
  } finally { cemeDown = false; }
});

test('http: list_ceme_tariffs matches accents either way', async () => {
  for (const query of ['luzigas', 'luzigás', 'LUZIGAS']) {
    assert.equal((await call('list_ceme_tariffs', { query })).structuredContent.count, 70, query);
  }
});

test('http: list_ceme_tariffs says so when it cuts the list, and only then', async () => {
  const all = await call('list_ceme_tariffs', { lang: 'pt' });
  assert.equal(all.structuredContent.count, 71);
  assert.equal(all.structuredContent.tariffs.length, 60);
  assert.match(all.structuredContent.notes[0], /60 dos 71.*query/);
  assert.match(all.content[0].text, /^.*60 dos 71/);
  const narrow = await call('list_ceme_tariffs', { query: 'edp' });
  assert.equal(narrow.structuredContent.count, 1);
  assert.equal(narrow.structuredContent.notes, undefined);
  // Already narrowed: telling it to call again with query would go in circles.
  for (const lang of ['en', 'pt']) {
    const [note] = (await call('list_ceme_tariffs', { query: 'luzigas', lang })).structuredContent.notes;
    assert.match(note, /60 .*70/);
    assert.doesNotMatch(note, /query/);
  }
});

test('http: a socket with no published power or plug reads "?" in the summary lines', async () => {
  const unknown = /\(?\? kW \?\)? \[EDP-FAR-00001\/FAR-00001-01\]/;
  const ranked = await call('find_cheapest_charging', { place: 'Faro', ...car });
  assert.match(ranked.content[0].text.split('\n\n')[0], unknown);
  const single = await call('estimate_charging_cost', { site: 'EDP-FAR-00001', ...car });
  assert.match(single.content[0].text.split('\n\n')[0], unknown);
  const found = await call('lookup_charger', { query: 'EDP-FAR-00001' });
  assert.match(found.content[0].text.split('\n\n')[0], /1× \? kW \?$/m);
  // Only the text: the data keeps what the dataset says.
  assert.equal(single.structuredContent.results[0].connector, 'nan');
});

test('http: with ceme-v2 down, the other ways to pay still come back, flagged', async () => {
  cemeDown = true;
  try {
    const r = await call('find_cheapest_charging', { place: 'Leiria', ...car, at: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.cemeUnavailable, true);
    const mobie = r.structuredContent.results.filter(q => q.regime === 'mobie');
    assert.ok(mobie.every(q => q.cemeUnavailable && q.total === null));
  } finally { cemeDown = false; }
});

test('http: the landing page is rendered in each language at its own URL, for crawlers', async () => {
  const pt = await (await fetch(`${base}/`)).text();
  assert.match(pt, /<html lang="pt-PT">/);
  assert.match(pt, /<h1 data-i="hero.title">Pergunta ao teu assistente/);
  assert.match(pt, /<link rel="canonical" href="https:\/\/ohmigo\.ocarroeletrico\.com\/">/);
  assert.match(pt, /hreflang="en" href="https:\/\/ohmigo\.ocarroeletrico\.com\/en"/);
  assert.match(pt, /og:image" content="https:\/\/ohmigo\.ocarroeletrico\.com\/og\.png"/);
  assert.match(pt, /href="https:\/\/ceme\.ocarroeletrico\.com">comparador/);
  const ld = JSON.parse(pt.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'WebApplication');
  assert.doesNotMatch(pt, /data-i="[^"]+"><\//, 'no element left empty');

  const en = await (await fetch(`${base}/en`)).text();
  assert.match(en, /<html lang="en">/);
  assert.match(en, /<link rel="canonical" href="https:\/\/ohmigo\.ocarroeletrico\.com\/en">/);
  assert.match(en, /data-lang="en" aria-current="page"/);

  const old = await fetch(`${base}/?lang=en&from=x`, { redirect: 'manual' });
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('location'), '/en?from=x');

  const map = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(map, /<loc>https:\/\/ohmigo\.ocarroeletrico\.com\/en<\/loc>/);
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Sitemap: https:\/\/ohmigo\.ocarroeletrico\.com\/sitemap\.xml/);
  const og = await fetch(`${base}/og.png`);
  assert.equal(og.headers.get('content-type'), 'image/png');
});

test('http: /healthz, robots.txt, favicon and 404', async () => {
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.ok(['ok', 'degraded'].includes(h.status));
  assert.ok(h.problems.some(p => p.startsWith('live:')), 'the fake feed is down');
  assert.ok(h.tools.estimate_charging_cost.calls >= 1);
  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  for (const [path, type] of [['/favicon.ico', 'image/x-icon'], ['/icon.svg', 'image/svg+xml'], ['/icon-512.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), type);
  }
  const nf = await fetch(`${base}/nope`);
  assert.equal(nf.status, 404);
  assert.match(nf.headers.get('content-type'), /text\/plain/);
});

test('http: the view gets the bridge, the version and no raw coordinates', async () => {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://ohmigo/results.html' } }),
  });
  const msg = (await r.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))).find(m => m.id === 1);
  const html = msg.result.contents[0].text;
  assert.match(html, /globalThis\.McpApps=\{App:/);
  assert.doesNotMatch(html, /__BRIDGE__|__VERSION__/);
  assert.doesNotMatch(html, /data-lat="\$\{q\.lat\}"/);
  assert.match(html, /renderError/);
});

test('http: car powers below a real on-board charger or charger are refused; the lowest real one is priced', async () => {
  for (const args of [{ car_ac_kw: 1e-9 }, { car_dc_kw: 1e-9 }, { car_ac_kw: 0.5 }, { car_dc_kw: 0.5 }]) {
    const r = await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...car, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, /car_(ac|dc)_kw/);
  }
  const ok = await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...car, car_ac_kw: 1, car_dc_kw: 1 });
  assert.equal(ok.isError, undefined);
});

test('http: a session past the limit is a business error in the user\'s language; other sockets still price', async () => {
  const slow = { battery_kwh: 250, start_pct: 0, target_pct: 100, car_ac_kw: 1, car_dc_kw: 1 };
  for (const [lang, text] of [['en', /would take over 72 hours/], ['pt', /demoraria mais de 72 horas/]]) {
    const r = await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...slow, lang });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'tooLong');
    assert.match(r.content[0].text, text);
  }
  const ranking = await call('find_cheapest_charging', { place: 'Leiria', ...slow, lang: 'en' });
  assert.equal(ranking.structuredContent.code, 'tooLong');
  // No socket could be priced, so raising the time limit wouldn't help.
  const inTime = await call('find_cheapest_charging', { place: 'Leiria', ...slow, max_minutes: 30, lang: 'en' });
  assert.equal(inTime.structuredContent.code, 'tooLong');
  // Only the AC sockets are too slow here: they're left out, and the note says so.
  const some = (await call('estimate_charging_cost', { site: 'GLP-LRA-00156', battery_kwh: 250, start_pct: 0, target_pct: 100, car_ac_kw: 1, lang: 'en' })).structuredContent;
  assert.ok(some.results.length > 0 && some.results.every(q => q.dc));
  assert.ok(some.notes.some(n => /Kinds of socket left out/.test(n)));
});

test('http: a socket declared at 0 kW is priced and shown as unknown power', async () => {
  const data = JSON.parse(readFileSync(new URL('fixtures/chargers.json', import.meta.url)));
  for (const site of data.sites) for (const p of site.points) if (p.connector === 'T2') { p.kw = 0; delete p.osm; }
  const dir = mkdtempSync(join(tmpdir(), 'ohmigo-'));
  writeFileSync(join(dir, 'chargers.json'), JSON.stringify(data));
  const zero = await boot(join(dir, 'chargers.json'));
  try {
    const args = { site: 'GLP-LRA-00156', connectors: ['T2'], ...car, lang: 'en' };
    const r = await call('estimate_charging_cost', args, zero.url);
    assert.equal(r.isError, undefined);
    const [q] = r.structuredContent.results;
    assert.equal(q.kw, null);
    assert.ok(q.assumptions.some(a => /charger power not published/.test(a)), JSON.stringify(q.assumptions));
    assert.ok(q.options.every(o => o.kind !== 'direct'), 'no offers for a power band');
    const looked = await call('lookup_charger', { query: 'GLP-LRA-00156', connectors: ['T2'], lang: 'en' }, zero.url);
    for (const x of [r, looked]) {
      assert.doesNotMatch(x.content[0].text, /\b0 kW|null kW/);
      assert.match(x.content[0].text, /\? kW/);
    }
  } finally {
    zero.proc.kill('SIGKILL');
    rmSync(dir, { recursive: true });
  }
});

test('http: a request target that does not parse gets a 400, is logged, and the server keeps answering', async () => {
  for (const target of ['//', '//:', '/\\', 'http://[']) {
    assert.match(await get(target), /^HTTP\/1\.1 400 /, target);
    assert.match(serverLog, /bad request target/, target);
    assert.equal((await fetch(`${base}/healthz`)).status, 200, target);
  }
});

test('http: the path is the path: a target starting with two slashes names no host', async () => {
  // Parsed against a base URL, these would read as host "evil" and path "/mcp".
  for (const target of ['//evil/mcp', '/\\evil/mcp', '///evil/mcp', '//evil/healthz']) {
    assert.match(await get(target), /^HTTP\/1\.1 404 /, target);
  }
  // A proxy's absolute form is still a normal request for its path.
  assert.match(await get('http://example.com/healthz'), /^HTTP\/1\.1 200 /);
});

test('http: an oversized body gets a 413 and the connection closes without reading the rest', async () => {
  const size = 256 * 1024 + 1;
  const declared = `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${size}`;
  // Declared up front: answered without waiting for the body at all.
  assert.match(await rawRequest(declared), /^HTTP\/1\.1 413 /);
  // No declared length: the server stops once the chunks pass the limit.
  const chunked = 'POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked';
  const chunk = 'x'.repeat(64 * 1024);
  const body = `${chunk.length.toString(16)}\r\n${chunk}\r\n`.repeat(5);
  const r = await rawRequest(chunked, body);
  assert.match(r, /^HTTP\/1\.1 413 /);
  assert.match(r, /connection: close/i);
  assert.match(r, /too large/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('http: a body at the limit is still read', async () => {
  const pad = ' '.repeat(255 * 1024);
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}${pad}`,
  });
  assert.equal(r.status, 200);
});

test('http: a JSON-RPC batch is refused with a JSON-RPC error, on any protocol version', async () => {
  const one = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  for (const body of [[one, { ...one, id: 2 }], [one], []]) {
    // Without the version header the SDK assumes the oldest protocol, which had batches.
    for (const version of ['2025-06-18', '2025-03-26', undefined]) {
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(version && { 'mcp-protocol-version': version }) },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400, version);
      assert.match(r.headers.get('content-type'), /application\/json/);
      const d = await r.json();
      assert.equal(d.jsonrpc, '2.0');
      assert.equal(d.id, null);
      assert.equal(d.error.code, -32600);
      assert.match(d.error.message, /batch/i);
    }
  }
});

test('http: free-text arguments have a length limit', async () => {
  const at = n => 'a'.repeat(n);
  const cases = [
    ['find_chargers', { place: at(201) }, 'place'],
    ['find_cheapest_charging', { place: at(201), ...car }, 'place'],
    ['estimate_charging_cost', { point_id: at(201), ...car }, 'point_id'],
    ['list_ceme_tariffs', { query: at(201) }, 'query'],
    ['estimate_charging_cost', { site: 'GLP-LRA-00156', ...car, tariff_ids: [at(101)] }, 'tariff_ids'],
  ];
  for (const [tool, args, field] of cases) {
    const r = await call(tool, args);
    assert.equal(r.isError, true, `${tool} ${field}`);
    assert.match(r.content[0].text, new RegExp(field), `${tool} ${field}`);
  }
  // At the limit they're ordinary arguments, answered as usual.
  assert.equal((await call('find_chargers', { place: at(200) })).structuredContent.code, 'place');
  assert.equal((await call('estimate_charging_cost', { point_id: at(200), ...car })).structuredContent.code, 'point');
  assert.ok((await call('list_ceme_tariffs', { query: at(200) })).structuredContent);
  assert.equal((await call('estimate_charging_cost', { site: 'GLP-LRA-00156', ...car, tariff_ids: [at(100)] })).isError, undefined);
});

// Last: it stops the server.
test('http: SIGTERM lets the process exit cleanly', async () => {
  server.kill('SIGTERM');
  const [code] = await once(server, 'exit');
  assert.equal(code, 0);
});
