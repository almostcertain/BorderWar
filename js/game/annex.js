// js/game/annex.js — Enclosed regions & annexation.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // True when `tile` has a 4-neighbour already owned by `playerId`, i.e. taking
  // it would keep that player's territory contiguous.
  touchesPlayer(tile, playerId) {
    const nb = this.abuf;
    const n = GameMap.neighbors(tile, nb);
    for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] === playerId) return true;
    return false;
  },

  // True when `playerId` already holds any land on the same landmass as
  // `tile` — the right test for "is this a normal land attack, not a naval
  // one," regardless of exactly which tile got clicked. A per-tile
  // touchesPlayer check is too strict here: attacking neutral or enemy land
  // has always worked by clicking anywhere on it, with the whole contiguous
  // border expanding from wherever the attacker actually touches it — not
  // just the one pixel that happens to be tapped. That matters most right at
  // the start of a match, when a nation is a ~49-tile dot easy to miss by a
  // tile at the default whole-map zoom.
  onSameLandmass(playerId, tile) {
    const p = this.players[playerId];
    if (!p) return false;
    const id = GameMap.landmassId[tile];
    for (const t of p.tiles) if (GameMap.landmassId[t] === id) return true;
    return false;
  },

  // Flood-fills the connected component of same-owner tiles containing
  // `startTile` and tests whether it is fully enclosed by OTHER players'
  // territory: walking outward from it can only ever land on more of the
  // same owner (interior) or on any other live player's land (a wall) —
  // reaching open water, unclaimed land, or the map edge means there's a gap
  // and it's not enclosed. Ported against OpenFront's actual
  // PlayerExecution.isSurrounded/isEnclosed source (github.com/openfrontio/
  // OpenFrontIO), collapsed from their two-stage cheap-filter-then-confirm
  // design into one walk since this runs on demand (a click, a bot's
  // decision, the periodic sweep below) rather than continuously across
  // every player every tick. Unclaimed land disqualifies too, not just
  // water — that looks stricter than OpenFront's isEnclosed alone, but
  // matches what actually happens in real matches: their cheap prefilter
  // already rejects any unowned neighbour before the lenient flood-fill ever
  // gets a chance to run. Returns {tiles, wallCounts} (annexable) or null
  // (not enclosed).
  //
  // The wall no longer has to be a single owner (2026-09-09 fix, see
  // dominantWaller below) — the original version took a `byPlayerId` and
  // rejected the whole walk the instant it touched any OTHER real player,
  // which matched real OpenFront for a besieger who walls a pocket alone but
  // silently refused every pocket ringed by a MIX of nations (a tribe or a
  // second bot contributing even one tile of the wall was enough to block
  // it forever, not just for the periodic sweep but for a human's own tap
  // too) — an easy thing to hit on a map seeded with dozens of tribes. Real
  // OpenFront hands a mixed-wall pocket to whichever bordering nation
  // "attacks it hardest" (owns the most of its border) instead of refusing
  // it, so this now tallies contact tiles per bordering owner in
  // `wallCounts` and leaves picking a winner to the caller.
  //
  // `seen`/`run` are how enclosedPocketsOf below walks many pockets in one
  // sweep without paying for the same ground twice: `seen` maps a tile to the
  // id of the walk that reached it, so every tile is expanded at most once
  // across the whole sweep. Meeting a tile stamped by an *earlier* walk means
  // this pocket has already been walked from another contact point and
  // rejected there — an accepted pocket is a whole connected component, so it
  // can never be touching this one — and this walk fails with it.
  enclosedRegion(startTile, seen, run) {
    const target = GameMap.owner[startTile];
    if (target < 0) return null;

    seen.set(startTile, run);
    const region = [startTile];
    const stack = [startTile];
    const wallCounts = new Map();
    const nb = this.abuf;

    while (stack.length) {
      const tile = stack.pop();
      const n = GameMap.neighbors(tile, nb);
      if (n < 4) return null; // touches the map edge
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        const o = GameMap.owner[j];
        if (o === target) {
          const walk = seen.get(j);
          if (walk === run) continue;
          if (walk !== undefined) return null; // already walked, already rejected
          seen.set(j, run);
          region.push(j);
          stack.push(j);
          continue;
        }
        if (o < 0) return null; // water or unclaimed land: a gap
        wallCounts.set(o, (wallCounts.get(o) || 0) + 1);
      }
    }
    return { tiles: region, wallCounts };
  },

  // Whichever bordering owner contributes the most wall-tile contact to an
  // enclosed pocket, tie-broken by lowest player id so every client agrees
  // regardless of Map insertion order. This is real OpenFront's own
  // resolution for a pocket ringed by a mix of more than one nation ("owns
  // the most of its border"); see enclosedRegion above for why a mixed wall
  // is now tallied instead of rejected outright.
  dominantWaller(wallCounts) {
    let best = -1, bestCount = -1;
    for (const [owner, count] of wallCounts) {
      if (count > bestCount || (count === bestCount && owner < best)) { best = owner; bestCount = count; }
    }
    return best;
  },

  // Every pocket of `targetId` that `byPlayerId`'s land touches the wall of,
  // not just the one under a cursor. A nuke leaves its blast as a scatter of
  // survivors among unclaimed irradiated ground, so resettling that ground
  // turns what is left of the defender there into dozens of one- and
  // two-tile pockets — annexing them one tap at a time was miserable, and
  // this is what lets a single tap take the lot.
  //
  // `requireDominant` (default false — an explicit tap or a bot's own
  // opportunistic annex, ai.js's annexIfEnclosed, always succeeds against
  // any pocket byPlayerId touches at all, mixed wall or not) switches to
  // real OpenFront's "attacks it hardest" resolution instead: only pockets
  // where byPlayerId is the single dominant wall contributor pass, which is
  // what the automatic sweep below needs so a pocket touched by several
  // different players resolves to exactly one winner rather than whoever's
  // scan happens to run first.
  //
  // Contact points are collected off our own border (borderTiles, kept live
  // by setOwner) rather than off the defender's tile set or our own full
  // territory, since a pocket is by definition something our land touches —
  // only a border tile can have a neighbour of a different owner — and the
  // shared seen/run map keeps the sweep linear in the defender's tiles no
  // matter how much of our border touches them. This runs from the hover
  // renderer on essentially every frame territory changes anywhere on the
  // map while the cursor rests on another nation, so scanning all of `me`'s
  // tiles instead of just its border was a per-frame hitch of its own for a
  // large empire. Uses nbuf so the abuf enclosedRegion walks on can't
  // clobber it mid-scan.
  //
  // Mainland vs cut-off piece (2026-09-21 fix). Real OpenFront holds the two
  // to different standards: a fragment falls to any wall, mixed or not, but a
  // nation's mainland (its largest connected piece) only falls when exactly
  // ONE other player walls it in — `surroundedBySamePlayer`. Without that, a
  // landlocked nation ringed by two or three neighbours was swallowed whole by
  // whichever touched it most, on the sweep and on a tap or bot alike, which
  // read as nations being annexed far too easily. The single-wall rule is
  // applied here rather than behind requireDominant so the hover cue, the
  // tap, the bots and the sweep all agree.
  enclosedPocketsOf(targetId, byPlayerId, requireDominant) {
    const me = this.players[byPlayerId];
    if (targetId < 0 || targetId === byPlayerId || !me) return [];
    const seen = new Map(), nb = this.nbuf, regions = [];
    let run = 0, biggest = -1;
    for (const i of me.borderTiles) {
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] !== targetId || seen.has(j)) continue;
        const found = this.enclosedRegion(j, seen, ++run);
        if (!found) continue;
        if (found.wallCounts.size > 1) {
          // Mixed wall: fine for a fragment, never for the mainland. Only pay
          // for the largest-piece scan once a pocket has actually passed.
          if (biggest < 0) biggest = this.largestLandPiece(targetId);
          if (found.tiles.length >= biggest) continue;
        }
        if (requireDominant && this.dominantWaller(found.wallCounts) !== byPlayerId) continue;
        regions.push(found.tiles);
      }
    }
    return regions;
  },

  // Size of the largest 4-connected piece of `playerId`'s land — its mainland.
  // Walks on abuf, which enclosedPocketsOf's own loop (nbuf) is not using.
  largestLandPiece(playerId) {
    const tiles = this.players[playerId].tiles;
    const seen = new Set(), nb = this.abuf;
    let best = 0;
    for (const start of tiles) {
      if (seen.has(start)) continue;
      seen.add(start);
      const stack = [start];
      let size = 0;
      while (stack.length) {
        const t = stack.pop();
        size++;
        const n = GameMap.neighbors(t, nb);
        for (let k = 0; k < n; k++) {
          const j = nb[k];
          if (GameMap.owner[j] === playerId && !seen.has(j)) { seen.add(j); stack.push(j); }
        }
      }
      if (size > best) best = size;
    }
    return best;
  },

  // Hands every one of those pockets over at once. All of them are found
  // before any of them changes hands, since annexRegion/setOwner rewrite the
  // very tile sets enclosedPocketsOf scans. Returns the tiles taken.
  annexEnclosedPockets(targetId, byPlayerId, requireDominant) {
    const regions = this.enclosedPocketsOf(targetId, byPlayerId, requireDominant);
    let taken = 0;
    for (const r of regions) { taken += r.length; this.annexRegion(r, byPlayerId); }
    return taken;
  },

  // Every ~20 ticks (real OpenFront's own PlayerExecution cadence at its 10
  // ticks/sec, see feedback-openfront-source-porting memory), sweep every
  // live player's border for enclosed enemy ground and take it automatically
  // — no tap required. The original port (2026-08-18) deliberately made this
  // click-only, reasoning the user had framed the feature as "click on them
  // once"; a later report made clear that read was wrong on two points: a
  // surrounded tribe/pocket should fall the instant the ring closes exactly
  // like real OpenFront, and the same is true of a chunk of a bigger nation
  // that an ongoing attack has just cut off from its own mainland — neither
  // should sit there waiting on a click. UI.onTap's own annexRegion intent is
  // left in place alongside this (an already-annexed pocket just finds
  // nothing left to take, harmlessly), since a tap still resolves faster than
  // waiting for the next sweep tick.
  //
  // Passes requireDominant=true to annexEnclosedPockets (see its own comment)
  // so a pocket ringed by a mix of players resolves to exactly one of them —
  // whoever owns the most of its wall — instead of every bordering player's
  // turn in this same loop independently trying (and, before that flag
  // existed, every one of them failing, since the old single-owner-wall test
  // rejected a mixed ring outright regardless of who was asking).
  //
  // Contacts are read the same way AI.borderTargets does (a single walk of
  // borderTiles, not the full tile set), just inlined here rather than
  // shared with ai.js, which this file must not depend on.
  ANNEX_SWEEP_TICKS: 20,
  checkAnnexations() {
    const nb = this.nbuf;
    for (const p of this.players) {
      if (!p.alive || p.tiles.size === 0) continue;
      const targets = new Set();
      for (const i of p.borderTiles) {
        const n = GameMap.neighbors(i, nb);
        for (let k = 0; k < n; k++) {
          const o = GameMap.owner[nb[k]];
          if (o < 0 || o === p.id || p.allies.has(o)) continue;
          targets.add(o);
        }
      }
      for (const targetId of targets) this.annexEnclosedPockets(targetId, p.id, true);
    }
  },

  // Instantly hands every tile of an enclosed region to byPlayerId — no
  // troops, no siege ticks, per OpenFront's annexation rule that a fully
  // surrounded territory falls for free the moment it's attacked. If this
  // was the loser's entire remaining territory, their treasury moves with
  // it too (same halved-for-human rule handleDeadDefender uses below), since
  // regular tile loss never transfers gold and a full wipe otherwise
  // silently drops it.
  //
  // A combat death catches itself next tick: maxTroops falls with every tile
  // lost, so by the time the last one goes troops are already near zero and
  // the p.troops < 20 sweep below finishes the job. Annexation skips combat
  // entirely, so that path never fires here — a 0-tile player's floor is
  // BASE_POP, not zero, so their troops would actually climb from wherever
  // annexation left them and they'd sit "alive" forever. Elimination is
  // finalized here instead of left to the sweep.
  annexRegion(tiles, byPlayerId) {
    if (tiles.length === 0) return;
    const loser = this.players[GameMap.owner[tiles[0]]];
    const wipesThem = loser.tiles.size === tiles.length;
    const spoils = wipesThem ? (loser.isHuman ? loser.gold / 2 : loser.gold) : 0;
    if (wipesThem) this.spoilsPopup(loser.tiles, spoils, byPlayerId);

    for (const t of tiles) this.setOwner(t, byPlayerId);

    if (wipesThem) {
      const winner = this.players[byPlayerId];
      // Same half-spoils rule as the conquest path above, and keyed the same
      // way — on the loser being human-controlled, never on it being the
      // viewing client, which a lockstep sim must not know about.
      winner.gold += spoils;
      loser.gold = 0;
      loser.troops = 0;
      loser.alive = false;
    }
  },

});
