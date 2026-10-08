// js/game/rail.js — Rail network & trains.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Rail network & trains ------------------------------------------------
  //  - Rails connect ANY nearby station (own, enemy or neutral); the
  //    physical network has no owner filter. Trade is open with everyone by
  //    default (tradeAvailable) unless one side has embargoed the other, and
  //    a train stop pays both ends.
  //  - No minimum connection range: with one, a Factory built close beside
  //    the Cities it exists to connect could end up isolated from them.
  //  - Rails are strictly horizontal/vertical, laid as a single elbow bend
  //    (see orthogonalPath). A style choice.
  //
  // A Factory becomes a station the instant it finishes and recruits every
  // City within range, even ones built long before it. A City built later
  // checks the reverse. Only a Factory ever originates a train (see
  // updateFactoryStations); Cities and Ports are destinations only.
  //
  // Range/hop constants are in tiles.
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
    // RailNetworkImpl.connectStation: a station beside an existing rail joins
    // that rail and lays nothing new; only otherwise does it reach out to
    // nearby stations.
    if (!this.snapToExistingRails(b)) this.linkStationToNetwork(b);
  },

  // RailNetworkImpl's stationRadius: a new station this close to an existing
  // rail splices into it instead of laying rails of its own.
  RAIL_SNAP_RADIUS: 3,

  // Every existing rail passing within RAIL_SNAP_RADIUS of `tile`, with
  // where a station there would splice in: `leg` is the index of the rail
  // leg holding the closest point, and `path` runs from that point to `tile`
  // (one tile when `tile` is on the rail, otherwise a short axis-aligned
  // spur). A rail whose closest point is one of its own ends is left alone,
  // as is one whose spur would cross water.
  railSnapPoints(tile) {
    const w = GameMap.width, sx = tile % w, sy = (tile / w) | 0;
    const r2 = this.RAIL_SNAP_RADIUS * this.RAIL_SNAP_RADIUS;
    const out = [];
    for (const rail of this.railroads) {
      if (rail.a === tile || rail.b === tile) continue;
      const wp = rail.waypoints;
      let best = r2 + 1, leg = -1, at = -1;
      for (let k = 0; k + 1 < wp.length; k++) {
        const x1 = wp[k] % w, y1 = (wp[k] / w) | 0;
        const x2 = wp[k + 1] % w, y2 = (wp[k + 1] / w) | 0;
        const px = Math.max(Math.min(x1, x2), Math.min(sx, Math.max(x1, x2)));
        const py = Math.max(Math.min(y1, y2), Math.min(sy, Math.max(y1, y2)));
        const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
        if (d < best) { best = d; leg = k; at = py * w + px; }
      }
      if (leg === -1 || at === rail.a || at === rail.b) continue;
      const path = at === tile ? [tile] : this.orthogonalPath(at, tile);
      if (path) out.push({ rail, leg, path });
    }
    return out;
  },

  // RailNetworkImpl.connectToExistingRails: each rail passing beside the new
  // station is cut in two at its closest point, and both halves now end at
  // the station. Returns whether any rail was spliced. Trains already under
  // way keep the route they left with.
  snapToExistingRails(station) {
    let snapped = false;
    for (const { rail, leg, path } of this.railSnapPoints(station.tile)) {
      const a = this.buildings.get(rail.a), b = this.buildings.get(rail.b);
      if (!a || !b) continue;
      this.railroads.splice(this.railroads.indexOf(rail), 1);
      a.rails.delete(rail.b);
      b.rails.delete(rail.a);
      const wp = rail.waypoints;
      this.addRail(a, station, wp.slice(0, leg + 1).concat(path));
      this.addRail(station, b, [...path].reverse().concat(wp.slice(leg + 1)));
      snapped = true;
    }
    return snapped;
  },

  // RailNetworkImpl.removeStation/disconnectFromNetwork: a destroyed
  // station's rails go with it. Call before the building leaves
  // Game.buildings.
  removeStationRails(b) {
    if (!b.rails || b.rails.size === 0) return;
    for (const n of b.rails.keys()) {
      const other = this.buildings.get(n);
      if (other) other.rails.delete(b.tile);
    }
    b.rails.clear();
    for (let i = this.railroads.length - 1; i >= 0; i--) {
      const rr = this.railroads[i];
      if (rr.a === b.tile || rr.b === b.tile) this.railroads.splice(i, 1);
    }
  },

  // For a station that had no rail to snap onto (see becomeStation). Skips
  // a candidate already reachable within RAIL_MAX_CONNECTION_HOPS hops, so
  // the graph stays sparse: a new station links to its nearest neighbours,
  // not to every station in range.
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

  // Read-only preview of the rail lines a new station at `tile` would draw
  // to EXISTING stations; shared by previewFactoryConnections and
  // previewCityConnections. No owner filter, and the same hop-dedup as
  // linkStationToNetwork: a candidate within RAIL_MAX_CONNECTION_HOPS-1 hops
  // of one already 'linked' here is skipped (the -1 is the extra hop
  // through the new hub).
  previewStationLinks(tile) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    const lines = [];

    // A station here would splice into the rail beside it and lay nothing
    // new (computeGhostRailPaths' canSnapToExistingRailway early-out); the
    // only thing to show is the spur, if the tile is off the rail.
    const snaps = this.railSnapPoints(tile);
    if (snaps.length) {
      for (const s of snaps) if (s.path.length > 1) lines.push(s.path);
      return lines;
    }

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

  // Read-only preview of what placing a Factory at `tile` would connect to,
  // for Render's placement ghost. Mirrors onStructureCompleted's factory
  // branch against the real, unmutated rail graph: previewStationLinks
  // covers links to existing stations, and the loop below covers what only
  // a Factory does, recruiting non-station City/Factory/Port buildings in
  // range (any owner). The type filter must list every recruitable type
  // explicitly, or a Port near the Factory draws no preview line.
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

  // Read-only preview of what placing a City or Port at `tile` would
  // connect to. Neither recruits anyone, and neither joins the network
  // unless a Factory (any owner) is ALREADY within range; until then this
  // returns no lines. After that it defers to previewStationLinks.
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

  // Builds one rail edge between two stations along an elbow path (see
  // orthogonalPath) and records it on both stations' adjacency plus the
  // flat railroads[] list Render draws from. No-op if neither bend
  // orientation has a clear corridor, or the path would exceed
  // RAILROAD_MAX_TILES. Each station's rails Map stores the waypoint list
  // (station, optional elbow, station) oriented FROM that station, so
  // buildTrainRoute can concatenate hops directly.
  connectStations(a, b) {
    if (a.rails.has(b.tile)) return false;
    const waypoints = this.orthogonalPath(a.tile, b.tile);
    if (!waypoints || this.pathLength(waypoints) > this.RAILROAD_MAX_TILES) return false;
    return this.addRail(a, b, waypoints);
  },

  // Records a rail running a -> b along `waypoints` (a.tile first, b.tile
  // last; repeated tiles are dropped). One rail per station pair.
  addRail(a, b, waypoints) {
    if (a.rails.has(b.tile)) return false;
    waypoints = waypoints.filter((t, i) => i === 0 || t !== waypoints[i - 1]);
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

  // Builds a single-bend 'elbow' path between two stations: one straight
  // horizontal leg and one straight vertical leg, never a diagonal. Tries
  // horizontal-then-vertical, then vertical-then-horizontal, since water
  // might block one bend but not the other; null only if both are blocked.
  // Two stations sharing a row or column get a single straight leg.
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
  // Train gold is not scaled by POP_SCALE. TRAIN_SPEED is in tiles/sec
  // (2 tiles per tick).
  TRAIN_SPEED: 20,
  TRAIN_SPAWN_COOLDOWN: 1,        // seconds; ticksCooldown=10 @ 10 ticks/sec
  // Train gold per relation. 'self' pays the LEAST: trading across borders
  // is deliberately rewarded more than trading with your own cities.
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

  // One reservoir-sampling BFS: walk the rail graph from `station` and
  // sample among reachable City or Port stations of ANY owner that
  // tradeAvailable allows (no embargo either way). Ownership is read live,
  // so a captured factory at once trades with its new owner's stations over
  // rails the old owner built.
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

  // Expands a station-hop path into the FULL waypoint list a train travels
  // (each hop's elbow path concatenated, skipping each segment's repeated
  // leading tile), plus `cum`, the cumulative distance at every waypoint
  // including bends, and `stops`, the cumulative distance at each STATION,
  // for stepTrains' arrival check. Distance, not a tile index, is what lets
  // a train move (and Render draw it, via trainTilePos) along the real legs.
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

  // Run for every built factory station every tick. Only rolls once the
  // cooldown since its last train has elapsed, then retries every tick
  // until a roll lands. The destination is picked BEFORE rolling, so an
  // empire with nowhere to trade never burns a roll.
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
          // Recorded for every station owner alike. The renderer filters to
          // the local viewer at draw time; a sim branch on Game.me would make
          // this compute differently on every client. See js/fx.js.
          Fx.goldPopup(stop.tile, gold, stationOwnerId);
        }
      }

      if (t.nextStop >= t.stops.length) this.trains.splice(i, 1);
    }
  },

});
