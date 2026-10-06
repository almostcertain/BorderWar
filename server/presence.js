// Singleplayer presence. A singleplayer match runs entirely in the browser and
// never opens a socket, so the server only knows about one if the page says so:
//
//   POST /presence   body: the page's random id. js/main.js sends it every
//                    30 s while a singleplayer match is on screen.
//
// count() is how many different ids were heard from in the last TTL_MS; the
// admin page shows it (server/admin.js). An id is held in memory until it
// expires and is never logged or written to disk.
//
// Anyone can post made-up ids, so read the number as a headcount, not a fact.
'use strict';

// Two and a half pings, so one lost ping doesn't drop a player from the count.
const TTL_MS = 75 * 1000;
const MAX_IDS = 20000;
const MAX_BODY = 64;
const ID_RE = /^[0-9a-f]{16}$/;

function create() {
  const seen = new Map(); // id -> when it was last heard from (ms)

  function prune(now) {
    for (const [id, t] of seen) if (now - t > TTL_MS) seen.delete(id);
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
      const id = body.trim();
      if (ID_RE.test(id)) {
        const now = Date.now();
        if (!seen.has(id) && seen.size >= MAX_IDS) prune(now);
        if (seen.has(id) || seen.size < MAX_IDS) seen.set(id, now);
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
    });
  }

  function count() {
    prune(Date.now());
    return seen.size;
  }

  return { handle, count };
}

module.exports = { create };
