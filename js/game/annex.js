// js/game/annex.js — Enclosed regions & annexation.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.

// Scratch for the periodic sweep's shared walk cache (see AnnexSweep below).
// Kept out of Game so it is never part of the hashed sim state; the stamps
// are only ever compared, so their values never leak into results.
let annexStamp = null, annexRun = 0;
let pieceStamp = null, pieceRun = 0;   // largestLandPiece's visited marks
let openStamp = null, openRun = 0;     // openGroundSealed's visited marks

// One annexation sweep's memory of which enemy components have been
// walked. Whether a same-owner component is enclosed depends only on the
// ownership map, so while no tile changes hands every bordering player
// reuses the first walk's verdict (re-flooding big landlocked mainlands
// was a 200+ ms hitch per sweep). Any annexation resets it; a cached
// mainland size only goes stale for the two players involved.
function AnnexSweep() {
  if (!annexStamp || annexStamp.length !== GameMap.owner.length) {
    annexStamp = new Int32Array(GameMap.owner.length);
    annexRun = 0;
  }
  this.largest = new Map();      // targetId -> largestLandPiece
  this.reset();
}
AnnexSweep.prototype.reset = function (changedIds) {
  if (annexRun > 0x7ffffff0) { annexStamp.fill(0); annexRun = 0; }
  this.base = annexRun;          // stamps <= base are stale
  this.accepted = new Map();     // run -> { wallCounts, size, open } of an enclosed component
  if (changedIds) for (const id of changedIds) this.largest.delete(id);
};
// Verdict for the component containing `tile`: the run id it was stamped
// with, walking it first if nothing this sweep has reached it yet.
AnnexSweep.prototype.componentOf = function (tile) {
  const s = annexStamp[tile];
  if (s > this.base) return s;
  const run = ++annexRun;
  const found = Game.enclosedRegion(tile, null, run, annexStamp, this.base);
  if (found) this.accepted.set(run, { wallCounts: found.wallCounts, size: found.tiles.length, open: found.open });
  return run;
};

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
  // `tile`: the test for 'a land attack, not a naval one', whichever tile
  // was clicked. A per-tile touchesPlayer check is too strict: an attack
  // expands from wherever the attacker touches the target, and a small
  // nation is easy to miss by a tile.
  onSameLandmass(playerId, tile) {
    const p = this.players[playerId];
    if (!p) return false;
    const id = GameMap.landmassId[tile];
    for (const t of p.tiles) if (GameMap.landmassId[t] === id) return true;
    return false;
  },

  // Flood-fills the connected component of same-owner tiles containing
  // `startTile` and tests whether it is enclosed by OTHER players'
  // territory. Water or the map edge next to the piece is always a gap.
  // Unclaimed land is not: it is a hole (a nuke crater, say), so the piece
  // still counts as enclosed if that open ground is itself sealed in (see
  // openGroundSealed). Returns {tiles, wallCounts, open} or null (not
  // enclosed); `open` says the piece touches unclaimed land, which the
  // mainland rule (mainlandHolds) cares about.
  //
  // The wall may be a mix of owners: contact tiles are tallied per
  // bordering owner in `wallCounts`, and the caller picks a winner.
  //
  // `seen`/`run` let enclosedPocketsOf walk many pockets in one sweep
  // without paying for the same ground twice: `seen` maps a tile to the id
  // of the walk that reached it. Meeting a tile stamped by an *earlier* walk
  // means this pocket was already walked from another contact point and
  // rejected, so this walk fails with it.
  //
  // `stamp`/`base` (sweep use only) swap `seen` for a typed array of run
  // ids, where anything <= base counts as unvisited.
  enclosedRegion(startTile, seen, run, stamp, base) {
    const target = GameMap.owner[startTile];
    if (target < 0) return null;

    if (stamp) stamp[startTile] = run; else seen.set(startTile, run);
    const region = [startTile];
    const stack = [startTile];
    const wallCounts = new Map();
    const nb = this.abuf;
    const total = this.players[target].tiles.size;
    let open = null;   // unclaimed tiles the piece touches

    while (stack.length) {
      // More than half the nation is its mainland, and a mainland touching
      // unclaimed land never falls (mainlandHolds), so stop walking it.
      if (open && region.length * 2 > total) return null;
      const tile = stack.pop();
      const n = GameMap.neighbors(tile, nb);
      if (n < 4) return null; // touches the map edge
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        const o = GameMap.owner[j];
        if (o === target) {
          if (stamp) {
            const walk = stamp[j];
            if (walk === run) continue;
            if (walk > base) return null; // already walked, already rejected
            stamp[j] = run;
          } else {
            const walk = seen.get(j);
            if (walk === run) continue;
            if (walk !== undefined) return null; // already walked, already rejected
            seen.set(j, run);
          }
          region.push(j);
          stack.push(j);
          continue;
        }
        if (o === WATER) return null; // a gap
        if (o === NEUTRAL) { if (open) open.push(j); else open = [j]; continue; }
        wallCounts.set(o, (wallCounts.get(o) || 0) + 1);
      }
    }
    if (open && !this.openGroundSealed(region, open, target)) return null;
    return { tiles: region, wallCounts, open: open !== null };
  },

  // enclosedRegion's second stage, for a piece that touches unclaimed land.
  // Two tests: the other players' tiles around the piece must reach at
  // least as far as it does in all four directions (so a tip poking into
  // open ground does not fall), and walking on from the unclaimed land,
  // through more of it and more of the same nation's land, must never reach
  // water or the map edge.
  openGroundSealed(region, open, target) {
    const size = GameMap.owner.length, w = GameMap.width, owner = GameMap.owner, nb = this.abuf;
    if (!openStamp || openStamp.length !== size) { openStamp = new Int32Array(size); openRun = 0; }
    if (openRun > 0x7ffffff0) { openStamp.fill(0); openRun = 0; }
    const run = ++openRun, seen = openStamp;

    let minX = w, minY = size, maxX = -1, maxY = -1;       // the piece
    let wMinX = w, wMinY = size, wMaxX = -1, wMaxY = -1;   // its wall
    for (const t of region) {
      seen[t] = run;   // already known clear of water and the edge
      const x = t % w, y = (t - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const n = GameMap.neighbors(t, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k], o = owner[j];
        if (o < 0 || o === target) continue;
        const jx = j % w, jy = (j - jx) / w;
        if (jx < wMinX) wMinX = jx;
        if (jx > wMaxX) wMaxX = jx;
        if (jy < wMinY) wMinY = jy;
        if (jy > wMaxY) wMaxY = jy;
      }
    }
    if (wMinX > minX || wMinY > minY || wMaxX < maxX || wMaxY < maxY) return false;

    const stack = [];
    for (const t of open) if (seen[t] !== run) { seen[t] = run; stack.push(t); }
    while (stack.length) {
      const t = stack.pop();
      const n = GameMap.neighbors(t, nb);
      if (n < 4) return false;
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (seen[j] === run) continue;
        const o = owner[j];
        if (o === WATER) return false;
        if (o !== NEUTRAL && o !== target) continue;   // someone else's land: wall
        seen[j] = run;
        stack.push(j);
      }
    }
    return true;
  },

  // Which bordering nation an enclosed pocket of `targetId` falls to when
  // nobody tapped it. Only nations not friendly to the owner can take it.
  // Among those: whoever has the largest attack running against the owner;
  // with no attack, whoever has the most wall-tile contact, tie-broken by
  // lowest player id so every client agrees. Returns -1 when every nation
  // on the wall is the owner's friend.
  capturingPlayer(wallCounts, targetId) {
    const friends = this.players[targetId].allies;
    let best = -1, bestTroops = 0;
    for (const at of this.attacks) {
      if (at.target !== targetId || at.retreating || at.troops <= bestTroops) continue;
      if (!wallCounts.has(at.attacker) || friends.has(at.attacker)) continue;
      best = at.attacker;
      bestTroops = at.troops;
    }
    if (best >= 0) return best;
    let bestCount = -1;
    for (const [owner, count] of wallCounts) {
      if (friends.has(owner)) continue;
      if (count > bestCount || (count === bestCount && owner < best)) { best = owner; bestCount = count; }
    }
    return best;
  },

  // True when an enclosed piece is its nation's mainland (its largest
  // piece) and may not be annexed. A cut-off fragment falls to any wall,
  // but the mainland falls only when ringed by exactly one other nation
  // with no unclaimed land along its border. So one nation that fully
  // engulfs another takes it whole, and a nation hemmed in by several
  // neighbours is left to be fought. `pocket` is anything carrying
  // enclosedRegion's wallCounts and open.
  mainlandHolds(pocket, size, biggest) {
    return size >= biggest && (pocket.open || pocket.wallCounts.size !== 1);
  },

  // Every pocket of `targetId` that `byPlayerId`'s land touches the wall
  // of, not just the one under a cursor, so a single tap clears the scatter
  // of survivors a nuke leaves.
  //
  // `requireDominant` (default false: a tap or a bot's annexIfEnclosed
  // succeeds against any pocket byPlayerId touches) keeps only pockets where
  // byPlayerId is the capturing player. The automatic sweep needs that so a
  // pocket touched by several players resolves to exactly one winner.
  //
  // Contact points are collected off our own border (borderTiles), and the
  // shared seen/run map keeps the sweep linear in the defender's tiles. The
  // hover renderer calls this often, so it must stay border-sized. Uses nbuf
  // so enclosedRegion's abuf can't clobber it mid-scan.
  //
  // Mainland vs cut-off piece: see mainlandHolds.
  //
  // Friends never annex each other, whichever caller asks: an alliance (or
  // a shared team) is checked here, not left to the callers.
  //
  // `sweep` (checkAnnexations only) is an AnnexSweep shared across every
  // player's scan in one sweep: components are judged from its cache, and
  // only a pocket that passes is re-walked from this player's own contact
  // tile, so the tiles come back in exactly the order the uncached walk
  // would produce.
  enclosedPocketsOf(targetId, byPlayerId, requireDominant, sweep) {
    const me = this.players[byPlayerId];
    if (targetId < 0 || targetId === byPlayerId || !me) return [];
    if (this.areAllied(targetId, byPlayerId)) return [];
    if (sweep) return this.sweepPocketsOf(targetId, me, requireDominant, sweep);
    const seen = new Map(), nb = this.nbuf, regions = [];
    let run = 0, biggest = -1;
    for (const i of me.borderTiles) {
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] !== targetId || seen.has(j)) continue;
        const found = this.enclosedRegion(j, seen, ++run);
        if (!found) continue;
        if (requireDominant && this.capturingPlayer(found.wallCounts, targetId) !== byPlayerId) continue;
        // Only pay for the largest-piece scan once a pocket has actually passed.
        if (biggest < 0) biggest = this.largestLandPiece(targetId);
        if (this.mainlandHolds(found, found.tiles.length, biggest)) continue;
        regions.push(found.tiles);
      }
    }
    return regions;
  },

  // enclosedPocketsOf's cached path; same decisions, same result order.
  sweepPocketsOf(targetId, me, requireDominant, sweep) {
    const nb = this.nbuf, regions = [], judged = new Set();
    for (const i of me.borderTiles) {
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] !== targetId) continue;
        const comp = sweep.componentOf(j);
        if (judged.has(comp)) continue;
        judged.add(comp);
        const verdict = sweep.accepted.get(comp);
        if (!verdict) continue;
        if (requireDominant && this.capturingPlayer(verdict.wallCounts, targetId) !== me.id) continue;
        let biggest = sweep.largest.get(targetId);
        if (biggest === undefined) { biggest = this.largestLandPiece(targetId); sweep.largest.set(targetId, biggest); }
        if (this.mainlandHolds(verdict, verdict.size, biggest)) continue;
        regions.push(this.enclosedRegion(j, new Map(), 1).tiles);
      }
    }
    return regions;
  },

  // Size of the largest 4-connected piece of `playerId`'s land — its mainland.
  // Walks on abuf, which enclosedPocketsOf's own loop (nbuf) is not using.
  // Visited marks are a reused typed array rather than a Set — this runs on
  // whole mainlands, and a Set of 100k+ tiles was most of its cost.
  largestLandPiece(playerId) {
    const tiles = this.players[playerId].tiles;
    if (!pieceStamp || pieceStamp.length !== GameMap.owner.length) { pieceStamp = new Int32Array(GameMap.owner.length); pieceRun = 0; }
    if (pieceRun > 0x7ffffff0) { pieceStamp.fill(0); pieceRun = 0; }
    const run = ++pieceRun, seen = pieceStamp, nb = this.abuf;
    let best = 0;
    for (const start of tiles) {
      if (seen[start] === run) continue;
      seen[start] = run;
      const stack = [start];
      let size = 0;
      while (stack.length) {
        const t = stack.pop();
        size++;
        const n = GameMap.neighbors(t, nb);
        for (let k = 0; k < n; k++) {
          const j = nb[k];
          if (GameMap.owner[j] === playerId && seen[j] !== run) { seen[j] = run; stack.push(j); }
        }
      }
      if (size > best) best = size;
    }
    return best;
  },

  // Hands every one of those pockets over at once. All of them are found
  // before any of them changes hands, since annexRegion/setOwner rewrite the
  // very tile sets enclosedPocketsOf scans. Returns the tiles taken.
  annexEnclosedPockets(targetId, byPlayerId, requireDominant, sweep) {
    const regions = this.enclosedPocketsOf(targetId, byPlayerId, requireDominant, sweep);
    let taken = 0;
    for (const r of regions) { taken += r.length; this.annexRegion(r, byPlayerId); }
    return taken;
  },

  // Every ANNEX_SWEEP_TICKS ticks, sweep every live player's border for
  // enclosed enemy ground and take it automatically: a surrounded pocket,
  // or a chunk an attack has cut off from its mainland, falls when the ring
  // closes. UI.onTap's annexRegion intent stays alongside, since a tap
  // resolves faster than the next sweep.
  //
  // Passes requireDominant=true so a pocket ringed by a mix of players
  // resolves to exactly one of them.
  //
  // Contacts are read as AI.borderTargets does (one walk of borderTiles),
  // inlined because this file must not depend on ai.js.
  ANNEX_SWEEP_TICKS: 20,
  checkAnnexations() {
    const nb = this.nbuf, sweep = new AnnexSweep();
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
      for (const targetId of targets) {
        if (this.annexEnclosedPockets(targetId, p.id, true, sweep) > 0) sweep.reset([targetId, p.id]);
      }
    }
  },

  // Instantly hands every tile of an enclosed region to byPlayerId: no
  // troops, no siege ticks. If this was the loser's entire territory, their
  // treasury moves too (halved for a human, as in handleDeadDefender).
  //
  // Annexation skips combat, so the loser's troops are never spent down and
  // the tick() sweep (troops < 20) would never catch them: a 0-tile player
  // would regrow toward BASE_POP and sit 'alive' forever. Elimination is
  // finalized here instead.
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
      this.eliminatePlayer(loser);
    }
  },

});
