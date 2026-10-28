// Dev helper: node scripts/call.mjs <tool> '<json args>' [url]
const [tool, args = '{}', url = 'http://127.0.0.1:3002/mcp'] = process.argv.slice(2);
const r = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: JSON.parse(args) } }),
});
const j = await r.json();
if (j.error) { console.error(j.error); process.exit(1); }
const res = j.result;
if (res.isError) { console.error(res.content[0].text); process.exit(1); }
console.log(JSON.stringify(res.structuredContent ?? res.content, null, 2));
