// js/game/seapath.js — Water pathfinding & smoothing.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // Ported against OpenFront's actual AStarWater/SmoothingWaterTransformer
  // source (github.com/openfrontio/OpenFrontIO), not guessed. The old
  // seaPath was an unweighted multi-source BFS — correct, but on a
  // 4-directional grid an unweighted search has no reason to prefer one
  // shortest path over another, so ties resolved in queue order and routes
  // came out as long straight runs hugging the coastline. OpenFront's real
  // pathfinder fixes that with three independent levers, all reproduced
  // below:
  //  1. A per-tile cost keyed on distance-from-shore (GameMap.shoreDist) —
  //     hugging the coast is expensive, a band a few tiles out is free, deep
  //     water carries a small penalty of its own. See shoreCostPenalty.
  //  2. A weighted heuristic (SEA_HEURISTIC_WEIGHT > 1) plus a small
  //     cross-product tie-breaker that biases ties toward the straight
  //     source-goal line. On a cardinal-only grid that turns ties into an
  //     alternating staircase instead of one long run per axis.
  //  3. A Bresenham re-trace over the result (retraceWaterLine) that pulls
  //     each straight-enough stretch taut into a true diagonal line,
  //     decomposed into whichever cardinal tile of each diagonal step is
  //     actually deep enough water — the direct source of the organic
  //     diagonal/stair-step look, not just the search's tie-breaking.
  //
  // Terrain-agnostic BFS distance is still what nearestOwnedCoast /
  // isCoastal use elsewhere — this is specifically the open-water crossing.

  // OpenFront's AStarWater cost constants: 100 per tile moved, scaled up so
  // the magnitude penalty buckets (below) stay whole numbers.
  SEA_COST_SCALE: 100,

  // Weight >1 trades A*'s optimality guarantee for a much more directed
  // search — matches AStarWater's own default. A plain unweighted A* (or
  // BFS) explores every tied shortest path equally, which is what produced
  // the ruler-straight, coast-hugging routes this replaced.
  SEA_HEURISTIC_WEIGHT: 5,

  // AStarWater.getMagnitudePenalty verbatim: tiles under 3 from shore are
  // heavily taxed, 3-10 out is the free "sweet spot", beyond that a small
  // penalty for open blue water.
  shoreCostPenalty(dist) {
    if (dist < 3) return 10 * this.SEA_COST_SCALE;
    if (dist <= 10) return 0;
    return this.SEA_COST_SCALE;
  },

  // Scratch space seaPath reuses across calls, sized to the map and built on
  // first use (a match that never launches a boat never pays for it). The
  // heap is sized to the guard rather than the map: the search stops after
  // SEA_PATH_GUARD pops, and every pop can push at most 3 new tiles, so it
  // can never outgrow that bound.
  seaArena(size) {
    let a = this._seaArena;
    if (!a || a.size !== size) {
      const cap = this.SEA_PATH_GUARD * 4;
      a = this._seaArena = {
        size,
        hasG: new Uint8Array(size),
        closed: new Uint8Array(size),
        gVal: new Int32Array(size),
        from: new Int32Array(size),
        steps: new Int32Array(size),
        heapId: new Int32Array(cap),
        heapPri: new Int32Array(cap)
      };
    }
    return a;
  },

  // True once this tick's seaPath work has reached
  // SEA_PATH_NODE_BUDGET_PER_TICK, so no new search will start until the
  // next tick. Always false outside tick().
  seaPathBudgetSpent() {
    return this._inTick && this._seaPathNodesThisTick >= this.SEA_PATH_NODE_BUDGET_PER_TICK;
  },

  // Weighted A* over WATER tiles, seeded from every water tile adjacent to
  // `sourceTiles`, stopping the instant it pops a water tile adjacent to
  // `targetTile`. Returns the path as a tile sequence (water tiles, ending
  // on targetTile itself) or null if `targetTile` isn't coastal at all or no
  // route is found within the guard.
  //
  // `maxSteps` (optional) never extends a route past that many water tiles
  // from its start. A caller that will reject a long route anyway (the AI's
  // detour check) passes it so a target only reachable the long way round
  // fails fast instead of exhausting SEA_PATH_GUARD — measured on The World
  // at ~144ms per such failure, most of the AI's naval hitching. It also
  // shrinks the node guard (SEA_PATH_NODES_PER_STEP).
  seaPath(sourceTiles, targetTile, maxSteps = Infinity) {
    const owner = GameMap.owner, shoreDist = GameMap.shoreDist, w = GameMap.width;
    const nb = new Int32Array(4);

    const targetNb = GameMap.neighbors(targetTile, nb);
    const targetWater = new Set();
    for (let k = 0; k < targetNb; k++) if (owner[nb[k]] === WATER) targetWater.add(nb[k]);
    if (targetWater.size === 0) return null;

    const starts = [];
    for (const land of sourceTiles) {
      const n = GameMap.neighbors(land, nb);
      for (let k = 0; k < n; k++) if (owner[nb[k]] === WATER) starts.push(nb[k]);
    }
    if (starts.length === 0) return null;

    // Fast reject: two water tiles can only connect if they share a
    // waterComponentId (see GameMap.computeWaterComponents, same adjacency
    // this A* moves through below). Without this, a target on a separate
    // sea or a landlocked lake made the search below exhaust its entire
    // reachable side of the map — up to SEA_PATH_GUARD tiles — just to
    // prove there's no route; measured live at 20-40ms for a single call,
    // repeated across every boat/warship/trade-ship repath on the map, this
    // was the game's main remaining source of hitching.
    const wc = GameMap.waterComponentId;
    const targetComponents = new Set();
    for (const t of targetWater) targetComponents.add(wc[t]);
    if (!starts.some(s => targetComponents.has(wc[s]))) return null;

    // Past the fast reject, this is a real weighted A* over potentially
    // thousands of water tiles — budget how much of that runs per tick (see
    // SEA_PATH_NODE_BUDGET_PER_TICK) rather than let however many callers
    // happen to land on the same tick all pay the full cost at once.
    // Only inside tick() — see its _inTick comment.
    if (this._inTick) {
      if (this.seaPathBudgetSpent()) return null;
      this._seaPathSearchesThisTick++;
      this._seaPathNodesThisTick += this.SEA_PATH_SEARCH_COST;
    }

    const goalX = targetTile % w, goalY = (targetTile / w) | 0;

    // Cross-product tie-breaker needs one reference line — the start closest
    // to the goal, so the bias points along the route actually being sailed
    // rather than an arbitrary one among the attacker's coastal launch points.
    let s0 = starts[0], bestD = Infinity;
    for (const s of starts) {
      const sx = s % w, sy = (s / w) | 0;
      const d = Math.abs(sx - goalX) + Math.abs(sy - goalY);
      if (d < bestD) { bestD = d; s0 = s; }
    }
    const dxGoal = goalX - (s0 % w), dyGoal = goalY - ((s0 / w) | 0);
    const crossNorm = Math.max(1, Math.abs(dxGoal) + Math.abs(dyGoal));
    const COST_SCALE = this.SEA_COST_SCALE, BASE_COST = COST_SCALE, weight = this.SEA_HEURISTIC_WEIGHT;
    const crossTieBreaker = (nx, ny) => {
      const dxN = nx - goalX, dyN = ny - goalY;
      const cross = Math.abs(dxGoal * dyN - dyGoal * dxN);
      return Math.floor((cross * (COST_SCALE - 1)) / crossNorm / crossNorm);
    };

    // Search state lives in a reusable arena rather than a Map/Set/array trio
    // built and thrown away per call. A single search explores thousands of
    // water tiles, so those collections were the game's largest remaining
    // source of garbage once the repaint queue was fixed — with the AI
    // disabled a tick allocates nothing at all, and this is most of what the
    // AI's share was. Costs are bounded well inside Int32: SEA_PATH_GUARD
    // (200k) tiles at BASE_COST 100 plus at most a 1000 shore penalty each is
    // ~2.2e8 against a 2.1e9 ceiling.
    const arena = this.seaArena(owner.length);
    const hasG = arena.hasG, gVal = arena.gVal, from = arena.from, closed = arena.closed, steps = arena.steps;
    const heapId = arena.heapId, heapPri = arena.heapPri;
    // Only the flags need resetting; gVal/from are never read unless their
    // tile's flag says this search wrote them.
    hasG.fill(0); closed.fill(0);
    let heapLen = 0;

    const heapPush = (id, pri) => {
      let i = heapLen++;
      heapId[i] = id; heapPri[i] = pri;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapPri[p] <= heapPri[i]) break;
        const tid = heapId[p]; heapId[p] = heapId[i]; heapId[i] = tid;
        const tpr = heapPri[p]; heapPri[p] = heapPri[i]; heapPri[i] = tpr;
        i = p;
      }
    };
    const heapPop = () => {
      const top = heapId[0];
      const lastId = heapId[--heapLen], lastPri = heapPri[heapLen];
      if (heapLen > 0) {
        heapId[0] = lastId; heapPri[0] = lastPri;
        let i = 0;
        const n = heapLen;
        while (true) {
          let l = i * 2 + 1, r = l + 1, smallest = i;
          if (l < n && heapPri[l] < heapPri[smallest]) smallest = l;
          if (r < n && heapPri[r] < heapPri[smallest]) smallest = r;
          if (smallest === i) break;
          const tid = heapId[smallest]; heapId[smallest] = heapId[i]; heapId[i] = tid;
          const tpr = heapPri[smallest]; heapPri[smallest] = heapPri[i]; heapPri[i] = tpr;
          i = smallest;
        }
      }
      return top;
    };

    for (const s of starts) {
      if (hasG[s]) continue;
      hasG[s] = 1; gVal[s] = 0; from[s] = -1; steps[s] = 0;
      const sx = s % w, sy = (s / w) | 0;
      const h = weight * BASE_COST * (Math.abs(sx - goalX) + Math.abs(sy - goalY));
      heapPush(s, h);
    }

    let found = -1, guard = Math.min(this.SEA_PATH_GUARD, maxSteps * this.SEA_PATH_NODES_PER_STEP);
    const guardStart = guard;
    while (heapLen > 0 && guard-- > 0) {
      const current = heapPop();
      if (closed[current]) continue;
      closed[current] = 1;
      if (targetWater.has(current)) { found = current; break; }

      const currentG = gVal[current];
      const nextSteps = steps[current] + 1;
      if (nextSteps > maxSteps) continue;
      const n = GameMap.neighbors(current, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (owner[j] !== WATER || closed[j]) continue;
        const tentativeG = currentG + BASE_COST + this.shoreCostPenalty(shoreDist[j]);
        if (!hasG[j] || tentativeG < gVal[j]) {
          hasG[j] = 1; gVal[j] = tentativeG; from[j] = current; steps[j] = nextSteps;
          const jx = j % w, jy = (j / w) | 0;
          const h = weight * BASE_COST * (Math.abs(jx - goalX) + Math.abs(jy - goalY));
          heapPush(j, tentativeG + h + crossTieBreaker(jx, jy));
        }
      }
    }
    if (this._inTick) this._seaPathNodesThisTick += guardStart - Math.max(0, guard);
    if (found < 0) return null;

    const waterPath = [];
    let cur = found;
    while (cur !== -1) { waterPath.push(cur); cur = from[cur]; }
    waterPath.reverse();
    waterPath.push(targetTile);
    return this.smoothSeaPath(waterPath);
  },

  // Straightens the A* result into diagonal-looking runs without changing
  // its tile-density — render.js's boat trail and stepBoats' pos/BOAT_SPEED
  // both treat every path[] entry as one tile of travel, so smoothing has to
  // fill in every intermediate tile of the straightened line rather than
  // collapse to sparse corner waypoints. Two passes, loose then strict,
  // mirror SmoothingWaterTransformer's own two line-of-sight passes; the
  // deep local-A*-refinement pass it also runs near the two endpoints isn't
  // ported — shoreCostPenalty already keeps seaPath itself off the shore
  // near departure and arrival, which is what that pass exists to patch up.
  smoothSeaPath(path) {
    if (path.length <= 3) return path;
    const target = path[path.length - 1];
    let water = path.slice(0, -1);
    water = this.losSmoothSeaPath(water, 2);
    water = this.losSmoothSeaPath(water, 3);
    water.push(target);
    return water;
  },

  // Binary-searches, from each kept waypoint, the farthest later waypoint
  // with a clear (deep-enough) straight line to it, then replaces everything
  // in between with that literal line — retraceWaterLine's Bresenham walk —
  // so a wavy A* detour collapses into one taut diagonal stretch.
  losSmoothSeaPath(path, minShoreDist) {
    if (path.length <= 2) return path;
    const result = [path[0]];
    let current = 0;
    while (current < path.length - 1) {
      let lo = current + 1, hi = path.length - 1, farthest = lo;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.seaLineOfSight(path[current], path[mid], minShoreDist)) { farthest = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (farthest > current + 1) {
        const trace = this.retraceWaterLine(path[current], path[farthest], minShoreDist);
        for (let i = 1; i < trace.length - 1; i++) result.push(trace[i]);
      }
      current = farthest;
      result.push(path[current]);
    }
    return result;
  },

  seaLineOfSight(from, to, minShoreDist) {
    return this.retraceWaterLine(from, to, minShoreDist) !== null;
  },

  // Bresenham line from `from` to `to`, decomposing each diagonal step of
  // the ideal line into whichever of its two cardinal sub-tiles is passable
  // (falls back to the other), since this grid only has cardinal edges —
  // exactly SmoothingWaterTransformer's canSee/tracePath. Returns the full
  // tile sequence (inclusive of both ends) or null the moment the line
  // crosses land or water shallower than `minShoreDist`.
  retraceWaterLine(from, to, minShoreDist) {
    const w = GameMap.width, owner = GameMap.owner, shoreDist = GameMap.shoreDist;
    const passable = t => owner[t] === WATER && shoreDist[t] >= minShoreDist;

    let x = from % w, y = (from / w) | 0;
    const x1 = to % w, y1 = (to / w) | 0;
    const dx = Math.abs(x1 - x), dy = Math.abs(y1 - y);
    const sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
    let err = dx - dy;

    if (!passable(from)) return null;
    const tiles = [from];

    while (!(x === x1 && y === y1)) {
      const e2 = 2 * err;
      const moveX = e2 > -dy, moveY = e2 < dx;
      if (moveX && moveY) {
        x += sx; err -= dy;
        const mid = y * w + x;
        if (passable(mid)) {
          tiles.push(mid);
          y += sy; err += dx;
        } else {
          x -= sx; err += dy;
          y += sy; err += dx;
          const alt = y * w + x;
          if (!passable(alt)) return null;
          tiles.push(alt);
          x += sx; err -= dy;
        }
      } else if (moveX) {
        x += sx; err -= dy;
      } else {
        y += sy; err += dx;
      }
      const tile = y * w + x;
      if (!passable(tile)) return null;
      tiles.push(tile);
    }
    return tiles;
  },

});
