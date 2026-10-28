// The process entry point: an HTTP server. POST /mcp is the MCP server;
// GET / is a landing page for people (site/index.html).
//
// What happens on boot:
//   1. load the charger dataset (data.js), from a local file in development or
//      from nap-dashboard's Pages copy in production;
//   2. start one download of the live status feed (live.js), so the first user
//      after a deploy doesn't have to wait for it;
//   3. listen for requests.
//
// Every request gets a brand new MCP server object (cheap: it's a few closures)
// with no session id. "Stateless" means any request can land on any instance,
// and a restart loses nothing, because there's nothing to lose.

import { createServer as createHttp } from 'node:http';
import { readFileSync } from 'node:fs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Dataset } from './data.js';
import { LiveStatus } from './live.js';
import { createServer, QA } from './mcp.js';

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 256 * 1024;
// How often to ask whether a new weekly dataset is out. See below.
const DATASET_CHECK_MS = Number(process.env.DATASET_CHECK_HOURS || 6) * 3600_000;

let ds = await Dataset.load();
console.log(`[ohmigo] ${ds.sites.length} sites, data as of ${ds.generatedAt}`);

const live = new LiveStatus();
if (process.env.LIVE_WARMUP !== '0') live.refresh();

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

// The landing page: one static file, read once at boot.
const SITE = readFileSync(new URL('../site/index.html', import.meta.url));
// Privacy, support and terms share one file; its script picks the page from the path.
// Directories and assistants' review forms want a stable URL for each.
const LEGAL = readFileSync(new URL('../site/legal.html', import.meta.url));
const LEGAL_PATHS = new Set(['/privacidade', '/privacy', '/suporte', '/support', '/termos', '/terms']);
const SITE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
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

createHttp(async (req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  // Health check for the hosting platform (and for you: it shows how fresh
  // the data is).
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, dataAsOf: ds.generatedAt, live: live.info() });
  if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, SITE_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : SITE);
  }
  if (LEGAL_PATHS.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, SITE_HEADERS);
    return res.end(req.method === 'HEAD' ? undefined : LEGAL);
  }
  if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
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
}).listen(PORT, HOST, () => console.log(`[ohmigo] http://${HOST}:${PORT}/mcp`));
