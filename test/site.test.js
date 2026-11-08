// The landing page carries its own strings (site/index.html, the #strings
// block), and so do the privacy and support pages. Every sentence exists in both languages, and every data-i key the
// markup uses has a string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CTA, LEGAL, LEGAL_PAGES, PAGES, SITEMAP, THEME_SCRIPT } from '../src/site.js';

const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const S = JSON.parse(html.match(/<script type="application\/json" id="strings">([\s\S]*?)<\/script>/)[1]);

test('site: en and pt have the same keys', () => {
  assert.deepEqual(Object.keys(S.pt).sort(), Object.keys(S.en).sort());
});

test('site: every screen reader label has a string in both languages', () => {
  const used = [...html.matchAll(/data-aria="([^"]+)"/g)].map(m => m[1]);
  assert.ok(used.length >= 1);
  for (const k of used) for (const l of ['pt', 'en']) assert.ok(S[l][k], `missing ${l} ${k}`);
});

test('site: the skip link comes first and lands on the <h1>', () => {
  assert.match(html, /<body>\s*<a class="skip" href="#conteudo" data-i="a11y\.skip"><\/a>/);
  assert.match(html, /<h1 id="conteudo" tabindex="-1"/);
});

test('site: the top links are a named <nav>', () => {
  assert.match(html.match(/<header>[\s\S]*<\/header>/)[0], /<nav [^>]*data-aria="a11y\.nav">[\s\S]*data-lang="en"[\s\S]*<\/nav>/);
});

test('site: every inline SVG is hidden from screen readers or has a name', () => {
  for (const [tag] of html.matchAll(/<svg\b[^>]*>/g)) assert.match(tag, /aria-hidden="true"|aria-label=|data-aria=/, tag);
});

test('site: focus is visible', () => {
  assert.match(html, /:focus-visible \{ outline: 3px solid/);
  assert.doesNotMatch(html, /outline: (none|0)/);
});

test('site: the link preview image stays small and keeps the size the head declares', () => {
  const png = readFileSync(new URL('../site/og.png', import.meta.url));
  assert.ok(png.length < 100 * 1024, `${png.length} bytes`);
  // Width and height sit at fixed offsets in a PNG (its IHDR chunk).
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
});

test('site: llms.txt follows SITE_URL, as the sitemap does', () => {
  const code = "const { LLMS_TXT } = await import('./src/site.js'); process.stdout.write(LLMS_TXT);";
  const txt = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, SITE_URL: 'https://staging.example/' }, encoding: 'utf8',
  });
  assert.match(txt, /https:\/\/staging\.example\/mcp\n/);
  assert.doesNotMatch(txt, /ohmigo\.ocarroeletrico\.com/);
});

test('site: every hero topic button has its question, answer and source in both languages', () => {
  const topics = [...html.matchAll(/data-topic="([^"]+)"/g)].map(m => m[1]);
  assert.ok(topics.length >= 2);
  for (const t of topics) for (const part of ['label', 'q', 'a', 'src']) for (const l of ['pt', 'en']) {
    assert.ok(S[l][`topic.${t}.${part}`], `missing ${l} topic.${t}.${part}`);
  }
});

// The script in <head>, run against a fake browser: what it does to <html>
// before the first paint, for what is saved.
function headScript(saved, { throws = false, vision = null } = {}) {
  const code = html.match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>/)[1];
  const root = { dataset: {}, classes: new Set(), classList: { add: c => root.classes.add(c) } };
  runInNewContext(code, {
    document: { documentElement: root },
    localStorage: { getItem: k => { if (throws) throw new Error('blocked'); return k === 'ohmigo.vision' ? vision : saved; } },
  });
  return { theme: root.dataset.theme ?? null, js: root.classes.has('js'), vision: root.dataset.vision ?? null };
}

test('site: a theme picked before applies before the first paint, and nothing else does', () => {
  assert.deepEqual(headScript('dark'), { theme: 'dark', js: true, vision: null });
  assert.deepEqual(headScript('light'), { theme: 'light', js: true, vision: null });
  // Nothing saved, or something we never wrote: the system decides (the CSS).
  assert.deepEqual(headScript(null), { theme: null, js: true, vision: null });
  assert.deepEqual(headScript('sepia'), { theme: null, js: true, vision: null });
  // Storage blocked (private mode, cookies off): the page still loads.
  assert.deepEqual(headScript('dark', { throws: true }), { theme: null, js: true, vision: null });
});

test('site: a saved vision mode applies before the first paint; anything else is ignored', () => {
  assert.equal(headScript(null, { vision: 'cb' }).vision, 'cb');
  assert.equal(headScript('dark', { vision: 'hc' }).vision, 'hc');
  assert.equal(headScript(null, { vision: 'rainbow' }).vision, null);
});

test('site: the vision palettes are the same block on the landing and legal pages, with strings for every mode', () => {
  const block = h => h.match(/\/\* vision: start[\s\S]*?\/\* vision: end \*\//)?.[0];
  assert.ok(block(html), 'landing page has the vision block');
  assert.equal(block(html), block(readFileSync(new URL('../site/legal.html', import.meta.url), 'utf8')));
  for (const l of ['pt', 'en']) for (const m of ['off', 'cb', 'hc']) {
    assert.ok(S[l][`vision.${m}`] && S[l][`vision.toast.${m}`], `missing ${l} vision.${m}`);
  }
});

test('site: every data-i key has a string', () => {
  const used = new Set([...html.matchAll(/data-i="([^"]+)"/g)].map(m => m[1]));
  for (const k of used) assert.ok(k in S.pt, `missing ${k}`);
});

// Privacy and support share one source (site/legal.html, its #strings block);
// src/site.js says which strings make up each page and renders every URL.
const legal = readFileSync(new URL('../site/legal.html', import.meta.url), 'utf8');
const L = JSON.parse(legal.match(/<script type="application\/json" id="strings">([\s\S]*?)<\/script>/)[1]);
const pageKeys = Object.values(LEGAL).flatMap(p => p.sections.flat(2)).filter(k => k !== 'CTA');
const legalKeys = new Set([
  ...pageKeys,
  ...CTA.map(c => c.key),
  ...[...legal.matchAll(/data-i="([^"]+)"/g)].map(m => m[1]),
  ...Object.keys(LEGAL).flatMap(page => ['title', 'desc', 'h1', 'lede'].map(f => `${page}.${f}`)),
]);

test('legal: en and pt have the same keys', () => {
  assert.deepEqual(Object.keys(L.pt).sort(), Object.keys(L.en).sort());
});

test('legal: every key the markup and the page lists use has a string', () => {
  for (const k of legalKeys) assert.ok(k in L.pt, `missing ${k}`);
});

test('legal: every string is used', () => {
  for (const k of Object.keys(L.pt)) assert.ok(legalKeys.has(k), `unused ${k}`);
});

const ORIGIN = 'https://ohmigo.ocarroeletrico.com';
const URLS = [
  { path: '/privacidade', twin: '/privacy', page: 'privacy', lang: 'pt', html: 'pt-PT', locale: 'pt_PT' },
  { path: '/privacy', twin: '/privacidade', page: 'privacy', lang: 'en', html: 'en', locale: 'en_GB' },
  { path: '/suporte', twin: '/support', page: 'support', lang: 'pt', html: 'pt-PT', locale: 'pt_PT' },
  { path: '/support', twin: '/suporte', page: 'support', lang: 'en', html: 'en', locale: 'en_GB' },
];
// The text a reader or a crawler gets: the rendered markup, without tags.
const visible = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const plain = s => visible(s).trim();

for (const { path, twin, page, lang, html, locale } of URLS) {
  test(`legal ${path}: head says what the URL is`, () => {
    const h = LEGAL_PAGES[path].toString();
    const t = L[lang];
    assert.ok(h.includes(`<html lang="${html}">`), 'lang');
    assert.ok(h.includes(`<title>${t[`${page}.title`]}</title>`), 'title');
    assert.ok(h.includes(`<meta name="description" content="${t[`${page}.desc`]}">`), 'description');
    assert.ok(h.includes(`<link rel="canonical" href="${ORIGIN}${path}">`), 'canonical');
    const ptPath = lang === 'pt' ? path : twin, enPath = lang === 'en' ? path : twin;
    assert.ok(h.includes(`<link rel="alternate" hreflang="pt-PT" href="${ORIGIN}${ptPath}">`), 'hreflang pt');
    assert.ok(h.includes(`<link rel="alternate" hreflang="en" href="${ORIGIN}${enPath}">`), 'hreflang en');
    assert.ok(h.includes(`<link rel="alternate" hreflang="x-default" href="${ORIGIN}${ptPath}">`), 'x-default on the pt URL');
    assert.equal([...h.matchAll(/rel="alternate"/g)].length, 3);
    assert.ok(h.includes(`<meta property="og:url" content="${ORIGIN}${path}">`), 'og:url');
    assert.ok(h.includes(`<meta property="og:title" content="${t[`${page}.title`]}">`), 'og:title');
    assert.ok(h.includes(`<meta property="og:description" content="${t[`${page}.desc`]}">`), 'og:description');
    assert.ok(h.includes(`<meta property="og:locale" content="${locale}">`), 'og:locale');
    assert.ok(h.includes(`<meta property="og:image" content="${ORIGIN}/og.png">`), 'og:image');
    assert.ok(h.includes('<meta name="twitter:card" content="summary_large_image">'), 'twitter:card');
  });

  test(`legal ${path}: the content is in the HTML, in one language`, () => {
    const h = LEGAL_PAGES[path].toString();
    const text = visible(h);
    const t = L[lang], other = L[lang === 'pt' ? 'en' : 'pt'];
    assert.ok(h.includes(`>${t[`${page}.h1`]}</h1>`), 'h1');
    assert.ok(text.includes(t[`${page}.lede`]), 'lede');
    for (const k of LEGAL[page].sections.flat(2)) {
      if (k === 'CTA') continue;
      assert.ok(text.includes(plain(t[k])), `${k} in place`);
      if (t[k] !== other[k]) assert.ok(!text.includes(plain(other[k])), `${k} of the other language`);
    }
    // The theme script and nothing else: the text is already in place.
    assert.deepEqual(h.match(/<script\b[^>]*>[\s\S]*?<\/script>/g), [THEME_SCRIPT], 'only the theme script');
    assert.ok(h.indexOf(THEME_SCRIPT) < h.indexOf('<style>'), 'the theme script runs before the page is styled');
    assert.doesNotMatch(h, /data-i="[^"]+"><\//, 'no element left empty');
    assert.doesNotMatch(h, /<!-- /, 'no source comment sent');
  });

  test(`legal ${path}: links stay in the language, the buttons go to the other URL`, () => {
    const h = LEGAL_PAGES[path].toString();
    assert.match(h, new RegExp(`<a href="${path}" data-lang="${lang}"[^>]* aria-current="page"`));
    assert.match(h, new RegExp(`<a href="${twin}" data-lang="${lang === 'pt' ? 'en' : 'pt'}"`));
    const footer = h.match(/<footer>[\s\S]*<\/footer>/)[0];
    const [home, privacy, support] = lang === 'pt' ? ['/?lang=pt', '/privacidade', '/suporte'] : ['/en?lang=en', '/privacy', '/support'];
    for (const href of [home, privacy, support]) assert.ok(footer.includes(`href="${href}"`), href);
  });
}

// The start of the landing page's script, run against a fake browser: which
// page a visitor ends up on, and what is left saved.
function landing(path, saved) {
  const code = html.match(/const store = \{[\s\S]*?(?=  for \(const a of document\.querySelectorAll\('\[data-lang\]'\))/)[0];
  const url = new URL(path, 'https://x');
  const stored = new Map(saved ? [['ohmigo.lang', saved]] : []);
  const replaced = [];
  runInNewContext(code, {
    URLSearchParams,
    document: { documentElement: { lang: url.pathname === '/en' ? 'en' : 'pt-PT' } },
    location: { search: url.search, hash: url.hash, replace: to => replaced.push(to) },
    localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) },
  });
  return { to: replaced[0] ?? null, saved: stored.get('ohmigo.lang') ?? null };
}

test('landing: an earlier pick of English still redirects a plain /', () => {
  assert.deepEqual(landing('/', 'en'), { to: '/en', saved: 'en' });
  assert.deepEqual(landing('/', null), { to: null, saved: null });
  assert.deepEqual(landing('/', 'pt'), { to: null, saved: 'pt' });
});

test('landing: a link home from a legal page wins over the saved language, and replaces it', () => {
  assert.deepEqual(landing('/?lang=pt', 'en'), { to: null, saved: 'pt' });
  assert.deepEqual(landing('/en?lang=en', 'pt'), { to: null, saved: 'en' });
  // After that, a plain / stays where the reader chose.
  assert.equal(landing('/', landing('/?lang=pt', 'en').saved).to, null);
});

test('landing: the footer links to the pages in its own language', () => {
  assert.ok(PAGES.pt.toString().includes('href="/privacidade"'));
  const en = PAGES.en.toString();
  assert.ok(en.includes('href="/privacy"') && en.includes('href="/support"'));
  assert.ok(!en.includes('href="/privacidade"') && !en.includes('href="/suporte"'));
});

test('sitemap: every legal URL lists both languages', () => {
  for (const { path, twin, lang } of URLS) {
    const ptPath = lang === 'pt' ? path : twin, enPath = lang === 'en' ? path : twin;
    const entry = SITEMAP.match(new RegExp(`<url><loc>${ORIGIN}${path}</loc>.*</url>`))?.[0] ?? '';
    assert.ok(entry.includes(`hreflang="pt-PT" href="${ORIGIN}${ptPath}"`), `${path} pt`);
    assert.ok(entry.includes(`hreflang="en" href="${ORIGIN}${enPath}"`), `${path} en`);
    assert.ok(entry.includes(`hreflang="x-default" href="${ORIGIN}${ptPath}"`), `${path} x-default`);
  }
});
