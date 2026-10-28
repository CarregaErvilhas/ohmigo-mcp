// A session runs for minutes to hours, and the energy price can change while
// it does. These tests cover how ohmigo lays a session out on the clock
// (profile.js) and what it sends ceme-v2 and shows the driver (quote.js).
// The pricing of each slice is ceme-v2's job and is tested there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionProfile, localTime, localOffset } from '../src/profile.js';
import { estimateSession } from '../src/charging.js';
import { quotePoint } from '../src/quote.js';

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

test('quote: detail adds the timeline, qa the debug block', async () => {
  fakeCeme();
  const q = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T21:30:00Z'), lang: 'pt', detail: true });
  assert.equal(q.timeline.timeZone, 'Europe/Lisbon');
  assert.equal(q.timeline.slices[0].local, '21:30');
  assert.equal(q.timeline.slices[0].utcOffset, '+00:00');
  assert.deepEqual(q.timeline.tariffs[0].slices.slice(1, 3).map(s => s.period), ['FORA_VAZIO', 'VAZIO']);
  assert.equal(q.timeline.omieQuartersKnown, `0/${q.timeline.slices.length}`);
  assert.equal(q.debug, undefined);
  const qa = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T21:30:00Z'), lang: 'pt', qa: true });
  assert.ok(qa.timeline, 'qa implies detail');
  assert.equal(qa.debug.profileSent.length, qa.timeline.slices.length);
  assert.ok(qa.debug.segments.length >= 1);
});

test('quote: an older ceme-v2 that ignores the profile is flagged, not trusted', async () => {
  fakeCeme({ withProfile: false });
  const q = await quotePoint({ site, point }, car, { at: new Date('2026-11-10T21:30:00Z'), lang: 'en' });
  assert.match(q.assumptions.join(' | '), /as if the whole session happened at 21:30/);
  assert.equal(q.options[0].kwhByPeriod, undefined);
});
