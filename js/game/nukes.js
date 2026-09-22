// js/game/nukes.js — Missile Silo & nukes.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Missile Silo & Nukes -----------------------------------------------
  // Ported against OpenFront's real MissileSiloExecution/NukeExecution/
  // Config.ts source (github.com/openfrontio/OpenFrontIO), not guessed — see
  // feedback-openfront-source-porting memory for the fetch approach. Scoped
  // down from the real source the same way every other structure in this
  // file has been (see the UNITS/Warship section comments above), per an
  // explicit user scoping decision this session: only Missile Silo, Atom
  // Bomb, and Hydrogen Bomb are ported here. SAM Launcher (the defensive
  // interceptor) was deferred at the time this comment was first written but
  // has since been added — see the "SAM Launcher & Interceptors" section
  // below, right after stepNukes. MIRV (the multi-warhead mega-nuke) is
  // still deliberately left for a later pass. Alliance-breaking
  // (NukeExecution.maybeBreakAlliances' weighted-tile-count threshold) WAS
  // deliberately left unported at first, then added after a user report
  // that nuking an ally earned no betrayal debuff — see
  // maybeBreakNukeAlliances below, hung off launchNuke/debugNuke rather
  // than detonateNuke (see that function's own comment for why).
  //
  // Purchase/targeting follows the same "click anywhere, launch from the
  // nearest ready structure" UX Warship's resolveWarshipLaunch already
  // established (see that function's own comment) — real OpenFront's own
  // nuke targeting works this way natively (any tile is a valid target,
  // Player.canBuild resolves which Silo actually launches it), so this one
  // needed no divergence note the way Warship's port-requirement did.
  //
  // A nuke is a wholly new entity shape, not reusing the boat/warship/
  // trade-ship {path, pos} convention Game.pathPos reads — a missile flies
  // in a straight line over anything (terrain, water, the map's whole
  // pathfinding graph) rather than following a route, so it only ever needs
  // its fixed from/to endpoints and a travel duration, exactly like a
  // Warship's own shell (see warshipShootAt/stepShells) but slower and far
  // more destructive on arrival.

  // Config.ts's nukeMagnitudes(): inner = guaranteed-destroyed radius, outer
  // = the falling-off "radiating" edge (see nukeBlastTiles). Tile radii,
  // not ticks — no rescaling needed, since MAP_SIZES already ports
  // OpenFront's real map dimensions tile-for-tile (see TRAIN_STATION_MAX_
  // RANGE's own comment making the identical point). MIRV's own magnitude
  // (12/18) isn't carried here — no MIRV in this pass.
  NUKE_MAGNITUDES: {
    atombomb: { inner: 12, outer: 30 },
    hydrogenbomb: { inner: 80, outer: 100 }
  },
  // Config.ts's nukeAllianceBreakThreshold(): a flat 100 for every nuke
  // type, no rescaling needed for the same tile-for-tile reason
  // NUKE_MAGNITUDES' own comment gives. See maybeBreakNukeAlliances below.
  NUKE_ALLIANCE_BREAK_THRESHOLD: 100,
  // Config.ts's nukeSpeed(): both bomb types return 10 in their own per-tick
  // scale, which converts to 100 tiles/sec via TICKS_PER_SEC exactly like
  // BOAT_SPEED's own "1 tile/tick" comment. Slowed well below that ported
  // rate so a nuke's flight is visible on screen instead of near-instant,
  // while still reading as dramatically faster than a boat/warship.
  NUKE_SPEED: { atombomb: 45, hydrogenbomb: 45 },
  // Config.ts's SiloCooldown(): 90 ticks, converted through TICKS_PER_SEC.
  SILO_COOLDOWN: 9,
  // No OpenFront equivalent — purely how long the render-only shockwave
  // effect (see detonateNuke's push to nukeBlasts) stays on screen.
  NUKE_BLAST_FX_DURATION: 1.2,

  // Config.ts's nukeDeathFactor with the MIRVWarhead branch dropped (no MIRV
  // in this pass) — the AtomBomb/HydrogenBomb branch is the same formula
  // for both types regardless: 5x the target's current troops, divided by
  // however many owned tiles they have left. Called once per impacted tile
  // in detonateNuke's loop, with `humans`/`tilesLeft` shrinking each
  // iteration, so the same nuke hurts more per-tile against a nation that's
  // already small than one that's still large — verbatim their own
  // diminishing-effect loop.
  nukeDeathFactor(humans, tilesLeft) {
    return (5 * humans) / Math.max(1, tilesLeft);
  },

  // Resolves what a nuke-purchase click actually means: which of the
  // player's own built, off-cooldown Silos launches it, and the target tile
  // (unlike Warship's resolveWarshipLaunch, a nuke's destination is never
  // snapped — any tile, land, water, even a tile the player's own nation
  // holds, is a legal target, matching real OpenFront exactly). Returns
  // { ok:false, reason } or { ok:true, silo, dst }. Shared by
  // nukeBlockReason (a dry run for the UI) and launchNuke.
  resolveNukeLaunch(playerId, nukeType, clickTile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return { ok: false, reason: 'Nation defeated' };
    if (clickTile < 0) return { ok: false, reason: 'Off the map' };

    const silos = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'silo' && b.built && GameMap.owner[b.tile] === playerId) silos.push(b);
    }
    if (silos.length === 0) return { ok: false, reason: 'Build a Missile Silo first' };

    const ready = silos.filter(s => this.elapsed - s.lastLaunchAt >= this.SILO_COOLDOWN);
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

  // Ported against NukeExecution.maybeBreakAlliances/Util.ts's
  // listNukeBreakAlliance. Real OpenFront runs this the INSTANT a nuke is
  // launched — NukeExecution.tick's nuke===null branch calls it right after
  // building the missile unit, not on impact — so the diplomatic fallout is
  // committed by the trajectory alone, even for a nuke a SAM shoots down
  // seconds later. Ported at the same point here: launchNuke/debugNuke
  // below, not detonateNuke. MIRV warheads are excluded in the real source;
  // this game has no MIRV yet (see project memory), so every nuke type
  // qualifies.
  //
  // Two ways a target gets angered, matching the real source exactly:
  // 1. A weighted tile count (their owned tiles within the outer blast
  //    radius, 1 per inner-radius tile / 0.5 per outer-ring tile) exceeding
  //    NUKE_ALLIANCE_BREAK_THRESHOLD. Deliberately a flat geometric circle
  //    scan, NOT nukeBlastTiles' irregular crater shape below — the real
  //    source keeps this pure distance so it doesn't depend on the coin
  //    flip that decides which tiles actually burn.
  // 2. ANY structure of theirs at all inside the outer radius, no
  //    threshold — verbatim listNukeBreakAlliance's unconditional
  //    nearbyUnits(...Structures.types...) sweep.
  // An angered ally has the alliance broken via breakAlliance (which is
  // what actually applies the traitor mark/betrayal debuff to the nuke's
  // owner); an angered non-ally just takes the flat -100 relation hit real
  // OpenFront gives every angered player regardless of alliance status.
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
      }
    }
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
    r.silo.lastLaunchAt = this.elapsed;

    const w = GameMap.width;
    const from = { x: r.silo.tile % w, y: (r.silo.tile / w) | 0 };
    const to = { x: clickTile % w, y: (clickTile / w) | 0 };
    const dist = this.det.hypot(to.x - from.x, to.y - from.y);
    this.nukes.push({
      ownerId: playerId, nukeType,
      src: r.silo.tile, dst: clickTile,
      from, to,
      born: this.elapsed,
      duration: Math.max(0.3, dist / this.NUKE_SPEED[nukeType]),
      // SAMTargetingSystem's targetedBySam flag, ported for stepSAMs (see
      // "SAM Launcher & Interceptors") — set the instant a SAM commits a
      // charge to this nuke, so a second SAM never also claims it.
      targetedBySAM: false
    });
    this.maybeBreakNukeAlliances(playerId, nukeType, clickTile);
    return true;
  },

  // Debug-panel nuke — fires a nuke straight into this.nukes from an
  // explicit source/destination pair, skipping every resolveNukeLaunch check
  // (Silo built, cooldown, gold). Backs UI's two-click "Debug Nuke"/"Debug
  // H-Bomb" buttons (see ui.js's armDebugNuke/onTap 'debugnuke' branch), but
  // also callable straight from the browser console since Game is a plain
  // top-level const, not module-scoped:
  //   Game.debugNuke('atombomb', 1000, 1234)
  //   Game.debugNuke('hydrogenbomb', 1000, 1234, ownerId)
  // owner defaults to the first living non-tribe bot (so your own SAMs treat
  // it as hostile, same as a real attack) and falls back to the human player
  // if no such bot exists — letting srcTile/dstTile be any two tiles at all (own
  // territory included) is what makes this useful for testing SAM defenses
  // without waiting on a bot to build a Silo and choose to strike.
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
      duration: Math.max(0.3, dist / this.NUKE_SPEED[nukeType]),
      targetedBySAM: false
    });
    this.maybeBreakNukeAlliances(ownerId, nukeType, dstTile);
    return true;
  },

  // The "radiating" blast footprint: a solid disc out to the inner radius,
  // then an edge that wanders between inner and outer by bearing — three
  // low-frequency harmonics with random phases — so the crater is irregular
  // but always one solid blob. OpenFront's per-tile coin flip in that band
  // (rand.chance(2)) was ported here first, and it peppered the rim with
  // survivors and one-tile fallout holes: cleaning up after a hit meant
  // tapping them one at a time. The band still averages half its width, so
  // the total area lands where the coin flip's did. Draws a fixed three
  // rng() values per blast, so lockstep clients stay in step.
  nukeBlastTiles(dst, magnitude) {
    const inner2 = magnitude.inner * magnitude.inner;
    const w = GameMap.width, h = GameMap.height;
    const cx = dst % w, cy = (dst / w) | 0;
    const band = magnitude.outer - magnitude.inner;
    const phase = [this.rng() * 2 * Math.PI, this.rng() * 2 * Math.PI, this.rng() * 2 * Math.PI];
    const reach = Math.ceil(magnitude.outer);
    const result = new Set();
    for (let y = Math.max(0, cy - reach); y <= Math.min(h - 1, cy + reach); y++) {
      for (let x = Math.max(0, cx - reach); x <= Math.min(w - 1, cx + reach); x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > inner2) {
          const a = Math.atan2(dy, dx);
          const s = 0.5 + 0.5 * (Math.sin(2 * a + phase[0]) * 0.5 + Math.sin(3 * a + phase[1]) * 0.3 + Math.sin(5 * a + phase[2]) * 0.2);
          const r = magnitude.inner + band * s;
          if (d2 > r * r) continue;
        }
        result.add(y * w + x);
      }
    }
    return result;
  },

  // Ported against NukeExecution.detonate(). Order matters: buildings are
  // destroyed FIRST, reading ownership straight off GameMap.owner before
  // anything below overwrites it; then tiles are unclaimed and irradiated —
  // the "radiating land" the user asked for, which turned out to mean
  // OpenFront's real fallout mechanic, not a literal water crater: the land
  // survives, unowned, and stays fully capturable — just brutally expensive
  // to retake until someone actually does (see falloutDefenseModifier); then
  // troop losses are applied using the POST-irradiation tile counts
  // (tilesBeforeNuke = numTilesOwned() + numImpactedTiles, verbatim their
  // own detonate()); then finally anything afloat within the full outer-
  // radius circle sinks — a stricter, luck-free circle than the
  // probabilistic "radiating" land-destroy shape above, matching how the
  // real source's separate mg.units() sweep uses a flat
  // euclideanDistSquared test with no rand.chance involved, and how a
  // structure can therefore be destroyed by this circle even on a tile the
  // land-destroy coin flip happened to spare.
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
      }
      this.buildings.delete(tile);
    }

    // 2. Unclaim + irradiate the "radiating" land-destroy set. Real
    // GameImpl.queueWaterConversion only actually turns land to water under
    // a `waterNukes` ruleset toggle this game doesn't model — its default
    // (and this port's) behavior is `setFallout(tile, true)` instead: the
    // land itself survives, unowned and radioactive, still fully capturable
    // — just at falloutDefenseModifier's steep troop/speed multiplier (see
    // tileCost/stepAttack) until someone actually resettles it, which
    // GameImpl's own conquer() clears instantly (ported in setOwner above).
    const toDestroy = this.nukeBlastTiles(dst, magnitude);
    const tilesPerPlayer = new Map();
    for (const tile of toDestroy) {
      const owner = GameMap.owner[tile];
      if (owner >= 0) {
        tilesPerPlayer.set(owner, (tilesPerPlayer.get(owner) || 0) + 1);
        // Routed through setOwner rather than writing GameMap.owner directly:
        // relinquishing a tile also moves border status for that tile AND its
        // four neighbours, and setOwner is the only thing that keeps
        // Player.borderTiles in step (see updateBorderTile). A raw write left
        // every still-owned tile ringing the crater marked interior, so
        // refreshFrontier — which scans borderTiles alone — found no frontier
        // against the fresh NEUTRAL ground and launchAttack refused outright:
        // a crater blown inside your own territory was simply un-retakable.
        // setOwner does NOT clear fallout on a revert-to-NEUTRAL (only a real
        // capture decontaminates), so the irradiation added just below stands.
        // Buildings in the blast are already gone from step 1, so its capture
        // branch has nothing left to find here.
        this.setOwner(tile, NEUTRAL);
      }
      // Fallout applies to every LAND tile in the blast, owned or not —
      // verbatim queueWaterConversion's own mg.isLand(tile) guard, which has
      // no ownership condition. `owner !== WATER` is this game's isLand
      // check (already-relinquished-to-NEUTRAL tiles above still count).
      if (owner !== WATER) this.fallout.add(tile);
      this.dirtyTiles.add(tile);
    }

    // 3. Diminishing troop losses — the player's home reserve, their
    // outgoing attacks, and their in-transit invasion boats all take the
    // same per-tile nukeDeathFactor hit, each reading/writing live so the
    // loss compounds exactly like the real per-tile loop does.
    for (const [ownerId, numImpactedTiles] of tilesPerPlayer) {
      const p = this.players[ownerId];
      let tilesLeft = p.tiles.size + numImpactedTiles;
      for (let i = 0; i < numImpactedTiles; i++) {
        p.troops = Math.max(0, p.troops - this.nukeDeathFactor(p.troops, tilesLeft));
        for (const a of this.attacks) {
          if (a.attacker !== ownerId) continue;
          a.troops = Math.max(0, a.troops - this.nukeDeathFactor(a.troops, tilesLeft));
        }
        for (const bt of this.boats) {
          if (bt.attacker !== ownerId) continue;
          bt.troops = Math.max(0, bt.troops - this.nukeDeathFactor(bt.troops, tilesLeft));
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

  // Advances every in-flight nuke (straight-line, see launchNuke) and
  // detonates it once its travel duration elapses. A nuke intercepted by a
  // SAM this same tick never reaches here at all — stepSamMissiles (called
  // first, see Game.tick) already spliced it out of this.nukes — so this
  // still needs no interception check of its own; every nuke still in the
  // array by the time this runs is one that got through. Also prunes spent
  // shockwave effects, the only other thing this system leaves lying around.
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

});
