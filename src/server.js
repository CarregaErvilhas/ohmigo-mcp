// The process entry point: an HTTP server. POST /mcp is the MCP server;
// GET / is a landing page for people (site/index.html).
//
// What happens on boot:
//   1. load the charger dataset (data.js), from a local file in development or
//      from nap-dashboard's Pages copy in production;
//   2. start one download of the live status feed (live.js), a few seconds
//      later on each instance, so the first user after a deploy doesn't have
//      to wait for it;
//   3. listen for requests, until SIGTERM (a deploy): then finish the ones
//      in flight and exit.
//
// Every request gets a brand new MCP server object (cheap: it's a few closures)
// with no session id. "Stateless" means any request can land on any instance,
// and a restart loses nothing, because there's nothing to lose.

import { createServer as createHttp } from 'node:http';
import { readFileSync } from 'node:fs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { cemeHealth } from './ceme.js';
import { Dataset } from './data.js';
import { LiveStatus } from './live.js';
import { chargers, dump } from './dump.js';
import { createServer, QA } from './mcp.js';
import { PAGES, SITEMAP, SITE_URL } from './site.js';
import { statsSummary } from './stats.js';
import { VERSION } from './version.js';

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 256 * 1024;
// How often to ask whether a new weekly dataset is out. See below.
const DATASET_CHECK_MS = Number(process.env.DATASET_CHECK_HOURS || 6) * 3600_000;

// A CDN hiccup at boot shouldn't crash-loop the container. 4 tries of 15 s
// with 2/4/8 s between them is ~74 s, inside Zerops' 120 s readiness
// timeout (zerops.yml); past that, exit and let the platform keep the old
// version.
async function loadDataset(tries = 4) {
  for (let i = 1; ; i++) {
    try { return await Dataset.load({ timeoutMs: 15_000 }); } catch (e) {
      console.error(`[ohmigo] dataset load ${i}/${tries} failed: ${e.message}`);
      if (i === tries) process.exit(1);
      await new Promise(r => setTimeout(r, 2_000 * 2 ** (i - 1)));
    }
  }
}
let ds = await loadDataset();
console.log(`[ohmigo] ${ds.sites.length} sites, data as of ${ds.generatedAt}`);

const live = new LiveStatus();
// Jittered, so two instances booting together don't both pull the 38 MB feed
// at the same second. A request before then just triggers it itself.
if (process.env.LIVE_WARMUP !== '0') setTimeout(() => live.refresh(), Math.random() * 20_000).unref();

// The dataset changes once a week (Monday morning), but the server may run for
// weeks without a restart. So every few hours it asks "has it changed?" with
// the ETag of the copy it has. Unchanged: the answer is a 304 of a few hundred
// bytes and nothing else happens. Changed: it downloads the new file (~600 KB
// compressed) and swaps it in; requests already running finish on the old one.
// If the check fails, the old copy stays. A local file (development) is never
// re-checked.
if (!process.env.DATASET_PATH && ds.etag !== undefined) {
  setInterval(async () => {
    try {
      const next = await Dataset.load({ etag: ds.etag });
      if (next) { ds = next; console.log(`[ohmigo] new dataset, data as of ${ds.generatedAt}`); }
    } catch (e) { console.warn('[ohmigo] dataset check failed, keeping the current one:', e.message); }
  }, DATASET_CHECK_MS).unref();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}

// The landing page, one copy per language rendered at boot (src/site.js),
// and its link-preview image.
const OG_IMAGE = readFileSync(new URL('../site/og.png', import.meta.url));
// Privacy and support share one file; its script picks the page from the path.
// Directories and assistants' review forms want a stable URL for each.
const LEGAL = readFileSync(new URL('../site/legal.html', import.meta.url));
// The data dump: what the tools know, for people (src/dump.js). Public, but
// kept out of search engines (X-Robots-Tag, which also covers the JSON).
// Meant to sit behind Cloudflare's cache: tariffs, offers and the dataset
// change rarely, so the edge keeps a copy for 1 h (s-maxage) and may serve it
// up to a day past that while it fetches a new one in the background
// (stale-while-revalidate); browsers keep it 10 min. Cache-Tag lets one API
// call purge all of it (Cloudflare strips the header before the browser).
// Cloudflare only caches HTML/JSON when a Cache Rule makes /dados* eligible.
const DADOS = readFileSync(new URL('../site/dados.html', import.meta.url));
const DADOS_CACHE = {
  'cache-control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
  'cache-tag': 'ohmigo-dados',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};
// With ceme-v2 down the page goes out without tariffs: 1 min, so the edge
// doesn't keep the hole for a day.
const DADOS_PARTIAL = { ...DADOS_CACHE, 'cache-control': 'public, max-age=60, s-maxage=60' };
const sendDados = (res, body, partial = false, type = 'application/json') => {
  res.writeHead(200, { ...(partial ? DADOS_PARTIAL : DADOS_CACHE), 'content-type': type });
  res.end(body);
};
const LEGAL_PATHS = new Set(['/privacidade', '/privacy', '/suporte', '/support']);
const SITE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

// Browser-based clients (MCP Inspector, claude.ai's connector check) send
// CORS preflights. The server holds no user data and needs no cookies, so
// any origin may call it.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id, authorization',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

// ok: every dependency answers. degraded: answering, but the last live feed
// refresh failed, or CEME prices are off (the tools say so in their results).
// An old live copy alone isn't degraded: the feed is fetched on demand, so a
// quiet server has an old one. Always
// 200 while the server can answer at all, so a ceme-v2 outage doesn't make
// the platform restart a healthy container; monitors read `status`.
function health() {
  const lv = live.info(), ceme = cemeHealth();
  const problems = [
    ...(lv.error ? ['live: ' + lv.error] : []),
    ...(ceme.openUntil ? ['ceme-v2: unavailable'] : []),
  ];
  const ageH = (Date.now() - Date.parse(ds.generatedAt)) / 3600_000;
  // The dataset is rebuilt weekly; past ~9 days the pipeline has missed one.
  if (ageH > 9 * 24) problems.push('dataset: older than 9 days');
  const mem = process.memoryUsage();
  return {
    ok: true, status: problems.length ? 'degraded' : 'ok', problems, version: VERSION,
    dataAsOf: ds.generatedAt, dataAgeHours: Math.round(ageH * 10) / 10,
    live: lv, ceme, tools: statsSummary(),
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
  };
}

const httpServer = createHttp(async (req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  // Health check for the hosting platform (and for you: it shows how fresh
  // the data is).
  if (url.pathname === '/healthz') return send(res, 200, health());
  const get = req.method === 'GET' || req.method === 'HEAD';
  if ((url.pathname === '/' || url.pathname === '/en') && get) {
    // Old links chose the language with ?lang=; each language has its own URL now.
    const want = url.searchParams.get('lang');
    if ((want === 'en' && url.pathname === '/') || (want === 'pt' && url.pathname === '/en')) {
      url.searchParams.delete('lang');
      res.writeHead(301, { location: (want === 'en' ? '/en' : '/') + url.search });
      return res.end();
    }
    res.writeHead(200, SITE_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : PAGES[url.pathname === '/en' ? 'en' : 'pt']);
  }
  if (url.pathname === '/og.png' && get) {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(req.method === 'HEAD' ? undefined : OG_IMAGE);
  }
  if (url.pathname === '/sitemap.xml') return send(res, 200, SITEMAP, 'application/xml; charset=utf-8');
  if (LEGAL_PATHS.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, SITE_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : LEGAL);
  }
  if (url.pathname === '/dados' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { ...SITE_HEADERS, ...DADOS_CACHE });
    return res.end(req.method === 'HEAD' ? undefined : DADOS);
  }
  // A broken dump page must not take the MCP server down with it.
  if (url.pathname === '/dados.json' || url.pathname === '/dados/postos.json') {
    try {
      const body = url.pathname === '/dados.json' ? await dump(ds) : chargers(ds, url.searchParams.get('op') || '');
      return sendDados(res, JSON.stringify(body), !!body.partial);
    } catch (e) {
      console.error('[ohmigo] dados:', e);
      return send(res, 500, { error: 'dados unavailable' });
    }
  }
  if (url.pathname === '/robots.txt') return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /mcp\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, 'text/plain; charset=utf-8');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname !== '/mcp') return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
  // Someone pasted the MCP address into a browser. MCP clients never ask for
  // text/html, so send the person to the page that explains what to do.
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
    res.writeHead(302, { location: '/?from=mcp#instalar' });
    return res.end();
  }
  // Stateless server: no stream to resume (GET) and no session to end (DELETE).
  if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });

  let body;
  try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  // QA mode logs every call, so a tester can see what the client actually sent.
  if (QA) console.log('[ohmigo] qa:', body?.method, body?.params?.name ?? '', JSON.stringify(body?.params?.arguments ?? {}));
  const server = createServer(() => ds, live);
  // Responses go out as a stream (SSE), not one JSON blob, so a progress
  // message can reach the user while a tool waits for the live feed.
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('[ohmigo]', e);
    if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}).listen(PORT, HOST, () => console.log(`[ohmigo] ${VERSION} http://${HOST}:${httpServer.address().port}/mcp`));

// A deploy sends SIGTERM to the old process: stop taking connections, let
// the requests in flight finish (a ranking, a ceme-v2 call: seconds), then
// exit. 15 s is the cap, for a request stuck on the 38 MB feed.
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[ohmigo] ${signal}: finishing requests in flight`);
  httpServer.close(() => process.exit(0));
  httpServer.closeIdleConnections();
  setTimeout(() => process.exit(0), 15_000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
