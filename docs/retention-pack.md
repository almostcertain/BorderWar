# Retention pack — sound, Daily Challenge, match report

> **STATUS (2026-11-11): built on branch `feature/retention-pack`, awaiting owner
> review.** Not merged, not deployed. Nothing here changes the simulation.

## Quick reference

- **Brief:** "notable and significant improvements that will draw more people in
  and retain them", with free choice of what.
- **What was built:** three client-only features.
  1. **Sound effects** — the game was silent apart from music.
  2. **Daily Challenge** — one shared match a day, with a score, a personal best
     and a play streak. A reason to come back tomorrow.
  3. **Match report** — a chart and headline numbers on the end card, and a
     **Share result** button. A reason to show someone else.
- **Sim impact: none.** No sim file, `js/net/*`, `js/fx.js` or `js/replay.js` was
  touched, so the goldens are unaffected and `compare` was not needed.
- **Server impact: none.** Everything is stored in the browser. There is no
  global daily leaderboard yet (§5).
- **Needs your ears:** the sounds are synthesized and were checked by machine
  (they render, at sane levels, on the right events), not by listening. See §6.

## Why these three

The game already has the long-term layer (achievements, cosmetics, accounts), a
tutorial, replays and an open lobby. What it lacked:

| Gap | Effect on players | Answer |
|---|---|---|
| No sound at all besides music | A war game with silent nukes feels unfinished in the first minute; events off screen go unnoticed | Sound effects |
| No reason to return on a given day | Achievements run out; nothing is new tomorrow | Daily Challenge and streak |
| A match ends on one line of text | Nothing to look back on, nothing to send a friend | Match report and sharing |

Sharing is the acquisition piece: a shared daily result carries the link
`borderwar.io/?daily`, which opens straight onto that day's challenge.

---

## 1. Sound effects (`js/sfx.js`)

Synthesized with Web Audio, like the music: no audio files, nothing to license,
nothing to download.

| Sound | When |
|---|---|
| Drums | You launch an attack or a boat |
| Horn | A nation starts a new attack on you |
| Hammer and chime | One of your structures finishes |
| Coins | Trade income or a donation arrives |
| Rising fanfare | You eliminate a nation or tribe |
| Two-note ping | An alliance request reaches you |
| Whoosh | You launch a nuke |
| Siren | A nuke is heading for your land |
| Explosion | A nuke lands (loud on screen, a rumble off it; silent if fog hides it) |
| Short rise | The spawn phase ends and the match begins |
| Chime | Achievement earned |
| Victory / defeat stings | The end card appears |
| Click | Any button |

- **Options → Sound effects** and **Effects volume**. On by default for players;
  off by default on a developer's own machine, the same rule the music uses.
- Each sound has a minimum gap, so a burst of events reads as one sound.
- Silent while a replay is seeking or a reconnect is catching up.
- It watches sim state once per drawn frame and writes none.

## 2. Daily Challenge (`js/daily.js`)

A singleplayer match whose map, rules and rival nations are the same for every
player that day. Only the spawn point and the play differ.

**For the player**

- A gold **Daily Challenge #N** row on the main menu, showing today's settings,
  or "Done today · best 1,840 · new map in 5h" once played.
- A **streak** chip on that row: green once today is done, red when yesterday
  was played and today is not yet (the streak is at stake).
- Clicking it opens a panel: map preview, the rules, today's best, and Play.
- The end card shows the score, whether it is a personal best, and the streak.
  **Play Again** after a daily starts another attempt at it.

**Rules**

- The day changes at 00:00 UTC, so everyone has the same challenge at once.
- Unlimited attempts; the best score counts.
- Score = 20 per 1% of the map held at your peak + 15 per nation you outlast
  + 1,000 for winning + up to 1,000 more for winning fast (one point lost per
  3 seconds).
- A loss shorter than 2 minutes does not count, for the score or the streak.
- Leaving mid-match counts as falling at that moment.
- Opening the debug panel voids the attempt (developer machines only).

**What varies by day**

| Day (UTC) | Difficulty | Map |
|---|---|---|
| Monday | Easy | Small, 20 nations |
| Tuesday to Thursday | Medium | Small, 20 nations |
| Friday, Sunday | Hard | Small, 20 nations |
| Saturday | Medium | Medium, 46 nations ("Big map") |

Landform, terrain and rivers are drawn from the day number. About one day in
three has fog of war. Points of interest are always on.

**Storage:** the browser only (`borderwar_daily`), last 60 days. It does not
follow an account to another device yet (§5).

## 3. Match report (`js/matchstats.js`)

On the end card of every match except replays, the tutorial and the admin watch:

- A chart of your share of the map over time against the strongest rival's.
- Four numbers: time, peak land, best rank, finishing place.
- **Share result:** the phone's share sheet on touch devices, otherwise copies
  to the clipboard. Example:

  ```
  BorderWar Daily #11 (Continents · Medium)
  Victory in 14:32 · 2,140 points · 4-day streak
  Same map for everyone today: https://borderwar.io/?daily
  ```

Works in multiplayer too. The end card now scrolls if a short screen cannot fit it.

---

## 4. Decisions for the owner

These are my calls; each is a one-line change if you disagree.

1. **Sound on by default** for players. The alternative is opt-in.
2. **Unlimited daily attempts.** One attempt a day has higher stakes, but a
   match takes 15 to 30 minutes and an early death would end the day.
3. **The streak counts days played, not days won.** Friendlier to new players.
4. **Daily progress is per browser.** Syncing it to accounts is in §5.
5. **Day 1 is 1 November 2026.** Change `Daily.EPOCH` before launch if you want
   the numbering to start on release day.
6. **Sharing links to borderwar.io.** Fixed in `MatchStats.SITE`.

## 5. Not built, recommended next

- **Global daily leaderboard.** The feature that would make the daily social.
  Needs a server route and a view on trust: a client reports its own score, so
  without replay verification the board can be faked. Replays already exist,
  so the server could re-run a submitted one.
- **Daily progress on accounts**, the way achievements sync.
- **Daily achievements and a cosmetic** for a 7-day streak, to tie this into
  the existing unlocks.
- **A What's new post** announcing all three (posts live on the server).
- **Minimap.** The large maps would benefit; left out to keep this change away
  from the renderer.

## 6. What was and was not verified

Checked in the `borderwar` preview, Atlas and Classic themes, desktop and phone
widths, with no console errors:

- Daily: menu row, panel, a match played to defeat, score, best kept across a
  worse attempt, attempt count, streak, the under-2-minutes rule, leaving
  mid-match, Play Again.
- Report: chart and numbers on a daily and on a normal Solo match.
- Sound: all 14 sounds render audio without clipping; sounds fire during a
  live match.

Not checked:

- **How the sounds actually sound.** Please play a match with them on.
- A **victory** (only defeats were played), a multiplayer match, and the
  streak across a real midnight.
- **Share** on a real phone, and the clipboard (the preview pane refuses
  clipboard access, so the button showed its fallback text).
- Firefox and Safari.

## 7. Files

New: `js/sfx.js`, `js/daily.js`, `js/matchstats.js`, this document.
Edited: `index.html` (menu row, daily panel, end card block, two option rows,
script list), `js/main.js` (starting a daily, per-turn and per-frame hooks),
`js/ui.js` (four one-line hooks), `js/options.js`, `css/style.css`,
`css/atlas.css`, `CLAUDE.md` (module map).
