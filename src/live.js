// Live charger status and NAP fees from MOBI.E's DATEX II status feed.
//
// The feed is one ~38 MB XML file with no gzip and no byte ranges (13-20 s to
// download). It's fetched on demand: a request that finds the copy older than
// the TTL triggers one refresh, every concurrent request shares it, and the
// next users within the TTL get it for free. A copy past the TTL is still
// good enough for a while (LIVE_MAX_STALE_SECONDS): the request answers with
// it at once, flagged stale, and the refresh runs behind it. Only with no copy,
// or one older than that, does a request wait, and only up to a budget; past
// that it answers with what there is, and the refresh carries on for whoever
// asks next. So a status can be that old, or older while the feed is down, and
// the result says so (fresh: false, and a note with its age, see outdated in
// info()).
//
// Refreshes use If-None-Match (304 with no body when unchanged) and parse the
// body as a stream, so the 38 MB never sit in memory as text. In practice the
// feed is regenerated every minute or two, so a 304 is rare and almost every
// refresh is a full download: that's why the TTL is 15 min, not 5 (~96
// downloads a day per instance instead of 288). Results carry publishedAt, so
// the assistant can say how old the status is.
//
// When the feed is down, failed refreshes back off (30 s, 1, 2, 5 min) instead
// of starting another 38 MB download on every request.

import { SaxesParser } from 'saxes';

const URL_ = process.env.NAP_STATUS_URL || 'https://pgm.mobie.pt/integration/nap/evActualStatus';
const TTL_MS = Number(process.env.LIVE_TTL_SECONDS || 900) * 1000;
const WAIT_MS = Number(process.env.LIVE_WAIT_SECONDS || 25) * 1000;
const MAX_STALE_MS = Number(process.env.LIVE_MAX_STALE_SECONDS || 3600) * 1000;

// Point ids are only unique within a site (some operators publish bare
// numbers that repeat), so entries are keyed "SITE/POINT".
export const pointKey = (siteId, pointId) => `${siteId}/${pointId}`;

// Parses the feed from an async iterable of byte chunks.
export async function parseStatus(chunks) {
  const points = new Map();
  let publicationTime = null;
  const p = new SaxesParser({ xmlns: true });
  const stack = [];
  let text = '';
  let site = null, point = null, policy = null, fee = null;

  p.on('opentag', n => {
    stack.push(n.local);
    text = '';
    if (n.local === 'energyInfrastructureSiteStatus') site = null;
    else if (n.local === 'refillPointStatus') point = { status: null, fees: [] };
    // The first <reference> inside a site / refill point is its own id.
    else if (n.local === 'reference') {
      if (point) point.id ??= n.attributes.id?.value;
      else site ??= n.attributes.id?.value;
    } else if (n.local === 'energyPricingPolicy') { policy = null; fee = null; }
  });
  p.on('text', t => { text += t; });
  p.on('closetag', n => {
    stack.pop();
    const v = text.trim();
    switch (n.local) {
      case 'publicationTime': if (stack.length === 1) publicationTime = v; break;
      case 'status': if (point) point.status = v; break;
      case 'pricingPolicy': policy = v; break;
      case 'minimumDeliveryFee': fee = Number(v); break;
      case 'energyPricingPolicy':
        if (point && policy && Number.isFinite(fee)) point.fees.push({ policy, eur: fee });
        break;
      case 'refillPointStatus':
        if (point?.id) points.set(pointKey(site, point.id), { status: point.status, fees: point.fees });
        point = null;
        break;
    }
    text = '';
  });
  let err = null;
  p.on('error', e => { err = e; });

  const dec = new TextDecoder();
  for await (const c of chunks) {
    p.write(dec.decode(c, { stream: true }));
    if (err) throw err;
  }
  p.close();
  if (err) throw err;
  return { publicationTime, points };
}

// NAP fees -> the same plan shape as the MOBI.E tariff file (see opc.js).
// pricePerChargingTime is €/min, like MOBI.E's TIME (checked against the
// MOBI.E file: 79 % match to the cent, the rest are tiered there). NAP rounds
// to the cent and has no tiers, so the MOBI.E file wins when it has the socket.
export function napPlan(fees) {
  const plan = {};
  const add = (k, v) => { (plan[k] ||= []).includes(v) || plan[k].push(v); };
  for (const f of fees) {
    if (f.policy === 'flatRate') add('flat', f.eur);
    else if (f.policy === 'pricePerDeliveryUnit') add('energy', f.eur);
    else if (f.policy === 'pricePerChargingTime') (plan.time ||= []).push({ eur: f.eur, from: 0, to: null });
  }
  return Object.keys(plan).length ? plan : null;
}

// The NAP's €/kWh for a socket outside MOBI.E (lp: its live entry, if any).
// The live per-kWh fee wins. The static price from the dataset stands in only
// when the live feed has no fees for the socket: when it has fees and none is
// per kWh (a per-minute or flat price), the static one no longer describes it.
export function napEurPerKwh(lp, staticPrice) {
  if (!lp?.fees.length) return staticPrice;
  return lp.fees.find(f => f.policy === 'pricePerDeliveryUnit')?.eur;
}

const sleep = ms => new Promise(r => setTimeout(r, ms).unref());
// ±10 %, so two instances started together drift apart instead of
// downloading in lockstep.
const jitter = ms => ms * (0.9 + Math.random() * 0.2);
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
// A body cut mid-file (seen: "unclosed tag") or a reset connection is worth
// one immediate retry; an HTTP error or a refused connection is not, the
// backoff handles those.
const retryable = e => /unclosed|unexpected end|ECONNRESET|terminated|socket/i.test(`${e.message} ${e.cause?.code ?? ''}`);

export class LiveStatus {
  constructor({ ttlMs = TTL_MS, waitMs = WAIT_MS, maxStaleMs = MAX_STALE_MS, fetchImpl = fetch } = {}) {
    this.ttlMs = ttlMs;
    this.waitMs = waitMs;
    this.maxStaleMs = maxStaleMs;
    this.fetch = fetchImpl;
    this.points = new Map();
    this.publicationTime = null;
    this.fetchedAt = null;
    this.etag = null;
    this.running = null;
    this.lastError = null;
    this.failures = 0;
    this.retryAt = 0;
    this.freshUntil = 0;
    this.bytesLast = null;
  }

  get(siteId, pointId) { return this.points.get(pointKey(siteId, pointId)) || null; }

  fresh() { return this.fetchedAt != null && Date.now() < this.freshUntil; }

  // Past the TTL, but still worth answering with rather than making someone
  // wait for a 38 MB download.
  usable() { return this.fetchedAt != null && Date.now() - this.fetchedAt < this.maxStaleMs; }

  // Makes sure a refresh is on its way when the copy is past the TTL. With a
  // usable copy the caller goes on at once; otherwise it waits up to the
  // budget. `onWait` runs once when the caller is going to wait, so the tool
  // can tell the user why.
  async ensure({ onWait } = {}) {
    if (this.fresh()) return;
    // Backing off after a failure: answer with what we have, right away.
    if (!this.running && Date.now() < this.retryAt) return;
    const refresh = this.refresh();
    if (this.usable()) return;
    onWait?.();
    await Promise.race([refresh, sleep(this.waitMs)]);
  }

  refresh() {
    if (this.running) return this.running;
    if (Date.now() < this.retryAt) return Promise.resolve();
    this.running = (async () => {
      const t0 = Date.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await this.fetchOnce();
          this.lastError = null;
          this.failures = 0;
          this.retryAt = 0;
          console.log(`[ohmigo] live: ${this.points.size} points, published ${this.publicationTime}, ${this.bytesLast ?? '?'} bytes, ${Date.now() - t0} ms`);
          break;
        } catch (e) {
          this.lastError = e.message;
          console.warn(`[ohmigo] live refresh attempt ${attempt} failed, keeping previous data:`, e.message);
          if (attempt === 2 || !retryable(e)) {
            const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
            this.failures++;
            this.retryAt = Date.now() + jitter(wait);
            break;
          }
        }
      }
      this.running = null;
    })();
    return this.running;
  }

  async fetchOnce() {
    const res = await this.fetch(URL_, {
      headers: this.etag ? { 'if-none-match': this.etag } : {},
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 304) { this.markFetched(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { publicationTime, points } = await parseStatus(res.body);
    if (points.size < 1000) throw new Error(`only ${points.size} points parsed`);
    this.points = points;
    this.publicationTime = publicationTime;
    this.etag = res.headers.get('etag');
    this.bytesLast = Number(res.headers.get('content-length')) || null;
    this.markFetched();
  }

  markFetched() {
    this.fetchedAt = Date.now();
    this.freshUntil = this.fetchedAt + jitter(this.ttlMs);
  }

  // The copy and its flags as of now, for one request. A background refresh
  // can land while the request is pricing (ceme-v2 takes a moment), and an
  // answer built on the old copy must not come out labelled fresh.
  snapshot() {
    const { points } = this, info = this.info();
    return { get: (siteId, pointId) => points.get(pointKey(siteId, pointId)) || null, info: () => info };
  }

  // How old the data itself is. publicationTime, not fetchedAt: a 304 moves
  // fetchedAt on, and a publisher that has stalled keeps answering 304 with
  // the same old file. fetchedAt only stands in if the time doesn't parse.
  ageMs() {
    if (this.fetchedAt == null) return null;
    // Never less than since we fetched it: a clock ahead of ours can't make it new.
    const published = Date.parse(this.publicationTime);
    return Date.now() - (published < this.fetchedAt ? published : this.fetchedAt);
  }

  info() {
    const ageMs = this.ageMs();
    return {
      publishedAt: this.publicationTime,
      ageMs,
      // Worth telling the user. Goes beyond !fresh for that stalled publisher:
      // the copy is fresh, what it says isn't.
      // Half a TTL on top, so the feed's normal lag behind a copy near the end
      // of its TTL doesn't count as a stall.
      outdated: ageMs != null && (!this.fresh() || ageMs > this.ttlMs * 1.5),
      checkedAt: this.fetchedAt && new Date(this.fetchedAt).toISOString(),
      fresh: this.fresh(),
      refreshing: !!this.running,
      points: this.points.size,
      error: this.lastError,
      failures: this.failures,
      retryAt: this.retryAt > Date.now() ? new Date(this.retryAt).toISOString() : null,
      bytesLast: this.bytesLast,
    };
  }
}
