// The small line in front of ceme-v2 and the rankings. The rest of what it does
// is tested through its users (ceme-load.test.js, rank-load.test.js).
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { limiter, MAX_WAIT_MS } from '../src/limit.js';

afterEach(() => mock.timers.reset());

const line = () => limiter({ concurrent: 1, queued: 2, full: () => new Error('refused'), gone: () => new Error('gone') });
const settle = () => new Promise(r => setImmediate(r));

test('past MAX_WAIT_MS a job in line is refused like a full line, and its place is freed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const run = line();
  let finish;
  const first = run(() => new Promise(r => { finish = r; }));
  const late = run(async () => assert.fail('must not run'));
  mock.timers.tick(MAX_WAIT_MS - 1);
  await settle();
  const next = run(async () => 'ran');
  mock.timers.tick(1);
  await assert.rejects(late, /refused/);
  finish();
  await first;
  assert.equal(await next, 'ran', 'the line moves on');
});

test('a job that got its turn in time is not refused later', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const run = line();
  let finish;
  const first = run(() => new Promise(r => { finish = r; }));
  const second = run(async () => { await settle(); return 'ran'; });
  finish();
  await first;
  mock.timers.tick(MAX_WAIT_MS * 2);
  assert.equal(await second, 'ran');
});
