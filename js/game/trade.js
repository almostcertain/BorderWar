// js/game/trade.js — Ports & trade ships.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Ports & trade ships ----------------------------------------------------
  // Ported against OpenFront's actual PortExecution / TradeShipExecution /
  // Config.ts source (github.com/openfrontio/OpenFrontIO), not guessed.
  // A Port is placed on the coast (buildBlockReason) and, once built, rolls
  // every PORT_TRADE_CHECK_INTERVAL for a trade ship to another player's
  // Port — matching PortExecution's own "only check every 10 ticks" gate at
  // this game's 10 ticks/sec. A spawned ship sails the real weighted A*
  // water route (seaPath, the same pathfinder invasion boats use) to its
  // chosen destination and pays BOTH ports' owners on arrival — see
  // stepTradeShips' complete-equivalent branch.
  //
  // Deliberate scope cuts, noted where they happen:
  //  - tradingPorts() drops the real source's "water component" pre-filter
  //    (a cheap flood-fill labelling used purely to skip candidates on an
  //    unreachable sea before even trying to path to them) since this game
  //    has no such labelling built for water tiles. updatePortTrade does the
  //    equivalent check the honest way instead — a real seaPath call at
  //    spawn time — which is slower per-candidate but exactly as correct,
  //    and only runs once per successful spawn roll rather than continuously.
  //  - The captured-trade-ship redirect (TradeShipExecution's wasCaptured
  //    branch, re-targeting the ship's new owner's nearest tradeable Port) IS
  //    ported — see warshipChaseTradeShip's capture branch and
  //    nearestOwnedPortRoute below in the Warships section. The other
  //    capture case — one Port capturing the other mid-crossing, collapsing
  //    the trip into "trading with yourself" — is still handled too,
  //    matching the real early-return for it.
  //  - goldMultiplierFor (host-cheats / lobby-creator gold multiplier) has no
  //    counterpart here, so tradeShipGold omits it entirely rather than
  //    hardcoding a multiplier of 1 for a system that doesn't exist.

  // Config.ts's tradeShipShortRangeDebuff() — trading with a Port under this
  // many World tiles away (see tradeDist) earns sharply less (see tradeShipGold's sigmoid), and
  // tradingPorts' proximity/ally bonus weighting explicitly skips it too.
  TRADE_SHIP_SHORT_RANGE_DEBUFF: 300,
  // How often (seconds) each built Port re-checks whether to spawn a trade
  // ship — PortExecution's own "(ticks + offset) % 10 !== 0" collapses to a
  // flat 1-second cadence at this game's fixed 10 ticks/sec, so the random
  // per-port offset that avoids every Port rolling on the same tick in their
  // variable-rate engine isn't needed here.
  PORT_TRADE_CHECK_INTERVAL: 1,
  // OpenFront's distance numbers (the 300-tile debuff, the sigmoid's 0.03
  // slope, the 50-gold-per-tile term) are tuned in tiles of their World map,
  // 2000 wide. MAP_SIZES are that same World downsampled, so a route that is
  // 400 tiles there is 100 here on medium — deep in the debuff, paying ~5k
  // instead of ~91k. Every trade distance is therefore converted to
  // World-equivalent tiles first (see docs/economy-vs-openfront.md). Same
  // relative-reach idea as fortRange; xlarge's factor is exactly 1.
  TRADE_DIST_REF_WIDTH: 2000,

  manhattanDist(a, b) {
    const w = GameMap.width;
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    return Math.abs(ax - bx) + Math.abs(ay - by);
  },

  // A tile distance on this map, in OpenFront World tiles. Ordered
  // dist*ref/width (not dist*(ref/width)) so every MAP_SIZES width gives an
  // exact result in binary floating point — ×8 / ×4 / ×2 / ×1 on an integer
  // — which the lockstep sim needs.
  tradeDist(dist) {
    return dist * this.TRADE_DIST_REF_WIDTH / GameMap.width;
  },

  // Config.ts's tradeShipSaturation verbatim: a ~1.45x odds boost while the
  // world fleet is small, a damping sigmoid past a 330-ship midpoint, and a
  // 0.25 plateau (itself collapsing past ~800 ships) so heavy port
  // investment keeps paying late. Fleet counts are left unscaled — they are
  // whole-map totals, and our smaller lobbies simply sit in the boost region
  // longer.
  tradeShipSaturation(numTradeShips) {
    const boost = 1 + 0.45 * this.det.exp(-numTradeShips / 120);
    const damping = 1 - this.sigmoid(numTradeShips, Math.LN2 / 50, 330);
    const plateau = 0.25 * (1 - this.sigmoid(numTradeShips, Math.LN2 / 100, 800));
    return boost * Math.max(damping, plateau);
  },

  // Config.ts's tradeShipSpawnRate verbatim: returned as a 1-in-N chance.
  // The "pity timer" rejectionModifier raises the odds after each consecutive
  // miss so a quiet Port doesn't go dry forever.
  tradeShipSpawnRate(rejections, numTradeShips) {
    const rejectionModifier = 1 / (rejections + 1);
    return Math.max(1, Math.floor((100 * rejectionModifier) / this.tradeShipSaturation(numTradeShips)));
  },

  // Config.ts's tradeShipGold: a sigmoid climbing from a small base near 0
  // distance up toward a ~75k plateau, plus a flat 50-gold-per-tile term on
  // top — concave at first, a sharp S through the mid-range, effectively
  // linear beyond it. `dist` is the real sea route length in tiles (the
  // trade ship's path.length - 1), same measure OpenFront's own
  // tilesTraveled counts, converted to World tiles by tradeDist.
  // goldMultiplierFor is not ported — see class comment.
  tradeShipGold(dist) {
    const d = this.tradeDist(dist);
    const debuff = this.TRADE_SHIP_SHORT_RANGE_DEBUFF;
    return Math.floor(75000 / (1 + this.det.exp(-0.03 * (d - debuff))) + 50 * d);
  },

  // Config.ts's proximityBonusPortsNb: how many of the nearest candidate
  // Ports (once sorted by distance in tradingPorts) get the extra proximity
  // weight — a third of the total, floored at 4, never more than there are
  // candidates to begin with.
  proximityBonusPortsNb(totalPorts) {
    return Math.min(totalPorts, Math.max(4, Math.round(totalPorts / 3)));
  },

  // PortExecution.tradingPorts: every other living player's built Port,
  // weighted into a flat array so a plain random index pick over it
  // reproduces the real probability distribution — a Port appears once per
  // level (a bigger Port is a bigger trade partner), a second time if it's
  // one of the closer candidates (proximityBonusPortsNb) or allied, but
  // never for either bonus if it's under the short-range debuff distance
  // (matching the real source's `!tooClose` guard on both bonuses).
  tradingPorts(port) {
    const ownerId = GameMap.owner[port.tile];
    const candidates = [];
    for (const b of this.buildings.values()) {
      if (b.type !== 'port' || !b.built || b === port) continue;
      const oid = GameMap.owner[b.tile];
      if (oid < 0 || oid === ownerId) continue;
      const op = this.players[oid];
      if (!op || !op.alive) continue;
      candidates.push(b);
    }
    candidates.sort((a, c) => this.manhattanDist(port.tile, a.tile) - this.manhattanDist(port.tile, c.tile));

    const bonusCount = this.proximityBonusPortsNb(candidates.length);
    const weighted = [];
    for (let i = 0; i < candidates.length; i++) {
      const other = candidates[i];
      const expanded = new Array(other.level).fill(other);
      weighted.push(...expanded);
      const tooClose = this.tradeDist(this.manhattanDist(port.tile, other.tile)) < this.TRADE_SHIP_SHORT_RANGE_DEBUFF;
      if (!tooClose && i < bonusCount) weighted.push(...expanded);
      if (!tooClose && this.areAllied(ownerId, GameMap.owner[other.tile])) weighted.push(...expanded);
    }
    return weighted;
  },

  // PortExecution.shouldSpawnTradeShip: one roll per level, first success
  // wins and resets the pity counter; every miss (whether or not the Port
  // gets a hit on a later level this same call) increments it for next time.
  shouldSpawnTradeShip(b) {
    const numTradeShips = this.tradeShips.length;
    for (let i = 0; i < b.level; i++) {
      const spawnRate = this.tradeShipSpawnRate(b.tradeRejections, numTradeShips);
      if (this.rng() < 1 / spawnRate) {
        b.tradeRejections = 0;
        return true;
      }
      b.tradeRejections++;
    }
    return false;
  },

  // Rolls every built Port for a fresh trade ship. On a hit, picks a
  // weighted destination (tradingPorts) and only actually commits once a
  // real sea route to it exists — see the class comment on why that replaces
  // the real source's water-component pre-filter. A few attempts guard
  // against one unlucky pick (an allied bonus entry, say, whose sea lane
  // happens to be blocked) wasting an entire successful roll.
  updatePortTrade() {
    for (const b of this.buildings.values()) {
      if (b.type !== 'port' || !b.built) continue;
      if (this.elapsed - b.lastTradeCheckAt < this.PORT_TRADE_CHECK_INTERVAL) continue;
      b.lastTradeCheckAt = this.elapsed;

      const owner = GameMap.owner[b.tile];
      const p = this.players[owner];
      if (!p || !p.alive) continue;

      if (!this.shouldSpawnTradeShip(b)) continue;

      const candidates = this.tradingPorts(b);
      if (candidates.length === 0) continue;

      for (let attempt = 0; attempt < 3; attempt++) {
        const dest = candidates[Math.floor(this.rng() * candidates.length)];
        const path = this.seaPath([b.tile], dest.tile);
        if (path) {
          this.tradeShips.push({ owner, srcPort: b.tile, dstPort: dest.tile, path, pos: 0 });
          break;
        }
      }
    }
  },

  // Advances every trade ship along its sea route; arrival pays both ports'
  // (current) owners the same amount each — TradeShipExecution.complete's
  // real two-way payout, not a split, exactly like a train reaching a City
  // (see stepTrains). Re-checked every tick rather than only at spawn: if
  // one Port captures the other mid-crossing the trip becomes "trading with
  // yourself" and is cancelled without a payout, matching the real source's
  // early-return for that exact case (see class comment on what isn't
  // ported alongside it).
  stepTradeShips() {
    for (let i = this.tradeShips.length - 1; i >= 0; i--) {
      const s = this.tradeShips[i];
      if (GameMap.owner[s.srcPort] === GameMap.owner[s.dstPort]) {
        this.tradeShips.splice(i, 1);
        continue;
      }

      s.pos += this.BOAT_SPEED * this.TICK_DT;
      if (s.pos < s.path.length - 1) continue;

      const srcP = this.players[GameMap.owner[s.srcPort]];
      const dstP = this.players[GameMap.owner[s.dstPort]];
      const gold = this.tradeShipGold(s.path.length - 1);
      // Recorded for both ports' owners unconditionally; the renderer filters
      // to the local viewer — see stepTrains' identical note and js/fx.js.
      if (srcP) {
        srcP.gold += gold;
        Fx.goldPopup(s.srcPort, gold, GameMap.owner[s.srcPort]);
      }
      if (dstP) {
        dstP.gold += gold;
        Fx.goldPopup(s.dstPort, gold, GameMap.owner[s.dstPort]);
      }

      this.tradeShips.splice(i, 1);
    }
  },

});
