// The guards on a downloaded dataset (Dataset.load): a byte cap, a floor of
// sites, and no hot reload that loses most of the network. Plus the server
// keeping its copy and saying so on /healthz when a reload is refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Dataset, DatasetRefused, MAX_DATASET_BYTES, MIN_RATIO, MIN_SITES } from '../src/data.js';

const site = (i, points = 1) => ({
  id: `S${i}`, code: `S${i}`, lat: 39.7, lon: -8.8, region: 'CONT', city: 'Leiria', operator: 'X', operatorId: 'XX',
  points: Array.from({ length: points }, (_, j) => ({ id: String(j + 1), kw: 22 })),
});
const dataset = (n, points = 1) => ({ schema: 1, generatedAt: new Date().toISOString(), sites: Array.from({ length: n }, (_, i) => site(i, points)) });

// Serves whatever `body` holds at the moment of the request.
let body = '';
const origin = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', etag: `"${body.length}"` }); res.end(body); }).listen(0, '127.0.0.1');
await once(origin, 'listening');
const url = `http://127.0.0.1:${origin.address().port}/chargers.json`;
after(() => origin.close());

async function remote(raw, opts) {
  body = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const saved = { path: process.env.DATASET_PATH, url: process.env.DATASET_URL };
  delete process.env.DATASET_PATH;
  process.env.DATASET_URL = url;
  try { return await Dataset.load(opts); } finally {
    if (saved.path === undefined) delete process.env.DATASET_PATH; else process.env.DATASET_PATH = saved.path;
    if (saved.url === undefined) delete process.env.DATASET_URL; else process.env.DATASET_URL = saved.url;
  }
}

test('dataset guards: a download with enough sites loads', async () => {
  const ds = await remote(dataset(MIN_SITES));
  assert.equal(ds.sites.length, MIN_SITES);
});

test('dataset guards: a download under MIN_SITES fails at boot', async () => {
  await assert.rejects(remote(dataset(MIN_SITES - 1)), DatasetRefused);
});

test('dataset guards: a local file has no floor (tests and development use small ones)', async () => {
  const saved = process.env.DATASET_PATH;
  process.env.DATASET_PATH = 'test/fixtures/chargers.json';
  try { assert.ok((await Dataset.load()).sites.length < MIN_SITES); } finally {
    if (saved === undefined) delete process.env.DATASET_PATH; else process.env.DATASET_PATH = saved;
  }
});

test('dataset guards: a reload with under MIN_RATIO of the sites in memory is refused', async () => {
  const previous = await remote(dataset(4 * MIN_SITES));
  const n = Math.floor(4 * MIN_SITES * MIN_RATIO) - 1;
  await assert.rejects(remote(dataset(n), { previous }), e => e instanceof DatasetRefused && /sites/.test(e.message));
  assert.equal((await remote(dataset(n + 1), { previous })).sites.length, n + 1);
});

test('dataset guards: a reload that keeps the sites but loses most points is refused', async () => {
  const previous = await remote(dataset(MIN_SITES, 4));
  await assert.rejects(remote(dataset(MIN_SITES, 1), { previous }), e => e instanceof DatasetRefused && /points/.test(e.message));
});

test('dataset guards: a body over MAX_DATASET_BYTES is refused', async () => {
  await assert.rejects(remote(' '.repeat(MAX_DATASET_BYTES + 1)), DatasetRefused);
});

test('dataset guards: the server keeps its dataset and names the refusal on /healthz', async () => {
  body = JSON.stringify(dataset(2 * MIN_SITES));
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', DATASET_URL: url, DATASET_CHECK_HOURS: String(0.3 / 3600),
    CEME_API_URL: 'http://127.0.0.1:9', CEME_API_KEY: '', NAP_STATUS_URL: 'http://127.0.0.1:9/live', LIVE_WARMUP: '0', HEALTHZ_TOKEN: '' };
  delete env.DATASET_PATH;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  after(() => child.kill());
  const base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', c => { out += c; const m = out.match(/http:\/\/(\S+?)\/mcp/); if (m) resolve(`http://${m[1]}`); });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${out}`)));
  });
  const healthz = () => fetch(`${base}/healthz`).then(r => r.json());
  assert.ok(!(await healthz()).problems.includes('dataset: last update refused'));
  body = JSON.stringify(dataset(10));
  let h;
  for (let i = 0; i < 50; i++) {
    h = await healthz();
    if (h.problems.includes('dataset: last update refused')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(h.problems.includes('dataset: last update refused'), JSON.stringify(h.problems));
  assert.equal(h.status, 'degraded');
  // A good file clears it.
  body = JSON.stringify(dataset(2 * MIN_SITES + 1));
  for (let i = 0; i < 50; i++) {
    h = await healthz();
    if (!h.problems.includes('dataset: last update refused')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(!h.problems.includes('dataset: last update refused'));
});
