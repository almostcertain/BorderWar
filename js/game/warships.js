// js/game/warships.js — Warships & shells.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Warships ----------------------------------------------------------
  // A Warship spawns at full health, fights until it sinks, and is gone: no
  // docking, repair, healing or veterancy. It steals unfriendly trade ships,
  // shoots down invasion boats, fights other warships and patrols an
  // assigned area. It is bought from a Port (see resolveWarshipLaunch).
  //
  // Movement reuses seaPath. A warship is stored as {path, pos}, the shape a
  // boat or trade ship has, so Game.pathPos reads all three.
  WARSHIP_MAX_HEALTH: 1000,               // Config.ts UnitType.Warship.maxHealth
  WARSHIP_TARGET_RANGE: 65,               // half of warshipTargettingRange() — engagement/detection radius
  WARSHIP_PATROL_RANGE: 50,               // half of warshipPatrolRange() — wander radius around patrolTile
  WARSHIP_SHELL_COOLDOWN: 2,              // warshipShellAttackRate()=20 ticks @ 10 ticks/sec
  // Tiles/sec a shell closes on its target's LIVE position each tick (see
  // stepShells), so a moving target can't dodge. Slow enough that a shell
  // reads as a projectile; several can be in flight at one target.
  WARSHIP_SHELL_SPEED: 25,
  WARSHIP_CAPTURE_DIST: 5,                // huntDownTradeShip's manhattan capture distance
  // BOAT_SPEED's own comment: 10 ticks/sec, 1 tile/tick is the ported rate
  // for every ship type in this file, warships included — OpenFront has no
  // separate, slower warshipSpeed of its own.
  WARSHIP_SPEED: 10,
  // A trade ship moves at BOAT_SPEED, so a warship at plain WARSHIP_SPEED
  // could never close the gap on any indirect route. Applied only in
  // warshipChaseTradeShip, not patrol.
  WARSHIP_CHASE_SPEED_MULT: 1.5,
  WARSHIP_REPATH_INTERVAL: 5,             // seconds between patrol-wander waypoint picks
  WARSHIP_CHASE_REPATH: 1.5,              // seconds between trade-ship-chase path refreshes
  WARSHIP_SNAP_MAX_DIST: 8,               // AI.warshipSite's own coast-to-water snap distance
  // Repair and retreat — Config.ts warshipRetreatHealthPercent / DockingRange /
  // PassiveHealing(+Range) / PortHealingBonusPerLevel, in this game's tiles
  // and 10 ticks/sec (OpenFront's ticks are the same 10/sec).
  WARSHIP_RETREAT_HEALTH_PCT: 75,         // below this % of max health a patrolling warship heads for a Port
  WARSHIP_DOCK_RANGE: 5,                  // within this of the Port it docks
  WARSHIP_PASSIVE_HEAL: 1,                // hp/tick while within PASSIVE_HEAL_RANGE of any own Port
  WARSHIP_PASSIVE_HEAL_RANGE: 150,
  WARSHIP_DOCK_HEAL_PER_LEVEL: 5,         // hp/tick pool per Port level, split among the ships docked there
  WARSHIP_RETREAT_BLOCK: 5,               // seconds after a manual order during which it won't retreat (50 ticks)

  // Float tile-space position of anything shaped like a boat/trade ship/
  // warship — {path: [tile,...], pos: float index along it} — interpolating
  // between the two path tiles straddling `pos`. Same technique render.js's
  // drawBoats/drawTradeShips already use inline for their pixel position;
  // this is the game-logic (range-check) equivalent, shared by all three.
  pathPos(entity) {
    const path = entity.path, w = GameMap.width;
    const idx = Math.min(path.length - 1, Math.floor(entity.pos));
    const frac = Math.min(1, entity.pos - idx);
    const a = path[idx], c = path[Math.min(idx + 1, path.length - 1)];
    const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
    return { x: ax + (cx - ax) * frac, y: ay + (cy - ay) * frac };
  },

  // Terrain-agnostic BFS from `fromTile` to the nearest WATER tile, with no
  // ownership requirement: a warship's destination can be anywhere at sea.
  // A click already on water returns unchanged. Capped at
  // NEAREST_COAST_MAX_DIST.
  nearestWaterNear(fromTile, maxDist) {
    if (fromTile < 0) return -1;
    if (GameMap.owner[fromTile] === WATER) return fromTile;
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
      if (dist < bestDist && GameMap.owner[i] === WATER) { best = i; bestDist = dist; }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // Same terrain-agnostic BFS shape as nearestWaterNear, but hunting for a
  // WATER tile that touches the player's own coastline specifically — used
  // only by AI.warshipSite to pick a sensible coastal patrol destination for
  // a bot, not by the player-facing purchase flow any more (see
  // resolveWarshipLaunch below: a player click can land anywhere).
  nearestOwnedWaterNear(playerId, fromTile, maxDist) {
    if (fromTile < 0) return -1;
    const w = GameMap.width;
    const nb = new Int32Array(4);
    const touchesOwnCoast = (i) => {
      if (GameMap.owner[i] !== WATER) return false;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] === playerId && GameMap.isLand(nb[k])) return true;
      return false;
    };
    if (touchesOwnCoast(fromTile)) return fromTile;
    const tx = fromTile % w, ty = (fromTile / w) | 0;
    const seen = new Set([fromTile]);
    const queue = [fromTile];
    let head = 0, best = -1, bestDist = Infinity;
    while (head < queue.length) {
      const i = queue[head++];
      const ix = i % w, iy = (i / w) | 0;
      const dist = Math.abs(ix - tx) + Math.abs(iy - ty);
      if (dist < bestDist && touchesOwnCoast(i)) { best = i; bestDist = dist; }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // How many of a player's own Ports (nearest first, by straight-line
  // distance to the destination) to try a real seaPath from before giving
  // up. More than one, because the nearest Port can sit on a different,
  // landlocked body of water.
  WARSHIP_LAUNCH_PORT_ATTEMPTS: 4,

  // Resolves a Warship purchase click: which of the player's Ports it
  // launches from and the route to wherever was clicked. Design rules: no
  // need to click on the coast, a Port is required, it spawns from the
  // nearest available owned Port and pathfinds to the click.
  //
  // Returns { ok:false, reason } or { ok:true, port, dest, path }. Shared by
  // warshipBlockReason (a dry run for the UI) and buildWarship, which
  // re-runs it.
  resolveWarshipLaunch(playerId, clickTile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return { ok: false, reason: 'Nation defeated' };

    const ports = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'port' && b.built && GameMap.owner[b.tile] === playerId) ports.push(b);
    }
    if (ports.length === 0) return { ok: false, reason: 'Build a Port first' };

    if (p.gold < this.unitCost(p, 'warship')) return { ok: false, reason: 'Not enough gold' };

    // Fog of war: a warship can only be ordered to discovered water. The click
    // is checked before the water search so a refusal never says what is under
    // the fog; the snapped destination is checked too, since it can lie in a
    // different cell from the click.
    if (this.fog && !this.isDiscovered(playerId, clickTile)) return { ok: false, reason: 'Undiscovered' };
    const dest = this.nearestWaterNear(clickTile, this.NEAREST_COAST_MAX_DIST);
    if (dest < 0) return { ok: false, reason: 'No open water there' };
    if (this.fog && !this.isDiscovered(playerId, dest)) return { ok: false, reason: 'Undiscovered' };

    ports.sort((a, c) => this.tileDistSq(a.tile, dest) - this.tileDistSq(c.tile, dest));
    for (let i = 0; i < Math.min(ports.length, this.WARSHIP_LAUNCH_PORT_ATTEMPTS); i++) {
      const path = this.seaPath([ports[i].tile], dest);
      if (path) return { ok: true, port: ports[i], dest, path };
    }
    return { ok: false, reason: 'No sea route there' };
  },

  // `playerId`'s nearest built Port reachable by sea from `fromTile`
  // (nearest first, verified with seaPath). Used to reroute a captured
  // trade ship (see warshipChaseTradeShip). Null if that player owns no
  // Port, or none of the nearest few connect by sea.
  nearestOwnedPortRoute(playerId, fromTile) {
    const ports = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'port' && b.built && GameMap.owner[b.tile] === playerId) ports.push(b);
    }
    if (ports.length === 0) return null;
    ports.sort((a, c) => this.tileDistSq(a.tile, fromTile) - this.tileDistSq(c.tile, fromTile));
    for (let i = 0; i < Math.min(ports.length, this.WARSHIP_LAUNCH_PORT_ATTEMPTS); i++) {
      const path = this.seaPath([fromTile], ports[i].tile);
      if (path) return { port: ports[i], path };
    }
    return null;
  },

  // Why a Warship purchase click can't be carried out, for the UI to say out
  // loud — same null-or-reason shape as buildBlockReason.
  warshipBlockReason(playerId, clickTile) {
    return this.resolveWarshipLaunch(playerId, clickTile).reason || null;
  },

  canBuildWarship(playerId, clickTile) { return !this.warshipBlockReason(playerId, clickTile); },

  // Spawns instantly (see the UNITS comment on why buildTime isn't read
  // here) at full health, right at whichever owned Port resolveWarshipLaunch
  // picked, immediately sailing the resolved route out to the clicked
  // destination — which becomes its patrol center the moment it arrives,
  // exactly like a player-issued moveWarships relocation (see warshipPatrol).
  buildWarship(playerId, clickTile) {
    const r = this.resolveWarshipLaunch(playerId, clickTile);
    if (!r.ok) return false;
    const p = this.players[playerId];
    p.gold -= this.unitCost(p, 'warship');
    p.unitsBuilt.warship = this.unitsBuilt(p, 'warship') + 1;
    p.units.warship = this.unitsOwned(p, 'warship') + 1;
    this.warships.push({
      id: this.nextWarshipId++,
      owner: playerId,
      path: r.path, pos: 0,
      patrolTile: r.dest,
      ordered: true,
      health: this.WARSHIP_MAX_HEALTH, maxHealth: this.WARSHIP_MAX_HEALTH,
      target: null, targetKind: null,
      state: 'patrolling', retreatPort: -1, retreatBlockUntil: 0, healRemainder: 0,
      lastShellAt: -Infinity, lastPathAt: this.elapsed
    });
    if (this.fog) this.warshipReveal(this.warships[this.warships.length - 1]);
    return true;
  },

  // Player-issued relocation. A click that isn't water snaps to the nearest
  // water, as a purchase click does; an unreachable body of water shows up
  // as a failed seaPath. The destination becomes the new patrol centre (see
  // warshipPatrol).
  // `playerId` defaults to this.me only for local callers; the Executor
  // passes the actor resolved from the intent's stamped clientID, since the
  // ownership check is a sim rule.
  moveWarships(list, clickTile, playerId) {
    const owner = playerId === undefined ? this.me : playerId;
    // Fog of war: same rule as resolveWarshipLaunch — discovered water only.
    if (this.fog && !this.isDiscovered(owner, clickTile)) return false;
    const tile = this.nearestWaterNear(clickTile, this.NEAREST_COAST_MAX_DIST);
    if (tile < 0) return false;
    if (this.fog && !this.isDiscovered(owner, tile)) return false;
    let moved = false;
    for (const w of list) {
      if (!this.warships.includes(w) || w.owner !== owner) continue;
      const idx = Math.min(w.path.length - 1, Math.floor(w.pos));
      const curTile = w.path[idx];
      const path = this.seaPath([curTile], tile);
      if (!path) continue;
      w.path = path;
      w.pos = 0;
      w.patrolTile = tile;
      w.ordered = true;
      w.target = null; w.targetKind = null;
      w.state = 'patrolling'; w.retreatPort = -1; w.healRemainder = 0;
      w.retreatBlockUntil = this.elapsed + this.WARSHIP_RETREAT_BLOCK;
      w.lastPathAt = this.elapsed;
      moved = true;
    }
    return moved;
  },

  // Config.ts's ShellExecution.effectOnTarget with baseDamage=250 (so the
  // (roll-1)*25+200 multiplier IS the damage) and the veterancy bonus term
  // dropped — this game has no veterancy system. A 1-6 roll, 200-325 damage.
  warshipShellDamage() {
    const roll = 1 + Math.floor(this.rng() * 6);
    return (roll - 1) * 25 + 200;
  },

  // WarshipExecution.findBestTarget: transport ship (boat) beats warship
  // beats trade ship, nearest of whichever tier wins, "unfriendly" meaning
  // not this warship's own owner and not allied to them (this game has no
  // canAttackPlayer beyond that). Only called when `w` has no target already.
  warshipAcquireTarget(w, pos, rangeSq) {
    let best = null, bestDist = Infinity;
    for (const b of this.boats) {
      if (b.attacker === w.owner || this.areAllied(w.owner, b.attacker)) continue;
      const bp = this.pathPos(b);
      const d = (bp.x - pos.x) ** 2 + (bp.y - pos.y) ** 2;
      if (d <= rangeSq && d < bestDist) { best = b; bestDist = d; }
    }
    if (best) { w.target = best; w.targetKind = 'boat'; return; }

    best = null; bestDist = Infinity;
    for (const ow of this.warships) {
      if (ow === w || ow.owner === w.owner || ow.state === 'docked' || this.areAllied(w.owner, ow.owner)) continue;
      const op = this.pathPos(ow);
      const d = (op.x - pos.x) ** 2 + (op.y - pos.y) ** 2;
      if (d <= rangeSq && d < bestDist) { best = ow; bestDist = d; }
    }
    if (best) { w.target = best; w.targetKind = 'warship'; return; }

    // Fog of war: an unfriendly Scout (game/scouts.js) comes next. It is shot
    // from where the warship stands, like a boat or a warship, never chased.
    if (this.fog && this.scoutTargetFor(w, pos, rangeSq)) return;

    best = null; bestDist = Infinity;
    for (const s of this.tradeShips) {
      if (s.owner === w.owner || this.areAllied(w.owner, s.owner)) continue;
      const sp = this.pathPos(s);
      const d = (sp.x - pos.x) ** 2 + (sp.y - pos.y) ** 2;
      if (d <= rangeSq && d < bestDist) { best = s; bestDist = d; }
    }
    if (best) { w.target = best; w.targetKind = 'tradeship'; }
  },

  // Priority 1/2 targets (boat, warship): the warship holds its ground and
  // fires on cooldown; it only ever moves toward a trade ship. A shot spawns
  // a travelling shell and the effect lands on impact. A boat has no health,
  // so a shell sinks it outright; a warship takes damage until it sinks
  // (stepWarships removes it at 0 hp). w.target/targetKind are left alone:
  // warshipTick's validity check clears them once the target is gone.
  warshipShootAt(w) {
    if (this.elapsed - w.lastShellAt < this.WARSHIP_SHELL_COOLDOWN) return;
    w.lastShellAt = this.elapsed;
    const from = this.pathPos(w);
    this.shells.push({
      ownerId: w.owner,
      x: from.x, y: from.y,
      born: this.elapsed,
      targetKind: w.targetKind,
      target: w.target,
      damage: w.targetKind === 'warship' || w.targetKind === 'scout' ? this.warshipShellDamage() : null
    });
  },

  // Priority 3: the only target a warship chases. Repathed on a cooldown,
  // since a seaPath per warship per tick is far too expensive. On capture
  // the trade ship changes owner (and colour) and reroutes to the capturing
  // player's nearest tradeable Port (nearestOwnedPortRoute), so the payout
  // on arrival goes to the new owner. With no reachable Port it keeps its
  // old route under new colours.
  warshipChaseTradeShip(w, curTile) {
    const target = w.target;
    const tIdx = Math.min(target.path.length - 1, Math.floor(target.pos));
    const targetTile = target.path[tIdx];
    if (this.manhattanDist(curTile, targetTile) <= this.WARSHIP_CAPTURE_DIST) {
      target.owner = w.owner;
      target.captured = true;
      const route = this.nearestOwnedPortRoute(w.owner, targetTile);
      if (route) {
        target.dstPort = route.port.tile;
        target.path = route.path;
        target.pos = 0;
      }
      w.target = null; w.targetKind = null;
      return;
    }
    if (!w.path || w.pos >= w.path.length - 1 || this.elapsed - w.lastPathAt >= this.WARSHIP_CHASE_REPATH) {
      const path = this.seaPath([curTile], targetTile);
      if (path) { w.path = path; w.pos = 0; }
      w.lastPathAt = this.elapsed;
    }
    w.pos = Math.min(w.path.length - 1, w.pos + this.WARSHIP_SPEED * this.WARSHIP_CHASE_SPEED_MULT * this.TICK_DT);
  },

  // Bounded rejection sample for a water tile within patrol range of
  // `w.patrolTile` — a light version of WarshipExecution.randomTile (which
  // escalates its search radius over hundreds of attempts); missing here
  // just means trying again next WARSHIP_REPATH_INTERVAL, so there's no
  // need for that machinery. Returns -1 on a run of bad luck.
  warshipPickPatrolWaypoint(w) {
    const mw = GameMap.width, mh = GameMap.height;
    const cx = w.patrolTile % mw, cy = (w.patrolTile / mw) | 0;
    const range = this.WARSHIP_PATROL_RANGE;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = cx + Math.floor((this.rng() * 2 - 1) * range);
      const y = cy + Math.floor((this.rng() * 2 - 1) * range);
      if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
      const tile = GameMap.idx(x, y);
      if (GameMap.owner[tile] === WATER) return tile;
    }
    return -1;
  },

  // No target: wander within patrol range of patrolTile, exactly like
  // WarshipExecution.patrol(). Also where a fresh moveWarships() relocation
  // order actually plays out — that just seeds w.path/patrolTile directly,
  // so once it arrives this same "arrived → pick a new nearby waypoint"
  // logic takes over from the new center with no special-casing needed.
  warshipPatrol(w, curTile) {
    const arrived = !w.path || w.pos >= w.path.length - 1;
    if (arrived) {
      if (this.elapsed - w.lastPathAt >= this.WARSHIP_REPATH_INTERVAL) {
        const dest = this.warshipPickPatrolWaypoint(w);
        if (dest >= 0) {
          const path = this.seaPath([curTile], dest);
          if (path) { w.path = path; w.pos = 0; }
        }
        w.lastPathAt = this.elapsed;
      }
      return;
    }
    w.pos = Math.min(w.path.length - 1, w.pos + this.WARSHIP_SPEED * this.TICK_DT);
  },

  // Revalidates (and, if empty, re-acquires) a target every tick, then hands
  // off to combat/chase/patrol — see WarshipExecution.tick's own priority
  // chain (transport ship > warship > trade ship > patrol), reproduced here.
  warshipTick(w) {
    const idx = Math.min(w.path.length - 1, Math.floor(w.pos));
    const curTile = w.path[idx];
    const pos = this.pathPos(w);
    const rangeSq = this.WARSHIP_TARGET_RANGE * this.WARSHIP_TARGET_RANGE;
    const healthBefore = w.health;

    this.warshipHeal(w, curTile);

    if (w.target) {
      const kind = w.targetKind;
      const arr = kind === 'boat' ? this.boats : kind === 'warship' ? this.warships : kind === 'scout' ? this.scouts : this.tradeShips;
      let ok = arr.includes(w.target) && ((kind !== 'warship' && kind !== 'scout') || w.target.health > 0);
      if (ok) {
        const tp = this.pathPos(w.target);
        const d = (tp.x - pos.x) ** 2 + (tp.y - pos.y) ** 2;
        const ownerOf = kind === 'boat' ? w.target.attacker : w.target.owner;
        ok = d <= rangeSq && ownerOf !== w.owner && !this.areAllied(w.owner, ownerOf) &&
          !(kind === 'warship' && w.target.state === 'docked');
      }
      if (!ok) { w.target = null; w.targetKind = null; }
    }

    // Docked: sits in the Port healing, untargetable, until full health or its
    // Port is gone (WarshipExecution.tick's docked branch).
    if (w.state === 'docked') {
      if (!this.warshipRetreatPort(w) || w.health >= w.maxHealth) this.warshipCancelRetreat(w);
      else { w.target = null; w.targetKind = null; return; }
    }

    if (w.state === 'retreating') {
      if (this.warshipRetreat(w, curTile, pos, rangeSq)) return;
    } else if (this.warshipShouldRetreat(w, healthBefore)) {
      if (this.warshipStartRetreat(w, curTile) && this.warshipRetreat(w, curTile, pos, rangeSq)) return;
    }

    if (w.ordered && w.pos >= w.path.length - 1) w.ordered = false;

    if (!w.target) this.warshipAcquireTarget(w, pos, rangeSq);

    // A relocation order (or the launch voyage) is never interrupted: the ship
    // keeps sailing and shoots what it passes, but doesn't stop or chase.
    if (w.ordered) {
      if (w.targetKind === 'boat' || w.targetKind === 'warship' || w.targetKind === 'scout') this.warshipShootAt(w);
      else { w.target = null; w.targetKind = null; }
      w.pos = Math.min(w.path.length - 1, w.pos + this.WARSHIP_SPEED * this.TICK_DT);
      return;
    }

    if (w.targetKind === 'boat' || w.targetKind === 'warship' || w.targetKind === 'scout') {
      this.warshipShootAt(w);
      return;
    }
    if (w.targetKind === 'tradeship') {
      this.warshipChaseTradeShip(w, curTile);
      return;
    }
    this.warshipPatrol(w, curTile);
  },

  // --- Repair and retreat (WarshipExecution healWarship / handleRepairRetreat) ---

  // A player's built, owned Ports, in Game.buildings insertion order.
  warshipPorts(playerId) {
    const ports = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'port' && b.built && GameMap.owner[b.tile] === playerId) ports.push(b);
    }
    return ports;
  },

  // The Port a retreating/docked ship is bound for, or null if it is gone.
  warshipRetreatPort(w) {
    if (w.retreatPort < 0) return null;
    for (const b of this.warshipPorts(w.owner)) if (b.tile === w.retreatPort) return b;
    return null;
  },

  // Ships docked at `port`: the Port's capacity is its level.
  warshipsDockedAt(port, except) {
    let n = 0;
    const owner = GameMap.owner[port.tile];
    for (const o of this.warships) {
      if (o !== except && o.owner === owner && o.state === 'docked' && o.retreatPort === port.tile) n++;
    }
    return n;
  },

  // +1 hp/tick anywhere within range of an own Port; docked ships also share
  // the Port's pool (level * 5 hp/tick) between them, with the fraction carried.
  warshipHeal(w, curTile) {
    if (w.health >= w.maxHealth) return;
    const ports = this.warshipPorts(w.owner);
    const r2 = this.WARSHIP_PASSIVE_HEAL_RANGE * this.WARSHIP_PASSIVE_HEAL_RANGE;
    for (const b of ports) {
      if (this.tileDistSq(curTile, b.tile) <= r2) { w.health += this.WARSHIP_PASSIVE_HEAL; break; }
    }
    if (w.state === 'docked') {
      const port = ports.find(b => b.tile === w.retreatPort);
      if (port) {
        const n = this.warshipsDockedAt(port, null);
        if (n > 0) {
          w.healRemainder += port.level * this.WARSHIP_DOCK_HEAL_PER_LEVEL / n;
          const whole = Math.floor(w.healRemainder);
          w.healRemainder -= whole;
          w.health += whole;
        }
      }
    }
    if (w.health > w.maxHealth) w.health = w.maxHealth;
  },

  warshipShouldRetreat(w, healthBefore) {
    if (this.elapsed < w.retreatBlockUntil) return false;
    if (healthBefore >= Math.floor(w.maxHealth * this.WARSHIP_RETREAT_HEALTH_PCT / 100)) return false;
    return this.warshipPorts(w.owner).length > 0;
  },

  // Nearest own Port with free dock space that this ship can actually sail to,
  // with the route. `except` is the ship itself so its own berth doesn't count.
  warshipFindPort(w, curTile) {
    const ports = this.warshipPorts(w.owner).filter(b => this.warshipsDockedAt(b, w) < b.level);
    ports.sort((a, c) => this.tileDistSq(a.tile, curTile) - this.tileDistSq(c.tile, curTile));
    for (let i = 0; i < Math.min(ports.length, this.WARSHIP_LAUNCH_PORT_ATTEMPTS); i++) {
      const path = this.seaPath([curTile], ports[i].tile);
      if (path) return { port: ports[i], path };
    }
    return null;
  },

  warshipStartRetreat(w, curTile) {
    const r = this.warshipFindPort(w, curTile);
    if (!r) return false;
    w.state = 'retreating';
    w.retreatPort = r.port.tile;
    w.path = r.path; w.pos = 0;
    w.ordered = false;
    w.healRemainder = 0;
    w.target = null; w.targetKind = null;
    return true;
  },

  warshipCancelRetreat(w) {
    w.state = 'patrolling';
    w.retreatPort = -1;
    w.healRemainder = 0;
    w.ordered = false;
    w.target = null; w.targetKind = null;
    w.path = [w.path[Math.min(w.path.length - 1, Math.floor(w.pos))]];
    w.pos = 0;
    w.lastPathAt = this.elapsed;
  },

  // One tick of retreating. Fires back at a boat or warship in range while it
  // runs (never chases, never stops for a trade ship), docks inside the dock
  // range if the Port has room, and re-routes if the Port is lost or full.
  // Returns true when it handled the tick.
  warshipRetreat(w, curTile, pos, rangeSq) {
    if (!w.target) {
      this.warshipAcquireTarget(w, pos, rangeSq);
      if (w.targetKind === 'tradeship') { w.target = null; w.targetKind = null; }
    }
    if (w.target) this.warshipShootAt(w);

    let port = this.warshipRetreatPort(w);
    if (port && this.warshipsDockedAt(port, w) >= port.level) port = null;
    if (!port) {
      const r = this.warshipFindPort(w, curTile);
      if (!r) { this.warshipCancelRetreat(w); return false; }
      port = r.port;
      w.retreatPort = port.tile;
      w.path = r.path; w.pos = 0;
    }

    const d2 = this.tileDistSq(curTile, port.tile);
    if (d2 <= this.WARSHIP_DOCK_RANGE * this.WARSHIP_DOCK_RANGE) {
      w.state = 'docked';
      w.target = null; w.targetKind = null;
      return true;
    }
    if (w.pos >= w.path.length - 1) {
      // Path spent but not within dock range: re-route once per repath interval.
      if (this.elapsed - w.lastPathAt >= this.WARSHIP_CHASE_REPATH) {
        const path = this.seaPath([curTile], port.tile);
        if (path) { w.path = path; w.pos = 0; }
        else { this.warshipCancelRetreat(w); return false; }
        w.lastPathAt = this.elapsed;
      }
      return true;
    }
    w.pos = Math.min(w.path.length - 1, w.pos + this.WARSHIP_SPEED * this.TICK_DT);
    return true;
  },

  // Advances every in-flight shell by re-homing on its target's live
  // position, and resolves impact once it is within one tick's travel: a
  // boat is spliced from this.boats, a warship takes the shell's damage. If
  // the target is already gone, the shell is removed at once. render.js's
  // drawShells reads shell.x/y/born.
  stepShells() {
    const step = this.WARSHIP_SHELL_SPEED * this.TICK_DT;
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      const arr = s.targetKind === 'boat' ? this.boats : s.targetKind === 'scout' ? this.scouts : this.warships;
      const alive = arr.includes(s.target) && (s.targetKind === 'boat' || s.target.health > 0);
      if (!alive) { this.shells.splice(i, 1); continue; }

      const tp = this.pathPos(s.target);
      const dx = tp.x - s.x, dy = tp.y - s.y;
      const dist = this.det.hypot(dx, dy);
      if (dist <= step) {
        if (s.targetKind === 'boat') {
          const bi = this.boats.indexOf(s.target);
          if (bi >= 0) this.boats.splice(bi, 1);
        } else {
          s.target.health -= s.damage;
        }
        this.shells.splice(i, 1);
        continue;
      }
      s.x += dx / dist * step;
      s.y += dy / dist * step;
    }
  },

  // Sinks anything at 0 hp (no refund, no port to recall to — see the class
  // comment on what's deliberately not ported), decrementing units.warship
  // so unitCost's price curve reflects the fleet actually still afloat.
  // unitsBuilt is left untouched, same treatment losing a captured structure
  // gets — see the UNITS comment on why it never decrements.
  stepWarships() {
    for (let i = this.warships.length - 1; i >= 0; i--) {
      const w = this.warships[i];
      if (w.health <= 0) {
        this.warships.splice(i, 1);
        const owner = this.players[w.owner];
        if (owner) owner.units.warship = Math.max(0, this.unitsOwned(owner, 'warship') - 1);
        continue;
      }
      this.warshipTick(w);
      if (this.fog) this.warshipReveal(w);
    }
  },

  // Fog of war (docs/fog-of-war.md): a warship uncovers VISION_SIGHT_WARSHIP
  // cells around itself, for its owner and its owner's allies. Called at
  // launch and after each of its ticks; stamps only when the ship is in a
  // different vision cell from the last stamp. `visionCell` exists only on
  // warships in fog matches.
  warshipReveal(w) {
    const tile = w.path[Math.min(w.path.length - 1, Math.floor(w.pos))];
    const cell = this.visionCellOf(tile);
    if (cell === w.visionCell) return;
    w.visionCell = cell;
    this.revealAround(w.owner, tile, this.VISION_SIGHT_WARSHIP);
  },

});
