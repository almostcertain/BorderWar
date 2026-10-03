// js/game/drill.js — Battle Royale: The Drill and its closing circle.
// Extends the Game singleton declared in game/core.js. See
// docs/battle-royale.md for the design and the BR-* task list.
Object.assign(Game, {
  // --- The Drill -------------------------------------------------------------
  // One nation pays DRILL_COST to place The Drill on its own land. After a
  // DRILL_COUNTDOWN_S warning, a circle centred on it shrinks linearly from
  // r0 (just enough to cover the farthest land tile, so nothing dies on the
  // first frame) to zero over DRILL_SHRINK_S. One per match, for the whole
  // match: the first placement locks everyone else out. Unstoppable — the
  // record is never removed once placed, whatever happens to the tile under
  // it or to its owner.
  //
  // Radius is integer fixed-point (DRILL_FP units per tile) and computed
  // from the tick count, never accumulated, so every client holds the same
  // integer on the same turn. Inside/outside tests compare squared integer
  // distances (see drillInside); no floats ever reach sim state.

  // Flat, like Silo/AtomBomb — the UNITS 'drill' entry carries the same
  // number so unitCost's `flat` branch prices it without a special case.
  DRILL_COST: 20000000,
  DRILL_COUNTDOWN_S: 20,
  DRILL_SHRINK_S: 300,
  // Fixed-point scale for radii: 1 tile = DRILL_FP. With the largest map's
  // diagonal (~2236 tiles) r0*FP is ~2.3M, its square ~5.2e12 — every value
  // and product here stays an exact integer well below 2^53.
  DRILL_FP: 1024,

  // { ownerId, tile, cx, cy, placedTick, startTick, endTick, r0, r, rPrev }
  // or null. r0 is in whole tiles; r and rPrev are fixed-point (DRILL_FP).
  // r is the radius as of the current tick; rPrev the radius the tick
  // before, so stepDrill's sweep (BR-3) can process just the annulus
  // between them.
  drill: null,
  // Each player's land count (tiles.size) and troops as they stood just
  // before this tick's sweep, indexed by player id — an Int32Array and a
  // Float64Array of players.length. Written by stepDrill on every tick once a
  // Drill exists (sweep or not), read by the full-closure win rule (BR-4,
  // teams.js drillLandBefore/drillTroopsBefore). null until then.
  drillPrevLand: null,
  drillPrevTroops: null,
  // The dead zone (BR-3): 1 for every tile the circle has passed over, land
  // and water alike, 0 elsewhere. Permanent — unlike fallout, nothing ever
  // clears it, and a dead land tile is NEUTRAL forever (every path that could
  // claim a NEUTRAL tile checks it). Allocated per match in initDrill, all
  // zeros until the circle starts shrinking. Once it has, the set is exactly
  // the complement of the current circle, so `drillDead[t]` is the
  // "outside?" test for units and paths too.
  drillDead: null,
  // Dead land tiles, and dead tiles of any kind (water included).
  drillDeadLand: 0,
  drillDeadTiles: 0,
  // Scratch: land each player lost in the current sweep, by player id.
  _drillLost: null,
  // Per map row, the half-width of the circle's live span as of the last
  // sweep (live tiles are cx-half .. cx+half; -1 = the whole row is dead).
  // Derived from the record alone, like drillDead. Lets each sweep walk each
  // row's edge inward instead of solving it with a square root (BR-8: the
  // per-row isqrt was most of stepDrill's cost). null until the first sweep.
  _drillHalf: null,

  initDrill() {
    this.drill = null;
    this.drillPrevLand = null;
    this.drillPrevTroops = null;
    const n = GameMap.owner.length;
    if (this.drillDead && this.drillDead.length === n) this.drillDead.fill(0);
    else this.drillDead = new Uint8Array(n);
    this.drillDeadLand = 0;
    this.drillDeadTiles = 0;
    this._drillLost = null;
    this._drillHalf = null;
  },

  // True when any tile of `path` is in the dead zone. For cached routes
  // (trade.js portRoute) that were found before the circle passed over them.
  drillPathDead(path) {
    if (this.drillDeadTiles === 0) return false;
    const dead = this.drillDead;
    for (let i = 0; i < path.length; i++) if (dead[path[i]]) return true;
    return false;
  },

  // Why `playerId` can't place The Drill at `tile`, for the UI to say out
  // loud, or null — same shape as buildBlockReason. The one-per-match rule
  // lives here, not in Protocol: Protocol only checks shapes, and whether a
  // Drill exists is sim state.
  drillBlockReason(playerId, tile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    if (this.spawning || !this.running) return 'The match has not started';
    if (this.drill) return 'The Drill has already been built';
    if (!Number.isInteger(tile) || tile < 0 || tile >= GameMap.owner.length ||
        GameMap.owner[tile] !== playerId) return 'Your own land only';
    if (p.gold < this.unitCost(p, 'drill')) return 'Not enough gold';
    return null;
  },

  // Places The Drill: instant, no construction phase (the countdown is the
  // telegraph). Reached only through Executor's build_unit intent. Returns
  // false and changes nothing when drillBlockReason refuses.
  placeDrill(playerId, tile) {
    if (this.drillBlockReason(playerId, tile)) return false;
    const p = this.players[playerId];
    p.gold -= this.unitCost(p, 'drill');
    const w = GameMap.width;
    const cx = tile % w, cy = (tile - cx) / w;
    const r0 = this.drillStartRadius(cx, cy);
    // Intents apply before tick() increments `ticks`, so the first tick that
    // sees the Drill is placedTick + 1. The countdown runs whole ticks from
    // here; the shrink then takes exactly DRILL_SHRINK_S of ticks.
    const placedTick = this.ticks;
    const startTick = placedTick + this.DRILL_COUNTDOWN_S * this.TICKS_PER_SEC;
    const endTick = startTick + this.DRILL_SHRINK_S * this.TICKS_PER_SEC;
    this.drill = {
      ownerId: playerId, tile, cx, cy, placedTick, startTick, endTick, r0,
      r: r0 * this.DRILL_FP, rPrev: r0 * this.DRILL_FP
    };
    return true;
  },

  // Smallest whole-tile radius whose circle contains every land tile, owned
  // or not: ceil of the distance to the farthest one. One full-map pass, run
  // once per match at placement. Integer throughout; the sqrt only seeds the
  // guess and the two loops settle it exactly.
  drillStartRadius(cx, cy) {
    const owner = GameMap.owner, w = GameMap.width, n = owner.length;
    let maxD2 = 0;
    for (let i = 0, x = 0, y = 0; i < n; i++) {
      if (owner[i] !== WATER) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > maxD2) maxD2 = d2;
      }
      if (++x === w) { x = 0; y++; }
    }
    let r = Math.ceil(Math.sqrt(maxD2));
    while (r * r < maxD2) r++;
    while (r > 0 && (r - 1) * (r - 1) >= maxD2) r--;
    return r;
  },

  // Fixed-point radius (DRILL_FP units) at `tick`: r0 through the countdown,
  // then linear to 0 at endTick, 0 after. 0 when there is no Drill. Integer:
  // the floor of an exact quotient of integers below 2^53.
  drillRadius(tick) {
    const d = this.drill;
    if (!d) return 0;
    const full = d.r0 * this.DRILL_FP;
    if (tick <= d.startTick) return full;
    if (tick >= d.endTick) return 0;
    const span = d.endTick - d.startTick;
    return Math.floor(full * (d.endTick - tick) / span);
  },

  // Squared distance in whole tiles from the Drill to `tile`. Callers must
  // check Game.drill first.
  drillDist2(tile) {
    const w = GameMap.width;
    const x = tile % w, dx = x - this.drill.cx, dy = (tile - x) / w - this.drill.cy;
    return dx * dx + dy * dy;
  },

  // Whether `tile` is inside (or on) the circle of fixed-point radius rFp —
  // the current one, Game.drill.r, when omitted. True everywhere when there
  // is no Drill. A radius of 0 holds nothing, not even the centre tile: the
  // circle has fully closed.
  drillInside(tile, rFp) {
    if (!this.drill) return true;
    const r = rFp === undefined ? this.drill.r : rFp;
    return r > 0 && this.drillDist2(tile) * this.DRILL_FP * this.DRILL_FP <= r * r;
  },

  // Called once per tick from core.js's tick(), after nukes resolve and
  // before the elimination sweep and win check, so land lost to the circle
  // eliminates its nation and settles the winner on the same tick. A no-op
  // until a Drill exists.
  stepDrill() {
    const d = this.drill;
    if (!d) return;
    d.rPrev = d.r;
    d.r = this.drillRadius(this.ticks);

    // Pre-sweep snapshot for BR-4's full-closure rule, every tick.
    const players = this.players, np = players.length;
    if (!this.drillPrevLand || this.drillPrevLand.length !== np) {
      this.drillPrevLand = new Int32Array(np);
      this.drillPrevTroops = new Float64Array(np);
      this._drillLost = new Int32Array(np);
    }
    for (let i = 0; i < np; i++) {
      this.drillPrevLand[i] = players[i].tiles.size;
      this.drillPrevTroops[i] = players[i].troops;
    }

    // Nothing dies during the countdown.
    if (this.ticks <= d.startTick) return;

    // Sweep the ring of tiles that were inside last tick and are not now.
    // In whole tiles: kill dist2 in (inner2, outer2]. The first sweep's outer
    // bound is the whole map, which marks the water beyond r0 dead in one
    // go (r0 covers all land, so that pass is water only); from then on the
    // dead set is exactly the outside of the circle. A row-wise scan with
    // the two edges solved per row, so a tick costs its rows plus the tiles
    // it kills, never the whole map.
    const F2 = this.DRILL_FP * this.DRILL_FP;
    const w = GameMap.width, h = GameMap.height;
    const outer2 = this.drillDeadTiles === 0
      ? (w + h) * (w + h)
      : Math.floor(d.rPrev * d.rPrev / F2);
    const inner2 = d.r > 0 ? Math.floor(d.r * d.r / F2) : -1;
    if (inner2 < outer2) this.drillSweep(outer2, inner2);

    // Units outside the circle, every tick once it shrinks: a ship can sail
    // out into the dead zone between sweeps.
    if (this.drillDeadTiles > 0) this.drillKillUnits();
  },

  // Integer square root: the largest s with s*s <= n (n >= 0, below 2^52).
  drillIsqrt(n) {
    let s = Math.floor(Math.sqrt(n));
    while (s * s > n) s--;
    while ((s + 1) * (s + 1) <= n) s++;
    return s;
  },

  // Kills every tile whose squared distance from the Drill is in
  // (inner2, outer2] (whole tiles; inner2 -1 includes the centre). Rows top
  // to bottom, tiles left to right, so every client kills in the same order.
  drillSweep(outer2, inner2) {
    const d = this.drill, w = GameMap.width, h = GameMap.height;
    const cx = d.cx, cy = d.cy;
    const lost = this._drillLost;
    lost.fill(0);
    const before = this.drillDeadTiles;
    // Each row's live span as of the last sweep: half[y]. Before the first
    // sweep every row is live edge to edge (w covers it from any cx). The
    // new half-width is found by stepping the old one inward until it is
    // inside the new circle — the largest x with x*x + dy2 <= inner2, the
    // same integer drillIsqrt(inner2 - dy2) gives — so a tick costs a
    // compare per row plus one step per tile that dies.
    let half = this._drillHalf;
    if (!half || half.length !== h) { half = this._drillHalf = new Int32Array(h).fill(w); }
    const ry = this.drillIsqrt(outer2);
    const y0 = Math.max(0, cy - ry), y1 = Math.min(h - 1, cy + ry);
    for (let y = y0; y <= y1; y++) {
      const xo = half[y];
      if (xo < 0) continue;
      const dy2 = (y - cy) * (y - cy);
      let xi = xo;
      while (xi >= 0 && xi * xi + dy2 > inner2) xi--;
      if (xi === xo) continue;
      half[y] = xi;
      const row = y * w;
      if (xi >= 0) {
        this.drillKillRun(row, Math.max(0, cx - xo), Math.min(w - 1, cx - xi - 1), lost);
        this.drillKillRun(row, Math.max(0, cx + xi + 1), Math.min(w - 1, cx + xo), lost);
      } else {
        this.drillKillRun(row, Math.max(0, cx - xo), Math.min(w - 1, cx + xo), lost);
      }
    }
    if (this.drillDeadTiles === before) return;

    // Troops fall in proportion to land lost, home reserve and everything
    // in the field alike (the units nukes.js's detonateNuke also bleeds), so
    // a nation squeezed out entirely is left with none and core.js's
    // elimination sweep takes it this same tick. Player-id order.
    const players = this.players;
    for (let id = 0; id < players.length; id++) {
      const gone = lost[id];
      if (gone === 0) continue;
      const p = players[id];
      const left = p.tiles.size, had = left + gone;
      p.troops = p.troops * left / had;
      for (const a of this.attacks) if (a.attacker === id) a.troops = a.troops * left / had;
      for (const b of this.boats) if (b.attacker === id) b.troops = b.troops * left / had;
    }

    // Rails can't cross the dead zone: drop every rail with an end or bend
    // in it (both legs of an elbow are straight lines, and the circle is
    // convex, so ends and bend inside means the whole rail is), and every
    // train whose route touches one.
    const dead = this.drillDead;
    for (let i = this.railroads.length - 1; i >= 0; i--) {
      const rr = this.railroads[i];
      let cut = false;
      for (let k = 0; k < rr.waypoints.length; k++) if (dead[rr.waypoints[k]]) { cut = true; break; }
      if (!cut) continue;
      const a = this.buildings.get(rr.a), b = this.buildings.get(rr.b);
      if (a && a.rails) a.rails.delete(rr.b);
      if (b && b.rails) b.rails.delete(rr.a);
      this.railroads.splice(i, 1);
    }
    for (let i = this.trains.length - 1; i >= 0; i--) {
      if (this.drillPathDead(this.trains[i].waypoints)) this.trains.splice(i, 1);
    }
  },

  // Kills tiles row+x0 .. row+x1 (inclusive; nothing when x0 > x1): marks
  // them dead, destroys any structure there, and hands owned land back to
  // NEUTRAL, counting what each owner lost in `lost`.
  drillKillRun(row, x0, x1, lost) {
    const dead = this.drillDead, owner = GameMap.owner;
    for (let t = row + x0, end = row + x1; t <= end; t++) {
      if (dead[t]) continue;
      dead[t] = 1;
      this.drillDeadTiles++;
      const o = owner[t];
      // Dead water looks the same on the tile layer (render.js tints it with
      // the circle overlay instead), so it is never queued for a repaint:
      // the first sweep alone would otherwise queue ~1M water tiles on a
      // large map with the Drill near an edge.
      if (o === WATER) continue;
      this.dirtyTiles.add(t);
      this.drillDeadLand++;
      // Structures go first, the same bookkeeping detonateNuke does, so
      // setOwner below finds nothing to hand over.
      const b = this.buildings.get(t);
      if (b) {
        if (o >= 0) {
          const op = this.players[o];
          if (b.built) op.units[b.type] = Math.max(0, this.unitsOwned(op, b.type) - b.level);
          else op.unitsPending[b.type] = Math.max(0, this.unitsPending(op, b.type) - 1);
        }
        this.buildings.delete(t);
      }
      if (o >= 0) { lost[o]++; this.setOwner(t, NEUTRAL); }
      // Dead supersedes fallout: the tile is never capturable again.
      this.fallout.delete(t);
    }
  },

  // Boats, warships, trade ships and scouts whose current tile is dead sink;
  // trains on a route through the dead zone are scrapped. Nukes and MIRVs
  // already in flight carry on (detonateNuke ignores dead tiles).
  drillKillUnits() {
    const dead = this.drillDead;
    const at = e => e.path[Math.min(e.path.length - 1, Math.floor(e.pos))];
    for (let i = this.boats.length - 1; i >= 0; i--) if (dead[at(this.boats[i])]) this.boats.splice(i, 1);
    // Same bookkeeping as a warship sunk in stepWarships.
    for (let i = this.warships.length - 1; i >= 0; i--) {
      const ws = this.warships[i];
      if (!dead[at(ws)]) continue;
      this.warships.splice(i, 1);
      const owner = this.players[ws.owner];
      if (owner) owner.units.warship = Math.max(0, this.unitsOwned(owner, 'warship') - 1);
    }
    for (let i = this.tradeShips.length - 1; i >= 0; i--) if (dead[at(this.tradeShips[i])]) this.tradeShips.splice(i, 1);
    // Same as a Scout lost in stepScouts: its route search goes with it.
    for (let i = this.scouts.length - 1; i >= 0; i--) {
      const s = this.scouts[i];
      if (!dead[at(s)]) continue;
      this.scouts.splice(i, 1);
      if (this.scoutSearch && this.scoutSearch.scoutId === s.id) this.scoutSearch = null;
    }
    const w = GameMap.width;
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const p = this.trainTilePos(this.trains[i]);
      if (dead[Math.floor(p.y) * w + Math.floor(p.x)]) this.trains.splice(i, 1);
    }
  }
});
