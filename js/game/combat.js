// js/game/combat.js — Combat math, terrain & fallout.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  DEFENSE_WEIGHT: 1.6,
  DEFENDER_LOSS: 0.55,

  // What being marked a traitor costs, from OpenFront's config:
  // traitorDefenseDebuff 0.5, traitorSpeedDebuff 0.8.
  //
  // Note where these land. Neither touches a defence stat — both are applied to
  // the ATTACKER's side of the ledger, so a traitor is cheaper and quicker to
  // carve up. And they apply to every attacker on the map, not only the nation
  // that was betrayed: the whole world smells blood.
  TRAITOR_DEFENSE_DEBUFF: 0.5,
  TRAITOR_SPEED_DEBUFF: 0.8,

  // There is deliberately no penalty on the attacker's own size here. One
  // existed while conquest cost rose without limit against a stronger defender;
  // with OpenFront's clamped cost it became a second tax on scale on top of the
  // growth curve's own, and swept measurably worse — 5 of 8 matches resolving
  // against 8 of 8 without it, and slower. Anti-snowball now comes entirely
  // from the population curve refilling large empires more slowly.

  // --- How fast a front advances -------------------------------------------
  // Re-ported 2026-09-10 against OpenFront's LIVE attackLogic/AttackExecution
  // (github.com/openfrontio/OpenFrontIO, fetched fresh rather than trusting
  // the version this file was originally ported against) after a user report
  // — backed by a side-by-side recording of real openfront.io — that pushes
  // here read "too fast and chunky" next to theirs. TERRAIN_MAG/TERRAIN_SPEED
  // below already matched; everything downstream of them had drifted: their
  // budget/cost shape has been rewritten since the original port and no
  // longer resembles what the old comments here described (an independent
  // border-scaled budget alongside a separately-clamped per-tile ratio, plus
  // two ATTACK_RATE_SCALE/NEUTRAL_RATE_SCALE fudge factors invented
  // specifically because those stale constants, taken literally, resolved a
  // push in under a second).
  //
  // Real AttackExecution.tick() gives every attack a flat budget of exactly
  // ATTACK_TICK_BUDGET (1) per tick — NOT proportional to border width, no
  // fudge factor — and spends it tile by tile against attackTickFraction
  // (their attackLogic's `tickFraction`), which folds terrain, the troop-
  // ratio speed ramp, AND border width into one number. Border width only
  // ever appears once, as that function's own divisor — a wide front and a
  // narrow one obey the same rule instead of two independently-tuned ones
  // that can drift apart, which is what let a big overmatched push here dump
  // dozens of tiles in a single 100ms tick (one generous budget, then a
  // second generous per-tile discount, compounding) instead of the steadier
  // per-tick trickle real OpenFront shows even at full commitment.
  //
  // Any budget left over after the last affordable tile is simply discarded,
  // exactly as their `tickBudget` is a fresh local reset to 1 every tick
  // rather than a persisted field — see stepAttack, which no longer carries
  // `a.progress` across ticks for this reason.
  ATTACK_TICK_BUDGET: 1,

  // Terra nullius' own cost/speed constants (Config.ts's TERRA_NULLIUS_*):
  // attackTickFraction's unclaimed-land branch is `within(COST_SCALE*tileCost
  // /attackTroops, MIN, MAX) / (borderSize*2)` — inversely proportional to
  // the committed force, so a big grab swallows open ground fast while a
  // token nibble stays slow. This game's troop-cost side for the same branch
  // (tileCost()'s `if (!defender) return ...`) was already correct; only the
  // speed side was missing a real formula, previously papered over by the
  // flat NEUTRAL_RATE_SCALE knob this replaces.
  TERRA_NULLIUS_COST_SCALE: 2000,
  TERRA_NULLIUS_MIN_COST: 5,
  TERRA_NULLIUS_MAX_COST: 100,

  // Config.ts's SPEED_COST_DIVISOR and ATTACKER_LOSS_BASE/PER_DENSITY: the
  // troop-ratio speed ramp (attackTickFraction) and the troop-loss formula
  // (tileCost) below.
  SPEED_COST_DIVISOR: 7.77,
  ATTACKER_LOSS_BASE: 0.463,
  ATTACKER_LOSS_PER_DENSITY: 0.0039,

  // Config.ts's BOT_DEFENDER_LOSS_MULT: replaces this file's old, narrower
  // "attacker.isHuman && defender.isTribe -> mag *= 0.8" in tileCost. The
  // real discount is 0.7x (not 0.8x) and fires for ANY attacker fighting a
  // Bot-type defender, human or Nation alike. Every attacker in this game is
  // Human or Nation (Tribes never attack), so in practice this now just
  // means: any attack on a Tribe gets the discount, full stop.
  BOT_DEFENDER_LOSS_MULT: 0.7,

  // --- Large-player rebalancing ---------------------------------------------
  // Re-ported alongside the above: real OpenFront collapsed the old separate
  // largeDefenderMultiplier (sigmoid on raw tile count, applied to both
  // tileCost and speed) and largeAttackerLossMult/largeAttackerSpeedMult (two
  // different pow() exponents, 0.7 troop cost / 0.6 speed, only past a flat
  // 100k-tile cliff) into ONE function, largeTerritoryBonus: a logistic in
  // log(tiles) — smooth from the smallest nation instead of flat-then-cliff —
  // shared verbatim by both the troop-cost and speed formulas, for both
  // attacker and defender, differing only in `depth` (how far it can pull the
  // multiplier down: 0.7 for an attacker's edge, 0.3 for a defender's
  // debuff). Same real-world motivation as before (their "Update attack meta"
  // PR: large defenders get weaker, not large attackers stronger, so the late
  // game doesn't crawl) — just a cleaner shared curve, and one no longer
  // gated behind a 100k/150k-tile threshold that our old small/medium maps
  // could never reach.
  LARGE_TERRITORY_MIDPOINT: 300000,
  LARGE_TERRITORY_STEEPNESS: 2.5,
  LARGE_ATTACKER_DEPTH: 0.7,
  LARGE_DEFENDER_DEPTH: 0.3,

  // Hard-only: as the field thins toward a final showdown, ease off the
  // attacker's anti-snowball brake so a dominant nation can actually close
  // the game out instead of grinding down a hopeless straggler for minutes —
  // real OpenFront has no equivalent because its matches are 8+ humans who
  // self-regulate; ours can end up 2M pop vs. 50k with nobody left to check
  // it, and the same brake that stops early snowballing has no job left to
  // do at that point. Easy/Medium keep the flat brake throughout: closing
  // out fast is a "play like a sharp human" trait, not a default AI one.
  // Threshold picked to already be partway eased at "5 nations left" (this
  // game's own worked example), fully off by the literal final 1v1.
  LATE_GAME_NATION_THRESHOLD: 6,
  LATE_GAME_MIN_NATIONS: 2,

  sigmoid(value, decayRate, midpoint) {
    return 1 / (1 + this.det.exp(-decayRate * (value - midpoint)));
  },

  // Effective LARGE_ATTACKER_DEPTH for this moment: unchanged outside Hard,
  // and unchanged above LATE_GAME_NATION_THRESHOLD nations alive; linearly
  // eases to 0 (no large-attacker penalty at all) as the alive count falls
  // to LATE_GAME_MIN_NATIONS. nationCount/placements are both replicated sim
  // state (see core.js), so this stays identical across clients.
  lateGameAttackerDepth() {
    if (Game.difficulty !== 'hard') return this.LARGE_ATTACKER_DEPTH;
    const alive = Game.nationCount - Game.placements.size;
    const span = this.LATE_GAME_NATION_THRESHOLD - this.LATE_GAME_MIN_NATIONS;
    const t = Math.min(1, Math.max(0, (alive - this.LATE_GAME_MIN_NATIONS) / span));
    return this.LARGE_ATTACKER_DEPTH * t;
  },

  // 1.0 for a nation well under LARGE_TERRITORY_MIDPOINT tiles, easing down
  // to `1 - depth` for a huge one, halfway there at the midpoint — log-scaled,
  // so the curve cares about tile-count RATIOS (doubling from 1k to 2k tiles
  // moves it as much as doubling from 300k to 600k) rather than an absolute
  // tile gap dominating everywhere. Guards `numTiles` at 1 rather than 0 only
  // for det.log's sake (log(0) is -Infinity) — every live attacker or
  // defender this is called on already owns at least one tile.
  largeTerritoryBonus(numTiles, depth) {
    return 1 - depth * this.sigmoid(this.det.log(Math.max(1, numTiles)),
      this.LARGE_TERRITORY_STEEPNESS, this.det.log(this.LARGE_TERRITORY_MIDPOINT));
  },

  // Per-tile speed cost as a fraction of ATTACK_TICK_BUDGET — OpenFront's own
  // attackLogic `tickFraction`. `attackTroops`/`defender` are read live by
  // the caller (stepAttack), exactly as OpenFront recomputes troopCount and
  // defender.troops() fresh every iteration rather than once per tick.
  // `tile` is optional; pass it from stepAttack to enable the fort/fallout
  // bonuses (same contract tileCost's own `tile` argument has).
  attackTickFraction(attacker, defender, attackTroops, terrain, tile, borderSize) {
    let tileSpeed = this.TERRAIN_SPEED[terrain || 0];
    // Fallout: falloutSpeedMult, not the flat falloutDefenseModifier tileCost's
    // troop-cost side still uses — see that function's own comment. Applies to
    // both branches below, matching how this was already called before this
    // re-port.
    if (tile !== undefined && this.fallout.has(tile)) tileSpeed *= this.falloutSpeedMult(attackTroops);

    if (!defender) {
      // TERRA_NULLIUS_COST_SCALE (2000) is one of OpenFront's own absolute
      // constants, calibrated against THEIR raw troop counts — but
      // `attackTroops` here is already POP_SCALE-shrunk (this game stores
      // troops at 1/10th OpenFront's internal scale so the HUD reads the same
      // numbers their UI does; see POP_SCALE's own comment). Dividing an
      // unscaled 2000 by a 10x-too-small attackTroops silently inflated `raw`
      // ~10x, pinning most early pushes near TERRA_NULLIUS_MAX_COST (the
      // SLOWEST tier) instead of scaling down as troops committed grew — the
      // actual cause of "initial pushes after spawn" reading way too slow
      // once this branch was re-ported. Un-shrinking attackTroops back to
      // OpenFront's own scale before the division is the fix; nothing else
      // in this function reads an absolute troop count (troopRatio below is
      // a ratio of two already-shrunk numbers, so POP_SCALE cancels there —
      // this branch was the only one actually affected).
      const raw = Math.min(this.TERRA_NULLIUS_MAX_COST, Math.max(this.TERRA_NULLIUS_MIN_COST,
        this.TERRA_NULLIUS_COST_SCALE * tileSpeed / Math.max(1, attackTroops / this.POP_SCALE)));
      return raw / (borderSize * 2);
    }

    // Defense fort: movement cost into protected tiles is 3x, matching
    // Config.defensePostSpeedBonus in OpenFront's attackLogic.
    if (tile !== undefined && this.fortInRange(tile, defender.id)) tileSpeed *= this.FORT_SPEED_MULT;

    const troopRatio = this.defenceStrength(defender, attacker.id) / Math.max(1, attackTroops);
    // Flat at its floor (1/SPEED_COST_DIVISOR) for any attack that has NOT
    // been outnumbered — real OpenFront's own intent: it exists to stall
    // hopeless attacks, not to reward blowouts. Only ramps up once the
    // defender is stronger: linearly to 7.5x by troopRatio=7.5, then a second
    // multiplier ramps a further 50x on top for a truly hopeless push
    // (troopRatio past 150).
    const speedCost = (Math.min(7.5, Math.max(1, troopRatio)) * Math.min(50, Math.max(1, troopRatio / 20)))
      / this.SPEED_COST_DIVISOR;
    const largeAtk = this.largeTerritoryBonus(attacker.tiles.size, this.lateGameAttackerDepth());
    const largeDef = this.largeTerritoryBonus(defender.tiles.size, this.LARGE_DEFENDER_DEPTH);
    const traitorMod = this.isTraitor(defender) ? this.TRAITOR_SPEED_DEBUFF : 1;
    return (speedCost * tileSpeed * largeAtk * largeDef * traitorMod) / borderSize;
  },

  // What a defender is worth against a particular attacker: the home reserve
  // plus anything already committed to a front facing them. Troops standing on
  // a front are still fighting that opponent, so an army thrown at someone must
  // get through it — reading the home reserve alone made a nation that had just
  // committed everything the cheapest possible target, however large the force
  // it held on the border. Troops committed elsewhere deliberately do not
  // count: over-extending on one front really does leave the others thin.
  defenceStrength(defender, attackerId) {
    let n = defender.troops;
    for (const a of this.attacks) {
      // A retreating counter-push has already pulled out of this fight.
      if (a.attacker === defender.id && a.target === attackerId && !a.retreating) n += a.troops;
    }
    return n;
  },

  // What the defender pays per tile lost, as a share of what the attacker
  // spent taking it — an engagement costs both sides.
  //
  // This was once keyed to the base cost instead, because scaling losses with
  // the defender's own multiplier made a populous nation bleed in proportion
  // to its size and collapse exponentially. That only bit when attacks
  // resolved instantly and the whole decay landed inside two seconds. Now that
  // a front takes half a minute to move, the same proportional attrition plays
  // out gradually and the defender can regrow, reinforce or counter while it
  // happens. Without it a defender simply out-regrows the damage and every
  // border sets into a permanent trench line.
  // OpenFront: defenderTroopLoss = defender.troops() / defender.numTilesOwned().
  // The defender sheds their own average garrison with each tile, so losing the
  // whole country costs them exactly their whole army — no more, no less.
  defenderLossPerTile(defender) {
    return defender.troops / Math.max(1, defender.tiles.size);
  },

  // Defense fort constants, ported from OpenFront's Config.ts:
  // defensePostRange=30, defensePostDefenseBonus=5, defensePostSpeedBonus=3.
  // A built fort within fortRange() tiles of a contested tile multiplies the
  // attacker's troop cost (FORT_DEF_MULT) and movement cost (FORT_SPEED_MULT).
  //
  // The two multipliers are theirs verbatim. The RANGE is not, and deliberately
  // so: 30 tiles is an absolute constant tuned against the only board OpenFront
  // actually plays on — their World map, 2000x1000 with 651,569 land tiles per
  // their own resources/maps/world/manifest.json (map4x and map16x in that same
  // manifest are downsampled render assets, not playable sizes). Every other
  // quantity in a fight scales with MAP_SIZES — nation area, army cap, the
  // length of the front — but a flat radius does not, so the protected disc's
  // share of the world exploded as the map shrank:
  //
  //   pi*30^2 = 2827 tiles      as % of land (LAND_FRACTION 0.40)
  //     small  12,500 land       22.6%
  //     medium 50,000 land        5.7%     <- default
  //     large  200,000 land       1.4%
  //     xlarge 800,000 land       0.35%
  //     OpenFront World           0.43%
  //
  // At medium that is 13x OpenFront's intended footprint, and the numbers stop
  // being a tax and start being a wall: a 3,000-tile nation at 70% of cap holds
  // ~24k troops, and committing all of it buys 3,354 tiles of open ground but
  // only 671 inside a fort aura — while clearing one full disc costs ~101k
  // troops against a cap of ~34k. Worse, that nation is only ~55 tiles across
  // and the disc is 60 wide, so there is no flank to go around; in OpenFront the
  // front is far longer than the aura and routing around a post is the answer.
  //
  // So hold their RELATIVE reach instead of their absolute one: 30 tiles on a
  // 2000-wide map is 1.5% of map width, which is what FORT_RANGE_BASE /
  // FORT_RANGE_REF_WIDTH encodes. xlarge lands on exactly 30 again, and the
  // smaller sizes get the aura OpenFront would have given them. FORT_RANGE_MIN
  // keeps small from collapsing to a 3.75-tile disc that a fort could not
  // meaningfully protect anything with.
  FORT_RANGE_BASE: 30,
  FORT_RANGE_REF_WIDTH: 2000,
  FORT_RANGE_MIN: 6,
  FORT_DEF_MULT: 5,
  FORT_SPEED_MULT: 3,

  // Ordered base*width/ref (not base*(width/ref)) so every MAP_SIZES width
  // lands on a value exact in binary floating point — 3.75 / 7.5 / 15 / 30,
  // squaring to 56.25 / 225 / 900 — which a lockstep sim needs, since this
  // feeds tileCost and stepAttack on every client.
  fortRange() {
    const r = this.FORT_RANGE_BASE * GameMap.width / this.FORT_RANGE_REF_WIDTH;
    return r < this.FORT_RANGE_MIN ? this.FORT_RANGE_MIN : r;
  },

  // True when a fully-built fort owned by `ownerId` is within fortRange()
  // tiles (Euclidean) of `tile`. Iterates all buildings — typically <100
  // total — so this is cheap relative to the per-tile attack loop cost.
  // `includePending` also counts a fort still under construction — the combat
  // hooks below never pass it (an unfinished fort grants no bonus yet), but
  // AI.fortSite does, so a bot doesn't queue a second fort a few tiles from
  // one it already started this same minute.
  fortInRange(tile, ownerId, includePending) {
    const w = GameMap.width, tx = tile % w, ty = (tile / w) | 0;
    const fr = this.fortRange(), r2 = fr * fr;
    for (const [bt, b] of this.buildings) {
      if (b.type !== 'fort' || (!b.built && !includePending)) continue;
      if (GameMap.owner[bt] !== ownerId) continue;
      const bx = bt % w, by = (bt / w) | 0;
      const dx = tx - bx, dy = ty - by;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  },

  // Terrain magnitude and speed, straight from OpenFront's attackLogic switch.
  // Indexed by PLAINS / HIGHLAND / MOUNTAIN. TERRAIN_SPEED feeds
  // attackTickFraction directly now (no separate plains-relative
  // terrainMoveCost helper — that abstraction belonged to the old
  // border-scaled budget this file no longer runs).
  TERRAIN_MAG: [80, 100, 120],
  TERRAIN_SPEED: [16.5, 20, 25],

  // Shape of the advancing edge, ported from OpenFront's actual
  // AttackExecution.addNeighbors rather than invented here:
  //
  //   priority = (rand(0,7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) + tickNow
  //
  // Three ideas, none of which the previous version had.
  //
  // 1. The priority is NOT cumulative. Ours used to be `reached + moveCost`,
  //    i.e. Dijkstra over a cost field, so the wave left the heap in exact
  //    cost-distance order and a push across even ground drew a near-perfect
  //    expanding contour. Coherent noise added on top only bent that contour;
  //    it could not break it, which is precisely why fronts still read as
  //    rigid. OpenFront's ordering is *local* — it never accumulates — and
  //    `tickNow` is the only thing pulling the queue forward, acting as an
  //    aging term so ground deferred by a bad roll or rough terrain still
  //    comes up a few seconds later instead of never.
  //
  // 2. `numOwnedByMe` — how many of the tile's four neighbours the attacker
  //    already holds — is the dominant term, and it is negative. At 4 it is
  //    -1.0 (priority goes negative: taken immediately), at 1 it is +0.5.
  //    Concave pockets in the line therefore snap shut while convex bulges
  //    crawl. That single term is most of the OpenFront look: the front
  //    reaches out in fingers, then the bays between them fill in behind.
  //
  // 3. Terrain (`mag`: 1 plains / 1.5 highland / 2 mountain) MULTIPLIES the
  //    random roll instead of being added beside it. The old note here — that
  //    per-tile white noise "flattened mountain resistance from 21% to 46%"
  //    — was a true measurement of the wrong construction: additive noise on
  //    an accumulating cost drowns terrain out. Multiplied, a mountain scales
  //    the whole roll by 1.5x and keeps its full relative weight no matter how
  //    large the jitter is, so the edge can be genuinely ragged and still bend
  //    around high ground. Terrain's effect on *speed* is unchanged either
  //    way — that lives in attackTickFraction's own TERRAIN_SPEED lookup.
  //
  // Rolled per tile visit from the attack's own stream (frontRand), not
  // sampled from a smooth field: coherent noise moves whole stretches of line
  // together, which is a different, smoother artifact than what OpenFront
  // actually produces.
  FRONT_TERRAIN_MAG: [1, 1.5, 2],

  // Per-attack xorshift32. Integer-only so every client's stream is
  // bit-identical, and separate from Game.rng so the number of tiles a front
  // happens to touch cannot shift the shared stream every other system draws
  // from. Returns 0..n-1, matching PseudoRandom.nextInt(0, n)'s exclusive max.
  frontRand(a, n) {
    let s = a.frontSeed;
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s |= 0;
    a.frontSeed = s;
    return (s >>> 0) % n;
  },

  frontierPriority(tile, a) {
    const nb = this.pbuf;
    const n = GameMap.neighbors(tile, nb);
    let owned = 0;
    for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] === a.attacker) owned++;
    const mag = this.FRONT_TERRAIN_MAG[GameMap.terrain[tile] || 0];
    return (this.frontRand(a, 7) + 10) * (1 - owned * 0.5 + mag / 2) + this.ticks;
  },

  // Troops spent to take one tile, re-ported 2026-09-10 against OpenFront's
  // CURRENT attackLogic (see the "How fast a front advances" section above
  // for why this whole area was re-fetched from live source rather than
  // trusted as-is): a single multiplicative formula, not the 0.6/0.4 blend
  // of two independent ratios this replaces —
  //
  //   attackerTroopLoss = mag * traitorMod * within(defence/attack, 0.6, 2)
  //     * (ATTACKER_LOSS_BASE * largeAtk * largeDef
  //        + ATTACKER_LOSS_PER_DENSITY * defenderTroopLoss)
  //
  // largeAtk/largeDef are largeTerritoryBonus (see above), not the old
  // largeAttackerLossMult/largeDefenderMultiplier pair. The clamp at 2 is
  // unchanged from before and still the load-bearing piece: without it, cost
  // rose without limit as the defender outweighed the attack, so pushing into
  // anyone stronger burned troops for almost no ground.
  //
  // Strength counted for the ratio is defenceStrength(): home reserve plus
  // whatever is committed against this same attacker — a deliberate widening
  // of OpenFront's own `defender.troops`, not a fidelity gap (see that
  // function's own comment). The density term (defenderTroopLoss) is
  // defenderLossPerTile — OpenFront's literal `defender.troops/numTilesOwned`,
  // deliberately the raw figure here rather than defenceStrength's widened
  // one, matching their own source exactly. The mag term is in OpenFront's
  // troop units so it converts through POP_SCALE.
  // Unclaimed land, OpenFront's TerraNullius branch: the attacker simply pays
  // mag/5 per tile (mag/10 for their simple Bot type, which our rival nations
  // are not). No ratio, no defender strength — empty ground just costs a flat
  // toll. At Plains mag 80 that is 16 troops a tile before scaling.
  neutralTileCost(terrain) {
    return (this.TERRAIN_MAG[terrain || 0] / 5) * this.POP_SCALE;
  },

  // Config.ts's falloutDefenseModifier(falloutRatio) = 5 - falloutRatio*2:
  // taking irradiated land costs 5x while fallout is rare on the map,
  // easing down to 2.5x once a large share of it has been nuked. See
  // Game.fallout (set in detonateNuke, cleared in setOwner on capture) and
  // the "Missile Silo & Nukes" section's own comment on why this — not
  // converting the land to water — is OpenFront's actual default-ruleset
  // behavior.
  falloutDefenseModifier() {
    const ratio = GameMap.landTiles > 0 ? this.fallout.size / GameMap.landTiles : 0;
    return 5 - ratio * 2;
  },

  // Real attackLogic applies this same modifier to BOTH troop cost (mag) and
  // per-tile speed (tileCost) — but its terra-nullius branch computes speed
  // as within(2000*tileCost/attackTroops, 5, 100), i.e. inversely
  // proportional to the attacking force's committed troops, while the troop
  // COST side (mag/5) stays flat regardless of force size. Our engine's
  // NEUTRAL_RATE_SCALE budget has no troop term at all, so porting the flat
  // 5x-2.5x multiplier onto move cost alone made pushes into fallout crawl
  // at the same fixed pace no matter how large the committed army was — a
  // small force and a huge one took equally forever, which is exactly what
  // the user reported ("lasts a very long time") and not what OpenFront
  // actually does (a big army shrugs off the terrain and burns through it
  // fast, still paying the full flat troop cost per tile, so the whole push
  // is short and decisive). This reuses that shape — bigger a.troops erases
  // more of the speed penalty — without touching the flat troop-cost side or
  // the calibrated non-fallout NEUTRAL_RATE_SCALE pacing.
  FALLOUT_SPEED_TROOPS: 3000,
  falloutSpeedMult(troops) {
    const full = this.falloutDefenseModifier();
    return 1 + (full - 1) * (this.FALLOUT_SPEED_TROOPS / (this.FALLOUT_SPEED_TROOPS + Math.max(0, troops)));
  },

  // `tile` is optional; pass it from stepAttack to enable the fort bonus.
  tileCost(attacker, defender, attackTroops, terrain, tile) {
    let mag = this.TERRAIN_MAG[terrain || 0];
    // Fallout: unconditional in real attackLogic (no `defender.isPlayer()`
    // gate the way DefensePost's own bonus below has) — fitting, since a
    // fallout tile is by construction always unowned (GameImpl's setFallout
    // throws otherwise), so it only ever actually matters against the
    // neutral-land branch just below in practice.
    if (tile !== undefined && this.fallout.has(tile)) mag *= this.falloutDefenseModifier();
    // Unclaimed land: OpenFront's "simple Bot" type pays half toll (mag/10)
    // that a human or Nation pays (mag/5) — Tribes are that simple Bot type.
    if (!defender) return (mag / (attacker.isTribe ? 10 : 5)) * this.POP_SCALE;

    // Config.ts's BOT_DEFENDER_LOSS_MULT (see its own comment above): any
    // attacker fighting a Tribe pays 0.7x mag, full stop — not gated on the
    // attacker's own type the way the 0.8x this replaces was.
    if (defender.isTribe) mag *= this.BOT_DEFENDER_LOSS_MULT;

    // Defense fort: troop cost to take a tile inside the fort's range is 5x,
    // matching Config.defensePostDefenseBonus in OpenFront's attackLogic.
    if (tile !== undefined && this.fortInRange(tile, defender.id)) mag *= this.FORT_DEF_MULT;

    const strength = this.defenceStrength(defender, attacker.id);
    const ratio = Math.min(2, Math.max(0.6, strength / Math.max(1, attackTroops)));
    const largeAtk = this.largeTerritoryBonus(attacker.tiles.size, this.lateGameAttackerDepth());
    const largeDef = this.largeTerritoryBonus(defender.tiles.size, this.LARGE_DEFENDER_DEPTH);
    const traitorMod = this.isTraitor(defender) ? this.TRAITOR_DEFENSE_DEBUFF : 1;
    // Same POP_SCALE un-shrink as attackTickFraction's terra-nullius branch
    // (see its comment): ATTACKER_LOSS_PER_DENSITY is calibrated against
    // OpenFront's raw troops-per-tile, and defenderLossPerTile returns ours
    // already shrunk 10x. Smaller a miss than the terra-nullius one — this
    // term is only ADDED to ATTACKER_LOSS_BASE, not the whole formula's
    // divisor — but the same real bug, so fixed alongside it.
    const density = this.defenderLossPerTile(defender) / this.POP_SCALE;
    return mag * traitorMod * ratio
      * (this.ATTACKER_LOSS_BASE * largeAtk * largeDef + this.ATTACKER_LOSS_PER_DENSITY * density)
      * this.POP_SCALE;
  },

});
