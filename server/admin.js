// Admin stats: a view of what this server is doing right now, plus the drain switch.
// Singleplayer matches run in the browser; their count comes from server/presence.js.
//
//   GET /admin        the page (server/admin.html); public, holds no data
//   GET /admin/stats  JSON snapshot; needs `Authorization: Bearer <token>`
//   GET /admin/history[?since=ms]  one sample a minute for the page's charts
//   POST /admin/drain[?maxMinutes=n]  stop taking new games, exit once active
//                     matches finish (tools/drain-server.js); same token
//   POST /admin/news  publish or remove the What's new post (server/news.js);
//                     same token
//
// The token is BORDERWAR_ADMIN_TOKEN if set, otherwise a random one generated
// on first start and kept in server/data/admin-token.txt (gitignored). There is
// no localhost exemption on purpose: behind the Cloudflare Tunnel every request
// arrives from loopback, so "local" proves nothing.
//
// History is kept for a week. With `persistHistory` it is also appended to
// server/data/stats-history.jsonl so the charts survive a restart; a gap in the
// samples is the server having been down.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TOKEN_FILE = path.join(__dirname, 'data', 'admin-token.txt');
const PAGE_FILE = path.join(__dirname, 'admin.html');
const HISTORY_FILE = path.join(__dirname, 'data', 'stats-history.jsonl');

// One sample row is these fields, in this order (the page indexes into it).
// New fields go on the end: a saved row from before a field existed is shorter,
// and is read back with 0 there.
const HISTORY_FIELDS = ['t', 'players', 'spectators', 'activeGames', 'lobbies', 'sockets', 'rssMB', 'solo'];
const HISTORY_MIN_FIELDS = 7;
const SAMPLE_INTERVAL_MS = 60 * 1000;
const HISTORY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// Appends between rewrites of the file, which is what drops expired rows from it.
const COMPACT_EVERY = 1440;

function writeHistory(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r) + '\n').join(''));
}

// Rows still inside the keep window. A line that doesn't parse is skipped.
function loadHistory(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { continue; }
    if (!Array.isArray(row) || row.length < HISTORY_MIN_FIELDS || row.length > HISTORY_FIELDS.length) continue;
    if (!row.every(Number.isFinite) || row[0] < cutoff) continue;
    while (row.length < HISTORY_FIELDS.length) row.push(0);
    rows.push(row);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return rows;
}

function loadToken(log) {
  const fromEnv = (process.env.BORDERWAR_ADMIN_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) {
      try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) { /* not ours to change */ }
      return saved;
    }
  } catch (e) { /* not created yet */ }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  log.info('admin', 'generated admin token in ' + TOKEN_FILE);
  return token;
}

function create(opts) {
  const { gameManager, wss, presence, log, build } = opts;
  const tokenHash = crypto.createHash('sha256').update(loadToken(log)).digest();
  const startedAt = Date.now();
  const historyFile = process.env.BORDERWAR_STATS_FILE || (opts.persistHistory ? HISTORY_FILE : null);

  // Since-start counters. Nothing else in the server keeps history.
  let totalConnections = 0;
  let peakConnections = 0;
  wss.on('connection', () => {
    totalConnections++;
    if (wss.clients.size > peakConnections) peakConnections = wss.clients.size;
  });

  function authorized(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    // Hash both sides so the comparison is constant-time at a fixed length.
    const given = crypto.createHash('sha256').update(m[1].trim()).digest();
    return crypto.timingSafeEqual(given, tokenHash);
  }

  function snapshot() {
    const now = Date.now();
    const games = [];
    let players = 0, spectators = 0, lobbies = 0, active = 0;
    for (const game of gameManager.games.values()) {
      const clients = [];
      for (const c of game.clients.values()) {
        clients.push({
          clientID: c.clientID,
          username: c.username,
          spectator: !!c.spectator,
          connected: !!c.active,
          idleMs: now - c.lastPing
        });
        if (!c.active) continue;
        if (c.spectator) spectators++; else players++;
      }
      if (game.stage === 'LOBBY') lobbies++;
      else if (game.stage === 'ACTIVE') active++;
      const cfg = game.gameStartInfo ? game.gameStartInfo.config : game.autoConfig;
      games.push({
        gameID: game.gameID,
        stage: game.stage,
        isPublic: !!game.isPublic,
        isAuto: !!game.isAutoLobby,
        map: cfg ? (cfg.map === 'world' ? 'world' : cfg.mapSize) : null,
        mode: cfg && cfg.gameMode || null,
        bots: cfg && Number.isInteger(cfg.bots) ? cfg.bots : null,
        tribes: cfg && Number.isInteger(cfg.tribes) ? cfg.tribes : null,
        turn: game.turns.length,
        startedAt: game._startedAt,
        autoStartAt: game._autoStartAt,
        desynced: game.desyncFlagged.size,
        clients: clients
      });
    }
    const mem = process.memoryUsage();
    return {
      now: now,
      server: {
        build: build,
        draining: !!gameManager.draining,
        node: process.version,
        startedAt: startedAt,
        uptimeMs: now - startedAt,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        systemFreeMem: os.freemem(),
        systemTotalMem: os.totalmem(),
        cpus: os.cpus().length
      },
      totals: {
        sockets: wss.clients.size,
        players: players,
        spectators: spectators,
        // Pages in a singleplayer match right now (server/presence.js).
        solo: presence ? presence.count() : 0,
        lobbies: lobbies,
        activeGames: active,
        totalConnections: totalConnections,
        peakConnections: peakConnections
      },
      games: games
    };
  }

  let history = [];
  let appendsSinceCompact = 0;
  let historyWriteFailed = false;
  if (historyFile) {
    history = loadHistory(historyFile);
    try { writeHistory(historyFile, history); } catch (e) { /* reported by the first sample */ }
  }

  function sample() {
    const s = snapshot();
    const row = [s.now, s.totals.players, s.totals.spectators, s.totals.activeGames,
      s.totals.lobbies, s.totals.sockets, Math.round(s.server.rss / 1048576), s.totals.solo];
    history.push(row);
    const cutoff = s.now - HISTORY_KEEP_MS;
    let expired = 0;
    while (history[expired][0] < cutoff) expired++;
    if (expired) history.splice(0, expired);
    if (!historyFile) return;
    try {
      if (++appendsSinceCompact >= COMPACT_EVERY) {
        appendsSinceCompact = 0;
        writeHistory(historyFile, history);
      } else {
        fs.appendFileSync(historyFile, JSON.stringify(row) + '\n');
      }
      historyWriteFailed = false;
    } catch (e) {
      if (!historyWriteFailed) log.warn('admin', 'could not write stats history: ' + (e && e.message || e));
      historyWriteFailed = true;
    }
  }
  sample();
  const sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS);
  if (typeof sampleTimer.unref === 'function') sampleTimer.unref();

  function historySince(req) {
    const m = /[?&]since=(\d+)/.exec(req.url);
    const since = m ? Number(m[1]) : 0;
    return {
      fields: HISTORY_FIELDS,
      intervalMs: SAMPLE_INTERVAL_MS,
      samples: since ? history.filter(r => r[0] > since) : history
    };
  }

  function send(res, status, type, body) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  // Answers /admin and anything under /admin/.
  function handle(req, res) {
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/admin/drain') {
      if (!opts.drain) return send(res, 404, 'text/plain', 'Not found');
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed');
      if (!authorized(req)) return send(res, 401, 'application/json; charset=utf-8', '{"error":"unauthorized"}');
      const m = /[?&]maxMinutes=(\d+(?:\.\d+)?)/.exec(req.url);
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify(opts.drain(m ? Number(m[1]) * 60000 : 0)));
    }
    if (urlPath === '/admin/news') {
      if (!opts.news) return send(res, 404, 'text/plain', 'Not found');
      if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed');
      if (!authorized(req)) return send(res, 401, 'application/json; charset=utf-8', '{"error":"unauthorized"}');
      return opts.news.publish(req, res);
    }
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
    if (urlPath === '/admin' || urlPath === '/admin/') {
      return fs.readFile(PAGE_FILE, (err, data) => {
        if (err) return send(res, 404, 'text/plain', 'Not found');
        send(res, 200, 'text/html; charset=utf-8', data);
      });
    }
    if (urlPath === '/admin/stats') {
      if (!authorized(req)) return send(res, 401, 'application/json; charset=utf-8', '{"error":"unauthorized"}');
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot()));
    }
    if (urlPath === '/admin/history') {
      if (!authorized(req)) return send(res, 401, 'application/json; charset=utf-8', '{"error":"unauthorized"}');
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(historySince(req)));
    }
    return send(res, 404, 'text/plain', 'Not found');
  }

  return { handle, snapshot, sample };
}

module.exports = { create };
