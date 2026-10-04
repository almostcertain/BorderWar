// Server skeleton (MP-2.1, docs/multiplayer-architecture.md §6/§9 Phase 2).
//
// The first real Node process this project runs. Everything before this task
// was LocalServer — an in-page object pretending to be a server (§2). This
// file gives Transport.connectRemote something to connect to; it does almost
// no work of its own on purpose:
//
//   - static HTTP: serves the repo's existing js/css/index.html so the whole
//     game is reachable from one origin, exactly as OpenFront's Master.ts
//     fronts its static assets alongside the WS upgrade.
//   - one ws.Server, upgrading only at /ws.
//   - handing each new connection straight to GameManager, untouched.
//
// NOT HERE, ON PURPOSE: no message parsing, no lobby, no turn relay. That is
// server/gameserver.js's GameServer, which is explicitly MP-2.2 — see the
// scope note atop gamemanager.js. A connection arriving is the only event
// this task needs to react to.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');
const GameManager = require('./gamemanager');
const log = require('./log');
const { getBuildInfo } = require('../tools/build-info');

// Not 8123: .claude/launch.json's "borderwar" config already claims 8123 for
// the plain static dev server used throughout Phase 0/1 browser verification.
// The two must be able to run side by side during development (this server
// is additive, not a replacement), so this one defaults to a different port.
const PORT = Number(process.env.PORT) || 8124;

// server/ sits one level under the repo root; the static files this must
// serve (index.html, js/, css/) live at that root, not under server/.
const REPO_ROOT = path.join(__dirname, '..');

// The only parts of the repo the web server hands out (buildinfo.json is
// answered separately, below). Add to these if index.html starts loading
// something from a new place.
const PUBLIC_FILES = new Set(['index.html', 'version.json', 'LICENSE', 'manifest.webmanifest']);
const PUBLIC_DIRS = new Set(['js', 'css', 'assets', 'maps']);

// Minimal content-type table. Just enough for what index.html's own loader
// actually requests (see its script list) plus the page and its stylesheet —
// this is not a general-purpose static file server, it is the same handful
// of file kinds .claude/launch.json's python http.server already handles via
// its own built-in guessing.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// index.html's loader (js/main.js's script list, built by the document.write
// block at the bottom of index.html) does not change for this task — see
// that file's comment on why 'net/protocol' etc. sit where they do. This
// server only needs to serve the same files an existing static server
// (.claude/launch.json's "borderwar", python's http.server on 8123) already
// serves; it does not need to know the loader's contents at all.
//
// That reference server sends `Cache-Control: no-store, no-cache,
// must-revalidate` on every response specifically to defeat browser caching
// during rapid edit/reload cycles (see its comment in .claude/launch.json and
// the matching one in index.html about python's 1s Last-Modified
// granularity). index.html additionally cache-busts every script tag with a
// `?v=timestamp` query string, which alone would be enough; matching the
// no-store header here too is cheap and keeps this server's dev experience
// identical to the reference one, so it is done, but it is not load-bearing.
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve against the repo root and reject anything that escapes it
  // (`..` traversal) — the one piece of hardening a static file server
  // cannot skip, not a security *feature* of this task, just table stakes
  // for serving arbitrary request paths off disk.
  const filePath = path.normalize(path.join(REPO_ROOT, urlPath));
  // A bare startsWith(REPO_ROOT) has the classic sibling-prefix hole: if
  // REPO_ROOT were e.g. "C:\foo", a resolved path of "C:\foo-evil\x" would
  // pass the check even though it's a different directory that merely shares
  // a string prefix. Requiring an exact match or a match followed by the
  // platform separator closes that — the only two ways a path can legitimately
  // be "REPO_ROOT or something inside it".
  if (filePath !== REPO_ROOT && !filePath.startsWith(REPO_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // The server is public, so serve only what the game itself loads. Anything
  // else under the repo (.git, .claude, docs, server, tools, marketing, any
  // stray .env or log) answers 404, exactly like a file that does not exist.
  const rel = path.relative(REPO_ROOT, filePath).split(path.sep);
  const allowed = rel.length === 1
    ? PUBLIC_FILES.has(rel[0])
    : PUBLIC_DIRS.has(rel[0]) && !rel.some(seg => seg.startsWith('.'));
  if (!allowed) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(data);
  });
}

// Issue #9: the public lobby browser's data source. A plain JSON GET, not a
// WS message — it needs to work from the Join screen before any socket
// exists, and answering it doesn't touch a specific game's turn loop, so it
// doesn't belong in gamemanager.js's per-connection message switch. Checked
// ahead of serveStatic since nothing under REPO_ROOT is named this.
function serveLobbyList(req, res) {
  const body = JSON.stringify(gameManager.listPublicLobbies());
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  });
  res.end(body);
}

// Computed once at startup, so it reflects the commit the server was started on.
const BUILD_INFO = JSON.stringify(getBuildInfo());

// Accounts (docs/accounts-auth.md). Optional: on a Node without node:sqlite,
// or if the database can't be opened, the server runs as before, /api/* is
// 404 and the client hides its sign-in UI.
let accounts = null;
try {
  accounts = require('./accounts/routes').create({ dbPath: process.env.BORDERWAR_DB, log });
} catch (e) {
  log.warn('accounts', 'disabled: ' + (e && e.message || e));
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    if (accounts) return accounts.handle(req, res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  if (urlPath === '/admin' || urlPath.startsWith('/admin/')) {
    if (admin) return admin.handle(req, res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  if (req.method === 'GET' && urlPath === '/lobbies') return serveLobbyList(req, res);
  if (req.method === 'GET' && urlPath === '/buildinfo.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(BUILD_INFO);
  }
  return serveStatic(req, res);
});

// Upgrade only at /ws, matching §3/§6.1's "server/index.js serves the static
// game and the WS upgrade from the same origin" — one process, one port, so
// the tunnelled deployment (§6.1) has exactly one thing to point at.
const wss = new WebSocket.Server({ server, path: '/ws' });

const gameManager = new GameManager({ buildID: JSON.parse(BUILD_INFO).id });

// Admin stats page (server/admin.js): /admin, token-protected. Optional like
// accounts: if the token can't be read or written, /admin is 404.
// Chart history is saved to disk only on the default port, so a dev server
// started beside the live one (on another port) doesn't write into its history.
let admin = null;
try {
  admin = require('./admin').create({
    gameManager, wss, log, build: JSON.parse(BUILD_INFO).id, persistHistory: PORT === 8124
  });
} catch (e) {
  log.warn('admin', 'disabled: ' + (e && e.message || e));
}

// Basic flood resistance for a server now reachable from the open internet
// (§6.1's tunnelled deployment), not a security control — matching MP-4.3's
// own framing (D2): this stops a naive flood of WebSocket upgrades from
// piling up sockets/Client objects faster than anything downstream ever gets
// a chance to reap them. It does nothing against a determined attacker
// spreading requests across many source addresses.
//
// A plain fixed-window counter, not per-IP: per-IP tracking needs its own
// cleanup lifecycle for a self-hosted box that was explicitly scoped to skip
// exactly that kind of bookkeeping (§6.1 — "never many concurrent games on a
// self-hosted box"). MAX_NEW_CONNECTIONS_PER_WINDOW is generous for any
// realistic burst of real players joining a lobby at once.
const CONNECTION_WINDOW_MS = 1000;
const MAX_NEW_CONNECTIONS_PER_WINDOW = 20;
let _connWindowStart = Date.now();
let _connCountInWindow = 0;
// A flood would otherwise print one warning per rejected socket; log the first
// rejection of each window with a count of how many it turned away.
let _rejectedInWindow = 0;

wss.on('connection', (ws) => {
  const now = Date.now();
  if (now - _connWindowStart >= CONNECTION_WINDOW_MS) {
    _connWindowStart = now;
    _connCountInWindow = 0;
    _rejectedInWindow = 0;
  }
  _connCountInWindow++;
  if (_connCountInWindow > MAX_NEW_CONNECTIONS_PER_WINDOW) {
    if (_rejectedInWindow++ === 0) {
      log.warn('server', 'connection rate exceeded (>' + MAX_NEW_CONNECTIONS_PER_WINDOW
        + '/s), rejecting new sockets');
    }
    try { ws.close(1013, 'server busy'); } catch (e) { /* already closing */ }
    return;
  }

  // Handing the raw connection to GameManager, untouched, is the entire job
  // here — see the file header. As of MP-2.2, GameManager.handleConnection
  // waits for the connection's first message (must be `join` or `rejoin`)
  // and does its own routing/validation/logging; there is no longer a
  // synchronous 'default' game to log against immediately (MP-2.1's
  // PlaceholderGame routed everything to one hardcoded lobby before any
  // message existed — GameServer/GameManager replace that wholesale).
  gameManager.handleConnection(ws);
});

// Non-loopback IPv4 addresses, so the startup line can say where LAN players
// connect rather than only "localhost".
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  log.info('server', 'listening on port ' + PORT + ' (WS at /ws)');
  log.info('server', 'local:  http://localhost:' + PORT);
  for (const ip of lanAddresses()) log.info('server', 'LAN:    http://' + ip + ':' + PORT);
  gameManager.startHeartbeat();
});

// Graceful shutdown. Verified against ws's own source (lib/websocket-server.js
// close()): when a WebSocketServer is attached to an external http.Server (as
// this one is), close() does NOT terminate existing clients — it only stops
// accepting new upgrades and waits for whatever is already connected to close
// on its own. A single client left open (an idle player, a dropped-but-not-
//-yet-timed-out socket) would therefore hang this callback chain forever, so
// every tracked client is terminated explicitly first. Only then is it safe
// to close wss and the underlying HTTP server, whose own close() likewise
// only waits for in-flight requests/sockets to end rather than forcing them.
function shutdown(signal) {
  log.info('server', signal + ' received, shutting down');
  for (const ws of wss.clients) ws.terminate();
  wss.close(() => {
    server.close(() => {
      log.info('server', 'shutdown complete');
      process.exit(0);
    });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, wss, gameManager, accounts, PORT };
