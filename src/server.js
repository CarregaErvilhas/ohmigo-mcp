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

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { readFileSync } from 'node:fs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { cemeHealth } from './ceme.js';
import { Dataset } from './data.js';
import { LiveStatus } from './live.js';
import { chargers, dump, forgetDump } from './dump.js';
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
      if (next) { ds = next; forgetDump(); console.log(`[ohmigo] new dataset, data as of ${ds.generatedAt}`); }
    } catch (e) { console.warn('[ohmigo] dataset check failed, keeping the current one:', e.message); }
  }, DATASET_CHECK_MS).unref();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Stops reading but leaves the socket open: the caller still has to get
    // the 413 out through it.
    const tooLarge = () => { req.pause(); reject(Object.assign(new Error('too large'), { status: 413 })); };
    if (Number(req.headers['content-length']) > MAX_BODY) return tooLarge();
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) tooLarge(); else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}

// The landing page, one copy per language rendered at boot (src/site.js),
// and its link-preview image.
const OG_IMAGE = readFileSync(new URL('../site/og.png', import.meta.url));
const LLMS_TXT = readFileSync(new URL('../site/llms.txt', import.meta.url));
// The mascot as an icon. Assistants (ChatGPT's app list, Claude's connector
// list) show the one the MCP server declares in serverInfo.icons (src/mcp.js)
// or, failing that, the site's favicon, so every URL must answer with an image.
const ICONS = Object.fromEntries([
  ['/icon.svg', 'image/svg+xml'], ['/icon-512.png', 'image/png'],
  ['/apple-touch-icon.png', 'image/png'], ['/favicon.ico', 'image/x-icon'],
].map(([path, type]) => [path, { type, body: readFileSync(new URL(`../site${path}`, import.meta.url)) }]));
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
  // No clipboard here: the landing page's copy buttons use it.
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': csp("'unsafe-inline'"),
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
// robots.txt, sitemap.xml and llms.txt only change with a deploy.
const sendPublic = (res, body, type) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' }); res.end(body); };

// Browser-based clients (MCP Inspector, claude.ai's connector check) send
// CORS preflights. The server holds no user data and needs no cookies, so
// any origin may call it, on the paths a client has a reason to read: /mcp,
// the public JSON and images, and /.well-known, where MCP clients look for
// OAuth metadata before connecting (at the root or under /mcp) and need to be
// able to read the 404.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id, authorization',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};
const corsOpen = path => path === '/mcp' || path.startsWith('/mcp/') || path === '/og.png' || path === '/dados.json' || path === '/dados/postos.json'
  || !!ICONS[path] || path.startsWith('/.well-known/');
// Images go inside assistants' apps, some of which only load what says it may
// be embedded elsewhere.
const IMAGE_HEADERS = { 'cache-control': 'public, max-age=86400', 'cross-origin-resource-policy': 'cross-origin' };

// Hoisted: SITE_HEADERS above uses it too.
function csp(scriptSrc) {
  return `default-src 'self'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
// Inline scripts allowed by hash instead of 'unsafe-inline'. <script> with no
// attributes skips the JSON blocks, which browsers don't run. Change a script
// and its hash follows. The landing page's script is the same in both languages.
const inlineScripts = html => [...new Set([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`))].join(' ');
const LANDING_HEADERS = { ...SITE_HEADERS, 'content-security-policy': csp(inlineScripts(Object.values(PAGES).join(''))) };
const DADOS_PAGE_HEADERS = { ...SITE_HEADERS, ...DADOS_CACHE, 'content-security-policy': csp(inlineScripts(DADOS.toString())) };

// RFC 9116. Expires is required and a fixed date would rot, so each answer
// counts from today.
const securityTxt = () => `Contact: mailto:info@ocarroeletrico.com
Expires: ${new Date(Date.now() + 180 * 86_400_000).toISOString()}
Canonical: ${SITE_URL}/.well-known/security.txt
Preferred-Languages: pt, en
`;

// The detail on /healthz is for whoever runs the server. Hashing first gives
// timingSafeEqual two buffers of the same length, whatever was sent. No token
// configured means nobody gets the detail.
const HEALTHZ_TOKEN = process.env.HEALTHZ_TOKEN || null;
const sha256 = s => createHash('sha256').update(s).digest();
const healthzAllowed = given => !!HEALTHZ_TOKEN && timingSafeEqual(sha256(given ?? ''), sha256(HEALTHZ_TOKEN));

// ok: every dependency answers. degraded: answering, but the last live feed
// refresh failed, or CEME prices are off (the tools say so in their results).
// An old live copy alone isn't degraded: the feed is fetched on demand, so a
// quiet server has an old one. Always
// 200 while the server can answer at all, so a ceme-v2 outage doesn't make
// the platform restart a healthy container; monitors read `status`.
// `problems` is public, so it names what's wrong without the raw error, which
// is in `live.error` for whoever has the token.
function health(detail) {
  const lv = live.info(), ceme = cemeHealth();
  const problems = [
    ...(lv.error ? ['live: last refresh failed'] : []),
    ...(ceme.openUntil ? ['ceme-v2: unavailable'] : []),
  ];
  const ageH = (Date.now() - Date.parse(ds.generatedAt)) / 3600_000;
  // The dataset is rebuilt weekly; past ~9 days the pipeline has missed one.
  if (ageH > 9 * 24) problems.push('dataset: older than 9 days');
  const summary = {
    ok: true, status: problems.length ? 'degraded' : 'ok', problems, version: VERSION,
    dataAsOf: ds.generatedAt, dataAgeHours: Math.round(ageH * 10) / 10,
  };
  if (!detail) return summary;
  const mem = process.memoryUsage();
  return {
    ...summary, live: lv, ceme, tools: statsSummary(),
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
  };
}

// The request target as a URL, or null when it doesn't parse. A target is a
// path ("/mcp?x=1"), but a URL parser reads a leading "//" (or "/\\": in http
// URLs a backslash counts as a slash) as "a host comes next". So those are
// parsed again glued to the base, which leaves the whole thing as the path.
function parseTarget(target) {
  try {
    const url = new URL(target, 'http://x');
    return /^\/[/\\]/.test(target) ? new URL(`http://x${target}`) : url;
  } catch { return null; }
}

async function handle(req, res) {
  const url = parseTarget(req.url);
  if (!url) {
    console.warn('[ohmigo] bad request target:', JSON.stringify(req.url.slice(0, 200)));
    return send(res, 400, 'bad request\n', 'text/plain; charset=utf-8');
  }
  if (corsOpen(url.pathname)) for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  // Health check for the hosting platform (and for you: it shows how fresh
  // the data is).
  if (url.pathname === '/healthz') return send(res, 200, health(healthzAllowed(req.headers['x-healthz-token'])));
  const get = req.method === 'GET' || req.method === 'HEAD';
  if ((url.pathname === '/' || url.pathname === '/en') && get) {
    // Old links chose the language with ?lang=; each language has its own URL now.
    const want = url.searchParams.get('lang');
    if ((want === 'en' && url.pathname === '/') || (want === 'pt' && url.pathname === '/en')) {
      url.searchParams.delete('lang');
      res.writeHead(301, { location: (want === 'en' ? '/en' : '/') + url.search });
      return res.end();
    }
    res.writeHead(200, LANDING_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : PAGES[url.pathname === '/en' ? 'en' : 'pt']);
  }
  if (url.pathname === '/og.png' && get) {
    res.writeHead(200, { ...IMAGE_HEADERS, 'content-type': 'image/png' });
    return res.end(req.method === 'HEAD' ? undefined : OG_IMAGE);
  }
  if (ICONS[url.pathname] && get) {
    res.writeHead(200, { ...IMAGE_HEADERS, 'content-type': ICONS[url.pathname].type });
    return res.end(req.method === 'HEAD' ? undefined : ICONS[url.pathname].body);
  }
  if (url.pathname === '/sitemap.xml') return sendPublic(res, SITEMAP, 'application/xml; charset=utf-8');
  if (LEGAL_PATHS.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, SITE_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : LEGAL);
  }
  if (url.pathname === '/dados' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, DADOS_PAGE_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : DADOS);
  }
  // A broken dump page must not take the MCP server down with it.
  if (url.pathname === '/dados.json' || url.pathname === '/dados/postos.json') {
    if (!get) { res.setHeader('allow', 'GET, HEAD'); return send(res, 405, { error: 'method not allowed' }); }
    try {
      const body = url.pathname === '/dados.json' ? await dump(ds) : chargers(ds, url.searchParams.get('op') || '');
      return sendDados(res, JSON.stringify(body), !!body.partial);
    } catch (e) {
      console.error('[ohmigo] dados:', e);
      return send(res, 500, { error: 'dados unavailable' });
    }
  }
  if (url.pathname === '/robots.txt') return sendPublic(res, `User-agent: *\nAllow: /\nDisallow: /mcp\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, 'text/plain; charset=utf-8');
  if (url.pathname === '/llms.txt' && get) return sendPublic(res, LLMS_TXT, 'text/plain; charset=utf-8');
  if (url.pathname === '/.well-known/security.txt' && get) return send(res, 200, securityTxt(), 'text/plain; charset=utf-8');
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
  try { body = await readJson(req); } catch (e) {
    // The rest of a body that's too large stays unread, so this connection
    // can't carry another request: Node closes it once the response is out.
    if (e.status === 413) res.setHeader('connection', 'close');
    return send(res, e.status || 400, { error: e.message });
  }
  // A JSON array is a JSON-RPC batch: many tool calls in one request. The
  // 2025-06-18 protocol removed them and no client of ours sends one, but the
  // SDK still takes them from clients on older versions. Without this, one
  // POST could ask for many answers, past what the body limit and the cost of
  // a tool call assume.
  if (Array.isArray(body)) return send(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: JSON-RPC batches are not supported' }, id: null });
  // QA mode logs every call, so a tester can see what the client actually sent.
  if (QA) console.log('[ohmigo] qa:', body?.method, body?.params?.name ?? '', JSON.stringify(body?.params?.arguments ?? {}));
  const server = createServer(() => ds, live);
  // Responses go out as a stream (SSE), not one JSON blob, so a progress
  // message can reach the user while a tool waits for the live feed.
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { closing(() => transport.close()); closing(() => server.close()); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('[ohmigo]', e);
    // With the headers out, a status can't be sent any more: closing is how
    // the client learns this response won't finish.
    if (res.headersSent) res.destroy();
    else send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

// Node ends the process on a promise rejection nobody handles, so the two
// things that run outside handle()'s own promise chain catch their own: the
// handler as a whole, and the cleanup after the response has closed.
const closing = close => Promise.resolve().then(close).catch(e => console.error('[ohmigo] close:', e));

const httpServer = createHttp((req, res) => {
  handle(req, res).catch(e => {
    console.error('[ohmigo] request:', e);
    if (res.headersSent) res.destroy();
    else send(res, 500, 'internal error\n', 'text/plain; charset=utf-8');
  });
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
