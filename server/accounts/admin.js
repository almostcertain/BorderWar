// Owner's command line for accounts (AU-7, docs/accounts-auth.md §5). Run on
// the host, against the same database file the server uses:
//
//   node server/accounts/admin.js stats                     how many accounts exist, and recent signups
//   node server/accounts/admin.js export <email>            everything held for one account, as JSON
//   node server/accounts/admin.js reset-password <email>    set a temporary password, sign them out
//   node server/accounts/admin.js revoke-sessions <email>   sign one account out everywhere
//   node server/accounts/admin.js revoke-sessions --all     sign everyone out (docs/breach-response.md)
//   node server/accounts/admin.js grant <email> <pack>      give an account a paid pack (docs/customization.md)
//   node server/accounts/admin.js revoke <email> <pack>     take it away again (a refund)
//   node server/accounts/admin.js wallet <email>            balances and the last 20 changes
//   node server/accounts/admin.js adjust <email> <bb|marks> <+n|-n> <note>
//                                                           add or take currency (support, refunds)
//   node server/accounts/admin.js subscribe <email> <scout|warden|sovereign> [days]
//                                                           start or extend a subscription (default 30
//                                                           days) and grant that period's Border Bucks
//   node server/accounts/admin.js unsubscribe <email>       end it now
//   node server/accounts/admin.js release-name <name>       free a verified name (an abusive one)
//
// Safe to run while the server is up; SQLite handles the second connection.
'use strict';

const crypto = require('crypto');
const dbModule = require('./db');
const passwords = require('./passwords');
const validate = require('./validate');
const entitlements = require('./entitlements');
const wallet = require('./wallet');
const subscriptions = require('./subscriptions');
const names = require('./names');
const ShopDefs = require('../../js/shop-defs.js');

function findUser(db, email) {
  const clean = validate.email(email);
  return clean ? (db.prepare('SELECT * FROM users WHERE email = ?').get(clean) || null) : null;
}

const iso = (ms) => new Date(ms).toISOString();

// Everything stored about one account, or null if there is none. Leaves out
// the password hash and session token hashes: they are secrets, not the
// player's information.
function exportUser(db, email, now) {
  const user = findUser(db, email);
  if (!user) return null;
  let settings = {};
  try { settings = JSON.parse(user.settings_json) || {}; } catch (e) { /* keep {} */ }
  const parse = (json) => { try { return JSON.parse(json) || {}; } catch (e) { return {}; } };
  const progress = parse(user.progress_json);
  const sessions = db.prepare('SELECT created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at').all(user.id);
  const matches = db.prepare(
    'SELECT m.game_id, m.ended_at, m.duration_turns, m.map, m.mode, m.nation_count, p.player_id, p.result, p.place '
    + 'FROM match_players p JOIN matches m ON m.id = p.match_id WHERE p.user_id = ? ORDER BY m.ended_at').all(user.id);
  return {
    exportedAt: iso((now || Date.now)()),
    account: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      tag: user.tag,
      settings,
      createdAt: iso(user.created_at)
    },
    progress: { unlocked: progress.unlocked || {}, counters: progress.counters || {}, equipped: parse(user.equipped_json) },
    entitlements: entitlements.history(db, user.id).map(e => ({ pack: e.sku, grantedAt: iso(e.granted_at), source: e.source, ref: e.ref })),
    wallet: wallet.balances(db, user.id),
    subscription: subscriptions.summary(db, user.id, (now || Date.now)()),
    verifiedName: names.verifiedName(db, user.id, (now || Date.now)()),
    ledger: wallet.history(db, user.id, 1000).map(l => Object.assign({}, l, { createdAt: iso(l.createdAt) })),
    sessions: sessions.map(s => ({ createdAt: iso(s.created_at), lastSeenAt: iso(s.last_seen_at), expiresAt: iso(s.expires_at) })),
    matches: matches.map(m => ({
      gameId: m.game_id, endedAt: iso(m.ended_at), durationTurns: m.duration_turns, map: m.map, mode: m.mode,
      nationCount: m.nation_count, playerId: m.player_id, result: m.result, place: m.place
    }))
  };
}

// Sets a random temporary password and ends the account's sessions. Resolves
// to the temporary password, or null if there is no such account.
async function resetPassword(db, email, scrypt) {
  const user = findUser(db, email);
  if (!user) return null;
  const temp = crypto.randomBytes(12).toString('base64url');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await passwords.hash(temp, scrypt), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return temp;
}

// Ends every session of one account, or of all accounts when email is null.
// Returns how many were ended, or null if there is no such account.
function revokeSessions(db, email) {
  if (email === null) return Number(db.prepare('DELETE FROM sessions').run().changes);
  const user = findUser(db, email);
  if (!user) return null;
  return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Accounts that exist now, and how many of them were created in the last day
// and week. Deleted accounts are not counted.
function accountStats(db, now) {
  const t = (now || Date.now)();
  const row = db.prepare(
    'SELECT COUNT(*) AS total, '
    + 'COALESCE(SUM(created_at > ?), 0) AS day, COALESCE(SUM(created_at > ?), 0) AS week FROM users'
  ).get(t - DAY_MS, t - 7 * DAY_MS);
  return { total: Number(row.total), last24h: Number(row.day), last7d: Number(row.week) };
}

// Gives or takes one pack. Returns the account's packs afterwards, or null if
// there is no such account.
function setEntitlement(db, email, sku, on, now) {
  const user = findUser(db, email);
  if (!user) return null;
  if (on) entitlements.grant(db, user.id, sku, 'admin', '', now);
  else entitlements.revoke(db, user.id, sku);
  return entitlements.list(db, user.id);
}

// Admin change to a balance. May go below zero (taking back BB already spent).
// Returns the wallet afterwards, or null if there is no such account.
function adjustWallet(db, email, currency, delta, note, now) {
  const user = findUser(db, email);
  if (!user) return null;
  wallet.apply(db, user.id, currency, delta, { reason: note, source: 'admin', allowNegative: true, now });
  return wallet.balances(db, user.id);
}

function walletReport(db, email) {
  const user = findUser(db, email);
  if (!user) return null;
  const b = wallet.balances(db, user.id);
  const lines = ['Border Bucks: ' + b.bb + '   Marks: ' + b.marks];
  for (const l of wallet.history(db, user.id, 20)) {
    lines.push(iso(l.createdAt) + '  ' + (l.delta > 0 ? '+' : '') + l.delta + ' ' + l.currency
      + '  -> ' + l.balanceAfter + '  ' + l.source + (l.ref ? ' ' + l.ref : '') + (l.reason ? '  "' + l.reason + '"' : ''));
  }
  return lines.join('\n');
}

const DAY = 24 * 60 * 60 * 1000;

// Starts or extends a subscription by `days` from today (or from its current
// end, if later), grants that period's BB, and reserves the display name if
// it is free. Returns a summary line, or null if there is no such account.
function subscribe(db, email, tier, days, now) {
  const user = findUser(db, email);
  if (!user) return null;
  const t = (now || Date.now)();
  const sub = subscriptions.get(db, user.id);
  const from = sub && sub.status !== 'ended' ? Math.max(t, sub.period_end) : t;
  subscriptions.startPeriod(db, user.id, tier, from + days * DAY, { provider: 'admin', ref: 'admin-' + user.id + '-' + t, now: t });
  const r = names.reserve(db, user.id, user.display_name, t);
  const s = subscriptions.summary(db, user.id, t);
  return ShopDefs.tier(tier).name + ' until ' + iso(s.periodEnd).slice(0, 10)
    + '. Border Bucks: ' + wallet.balances(db, user.id).bb + '. '
    + (r.ok ? 'Verified name: ' + user.display_name : 'Name not reserved (' + r.error + '); they can pick another in the menu.');
}

function unsubscribe(db, email, now) {
  const user = findUser(db, email);
  if (!user) return null;
  return subscriptions.end(db, user.id, (now || Date.now)()) ? 'Ended. Their name stays reserved for 60 days.' : 'They had no subscription.';
}

const LIST_MAX = 200;

// One page of accounts, newest first, for the admin page. `query` matches part
// of the email or display name. `lastSeenAt` comes from live sessions only: it
// is null for someone who signed out everywhere. Leaves out secrets.
function listUsers(db, opts) {
  opts = opts || {};
  const limit = Math.min(LIST_MAX, Math.max(1, Math.floor(opts.limit) || 50));
  const offset = Math.max(0, Math.floor(opts.offset) || 0);
  const q = String(opts.query || '').trim().toLowerCase().slice(0, 100);
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const where = q ? "WHERE lower(email) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\'" : '';
  const args = q ? [like, like] : [];
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM users ' + where).get(...args).n);
  const rows = db.prepare(
    'SELECT u.id, u.email, u.display_name, u.tag, u.created_at, '
    + '(SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at, '
    + '(SELECT COUNT(*) FROM match_players p WHERE p.user_id = u.id) AS matches '
    + 'FROM users u ' + where.replace(/\b(email|display_name)\b/g, 'u.$1')
    + ' ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?'
  ).all(...args, limit, offset);
  return {
    total,
    users: rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      displayName: r.display_name,
      tag: r.tag,
      createdAt: Number(r.created_at),
      lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
      matches: Number(r.matches),
      packs: entitlements.list(db, r.id),
      wallet: wallet.balances(db, r.id),
      tier: subscriptions.activeTier(db, r.id, Date.now())
    }))
  };
}

async function main(argv) {
  const [command, arg, pack] = argv;
  const usage = 'Usage: node server/accounts/admin.js stats | export <email> | reset-password <email> | revoke-sessions <email>|--all'
    + ' | grant <email> <pack> | revoke <email> <pack> | wallet <email> | adjust <email> <bb|marks> <+n|-n> <note>'
    + ' | subscribe <email> <tier> [days] | unsubscribe <email> | release-name <name>';
  const packCommand = command === 'grant' || command === 'revoke';
  if (!['stats', 'export', 'reset-password', 'revoke-sessions', 'grant', 'revoke', 'wallet', 'adjust',
    'subscribe', 'unsubscribe', 'release-name'].includes(command) || (command !== 'stats' && !arg)) {
    console.error(usage);
    return 2;
  }
  const delta = Number(argv[3]);
  const note = argv.slice(4).join(' ').trim();
  if (command === 'adjust' && (!wallet.known(pack) || !Number.isSafeInteger(delta) || delta === 0
    || Math.abs(delta) > wallet.MAX_AMOUNT || !note)) {
    console.error('Usage: adjust <email> <bb|marks> <+n|-n> <note>   e.g. adjust a@b.co bb +500 refund for lost match');
    return 2;
  }
  if (packCommand && !entitlements.known(pack)) {
    console.error('Unknown pack. Known packs: ' + Object.keys(require('../../js/progress-defs.js').PACKS).join(', '));
    return 2;
  }
  const days = argv[3] === undefined ? 30 : Number(argv[3]);
  if (command === 'subscribe' && (!ShopDefs.tier(pack) || !Number.isInteger(days) || days < 1 || days > 3660)) {
    console.error('Usage: subscribe <email> <' + Object.keys(ShopDefs.TIERS).join('|') + '> [days, default 30]');
    return 2;
  }
  const db = dbModule.open(process.env.BORDERWAR_DB);
  try {
    let out;
    if (command === 'stats') {
      const s = accountStats(db);
      out = 'Accounts: ' + s.total + ' (' + s.last24h + ' in the last 24 h, ' + s.last7d + ' in the last 7 days)';
    } else if (command === 'export') {
      const data = exportUser(db, arg);
      out = data && JSON.stringify(data, null, 2);
    } else if (command === 'reset-password') {
      const temp = await resetPassword(db, arg);
      out = temp && 'Temporary password: ' + temp + '\nTheir sessions were ended. Ask them to change it after signing in.';
    } else if (command === 'subscribe') {
      out = subscribe(db, arg, pack, days);
    } else if (command === 'unsubscribe') {
      out = unsubscribe(db, arg);
    } else if (command === 'release-name') {
      out = names.release(db, argv.slice(1).join(' ')) ? 'Released.' : 'Nobody holds that name.';
    } else if (command === 'wallet') {
      out = walletReport(db, arg);
    } else if (command === 'adjust') {
      const b = adjustWallet(db, arg, pack, delta, note);
      out = b && 'Border Bucks: ' + b.bb + '   Marks: ' + b.marks + '\nThey see the change the next time they load the page.';
    } else if (packCommand) {
      const packs = setEntitlement(db, arg, pack, command === 'grant');
      out = packs && 'Packs on this account: ' + (packs.join(', ') || 'none') + '\nThey see the change the next time they load the page.';
    } else {
      const count = revokeSessions(db, arg === '--all' ? null : arg);
      out = count === null ? null : 'Ended ' + count + ' session' + (count === 1 ? '' : 's') + '.';
    }
    if (out === null) {
      console.error('No account with that email.');
      return 1;
    }
    console.log(out);
    return 0;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e && e.message || e);
    process.exitCode = 1;
  });
}

module.exports = { accountStats, adjustWallet, walletReport, subscribe, unsubscribe, exportUser, findUser, listUsers, resetPassword, revokeSessions, setEntitlement };
