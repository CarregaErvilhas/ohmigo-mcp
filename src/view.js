// Builds the MCP Apps view: ui/results.html with the ext-apps App bridge
// inlined. Hosts render the view in a sandboxed iframe that can't load
// scripts from our origin unless we declare CSP domains, so the bridge ships
// inside the HTML. The bundle is an ES module; we swap its trailing `export`
// for a global so a plain inline <script> can use it.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let html = null;

export async function viewHtml() {
  if (html) return html;
  const bundlePath = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
  const bundle = await readFile(bundlePath, 'utf8');
  const m = bundle.match(/export\s*\{([^}]*)\};?\s*$/);
  if (!m) throw new Error('ext-apps bundle: trailing export not found');
  const app = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)).find(([, name]) => name === 'App');
  if (!app) throw new Error('ext-apps bundle: App export not found');
  const bridge = bundle.slice(0, m.index) + `;globalThis.McpApps={App:${app[0]}};`;
  const page = await readFile(new URL('../ui/results.html', import.meta.url), 'utf8');
  // A function replacer: the bundle contains `$&`-style sequences that a
  // replacement string would interpret.
  html = page.replace('/*__BRIDGE__*/', () => bridge.replace(/<\/script/gi, '<\\/script'));
  return html;
}
