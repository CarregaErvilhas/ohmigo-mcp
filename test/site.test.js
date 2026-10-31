// The landing page carries its own strings (site/index.html, the #strings
// block). Every sentence exists in both languages, and every data-i key the
// markup uses has a string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('site: the skip link comes first and lands on <main>', () => {
  assert.match(html, /<body>\s*<a class="skip" href="#top" data-i="a11y\.skip"><\/a>/);
  assert.match(html, /<main id="top" tabindex="-1">/);
});

test('site: the top links are a named <nav>', () => {
  assert.match(html.match(/<header>[\s\S]*<\/header>/)[0], /<nav [^>]*data-aria="a11y\.nav">[\s\S]*data-lang="en"[\s\S]*<\/nav>/);
});

test('site: every inline SVG is hidden from screen readers or has a name', () => {
  for (const [tag] of html.matchAll(/<svg\b[^>]*>/g)) assert.match(tag, /aria-hidden="true"|aria-label=|data-aria=/, tag);
});

test('site: focus is visible', () => {
  assert.match(html, /:focus-visible \{ outline: 3px solid/);
  assert.doesNotMatch(html.replace('main:focus { outline: none; }', ''), /outline: (none|0)/);
});

test('site: the link preview image stays small and keeps the size the head declares', () => {
  const png = readFileSync(new URL('../site/og.png', import.meta.url));
  assert.ok(png.length < 100 * 1024, `${png.length} bytes`);
  // Width and height sit at fixed offsets in a PNG (its IHDR chunk).
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
});

test('site: every data-i key has a string', () => {
  const used = new Set([...html.matchAll(/data-i="([^"]+)"/g)].map(m => m[1]));
  for (const k of used) assert.ok(k in S.pt, `missing ${k}`);
});

// Privacy and support live in one file (site/legal.html): the script picks the
// page from the path, and the strings block has both pages in both languages.
const legal = readFileSync(new URL('../site/legal.html', import.meta.url), 'utf8');
const L = JSON.parse(legal.match(/<script type="application\/json" id="strings">([\s\S]*?)<\/script>/)[1]);

test('legal: en and pt have the same keys', () => {
  assert.deepEqual(Object.keys(L.pt).sort(), Object.keys(L.en).sort());
});

test('legal: every key the markup and the page lists use has a string', () => {
  const used = new Set([...legal.matchAll(/data-i="([^"]+)"/g)].map(m => m[1]));
  // The PAGES table in the script: every quoted key like 'p2.h' or 's3.li1'.
  const table = legal.match(/const PAGES = \{([\s\S]*?)\n  \};/)[1];
  for (const m of table.matchAll(/'([ps]\d\.[a-z0-9]+)'/g)) used.add(m[1]);
  for (const page of ['privacy', 'support']) for (const f of ['title', 'desc', 'h1', 'lede']) used.add(`${page}.${f}`);
  for (const k of used) assert.ok(k in L.pt, `missing ${k}`);
});

test('legal: every string is used', () => {
  const body = legal.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '');
  for (const k of Object.keys(L.pt)) {
    // CTA texts are built as t['s1.cta1']; everything else appears as a quoted key.
    assert.ok(body.includes(`'${k}'`) || body.includes(`"${k}"`) || /^(privacy|support)\./.test(k), `unused ${k}`);
  }
});
