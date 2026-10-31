// A session runs for minutes to hours, and the energy price can change while
// it does. These tests cover how ohmigo lays a session out on the clock
// (profile.js) and what it sends ceme-v2 and shows the driver (quote.js).
// The pricing of each slice is ceme-v2's job and is tested there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SESSION_HOURS, sessionProfile, localTime, localOffset } from '../src/profile.js';
import { estimateSession } from '../src/charging.js';
import { quotePoint, rank } from '../src/quote.js';

const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('profile: one slice per quarter-hour, energy kept, first slice starts at the start', () => {
  // 30 min at 50 kW then 20 min at 15 kW, from 21:50 UTC.
  const p = sessionProfile([{ minutes: 30, kwh: 25 }, { minutes: 20, kwh: 5 }], new Date('2026-11-10T21:50:00Z'));
  assert.deepEqual(p.map(s => s.at.slice(11, 16)), ['21:50', '22:00', '22:15', '22:30']);
  assert.ok(near(sum(p, 'kwh'), 30));
  assert.ok(near(sum(p, 'minutes'), 50, 0.2));
  assert.deepEqual(p.map(s => s.kw), [50, 50, 26.7, 15]);
});

test('profile: a session that starts and ends inside one quarter is one slice', () => {
  const p = sessionProfile([{ minutes: 6, kwh: 2 }], new Date('2026-11-10T21:31:00Z'));
  assert.equal(p.length, 1);
  assert.equal(p[0].kwh, 2);
  assert.equal(p[0].kw, 20);
});

test('profile: no energy, no slices', () => {
  assert.deepEqual(sessionProfile([], new Date()), []);
});

test('profile: every segment shape from charging.js adds up', () => {
  const start = new Date('2026-11-10T20:07:00Z');
  const car = { batteryKwh: 64, startPct: 12, targetPct: 90, acKw: 11, dcKw: 150 };
  const cases = [
    [{ kw: 22, dc: false }, car],
    [{ kw: 150, dc: true }, car],
    [{ kw: 150, dc: true }, { ...car, dc10to80Minutes: 28 }],
    [{ kw: 50, dc: true }, { ...car, curve: [{ soc: 10, kw: 120 }, { soc: 50, kw: 90 }, { soc: 80, kw: 45 }, { soc: 100, kw: 10 }] }],
  ];
  for (const [point, c] of cases) {
    const s = estimateSession(point, c);
    assert.ok(near(sum(s.segments, 'minutes'), s.minutes), `segments = minutes (${point.kw} kW)`);
    assert.ok(near(sum(s.segments, 'kwh'), s.kwh), `segments = billed kWh (${point.kw} kW)`);
    const p = sessionProfile(s.segments, start);
    assert.ok(near(sum(p, 'kwh'), s.kwh, 0.01), 'profile keeps the kWh');
    assert.ok(p.every((x, i) => i === 0 || Date.parse(x.at) % 900_000 === 0), 'cut on quarter boundaries');
  }
});

test('profile: the October clock change (01:00-02:00 Lisbon happens twice)', () => {
  // 25 Oct 2026: 00:45Z is 01:45 summer time, 01:00Z is 01:00 winter time.
  const p = sessionProfile([{ minutes: 60, kwh: 60 }], new Date('2026-10-25T00:30:00Z'));
  assert.deepEqual(p.map(s => localTime(s.at)), ['01:30', '01:45', '01:00', '01:15']);
  assert.deepEqual(p.map(s => localOffset(s.at)), ['+01:00', '+01:00', '+00:00', '+00:00']);
  assert.ok(near(sum(p, 'kwh'), 60), 'a 60-minute session is 60 minutes, whatever the clock says');
});

test('profile: the March clock change (01:00-02:00 Lisbon never happens)', () => {
  const p = sessionProfile([{ minutes: 45, kwh: 30 }], new Date('2026-03-29T00:30:00Z'));
  assert.deepEqual(p.map(s => localTime(s.at)), ['00:30', '00:45', '02:00']);
});

test('profile: local time per region', () => {
  const at = '2026-11-10T22:00:00Z';
  assert.equal(localTime(at, 'CONT'), '22:00');
  assert.equal(localTime(at, 'MAD'), '22:00');
  assert.equal(localTime(at, 'AZO'), '21:00');
  assert.equal(localOffset(at, 'AZO'), '-01:00');
});

// quotePoint against a fake ceme-v2: what goes out, what comes back.
function fakeCeme({ withProfile = true } = {}) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith('/v1/session')) return new Response(JSON.stringify({ token: 't', expires_in: 3600 }));
    const body = JSON.parse(init.body);
    sent.push(body);
    const slices = (body.profile || []).map((s, i) => ({ at: s.at, kwh: s.kwh, period: i < 2 ? 'FORA_VAZIO' : 'VAZIO', final: i < 2 ? 0.2 : 0.12 }));
    const tariff = {
      id: 'edp-bt-cartao', ceme: 'EDP', name: 'Cartão', voltage: 'BT', popular: true, bundle: false,
      totalEur: 9.87, vat: 1.23, period: 'FORA_VAZIO', kind: 'FIXED',
      ...(withProfile && slices.length > 1 && { kwhByPeriod: { FORA_VAZIO: 20, VAZIO: 20 } }),
      ...(withProfile && body.detail && { slices }),
    };
    return new Response(JSON.stringify({
      at: body.at, kwh: body.kwh, region: body.region, omieSpot: null, data: [tariff],
      ...(withProfile && body.profile && { profile: { slices: body.profile.length, from: body.profile[0].at, to: body.profile.at(-1).at, withSpot: 0 } }),
    }));
  };
  return sent;
}

const site = { id: 'S1', code: 'X', region: 'CONT', operator: 'Op', city: 'Leiria', address: 'Rua' };
const point = { id: 'P1', kw: 22, dc: false, level: 'BTN', regime: 'mobie', opc: { REGULAR: { energy: [0.05] } } };
const car = { batteryKwh: 60, startPct: 20, targetPct: 80, acKw: 11 };

test('quote: sends the session as quarter-hour slices from the start', async () => {
  const sent = fakeCeme();
  const q = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T21:31:40Z'), lang: 'en' });
  const body = sent[0];
  assert.equal(body.profile[0].at, '2026-11-10T21:31:00.000Z', 'start rounded to the minute');
  assert.equal(body.profile[1].at, '2026-11-10T21:45:00.000Z');
  assert.ok(near(sum(body.profile, 'kwh'), q.session.kwhBilled, 0.01));
  assert.equal(body.at, body.profile[0].at, 'kwh and at still sent, for a ceme-v2 without profile');
  assert.equal(body.detail, false);
  assert.equal(q.session.startLocal, '21:31');
  assert.match(q.assumptions.join(' | '), /quarter-hour by quarter-hour .* from 21:31 to/);
  assert.deepEqual(q.options[0].kwhByPeriod, { FORA_VAZIO: 20, VAZIO: 20 });
  assert.equal(q.timeline, undefined, 'no timeline unless asked');
  assert.equal(q.debug, undefined);
});

// 60 % of 60 kWh on 11 kW AC takes just under 4 h.
const closing = { ...site, hours: 'Mo-Su 09:00-21:00' };
const closes = q => q.assumptions.filter(a => /, before the session ends|, antes de o carregamento acabar/.test(a));
const closedAtStart = q => q.assumptions.filter(a => /closed when the session starts|fechado à hora de início/.test(a));

test('quote: a site that closes before the session ends says so', async () => {
  fakeCeme();
  const q = await quotePoint({ site: closing, point }, car, { at: new Date('2026-11-10T20:00:00Z'), lang: 'en' });
  assert.equal(q.session.startLocal, '20:00');
  assert.deepEqual(closedAtStart(q), [], 'open when it starts');
  assert.match(closes(q)[0], /Mo-Su 09:00-21:00.*closes at 21:00, before the session ends \(expected at 23:\d\d/);
  const pt = await quotePoint({ site: closing, point }, car, { at: new Date('2026-11-10T20:00:00Z'), lang: 'pt' });
  assert.match(closes(pt)[0], /Mo-Su 09:00-21:00.*fecha às 21:00, antes de o carregamento acabar \(previsto para as 23:\d\d/);
});

test('quote: a closure on a later day says which day', async () => {
  fakeCeme();
  const late = { ...site, hours: 'Mo-Su 22:00-02:00' };
  const slow = { ...car, batteryKwh: 80 }; // about 5 h on 11 kW, from 23:00
  const en = await quotePoint({ site: late, point }, slow, { at: new Date('2026-11-10T23:00:00Z'), lang: 'en' });
  assert.match(closes(en)[0], /closes at 02:00 the next day, before/);
  const pt = await quotePoint({ site: late, point }, slow, { at: new Date('2026-11-10T23:00:00Z'), lang: 'pt' });
  assert.match(closes(pt)[0], /fecha às 02:00 do dia seguinte, antes/);
  const today = await quotePoint({ site: closing, point }, car, { at: new Date('2026-11-10T20:00:00Z'), lang: 'en' });
  assert.doesNotMatch(closes(today)[0], /next day/);
});

test('quote: a session ending exactly at closing time adds nothing', async () => {
  fakeCeme();
  const s = estimateSession(point, car);
  const q = await quotePoint({ site: closing, point }, car, { at: new Date(Date.parse('2026-11-10T21:00:00Z') - Math.ceil(s.minutes) * 60_000), lang: 'en' });
  assert.deepEqual(closes(q), []);
});

test('quote: a slow session open at both ends still crosses the closed night', async () => {
  fakeCeme();
  const slow = { ...car, batteryKwh: 80, acKw: 3.7 }; // about 15.5 h, ending mid-morning
  const q = await quotePoint({ site: closing, point }, slow, { at: new Date('2026-11-10T20:00:00Z'), lang: 'en' });
  assert.ok(q.session.endLocal >= '09:00' && q.session.endLocal < '21:00', q.session.endLocal);
  assert.equal(closes(q).length, 1);
});

test('quote: a session inside the opening hours, or hours we cannot read, adds nothing', async () => {
  fakeCeme();
  const inside = await quotePoint({ site: closing, point }, car, { at: new Date('2026-11-10T12:00:00Z'), lang: 'en' });
  assert.deepEqual(closes(inside), []);
  const unknown = await quotePoint({ site: { ...site, hours: 'Apr-Sep 08:30-20:00' }, point }, car, { at: new Date('2026-11-10T20:00:00Z'), lang: 'en' });
  assert.deepEqual([...closes(unknown), ...closedAtStart(unknown)], []);
});

test('quote: closed when it starts is the only warning, not two', async () => {
  fakeCeme();
  const q = await quotePoint({ site: closing, point }, car, { at: new Date('2026-11-10T22:00:00Z'), lang: 'en' });
  assert.equal(closedAtStart(q).length, 1);
  assert.deepEqual(closes(q), []);
});

test('quote: detail adds the timeline, qa the debug block', async () => {
  fakeCeme();
  const q = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T21:30:00Z'), lang: 'pt', detail: true });
  assert.equal(q.timeline.timeZone, 'Europe/Lisbon');
  assert.equal(q.timeline.slices[0].from, '21:30');
  assert.equal(q.timeline.slices[0].utcOffset, '+00:00');
  // Quarters with the same period and price are one run; the kWh add up.
  const runs = q.timeline.tariffs[0].runs;
  assert.deepEqual(runs.map(r => r.period), ['FORA_VAZIO', 'VAZIO']);
  assert.equal(runs[1].from, runs[0].to, 'runs are back to back');
  assert.equal(runs.reduce((a, r) => a + r.quarters, 0), q.timeline.quarters);
  assert.ok(near(runs.reduce((a, r) => a + r.kwh, 0), q.session.kwhBilled, 0.01));
  assert.equal(q.timeline.omieQuartersKnown, `0/${q.timeline.quarters}`);
  assert.equal(q.debug, undefined);
  const qa = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T21:30:00Z'), lang: 'pt', qa: true });
  assert.ok(qa.timeline, 'qa implies detail');
  assert.equal(qa.debug.profileSent.length, qa.timeline.quarters);
  assert.ok(qa.debug.segments.length >= 1);
});

test('quote: an older ceme-v2 that ignores the profile is flagged, not trusted', async () => {
  fakeCeme({ withProfile: false });
  const q = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T21:30:00Z'), lang: 'en' });
  assert.match(q.assumptions.join(' | '), /as if the whole session happened at 21:30/);
  assert.equal(q.options[0].kwhByPeriod, undefined);
});

test('sessionProfile: a session past the limit, or with no end, is refused before any slice is made', () => {
  const start = new Date('2026-11-10T21:30:00Z');
  const limit = MAX_SESSION_HOURS * 60;
  assert.ok(sessionProfile([{ minutes: limit, kwh: 10 }], start).length <= limit / 15 + 1);
  for (const minutes of [limit + 1, Infinity, NaN]) {
    assert.throws(() => sessionProfile([{ minutes, kwh: 10 }], start), RangeError, String(minutes));
  }
  assert.throws(() => sessionProfile([{ minutes: limit, kwh: 5 }, { minutes: limit, kwh: 5 }], start), RangeError);
});

test('quote: a session past the limit gets no quote and costs no ceme-v2 call, on every path', async () => {
  const sent = fakeCeme();
  const big = { batteryKwh: 250, startPct: 0, targetPct: 100 };
  const slow = [
    [point, { ...big, acKw: 1 }],
    [{ ...point, kw: 50, dc: true }, { ...big, dcKw: 1 }],
    [{ ...point, kw: 50, dc: true }, { ...big, dc10to80Minutes: 300 * 20, dcKw: 1 }],
    [{ ...point, kw: 50, dc: true }, { ...big, curve: [{ soc: 0, kw: 0.001 }, { soc: 100, kw: 0.001 }] }],
  ];
  for (const [p, c] of slow) assert.equal(await quotePoint({ site, point: p }, c, { lang: 'en' }), null, JSON.stringify(c));
  assert.equal(sent.length, 0);
});

test('rank: leaves out what would take too long, counts it, and still ranks the rest', async () => {
  fakeCeme();
  const slowAc = { ...point, id: 'P2', kw: 3.7 };
  const fast = { ...point, id: 'P3', kw: 50, dc: true };
  const r = await rank([{ site, points: [slowAc, fast] }], { batteryKwh: 250, startPct: 0, targetPct: 100 }, { lang: 'en' });
  assert.deepEqual(r.map(q => q.pointId), ['S1/P3']);
  assert.equal(r.tooLong, 1);
});

test('rank: what the driver\'s own filters drop does not count as too long', async () => {
  fakeCeme();
  const slowAc = { ...point, id: 'P2', kw: 3.7 };
  const fast = { ...point, id: 'P3', kw: 50, dc: true };
  const big = { batteryKwh: 250, startPct: 0, targetPct: 100 };
  const inTime = await rank([{ site, points: [slowAc, fast] }], big, { lang: 'en', maxMinutes: 10 });
  assert.deepEqual([inTime.length, inTime.tooLong], [0, 0]);
  const busy = { get: () => ({ status: 'charging', fees: [] }) };
  const free = await rank([{ site, points: [slowAc] }], big, { lang: 'en', live: busy, availableOnly: true });
  assert.deepEqual([free.length, free.tooLong], [0, 0]);
  const longer = await rank([{ site, points: [slowAc, fast] }], big, { lang: 'en', maxMinutes: 100_000 });
  assert.deepEqual([longer.length, longer.tooLong], [1, 1]);
});
