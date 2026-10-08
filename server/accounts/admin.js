// Owner's command line for accounts (AU-7, docs/accounts-auth.md §5). Run on
// the host, against the same database file the server uses:
//
//   node server/accounts/admin.js export <email>            everything held for one account, as JSON
//   node server/accounts/admin.js reset-password <email>    set a temporary password, sign them out
//   node server/accounts/admin.js revoke-sessions <email>   sign one account out everywhere
//   node server/accounts/admin.js revoke-sessions --all     sign everyone out (docs/breach-response.md)
//
// Safe to run while the server is up; SQLite handles the second connection.
'use strict';

const crypto = require('crypto');
const dbModule = require('./db');
const passwords = require('./passwords');
const validate = require('./validate');

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

async function main(argv) {
  const [command, arg] = argv;
  const usage = 'Usage: node server/accounts/admin.js export <email> | reset-password <email> | revoke-sessions <email>|--all';
  if (!arg || !['export', 'reset-password', 'revoke-sessions'].includes(command)) {
    console.error(usage);
    return 2;
  }
  const db = dbModule.open(process.env.BORDERWAR_DB);
  try {
    let out;
    if (command === 'export') {
      const data = exportUser(db, arg);
      out = data && JSON.stringify(data, null, 2);
    } else if (command === 'reset-password') {
      const temp = await resetPassword(db, arg);
      out = temp && 'Temporary password: ' + temp + '\nTheir sessions were ended. Ask them to change it after signing in.';
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

module.exports = { exportUser, resetPassword, revokeSessions };
