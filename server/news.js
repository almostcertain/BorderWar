// What's new: one short post, written on the admin page and shown from the
// game's main menu (UI.setupNews). The text is stored as typed; the browser
// renders its markup (js/markup.js).
//
//   GET /news          public: { post: { title, body, at } | null }
//   POST /admin/news   { title, body } replaces the post; both empty removes
//                      it. server/admin.js checks the token before `publish`.
//
// With `file` the post is kept there, so it survives a restart.
'use strict';

const fs = require('fs');
const path = require('path');
const { ApiError, send, readJson } = require('./httpapi');

const FILE = path.join(__dirname, 'data', 'news.json');
const MAX_TITLE = 80;
const MAX_BODY = 1500;

// Trimmed text with \n line ends and no other control characters, or null if
// it isn't a string or is too long.
function cleanText(v, max, multiline) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s.trim();
  return s.length > max ? null : s;
}

function validPost(p) {
  return !!p && typeof p === 'object' && cleanText(p.title, MAX_TITLE, false) === p.title &&
    cleanText(p.body, MAX_BODY, true) === p.body && (p.title + p.body) !== '' && Number.isFinite(p.at);
}

// opts: { file, now, log } — all optional.
function create(opts) {
  opts = opts || {};
  const file = opts.file || null;
  const now = opts.now || Date.now;
  const log = opts.log || { warn() {}, error() {} };

  let post = null;
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (validPost(saved)) post = { title: saved.title, body: saved.body, at: saved.at };
    } catch (e) { /* none saved yet */ }
  }

  // Replaces the post and returns it; null when both fields are empty.
  function set(title, body) {
    const t = cleanText(title, MAX_TITLE, false), b = cleanText(body, MAX_BODY, true);
    if (t === null || b === null) throw new ApiError(400, 'invalid', 'Title is up to ' + MAX_TITLE + ' characters, text up to ' + MAX_BODY);
    post = (t || b) ? { title: t, body: b, at: now() } : null;
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(post));
      } catch (e) {
        log.warn('news', 'could not save the post: ' + (e && e.message || e));
      }
    }
    return post;
  }

  function serve(req, res) {
    send(res, 200, { post: post });
  }

  // Never rejects. The caller has already checked the admin token.
  async function publish(req, res) {
    try {
      const body = await readJson(req);
      return send(res, 200, { post: set(body.title, body.body) });
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message });
      log.error('news', 'request failed: ' + (e && e.message || e));
      if (!res.headersSent) send(res, 500, { error: 'server', message: 'Something went wrong' });
    }
  }

  return { get: () => post, set, serve, publish };
}

module.exports = { create, FILE, MAX_TITLE, MAX_BODY };
