// js/game/rail.js — Rail network & trains.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Rail network & trains ------------------------------------------------
  // Ported against OpenFront's actual FactoryExecution / TrainStationExecution
  // / TrainExecution / RailNetworkImpl / TrainStation / Config.ts source
  // (github.com/openfrontio/OpenFrontIO), not guessed, with deliberate scope
  // cuts made and noted where they happen:
  //  - Rails connect ANY nearby City/Factory (own, enemy, or neutral) exactly
  //    like the real RailNetworkImpl.connectToNearbyStations/
  //    computeGhostRailPaths, which apply no owner filter at all to the
  //    physical network. Trade is likewise open with everyone by default
  //    (tradeAvailable, mirroring TrainStation.tradeAvailable) unless one
  //    side has embargoed the other — a bot's factory will happily route a
  //    train to your city, paying BOTH of you, exactly like
  //    TradeStationStopHandler's two-way payout. Only the "team" tier is
  //    missing from trainGold's rate table, since there's no team system
  //    here, only alliance (self/ally/other).
  //  - No minimum connection range. OpenFront's own RailNetworkImpl skips a
  //    candidate closer than trainStationMinRange (15 tiles), which sounds
  //    like a reasonable "don't draw a silly one-tile stub" guard but has a
  //    sharp edge: a Factory built close beside the very Cities it exists to
  //    connect can end up isolated from all of them while they connect to
  //    each other instead, because they're near enough to fail ITS distance
  //    check but still just far enough apart to pass each other's. Since
  //    this game's whole point for a Factory is "connect the cities near
  //    it," leaving it possible for the nearest ones to be exactly the ones
  //    it refuses to link is a bug here even though it's just an edge case
  //    in OpenFront's own much bigger world map — so this game drops the
  //    minimum entirely instead of porting it.
  //  - Rails are strictly horizontal/vertical, laid as a single elbow bend
  //    (one straight leg each way) rather than OpenFront's diagonal-capable
  //    weighted AStar.Rail — an explicit style choice for this game (real
  //    rail-map look, no diagonals) rather than a fidelity simplification.
  //    See orthogonalPath.
  //
  // A Factory becomes a station the instant it finishes construction, and it
  // recruits every City within range into the network too — even ones built
  // long before it (FactoryExecution.createStation). A City built later
  // checks the reverse: is a Factory already close enough to plug it in. A
  // City the network never reaches just never spawns or earns anything —
  // only a Factory ever originates a train (see updateFactoryStations),
  // exactly like OpenFront's own City/Port stations, which are trade
  // destinations only and never spawnTrains themselves.
  //
  // Range/hop constants below are lifted verbatim from Config.ts's
  // trainStationMaxRange/railroadMaxSize and RailNetworkImpl's own
  // maxConnectionDistance — unscaled, because MAP_SIZES already ports
  // OpenFront's real map dimensions tile-for-tile, so their absolute tile
  // radii need no rescaling to mean the same thing here.
  TRAIN_STATION_MAX_RANGE: 110,
  RAILROAD_MAX_TILES: Math.round(110 * 1.4142),   // trainStationMaxRange() * 1.4142
  RAIL_MAX_CONNECTION_HOPS: 4,

  tileDistSq(a, b) {
    const w = GameMap.width;
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  },

  // Fires once, the instant a city or factory finishes construction (see
  // updateConstruction) — never on capture and never on upgrade.
  onStructureCompleted(b) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    if (b.type === 'factory') {
      this.becomeStation(b);
      for (const other of this.buildings.values()) {
        if (other === b || other.station || !other.built) continue;
        // Fort is a defensive-only structure — never a rail station, matching
        // previewFactoryConnections' own city/factory/port-only filter (this
        // loop previously had no type filter at all, so a Fort near a
        // completing Factory silently became a station despite the preview
        // never showing that line).
        if (other.type !== 'city' && other.type !== 'factory' && other.type !== 'port') continue;
        if (this.tileDistSq(b.tile, other.tile) <= range * range) this.becomeStation(other);
      }
    } else if (b.type === 'city' || b.type === 'port') {
      // PortExecution.createStation checks the identical condition City's
      // own TrainStationExecution does — join only if a Factory is already
      // in range — so Port rides the same branch rather than a copy of it.
      for (const other of this.buildings.values()) {
        if (other.type !== 'factory' || !other.built) continue;
        if (this.tileDistSq(b.tile, other.tile) <= range * range) { this.becomeStation(b); break; }
      }
    }
  },

  // Marks `b` a station and links it into whatever nearby same-owner stations
  // it can reach — see linkStationToNetwork. Idempotent: a station recruited
  // twice (a City in range of two different Factories, say) only runs the
  // linking pass once.
  becomeStation(b) {
    if (b.station) return;
    b.station = true;
    this.linkStationToNetwork(b);
  },

  // RailNetworkImpl.connectToNearbyStations, minus the "snap onto the middle
  // of an existing rail" refinement (connectToExistingRails) — a real but
  // rare optimization OpenFront uses to keep dense networks from crossing
  // themselves; skipping it just means two stations occasionally get a
  // slightly longer point-to-point rail instead of branching off an existing
  // one partway along. Also minus their minimum-range skip — see the class
  // comment for why that's dropped rather than ported. Still skips a
  // candidate already reachable within RAIL_MAX_CONNECTION_HOPS hops, so the
  // graph stays sparse rather than fully meshed — a new station still gets a
  // link to its actual nearest neighbours, just not to every station in
  // range.
  linkStationToNetwork(station) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    const candidates = [];
    for (const other of this.buildings.values()) {
      if (!other.station || other === station) continue;
      const d = this.tileDistSq(station.tile, other.tile);
      if (d > range * range) continue;
      candidates.push({ b: other, d });
    }
    candidates.sort((x, y) => x.d - y.d);

    for (const { b: other } of candidates) {
      const hops = this.stationHopDistance(station.tile, other.tile, this.RAIL_MAX_CONNECTION_HOPS);
      if (hops !== -1) continue;
      this.connectStations(station, other);
    }
  },

  // Read-only preview of the rail lines a hypothetical new station at `tile`
  // would draw to EXISTING stations — shared by both previewFactoryConnections
  // and previewCityConnections, since linkStationToNetwork treats a fresh
  // City-that-just-qualified and a fresh Factory identically once each is
  // actually becoming a station. No owner filter, matching linkStationToNetwork
  // (own/enemy/neutral stations all preview) — see the class comment. Same
  // hop-dedup linkStationToNetwork applies for real: a candidate already
  // within RAIL_MAX_CONNECTION_HOPS-1 hops of one this preview already
  // "linked" is skipped, since it would be reachable through that neighbour
  // once the new station's own edge to it exists (the -1 accounts for that
  // one extra hop through the new hub).
  previewStationLinks(tile) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    const lines = [];

    const stationCandidates = [];
    for (const other of this.buildings.values()) {
      if (!other.station || !other.built) continue;
      if (this.tileDistSq(tile, other.tile) > range * range) continue;
      stationCandidates.push(other);
    }
    stationCandidates.sort((a, b) => this.tileDistSq(tile, a.tile) - this.tileDistSq(tile, b.tile));

    const linked = [];
    for (const other of stationCandidates) {
      const alreadyReachable = linked.some(s =>
        this.stationHopDistance(other.tile, s.tile, this.RAIL_MAX_CONNECTION_HOPS - 1) !== -1);
      if (alreadyReachable) continue;
      const path = this.orthogonalPath(tile, other.tile);
      if (path) { lines.push(path); linked.push(other); }
    }

    return lines;
  },

  // Read-only preview of what placing a Factory at `tile` would connect to —
  // Render's placement ghost calls this to draw candidate rail lines before
  // the player commits. Mirrors onStructureCompleted's factory branch
  // against the REAL, unmutated rail graph rather than actually building
  // anything: previewStationLinks covers the "link to nearby EXISTING
  // stations" half, and the loop below covers the other half a Factory does
  // that a City/Port never does — recruiting non-station City/Factory/Port
  // buildings in range, own/enemy/neutral alike (see the class comment). In
  // the common case (nothing nearby connected yet) each one's own real
  // linkStationToNetwork call finds the new factory as its nearest station
  // and links straight to it, so every one of them gets a preview line too,
  // without the hop-dedup pass (it doesn't apply until a candidate is
  // already a station). The type filter here has to list every recruitable
  // type explicitly, unlike onStructureCompleted's own factory branch (no
  // filter at all) — a real gap that once meant a Port sitting near a
  // freshly-placed Factory drew no preview line even though it would
  // actually join the network the instant that Factory finished building.
  previewFactoryConnections(tile) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    const lines = this.previewStationLinks(tile);

    for (const other of this.buildings.values()) {
      if (other.station || !other.built) continue;
      if (other.type !== 'city' && other.type !== 'factory' && other.type !== 'port') continue;
      if (this.tileDistSq(tile, other.tile) > range * range) continue;
      const path = this.orthogonalPath(tile, other.tile);
      if (path) lines.push(path);
    }

    return lines;
  },

  // Read-only preview of what placing a City (or a Port — see
  // onStructureCompleted, which treats them identically for station-joining)
  // at `tile` would connect to. Unlike a Factory, neither one recruits
  // anyone — per onStructureCompleted's shared branch it doesn't even join
  // the network itself unless a Factory (own, enemy, or neutral — see the
  // class comment) is ALREADY within range, so this returns no lines at all
  // (nothing to preview) until that condition is met, then defers to the
  // same previewStationLinks a Factory placement uses.
  previewCityConnections(tile) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    let factoryInRange = false;
    for (const other of this.buildings.values()) {
      if (other.type !== 'factory' || !other.built) continue;
      if (this.tileDistSq(tile, other.tile) <= range * range) { factoryInRange = true; break; }
    }
    return factoryInRange ? this.previewStationLinks(tile) : [];
  },

  // BFS over the existing rail graph, capped at maxHops — RailNetworkImpl's
  // own distanceFrom, used only to decide whether a NEW link is worth adding
  // (see linkStationToNetwork), not for train routing (findStationPath below
  // is uncapped).
  stationHopDistance(fromTile, toTile, maxHops) {
    if (fromTile === toTile) return 0;
    const visited = new Set([fromTile]);
    let frontier = [fromTile];
    for (let dist = 1; dist <= maxHops; dist++) {
      const next = [];
      for (const t of frontier) {
        const b = this.buildings.get(t);
        if (!b) continue;
        for (const n of b.rails.keys()) {
          if (n === toTile) return dist;
          if (!visited.has(n)) { visited.add(n); next.push(n); }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return -1;
  },

  // Builds one rail edge between two stations along an axis-aligned elbow
  // path (see orthogonalPath) and records it on both stations' adjacency
  // plus the flat railroads[] list Render draws from. No-op if no clear
  // orthogonal corridor exists in either bend orientation, or the path would
  // run longer than RAILROAD_MAX_TILES — mirrors RailNetworkImpl.connect's
  // own path.length < railroadMaxSize guard. Each station's rails Map stores
  // the small waypoint list itself (2 or 3 tiles: station, optional elbow,
  // station) — cheap to keep in full, unlike a per-cell walk would be —
  // oriented FROM that station, so buildTrainRoute can concatenate hops
  // directly without re-deriving direction.
  connectStations(a, b) {
    if (a.rails.has(b.tile)) return false;
    const waypoints = this.orthogonalPath(a.tile, b.tile);
    if (!waypoints || this.pathLength(waypoints) > this.RAILROAD_MAX_TILES) return false;
    const id = this.nextRailId++;
    this.railroads.push({ id, a: a.tile, b: b.tile, waypoints });
    a.rails.set(b.tile, waypoints);
    b.rails.set(a.tile, [...waypoints].reverse());
    return true;
  },

  // Every tile along a horizontal run at fixed y from x0 to x1, or a
  // vertical run at fixed x from y0 to y1 (caller guarantees exactly one of
  // x0===x1 / y0===y1 holds) — true the instant one of them isn't land.
  // Battle Royale's dead zone (game/drill.js) blocks a rail like water does.
  straightClear(x0, y0, x1, y1) {
    const w = GameMap.width, dead = this.drillDead;
    if (y0 === y1) {
      const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      for (let x = lo; x <= hi; x++) if (!GameMap.isLand(y0 * w + x) || dead[y0 * w + x]) return false;
    } else {
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      for (let y = lo; y <= hi; y++) if (!GameMap.isLand(y * w + x0) || dead[y * w + x0]) return false;
    }
    return true;
  },

  // The land counterpart of retraceWaterLine's diagonal Bresenham walk, but
  // deliberately NOT diagonal: builds a single-bend "elbow" path between two
  // stations, one straight horizontal leg and one straight vertical leg, so
  // every rail this game draws runs strictly up/down or left/right — a
  // classic rail-map look rather than OpenFront's own diagonal-capable
  // AStar.Rail (see the class comment). Tries horizontal-then-vertical
  // first, then vertical-then-horizontal, since a water obstacle might block
  // one bend but not the other; returns null only if both do. Two stations
  // already sharing a row or column degenerate to a single straight leg with
  // no elbow at all.
  orthogonalPath(from, to) {
    const w = GameMap.width;
    const ax = from % w, ay = (from / w) | 0, bx = to % w, by = (to / w) | 0;
    if (ax === bx || ay === by) {
      return this.straightClear(ax, ay, bx, by) ? [from, to] : null;
    }
    const elbowH = GameMap.idx(bx, ay);   // horizontal leg first: from -> (bx,ay) -> to
    if (this.straightClear(ax, ay, bx, ay) && this.straightClear(bx, ay, bx, by)) {
      return [from, elbowH, to];
    }
    const elbowV = GameMap.idx(ax, by);   // vertical leg first: from -> (ax,by) -> to
    if (this.straightClear(ax, ay, ax, by) && this.straightClear(ax, by, bx, by)) {
      return [from, elbowV, to];
    }
    return null;
  },

  // Sum of Euclidean segment lengths across a waypoint list — for
  // axis-aligned legs this equals each leg's tile count, so it plays the
  // same role landLine's path.length used to for the RAILROAD_MAX_TILES cap.
  pathLength(waypoints) {
    let len = 0;
    for (let i = 0; i + 1 < waypoints.length; i++) {
      len += Math.sqrt(this.tileDistSq(waypoints[i], waypoints[i + 1]));
    }
    return len;
  },

  // Shortest hop path of station TILES from `fromTile` to `toTile` over the
  // full rail graph — unlike stationHopDistance this has no cap, since a
  // train has to reach wherever its destination actually is. Plays the role
  // of PathFinding.Stations at this game's scale (a handful of stations per
  // empire, not the thousands OpenFront's real maps can carry).
  findStationPath(fromTile, toTile) {
    if (fromTile === toTile) return [fromTile];
    const cameFrom = new Map([[fromTile, -1]]);
    const queue = [fromTile];
    let head = 0;
    while (head < queue.length) {
      const t = queue[head++];
      const b = this.buildings.get(t);
      if (!b) continue;
      for (const n of b.rails.keys()) {
        if (cameFrom.has(n)) continue;
        cameFrom.set(n, t);
        if (n === toTile) {
          const path = [n];
          let cur = t;
          while (cur !== -1) { path.push(cur); cur = cameFrom.get(cur); }
          path.reverse();
          return path;
        }
        queue.push(n);
      }
    }
    return null;
  },

  // --- Trains ----------------------------------------------------------------
  // trainSpawnRate/trainGold ported verbatim from Config.ts — neither is
  // scaled by POP_SCALE, matching GOLD_PER_SEC's own comment that gold prices
  // have no such constraint. TRAIN_SPEED follows the same conversion
  // BOAT_SPEED already documents: OpenFront moves a train 2 tiles per tick
  // (TrainExecution's own `speed = 2`) at their 10-ticks/sec, i.e. 20
  // tiles/sec — a straight port, not a re-tuned dial.
  TRAIN_SPEED: 20,
  TRAIN_SPAWN_COOLDOWN: 1,        // seconds; ticksCooldown=10 @ 10 ticks/sec
  // Config.ts's trainGold baseGold per relation. Real source also has a
  // "team" tier (25000, same as "other") but this game has no team system,
  // only alliance — see tradeRel. Note "self" pays the LEAST: OpenFront
  // deliberately rewards trading across borders more than trading with your
  // own cities, which is what makes bots' trains actually go somewhere
  // interesting instead of only ever shuttling gold to themselves.
  TRAIN_GOLD_SELF_BASE: 10000,
  TRAIN_GOLD_OTHER_BASE: 25000,
  TRAIN_GOLD_ALLY_BASE: 35000,
  TRAIN_GOLD_FREE_STOPS: 9,
  TRAIN_GOLD_DIST_PENALTY: 5000,
  TRAIN_GOLD_FLOOR: 5000,

  // OpenFront counts trains in Unit entities — engine, tail engine and 5
  // cars — and its saturation curve is tuned in those units. Our train is
  // one object, so it converts at this rate.
  TRAIN_UNITS_PER_TRAIN: 7,

  // Config.ts's trainSaturation verbatim: up to 1.5x spawns for the first
  // trains (~1x around 5 trains), a damping sigmoid past a 560-unit
  // midpoint, and a 0.25 plateau that collapses past ~900 units.
  trainSaturation(numTrainUnits) {
    const boost = 1 + 0.5 * this.det.exp(-numTrainUnits / 30);
    const damping = 1 - this.sigmoid(numTrainUnits, Math.LN2 / 100, 560);
    const plateau = 0.25 * (1 - this.sigmoid(numTrainUnits, Math.LN2 / 150, 900));
    return boost * Math.max(damping, plateau);
  },

  // Config.ts's trainSpawnRate: hyperbolic decay, midpoint at 10 factories,
  // divided by the world-wide saturation. Returned as a 1-in-N chance,
  // consumed by updateFactoryStations below.
  trainSpawnRate(numFactories, numTrains) {
    const rate = (numFactories + 10) * 15;
    return Math.max(1, Math.floor(rate / this.trainSaturation(numTrains * this.TRAIN_UNITS_PER_TRAIN)));
  },

  // TrainStation.tradeAvailable: a station trades with its own owner, and
  // with anyone Game.canTrade allows — open by default, closed by an
  // embargo from either side (see the Embargoes section in diplomacy.js).
  tradeAvailable(stationOwnerId, trainOwnerId) {
    return stationOwnerId === trainOwnerId || this.canTrade(stationOwnerId, trainOwnerId);
  },

  // The rate tier for a stop — TrainStation's rel(). Checked before
  // areAllied, which is also true for teammates (game/teams.js): upstream
  // pays a teammate's stop at the "other" rate, not the alliance one.
  tradeRel(a, b) {
    if (a === b) return 'self';
    if (this.onSameTeam(a, b)) return 'team';
    return this.areAllied(a, b) ? 'ally' : 'other';
  },

  // Config.ts's trainGold. No penalty for the first 9 stops on a trip; each
  // one after costs 5000, floored at 5000. `stopsVisited` is the count
  // BEFORE this stop, matching TradeStationStopHandler reading
  // tradeStopsVisited() before stationReached() increments it — see
  // stepTrains.
  trainGold(stopsVisited, rel) {
    const base = rel === 'ally' ? this.TRAIN_GOLD_ALLY_BASE
      : rel === 'self' ? this.TRAIN_GOLD_SELF_BASE
      : this.TRAIN_GOLD_OTHER_BASE;
    const penalty = Math.max(0, stopsVisited - this.TRAIN_GOLD_FREE_STOPS) * this.TRAIN_GOLD_DIST_PENALTY;
    return Math.max(this.TRAIN_GOLD_FLOOR, base - penalty);
  },

  // unitCount(UnitType.Factory) — a built headcount, not the sum-of-levels
  // unitsOwned uses for cost/pop, since a level-3 factory should spawn like
  // one factory feeding three rolls (see updateFactoryStations' `b.level`
  // loop), not count as three factories toward the spawn-rate denominator.
  factoryCount(p) {
    let n = 0;
    for (const b of this.buildings.values()) {
      if (b.type === 'factory' && b.built && GameMap.owner[b.tile] === p.id) n++;
    }
    return n;
  },

  // Cluster.hasAnyTradeDestination + randomTradeDestination collapsed into
  // one reservoir-sampling BFS: walk the rail graph from `station` and
  // sample among reachable City OR Port stations (TradeStationStopHandler
  // covers both in the real source — see stepTrains) of ANY owner — own,
  // allied, or enemy alike, as long as tradeAvailable allows it (no
  // embargo either way). This is what makes a bot's factory route
  // trains to a human player's cities/ports (and vice versa) whenever rails
  // happen to connect them, not just its own. Live ownership, not whoever
  // owned a station when the rail was laid, is why a captured factory can
  // immediately start trading with its new owner's other stations over
  // rails an old regime built.
  pickTrainDestination(station) {
    const ownerId = GameMap.owner[station.tile];
    const visited = new Set([station.tile]);
    let frontier = [station.tile];
    let chosen = null, seen = 0;
    while (frontier.length) {
      const next = [];
      for (const t of frontier) {
        const b = this.buildings.get(t);
        if (!b) continue;
        for (const n of b.rails.keys()) {
          if (visited.has(n)) continue;
          visited.add(n);
          next.push(n);
          const nb = this.buildings.get(n);
          if (nb && (nb.type === 'city' || nb.type === 'port') &&
              this.tradeAvailable(GameMap.owner[n], ownerId)) {
            seen++;
            if (this.rng() * seen < 1) chosen = nb;
          }
        }
      }
      frontier = next;
    }
    return chosen;
  },

  // Expands a station-hop path into the FULL waypoint list a train actually
  // travels — each hop's small elbow path (station, optional bend, station;
  // see connectStations) concatenated end to end, skipping each segment's
  // repeated leading tile — plus `cum`, the cumulative straight-line
  // distance at every waypoint including the elbow bends, and `stops`, the
  // cumulative distance recorded only at each intermediate/final STATION for
  // stepTrains' arrival check (a bend is geometry, not a place a train stops
  // or earns anything). Distance rather than a per-tile array index is what
  // lets a train travel (and Render draw it, via trainTilePos) along the
  // real orthogonal legs instead of snapping tile-to-tile.
  buildTrainRoute(stationTiles) {
    const waypoints = [stationTiles[0]];
    const cum = [0];
    const stops = [];
    for (let i = 0; i + 1 < stationTiles.length; i++) {
      const from = this.buildings.get(stationTiles[i]);
      const seg = from.rails.get(stationTiles[i + 1]);
      if (!seg) return null;
      // seg[0] === stationTiles[i], already the last waypoint pushed.
      for (let k = 1; k < seg.length; k++) {
        cum.push(cum[cum.length - 1] + Math.sqrt(this.tileDistSq(waypoints[waypoints.length - 1], seg[k])));
        waypoints.push(seg[k]);
      }
      stops.push({ dist: cum[cum.length - 1], tile: stationTiles[i + 1] });
    }
    return { waypoints, cum, stops };
  },

  // Continuous tile-space position of a train along its route, for Render to
  // project onto the screen — walking `cum` to find which straight leg
  // `pos` currently falls in, rather than indexing a discrete per-tile
  // path, so the dot glides smoothly along the real horizontal/vertical
  // segments (and pivots cleanly at each elbow) drawRailroads renders.
  trainTilePos(t) {
    const w = GameMap.width, cum = t.cum, wp = t.waypoints;
    let i = 0;
    while (i < cum.length - 2 && t.pos >= cum[i + 1]) i++;
    const segLen = cum[i + 1] - cum[i];
    const frac = segLen > 0 ? Math.min(1, (t.pos - cum[i]) / segLen) : 1;
    const a = wp[i], b = wp[i + 1];
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    return { x: ax + (bx - ax) * frac, y: ay + (by - ay) * frac };
  },

  spawnTrain(station, destStation, ownerId) {
    const stationTiles = this.findStationPath(station.tile, destStation.tile);
    if (!stationTiles || stationTiles.length < 2) return false;
    const route = this.buildTrainRoute(stationTiles);
    if (!route) return false;
    this.trains.push({
      id: this.nextTrainId++, owner: ownerId,
      waypoints: route.waypoints, cum: route.cum, stops: route.stops,
      pos: 0, nextStop: 0, stopsVisited: 0
    });
    return true;
  },

  // TrainStationExecution.tick, run for every built factory station every
  // tick. Only rolls once the cooldown since its last train has elapsed,
  // then retries every tick after that until a roll lands — matching their
  // own "lastSpawnTick + ticksCooldown" gate followed by an unconditional
  // per-tick shouldSpawnTrain() call. The destination is picked BEFORE
  // rolling (hasAnyTradeDestination is checked first in the real source too)
  // so an empire with nowhere to trade never burns a roll on it.
  updateFactoryStations() {
    for (const b of this.buildings.values()) {
      if (b.type !== 'factory' || !b.station) continue;
      if (this.elapsed - b.lastTrainAt < this.TRAIN_SPAWN_COOLDOWN) continue;
      const owner = GameMap.owner[b.tile];
      const p = this.players[owner];
      if (!p || !p.alive) continue;

      const dest = this.pickTrainDestination(b);
      if (!dest) continue;

      const spawnRate = this.trainSpawnRate(this.factoryCount(p), this.trains.length);
      let roll = false;
      for (let i = 0; i < b.level; i++) {
        if (this.rng() < 1 / spawnRate) { roll = true; break; }
      }
      if (!roll) continue;

      if (this.spawnTrain(b, dest, owner)) b.lastTrainAt = this.elapsed;
    }
  },

  // TrainExecution.tick's per-tick advance, folded together with
  // stationReached/TradeStationStopHandler — every stop the train's `pos`
  // crosses this tick pays out (or not) in the same pass, so a train moving
  // fast enough to cross two close-together stations in one tick still pays
  // both instead of only the one nearest the end of the step.
  stepTrains() {
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i];
      // TrainExecution.canTradeWithDestination: a train only rolls on toward
      // a station that will still trade with it. An embargo declared while
      // it's under way ends the trip at the last stop it reached.
      if (t.nextStop < t.stops.length &&
          !this.tradeAvailable(GameMap.owner[t.stops[t.nextStop].tile], t.owner)) {
        this.trains.splice(i, 1);
        continue;
      }
      t.pos += this.TRAIN_SPEED * this.TICK_DT;

      while (t.nextStop < t.stops.length && t.pos >= t.stops[t.nextStop].dist) {
        const stop = t.stops[t.nextStop++];
        const b = this.buildings.get(stop.tile);
        // FactoryStopHandler is a no-op in the real source — only City and
        // Port use TradeStationStopHandler and actually pay out. Station
        // owner is read live at arrival, not whoever owned it when the train
        // departed (same capture-friendly rule as pickTrainDestination).
        if (b && (b.type === 'city' || b.type === 'port')) {
          const stationOwnerId = GameMap.owner[stop.tile];
          const rel = this.tradeRel(t.owner, stationOwnerId);
          const gold = this.trainGold(t.stopsVisited, rel);
          // TradeStationStopHandler: the train's own player always earns the
          // trip's gold, and if the station belongs to someone else, THEY
          // separately earn the same amount — a real two-way payout, not a
          // toll, which is why a foreign train rolling through your city is
          // a good thing for you.
          const trainP = this.players[t.owner];
          if (trainP) trainP.gold += gold;
          if (stationOwnerId !== t.owner) {
            const stationP = this.players[stationOwnerId];
            if (stationP) stationP.gold += gold;
          }
          t.stopsVisited++;
          // Recorded for every station owner alike, whoever they are. The
          // renderer shows the local viewer only their own payouts (a payout
          // at a foreign or allied city isn't the player's money to watch tick
          // up) — but that filter belongs at draw time, not here: a sim branch
          // on Game.me would make this line compute differently on every
          // client. See js/fx.js.
          Fx.goldPopup(stop.tile, gold, stationOwnerId);
        }
      }

      if (t.nextStop >= t.stops.length) this.trains.splice(i, 1);
    }
  },

});
