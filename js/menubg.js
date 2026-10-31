// Main-menu backdrop: a slowly panning, softly blurred map where nations creep
// outward until the land is claimed, then it fades and starts over on a new map.
// Purely cosmetic and client-only: it generates on its own GameMap copy (like the
// map-options preview in ui.js), never touches Game, and draws behind #overlay.
// It idles while the overlay is hidden, so it costs nothing during a match.
const MenuBg = (function() {
  const W = 400, H = 200;          // generated map size
  const NATIONS = 16;
  const GROW_PER_TICK = 45;        // tiles claimed per tick
  const TICK_MS = 50;
  const HOLD_TICKS = 240;          // linger on the finished map
  const FADE_MS = 1600;
  // Colours per map style (Options → Map style). Atlas is drawn like the game's
  // zoomed-in Atlas map (see buildBase and paintAtlas) and takes its colours from
  // Render.ATLAS.
  const PALETTES = {
    classic: { terrain: [[78, 94, 72], [104, 96, 66], [122, 120, 114]], water: [18, 34, 60], mix: 0.8 },
    atlas: { atlas: true, water: Render.ATLAS.water }
  };
  let pal = PALETTES.classic;
  const NEIGHBORS = [1, -1, W, -W];

  const overlay = document.getElementById('overlay');
  const view = document.createElement('canvas');
  view.id = 'menuBg';
  overlay.parentNode.insertBefore(view, overlay);
  const vctx = view.getContext('2d');

  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');
  const img = octx.createImageData(W, H);

  let map = null, owner = null, frontier = [], rng = null;
  let base = null;                 // unclaimed colour per tile, RGB triples
  let tones = null;                // Atlas: per nation {fill, border, band, bandA}
  let enabled = true;
  let phase = 'grow', holdLeft = 0, fadeStart = 0, t0 = 0;

  function mulberry32(a) {
    return function() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Cosmetic value noise, as in Render.buildAtlasBases.
  function hash(x, y) {
    let k = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0;
    k = Math.imul(k ^ (k >>> 13), 1274126177);
    return ((k ^ (k >>> 16)) >>> 0) / 4294967296;
  }
  function vn(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  // Tiles of sea from land (4-way), up to max; 0 for land and for sea further out.
  function seaDistance(max) {
    const n = W * H, d = new Uint8Array(n), q = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (map.owner[i] === WATER) continue;
      const x = i % W;
      if (x > 0 && map.owner[i - 1] === WATER && !d[i - 1]) { d[i - 1] = 1; q[tail++] = i - 1; }
      if (x < W - 1 && map.owner[i + 1] === WATER && !d[i + 1]) { d[i + 1] = 1; q[tail++] = i + 1; }
      if (i >= W && map.owner[i - W] === WATER && !d[i - W]) { d[i - W] = 1; q[tail++] = i - W; }
      if (i < n - W && map.owner[i + W] === WATER && !d[i + W]) { d[i + W] = 1; q[tail++] = i + W; }
    }
    while (head < tail) {
      const i = q[head++], k = d[i] + 1;
      if (k > max) continue;
      const x = i % W;
      if (x > 0 && map.owner[i - 1] === WATER && !d[i - 1]) { d[i - 1] = k; q[tail++] = i - 1; }
      if (x < W - 1 && map.owner[i + 1] === WATER && !d[i + 1]) { d[i + 1] = k; q[tail++] = i + 1; }
      if (i >= W && map.owner[i - W] === WATER && !d[i - W]) { d[i - W] = k; q[tail++] = i - W; }
      if (i < n - W && map.owner[i + W] === WATER && !d[i + W]) { d[i + W] = k; q[tail++] = i + W; }
    }
    return d;
  }

  // Unclaimed colour of every tile. Atlas follows Render.buildAtlasBases: biome
  // colours on shaded relief, with an inked coast and ripples in the sea.
  function buildBase() {
    const n = W * H, own = map.owner, tier = map.terrain;
    base = new Uint8ClampedArray(n * 3);
    if (!pal.atlas) {
      for (let i = 0; i < n; i++) {
        const c = own[i] === WATER ? pal.water : pal.terrain[tier[i]];
        base[i * 3] = c[0]; base[i * 3 + 1] = c[1]; base[i * 3 + 2] = c[2];
      }
      return;
    }
    const A = Render.ATLAS, R = A.relief, BA = Render.BIOME_ATLAS;
    buildTones();
    const clim = Render.computeClimate(map, null), tmp = new Float32Array(n);
    const hb = new Float32Array(n);
    for (let i = 0; i < n; i++) hb[i] = own[i] === WATER ? -0.2 : tier[i] * 0.5;
    Render.boxBlur(hb, tmp, W, H, 2);
    const ht = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, e = Math.max(0, hb[i]);
        ht[i] = hb[i] + (vn(x / 9, y / 9) - 0.5) * 0.22 * (0.3 + e) + (vn(x / 3.5, y / 3.5) - 0.5) * 0.12 * e;
      }
    }
    const lr = new Float32Array(n), lg = new Float32Array(n), lb = new Float32Array(n), cold = new Float32Array(n);
    const forest = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, c = own[i] === WATER ? R[0] : BA[clim.biome[i]];
        lr[i] = c[0]; lg[i] = c[1]; lb[i] = c[2];
        cold[i] = own[i] === WATER ? 0 : clim.cold[i];
        if (own[i] !== WATER) forest[i] = Render.atlasWoods(vn, x, y, tier[i], clim.biome[i]);
      }
    }
    for (const a of [lr, lg, lb, cold]) Render.boxBlur(a, tmp, W, H, 2);
    const sea = seaDistance(A.RIPPLES[A.RIPPLES.length - 1]);
    const col = [0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, p = i * 3;
        if (own[i] === WATER) {
          const d = sea[i], k = A.RIPPLES.indexOf(d);
          const c = d === 1 ? A.coast : k >= 0 ? A.water.map((v, j) => v + (A.coast[j] - v) * A.RIPPLE_INK[k]) : A.water;
          base[p] = c[0]; base[p + 1] = c[1]; base[p + 2] = c[2];
          continue;
        }
        Render.reliefColor(Math.max(0, Math.min(1, hb[i])), lr[i], lg[i], lb[i], cold[i], forest[i], col);
        // Lit from the north-west, as in the game.
        const nw = x > 0 && y > 0 ? ht[i - W - 1] : ht[i], se = x < W - 1 && y < H - 1 ? ht[i + W + 1] : ht[i];
        const s = 1 + Math.max(-A.SHADE_MAX, Math.min(A.SHADE_MAX, (se - nw) * A.SHADE_K));
        base[p] = col[0] * s; base[p + 1] = col[1] * s; base[p + 2] = col[2] * s;
      }
    }
  }

  // Nation colours as the game's Atlas territory draws them: the fill over
  // the relief as a light wash plus a multiplied tint, darker in a band along borders.
  function buildTones() {
    const A = Render.ATLAS, F = A.FILL, bandA = 1 - (1 - A.BAND) * (1 - F);
    tones = PLAYER_COLORS.slice(0, NATIONS).map(rgb => {
      const fill = Render.atlasTone(rgb), border = fill.map(c => c * 0.55);
      const band = fill.map((c, k) => ((1 - A.BAND) * F * c + A.BAND * border[k]) / bandA);
      return { fill, band, bandA };
    });
  }

  function paintAtlas(i) {
    const A = Render.ATLAS, o = owner[i], p = i * 3, d = img.data, q = i * 4;
    const t = tones[o], x = i % W;
    let edge = false;
    for (let k = 0; k < 4 && !edge; k++) {
      const j = k === 0 ? (x < W - 1 ? i + 1 : -1) : k === 1 ? (x > 0 ? i - 1 : -1) : k === 2 ? i + W : i - W;
      edge = j >= 0 && j < W * H && owner[j] !== o && map.owner[j] !== WATER;
    }
    const c = edge ? t.band : t.fill, a = edge ? t.bandA : A.FILL;
    const wash = a * A.NEAR_WASH, tint = a * A.NEAR_TINT;
    for (let k = 0; k < 3; k++) {
      const over = base[p + k] + (c[k] - base[p + k]) * wash;
      d[q + k] = over * (1 - tint) + over * c[k] / 255 * tint;
    }
  }

  function paint(i) {
    const o = owner[i], d = img.data, p = i * 3, q = i * 4;
    if (o < 0) { d[q] = base[p]; d[q + 1] = base[p + 1]; d[q + 2] = base[p + 2]; return; }
    if (pal.atlas) { paintAtlas(i); return; }
    const c = PLAYER_COLORS[o], m = pal.mix;
    d[q] = base[p] + (c[0] - base[p]) * m;
    d[q + 1] = base[p + 1] + (c[1] - base[p + 1]) * m;
    d[q + 2] = base[p + 2] + (c[2] - base[p + 2]) * m;
  }

  // Claiming a tile moves the border, so Atlas redraws its neighbours too.
  function claim(i) {
    paint(i);
    if (!pal.atlas) return;
    const x = i % W;
    if (x < W - 1 && owner[i + 1] >= 0) paint(i + 1);
    if (x > 0 && owner[i - 1] >= 0) paint(i - 1);
    if (i + W < W * H && owner[i + W] >= 0) paint(i + W);
    if (i >= W && owner[i - W] >= 0) paint(i - W);
  }

  function newMap() {
    const seed = (Math.random() * 1e9) | 0;
    rng = mulberry32(seed ^ 0x5bd1e995);
    map = Object.create(GameMap);
    map.generate(W, H, seed >>> 0, Protocol.normalizeMapGen({}));
    owner = new Int16Array(W * H).fill(-1);
    frontier = [];
    buildBase();
    for (let i = 0; i < W * H; i++) { img.data[i * 4 + 3] = 255; paint(i); }
    for (let n = 0, tries = 0; n < NATIONS && tries < 4000; tries++) {
      const i = Math.floor(rng() * W * H);
      if (map.owner[i] === WATER || owner[i] >= 0) continue;
      owner[i] = n; frontier.push(i); claim(i);
      n++;
    }
    phase = 'grow';
  }

  function grow() {
    for (let k = 0; k < GROW_PER_TICK && frontier.length; k++) {
      const fi = Math.floor(rng() * frontier.length);
      const i = frontier[fi];
      const x = i % W;
      let open = false;
      for (let d = 0; d < 4; d++) {
        const j = i + NEIGHBORS[d];
        if (j < 0 || j >= W * H) continue;
        if (d < 2 && Math.abs(j % W - x) !== 1) continue;
        if (owner[j] >= 0 || map.owner[j] === WATER) continue;
        open = true;
        owner[j] = owner[i]; frontier.push(j); claim(j);
        break;
      }
      if (!open) { frontier[fi] = frontier[frontier.length - 1]; frontier.pop(); }
    }
    if (!frontier.length) { phase = 'hold'; holdLeft = HOLD_TICKS; }
  }

  function resize() {
    // Low internal resolution: the upscale is what makes it soft.
    view.width = Math.max(2, Math.round(window.innerWidth / 3));
    view.height = Math.max(2, Math.round(window.innerHeight / 3));
  }

  function draw(now) {
    const cw = view.width, ch = view.height;
    octx.putImageData(img, 0, 0);
    const time = (now - t0) / 1000;
    const zoom = 1.3 + 0.08 * Math.sin(time / 23);
    const s = Math.max(cw / W, ch / H) * zoom;
    const px = (W * s - cw), py = (H * s - ch);
    const x = -px * (0.5 + 0.5 * Math.sin(time / 31));
    const y = -py * (0.5 + 0.5 * Math.cos(time / 43));
    vctx.imageSmoothingEnabled = true;
    vctx.imageSmoothingQuality = 'high';
    vctx.fillStyle = 'rgb(' + pal.water.join(',') + ')';
    vctx.fillRect(0, 0, cw, ch);
    vctx.drawImage(off, x, y, W * s, H * s);
    let a = 1;
    if (phase === 'fade') a = Math.max(0, 1 - (now - fadeStart) / FADE_MS);
    else if (now - t0 < FADE_MS) a = (now - t0) / FADE_MS;
    view.style.opacity = a;
  }

  function tick() {
    if (!enabled || overlay.classList.contains('hidden')) return;
    const now = performance.now();
    if (phase === 'grow') grow();
    else if (phase === 'hold') {
      if (--holdLeft <= 0) { phase = 'fade'; fadeStart = now; }
    } else if (now - fadeStart >= FADE_MS) {
      newMap(); t0 = now;
    }
    draw(now);
  }

  try {
    resize();
    window.addEventListener('resize', resize);
    newMap();
    t0 = performance.now();
    overlay.classList.add('menuBgOn');
    setInterval(tick, TICK_MS);
  } catch (e) {
    console.error('[menu bg]', e);
    view.remove();
  }
  // Low graphics turns the backdrop off: no timer work, no canvas, and the
  // overlay falls back to its solid background.
  function setEnabled(on) {
    enabled = !!on;
    view.style.display = enabled ? '' : 'none';
    overlay.classList.toggle('menuBgOn', enabled && !!map);
  }
  // Recolours the map on screen in place, claimed land included.
  function setStyle(style) {
    const next = PALETTES[style] || PALETTES.classic;
    if (next === pal) return;
    pal = next;
    if (!map) return;
    buildBase();
    for (let i = 0; i < W * H; i++) paint(i);
  }
  return { setEnabled, setStyle };
})();
