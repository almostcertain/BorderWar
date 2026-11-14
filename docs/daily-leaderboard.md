# Daily Challenge — global board, account sync, daily achievements

> **STATUS (2026-11-13): built on branch `feature/retention-pack`, awaiting owner
> review.** Follows `retention-pack.md` §5. No sim file changed, so the goldens
> are unaffected.

## Quick reference

- **Global board:** today's and yesterday's top 20 in the Daily panel, plus your
  own rank. The end card says "Checking your match…" and then your rank.
- **Trust:** the server never takes the client's score. It re-runs the submitted
  replay through the real sim and stores the score it computes itself (§2).
- **Who is ranked:** signed-in accounts only, shown by display name and tag.
  Guests see the board and a "sign in to post" line (§5, decision 1).
- **Account sync:** daily results and streaks travel with the account, merged
  like achievements (§4).
- **Achievements:** a new *Daily Challenge* group of four (§3). The 7-day streak
  unlocks the **Sun** emblem.

## 1. Flow

1. A daily ends for the player (fall, win, someone else wins, or Exit after the
   spawn phase). `MatchStats` settles the result **on that exact turn** with
   `DailyCore.settle` (`js/daily-core.js`), the same code the server runs.
2. `Daily.submit` posts `{ day, claimed, replay }` to `POST /api/daily/submit`.
   Results under 2 minutes, and attempts with the debug panel opened, are not sent.
3. The server answers `202 checking` at once and queues the replay.
4. The client polls `GET /api/daily/board?day=N` every 4 s until the check is
   `done` or `rejected`, then shows the rank.

## 2. Server check (`server/daily.js`, `server/dailyreplay.js`)

Before re-running, the route refuses (no sim work):

| Check | Answer |
|---|---|
| Not signed in | 401 |
| Day is not today or yesterday (UTC) | 400 |
| Replay `build` differs from the server's | 409 "the game was updated…" |
| `claimed` ≤ the player's stored best that day | `kept`, no re-run |
| A check of theirs is already running | 429 |
| More than 12 submissions in an hour | 429 |
| Queue holds 30 jobs | 503 |

The re-run (`dailyreplay.js`), one job per child process, `nice 19`, 5-minute
timeout:

- `Replay.validate`, one-player roster, and the settings and seed must equal
  `DailyCore.challenge(day)` exactly, as LocalServer writes them.
- Every recorded checksum (one per 100 turns) must match. A mismatch means a
  different build or debug cheats; rejected.
- Turns are applied until the player falls or someone wins, then scored with
  `DailyCore.settle`. A replay that stops while the match is undecided is scored
  as leaving at that point. Capped at 54,000 turns (90 minutes).
- Only a higher score replaces the stored one (`daily_scores`, one row per
  account per day; deleted with the account).

**Cost**, measured 2026-11-13 on a dev machine, sim loaded into the child's own
globals (a `vm` sandbox was about 3x slower):

| Day | Map | Per turn | A 20-minute match |
|---|---|---|---|
| Sunday to Friday | small, 20 nations | ~1.4 ms after the opening | ~15–25 s |
| Saturday | medium, 46 nations | ~4 ms | ~60–90 s |

The `kept` short-cut means only a new personal best costs a re-run.

**Exactness:** client and server scored the same real match identically
(83 points, 152 s, 18th of 21) in the browser check. Before the fix in step 1,
the client settled when the end card appeared, which in a catch-up could be
many turns late; the server caught that.

### What this does and does not stop

- **Stops:** typed-in scores, edited local storage, a replay of another day or
  edited settings, a replay with debug gold, any score the inputs don't produce.
- **Does not stop:** a bot or script playing the match through real inputs
  (tool-assisted play), or someone submitting another player's replay file under
  their own account. Both need real effort; a top-score review using stored
  replays would be the next step (§6).

## 3. Achievements and cosmetics (`js/progress-defs.js`)

| Achievement | Condition | Unlocks |
|---|---|---|
| Daily Recruit | Post a daily result (2 minutes or more) | — |
| Daily Victor | Win a daily | Banner *Dawn* |
| Devoted | 7-day daily streak | Emblem *Sun* ☀ |
| Ever Present | 30-day daily streak | Title *the Devoted* |

The streak achievements read a new counter, `dailyStreak`, which holds the
longest streak and only rises (`Progress.raise`). They are judged by the
client, on the same honour system as every other achievement
(`metaprogression.md` §7). Only the board is server-checked.

## 4. Account sync

- `POST /api/progress` takes an optional `daily` field and always returns the
  merged copy; `GET` returns it too. Stored in `users.daily_json` (migration 4).
- Merge (`DailyCore.merge`): per day the higher score wins and tries take the
  larger; `last` and `bestStreak` take the larger; the streak is rebuilt from the
  union of days, so days played on two devices join into one run. Repeat-safe.
- The progress route's body limit is 16 KB (60 days of results); other routes keep 4 KB.
- Signing out clears this browser's copy, as with achievements.
- The admin per-user export includes the daily progress and board rows.

## 5. Decisions for the owner

1. **Accounts only on the board.** Guests are probably most players, but a guest
   name can't be held to one entry or moderated. Alternative: rank guests by
   browser ID under their chosen name.
2. **Today and yesterday only** may be submitted, so a match that crosses
   midnight UTC still counts.
3. **Top 20 shown**, plus your own row if you're lower.
4. **A deploy invalidates replays in flight.** A match started on the old build
   gets "the game was updated" and must be replayed for the board. Its local
   best and streak still count.
5. **Ever Present (30 days)** and **Daily Victor** were added beyond the brief's
   7-day cosmetic, to fill out the group.

## 6. Not built

- Keeping the best replays on the server, so the top runs can be watched and
  reviewed (also the answer to tool-assisted runs).
- An all-time or weekly board.
- A *Top 10 finish* achievement (it would need the server to vouch for it).

## 7. Tests

- `node --test tools/daily.test.js`: scoring, day numbering, sanitize and merge.
- `node --test tools/progress.test.js`: counters and the streak unlock.
- `cd server && node --test daily.test.js accounts/accounts.test.js`: route checks,
  ranking and "only raised", a real replay re-run, tampered seed, settings and
  checksums; daily sync through `/api/progress`.
- Browser (`borderwar-mp` with an in-memory DB): a real daily played to "Left",
  scored 83 by both client and server; the board, sync after clearing local
  storage, the achievements panel, phone width; no console errors.
