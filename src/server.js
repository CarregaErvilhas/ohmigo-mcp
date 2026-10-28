// HTTP entry point. Stateless Streamable HTTP: a fresh McpServer + transport
// per request, no session ids, so any instance can answer any request.

import { createServer as createHttp } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Dataset } from './data.js';
import { LiveStatus } from './live.js';
import { createServer } from './mcp.js';

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 256 * 1024;

let ds = await Dataset.load();
console.log(`[ohmigo] ${ds.sites.length} sites, data as of ${ds.generatedAt}`);
const live = new LiveStatus();
if (process.env.NAP_POLL !== '0') live.start();

// With DATASET_URL, pick up the weekly NAP refresh without a redeploy. A
// failed reload keeps the data we have.
if (process.env.DATASET_URL) {
  setInterval(async () => {
    try {
      const next = await Dataset.load();
      if (next.generatedAt !== ds.generatedAt) { ds = next; console.log(`[ohmigo] reloaded, data as of ${ds.generatedAt}`); }
    } catch (e) { console.warn('[ohmigo] dataset reload failed:', e.message); }
  }, 6 * 3600_000).unref();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}

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
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, dataAsOf: ds.generatedAt, live: live.info() });
  if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
  // Stateless server: no SSE stream to resume and no session to delete.
  if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });

  let body;
  try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
  const server = createServer(ds, live);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error('[ohmigo]', e);
    if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}).listen(PORT, HOST, () => console.log(`[ohmigo] http://${HOST}:${PORT}/mcp`));
