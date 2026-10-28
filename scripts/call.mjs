// Dev helper: node scripts/call.mjs <tool> '<json args>' [url]
// Prints progress notifications to stderr and the result to stdout.
const [tool, args = '{}', url = 'http://127.0.0.1:3002/mcp'] = process.argv.slice(2);
const r = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: JSON.parse(args), _meta: { progressToken: 'p1' } } }),
});
const body = await r.text();
const msgs = r.headers.get('content-type')?.includes('text/event-stream')
  ? body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
  : [JSON.parse(body)];
for (const m of msgs) if (m.method === 'notifications/progress') console.error('progress:', m.params.message);
const j = msgs.find(m => m.id === 1);
if (j.error) { console.error(j.error); process.exit(1); }
const res = j.result;
if (res.isError) { console.error(res.content[0].text); process.exit(1); }
console.log(JSON.stringify(res.structuredContent ?? res.content, null, 2));
