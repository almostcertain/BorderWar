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
  const TERRAIN = [[78, 94, 72], [104, 96, 66], [122, 120, 114]];
  const WATER_RGB = [18, 34, 60];
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

  function paint(i, c, mix) {
    const t = TERRAIN[map.terrain[i]];
    const d = img.data, p = i * 4;
    d[p] = t[0] + (c[0] - t[0]) * mix;
    d[p + 1] = t[1] + (c[1] - t[1]) * mix;
    d[p + 2] = t[2] + (c[2] - t[2]) * mix;
  }

  function newMap() {
    const seed = (Math.random() * 1e9) | 0;
    rng = mulberry32(seed ^ 0x5bd1e995);
    map = Object.create(GameMap);
    map.generate(W, H, seed >>> 0, Protocol.normalizeMapGen({}));
    owner = new Int16Array(W * H).fill(-1);
    frontier = [];
    for (let i = 0; i < W * H; i++) {
      const p = i * 4, c = map.owner[i] === WATER ? WATER_RGB : TERRAIN[map.terrain[i]];
      img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
    }
    for (let n = 0, tries = 0; n < NATIONS && tries < 4000; tries++) {
      const i = Math.floor(rng() * W * H);
      if (map.owner[i] === WATER || owner[i] >= 0) continue;
      owner[i] = n; frontier.push(i); paint(i, PLAYER_COLORS[n], 0.8);
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
        owner[j] = owner[i]; frontier.push(j); paint(j, PLAYER_COLORS[owner[i]], 0.8);
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
    vctx.fillStyle = 'rgb(18,34,60)';
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
  return { setEnabled };
})();
