// Paddle Billing (docs/monetization.md MO-6): the API client, the catalog of
// our prices, and webhook signature checks. Applying an event to the database
// is in paddle-events.js. Uses the built-in fetch and crypto; no dependency.
'use strict';

const crypto = require('crypto');
const ShopDefs = require('../../js/shop-defs.js');

const API = { sandbox: 'https://sandbox-api.paddle.com', production: 'https://api.paddle.com' };
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
const CATALOG_RETRY_MS = 5 * 60 * 1000;

// Our item ids: BB packs and subscription tiers. A Paddle price is ours when
// its custom_data.borderwar_sku is one of these (set by paddle-setup.js).
const knownSku = (sku) => !!(ShopDefs.BB_PACKS[sku] || ShopDefs.tier(sku));

// "ts=...;h1=..." over `${ts}:${rawBody}`, HMAC-SHA256 with the destination's
// secret. Paddle may send several h1 values while a secret is being rotated.
function verifySignature(raw, header, secret, now) {
  if (!secret || typeof header !== 'string') return false;
  let ts = null;
  const sigs = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
    if (k === 'ts') ts = v;
    else if (k === 'h1') sigs.push(v);
  }
  if (!ts || !/^\d+$/.test(ts) || !sigs.length) return false;
  if (Math.abs(now - Number(ts) * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const want = crypto.createHmac('sha256', secret).update(ts + ':').update(raw).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    return crypto.timingSafeEqual(Buffer.from(s, 'hex'), want);
  });
}

// opts: { apiKey, clientToken, webhookSecret, environment, fetch, log, now }
function create(opts) {
  opts = opts || {};
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now || Date.now;
  const environment = opts.environment === 'production' ? 'production' : 'sandbox';
  const base = API[environment];
  const configured = !!(opts.apiKey && opts.clientToken && opts.webhookSecret);
  const bySku = new Map(), bySkuPrice = new Map();
  let retryTimer = null;

  async function api(method, path, body) {
    const r = await doFetch(path.startsWith('http') ? path : base + path, {
      method,
      headers: { 'Authorization': 'Bearer ' + opts.apiKey, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) {
      const detail = data && data.error ? data.error.code + ': ' + data.error.detail : 'HTTP ' + r.status;
      throw new Error('Paddle ' + method + ' ' + path.replace(/^https?:\/\/[^/]+/, '') + ' failed: ' + detail);
    }
    return data;
  }

  // All active prices, following pagination.
  async function listPrices() {
    const out = [];
    let next = '/prices?status=active&per_page=200';
    while (next) {
      const page = await api('GET', next);
      for (const p of page.data || []) out.push(p);
      const pg = page.meta && page.meta.pagination;
      next = pg && pg.has_more ? pg.next : null;
    }
    return out;
  }

  async function loadCatalog() {
    const prices = await listPrices();
    bySku.clear();
    bySkuPrice.clear();
    for (const p of prices) {
      const sku = p.custom_data && p.custom_data.borderwar_sku;
      if (!knownSku(sku) || bySku.has(sku)) continue;
      bySku.set(sku, p.id);
      bySkuPrice.set(p.id, sku);
    }
    const missing = Object.keys(ShopDefs.BB_PACKS).concat(Object.keys(ShopDefs.TIERS)).filter((s) => !bySku.has(s));
    if (missing.length) log.warn('paddle', 'catalog has no price for: ' + missing.join(', ') + ' (run paddle-setup.js)');
    else log.info('paddle', 'catalog loaded (' + environment + ')');
  }

  // At startup and every few minutes until it works, so a Paddle outage at
  // boot doesn't leave the shop off until the next restart.
  function start() {
    if (!configured) return;
    loadCatalog().catch((e) => {
      log.warn('paddle', 'catalog load failed: ' + (e && e.message || e));
      retryTimer = setTimeout(start, CATALOG_RETRY_MS);
      if (retryTimer.unref) retryTimer.unref();
    });
  }

  return {
    configured,
    environment,
    clientToken: opts.clientToken || '',
    start,
    stop() { if (retryTimer) clearTimeout(retryTimer); },
    loadCatalog,
    listPrices,
    api,
    priceFor: (sku) => bySku.get(sku) || null,
    skuFor: (priceId) => bySkuPrice.get(priceId) || null,
    ready: () => configured && bySku.size > 0,
    verify: (raw, header) => verifySignature(raw, header, opts.webhookSecret, now()),

    // A short-lived link to Paddle's page where the customer cancels or
    // changes their card.
    async portalUrl(customerId, subscriptionId) {
      const body = subscriptionId ? { subscription_ids: [subscriptionId] } : {};
      const r = await api('POST', '/customers/' + encodeURIComponent(customerId) + '/portal-sessions', body);
      const urls = r.data && r.data.urls;
      return urls && urls.general && urls.general.overview;
    },

    // Upgrades are charged now, prorated; downgrades take effect from the next bill.
    async changePrice(subscriptionId, priceId, upgrade) {
      return api('PATCH', '/subscriptions/' + encodeURIComponent(subscriptionId), {
        items: [{ price_id: priceId, quantity: 1 }],
        proration_billing_mode: upgrade ? 'prorated_immediately' : 'full_next_billing_period'
      });
    }
  };
}

module.exports = { create, verifySignature, knownSku, API };
