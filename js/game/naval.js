// js/game/naval.js — Boats, coast lookup & naval invasions.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Naval invasions -------------------------------------------------------
  // A boat is a travel phase in front of the same conquest machinery land
  // attacks use: it crosses open water, takes the landing tile for free on
  // arrival, then opens a normal attack from there (see resolveLanding).

  // OpenFront moves a transport ship exactly 1 tile per tick (ticksPerMove=1
  // in TransportShipExecution), and their msPerTick is 100 — the same 10
  // ticks/sec this file already runs on (see TICKS_PER_SEC), so this is a
  // straight port, not a re-tuned dial: 10 tiles/sec.
  BOAT_SPEED: 10,

  // TransportShipExecution's malusForRetreat: landing back on your own land
  // (the target tile changed hands again while the boat was crossing) loses
  // 25% of the troops rather than refunding them in full.
  BOAT_RETREAT_MALUS: 0.25,

  // A sea route that never reaches its target should fail fast rather than
  // walk the whole ocean — caps how many water tiles a single search visits.
  SEA_PATH_GUARD: 200000,

  // A step-capped search (seaPath's maxSteps) also gets its node guard cut
  // to this many visits per allowed step. Successful AI routes explore few
  // nodes per step, while failing ones ran the whole 200k guard; this ends
  // those early. 8 keeps the same number of successful AI routes (4 loses
  // about 10%).
  SEA_PATH_NODES_PER_STEP: 8,

  // Caps how much full (post-fast-reject) seaPath work starts in a single
  // tick, in water tiles explored; reset in tick(). Port trade rolls, bots'
  // navalThink and warship repathing all call seaPath independently, and a
  // burst of long searches in one tick is a visible hitch on real-coastline
  // maps. Callers already treat a null path as 'try again later', so
  // deferring the overflow is safe.
  //
  // Counted in explored tiles, not searches. A search only STARTS while the
  // tick is under budget, then runs to its own guard (aborting midway would
  // waste the work and could starve long routes), so the worst case is the
  // budget plus one full search. Each search also pays SEA_PATH_SEARCH_COST
  // up front for its fixed setup. See docs/perf-frame-rate-profile.md.
  SEA_PATH_NODE_BUDGET_PER_TICK: 40000,
  SEA_PATH_SEARCH_COST: 500,

  // Config.boatMaxNumber().
  MAX_BOATS_PER_PLAYER: 3,

  // SpatialQuery.closestReachableShore's default maxDist: OpenFront doesn't
  // require the exact tapped tile to be a shore — it lands at the nearest
  // actual coastal tile of the same owner, so a click a little inland from
  // the coast still invades sensibly instead of failing.
  NEAREST_COAST_MAX_DIST: 50,

  // Terrain-agnostic BFS (Manhattan-ordered, ignores land/water) from
  // `tile` to the nearest tile that is coastal AND owned by whoever owns
  // `tile`: a geometric 'closest shore' search. Returns `tile` itself when
  // it is already coastal.
  //
  // Open water has no owner, so a water click resolves to the nearest
  // unclaimed shore near that point.
  nearestOwnedCoast(tile) {
    // isCoastal only means anything for land — a water tile bordering more
    // water would otherwise short-circuit here and "land" on itself.
    // Battle Royale's dead zone (game/drill.js) is never a landing site.
    const dead = this.drillDead;
    if (GameMap.isLand(tile) && GameMap.isCoastal(tile) && !dead[tile]) return tile;
    const rawOwner = GameMap.owner[tile];
    const owner = rawOwner === WATER ? NEUTRAL : rawOwner;
    const w = GameMap.width;
    const tx = tile % w, ty = (tile / w) | 0;
    const maxDist = this.NEAREST_COAST_MAX_DIST;
    const seen = new Set([tile]);
    const queue = [tile];
    const nb = new Int32Array(4);
    let head = 0, best = -1, bestDist = Infinity;
    while (head < queue.length) {
      const i = queue[head++];
      const ix = i % w, iy = (i / w) | 0;
      const dist = Math.abs(ix - tx) + Math.abs(iy - ty);
      if (dist < bestDist && GameMap.owner[i] === owner && !dead[i] && GameMap.isCoastal(i)) {
        best = i; bestDist = dist;
      }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // How close a Port placement click has to land to the player's own coast
  // to snap onto it (see nearestOwnedCoastNear) — deliberately much tighter
  // than NEAREST_COAST_MAX_DIST above (a boat target snapping across half
  // the map to the "nearest" shore still makes sense; a building silently
  // teleporting that far from where you tapped would not).
  PORT_SNAP_MAX_DIST: 6,

  // Like nearestOwnedCoast, but for placing a Port: searches out from
  // `fromTile` (any tile) for the nearest land tile that is coastal AND
  // owned by `playerId` specifically. Returns -1 if nothing qualifies
  // within maxDist, or if fromTile is off the map.
  nearestOwnedCoastNear(playerId, fromTile, maxDist) {
    if (fromTile < 0) return -1;
    if (GameMap.owner[fromTile] === playerId && GameMap.isLand(fromTile) && GameMap.isCoastal(fromTile)) {
      return fromTile;
    }
    const w = GameMap.width;
    const tx = fromTile % w, ty = (fromTile / w) | 0;
    const seen = new Set([fromTile]);
    const queue = [fromTile];
    const nb = new Int32Array(4);
    let head = 0, best = -1, bestDist = Infinity;
    while (head < queue.length) {
      const i = queue[head++];
      const ix = i % w, iy = (i / w) | 0;
      const dist = Math.abs(ix - tx) + Math.abs(iy - ty);
      if (dist < bestDist && GameMap.owner[i] === playerId && GameMap.isLand(i) && GameMap.isCoastal(i)) {
        best = i; bestDist = dist;
      }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // seaPath, seeded from the attacker's coastal tiles, found by scanning
  // attacker.borderTiles (coastal tiles are a subset of border tiles) so the
  // cost is perimeter-sized. The radial menu calls this through
  // navalInvasionBlockReason.
  //
  // Found routes are memoised for the rest of the tick (cleared by tick()
  // and by any setOwner), keyed by attacker and target: one boat launch asks
  // for the same route up to three times. Only successes are cached; a null
  // from a step-capped or over-budget search says nothing about an uncapped
  // one. `maxSteps` (optional): see seaPath.
  nearestCoastPath(attackerId, targetTile, maxSteps) {
    const key = attackerId * GameMap.owner.length + targetTile;
    if (this._inTick) {
      const cached = this._coastPathMemo.get(key);
      if (cached) return cached;
    }
    const attacker = this.players[attackerId];
    const coastal = [];
    for (const t of attacker.borderTiles) if (GameMap.isCoastal(t)) coastal.push(t);
    if (coastal.length === 0) return null;
    const path = this.seaPath(coastal, targetTile, maxSteps);
    if (path && this._inTick) this._coastPathMemo.set(key, path);
    return path;
  },

  // Why a boat cannot launch at `tile` right now, for the radial menu's Boat
  // slot to say out loud — same null-or-reason shape as buildBlockReason and
  // allianceBlockReason. `tile` doesn't need to be a shore itself; this
  // resolves it exactly the way launchNavalInvasion will (nearestOwnedCoast).
  navalInvasionBlockReason(attackerId, tile, troops) {
    const attacker = this.players[attackerId];
    if (!attacker || !attacker.alive) return 'Nation defeated';
    if (troops < 20 || attacker.troops < troops) return 'Not enough troops';
    // Counted, not collected — navalInvasionBlockReason is what the radial
    // menu asks to decide whether the Boat wedge is greyed out.
    let myBoats = 0;
    for (const b of this.boats) if (b.attacker === attackerId) myBoats++;
    if (myBoats >= this.MAX_BOATS_PER_PLAYER) {
      return 'Boat limit reached';
    }
    // Fog of war: the click is checked before anything terrain-dependent is
    // resolved from it, so a refusal never says what is under the fog.
    if (this.fog && !this.isDiscovered(attackerId, tile)) return 'Undiscovered';
    const landingTile = this.nearestOwnedCoast(tile);
    if (landingTile < 0) return 'No coast nearby';
    if (this.fog && !this.isDiscovered(attackerId, landingTile)) return 'Undiscovered';
    const targetOwner = GameMap.owner[landingTile];
    if (targetOwner === attackerId) return 'Already yours';
    if (this.areAllied(attackerId, targetOwner)) return 'Allied';
    if (!this.nearestCoastPath(attackerId, landingTile)) return 'No sea route';
    return null;
  },

  canLaunchNavalInvasion(attackerId, tile, troops) {
    return !this.navalInvasionBlockReason(attackerId, tile, troops);
  },

  // Sends a boat carrying `troops` from the attacker's nearest coast toward
  // the nearest coastal tile near `targetTile` (see nearestOwnedCoast).
  // Troops leave the home reserve immediately, like launchAttack, and count
  // against the pop cap via marchingTroops until the boat lands.
  launchNavalInvasion(attackerId, targetTile, troops) {
    if (this.navalInvasionBlockReason(attackerId, targetTile, troops)) return false;

    const landingTile = this.nearestOwnedCoast(targetTile);
    const targetOwner = GameMap.owner[landingTile];
    // navalInvasionBlockReason found this route, but
    // SEA_PATH_NODE_BUDGET_PER_TICK can still make it come back null here.
    // Bail out: every reader of Game.boats assumes path is an array.
    const path = this.nearestCoastPath(attackerId, landingTile);
    if (!path) return false;

    // Marching on someone answers their proposal, same as launchAttack.
    if (targetOwner >= 0) this.dropRequestsBetween(attackerId, targetOwner);

    const attacker = this.players[attackerId];
    attacker.troops -= troops;
    // `target` is fixed here and never re-read at arrival — OpenFront's own
    // TransportShipExecution stores the target once at launch too, so a boat
    // still attacks the nation it was sent against even if the landing tile
    // itself changes hands again before it arrives.
    this.boats.push({ id: this.nextBoatId++, attacker: attackerId, target: targetOwner, troops, path, pos: 0, landingTile });
    if (targetOwner >= 0) this.noteFreshFront(attacker, this.players[targetOwner]);
    return true;
  },

  // Advances every boat along its path; arrival is handled by resolveLanding.
  // A recalled boat runs this in reverse instead — sailing back down the same
  // route toward pos 0 — and hands the troops home once it gets there.
  stepBoats() {
    for (let i = this.boats.length - 1; i >= 0; i--) {
      const b = this.boats[i];
      if (b.retreating) {
        b.pos -= this.BOAT_SPEED * this.TICK_DT;
        if (b.pos > 0) continue;
        const attacker = this.players[b.attacker];
        const malus = b.target >= 0 ? this.ATTACK_RETREAT_MALUS : 0;
        attacker.troops += b.troops * (1 - malus);
        this.boats.splice(i, 1);
        continue;
      }
      b.pos += this.BOAT_SPEED * this.TICK_DT;
      if (b.pos < b.path.length - 1) continue;
      this.resolveLanding(b);
      this.boats.splice(i, 1);
    }
  },

  // Mirrors TransportShipExecution.tick's PathStatus.COMPLETE branch exactly.
  resolveLanding(boat) {
    const attacker = this.players[boat.attacker];
    const tile = boat.landingTile;

    // The landing tile is already ours again (recaptured some other way
    // while the boat was crossing) — OpenFront treats this as a retreat and
    // tolls it: 25% of the troops are lost, not refunded in full.
    if (GameMap.owner[tile] === boat.attacker) {
      attacker.troops += boat.troops * (1 - this.BOAT_RETREAT_MALUS);
      return;
    }
    // The circle (game/drill.js) passed over the landing tile while the boat
    // was crossing: nothing to land on, so it turns back with the same toll.
    if (this.drillDead[tile]) {
      attacker.troops += boat.troops * (1 - this.BOAT_RETREAT_MALUS);
      return;
    }

    // The landing tile itself is always taken for free — no fight, no troop
    // cost — exactly like OpenFront's unconditional conquer() on arrival.
    this.setOwner(tile, boat.attacker);

    // An alliance can form mid-crossing; OpenFront doesn't recall the boat
    // for it, it just changes what happens on arrival. The landing tile is
    // still taken either way (that conquer() above already ran) — only the
    // remaining troops differ: home in full rather than pressing an attack.
    if (this.areAllied(boat.attacker, boat.target)) {
      attacker.troops += boat.troops;
      return;
    }

    // OpenFront lands a boat by starting an AttackExecution, which brings its
    // temporary embargo with it — see embargoOnAttack.
    this.embargoOnAttack(boat.attacker, boat.target);
    // Fog of war: a landing is an attack, so the target has met the attacker.
    if (this.fog) this.markMet(boat.target, boat.attacker);

    // A normal attack, seeded from the landing tile's border (it is owned
    // territory now). It gets a fresh attack id (the boat's id dies with
    // the landing) and can be cancelled separately. landmassId is stamped
    // from the landing tile, so a later click on this island folds into
    // the beachhead instead of opening a parallel front.
    const a = { id: this.nextAttackId++, attacker: boat.attacker, target: boat.target, troops: boat.troops,
                heapTile: [], heapPrio: [], border: new Set(), landmassId: GameMap.landmassId[tile],
                frontSeed: ((this.rng() * 0x7fffffff) | 0) || 1 };
    const nb = this.nbuf;
    const n = GameMap.neighbors(tile, nb);
    for (let k = 0; k < n; k++) {
      const j = nb[k];
      if (GameMap.owner[j] === boat.target && !this.drillDead[j]) {
        a.border.add(j);
        this.heapPush(a, j, this.frontierPriority(j, a));
      }
    }
    // The target no longer holds anything touching the beachhead (lost it to
    // a third party while the boat was crossing) — the free tile is still
    // ours; the rest of the troops simply garrison it rather than vanish.
    if (a.heapTile.length > 0) this.attacks.push(a);
    else attacker.troops += boat.troops;
  },

});
