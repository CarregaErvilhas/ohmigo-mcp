// Finding a charger by what the user calls it (src/lookup.js, Dataset.lookup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dataset } from '../src/data.js';
import { codesIn } from '../src/lookup.js';

const pt = (id, extra = {}) => ({ id, kw: 22, connector: 'T2', dc: false, regime: 'mobie', ...extra });
const site = (id, code, city, address, operator, operatorId, lat, lon, extra = {}) =>
  ({ id, code, city, address, operator, operatorId, lat, lon, region: 'CONT', points: [pt(`${code}-01`), pt(`${code}-02`, { kw: 50, connector: 'CCS', dc: true })], ...extra });

const ds = new Dataset({
  schema: 1, generatedAt: '2026-10-28T00:00:00Z',
  sites: [
    site('GLP-LRA-00156', 'LRA-00156', 'Leiria', 'Avenida 25 de Abril', 'Galp Power OPC', 'GLPP', 39.7469, -8.8157),
    site('GLP-MOBI-LSB-00085', 'LSB-00085', 'Lisboa', 'Rua Tomás da Fonseca', 'Galp Power OPC', 'GLPP', 38.75, -9.17),
    site('HRZ-PBL-00016', 'PBL-00016', 'Pombal', 'N1 45', 'Powerdot, S.A', 'HORZ', 39.92, -8.63),
    site('HRZ-OER-90013', 'OER-90013', 'Oeiras', 'Largo Marquês Pombal', 'Powerdot, S.A', 'HORZ', 38.69, -9.31),
    site('IOY-ALB-00019', 'ALB-00019', 'Albergaria-a-Velha', 'N1-IC2 Km245,5', 'IONITY GmbH', 'IONY', 40.68, -8.47),
    site('ATL-MLD-00011', 'MLD-00011', 'Mealhada', 'Avenida da Floresta', 'Atlante Infra Portugal, S.A', 'ATLA', 40.38, -8.45),
    site('CNT-9648PL0001', '9648PL0001', 'Leiria', 'R. Vale de Lobos 37', 'Modelo Continente Hipermercados, S.A.', 'CONT', 39.75, -8.80,
      { osm: { name: 'Continente Leiria', brand: 'Continente Plug&Charge', location: 'underground' } }),
    // Continente publishes some sites with no operator at all.
    site('CNT-0001PL0002', '0001PL0002', 'Matosinhos', 'Rua João Mendonça 505', null, null, 41.18, -8.66),
    site('TSL-d9df0db6-fea7-4f68-be57-13dbb28dbae1', 'd9df0db6-fea7-4f68-be57-13dbb28dbae1', 'Mealhada', 'R. São Domingos', 'Tesla', 'TSLA', 40.37, -8.48),
    site('LDL-CBR-00001', 'CBR-00001', 'Coimbra', 'Rua do Brasil', 'Helexia II Energy Services, Lda.', 'HELX', 40.2, -8.42, { osm: { brand: 'Lidl' } }),
    site('SMF-VFR-00001', 'VFR-00001', 'Santa Maria da Feira', 'Rua Central', 'EDP Comercial', 'EDPC', 40.92, -8.54),
  ],
});
const ids = (q, opts) => ds.lookup(q, opts).results.map(h => h.site.id);

test('lookup: a MOBI.E code, however it is written', () => {
  for (const q of ['LRA-00156', 'lra 156', 'LRA00156', 'GLP-LRA-00156', 'MOBI-LRA-00156', 'o posto LRA-00156 em Leiria']) {
    assert.deepEqual(ids(q), ['GLP-LRA-00156'], q);
  }
  assert.deepEqual(ids('LSB-00085'), ['GLP-MOBI-LSB-00085']);
});

test('lookup: the socket number on the sticker is kept', () => {
  assert.equal(ds.lookup('LRA-00156-02').results[0].socket, 2);
  assert.equal(ds.lookup('GLP-LRA-00156-02').results[0].socket, 2);
  assert.equal(ds.lookup('LRA-00156').results[0].socket, null);
});

test('lookup: ids that are not MOBI.E codes match whole', () => {
  assert.deepEqual(ids('0001PL0002'), ['CNT-0001PL0002']);
  assert.deepEqual(ids('d9df0db6-fea7-4f68-be57-13dbb28dbae1'), ['TSL-d9df0db6-fea7-4f68-be57-13dbb28dbae1']);
  // A UUID segment that looks like letters+digits is not a code.
  assert.deepEqual(codesIn('fea7'), [{ key: 'FEA-7', socket: null }]);
  assert.deepEqual(ids('FEA-7'), []);
});

test('lookup: operator and town, ignoring accents, case and filler words', () => {
  assert.deepEqual(ids('o posto da Powerdot em Pombal'), ['HRZ-PBL-00016', 'HRZ-OER-90013']);
  assert.deepEqual(ids('galp leiria'), ['GLP-LRA-00156']);
  assert.deepEqual(ids('EDP Santa Maria da Feira'), ['SMF-VFR-00001']);
});

test('lookup: a town in the words orders the rest by distance to it', () => {
  const r = ds.lookup('powerdot pombal');
  assert.equal(r.town, 'pombal');
  assert.ok(r.results[0].km < r.results[1].km);
});

test('lookup: brand names from offers/networks.json and from OpenStreetMap', () => {
  assert.deepEqual(ids('IONITY'), ['IOY-ALB-00019']);
  assert.deepEqual(ids('tesla supercharger'), ['TSL-d9df0db6-fea7-4f68-be57-13dbb28dbae1']);
  assert.deepEqual(ids('lidl coimbra'), ['LDL-CBR-00001']);
  assert.deepEqual(ids('continente plug charge leiria'), ['CNT-9648PL0001']);
});

test('lookup: a site without an operator borrows the one its id prefix belongs to', () => {
  assert.ok(ids('continente matosinhos').includes('CNT-0001PL0002'));
});

test('lookup: one typo is forgiven in longer words', () => {
  assert.deepEqual(ids('Albergaria Ionty'), ['IOY-ALB-00019']);
});

test('lookup: partial matches say which words they lack', () => {
  const r = ds.lookup('IONITY Mealhada');
  // No IONITY in Mealhada: IONITY sites come first (who runs it beats the
  // town), each saying it lacks "mealhada".
  assert.equal(r.results[0].site.id, 'IOY-ALB-00019');
  assert.deepEqual(r.results[0].missing, ['mealhada']);
  assert.deepEqual(ds.lookup('galp leiria').results[0].missing, []);
});

test('lookup: nothing for words nobody has', () => {
  assert.equal(ds.lookup('xyzzy').total, 0);
  assert.equal(ds.lookup('o posto').total, 0);
});

test('lookup: filters and radius', () => {
  const r = ds.lookup('galp', { connectors: ['CCS'] });
  assert.ok(r.results.every(h => h.points.every(p => p.connector === 'CCS')));
  assert.deepEqual(ids('galp', { near: { lat: 39.74, lon: -8.81 }, radiusKm: 10 }), ['GLP-LRA-00156']);
});

test('resolvePlace: the town before a comma', () => {
  assert.ok(ds.resolvePlace('Leiria, Portugal'));
  assert.equal(ds.resolvePlace(', '), null);
});

test('resolvePlace: whole words from the start, never a substring anywhere', () => {
  assert.equal(ds.resolvePlace('a'), null, 'too short');
  assert.equal(ds.resolvePlace('eir'), null, 'inside a word: not Leiria');
  assert.ok(Math.abs(ds.resolvePlace('lei').lat - 39.75) < 0.01, 'the start of one town');
  assert.ok(ds.resolvePlace('santa maria'), 'every word of a compound name');
  assert.equal(ds.resolvePlace('Rua'), null, 'an address word in several towns is not a place');
});

test('resolvePlace: a prefix of several towns is ambiguous, and says which', () => {
  const two = new Dataset({ schema: 1, generatedAt: 'x', sites: [
    site('A-1', 'A1', 'Viana do Castelo', 'R. 1', 'X', 'X', 41.69, -8.83),
    site('B-1', 'B1', 'Viana do Alentejo', 'R. 2', 'X', 'X', 38.33, -8.0),
  ] });
  assert.equal(two.resolvePlace('viana'), null);
  assert.deepEqual(two.placeCandidates('viana'), ['Viana do Castelo', 'Viana do Alentejo']);
  assert.ok(two.resolvePlace('Viana do Castelo'));
});
