import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEXNOW_KEY, indexNowSubmit } from '../src/indexnow.js';
import { SITEMAP, SITEMAP_URLS, SITE_URL } from '../src/site.js';

test('indexnow: submits every sitemap URL, for its own host, with the key file', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push([url, JSON.parse(opts.body)]); return { status: 202 }; };
  await indexNowSubmit(SITE_URL, SITEMAP_URLS, { fetchImpl, log: { log() {}, warn() {} } });
  const [[url, body]] = sent;
  assert.equal(url, 'https://api.indexnow.org/indexnow');
  assert.equal(body.keyLocation, `${SITE_URL}/${INDEXNOW_KEY}.txt`);
  assert.deepEqual(body.urlList, [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
  assert.ok(body.urlList.includes(`${SITE_URL}/grupo`));
});

test('indexnow: a network failure is logged, never thrown', async () => {
  const warned = [];
  await indexNowSubmit(SITE_URL, SITEMAP_URLS, { fetchImpl: async () => { throw new Error('offline'); }, log: { log() {}, warn: m => warned.push(m) } });
  assert.match(warned[0], /offline/);
});
