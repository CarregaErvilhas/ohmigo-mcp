// What the server answers around the tools: who may read what on /healthz,
// which methods the data dump takes, what a browser is told about each kind
// of response. Two servers: one with HEALTHZ_TOKEN set, one without.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';

// This process only calls dump.js directly; nothing here may reach the real ceme-v2.
process.env.CEME_API_URL = 'http://127.0.0.1:9';
const { chargers, dump, forgetDump } = await import('../src/dump.js');

const TOKEN = 'a-long-random-token';
const CEME_BODY = 'stack trace from db-internal-7 at /srv/ceme';

let ceme, cemeDown = false, withToken, noToken;
const children = [];

async function boot(env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_PATH: 'test/fixtures/chargers.json',
      CEME_API_URL: `http://127.0.0.1:${ceme.address().port}`, CEME_API_KEY: 'k',
      NAP_STATUS_URL: 'http://127.0.0.1:9/live', LIVE_WARMUP: '0', LIVE_WAIT_SECONDS: '1', HEALTHZ_TOKEN: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const proc = { child, log: '' };
  child.stderr.on('data', c => { proc.log += c; });
  proc.base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', c => { out += c; const m = out.match(/http:\/\/(\S+?)\/mcp/); if (m) resolve(`http://${m[1]}`); });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
  return proc;
}

before(async () => {
  ceme = createServer((req, res) => {
    req.resume();
    if (cemeDown) { res.writeHead(500); return res.end(CEME_BODY); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/promos' ? { data: [] } : { region: 'CONT', data: [] }));
  }).listen(0, '127.0.0.1');
  await once(ceme, 'listening');
  [withToken, noToken] = await Promise.all([boot({ HEALTHZ_TOKEN: TOKEN }), boot({})]);
  // Each server tries the unreachable live feed, so /healthz has a failure to report.
  await Promise.all([withToken, noToken].map(s => fetch(`${s.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estimate_charging_cost', arguments: { site: 'GLP-LRA-00156', battery_kwh: 58, start_pct: 20 } } }),
  }).then(r => r.text())));
});

after(() => { for (const c of children) c.kill('SIGKILL'); ceme.close(); });

const PUBLIC = ['dataAgeHours', 'dataAsOf', 'ok', 'problems', 'status', 'version'];

test('healthz: the public answer is the summary, with no raw error strings', async () => {
  for (const [server, headers] of [
    [withToken, {}], [withToken, { 'x-healthz-token': 'wrong' }], [withToken, { 'x-healthz-token': '' }],
    [noToken, {}], [noToken, { 'x-healthz-token': '' }], [noToken, { 'x-healthz-token': 'undefined' }],
  ]) {
    const r = await fetch(`${server.base}/healthz`, { headers });
    assert.equal(r.status, 200, 'readiness only needs a 200');
    const h = await r.json();
    assert.deepEqual(Object.keys(h).sort(), PUBLIC);
    assert.equal(h.ok, true);
    assert.equal(h.status, 'degraded');
    assert.ok(h.problems.includes('live: last refresh failed'), h.problems.join());
    for (const p of h.problems) assert.match(p, /^(live: last refresh failed|ceme-v2: unavailable|dataset: older than 9 days)$/);
  }
});

test('healthz: the right token adds the detail, and nothing caches it', async () => {
  const r = await fetch(`${withToken.base}/healthz`, { headers: { 'x-healthz-token': TOKEN } });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const h = await r.json();
  for (const k of [...PUBLIC, 'live', 'ceme', 'tools', 'memoryMb']) assert.ok(k in h, k);
  assert.ok(h.live.error, 'the raw error is for the token holder');
  assert.ok(h.tools.estimate_charging_cost.calls >= 1);
  assert.ok(h.memoryMb.rss > 0);
});

test('dados: a ceme-v2 failure reaches the log, not the public JSON', async () => {
  cemeDown = true;
  try {
    const text = await (await fetch(`${withToken.base}/dados.json`)).text();
    assert.doesNotMatch(text, /db-internal|stack trace|HTTP 500/);
    const d = JSON.parse(text);
    assert.equal(d.partial, true);
    assert.equal(d.ceme.error, 'unavailable');
    assert.equal(d.promos.error, 'unavailable');
    await new Promise(r => setTimeout(r, 50));
    assert.match(withToken.log, /db-internal/);
  } finally { cemeDown = false; }
});

test('dados: only GET and HEAD reach the JSON', async () => {
  for (const path of ['/dados.json', '/dados/postos.json?op=CONT']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${noToken.base}${path}`, { method });
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.equal(r.headers.get('allow'), 'GET, HEAD');
    }
    const head = await fetch(`${noToken.base}${path}`, { method: 'HEAD' });
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), '');
  }
});

test('dados: postos ignores every query parameter but op, and unknown operators stay empty', async () => {
  const get = async q => (await fetch(`${noToken.base}/dados/postos.json${q}`)).text();
  const plain = await get('?op=CONT');
  assert.ok(JSON.parse(plain).length > 0);
  assert.equal(await get('?op=CONT&x=1&cache=2'), plain);
  assert.equal(await get('?x=1&op=CONT'), plain);
  for (const q of ['', '?op=', '?op=__proto__', '?op=constructor', '?op=nobody']) assert.equal(await get(q), '[]', q);
});

test('dados: postos are built once per operator and dataset', () => {
  const ds = { sites: [{ id: 'A-1', operatorId: 'A', points: [] }, { id: 'B-1', operatorId: 'B', points: [] }] };
  const first = chargers(ds, 'A');
  assert.deepEqual(first.map(s => s.id), ['A-1']);
  assert.equal(chargers(ds, 'A'), first);
  assert.notEqual(chargers({ sites: ds.sites }, 'A'), first, 'a new dataset starts over');
});

test('dados: a new dataset drops the memo that held the old one', async () => {
  const ds = { sites: [], generatedAt: '2026-01-01T00:00:00Z' };
  const first = dump(ds);
  assert.equal(dump(ds), first);
  forgetDump();
  const second = dump(ds);
  assert.notEqual(second, first);
  await Promise.all([first, second]);
});

const HTML_PATHS = ['/', '/en', '/privacidade', '/privacy', '/suporte', '/support', '/dados'];
const IMAGES = ['/og.png', '/favicon.ico', '/icon.svg', '/icon-512.png', '/apple-touch-icon.png'];

test('headers: every HTML page asks for isolation', async () => {
  for (const path of HTML_PATHS) {
    const r = await fetch(`${noToken.base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('permissions-policy'), /geolocation=\(\)/, path);
    assert.doesNotMatch(r.headers.get('permissions-policy'), /clipboard/, 'the landing page has copy buttons');
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin', path);
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', path);
  }
});

test('headers: images stay loadable from an assistant\'s app', async () => {
  for (const path of IMAGES) {
    const r = await fetch(`${noToken.base}${path}`);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin', path);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', path);
  }
});

test('headers: the landing page and /dados allow exactly their own inline script', async () => {
  for (const path of ['/', '/en', '/dados']) {
    const r = await fetch(`${noToken.base}${path}`);
    const page = await r.text();
    const scriptSrc = r.headers.get('content-security-policy').match(/script-src ([^;]*)/)[1];
    assert.doesNotMatch(scriptSrc, /unsafe-inline/, path);
    const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(inline.length >= 1);
    for (const body of inline) assert.ok(scriptSrc.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`), path);
    // A hash turns inline handlers off, so none can be in the markup.
    assert.doesNotMatch(page.replace(/<script[\s\S]*?<\/script>/g, ''), /<[^>]+\son[a-z]+=/, path);
  }
});

test('cors: open on /mcp and what assistants fetch, absent from pages and operations', async () => {
  const open = ['/mcp', '/llms.txt', '/dados.json', '/dados/postos.json?op=CONT', ...IMAGES, '/.well-known/security.txt', '/.well-known/oauth-protected-resource/mcp'];
  for (const path of open) {
    const r = await fetch(`${noToken.base}${path}`, { headers: { origin: 'https://claude.ai' } });
    assert.equal(r.headers.get('access-control-allow-origin'), '*', path);
  }
  for (const path of [...HTML_PATHS, '/healthz', '/robots.txt', '/sitemap.xml', '/nope']) {
    const r = await fetch(`${noToken.base}${path}`, { headers: { origin: 'https://claude.ai' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, path);
  }
});

test('cors: the preflight on /mcp still answers what a browser client asks', async () => {
  const r = await fetch(`${noToken.base}/mcp`, {
    method: 'OPTIONS',
    headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,mcp-protocol-version' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-methods'), /POST/);
  assert.match(r.headers.get('access-control-allow-headers'), /mcp-protocol-version/);
  assert.match(r.headers.get('access-control-expose-headers'), /mcp-session-id/);
});

test('security.txt: RFC 9116 fields, with the contact on the privacy page', async () => {
  const r = await fetch(`${noToken.base}/.well-known/security.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  const text = await r.text();
  const email = text.match(/^Contact: mailto:(\S+)$/m)[1];
  assert.ok(readFileSync(new URL('../site/legal.html', import.meta.url), 'utf8').includes(`mailto:${email}`));
  const days = (Date.parse(text.match(/^Expires: (\S+)$/m)[1]) - Date.now()) / 86_400_000;
  assert.ok(days > 179 && days <= 180, `${days} days`);
  assert.match(text, /^Canonical: https:\/\/\S+\/\.well-known\/security\.txt$/m);
  assert.equal((await fetch(`${noToken.base}/.well-known/security.txt`, { method: 'POST' })).status, 404);
});
