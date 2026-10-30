// The landing page, rendered on the server in each language.
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

import { readFileSync } from 'node:fs';

export const SITE_URL = (process.env.SITE_URL || 'https://ohmigo.ocarroeletrico.com').replace(/\/$/, '');
export const PATHS = { pt: '/', en: '/en' };
const LOCALE = { pt: 'pt_PT', en: 'en_GB' };
const HTML_LANG = { pt: 'pt-PT', en: 'en' };

const source = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const S = JSON.parse(source.match(/<script type="application\/json" id="strings">([\s\S]*?)<\/script>/)[1]);

const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Strings may hold markup (<span class="hl">); <title> and meta want text.
const text = s => String(s).replace(/<[^>]+>/g, '');

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
    `<link rel="canonical" href="${url}">`,
    ...Object.entries(PATHS).map(([l, p]) => `<link rel="alternate" hreflang="${HTML_LANG[l]}" href="${SITE_URL + p}">`),
    `<link rel="alternate" hreflang="x-default" href="${SITE_URL}/">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="ohmigo">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${attr(text(t['meta.title']))}">`,
    `<meta property="og:description" content="${attr(text(t['meta.desc']))}">`,
    `<meta property="og:locale" content="${LOCALE[lang]}">`,
    `<meta property="og:image" content="${SITE_URL}/og.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    // JSON in a script tag: "<" escaped so no string can close it.
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].join('\n');
}

export function render(lang) {
  const t = S[lang];
  return source
    .replace(/<html lang="[^"]*">/, `<html lang="${HTML_LANG[lang]}">`)
    .replace(/<title>[^<]*<\/title>/, `<title>${attr(text(t['meta.title']))}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attr(text(t['meta.desc']))}">`)
    .replace(/<!-- seo:[^>]*-->/, head(lang))
    // Every data-i element is empty in the source (test/site.test.js).
    .replace(/(<(\w+)\b[^>]*\bdata-i="([^"]+)"[^>]*>)(<\/\2>)/g, (m, open, tag, key, close) => open + (t[key] ?? '') + close)
    .replace(/ aria-current="page"/g, '')
    .replace(`data-lang="${lang}"`, `data-lang="${lang}" aria-current="page"`);
}

export const PAGES = { pt: Buffer.from(render('pt')), en: Buffer.from(render('en')) };

// Every page worth indexing. The privacy and support pages exist under a
// Portuguese and an English path (site/legal.html picks the language).
export const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${Object.values(PATHS).map(p => `  <url><loc>${SITE_URL + p}</loc>${Object.entries(PATHS).map(([l, q]) => `<xhtml:link rel="alternate" hreflang="${HTML_LANG[l]}" href="${SITE_URL + q}"/>`).join('')}</url>`).join('\n')}
${['/privacidade', '/privacy', '/suporte', '/support'].map(p => `  <url><loc>${SITE_URL + p}</loc></url>`).join('\n')}
</urlset>
`;
