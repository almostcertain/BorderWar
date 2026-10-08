# Metaprogression — Achievements and Cosmetics

> **STATUS (2026-10-08): design only, nothing built.** §1 records the owner's
> decisions from 2026-10-08. §3 (the achievement list) and §4 (the cosmetic list)
> are drafts for the owner to tune. Tasks are in §9.

## Quick reference

- **Goal:** give players something to work towards across matches, without
  changing what happens inside a match.
- **What it is:** achievements, plus a small set of cosmetics unlocked by them.
  No XP, no levels, no currency.
- **No power, ever.** Nothing earned changes the simulation. Unlocks are cosmetic
  and visible; a new player and a veteran start every match identical.
- **Singleplayer counts** for achievements. Career stats stay multiplayer-only
  (`accounts-auth.md` A6 is unchanged).
- **Guests earn progress** in the browser. It moves into the account on sign-in.
- **Cosmetics are visible to other players**, so the equipped choice travels in
  the lobby and match-start data.
- **Sim impact: none.** Nothing under `js/game/*`, `ai.js`, `map.js` or `noise.js`
  changes. Two `js/net/` files do change (§6.3), which needs a golden re-record
  at the owner's say-so; it is planned to share the protocol bump AU-4 already needs.
- **Trust:** honour system. Unlocks are reported by the client, so a modified
  client can claim anything. Accepted, because nothing unlocked has any effect
  on play (§7).

---

## 1. Decisions taken

Settled by the project owner on 2026-10-08.

**P1 — Cosmetic and recognition only.** No unlock may alter the sim. This follows
from lockstep multiplayer and from fairness between new and old players.

**P2 — Achievements first; no XP or levels in v1.** Achievements give varied goals
for less grind. Levels can be layered on later (§10).

**P3 — Singleplayer counts for achievements.** Most players start against bots.
Stats (games, wins, finish percentile) remain multiplayer-only.

**P4 — Guests earn progress**, stored in the browser and merged into the account
on first sign-in.

**P5 — Cosmetics are visible to other players** in the lobby and in the match.

### Recommended, not yet confirmed

**R1 — Nation colour is not a cosmetic.** Colour is how players read the map. Two
neighbours picking the same colour, or a colour close to water or fog, hurts
everyone in the match. v1 cosmetics sit on top of the assigned colour (§4).

**R2 — Singleplayer wins need a minimum match** to count: at least 8 starting
nations and Medium or Hard bots. Otherwise a 1-bot Easy game unlocks everything.
Achievements that name a difficulty or mode state their own bar.

**R3 — Replays and the tutorial never award anything.**

---

## 2. User-facing behaviour

### 2.1 Earning

- When an achievement's condition is met, a toast appears in the match:
  the medal, its name, and the cosmetic it unlocked, if any. It never pauses or
  covers play.
- The end screen lists what was earned this match under the result text.
- Progress towards counted achievements ("Win 10 matches: 4/10") is shown in the
  achievements panel, not during play.

### 2.2 Achievements panel (main menu)

- A grid of medals: earned ones in colour with the date, unearned ones greyed with
  their condition shown. A few may be hidden until earned (marked in §3).
- A header line: "14 of 30 earned".
- Guests see the same panel, with a line: "Sign in to keep these on every device."

### 2.3 Cosmetics picker (same panel, second tab)

- One slot per cosmetic type (§4). Locked items show which achievement unlocks them.
- The choice is saved at once and used from the next lobby or match.

### 2.4 What other players see

- Lobby roster: the player's title next to their name.
- In the match: the title in the hover panel and nation menu; the capital emblem on
  the map.
- Fog of war: a cosmetic is only drawn where the thing it decorates is already
  visible to the viewer. It must never reveal a position (`fog-of-war.md`).

### 2.5 Signing in and out

- First sign-in on a browser: local progress and the account's progress are
  combined (an achievement earned in either place is kept). The local copy then
  becomes a cache of the account.
- Sign-out clears the local cache, so the next person on that browser does not
  inherit, or upload, someone else's medals.
- Deleting the account deletes its progress.

---

## 3. Achievements (draft list)

About 30, in four groups. Thresholds are placeholders to be tuned. "Win" means the
player's nation or team won, under R2 for singleplayer. *MP* = multiplayer only.

**First steps** (most players earn these in their first few matches)

| Name | Condition |
|---|---|
| First Blood | Eliminate a nation |
| Founder | Finish the tutorial |
| Landlord | Hold 25% of the map's land |
| Victory | Win a match |
| Sea Legs | Land a naval invasion on another landmass |
| Pact | Form an alliance |

**Mastery**

| Name | Condition |
|---|---|
| Veteran / Warlord / Conqueror | Win 5 / 25 / 100 matches |
| Hard Target | Win against Hard bots |
| World Power | Win on the world map |
| Big Country | Win on a large map |
| Last One Standing | Win a Battle Royale |
| In the Dark | Win a fog-of-war match |
| Team Player | Win a team match |
| Podium *(MP)* | Finish in the top 3 of a match with 8+ humans |
| Champion *(MP)* | Win a match with 8+ humans |

**Style** (these change how a match is played)

| Name | Condition |
|---|---|
| Clean Hands | Win without launching a nuke |
| Lone Wolf | Win without ever being in an alliance |
| Pacifist Economy | Reach the highest gold income in the match before your first attack on a nation |
| Blitz | Win in under N minutes of match time |
| Comeback | Win after falling below 2% of the map |
| Fortress | Win without losing your starting tile |
| Admiral | Sink N enemy boats with warships in one match |
| Iron Dome | Shoot down N nukes with SAMs in one match |
| Driller | Place the Drill and win |

**Hidden** (shown as "???" until earned)

| Name | Condition |
|---|---|
| So Close | Be the last nation eliminated |
| Betrayed | Be eliminated by a nation you were allied with in that match |
| Scorched Earth | Launch N nukes in one match |
| Kingmaker | Donate to an ally who goes on to win a free-for-all |

Rules that apply to all of them:

- Each is earned once. No tiers beyond the win-count trio.
- Conditions are measured in sim ticks or sim state, never wall-clock time, so
  every honest client would judge the same match the same way.
- Any condition the sim's current state cannot answer directly (for example
  "never launched a nuke") is tracked by the client during the match (§6.1).

---

## 4. Cosmetics (draft list)

Three types in v1. All are drawn on top of the normal map; none changes a colour
that carries meaning.

| Type | Where it shows | v1 count | Example unlocks |
|---|---|---|---|
| **Title** | Lobby roster, hover panel, nation menu | ~12 | "Admiral" from Admiral, "the Unbroken" from Fortress, "Champion" from Champion |
| **Capital emblem** | A small icon on the player's starting tile | ~8 | Crown from Conqueror, anchor from Sea Legs, drill bit from Driller |
| **Victory banner** | End screen, for everyone in the match, when this player wins | ~4 | Styles from Warlord, Hard Target, Last One Standing |

- Everyone has a default for each type (no title, plain capital, standard banner).
- Not every achievement unlocks a cosmetic; roughly half do.
- **Left out of v1:** nation colours (R1), border styles and territory patterns.
  Borders and territory are the hottest drawing paths on large maps
  (`perf-frame-rate-profile.md`), so they need their own performance work first.

---

## 5. Data

### 5.1 Definitions

One client-only file, `js/progress-defs.js`, holds two tables: achievements
(`id`, name, description, hidden flag, cosmetic unlocked) and cosmetics (`id`,
type, name). IDs are short stable strings (`win_hard`, `title_admiral`) and are
never reused or renamed once shipped; display names can change freely.

The server needs only the list of valid IDs, to reject junk (§6.4).

### 5.2 A player's progress

```
{
  v: 1,
  unlocked: { "<achievementId>": <unix ms>, … },
  counters: { wins: 7, … },          // only for counted achievements
  equipped: { title: "<id>"|null, emblem: "<id>"|null, banner: "<id>"|null }
}
```

- **Guest:** one localStorage key, `borderwar_progress`.
- **Account:** new columns on `users` — `progress_json` (unlocked + counters) and
  `equipped_json`. One schema migration. `ON DELETE` is covered because it is the
  user's own row.
- **Merging** two copies (local and account): `unlocked` is the union, keeping the
  earlier date; each counter takes the larger value; `equipped` takes the
  account's. Merging is safe to repeat, so a retried request does no harm.
- Counters take the larger value rather than the sum, so a guest who signs in
  cannot double-count by merging twice. The cost: wins earned separately as a
  guest and on the account before the first sign-in are not added together.

---

## 6. Design

### 6.1 Tracking (`js/progress.js`, new, client-only)

- `Progress.beginMatch(info)` at match start; `Progress.sample()` about once a
  second from the main loop; `Progress.endMatch()` from `UI.checkEndGame`.
- It **reads** sim state and never writes it. Per-match working state (peak land
  share, "was ever allied", nukes seen) lives on `Progress`, not on `Game`.
- Skipped entirely when `Replay.active` or `Tutorial.active` (R3), apart from
  awarding Founder when the tutorial finishes.
- Things sampled state cannot show (the player's own nuke launches, say) are
  counted by watching for the result in sim state between samples where possible,
  and otherwise from the player's own intents as they are sent.
- Unlocks are written to storage immediately, then synced (§6.4).

### 6.2 UI (`js/ui.js`, `js/render.js`)

- `ui.js`: achievements panel and cosmetics picker in the main menu, the unlock
  toast, the "earned this match" block on the end screen, titles in the lobby
  roster, hover panel and nation menu.
- `render.js`: capital emblems, drawn in the existing structure/icon pass and
  cached per emblem so there is no per-frame allocation.
- Cosmetics for a match are read from a client-side table keyed by playerId, built
  from the match-start data. They are **not** written onto `Game.players`.

### 6.3 Carrying cosmetics to other players (`js/net/`, `server/`)

- `join` gains an optional `cosmetics` field: `{title, emblem, banner}` IDs.
- The server keeps it on the `Client`, checks each ID is a known ID of the right
  type (unknown → dropped), and includes it in `lobby_info` players and in
  `gameStartInfo.players`.
- `Game.init` reads only `clientID`, `username` and `playerId` from that roster,
  so the extra field never reaches the sim.
- `LocalServer` adds the player's own cosmetics to the singleplayer
  `gameStartInfo`, so singleplayer and multiplayer share one code path.
- Replays store `gameStartInfo` whole, so a replay shows the cosmetics as they
  were, with no extra work.
- Bots and tribes have none.
- **Goldens:** `js/net/protocol.js` and `js/net/localserver.js` are hashed by the
  harness, so `compare` will fail on this change even though sim behaviour is
  identical. It needs a deliberate re-record. AU-4 already requires a protocol
  bump and a `server/protocol.js` recopy; do both in the same milestone and
  re-record once.

### 6.4 Sync (`server/accounts/`, `js/account.js`)

| Route | Body | Result |
|---|---|---|
| `GET /api/progress` | — | `{unlocked, counters, equipped}` |
| `POST /api/progress` | `{unlocked?, counters?, equipped?}` | the merged result |

- `POST` merges as in §5.2 and returns the merged copy, which the client stores.
- The server rejects unknown IDs, non-numeric or absurd counters, and equipped
  items whose unlocking achievement isn't in the merged `unlocked` set. Same
  session cookie, Origin check and JSON-only rules as the other `/api/*` routes.
  The existing 4 KB body limit is enough for the full list.
- No account server (static hosting): everything works from localStorage and the
  sync calls are skipped, the same way the sign-in UI hides today.

---

## 7. Trust and cheating

- The server does not run the simulation, so it cannot check that an achievement
  was really earned. It can only check that the request is well-formed.
- A player who edits localStorage or the client can unlock everything and wear any
  cosmetic. **Accepted**: the reward is decoration, and it matches the standing
  position on cheating (`multiplayer-architecture.md` D2).
- Consequence for later work: **do not build leaderboards, ranked play or anything
  with real standing on top of achievements.** If that is ever wanted, the
  win- and placement-based ones can be re-derived on the server from AU-4's
  majority-voted match results; the "style" ones cannot.
- A guest's `cosmetics` in `join` are shown to others on the same trust.

---

## 8. Testing

- **Unit tests** (`node --test`): merge rules (union, earlier date, larger counter,
  repeat-safe); server validation (unknown ID, wrong type, equipped-but-locked);
  migration on an existing database.
- **Condition tests:** each achievement's check as a pure function of a recorded
  match summary, so the list can be tested without playing 30 matches.
- **Browser check** on the `borderwar` preview: earn First Blood against bots, see
  the toast and the end-screen line, reload and confirm it persisted; equip a
  title and emblem and see both in a singleplayer match; no console errors.
- **Two-client check:** each player sees the other's title in the lobby and emblem
  in the match; a fog match does not show an emblem on an unseen capital.
- **Sign-in merge:** earn as a guest, sign in, confirm it is on the account; sign
  out, confirm the browser is empty; sign in elsewhere, confirm it is there.
- **Performance:** emblems on the `large` map with a full lobby, checked with the
  allocation metrics in `perf-tools.md`.
- **Goldens:** PG-1, PG-2 and PG-4 touch no hashed file; no compare needed. PG-3
  does (§6.3).

---

## 9. Task breakdown

Each is one ticket. PG-1 and PG-2 give a complete, shippable feature for a single
browser with no server or protocol change.

1. **PG-1 Tracking and storage.** `js/progress-defs.js`, `js/progress.js`,
   localStorage, the eligibility rules (R2, R3), condition tests. Start with the
   achievements that need only sampled sim state.
2. **PG-2 Achievements UI.** Menu panel, unlock toast, end-screen block.
3. **PG-3 Cosmetics.** Picker, titles and emblems and banners drawn locally, then
   the `join` / `lobby_info` / `gameStartInfo` field so others see them. Shares
   the protocol bump and golden re-record with AU-4.
4. **PG-4 Account sync.** Migration, `/api/progress`, merge on sign-in, clear on
   sign-out. Needs only AU-1 to AU-3, which are built.
5. **PG-5 Fill out the list.** The remaining achievements that need per-match
   tracking beyond simple sampling, plus tuning thresholds from real play.

Suggested order: PG-1, PG-2, PG-4, then PG-3 alongside AU-4, then PG-5.

---

## 10. Later, not now

- **Levels and XP**, with a rank shown beside the name.
- **Daily or weekly challenge:** a fixed seed and a goal, with the replay as proof.
  The seeded sim and `replays.md` make this cheap; it is the natural next step.
- **Border styles and territory patterns**, after render performance work.
- **Preferred nation colour**, with a rule for clashes.
- **Server-verified achievements** from AU-4 match records (§7).
- **Profile cards:** click a player in the lobby to see their medals.
