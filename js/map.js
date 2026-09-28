const WATER = -2;
const NEUTRAL = -1;

// OpenFront's three land terrains. Costlier ground is also slower ground —
// the two values move together, so rough country resists on both axes.
const PLAINS = 0, HIGHLAND = 1, MOUNTAIN = 2;

const GameMap = {
  width: 0,
  height: 0,
  elevation: null,  // Float32Array, 0..1 (land only meaningful above sea level)
  owner: null,      // Int16Array: WATER, NEUTRAL, or player index
  shoreDist: null,  // Uint8Array, water tiles only: tile-distance to nearest land
  landTiles: 0,

  // Default share of the grid that should end up as land. A fixed sea level
  // let the noise decide how much land a seed produced, and it varied 4-5x at
  // the same map size — an Extra Large roll could come out smaller than a
  // median Large and play like one. Match length follows land area, so that
  // variance landed straight on pacing. Each landform scales this (see
  // landformPlan), and the lobby's Land knob scales it again (LAND_SCALE).
  LAND_FRACTION: 0.40,

  // --- Generator options -----------------------------------------------------
  //
  // The lobby's "Map options" arrive as gameStartInfo.config.mapGen:
  // { landform, land, terrain, rivers, coast }. Protocol.MAP_GEN whitelists the
  // same names on the server; resolveGenOptions falls back to the defaults for
  // anything unrecognised, so a missing or stale config still builds a map.
  // See docs/procedural-maps.md for what each landform and knob does.
  LANDFORMS: ['continent', 'twin', 'continents', 'archipelago', 'pangaea', 'inland'],
  // How often 'random' picks each landform, in LANDFORMS order.
  LANDFORM_WEIGHTS: [24, 20, 20, 12, 14, 10],
  LAND_SCALE: { scarce: 0.65, normal: 1, abundant: 1.35 },
  // [highland share, mountain share] of land; see classifyTerrain.
  TERRAIN_SHARES: { flat: [0.14, 0.03], normal: [0.26, 0.10], rugged: [0.32, 0.16], alpine: [0.36, 0.24] },
  // [rivers-per-landmass multiplier, how far upstream a river reaches].
  RIVER_OPTIONS: { none: [0, 0.04], few: [0.5, 0.06], normal: [1, 0.04], many: [2, 0.022] },
  // Coastline character: octaves and contrast of the elevation noise, and how
  // far (as a fraction of map width) the continent outlines are bent.
  COAST_OPTIONS: {
    smooth: { octaves: 3, contrast: 2.0, warp: 0.04 },
    normal: { octaves: 5, contrast: 2.6, warp: 0.10 },
    jagged: { octaves: 7, contrast: 3.6, warp: 0.22 }
  },

  // Integer hash of the seed into [0, 1). Map generation runs in the sim, so it
  // must never touch Game.rng (that would shift every later draw); every
  // per-seed choice comes from here instead, each with its own `n`.
  seedHash(seed, n) {
    let x = Math.imul((seed | 0) ^ Math.imul(n, 0x9E3779B1), 0x85EBCA6B);
    x ^= x >>> 15; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 13;
    return (x >>> 0) / 4294967296;
  },

  resolveGenOptions(seed, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const has = (table, v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(table, v);
    let landform = this.LANDFORMS.includes(o.landform) ? o.landform : null;
    if (!landform) {
      let total = 0;
      for (const wt of this.LANDFORM_WEIGHTS) total += wt;
      let r = this.seedHash(seed, 100) * total;
      landform = this.LANDFORMS[this.LANDFORMS.length - 1];
      for (let k = 0; k < this.LANDFORMS.length; k++) {
        r -= this.LANDFORM_WEIGHTS[k];
        if (r < 0) { landform = this.LANDFORMS[k]; break; }
      }
    }
    return {
      landform: landform,
      land: has(this.LAND_SCALE, o.land) ? o.land : 'normal',
      terrain: has(this.TERRAIN_SHARES, o.terrain) ? o.terrain : 'normal',
      rivers: has(this.RIVER_OPTIONS, o.rivers) ? o.rivers : 'normal',
      coast: has(this.COAST_OPTIONS, o.coast) ? o.coast : 'normal'
    };
  },

  // Every landform is built from "plates": seed points that each grow one
  // landmass under a radial falloff (d = 1 at the plate's radii). With more
  // than one plate, every tile belongs to its nearest plate, and a strait is
  // sunk along the borders between them, so the landmasses never fuse and
  // crossing one always means a naval landing. Plate positions, sizes and
  // counts are fractions of the map, never tile counts, so the same seed and
  // options draw the same shapes at every map size (the lobby preview relies
  // on that).
  landformPlan(seed, landform, width, height) {
    const h = n => this.seedHash(seed, 200 + n);
    const cx = width / 2, cy = height / 2;
    const plan = {
      plates: null, land: this.LAND_FRACTION, featureScale: 5,
      falloffStart: 0.55, falloffStrength: 1.4, edgeStart: 0.9,
      strait: 0, straitSlope: 8, lakes: 0, innerSea: null
    };
    const plate = (x, y, rx, ry, weight) => ({ x, y, rx, ry, weight });

    if (landform === 'continent') {
      // One central continent, off-centre and out of round by seed.
      plan.featureScale = 4.2 + h(1) * 1.8;
      plan.plates = [plate(cx + (h(2) - 0.5) * width * 0.1, cy + (h(3) - 0.5) * height * 0.1,
        cx * (0.82 + h(4) * 0.3), cy * (0.82 + h(5) * 0.3), 1)];
    } else if (landform === 'twin') {
      // Two equal continents facing each other across a strait whose width
      // varies by seed: some get a narrow crossing, others a real sea.
      plan.plates = [plate(width / 4, cy, width / 4, cy, 1), plate(width * 3 / 4, cy, width / 4, cy, 1)];
      plan.strait = width * 0.015 * (0.6 + h(6) * 1.2);
    } else if (landform === 'continents') {
      // Three to five continents of uneven size.
      const count = 3 + Math.floor(h(7) * 3);
      plan.featureScale = 5 + h(8) * 1.5;
      plan.plates = this.scatterPlates(seed, count, width, height, 0.16, 0.22, 0.56, 0.75, 0.5);
      plan.strait = width * 0.012 * (0.7 + h(9) * 1.0);
    } else if (landform === 'archipelago') {
      // Many islands, from a few big ones to scattered small ones.
      const count = 14 + Math.floor(h(10) * 15);
      plan.featureScale = 8 + h(11) * 3;
      plan.plates = this.scatterPlates(seed, count, width, height, 0.07, 0.1, 0.7, 0.5, 1.3);
      plan.land = 0.28;
      plan.falloffStart = 0.15;
      plan.falloffStrength = 1.3;
      plan.strait = width * 0.005 * (0.8 + h(12) * 0.8);
      plan.straitSlope = 4;
    } else if (landform === 'pangaea') {
      // One supercontinent running nearly to the map edges, pocked with
      // inland seas and lakes.
      plan.featureScale = 4 + h(13) * 1.5;
      plan.plates = [plate(cx, cy, cx * 1.05, cy * 1.05, 1)];
      plan.land = 0.58;
      plan.falloffStart = 0.72;
      plan.edgeStart = 0.94;
      plan.lakes = 0.8 + h(14) * 0.8;
    } else {
      // 'inland': a ring of land around a central sea, opened to the ocean by
      // one channel pointing a seed-chosen way. The direction is a unit vector
      // from t = tan(angle/2) using only + * / (see rangeShape for why no trig).
      const t = h(15) * 2 - 1, k = 1 + t * t, flip = h(16) < 0.5 ? -1 : 1;
      plan.featureScale = 5 + h(17) * 1.2;
      plan.plates = [plate(cx, cy, cx * 0.95, cy * 0.95, 1)];
      plan.innerSea = {
        radius: 0.34 + h(18) * 0.12,
        dx: flip * (1 - t * t) / k, dy: flip * 2 * t / k,
        channel: 0.07 + h(19) * 0.05
      };
    }
    return plan;
  },

  // `count` plates spread over the map by best-candidate sampling (each new
  // one is the farthest of a dozen tries from those already placed), so they
  // tile the map loosely instead of clumping. Each plate's radius is a share
  // of the gap to its nearest neighbour, jittered by `sizeJitter` so they
  // come out uneven; `weight` sets its share of the land.
  scatterPlates(seed, count, width, height, marginX, marginY, reach, aspectJitter, sizeJitter) {
    let n = 300;
    const next = () => this.seedHash(seed, n++);
    const x0 = width * marginX, x1 = width * (1 - marginX);
    const y0 = height * marginY, y1 = height * (1 - marginY);
    const pts = [];
    for (let k = 0; k < count; k++) {
      let bx = 0, by = 0, bestD = -1;
      for (let tries = k === 0 ? 1 : 12; tries > 0; tries--) {
        const px = x0 + (x1 - x0) * next(), py = y0 + (y1 - y0) * next();
        let dmin = Infinity;
        for (const q of pts) {
          const dx = px - q.x, dy = py - q.y, d = dx * dx + dy * dy;
          if (d < dmin) dmin = d;
        }
        if (dmin > bestD) { bestD = dmin; bx = px; by = py; }
      }
      pts.push({ x: bx, y: by });
    }
    return pts.map(p => {
      let nn = Infinity;
      for (const q of pts) {
        if (q === p) continue;
        const dx = p.x - q.x, dy = p.y - q.y, d = dx * dx + dy * dy;
        if (d < nn) nn = d;
      }
      nn = Math.sqrt(nn);
      const size = 1 + (next() - 0.5) * sizeJitter;
      const r = nn * reach * size;
      return {
        x: p.x, y: p.y,
        rx: r * (1 + (next() - 0.5) * aspectJitter), ry: r * (1 + (next() - 0.5) * aspectJitter) * 0.8,
        weight: size
      };
    });
  },

  // A slowly varying 2D offset, sampled on a coarse grid (read back with
  // bilinear interpolation, like rangeLowFreq) and applied to the point each
  // plate's falloff is measured from. It bends continent outlines into
  // peninsulas and bays, and makes the straits between plates meander.
  outlineWarp(width, height, seed, amp) {
    const stride = Math.max(1, Math.round(width / 250));
    const gw = Math.ceil((width - 1) / stride) + 2, gh = Math.ceil((height - 1) / stride) + 2;
    const grid = new Float32Array(gw * gh * 2);
    const f = 2.2 / width, a = amp * width * 2;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const u = gx * stride * f, v = gy * stride * f * 1.6, o = (gy * gw + gx) * 2;
        grid[o] = (Noise.fractal(u, v, seed + 501, 3) - 0.5) * a;
        grid[o + 1] = (Noise.fractal(u, v, seed + 502, 3) - 0.5) * a;
      }
    }
    return { stride, gw, grid };
  },

  generate(width, height, seed, genOptions) {
    this.width = width;
    this.height = height;
    const size = width * height;
    this.elevation = new Float32Array(size);
    this.owner = new Int16Array(size);
    this._region = new Int32Array(size);
    this._queue = new Int32Array(size);

    const opts = this.genOptions = this.resolveGenOptions(seed, genOptions);
    this.layout = opts.landform;
    const plan = this.landformPlan(seed, opts.landform, width, height);
    const coast = this.COAST_OPTIONS[opts.coast];
    const shares = this.TERRAIN_SHARES[opts.terrain];
    // 'normal' terrain wanders a little by seed; the named settings don't.
    const jitter = opts.terrain === 'normal' ? 1 : 0;
    this.highlandShare = shares[0] + (this.seedHash(seed, 110) - 0.5) * 0.08 * jitter;
    this.mountainShare = shares[1] + (this.seedHash(seed, 111) - 0.5) * 0.06 * jitter;
    const rivers = this.RIVER_OPTIONS[opts.rivers];
    this.riverScale = rivers[0];
    this.riverShare = rivers[1];

    const scale = plan.featureScale / width;
    const cx = width / 2, cy = height / 2;
    const plates = plan.plates, P = plates.length;
    const warp = this.outlineWarp(width, height, seed, coast.warp);
    // Distance between each pair of plates, for the strait test below.
    const pairDist = new Float64Array(P * P);
    for (let a = 0; a < P; a++) {
      for (let b = 0; b < P; b++) {
        const dx = plates[a].x - plates[b].x, dy = plates[a].y - plates[b].y;
        pairDist[a * P + b] = Math.sqrt(dx * dx + dy * dy);
      }
    }
    // Which plate each tile belongs to; P marks the strait between plates.
    const plateOf = P > 1 ? new Uint8Array(size) : null;
    const lakeScale = scale * 2.6, inner = plan.innerSea;

    // Independent field driving terrain *tier* (plains vs highland vs
    // mountain) — deliberately decoupled from `elevation` below.
    // classifyTerrain used to slice tiers off elevation's own percentiles,
    // but elevation is dominated by the radial falloff (built to shape the
    // coastline, high in the middle by construction), so mountains and
    // highlands always collapsed into one contiguous blob near the landmass
    // centre. This is a height field of its own, built to read like a
    // topographic map — see rangeRoughness for the rules it follows.
    this.roughness = new Float32Array(size);
    const shape = this.rangeShape(seed);
    const low = this.rangeLowFreq(width, height, seed, scale * 1.6, shape);
    const { stride: ws, gw: wgw, grid: wg } = warp;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        // Octave averaging pulls values toward 0.5, so expand contrast back out.
        let e = (Noise.fractal(x * scale, y * scale * 1.6, seed, coast.octaves) - 0.5) * coast.contrast + 0.55;

        // Warped sample point for the plate falloff (bilinear read of the grid).
        const gx = (x / ws) | 0, gy = (y / ws) | 0;
        const fx = x / ws - gx, fy = y / ws - gy;
        const o00 = (gy * wgw + gx) * 2, o10 = o00 + 2, o01 = o00 + wgw * 2, o11 = o01 + 2;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const px = x + wg[o00] * w00 + wg[o10] * w10 + wg[o01] * w01 + wg[o11] * w11;
        const py = y + wg[o00 + 1] * w00 + wg[o10 + 1] * w10 + wg[o01 + 1] * w01 + wg[o11 + 1] * w11;

        // Nearest and second-nearest plate.
        let a = 0, b = -1, da = Infinity, db = Infinity;
        for (let k = 0; k < P; k++) {
          const dx = px - plates[k].x, dy = py - plates[k].y, d = dx * dx + dy * dy;
          if (d < da) { db = da; b = a; da = d; a = k; } else if (d < db) { db = d; b = k; }
        }
        const pl = plates[a];
        const nx = (px - pl.x) / pl.rx, ny = (py - pl.y) / pl.ry;
        const d = Math.sqrt(nx * nx + ny * ny);
        e -= Math.max(0, d - plan.falloffStart) * plan.falloffStrength;

        if (plateOf) {
          // Distance from the warped point to the border with the next plate
          // (the perpendicular bisector between the two plate centres).
          const gap = (db - da) / (2 * pairDist[a * P + b]);
          plateOf[i] = gap < plan.strait ? P : a;
          // Slope the land down into the strait, so the noise draws a real
          // coast there instead of the strait's hard edge clipping one.
          // Eased (squared) so the slope has no hard start line of its own.
          const k = Math.max(0, 1 - gap / (plan.strait * plan.straitSlope));
          e -= k * k * 1.2;
        }

        if (inner) {
          // Central sea: sink everything inside its radius, and cut the channel
          // out to the ocean along the chosen direction.
          e -= Math.max(0, inner.radius - d) * 3;
          const along = nx * inner.dx + ny * inner.dy;
          if (along > 0) {
            const across = Math.abs(ny * inner.dx - nx * inner.dy);
            const k = Math.max(0, 1 - across / inner.channel);
            e -= k * 1.2;
          }
        }
        if (plan.lakes) {
          const l = Noise.fractal(x * lakeScale, y * lakeScale * 1.6, seed + 4242, 3);
          e -= Math.max(0, l - 0.6) * plan.lakes * 4;
        }

        // Keep open ocean around the map border whatever the plates do. A
        // rounded square (x^4 + y^4), so land squeezed into a corner doesn't
        // take on a right-angled coast.
        const ex = (x - cx) / cx, ey = (y - cy) / cy, ex2 = ex * ex, ey2 = ey * ey;
        e -= Math.max(0, Math.sqrt(Math.sqrt(ex2 * ex2 + ey2 * ey2)) - plan.edgeStart) * 8;

        this.elevation[i] = e;
        this.roughness[i] = this.rangeRoughness(x * scale * 1.6, y * scale * 1.6, seed, shape, low, x, y);
      }
    }

    // Raise or lower the sea until the land is the size we want.
    const target = Math.round(size * Math.min(0.7, plan.land * this.LAND_SCALE[opts.land]));
    if (plateOf) {
      this.balancePlates(plateOf, plates, target);
      // Sunk below anything the search can reach, so plates never fuse.
      for (let i = 0; i < size; i++) if (plateOf[i] === P) this.elevation[i] = -10;
    }
    // One continent is sized by its main landmass: dropping the sea can spawn
    // separate islands that get pruned away, so only the connected mass is a
    // meaningful target. Multi-plate maps count every landmass that survives
    // pruning, since the land is meant to be spread across them.
    this._measureKept = P > 1;
    const best = this.findSeaLevel(target);

    this.largestLandmassAt(best);
    this.pruneSmallLandmasses(this.MIN_LANDMASS_TILES);
    // Estuaries turn land into water, which can pinch off a sliver of coast,
    // so landmasses are relabelled and re-pruned after carving.
    if (this.riverScale > 0 && this.carveRivers(seed)) {
      this._labelRegions();
      this.pruneSmallLandmasses(this.MIN_LANDMASS_TILES);
    }
    this.classifyTerrain();
    this.computeShoreDist();
    this.computeWaterComponents();
    return this.landTiles;
  },

  // Gives each plate its share of the land before the global sea level search,
  // so no plate comes out swamped or bone dry just because its noise ran wetter
  // or drier. Each plate should cover about the same fraction of its own cell,
  // scaled by its weight, and its elevation is shifted so the level that
  // floods all but that fraction lands on one common value. The strait tiles
  // between plates hide the steps this leaves at the borders. Capped well
  // short of a full cell, or a plate fills it and its coast is just the
  // straight strait edge. Percentiles come off a strided sample, like
  // classifyTerrain's.
  balancePlates(plateOf, plates, target) {
    const size = this.width * this.height, P = plates.length;
    const counts = new Float64Array(P);
    let total = 0, meanWeight = 0;
    for (let i = 0; i < size; i++) if (plateOf[i] < P) { counts[plateOf[i]]++; total++; }
    for (const p of plates) meanWeight += p.weight / P;
    const shift = new Float32Array(P);
    for (let k = 0; k < P; k++) {
      if (!counts[k]) continue;
      const stride = Math.max(1, Math.floor(counts[k] / 4000));
      const sample = [];
      let seen = 0;
      for (let i = 0; i < size; i++) {
        if (plateOf[i] === k && seen++ % stride === 0) sample.push(this.elevation[i]);
      }
      sample.sort((a, b) => a - b);
      const share = Math.max(0.05, Math.min(0.6, target / total * plates[k].weight / meanWeight));
      // The clamp stops a plate that is mostly sea (one squeezed against the
      // map edge) being lifted until the edge falloff draws its coast square.
      const s = 0.5 - sample[Math.min(sample.length - 1, Math.floor(sample.length * (1 - share)))];
      shift[k] = Math.max(-0.35, Math.min(0.25, s));
    }
    for (let i = 0; i < size; i++) if (plateOf[i] < P) this.elevation[i] += shift[plateOf[i]];
  },

  // Per-seed character of the terrain: which way the ranges run, how tightly
  // they're stretched, and how big the hills are. Integer hash of the seed
  // only — this runs in the sim, so it must not touch Game.rng.
  rangeShape(seed) {
    const h = n => {
      let x = Math.imul((seed | 0) ^ Math.imul(n, 0x9E3779B1), 0x85EBCA6B);
      x ^= x >>> 15; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 13;
      return (x >>> 0) / 4294967296;
    };
    // Grain direction as a unit vector from t = tan(angle/2), t in [-1, 1]:
    // that spans every orientation a ridge can have (lines repeat every half
    // turn) using only + * / — Math.cos/sin are allowed to differ in the last
    // bit between browsers, and one flipped tile would desync lockstep.
    const t = h(1) * 2 - 1, k = 1 + t * t;
    return {
      stretch: 1.3 + h(2) * 0.4,   // >1 elongates hills along the grain into ridges
      warp: 0.25 + h(3) * 0.15,    // how far the grain bends across the map
      scale: 1.5 + h(4) * 0.5,     // hill size: low = broad massifs, high = finer ridges
      cos: (1 - t * t) / k, sin: 2 * t / k
    };
  },

  // The warp is slow noise, so it is sampled on a coarse grid and
  // interpolated per tile rather than evaluated at every tile — on xlarge
  // that was a large share of generation time. Stride is 1 (exact) through
  // 750 wide and grows with the map, keeping ~125 tiles per feature.
  rangeLowFreq(width, height, seed, uvScale, shape) {
    const stride = Math.max(1, Math.round(width / 500));
    const gw = Math.ceil((width - 1) / stride) + 2, gh = Math.ceil((height - 1) / stride) + 2;
    const grid = new Float32Array(gw * gh * 2);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const u = gx * stride * uvScale * 0.5, v = gy * stride * uvScale * 0.5, o = (gy * gw + gx) * 2;
        grid[o] = (Noise.fractal(u, v, seed + 111, 2) - 0.5) * 2 * shape.warp;
        grid[o + 1] = (Noise.fractal(u, v, seed + 222, 2) - 0.5) * 2 * shape.warp;
      }
    }
    return { stride, gw, grid };
  },

  // Roughness at (u, v) in noise space; classifyTerrain slices tiers off it.
  // Tiers are level sets of a real height field, so they follow the rules of
  // a topographic map rather than the rules of noise:
  //  - No swirls or folds. The field is never bent hard: the warp only nudges
  //    the sample point (capped in rangeShape), because bending past about a
  //    third of a feature size folds the terrain into marbled whorls.
  //  - One grain across the whole map. Ranges, ridges and spurs in a real
  //    region all run the same way, so coordinates are stretched along a
  //    single seed-wide direction. It must be uniform — rotating it from place
  //    to place shears the noise into combed-hair swirls.
  //  - Steep ground is smooth, gentle ground is detailed (Noise.eroded).
  //  - Valleys drain outward. Ridged noise put ridges on a field's
  //    zero-crossings, which are always closed loops, so every range ringed a
  //    plain and maps were full of same-shaped sealed "bowls". A height field
  //    has real peaks and slopes instead: mountains sit inside highland,
  //    highland inside plains, and low ground runs out to the coast.
  rangeRoughness(u, v, seed, shape, low, x, y) {
    // Bilinear read of the coarse warp grid at tile (x, y).
    const { stride, gw, grid } = low;
    const gx = (x / stride) | 0, gy = (y / stride) | 0;
    const fx = x / stride - gx, fy = y / stride - gy;
    const o00 = (gy * gw + gx) * 2, o10 = o00 + 2, o01 = o00 + gw * 2, o11 = o01 + 2;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const pu = u + grid[o00] * w00 + grid[o10] * w10 + grid[o01] * w01 + grid[o11] * w11;
    const pv = v + grid[o00 + 1] * w00 + grid[o10 + 1] * w10 + grid[o01 + 1] * w01 + grid[o11 + 1] * w11;

    const a = (pu * shape.cos + pv * shape.sin) / shape.stretch;
    const b = (-pu * shape.sin + pv * shape.cos) * Math.sqrt(shape.stretch);
    return Noise.eroded(a * shape.scale, b * shape.scale, seed + 7000, 5, 0.5, 0.45);
  },

  // Below this, a landmass is dropped to water rather than kept as an island.
  // findSpawns' own landAround(x,y,5) >= 90 gate already requires a candidate
  // spawn centre to sit in a locally dense 11x11 patch of land, so anything
  // this small could never host a spawn anyway — this floor exists purely to
  // keep pixel-speck islands (and the coastline noise they'd add to sea
  // pathfinding) out of the map, not to gate spawning.
  MIN_LANDMASS_TILES: 70,

  // Raw bytes + manifest for OpenFront's real "World" map, handed off by
  // js/net/worldmap.js (ordinary client code — fetch() has no business in
  // this file, see its own comment) once fetched. loadWorld reads this
  // rather than taking a URL, so the file stays free of any network call.
  worldData: null,

  // Parses OpenFront's baked map.bin format (1 byte/tile, row-major):
  // bit 7 = land, bit 6 = shoreline, bit 5 = ocean, bits 0-4 = magnitude
  // (elevation on land, distance-to-land on water — see map-generator's
  // packTerrain in the OpenFrontIO repo). Land/water and magnitude are all
  // this needs; shoreline/ocean flags and the water magnitude are re-derived
  // by computeShoreDist/computeWaterComponents below exactly as generate()
  // does for a procedural map, so both paths feed Game.seaPath identical data.
  loadWorld(bytes, manifest) {
    const width = manifest.width, height = manifest.height;
    const size = width * height;
    if (bytes.length !== size) {
      throw new Error(`GameMap.loadWorld: expected ${size} bytes for ${width}x${height}, got ${bytes.length}`);
    }
    this.width = width;
    this.height = height;
    this.elevation = new Float32Array(size);
    this.owner = new Int16Array(size);
    this.roughness = new Float32Array(size);
    this._region = new Int32Array(size);
    this._queue = new Int32Array(size);
    this.genOptions = null;
    this.layout = 'world';
    this.highlandShare = this.HIGHLAND_SHARE;
    this.mountainShare = this.MOUNTAIN_SHARE;

    for (let i = 0; i < size; i++) {
      const b = bytes[i];
      const land = (b & 0x80) !== 0;
      const magnitude = (b & 0x1F) / 31;
      this.owner[i] = land ? NEUTRAL : WATER;
      // classifyTerrain slices tiers off `roughness`; feeding it real
      // elevation here (rather than the noise field generate() builds) is
      // exactly what makes mountain ranges land where they really do.
      this.roughness[i] = magnitude;
      // Water elevation matches pruneSmallLandmasses' own sentinel for
      // demoted land, so anything reading elevation (rendering) sees the
      // same "this is water" value regardless of which path built the map.
      this.elevation[i] = land ? magnitude : 0.48;
    }

    this._labelRegions();
    this.pruneSmallLandmasses(this.MIN_LANDMASS_TILES);
    this.classifyTerrain();
    this.computeShoreDist();
    this.computeWaterComponents();
    return this.landTiles;
  },

  // Finds the sea level whose largest connected landmass lands closest to
  // `target` tiles. Plain bisection (the old approach) assumed the largest-
  // component size shrinks smoothly as the threshold rises; measuring it
  // directly against real seeds turned up two ways that's not safe to assume:
  //
  //  1. The curve genuinely jumps. Lowering the sea level can fuse two
  //     islands, and the largest-component size leaps from one plateau to a
  //     much bigger one with nothing achievable in between — measured on one
  //     seed, 54% of the grid dropped straight to 26% between two thresholds
  //     0.02 apart. Bisection converges toward the crossing point assuming a
  //     value near the target exists there; across a jump like this, no such
  //     value exists, and which side it lands on is close to a coin flip.
  //  2. The old fixed floor (0.30) isn't always low enough to bracket the
  //     target at all. Measured directly: for some seeds the largest
  //     reachable landmass AT that floor — the most generous point the old
  //     search ever tried — topped out under 23%, because that seed's whole
  //     elevation field runs drier. No amount of searching inside
  //     [0.30, 0.85] finds 40% if 40% was never reachable in that range to
  //     begin with; bisection just converges on the floor and calls it the
  //     best it found. That's the exact shape of the ~15% severe-undershoot
  //     failures measured across both old and new map sizes — the same seeds
  //     had land comfortably past 40% available at a lower threshold the
  //     search never tried.
  //
  // The fix: widen the floor downward first, until the largest landmass AT it
  // actually clears the target — so the range brackets the target at all —
  // then sweep broadly rather than bisect, so a jump anywhere in that range
  // gets sampled on both sides instead of assumed not to exist. Every sample
  // taken, during widening, the coarse sweep, or the fine refinement,
  // updates one running best-so-far, so the result is never worse than the
  // best single point actually tried.
  //
  // What counts toward `target` is set by `_measureKept` (see generate).
  findSeaLevel(target) {
    let lo = 0.30, hi = 0.85;
    let bestT = lo, bestDiff = Infinity;
    const consider = t => {
      const largest = this.largestLandmassAt(t);
      const count = this._measureKept ? this._keptLand : largest;
      const diff = Math.abs(count - target);
      if (diff < bestDiff) { bestDiff = diff; bestT = t; }
      return count;
    };

    // Widen until the floor itself clears the target, or give up at a level
    // low enough that virtually the whole grid is land regardless of seed
    // (measured: -0.3 alone already clears 40% by 75%+ on every seed sampled;
    // this goes well past that for margin).
    for (let guard = 0; guard < 12 && consider(lo) < target; guard++) {
      lo -= 0.15;
      if (lo < -1.5) break;
    }

    // Broad sweep across the now target-bracketing range, so a jump anywhere
    // in it gets caught rather than stepped over.
    const COARSE = 18;
    const coarseT = [];
    for (let i = 0; i <= COARSE; i++) {
      const t = lo + (hi - lo) * i / COARSE;
      coarseT.push(t);
      consider(t);
    }

    // Refine inside the coarse step nearest the best sample found so far —
    // a much narrower window, so bisecting within it is far less likely to
    // itself straddle an undiscovered jump.
    let bestIdx = 0, bestGap = Infinity;
    for (let i = 0; i < coarseT.length; i++) {
      const gap = Math.abs(coarseT[i] - bestT);
      if (gap < bestGap) { bestGap = gap; bestIdx = i; }
    }
    const fineLo = coarseT[Math.max(0, bestIdx - 1)];
    const fineHi = coarseT[Math.min(coarseT.length - 1, bestIdx + 1)];
    const FINE = 10;
    for (let i = 0; i <= FINE; i++) {
      consider(fineLo + (fineHi - fineLo) * i / FINE);
    }

    return bestT;
  },

  // Share of land at each tier. Fixed proportions rather than fixed elevation
  // cutoffs, for the same reason the sea level is searched rather than fixed:
  // the noise's absolute range wanders by seed, so a hard cutoff would give one
  // map alpine spines and the next none at all. These are the defaults (the
  // World map uses them); generate() sets highlandShare/mountainShare from the
  // lobby's Terrain knob.
  HIGHLAND_SHARE: 0.26,
  MOUNTAIN_SHARE: 0.10,
  highlandShare: 0.26,
  mountainShare: 0.10,

  // How far inland (in tiles) the coastal penalty below fades out, and how
  // strong it is at the shoreline itself, as a fraction of this seed's own
  // roughness spread. Fixed tile counts, not map-fraction — the same coastal
  // strip width regardless of map size, like shoreDist's own bands.
  COAST_CLEAR_TILES: 16,
  COAST_PENALTY_STRENGTH: 0.75,

  // Tile-distance from each land tile to the nearest water, capped at
  // COAST_CLEAR_TILES (past that the penalty in classifyTerrain is zero
  // either way). Same multi-source BFS as computeShoreDist, mirrored onto
  // land. Left at 0 (unset) for any tile the BFS doesn't reach within the cap.
  computeCoastDist() {
    const size = this.width * this.height;
    const dist = this._coastDist = new Uint8Array(size);
    const queue = this._queue, nb = new Int32Array(4);
    let head = 0, tail = 0;

    for (let i = 0; i < size; i++) {
      if (this.owner[i] === WATER) continue;
      const n = this.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        if (this.owner[nb[k]] === WATER) { dist[i] = 1; queue[tail++] = i; break; }
      }
    }

    while (head < tail) {
      const i = queue[head++];
      const d = dist[i];
      if (d >= this.COAST_CLEAR_TILES) continue;
      const n = this.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (this.owner[j] !== WATER && dist[j] === 0) { dist[j] = d + 1; queue[tail++] = j; }
      }
    }
  },

  classifyTerrain() {
    const size = this.width * this.height;
    this.terrain = new Uint8Array(size);
    if (!this.landTiles) return;

    // Roughness alone scatters its peaks evenly across a landmass, including
    // right on the shoreline — real ranges sit inland, with open low ground
    // at the coast for landings and ports. computeCoastDist lets the scoring
    // below push each tile's rank down near the water before classifying.
    this.computeCoastDist();
    const coastDist = this._coastDist;

    // Percentiles off a sample — sorting every land tile on an XL map is far
    // more work than the answer needs. Off `roughness`, not `elevation`: see
    // its comment in generate() — using elevation here is what produced one
    // contiguous highland/mountain mass instead of scattered ranges. This
    // first pass also finds the sample's spread, so the coastal penalty is
    // scaled to this seed's own roughness range rather than a hardcoded
    // constant — the noise's absolute range wanders by seed just like
    // elevation's does.
    const indices = [];
    const stride = Math.max(1, Math.floor(this.landTiles / 20000));
    let seen = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < size; i++) {
      if (this.owner[i] === WATER) continue;
      const r = this.roughness[i];
      if (r < lo) lo = r;
      if (r > hi) hi = r;
      if (seen++ % stride === 0) indices.push(i);
    }
    if (!indices.length) return;
    const spread = hi - lo;

    const scoreAt = i => {
      const d = coastDist[i];
      if (d === 0) return this.roughness[i];
      return this.roughness[i] - spread * this.COAST_PENALTY_STRENGTH * (1 - d / this.COAST_CLEAR_TILES);
    };

    const sample = indices.map(scoreAt);
    sample.sort((a, b) => a - b);
    const at = f => sample[Math.min(sample.length - 1, Math.floor(sample.length * f))];
    const mountainAt = at(1 - this.mountainShare);
    const highlandAt = at(1 - this.mountainShare - this.highlandShare);

    for (let i = 0; i < size; i++) {
      if (this.owner[i] === WATER) continue;
      const s = scoreAt(i);
      this.terrain[i] = s >= mountainAt ? MOUNTAIN : (s >= highlandAt ? HIGHLAND : PLAINS);
    }
  },

  // Rivers: a few major ones per continent, found rather than drawn. A
  // priority flood from the coast inland (lowest ground first, filling any
  // closed hollow up to its rim) gives every land tile a downstream
  // neighbour, so the whole landmass drains to the sea along the valleys the
  // elevation noise already has. Counting how many tiles drain through each
  // tile then shows where water collects: the biggest basins' trunks, down
  // to a share of their mouth's flow, become the rivers.
  //
  // Rivers are ordinary water, the same as the sea they drain into: they
  // block land attacks, carry boats and give their banks a coast. Each
  // river is a tree rooted at the sea, so it never rings off a pocket of
  // land by itself; where two happen to touch, the re-prune after carving
  // tidies up. The last stretch widens into an estuary toward the mouth.
  //
  // Returns whether any land was turned to water. Integer and IEEE-exact
  // throughout; ties break on tile index, so every client carves the same
  // tiles.
  RIVER_SLOPE_WEIGHT: 0.5,
  RIVER_MEANDER: 0.15,
  RIVER_SHARE: 0.04,     // a river reaches upstream until its flow drops below this share of its mouth's
  riverScale: 1,         // rivers per landmass, times the base count (the lobby's Rivers knob)
  riverShare: 0.04,      // per-map RIVER_SHARE, also set from the Rivers knob
  ESTUARY_SHARE: 0.3,    // only the trunk (this share of mouth flow and up) widens into an estuary
  carveRivers(seed) {
    const w = this.width, h = this.height, size = w * h;
    const owner = this.owner, elev = this.elevation, rough = this.roughness;
    // Water runs off the terrain's ranges (roughness, the field mountains
    // are cut from), so rivers rise in the hills and follow the valleys
    // between ranges instead of cutting across them. A little of the
    // continent-shaping elevation keeps the broad slope pointing seaward.
    // On top of both, a gentle meander field: flat plains otherwise give
    // the flood nothing to follow and channels come out ruler-straight.
    const EW = this.RIVER_SLOPE_WEIGHT, MW = this.RIVER_MEANDER, ms = 12 / w;
    const height = i => rough[i] + elev[i] * EW +
      Noise.fractal((i % w) * ms, ((i / w) | 0) * ms, seed + 9000, 3) * MW;
    const down = new Int32Array(size).fill(-1);
    const acc = new Int32Array(size);
    const order = new Int32Array(this.landTiles);
    const nb = new Int32Array(4);

    // Binary min-heap over (key, tile). Each land tile is pushed once.
    const hk = new Float64Array(this.landTiles), ht = new Int32Array(this.landTiles);
    let hn = 0, popKey = 0;
    const less = (a, b) => hk[a] < hk[b] || (hk[a] === hk[b] && ht[a] < ht[b]);
    const swap = (a, b) => {
      const k = hk[a]; hk[a] = hk[b]; hk[b] = k;
      const t = ht[a]; ht[a] = ht[b]; ht[b] = t;
    };
    const push = (key, t) => {
      let c = hn++;
      hk[c] = key; ht[c] = t;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (!less(c, p)) break;
        swap(c, p); c = p;
      }
    };
    const pop = () => {
      const t = ht[0], key = hk[0];
      hn--;
      if (hn > 0) {
        hk[0] = hk[hn]; ht[0] = ht[hn];
        let c = 0;
        for (;;) {
          const l = c * 2 + 1, r = l + 1;
          let m = c;
          if (l < hn && less(l, m)) m = l;
          if (r < hn && less(r, m)) m = r;
          if (m === c) break;
          swap(c, m); c = m;
        }
      }
      popKey = key;
      return t;
    };

    const seen = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      if (owner[i] === WATER) continue;
      const n = this.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        if (owner[nb[k]] === WATER) { seen[i] = 1; push(height(i), i); break; }
      }
    }
    // Inside a filled hollow every tile would share its rim's height and
    // drain in plain index order, in ruler-straight lines; the small step
    // makes the fill spread outward from the rim like a flood instead.
    // The step is jittered per tile (integer hash, identical everywhere) so
    // the flood front, and the channels traced back through it, wander
    // instead of running along grid rows.
    const STEP = 1e-6;
    const jitter = i => {
      let x = Math.imul(i ^ 0x27D4EB2D, 0x85EBCA6B);
      x ^= x >>> 15; x = Math.imul(x, 0xC2B2AE35); x ^= x >>> 13;
      return 1 + ((x >>> 0) & 1023) / 256;
    };
    let count = 0;
    while (hn > 0) {
      const i = pop(), key = popKey;
      order[count++] = i;
      const n = this.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (owner[j] === WATER || seen[j]) continue;
        seen[j] = 1;
        down[j] = i;
        push(Math.max(height(j), key + STEP * jitter(j)), j);
      }
    }

    // Upstream tile count, children before parents (reverse flood order),
    // and each tile's mouth, parents before children.
    for (let k = count - 1; k >= 0; k--) {
      const i = order[k];
      acc[i] += 1;
      if (down[i] >= 0) acc[down[i]] += acc[i];
    }
    const mouth = new Int32Array(size).fill(-1);
    for (let k = 0; k < count; k++) {
      const i = order[k];
      mouth[i] = down[i] < 0 ? i : mouth[down[i]];
    }

    // Pick each landmass's biggest basins, spaced apart along the coast.
    const mouths = [];
    for (let k = 0; k < count; k++) if (down[order[k]] < 0) mouths.push(order[k]);
    mouths.sort((a, b) => acc[b] - acc[a] || a - b);
    const chosen = new Map();   // mouth tile -> its flow
    const perLandmass = this.landmasses.map(lm => ({
      want: Math.round((lm.size < 4000 ? 0 : lm.size < 20000 ? 1 : 2 + Math.round(Math.sqrt(lm.size) / 250)) * this.riverScale),
      spacing: Math.sqrt(lm.size) * 0.2,
      picked: []
    }));
    for (const m of mouths) {
      const pl = perLandmass[this.landmassId[m]];
      if (pl.picked.length >= pl.want) continue;
      // Too small a basin to read as a major river on this landmass.
      if (acc[m] < this.landmasses[this.landmassId[m]].size * 0.01) continue;
      const mx = m % w, my = (m / w) | 0;
      let ok = true;
      for (const p of pl.picked) {
        const dx = p % w - mx, dy = ((p / w) | 0) - my;
        if (dx * dx + dy * dy < pl.spacing * pl.spacing) { ok = false; break; }
      }
      if (!ok) continue;
      pl.picked.push(m);
      chosen.set(m, acc[m]);
    }

    // Mark the rivers, and measure how far each river tile is from the sea
    // along its own course (parents first, so the mouth is 0).
    const river = new Uint8Array(size);
    const dist = new Int32Array(size);
    for (let k = 0; k < count; k++) {
      const i = order[k];
      const flow = chosen.get(mouth[i]);
      if (flow === undefined || acc[i] < flow * this.riverShare) continue;
      river[i] = 1;
      dist[i] = down[i] < 0 ? 0 : dist[down[i]] + 1;
    }
    // On the big maps a one-tile channel all but vanishes when zoomed out,
    // so trunks are drawn two wide there. Widened tiles are flagged 2, not
    // 1, so the estuary pass (which walks the channel itself) skips them.
    if (w >= 1000) {
      for (let k = 0; k < count; k++) {
        const i = order[k];
        if (!river[i] || acc[i] < chosen.get(mouth[i]) * this.ESTUARY_SHARE) continue;
        const e = i % w < w - 1 ? i + 1 : -1, s = i + w < size ? i + w : -1;
        const j = down[i] === e || down[i] === i - 1 ? s : e;
        if (j >= 0 && owner[j] !== WATER && !river[j]) river[j] = 2;
      }
    }

    // Estuaries: the trunk's last stretch widens, three wide for its seaward
    // half (and five wide right at the mouth on the biggest maps).
    const reach = Math.max(4, Math.round(w * 0.02));
    const wide = w >= 1000 ? Math.round(reach * 0.25) : -1;
    let carved = false;
    for (let k = 0; k < count; k++) {
      const i = order[k];
      if (river[i] !== 1 || dist[i] > reach || acc[i] < chosen.get(mouth[i]) * this.ESTUARY_SHARE) continue;
      const r = dist[i] <= wide ? 2 : dist[i] <= reach / 2 ? 1 : 0;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > r) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (owner[j] === WATER) continue;
          owner[j] = WATER; elev[j] = 0.48;
          carved = true;
        }
      }
    }
    // Then the rest of every channel.
    for (let i = 0; i < size; i++) {
      if (!river[i] || owner[i] === WATER) continue;
      owner[i] = WATER; elev[i] = 0.48;
      carved = true;
    }
    return carved;
  },

  // Floods the map at sea level `t` and returns the size of its biggest
  // connected landmass, leaving `owner` and `_region` set for that threshold
  // (and `_keptLand`, see _labelRegions).
  largestLandmassAt(t) {
    const size = this.width * this.height;
    for (let i = 0; i < size; i++) {
      this.owner[i] = this.elevation[i] > t ? NEUTRAL : WATER;
    }
    return this._labelRegions();
  },

  // The flood-fill/labeling half of largestLandmassAt, split out so loadWorld
  // can reuse it against an `owner` array it already knows (from real map
  // data) rather than one this would derive from an elevation threshold.
  _labelRegions() {
    const size = this.width * this.height;
    const region = this._region, queue = this._queue, nb = new Int32Array(4);
    region.fill(-1);
    // Every region's size, not just the winner's — pruneSmallLandmasses uses
    // this to decide which secondary landmasses survive as islands rather
    // than being dropped to water along with everything too small to matter.
    const sizes = [];
    let bestRegion = -1, bestCount = 0, regionId = 0;

    for (let start = 0; start < size; start++) {
      if (this.owner[start] === WATER || region[start] !== -1) continue;
      let head = 0, tail = 0, count = 0;
      queue[tail++] = start;
      region[start] = regionId;
      while (head < tail) {
        const i = queue[head++];
        count++;
        const n = this.neighbors(i, nb);
        for (let k = 0; k < n; k++) {
          const j = nb[k];
          if (this.owner[j] !== WATER && region[j] === -1) { region[j] = regionId; queue[tail++] = j; }
        }
      }
      sizes.push(count);
      if (count > bestCount) { bestCount = count; bestRegion = regionId; }
      regionId++;
    }
    this._bestRegion = bestRegion;
    this._regionSizes = sizes;
    // Land that pruneSmallLandmasses would keep at this threshold.
    let kept = 0;
    for (const n of sizes) if (n >= this.MIN_LANDMASS_TILES) kept += n;
    this._keptLand = kept;
    return bestCount;
  },

  // Drops every landmass under `minTiles` to water, exactly as the old
  // pruneToLargest did for everything but the single biggest region — but
  // keeps any other region that clears the floor as a real, separately
  // identified island, now that naval invasions can actually reach one.
  // Two passes rather than one: the first settles which tiles are land at
  // all, so the second's coastline sampling (which asks "is my neighbour
  // water") reads the final map instead of a partially-pruned one that would
  // make the answer depend on iteration order.
  pruneSmallLandmasses(minTiles) {
    const size = this.width * this.height;
    const region = this._region, sizes = this._regionSizes;
    const survivors = [];
    for (let r = 0; r < sizes.length; r++) if (sizes[r] >= minTiles) survivors.push(r);
    // Largest first, so landmass id 0 is always the main continent — the one
    // findSpawns leans on most heavily by sheer odds of a sample landing there.
    survivors.sort((a, b) => sizes[b] - sizes[a]);
    const idOf = new Map(survivors.map((r, idx) => [r, idx]));

    let land = 0;
    for (let i = 0; i < size; i++) {
      if (this.owner[i] === WATER) continue;
      if (idOf.has(region[i])) land++;
      else { this.owner[i] = WATER; this.elevation[i] = 0.48; }
    }
    this.landTiles = land;

    // A stable id per surviving landmass, plus a small sample of its coastal
    // tiles — the lookup AI naval targeting scans instead of re-deriving
    // "what islands exist" from scratch on every bot's think.
    this.landmassId = new Int32Array(size).fill(-1);
    this.landmasses = survivors.map((r, idx) => ({ id: idx, size: sizes[r], coastSample: [] }));
    const nb = new Int32Array(4);
    const COAST_SAMPLE = 12;
    for (let i = 0; i < size; i++) {
      if (this.owner[i] === WATER) continue;
      const id = idOf.get(region[i]);
      this.landmassId[i] = id;
      const lm = this.landmasses[id];
      if (lm.coastSample.length >= COAST_SAMPLE) continue;
      const n = this.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        if (this.owner[nb[k]] === WATER) { lm.coastSample.push(i); break; }
      }
    }
  },

  // Multi-source BFS distance (in tiles) from every water tile to the
  // nearest land, seeded from the water tiles that actually touch a shore
  // and flooded outward across open water — mirrors the "magnitude" field
  // OpenFront bakes into its terrain data. Game.seaPath prices a route off
  // this: hugging the coast is expensive, a band a few tiles out is free,
  // and far blue water carries a small penalty of its own. Land tiles are
  // left at 0 (unused; the BFS never assigns them).
  computeShoreDist() {
    const size = this.width * this.height;
    const dist = this.shoreDist = new Uint8Array(size);
    const queue = this._queue, nb = new Int32Array(4);
    let head = 0, tail = 0;

    for (let i = 0; i < size; i++) {
      if (this.owner[i] === WATER) continue;
      const n = this.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (this.owner[j] === WATER && dist[j] === 0) { dist[j] = 1; queue[tail++] = j; }
      }
    }

    while (head < tail) {
      const i = queue[head++];
      const d = dist[i];
      if (d >= 250) continue;   // past this, every bucket above is identical anyway
      const n = this.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (this.owner[j] === WATER && dist[j] === 0) { dist[j] = d + 1; queue[tail++] = j; }
      }
    }
  },

  // Connected-component id for every WATER tile, over the same 4-neighbour
  // adjacency Game.seaPath's A* actually moves through — the sea's
  // counterpart to landmassId. Computed once here so seaPath can reject an
  // unreachable target instantly (two water tiles can only connect if they
  // share a component) instead of exhausting its whole reachable side of
  // the map — up to SEA_PATH_GUARD tiles — just to prove there's no route.
  // Land tiles are left at -1 (unused; never looked up for one).
  computeWaterComponents() {
    const size = this.width * this.height;
    const comp = this.waterComponentId = new Int32Array(size).fill(-1);
    const queue = this._queue, nb = new Int32Array(4);
    let id = 0;
    for (let start = 0; start < size; start++) {
      if (this.owner[start] !== WATER || comp[start] !== -1) continue;
      let head = 0, tail = 0;
      queue[tail++] = start;
      comp[start] = id;
      while (head < tail) {
        const i = queue[head++];
        const n = this.neighbors(i, nb);
        for (let k = 0; k < n; k++) {
          const j = nb[k];
          if (this.owner[j] === WATER && comp[j] === -1) { comp[j] = id; queue[tail++] = j; }
        }
      }
      id++;
    }
  },

  isLand(i) { return this.owner[i] !== WATER; },
  isCoastal(i) {
    const nb = this._coastBuf || (this._coastBuf = new Int32Array(4));
    const n = this.neighbors(i, nb);
    for (let k = 0; k < n; k++) if (this.owner[nb[k]] === WATER) return true;
    return false;
  },
  idx(x, y) { return y * this.width + x; },

  // Fills out[0..n] with the 4-neighbour indices of i that lie on the map.
  neighbors(i, out) {
    const w = this.width, x = i % w, y = (i / w) | 0;
    let n = 0;
    if (x > 0) out[n++] = i - 1;
    if (x < w - 1) out[n++] = i + 1;
    if (y > 0) out[n++] = i - w;
    if (y < this.height - 1) out[n++] = i + w;
    return n;
  },

  // Picks spawn points on land, spread apart, avoiding tiny islands.
  findSpawns(count, rng) {
    // Spread spawns as the landmass allows, relaxing the spacing requirement
    // until every player fits.
    let minDist = Math.sqrt(this.landTiles / count) * 1.1;

    for (let attempt = 0; attempt < 12; attempt++) {
      const spawns = [];
      for (let guard = 0; guard < 8000 && spawns.length < count; guard++) {
        const x = 6 + Math.floor(rng() * (this.width - 12));
        const y = 6 + Math.floor(rng() * (this.height - 12));
        const i = this.idx(x, y);
        if (!this.isLand(i)) continue;
        if (this.landAround(x, y, 5) < 90) continue;

        // Each candidate draws its own required spacing rather than all
        // sharing minDist verbatim, so the accepted spawns end up unevenly
        // distanced — some clustered closer together, others further apart —
        // instead of the rigid, roughly-Poisson-disc grid a single fixed
        // threshold produces. 0.5x floor still blocks unfair on-top-of-each-
        // other placements; 1.5x cap keeps this attempt's average spacing
        // near minDist so the relaxation loop below still converges.
        const required = minDist * (0.5 + rng());

        let ok = true;
        for (const s of spawns) {
          const sx = s % this.width, sy = (s / this.width) | 0;
          // sqrt(dx*dx + dy*dy), never Math.hypot. Every client generates the
          // map itself from the shared seed, so a single tile of disagreement
          // here is an instant, total desync of everything downstream — and
          // Math.hypot is one of the calls ECMA-262 leaves
          // implementation-approximated, so V8/SpiderMonkey/JavaScriptCore can
          // differ in the last ulp and straddle the `< required` comparison.
          // The multiplies, the add and the sqrt are all IEEE-754 operations
          // that every engine must round identically, so this form is exact
          // rather than merely quantized — which is why it is preferred to
          // Game.det.hypot here, in what is easily the hottest loop that
          // touches a hazardous call (up to 8000 candidate tiles x every
          // spawn already placed, x 12 relaxation attempts).
          const dx = sx - x, dy = sy - y;
          if (Math.sqrt(dx * dx + dy * dy) < required) { ok = false; break; }
        }
        if (ok) spawns.push(i);
      }
      if (spawns.length === count) return spawns;
      minDist *= 0.75;
    }
    return [];
  },

  landAround(x, y, r) {
    let n = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
        if (this.isLand(this.idx(nx, ny))) n++;
      }
    }
    return n;
  }
};
