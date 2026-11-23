// Direct offers: the blog parser, the manual overrides, and which offers
// apply at a charger. The fixture is a made-up table in the blog's layout,
// not a copy of the blog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { applyNotices, bandFor, bandPrice, BLOG_HOST, MAX_EUR_PER_KWH, MAX_LABEL_LENGTH, MIN_EUR_PER_KWH, offerProblems, parseTables, pricePosts, toOffers } from '../src/offers-parse.js';
import { activeOn, AUDIENCES, civilDay, gaps, isStale, mergeOffers, NAP_NOTES, noteFor, OFFERS, offersAt, ownWalkUp, perMinuteAt, unpricedMinutes } from '../src/offers.js';

const HEAD = `<thead><tr><th rowspan="2">Operador - Plano</th><th rowspan="2">Postos</th><th colspan="2">AC</th><th colspan="6">DC</th></tr>
<tr><th>&le;7.4</th><th>11..22</th><th>≤50</th><th>100</th><th>120</th><th>150</th><th>180</th><th>&gt;180</th></tr></thead>`;
const FIXTURE = `<p>intro</p>
<table class="evtable"><caption>Preços por kWh — Sem promoções ou subscrições pagas</caption>${HEAD}<tbody>
<tr><td>Acme - TPA</td><td>Acme</td><td></td><td></td><td>0,60</td><td>0,70</td></tr>
<tr><td>Roamy</td><td>Rede Mobi.E</td><td>0,41</td><td>0,42</td><td>0,60</td><td>0,72</td><td>0,72</td><td>0,72</td><td>0,79</td><td>0,79</td></tr>
<tr><td>Somewhere - App</td><td>Alguns Mobi.E</td><td></td><td></td><td>0,5</td></tr>
<tr><td>Newco - QRCode</td><td>Newco</td><td>0,49</td></tr>
</tbody></table>
<table class="evtable"><caption>Preços por kWh — Subscrições pagas</caption>${HEAD}<tbody>
<tr><td>Acme - Plus 8€/mês</td><td>Acme</td><td></td><td></td><td>0,49</td><td>0,49</td><td>0,49</td><td>0,49</td><td>0,49</td><td>0,49</td></tr>
</tbody></table>
<table class="evtable evtable-scale"><tr><th>Preço kWh</th><td>0,30</td></tr></table>`;
const POST = `https://${BLOG_HOST}/2026/10/post.html`;
const NETS = { 'Rede Mobi.E': { scope: 'mobie' }, 'Alguns Mobi.E': { scope: 'unknown' }, Acme: { operatorIds: ['ACME'] } };

test('parser: both tables, bands from the header, short rows, entities', () => {
  const t = parseTables(FIXTURE);
  assert.deepEqual(t.map(x => [x.kind, x.rows.length]), [['payg', 4], ['subscription', 1]]);
  assert.deepEqual(t[0].bands, ['ac7', 'ac22', 'dc50', 'dc100', 'dc120', 'dc150', 'dc180', 'dcMax']);
  assert.deepEqual(t[0].rows[0].prices, { ac7: null, ac22: null, dc50: 0.6, dc100: 0.7, dc120: null, dc150: null, dc180: null, dcMax: null });
});

test('parser: a layout change fails loudly', () => {
  assert.throws(() => parseTables(FIXTURE.replace('<th>120</th>', '<th>125</th>')), /unknown power band "125"/);
  assert.throws(() => parseTables('<p>no tables</p>'), /no price tables/);
});

test('parser: a price cell that is not a number fails loudly; an empty one is "not offered"', () => {
  const withCell = cell => FIXTURE.replace('<td>0,41</td>', `<td>${cell}</td>`);
  for (const cell of ['0,4l', 'n/d', '0,41 €', '-', '0x1', '1,2,3']) {
    assert.throws(() => parseTables(withCell(cell)), /Roamy.*not a number/, cell);
  }
  for (const cell of ['', ' ', '&nbsp;']) assert.equal(parseTables(withCell(cell))[0].rows[1].prices.ac7, null, JSON.stringify(cell));
});

test('toOffers: a price outside the bounds fails loudly, but only on a row that ships', () => {
  const ship = html => toOffers(parseTables(html), NETS, { url: POST, checkedAt: '2026-10-14', origin: 'custofinal' });
  const withPrice = price => FIXTURE.replace('<td>0,41</td>', `<td>${String(price).replace('.', ',')}</td>`);
  for (const price of [MIN_EUR_PER_KWH, MAX_EUR_PER_KWH]) {
    assert.equal(ship(withPrice(price)).offers.find(o => o.id === 'roamy-rede-mobi-e').prices.ac7, price);
  }
  // 41 is 0,41 without its comma; 0,004 is a price in the wrong unit.
  for (const price of [41, 0.004, 0]) assert.throws(() => ship(withPrice(price)), /Roamy.*out of bounds/, String(price));
  // Newco is unmapped and Somewhere is scope "unknown": neither ships, so a
  // typo in them doesn't hold back the rest of the update.
  assert.deepEqual(ship(FIXTURE.replace('<td>0,49</td></tr>\n</tbody>', '<td>49</td></tr>\n</tbody>')).unmapped, ['Newco']);
  assert.deepEqual(ship(FIXTURE.replace('<td>0,5</td>', '<td>50</td>')).skipped, ['Somewhere - App @ Alguns Mobi.E']);
});

test('parser: a row with more cells than bands fails loudly; a short one is fine', () => {
  const extra = FIXTURE.replace('<td>0,79</td><td>0,79</td></tr>', '<td>0,79</td><td>0,79</td><td>0,80</td></tr>');
  assert.throws(() => parseTables(extra), /Roamy.*9 price cells.*8 power bands/);
  assert.equal(parseTables(FIXTURE)[0].rows[3].prices.ac22, null);
});

test('parser: a bad label fails loudly, on rows that would be left out too', () => {
  const withName = name => FIXTURE.replace('<td>Roamy</td>', `<td>${name}</td>`);
  const unsafe = /control or format characters, angle brackets or entities/;
  assert.throws(() => parseTables(withName('R'.repeat(MAX_LABEL_LENGTH + 1))), /too long/);
  assert.equal(parseTables(withName('R'.repeat(MAX_LABEL_LENGTH)))[0].rows[1].name.length, MAX_LABEL_LENGTH);
  // Real tags are stripped; these only appear once the entities are decoded.
  assert.throws(() => parseTables(withName('&lt;script&gt;x')), unsafe);
  assert.throws(() => parseTables(withName('Ro&#27;amy')), unsafe);
  assert.throws(() => parseTables(withName('Ro&#8238;amy')), unsafe, 'a right-to-left override is invisible');
  // decode() knows only a few entities; the rest would be shown as typed.
  assert.throws(() => parseTables(withName('Caf&eacute;')), unsafe);
  assert.throws(() => parseTables(withName('Caf&#xe9;')), unsafe);
  assert.equal(parseTables(withName('A &amp; B; C'))[0].rows[1].name, 'A & B; C');
  // "Newco" isn't in NETS, but its label still ends up in the PR.
  assert.throws(() => parseTables(FIXTURE.replace('<td>Newco</td>', '<td>New&lt;co</td>')), unsafe);
});

test('toOffers: the source must be https on the blog', () => {
  const tables = parseTables(FIXTURE), at = url => toOffers(tables, NETS, { url, checkedAt: '2026-10-14', origin: 'custofinal' });
  assert.equal(at(POST).offers[0].source, POST);
  for (const url of [POST.replace('https:', 'http:'), 'https://evil.example/post', `https://${BLOG_HOST}.evil.example/`, `https://${BLOG_HOST}@evil.example/`, undefined]) {
    assert.throws(() => at(url), /source/, String(url));
  }
});

test('offerProblems: nothing on a good offer, each problem on a bad one', () => {
  const good = { label: 'A - B', provider: 'A', plan: '', network: 'N', prices: { dc50: 0.5, ac7: null }, source: POST };
  assert.deepEqual(offerProblems(good), []);
  assert.equal(offerProblems({ ...good, prices: { dc50: '0.5' } }).length, 1, 'a string is not a price');
  assert.equal(offerProblems({ ...good, prices: { dc50: NaN } }).length, 1);
  assert.equal(offerProblems({ ...good, plan: 'x'.repeat(MAX_LABEL_LENGTH + 1) }).length, 1);
  assert.equal(offerProblems({ ...good, source: 'https://example.com/' }).length, 1);
  assert.deepEqual(offerProblems({ ...good, source: 'https://example.com/' }, ['example.com']), []);
  // A manual.json override lists only the fields it changes.
  assert.deepEqual(offerProblems({ id: 'a', prices: { dcMax: 0.63 } }), []);
});

test('pricePosts: the newest price list by publication date, and the notices after it', () => {
  const LIST = '<table class="evtable"><caption>Preços por kWh — Sem promoções ou subscrições pagas</caption><th>Operador</th></table>';
  const NOTICE = '<table class="evtable"><th>Operador</th></table>';
  const post = (id, published, updated, content = LIST) => ({ id, published: { $t: published }, updated: { $t: updated }, content: { $t: content } });
  const old = post('old', '2026-03-01T10:00:00.000-08:00', '2026-10-30T10:00:00.000-07:00');
  const current = post('current', '2026-10-14T14:13:01.133-07:00', '2026-10-14T14:13:01.133-07:00');
  const chat = post('chat', '2026-10-20T10:00:00.000-07:00', '2026-10-20T10:00:00.000-07:00', '<p>hi</p>');
  const ids = ({ list, notices }) => [list?.id, notices.map(n => n.id)];
  assert.deepEqual(ids(pricePosts([old, chat, current])), ['current', []], 'editing an old post changes nothing');
  assert.deepEqual(ids(pricePosts([current, chat, old])), ['current', []]);
  // As instants, not as text: 23:30 at -08:00 is later than 00:30 next day at +01:00.
  const late = post('late', '2026-10-14T23:30:00.000-08:00', '2026-10-14T23:30:00.000-08:00');
  const early = post('early', '2026-10-15T00:30:00.000+01:00', '2026-10-15T00:30:00.000+01:00');
  assert.equal(pricePosts([early, late]).list.id, 'late');
  assert.deepEqual(ids(pricePosts([chat])), [undefined, []]);
  // Tables without the list's caption: a notice if newer than the list
  // (oldest first), ignored if older.
  const n1 = post('n1', '2026-10-16T10:00:00.000-07:00', '2026-10-16T10:00:00.000-07:00', NOTICE);
  const n2 = post('n2', '2026-10-18T10:00:00.000-07:00', '2026-10-18T10:00:00.000-07:00', NOTICE);
  const before = post('before', '2026-10-01T10:00:00.000-07:00', '2026-10-01T10:00:00.000-07:00', NOTICE);
  assert.deepEqual(ids(pricePosts([n2, before, current, n1, chat])), ['current', ['n1', 'n2']]);
  // A newer post whose table doesn't read as prices stops the scrape loudly,
  // instead of falling back to last month's post.
  const renamed = { ...chat, content: { $t: '<table class="evtable"><th>Fornecedor</th></table>' } };
  assert.deepEqual(ids(pricePosts([current, renamed])), ['current', ['chat']]);
  assert.throws(() => parseTables(renamed.content.$t, { notice: true }), /no price tables/);
});

// The Electroverse notice of 22 Nov 2026, cut down: the provider's name spans
// its rows, AC is split in 11 / 22 / 43, "⚡️+🕘" = billed per minute too.
const NOTICE_HEAD = `<thead><tr><th class="evtable-operator" rowspan="2">Operador - Plano</th><th rowspan="2">Postos</th><th colspan="4">AC</th><th colspan="6">DC</th></tr>
<tr class="evtable-subhead"><th>≤7.4</th><th>11</th><th>22</th><th>43</th><th>≤50</th><th>100</th><th>120</th><th>150</th><th>180</th><th>&gt;180</th></tr></thead>`;
const NOTICE = `<div class="evtable-wrap"><table class="evtable">${NOTICE_HEAD}<tbody>
<tr><td class="evtable-operator" rowspan="3">Roamy</td><td class="evtable-network">Acme</td><td class="price">0,40</td><td>0,42</td><td>⚡️+🕘</td><td>⚡️+🕘</td><td>0,60</td><td>0,72</td></tr>
<tr><td class="evtable-network">Outros Mobi.E</td><td>0,40</td><td>0,42</td><td>0,42</td><td>0,60</td><td>0,60</td><td>0,72</td></tr>
  <tr><td class="evtable-network">Ionity</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td>0,62</td></tr>
</tbody></table></div>`;

test('parser: a notice, its provider spanning rows, AC 11/22/43 and per-minute cells', () => {
  assert.throws(() => parseTables(NOTICE), /without a caption/, 'a price list needs its captions');
  const [t] = parseTables(NOTICE, { notice: true });
  assert.equal(t.kind, 'payg');
  assert.deepEqual(t.bands, ['ac7', 'ac11', 'ac22', 'ac43', 'dc50', 'dc100', 'dc120', 'dc150', 'dc180', 'dcMax']);
  assert.deepEqual(t.rows.map(r => [r.name, r.network]), [['Roamy', 'Acme'], ['Roamy', 'Outros Mobi.E'], ['Roamy', 'Ionity']]);
  assert.deepEqual(t.rows[0].prices, { ac7: 0.4, ac11: 0.42, ac22: null, ac43: null, dc50: 0.6, dc100: 0.72, dc120: null, dc150: null, dc180: null, dcMax: null });
  assert.deepEqual(t.rows[0].perMinute, ['ac22', 'ac43']);
  assert.equal(t.rows[1].perMinute, undefined);
  assert.equal(t.rows[2].prices.dcMax, 0.62);
  // A span past the last row, or on any other cell, would shift the prices.
  assert.throws(() => parseTables(NOTICE.replace('rowspan="3"', 'rowspan="4"'), { notice: true }), /spans more rows/);
  assert.throws(() => parseTables(NOTICE.replace('<td>0,42</td><td>0,42</td>', '<td rowspan="2">0,42</td><td>0,42</td>'), { notice: true }), /merged cells/);
  // A fee in a notice's name: a subscription we couldn't tell from the list's.
  assert.throws(() => parseTables(NOTICE.replace('>Roamy<', '>Roamy - Plus 8€/mês<'), { notice: true }), /fee in its name/);
  const [o] = toOffers([t], { ...NETS, 'Outros Mobi.E': { scope: 'mobie' }, Ionity: { operatorIds: ['IONY'] } }, { url: POST, checkedAt: '2026-11-22', origin: 'custofinal' }).offers;
  assert.deepEqual(o.perMinute, ['ac22', 'ac43']);
  assert.deepEqual(offerProblems(o), []);
  assert.equal(offerProblems({ perMinute: ['ac99'] }).length, 1);
});

test('applyNotices: a notice replaces its provider\'s pay-as-you-go rows, not its subscriptions', () => {
  const src = url => ({ url, checkedAt: '2026-11-22', origin: 'custofinal' });
  const list = { tables: parseTables(FIXTURE.replace('>Acme - Plus 8€/mês<', '>Roamy - Plus 8€/mês<')), source: src(POST) };
  const notice = { tables: parseTables(NOTICE, { notice: true }), source: src(`https://${BLOG_HOST}/2026/11/notice.html`) };
  const { posts, replaced } = applyNotices([list, notice]);
  assert.deepEqual(replaced, [{ url: notice.source.url, labels: ['Roamy'] }]);
  assert.ok(!posts[0].tables[0].rows.some(r => r.name === 'Roamy'), 'the list\'s Roamy @ Rede Mobi.E is gone');
  assert.equal(posts[0].tables[0].rows.length, 3);
  assert.deepEqual(posts[0].tables[1].rows.map(r => r.name), ['Roamy - Plus 8€/mês'], 'the subscription stays');
  assert.equal(posts[1].tables, notice.tables);
  // A notice about a provider the list doesn't have is a new kind of post.
  const stranger = { tables: parseTables(NOTICE.replace('>Roamy<', '>Zappy<'), { notice: true }), source: notice.source };
  assert.throws(() => applyNotices([list, stranger]), /"zappy" is not a pay-as-you-go offer/);
  // A later notice can replace an earlier one's rows.
  assert.equal(applyNotices([list, notice, { ...notice, source: src(`https://${BLOG_HOST}/2026/11/again.html`) }]).posts[1].tables[0].rows.length, 0);
});

test('parseTables: a merged cell in a price row stops the scrape', () => {
  const html = `<table class="evtable"><caption>Preços</caption>${HEAD}<tbody><tr><td>A</td><td colspan="2">B</td></tr></tbody></table>`;
  assert.throws(() => parseTables(html), /merged cells/);
});

test('toOffers: scope from networks.json, walk-up, fees, unmapped and unknown labels', () => {
  const r = toOffers(parseTables(FIXTURE), NETS, { url: POST, checkedAt: '2026-10-14', origin: 'custofinal' });
  const by = Object.fromEntries(r.offers.map(o => [o.id, o]));
  assert.deepEqual(Object.keys(by).sort(), ['acme-plus-8-mes-acme', 'acme-tpa-acme', 'roamy-rede-mobi-e']);
  assert.equal(by['acme-tpa-acme'].walkUp, true);
  assert.deepEqual(by['acme-tpa-acme'].scope, { operatorIds: ['ACME'] });
  assert.deepEqual(by['roamy-rede-mobi-e'].scope, { mobie: true });
  assert.deepEqual(by['acme-plus-8-mes-acme'].fee, { eur: 8, per: 'month' });
  assert.equal(by['acme-plus-8-mes-acme'].subscription, true);
  assert.deepEqual(r.unmapped, ['Newco']);
  assert.deepEqual(r.skipped, ['Somewhere - App @ Alguns Mobi.E']);
});

test('bandFor: the blog power bands', () => {
  const b = (kw, dc) => bandFor({ kw, dc });
  assert.deepEqual([b(3.7, false), b(7.4, false), b(11, false), b(11.04, false), b(13.8, false), b(22, false), b(22.08, false), b(43, false), b(50, true), b(60, true), b(120, true), b(150, true), b(175, true), b(350, true), b(null, true)],
    ['ac7', 'ac7', 'ac11', 'ac11', 'ac22', 'ac22', 'ac22', 'ac43', 'dc50', 'dc100', 'dc120', 'dc150', 'dc180', 'dcMax', null]);
});

test('bandPrice: the list\'s one AC column covers 11 and 43 kW; a notice\'s own bands win, even empty', () => {
  const list = { ac7: 0.4, ac22: 0.42, dc50: 0.6 };
  assert.deepEqual(['ac7', 'ac11', 'ac22', 'ac43', 'dc100'].map(b => bandPrice(list, b)), [0.4, 0.42, 0.42, 0.42, null]);
  const notice = { ac7: 0.4, ac11: 0.42, ac22: null, ac43: null };
  assert.deepEqual(['ac11', 'ac22', 'ac43'].map(b => bandPrice(notice, b)), [0.42, null, null]);
  assert.equal(bandPrice({ all: 0.41 }, 'ac11'), 0.41);
  assert.equal(bandPrice({ ac22: null, all: 0.41 }, 'ac22'), 0.41, 'as before: an empty band falls back to all');
});

test('Electroverse per minute: priced from manual.json where its rate was seen', () => {
  const ev = (site, point, f = offersAt) => f(site, { dc: false, regime: 'mobie', ...point }).filter(x => x.offer.provider === 'Electroverse');
  const row = (site, kw) => ev(site, { kw }).map(x => [x.offer.id, x.eurPerKwh, x.eurPerMin, x.offer.sessionEur]);
  const galp = { operatorId: 'GLPP' }, emel = { operatorId: 'EMEL' }, atlante = { operatorId: 'ATLA' };
  assert.deepEqual(row(galp, 22), [['electroverse-galp', 0.42, 0.05, 0.3]]);
  assert.deepEqual(row(galp, 43), [['electroverse-galp', 0.6, 0.08, 0.3]]);
  assert.deepEqual(row(galp, 11), [['electroverse-galp', 0.42, undefined, 0.3]]);
  assert.deepEqual(row(emel, 22), [['electroverse-emel', 0.6, 0.25, 0.3]]);
  // The notice's per-minute AC 22 wasn't seen at Atlante: plain kWh, no fee.
  assert.deepEqual(row(atlante, 22), [['electroverse-atlante', 0.6, undefined, undefined]]);
  assert.deepEqual([60, 150, 300].map(kw => offersAt(atlante, { kw, dc: true, regime: 'mobie' }).find(x => x.offer.id === 'electroverse-atlante').eurPerKwh), [0.6, 0.7, 0.7]);
  // GLPG sites bill like the rest of MOBI.E.
  assert.deepEqual(row({ operatorId: 'GLPG' }, 22), [['electroverse-outros-mobi-e', 0.42, undefined, 0.3]]);
  for (const site of [galp, emel, atlante]) assert.deepEqual(ev(site, { kw: 22 }, perMinuteAt), []);
});

test('unpricedMinutes: per minute at a band without its rate means no price there', () => {
  const offer = { perMinute: ['ac22', 'ac43'], minuteEur: { ac22: 0.05 } };
  assert.equal(unpricedMinutes(offer, 'ac22'), false);
  assert.equal(unpricedMinutes(offer, 'ac43'), true);
  assert.equal(unpricedMinutes(offer, 'ac11'), false);
  assert.equal(unpricedMinutes({ perMinute: [] }, 'ac22'), false, 'manual.json emptied it: priced per kWh');
});

test('mergeOffers: manual overrides fields and prices band by band, adds, disables', () => {
  const scraped = [
    { id: 'a', label: 'A', prices: { dc50: 0.5, dcMax: 0.6 }, origin: 'custofinal' },
    { id: 'b', label: 'B', prices: { dc50: 0.4 }, origin: 'custofinal' },
  ];
  const merged = mergeOffers(scraped, [
    { id: 'a', prices: { dcMax: 0.63 }, why: 'official' },
    { id: 'b', disable: true },
    { id: 'c', add: true, label: 'C', prices: { dc50: 0.3 } },
  ]);
  assert.deepEqual(merged.map(o => [o.id, o.prices, o.origin]), [
    ['a', { dc50: 0.5, dcMax: 0.63 }, 'manual'],
    ['c', { dc50: 0.3 }, 'manual'],
  ]);
  assert.deepEqual(merged.orphans, []);
});

test('mergeOffers: a typo in an id is reported, never a phantom offer', () => {
  const scraped = [{ id: 'a', label: 'A', prices: { dc50: 0.5 } }];
  const merged = mergeOffers(scraped, [
    { id: 'a-typo', prices: { dc50: 0.4 } },
    { id: 'gone', disable: true },
    { id: 'a', add: true, label: 'A2', prices: { dc50: 0.1 } },
  ]);
  assert.deepEqual(merged.map(o => o.id), ['a']);
  assert.equal(merged[0].label, 'A', 'an "add" never replaces a scraped offer');
  assert.equal(merged.orphans.length, 3);
  assert.match(merged.orphans.join('\n'), /a-typo.*override/);
  assert.match(merged.orphans.join('\n'), /gone.*disable/);
});

test('offers/manual.json: every override and disable still matches the scrape', () => {
  assert.deepEqual(OFFERS.orphans, [], 'fix the id in offers/manual.json, or drop the entry');
});

test('offersAt: operator offers + MOBI.E-wide ones, priced for the band', () => {
  const ionity = { id: 'IOY-X', operatorId: 'IONY' };
  const at = offersAt(ionity, { kw: 350, dc: true, regime: 'mobie' });
  const ids = at.map(x => x.offer.id);
  assert.ok(ids.includes('ionity-tpa-ionity') && ids.includes('ionity-app-ionity'));
  assert.equal(at.find(x => x.offer.id === 'ionity-tpa-ionity').eurPerKwh, 0.63, 'manual.json wins over the blog');
  assert.ok(at.some(x => x.offer.scope.mobie), 'MOBI.E-wide offers apply at a MOBI.E charger');
  const labels = at.map(x => x.offer.label);
  assert.equal(labels.length, new Set(labels).size, 'a network-specific row replaces the same provider\'s MOBI.E-wide row');
  assert.equal(ownWalkUp(ionity, at), true);
  // Outside MOBI.E, MOBI.E-wide offers don't apply: Tesla, whose own blog
  // rows manual.json disables, gets none.
  assert.deepEqual(offersAt({ operatorId: 'TSLA' }, { kw: 250, dc: true, regime: 'sem_ceme' }), []);
  // An offer without a price for this band is not offered here.
  assert.ok(!offersAt(ionity, { kw: 22, dc: false, regime: 'mobie' }).some(x => x.offer.id === 'ionity-tpa-ionity'));
});

test('offersAt: a promotion ends on its `until` day and the regular price takes over', () => {
  const telpark = { id: 'EPK-X', operatorId: 'EPKS', region: 'CONT' }, ac = { kw: 22, dc: false, regime: 'mobie_sem_tarifa' };
  const own = at => offersAt(telpark, ac, [], new Date(at)).filter(x => x.offer.scope.operatorIds?.includes('EPKS'));
  const ids = at => own(at).map(x => x.offer.id);
  assert.deepEqual(ids('2026-12-31T23:30:00Z'), ['telpark-app-telpark-lancamento-telpark'], '23:30 UTC on 31 Dec is still 31 Dec in Lisbon');
  assert.deepEqual(ids('2027-01-01T00:30:00Z'), ['telpark-app-telpark']);
  assert.equal(own('2026-11-10T12:00:00Z')[0].eurPerKwh, 0.59);
  assert.equal(own('2027-02-01T12:00:00Z')[0].eurPerKwh, 0.69);
  // In winter the Azores are an hour behind UTC: still 31 Dec there.
  assert.equal(civilDay(new Date('2027-01-01T00:30:00Z'), 'AZO'), '2026-12-31');
  assert.equal(activeOn({ from: '2027-01-01' }, '2026-12-31'), false);
});

test('gaps: operators with direct-payment signals and no scoped offer', () => {
  const site = (operatorId, payment, adhoc) => ({ operatorId, operator: operatorId, payment, points: [{ opc: adhoc ? { AD_HOC_PAYMENT: {} } : {} }] });
  const g = gaps([site('IONY', ['creditCard'], true), site('AAA', ['apps', 'creditCard']), site('AAA', ['apps']), site('BBB', ['apps', 'rfid']), site('CCC', ['apps'], true)]);
  assert.deepEqual(g.map(o => [o.operatorId, o.sites, o.card, o.adhoc]), [['AAA', 2, 1, 0], ['CCC', 1, 0, 1]]);
});

test('isStale after 90 days', () => {
  assert.equal(isStale({ checkedAt: '2026-01-01' }, new Date('2026-10-28')), true);
  assert.equal(isStale({ checkedAt: '2026-10-01' }, new Date('2026-10-28')), false);
});

// The offers files are edited by hand (manual.json, networks.json) or by a
// bot (custofinal.json), so the tests are their validator.
test('offers files are well-formed', () => {
  const ids = new Set();
  for (const o of OFFERS) {
    assert.ok(!ids.has(o.id), `duplicate id ${o.id}`); ids.add(o.id);
    assert.ok(o.label && o.provider, `${o.id}: label and provider`);
    assert.ok(o.scope?.mobie === true || o.scope?.operatorIds?.length, `${o.id}: scope`);
    assert.match(o.source, /^https:\/\//, `${o.id}: https source`);
    assert.match(o.checkedAt, /^\d{4}-\d{2}-\d{2}$/, `${o.id}: checkedAt YYYY-MM-DD`);
    assert.ok(new Date(o.checkedAt) <= new Date(), `${o.id}: checkedAt in the future`);
    const prices = Object.values(o.prices).filter(v => v != null);
    assert.ok(prices.length, `${o.id}: at least one price`);
    for (const k of ['from', 'until']) if (k in o) assert.match(o[k], /^\d{4}-\d{2}-\d{2}$/, `${o.id}: ${k} YYYY-MM-DD`);
    if (o.from && o.until) assert.ok(o.from <= o.until, `${o.id}: from after until`);
    if (o.subscription && o.fee) assert.ok(o.fee.eur > 0 && ['month', 'year'].includes(o.fee.per), `${o.id}: fee`);
  }
  const manual = JSON.parse(readFileSync(new URL('../offers/manual.json', import.meta.url), 'utf8')).offers;
  for (const m of manual) {
    assert.ok(m.id && (m.disable || (m.source && m.checkedAt)), `manual ${m.id}: source and checkedAt`);
  }
  const custofinal = JSON.parse(readFileSync(new URL('../offers/custofinal.json', import.meta.url), 'utf8'));
  assert.deepEqual(custofinal.unmapped, [], 'custofinal.json has unmapped networks: add them to offers/networks.json');
});

// The same check the parser runs on every scrape, over what's already in the
// files: a hand edit to manual.json never goes through the parser.
test('offers/*.json pass the sanity check', () => {
  const file = name => JSON.parse(readFileSync(new URL(`../offers/${name}.json`, import.meta.url), 'utf8'));
  const { source, offers, unmapped, skipped } = file('custofinal');
  const { sourceHosts, offers: manual } = file('manual');
  assert.ok(sourceHosts.includes(BLOG_HOST));
  const clean = (what, problems) => assert.deepEqual(problems, [], what);

  for (const o of offers) clean(`custofinal ${o.id}`, offerProblems(o));
  clean('custofinal source', offerProblems({ source: source.post }));
  for (const label of [...unmapped, ...skipped.flatMap(s => s.split(' @ '))]) clean(label, offerProblems({ label }));
  for (const o of manual) clean(`manual ${o.id}`, offerProblems(o, sourceHosts));
  for (const o of OFFERS) clean(`merged ${o.id}`, offerProblems(o, sourceHosts));
  for (const n of NAP_NOTES) clean(n.why, offerProblems({ source: n.source }, sourceHosts));
  for (const network of Object.keys(file('networks').networks)) clean(network, offerProblems({ network }));
  for (const a of Object.values(AUDIENCES)) clean(a.en, [...offerProblems({ label: a.en }), ...offerProblems({ label: a.pt })]);
});

test('noteFor: a NAP-price note matches by operator or by site', () => {
  const notes = [{ scope: { operatorIds: ['CONT'] }, why: 'a' }, { scope: { siteIds: ['TSL-1'] }, why: 'b' }];
  assert.equal(noteFor(notes, { id: 'CONT-9', operatorId: 'CONT' })?.why, 'a');
  assert.equal(noteFor(notes, { id: 'TSL-1', operatorId: 'TSLA' })?.why, 'b');
  assert.equal(noteFor(notes, { id: 'TSL-2', operatorId: 'TSLA' }), null);
});

test('nap-notes.json: every note is scoped and sourced', () => {
  const { notes } = JSON.parse(readFileSync(new URL('../offers/nap-notes.json', import.meta.url), 'utf8'));
  for (const n of notes) {
    assert.ok(n.scope?.operatorIds?.length || n.scope?.siteIds?.length, JSON.stringify(n.scope));
    assert.ok(n.why && /^https:\/\//.test(n.source) && /^\d{4}-\d{2}-\d{2}$/.test(n.checkedAt), n.why);
  }
});

test('audience offers: hidden unless the driver claims the group; ids exist', () => {
  for (const o of OFFERS) if (o.audience) assert.ok(AUDIENCES[o.audience], `${o.id}: unknown audience ${o.audience}`);
  for (const [id, a] of Object.entries(AUDIENCES)) assert.ok(a.en && a.pt, id);
  const powerdot = { operatorId: 'HORZ' }, dc = { kw: 150, dc: true, regime: 'mobie' };
  const ids = audiences => offersAt(powerdot, dc, audiences).map(x => x.offer.id);
  assert.ok(!ids().includes('powerdot-uber-driver-powerdot'));
  assert.ok(!ids(['edp-staff']).includes('powerdot-uber-driver-powerdot'));
  const uber = offersAt(powerdot, dc, ['uber-driver']).find(x => x.offer.id === 'powerdot-uber-driver-powerdot');
  assert.equal(uber.eurPerKwh, 0.41);
  // The offers for everyone are still there.
  assert.deepEqual(ids().filter(id => id !== 'powerdot-uber-driver-powerdot'), ids(['uber-driver']).filter(id => id !== 'powerdot-uber-driver-powerdot'));
});

test('minuteEur: a per-minute price for some bands, checked and added to the total', async () => {
  const { directOptionsForTest } = await import('../src/quote.js');
  assert.deepEqual(offerProblems({ minuteEur: { ac22: 0.05, ac43: 0.08 } }), []);
  assert.equal(offerProblems({ minuteEur: { ac99: 0.05 } }).length, 1, 'not a band');
  assert.equal(offerProblems({ minuteEur: { ac22: 5 } }).length, 1, 'a lost decimal comma');
  const offer = { id: 'x', label: 'X', provider: 'X', prices: { ac22: 0.42 }, sessionEur: 0.3, checkedAt: '2026-11-23', origin: 'manual', source: 'https://example.com/' };
  const [o] = directOptionsForTest([{ offer, eurPerKwh: 0.42, eurPerMin: 0.05 }], { kwh: 30, minutes: 100 }, 'pt', 'CONT', 120);
  assert.equal(o.total, 18.9); // 30 × 0,42 + 120 min × 0,05 + 0,30: minutes plugged in, not charging
  assert.equal(o.eurPerMin, 0.05);
  assert.match(o.note, /0,05 € por minuto \(120 min\)/);
  assert.match(o.note, /0,30 € por sessão/);
});

test('per-session fee: in the total, said in the note; staff offer is half of Electroverse', async () => {
  const { directOptionsForTest } = await import('../src/quote.js');
  const powerdot = { operatorId: 'HORZ' }, dc = { kw: 150, dc: true, regime: 'mobie' };
  const staff = offersAt(powerdot, dc, ['powerdot-staff']).find(x => x.offer.id === 'electroverse-powerdot-staff-powerdot');
  const ev = offersAt(powerdot, dc).find(x => x.offer.id === 'electroverse-outros-mobi-e');
  assert.equal(staff.eurPerKwh, ev.eurPerKwh / 2);
  const [o] = directOptionsForTest([staff], { kwh: 38.71 }, 'pt', 'CONT');
  assert.equal(o.total, 14.24); // 38,71 × 0,36 + 0,30
  assert.equal(o.audience, 'powerdot-staff');
  assert.match(o.note, /0,30 € por sessão/);
});

test('offers: the parser does not load the network list at import', () => {
  // The weekly scrape reads networks.json itself and reports what's wrong with it.
  const script = `import { registerHooks } from 'node:module';
const seen = [];
registerHooks({ resolve(spec, ctx, next) { seen.push(spec); return next(spec, ctx); } });
await import('./src/offers-parse.js');
console.log(seen.join(' '));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /promos|lookup/);
});
