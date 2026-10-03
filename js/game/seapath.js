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
    // Battle Royale's dead zone (game/drill.js) is impassable: no route
    // starts, ends or runs through a dead water tile.
    const dead = this.drillDead;
    const nb = new Int32Array(4);

    const targetNb = GameMap.neighbors(targetTile, nb);
    const targetWater = new Set();
    for (let k = 0; k < targetNb; k++) if (owner[nb[k]] === WATER && !dead[nb[k]]) targetWater.add(nb[k]);
    if (targetWater.size === 0) return null;

    const starts = [];
    for (const land of sourceTiles) {
      const n = GameMap.neighbors(land, nb);
      for (let k = 0; k < n; k++) if (owner[nb[k]] === WATER && !dead[nb[k]]) starts.push(nb[k]);
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
        if (owner[j] !== WATER || closed[j] || dead[j]) continue;
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
    const w = GameMap.width, owner = GameMap.owner, shoreDist = GameMap.shoreDist, dead = this.drillDead;
    const passable = t => owner[t] === WATER && shoreDist[t] >= minShoreDist && !dead[t];

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

  // --- Closest reachable water (fog of war scouts, game/scouts.js) -----------
  //
  // seaPath answers "is there a route to this tile" and says no for land, for
  // a lake the ship cannot get into, and when its guard runs out. A Scout may
  // never be told no because of terrain — the refusal itself would say what is
  // under the fog (docs/fog-of-war.md) — so this is the search that always
  // has an answer: sail toward a tile, whatever it is, and end on the closest
  // water that can actually be reached.
  //
  // It is the same weighted A* as seaPath (same costs, heuristic weight,
  // tie-breaker and smoothing) with two differences.
  //
  // IT KEEPS THE BEST TILE IT HAS SEEN, by straight grid distance to what it
  // is steering for, and when it stops without arriving that tile is the
  // answer. What it steers for (the "aim") is the goal itself when the ship
  // can sail onto it; otherwise the nearest tile of the ship's own body of
  // water within SEA_TOWARD_SNAP_DIST of the goal — the exact closest
  // reachable water, found by a ring scan before the search starts, so a
  // click on land or on a lake has a real destination to path to. Only when
  // there is no such tile does the search run "blind": it steers at the goal
  // itself, which it can never reach, and settles for the best tile within
  // SEA_TOWARD_BLIND_NODES.
  //
  // IT NEVER EXCEEDS THE TICK'S SEA BUDGET. seaPath only checks the budget
  // before it starts and then runs to its own 200k guard in one go. This runs
  // in slices: seaTowardRun explores at most `slice` tiles per call, and
  // inside tick() only runs at all when the whole slice (plus the fixed cost,
  // on the first one) still fits in what SEA_PATH_NODE_BUDGET_PER_TICK has
  // left. The search state survives between calls, so a long route is found
  // over several ticks rather than not at all: the same 200k guard seaPath
  // has, spent a slice at a time. Either a slice runs whole or it does not
  // run, which keeps the route a ship gets independent of what else was
  // searching that tick; only when it gets it moves.
  //
  // That is what the separate arena below is for: seaPath's own is wiped by
  // every other search between one slice and the next. It holds ONE search at
  // a time — starting a second wipes the first — so the caller owns the
  // rule that only one is in flight (Game.scoutSearch).
  //
  // Deterministic: integer math over the map, a binary heap with a fixed push
  // order, nothing from Game.rng. The state object and the arena are sim
  // state like any other and are only advanced inside tick().
  SEA_TOWARD_SNAP_DIST: 256,
  SEA_TOWARD_BLIND_NODES: 40000,

  // The arena seaTowardRun searches in. `mark` bit 0: the tile has a cost and
  // a parent; bit 1: it is closed. Built on first use, so only a fog match
  // with a Scout in it ever has one. The heap is sized to the guard: every
  // pop pushes at most three tiles.
  _seaTowardArena: null,
  seaTowardArena(size) {
    let a = this._seaTowardArena;
    if (!a || a.size !== size) {
      const cap = this.SEA_PATH_GUARD * 3 + 4;
      a = this._seaTowardArena = {
        size,
        mark: new Uint8Array(size),
        gVal: new Int32Array(size),
        from: new Int32Array(size),
        heapId: new Int32Array(cap),
        heapPri: new Int32Array(cap)
      };
    }
    return a;
  },

  // A new search from water tile `fromTile` toward `goalTile` (any tile on
  // the map), not yet run. Costs nothing; seaTowardRun does the work.
  //   done       the search is over and seaTowardPath has its answer
  //   arrived    it ended on the tile it was steering for
  //   exhausted  it ended because there was no sea left to explore, so the
  //              best tile is the closest there is
  //   nodes      tiles explored so far
  seaTowardStart(fromTile, goalTile) {
    return {
      from: fromTile, goal: goalTile, aim: goalTile, reachable: false,
      begun: false, done: false, arrived: false, exhausted: false,
      limit: 0, nodes: 0, heapLen: 0, best: fromTile, bestH: 0
    };
  },

  // Advances search `st` by at most `slice` explored tiles. Returns true when
  // the search is over, false when it has more to do, and null when it did
  // nothing because this tick's sea budget has no room for the slice (ask
  // again next tick).
  seaTowardRun(st, slice) {
    if (st.done) return true;
    const owner = GameMap.owner, shoreDist = GameMap.shoreDist, w = GameMap.width, dead = this.drillDead;
    if (owner[st.from] !== WATER) { st.done = st.exhausted = true; return true; }

    const budget = this.SEA_PATH_NODE_BUDGET_PER_TICK;
    const fixed = st.begun ? 0 : this.SEA_PATH_SEARCH_COST;
    let cap = Math.max(1, Math.min(slice | 0, budget - this.SEA_PATH_SEARCH_COST));
    if (this._inTick) {
      if (this._seaPathNodesThisTick + fixed + cap > budget) return null;
      this._seaPathNodesThisTick += fixed;
      if (!st.begun) this._seaPathSearchesThisTick++;
    }

    const arena = this.seaTowardArena(owner.length);
    const mark = arena.mark, gVal = arena.gVal, from = arena.from;
    const heapId = arena.heapId, heapPri = arena.heapPri;
    let heapLen = st.heapLen;

    // The same binary heap as seaPath's.
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

    const COST_SCALE = this.SEA_COST_SCALE, BASE_COST = COST_SCALE, weight = this.SEA_HEURISTIC_WEIGHT;
    if (!st.begun) {
      st.begun = true;
      // What to steer for — see the section comment.
      const wc = GameMap.waterComponentId, comp = wc[st.from];
      st.reachable = wc[st.goal] === comp;
      if (!st.reachable) {
        const near = this.nearestWaterInComponent(st.goal, comp, this.SEA_TOWARD_SNAP_DIST);
        if (near >= 0) { st.aim = near; st.reachable = true; }
      }
      st.limit = st.reachable ? this.SEA_PATH_GUARD : this.SEA_TOWARD_BLIND_NODES;
      st.bestH = Math.abs((st.aim % w) - (st.from % w)) + Math.abs(((st.aim / w) | 0) - ((st.from / w) | 0));
      mark.fill(0);
      mark[st.from] = 1; gVal[st.from] = 0; from[st.from] = -1;
      heapPush(st.from, weight * BASE_COST * st.bestH);
    }

    const aim = st.aim, reachable = st.reachable;
    const goalX = aim % w, goalY = (aim / w) | 0;
    const dxGoal = goalX - (st.from % w), dyGoal = goalY - ((st.from / w) | 0);
    const crossNorm = Math.max(1, Math.abs(dxGoal) + Math.abs(dyGoal));
    let best = st.best, bestH = st.bestH;

    cap = Math.min(cap, st.limit - st.nodes);
    const nb = new Int32Array(4);
    let left = cap, arrived = false;
    while (heapLen > 0 && left > 0) {
      left--;
      const current = heapPop();
      if (mark[current] & 2) continue;
      mark[current] |= 2;
      if (reachable && current === aim) { arrived = true; break; }

      const currentG = gVal[current];
      const n = GameMap.neighbors(current, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (owner[j] !== WATER || (mark[j] & 2) || dead[j]) continue;
        const tentativeG = currentG + BASE_COST + this.shoreCostPenalty(shoreDist[j]);
        if (!mark[j] || tentativeG < gVal[j]) {
          mark[j] = 1; gVal[j] = tentativeG; from[j] = current;
          const dxN = (j % w) - goalX, dyN = ((j / w) | 0) - goalY;
          const h = Math.abs(dxN) + Math.abs(dyN);
          // The closest tile reached so far. Strictly closer only, so among
          // equals the first one the search came to wins.
          if (h < bestH) { bestH = h; best = j; }
          heapPush(j, tentativeG + weight * BASE_COST * h
            + Math.floor((Math.abs(dxGoal * dyN - dyGoal * dxN) * (COST_SCALE - 1)) / crossNorm / crossNorm));
        }
      }
    }
    const used = cap - left;
    st.nodes += used;
    st.heapLen = heapLen; st.best = best; st.bestH = bestH;
    if (this._inTick) this._seaPathNodesThisTick += used;

    if (arrived) st.done = st.arrived = true;
    else if (heapLen === 0) st.done = st.exhausted = true;
    else if (st.nodes >= st.limit) st.done = true;
    return st.done;
  },

  // The route a finished search found: water tiles from where it started to
  // its best tile, smoothed like a seaPath route. `[from]` alone when it found
  // nothing closer than where it started. Must be read before another search
  // starts in the arena.
  seaTowardPath(st) {
    if (!st.begun) return [st.from];
    const from = this._seaTowardArena.from;
    let path = [];
    for (let cur = st.best; cur !== -1; cur = from[cur]) path.push(cur);
    path.reverse();
    if (path.length > 3) path = this.losSmoothSeaPath(this.losSmoothSeaPath(path, 2), 3);
    return path;
  },

  // The closest tile to `tile` (straight grid distance, at most `maxDist`,
  // `tile` itself excluded) that belongs to water body `comp`, or -1. Walks
  // the diamond rings outward in a fixed order, so equal distances always
  // resolve the same way. Plain array reads, about 2 * maxDist^2 of them at
  // worst (131k at 256), which is what seaTowardRun's fixed cost pays for.
  nearestWaterInComponent(tile, comp, maxDist) {
    const w = GameMap.width, h = GameMap.height, wc = GameMap.waterComponentId;
    const tx = tile % w, ty = (tile / w) | 0;
    for (let d = 1; d <= maxDist; d++) {
      for (let dx = -d; dx <= d; dx++) {
        const x = tx + dx;
        if (x < 0 || x >= w) continue;
        const dy = d - (dx < 0 ? -dx : dx);
        if (ty - dy >= 0 && wc[(ty - dy) * w + x] === comp) return (ty - dy) * w + x;
        if (dy > 0 && ty + dy < h && wc[(ty + dy) * w + x] === comp) return (ty + dy) * w + x;
      }
    }
    return -1;
  },

});
