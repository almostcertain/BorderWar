// Global Daily Challenge leaderboard (docs/daily-leaderboard.md). Signed-in
// players submit their replay; the server re-runs it in a child process
// (server/dailyreplay.js) and stores the score it computed itself. The client's
// own score is only used to skip re-running a result that can't beat the
// player's stored best.
'use strict';

const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const DailyCore = require('../js/daily-core.js');
const ratelimit = require('./accounts/ratelimit');
const { ApiError, send, checkOrigin, readJson } = require('./httpapi');

const UPLOAD_LIMIT = 1024 * 1024;
const TOP = 20;

// Runs one replay check at a time, each in a fresh low-priority process.
function createChecker(opts) {
  opts = opts || {};
  const script = opts.script || path.join(__dirname, 'dailyreplay.js');
  const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
  const maxQueue = opts.maxQueue || 30;
  const log = opts.log;
  const queue = [];
  let running = null;

  function next() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = job;
    const child = fork(script, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    try { os.setPriority(child.pid, 19); } catch (e) { /* not permitted here */ }
    let done = false, stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running = null;
      if (out.crash && log) log.error('daily', 'replay check crashed: ' + out.crash);
      job.resolve(out);
      setImmediate(next);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: 'This match took too long to check.' });
    }, timeoutMs);
    child.on('message', finish);
    child.on('exit', (code) => finish({ ok: false, message: 'The server could not check this match.', crash: 'exit ' + code + ' ' + stderr }));
    child.send({ record: job.record, day: job.day });
  }

  return {
    // Resolves { ok, result } or { ok: false, message }; null when the queue is full.
    check(record, day) {
      if (queue.length >= maxQueue) return null;
      return new Promise((resolve) => { queue.push({ record, day, resolve }); next(); });
    },
    get size() { return queue.length + (running ? 1 : 0); }
  };
}

// opts: { db, log, build, userIdForRequest, now, checker }
function create(opts) {
  const db = opts.db;
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const now = opts.now || Date.now;
  const checker = opts.checker || createChecker({ log });
  const submitLimit = ratelimit.window(12, 60 * 60 * 1000, now);
  // userId -> { day, status: 'checking'|'done'|'rejected', message, score }
  const checks = new Map();

  const q = {
    user: db.prepare('SELECT id, display_name, tag FROM users WHERE id = ?'),
    best: db.prepare('SELECT * FROM daily_scores WHERE day = ? AND user_id = ?'),
    upsert: db.prepare(`INSERT INTO daily_scores (day, user_id, score, won, secs, place, nations, peak, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, user_id) DO UPDATE SET score = excluded.score, won = excluded.won, secs = excluded.secs,
        place = excluded.place, nations = excluded.nations, peak = excluded.peak, at = excluded.at
      WHERE excluded.score > daily_scores.score`),
    top: db.prepare(`SELECT s.*, u.display_name, u.tag FROM daily_scores s JOIN users u ON u.id = s.user_id
      WHERE s.day = ? ORDER BY s.score DESC, s.at ASC LIMIT ?`),
    count: db.prepare('SELECT COUNT(*) AS n FROM daily_scores WHERE day = ?'),
    ahead: db.prepare('SELECT COUNT(*) AS n FROM daily_scores WHERE day = ? AND (score > ? OR (score = ? AND at < ?))')
  };

  const today = () => DailyCore.dayAt(now());
  const name = (r) => (r.tag ? '[' + r.tag + '] ' : '') + r.display_name;
  const row = (r, rank) => ({ rank, name: name(r), score: r.score, won: !!r.won, secs: r.secs, place: r.place, nations: r.nations, peak: r.peak });

  function requireUser(req) {
    const id = opts.userIdForRequest(req);
    const user = id === null ? null : q.user.get(id);
    if (!user) throw new ApiError(401, 'unauthorized', 'Sign in to post a score');
    return user;
  }

  function board(day, userId) {
    const top = q.top.all(day, TOP).map((r, i) => row(r, i + 1));
    const out = { day, today: today(), total: q.count.get(day).n, top, me: null, check: null };
    if (userId !== null) {
      const mine = q.best.get(day, userId);
      if (mine) out.me = row(Object.assign({}, mine, q.user.get(userId)), q.ahead.get(day, mine.score, mine.score, mine.at).n + 1);
      const c = checks.get(userId);
      if (c && c.day === day) out.check = { status: c.status, message: c.message || null, score: c.score === undefined ? null : c.score };
    }
    return out;
  }

  async function submit(req) {
    const user = requireUser(req);
    checkOrigin(req);
    const body = await readJson(req, UPLOAD_LIMIT);
    const day = body.day, rec = body.replay;
    const t = today();
    // Yesterday too: a match that started before midnight UTC ends after it.
    if (!Number.isInteger(day) || day < t - 1 || day > t) throw new ApiError(400, 'invalid', 'That Daily Challenge is closed.');
    if (!rec || typeof rec !== 'object') throw new ApiError(400, 'invalid', 'No replay sent.');
    if (opts.build && rec.build !== opts.build) {
      throw new ApiError(409, 'invalid', 'The game was updated since this match started, so it can\'t be checked. Play it again for the board.');
    }
    const stored = q.best.get(day, user.id);
    const claimed = Number.isInteger(body.claimed) ? body.claimed : Infinity;
    // Nothing to gain from checking a result that can't replace the stored one.
    if (stored && claimed <= stored.score) return { status: 'kept' };
    const pending = checks.get(user.id);
    if (pending && pending.status === 'checking') throw new ApiError(429, 'rate-limited', 'Still checking your last result. Try again in a minute.');
    if (!submitLimit.take(user.id)) throw new ApiError(429, 'rate-limited', 'Too many results this hour.');
    const job = checker.check(rec, day);
    if (!job) throw new ApiError(503, 'invalid', 'The leaderboard is busy. Try again in a few minutes.');
    checks.set(user.id, { day, status: 'checking' });
    job.then((out) => {
      if (!out.ok) {
        checks.set(user.id, { day, status: 'rejected', message: out.message });
        log.info('daily', 'day ' + day + ' user ' + user.id + ' rejected: ' + out.message);
        return;
      }
      const r = out.result;
      try {
        q.upsert.run(day, user.id, r.score, r.won ? 1 : 0, r.secs, r.place, r.nations, r.peak, now());
      } catch (e) {
        // The account may have been deleted while its replay was checked.
        log.warn('daily', 'could not store a score: ' + (e && e.message || e));
      }
      checks.set(user.id, { day, status: 'done', score: r.score });
      log.info('daily', 'day ' + day + ' user ' + user.id + ' scored ' + r.score + ' (' + r.title + ', ' + r.turns + ' turns)');
    });
    return { status: 'checking' };
  }

  // Answers any request under /api/daily/. Never rejects.
  async function handle(req, res) {
    try {
      const [route, query] = req.url.slice('/api/daily/'.length).split('?');
      if (req.method === 'GET' && route === 'board') {
        const m = /(?:^|&)day=(\d{1,6})(?:&|$)/.exec(query || '');
        const day = m ? Number(m[1]) : today();
        const id = opts.userIdForRequest(req);
        return send(res, 200, board(day, id));
      }
      if (req.method === 'POST' && route === 'submit') return send(res, 202, await submit(req));
      throw new ApiError(404, 'not-found');
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message });
      log.error('daily', 'request failed: ' + (e && e.stack || e));
      if (!res.headersSent) send(res, 500, { error: 'server', message: 'Something went wrong' });
    }
  }

  return { handle, board };
}

module.exports = { create, createChecker };
