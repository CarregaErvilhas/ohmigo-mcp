// The landing page carries its own strings (site/index.html, the #strings
// block), and so do the privacy and support pages. Every sentence exists in both languages, and every data-i key the
// markup uses has a string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CTA, LEGAL, LEGAL_PAGES, PAGES, SITEMAP } from '../src/site.js';

const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const S = JSON.parse(html.match(/<script type="application\/json" id="strings">([\s\S]*?)<\/script>/)[1]);

test('site: en and pt have the same keys', () => {
  assert.deepEqual(Object.keys(S.pt).sort(), Object.keys(S.en).sort());
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
    assert.doesNotMatch(h, /<script/, 'nothing left for a script to do');
    assert.doesNotMatch(h, /data-i="[^"]+"><\//, 'no element left empty');
    assert.doesNotMatch(h, /<!-- /, 'no source comment sent');
  });

  test(`legal ${path}: links stay in the language, the buttons go to the other URL`, () => {
    const h = LEGAL_PAGES[path].toString();
    assert.match(h, new RegExp(`<a href="${path}" data-lang="${lang}"[^>]* aria-current="page"`));
    assert.match(h, new RegExp(`<a href="${twin}" data-lang="${lang === 'pt' ? 'en' : 'pt'}"`));
    const footer = h.match(/<footer>[\s\S]*<\/footer>/)[0];
    const [home, privacy, support] = lang === 'pt' ? ['/', '/privacidade', '/suporte'] : ['/en', '/privacy', '/support'];
    for (const href of [home, privacy, support]) assert.ok(footer.includes(`href="${href}"`), href);
  });
}

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
