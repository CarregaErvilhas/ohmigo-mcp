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

test('site: every data-i key has a string', () => {
  const used = new Set([...html.matchAll(/data-i="([^"]+)"/g)].map(m => m[1]));
  for (const k of used) assert.ok(k in S.pt, `missing ${k}`);
});

// Privacy, support and terms live in one file (site/legal.html): the script picks the
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
  for (const m of table.matchAll(/'([pst]\d\.[a-z0-9]+)'/g)) used.add(m[1]);
  for (const page of ['privacy', 'support', 'terms']) for (const f of ['title', 'desc', 'h1', 'lede']) used.add(`${page}.${f}`);
  for (const k of used) assert.ok(k in L.pt, `missing ${k}`);
});

test('legal: every string is used', () => {
  const body = legal.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '');
  for (const k of Object.keys(L.pt)) {
    // CTA texts are built as t['s1.cta1']; everything else appears as a quoted key.
    assert.ok(body.includes(`'${k}'`) || body.includes(`"${k}"`) || /^(privacy|support|terms)\./.test(k), `unused ${k}`);
  }
});
