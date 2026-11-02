// Dev helper: node scripts/call.mjs <tool> '<json args>' [url]
// Prints progress notifications to stderr and the result to stdout.
const [tool, args = '{}', url = 'http://127.0.0.1:3002/mcp'] = process.argv.slice(2);
const die = message => { console.error(message); process.exit(1); };
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const r = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: parse(args) ?? die(`the arguments aren't valid JSON: ${args}`), _meta: { progressToken: 'p1' } } }),
}).catch(e => die(`can't reach ${url} (${e.cause?.code ?? e.message}): is the server running?`));
const body = await r.text().catch(e => die(`the reply from ${url} broke off (HTTP ${r.status}): ${e.cause?.code ?? e.message}`));
// Whatever doesn't parse is dropped: without our reply, that's said just below.
const msgs = (r.headers.get('content-type')?.includes('text/event-stream')
  ? body.split('\n').filter(l => l.startsWith('data: ')).map(l => parse(l.slice(6)))
  : [parse(body)]).filter(Boolean);
for (const m of msgs) if (m.method === 'notifications/progress') console.error('progress:', m.params.message);
const j = msgs.find(m => m.id === 1);
// A proxy's error page or a rejected request: no reply to our call at all.
if (!j) die(`no reply from ${url} (HTTP ${r.status}): ${body.slice(0, 500).replaceAll('\n', ' ')}`);
if (j.error) die(j.error.message ?? JSON.stringify(j.error));
const res = j.result;
if (res.isError) die(res.content[0].text);
console.log(JSON.stringify(res.structuredContent ?? res.content, null, 2));
