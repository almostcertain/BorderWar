// js/game/scouts.js — Fog of war: the Scout (docs/fog-of-war.md).
// Extends the Game singleton declared in game/core.js.
//
// An unarmed ship that exists to uncover the map. It is bought like a Warship
// (the `build_unit` intent, launched from one of the buyer's Ports) and sent
// like one (`move_scout`), but where a Warship can only be ordered onto
// discovered water, a Scout can be sent anywhere, including straight into the
// black. It reveals VISION_SIGHT_SCOUT cells around itself as it sails, and
// lasts until an enemy Warship or a nuke sinks it.
//
// FOG OFF: no Scout can exist. buildScout refuses, Game.scouts stays empty,
// tick() never calls stepScouts, and nothing here draws from Game.rng in any
// match. All Scout state is the three top-level fields below, plus the search
// arena in game/seapath.js, which only a Scout's search ever allocates.
//
// AN ORDER NEVER SAYS NO BECAUSE OF TERRAIN. A refusal would tell the player
// whether a black tile is land or water. So neither buying nor redirecting a
// Scout looks at the map under the click at all: the order only records the
// tile, and stepScouts does the pathfinding afterwards, inside the tick, with
// the seaToward search (game/seapath.js) — the one that always has an answer.
// The Scout sails toward the tile and stops on the closest water it can
// reach: on the tile itself, off the coast if it turned out to be land, on
// the near shore if it is a lake the Scout cannot get into. The only refusals
// are ones that say nothing about fogged terrain — see resolveScoutLaunch.
//
// THE SEARCH IS SPREAD OVER TICKS. It explores at most SCOUT_PATH_NODES tiles
// a tick and never takes a tick over the sea budget, so a long route takes a
// few ticks to find (ten at the very worst, one second), during which the
// Scout waits where it is. One search is in flight at a time, for the whole
// match (Game.scoutSearch); other Scouts needing a route wait their turn.
//
// A search that ends without arriving — its guard ran out, or the tile is
// too far from the Scout's sea to have a known closest point — gives the best
// tile it found. The Scout sails there and searches again, and stops for good
// when a search arrives, runs out of sea, or finds nothing closer than where
// the Scout already is. Every leg ends strictly closer to the destination
// than it began, so that always terminates.
//
// What the UI may show: `destTile` is the tile the player clicked and is safe
// to draw. `path` is the real route, computed on the real map, and runs
// through water the owner has not discovered yet — draw the ship, never the
// route ahead of it.
Object.assign(Game, {
  // Two shells sink it whatever they roll (warshipShellDamage is 200-325).
  SCOUT_MAX_HEALTH: 400,
  // Tiles per second: the rate every other ship sails at (see BOAT_SPEED).
  SCOUT_SPEED: 10,
  MAX_SCOUTS_PER_PLAYER: 2,
  // Water tiles the route search may explore in one tick. Half the tick's sea
  // budget, so a searching Scout always leaves the other half for trade,
  // Warships and the bots (seaTowardRun only runs when the whole slice fits).
  SCOUT_PATH_NODES: 20000,

  // Scouts afloat: { id, owner, path, pos, destTile, routing, cell, health,
  // maxHealth }. `path`/`pos` are the shape boats and Warships share, so
  // Game.pathPos reads a Scout too; `path` is water tiles only. `destTile` is
  // the tile it was last sent to, exactly as clicked. `routing` is true while
  // it still owes a search toward destTile. `cell` is the vision cell it last
  // revealed from. Ids come from nextScoutId, the same scheme as
  // nextWarshipId.
  scouts: [],
  nextScoutId: 1,
  // The one route search in flight: a seaTowardStart state plus `scoutId`,
  // the Scout it is for. null when none is.
  scoutSearch: null,

  // Called from init(). Per-match reset; a fog-off match never adds to it.
  // Lets go of the search arena too, so a fog-off match after a fog one does
  // not keep it.
  initScouts() {
    this.scouts = [];
    this.nextScoutId = 1;
    this.scoutSearch = null;
    this._seaTowardArena = null;
  },

  scoutById(id) {
    for (const s of this.scouts) if (s.id === id) return s;
    return null;
  },

  // How many Scouts `playerId` has afloat.
  scoutCount(playerId) {
    let n = 0;
    for (const s of this.scouts) if (s.owner === playerId) n++;
    return n;
  },

  // The water tile a Scout is on.
  scoutTile(s) { return s.path[Math.min(s.path.length - 1, Math.floor(s.pos))]; },

  // What a Scout purchase resolves to: { ok:false, reason } or
  // { ok:true, port, start }, `start` being the water tile beside `port` the
  // Scout is put on. The reasons, in the order they are checked:
  //   'Nation defeated'
  //   'Scouts need fog of war'   the match has fog off
  //   'Off the map'              clickTile is not a tile
  //   'Build a Port first'       no built Port of the buyer's own
  //   'Scout limit reached'      MAX_SCOUTS_PER_PLAYER already afloat
  //   'Not enough gold'
  // None of them depends on what is at clickTile.
  //
  // The Port is the buyer's nearest to the click, in a straight line. One
  // refinement, which uses only what the buyer can already see: when the
  // click is on water the buyer has discovered, the nearest Port on that same
  // body of water is preferred, so a nation with a Port on a lake and another
  // on the ocean launches from the right one. A click into the black never
  // gets that treatment — which Port answers would say something about it.
  resolveScoutLaunch(playerId, clickTile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return { ok: false, reason: 'Nation defeated' };
    if (!this.fog) return { ok: false, reason: 'Scouts need fog of war' };
    if (!(clickTile >= 0 && clickTile < GameMap.owner.length)) return { ok: false, reason: 'Off the map' };

    const ports = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'port' && b.built && GameMap.owner[b.tile] === playerId) ports.push(b);
    }
    if (ports.length === 0) return { ok: false, reason: 'Build a Port first' };
    if (this.scoutCount(playerId) >= this.MAX_SCOUTS_PER_PLAYER) return { ok: false, reason: 'Scout limit reached' };
    if (p.gold < this.unitCost(p, 'scout')) return { ok: false, reason: 'Not enough gold' };

    // Nearest first; equal distances keep Game.buildings' own order.
    ports.sort((a, c) => this.tileDistSq(a.tile, clickTile) - this.tileDistSq(c.tile, clickTile));
    const wc = GameMap.waterComponentId, nb = new Int32Array(4);
    const want = GameMap.owner[clickTile] === WATER && this.isDiscovered(playerId, clickTile) ? wc[clickTile] : -1;
    let port = null, start = -1;
    for (const b of ports) {
      const n = GameMap.neighbors(b.tile, nb);
      for (let k = 0; k < n; k++) {
        const t = nb[k];
        if (GameMap.owner[t] !== WATER) continue;
        if (wc[t] === want) return { ok: true, port: b, start: t };
        if (start < 0) { port = b; start = t; }
      }
    }
    // A Port always touches water (buildBlockReason), so this is unreachable.
    if (start < 0) return { ok: false, reason: 'Build a Port first' };
    return { ok: true, port, start };
  },

  // Why a Scout cannot be bought, for the UI to say out loud: null or one of
  // resolveScoutLaunch's reasons.
  scoutBlockReason(playerId, clickTile) {
    return this.resolveScoutLaunch(playerId, clickTile).reason || null;
  },

  canBuildScout(playerId, clickTile) { return !this.scoutBlockReason(playerId, clickTile); },

  // Buys a Scout and sends it toward `clickTile`. It appears at once, beside
  // the Port resolveScoutLaunch picked, reveals the water around that Port,
  // and starts sailing on the next tick, when stepScouts finds its route.
  buildScout(playerId, clickTile) {
    const r = this.resolveScoutLaunch(playerId, clickTile);
    if (!r.ok) return false;
    const p = this.players[playerId];
    p.gold -= this.unitCost(p, 'scout');
    this.scouts.push({
      id: this.nextScoutId++,
      owner: playerId,
      path: [r.start], pos: 0,
      destTile: clickTile,
      routing: true,
      cell: this.visionCellOf(r.start),
      health: this.SCOUT_MAX_HEALTH, maxHealth: this.SCOUT_MAX_HEALTH
    });
    this.revealAround(playerId, r.start, this.VISION_SIGHT_SCOUT);
    return true;
  },

  // Redirects every Scout in `list` that belongs to `playerId` toward
  // `clickTile`, any tile on the map. Each one stops where it is and sets off
  // again on the next tick. Returns whether any Scout took the order; false
  // only for an off-map tile or a list with none of the player's live Scouts
  // in it, never because of what the tile is.
  moveScouts(list, clickTile, playerId) {
    if (!this.fog || !(clickTile >= 0 && clickTile < GameMap.owner.length)) return false;
    let moved = false;
    for (const s of list) {
      if (!this.scouts.includes(s) || s.owner !== playerId) continue;
      s.path = [this.scoutTile(s)];
      s.pos = 0;
      s.destTile = clickTile;
      s.routing = true;
      moved = true;
    }
    return moved;
  },

  // tick()'s hook, fog matches only, straight after stepWarships. Sinks what
  // has been shot to 0 hp (stepShells does the damage) and what has lost its
  // nation — the same two ways a Warship goes; like a Warship, a Scout does
  // not care whether its owner still has a Port. Then each Scout either sails
  // one step, revealing when that takes it into a new vision cell, or, at the
  // end of a leg with a search still owed, looks for the next one.
  stepScouts() {
    const scouts = this.scouts;
    for (let i = scouts.length - 1; i >= 0; i--) {
      const s = scouts[i];
      const owner = this.players[s.owner];
      if (s.health <= 0 || !owner || !owner.alive) {
        scouts.splice(i, 1);
        if (this.scoutSearch && this.scoutSearch.scoutId === s.id) this.scoutSearch = null;
        continue;
      }
      const end = s.path.length - 1;
      if (s.pos < end) {
        s.pos = Math.min(end, s.pos + this.SCOUT_SPEED * this.TICK_DT);
        const tile = this.scoutTile(s), cell = this.visionCellOf(tile);
        if (cell !== s.cell) {
          s.cell = cell;
          this.revealAround(s.owner, tile, this.VISION_SIGHT_SCOUT);
        }
      } else if (s.routing) {
        this.scoutRoute(s);
      }
    }
  },

  // One tick's worth of route search for a Scout standing at the end of its
  // path. It waits while another living Scout's search is in flight, starts
  // its own when the slot is free (or when the one it had was for an order it
  // no longer has), and takes the route once the search is over.
  scoutRoute(s) {
    const tile = this.scoutTile(s);
    let st = this.scoutSearch;
    if (st && st.scoutId !== s.id) {
      if (this.scoutById(st.scoutId)) return;
      st = null;   // its Scout is gone
    }
    if (st && (st.from !== tile || st.goal !== s.destTile)) st = null;
    if (!st) {
      st = this.scoutSearch = this.seaTowardStart(tile, s.destTile);
      st.scoutId = s.id;
    }
    // null: no room in this tick's sea budget. false: more to explore. Either
    // way, carry on next tick.
    if (!this.seaTowardRun(st, this.SCOUT_PATH_NODES)) return;
    this.scoutSearch = null;
    const path = this.seaTowardPath(st);
    const closer = path.length > 1;
    if (closer) { s.path = path; s.pos = 0; }
    if (st.arrived || st.exhausted || !closer) s.routing = false;
  },

  // warshipAcquireTarget's hook, fog matches only: the nearest unfriendly
  // Scout within range of Warship `w`, taken as its target. Returns whether
  // there was one. Ranked by the caller below an enemy Warship and above a
  // trade ship.
  scoutTargetFor(w, pos, rangeSq) {
    let best = null, bestDist = Infinity;
    for (const s of this.scouts) {
      if (s.owner === w.owner || s.health <= 0 || this.areAllied(w.owner, s.owner)) continue;
      const sp = this.pathPos(s);
      const d = (sp.x - pos.x) ** 2 + (sp.y - pos.y) ** 2;
      if (d <= rangeSq && d < bestDist) { best = s; bestDist = d; }
    }
    if (!best) return false;
    w.target = best; w.targetKind = 'scout';
    return true;
  }
});
