# Accounts and Authentication — BorderWar

> **STATUS (2026-10-03): AU-1, AU-2 and AU-3 built** (storage, passwords, sessions,
> all §5.1 routes except `/api/stats`, menu strip and sign-in dialog). AU-4 to AU-7
> not started. §1 records the owner's decisions from 2026-10-03. Tasks are in §8.
> Tests: `cd server && npm test`.

## Quick reference

- **Goal:** let players optionally sign in so their name, tag, settings and match
  record persist across browsers and devices. Guest play stays exactly as it is today.
- **Sign-in:** email + password only. No third-party sign-in, no password recovery in v1.
- **Names:** display names are free-form and not unique. No reserved names, no badge.
- **Stats:** multiplayer only — games, wins, losses, and average finish place as a percentile.
- **Where it lives:** a new `server/accounts/` module (store, passwords, sessions,
  HTTP routes) and a small client `js/account.js` plus menu UI in `ui.js`.
- **Sim impact: none.** Accounts never touch `js/game/*`, `ai.js`, `map.js`,
  the turn stream or `gameStartInfo`'s shape. Goldens are unaffected.
- **Dependencies: none new.** Node built-ins only: `crypto.scrypt` for passwords,
  `node:sqlite` for storage (Node ≥ 22.13; checked working on 22.19, which prints a
  one-line "experimental" warning at startup — harmless).
- **Singleplayer / static hosting:** when the page isn't served by the Node server
  (e.g. `local-mac.command` on 8123), `/api/me` 404s and the sign-in UI hides itself.

---

## 0. Where we are today

Verified against the code on 2026-10-02:

- **No accounts by design.** `multiplayer-architecture.md` D2/D4 put accounts out of
  scope *for v1*. v1 has shipped, so this is the planned post-v1 addition, not a reversal.
- **Identity is a browser UUID.** `getPersistentID()` in `js/net/transport.js` keeps a
  random `borderwar_persistentID` in localStorage and sends it in `join`/`rejoin`.
  The server can't verify it; `GameServer.rejoinClient` gives a rejoining browser a
  fresh clientID rather than its old nation, because nothing proves ownership.
- **Name and tag are local.** `UI.getPlayerName()` reads the menu fields and stores
  `borderwar_username` / `borderwar_tag` in localStorage. Anyone can type any name.
- **Settings are local.** `js/options.js` stores one JSON blob in localStorage.
- **The server already knows who won.** `GameServer.recordWinnerVote` takes a strict
  majority of active clients' `winner` votes. That's the hook for recording results.
- **The sim already tracks finish places.** `Game.eliminatePlayer` writes
  `Game.placements` (playerId → place among `Game.nationCount` nations: humans and
  bots, never tribes). Nations still alive at the end, including the winner, have no entry.
- **One process, one origin.** `server/index.js` serves static files, `/lobbies`,
  `/buildinfo.json` and the `/ws` upgrade on one port behind Cloudflare Tunnel.
  Cookies set by `/api/*` are sent automatically on the `/ws` upgrade.

---

## 1. Decisions taken

Settled by the project owner on 2026-10-03.

**A1 — Sign-in is email + password, and nothing else.** No Google/Apple/Discord.

**A2 — No password recovery in v1.** Consequence: no email service is needed, so
emails are **not verified** — an email is just a login identifier, never shown to
anyone and never mailed. **A forgotten password means the account and its stats are
unreachable**; the only remedy is the owner resetting it by hand (§4, admin script).
The create-account form says so.

**A3 — Accounts are optional.** Guests play exactly as today.

**A4 — No name protection.** Display names are not unique and guests may use any
name, including one a signed-in player uses. No "verified" badge.

**A5 — Stats are wins, losses and average finish place as a percentile**, over all
recorded matches.

**A6 — Multiplayer only.** Singleplayer results are never recorded.

**A7 — Storage is a SQLite file** via `node:sqlite` at `server/data/borderwar.db`.

**B2 — Finish place counts all starting nations, bots included**, the same as the
defeat screen's "5th out of 32". Tribes are never counted.

**B3 — A player who quits mid-match is still recorded.** Their nation plays on in
everyone's sim; wherever it finishes is their place, and it counts as a loss unless
the nation (or its team) wins.

Nothing is open; tasks can be cut from §8.

---

## 2. User-facing behaviour

### 2.1 Menu

- Top of the main menu: **"Playing as guest · Sign in"**, or when signed in
  **"Signed in · Profile · Sign out"**.
- The sign-in modal is email + password with a "Create account" toggle (which adds a
  confirm-password field). Under the password field on create: *"There's no password
  reset yet, so keep this somewhere safe."*
- Errors inline: "Wrong email or password", "That email already has an account",
  "Too many attempts, try again in a minute".
- The name and tag fields work as today and stay editable. When signed in they are
  filled from the account and saved back to it when a game or lobby starts.
- The sign-in UI is hidden entirely when there's no account server (static hosting).

### 2.2 Profile panel

- Display name, clan tag.
- Change email, change password, "Sign out everywhere", delete account.
- **Stats:** games, wins, losses, win rate, **average finish: top N%**.
- Recent matches (last 20): date, map, mode, result, place "3rd of 32".

### 2.3 In game

- Nothing visible changes in a match. Names display as they do now.
- Reconnecting after a dropped connection or reload resumes your own nation
  (§5.4), for signed-in players and guests alike.

### 2.4 Settings sync

- Signed in: `options.js` values and name/tag load from the account on sign-in and
  save back on change (debounced). localStorage stays the offline cache.
- First sign-in on a browser: the server's copy wins if one exists; otherwise the
  local values are uploaded.

---

## 3. Data model

SQLite, one file, created on first start. Schema version tracked in a `meta` table so
later migrations are simple.

```
users
  id              INTEGER PRIMARY KEY
  email           TEXT NOT NULL UNIQUE   -- trimmed, lower-cased; login identifier only
  pass_hash       TEXT NOT NULL          -- "scrypt$N$r$p$salt$hash"
  display_name    TEXT NOT NULL          -- 1–20 chars, not unique
  tag             TEXT NOT NULL DEFAULT ''
  settings_json   TEXT NOT NULL DEFAULT '{}'
  progress_json   TEXT NOT NULL DEFAULT '{}'   -- achievements; see metaprogression.md §5.2
  equipped_json   TEXT NOT NULL DEFAULT '{}'   -- equipped cosmetics
  created_at      INTEGER NOT NULL       -- unix ms

sessions
  token_hash      TEXT PRIMARY KEY       -- sha256 of the cookie token; raw token never stored
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  created_at      INTEGER NOT NULL
  last_seen_at    INTEGER NOT NULL
  expires_at      INTEGER NOT NULL

matches
  id              INTEGER PRIMARY KEY
  game_id         TEXT NOT NULL
  ended_at        INTEGER NOT NULL
  duration_turns  INTEGER NOT NULL
  map             TEXT, mode TEXT
  nation_count    INTEGER NOT NULL       -- humans + bots at start

match_players
  match_id        INTEGER REFERENCES matches(id) ON DELETE CASCADE
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE
  player_id       INTEGER NOT NULL       -- sim playerId
  result          TEXT NOT NULL          -- 'win' | 'loss'
  place           INTEGER                -- 1 = best; NULL if clients didn't agree
  PRIMARY KEY (match_id, user_id)
```

**Stats are computed from `match_players`**, no counters to drift:

- games, wins, losses: row counts.
- **Finish percentile** for one match = `100 × (nation_count − place) / (nation_count − 1)`,
  so 1st is 100 and last is 0. The profile shows the mean over matches that have a
  place, phrased as "top N%" where N = 100 − mean (rounded, minimum 1).

**Email rules:** trimmed, lower-cased, ≤ 254 chars, must look like `x@y.z`. No further
checking, since nothing is ever mailed to it.

**Display name rules:** 1–20 chars after trimming, no control characters, no `[` `]`
(they'd collide with the clan-tag convention in `Teams.tagOf`). Same as a guest's.
Default on create: the name in the menu field, else "Player".

---

## 4. Security

Proportionate to a self-hosted game with no payments, but done properly since it's on
the open internet.

- **Passwords:** `crypto.scrypt`, N=2^15, r=8, p=1, 16-byte random salt, 64-byte key.
  Parameters are stored in the hash string so they can be raised later; a login with
  old parameters re-hashes. Compare with `crypto.timingSafeEqual`. Length 8–128,
  no composition rules. Reject common passwords (a bundled list; as built it holds
  about 250 entries of 8+ characters, since shorter ones already fail on length).
- **Sessions:** 32 random bytes, base64url, in cookie `bw_session`:
  `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30 days`. Store only its SHA-256.
  Sliding expiry: `last_seen_at` refreshed at most once an hour. Password change and
  "sign out everywhere" delete all of the user's sessions. `Secure` is set whenever
  the page's `Origin` is https and dropped on a plain-http origin, so localhost dev
  and LAN playtests (`http://<lan-ip>:8124`) can sign in. (As built; the first draft
  dropped it for localhost only, which would have silently broken LAN sign-in.)
- **CSRF:** every state-changing `/api/*` route is `POST` with a JSON body and requires
  `Content-Type: application/json` plus an `Origin` header matching the host. That
  combination can't be forged cross-site without CORS, and we send no CORS headers.
- **WebSocket origin:** the `/ws` upgrade now carries the session cookie, so it must
  check `Origin` too (cross-site WebSocket hijacking). Reject mismatched origins.
- **Rate limits (per IP, in memory):** login 10/min, create-account 3/hour, with a
  per-email lockout of 15 min after 10 failures. The client IP comes from
  Cloudflare's `CF-Connecting-IP` header, trusted only when the TCP peer is loopback
  (the tunnel); otherwise the socket address.
- **Unverified emails:** anyone can register any address. That's harmless here — the
  address gets nothing and unlocks nothing — but it means the real owner of an address
  may find it taken. Accepted for v1; fixed when verification arrives (§9).
- **Error messages:** login failure never says which field was wrong. Create-account
  does reveal that an email is taken; accepted, since there's no other way to tell the user.
- **Sensitive changes** (email, password, delete) require the current password.
- **Admin reset:** `node server/accounts/admin.js reset-password <email>` run on the
  host prints a one-time temporary password and clears that user's sessions. This is
  the only recovery path, at the owner's discretion.
- **Logging:** never log passwords, tokens, cookies, emails or IP addresses. Log
  sign-ups, sign-ins and failures with user id only (#53).
- **Personal data held:** email, display name, match results. Delete-account removes all of it.
- **Backups:** the DB is one file; the server itself (`server/accounts/backup.js`)
  snapshots it to `server/data/backups/` daily, keeping 14. `server/data/` is
  gitignored, is not under the static server's `PUBLIC_DIRS`, and the DB, backups and
  admin token are set to owner-only file access. The 14 days is quoted in
  `privacy.html`; change both together.
- **Data requests and incidents:** `admin.js export <email>` produces a player's data;
  `admin.js revoke-sessions --all` signs everyone out. See `docs/breach-response.md`.
- **Out of scope (D2 still holds):** this authenticates *who* a player is. It does
  not stop a modified client from cheating in a match, and stats inherit that.

---

## 5. Server design

### 5.1 HTTP routes (`server/accounts/routes.js`, mounted in `server/index.js`)

| Route | Body | Result |
|---|---|---|
| `GET /api/me` | — | `{user:{id,email,displayName,tag,settings}}` or `{user:null}` |
| `POST /api/register` | `{email,password,displayName?}` | sets cookie, returns `/api/me` shape |
| `POST /api/login` | `{email,password}` | sets cookie, returns `/api/me` shape |
| `POST /api/logout` | `{}` | clears this session |
| `POST /api/logout-all` | `{}` | clears all sessions for the user |
| `POST /api/profile` | `{displayName?,tag?,settings?}` | updated user |
| `POST /api/email` | `{password,email}` | updated user |
| `POST /api/password` | `{current,next}` | resets sessions, issues a new cookie |
| `POST /api/delete-account` | `{password}` | deletes user, sessions and match rows |
| `GET /api/stats` | — | `{games,wins,losses,avgPercentile,recent:[…20]}` |
| `GET`/`POST /api/progress` | see `metaprogression.md` §6.4 | `{unlocked,counters,equipped}` |

Body limit 4 KB. JSON errors: `{error:'code', message:'…'}` with stable codes
(`email-taken`, `bad-credentials`, `rate-limited`, `invalid`, `unauthorized`).

### 5.2 WebSocket identity

- On `/ws` upgrade, `index.js` checks `Origin`, parses `bw_session`, looks up the user
  and attaches `userId` (or null) to the connection before handing it to `GameManager`.
- `Client` gains `userId`. It is used for recording results and for rejoin, nothing else.
- `join` is unchanged: the client still sends its own `username`, which is the menu
  name (A4: no server-side name enforcement). `gameStartInfo.players` is unchanged —
  the sim never sees accounts.

### 5.3 Recording results and finish places

The server doesn't simulate, so places come from the clients, the same way the winner does.

- **Client:** when `Game.winnerId` is decided, `UI.checkEndGame` builds a final ranking
  of every nation, reading sim state only (never writing it):
  1. the winner (in team modes, the winning team's living members, most tiles first);
  2. other nations still alive, most tiles first, ties to the lower playerId;
  3. eliminated nations, by `Game.placements`.
  Since every client holds identical sim state, every honest client builds the same list.
- **Wire:** the `winner` message gains an optional `places` field: `[[playerId, place], …]`
  for the human players only. Protocol version bump; `server/protocol.js` recopied.
- **Server:** the winner majority works as today. For each human, the recorded place is
  the value a strict majority of active voters reported; with no majority, `place` is
  NULL and the match still counts as a win or loss.
- When the majority is reached and `end()` runs, `GameServer` hands the accounts module
  `{gameID, turns, map, mode, nationCount, roster, winnerId, winnerTeam, places}`.
  Each roster entry with a `userId` gets `win` if their nation or team won, else `loss`.
  A player who disconnected is still recorded, with wherever their nation finished (B3).
- Matches with no signed-in players, or that end without a winner majority, aren't stored.
- Writes are one transaction after the turn loop has stopped, so they can't stall a
  running match.

### 5.4 Rejoin (fixes the gap documented on `GameServer.rejoinClient`)

- At `start`, the server sends each client a private random `rejoinToken`, held in
  memory against `{gameID, clientID, playerId}`. The client keeps it in sessionStorage.
- `rejoin` gains an optional `rejoinToken` field. With a valid token (or a signed-in
  socket whose `userId` matches a roster slot), the server reattaches the connection to
  the **old clientID**, so intents keep coming from the same nation. Without one,
  today's behaviour is kept.
- Rides the same protocol bump as §5.3.

---

## 6. Client design

- **`js/account.js`** (new, loaded before `ui.js`): `Account.init()` calls `/api/me`
  and sets `Account.user` (or `null`, or `Account.available = false` on 404/network
  error). Methods `login`, `register`, `logout`, `saveProfile`, `saveSettings`
  (debounced 1 s), `stats`. All `fetch` with `credentials: 'same-origin'`.
- **`ui.js`:** menu account strip, sign-in modal, profile panel; `getPlayerName()`
  saves name/tag to the account when signed in; `checkEndGame` builds the ranking (§5.3).
- **`options.js`:** after a local save, call `Account.saveSettings` if signed in; on
  sign-in, apply `Account.user.settings`.
- **`transport.js`:** send `places` with the winner vote; store and send the
  `rejoinToken`. `persistentID` is left as is.
- None of this is sim code; the determinism rules don't apply, but none of it may
  write `Game` state.

---

## 7. Testing

- **Server unit tests** (`node --test server/accounts/*.test.js`): hash/verify and
  re-hash on old params; email normalisation and uniqueness; session create/expire/
  revoke; rate limiter; CSRF/Origin rejection; admin reset; result recording for
  win/loss/team win/place majority/no majority; percentile maths.
- **Integration script** (same style as the MP-2 scripted `ws` clients): register two
  users, open two sockets with their cookies, play to a scripted end with `places`,
  check `/api/stats` for both; drop and rejoin with token resumes the same clientID.
- **Browser check** on the `borderwar` server preview: create account, sign out, sign
  in, settings round-trip, no console errors.
- **Goldens:** not affected; run `compare` once at the end as a guard since
  `server/protocol.js` is recopied.

---

## 8. Task breakdown

Each is one ticket. AU-1 → AU-3 in order; the rest can go in any order after that.

1. **AU-1 Storage + passwords.** `server/accounts/db.js` (schema, migrations),
   `passwords.js`, name/email validation. Unit tests.
2. **AU-2 Sessions + HTTP routes.** `sessions.js`, `routes.js`, rate limits,
   Origin/CSRF checks, mounted in `index.js`. Unit tests.
3. **AU-3 Client sign-in UI.** `js/account.js`, menu strip, sign-in/create modal,
   name/tag saved to the account, hidden when unavailable.
4. **AU-4 Match results + places.** Cookie and Origin check on upgrade, `userId` on
   `Client`, `places` in the winner vote, recording on `end()`, `/api/stats`.
5. **AU-5 Profile, settings sync, stats display.** Profile panel (name, tag, email,
   password, sign out everywhere, delete), `options.js` sync, stats and recent matches.
6. **AU-6 Rejoin tokens.** §5.4. Closes the documented rejoin gap.
7. **AU-7 Ops.** Admin reset script, DB backup in `live-mac.command`, gitignore,
   README section, update the "no accounts" lines in `multiplayer-architecture.md`
   to point here.

---

## 9. Later, not now

- Email verification and password reset (needs an email provider).
- Sign in with Google/Apple/Discord. Considered and dropped for v1 on 2026-10-03;
  it would add an `identities` table alongside `users`, no rework of the rest.
- Friends list, invites to signed-in friends.
- Leaderboards. Only worth it with some answer to D2 (cheating), since stats are
  only as honest as the clients voting.
- Ranked matchmaking.
