// The landing, privacy and support pages, rendered on the server in each
// language.
//
// site/index.html carries every sentence in both languages (its #strings
// block) and empty elements tagged data-i="key". Filling them in the browser
// works for people, but search engines and AI crawlers read the HTML as sent:
// many don't run scripts, and the ones that do crawl with an English browser,
// so they saw an empty page or the English one. So here, once at boot, each
// language gets its own copy with the text in place and its own URL:
//   /    Portuguese (the audience)
//   /en  English
// plus the tags that tell search engines what the page is: canonical URL,
// the other language (hreflang), Open Graph for link previews, and JSON-LD.
//
// site/legal.html works the same way for the privacy and support pages, one
// source for four URLs. There the strings block stays behind: with the text in
// place a browser has nothing left to do, so those pages send no script.

import { readFileSync } from 'node:fs';

export const SITE_URL = (process.env.SITE_URL || 'https://ohmigo.ocarroeletrico.com').replace(/\/$/, '');
export const PATHS = { pt: '/', en: '/en' };
const LOCALE = { pt: 'pt_PT', en: 'en_GB' };
const HTML_LANG = { pt: 'pt-PT', en: 'en' };

const source = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const S = JSON.parse(source.match(/<script type="application\/json" id="strings">([\s\S]*?)<\/script>/)[1]);

// Each legal page's sections, in order: [heading key, then paragraph keys].
// An array of keys is a bulleted list; 'CTA' is the row of contact buttons.
export const LEGAL = {
  privacy: {
    paths: { pt: '/privacidade', en: '/privacy' },
    sections: [
      ['p1.h', 'p1.p'],
      ['p2.h', 'p2.p1', 'p2.p2', 'p2.p3'],
      ['p3.h', ['p3.li1', 'p3.li2', 'p3.li3'], 'p3.p'],
      ['p4.h', 'p4.p1', 'p4.p2', 'p4.p3'],
      ['p5.h', 'p5.p'],
      ['p6.h', 'p6.p', 'p6.updated'],
    ],
  },
  support: {
    paths: { pt: '/suporte', en: '/support' },
    sections: [
      ['s1.h', 's1.p1', 'CTA'],
      ['s2.h', ['s2.li1', 's2.li2', 's2.li3', 's2.li4']],
      ['s3.h', ['s3.li1', 's3.li2', 's3.li3', 's3.li4']],
      ['s4.h', 's4.p'],
    ],
  },
};
const NEW_TAB = 'target="_blank" rel="noopener"';
export const CTA = [
  { key: 's1.cta1', attrs: `href="https://github.com/CarregaErvilhas/ohmigo-mcp/issues" ${NEW_TAB}` },
  { key: 's1.cta2', attrs: 'class="sec" href="mailto:info@ocarroeletrico.com"' },
  { key: 's1.cta3', attrs: `class="sec" href="https://m.me/OCarroEletricoDotCom" ${NEW_TAB}` },
];

const legalSource = readFileSync(new URL('../site/legal.html', import.meta.url), 'utf8');
const L = JSON.parse(legalSource.match(/<script type="application\/json" id="strings">([\s\S]*?)<\/script>/)[1]);

const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Strings may hold markup (<span class="hl">); <title> and meta want text.
const text = s => String(s).replace(/<[^>]+>/g, '');

// hreflang value -> URL for a page that exists in both languages. x-default
// is what a reader in neither language gets: the Portuguese page.
const alternates = paths => [
  ...Object.entries(paths).map(([l, p]) => [HTML_LANG[l], SITE_URL + p]),
  ['x-default', SITE_URL + paths.pt],
];

// The tags every page shares. Title and description arrive as plain text.
function seo(lang, paths, title, desc) {
  const url = SITE_URL + paths[lang];
  return [
    `<link rel="canonical" href="${url}">`,
    ...alternates(paths).map(([l, u]) => `<link rel="alternate" hreflang="${l}" href="${u}">`),
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="ohmigo">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${attr(title)}">`,
    `<meta property="og:description" content="${attr(desc)}">`,
    `<meta property="og:locale" content="${LOCALE[lang]}">`,
    `<meta property="og:image" content="${SITE_URL}/og.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ];
}

function head(lang) {
  const t = S[lang], url = SITE_URL + PATHS[lang];
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'ohmigo',
    url,
    description: text(t['meta.desc']),
    inLanguage: HTML_LANG[lang],
    applicationCategory: 'TravelApplication',
    operatingSystem: 'Any',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    areaServed: { '@type': 'Country', name: 'Portugal' },
    publisher: { '@type': 'Organization', name: 'O Carro Elétrico', url: 'https://ocarroeletrico.com' },
  };
  return [
    ...seo(lang, PATHS, text(t['meta.title']), text(t['meta.desc'])),
    // JSON in a script tag: "<" escaped so no string can close it.
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].join('\n');
}

// A reader of the English copy stays in English when following a link. These
// URLs don't detect a language, so each link has to name the right page.
const englishLegalLinks = html => html
  .replaceAll('href="/privacidade"', `href="${LEGAL.privacy.paths.en}"`)
  .replaceAll('href="/suporte"', `href="${LEGAL.support.paths.en}"`);

export function render(lang) {
  const t = S[lang];
  const html = source
    .replace(/<html lang="[^"]*">/, `<html lang="${HTML_LANG[lang]}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(text(t['meta.title']))}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr(text(t['meta.desc']))}">`)
    .replace(/<!-- seo:[^>]*-->/, head(lang))
    // Every data-i element is empty in the source (test/site.test.js).
    .replace(/(<(\w+)\b[^>]*\bdata-i="([^"]+)"[^>]*>)(<\/\2>)/g, (m, open, tag, key, close) => open + (t[key] ?? '') + close)
    .replace(/ aria-current="page"/g, '')
    .replace(`data-lang="${lang}"`, `data-lang="${lang}" aria-current="page"`);
  return lang === 'en' ? englishLegalLinks(html) : html;
}

function section([h, ...rest], t) {
  const inner = rest.map(k => {
    if (Array.isArray(k)) return `<ul>${k.map(x => `<li>${t[x]}</li>`).join('')}</ul>`;
    if (k === 'CTA') return `<div class="cta">${CTA.map(c => `<a ${c.attrs}>${t[c.key]}</a>`).join('')}</div>`;
    return `<p>${t[k]}</p>`;
  }).join('');
  return `<article><h2>${t[h]}</h2>${inner}</article>`;
}

export function renderLegal(page, lang) {
  const t = L[lang], { paths, sections } = LEGAL[page];
  const title = text(t[`${page}.title`]), desc = text(t[`${page}.desc`]);
  const html = legalSource
    .replace(/<!-- strings:[\s\S]*?<\/script>\n/, '')
    .replace(/<html lang="[^"]*">/, `<html lang="${HTML_LANG[lang]}">`)
    .replace(/<title>[^<]*<\/title>/, () => `<title>${attr(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${attr(desc)}">`)
    .replace(/<!-- seo:[^>]*-->/, () => seo(lang, paths, title, desc).join('\n'))
    .replace('<h1 id="h1"></h1>', () => `<h1 id="h1">${t[`${page}.h1`]}</h1>`)
    .replace('<p class="lede" id="lede"></p>', () => `<p class="lede" id="lede">${t[`${page}.lede`]}</p>`)
    .replace('<div id="body"></div>', () => `<div id="body">${sections.map(s => section(s, t)).join('')}</div>`)
    .replace(/(<(\w+)\b[^>]*\bdata-i="([^"]+)"[^>]*>)(<\/\2>)/g, (m, open, tag, key, close) => open + (t[key] ?? '') + close);
  const linked = lang === 'en' ? englishLegalLinks(html) : html;
  // These pages have no script to save a language choice, so the way home
  // carries it and the landing page's script saves it (site/index.html).
  const home = `${PATHS[lang]}?lang=${lang}`;
  // Plain links, one per language: the page itself and its twin.
  return linked.replaceAll('href="/"', `href="${home}"`).replaceAll('href="/#', `href="${home}#`).replace(/<a href="" data-lang="(\w+)"/g, (m, l) =>
    `<a href="${paths[l]}" data-lang="${l}"${l === lang ? ' aria-current="page"' : ''}`);
}

export const PAGES = { pt: Buffer.from(render('pt')), en: Buffer.from(render('en')) };

// URL -> its HTML: one copy per URL, rendered once at boot.
export const LEGAL_PAGES = Object.fromEntries(Object.entries(LEGAL).flatMap(([page, { paths }]) =>
  Object.entries(paths).map(([lang, path]) => [path, Buffer.from(renderLegal(page, lang))])));

// Every page worth indexing, each with its other language.
const sitemapEntry = (path, paths) =>
  `  <url><loc>${SITE_URL + path}</loc>${alternates(paths).map(([l, u]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${u}"/>`).join('')}</url>`;

export const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[PATHS, ...Object.values(LEGAL).map(p => p.paths)].flatMap(paths => Object.values(paths).map(p => sitemapEntry(p, paths))).join('\n')}
</urlset>
`;
