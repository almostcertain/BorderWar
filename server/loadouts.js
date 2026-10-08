// Equipped cosmetics per browser (docs/metaprogression.md §6.3). The page
// POSTs its loadout here keyed by its persistentID, and `join` (which already
// carries that id) picks it up. In memory only; honour system (§7).
'use strict';

const ProgressDefs = require('../js/progress-defs.js');
const ratelimit = require('./accounts/ratelimit');
const { ApiError, send, clientIp, checkOrigin, readJson } = require('./httpapi');

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;
const POSTS_PER_MINUTE = 30;

// crypto.randomUUID() or transport.js's 'p-<base36>-<base36>' fallback.
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function validPersistentID(v) {
  return typeof v === 'string' && ID_PATTERN.test(v);
}

// {title, emblem, banner} holding only known ids of the right type, or null
// when nothing is equipped.
function clean(equipped) {
  const e = ProgressDefs.sanitize({ equipped }).equipped;
  for (let i = 0; i < ProgressDefs.COSMETIC_TYPES.length; i++) {
    if (e[ProgressDefs.COSMETIC_TYPES[i]] !== null) return e;
  }
  return null;
}

// opts: { ttlMs, max, now } — all optional.
function createStore(opts) {
  opts = opts || {};
  const ttlMs = opts.ttlMs || TTL_MS;
  const max = opts.max || MAX_ENTRIES;
  const now = opts.now || Date.now;
  // persistentID -> { equipped, at }. Every write re-inserts, so Map order is
  // oldest write first and both expiry and the cap trim from the front.
  const entries = new Map();

  function trim() {
    const t = now();
    for (const [id, entry] of entries) {
      if (entries.size <= max && t - entry.at < ttlMs) break;
      entries.delete(id);
    }
  }

  return {
    // Stores the cleaned loadout and returns it (null clears the entry).
    set(persistentID, equipped) {
      const e = clean(equipped);
      entries.delete(persistentID);
      if (e) entries.set(persistentID, { equipped: e, at: now() });
      trim();
      return e;
    },
    get(persistentID) {
      const entry = entries.get(persistentID);
      if (!entry) return null;
      if (now() - entry.at >= ttlMs) { entries.delete(persistentID); return null; }
      return entry.equipped;
    },
    get size() { return entries.size; }
  };
}

// opts: { store, onChange(persistentID, equipped), now, log }. `handle` answers
// POST /api/loadout and never rejects.
function createRoute(opts) {
  opts = opts || {};
  const store = opts.store || createStore({ now: opts.now });
  const log = opts.log || { error() {} };
  const limit = ratelimit.window(POSTS_PER_MINUTE, 60 * 1000, opts.now);

  async function handle(req, res) {
    try {
      if (req.method !== 'POST') throw new ApiError(404, 'not-found');
      checkOrigin(req);
      if (!limit.take(clientIp(req))) throw new ApiError(429, 'rate-limited');
      const body = await readJson(req);
      if (!validPersistentID(body.persistentID)) throw new ApiError(400, 'invalid');
      const raw = body.equipped;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'invalid');
      const equipped = store.set(body.persistentID, raw);
      if (opts.onChange) opts.onChange(body.persistentID, equipped);
      return send(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message });
      log.error('loadouts', 'request failed: ' + (e && e.message || e));
      if (!res.headersSent) send(res, 500, { error: 'server', message: 'Something went wrong' });
    }
  }

  return { handle, store };
}

module.exports = { createStore, createRoute, validPersistentID, clean, TTL_MS, MAX_ENTRIES, POSTS_PER_MINUTE };
