// js/game/specialize.js — City specializations (docs/city-specialization.md).
// Extends the Game singleton declared in game/core.js.
Object.assign(Game, {
  // A City at this level or above can take one specialization, for good.
  SPEC_MIN_LEVEL: 3,
  // Fee: SPEC_BASE_COST * 2^n, uncapped. See specCost.
  SPEC_BASE_COST: 250000,

  // Every effect is per level of the specialized city.
  // Unscaled, like CITY_POP_INCREASE: +15k troops of cap on the readout.
  METROPOLIS_POP_PER_LEVEL: 150000,
  TRADEHUB_GOLD_PER_LEVEL: 0.25,
  TREASURY_GOLD_PER_LEVEL: 500,
  GARRISON_GROWTH_PER_LEVEL: 0.05,
  GARRISON_GROWTH_CAP: 0.5,

  SPECS: [
    { type: 'metropolis', name: 'Metropolis' },
    { type: 'tradehub', name: 'Trade Hub' },
    { type: 'treasury', name: 'Treasury' },
    { type: 'garrison', name: 'Garrison Town' }
  ],

  specDef(type) { return this.SPECS.find(s => s.type === type) || null; },

  // Shared across every type. n follows unitCost's rule: captured cities
  // cannot push the price past the player's own purchases, and losing one
  // lowers it. Base 2 with a small integer exponent is exact (see unitCost).
  specCost(p) {
    const held = (p && p.spec && p.spec.held) || 0;
    const bought = (p && p.specsBought) || 0;
    return this.SPEC_BASE_COST * Math.pow(2, Math.min(held, bought));
  },

  // null when `spec` can go on the structure at `tile`. Pass no `spec` to ask
  // only whether the city is ready for one.
  specializeBlockReason(playerId, tile, spec) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    const b = this.buildings.get(tile);
    if (!b) return 'Nothing built here';
    if (GameMap.owner[tile] !== playerId) return 'Your own land only';
    if (b.type !== 'city') return 'Only Cities specialize';
    if (b.spec) return 'Already specialized';
    if (!b.built || b.level < this.SPEC_MIN_LEVEL) return 'Needs a level ' + this.SPEC_MIN_LEVEL + ' City';
    if (spec !== undefined && !this.specDef(spec)) return 'Unknown specialization';
    if (p.gold < this.specCost(p)) return 'Not enough gold';
    return null;
  },

  canSpecialize(playerId, tile, spec) { return !this.specializeBlockReason(playerId, tile, spec); },

  specialize(playerId, tile, spec) {
    if (spec === undefined || !this.canSpecialize(playerId, tile, spec)) return false;
    const p = this.players[playerId];
    const b = this.buildings.get(tile);
    p.gold -= this.specCost(p);   // priced before the counts go up
    b.spec = spec;
    p.specsBought++;
    // Counted now so a second purchase this turn prices higher; the next
    // updateSpecTotals rebuilds the same numbers.
    p.spec.held++;
    p.spec[spec] += b.level;
    return true;
  },

  // Rebuilds every player's totals from the buildings map: per type, the sum
  // of levels of the specialized cities they hold. Run at the top of tick(),
  // so capture, destruction and level-ups need no bookkeeping of their own.
  updateSpecTotals() {
    for (const p of this.players) {
      const s = p.spec;
      s.held = s.metropolis = s.tradehub = s.treasury = s.garrison = 0;
    }
    for (const b of this.buildings.values()) {
      if (!b.spec) continue;
      const owner = GameMap.owner[b.tile];
      if (owner < 0) continue;
      const s = this.players[owner].spec;
      s.held++;
      s[b.spec] += b.level;
    }
  },

  // Raw troop cap from this player's Metropolises (see maxTroopsRaw).
  specPopBonus(p) {
    return ((p.spec && p.spec.metropolis) || 0) * this.METROPOLIS_POP_PER_LEVEL;
  },

  specGrowthMult(p) {
    const levels = (p.spec && p.spec.garrison) || 0;
    return 1 + Math.min(this.GARRISON_GROWTH_CAP, levels * this.GARRISON_GROWTH_PER_LEVEL);
  },

  specGoldPerSecond(p) {
    return ((p.spec && p.spec.treasury) || 0) * this.TREASURY_GOLD_PER_LEVEL;
  },

  // What a train stop at station `b` pays, given the ordinary `gold`.
  specTrainGold(b, gold) {
    if (b.spec !== 'tradehub') return gold;
    return Math.floor(gold * (1 + b.level * this.TRADEHUB_GOLD_PER_LEVEL));
  },

});
