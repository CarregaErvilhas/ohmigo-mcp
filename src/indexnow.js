// IndexNow (https://www.indexnow.org) tells Bing, and the other engines that
// share submissions, which URLs to crawl again. Google doesn't take part: it
// reads the sitemap. server.js sends the sitemap's URLs once per process start
// when INDEXNOW=on (zerops.yml), that is, after every deploy.
//
// The key is not a secret: it's served at /<key>.txt so the engine can check
// that whoever submits controls the host. The group's other sites use the same.
export const INDEXNOW_KEY = '5162276ff8f52857dee877725610e84e';
const ENDPOINT = 'https://api.indexnow.org/indexnow';

// A failure is only logged: the sitemap is still there for the next crawl.
export async function indexNowSubmit(origin, urls, { fetchImpl = fetch, log = console } = {}) {
  const host = new URL(origin).host;
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation: `${origin}/${INDEXNOW_KEY}.txt`, urlList: urls }),
      signal: AbortSignal.timeout(30_000),
    });
    log.log(`[indexnow] ${host}: HTTP ${res.status}, ${urls.length} URLs`);
  } catch (e) {
    log.warn(`[indexnow] ${host}: ${e.message}`);
  }
}
