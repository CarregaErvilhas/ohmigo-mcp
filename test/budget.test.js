// What every conversation with ohmigo connected pays for, used or not: the
// server's instructions and the tool list. Clients cut them: Claude Code
// keeps the first 2048 characters of the instructions and of each tool
// description (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH changes that), and
// ChatGPT weighs the first 512 most. So the instructions open with what the
// assistant can't do without, and the rest lives in the tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Dataset } from '../src/data.js';
import { LiveStatus } from '../src/live.js';
import { createServer, INSTRUCTIONS, QA_NOTE } from '../src/mcp.js';

const CUT = 2048;
const HEAD = 512;
// Adding a tool is a decision, not a fix: first try an argument on one that
// exists (see "private" on estimate_charging_cost).
const TOOLS_MAX = 7;

// tools/list straight from createServer, over an in-memory pair: no HTTP, no
// ceme-v2, nothing priced.
async function listTools() {
  const ds = new Dataset(JSON.parse(readFileSync(new URL('fixtures/chargers.json', import.meta.url), 'utf8')));
  const server = createServer(() => ds, new LiveStatus());
  const [client, side] = InMemoryTransport.createLinkedPair();
  await server.connect(side);
  const replies = new Map();
  client.onmessage = m => { if (m.id !== undefined) replies.get(m.id)?.(m); };
  const rpc = (id, method, params = {}) => new Promise(resolve => { replies.set(id, resolve); client.send({ jsonrpc: '2.0', id, method, params }); });
  await client.start();
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'budget', version: '0' } });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const { result } = await rpc(2, 'tools/list');
  await server.close();
  return result.tools;
}

test('budget: the instructions, QA note included, fit before Claude Code cuts them', () => {
  const n = INSTRUCTIONS.length + QA_NOTE.length;
  assert.ok(n <= CUT, `${n} > ${CUT} characters: move what one tool needs to its description, and what one result needs to the result`);
});

test('budget: the first 512 characters say what ohmigo covers (voltaria too), the language rule and who is who', () => {
  const head = INSTRUCTIONS.slice(0, HEAD);
  for (const must of [/Portugal/, /NAP/, /\blang\b/, /user's language/, /\bCEME\b/, /\bOPC\b/, /\bDPC\b/, /voltaria/]) assert.match(head, must);
});

test('budget: the plug rule stays in the instructions: every tool returns sockets, and users look for a plug', () => {
  assert.match(INSTRUCTIONS, /which plug to use \("plug"\)/);
});

test('budget: every tool description fits before Claude Code cuts it, and the list stays short', async () => {
  const tools = await listTools();
  assert.ok(tools.length <= TOOLS_MAX, `${tools.length} tools, budget ${TOOLS_MAX}`);
  for (const t of tools) assert.ok(t.description.length <= CUT, `${t.name}: ${t.description.length} > ${CUT} characters`);
});

test('budget: the presentation rules ride on the pricing tools, where every client reads them', async () => {
  const tools = await listTools();
  for (const name of ['find_cheapest_charging', 'estimate_charging_cost']) {
    const d = tools.find(t => t.name === name).description;
    for (const must of [/"best"/, /adhoc/, /newCustomersOnly/, /audience/, /peak/, /OpenStreetMap/, /live\.fresh/]) assert.match(d, must, `${name} lacks ${must}`);
  }
});

// Clients that load tools on demand (Claude Code's tool search) show the
// assistant only tool names until it loads one, and "voltaria" says nothing.
// The instructions are always shown, so they carry the routing: a question
// that isn't a price goes to voltaria, not to memory or a web search, which
// still give the rules of the revoked DL 39/2010.
test('budget: the instructions send non-price EV questions to voltaria, even when tools are deferred', () => {
  for (const must of [/Not a price\?/, /what a condo can refuse/, /not memory or the web/, /DL 93\/2025/, /by name only: load it/]) assert.match(INSTRUCTIONS, must);
});
