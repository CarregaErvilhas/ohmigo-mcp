// The eval harness (evals/) runs with a model, outside npm test. What can be
// checked without one is checked here: the matchers grade.mjs relies on, and
// that every case in cases.json is well formed, so a broken case shows up now
// and not in the middle of a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CACHE, ROOT, RUNS, callMatches, checkCase, checkJudge, dated, linkModules, matchValue } from '../evals/lib.mjs';

const { cases } = JSON.parse(readFileSync(new URL('../evals/cases.json', import.meta.url), 'utf8'));
const TOOLS = ['list_ceme_tariffs', 'lookup_charger', 'find_chargers', 'list_operators', 'find_cheapest_charging', 'estimate_charging_cost'];

test('evals: matchers', () => {
  assert.equal(matchValue(undefined, false), true);
  assert.equal(matchValue('x', true), true);
  assert.equal(matchValue(52, [48, 56]), true);
  assert.equal(matchValue('52', [48, 56]), false);
  assert.equal(matchValue(['viaverde-bt-x'], 'viaverde-'), true);
  assert.equal(matchValue({ 'goldenergy-bt-clientesgold': 12 }, 'goldenergy[^"]*":12(\\.0+)?[,}]'), true);
  assert.equal(matchValue({ 'goldenergy-bt-clientesgold': 120 }, 'goldenergy[^"]*":12(\\.0+)?[,}]'), false);
  assert.equal(matchValue(undefined, 'x'), false);
  const call = { tool: 'estimate_charging_cost', args: { site: 'LRA-00156', lang: 'pt' }, isError: true };
  assert.equal(callMatches(call, { tool: 'estimate_charging_cost|lookup_charger', args: { site: 'lra-00156' } }), true);
  assert.equal(callMatches(call, { tool: 'estimate', args: {} }), false, 'tool matches the whole name');
  assert.equal(callMatches(call, { tool: 'estimate_charging_cost', ok: true }), false, 'ok skips errors');
  assert.equal(callMatches(call, { args: { '*': '"lang":"pt"' } }), true);
});

test('evals: a case is graded on calls and answer, judge verdicts on yes/no/n/a', () => {
  const calls = [{ tool: 'list_ceme_tariffs', args: { lang: 'pt' } }, { tool: 'estimate_charging_cost', args: { lang: 'pt', audiences: ['edp-staff'] } }];
  const r = checkCase({
    calls: [{ tool: 'list_ceme_tariffs' }], noCalls: [{ args: { audiences: true } }],
    every: { args: { lang: '^pt' } }, answer: { match: ['€'], noMatch: ['identificador'] },
  }, calls, 'Custa 5 €.');
  assert.deepEqual(r.map(x => x.pass), [true, false, true, true, true]);
  assert.match(r[1].got, /edp-staff/);
  assert.deepEqual(checkJudge(['a', 'b', 'c', 'd'], { 1: 'yes', 2: 'n/a', 3: 'No' }).map(x => x.pass), [true, true, false, null]);
  assert.equal(checkCase({ answer: { noMatch: ['x'] } }, [], null)[0].pass, false, 'no answer never passes');
});

test('evals: only "yes" and "n/a" pass a judge question', () => {
  const pass = v => checkJudge(['q'], { 1: v })[0].pass;
  for (const v of ['yes', 'Yes', ' n/a ', 'N/A']) assert.equal(pass(v), true, v);
  for (const v of ['no', 'no, it omits the fee', 'not really', 'maybe', 'yes, but only partly']) assert.equal(pass(v), false, v);
});

const scratch = t => {
  const dir = mkdtempSync(join(tmpdir(), 'ohmigo-evals-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
// A process that sits there; `args` end up on its command line.
const idle = (t, ...args) => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], { stdio: 'ignore' });
  t.after(() => p.kill('SIGKILL'));
  return p;
};
const stop = dir => spawnSync(process.execPath, ['evals/serve.mjs', 'stop', dir], { cwd: ROOT, encoding: 'utf8' });
const running = p => p.exitCode === null && p.signalCode === null;

test('evals: stop leaves alone a pid that went to another process', async t => {
  const dir = scratch(t);
  const other = idle(t);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ pid: other.pid }));
  stop(dir);
  await sleep(200);
  assert.ok(running(other), 'killed a process that was not ours');
});

test('evals: stop still stops a serve.mjs', async t => {
  const dir = scratch(t);
  const ours = idle(t, 'evals/serve.mjs', '--variant', 'full');
  await sleep(200); // until exec has replaced the command line
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ pid: ours.pid }));
  assert.match(stop(dir).stdout, /stopped/);
  await Promise.race([once(ours, 'exit'), sleep(2000)]);
  assert.ok(!running(ours));
});

// Runs serve.mjs with a preload that notes every node process it starts, so
// the test can see the server child even after serve.mjs is gone.
async function serveWatched(t, args, preload = '') {
  const dir = scratch(t);
  const pids = join(dir, 'pids');
  writeFileSync(pids, '');
  writeFileSync(join(dir, 'preload.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(pids)}, process.pid + ' ' + process.argv.slice(1).join(' ') + '\\n');
${preload}`);
  const proc = spawn(process.execPath, ['evals/serve.mjs', ...args], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: `--import=${join(dir, 'preload.mjs')}` },
  });
  let stderr = '';
  proc.stderr.on('data', c => { stderr += c; });
  const [code] = await once(proc, 'exit');
  const servers = readFileSync(pids, 'utf8').split('\n').filter(l => l.includes('src/server.js')).map(l => Number(l.split(' ')[0]));
  t.after(() => { for (const pid of servers) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  return { code, stderr, servers };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('evals: a typo in --cases stops before any server starts', { timeout: 150_000 }, async t => {
  const { code, stderr, servers } = await serveWatched(t, ['--cases', 'typo']);
  assert.notEqual(code, 0);
  assert.match(stderr, /unknown case in --cases: typo/);
  assert.deepEqual(servers, []);
});

test('evals: a failure after the server started takes the server down too', {
  timeout: 60_000, skip: !existsSync(join(CACHE, 'chargers.json')) && 'needs the frozen dataset in evals/.cache',
}, async t => {
  // Only the parent's calls to the server fail.
  const { code, servers } = await serveWatched(t, ['--cases', cases[0].id], `if (process.argv[1]?.endsWith('serve.mjs')) globalThis.fetch = () => Promise.reject(new Error('no answer'));`);
  assert.notEqual(code, 0);
  assert.equal(servers.length, 1);
  for (let i = 0; i < 50 && alive(servers[0]); i++) await sleep(100);
  assert.ok(!alive(servers[0]), 'the server was left running');
});

test('evals: a dangling node_modules link in a ref cache is replaced', t => {
  const dir = scratch(t);
  symlinkSync(join(dir, 'gone'), join(dir, 'node_modules'));
  linkModules(dir);
  assert.equal(readlinkSync(join(dir, 'node_modules')), join(ROOT, 'node_modules'));
  linkModules(dir); // already fine: nothing to do
});

test('evals: a real node_modules in a ref cache stays', t => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'node_modules'));
  linkModules(dir);
  assert.ok(lstatSync(join(dir, 'node_modules')).isDirectory());
});

test('evals: call.mjs refuses a tool name that is not one', t => {
  mkdirSync(RUNS, { recursive: true });
  const run = mkdtempSync(join(RUNS, 'test-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  const dir = join(run, 'case');
  mkdirSync(join(dir, 'results'), { recursive: true });
  writeFileSync(join(dir, 'brief.md'), '');
  // Nothing listens there: a name that passes gets as far as "not answering".
  writeFileSync(join(run, 'manifest.json'), JSON.stringify({ url: 'http://127.0.0.1:9' }));
  const call = tool => spawnSync(process.execPath, ['evals/call.mjs', dir, tool, '{}'], { cwd: ROOT, encoding: 'utf8' });
  for (const bad of ['../../../x', 'a/b', 'Lookup', 'x y', 'tool.txt']) {
    const r = call(bad);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /tool name/, bad);
  }
  assert.equal(call('lookup_charger').status, 3);
});

test('evals: {{month}} and {{year}} become the current ones, in Portuguese', () => {
  assert.equal(dated('em {{month}} de {{year}}', new Date('2026-10-31T12:00:00Z')), 'em outubro de 2026');
});

test('evals: every case is well formed', () => {
  const ids = new Set();
  for (const c of cases) {
    assert.match(c.id, /^[a-z0-9-]+$/, c.id);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.why && c.message, `${c.id}: why and message`);
    const e = c.expect ?? {};
    const exps = [...(e.calls ?? []), ...(e.noCalls ?? []), ...(e.every ? [e.every] : [])];
    assert.ok(exps.length || e.answer || e.judge?.length, `${c.id}: expects nothing`);
    for (const x of exps) {
      // Every tool a case names exists, so a renamed tool fails here.
      if (x.tool) for (const name of x.tool.split('|')) assert.ok(TOOLS.includes(name), `${c.id}: unknown tool ${name}`);
      for (const [k, m] of Object.entries(x.args ?? {})) {
        if (typeof m === 'string') new RegExp(m, 'i');
        else assert.ok(typeof m === 'boolean' || (Array.isArray(m) && m.length === 2 && m.every(n => typeof n === 'number')), `${c.id}: bad matcher for ${k}`);
      }
    }
    for (const re of [...(e.answer?.match ?? []), ...(e.answer?.noMatch ?? [])]) new RegExp(re, 'i');
    for (const r of c.requires ?? []) assert.ok(r.site || r.tariff != null || r.promo != null, `${c.id}: requirement ${JSON.stringify(r)}`);
  }
});
