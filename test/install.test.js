// site/install.js picks the steps for the browser in use from its user agent.
// The browser pane only runs Chrome, so the other browsers are checked here
// with real user agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sandbox = {};
runInNewContext(readFileSync(new URL('../site/install.js', import.meta.url), 'utf8'), sandbox);
const { installHint } = sandbox;

const CASES = [
  ['ios-safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'],
  ['ios-safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', 5], // iPad
  ['ios-other', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/137.0.7151.79 Mobile/15E148 Safari/604.1'],
  ['ios-other', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/139.0 Mobile/15E148 Safari/605.1.15'],
  ['ios-other', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/137.3296.68 Mobile/15E148 Safari/605.1.15'],
  ['ios-other', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', 5, true], // Brave
  ['in-app', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76 [FBAN/FBIOS;FBAV/514.0.0.43.109;FBBV/735443453;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.5;FBSS/3;FBCR/;FBID/phone;FBLC/pt_PT;FBOP/80]'],
  ['in-app', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 384.0.0.28.95 (iPhone15,2; iOS 18_5; pt_PT; pt; scale=3.00; 1179x2556; 742716331)'],
  ['in-app', 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/137.0.7151.89 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/514.0.0.54.109;]'],
  ['in-app', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/137.0.7151.89 Mobile Safari/537.36'],
  ['android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'],
  ['android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36 EdgA/137.0.3296.83'],
  ['samsung', 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36'],
  ['android-firefox', 'Mozilla/5.0 (Android 14; Mobile; rv:139.0) Gecko/139.0 Firefox/139.0'],
  ['desktop', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15', 0],
  ['desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'],
  ['desktop', 'Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0'],
];

test('install: each browser gets its own steps', () => {
  for (const [want, ua, touch = 0, brave = false] of CASES) assert.equal(installHint(ua, touch, brave), want, ua);
});

test('install: the page has a block of steps for every answer', () => {
  const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
  for (const hint of new Set(CASES.map(c => c[0]))) assert.match(html, new RegExp(`data-install-hint="${hint}"`), hint);
});
