// js/game/economy.js — Population & economy.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Population model ----------------------------------------------------
  // Cap:         2 * (tiles^0.6 * 1000 + 50000) + cities * 25000
  // Growth/tick: (10 + pop^0.73 / 4) * (1 - pop / maxPop)     at 10 ticks/sec
  //
  // The 0.73 exponent makes growth depend on absolute population, so the
  // maths is done in unscaled units and converted back through POP_SCALE:
  // the curve, including its 42% peak, is preserved while the magnitudes
  // suit this map. At 0.1 a fresh spawn's cap reads as about 12.1k.
  POP_SCALE: 0.1,
  TICKS_PER_SEC: 10,
  // 1.0 = OpenFront's own rate, exactly. Their msPerTick is 100, the same tick
  // this game runs on, so no correction is needed. Kept as a named dial only
  // because match length is sensitive to it.
  GROWTH_TIME_SCALE: 1.0,
  TILE_POP_EXPONENT: 0.6,
  TILE_POP_COEF: 1000,
  BASE_POP: 50000,
  // Unscaled units: through POP_SCALE a city is worth +25k troops on the
  // readout. Paid per LEVEL, not per city: maxTroops sums city levels, so a
  // level-3 city is worth three level-1 cities.
  CITY_POP_INCREASE: 250000,

  // Nation difficulty: a Nation's opening troops, cap and growth scale by
  // the match's difficulty (0.5 / 0.75 / 1.0x cap and 0.9 / 0.95 / 1.0x
  // growth for Easy / Medium / Hard). Hard is a Nation on a human's footing.
  //
  // Medium is the fallback for a missing or unrecognised setting. All three
  // convert through POP_SCALE. A human (isBot false) gets none of it. The
  // behavioural half of each tier is AI.PROFILES.
  DIFFICULTIES: ['easy', 'medium', 'hard'],
  DEFAULT_DIFFICULTY: 'medium',
  NATION_DIFFICULTY: {
    easy:   { startTroops: 12500, capMult: 0.5,  growthMult: 0.9 },
    medium: { startTroops: 18750, capMult: 0.75, growthMult: 0.95 },
    hard:   { startTroops: 25000, capMult: 1,    growthMult: 1 }
  },
  START_TROOPS_HUMAN: 25000,
  // OpenFront's real Bot startManpower — this is what Tribes take, not the
  // Nation figure above (openfront.wiki/Bots, "Bots start with
  // 10,000 troops" vs. 25,000 for a human). Tribes ignore difficulty.
  START_TROOPS_TRIBE: 10000,

  // OpenFront's Bot-specific caps, from Config.ts (the wiki's "half the
  // population, 30% slower growth" is out of date): maxTroops / 3 and
  // toAdd *= 0.5. Independent of the Nation multipliers above — Tribes are the
  // "simple Bot" type Nations are not. The small cap is what keeps a tribe's
  // big per-attack commitment (TribeAI) from making it a real power.
  TRIBE_TROOP_CAP_MULT: 1 / 3,
  TRIBE_GROWTH_MULT: 0.5,

  // `cityLevels` is the sum of levels across the player's built cities (what
  // unitsOwned(p, 'city') already tracks), not a count of cities — see the
  // UNITS comment.
  maxTroopsRaw(tiles, cityLevels) {
    return 2 * (this.det.pow(tiles, this.TILE_POP_EXPONENT) * this.TILE_POP_COEF + this.BASE_POP)
      + (cityLevels || 0) * this.CITY_POP_INCREASE;
  },

  // The active match's Nation tier (see NATION_DIFFICULTY). init() sets
  // `difficulty` from the match config; the fallback covers a Game that has not
  // been initialised yet.
  nationDifficulty() {
    return this.NATION_DIFFICULTY[this.difficulty] || this.NATION_DIFFICULTY[this.DEFAULT_DIFFICULTY];
  },

  maxTroops(p) {
    const raw = this.maxTroopsRaw(p.tiles.size, this.unitsOwned(p, 'city'));
    const mult = p.isTribe ? this.TRIBE_TROOP_CAP_MULT : (p.isBot ? this.nationDifficulty().capMult : 1);
    return raw * mult * this.POP_SCALE;
  },

  // Troops currently committed to this player's in-flight attacks. They have
  // left the home reserve but are still very much part of the nation.
  marchingTroops(playerId) {
    let n = 0;
    for (const a of this.attacks) if (a.attacker === playerId) n += a.troops;
    for (const b of this.boats) if (b.attacker === playerId) n += b.troops;
    return n;
  },

  // Reserve plus everyone on campaign. Reported where the whole nation's
  // strength is the question; it is NOT what drives growth.
  totalTroops(p) { return p.troops + this.marchingTroops(p.id); },

  // Fill ratio at which growth peaks: the level worth sitting at rather
  // than banking past. About 42%, but it drifts a little with cap because
  // of the constant `10 +` term, so it is solved from the curve and cached
  // per cap.
  peakGrowthRatio(p) {
    const max = this.maxTroops(p);
    if (this._peakCap && Math.abs(max - this._peakCap) / this._peakCap < 0.02) {
      return this._peakRatio;
    }
    // id -1 owns no attacks, so the probe's growth reads off its troops alone
    // rather than picking up this player's marching forces. isBot has to carry
    // over too — maxTroops(probe) recomputes the cap from scratch, and if the
    // Nation difficulty multiplier dropped out here the probe would scan a
    // different (larger) cap than the player it's standing in for.
    const probe = { tiles: p.tiles, troops: 0, id: -1, units: p.units, isBot: p.isBot, isTribe: p.isTribe };
    let bestR = 0.42, best = -1;
    for (let r = 0.15; r <= 0.75; r += 0.005) {
      probe.troops = r * max;
      const g = this.growthPerSecond(probe);
      if (g > best) { best = g; bestR = r; }
    }
    this._peakCap = max;
    this._peakRatio = bestR;
    return bestR;
  },

  // Absolute troops/sec a player is gaining, for the sim and the HUD alike.
  // Growth reads the home reserve alone: troops out on campaign have left
  // the population that reproduces, so committing an army drops you back
  // down the curve.
  growthPerSecond(p) {
    const max = this.maxTroops(p);
    const pop = p.troops;
    if (pop >= max) return 0;
    const rawPop = pop / this.POP_SCALE;
    let perTick = (10 + this.det.pow(rawPop, 0.73) / 4) * (1 - pop / max);
    // OpenFront's troopIncreaseRate applies the same difficulty scalar to
    // growth that maxTroops applies to the cap — a second, independent cut
    // on top of the smaller max, not implied by it. Tribes get their own
    // (larger) cut instead — see TRIBE_GROWTH_MULT.
    if (p.isTribe) perTick *= this.TRIBE_GROWTH_MULT;
    else if (p.isBot) perTick *= this.nationDifficulty().growthMult;
    return perTick * this.POP_SCALE * this.TICKS_PER_SEC * this.GROWTH_TIME_SCALE;
  },

  // --- Economy -------------------------------------------------------------
  // Gold is the second resource, and everything built is priced in it. The
  // base income is a flat rate, identical for everyone, paid every tick; the
  // rate is a dial, set so a match accumulates a treasury worth spending.
  // Gold is NOT scaled by POP_SCALE.
  START_GOLD: 0,
  GOLD_PER_SEC: 1000,

  // Per-player, like growthPerSecond, so the formula can change without
  // touching call sites.
  //
  // Income is gated on holding land, not on the `alive` flag: a nation
  // whose last tile is gone can stay technically alive for a while (the
  // death sweep also wants its troops under 20) and has nothing to tax.
  goldPerSecond(p) {
    return p && p.alive && p.tiles.size > 0 ? this.GOLD_PER_SEC : 0;
  },

});
