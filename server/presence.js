// Singleplayer presence. A singleplayer match runs entirely in the browser and
// never opens a socket, so the server only knows about one if the page says so:
//
//   POST /presence   body: JSON {id, map, mode, bots, tribes, tutorial, age}
//                    (or just the bare id). js/main.js sends it every 30 s
//                    while a singleplayer match is on screen; `age` is seconds
//                    since the match began.
//
// count() is how many different ids were heard from in the last TTL_MS;
// matches() lists them with their settings. The admin page shows both
// (server/admin.js). Ids and settings are held in memory until they expire and
// are never logged or written to disk. No account or player name is sent.
//
// Anyone can post made-up ids, so read the numbers as a headcount, not a fact.
'use strict';

// Two and a half pings, so one lost ping doesn't drop a player from the count.
const TTL_MS = 75 * 1000;
const MAX_IDS = 20000;
const MAX_BODY = 256;
const ID_RE = /^[0-9a-f]{16}$/;
const MAP_SIZES = new Set(['small', 'medium', 'large', 'world']);
const MODE_RE = /^[a-z_-]{1,16}$/;
const MAX_AGE_S = 7 * 24 * 3600;

function int(v, max) {
  return Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

// {id, info} from a request body, or null if it has no valid id.
function parse(text) {
  text = text.trim();
  if (ID_RE.test(text)) return { id: text, info: null };
  let j;
  try { j = JSON.parse(text); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || typeof j.id !== 'string' || !ID_RE.test(j.id)) return null;
  return {
    id: j.id,
    info: {
      map: MAP_SIZES.has(j.map) ? j.map : null,
      mode: typeof j.mode === 'string' && MODE_RE.test(j.mode) ? j.mode : null,
      bots: int(j.bots, 1000),
      tribes: int(j.tribes, 1000),
      tutorial: j.tutorial === true,
      age: int(j.age, MAX_AGE_S) || 0
    }
  };
}

function create() {
  const seen = new Map(); // id -> { t: last heard (ms), info }

  function prune(now) {
    for (const [id, e] of seen) if (now - e.t > TTL_MS) seen.delete(id);
  }

  function handle(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Method not allowed');
    }
    let body = '';
    req.on('error', () => { /* the page went away mid-request */ });
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      const p = parse(body);
      if (p) {
        const now = Date.now();
        if (!seen.has(p.id) && seen.size >= MAX_IDS) prune(now);
        if (seen.has(p.id) || seen.size < MAX_IDS) seen.set(p.id, { t: now, info: p.info });
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
  }

  function count() {
    prune(Date.now());
    return seen.size;
  }

  // One entry per live match, oldest first. `ref` is the first 4 characters of
  // the page id, enough to tell rows apart.
  function matches() {
    const now = Date.now();
    prune(now);
    const out = [];
    for (const [id, e] of seen) {
      const i = e.info || {};
      out.push({
        ref: id.slice(0, 4),
        map: i.map || null,
        mode: i.mode || null,
        bots: i.bots == null ? null : i.bots,
        tribes: i.tribes == null ? null : i.tribes,
        tutorial: !!i.tutorial,
        startedAt: e.info ? e.t - (i.age || 0) * 1000 : null,
        idleMs: now - e.t
      });
    }
    out.sort((a, b) => (a.startedAt || Infinity) - (b.startedAt || Infinity));
    return out;
  }

  return { handle, count, matches };
}

module.exports = { create };
