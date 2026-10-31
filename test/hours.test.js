// Opening hours in OpenStreetMap syntax, read in the site's time zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closesDuring, isOpen, parseHours, siteOpen } from '../src/hours.js';

// 2026-11-02 is a Monday; Lisbon is on UTC+0 then.
const at = (iso) => new Date(iso);

test('hours: 24/7, every day, weekdays and a closed day', () => {
  assert.equal(isOpen('24/7', at('2026-11-02T03:00:00Z'), 'CONT'), true);
  assert.equal(isOpen('09:00-21:00', at('2026-11-02T21:00:00Z'), 'CONT'), false);
  assert.equal(isOpen('Mo-Su 09:00-21:00', at('2026-11-02T20:59:00Z'), 'CONT'), true);
  assert.equal(isOpen('Mo-Fr 08:00-19:00; Sa 08:00-13:00', at('2026-11-01T10:00:00Z'), 'CONT'), false); // Sunday
  assert.equal(isOpen('Mo-Su 08:00-22:00; Mo off', at('2026-11-02T10:00:00Z'), 'CONT'), false); // later rule wins
});

test('hours: a range past midnight runs into the next day', () => {
  assert.equal(isOpen('Fr 22:00-02:00', at('2026-11-07T01:00:00Z'), 'CONT'), true); // Saturday 01:00
  assert.equal(isOpen('Fr 22:00-02:00', at('2026-11-07T03:00:00Z'), 'CONT'), false);
});

test('hours: the site\'s own time zone (the Azores are an hour behind)', () => {
  assert.equal(isOpen('Mo-Su 09:00-21:00', at('2026-11-02T21:30:00Z'), 'AZO'), true);
  assert.equal(isOpen('Mo-Su 09:00-21:00', at('2026-11-02T21:30:00Z'), 'CONT'), false);
});

test('hours: what the parser does not know is unknown, not a guess', () => {
  assert.equal(parseHours('Apr-Sep 08:30-20:00'), null);
  assert.equal(isOpen('Mo-Su 09:00-21:00; PH off', at('2026-11-02T10:00:00Z'), 'CONT'), null);
  assert.equal(isOpen(undefined, new Date(), 'CONT'), null);
});

test('hours: a site is open only when every source with hours says so', () => {
  const site = { region: 'CONT', hours: '24/7', osm: { openingHours: 'Mo-Su 09:00-21:00' } };
  assert.deepEqual(siteOpen(site, at('2026-11-02T23:00:00Z')), { open: false, nap: '24/7', osm: 'Mo-Su 09:00-21:00', disagree: true });
  assert.equal(siteOpen(site, at('2026-11-02T12:00:00Z')).open, true);
  assert.equal(siteOpen({ region: 'CONT' }).open, null);
});

test('hours: closesDuring gives the first closed instant, at the end of the session or inside it', () => {
  const site = { region: 'CONT', hours: 'Mo-Su 09:00-21:00' };
  const closes = (from, to, x = site) => closesDuring(x, at(from), at(to))?.toISOString() ?? null;
  assert.equal(closes('2026-11-02T20:00:00Z', '2026-11-02T20:59:00Z'), null);
  assert.equal(closes('2026-11-02T20:00:00Z', '2026-11-02T23:00:00Z'), '2026-11-02T21:00:00.000Z');
  // The exact minute, whatever the start: a walk in quarters alone says 21:07.
  assert.equal(closes('2026-11-02T20:07:00Z', '2026-11-02T23:00:00Z'), '2026-11-02T21:00:00.000Z');
  // Open at both ends, closed all night in between.
  assert.equal(closes('2026-11-02T20:00:00Z', '2026-11-03T10:00:00Z'), '2026-11-02T21:00:00.000Z');
  // A lunch break inside the session.
  assert.equal(closes('2026-11-02T12:00:00Z', '2026-11-02T14:30:00Z', { region: 'CONT', hours: 'Mo-Su 09:00-12:30,14:00-21:00' }), '2026-11-02T12:30:00.000Z');
  // Past midnight, the day after the start.
  assert.equal(closes('2026-11-02T23:00:00Z', '2026-11-03T04:00:00Z', { region: 'CONT', hours: 'Mo-Su 22:00-02:00' }), '2026-11-03T02:00:00.000Z');
  // The other source closes it: either one is enough.
  assert.equal(closes('2026-11-02T20:00:00Z', '2026-11-02T23:00:00Z', { region: 'CONT', hours: '24/7', osm: { openingHours: 'Mo-Su 09:00-22:00' } }), '2026-11-02T22:00:00.000Z');
});

test('hours: a session ending exactly at closing time fits', () => {
  const site = { region: 'CONT', hours: 'Mo-Su 09:00-21:00' };
  assert.equal(closesDuring(site, at('2026-11-02T20:00:00Z'), at('2026-11-02T21:00:00Z')), null);
  assert.deepEqual(closesDuring(site, at('2026-11-02T20:00:00Z'), at('2026-11-02T21:01:00Z')), at('2026-11-02T21:00:00Z'));
});

test('hours: closesDuring never guesses, and 24/7 or unknown hours do no work', () => {
  const walks = (hours, osm) => {
    let reads = 0;
    const site = { region: 'CONT', get hours() { reads++; return hours; }, osm: { openingHours: osm } };
    assert.equal(closesDuring(site, at('2026-11-02T20:00:00Z'), at('2026-11-03T10:00:00Z')), null);
    return reads;
  };
  assert.equal(walks('24/7', undefined), 1, 'only the check before the walk');
  assert.equal(walks('24/7', '24/7'), 1);
  assert.equal(walks('Apr-Sep 08:30-20:00', undefined), 1);
  assert.equal(walks(undefined, undefined), 1);
});
