// js/game/combat.js — Combat math, terrain & fallout.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  DEFENSE_WEIGHT: 1.6,
  DEFENDER_LOSS: 0.55,

  // What being marked a traitor costs. Both are applied to the ATTACKER's
  // side of the ledger, so a traitor is cheaper and quicker to carve up,
  // for every attacker on the map.
  TRAITOR_DEFENSE_DEBUFF: 0.5,
  TRAITOR_SPEED_DEBUFF: 0.8,

  // There is deliberately no penalty on the attacker's own size here: it
  // made matches resolve worse and slower in sweeps. Anti-snowball comes
  // from the population curve refilling large empires more slowly.

  // --- How fast a front advances -------------------------------------------
  // Every attack gets a flat budget of ATTACK_TICK_BUDGET per tick, NOT
  // proportional to border width, and spends it tile by tile against
  // attackTickFraction, which folds terrain, the troop-ratio speed ramp and
  // border width into one number. Border width appears once, as that
  // function's divisor.
  //
  // Budget left over after the last affordable tile is discarded; nothing is
  // carried across ticks (see stepAttack).
  ATTACK_TICK_BUDGET: 1,

  // Unclaimed-land speed constants. attackTickFraction's unclaimed-land
  // branch is `within(COST_SCALE*tileCost/attackTroops, MIN, MAX) /
  // (borderSize*2)`: inversely proportional to the committed force, so a
  // big grab swallows open ground fast while a token nibble stays slow.
  TERRA_NULLIUS_COST_SCALE: 2000,
  TERRA_NULLIUS_MIN_COST: 5,
  TERRA_NULLIUS_MAX_COST: 100,

  // Config.ts's SPEED_COST_DIVISOR and ATTACKER_LOSS_BASE/PER_DENSITY: the
  // troop-ratio speed ramp (attackTickFraction) and the troop-loss formula
  // (tileCost) below.
  SPEED_COST_DIVISOR: 7.77,
  ATTACKER_LOSS_BASE: 0.463,
  ATTACKER_LOSS_PER_DENSITY: 0.0039,

  // Any attack on a Tribe gets this troop-loss discount.
  BOT_DEFENDER_LOSS_MULT: 0.7,

  // --- Large-player rebalancing ---------------------------------------------
  // largeTerritoryBonus is one logistic in log(tiles), shared by the
  // troop-cost and speed formulas for both attacker and defender, differing
  // only in `depth` (how far it can pull the multiplier down: 0.7 for an
  // attacker's edge, 0.3 for a defender's debuff). Large defenders get
  // weaker, so the late game doesn't crawl.
  LARGE_TERRITORY_MIDPOINT: 300000,
  LARGE_TERRITORY_STEEPNESS: 2.5,
  LARGE_ATTACKER_DEPTH: 0.7,
  LARGE_DEFENDER_DEPTH: 0.3,

  // Hard-only: as the field thins toward a final showdown, ease off the
  // attacker's anti-snowball brake so a dominant nation can close the game
  // out instead of grinding down a hopeless straggler. Easy/Medium keep the
  // flat brake. Partway eased at 5 nations left, fully off at the final 1v1.
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
  // to `1 - depth` for a huge one, halfway at the midpoint. Log-scaled, so
  // it follows tile-count ratios. `numTiles` is guarded at 1 because
  // log(0) is -Infinity.
  largeTerritoryBonus(numTiles, depth) {
    return 1 - depth * this.sigmoid(this.det.log(Math.max(1, numTiles)),
      this.LARGE_TERRITORY_STEEPNESS, this.det.log(this.LARGE_TERRITORY_MIDPOINT));
  },

  // Per-tile speed cost as a fraction of ATTACK_TICK_BUDGET.
  // `attackTroops`/`defender` are read live by the caller (stepAttack) on
  // every iteration. `tile` is optional; pass it to enable the fort and
  // fallout bonuses (as with tileCost).
  attackTickFraction(attacker, defender, attackTroops, terrain, tile, borderSize) {
    let tileSpeed = this.TERRAIN_SPEED[terrain || 0];
    // Fallout: falloutSpeedMult, not the flat falloutDefenseModifier tileCost's
    // troop-cost side still uses — see that function's own comment. Applies to
    // both branches below, matching how this was already called before this
    // re-port.
    if (tile !== undefined && this.fallout.has(tile)) tileSpeed *= this.falloutSpeedMult(attackTroops);

    if (!defender) {
      // TERRA_NULLIUS_COST_SCALE is calibrated against unscaled troop
      // counts, but `attackTroops` here is POP_SCALE-shrunk, so it is
      // un-shrunk before the division. Without that, early pushes pin near
      // TERRA_NULLIUS_MAX_COST (the slowest tier). troopRatio below is a
      // ratio of two shrunk numbers, so POP_SCALE cancels there.
      const raw = Math.min(this.TERRA_NULLIUS_MAX_COST, Math.max(this.TERRA_NULLIUS_MIN_COST,
        this.TERRA_NULLIUS_COST_SCALE * tileSpeed / Math.max(1, attackTroops / this.POP_SCALE)));
      return raw / (borderSize * 2);
    }

    // Defense fort: movement cost into protected tiles is 3x, matching
    // Config.defensePostSpeedBonus in OpenFront's attackLogic.
    if (tile !== undefined && this.fortInRange(tile, defender.id)) tileSpeed *= this.FORT_SPEED_MULT;

    const troopRatio = this.defenceStrength(defender, attacker.id) / Math.max(1, attackTroops);
    // Flat at its floor (1/SPEED_COST_DIVISOR) for any attack that is not
    // outnumbered: it exists to stall hopeless attacks, not reward
    // blowouts. Once the defender is stronger it ramps linearly to 7.5x by
    // troopRatio=7.5, then up to a further 50x for a truly hopeless push.
    const speedCost = (Math.min(7.5, Math.max(1, troopRatio)) * Math.min(50, Math.max(1, troopRatio / 20)))
      / this.SPEED_COST_DIVISOR;
    const largeAtk = this.largeTerritoryBonus(attacker.tiles.size, this.lateGameAttackerDepth());
    const largeDef = this.largeTerritoryBonus(defender.tiles.size, this.LARGE_DEFENDER_DEPTH);
    const traitorMod = this.isTraitor(defender) ? this.TRAITOR_SPEED_DEBUFF : 1;
    return (speedCost * tileSpeed * largeAtk * largeDef * traitorMod) / borderSize;
  },

  // What a defender is worth against a particular attacker: the home
  // reserve plus anything already committed to a front facing them (or a
  // nation that had just committed everything would be the cheapest target
  // on the map). Troops committed elsewhere do not count: over-extending
  // on one front really does leave the others thin.
  defenceStrength(defender, attackerId) {
    let n = defender.troops;
    for (const a of this.attacks) {
      // A retreating counter-push has already pulled out of this fight.
      if (a.attacker === defender.id && a.target === attackerId && !a.retreating) n += a.troops;
    }
    return n;
  },

  // What the defender pays per tile lost: defender troops / tiles owned.
  // The defender sheds their average garrison with each tile, so losing the
  // whole country costs exactly their whole army. Without proportional
  // attrition a defender out-regrows the damage and borders set into
  // permanent trench lines.
  defenderLossPerTile(defender) {
    return defender.troops / Math.max(1, defender.tiles.size);
  },

  // Defense fort constants. A built fort within fortRange() tiles of a
  // contested tile multiplies the attacker's troop cost (FORT_DEF_MULT) and
  // movement cost (FORT_SPEED_MULT).
  //
  // The range is one flat radius on every map size, because nation size is
  // flat: default Nation/Tribe counts follow map AREA (js/main.js), so an
  // average nation starts with about 1,700 tiles everywhere. pi*25^2 = 1,963
  // tiles, roughly one average nation.
  FORT_RANGE: 25,
  FORT_DEF_MULT: 5,
  FORT_SPEED_MULT: 3,

  // An integer, so fortInRange's squared compare is exact on every client.
  fortRange() {
    return this.FORT_RANGE;
  },

  // True when a fully-built fort owned by `ownerId` is within fortRange()
  // tiles (Euclidean) of `tile`. Iterates all buildings (typically <100).
  // `includePending` also counts a fort under construction; combat never
  // passes it, AI.fortSite does, so a bot doesn't queue a second fort beside
  // one it just started.
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

  // Shape of the advancing edge:
  //
  //   priority = (rand(0,7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) + tickNow
  //
  // 1. The priority is NOT cumulative. A cumulative cost (Dijkstra) leaves
  //    the heap in exact cost-distance order and draws a rigid expanding
  //    contour. `tickNow` is an aging term, so ground deferred by a bad roll
  //    still comes up a few seconds later.
  //
  // 2. `numOwnedByMe` (how many of the tile's four neighbours the attacker
  //    holds) is the dominant term, and negative: concave pockets snap shut
  //    while convex bulges crawl, so the front reaches out in fingers and
  //    the bays fill in behind.
  //
  // 3. Terrain (`mag`: 1 plains / 1.5 highland / 2 mountain) MULTIPLIES the
  //    random roll, so it keeps its relative weight however large the
  //    jitter is. Terrain's effect on *speed* lives in attackTickFraction.
  //
  // Rolled per tile visit from the attack's own stream (frontRand), not
  // sampled from a smooth field, which would move whole stretches together.
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

  // Troops spent to take one tile:
  //
  //   attackerTroopLoss = mag * traitorMod * within(defence/attack, 0.6, 2)
  //     * (ATTACKER_LOSS_BASE * largeAtk * largeDef
  //        + ATTACKER_LOSS_PER_DENSITY * defenderTroopLoss)
  //
  // largeAtk/largeDef are largeTerritoryBonus. The clamp at 2 is
  // load-bearing: without it, pushing into anyone stronger burns troops for
  // almost no ground.
  //
  // Strength for the ratio is defenceStrength(): home reserve plus whatever
  // is committed against this attacker. The density term is
  // defenderLossPerTile, the raw troops/tiles figure. The mag term is in
  // unscaled troop units, so it converts through POP_SCALE.
  // Unclaimed land: the attacker pays a flat mag/5 per tile. No ratio, no
  // defender strength.
  neutralTileCost(terrain) {
    return (this.TERRAIN_MAG[terrain || 0] / 5) * this.POP_SCALE;
  },

  // 5 - falloutRatio*2: taking irradiated land costs 5x while fallout is
  // rare on the map, easing to 2.5x once a large share has been nuked. See
  // Game.fallout (set in detonateNuke, cleared in setOwner on capture).
  falloutDefenseModifier() {
    const ratio = GameMap.landTiles > 0 ? this.fallout.size / GameMap.landTiles : 0;
    return 5 - ratio * 2;
  },

  // Fallout's troop cost is flat, but its speed penalty shrinks as the
  // committed force grows: a big army burns through irradiated ground fast
  // (still paying full troop cost per tile), where a small one crawls.
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
    // Same POP_SCALE un-shrink as attackTickFraction's unclaimed-land
    // branch: ATTACKER_LOSS_PER_DENSITY is calibrated against unscaled
    // troops per tile, and defenderLossPerTile returns ours shrunk.
    const density = this.defenderLossPerTile(defender) / this.POP_SCALE;
    return mag * traitorMod * ratio
      * (this.ATTACKER_LOSS_BASE * largeAtk * largeDef + this.ATTACKER_LOSS_PER_DENSITY * density)
      * this.POP_SCALE;
  },

});
