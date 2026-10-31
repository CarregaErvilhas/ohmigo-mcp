// site/dados.html is one inline script with no build step, so the test runs
// that script as it ships: in a bare VM, with a stand-in for the few DOM calls
// it makes and a fake fetch. What it reads comes from third parties (the NAP,
// ceme-v2, a blog), so the page has to treat all of it as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../site/dados.html', import.meta.url), 'utf8');
const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
const tick = () => new Promise(r => setImmediate(r));

// Runs the page and returns what it drew. `answer(url)` plays the server.
async function load({ hash = '', answer }) {
  // As in a browser, whichever of the two is set last replaces the content.
  const metaEl = { html: 'A carregar…', set innerHTML(v) { this.html = v; }, set textContent(v) { this.html = v; } };
  const els = { '#meta': metaEl, '#tabs': { innerHTML: '' }, '#app': { innerHTML: '' } };
  const on = {};
  vm.runInNewContext(script, {
    document: { querySelector: s => els[s] ?? null, addEventListener: (type, fn) => { on[type] = fn; } },
    location: { hash },
    fetch: async url => answer(url),
    URL,
    queueMicrotask,
    console: { error() {}, warn() {}, log() {} },
  });
  await tick();
  const meta = () => metaEl.html;
  const app = () => els['#app'].innerHTML;
  const open = async op => {
    on.click({ target: { closest: s => (s === '[data-op]' ? { dataset: { op } } : null) } });
    await tick();
  };
  return { meta, app, open };
}

const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = status => ({ ok: false, status, json: async () => ({ error: 'dados unavailable' }) });

const bad = 'javascript:alert(1)';
const dump = over => ({
  version: '1.0.0', dataAsOf: '2026-10-26T00:00:00Z', now: '2026-10-31T00:00:00Z',
  counts: { sites: 1, points: 1, regimes: { mobie: 1 } },
  ceme: { region: 'CONT', tariffs: [{ id: 't', legacyId: '"><img id=legacy>', ceme: 'C', name: "d'Ávila", kind: 'FIXED', voltage: 'BT', schedule: 'S', cycle: 'D', validFrom: '2026-01-01', url: bad, promos: [], prices: { SIMPLES: 0.1 } }] },
  promos: [
    { id: 'p1', ceme: 'C', name: 'P1', target: 'OPC', pct: '<img id=pct>', url: ' JaVaScRiPt:alert(1)', from: 'a', checked: 'b' },
    { id: 'p2', ceme: 'C', name: 'P2', target: 'KWH_GRATIS', freeKwh: '<img id=free>', url: 'https://ceme.example/promo?a=1&b=2', from: 'a', checked: 'b' },
  ],
  offers: { source: { post: bad, published: '2026-01-01' }, list: [{ id: 'o', label: 'O', network: 'N', scope: { mobie: true }, source: 'data:text/html,x', origin: 'custofinal', checkedAt: '2026-01-01' }], orphans: [] },
  napNotes: [{ scope: { operatorIds: ['X'] }, why: 'w', source: 'vbscript:x', checkedAt: '2026-01-01' }],
  networks: {},
  operators: [{ key: 'K', id: 'I', name: 'N', website: bad, sites: 1, points: 1, dc: 0, maxKw: 50, regimes: {}, plans: [], adhoc: [], offers: [] }],
  ...over,
});

test('dados page: only http(s) links survive, wherever a URL comes from', async () => {
  for (const hash of ['', '#tarifarios', '#promos', '#ofertas', '#operadores', '#notas']) {
    const p = await load({ hash, answer: () => ok(dump()) });
    const hrefs = [...p.app().matchAll(/href="([^"]*)"/g)].map(m => m[1]);
    assert.ok(hrefs.every(h => /^https?:\/\//.test(h)), `${hash}: ${hrefs}`);
    assert.doesNotMatch(p.app(), /javascript:/i, hash);
  }
  const p = await load({ hash: '#promos', answer: () => ok(dump()) });
  assert.match(p.app(), /href="https:\/\/ceme\.example\/promo\?a=1&amp;b=2"/);
  assert.match(p.app(), />P1</, 'the name stays, as plain text');
});

test('dados page: values are escaped, quotes included', async () => {
  const t = (await load({ hash: '#tarifarios', answer: () => ok(dump()) })).app();
  assert.doesNotMatch(t, /<img id=legacy>/);
  assert.match(t, /d&#39;Ávila/);
  const pr = (await load({ hash: '#promos', answer: () => ok(dump()) })).app();
  assert.doesNotMatch(pr, /<img id=(pct|free)>/);

  const answer = url => ok(String(url).startsWith('/dados/postos') ? [{ city: 'L', address: 'A', code: 'C', points: [{ id: 'x', kw: '<img id=kw>', connector: 'T2', regime: 'mobie', offers: [] }] }] : dump());
  const p = await load({ hash: '#operadores', answer });
  await p.open('K');
  assert.doesNotMatch(p.app(), /<img id=kw>/);
  assert.match(p.app(), /&lt;img id=kw&gt;/);
});

test('dados page: a hash naming something inherited falls back to the summary', async () => {
  for (const hash of ['#constructor', '#toString', '#__proto__']) {
    const p = await load({ hash, answer: () => ok(dump()) });
    assert.match(p.app(), /De onde vem cada coisa/, hash);
    assert.match(p.meta(), /ohmigo 1\.0\.0/, hash);
  }
});

test('dados page: a failed load says so in plain words, and never as a raw error', async () => {
  const cases = [
    () => fail(500),
    () => { throw new TypeError('Failed to fetch'); },
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    () => ok({ error: 'not the shape the page expects' }),
  ];
  for (const answer of cases) {
    const m = (await load({ answer })).meta();
    assert.match(m, /Não foi possível carregar os dados/);
    assert.doesNotMatch(m, /A carregar|TypeError|fetch|token|undefined/);
  }
});

test('dados page: a failed operator load replaces "A carregar…", and closing and reopening retries', async () => {
  let answers = [() => fail(500), () => { throw new TypeError('Failed to fetch'); }];
  const answer = url => (String(url).startsWith('/dados/postos') ? answers.shift()() : ok(dump()));
  const p = await load({ hash: '#operadores', answer });
  for (let i = 0; i < 2; i++) {
    await p.open('K');
    assert.match(p.app(), /Não foi possível carregar os postos/);
    assert.doesNotMatch(p.app(), /A carregar|Failed to fetch/);
    await p.open('K'); // close
  }
  answers = [() => ok([])];
  await p.open('K');
  assert.doesNotMatch(p.app(), /Não foi possível/);
});

test('dados page: an old copy of the ceme-v2 data says so', async () => {
  const old = dump({ staleSince: '2026-10-31T10:00:00.000Z' });
  assert.match((await load({ answer: () => ok(old) })).app(), /Dados do ceme-v2 de 2026-10-31T10:00:00.000Z/);
  assert.doesNotMatch((await load({ answer: () => ok(dump()) })).app(), /Dados do ceme-v2 de/);
});

test('dados page: with ceme-v2 out, the page says so in Portuguese without quoting the server', async () => {
  const partial = dump({ ceme: { error: 'unavailable' }, promos: { error: 'unavailable' } });
  for (const hash of ['', '#tarifarios', '#promos']) {
    const a = (await load({ hash, answer: () => ok(partial) })).app();
    assert.match(a, /ceme-v2 indisponível de momento\./, hash);
    assert.doesNotMatch(a, /unavailable/, hash);
  }
  // The summary's cards have their own mark for a count it doesn't have.
  assert.equal((await load({ answer: () => ok(partial) })).app().match(/<span class=err>erro<\/span>/g).length, 2);
});

// A fetch the test answers by hand, to control the order of the answers.
function deferred() {
  const pending = [];
  const answer = url => (String(url).startsWith('/dados/postos') ? new Promise(resolve => pending.push(resolve)) : ok(dump()));
  return { answer, pending };
}
const site = city => ({ city, address: 'A', code: 'C', points: [{ id: 'x', kw: 50, connector: 'T2', regime: 'mobie', offers: [] }] });

test('dados page: closing an operator mid-load keeps it closed when the answer arrives', async () => {
  const { answer, pending } = deferred();
  const p = await load({ hash: '#operadores', answer });
  await p.open('K');
  assert.match(p.app(), /A carregar/);
  await p.open('K'); // close
  pending[0](ok([site('Late')]));
  await tick();
  assert.doesNotMatch(p.app(), /Late|A carregar/);
  assert.match(p.app(), />postos</);
});

test('dados page: after close and reopen, only the latest request can answer', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const { answer, pending } = deferred();
    const p = await load({ hash: '#operadores', answer });
    await p.open('K');
    await p.open('K');
    await p.open('K');
    assert.equal(pending.length, 2);
    const answers = [() => pending[0](fail(500)), () => pending[1](ok([site('Latest')]))];
    for (const i of order) { answers[i](); await tick(); }
    assert.match(p.app(), /Latest/, `order ${order}`);
    assert.doesNotMatch(p.app(), /Não foi possível|A carregar/, `order ${order}`);
  }
});

test('dados page: chargers that fail to render show the message, not "A carregar…"', async () => {
  const answer = url => ok(String(url).startsWith('/dados/postos') ? [{ city: 'L' }] : dump());
  const p = await load({ hash: '#operadores', answer });
  await p.open('K');
  assert.match(p.app(), /Não foi possível carregar os postos/);
  assert.doesNotMatch(p.app(), /A carregar/);
});
