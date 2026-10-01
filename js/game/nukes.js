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
  // Ported against OpenFront's real MissileSiloExecution/NukeExecution/
  // Config.ts source (github.com/openfrontio/OpenFrontIO), not guessed — see
  // feedback-openfront-source-porting memory for the fetch approach. Scoped
  // down from the real source the same way every other structure in this
  // file has been (see the UNITS/Warship section comments above), per an
  // explicit user scoping decision this session: only Missile Silo, Atom
  // Bomb, and Hydrogen Bomb are ported here. SAM Launcher (the defensive
  // interceptor) was deferred at the time this comment was first written but
  // has since been added — see the "SAM Launcher & Interceptors" section
  // below, right after stepNukes. MIRV (the multi-warhead mega-nuke, ticket
  // #28) has since been added too — see the "MIRV" section at the very end
  // of this file. Alliance-breaking
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
  // RANGE's own comment making the identical point). mirvwarhead is
  // Config.ts's own MIRVWarhead entry (what an individual MIRV submunition
  // does on impact) — the MIRV "mothership" missile itself has no blast of
  // its own; see the "MIRV" section's own comment on why it never detonates
  // directly.
  NUKE_MAGNITUDES: {
    atombomb: { inner: 12, outer: 30 },
    hydrogenbomb: { inner: 80, outer: 100 },
    mirvwarhead: { inner: 12, outer: 18 }
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
  // mirv/mirvwarhead: Config.ts's real nukeSpeed() returns 15/22 respectively
  // (against AtomBomb/HydrogenBomb's own 10) — kept at the same 4.5x slowdown
  // ratio NUKE_SPEED's atombomb/hydrogenbomb entries already apply for
  // on-screen visibility (45 = 10*4.5), so a MIRV and its warheads read as
  // faster than an ordinary nuke, exactly as they're relatively faster in
  // the real source, without reintroducing the "near-instant" raw
  // TICKS_PER_SEC-scaled speed that comment says was deliberately avoided.
  NUKE_SPEED: { atombomb: 45, hydrogenbomb: 45, mirv: 68, mirvwarhead: 99 },
  // Config.ts's SiloCooldown(): 90 ticks, converted through TICKS_PER_SEC.
  SILO_COOLDOWN: 9,
  // No OpenFront equivalent — purely how long the render-only shockwave
  // effect (see detonateNuke's push to nukeBlasts) stays on screen.
  NUKE_BLAST_FX_DURATION: 1.2,

  // Config.ts's nukeDeathFactor, now WITH the MIRVWarhead branch (ticket #28
  // follow-up — this was dropped in the first MIRV pass; see the "MIRV"
  // section's own comment on why every simplification from that pass is
  // gone now). AtomBomb/HydrogenBomb branch: flat 5x the target's current
  // troops, divided by however many owned tiles they have left. Called once
  // per impacted tile in detonateNuke's loop, with `humans`/`tilesLeft`
  // shrinking each iteration, so the same nuke hurts more per-tile against a
  // nation that's already small than one that's still large — verbatim
  // their own diminishing-effect loop. MIRVWarhead gets an entirely
  // different curve, verbatim: rather than caring how much land is left, it
  // cares how far the target's troops sit ABOVE 3% of their own maxTroops
  // cap (targetTroops) — a nation sitting near or below that floor takes
  // almost nothing per warhead, one sitting well above it (hoarding troops
  // instead of spending them) takes up to scalingFactor=500 per warhead,
  // ramping in via `1 - e^(-2x)` so it saturates rather than diverging.
  // `maxTroops` is threaded through from detonateNuke (computed once per
  // player, matching their own `config.maxTroops(player)` call outside the
  // per-tile loop) for every nuke type even though only mirvwarhead reads
  // it, so this one function stays the single source of truth for both
  // curves rather than splitting the branch across caller and callee.
  nukeDeathFactor(nukeType, humans, tilesLeft, maxTroops) {
    if (nukeType !== 'mirvwarhead') return (5 * humans) / Math.max(1, tilesLeft);
    const targetTroops = 0.03 * maxTroops;
    const excessTroops = Math.max(0, humans - targetTroops);
    const scalingFactor = 500, steepness = 2;
    const normalizedExcess = excessTroops / Math.max(1, maxTroops);
    return scalingFactor * (1 - Math.exp(-steepness * normalizedExcess));
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

  // Ported against NukeExecution.maybeBreakAlliances/Util.ts's
  // listNukeBreakAlliance. Real OpenFront runs this the INSTANT a nuke is
  // launched — NukeExecution.tick's nuke===null branch calls it right after
  // building the missile unit, not on impact — so the diplomatic fallout is
  // committed by the trajectory alone, even for a nuke a SAM shoots down
  // seconds later. Ported at the same point here: launchNuke/debugNuke
  // below, not detonateNuke. Only applies to atombomb/hydrogenbomb — a MIRV
  // uses its own, unconditional maybeBreakMirvAlliance (see the "MIRV"
  // section at the end of this file) rather than this weighted scan, and an
  // individual mirvwarhead never calls this function at all: real
  // SAMLauncherExecution.ts explicitly excludes MIRVWarhead from alliance-
  // breaking ("MIRV warheads shouldn't break alliances" — the MIRV's own
  // launch already paid that cost once for the whole strike), and
  // mirvwarhead entries are synthesized directly by spawnMirvWarheads rather than
  // passed through launchNuke/debugNuke, so they never reach this function
  // to begin with.
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
      duration: Math.max(0.3, dist / this.NUKE_SPEED[nukeType])
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
        // Fog of war: a nuke hit tells the victim who launched it.
        if (this.fog) this.markMet(owner, nuke.ownerId);
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
    // loss compounds exactly like the real per-tile loop does. maxTroops is
    // computed once per player (matching real detonate()'s own
    // config.maxTroops(player) call outside this loop) and threaded through
    // even for atombomb/hydrogenbomb, whose branch of nukeDeathFactor simply
    // ignores it — see that function's own comment.
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
  // SAM this same tick never reaches here at all — stepSAMs (called
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

  // --- MIRV (ticket #28) ----------------------------------------------------
  // Ported against OpenFront's real MIRVExecution.ts/NukeExecution.ts/
  // Config.ts source (github.com/openfrontio/OpenFrontIO), verbatim this
  // time — an earlier pass here scoped down the warhead count, the mid-air
  // separation point, the staggered target-generation pass, the per-warhead
  // spawn delay, and MIRVWarhead's own death-factor curve; a producer
  // follow-up asked for all five back, 1:1, and this section is that
  // rewrite. Every one of those five is now ported:
  //   - MIRV_WARHEAD_COUNT is the real 350, not a scaled-down count.
  //   - The mothership flies Silo -> a real mid-air separation point (see
  //     that constant's own comment for the exact formula), not straight to
  //     the clicked tile; warheads fan out from THAT point, not from the
  //     target itself.
  //   - Targets are generated in a staggered pass across real ticks 20
  //     through 11 before the mothership reaches the separation point, then
  //     re-validated/topped-up/sorted in one real finalize pass at tick 10 —
  //     see stepMirvs.
  //   - Each warhead gets its own Game.rng()-drawn wait (0-15 ticks) on top
  //     of the shared base wait, plus an index-bucketed speed offset, so
  //     they don't all launch and arrive in lockstep — see
  //     spawnMirvWarheads.
  //   - nukeDeathFactor (above) now branches on nukeType exactly like
  //     Config.ts's real one.
  //
  // What's still NOT ported, deliberately, and why: real OpenFront gives the
  // mothership and every warhead their own cubic-Bezier "parabola" flight
  // (PathFinder.Parabola.ts's getParabolaControlPoints/
  // DistanceBasedBezierCurve — control points offset vertically by
  // max(distance/3, 50) tiles, walked one curve-length-increment per tick)
  // plus a whole deterministic-speed-normalization pass
  // (calculateDeterministicSpeed) that stretches/compresses a MIRV's own
  // flight to land near mirvNormalizeTargetTicks=14 ticks regardless of map
  // distance. This game's nukes have never had any of that — launchNuke's
  // own class comment describes every nuke here (Atom/Hydrogen Bomb
  // included) as a fixed from/to pair walked by elapsed-time lerp with a
  // cheap sine-shaped vertical offset for the arc "look" (see render.js's
  // drawNukes/drawMirvs), not a real curve-fitting pathfinder, and porting
  // one in just for MIRV would make it the only nuke type in the file that
  // moves on a fundamentally different system from its own mothership-to-
  // warhead cousins. Per the producer's own instruction ("if this game's
  // other nukes fly straight lines, keep MIRV consistent... explain what you
  // did"): MIRV keeps that same straight-line-plus-arc convention for BOTH
  // legs (Silo->separation, separation->each warhead's own target) — what's
  // real now is the GEOMETRY those two legs actually connect (the real
  // separation-point formula, the real per-warhead target set, the real
  // staggered generation/finalize timing, the real per-warhead delay/speed
  // jitter), not the literal curve shape each leg is drawn with. drawMirvs'
  // own arc-height formula is tuned to `max(distance/3, 50)` — the real
  // source's own control-point height — specifically to close that visual
  // gap without needing the underlying Bezier math.
  //
  // Also not ported: the real source's silo-launch-queue stagger inside
  // NukeExecution.tick (multiple stacked purchases from ONE silo trail each
  // other by a tick each). This game's SILO_COOLDOWN already forbids a
  // second launch from the same Silo before the first one's cooldown clears
  // — the scenario that stagger exists to fix (two nukes leaving the same
  // silo the same tick) cannot happen here at all, MIRV included, so there
  // is nothing for it to fix.
  MIRV_WARHEAD_COUNT: 350,
  // Config.ts's MirvExecution.range/minimumSpread, verbatim tile counts — no
  // rescaling, same reasoning as every other MAGNITUDES/RANGE constant in
  // this file. `range` is how far from the AIM tile a warhead target may
  // land; `minimumSpread` is the minimum Manhattan distance kept between any
  // two chosen warhead targets, so they don't all pile onto the same few
  // tiles.
  MIRV_RANGE: 1500,
  MIRV_MIN_SPREAD: 55,
  // MirvExecution's own tick windows, in real ticks (this game's TICK_DT
  // already matches OpenFront's own tick rate — see SILO_COOLDOWN's "90
  // ticks / TICKS_PER_SEC" comment making the identical point — so these
  // need no rescaling either): staggered target pre-generation runs while
  // the mothership has MORE than MIRV_FINALIZE_TICKS but AT MOST
  // MIRV_STAGE_TICKS ticks left before it reaches the separation point;
  // finalize (re-validate/top-up/sort/spawn) fires once, the first tick it
  // has AT MOST MIRV_FINALIZE_TICKS left. See stepMirvs.
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
  // spawnWarheadsWithWait's own per-warhead jitter: `random.nextInt(0, 15)`
  // added on top of the shared waitBase — PseudoRandom.nextInt's own bounds
  // aren't in scope of what was fetched for this port, so this assumes the
  // common "inclusive of both ends" reading (16 possible values, 0..15);
  // Game.rng() is this game's only source of randomness either way, so the
  // exact bound convention has no effect on determinism, only on the exact
  // visual spread of arrival times.
  MIRV_WAIT_JITTER_TICKS: 16,
  // spawnWarheadsWithWait's own 5-bucket speed ramp (i<70:+0, <140:+1,
  // <210:+2, <280:+3, else:+4 — exactly MIRV_WARHEAD_COUNT/5 per bucket at
  // the real 350 count) added to NUKE_SPEED.mirvwarhead per warhead, index
  // is the warhead's position in the finalized (descending-distance-sorted)
  // target list. Real source adds the raw offset (0-4) directly to their
  // own nukeSpeed(MIRVWarhead)=22; scaled by the same 4.5x factor
  // NUKE_SPEED's own comment already applies everywhere else in this file
  // (99/22 = 4.5), so the ramp's relative shape survives the slowdown
  // intact.
  MIRV_WARHEAD_SPEED_STEP: 4.5,
  // Config.ts's UnitType.MIRV cost: 25_000_000 + 15_000_000 per MIRV any
  // player has EVER launched this match (game.mirvsLaunched(), a whole-match
  // counter — see mirvsLaunched in core.js's Game.init) — deliberately NOT
  // the per-owner unitsOwned/unitsBuilt curve every other UNITS entry uses,
  // so it gets its own special case in Game.unitCost rather than living as
  // ordinary UNITS fields. See unitCost's own comment.
  MIRV_BASE_COST: 25000000,
  MIRV_COST_STEP: 15000000,

  // Same "click anywhere, launch from the nearest ready Silo" resolution as
  // an Atom/Hydrogen Bomb — resolveNukeLaunch/nukeBlockReason/canLaunchNuke
  // above are already fully generic over nukeType (Silo ownership/cooldown,
  // gold via unitCost), so 'mirv' rides them unmodified; nothing here
  // duplicates that logic (teamNukeBlockReason in teams.js already refuses a
  // teammate's tile before this is ever called). What IS new versus the
  // first MIRV pass: the real mid-air separation-point geometry
  // (MIRVExecution.tick's own formula, verbatim) and the staged-target
  // bookkeeping stepMirvs drives every tick from here on.
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

    // MIRVExecution.tick's own separation-point formula, verbatim: `x =
    // floor((baseX + spawnX) / 2)` — horizontally the midpoint between the
    // launching Silo and the aim tile — and `y = max(0, baseY - 500) + 50`
    // — vertically a near-fixed high-altitude apex derived from the AIM
    // tile's own row alone (not the Silo's), clamped to never go above the
    // map's top edge. On this game's map heights (250-1000 rows) that
    // second term is 50 for almost every strike — the mothership climbs to
    // just south of the top edge no matter where it's launched from or at,
    // then dives — matching the real source's own "climbs way up, then
    // rains down" silhouette on maps of this scale. Clamped to h-1 on the
    // low end too, defensively, for any custom map under 50 rows tall.
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
      // Snapshot of who owns the aim tile at launch — MirvExecution's own
      // `this.targetPlayer = this.mg.owner(this.dst)`, read once in init()
      // and reused by every later generation/finalize pass rather than
      // re-read live (finalizeMirvTargets re-validates individual STAGED
      // TILES against this captured value, exactly like the real source's
      // own re-check — a tile that changed hands mid-flight drops out).
      targetOwner: GameMap.owner[clickTile],
      from: siloXY, to: { x: sepX, y: sepY },
      born: this.elapsed, duration,
      bornTick: this.ticks, durationTicks,
      // MirvExecution's own `stagedTargets = [this.dst]` seed — the aim
      // tile is always the first staged target, guaranteeing at least one
      // warhead lands exactly where the player clicked even if nothing else
      // nearby ever validates. _grid is mirvTargetOverlaps' own spatial hash
      // (see its own comment) — seeded with the aim point too, so a
      // generated target can't land right on top of it either.
      stagedTargets: [clickTile], _xs: [aimXY.x], _ys: [aimXY.y],
      _grid: new Map([[this.mirvGridCell(aimXY.x, aimXY.y), [aimXY.x, aimXY.y]]]),
      finalized: false
    });
    this.maybeBreakMirvAlliance(playerId, clickTile);
    return true;
  },

  // MirvExecution.tick's own launch-moment betrayal check, translated off
  // this game's relation/alliance primitives — and, unlike the first MIRV
  // pass, now the real UNCONDITIONAL-mutual version rather than
  // maybeBreakNukeAlliances' own one-directional convention: real OpenFront
  // applies updateRelation(-100) on BOTH sides whenever the aim tile has an
  // owner other than the launcher, every single time, regardless of whether
  // an alliance existed to break — on top of (not instead of) breakAlliance
  // itself, which (in this game, same as upstream) applies its own further
  // -100 to the betrayed side. A MIRV fired at a still-allied nation
  // therefore takes that ally's opinion down by 200 total (100 from
  // breakAlliance, 100 from this function's own explicit hit) — that
  // double count is a faithful port of the real source's own layering, not
  // a bug: MirvExecution calls updateRelation itself in addition to, not
  // instead of, Player.breakAlliance's own internal penalty.
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

  // MirvExecution.tryGenerateTarget/isOverlapping, ported as a single
  // bounded search for ONE valid target — the caller (stageMirvTargets /
  // finalizeMirvTargets) is what supplies the OUTER retry loop, exactly
  // matching the real source's own split between the two. Draws Game.rng()
  // twice per attempt (x, then y) — the real source derives its second draw
  // algebraically from the first for their own PRNG's reasons; two
  // independent mulberry32 draws serve the same purpose here and stay
  // exactly as deterministic. Returns -1 on total failure (all
  // MIRV_TARGET_ATTEMPTS attempts invalid), matching `return undefined`.
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

  // Spatial-hash stand-in for tryGenerateTarget's own O(n) isOverlapping
  // scan — same MIN_SPREAD Manhattan-distance decision, just cheap at 350
  // targets. Every staged point is bucketed into a MIRV_MIN_SPREAD-sized
  // grid cell (m._grid); a Manhattan distance under one cell's own side
  // length can never cross two cell boundaries in the same axis, so any
  // point within minSpread of (x,y) is guaranteed to land in (x,y)'s own
  // cell or one of its 8 neighbours — only those 9 buckets ever need
  // scanning, instead of every point staged so far. Pure performance, same
  // accept/reject result as the O(n) scan for every possible input. (In the
  // browser, a whole MIRV's finalize pass measured ~2.4ms on the 2000x1000
  // World map; the node harness reads far slower because vm-context global
  // lookups like Math are slow there.)
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

  // MirvExecution.tick's own staggered pre-generation loop, run once per
  // tick while remainingTicks is inside (MIRV_FINALIZE_TICKS,
  // MIRV_STAGE_TICKS] — see stepMirvs. Up to MIRV_STAGE_ATTEMPTS_PER_TICK
  // calls to tryGenerateMirvTarget, stopping early once MIRV_WARHEAD_COUNT
  // is reached (real source's own `if (stagedTargets.length >= warheadCount)
  // break`).
  stageMirvTargets(m) {
    for (let attempt = 0; attempt < this.MIRV_STAGE_ATTEMPTS_PER_TICK && m.stagedTargets.length < this.MIRV_WARHEAD_COUNT; attempt++) {
      const tile = this.tryGenerateMirvTarget(m);
      if (tile >= 0) this.pushMirvTarget(m, tile);
    }
  },

  // MirvExecution.finalizeDestinations, ported verbatim: re-validate every
  // staged tile against the OWNERSHIP SNAPSHOT taken at launch (m.dst
  // itself always survives — it's exempt from the ownership check, same as
  // the real `tile === this.dst ||` short-circuit), top up with
  // `additionalAttempts` more tryGenerateMirvTarget calls, then sort
  // descending by Manhattan distance from the aim tile (farthest first) —
  // spawnMirvWarheads' own index-bucketed speed ramp depends on that order.
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

  // MirvExecution.spawnWarheadsWithWait, ported verbatim: every finalized
  // target becomes one ordinary this.nukes entry (nukeType 'mirvwarhead'),
  // launched from the real separation point (m.to — see launchMirv's own
  // comment on that formula), each with its own Game.rng()-drawn wait ON
  // TOP of the shared waitBase (remaining ticks until the mothership itself
  // reaches the separation point) and its own index-bucketed speed offset —
  // see MIRV_WARHEAD_SPEED_STEP's own comment. `born` is set to the FUTURE
  // tick the warhead actually starts moving (this.elapsed + total wait), not
  // now — render.js's drawNukes/drawMirvs and sam.js's stepSAMs both already
  // clamp their own (elapsed-born)/duration fraction to >=0 (sam.js always
  // did; render.js's own clamp was added alongside this rewrite — see its
  // own comment), so a warhead with a still-future born simply renders and
  // sits at its launch point (interceptable there, matching the real
  // source: the unit exists in the world for the whole wait, it just never
  // moves) until its own born tick arrives, then flies exactly like any
  // other nuke. Every warhead is pushed into this.nukes in stagedTargets'
  // own (already-sorted) order — stable iteration order, no Set/Map
  // involved, so every client resolves the exact same array.
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

  // Advances every in-flight MIRV mothership — the MIRV equivalent of
  // stepNukes, kept separate rather than folded into it because a MIRV
  // doesn't detonate the way an Atom/Hydrogen Bomb does; it stages targets,
  // finalizes/spawns warheads roughly a second before it actually arrives,
  // then simply disappears (MirvExecution.separate() — no blast of its
  // own). Runs before stepSAMs/stepNukes in Game.tick (see that call site's
  // own comment) so a warhead spawned this tick is immediately visible to
  // this same tick's SAM pass. this.mirvs is deliberately never scanned by
  // stepSAMs — real SAMLauncherExecution.ts's own targetable-unit list is
  // [AtomBomb, HydrogenBomb, MIRVWarhead], explicitly excluding UnitType.
  // MIRV itself, so the mothership missile is not interceptable; only what
  // it splits into is.
  //
  // remainingTicks is computed once per MIRV per tick from the integer
  // bornTick/durationTicks pair launchMirv stashed (not from the
  // seconds-based born/duration render.js/ui.js read) — see launchMirv's own
  // comment on why the countdown stays in exact integer ticks rather than
  // float seconds.
  stepMirvs() {
    for (let i = this.mirvs.length - 1; i >= 0; i--) {
      const m = this.mirvs[i];
      const remainingTicks = m.bornTick + m.durationTicks - this.ticks;

      if (remainingTicks <= this.MIRV_STAGE_TICKS && remainingTicks > this.MIRV_FINALIZE_TICKS) {
        this.stageMirvTargets(m);
      }
      if (remainingTicks <= this.MIRV_FINALIZE_TICKS && !m.finalized) {
        m.finalized = true;
        // The strike area can change hands mid-flight; this re-reads
        // CURRENT ownership (not the launch-time targetOwner snapshot every
        // other check in this function uses) — teamNukeBlockReason already
        // refused launching AT a teammate's tile, this is the same rule
        // applied to a tile that only BECAME a teammate's after launch, so
        // the strike fizzles (no warheads at all) rather than scattering
        // over an ally/teammate.
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
