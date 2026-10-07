// Host process (docs/multiplayer-architecture.md §6). Does little on purpose:
//   - static HTTP: serves the repo's js/css/index.html from one origin
//   - one ws.Server, upgrading only at /ws
//   - hands each new connection to GameManager, untouched
// No message parsing, lobby or turn relay here; that is server/gameserver.js.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const os = require('os');
const GameManager = require('./gamemanager');
const Client = require('./client');
const log = require('./log');
const { getBuildInfo } = require('../tools/build-info');

// Not 8123: the `borderwar` static dev server (.claude/launch.json) uses
// that, and the two must be able to run side by side.
const PORT = Number(process.env.PORT) || 8124;

// server/ sits one level under the repo root; the static files this must
// serve (index.html, js/, css/) live at that root, not under server/.
const REPO_ROOT = path.join(__dirname, '..');

// The only parts of the repo the web server hands out (buildinfo.json is
// answered separately, below). Add to these if index.html starts loading
// something from a new place.
const PUBLIC_FILES = new Set(['index.html', 'privacy.html', 'terms.html', 'version.json', 'LICENSE', 'manifest.webmanifest']);
const PUBLIC_DIRS = new Set(['js', 'css', 'assets', 'maps']);

// Minimal content-type table: just the file kinds index.html requests.
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

// Serves the same files the static dev server does. `Cache-Control:
// no-store` matches that server; index.html's `?v=` cache-busting already
// covers scripts, so the header is not load-bearing.
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve against the repo root and reject anything that escapes it
  // (`..` traversal).
  const filePath = path.normalize(path.join(REPO_ROOT, urlPath));
  // Exact match or REPO_ROOT + separator: a bare startsWith(REPO_ROOT)
  // would let a sibling like `C:oo-evil` pass for `C:oo`.
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

// Public lobby browser data. A JSON GET rather than a WS message because
// the Join screen needs it before any socket exists. Checked ahead of
// serveStatic.
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
  const dbFile = process.env.BORDERWAR_DB || require('./accounts/db').DEFAULT_PATH;
  if (dbFile !== ':memory:') {
    require('./accounts/backup').start(accounts.db, path.join(path.dirname(dbFile), 'backups'), { log });
  }
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
  if (urlPath === '/presence') return presence.handle(req, res);
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

// Singleplayer matches never reach the WS server; the page reports them here
// so the admin page can count them (server/presence.js).
const presence = require('./presence').create();

// Admin stats page (server/admin.js): /admin, token-protected. Optional like
// accounts: if the token can't be read or written, /admin is 404.
// Chart history is saved to disk only on the default port, so a dev server
// started beside the live one (on another port) doesn't write into its history.
let admin = null;
try {
  admin = require('./admin').create({
    gameManager, wss, presence, log, build: JSON.parse(BUILD_INFO).id, persistHistory: PORT === 8124,
    drain: (maxMs) => drain('admin drain requested', maxMs)
  });
} catch (e) {
  log.warn('admin', 'disabled: ' + (e && e.message || e));
}

// Basic flood resistance, not a security control (D2): stops a naive
// flood of WebSocket upgrades piling up sockets faster than they are
// reaped. A fixed-window counter, deliberately not per-IP.
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

  // GameManager waits for the first message (`join` or `rejoin`) and does
  // its own routing, validation and logging.
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

// Graceful shutdown. With an external http.Server, wss.close() does NOT
// terminate existing clients, so one idle socket would hang this forever:
// terminate every tracked client first, then close wss and the HTTP
// server. Anyone still connected is told why first, with a moment for the
// message to leave.
let stopping = false;
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log.info('server', reason + ', shutting down');
  for (const ws of wss.clients) {
    Client.closeWithError(ws, GameManager.RESTARTING_ERROR, GameManager.RESTARTING_MESSAGE);
  }
  setTimeout(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => {
      server.close(() => {
        log.info('server', 'shutdown complete');
        process.exit(0);
      });
      // Keep-alive HTTP connections would otherwise hold server.close() open.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  }, 500);
}

// Drain: stop taking new games, let ACTIVE matches play out, then shut down.
// Triggered by the first Ctrl+C / SIGTERM, or by POST /admin/drain
// (tools/drain-server.js). `maxMs` > 0 caps the wait; a later call can only
// shorten it. Returns the current state for the caller to report.
const DRAIN_POLL_MS = 2000;
let drainDeadline = null; // epoch ms, or null for "however long it takes"
let drainTimerID = null;
function drain(reason, maxMs) {
  if (maxMs > 0) {
    const deadline = Date.now() + maxMs;
    if (drainDeadline === null || deadline < drainDeadline) drainDeadline = deadline;
  }
  if (!gameManager.draining) {
    gameManager.beginDrain();
    const n = gameManager.activeGameCount();
    log.info('server', reason + ', draining: no new games; waiting for ' + n + ' active game'
      + (n === 1 ? '' : 's') + ' to finish'
      + (drainDeadline === null ? '' : ' (at most ' + Math.round((drainDeadline - Date.now()) / 60000) + ' min)'));
    const check = () => {
      if (gameManager.activeGameCount() === 0) return shutdown('drain complete');
      if (drainDeadline !== null && Date.now() >= drainDeadline) return shutdown('drain time limit reached');
      drainTimerID = setTimeout(check, DRAIN_POLL_MS);
    };
    check();
  }
  return { draining: true, activeGames: gameManager.activeGameCount(), deadline: drainDeadline };
}

// First signal drains; a second one stops now.
function onSignal(signal) {
  if (gameManager.draining) {
    if (drainTimerID !== null) clearTimeout(drainTimerID);
    return shutdown(signal + ' received again');
  }
  drain(signal + ' received');
  if (!stopping) log.info('server', 'press Ctrl+C again to stop now');
}

process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

module.exports = { server, wss, gameManager, accounts, PORT };
