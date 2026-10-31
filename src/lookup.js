// Finding a charger by what people call it.
//
// Nobody knows a charge point's id. People say "the Continente in Leiria",
// "IONITY Mealhada", "the Galp on the A1 at Pombal", or read the code off the
// sticker on the charger ("LRA-00156"). This file turns that text into sites.
//
// Two ways in:
//   - a code: MOBI.E codes look like "LRA-00156" (municipality + number) and
//     show up with or without the operator prefix ("GLP-LRA-00156"), with
//     MOBI.E's own prefix ("MOBI-LRA-00156"), without the leading zeros, or
//     with the socket number ("LRA-00156-02"). All of these find the site.
//     Networks outside MOBI.E use other ids (Tesla publishes UUIDs), which
//     only match whole.
//   - words: every word of the query has to appear in what we know about the
//     site: operator, the brand names in offers/networks.json, the site's
//     name on the NAP ("Auchan Cascais"), OpenStreetMap's
//     name/brand/operator (the `osm` block nap-dashboard adds), town and
//     address. "Continente Leiria" = a site whose words include "continente"
//     AND "leiria". A word matches the start of a site word ("galp" finds
//     "Galpgeste"), and words of 5+ letters forgive one typo.
//
// When no site has every word, the ones with the most words still come back,
// each with the words it lacks in `missing`, so the assistant can say so or
// try again with fewer.

import { readFileSync } from 'node:fs';

export const fold = s => (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const words = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

// Words that say nothing about which charger, in both languages: articles
// and prepositions, "charger", and the kind of place ("the Galp service area
// on the A1": the NAP's address says "(A1) KM 166,7", not "service area").
const FILLER = new Set(`
  a o as os de do da dos das e em no na nos nas ao aos perto junto pe
  posto postos carregador carregadores carregamento estacao ponto tomada
  area servico servicos bomba bombas gasolineira supermercado hipermercado loja estacionamento
  the of in at on near by and charger chargers charging station point
  service services petrol gas supermarket shop
`.trim().split(/\s+/));

// "LRA-00156", "lra 156", "GLP-LRA-00156-02" -> { key: "LRA-156", socket: 2 }.
// Three letters and a number is MOBI.E's pattern (municipality + sequence).
const CODE = /\b([a-z]{3})[- ]?0*(\d{1,5})(?:[-.]0*(\d{1,2}))?\b/g;
export function codesIn(text) {
  const out = [];
  for (const m of fold(text).matchAll(CODE)) out.push({ key: `${m[1].toUpperCase()}-${Number(m[2])}`, socket: m[3] != null ? Number(m[3]) : null });
  return out;
}

// The MOBI.E codes a site goes by: "GLP-MOBI-LSB-00085" -> "LSB-85". Read
// from whole id segments, so a Tesla UUID ("…-fea7-…") never looks like one.
function siteCodes(site) {
  const seg = site.id.split('-');
  const out = new Set();
  for (let i = 0; i < seg.length - 1; i++) {
    if (/^[A-Z]{3}$/.test(seg[i]) && /^\d{3,5}$/.test(seg[i + 1])) out.add(`${seg[i]}-${Number(seg[i + 1])}`);
  }
  return out;
}

// Brand names people use for an operator, from offers/networks.json ("Powerdot"
// for HORZ, "Tesla Supercharger" for TSLA). Data, so no operator lives in code.
function brandNames() {
  const { networks } = JSON.parse(readFileSync(new URL('../offers/networks.json', import.meta.url), 'utf8'));
  const by = new Map();
  for (const [label, n] of Object.entries(networks)) {
    for (const id of n.operatorIds || []) by.set(id, [...(by.get(id) || []), label]);
  }
  return by;
}

// One typo: same length with one letter different, or one letter more or less.
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const hits = (token, ws) => ws.some(w => w === token || (token.length >= 3 && w.startsWith(token))
  || (token.length >= 5 && w.length >= 4 && oneEdit(token, w.length > token.length + 1 ? w.slice(0, token.length) : w)));

// The search index: what each site can be found by. Built once per dataset.
export class Index {
  constructor(sites) {
    const brands = brandNames();
    // Some operators publish part of their sites without a name (Continente's
    // "CNT-0001PL0002" sites have no operator). Their id prefix is shared with
    // the named ones, so a prefix that belongs to one operator lends its name.
    const prefixOp = new Map();
    for (const s of sites) {
      if (!s.operator) continue;
      const p = s.id.split('-')[0];
      const cur = prefixOp.get(p);
      prefixOp.set(p, cur === undefined || (cur && cur.operatorId === s.operatorId) ? { operator: s.operator, operatorId: s.operatorId } : null);
    }
    this.byCode = new Map();
    this.entries = sites.map(site => {
      const op = site.operator ? site : prefixOp.get(site.id.split('-')[0]) || {};
      const fields = {
        operator: words([op.operator, op.operatorId, ...(brands.get(op.operatorId) || [])].join(' ')),
        // The NAP's own name for the site ("Auchan Cascais").
        name: words(site.name),
        osm: words([site.osm?.name, site.osm?.brand, site.osm?.operator].join(' ')),
        city: words(site.city),
        address: words(site.address),
      };
      const exact = new Set([fold(site.id), fold(site.code)]);
      // Point ids too ("LRA-00156-02"), but not the bare numbers some
      // operators use ("19"), which repeat across sites.
      for (const p of site.points) if (p.id.length >= 6) exact.add(fold(p.id));
      for (const key of siteCodes(site)) {
        if (!this.byCode.has(key)) this.byCode.set(key, new Set());
        this.byCode.get(key).add(site);
      }
      return { site, fields, all: Object.values(fields).flat(), exact };
    });
  }

  // [{ site, score, matched: [field...], missing: [word...], socket }]: the
  // best-scoring sites, unsorted (the caller sorts, by distance among others).
  find(query) {
    const q = fold(query);
    // A whole id or code, as published (also Tesla's UUIDs and "0001PL0002").
    const exact = this.entries.filter(e => e.exact.has(q));
    if (exact.length) {
      const socket = codesIn(query)[0]?.socket ?? null;
      return exact.map(e => ({ site: e.site, matched: ['code'], socket, score: Infinity }));
    }
    // A MOBI.E code anywhere in the text ("o posto LRA-00156 em Leiria").
    const codes = codesIn(query).filter(c => this.byCode.has(c.key));
    if (codes.length) {
      return codes.flatMap(c => [...this.byCode.get(c.key)].map(site => ({ site, matched: ['code'], socket: c.socket, score: Infinity })));
    }
    const tokens = [...new Set(words(query).filter(w => !FILLER.has(w)))];
    if (!tokens.length) return [];
    const scored = [];
    for (const e of this.entries) {
      const ok = tokens.filter(tk => hits(tk, e.all));
      if (!ok.length) continue;
      const matched = Object.keys(e.fields).filter(f => ok.some(tk => hits(tk, e.fields[f])));
      scored.push({ site: e.site, matched, score: ok.length, ok });
    }
    const top = Math.max(...scored.map(h => h.score));
    return scored.filter(h => h.score === top)
      .map(({ ok, ...h }) => ({ ...h, missing: tokens.filter(tk => !ok.includes(tk)) }));
  }

  // The town named in the query, if any: the longest run of its words that
  // is some site's town ("santa maria da feira", "vila real", "leiria").
  // Lets "IONITY Mealhada" rank IONITY sites by distance to Mealhada when
  // there's none in Mealhada itself.
  townIn(query) {
    this.towns ??= new Set(this.entries.map(e => e.fields.city.join(' ')).filter(Boolean));
    const ws = words(query);
    for (let n = Math.min(5, ws.length); n > 0; n--) {
      for (let i = 0; i + n <= ws.length; i++) {
        const name = ws.slice(i, i + n).join(' ');
        if (!FILLER.has(name) && this.towns.has(name)) return name;
      }
    }
    return null;
  }
}
