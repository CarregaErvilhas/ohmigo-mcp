// Builds the MCP Apps view: ui/results.html with the ext-apps bridge inside.
//
// The bridge (`App` from @modelcontextprotocol/ext-apps) is the small library
// the page uses to talk to the chat app hosting it: receive the tool result,
// open a link, follow the theme. Hosts load the page in a sandboxed iframe
// that can't fetch scripts from our server unless we declare extra security
// (CSP) domains, so the simplest thing is to ship the bridge INSIDE the HTML.
//
// The bundle is an ES module (it ends in `export { ... as App }`), and an
// inline <script> can't use `export`. So we:
//   1. cut the trailing `export {...}`,
//   2. wrap the rest in a function, so its minified top-level names (`S`,
//      `qB`...) don't leak into the page and collide with ours,
//   3. hand `App` out as `globalThis.McpApps.App`.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { VERSION } from './version.js';

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
  const bridge = `(function(){${bundle.slice(0, m.index)};globalThis.McpApps={App:${app[0]}};})();`;
  const page = await readFile(new URL('../ui/results.html', import.meta.url), 'utf8');
  // A function replacer, because the bundle contains `$&`-style sequences
  // that a replacement string would interpret. `</script` inside the bundle
  // would end our <script> element early, so it's escaped.
  html = page.replaceAll('__VERSION__', VERSION).replace('/*__BRIDGE__*/', () => bridge.replace(/<\/script/gi, '<\\/script'));
  return html;
}
