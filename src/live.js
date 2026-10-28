// Live charger status and NAP fees from MOBI.E's DATEX II status feed.
//
// The feed is one ~38 MB XML file with no gzip and no byte ranges, so users
// never trigger a download. One background poller per process keeps a map of
// point id -> { status, fees } and every query reads that map. Polls use
// If-None-Match: when nothing changed, MOBI.E answers 304 with no body. When
// it did change, the body is parsed as a stream, so we never hold 38 MB of
// text in memory.

import { SaxesParser } from 'saxes';

const URL_ = process.env.NAP_STATUS_URL || 'https://pgm.mobie.pt/integration/nap/evActualStatus';
const EVERY_MS = Number(process.env.NAP_POLL_SECONDS || 180) * 1000;

// Parses the feed from an async iterable of byte chunks.
export async function parseStatus(chunks) {
  const points = new Map();
  let publicationTime = null;
  const p = new SaxesParser({ xmlns: true });
  const stack = [];
  let text = '';
  let point = null, policy = null, fee = null;

  p.on('opentag', n => {
    stack.push(n.local);
    text = '';
    if (n.local === 'refillPointStatus') point = { status: null, fees: [] };
    // The first <reference> inside a refillPointStatus is the point's own id.
    else if (n.local === 'reference' && point && !point.id) point.id = n.attributes.id?.value;
    else if (n.local === 'energyPricingPolicy') { policy = null; fee = null; }
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
        if (point?.id) points.set(point.id, { status: point.status, fees: point.fees });
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

export class LiveStatus {
  constructor() {
    this.points = new Map();
    this.publicationTime = null;
    this.fetchedAt = null;
    this.etag = null;
    this.running = null;
    this.lastError = null;
  }

  get(id) { return this.points.get(id) || null; }

  // Status is "live" only if the feed was read recently; a stuck poller must
  // not present hour-old data as current.
  fresh(maxAgeMs = 3 * EVERY_MS) {
    return this.fetchedAt != null && Date.now() - this.fetchedAt < maxAgeMs;
  }

  async poll() {
    if (this.running) return this.running;
    this.running = (async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(URL_, {
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
        this.lastError = null;
        console.log(`[ohmigo] live: ${points.size} points, published ${publicationTime}, ${Date.now() - t0} ms`);
      } catch (e) {
        this.lastError = e.message;
        console.warn('[ohmigo] live poll failed, keeping previous data:', e.message);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  start() {
    this.poll();
    setInterval(() => this.poll(), EVERY_MS).unref();
  }

  info() {
    return { publishedAt: this.publicationTime, checkedAt: this.fetchedAt && new Date(this.fetchedAt).toISOString(), fresh: this.fresh(), points: this.points.size, error: this.lastError };
  }
}
