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

  // Default share of the grid that should end up as land. Searched for
  // rather than left to a fixed sea level, because land area varied 4-5x by
  // seed and match length follows it. Each landform scales this (see
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

  // Every landform is built from 'plates': seed points that each grow one
  // landmass under a radial falloff. With more than one plate, every tile
  // belongs to its nearest plate and a strait is sunk along the borders, so
  // landmasses never fuse. Plate positions and sizes are fractions of the
  // map, so the same seed and options draw the same shapes at every size
  // (the lobby preview relies on that).
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

  // Gives each plate a spine: a bent centre line with tapering width and a
  // few side branches, so landmasses grow arms, peninsulas and necks rather
  // than an oval. `segs` holds [ax, ay, bx, by, ra, rb] per segment. The
  // 'inland' ring keeps its ellipse. Directions use the tan-half-angle trick
  // (no trig; see rangeShape).
  growSpines(seed, plates, landform) {
    let n = 900;
    const next = () => this.seedHash(seed, n++);
    const unit = t => { const k = 1 + t * t; return [(1 - t * t) / k, 2 * t / k]; };
    const rot = (d, c) => [d[0] * c[0] - d[1] * c[1], d[0] * c[1] + d[1] * c[0]];
    const S = this.SPINE[landform] || this.SPINE.continent;
    for (const p of plates) {
      const segs = [], nodes = [];
      // Main axis, within S.tilt of the plate's long side.
      let dir = unit((next() - 0.5) * 2 * S.tilt);
      if (p.ry > p.rx) dir = [-dir[1], dir[0]];
      const reach = 1 / Math.sqrt(dir[0] * dir[0] / (p.rx * p.rx) + dir[1] * dir[1] / (p.ry * p.ry));
      const body = Math.min(p.rx, p.ry) * (S.body + next() * 0.2);
      // Walks `steps` segments from (x, y), bending as it goes; width runs
      // from r0 down by `taper` at the tip.
      const walk = (x, y, d, len, steps, r0, taper, record) => {
        let r = r0, turn = 0;
        for (let k = 1; k <= steps; k++) {
          turn = turn * 0.5 + (next() - 0.5) * S.bend;
          d = rot(d, unit(turn));
          const f = k / steps;
          const nr = r0 * Math.max(0.08, 1 - taper * f * Math.sqrt(f)) * (0.8 + next() * 0.4);
          const nx = x + d[0] * len / steps, ny = y + d[1] * len / steps;
          segs.push(x, y, nx, ny, r, nr);
          if (record) nodes.push(nx, ny, d[0], d[1], nr);
          x = nx; y = ny; r = nr;
        }
      };
      for (const side of [1, -1]) {
        walk(p.x, p.y, [dir[0] * side, dir[1] * side], reach * (S.len + next() * 0.45),
          S.steps, body, 0.45 + next() * 0.5, true);
      }
      const branches = Math.floor(next() * (S.branches + 1));
      for (let b = 0; b < branches && nodes.length; b++) {
        const m = Math.floor(next() * nodes.length / 5) * 5;
        const flip = next() < 0.5 ? 1 : -1;
        const d = rot([-nodes[m + 3] * flip, nodes[m + 2] * flip], unit((next() - 0.5) * 0.7));
        walk(nodes[m], nodes[m + 1], d, reach * (0.3 + next() * 0.35), 3,
          nodes[m + 4] * (0.55 + next() * 0.3), 0.7, false);
      }
      p.segs = segs;
      p.body = body;
    }
  },

  // Per-landform spine character: axis tilt off the long side (tan of half
  // the angle), body width as a share of the plate's short radius, arm
  // length as a share of its reach, segments per arm, bend per segment and
  // most side branches.
  SPINE: {
    continent:   { tilt: 0.25, body: 0.3,  len: 0.6, steps: 4, bend: 0.5, branches: 4, fall: [0.9, 1.6] },
    twin:        { tilt: 0.5,  body: 0.3,  len: 0.55, steps: 4, bend: 0.5, branches: 3, fall: [0.9, 1.6] },
    continents:  { tilt: 0.6,  body: 0.45, len: 0.6, steps: 3, bend: 0.4, branches: 2, fall: [0.9, 1.1] },
    archipelago: { tilt: 1,    body: 0.45, len: 0.6, steps: 2, bend: 0.6, branches: 1, fall: [0.9, 1.1] },
    pangaea:     { tilt: 0.15, body: 0.5,  len: 0.6, steps: 4, bend: 0.4, branches: 4, fall: [0.9, 1.2] }
  },

  // Each plate's distance field on the warp grid's nodes, at the warped
  // point: `S` is signed distance to the plate's edge in tiles, `D` the same
  // over the plate's body width plus 1 (so 1 at the edge, like an ellipse's
  // normalised radius), which keeps thin arms from drowning. generate() reads them back
  // bilinearly. `cand` lists, per grid cell, the plates that can be nearest
  // or second nearest anywhere in the cell: an interpolated value stays
  // within its corners, so a plate whose lowest corner is above the second
  // lowest highest-corner can't qualify. Up to CAND per cell, 255 = unused.
  plateField(plates, warp) {
    const { stride: s, gw, grid } = warp, gh = grid.length / (gw * 2);
    const P = plates.length, nodes = gw * gh;
    const D = new Float32Array(nodes * P), S = new Float32Array(nodes * P);
    for (let o = 0; o < nodes; o++) {
      const px = (o % gw) * s + grid[o * 2], py = ((o / gw) | 0) * s + grid[o * 2 + 1];
      for (let k = 0; k < P; k++) {
        const p = plates[k], g = p.segs;
        let bd = Infinity, bs = Infinity;
        if (!g) {
          const nx = (px - p.x) / p.rx, ny = (py - p.y) / p.ry;
          bd = Math.sqrt(nx * nx + ny * ny);
          bs = (bd - 1) * Math.sqrt(p.rx * p.ry);
        } else {
          for (let q = 0; q < g.length; q += 6) {
            const ax = g[q], ay = g[q + 1], dx = g[q + 2] - ax, dy = g[q + 3] - ay;
            const ll = dx * dx + dy * dy;
            let t = ll > 0 ? ((px - ax) * dx + (py - ay) * dy) / ll : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = px - ax - dx * t, ey = py - ay - dy * t;
            const dist = Math.sqrt(ex * ex + ey * ey), r = g[q + 4] + (g[q + 5] - g[q + 4]) * t;
            if (dist - r < bs) bs = dist - r;
          }
          bd = 1 + bs / p.body;
        }
        D[o * P + k] = bd;
        S[o * P + k] = bs;
      }
    }
    const CAND = 6, cw = gw - 1, cells = cw * (gh - 1);
    const cand = new Uint8Array(cells * CAND).fill(255);
    const lo = new Float64Array(P), order = [];
    for (let c = 0; c < cells; c++) {
      const o00 = ((c / cw) | 0) * gw + c % cw, os = [o00, o00 + 1, o00 + gw, o00 + gw + 1];
      let hi1 = Infinity, hi2 = Infinity;
      for (let k = 0; k < P; k++) {
        let mn = Infinity, mx = -Infinity;
        for (const o of os) { const v = S[o * P + k]; if (v < mn) mn = v; if (v > mx) mx = v; }
        lo[k] = mn;
        if (mx < hi1) { hi2 = hi1; hi1 = mx; } else if (mx < hi2) hi2 = mx;
      }
      const cut = P > 1 ? hi2 : hi1;
      order.length = 0;
      for (let k = 0; k < P; k++) if (lo[k] <= cut) order.push(k);
      order.sort((a, b) => lo[a] - lo[b] || a - b);
      for (let q = 0; q < order.length && q < CAND; q++) cand[c * CAND + q] = order[q];
    }
    return { P, D, S, cand, CAND, cw };
  },

  // Tectonic plates, separate from the landform plates: seed points that
  // each drift a seed-chosen way. Where two close in, a mountain belt rises
  // along their border (offset onto the overriding plate, like the Andes);
  // where they part, a rift sinks. `conv` is the closing speed per pair,
  // `inv2d` turns a squared-distance difference into tiles from their border.
  TECTONIC: {
    belt: 0.035,      // belt half-width, share of map width
    rise: 1.8,        // belt's push on roughness, times this seed's roughness spread
    lift: 0.12,       // belt's push on elevation (island arcs at sea)
    rift: 0.7,        // rift's sink on elevation
    riftWidth: 0.4    // rift half-width, share of the belt's
  },
  tectonics(seed, width, height) {
    let n = 1300;
    const next = () => this.seedHash(seed, n++);
    const K = 7 + Math.floor(next() * 5);
    const pts = [];
    for (let k = 0; k < K; k++) {
      let bx = 0, by = 0, best = -1;
      for (let tries = k === 0 ? 1 : 10; tries > 0; tries--) {
        const px = width * (0.05 + next() * 0.9), py = height * (0.05 + next() * 0.9);
        let dmin = Infinity;
        for (const q of pts) { const dx = px - q.x, dy = py - q.y; dmin = Math.min(dmin, dx * dx + dy * dy); }
        if (dmin > best) { best = dmin; bx = px; by = py; }
      }
      const t = next() * 2 - 1, kk = 1 + t * t, flip = next() < 0.5 ? -1 : 1, speed = 0.3 + next() * 0.7;
      pts.push({ x: bx, y: by, vx: flip * speed * (1 - t * t) / kk, vy: flip * speed * 2 * t / kk });
    }
    const conv = new Float64Array(K * K), inv2d = new Float64Array(K * K), over = new Uint8Array(K * K);
    for (let a = 0; a < K; a++) {
      for (let b = a + 1; b < K; b++) {
        const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y, dist = Math.sqrt(dx * dx + dy * dy);
        const c = ((pts[a].vx - pts[b].vx) * dx + (pts[a].vy - pts[b].vy) * dy) / dist;
        conv[a * K + b] = conv[b * K + a] = c;
        inv2d[a * K + b] = inv2d[b * K + a] = 1 / (2 * dist);
        const o = next() < 0.5 ? 1 : 0;
        over[a * K + b] = o; over[b * K + a] = 1 - o;
      }
    }
    const belt = width * this.TECTONIC.belt;
    return { K, pts, conv, inv2d, over, belt, ridgeAlong: 0.5 / belt, ridgeAcross: 1.6 / belt };
  },

  // Belt uplift (0..~1.5) and rift depth at warped point (px, py), written
  // to out[0] and out[1]. `m` (0..1, slow noise) varies belt width and
  // strength along a border, so ranges thin out, break at passes and rifts
  // come in pieces. Inside a belt, out[2] is ridge texture (0..1): ridged
  // noise stretched along the border, so ranges run parallel to it.
  tectonicAt(T, px, py, m, seed, out, ridge) {
    const { K, pts, conv, inv2d, over } = T;
    let a = 0, da = Infinity;
    for (let k = 0; k < K; k++) {
      const dx = px - pts[k].x, dy = py - pts[k].y, d = dx * dx + dy * dy;
      if (d < da) { da = d; a = k; }
    }
    const W = T.belt * (0.6 + m * 0.8), shift = W * 0.35, RW = W * this.TECTONIC.riftWidth;
    let up = 0, rift = 0, pair = -1, across = 0;
    for (let k = 0; k < K; k++) {
      if (k === a) continue;
      const dx = px - pts[k].x, dy = py - pts[k].y;
      const gap = (dx * dx + dy * dy - da) * inv2d[a * K + k];
      if (gap > W * 1.4) continue;
      const c = conv[a * K + k];
      if (c > 0) {
        // Peak sits `shift` onto the overriding plate's side.
        const off = Math.abs(over[a * K + k] ? gap - shift : gap + shift);
        let f = 1 - off / W;
        if (f <= 0) continue;
        f = f * f * Math.min(1, 0.45 + c);
        if (f > up) { up = f; pair = k; across = a < k ? gap : -gap; }
      } else {
        let f = 1 - gap / RW;
        if (f <= 0) continue;
        f = f * f * Math.min(1, 0.45 - c);
        if (f > rift) rift = f;
      }
    }
    // Fractal noise bunches near 0.5; stretch it so strength really varies.
    const mm = Math.max(0, Math.min(1, (m - 0.5) * 2.5 + 0.5));
    out[0] = up * (0.25 + mm);
    out[1] = rift * (m > 0.35 ? Math.min(1, (m - 0.35) * 4) : 0);
    out[2] = 0;
    if (ridge && pair >= 0) {
      // Along-border coordinate, oriented by the lower plate index so both
      // sides agree.
      const lo = a < pair ? a : pair, hi = a < pair ? pair : a;
      const tx = pts[lo].y - pts[hi].y, ty = pts[hi].x - pts[lo].x;
      const along = (px * tx + py * ty) * inv2d[a * K + pair] * 2;
      const r = Noise.fractal(along * T.ridgeAlong, across * T.ridgeAcross, seed + 1800 + lo * 31 + hi, 2);
      const q = Math.max(0, 1 - Math.abs(r - 0.5) * 5);
      out[2] = q * q;
    }
  },

  // Belt strength, rift depth and the `m` noise on the warp grid's nodes,
  // at the warped point; all three are smooth, so generate() reads them back
  // bilinearly and only works per tile inside belts (for ridge texture).
  tectonicGrid(T, warp, seed, width) {
    const { stride: s, gw, grid } = warp, nodes = grid.length / 2, mS = 3 / width;
    const g = new Float32Array(nodes * 3), out = [0, 0, 0];
    for (let o = 0; o < nodes; o++) {
      const x = (o % gw) * s, y = ((o / gw) | 0) * s;
      const m = Noise.fractal(x * mS, y * mS, seed + 1700, 2);
      this.tectonicAt(T, x + grid[o * 2], y + grid[o * 2 + 1], m, seed, out, false);
      g[o * 3] = out[0]; g[o * 3 + 1] = out[1]; g[o * 3 + 2] = m;
    }
    return g;
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

    this.seed = seed;   // read by render.js's climate (looks only)
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
    if (!plan.innerSea) {
      this.growSpines(seed, plates, opts.landform);
      [plan.falloffStart, plan.falloffStrength] = this.SPINE[opts.landform].fall;
    }
    const field = this.plateField(plates, warp);
    const { D: fD, S: fS, cand, CAND, cw } = field;
    // Which plate each tile belongs to; P marks the strait between plates.
    const plateOf = P > 1 ? new Uint8Array(size) : null;
    const lakeScale = scale * 2.6, inner = plan.innerSea;

    // Independent field driving terrain *tier* (plains, highland, mountain),
    // decoupled from `elevation`: elevation is dominated by the radial
    // falloff, so tiers cut from it collapse into one blob at the landmass
    // centre. See rangeRoughness.
    this.roughness = new Float32Array(size);
    const shape = this.rangeShape(seed);
    const low = this.rangeLowFreq(width, height, seed, scale * 1.6, shape);
    const tect = this.tectonics(seed, width, height), TC = this.TECTONIC;
    const belt = new Float32Array(size), tOut = [0, 0, 0];
    const tg = this.tectonicGrid(tect, warp, seed, width);
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

        // Nearest and second-nearest plate by signed edge distance, read
        // bilinearly off the plate field.
        let a = 0, sa = Infinity, sb = Infinity;
        const c0 = (gy * cw + gx) * CAND;
        for (let q = 0; q < CAND; q++) {
          const k = cand[c0 + q];
          if (k === 255) break;
          const v = fS[o00 / 2 * P + k] * w00 + fS[o10 / 2 * P + k] * w10 + fS[o01 / 2 * P + k] * w01 + fS[o11 / 2 * P + k] * w11;
          if (v < sa) { sb = sa; sa = v; a = k; } else if (v < sb) sb = v;
        }
        const d = fD[o00 / 2 * P + a] * w00 + fD[o10 / 2 * P + a] * w10 + fD[o01 / 2 * P + a] * w01 + fD[o11 / 2 * P + a] * w11;
        e -= Math.max(0, d - plan.falloffStart) * plan.falloffStrength;

        if (plateOf) {
          // Distance to the border with the next plate, where the two
          // signed edge distances meet.
          const gap = (sb - sa) / 2;
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
          const nx = (px - plates[0].x) / plates[0].rx, ny = (py - plates[0].y) / plates[0].ry;
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

        const t00 = o00 / 2 * 3, t10 = o10 / 2 * 3, t01 = o01 / 2 * 3, t11 = o11 / 2 * 3;
        const up = tg[t00] * w00 + tg[t10] * w10 + tg[t01] * w01 + tg[t11] * w11;
        const rift = tg[t00 + 1] * w00 + tg[t10 + 1] * w10 + tg[t01 + 1] * w01 + tg[t11 + 1] * w11;
        if (up > 0.005) {
          const m = tg[t00 + 2] * w00 + tg[t10 + 2] * w10 + tg[t01 + 2] * w01 + tg[t11 + 2] * w11;
          this.tectonicAt(tect, px, py, m, seed, tOut, true);
          // Soft cap, and deep valleys between ridges, so where belts meet
          // they don't merge into one solid block of mountain.
          belt[i] = up / (0.4 + up) * (0.1 + 0.9 * tOut[2]);
        }
        e += up * TC.lift - rift * TC.rift;

        this.elevation[i] = e;
        this.roughness[i] = this.rangeRoughness(x * scale * 1.6, y * scale * 1.6, seed, shape, low, x, y);
      }
    }
    // Belts raise roughness, so mountain and highland tiers gather along them.
    {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < size; i++) { const r = this.roughness[i]; if (r < lo) lo = r; if (r > hi) hi = r; }
      const k = (hi - lo) * TC.rise;
      for (let i = 0; i < size; i++) this.roughness[i] += belt[i] * k;
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

  // Gives each plate its share of the land before the global sea level
  // search: its elevation is shifted so the level that floods all but its
  // fraction of its cell lands on one common value. Capped well short of a
  // full cell, or a plate's coast is just the straight strait edge.
  // Percentiles come off a strided sample.
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
  // Tiers are level sets of a real height field:
  //  - No swirls or folds: the warp only nudges the sample point (capped in
  //    rangeShape).
  //  - One grain across the whole map: coordinates are stretched along a
  //    single seed-wide direction. It must be uniform.
  //  - Steep ground is smooth, gentle ground is detailed (Noise.eroded).
  //  - Valleys drain outward: mountains sit inside highland, highland inside
  //    plains, and low ground runs out to the coast.
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

  // Below this, a landmass is dropped to water. Keeps pixel-speck islands
  // (and the coastline noise they add to sea pathfinding) off the map; it
  // is not a spawn gate.
  MIN_LANDMASS_TILES: 70,

  // Raw bytes + manifest per baked map id ('world', 'europe', ...), handed off
  // by js/net/worldmap.js once fetched, so this file stays free of network calls.
  mapData: {},

  // Parses the baked map.bin format (1 byte/tile, row-major): bit 7 =
  // land, bits 0-4 = magnitude (elevation on land). Shoreline, ocean and
  // water magnitude are re-derived by computeShoreDist/
  // computeWaterComponents, as generate() does, so both paths feed
  // Game.seaPath identical data.
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
    this.seed = 0;
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
  // `target` tiles. Not bisection: the largest-component size jumps when
  // islands fuse, and a fixed floor does not always bracket the target.
  // So the floor is widened downward until the landmass at it clears the
  // target, then the range is swept (coarse, then fine). Every sample
  // updates one running best, so the result is the best point tried.
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

  // Share of land at each tier. Fixed proportions, not elevation cutoffs,
  // because the noise's absolute range wanders by seed. These are the
  // defaults (the World map uses them); generate() sets them from the
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

    // Percentiles off a sample of `roughness` (not `elevation`; see
    // generate()). This pass also finds the sample's spread, so the coastal
    // penalty is scaled to this seed's own roughness range.
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

  // Rivers: a few major ones per continent. A priority flood from the
  // coast inland gives every land tile a downstream neighbour; counting
  // how many tiles drain through each tile shows where water collects, and
  // the biggest basins' trunks become the rivers.
  //
  // Rivers are ordinary water: they block land attacks, carry boats and
  // give their banks a coast. Each is a tree rooted at the sea; the
  // re-prune after carving tidies up where two touch. The last stretch
  // widens into an estuary.
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
    // Water runs off roughness (the field mountains are cut from), so
    // rivers follow the valleys between ranges. A little elevation keeps
    // the broad slope seaward, and a gentle meander field keeps channels
    // on flat plains from running ruler-straight.
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
    // The small step makes a filled hollow flood outward from its rim
    // instead of draining in index order. It is jittered per tile (integer
    // hash, identical everywhere) so channels wander off the grid rows.
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

  // Drops every landmass under `minTiles` to water and keeps the rest as
  // separately identified islands. Two passes: the first settles which
  // tiles are land, so the second's coastline sampling reads the final map
  // and does not depend on iteration order.
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
  // nearest land. Game.seaPath prices a route off this: hugging the coast
  // is expensive, a band a few tiles out is free, and far open water has a
  // small penalty. Land tiles are left at 0.
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

  // Connected-component id for every WATER tile, over the 4-neighbour
  // adjacency Game.seaPath moves through. Lets seaPath reject an
  // unreachable target at once. Land tiles are left at -1.
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

        // Each candidate draws its own required spacing (0.5x to 1.5x
        // minDist), so spawns end up unevenly distanced instead of on a
        // rigid grid, while the average stays near minDist.
        const required = minDist * (0.5 + rng());

        let ok = true;
        for (const s of spawns) {
          const sx = s % this.width, sy = (s / this.width) | 0;
          // sqrt(dx*dx + dy*dy), never Math.hypot: Math.hypot is
          // implementation-approximated and can differ in the last ulp across
          // engines, which would desync map generation. The multiplies, add
          // and sqrt are IEEE-exact. Inlined rather than Game.det.hypot
          // because this is a very hot loop.
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
