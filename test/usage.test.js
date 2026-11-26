// The per-site usage files nap-dashboard publishes (src/usage.js): the hash
// that names a site's file, the summary lookup_charger shows, and a file that
// fails never failing the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { SiteUsage, shardOf, summarise } from '../src/usage.js';
import { siteHistory } from '../src/mcp.js';

test('usage: the shard hash matches nap-dashboard (site_history.shard_of, uso.js)', () => {
  assert.equal(shardOf('GLP-GDM-00060'), 'fa');
  assert.equal(shardOf('EZC-AMD-00051'), '07');
  assert.equal(shardOf('MOBI-AMD-00001'), '5d');
  assert.equal(shardOf('á'), '29');
});

// Two sockets, 28 days read every hour: one charges 9-12 on weekdays, the
// other is down one day in four. Index of w = weekday * 24 + hour, Monday first.
const W = (busyAt) => Array.from({ length: 168 }, (_, i) => {
  const day = Math.floor(i / 24), h = i % 24;
  return [4, busyAt(day, h) ? 400 : 0, busyAt(day, h) ? 0 : 400, 0];
});
const entry = {
  tz: 'Atlantic/Azores',
  p: {
    1: { d: Array.from({ length: 30 }, (_, i) => (i < 2 ? null : [24, 300, 2100, 0])), w: W((d, h) => d < 5 && h >= 9 && h < 12) },
    2: { d: Array.from({ length: 30 }, (_, i) => (i < 2 ? null : [24, 0, i % 4 ? 2400 : 0, i % 4 ? 0 : 2400])), w: W(() => false) },
  },
};

test('usage: a site sums its sockets over the last 4 weeks, by kind of day and hour', () => {
  const s = summarise(entry, 28);
  assert.equal(s.days, 28);
  assert.equal(s.tz, 'Atlantic/Azores');
  assert.equal(s.down, 12.5, '7 of the 56 socket-days down');
  assert.equal(s.busy.wd[10], 50, 'one of two sockets charging');
  assert.equal(s.busy.wd[13], 0);
  assert.equal(s.busy.we[10], 0);
  // siteHistory reads it as it read the dataset's, in the site's own time zone.
  const h = siteHistory({ region: 'CONT' }, new Date('2026-11-24T11:30:00Z'), s);   // Tuesday 10:30 in the Azores
  assert.equal(h.atHour, 10);
  assert.equal(h.busyPctAtHour, 50);
  assert.equal(h.outOfOrderPct, 12.5);
  assert.deepEqual(h.weekday.busiest, [9, 10, 11]);
});

test('usage: too little behind it says nothing; an hour with under two days per socket is null', () => {
  const short = { p: { 1: { d: [[24, 0, 2400, 0], [24, 0, 2400, 0]], w: [] } } };
  assert.equal(summarise(short), undefined);
  const thin = structuredClone(entry);
  thin.p[1].w[10] = [1, 100, 0, 0];   // Monday 10:00: one read in four weeks
  thin.p[2].w[10] = [0, 0, 0, 0];
  for (let d = 1; d < 5; d++) { thin.p[1].w[d * 24 + 10] = [0, 0, 0, 0]; thin.p[2].w[d * 24 + 10] = [0, 0, 0, 0]; }
  assert.equal(summarise(thin).busy.wd[10], null);
});

const file = sites => gzipSync(Buffer.from(JSON.stringify({ v: 1, heat: { days: 28 }, sites })));
const reply = (buf, status = 200) => ({ ok: status === 200, status, body: [buf] });

test('usage: fetches a file once, keeps only summaries, and a failed file leaves history out', async () => {
  const calls = [];
  const u = new SiteUsage({
    baseUrl: 'https://example.test/data/sites/',
    fetchImpl: async url => { calls.push(String(url)); return String(url).endsWith('/fa.json.gz') ? reply(file({ 'GLP-GDM-00060': entry })) : reply(Buffer.from(''), 404); },
  });
  const got = await u.get(['GLP-GDM-00060', 'EZC-AMD-00051', 'GLP-GDM-00060']);
  assert.deepEqual([...got.keys()], ['GLP-GDM-00060']);
  assert.equal(got.get('GLP-GDM-00060').down, 12.5);
  assert.deepEqual(calls.sort(), ['https://example.test/data/sites/07.json.gz', 'https://example.test/data/sites/fa.json.gz']);
  await u.get(['GLP-GDM-00060', 'EZC-AMD-00051']);
  assert.equal(calls.length, 2, 'both files cached, the failed one too, for a while');
});

test('usage: a file of the wrong shape or too big is refused', async () => {
  const u = new SiteUsage({ baseUrl: 'https://example.test/', fetchImpl: async () => reply(gzipSync(Buffer.from('{"v":2,"sites":{}}'))) });
  assert.equal((await u.get(['GLP-GDM-00060'])).size, 0);
  const big = new SiteUsage({ baseUrl: 'https://example.test/', fetchImpl: async () => ({ ok: true, status: 200, body: [Buffer.alloc(4 * 1024 * 1024)] }) });
  assert.equal((await big.get(['GLP-GDM-00060'])).size, 0);
});
