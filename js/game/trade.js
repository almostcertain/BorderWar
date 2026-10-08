// js/game/trade.js — Ports & trade ships.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Ports & trade ships ----------------------------------------------------
  // A Port is placed on the coast (buildBlockReason) and, once built, rolls
  // every PORT_TRADE_CHECK_INTERVAL for a trade ship to another player's
  // Port. A ship sails the seaPath route to its destination and pays BOTH
  // ports' owners on arrival (see stepTradeShips).
  //
  //  - Reachability is checked with a real seaPath call at spawn time
  //    (updatePortTrade), once per successful spawn roll.
  //  - A captured trade ship is redirected to its new owner's nearest
  //    tradeable Port (see warshipChaseTradeShip, nearestOwnedPortRoute).
  //    One Port capturing the other mid-crossing cancels the trip.

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
  // The trade distance numbers are tuned in tiles of the 2000-wide World
  // map, so every trade distance is converted to World-equivalent tiles
  // first (see docs/economy-vs-openfront.md). Large's factor is exactly 1.
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

  // A ~1.45x odds boost while the world fleet is small, a damping sigmoid
  // past a 330-ship midpoint, and a 0.25 plateau so heavy port investment
  // keeps paying late. Fleet counts are whole-map totals and are not scaled.
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

  // A sigmoid climbing from a small base near 0 distance toward a ~75k
  // plateau, plus a flat 50 gold per tile on top. `dist` is the real sea
  // route length in tiles (path.length - 1), converted to World tiles by
  // tradeDist.
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

  // Every other living player's built Port, weighted into a flat array so a
  // random index pick gives the right distribution: a Port appears once per
  // level, and once more if it is one of the closer candidates
  // (proximityBonusPortsNb) or allied, but gets neither bonus under the
  // short-range debuff distance.
  tradingPorts(port) {
    const ownerId = GameMap.owner[port.tile];
    const candidates = [];
    for (const b of this.buildings.values()) {
      if (b.type !== 'port' || !b.built || b === port) continue;
      const oid = GameMap.owner[b.tile];
      if (oid < 0 || oid === ownerId) continue;
      if (!this.canTrade(ownerId, oid)) continue;
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
  // weighted destination (tradingPorts) and commits only once a real sea
  // route to it exists. A few attempts guard against one unlucky pick
  // wasting a successful roll.
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
        const path = this.portRoute(b.tile, dest.tile);
        if (path) {
          this.tradeShips.push({ owner, srcPort: b.tile, dstPort: dest.tile, path, pos: 0 });
          break;
        }
      }
    }
  },

  // How many port PAIRS portRoute keeps (one entry per pair, either
  // direction). Oldest-first eviction (Map insertion order), so every
  // client evicts the same entries. Sized to cover every pair up to ~90
  // ports; a smaller cache thrashed on The World (see
  // docs/perf-frame-rate-profile.md).
  PORT_ROUTE_CACHE_MAX: 4096,

  // seaPath([fromTile], toTile) for two Port tiles, cached for the match:
  // the search only reads water tiles and shoreDist, which never change.
  // Each pair is stored once, in the direction first searched; a B->A route
  // reversed and ended on B's tile answers A->B. Genuine failures are
  // cached as `false`; a null from an exhausted SEA_PATH_NODE_BUDGET_PER_TICK
  // is not, so the pair is tried again later. Only written inside tick()
  // (see its _inTick comment).
  portRoute(fromTile, toTile) {
    const size = GameMap.owner.length;
    const key = Math.min(fromTile, toTile) * size + Math.max(fromTile, toTile);
    let cached = this._portRoutes.get(key);
    if (cached === false) return null;
    // Battle Royale (game/drill.js): a route found before the circle passed
    // over part of it is searched again. Routes only ever get worse, so a
    // cached failure above stays a failure.
    if (cached && this.drillPathDead(cached)) { this._portRoutes.delete(key); cached = undefined; }
    if (cached) {
      if (cached[cached.length - 1] === toTile) return cached;
      const path = cached.slice(0, -1).reverse();
      path.push(toTile);
      return path;
    }

    const before = this._seaPathSearchesThisTick;
    const path = this.seaPath([fromTile], toTile);
    const refused = !path && this._seaPathSearchesThisTick === before && this.seaPathBudgetSpent();
    if (!refused) this.cachePortRoute(key, path || false);
    return path;
  },

  cachePortRoute(key, path) {
    if (!this._inTick) return;
    const routes = this._portRoutes;
    if (routes.size >= this.PORT_ROUTE_CACHE_MAX) routes.delete(routes.keys().next().value);
    routes.set(key, path);
  },

  // Advances every trade ship along its sea route; arrival pays both ports'
  // (current) owners the same amount each (not a split), like a train
  // reaching a City. Re-checked every tick: if one Port captures the other
  // mid-crossing, the trip is cancelled without a payout.
  stepTradeShips() {
    for (let i = this.tradeShips.length - 1; i >= 0; i--) {
      const s = this.tradeShips[i];
      if (GameMap.owner[s.srcPort] === GameMap.owner[s.dstPort]) {
        this.tradeShips.splice(i, 1);
        continue;
      }
      // An embargo declared mid-crossing sinks the deal: the ship is
      // scrapped, unpaid (TradeShipExecution's canTrade check). A captured
      // ship sails for its captor's own Port and is exempt, as upstream.
      if (!s.captured && !this.canTrade(s.owner, GameMap.owner[s.dstPort])) {
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
