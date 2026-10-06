// js/game/economy.js — Population & economy.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Population model, after OpenFront -----------------------------------
  // Cap:         2 * (tiles^0.6 * 1000 + 50000) + cities * 25000
  // Growth/tick: (10 + pop^0.73 / 4) * (1 - pop / maxPop)     at 10 ticks/sec
  //
  // The 0.73 exponent means growth depends on absolute population, so the curve
  // only keeps its shape at OpenFront's magnitudes. Their maps are far larger
  // than ours, and lifting their numbers wholesale would put armies in the
  // hundreds of thousands on a 25k-tile map — a single push would swallow it.
  // So the maths is done in OpenFront units and converted back through
  // POP_SCALE. The (1 - pop/max) term is scale-free and the P^0.73 term is
  // evaluated on the unscaled figure, so the curve — including its 42% peak —
  // is preserved exactly while the magnitudes suit this map.
  // OpenFront keeps troops internally at 10x what it shows: startManpower is
  // 25,000 and reads as 2.5k, a fresh spawn's cap is ~121,000 and reads as
  // 12.1k. Scaling by 0.1 therefore makes our raw numbers equal the figures
  // their UI puts on screen, so pacing can be compared directly.
  POP_SCALE: 0.1,
  TICKS_PER_SEC: 10,
  // 1.0 = OpenFront's own rate, exactly. Their msPerTick is 100, the same tick
  // this game runs on, so no correction is needed. Kept as a named dial only
  // because match length is sensitive to it.
  GROWTH_TIME_SCALE: 1.0,
  TILE_POP_EXPONENT: 0.6,
  TILE_POP_COEF: 1000,
  BASE_POP: 50000,
  // Raw OpenFront units (Config.cityTroopIncrease(), verified against their
  // live source), so through POP_SCALE a city is worth +25k troops on the
  // readout — about twice a fresh spawn's whole cap. Was ported at 25,000, a
  // 10x transcription error caught in an audit against their actual config.
  // Paid out per LEVEL, not per city — verbatim their maxTroops(), which sums
  // city.level() across every built city before multiplying by this. A city
  // upgraded to level 3 is worth exactly what three level-1 cities would be.
  CITY_POP_INCREASE: 250000,

  // Nation difficulty. OpenFront scales a Nation's opening troops, cap and
  // growth by the match's difficulty (startManpower / maxTroops /
  // troopIncreaseRate in Config.ts): 12,500 / 18,750 / 25,000 troops, 0.5 /
  // 0.75 / 1.0x cap and 0.9 / 0.95 / 1.0x growth for Easy / Medium / Hard.
  // Hard is a Nation on a human's footing. Only the three tiers the menu
  // offers are ported; their fourth (Impossible) isn't.
  //
  // Medium is the balance this game shipped with, so it is also the fallback
  // for a missing or unrecognised setting (a multiplayer lobby has no picker
  // yet). All three convert through POP_SCALE, which leaves the opening fill
  // ratio identical to OpenFront's — a human still starts at 19.6% of cap.
  // A human (isBot false) gets none of it, exactly as their Human branch
  // applies no multiplier at all. The behavioural half of each tier is
  // AI.PROFILES.
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
    for (const pl of this.planes) if (pl.owner === playerId) n += pl.troops;
    return n;
  },

  // Reserve plus everyone on campaign. Reported where the whole nation's
  // strength is the question; it is NOT what drives growth.
  totalTroops(p) { return p.troops + this.marchingTroops(p.id); },

  // Absolute troops/sec a player is currently gaining, for both simulation
  // and the HUD readout to consume identically.
  // Fill ratio at which growth peaks — the level worth sitting at rather than
  // banking past. It lands at ~42% (OpenFront's documented figure) but drifts a
  // little with cap because of the constant `10 +` term, so it is solved from
  // the curve rather than hardcoded. Cached per cap; the scan is far too costly
  // to repeat every frame.
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

  // Growth reads the home reserve alone — troops out on campaign have left the
  // population that reproduces, exactly as OpenFront's troopIncreaseRate works
  // off player.troops(). Committing an army therefore drops you back down the
  // curve, and if that puts you under the ~42% peak your regrowth accelerates.
  // Keying this to the reserve is also what keeps the bar, the colour and the
  // rate all describing the same number.
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
  // Gold is the second resource, and everything built later is priced in it.
  //
  // OpenFront does not pay gold for holding land: population is split by a
  // slider into troops and WORKERS, and income is derived from the worker half
  // (plus ports, trade and the rest of the structure layer). None of that
  // exists here yet — there is no worker split and nothing to build — so this
  // first step is deliberately the simplest thing that is still true of every
  // nation: a flat rate, identical for everyone, paid every tick you are alive.
  //
  // Keeping it flat matters for what comes next. When income becomes a function
  // of workers or of what you have built, the difference between two nations'
  // treasuries will be the whole point; starting from a rate nobody can
  // influence gives that change a clean baseline to be measured against.
  //
  // The number itself is a dial, not a ported constant. It is set so a match
  // accumulates a treasury worth spending — about 600k over a ten-minute game,
  // which is the order of magnitude OpenFront's structures are priced in — so
  // that when costs arrive they can be taken from their config directly rather
  // than re-derived. Gold is NOT scaled by POP_SCALE: that factor exists to
  // shrink armies to this map's size, and prices have no such constraint.
  START_GOLD: 0,
  GOLD_PER_SEC: 1000,

  // Per-player so the worker-derived formula can replace the body without
  // touching a single call site, exactly as growthPerSecond is shaped.
  //
  // Income is gated on holding land, not on the `alive` flag. A nation whose
  // last tile has been taken can stay technically alive for a while — the death
  // sweep also wants its troops under 20 — and a rump state with an army in the
  // field and no country left has nothing to tax. Land is the test the
  // leaderboard already applies to decide who is still in the game.
  goldPerSecond(p) {
    return p && p.alive && p.tiles.size > 0 ? this.GOLD_PER_SEC : 0;
  },

});
