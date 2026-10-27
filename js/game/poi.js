// js/game/poi.js — Points of interest: Gold Deposits and Mountain Passes.
// Rules and placement are in docs/points-of-interest.md.
Object.assign(Game, {
  // { tile, kind: 'gold' | 'pass' }, in placement order. Empty unless the
  // match turned POIs on.
  pois: [],
  // Own rng stream, so POIs never shift any other roll in the match.
  POI_SEED_SALT: 0x5f3759df,
  POI_GOLD_PER_SEC: 500,
  POI_FORT_RANGE: 15,
  POI_SPAWN_CLEAR: 20,
  // A pass needs mountain within PASS_REACH tiles on both sides along one
  // axis, and PASS_OPEN tiles of open land both ways along the other.
  PASS_REACH: 8,
  PASS_OPEN: 3,
  POI_TRIES: 6000,

  poiCounts(landTiles) {
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    return {
      gold: clamp(Math.round(landTiles / 40000), 3, 14),
      pass: clamp(Math.round(landTiles / 90000), 2, 8)
    };
  },

  // `spawns` is every starting spawn tile (humans' reserves and NPCs').
  initPOIs(on, seed, spawns) {
    this.pois = [];
    if (!on) return;
    const rng = mulberry32((seed ^ this.POI_SEED_SALT) >>> 0);
    const c = this.poiCounts(GameMap.landTiles);
    const spacing = Math.sqrt(GameMap.landTiles / (c.gold + c.pass)) * 0.8;
    // Passes first: valid sites are rare, so they get the first pick.
    this.placePOIs('pass', c.pass, rng, spawns, spacing);
    this.placePOIs('gold', c.gold, rng, spawns, spacing);
  },

  placePOIs(kind, count, rng, spawns, spacing) {
    const w = GameMap.width, h = GameMap.height;
    const clear2 = this.POI_SPAWN_CLEAR * this.POI_SPAWN_CLEAR;
    let placed = 0;
    // Spacing relaxes when the map can't fit them all; spawn clearance doesn't.
    for (let attempt = 0; attempt < 4 && placed < count; attempt++, spacing *= 0.7) {
      const sp2 = spacing * spacing;
      for (let guard = 0; guard < this.POI_TRIES && placed < count; guard++) {
        const x = 6 + Math.floor(rng() * (w - 12));
        const y = 6 + Math.floor(rng() * (h - 12));
        const i = y * w + x;
        if (!GameMap.isLand(i)) continue;
        if (kind === 'gold' ? GameMap.landAround(x, y, 5) < 90 : !this.isPass(x, y)) continue;
        if (this.nearAny(x, y, spawns, clear2)) continue;
        let ok = true;
        for (const q of this.pois) {
          const dx = q.tile % w - x, dy = ((q.tile / w) | 0) - y;
          if (dx * dx + dy * dy < sp2) { ok = false; break; }
        }
        if (!ok) continue;
        this.pois.push({ tile: i, kind });
        placed++;
      }
    }
  },

  nearAny(x, y, tiles, r2) {
    const w = GameMap.width;
    for (const t of tiles) {
      const dx = t % w - x, dy = ((t / w) | 0) - y;
      if (dx * dx + dy * dy < r2) return true;
    }
    return false;
  },

  isPass(x, y) {
    const i = y * GameMap.width + x;
    if (GameMap.terrain[i] === MOUNTAIN) return false;
    const R = this.PASS_REACH, O = this.PASS_OPEN;
    return (this.passWall(x, y, 1, 0, R) && this.passWall(x, y, -1, 0, R)
        && this.passOpen(x, y, 0, 1, O) && this.passOpen(x, y, 0, -1, O))
      || (this.passWall(x, y, 0, 1, R) && this.passWall(x, y, 0, -1, R)
        && this.passOpen(x, y, 1, 0, O) && this.passOpen(x, y, -1, 0, O));
  },

  // Mountain within `reach` steps, with only land on the way.
  passWall(x, y, dx, dy, reach) {
    for (let k = 1; k <= reach; k++) {
      const nx = x + dx * k, ny = y + dy * k;
      if (nx < 0 || ny < 0 || nx >= GameMap.width || ny >= GameMap.height) return false;
      const j = ny * GameMap.width + nx;
      if (!GameMap.isLand(j)) return false;
      if (GameMap.terrain[j] === MOUNTAIN) return true;
    }
    return false;
  },

  // `len` steps of land that isn't mountain.
  passOpen(x, y, dx, dy, len) {
    for (let k = 1; k <= len; k++) {
      const nx = x + dx * k, ny = y + dy * k;
      if (nx < 0 || ny < 0 || nx >= GameMap.width || ny >= GameMap.height) return false;
      const j = ny * GameMap.width + nx;
      if (!GameMap.isLand(j) || GameMap.terrain[j] === MOUNTAIN) return false;
    }
    return true;
  },

  // A human spawn this close would start on top of a POI.
  poiNear(tile, r) {
    if (!this.pois.length) return false;
    const w = GameMap.width;
    const tiles = this.pois.map(q => q.tile);
    return this.nearAny(tile % w, (tile / w) | 0, tiles, r * r);
  },

  poiGoldPerSecond(p) {
    let n = 0;
    for (const q of this.pois) if (q.kind === 'gold' && GameMap.owner[q.tile] === p.id) n++;
    return n * this.POI_GOLD_PER_SEC;
  },

  // True when a pass held by `ownerId` covers `tile`. Read by fortInRange.
  poiFortInRange(tile, ownerId) {
    const w = GameMap.width, tx = tile % w, ty = (tile / w) | 0;
    const r2 = this.POI_FORT_RANGE * this.POI_FORT_RANGE;
    for (const q of this.pois) {
      if (q.kind !== 'pass' || GameMap.owner[q.tile] !== ownerId) continue;
      const dx = q.tile % w - tx, dy = ((q.tile / w) | 0) - ty;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }
});
