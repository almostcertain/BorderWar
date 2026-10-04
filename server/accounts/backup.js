// Daily copies of the account database (AU-7, docs/accounts-auth.md §5): one
// file per day in a `backups` folder beside it, the oldest dropped after KEEP
// days. That limit is also how long a deleted account can survive in a backup,
// and the privacy policy quotes it; change both together.
'use strict';

const fs = require('fs');
const path = require('path');

const KEEP = 14;
const CHECK_MS = 60 * 60 * 1000;
const NAME = /^borderwar-\d{4}-\d{2}-\d{2}\.db$/;

function fileFor(ms) {
  return 'borderwar-' + new Date(ms).toISOString().slice(0, 10) + '.db';
}

// Writes today's backup if there isn't one yet, then prunes. Returns the new
// file's path, or null if today's already existed.
function run(db, dir, now, keep) {
  now = now || Date.now;
  keep = keep || KEEP;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, fileFor(now()));
  let made = null;
  if (!fs.existsSync(target)) {
    // VACUUM INTO writes a consistent snapshot even while the server is using
    // the database, which a plain file copy of a WAL database would not be.
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
    try { fs.chmodSync(target, 0o600); } catch (e) { /* no POSIX modes here */ }
    made = target;
  }
  // The names sort by date.
  const old = fs.readdirSync(dir).filter(f => NAME.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  return made;
}

// Backs up now and then checks hourly, so a server left running for weeks
// still gets one a day. opts: { log, now, keep }.
function start(db, dir, opts) {
  opts = opts || {};
  const log = opts.log || { info() {}, warn() {} };
  const tick = () => {
    try {
      const made = run(db, dir, opts.now, opts.keep);
      if (made) log.info('accounts', 'database backed up to ' + made);
    } catch (e) {
      log.warn('accounts', 'database backup failed: ' + (e && e.message || e));
    }
  };
  tick();
  const timer = setInterval(tick, CHECK_MS);
  timer.unref();
  return { stop() { clearInterval(timer); } };
}

module.exports = { run, start, KEEP };
