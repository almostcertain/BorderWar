// Account storage (AU-1, docs/accounts-auth.md §3). One SQLite file through
// Node's built-in node:sqlite, created on first start. The schema version sits
// in `meta`, so a later change is one more entry in MIGRATIONS.
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'borderwar.db');

// Each entry takes the schema from version (index) to version (index + 1).
// Never edit a shipped entry; add a new one.
const MIGRATIONS = [
  `CREATE TABLE users (
     id            INTEGER PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     pass_hash     TEXT NOT NULL,
     display_name  TEXT NOT NULL,
     tag           TEXT NOT NULL DEFAULT '',
     settings_json TEXT NOT NULL DEFAULT '{}',
     created_at    INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash   TEXT PRIMARY KEY,
     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at   INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE matches (
     id             INTEGER PRIMARY KEY,
     game_id        TEXT NOT NULL,
     ended_at       INTEGER NOT NULL,
     duration_turns INTEGER NOT NULL,
     map            TEXT,
     mode           TEXT,
     nation_count   INTEGER NOT NULL
   );
   CREATE TABLE match_players (
     match_id  INTEGER REFERENCES matches(id) ON DELETE CASCADE,
     user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
     player_id INTEGER NOT NULL,
     result    TEXT NOT NULL,
     place     INTEGER,
     PRIMARY KEY (match_id, user_id)
   );`
];

function schemaVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) "
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(v + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// `file` may be ':memory:' (tests).
function open(file) {
  file = file || DEFAULT_PATH;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // Emails and password hashes: readable by the server's own user only. SQLite
  // gives the -wal and -shm files the same mode. (No effect on Windows.)
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch (e) { /* not ours to change */ } }
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

module.exports = { open, schemaVersion, DEFAULT_PATH, LATEST_VERSION: MIGRATIONS.length };
