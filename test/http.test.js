// The whole server over HTTP: src/server.js started as a process, with a
// four-site dataset (test/fixtures) and a fake ceme-v2, called the way an MCP
// client calls it. Covers what the unit tests can't: the tool handlers, the
// response shapes, /healthz, the shutdown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

let ceme, cemeDown = false, server, base;

before(async () => {
  // Fake ceme-v2: one tariff, priced at 0.2 €/kWh.
  ceme = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (cemeDown) { res.writeHead(503); return res.end('down'); }
      const send = x => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
      if (req.url === '/v1/session') return send({ token: 't', expires_in: 3600 });
      if (req.url === '/v1/tariffs') return send({ data: [{ id: 'edp-bt-x', ceme: 'EDPC', ceme_id: 'EDPC', ceme_name: 'EDP', name: 'Stub', kind: 'FIXED' }] });
      if (req.url === '/v1/promos') return send({ data: [] });
      const b = JSON.parse(body || '{}');
      send({
        at: b.at, kwh: b.kwh, region: b.region, omieSpot: null,
        data: [{ id: 'edp-bt-x', ceme: 'EDP', name: 'Stub', voltage: 'BT', popular: true, bundle: false, totalEur: b.kwh * 0.2, vat: 1.23, period: 'UNICO', kind: 'FIXED' }],
        ...(b.profile && { profile: { slices: b.profile.length, withSpot: 0 } }),
      });
    });
  }).listen(0, '127.0.0.1');
  await once(ceme, 'listening');

  server = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_PATH: 'test/fixtures/chargers.json',
      CEME_API_URL: `http://127.0.0.1:${ceme.address().port}`, CEME_API_KEY: '',
      NAP_STATUS_URL: 'http://127.0.0.1:9/live', LIVE_WARMUP: '0', LIVE_WAIT_SECONDS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  base = await new Promise((resolve, reject) => {
    server.stdout.on('data', () => { const m = out.match(/http:\/\/(\S+?)\/mcp/); if (m) resolve(`http://${m[1]}`); });
    server.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
});

after(() => { server.kill('SIGKILL'); ceme.close(); });

async function call(name, args) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name === 'tools/list' ? name : 'tools/call', params: name === 'tools/list' ? {} : { name, arguments: args } }),
  });
  const msgs = (await r.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  return msgs.find(m => m.id === 1).result;
}

const car = { battery_kwh: 58, start_pct: 20 };

test('http: every tool is read-only and talks to the outside world', async () => {
  const { tools } = await call('tools/list');
  assert.equal(tools.length, 6);
  for (const t of tools) assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: true }, t.name);
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
});

test('http: find_cheapest_charging ranks MOBI.E and the networks outside it', async () => {
  const r = await call('find_cheapest_charging', { place: 'Leiria', ...car });
  const d = r.structuredContent;
  assert.equal(d.kind, 'ranking');
  assert.equal(d.quoted, 3);
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
  // A cost ranking still needs a place.
  const cheap = await call('find_cheapest_charging', { min_voltage: 900, ...car });
  assert.equal(cheap.structuredContent.code, 'where');
});

test('http: list_operators groups the NAP operators and narrows by filter and name', async () => {
  const all = (await call('list_operators', {})).structuredContent;
  // Same size: by name (Galp before Modelo Continente).
  assert.deepEqual(all.operators.map(o => [o.operatorId, o.sites]), [['GLPP', 2], ['CONT', 2]]);
  assert.equal(all.operators[1].maxVoltage, 1000);
  assert.ok(all.notes.length >= 1);
  const dc = (await call('list_operators', { min_voltage: 950 })).structuredContent;
  assert.deepEqual(dc.operators.map(o => o.operatorId), ['CONT']);
  const galp = (await call('list_operators', { query: 'galp' })).structuredContent;
  assert.deepEqual(galp.operators.map(o => o.operatorId), ['GLPP']);
});

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
    assert.equal(d.counts.sites, 4);
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
  assert.equal(d.counts.sites, 4);
  assert.deepEqual(d.ceme.tariffs.map(t => t.id), ['edp-bt-x']);
  assert.equal('totalEur' in d.ceme.tariffs[0], false);
  assert.ok(d.operators.some(o => o.id === 'CONT'));
  assert.ok(d.offers.list.length > 0);

  const postos = await (await fetch(`${base}/dados/postos.json?op=CONT`)).json();
  assert.deepEqual(postos.map(s => s.id).sort(), ['CNT-9648PL0001', 'CNT-9648PR0002']);
});

test('http: with ceme-v2 down, the other ways to pay still come back, flagged', async () => {
  cemeDown = true;
  try {
    const r = await call('find_cheapest_charging', { place: 'Leiria', ...car, at: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.cemeUnavailable, true);
    const mobie = r.structuredContent.results.filter(q => q.regime === 'mobie');
    assert.ok(mobie.every(q => q.cemeUnavailable && q.total === null));
    const t = await call('list_ceme_tariffs', {});
    assert.equal(t.isError, true);
    assert.equal(t.structuredContent.code, 'ceme');
    assert.doesNotMatch(t.content[0].text, /fetch failed|HTTP 503/);
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

// Last: it stops the server.
test('http: SIGTERM lets the process exit cleanly', async () => {
  server.kill('SIGTERM');
  const [code] = await once(server, 'exit');
  assert.equal(code, 0);
});
