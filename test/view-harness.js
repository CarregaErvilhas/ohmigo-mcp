// Runs the script of ui/results.html in a VM with a stand-in for the browser,
// so a test can hand it a tool result and read the HTML it writes. The file
// name doesn't end in .test.js: it's a helper, not a test.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../ui/results.html', import.meta.url), 'utf8');
const script = html.match(/<script>\/\*__BRIDGE__\*\/<\/script>\s*<script>([\s\S]*?)<\/script>/)[1];

export function renderView(structuredContent) {
  const els = { list: { className: '', textContent: '', innerHTML: '' }, foot: { textContent: '' } };
  let app;
  vm.runInNewContext(script, {
    document: { documentElement: { dataset: {} }, getElementById: id => els[id], addEventListener() {} },
    navigator: { language: 'en' },
    McpApps: {
      App: class {
        constructor() { app = this; }
        connect() { return Promise.resolve(); }
        getHostContext() { return null; }
      },
    },
  });
  app.ontoolresult({ structuredContent });
  // One string per charger row, the first being the top of the ranking.
  return els.list.innerHTML.split('<div class="row').slice(1);
}
