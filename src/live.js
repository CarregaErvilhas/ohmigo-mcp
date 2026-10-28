// Live charger status and NAP fees from MOBI.E's DATEX II status feed.
//
// The feed is one ~38 MB XML file with no gzip and no byte ranges (13-20 s to
// download). It's fetched on demand: a request that finds the copy older than
// the TTL triggers one refresh, every concurrent request shares it, and the
// next users within the TTL get it for free. A request waits for the refresh
// only up to a budget; past that it answers with the previous copy (flagged
// stale), or without status if there's none yet, and the refresh carries on
// for whoever asks next.
//
// Refreshes use If-None-Match (304 with no body when unchanged) and parse the
// body as a stream, so the 38 MB never sit in memory as text.

import { SaxesParser } from 'saxes';

const URL_ = process.env.NAP_STATUS_URL || 'https://pgm.mobie.pt/integration/nap/evActualStatus';
const TTL_MS = Number(process.env.LIVE_TTL_SECONDS || 300) * 1000;
const WAIT_MS = Number(process.env.LIVE_WAIT_SECONDS || 25) * 1000;

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

const sleep = ms => new Promise(r => setTimeout(r, ms).unref());

export class LiveStatus {
  constructor({ ttlMs = TTL_MS, waitMs = WAIT_MS, fetchImpl = fetch } = {}) {
    this.ttlMs = ttlMs;
    this.waitMs = waitMs;
    this.fetch = fetchImpl;
    this.points = new Map();
    this.publicationTime = null;
    this.fetchedAt = null;
    this.etag = null;
    this.running = null;
    this.lastError = null;
  }

  get(siteId, pointId) { return this.points.get(pointKey(siteId, pointId)) || null; }

  fresh() { return this.fetchedAt != null && Date.now() - this.fetchedAt < this.ttlMs; }

  // Makes sure the copy is within the TTL, waiting up to the budget for a
  // refresh. `onWait` runs once when the caller is going to wait, so the tool
  // can tell the user why.
  async ensure({ onWait } = {}) {
    if (this.fresh()) return;
    const refresh = this.refresh();
    onWait?.();
    await Promise.race([refresh, sleep(this.waitMs)]);
  }

  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const t0 = Date.now();
      // MOBI.E sometimes closes the connection mid-file (seen: a truncated
      // body that fails as "unclosed tag"), so one failure gets one retry.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await this.fetchOnce();
          this.lastError = null;
          console.log(`[ohmigo] live: ${this.points.size} points, published ${this.publicationTime}, ${Date.now() - t0} ms`);
          break;
        } catch (e) {
          this.lastError = e.message;
          console.warn(`[ohmigo] live refresh attempt ${attempt} failed, keeping previous data:`, e.message);
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
    if (res.status === 304) { this.fetchedAt = Date.now(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { publicationTime, points } = await parseStatus(res.body);
    if (points.size < 1000) throw new Error(`only ${points.size} points parsed`);
    this.points = points;
    this.publicationTime = publicationTime;
    this.etag = res.headers.get('etag');
    this.fetchedAt = Date.now();
  }

  info() {
    return {
      publishedAt: this.publicationTime,
      checkedAt: this.fetchedAt && new Date(this.fetchedAt).toISOString(),
      fresh: this.fresh(),
      refreshing: !!this.running,
      points: this.points.size,
      error: this.lastError,
    };
  }
}
