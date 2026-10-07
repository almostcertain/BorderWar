// js/game/nukes.js — Missile Silo & nukes.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // Where a nuke actually is at progress t (0..1), in tile space, including
  // the visual arc. Shared by stepSAMs (interception) and render.js
  // (drawing) so a nuke is shot down exactly when it is SEEN to cross a SAM
  // ring (ticket #35). The arc uses Bhaskara's sin(pi*t) approximation —
  // only +, *, / so it is bit-identical on every engine (Math.sin is not).
  nukeArcPos(n, t) {
    const dist = this.det.hypot(n.to.x - n.from.x, n.to.y - n.from.y);
    const k = t * (1 - t);
    const arc = 16 * k / (5 - 4 * k);
    return {
      x: n.from.x + (n.to.x - n.from.x) * t,
      y: n.from.y + (n.to.y - n.from.y) * t - arc * Math.min(dist * 0.35, 40),
    };
  },

  // --- Missile Silo & Nukes -----------------------------------------------
  // Missile Silo, Atom Bomb and Hydrogen Bomb. SAMs are in sam.js; MIRV is at
  // the end of this file.
  //
  // A nuke purchase is 'click anywhere, launch from the nearest ready Silo';
  // any tile is a valid target.
  //
  // A nuke has only fixed from/to endpoints and a travel duration (like a
  // warship's shell): it flies in a straight line over anything.

  // inner = guaranteed-destroyed radius, outer = the falling-off edge (see
  // nukeBlastTiles), in tiles. mirvwarhead is what one MIRV submunition does
  // on impact; the mothership has no blast of its own.
  NUKE_MAGNITUDES: {
    atombomb: { inner: 12, outer: 30 },
    // core/tendril: tile-destroy solid disc and spike gain, for blasts whose
    // 20-tile band is too thin to read as tendrils (see nukeBlastTiles).
    hydrogenbomb: { inner: 80, outer: 100, core: 65, tendril: 2.4 },
    mirvwarhead: { inner: 12, outer: 18 }
  },
  // Config.ts's nukeAllianceBreakThreshold(): a flat 100 for every nuke
  // type, no rescaling needed for the same tile-for-tile reason
  // NUKE_MAGNITUDES' own comment gives. See maybeBreakNukeAlliances below.
  NUKE_ALLIANCE_BREAK_THRESHOLD: 100,
  // Tiles per second. Deliberately slow enough that a flight is visible on
  // screen, while still much faster than a boat. MIRV and its warheads are
  // faster than an ordinary nuke, in the same ratio throughout.
  NUKE_SPEED: { atombomb: 45, hydrogenbomb: 45, mirv: 68, mirvwarhead: 99 },
  // Config.ts's SiloCooldown(): 90 ticks, converted through TICKS_PER_SEC.
  SILO_COOLDOWN: 9,
  // No OpenFront equivalent — purely how long the render-only shockwave
  // effect (see detonateNuke's push to nukeBlasts) stays on screen.
  NUKE_BLAST_FX_DURATION: 1.2,

  // Troops killed per impacted tile. Atom/Hydrogen Bomb: 5x the target's
  // current troops divided by the tiles they have left. Called once per
  // impacted tile with `humans`/`tilesLeft` shrinking, so a nuke hurts a
  // small nation more per tile. MIRVWarhead uses a different curve: it
  // scales with how far the target's troops sit ABOVE 3% of their maxTroops,
  // up to scalingFactor=500 per warhead, saturating via `1 - e^(-2x)`.
  // `maxTroops` is passed for every type; only mirvwarhead reads it.
  nukeDeathFactor(nukeType, humans, tilesLeft, maxTroops) {
    if (nukeType !== 'mirvwarhead') return (5 * humans) / Math.max(1, tilesLeft);
    const targetTroops = 0.03 * maxTroops;
    const excessTroops = Math.max(0, humans - targetTroops);
    const scalingFactor = 500, steepness = 2;
    const normalizedExcess = excessTroops / Math.max(1, maxTroops);
    return scalingFactor * (1 - Math.exp(-steepness * normalizedExcess));
  },

  // Resolves a nuke-purchase click: which of the player's built,
  // off-cooldown Silos launches it, and the target tile (never snapped; any
  // tile is legal). Returns { ok:false, reason } or { ok:true, silo, dst }.
  // Shared by nukeBlockReason (a dry run for the UI) and launchNuke.
  resolveNukeLaunch(playerId, nukeType, clickTile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return { ok: false, reason: 'Nation defeated' };
    if (clickTile < 0) return { ok: false, reason: 'Off the map' };
    const teamBlock = this.teamNukeBlockReason(playerId, nukeType, clickTile);
    if (teamBlock) return { ok: false, reason: teamBlock };

    const silos = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'silo' && b.built && GameMap.owner[b.tile] === playerId) silos.push(b);
    }
    if (silos.length === 0) return { ok: false, reason: 'Build a Missile Silo first' };

    const ready = silos.filter(s => this.siloFreeSlots(s) > 0);
    if (ready.length === 0) return { ok: false, reason: 'Silo reloading' };

    if (p.gold < this.unitCost(p, nukeType)) return { ok: false, reason: 'Not enough gold' };

    // Nearest ready Silo by straight-line distance — a missile has no route
    // to fail, unlike a Warship's seaPath, so there's nothing to fall back
    // through a second/third candidate for.
    ready.sort((a, c) => this.tileDistSq(a.tile, clickTile) - this.tileDistSq(c.tile, clickTile));
    return { ok: true, silo: ready[0], dst: clickTile };
  },

  nukeBlockReason(playerId, nukeType, clickTile) {
    return this.resolveNukeLaunch(playerId, nukeType, clickTile).reason || null;
  },

  canLaunchNuke(playerId, nukeType, clickTile) { return !this.nukeBlockReason(playerId, nukeType, clickTile); },

  // Diplomatic fallout of a nuke, applied at LAUNCH (launchNuke/debugNuke),
  // not on impact, so it holds even if a SAM shoots the nuke down. Atom and
  // Hydrogen Bombs only: a MIRV uses maybeBreakMirvAlliance, and a
  // mirvwarhead never reaches this.
  //
  // A target is angered when either:
  // 1. A weighted count of their tiles in the outer blast radius (1 per
  //    inner-radius tile, 0.5 per outer-ring tile) exceeds
  //    NUKE_ALLIANCE_BREAK_THRESHOLD. A flat circle scan, NOT
  //    nukeBlastTiles' irregular shape, so it does not depend on rng.
  // 2. ANY structure of theirs is inside the outer radius.
  // An angered ally has the alliance broken via breakAlliance (which marks
  // the owner a traitor); an angered non-ally takes a flat -100 relation hit.
  maybeBreakNukeAlliances(ownerId, nukeType, dst) {
    const magnitude = this.NUKE_MAGNITUDES[nukeType];
    const inner2 = magnitude.inner * magnitude.inner;
    const outer2 = magnitude.outer * magnitude.outer;
    const w = GameMap.width, h = GameMap.height;
    const dstX = dst % w, dstY = (dst / w) | 0;
    const x0 = Math.max(0, dstX - magnitude.outer), x1 = Math.min(w - 1, dstX + magnitude.outer);
    const y0 = Math.max(0, dstY - magnitude.outer), y1 = Math.min(h - 1, dstY + magnitude.outer);

    const weights = new Map();
    const angered = new Set();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - dstX, dy = y - dstY;
        const d2 = dx * dx + dy * dy;
        if (d2 > outer2) continue;
        const owner = GameMap.owner[y * w + x];
        if (owner < 0) continue;
        const weight = (weights.get(owner) || 0) + (d2 <= inner2 ? 1 : 0.5);
        weights.set(owner, weight);
        if (weight > this.NUKE_ALLIANCE_BREAK_THRESHOLD) angered.add(owner);
      }
    }

    for (const b of this.buildings.values()) {
      if (this.tileDistSq(dst, b.tile) < outer2) {
        const owner = GameMap.owner[b.tile];
        if (owner >= 0) angered.add(owner);
      }
    }

    for (const id of angered) {
      if (id === ownerId) continue;
      const target = this.players[id];
      if (!target || !target.alive) continue;
      if (this.areAllied(ownerId, id)) {
        this.breakAlliance(ownerId, id);
      } else {
        this.adjustRelation(target, ownerId, -100);
        // A nuke is an attack: the victim's allies cool toward the launcher too.
        const owner = this.players[ownerId];
        if (owner && !owner.isTribe && !target.isTribe && !this.isTraitor(target)) this.provokeAllies(owner, target);
      }
    }
  },

  // Missile slots this Silo can fire right now: its level minus launches
  // whose SILO_COOLDOWN hasn't run out yet. UnitImpl.isInCooldown is
  // `queue.length === level`; this counts instead of pruning so readiness
  // checks (UI, AI) never write sim state.
  siloFreeSlots(b) {
    let reloading = 0;
    for (const t of b.siloQueue) if (this.elapsed - t < this.SILO_COOLDOWN) reloading++;
    return Math.max(0, b.level - reloading);
  },
  // Spends one slot: drops reloads that have finished, then queues this one.
  consumeSiloSlot(b) {
    b.siloQueue = b.siloQueue.filter(t => this.elapsed - t < this.SILO_COOLDOWN);
    b.siloQueue.push(this.elapsed);
  },
  // Spawns instantly (matching SpawnExecution, same as buildWarship) at the
  // resolved Silo's tile, flying a straight line to the clicked destination.
  // Puts the launching Silo on cooldown immediately, exactly like
  // resolveWarshipLaunch's own MissileSilo.launch() call.
  launchNuke(playerId, nukeType, clickTile) {
    const r = this.resolveNukeLaunch(playerId, nukeType, clickTile);
    if (!r.ok) return false;
    const p = this.players[playerId];
    p.gold -= this.unitCost(p, nukeType);
    this.consumeSiloSlot(r.silo);

    const w = GameMap.width;
    const from = { x: r.silo.tile % w, y: (r.silo.tile / w) | 0 };
    const to = { x: clickTile % w, y: (clickTile / w) | 0 };
    const dist = this.det.hypot(to.x - from.x, to.y - from.y);
    this.nukes.push({
      ownerId: playerId, nukeType,
      src: r.silo.tile, dst: clickTile,
      from, to,
      born: this.elapsed,
      duration: Math.max(0.3, dist / this.NUKE_SPEED[nukeType])
    });
    this.maybeBreakNukeAlliances(playerId, nukeType, clickTile);
    return true;
  },

  // Debug-panel nuke: fires straight into this.nukes from an explicit
  // source/destination, skipping every resolveNukeLaunch check. Also
  // callable from the console:
  //   Game.debugNuke('atombomb', 1000, 1234)
  //   Game.debugNuke('hydrogenbomb', 1000, 1234, ownerId)
  // owner defaults to the first living non-tribe bot (so your own SAMs treat
  // it as hostile), falling back to the human player.
  debugNuke(nukeType, srcTile, dstTile, ownerId = null) {
    const w = GameMap.width;
    if (ownerId == null) {
      // "Not me" was only ever a stand-in for "not the human" — express it
      // that way so even this debug helper stays independent of which client
      // is viewing, and picks the same owner everywhere.
      ownerId = this.players.findIndex(p => p && p.alive && !p.isTribe && !p.isHuman);
      if (ownerId < 0) ownerId = this.players.findIndex(p => p && p.isHuman);
    }
    if (!this.players[ownerId]) { console.warn('[debugNuke] no such player', ownerId); return false; }

    const from = { x: srcTile % w, y: (srcTile / w) | 0 };
    const to = { x: dstTile % w, y: (dstTile / w) | 0 };
    const dist = this.det.hypot(to.x - from.x, to.y - from.y);
    this.nukes.push({
      ownerId, nukeType,
      src: srcTile, dst: dstTile,
      from, to,
      born: this.elapsed,
      duration: Math.max(0.3, dist / this.NUKE_SPEED[nukeType])
    });
    this.maybeBreakNukeAlliances(ownerId, nukeType, dstTile);
    return true;
  },

  // The blast footprint: a solid disc out to the inner radius, then an edge
  // that wanders between inner and outer by bearing (five harmonics with
  // random phases), so the crater is irregular but one solid, hole-free
  // shape. A per-tile coin flip in that band left one-tile survivors that
  // had to be cleaned up one at a time. Draws a fixed five rng() values per
  // blast, so lockstep clients stay in step.
  nukeBlastTiles(dst, magnitude) {
    const core = magnitude.core ?? magnitude.inner;
    const inner2 = core * core;
    const w = GameMap.width, h = GameMap.height;
    const cx = dst % w, cy = (dst / w) | 0;
    const band = magnitude.outer - core;
    const phase = [];
    for (let i = 0; i < 5; i++) phase.push(this.rng() * 2 * Math.PI);
    const reach = Math.ceil(magnitude.outer);
    const result = new Set();
    for (let y = Math.max(0, cy - reach); y <= Math.min(h - 1, cy + reach); y++) {
      for (let x = Math.max(0, cx - reach); x <= Math.min(w - 1, cx + reach); x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > inner2) {
          const a = Math.atan2(dy, dx);
          // Low harmonics give the lopsided base; the high ones (7/11/17
          // lobes) plus the squaring below turn the peaks into narrow
          // tendrils reaching toward the outer radius.
          const v = 0.5 + 0.5 * (Math.sin(2 * a + phase[0]) * 0.2 + Math.sin(3 * a + phase[1]) * 0.2 +
            Math.sin(7 * a + phase[2]) * 0.25 + Math.sin(11 * a + phase[3]) * 0.2 + Math.sin(17 * a + phase[4]) * 0.15);
          const s = Math.min(1, v * v * (magnitude.tendril ?? 1.8));
          const r = core + band * s;
          if (d2 > r * r) continue;
        }
        result.add(y * w + x);
      }
    }
    return result;
  },

  // Order matters:
  // 1. buildings are destroyed FIRST, reading ownership off GameMap.owner
  //    before anything overwrites it;
  // 2. tiles are unclaimed and irradiated: the land survives, unowned and
  //    capturable, but expensive to retake (see falloutDefenseModifier);
  // 3. troop losses are applied using tilesBeforeNuke = tiles owned now +
  //    impacted tiles;
  // 4. anything afloat within the full outer-radius circle sinks. That
  //    circle is stricter than the land-destroy shape, so a structure can
  //    be destroyed on a tile the blast shape spared.
  detonateNuke(nuke) {
    const dst = nuke.dst;
    const magnitude = this.NUKE_MAGNITUDES[nuke.nukeType];
    const outer2 = magnitude.outer * magnitude.outer;
    const w = GameMap.width;
    const dstX = dst % w, dstY = (dst / w) | 0;
    const withinOuter = (pos) => (pos.x - dstX) ** 2 + (pos.y - dstY) ** 2 < outer2;

    // 1. Every building within the full outer-radius circle, owner read
    // fresh before step 2 below can touch GameMap.owner.
    for (const [tile, b] of this.buildings) {
      if (this.tileDistSq(dst, tile) >= outer2) continue;
      const owner = GameMap.owner[tile];
      if (owner >= 0) {
        const op = this.players[owner];
        if (b.built) op.units[b.type] = Math.max(0, this.unitsOwned(op, b.type) - b.level);
        else op.unitsPending[b.type] = Math.max(0, this.unitsPending(op, b.type) - 1);
        // Fog of war: a nuke hit tells the victim who launched it.
        if (this.fog) this.markMet(owner, nuke.ownerId);
      }
      this.removeStationRails(b);
      this.buildings.delete(tile);
    }

    // 2. Unclaim + irradiate the land-destroy set. The land is not
    // turned to water: it gets fallout, which a real capture clears
    // (see setOwner).
    const toDestroy = this.nukeBlastTiles(dst, magnitude);
    const tilesPerPlayer = new Map();
    for (const tile of toDestroy) {
      const owner = GameMap.owner[tile];
      if (owner >= 0) {
        tilesPerPlayer.set(owner, (tilesPerPlayer.get(owner) || 0) + 1);
        // Must go through setOwner, not a raw GameMap.owner write: only
        // setOwner keeps Player.borderTiles in step (updateBorderTile), and
        // without that refreshFrontier finds no frontier against the crater
        // and it can never be retaken. setOwner does NOT clear fallout on a
        // revert to NEUTRAL, so the irradiation below stands.
        this.setOwner(tile, NEUTRAL);
      }
      // Fallout applies to every LAND tile in the blast, owned or not
      // (`owner !== WATER` is the land check). Battle Royale's dead zone
      // (game/drill.js) takes no fallout.
      if (owner !== WATER && !this.drillDead[tile]) this.fallout.add(tile);
      this.dirtyTiles.add(tile);
    }

    // 3. Diminishing troop losses: the player's home reserve, outgoing
    // attacks and in-transit invasion boats all take the same per-tile
    // nukeDeathFactor hit, read and written live so the loss compounds.
    // maxTroops is computed once per player.
    for (const [ownerId, numImpactedTiles] of tilesPerPlayer) {
      const p = this.players[ownerId];
      if (this.fog) this.markMet(ownerId, nuke.ownerId);
      const maxTroops = this.maxTroops(p);
      let tilesLeft = p.tiles.size + numImpactedTiles;
      for (let i = 0; i < numImpactedTiles; i++) {
        p.troops = Math.max(0, p.troops - this.nukeDeathFactor(nuke.nukeType, p.troops, tilesLeft, maxTroops));
        for (const a of this.attacks) {
          if (a.attacker !== ownerId) continue;
          a.troops = Math.max(0, a.troops - this.nukeDeathFactor(nuke.nukeType, a.troops, tilesLeft, maxTroops));
        }
        for (const bt of this.boats) {
          if (bt.attacker !== ownerId) continue;
          bt.troops = Math.max(0, bt.troops - this.nukeDeathFactor(nuke.nukeType, bt.troops, tilesLeft, maxTroops));
        }
        tilesLeft--;
      }
    }

    // 4. Anything afloat within the same full outer-radius circle sinks
    // outright, own fleet included — no owner immunity, matching the real
    // source's unconditional mg.units() sweep.
    for (let i = this.warships.length - 1; i >= 0; i--) {
      if (withinOuter(this.pathPos(this.warships[i]))) this.warships.splice(i, 1);
    }
    // Fog of war's Scouts (game/scouts.js); an empty list with fog off.
    for (let i = this.scouts.length - 1; i >= 0; i--) {
      if (withinOuter(this.pathPos(this.scouts[i]))) this.scouts.splice(i, 1);
    }
    for (let i = this.boats.length - 1; i >= 0; i--) {
      if (withinOuter(this.pathPos(this.boats[i]))) this.boats.splice(i, 1);
    }
    for (let i = this.tradeShips.length - 1; i >= 0; i--) {
      if (withinOuter(this.pathPos(this.tradeShips[i]))) this.tradeShips.splice(i, 1);
    }

    // Ephemeral shockwave for render.js's drawNukeBlasts — not gameplay
    // state, just aged out and pruned by stepNukes below.
    this.nukeBlasts.push({ x: dstX, y: dstY, inner: magnitude.inner, outer: magnitude.outer, born: this.elapsed });
  },

  // Advances every in-flight nuke and detonates it once its travel
  // duration elapses. stepSAMs runs first (see Game.tick) and splices out
  // anything it intercepts, so every nuke still here got through. Also
  // prunes spent shockwave effects.
  stepNukes() {
    for (let i = this.nukes.length - 1; i >= 0; i--) {
      const n = this.nukes[i];
      if (this.elapsed - n.born < n.duration) continue;
      this.nukes.splice(i, 1);
      this.detonateNuke(n);
    }
    for (let i = this.nukeBlasts.length - 1; i >= 0; i--) {
      if (this.elapsed - this.nukeBlasts[i].born > this.NUKE_BLAST_FX_DURATION) this.nukeBlasts.splice(i, 1);
    }
  },

  // --- MIRV -------------------------------------------------------------------
  //   - MIRV_WARHEAD_COUNT warheads.
  //   - The mothership flies Silo -> a mid-air separation point (see
  //     launchMirv), and the warheads fan out from THAT point.
  //   - Targets are generated in a staggered pass over the ticks before the
  //     mothership reaches the separation point, then re-validated, topped
  //     up and sorted in one finalize pass (see stepMirvs).
  //   - Each warhead gets its own Game.rng()-drawn wait on top of the shared
  //     base wait, plus an index-bucketed speed offset (spawnMirvWarheads).
  //   - nukeDeathFactor branches on nukeType.
  //
  // Both legs (Silo -> separation, separation -> each target) fly as a
  // straight line with a cosmetic arc, like every other nuke here.
  //
  // Two nukes cannot leave the same Silo on the same tick (SILO_COOLDOWN),
  // so there is no launch-queue stagger.
  MIRV_WARHEAD_COUNT: 350,
  // In tiles. `range` is how far from the AIM tile a warhead target may
  // land; `minimumSpread` is the minimum Manhattan distance between any two
  // warhead targets.
  MIRV_RANGE: 1500,
  MIRV_MIN_SPREAD: 55,
  // Tick windows. Staggered target pre-generation runs while the mothership
  // has MORE than MIRV_FINALIZE_TICKS but AT MOST MIRV_STAGE_TICKS ticks
  // left before the separation point; finalize (re-validate, top up, sort,
  // spawn) fires once, the first tick it has AT MOST MIRV_FINALIZE_TICKS
  // left. See stepMirvs.
  MIRV_STAGE_TICKS: 20,
  MIRV_FINALIZE_TICKS: 10,
  // MirvExecution's own per-tick/per-call attempt caps — see
  // tryGenerateMirvTarget (the 100-attempt inner search for ONE valid,
  // non-overlapping target) and stageMirvTargets (the 100-call outer budget
  // spent EACH tick of the staging window trying to grow stagedTargets by
  // one target per successful call).
  MIRV_TARGET_ATTEMPTS: 100,
  MIRV_STAGE_ATTEMPTS_PER_TICK: 100,
  // finalizeDestinations' own extra-attempts formula:
  // 500 + (MIRV_FINALIZE_TICKS - remainingTicks) * 50 — a flat budget plus a
  // penalty for every tick the staging window got cut short (a MIRV whose
  // whole flight is under MIRV_STAGE_TICKS ticks skips straight to finalize
  // with little or no staged pre-generation, and this is what compensates).
  MIRV_FINALIZE_BASE_ATTEMPTS: 500,
  MIRV_FINALIZE_ATTEMPTS_PER_TICK: 50,
  // Per-warhead wait jitter: one of 16 values (0..15 ticks), drawn from
  // Game.rng(), on top of the shared base wait.
  MIRV_WAIT_JITTER_TICKS: 16,
  // A 5-bucket speed ramp (MIRV_WARHEAD_COUNT/5 warheads per bucket) added
  // to NUKE_SPEED.mirvwarhead. The index is the warhead's position in the
  // finalized target list (sorted by descending distance).
  MIRV_WARHEAD_SPEED_STEP: 4.5,
  // MIRV cost: a base plus an increment per MIRV any player has EVER
  // launched this match (mirvsLaunched in core.js), not the per-owner curve
  // other UNITS entries use. Special-cased in Game.unitCost.
  MIRV_BASE_COST: 25000000,
  MIRV_COST_STEP: 15000000,

  // Same 'click anywhere, launch from the nearest ready Silo' resolution as
  // other nukes: resolveNukeLaunch/nukeBlockReason are generic over
  // nukeType (teamNukeBlockReason in teams.js has already refused a
  // teammate's tile). Adds the separation-point geometry and the
  // staged-target bookkeeping stepMirvs drives.
  launchMirv(playerId, clickTile) {
    const r = this.resolveNukeLaunch(playerId, 'mirv', clickTile);
    if (!r.ok) return false;
    const p = this.players[playerId];
    p.gold -= this.unitCost(p, 'mirv');
    this.consumeSiloSlot(r.silo);
    this.mirvsLaunched++;

    const w = GameMap.width, h = GameMap.height;
    const siloXY = { x: r.silo.tile % w, y: (r.silo.tile / w) | 0 };
    const aimXY = { x: clickTile % w, y: (clickTile / w) | 0 };

    // Separation point: x is the midpoint between the Silo and the aim
    // tile; y is `max(0, aimY - 500) + 50`, a near-fixed high apex (50
    // for almost every strike on these map heights). Clamped to h-1 for
    // any map under 50 rows tall.
    const sepX = Math.round((aimXY.x + siloXY.x) / 2);
    const sepY = Math.min(h - 1, Math.max(0, Math.max(0, aimXY.y - 500) + 50));
    const dist = this.det.hypot(sepX - siloXY.x, sepY - siloXY.y);
    const duration = Math.max(0.3, dist / this.NUKE_SPEED.mirv);
    // Tick-quantized duplicate of the same flight length, used ONLY for the
    // staging/finalize countdown in stepMirvs (see that function's own
    // comment on why integer ticks rather than float seconds) — `duration`
    // above stays in seconds for render.js/ui.js, which already read every
    // other nuke-shaped object's born/duration that way.
    const durationTicks = Math.max(1, Math.round(duration / this.TICK_DT));

    this.mirvs.push({
      ownerId: playerId, nukeType: 'mirv',
      src: r.silo.tile, dst: clickTile,
      // Who owns the aim tile at launch. Read once and reused by every
      // later pass: finalizeMirvTargets re-validates staged tiles against
      // this value, so a tile that changed hands mid-flight drops out.
      targetOwner: GameMap.owner[clickTile],
      from: siloXY, to: { x: sepX, y: sepY },
      born: this.elapsed, duration,
      bornTick: this.ticks, durationTicks,
      // The aim tile is always the first staged target, so at least one
      // warhead lands where the player clicked. _grid is
      // mirvTargetOverlaps' spatial hash, seeded with the aim point too.
      stagedTargets: [clickTile], _xs: [aimXY.x], _ys: [aimXY.y],
      _grid: new Map([[this.mirvGridCell(aimXY.x, aimXY.y), [aimXY.x, aimXY.y]]]),
      finalized: false
    });
    this.maybeBreakMirvAlliance(playerId, clickTile);
    return true;
  },

  // Launch-moment betrayal check. Unconditional and mutual: -100 relation
  // on BOTH sides whenever the aim tile has an owner other than the
  // launcher, on top of breakAlliance (which applies its own -100 to the
  // betrayed side). A MIRV at an ally therefore costs 200 of that ally's
  // opinion; the double count is intended.
  maybeBreakMirvAlliance(ownerId, dst) {
    const targetOwner = GameMap.owner[dst];
    if (targetOwner < 0 || targetOwner === ownerId) return;
    const owner = this.players[ownerId];
    const target = this.players[targetOwner];
    if (!target || !target.alive) return;
    if (this.areAllied(ownerId, targetOwner)) this.breakAlliance(ownerId, targetOwner);
    this.adjustRelation(target, ownerId, -100);
    if (owner) this.adjustRelation(owner, targetOwner, -100);
    if (owner && !owner.isTribe && !target.isTribe && !this.isTraitor(target)) this.provokeAllies(owner, target);
  },

  // A bounded search for ONE valid target; the callers (stageMirvTargets,
  // finalizeMirvTargets) supply the outer retry loop. Draws Game.rng()
  // twice per attempt (x, then y). Returns -1 when all
  // MIRV_TARGET_ATTEMPTS attempts are invalid.
  tryGenerateMirvTarget(m) {
    const w = GameMap.width, h = GameMap.height;
    const baseX = m.dst % w, baseY = (m.dst / w) | 0;
    const range = this.MIRV_RANGE, range2 = range * range;
    for (let attempt = 0; attempt < this.MIRV_TARGET_ATTEMPTS; attempt++) {
      const dx = Math.round((this.rng() * 2 - 1) * range);
      const dy = Math.round((this.rng() * 2 - 1) * range);
      if (dx * dx + dy * dy > range2) continue;
      const x = baseX + dx, y = baseY + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const tile = y * w + x;
      if (GameMap.owner[tile] !== m.targetOwner) continue;
      if (this.mirvTargetOverlaps(m, x, y)) continue;
      return tile;
    }
    return -1;
  },

  // Spatial hash for the MIN_SPREAD overlap test. Every staged point is
  // bucketed into a MIRV_MIN_SPREAD-sized grid cell (m._grid), so any point
  // within minSpread (Manhattan) of (x,y) is in its cell or one of the 8
  // neighbours. Same accept/reject result as an O(n) scan, just cheaper.
  mirvGridCell(x, y) {
    return Math.floor(x / this.MIRV_MIN_SPREAD) * 1000003 + Math.floor(y / this.MIRV_MIN_SPREAD);
  },
  mirvTargetOverlaps(m, x, y) {
    const minSpread = this.MIRV_MIN_SPREAD;
    const cx = Math.floor(x / minSpread), cy = Math.floor(y / minSpread);
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcy = -1; dcy <= 1; dcy++) {
        const bucket = m._grid.get((cx + dcx) * 1000003 + (cy + dcy));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 2) {
          if (Math.abs(x - bucket[i]) + Math.abs(y - bucket[i + 1]) < minSpread) return true;
        }
      }
    }
    return false;
  },

  // Pushes a freshly-found target into m.stagedTargets, the parallel
  // m._xs/m._ys coordinate arrays (spawnMirvWarheads' own reads), and the
  // m._grid bucket mirvTargetOverlaps scans.
  pushMirvTarget(m, tile) {
    const w = GameMap.width;
    const x = tile % w, y = (tile / w) | 0;
    m.stagedTargets.push(tile);
    m._xs.push(x);
    m._ys.push(y);
    const key = this.mirvGridCell(x, y);
    let bucket = m._grid.get(key);
    if (!bucket) { bucket = []; m._grid.set(key, bucket); }
    bucket.push(x, y);
  },

  // Staggered pre-generation, run once per tick while remainingTicks is in
  // (MIRV_FINALIZE_TICKS, MIRV_STAGE_TICKS] (see stepMirvs). Up to
  // MIRV_STAGE_ATTEMPTS_PER_TICK calls to tryGenerateMirvTarget, stopping
  // once MIRV_WARHEAD_COUNT is reached.
  stageMirvTargets(m) {
    for (let attempt = 0; attempt < this.MIRV_STAGE_ATTEMPTS_PER_TICK && m.stagedTargets.length < this.MIRV_WARHEAD_COUNT; attempt++) {
      const tile = this.tryGenerateMirvTarget(m);
      if (tile >= 0) this.pushMirvTarget(m, tile);
    }
  },

  // Re-validate every staged tile against the ownership snapshot taken at
  // launch (m.dst itself is exempt), top up with `additionalAttempts` more
  // tryGenerateMirvTarget calls, then sort descending by Manhattan distance
  // from the aim tile. spawnMirvWarheads' speed ramp depends on that order.
  finalizeMirvTargets(m, additionalAttempts) {
    const w = GameMap.width;
    const kept = [], keptX = [], keptY = [];
    for (let i = 0; i < m.stagedTargets.length; i++) {
      const tile = m.stagedTargets[i];
      if (tile === m.dst || GameMap.owner[tile] === m.targetOwner) {
        kept.push(tile); keptX.push(m._xs[i]); keptY.push(m._ys[i]);
      }
    }
    m.stagedTargets = kept; m._xs = keptX; m._ys = keptY;
    // Rebuild the overlap grid from the kept set only — a tile that just got
    // re-validated away must also stop blocking new targets near it.
    m._grid = new Map();
    for (let i = 0; i < kept.length; i++) {
      const key = this.mirvGridCell(keptX[i], keptY[i]);
      let bucket = m._grid.get(key);
      if (!bucket) { bucket = []; m._grid.set(key, bucket); }
      bucket.push(keptX[i], keptY[i]);
    }

    for (let attempt = 0; attempt < additionalAttempts && m.stagedTargets.length < this.MIRV_WARHEAD_COUNT; attempt++) {
      const tile = this.tryGenerateMirvTarget(m);
      if (tile >= 0) this.pushMirvTarget(m, tile);
    }

    const dstX = m.dst % w, dstY = (m.dst / w) | 0;
    const dist = (tile) => Math.abs(tile % w - dstX) + Math.abs(((tile / w) | 0) - dstY);
    // Stable sort: Array.prototype.sort has been spec-guaranteed stable
    // since ES2019 (every engine this game targets), so two targets at the
    // exact same distance keep their staged/generation order — deterministic
    // across clients the same way every other stable-iteration-order rule
    // in this file already is.
    m.stagedTargets.sort((a, b) => dist(b) - dist(a));
  },

  // Every finalized target becomes one ordinary this.nukes entry (nukeType
  // 'mirvwarhead'), launched from the separation point (m.to), with its own
  // Game.rng()-drawn wait on top of the shared waitBase and its own
  // index-bucketed speed offset. `born` is the FUTURE tick the warhead
  // starts moving: until then it sits at its launch point, interceptable,
  // and consumers clamp (elapsed-born)/duration to >= 0. Warheads are pushed
  // in stagedTargets' sorted order, so every client builds the same array.
  spawnMirvWarheads(m, remainingTicks) {
    const w = GameMap.width;
    const waitBase = Math.max(0, remainingTicks);
    const bucketSize = Math.ceil(this.MIRV_WARHEAD_COUNT / 5);
    for (let i = 0; i < m.stagedTargets.length; i++) {
      const tile = m.stagedTargets[i];
      const to = { x: m._xs[i], y: m._ys[i] };
      const dist = this.det.hypot(to.x - m.to.x, to.y - m.to.y);
      const speedOffset = Math.min(4, Math.floor(i / bucketSize)) * this.MIRV_WARHEAD_SPEED_STEP;
      const waitTicks = waitBase + Math.floor(this.rng() * this.MIRV_WAIT_JITTER_TICKS);
      this.nukes.push({
        ownerId: m.ownerId, nukeType: 'mirvwarhead',
        src: m.sepTile, dst: tile,
        from: m.to, to,
        born: this.elapsed + waitTicks * this.TICK_DT,
        duration: Math.max(0.3, dist / (this.NUKE_SPEED.mirvwarhead + speedOffset))
      });
    }
  },

  // Advances every in-flight MIRV mothership. Separate from stepNukes
  // because a MIRV doesn't detonate: it stages targets, spawns warheads
  // about a second before it arrives, then disappears. Runs before
  // stepSAMs/stepNukes in Game.tick, so a warhead spawned this tick is
  // visible to the same tick's SAM pass. stepSAMs never scans this.mirvs:
  // the mothership is not interceptable, only its warheads are.
  //
  // remainingTicks comes from the integer bornTick/durationTicks pair, not
  // the float seconds the renderer reads.
  stepMirvs() {
    for (let i = this.mirvs.length - 1; i >= 0; i--) {
      const m = this.mirvs[i];
      const remainingTicks = m.bornTick + m.durationTicks - this.ticks;

      if (remainingTicks <= this.MIRV_STAGE_TICKS && remainingTicks > this.MIRV_FINALIZE_TICKS) {
        this.stageMirvTargets(m);
      }
      if (remainingTicks <= this.MIRV_FINALIZE_TICKS && !m.finalized) {
        m.finalized = true;
        // Re-reads CURRENT ownership (not the launch-time snapshot): if the
        // strike area became a teammate's after launch, the strike fizzles
        // with no warheads.
        m.sepTile = m.to.y * GameMap.width + m.to.x;
        if (!this.onSameTeam(m.ownerId, GameMap.owner[m.dst])) {
          const extraAttempts = this.MIRV_FINALIZE_BASE_ATTEMPTS +
            (this.MIRV_FINALIZE_TICKS - remainingTicks) * this.MIRV_FINALIZE_ATTEMPTS_PER_TICK;
          this.finalizeMirvTargets(m, extraAttempts);
          this.spawnMirvWarheads(m, remainingTicks);
        }
      }
      if (remainingTicks > 0) continue;
      this.mirvs.splice(i, 1);
    }
  },

});
