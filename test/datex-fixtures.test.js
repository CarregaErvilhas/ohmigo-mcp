// Runs the status parser over the DATEX II fixtures shared with the
// collector and nap-dashboard (test/fixtures/datex/README.md) and compares
// with the expected output there. ohmigo has no static parser, so only the
// status half applies. The copies must stay byte-identical: SHA256SUMS
// catches an edit made to one copy only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parseStatus } from '../src/live.js';

const DIR = new URL('./fixtures/datex/', import.meta.url);
const read = f => readFileSync(new URL(f, DIR));
const expected = JSON.parse(read('expected.json'));

// Where this parser differs from expected.json today, with the reason. A
// listed path must keep differing, so a fix shows up as a failure here and
// the entry gets removed. Fixing the behaviour is a separate decision.
const KNOWN = {
  status: {
    'points["QA0002/5"].status': 'an empty <status/> stays an empty string, not "other"',
    'points["QA0002/6"].status': 'a point with no <status> gets null, not "other"',
    'points["QA0002/8"].fees': 'an empty <minimumDeliveryFee/> is read as 0 € (Number("") is 0), not as no fee',
    'points["QA0002/A/B"]': 'a slash in a point id is kept, so the SITE/POINT key is ambiguous',
    'points["null/Z1"]': 'a point in a site with no reference is keyed "null/Z1" instead of dropped',
  },
};

// Small odd-sized chunks, so text and multi-byte characters split across writes.
const chunks = buf => ({ async *[Symbol.asyncIterator]() { for (let i = 0; i < buf.length; i += 7) yield buf.subarray(i, i + 7); } });

// Native output -> the neutral shape. Shape and types only, never values.
const toStatus = r => ({
  publicationTime: r.publicationTime,
  points: Object.fromEntries([...r.points].map(([k, v]) => [k, { status: v.status, fees: v.fees }])),
});

// Path -> [expected, actual] for every field that differs.
function diff(exp, act) {
  const out = new Map();
  const keys = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  for (const sec of keys(exp, act)) {
    const e = exp[sec], a = act[sec];
    if (!e || typeof e !== 'object') { if (!isDeepStrictEqual(e, a)) out.set(sec, [e, a]); continue; }
    for (const k of keys(e, a)) {
      const p = `${sec}[${JSON.stringify(k)}]`;
      if (!e[k] || !a?.[k]) { out.set(p, [e[k], a?.[k]]); continue; }
      for (const f of keys(e[k], a[k])) if (!isDeepStrictEqual(e[k][f], a[k][f])) out.set(`${p}.${f}`, [e[k][f], a[k][f]]);
    }
  }
  return out;
}

test('datex fixtures: SHA256SUMS matches and lists every file', () => {
  const sums = read('SHA256SUMS').toString().trim().split('\n').map(l => l.split(/\s+\*?/));
  for (const [sum, file] of sums) assert.equal(createHash('sha256').update(read(file)).digest('hex'), sum, `${file} differs from the other copies`);
  const listed = new Set(sums.map(([, f]) => f));
  assert.deepEqual(readdirSync(DIR).filter(f => f !== 'SHA256SUMS' && !listed.has(f)), []);
});

for (const [name, file, parse, shape] of [
  ['status', 'status.xml', parseStatus, toStatus],
]) {
  const got = async () => diff(expected[name], shape(await parse(chunks(read(file)))));

  test(`datex fixtures: ${name} matches expected.json`, async () => {
    const d = await got();
    const unexpected = Object.fromEntries([...d].filter(([p]) => !(p in KNOWN[name])));
    assert.deepEqual(unexpected, {}, 'differs from expected.json: [expected, actual]');
    const fixed = Object.keys(KNOWN[name]).filter(p => !d.has(p));
    assert.deepEqual(fixed, [], 'known difference no longer differs: remove it from KNOWN');
  });

  for (const [path, reason] of Object.entries(KNOWN[name])) {
    test(`datex fixtures: ${name} ${path}`, { todo: reason }, async () => {
      assert.equal((await got()).get(path), undefined);
    });
  }
}
