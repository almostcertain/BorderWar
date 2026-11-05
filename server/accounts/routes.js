// Account HTTP routes (AU-2, docs/accounts-auth.md §4, §5.1), mounted under
// /api/ by server/index.js. Everything that changes state is a POST with a
// JSON body, a JSON content type and a same-host Origin; with no CORS headers
// sent, another site cannot produce that request.
'use strict';

const dbModule = require('./db');
const passwords = require('./passwords');
const sessionsModule = require('./sessions');
const ratelimit = require('./ratelimit');
const validate = require('./validate');
const entitlements = require('./entitlements');
const wallet = require('./wallet');
const emailTokensModule = require('./emailtokens');
const mailerModule = require('./mailer');
const ProgressDefs = require('../../js/progress-defs.js');
const { ApiError, send, clientIp, checkOrigin, readJson } = require('../httpapi');

// opts: { dbPath, db, log, now, scrypt, mailer, publicUrl } — all optional;
// tests pass ':memory:' and cheaper scrypt parameters. `publicUrl` is the base
// for emailed links; without it the request's own Origin is used (dev only,
// since a forged Host could point a reset link at another site).
function create(opts) {
  opts = opts || {};
  const db = opts.db || dbModule.open(opts.dbPath);
  const log = opts.log || { info() {}, warn() {}, error() {} };
  const now = opts.now || Date.now;
  const scrypt = opts.scrypt || passwords.DEFAULT_PARAMS;
  const sessions = sessionsModule.create(db, now);
  const emailTokens = emailTokensModule.create(db, now);
  const mailer = opts.mailer || mailerModule.create({});

  const loginLimit = ratelimit.window(10, 60 * 1000, now);
  const registerLimit = ratelimit.window(3, 60 * 60 * 1000, now);
  const emailLock = ratelimit.lockout(10, 15 * 60 * 1000, now);
  const forgotIpLimit = ratelimit.window(5, 60 * 60 * 1000, now);
  const forgotEmailLimit = ratelimit.window(3, 60 * 60 * 1000, now);
  const tokenLimit = ratelimit.window(10, 60 * 1000, now);
  const resendLimit = ratelimit.window(3, 60 * 60 * 1000, now);

  const q = {
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insert: db.prepare('INSERT INTO users (email, pass_hash, display_name, tag, created_at) VALUES (?, ?, ?, ?, ?)'),
    setProfile: db.prepare('UPDATE users SET display_name = ?, tag = ?, settings_json = ? WHERE id = ?'),
    setEmail: db.prepare('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?'),
    setVerified: db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email = ?'),
    setHash: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
    setProgress: db.prepare('UPDATE users SET progress_json = ?, equipped_json = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM users WHERE id = ?')
  };

  function publicUser(row) {
    let settings = {};
    try { settings = JSON.parse(row.settings_json) || {}; } catch (e) { /* keep {} */ }
    return {
      id: row.id, email: row.email, emailVerified: !!row.email_verified_at, displayName: row.display_name,
      tag: row.tag, settings, entitlements: entitlements.list(db, row.id), wallet: wallet.balances(db, row.id)
    };
  }

  // The stored copy, re-checked against today's tables in case an ID was retired.
  function storedProgress(row) {
    let progress = {}, equipped = {};
    try { progress = JSON.parse(row.progress_json) || {}; } catch (e) { /* keep {} */ }
    try { equipped = JSON.parse(row.equipped_json) || {}; } catch (e) { /* keep {} */ }
    const p = ProgressDefs.sanitize({ unlocked: progress.unlocked, counters: progress.counters, equipped });
    p.equipped = ProgressDefs.equippable(p, entitlements.list(db, row.id));
    return p;
  }

  const publicProgress = (p) => ({ unlocked: p.unlocked, counters: p.counters, equipped: p.equipped });

  function currentUser(req) {
    const id = sessions.userIdForRequest(req);
    return id === null ? null : (q.byId.get(id) || null);
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new ApiError(401, 'unauthorized');
    return user;
  }

  function sessionCookie(userId, origin) {
    // Secure whenever the page itself is https. A plain-http page (localhost,
    // or a LAN address during a playtest) could not store a Secure cookie.
    return sessionsModule.cookieHeader(sessions.start(userId), origin.protocol === 'https:', sessionsModule.MAX_AGE_MS);
  }

  function clearCookie(origin) {
    return sessionsModule.cookieHeader('', origin.protocol === 'https:', 0);
  }

  // Spends the same time on an unknown email as on a wrong password, so the
  // response time does not reveal which emails have accounts.
  let dummyHash = null;
  async function checkPassword(user, password) {
    if (typeof password !== 'string' || password.length > 128) password = '';
    if (!user) {
      if (!dummyHash) dummyHash = await passwords.hash('not a real password', scrypt);
      await passwords.verify(password, dummyHash);
      return false;
    }
    return passwords.verify(password, user.pass_hash);
  }

  const linkBase = (origin) => (opts.publicUrl || origin.origin).replace(/\/+$/, '');

  // Best effort: a mail that fails to send never fails the request.
  function sendVerify(user, origin) {
    if (!mailer.enabled) return;
    const token = emailTokens.issue(user.id, 'verify', user.email);
    mailer.send(user.email, 'Confirm your BorderWar email',
      'Confirm this address for your BorderWar account:\n\n' + linkBase(origin) + '/#verify=' + token
      + '\n\nThe link works for 24 hours. If you did not create an account, ignore this email.');
  }

  function newPassword(v) {
    if (typeof v !== 'string' || v.length < 8 || v.length > 128) {
      throw new ApiError(400, 'invalid', 'Password must be 8 to 128 characters');
    }
    if (!validate.password(v)) throw new ApiError(400, 'invalid', 'That password is too common. Pick another.');
    return v;
  }

  async function requirePassword(user, password) {
    if (!(await checkPassword(user, password))) throw new ApiError(403, 'bad-credentials', 'Wrong password');
  }

  const post = {
    async register(req, body, origin) {
      const ip = clientIp(req);
      if (!registerLimit.take(ip)) throw new ApiError(429, 'rate-limited', 'Too many new accounts from here, try again later');
      const email = validate.email(body.email);
      if (!email) throw new ApiError(400, 'invalid', 'Enter a valid email address');
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
        throw new ApiError(400, 'invalid', 'Password must be 8 to 128 characters');
      }
      if (!validate.password(body.password)) throw new ApiError(400, 'invalid', 'That password is too common. Pick another.');
      const name = body.displayName === undefined ? 'Player' : validate.displayName(body.displayName);
      if (!name) throw new ApiError(400, 'invalid', 'Name must be 1 to 20 characters, without [ or ]');
      const tag = body.tag === undefined ? '' : validate.tag(body.tag);
      if (tag === null) throw new ApiError(400, 'invalid', 'Tag must be up to 5 letters or digits');
      if (q.byEmail.get(email)) throw new ApiError(409, 'email-taken');

      const hash = await passwords.hash(body.password, scrypt);
      let id;
      try {
        id = Number(q.insert.run(email, hash, name, tag, now()).lastInsertRowid);
      } catch (e) {
        // Two sign-ups for one email raced past the check above.
        if (q.byEmail.get(email)) throw new ApiError(409, 'email-taken');
        throw e;
      }
      log.info('accounts', 'sign-up user ' + id);
      const created = q.byId.get(id);
      sendVerify(created, origin);
      return { body: { user: publicUser(created) }, cookie: sessionCookie(id, origin) };
    },

    async login(req, body, origin) {
      const ip = clientIp(req);
      if (!loginLimit.take(ip)) throw new ApiError(429, 'rate-limited');
      const email = validate.email(body.email) || '';
      if (emailLock.locked(email)) throw new ApiError(429, 'rate-limited', 'Too many attempts, try again in 15 minutes');
      const user = email ? q.byEmail.get(email) : null;
      if (!(await checkPassword(user, body.password))) {
        if (email) emailLock.fail(email);
        log.warn('accounts', 'sign-in failed' + (user ? ' for user ' + user.id : ''));
        throw new ApiError(401, 'bad-credentials');
      }
      emailLock.clear(email);
      if (passwords.needsRehash(user.pass_hash, scrypt)) {
        q.setHash.run(await passwords.hash(body.password, scrypt), user.id);
      }
      log.info('accounts', 'sign-in user ' + user.id);
      return { body: { user: publicUser(user) }, cookie: sessionCookie(user.id, origin) };
    },

    async logout(req, body, origin) {
      sessions.end(sessionsModule.readCookie(req));
      return { body: { user: null }, cookie: clearCookie(origin) };
    },

    async 'logout-all'(req, body, origin) {
      const user = requireUser(req);
      sessions.endAll(user.id);
      return { body: { user: null }, cookie: clearCookie(origin) };
    },

    async profile(req, body) {
      const user = requireUser(req);
      const name = body.displayName === undefined ? user.display_name : validate.displayName(body.displayName);
      if (!name) throw new ApiError(400, 'invalid', 'Name must be 1 to 20 characters, without [ or ]');
      const tag = body.tag === undefined ? user.tag : validate.tag(body.tag);
      if (tag === null) throw new ApiError(400, 'invalid', 'Tag must be up to 5 letters or digits');
      const settings = body.settings === undefined ? user.settings_json : validate.settings(body.settings);
      if (settings === null) throw new ApiError(400, 'invalid', 'Bad settings');
      q.setProfile.run(name, tag, settings, user.id);
      return { body: { user: publicUser(q.byId.get(user.id)) } };
    },

    // Unknown IDs and junk values are dropped, not refused (docs/metaprogression.md
    // §6.4, §7). Merging is repeat-safe, so a retried request changes nothing.
    async progress(req, body) {
      const user = requireUser(req);
      const stored = storedProgress(user);
      const sent = ProgressDefs.sanitize(body, now());
      // `equipped` is replaced whole when sent, kept when left out.
      const sentLoadout = body.equipped && typeof body.equipped === 'object';
      const merged = sentLoadout ? ProgressDefs.merge(stored, sent) : ProgressDefs.merge(sent, stored);
      merged.equipped = ProgressDefs.equippable(merged, entitlements.list(db, user.id));
      q.setProgress.run(JSON.stringify({ unlocked: merged.unlocked, counters: merged.counters }),
        JSON.stringify(merged.equipped), user.id);
      return { body: publicProgress(merged) };
    },

    async email(req, body, origin) {
      const user = requireUser(req);
      await requirePassword(user, body.password);
      const email = validate.email(body.email);
      if (!email) throw new ApiError(400, 'invalid', 'Enter a valid email address');
      const other = q.byEmail.get(email);
      if (other && other.id !== user.id) throw new ApiError(409, 'email-taken');
      if (email === user.email) return { body: { user: publicUser(user) } };
      q.setEmail.run(email, user.id);
      emailTokens.clear(user.id, 'reset');
      log.info('accounts', 'email changed for user ' + user.id);
      if (mailer.enabled) {
        mailer.send(user.email, 'Your BorderWar email was changed',
          'The email on your BorderWar account was just changed to another address.'
          + '\n\nIf that was not you, contact support@borderwar.io.');
      }
      const updated = q.byId.get(user.id);
      sendVerify(updated, origin);
      return { body: { user: publicUser(updated) } };
    },

    async password(req, body, origin) {
      const user = requireUser(req);
      await requirePassword(user, body.current);
      newPassword(body.next);
      q.setHash.run(await passwords.hash(body.next, scrypt), user.id);
      sessions.endAll(user.id);
      emailTokens.clear(user.id, 'reset');
      log.info('accounts', 'password changed for user ' + user.id);
      return { body: { user: publicUser(user) }, cookie: sessionCookie(user.id, origin) };
    },

    // Always answers ok, so it can't be used to find out which emails have
    // accounts.
    async 'forgot-password'(req, body, origin) {
      if (!mailer.enabled) throw new ApiError(503, 'mail-unavailable', 'Password reset is not available on this server');
      if (!forgotIpLimit.take(clientIp(req))) throw new ApiError(429, 'rate-limited', 'Too many requests, try again later');
      const email = validate.email(body.email);
      if (!email) throw new ApiError(400, 'invalid', 'Enter a valid email address');
      const user = q.byEmail.get(email);
      if (user && forgotEmailLimit.take(email)) {
        const token = emailTokens.issue(user.id, 'reset', user.email);
        mailer.send(user.email, 'Reset your BorderWar password',
          'Someone asked to reset the password for your BorderWar account. To choose a new one, open:\n\n'
          + linkBase(origin) + '/#reset=' + token
          + '\n\nThe link works for 1 hour. If you did not ask for this, ignore this email; your password has not changed.');
        log.info('accounts', 'reset link sent for user ' + user.id);
      }
      return { body: { ok: true } };
    },

    // Opening the link proves the player reads that mailbox, so the email
    // counts as verified too.
    async 'reset-password'(req, body, origin) {
      if (!tokenLimit.take(clientIp(req))) throw new ApiError(429, 'rate-limited');
      newPassword(body.password);
      const t = emailTokens.consume(body.token, 'reset');
      const user = t && q.byId.get(t.userId);
      if (!user || user.email !== t.email) throw new ApiError(400, 'bad-token', 'This reset link has expired or was already used. Ask for a new one.');
      q.setHash.run(await passwords.hash(body.password, scrypt), user.id);
      q.setVerified.run(now(), user.id, user.email);
      sessions.endAll(user.id);
      emailLock.clear(user.email);
      log.info('accounts', 'password reset for user ' + user.id);
      return { body: { user: publicUser(q.byId.get(user.id)) }, cookie: sessionCookie(user.id, origin) };
    },

    // Works without being signed in, so the link opens on any device.
    async 'verify-email'(req, body) {
      if (!tokenLimit.take(clientIp(req))) throw new ApiError(429, 'rate-limited');
      const t = emailTokens.consume(body.token, 'verify');
      const user = t && q.byId.get(t.userId);
      if (!user || user.email !== t.email) throw new ApiError(400, 'bad-token', 'This link has expired or was already used.');
      q.setVerified.run(now(), user.id, user.email);
      log.info('accounts', 'email verified for user ' + user.id);
      return { body: { ok: true } };
    },

    async 'resend-verification'(req, body, origin) {
      const user = requireUser(req);
      if (!mailer.enabled) throw new ApiError(503, 'mail-unavailable', 'Email is not available on this server');
      if (user.email_verified_at) return { body: { ok: true } };
      if (!resendLimit.take(String(user.id))) throw new ApiError(429, 'rate-limited', 'Too many emails sent, try again later');
      sendVerify(user, origin);
      return { body: { ok: true } };
    },

    async 'delete-account'(req, body, origin) {
      const user = requireUser(req);
      await requirePassword(user, body.password);
      q.remove.run(user.id);   // sessions and match rows go with it (ON DELETE CASCADE)
      log.info('accounts', 'deleted user ' + user.id);
      return { body: { user: null }, cookie: clearCookie(origin) };
    }
  };

  // Answers any request under /api/. Never rejects.
  async function handle(req, res) {
    try {
      const route = req.url.split('?')[0].slice('/api/'.length);
      if (req.method === 'GET' && route === 'me') {
        const user = currentUser(req);
        return send(res, 200, { user: user ? publicUser(user) : null });
      }
      if (req.method === 'GET' && route === 'progress') {
        return send(res, 200, publicProgress(storedProgress(requireUser(req))));
      }
      if (req.method === 'POST' && Object.prototype.hasOwnProperty.call(post, route)) {
        const origin = checkOrigin(req);
        const body = await readJson(req);
        const out = await post[route](req, body, origin);
        return send(res, 200, out.body, out.cookie);
      }
      throw new ApiError(404, 'not-found');
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message });
      log.error('accounts', 'request failed: ' + (e && e.stack || e));
      if (!res.headersSent) send(res, 500, { error: 'server', message: 'Something went wrong' });
    }
  }

  // Expired sessions are also dropped when they are next presented; this
  // clears the ones that never come back.
  sessions.prune();
  emailTokens.prune();
  const pruneTimer = setInterval(() => { sessions.prune(); emailTokens.prune(); }, 6 * 60 * 60 * 1000);
  pruneTimer.unref();

  return {
    handle,
    // The signed-in user id for a request (e.g. the /ws upgrade), or null.
    userIdForRequest: (req) => sessions.userIdForRequest(req),
    // The packs owned by whoever sent a request; [] for a guest.
    entitlementsForRequest(req) {
      const id = sessions.userIdForRequest(req);
      return id === null ? [] : entitlements.list(db, id);
    },
    mailEnabled: mailer.enabled,
    close() { clearInterval(pruneTimer); db.close(); },
    db
  };
}

module.exports = { create };
