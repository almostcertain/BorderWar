const Render = {
  canvas: null,
  ctx: null,
  tileCanvas: null,
  tileCtx: null,
  tileLayer: null,   // chunked bitmaps of tileCanvas (see makeLayer)
  hoverLayer: null,
  image: null,
  pixels: null,
  terrain: null,     // Uint32Array of base water/land colours
  fillColor: null,   // per-player packed colour
  borderColor: null,
  cam: { x: 0, y: 0, scale: 3 },

  labels: [],
  labelsAt: 0,
  // ms between the START of one label sweep and the next. A sweep no longer
  // happens in a single frame (see computeLabelSlice) — it walks one nation
  // per frame — so this is a cadence, not the cost of a spike. Measured on an
  // Extra Large map mid-match: the old single-pass version flood-filled all
  // ~830k owned tiles in one 32ms frame, 3.3x a second, which is most of the
  // client-side hitching this interval was originally set to ration.
  LABEL_INTERVAL: 1000,

  // Sweep state for the sliced rebuild: the ids still to walk this sweep, the
  // labels gathered so far, and whether a sweep is currently in progress.
  // `labels` itself is only swapped in once a sweep completes, so drawLabels
  // never sees a half-updated set.
  labelQueue: [],
  labelsPending: [],
  labelSweeping: false,

  // Same reasoning as LABEL_INTERVAL, applied to the hover-time annexation
  // check: a mouse resting deep inside a huge, ordinary (non-enclosed)
  // nation still has to walk that nation's whole interior before the flood
  // fill finds the gap proving it's *not* enclosed — sweeping the cursor
  // across one at full pointermove rate would repeat that walk every tile.
  hoverAnnexAt: 0,
  ANNEX_HOVER_INTERVAL: 150,

  packed(r, g, b, a) { return ((a === undefined ? 255 : a) << 24) | (b << 16) | (g << 8) | r; },

  setup(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loadIcons();
  },

  // --- Map icons ---------------------------------------------------------------
  // Bespoke SVG icons (assets/icons/, previewed by assets/icons/preview.html)
  // in place of emoji on the map. Emoji looked different on every platform,
  // and in Firefox on Windows each one is layered gradient art rasterised on
  // the CPU every time it's drawn: a 2026-09-24 profile had the emoji in the
  // name labels at 70% of main-thread time (~19 fps). Each icon is rasterised
  // once per whole-pixel size into its own small canvas and stamped with
  // drawImage from then on, which every browser does cheaply.
  ICON_NAMES: ['ally', 'teammate', 'target', 'traitor', 'embargo', 'expiring', 'drill'],
  iconImages: null,
  iconCache: new Map(),

  loadIcons() {
    this.iconImages = {};
    for (const name of this.ICON_NAMES) {
      const img = new Image();
      img.src = 'assets/icons/' + name + '.svg';
      this.iconImages[name] = img;
    }
  },

  // The pre-rendered icon at `size` device pixels, or null until its SVG has
  // loaded (callers just skip drawing it for those first frames).
  icon(name, size) {
    const px = Math.max(4, Math.round(size));
    const key = name + ':' + px;
    let c = this.iconCache.get(key);
    if (c) return c;
    const img = this.iconImages && this.iconImages[name];
    if (!img || !img.complete || !img.naturalWidth) return null;
    c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(img, 0, 0, px, px);
    this.iconCache.set(key, c);
    return c;
  },

  // Low graphics: draw at one canvas pixel per CSS pixel even on a Retina /
  // HiDPI screen. That is a quarter of the pixels to fill, blend and upload
  // every frame, which is what a weak integrated GPU (e.g. a 2017 MacBook's
  // Iris 640) runs out of first. Everything on the map is sized off this.dpr,
  // so it all scales down together; text is just a little softer.
  lowRes: false,
  setLowRes(on) {
    this.lowRes = !!on;
    if (this.canvas) this.resize();
  },

  resize() {
    const dpr = this.lowRes ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.dpr = dpr;
  },

  onMapReady() {
    const w = GameMap.width, h = GameMap.height;
    this.tileCanvas = document.createElement('canvas');
    this.tileCanvas.width = w;
    this.tileCanvas.height = h;
    this.tileCtx = this.tileCanvas.getContext('2d');
    this.image = this.tileCtx.createImageData(w, h);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.qHead = this.qTail = 0;   // a previous match's pending reveal is meaningless here
    // Sprites are keyed by player id, and ids (and their colours) are reused
    // by the next match.
    for (const [id, sp] of this.labelSprites) this.dropLabelSprite(id, sp);
    this.structSprites.clear();
    this.structSpriteR = -1;
    this.fogSource = null;         // the fog layer restarts from the new match's vision grid (updateFog)
    this.fogChanged();

    // Unclaimed ground, one tone per terrain: grassy plains, dun highland,
    // bare grey mountain.
    const water = this.packed(18, 34, 60);
    const bare = [this.packed(78, 94, 72), this.packed(104, 96, 66), this.packed(122, 120, 114)];
    this.bareTone = bare;
    this.altRel = null;   // alt view's relation table is per-match, like the colours below
    this.altView = false;
    this.terrain = new Uint32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      this.terrain[i] = GameMap.owner[i] === WATER ? water : bare[GameMap.terrain[i]];
    }

    // Owned tiles keep the nation's colour but darken over rough ground, so
    // ranges stay legible once the map is carved up — which is the whole point
    // of having terrain, since that is when it decides where fronts stall.
    const SHADE = [1, 0.84, 0.7];
    this.fillColor = [];
    this.borderColor = new Uint32Array(Game.players.length);
    for (let p = 0; p < Game.players.length; p++) {
      const [r, g, b] = Game.players[p].color;
      this.fillColor[p] = new Uint32Array(3);
      for (let t = 0; t < 3; t++) {
        const s = SHADE[t] * 0.62;
        this.fillColor[p][t] = this.packed(r * s, g * s, b * s);
      }
      this.borderColor[p] = this.packed(
        Math.min(255, r * 1.15 + 40), Math.min(255, g * 1.15 + 40), Math.min(255, b * 1.15 + 40));
    }

    // Hover highlight: a second per-pixel image the same size as tileCanvas,
    // transparent everywhere except the hovered nation's tiles, blitted in
    // lockstep with it. One pixel per tile like tileCanvas itself, so it
    // scales, pans and stays crisp identically — and it means highlighting a
    // nation is a fill of its own tile set, not thousands of individual
    // fillRect calls every frame.
    this.hoverCanvas = document.createElement('canvas');
    this.hoverCanvas.width = w;
    this.hoverCanvas.height = h;
    this.hoverCtx = this.hoverCanvas.getContext('2d');
    this.hoverImage = this.hoverCtx.createImageData(w, h);
    this.hoverPixels = new Uint32Array(this.hoverImage.data.buffer);
    this.hoverBuiltFor = -1;
    this.hoverBox = null;

    if (this.tileLayer) this.disposeLayer(this.tileLayer);
    if (this.hoverLayer) this.disposeLayer(this.hoverLayer);
    this.tileLayer = this.makeLayer(this.tileCanvas, true);
    this.hoverLayer = this.makeLayer(this.hoverCanvas, false);
  },

  // --- Chunked bitmap layers ---------------------------------------------------
  // tileCanvas and hoverCanvas are map-sized (8MB each on the large map) and
  // edited with putImageData, which leaves them as plain CPU canvases. Firefox
  // hands such a canvas to its GPU process by copying the whole thing on every
  // drawImage, changed or not: a 2026-09-28 profile on the large map had those
  // copies (plus the matching texture allocations in the GPU process) as the
  // main reason the game ran at ~30fps with the main thread 60% idle.
  //
  // So each layer is stamped from LAYER_CHUNK-sized ImageBitmaps instead. An
  // ImageBitmap is immutable, so the browser uploads it once and reuses the
  // texture; only chunks whose pixels changed get a new one. A chunk waiting on
  // its new bitmap keeps showing the old one for a frame (or the canvas region
  // itself before it has any), which the paced reveal already hides.
  // An opaque layer's bitmaps reach one tile into their right and bottom
  // neighbours, so fractional zoom never opens a hairline seam between chunks.
  // A translucent layer (the hover tint) can't overlap: the shared row and
  // column would be blended twice and show as stripes on the chunk grid.
  //
  // Changed tiles are tracked per chunk, not as one bounding box: with fronts
  // all over a large map a single box covered the whole map, so every chunk
  // was re-blitted and re-uploaded nearly every frame (2026-09-28 profile).
  LAYER_CHUNK: 128,

  makeLayer(canvas, overlap) {
    const C = this.LAYER_CHUNK, w = canvas.width, h = canvas.height, o = overlap ? 1 : 0;
    const layer = { canvas, cols: Math.ceil(w / C), rows: Math.ceil(h / C), chunks: [], alive: true };
    for (let cy = 0; cy < layer.rows; cy++) {
      for (let cx = 0; cx < layer.cols; cx++) {
        const x = cx * C, y = cy * C;
        layer.chunks.push({ x, y, w: Math.min(C + o, w - x), h: Math.min(C + o, h - y),
                            bmp: null, dirty: true, pending: false, put: false });
      }
    }
    return layer;
  },

  disposeLayer(layer) {
    layer.alive = false;
    for (const c of layer.chunks) if (c.bmp) { c.bmp.close(); c.bmp = null; }
  },

  // Flags every chunk whose bitmap covers any of tiles [minX..maxX]x[minY..maxY].
  // The overlap tile means a change on a chunk's first row/column also
  // touches the neighbour before it.
  markLayerDirty(layer, minX, minY, maxX, maxY) {
    if (!layer) return;
    const C = this.LAYER_CHUNK;
    const cx0 = Math.max(0, Math.floor((minX - 1) / C)), cx1 = Math.min(layer.cols - 1, Math.floor(maxX / C));
    const cy0 = Math.max(0, Math.floor((minY - 1) / C)), cy1 = Math.min(layer.rows - 1, Math.floor(maxY / C));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) layer.chunks[cy * layer.cols + cx].dirty = true;
    }
  },

  // Records that tile (x, y) of the layer's canvas image changed: its chunk
  // needs a blit and a new bitmap, and so do the neighbours whose overlap
  // row/column contains it.
  markLayerTile(layer, x, y) {
    if (!layer) return;
    const C = this.LAYER_CHUNK, cols = layer.cols, chunks = layer.chunks;
    const cx = (x / C) | 0, cy = (y / C) | 0, k = cy * cols + cx;
    const c = chunks[k];
    c.put = true;
    c.dirty = true;
    const left = cx > 0 && x === cx * C, up = cy > 0 && y === cy * C;
    if (left) chunks[k - 1].dirty = true;
    if (up) chunks[k - cols].dirty = true;
    if (left && up) chunks[k - cols - 1].dirty = true;
  },

  // Blits the chunks markLayerTile flagged from `image` into the canvas.
  flushLayerPuts(layer, ctx, image) {
    if (!layer) return;
    const C = this.LAYER_CHUNK, w = layer.canvas.width, h = layer.canvas.height;
    for (const c of layer.chunks) {
      if (!c.put) continue;
      c.put = false;
      ctx.putImageData(image, 0, 0, c.x, c.y, Math.min(C, w - c.x), Math.min(C, h - c.y));
    }
  },

  // Starts a new bitmap for each dirty chunk not already waiting on one. A
  // chunk dirtied again while pending stays dirty and goes round once more.
  refreshLayer(layer) {
    if (layer.noBitmap) return;
    for (const c of layer.chunks) {
      if (!c.dirty || c.pending) continue;
      c.dirty = false;
      c.pending = true;
      let req;
      try {
        req = createImageBitmap(layer.canvas, c.x, c.y, c.w, c.h);
      } catch (e) {
        layer.noBitmap = true;     // no createImageBitmap: stamp the canvas as before
        return;
      }
      req.then(bmp => {
        c.pending = false;
        if (!layer.alive) { bmp.close(); return; }
        if (c.bmp) c.bmp.close();
        c.bmp = bmp;
      }, () => { c.pending = false; layer.noBitmap = true; });
    }
  },

  // Draws the layer with its top-left at (ox, oy) in the current transform
  // (one unit per tile), skipping chunks outside the viewport or `box`.
  drawLayer(ctx, layer, ox, oy, box) {
    this.refreshLayer(layer);
    const s = this.cam.scale * this.dpr;
    const halfW = this.canvas.width / 2 / s, halfH = this.canvas.height / 2 / s;
    const vx0 = this.cam.x - halfW, vx1 = this.cam.x + halfW;
    const vy0 = this.cam.y - halfH, vy1 = this.cam.y + halfH;
    for (const c of layer.chunks) {
      if (c.x > vx1 || c.x + c.w < vx0 || c.y > vy1 || c.y + c.h < vy0) continue;
      if (box && (c.x > box.maxX || c.x + c.w <= box.minX || c.y > box.maxY || c.y + c.h <= box.minY)) continue;
      if (c.bmp) ctx.drawImage(c.bmp, ox + c.x, oy + c.y);
      else ctx.drawImage(layer.canvas, c.x, c.y, c.w, c.h, ox + c.x, oy + c.y, c.w, c.h);
    }
  },

  // Rebuilds the hover overlay for whichever nation UI.hoverId names. Only
  // called when that changes or the map's ownership does (draw() passes
  // territoryChanged through) — not every frame, so resting the mouse over a
  // huge nation costs one Set walk on the change, not one every 16ms.
  buildHoverOverlay(id) {
    const px = this.hoverPixels;
    const prev = this.hoverBox;
    if (prev) {
      const w = GameMap.width;
      for (let y = prev.minY; y <= prev.maxY; y++) px.fill(0, y * w + prev.minX, y * w + prev.maxX + 1);
    }
    this.hoverBox = null;
    const p = Game.players[id];
    if (!p) { this.flushHoverOverlay(prev); return; }

    // If the tile actually under the cursor sits in a patch of this nation's
    // land that's fully walled in by ours, tint gold instead of the plain
    // whole-nation wash — a visible "tap to annex free" cue ahead of the
    // click, and distinct from hovering their untouched mainland (same
    // nation, same id, not enclosed) which still gets the ordinary tint
    // below. Every walled-in patch of theirs is tinted, not just the hovered
    // one, because that is what the tap now takes (see UI.onTap) — after a
    // nuke that lights up the whole scatter of survivors at once. The full
    // sweep only runs once the cheap single walk has confirmed the cursor is
    // actually on a pocket, so ordinary hovering never pays for it.
    // enclosedRegion no longer takes a single "wall owner" — a pocket's wall
    // can now be a mix of players (see game/annex.js's 2026-09-09 fix) — so this
    // single-shot check supplies its own scratch seen/run and additionally
    // confirms Game.me is actually one of the pocket's wall contributors
    // (wallCounts.has), matching what a tap here would actually be able to
    // take (enclosedPocketsOf/UI.onTap accept any touching wall, not just a
    // dominant one).
    //
    // It also has to agree with enclosedPocketsOf on the mainland-vs-fragment
    // rule (game/annex.js's 2026-09-27 fix, #39): no wall, mixed or
    // single-owner, ever takes a nation's largest piece, only a fragment.
    // Skipping that check here used to make this walk see a mainland as
    // annexable while enclosedPocketsOf (correctly) refused it — for a
    // tribe wedged between neighbours, that meant hovering it took the
    // gold-pocket branch below, enclosedPocketsOf came back empty, and
    // nothing got painted at all instead of falling back to the plain wash.
    const found = id !== Game.me ? Game.enclosedRegion(UI.hoverTile, new Map(), 1) : null;
    const isMainland = found && found.tiles.length >= Game.largestLandPiece(id);
    const region = found && !isMainland && found.wallCounts.has(Game.me) ? found : null;
    if (region) {
      const c = this.packed(255, 215, 60, 130);
      for (const r of Game.enclosedPocketsOf(id, Game.me)) this.paintHoverTiles(r, c);
    } else {
      // Low alpha, plain white: brightens whatever colour is already there
      // rather than imposing one of its own, so it reads the same over a
      // vivid Nation and a muted Tribe alike.
      const c = this.packed(255, 255, 255, 60);
      this.paintHoverTiles(p.tiles, c);
    }
    this.flushHoverOverlay(prev);
  },

  // Paints `tiles` into the hover overlay and grows hoverBox around them.
  paintHoverTiles(tiles, c) {
    const px = this.hoverPixels, w = GameMap.width;
    let b = this.hoverBox;
    if (!b) b = this.hoverBox = { minX: w, minY: GameMap.height, maxX: -1, maxY: -1 };
    for (const t of tiles) {
      px[t] = c;
      const x = t % w, y = (t / w) | 0;
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
    }
    if (b.maxX < 0) this.hoverBox = null;
  },

  // Blits just the part of the overlay that changed — the old box (now
  // cleared) and the new one — instead of the whole map-sized image.
  flushHoverOverlay(prev) {
    const cur = this.hoverBox;
    if (!prev && !cur) return;
    const a = prev || cur, b = cur || prev;
    const minX = Math.min(a.minX, b.minX), minY = Math.min(a.minY, b.minY);
    const maxX = Math.max(a.maxX, b.maxX), maxY = Math.max(a.maxY, b.maxY);
    this.hoverCtx.putImageData(this.hoverImage, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
    this.markLayerDirty(this.hoverLayer, minX, minY, maxX, maxY);
  },

  drawHoverHighlight(territoryChanged, ctx) {
    const id = UI.hoverId;
    // Fog: a cursor over undiscovered ground highlights nothing, whatever the
    // UI has decided is hovered (hoverTile is -1 when the hover is a boat).
    if (id < 0 || (this.fogged && UI.hoverTile >= 0 && this.fogHides(UI.hoverTile))) {
      this.hoverBuiltFor = -1;
      return;
    }
    const now = performance.now();
    const tileMoved = UI.hoverTile !== this.hoverBuiltForTile;
    // Switching to a different nation rebuilds immediately — that one is a
    // direct answer to the cursor and has to feel instant. A territory change
    // or a same-nation tile move goes through the throttle instead.
    //
    // territoryChanged used to rebuild immediately too, which sounds cheap
    // and isn't: it is true on any frame ANY tile anywhere changed hands, so
    // during a push (or just bots fighting somewhere off screen) it fired on
    // essentially every frame, and each rebuild repaints the hovered nation's
    // whole tile set — 4ms a frame on an Extra Large map, sustained, for a
    // tint that nobody can see updating at 60Hz.
    if (id !== this.hoverBuiltFor ||
        ((territoryChanged || tileMoved) && now - this.hoverAnnexAt > this.ANNEX_HOVER_INTERVAL)) {
      this.buildHoverOverlay(id);
      this.hoverBuiltFor = id;
      this.hoverBuiltForTile = UI.hoverTile;
      this.hoverAnnexAt = now;
    }
    if (this.hoverBox) this.drawLayer(ctx, this.hoverLayer, -this.cam.x, -this.cam.y, this.hoverBox);
  },

  // Opens on the whole map, fitted to the viewport with a little breathing
  // room, rather than a close-up on the player's spawn.
  centerOnMap() {
    this.cam.x = GameMap.width / 2;
    this.cam.y = GameMap.height / 2;
    this.cam.scale = Math.min(
      window.innerWidth / GameMap.width,
      window.innerHeight / GameMap.height) * 0.92;
  },

  // One tile's pixel: its terrain tone if unowned, otherwise its owner's
  // fill color, brightened to a border tone if any neighbor has a different
  // owner. Shared by the full rebuild and the incremental one below so the
  // two can never drift apart on what a tile is supposed to look like.
  paintTile(i, x, y, w, h, owner, px) {
    const o = owner[i];
    let color;
    if (o < 0) {
      color = this.terrain[i];
    } else if (this.altView) {
      const edge =
        (x > 0 && owner[i - 1] !== o) ||
        (x < w - 1 && owner[i + 1] !== o) ||
        (y > 0 && owner[i - w] !== o) ||
        (y < h - 1 && owner[i + w] !== o);
      const rel = this.altRel[o];
      color = edge ? this.altBorder[rel] : this.altFill[rel][GameMap.terrain[i]];
    } else {
      const edge =
        (x > 0 && owner[i - 1] !== o) ||
        (x < w - 1 && owner[i + 1] !== o) ||
        (y > 0 && owner[i - w] !== o) ||
        (y < h - 1 && owner[i + w] !== o);
      color = edge ? this.borderColor[o] : this.fillColor[o][GameMap.terrain[i]];
    }
    // Irradiated land (see Game.fallout/detonateNuke) reads as a sickly
    // warning wash over whatever it would otherwise look like — almost
    // always bare unclaimed terrain (GameImpl's own setFallout throws on an
    // owned tile), so this only fires for the o<0 branch above in practice,
    // but blending rather than overriding keeps it correct either way.
    if (Game.fallout && Game.fallout.size && Game.fallout.has(i)) color = this.tintFallout(color);
    // The Drill's dead zone (Game.drillDead, permanent): dead land reads as a
    // dark irradiated violet, distinct from fallout's yellow-green. The sweep
    // queues every land tile it kills in dirtyTiles, so this repaints only
    // what died; dead water is tinted by drawDrill's circle overlay.
    else if (Game.drillDeadLand > 0 && Game.drillDead[i] && o !== WATER) color = this.tintDead(color);
    px[i] = color;
  },

  DEAD_TINT: [34, 6, 44],
  tintDead(color) {
    const r = color & 0xff, g = (color >> 8) & 0xff, b = (color >> 16) & 0xff, a = (color >>> 24) & 0xff;
    const t = this.DEAD_TINT, mix = 0.72;
    return this.packed(
      (r * (1 - mix) + t[0] * mix) | 0,
      (g * (1 - mix) + t[1] * mix) | 0,
      (b * (1 - mix) + t[2] * mix) | 0,
      a
    );
  },

  // --- Alternate view (hold Space), after OpenFront -------------------------
  // Strips the nation colours off the map: owned land is drawn as bare
  // terrain under a faint wash, and every border is recoloured by its
  // relationship to you — self green, ally/teammate yellow, embargo red,
  // everyone else grey. OpenFront's render-settings: fillAlpha 0.15, the same
  // four colours. Names, badges and fronts are hidden while it is up (draw()).
  altView: false,
  ALT_COLORS: [[0, 255, 0], [255, 255, 0], [128, 128, 128], [255, 0, 0]],
  ALT_FILL_ALPHA: 0.15,
  altRelKey: '',

  setAltView(on) {
    on = !!on;
    if (on === this.altView || !this.tileCanvas) return;
    this.altView = on;
    if (on) this.updateAltRelations(true);
    else this.repaintAll();
  },

  // 0 self, 1 ally, 2 neutral, 3 embargo — from Game.me's point of view.
  altRelationOf(id) {
    const me = Game.me;
    if (me < 0) return 2;
    if (id === me) return 0;
    if (Game.areAllied(me, id)) return 1;
    if (Game.hasEmbargoAgainst(me, id) || Game.hasEmbargoAgainst(id, me)) return 3;
    return 2;
  },

  // Recomputes everyone's relation and repaints only when one of them
  // changed (an alliance signed mid-hold, say) — otherwise it is just a
  // string compare, cheap enough to run every frame.
  updateAltRelations(force) {
    const n = Game.players.length;
    if (!this.altRel || this.altRel.length !== n) this.altRel = new Uint8Array(n);
    let key = '';
    for (let p = 0; p < n; p++) key += this.altRelationOf(p);
    if (!force && key === this.altRelKey) return;
    this.altRelKey = key;
    for (let p = 0; p < n; p++) this.altRel[p] = key.charCodeAt(p) - 48;
    if (!this.altFill) {
      const a = this.ALT_FILL_ALPHA;
      this.altFill = [];
      this.altBorder = new Uint32Array(4);
      for (let r = 0; r < 4; r++) {
        const c = this.ALT_COLORS[r];
        this.altBorder[r] = this.packed(c[0], c[1], c[2]);
        this.altFill[r] = new Uint32Array(3);
        for (let t = 0; t < 3; t++) {
          const b = this.bareTone[t];
          const mix = (k, sh) => (((b >> sh) & 0xff) * (1 - a) + c[k] * a) | 0;
          this.altFill[r][t] = this.packed(mix(0, 0), mix(1, 8), mix(2, 16));
        }
      }
    }
    this.repaintAll();
  },

  repaintAll() {
    this.buildTiles();
    this.qHead = this.qTail = 0;   // everything queued is painted from the live owner now
  },

  // Fixed-ratio blend toward FALLOUT_TINT, done in unpacked RGB space and
  // repacked — see the `packed` helper this mirrors. mix=0.45 keeps the
  // underlying terrain/border tone (and therefore ownership, still legible
  // at a glance) rather than replacing it outright.
  FALLOUT_TINT: [190, 210, 70],
  tintFallout(color) {
    const r = color & 0xff, g = (color >> 8) & 0xff, b = (color >> 16) & 0xff, a = (color >>> 24) & 0xff;
    const t = this.FALLOUT_TINT, mix = 0.45;
    return this.packed(
      (r * (1 - mix) + t[0] * mix) | 0,
      (g * (1 - mix) + t[1] * mix) | 0,
      (b * (1 - mix) + t[2] * mix) | 0,
      a
    );
  },

  buildTiles() {
    const w = GameMap.width, h = GameMap.height;
    const owner = GameMap.owner, px = this.pixels;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        this.paintTile(y * w + x, x, y, w, h, owner, px);
      }
    }
    this.tileCtx.putImageData(this.image, 0, 0);
    this.markLayerDirty(this.tileLayer, 0, 0, w - 1, h - 1);
  },

  // Recolors just the tiles Game.setOwner touched since the last rebuild
  // (already expanded to their neighbors there) instead of the whole map —
  // the same per-pixel result as buildTiles(), just proportional to how much
  // territory actually changed instead of total map size. Also narrows the
  // putImageData blit to the changed tiles' bounding box, which helps unless
  // damage is scattered across the map (e.g. two unrelated fronts active at
  // once), in which case it falls back toward a full-width/height blit —
  // never worse than buildTiles()'s own unconditional full blit.
  buildTilesIncremental(dirtyTiles) {
    const w = GameMap.width, h = GameMap.height;
    const owner = GameMap.owner, px = this.pixels;
    const layer = this.tileLayer;
    for (const i of dirtyTiles) {
      const x = i % w, y = (i / w) | 0;
      this.paintTile(i, x, y, w, h, owner, px);
      this.markLayerTile(layer, x, y);
    }
    this.flushLayerPuts(layer, this.tileCtx, this.image);
  },

  // --- Paced territory reveal ------------------------------------------------
  // The sim only advances on a turn (Protocol.TURN_INTERVAL_MS, 100ms), and a
  // whole turn's conquests land in one tick, so painting them the frame they
  // arrive makes a front visibly step ten times a second regardless of how
  // fast the display is. This spreads each turn's changed tiles across the
  // next REVEAL_MS of frames instead, in conquest order (the dirty list is
  // insertion-ordered), so the edge sweeps forward rather than jumping.
  //
  // Pure presentation: the sim, the wire and the state hash never see it.
  // The canvas trails GameMap.owner by at most REVEAL_MS, and every tile is
  // painted from the *current* owner when its slot comes up, so it always
  // converges to exactly what buildTiles() would draw. Set smoothTerritory
  // false to fall back to the old paint-on-arrival behaviour.
  smoothTerritory: true,
  REVEAL_MS: 90,          // a little under one turn, so a batch is done before the next lands
  qTile: new Int32Array(1 << 16),
  qTime: new Float64Array(1 << 16),
  qHead: 0,
  qTail: 0,

  // Moves this frame's dirty tiles into the reveal queue, timestamped across
  // [now, now + REVEAL_MS]. Anything still queued from the previous turn is
  // flushed first: turns arriving faster than REVEAL_MS (debug burst, catch-up,
  // a sped-up local game) degrade gracefully to paint-on-arrival instead of
  // building up lag.
  enqueueDirty(dirty, now) {
    const n = dirty.size;
    if (this.qHead < this.qTail) this.releaseTiles(Infinity);
    if (this.qTile.length < n) {
      let cap = this.qTile.length;
      while (cap < n) cap *= 2;
      this.qTile = new Int32Array(cap);
      this.qTime = new Float64Array(cap);
    }
    const T = this.qTile, TM = this.qTime, step = this.REVEAL_MS / n;
    let k = 0;
    for (const i of dirty) { T[k] = i; TM[k] = now + step * k; k++; }
    this.qHead = 0;
    this.qTail = n;
  },

  // Paints every queued tile whose slot has come up (all of them for
  // Infinity), then blits just the chunks they fell in.
  releaseTiles(now) {
    const T = this.qTile, TM = this.qTime, tail = this.qTail;
    let head = this.qHead;
    if (head >= tail) return;
    const w = GameMap.width, h = GameMap.height;
    const owner = GameMap.owner, px = this.pixels;
    const layer = this.tileLayer;
    while (head < tail && TM[head] <= now) {
      const i = T[head++];
      const x = i % w, y = (i / w) | 0;
      this.paintTile(i, x, y, w, h, owner, px);
      this.markLayerTile(layer, x, y);
    }
    this.qHead = head;
    this.flushLayerPuts(layer, this.tileCtx, this.image);
  },

  // Recenters the view on a tile without touching zoom — used when the
  // player taps a fronts-row chip to jump to that front. clampCamera() runs
  // again on the very next frame regardless, so there's no need to clamp here.
  jumpToTile(tx, ty) {
    this.cam.x = tx;
    this.cam.y = ty;
  },

  clampCamera() {
    const viewW = this.canvas.width / (this.cam.scale * this.dpr);
    const viewH = this.canvas.height / (this.cam.scale * this.dpr);
    const marginX = Math.min(GameMap.width * 0.5, viewW * 0.5);
    const marginY = Math.min(GameMap.height * 0.5, viewH * 0.5);
    this.cam.x = Math.max(-marginX, Math.min(GameMap.width + marginX, this.cam.x));
    this.cam.y = Math.max(-marginY, Math.min(GameMap.height + marginY, this.cam.y));

    const minScale = Math.min(
      this.canvas.width / this.dpr / GameMap.width,
      this.canvas.height / this.dpr / GameMap.height) * 0.45;
    // Max-zoom-in bound scales with viewport too, so it never fights the
    // adaptive zoom in centerOnMap() on large/high-res screens.
    const maxScale = Math.max(60, Math.min(window.innerWidth, window.innerHeight) / 8);
    this.cam.scale = Math.max(minScale, Math.min(maxScale, this.cam.scale));
  },

  screenToTile(sx, sy) {
    const s = this.cam.scale;
    const x = Math.floor((sx - window.innerWidth / 2) / s + this.cam.x);
    const y = Math.floor((sy - window.innerHeight / 2) / s + this.cam.y);
    if (x < 0 || y < 0 || x >= GameMap.width || y >= GameMap.height) return -1;
    return GameMap.idx(x, y);
  },

  // --- Fog of war --------------------------------------------------------------
  // docs/fog-of-war.md. What each nation has discovered is sim state
  // (game/vision.js); everything here only reads it, to decide what the local
  // viewer is shown, and writes nothing back.
  //
  // WHO IS FOGGED. fogActive() is the one place that decides whether the
  // viewer's picture is restricted at all, and canSee() the one place that
  // answers "is this tile inside what the viewer has discovered". The UI
  // (leaderboard, hover panel, radial menu) should filter on these two rather
  // than re-derive the rule. Both read the sim directly, so they are right at
  // any moment, input handlers included.
  //
  // The whole map is shown (fogActive() false, canSee() true for every tile)
  // when any of these holds:
  //   - the match has no fog (Game.fog);
  //   - the match is over (Game.winnerId is set): the fog lifts for everyone;
  //   - the viewer has been eliminated (their player's `alive` is false),
  //     from that turn on, team game or not;
  //   - the viewer is not a nation at all: Game.me names no player, or one
  //     with no vision group. This is the spectator and replay case. Neither
  //     exists as a client mode yet (a spectating client currently falls back
  //     to viewing as player 0, see main.js's `start` handler); whatever adds
  //     one only has to leave Game.me off the roster, e.g. -1, which
  //     altRelationOf and drawDiploBadges already treat as "no viewer".
  fogActive() {
    if (!Game.fog || Game.winnerId !== null) return false;
    const me = Game.players[Game.me];
    return !!me && me.alive && Game.visionGroup(Game.me) >= 0;
  },

  // True if the viewer may be shown what is on `tile`: always while
  // fogActive() is false, otherwise only inside their discovered area (never
  // for a tile off the map).
  canSee(tile) {
    return !this.fogActive() || Game.isDiscovered(Game.me, tile);
  },

  // THE LAYER. A small canvas with one pixel per CORNER of the sim's vision
  // grid rather than per cell: cells + 1 each way, 251x126 on the large map.
  // A corner is opaque while any cell touching it is undiscovered and clear
  // once they all are. Stretched over the map with smoothing, that leaves an
  // undiscovered cell solid across its whole area (all four of its corners
  // are opaque) and puts the soft edge, one cell wide, entirely inside the
  // discovered cells along the boundary. A pixel per cell would centre the
  // blend on the boundary instead and show the first half-cell of
  // undiscovered terrain through it.
  //
  // updateFog() keeps the layer in step with the viewer's vision group.
  // Game.visionCount[group] changes exactly when the group's discovered set
  // does, so on most frames the whole cost is comparing it with fogSeenCount.
  // When it has grown, the grid is walked for the cells the layer has not got
  // yet (fogSeen is the layer's own copy of the group's bits, and the walk
  // stops once it has found as many as the count grew by), their corners are
  // recomputed, and only the rectangle they fall in is blitted.
  //
  // Like the map layers above, the canvas is edited with putImageData, so
  // Firefox would copy it to the GPU on every draw. It is tiny, but once it
  // has held still for FOG_BITMAP_SETTLE frames it is swapped for an
  // ImageBitmap anyway; while the viewer is still exploring, the canvas itself
  // is stamped and no bitmaps are churned.
  //
  // CULLING. The layer is drawn over the whole world (see draw() for the
  // order), but no pass relies on it to hide anything: each one also skips
  // what fogHides()/fogHidesAt() say the viewer has not discovered. Those two
  // read fogSeen, so they are only for the passes draw() runs after
  // updateFog(), behind a check of `fogged`; anything answering a question
  // from outside a frame (the hit-tests) goes through canSee().
  FOG_COLOR: [6, 10, 20],        // the backdrop draw() clears to, so the fog and the void past the map's edge are one
  FOG_BITMAP_SETTLE: 30,
  FOG_SUB: 8,                    // layer pixels per vision cell each way
  FOG_EDGE_LO: 0.8,              // blended corner opacity at or below which a pixel is clear
  FOG_EDGE_HI: 0.95,             // ... and at or above which it is solid; the gap is the edge's width
  fogCorners: null,              // Uint8Array per vision-grid corner: 1 while any cell touching it is undiscovered
  fogged: false,                 // fogActive(), sampled once per draw()
  fogCanvas: null,
  fogCtx: null,
  fogImage: null,
  fogPixels: null,
  fogSeen: null,                 // Uint8Array per vision cell: 1 once the viewer's group has discovered it
  fogSeenCount: 0,
  fogW: 0,                       // vision grid size in cells, as built
  fogH: 0,
  fogGroup: -1,
  fogSource: null,               // the Game.visionCells the layer was built from; a new match has a new one
  fogBmp: null,
  fogBmpPending: false,
  fogNoBitmap: false,
  fogGen: 0,
  fogSteady: 0,

  // Starts the layer again from fully fogged: a new match, or a new viewer.
  resetFog(g) {
    const cw = Game.visionCellsW, ch = Game.visionCellsH;
    if (!this.fogCanvas || this.fogW !== cw || this.fogH !== ch) {
      this.fogCanvas = document.createElement('canvas');
      const S = this.FOG_SUB;
      this.fogCanvas.width = cw * S + 1;
      this.fogCanvas.height = ch * S + 1;
      this.fogCtx = this.fogCanvas.getContext('2d');
      this.fogImage = this.fogCtx.createImageData(cw * S + 1, ch * S + 1);
      this.fogPixels = new Uint32Array(this.fogImage.data.buffer);
      this.fogSeen = new Uint8Array(cw * ch);
      this.fogCorners = new Uint8Array((cw + 1) * (ch + 1));
      this.fogW = cw;
      this.fogH = ch;
    }
    const c = this.FOG_COLOR;
    this.fogSeen.fill(0);
    this.fogCorners.fill(1);
    this.fogSeenCount = 0;
    this.fogPixels.fill(this.packed(c[0], c[1], c[2]));
    this.fogCtx.putImageData(this.fogImage, 0, 0);
    this.fogGroup = g;
    this.fogSource = Game.visionCells;
    this.fogChanged();
  },

  // The canvas no longer matches any bitmap made from it, finished or not.
  fogChanged() {
    this.fogGen++;
    this.fogSteady = 0;
    if (this.fogBmp) { this.fogBmp.close(); this.fogBmp = null; }
  },

  // Clears corner (i, j) of the vision grid if every cell meeting there (up to
  // four) is now discovered. Cells past the map's edge don't exist and so
  // never hold a corner opaque; and discovery is permanent, so a corner never
  // has to be put back.
  fogCorner(i, j) {
    const cw = this.fogW, ch = this.fogH, seen = this.fogSeen;
    const left = i > 0, right = i < cw;
    let clear = true;
    if (j > 0) {
      const row = (j - 1) * cw + i;
      clear = (!left || seen[row - 1] !== 0) && (!right || seen[row] !== 0);
    }
    if (clear && j < ch) {
      const row = j * cw + i;
      clear = (!left || seen[row - 1] !== 0) && (!right || seen[row] !== 0);
    }
    if (clear) this.fogCorners[j * (cw + 1) + i] = 0;
  },

  // Repaints the layer's pixels for corners i0..i1, j0..j1 (inclusive) and the
  // cells around them. Each pixel is the bilinear blend of its cell's four
  // corners, pushed through a steep smoothstep: the edge is a fraction of a
  // cell wide instead of the whole cell a plain stretch would give. The ramp
  // starts well inside the discovered cell (t = 0.95 is nearly at the
  // undiscovered boundary), so undiscovered ground stays fully covered.
  fogPaint(i0, j0, i1, j1) {
    const cw = this.fogW, ch = this.fogH, S = this.FOG_SUB, stride = cw * S + 1;
    const corners = this.fogCorners, cs = cw + 1, px = this.fogPixels, c = this.FOG_COLOR;
    const lo = this.FOG_EDGE_LO, hi = this.FOG_EDGE_HI, rgb = this.packed(c[0], c[1], c[2], 0);
    const pxMin = Math.max(0, (i0 - 1) * S), pxMax = Math.min(cw * S, (i1 + 1) * S);
    const pyMin = Math.max(0, (j0 - 1) * S), pyMax = Math.min(ch * S, (j1 + 1) * S);
    for (let py = pyMin; py <= pyMax; py++) {
      const j = Math.min((py / S) | 0, ch), j1c = Math.min(j + 1, ch), fy = py / S - j;
      for (let p = pxMin; p <= pxMax; p++) {
        const i = Math.min((p / S) | 0, cw), i1c = Math.min(i + 1, cw), fx = p / S - i;
        const top = corners[j * cs + i] * (1 - fx) + corners[j * cs + i1c] * fx;
        const bot = corners[j1c * cs + i] * (1 - fx) + corners[j1c * cs + i1c] * fx;
        let t = (top * (1 - fy) + bot * fy - lo) / (hi - lo);
        t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
        px[py * stride + p] = rgb | ((t * 255 + 0.5) << 24);
      }
    }
  },

  updateFog() {
    const g = Game.visionGroup(Game.me);
    if (this.fogSource !== Game.visionCells || this.fogGroup !== g) this.resetFog(g);
    const count = Game.visionCount[g];
    let need = count - this.fogSeenCount;
    if (need === 0) {
      if (!this.fogBmp && !this.fogBmpPending && ++this.fogSteady >= this.FOG_BITMAP_SETTLE) this.snapshotFog();
      return;
    }
    // Discovery is permanent, so a count that fell belongs to a different grid.
    if (need < 0) { this.resetFog(g); need = count; }

    const cw = this.fogW, seen = this.fogSeen;
    const cells = Game.visionCells, W = Game.visionWords, bit = 1 << (g & 31);
    let minX = cw, minY = this.fogH, maxX = -1, maxY = -1;
    for (let c = 0, k = g >>> 5, n = seen.length; c < n && need > 0; c++, k += W) {
      if (seen[c] !== 0 || (cells[k] & bit) === 0) continue;
      seen[c] = 1;
      need--;
      // A corner shared with a cell found later in this walk is simply set
      // again then, with that cell counted.
      const cx = c % cw, cy = (c / cw) | 0;
      this.fogCorner(cx, cy);
      this.fogCorner(cx + 1, cy);
      this.fogCorner(cx, cy + 1);
      this.fogCorner(cx + 1, cy + 1);
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
    this.fogSeenCount = count;
    if (maxX < 0) return;
    const S = this.FOG_SUB;
    this.fogPaint(minX, minY, maxX + 1, maxY + 1);
    const dx = Math.max(0, (minX - 1) * S), dy = Math.max(0, (minY - 1) * S);
    this.fogCtx.putImageData(this.fogImage, 0, 0, dx, dy,
      Math.min(this.fogW * S, (maxX + 2) * S) - dx + 1, Math.min(this.fogH * S, (maxY + 2) * S) - dy + 1);
    this.fogChanged();
  },

  snapshotFog() {
    if (this.fogNoBitmap) return;
    const gen = this.fogGen;
    let req;
    try {
      req = createImageBitmap(this.fogCanvas);
    } catch (e) {
      this.fogNoBitmap = true;     // no createImageBitmap: keep stamping the canvas
      return;
    }
    this.fogBmpPending = true;
    req.then(bmp => {
      this.fogBmpPending = false;
      if (gen !== this.fogGen) { bmp.close(); return; }   // the fog moved on while this was being made
      this.fogBmp = bmp;
    }, () => { this.fogBmpPending = false; this.fogNoBitmap = true; });
  },

  // Is `tile` hidden from the viewer? Only meaningful while `fogged`.
  fogHides(tile) {
    const w = GameMap.width, C = Game.VISION_CELL;
    return this.fogSeen[(((tile / w) | 0) / C | 0) * this.fogW + ((tile % w) / C | 0)] === 0;
  },

  // The same for a tile-space position as the passes carry one: a unit at
  // (x, y) is drawn centred half a tile further on, and that centre is the
  // point tested. Anything off the map is hidden.
  fogHidesAt(x, y) {
    const C = Game.VISION_CELL;
    x += 0.5;
    y += 0.5;
    if (!(x >= 0 && y >= 0)) return true;
    const cx = (x / C) | 0, cy = (y / C) | 0;
    return cx >= this.fogW || cy >= this.fogH || this.fogSeen[cy * this.fogW + cx] === 0;
  },

  // Stretches the layer over the map. Only the part of it under the viewport
  // is drawn (plus a pixel each way, so the filter never runs out of source at
  // a screen edge): zoomed right in, the whole layer would be a destination
  // rectangle tens of thousands of pixels across.
  drawFog() {
    const ctx = this.ctx, s = this.cam.scale * this.dpr, C = Game.VISION_CELL;
    const cw = this.canvas.width, ch = this.canvas.height;
    const halfW = cw / 2 / s, halfH = ch / 2 / s;
    // In cells. The layer is let run half a cell past the map on every side
    // (the outer half of its edge pixels, which just repeat the edge value):
    // stopping exactly on the map's edge leaves that edge antialiased against
    // the tiles underneath, a faint outline of the map through the fog. Past
    // the edge there is only the backdrop, which is the fog's own colour.
    const x0 = Math.max(-0.5, Math.floor((this.cam.x - halfW) / C) - 1);
    const y0 = Math.max(-0.5, Math.floor((this.cam.y - halfH) / C) - 1);
    const x1 = Math.min(Math.min(GameMap.width / C, this.fogW) + 0.5, Math.ceil((this.cam.x + halfW) / C) + 1);
    const y1 = Math.min(Math.min(GameMap.height / C, this.fogH) + 0.5, Math.ceil((this.cam.y + halfH) / C) + 1);
    if (x1 <= x0 || y1 <= y0) return;

    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(s, 0, 0, s, cw / 2 - this.cam.x * s, ch / 2 - this.cam.y * s);
    // Corner i is pixel i, whose centre is at i + 0.5 in the image: the half
    // pixel of offset lines the pixel centres up with the cell corners.
    const S = this.FOG_SUB;
    ctx.drawImage(this.fogBmp || this.fogCanvas, x0 * S + 0.5, y0 * S + 0.5, (x1 - x0) * S, (y1 - y0) * S,
                  x0 * C, y0 * C, (x1 - x0) * C, (y1 - y0) * C);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = smooth;
  },

  draw() {
    // Fog of war, decided once so that every pass below agrees for the frame.
    const fog = this.fogged = this.fogActive();
    if (fog) this.updateFog();

    // Captured before the rebuild below consumes the flags, so the hover
    // overlay knows whether ownership moved this frame too.
    const territoryChanged = Game.dirty || Game.dirtyTiles.size > 0;
    if (this.altView) this.updateAltRelations(false);
    if (Game.dirty) {
      this.buildTiles();
      Game.dirty = false;
      Game.dirtyTiles.clear();
      this.qHead = this.qTail = 0;   // the full rebuild already painted everything queued
    } else if (this.smoothTerritory) {
      const now = performance.now();
      if (Game.dirtyTiles.size) {
        this.enqueueDirty(Game.dirtyTiles, now);
        Game.dirtyTiles.clear();
      }
      this.releaseTiles(now);
    } else if (Game.dirtyTiles.size) {
      this.buildTilesIncremental(Game.dirtyTiles);
      Game.dirtyTiles.clear();
    }

    const ctx = this.ctx;
    this.clampCamera();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const s = this.cam.scale * this.dpr;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(s, 0, 0, s, this.canvas.width / 2, this.canvas.height / 2);
    this.drawLayer(ctx, this.tileLayer, -this.cam.x, -this.cam.y);
    this.drawHoverHighlight(territoryChanged, ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this.drawRailroads();
    this.drawStructures();
    // In a fog match the placement ghost and the map lettering move to the
    // end, over the fog layer (see below). With fog off the order is as it
    // always was.
    if (!fog) {
      this.drawPlacement();
      if (!this.altView) {
        this.drawLabels();
        this.drawDiploBadges();
        this.drawFronts();
      }
    }
    this.drawBoats();
    this.drawTrains();
    this.drawTradeShips();
    this.drawWarships();
    this.drawScouts();
    this.drawShells();
    this.drawMirvs();
    this.drawNukes();
    this.drawNukeBlasts();
    this.drawSamFlashes();
    if (fog) {
      // Everything above is the world, and the fog goes over all of it:
      // whatever runs out past the discovered area (a range ring, a boat's
      // trail, a contrail, a blast) is cut off where the area ends. What
      // follows is drawn on top of the fog, so culling is all that hides it:
      //   - names, badges, front numbers and the gold pop-ups further down.
      //     Each is placed by a single discovered tile, and lettering sliced
      //     through by the fog's edge reads as a glitch;
      //   - the viewer's own missiles in flight, the one thing they are shown
      //     over undiscovered ground (the blast, a world effect, stays under);
      //   - the placement ghost: it is their cursor, and has to stay visible
      //     while a nuke is aimed into the black.
      this.drawFog();
      if (!this.altView) {
        this.drawLabels();
        this.drawDiploBadges();
        this.drawFronts();
      }
      this.drawMirvs(true);
      this.drawNukes(true);
    }
    // Battle Royale circle: over the fog on purpose (the spec makes the circle
    // and the Drill visible to everyone), under the labels and popups.
    this.drawDrill();
    // Over the fog, because it marks where the player sent a scout, which may
    // well be in the black. Nothing to draw in a match without fog.
    this.drawScoutOrders();
    this.drawGoldPopups();
    this.drawKillPopups();
    if (fog) this.drawPlacement();
    this.drawSelectionBox();
  },

  // Static rail lines between stations — drawn underneath the structure
  // discs (called before drawStructures in draw()) so a station's disc sits
  // cleanly on top of the tracks converging on it rather than the line
  // cutting across the icon. Each railroad's `waypoints` is just its two
  // station tiles plus, for a diagonal pair, the single axis-aligned elbow
  // bend between them (see Game.orthogonalPath) — never a per-cell walk —
  // so this draws as one or two dead-straight horizontal/vertical
  // moveTo/lineTo segments per rail, never a tile-by-tile staircase.
  drawRailroads() {
    if (!Game.railroads.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;

    const fog = this.fogged;
    ctx.strokeStyle = 'rgba(210, 190, 150, 0.55)';
    ctx.lineWidth = Math.max(1, this.dpr * 1.1);
    ctx.beginPath();
    for (const r of Game.railroads) {
      if (fog) {
        // A rail with every waypoint undiscovered is not drawn at all; one
        // that runs out into the fog is cut off by the layer above.
        let hidden = true;
        for (const tile of r.waypoints) if (!this.fogHides(tile)) { hidden = false; break; }
        if (hidden) continue;
      }
      let moved = false;
      for (const tile of r.waypoints) {
        const px = (tile % w + 0.5 - this.cam.x) * s + cw / 2;
        const py = (((tile / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
        if (!moved) { ctx.moveTo(px, py); moved = true; }
        else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  },

  // Structures, drawn as an overlay rather than baked into the tile blit: the
  // blit is one pixel per tile, which is far too coarse to carry an icon, and it
  // is rebuilt on every territory change besides.
  //
  // Each sits on a dark disc ringed in its owner's colour, so whose city it is
  // reads at a glance — which matters because capturing one takes its pop bonus
  // with it, making a bordering city a visible reason to push.
  // CSS-pixel disc radius a structure actually draws at — device-pixel-ratio
  // free, since input coordinates (pointer events, screenToTile) live in CSS
  // pixels too. Shared with findStructureNear below so the area someone can
  // tap always matches the size of the icon they're looking at.
  structureRadius() {
    const font = Math.max(10, Math.min(20, this.cam.scale * 2.2));
    return font * 0.66 * 2;   // doubled: at map-fit zoom the old size read as barely a dot
  },

  // Structure icons give way to dots (drawStructureDots) when zoomed far out:
  // their radius stops shrinking at the font floor above, so on a big map at
  // map-fit zoom they carpet whole nations and bury the borders (SAMs are the
  // exception and always keep their icon). Icons show
  // at ICON_DOT_SCALE (CSS px per tile) and closer, and always while placing a
  // build, so you can still see and tap what's already there.
  ICON_DOT_SCALE: 1.5,
  structureIconsShown() {
    return (typeof UI !== 'undefined' && !!UI.placing) || this.cam.scale >= this.ICON_DOT_SCALE;
  },

  // A structure's disc and glyph, drawn centred on (px, py) with radius r.
  // Used to fill the sprite cache (structureSprite) and, while the zoom is
  // still moving, to draw straight onto the map.
  paintStructureIcon(ctx, type, owner, built, px, py, r) {
    const c = owner >= 0 ? Game.players[owner].color : [200, 200, 200];
    // Disc is a dimmed tone of the owner's own colour — the same shade the
    // territory fill uses on flat ground — rather than a fixed dark navy, so
    // the city reads as part of that nation's land, not a generic marker.
    // It's fully opaque (no alpha) so the hover overlay, which is drawn
    // beneath structures each frame, never shows through and brightens it.
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${(c[0] * 0.62) | 0}, ${(c[1] * 0.62) | 0}, ${(c[2] * 0.62) | 0})`;
    ctx.fill();
    ctx.strokeStyle = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    ctx.lineWidth = Math.max(1.5, r * 0.18);
    ctx.stroke();

    const def = Game.unitDef(type);
    if (def) {
      // Under construction: the icon sits dimmed so a finished structure
      // still reads as the visually "solid" one at a glance.
      ctx.globalAlpha = built ? 1 : 0.45;
      // Hand-drawn glyphs rather than the unit's emoji: colour emoji carry
      // their own built-in colours and ignore fillStyle, so on platforms
      // with a colour emoji font the icon rendered washed out against the
      // disc instead of the solid white this needs to be.
      ctx.fillStyle = '#ffffff';
      if (type === 'factory') {
        // A single low, wide block with a smokestack — deliberately
        // squatter than the city's skyline so the two read as different
        // silhouettes even at a glance, not just a different badge.
        const bodyW = r * 0.95, bodyH = r * 0.5;
        const bx = px - bodyW / 2, by = py + r * 0.3 - bodyH;
        ctx.fillRect(bx, by, bodyW, bodyH);
        const stackW = r * 0.16;
        ctx.fillRect(px + bodyW * 0.18, by - r * 0.35, stackW, r * 0.35);
      } else if (type === 'fort') {
        // Heater-shield silhouette: flat top bar, straight sides down to
        // mid-height, then angling inward to a point at the bottom.
        const sw = r * 0.58, top = py - r * 0.52, bot = py + r * 0.7;
        const mid = top + (bot - top) * 0.48;
        ctx.beginPath();
        ctx.moveTo(px - sw, top);
        ctx.lineTo(px + sw, top);
        ctx.lineTo(px + sw, mid);
        ctx.lineTo(px, bot);
        ctx.lineTo(px - sw, mid);
        ctx.closePath();
        ctx.fill();
      } else if (type === 'port') {
        // Anchor glyph, stroked rather than filled like the others (a
        // ring and a hooked shackle read as hollow shapes) — ring at top,
        // a stem down through a crossbar (the "stock"), flaring into a
        // wide fluke at the base. Unmistakably distinct from the blocky
        // city/factory/fort silhouettes.
        ctx.lineWidth = Math.max(1.5, r * 0.16);
        ctx.strokeStyle = '#ffffff';
        ctx.lineCap = 'round';

        const ringR = r * 0.22, ringY = py - r * 0.66;
        ctx.beginPath();
        ctx.arc(px, ringY, ringR, 0, Math.PI * 2);
        ctx.stroke();

        const stemTop = ringY + ringR, stemBot = py + r * 0.5;
        ctx.beginPath();
        ctx.moveTo(px, stemTop);
        ctx.lineTo(px, stemBot);
        ctx.stroke();

        const barW = r * 0.46, barY = py - r * 0.22;
        ctx.beginPath();
        ctx.moveTo(px - barW / 2, barY);
        ctx.lineTo(px + barW / 2, barY);
        ctx.stroke();

        // Flukes: one wide arc curling up from the base of the stem toward
        // both sides, like the bottom half of the ring.
        const flukeR = r * 0.42;
        ctx.beginPath();
        ctx.arc(px, stemBot - flukeR, flukeR, Math.PI * 0.12, Math.PI * 0.88);
        ctx.stroke();

        ctx.lineCap = 'butt';
      } else if (type === 'silo') {
        // Missile nose cone atop a squat silo body, unmistakably distinct
        // from the blocky city/factory silhouettes and the hollow anchor —
        // a solid filled triangle-plus-rectangle rocket silhouette.
        const bodyW = r * 0.5, bodyTop = py - r * 0.05, bodyBot = py + r * 0.62;
        ctx.fillRect(px - bodyW / 2, bodyTop, bodyW, bodyBot - bodyTop);
        ctx.beginPath();
        ctx.moveTo(px, py - r * 0.72);
        ctx.lineTo(px + bodyW / 2, bodyTop);
        ctx.lineTo(px - bodyW / 2, bodyTop);
        ctx.closePath();
        ctx.fill();
        // Two small fins flaring out from the base.
        const finW = r * 0.28;
        ctx.beginPath();
        ctx.moveTo(px - bodyW / 2, bodyBot - r * 0.2);
        ctx.lineTo(px - bodyW / 2 - finW, bodyBot);
        ctx.lineTo(px - bodyW / 2, bodyBot);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(px + bodyW / 2, bodyBot - r * 0.2);
        ctx.lineTo(px + bodyW / 2 + finW, bodyBot);
        ctx.lineTo(px + bodyW / 2, bodyBot);
        ctx.closePath();
        ctx.fill();
      } else if (type === 'sam') {
        // A dish (arc) on a short mast, distinct from the Silo's solid
        // rocket silhouette — this shoots nukes down, it doesn't launch.
        ctx.lineWidth = Math.max(1.5, r * 0.16);
        ctx.strokeStyle = '#ffffff';
        ctx.lineCap = 'round';
        const mastTop = py - r * 0.05, mastBot = py + r * 0.6;
        ctx.beginPath();
        ctx.moveTo(px, mastTop);
        ctx.lineTo(px, mastBot);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, mastTop + r * 0.1, r * 0.42, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        ctx.lineCap = 'butt';
      } else if (type === 'radio') {
        // Radio Tower (fog matches): a tapering mast with a beacon on top and
        // a wave arc either side of it — the only glyph with anything
        // radiating from it, which is the whole of what the building does.
        const top = py - r * 0.3, bot = py + r * 0.66, halfW = r * 0.3;
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.lineTo(px + halfW, bot);
        ctx.lineTo(px - halfW, bot);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, top - r * 0.08, r * 0.13, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(1.2, r * 0.13);
        ctx.strokeStyle = '#ffffff';
        ctx.lineCap = 'round';
        const waveY = top - r * 0.08, waveR = r * 0.48;
        ctx.beginPath();
        ctx.arc(px, waveY, waveR, -Math.PI * 0.25, Math.PI * 0.25);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, waveY, waveR, Math.PI * 0.75, Math.PI * 1.25);
        ctx.stroke();
        ctx.lineCap = 'butt';
      } else {
        const bw = r * 0.22, gap = r * 0.12;
        const heights = [r * 0.5, r * 0.85, r * 0.62];
        const baseline = py + r * 0.45;
        let bx = px - (bw * 3 + gap * 2) / 2;
        for (const h of heights) {
          ctx.fillRect(bx, baseline - h, bw, h);
          bx += bw + gap;
        }
      }
      ctx.globalAlpha = 1;
    }
  },

  // Structure icons are stamped from a per-(type, owner, built) bitmap at the
  // current icon radius instead of being redrawn from paths every frame (a few
  // hundred structures cost several ms a frame that way). The radius changes
  // while zooming, and building a bitmap per structure per frame would cost
  // more than drawing directly, so sprites are only built once the radius has
  // held still for STRUCT_SPRITE_SETTLE frames; until then this returns null
  // and the caller draws directly. A new radius drops the old sprites.
  STRUCT_SPRITE_SETTLE: 10,
  STRUCT_TYPE_IDX: { city: 0, factory: 1, fort: 2, port: 3, silo: 4, sam: 5, radio: 6 },
  structSprites: new Map(),
  structSpriteR: -1,
  structSpriteSteady: 0,
  structureSprite(type, owner, built, r) {
    if (this.structSpriteSteady < this.STRUCT_SPRITE_SETTLE) return null;
    const t = this.STRUCT_TYPE_IDX[type];
    if (t === undefined) return null;
    const key = ((owner + 1) * 8 + t) * 2 + (built ? 1 : 0);
    let c = this.structSprites.get(key);
    if (c) return c;
    const half = Math.ceil(r * 1.15 + 2);
    c = document.createElement('canvas');
    c.width = c.height = half * 2;
    this.paintStructureIcon(c.getContext('2d'), type, owner, built, half, half, r);
    this.structSprites.set(key, c);
    return c;
  },

  // A structure's level number, outlined, rasterised once per level and
  // whole-pixel font size. Only a handful of sizes and levels ever occur, so
  // the cache stays tiny.
  levelBadges: new Map(),
  levelBadge(level, font) {
    const key = level * 1000 + font;
    let c = this.levelBadges.get(key);
    if (c) return c;
    const text = String(level);
    const line = Math.max(2, font * 0.3);
    c = document.createElement('canvas');
    let g = c.getContext('2d');
    g.font = '700 ' + font + 'px system-ui, sans-serif';
    c.width = Math.ceil(g.measureText(text).width + line + 4);
    c.height = Math.ceil(font * 1.3 + line + 4);
    g = c.getContext('2d');                  // resizing reset the context state
    g.font = '700 ' + font + 'px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = line;
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    g.fillStyle = '#ffe9a8';
    g.strokeText(text, c.width / 2, c.height / 2);
    g.fillText(text, c.width / 2, c.height / 2);
    this.levelBadges.set(key, c);
    return c;
  },

  // Finds the structure of `type` whose drawn disc a tap (in CSS-pixel client
  // coordinates, same space as screenToTile's input) actually falls near — not
  // just the single tile it happens to be anchored to. The disc reads as a
  // big, tappable icon, so a tap anywhere across it (plus a little slop past
  // its own edge) should count as tapping the structure, exactly as it looks
  // like it should. Picks the closest match when discs overlap.
  findStructureNear(sx, sy, type) {
    if (type !== 'sam' && !this.structureIconsShown()) return null;   // dots aren't tappable
    const r = this.structureRadius();
    const buffer = r * 1.5;
    const w = GameMap.width;
    let best = null, bestDist = Infinity;
    for (const b of Game.buildings.values()) {
      if (b.type !== type) continue;
      if (!this.canSee(b.tile)) continue;   // fog: not drawn, so not there to tap
      const bx = (b.tile % w + 0.5 - this.cam.x) * this.cam.scale + window.innerWidth / 2;
      const by = (((b.tile / w) | 0) + 0.5 - this.cam.y) * this.cam.scale + window.innerHeight / 2;
      const d = Math.hypot(bx - sx, by - sy);
      if (d <= buffer && d < bestDist) { best = b; bestDist = d; }
    }
    return best;
  },

  // Centroid of an attack's current frontier — a.border is the live set of
  // contested tiles (see attacks.js), so this tracks the front as it moves
  // rather than pointing at wherever the push originally started.
  attackTile(a) {
    const w = GameMap.width;
    let sx = 0, sy = 0, n = 0;
    for (const tile of a.border) {
      sx += tile % w;
      sy += (tile / w) | 0;
      n++;
    }
    return n ? { x: sx / n + 0.5, y: sy / n + 0.5 } : null;
  },

  // Current tile-space position of a boat along its path, interpolated the
  // same way findBoatNear and drawBoats place its dot.
  boatTile(b) {
    const w = GameMap.width;
    const idx = Math.min(b.path.length - 1, Math.floor(b.pos));
    const frac = Math.min(1, b.pos - idx);
    const a = b.path[idx], c = b.path[Math.min(idx + 1, b.path.length - 1)];
    const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
    return { x: ax + (cx - ax) * frac, y: ay + (cy - ay) * frac };
  },

  // Finds the boat (if any) whose current on-screen dot a hover falls near —
  // same buffered hit-test idea as findStructureNear, sized off the same
  // radius drawBoats uses for the dot itself rather than a single tile, so
  // the whole visible dot is hoverable.
  findBoatNear(sx, sy) {
    if (!Game.boats.length) return null;
    const s = this.cam.scale;
    const w = GameMap.width;
    const buffer = Math.max(5, Math.min(13, s * 1.05)) * 1.5;
    let best = null, bestDist = Infinity;
    for (const b of Game.boats) {
      const idx = Math.min(b.path.length - 1, Math.floor(b.pos));
      const frac = Math.min(1, b.pos - idx);
      const a = b.path[idx], c = b.path[Math.min(idx + 1, b.path.length - 1)];
      const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;
      // Fog: the same point drawBoats culls on, the centre of the dot.
      if (!this.canSee(Math.floor(ty + 0.5) * w + Math.floor(tx + 0.5))) continue;
      const bx = (tx + 0.5 - this.cam.x) * s + window.innerWidth / 2;
      const by = (ty + 0.5 - this.cam.y) * s + window.innerHeight / 2;
      const d = Math.hypot(bx - sx, by - sy);
      if (d <= buffer && d < bestDist) { best = b; bestDist = d; }
    }
    return best;
  },

  // Snaps the cursor to the nearest tile lying on any existing rail segment
  // when within 1.5 tile-widths of the line. Used for city placement so a
  // city placed near a rail lands on it rather than one tile off. Returns a
  // tile index, or -1 if nothing is close enough.
  findRailSnapTile(sx, sy) {
    if (!Game.railroads.length) return -1;
    const s = this.cam.scale;
    const w = GameMap.width;
    const cx = (sx - window.innerWidth / 2) / s + this.cam.x;
    const cy = (sy - window.innerHeight / 2) / s + this.cam.y;
    const SNAP_TILES = 3;
    let bestTile = -1, bestDist = SNAP_TILES;
    for (const r of Game.railroads) {
      const wps = r.waypoints;
      for (let i = 0; i + 1 < wps.length; i++) {
        const t1 = wps[i], t2 = wps[i + 1];
        const x1 = t1 % w, y1 = (t1 / w) | 0;
        const x2 = t2 % w, y2 = (t2 / w) | 0;
        let snapX, snapY;
        if (y1 === y2) {
          snapX = Math.max(Math.min(x1, x2), Math.min(Math.floor(cx), Math.max(x1, x2)));
          snapY = y1;
        } else {
          snapX = x1;
          snapY = Math.max(Math.min(y1, y2), Math.min(Math.floor(cy), Math.max(y1, y2)));
        }
        const d = Math.hypot(cx - snapX - 0.5, cy - snapY - 0.5);
        // Fog: an undiscovered stretch of rail must not pull the cursor onto it.
        if (d < bestDist && this.canSee(GameMap.idx(snapX, snapY))) {
          bestDist = d;
          bestTile = GameMap.idx(snapX, snapY);
        }
      }
    }
    return bestTile;
  },

  // Zoomed-out stand-in for structure icons: a small dot in the owner's
  // colour, so where things are built still reads without the clutter.
  drawStructureDots() {
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const d = Math.max(2, Math.round(3 * this.dpr)), h = d / 2, o = Math.max(1, Math.round(this.dpr));
    const fog = this.fogged;
    for (const b of Game.buildings.values()) {
      if (b.type === 'sam') continue;   // SAMs keep their full icon (see drawStructures)
      if (fog && this.fogHides(b.tile)) continue;
      const px = (b.tile % w + 0.5 - this.cam.x) * s + cw / 2;
      const py = (((b.tile / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -d || py < -d || px > cw + d || py > ch + d) continue;
      const owner = GameMap.owner[b.tile];
      const c = owner >= 0 ? Game.players[owner].color : [200, 200, 200];
      const x = Math.round(px - h), y = Math.round(py - h);
      ctx.fillStyle = 'rgba(8, 14, 26, 0.9)';
      ctx.fillRect(x - o, y - o, d + o * 2, d + o * 2);
      ctx.fillStyle = b.built ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.5)`;
      ctx.fillRect(x, y, d, d);
    }
  },

  drawStructures() {
    if (!Game.buildings.size) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;

    // Zoomed out, structures shrink to owner-coloured dots, as OpenFront
    // does, except SAMs: their icon and level stay, since reading air
    // defence at a glance is a big part of what max zoom-out is for.
    // Range rings follow the same rule: forts' only with icons, SAMs' always.
    const iconsShown = this.structureIconsShown();
    // Fog: an undiscovered structure is skipped in every pass below, range
    // ring included; a ring would give it away from well outside the fog.
    const fog = this.fogged;

    // First pass: draw protection radii for all built forts, behind everything.
    for (const b of Game.buildings.values()) {
      if (!iconsShown || b.type !== 'fort' || !b.built) continue;
      if (fog && this.fogHides(b.tile)) continue;
      const px = (b.tile % w + 0.5 - this.cam.x) * s + cw / 2;
      const py = (((b.tile / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      const rr = Game.fortRange() * s;
      if (px + rr < 0 || py + rr < 0 || px - rr > cw || py - rr > ch) continue;   // wholly off-screen
      const owner = GameMap.owner[b.tile];
      const c = owner >= 0 ? Game.players[owner].color : [200, 200, 200];
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.07)`;
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.35)`;
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Same idea for SAM Launchers, just with a per-building radius (
    // Game.dynamicSamRange, which grows with level and ramps smoothly right
    // after an upgrade — see its own comment) instead of Fort's fixed
    // fortRange(), and a solid rather than dashed ring so the two structures'
    // protection zones stay visually distinct even where they overlap.
    for (const b of Game.buildings.values()) {
      if (b.type !== 'sam' || !b.built) continue;
      if (fog && this.fogHides(b.tile)) continue;
      const px = (b.tile % w + 0.5 - this.cam.x) * s + cw / 2;
      const py = (((b.tile / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      const rr = Game.dynamicSamRange(b, Game.renderElapsed) * s;
      if (px + rr < 0 || py + rr < 0 || px - rr > cw || py - rr > ch) continue;   // wholly off-screen
      const owner = GameMap.owner[b.tile];
      const c = owner >= 0 ? Game.players[owner].color : [200, 200, 200];
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.05)`;
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.3)`;
      ctx.stroke();
    }

    if (!iconsShown) this.drawStructureDots();   // above the rings, below SAM icons

    const r = this.structureRadius() * this.dpr;
    if (r !== this.structSpriteR) {
      this.structSpriteR = r;
      this.structSpriteSteady = 0;
      this.structSprites.clear();
    } else {
      this.structSpriteSteady++;
    }
    ctx.lineWidth = Math.max(1.5, r * 0.18);   // reset per frame; the bar below borrows this ctx
    for (const b of Game.buildings.values()) {
      if (!iconsShown && b.type !== 'sam') continue;
      const px = (b.tile % w + 0.5 - this.cam.x) * s + cw / 2;
      const py = (((b.tile / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;
      if (fog && this.fogHides(b.tile)) continue;

      const owner = GameMap.owner[b.tile];
      const icon = this.structureSprite(b.type, owner, b.built, r);
      if (icon) ctx.drawImage(icon, Math.round(px - icon.width / 2), Math.round(py - icon.height / 2));
      else this.paintStructureIcon(ctx, b.type, owner, b.built, px, py, r);

      // One bar reused for both timers: dim blue while a fresh structure
      // stands unfinished, warm gold while a finished one is climbing a
      // level — same geometry, so the eye reads either as "not done yet"
      // without needing a second visual language.
      if (!b.built || b.upgrading) {
        const barW = r * 1.7, barH = Math.max(2 * this.dpr, r * 0.24);
        const bx = px - barW / 2, by = py + r + barH * 1.3;
        const pct = Math.max(0, Math.min(1, b.progress / b.buildTime));
        ctx.fillStyle = 'rgba(8, 14, 26, 0.85)';
        ctx.fillRect(bx, by, barW, barH);
        ctx.fillStyle = b.upgrading ? 'rgba(255, 205, 110, 0.95)' : 'rgba(130, 215, 255, 0.95)';
        ctx.fillRect(bx, by, barW * pct, barH);
      }

      // Level, above the disc — always shown once built, level 1 included, so
      // a structure's level can be read straight off the map.
      // Stamped from a cached bitmap (see levelBadge) rather than lettered here:
      // with a few hundred structures on screen this was the largest block of
      // text drawing in the frame.
      if (b.built && b.level >= 1) {
        const badgeFont = Math.round(Math.max(9 * this.dpr, Math.min(15 * this.dpr, r * 0.6)));
        const img = this.levelBadge(b.level, badgeFont);
        const ly = py - r - badgeFont * 0.85;
        ctx.drawImage(img, Math.round(px - img.width / 2), Math.round(ly - img.height / 2));
      }

      // Charge pips below the disc, one per level — filled = ready to fire,
      // hollow = that charge's own independent SAM_COOLDOWN is still
      // counting down (see Game.stepSAMs). Makes "a level-2 SAM has two
      // separate charges, not one shared cooldown" legible at a glance
      // instead of only inferable from watching it fire twice.
      // A Silo gets the same pips: its missile slots work the same way (see
      // Game.siloFreeSlots).
      if (b.built && (b.type === 'sam' || b.type === 'silo')) {
        const ready = b.type === 'sam' ? b.level - b.samQueue.length : Game.siloFreeSlots(b);
        const pipR = Math.max(1.5 * this.dpr, r * 0.12);
        const gap = pipR * 2.6;
        // Clear the upgrade progress bar (drawn just above, while
        // b.upgrading) instead of overlapping it — a SAM can be mid-upgrade
        // and still have charges to show at the same time.
        const barH = Math.max(2 * this.dpr, r * 0.24);
        const py2 = b.upgrading ? py + r + barH * 1.3 + barH + pipR * 1.6 : py + r + pipR * 1.6;
        let px2 = px - gap * (b.level - 1) / 2;
        for (let i = 0; i < b.level; i++) {
          ctx.beginPath();
          ctx.arc(px2, py2, pipR, 0, Math.PI * 2);
          if (i < ready) {
            ctx.fillStyle = '#8be08b';
            ctx.fill();
          } else {
            ctx.fillStyle = 'rgba(8, 14, 26, 0.85)';
            ctx.fill();
            ctx.lineWidth = Math.max(1, pipR * 0.35);
            ctx.strokeStyle = '#8be08b';
            ctx.stroke();
          }
          px2 += gap;
        }
      }
    }
  },

  // Game.resolveWarshipLaunch runs a real seaPath (weighted A*) per
  // candidate Port — fine for a one-off click, far too expensive to redo
  // every animation frame while the placement ghost just sits over the same
  // hovered tile. Cached by that tile, only recomputed when it actually
  // changes.
  warshipLaunchPreview(tile) {
    if (this._warshipLaunchTile !== tile) {
      this._warshipLaunchTile = tile;
      this._warshipLaunchResult = Game.resolveWarshipLaunch(Game.me, tile);
    }
    return this._warshipLaunchResult;
  },

  // Same caching idea as warshipLaunchPreview just above, for
  // Game.resolveNukeLaunch — cheap by comparison (no seaPath), but the
  // Silo scan is still no reason to redo it every animation frame while the
  // mouse sits still over the same tile.
  nukeLaunchPreview(nukeType, tile) {
    if (this._nukeLaunchTile !== tile || this._nukeLaunchType !== nukeType) {
      this._nukeLaunchTile = tile;
      this._nukeLaunchType = nukeType;
      this._nukeLaunchResult = Game.resolveNukeLaunch(Game.me, nukeType, tile);
    }
    return this._nukeLaunchResult;
  },

  // Fog of war: the rail link a placement ghost may draw from `from` to the
  // station at `to`, or null. Game.orthogonalPath's rule (one elbow, across
  // first and then down first, land all the way), except that ground the
  // viewer has not discovered never counts as a way through. With everything
  // on the route discovered this is the same line the sim would build.
  fogRailPreview(from, to) {
    if (this.fogHides(from) || this.fogHides(to)) return null;
    const w = GameMap.width;
    const ax = from % w, ay = (from / w) | 0, bx = to % w, by = (to / w) | 0;
    const clear = (x0, y0, x1, y1) => {
      const dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0);
      for (let x = x0, y = y0; ; x += dx, y += dy) {
        const t = y * w + x;
        if (this.fogHides(t) || !GameMap.isLand(t)) return false;
        if (x === x1 && y === y1) return true;
      }
    };
    if (ax === bx || ay === by) return clear(ax, ay, bx, by) ? [from, to] : null;
    if (clear(ax, ay, bx, ay) && clear(bx, ay, bx, by)) return [from, GameMap.idx(bx, ay), to];
    if (clear(ax, ay, ax, by) && clear(ax, by, bx, by)) return [from, GameMap.idx(ax, by), to];
    return null;
  },

  // Fog of war: is there a built Factory the viewer has discovered within
  // station range of `tile`? A City or Port only joins the rail network when
  // one is (Game.previewCityConnections), and that check counts hidden
  // Factories too.
  fogSeesFactoryNear(tile) {
    const range2 = Game.TRAIN_STATION_MAX_RANGE * Game.TRAIN_STATION_MAX_RANGE;
    for (const b of Game.buildings.values()) {
      if (b.type === 'factory' && b.built && !this.fogHides(b.tile) && Game.tileDistSq(tile, b.tile) <= range2) return true;
    }
    return false;
  },

  // Where the armed structure would land. Mouse only — touch has no hover, so
  // there the hint line under the build bar is the whole of the feedback.
  //
  // Fog: this is drawn over the fog layer (see draw()), so the cursor and a
  // nuke's aim stay visible in the black. That makes it the one pass nothing
  // covers, and each part of the ghost that is worked out from the real map
  // has to hold back what the viewer has not discovered: the structure under
  // the cursor, a warship's snapped destination and route, and the stations a
  // new one would link to. The rings centred on the cursor itself say nothing.
  drawPlacement() {
    if (!UI.placing || UI.placing === 'debugpeace' || UI.placeHover < 0) return;   // debugpeace has no ghost
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const tile = UI.placeHover;
    const fog = this.fogged;
    const blind = fog && this.fogHides(tile);
    const hoverB = blind ? undefined : Game.buildings.get(tile);
    // Warship resolution (which Port it launches from, the route it sails)
    // runs a real seaPath per candidate Port — too expensive to redo every
    // animation frame while the mouse just sits still. Cached by hovered
    // tile, same idea render.js's own hoverAnnexAt throttle uses for a
    // different expensive per-frame check.
    const warshipPreview = UI.placing === 'warship' ? this.warshipLaunchPreview(tile) : null;
    const isNuke = UI.placing === 'atombomb' || UI.placing === 'hydrogenbomb' || UI.placing === 'mirv';
    const nukePreview = isNuke ? this.nukeLaunchPreview(UI.placing, tile) : null;
    const isDebugNuke = UI.placing === 'debugnuke';
    // Hovering an existing structure of the same type while armed previews an
    // upgrade instead of a blocked build — same ghost, different legality
    // check, matching what UI.onTap actually does on tap. Warship and the
    // two bomb types have no buildings-map entry (and no upgrade) at all —
    // they're always checked against their own cached resolution instead.
    // The debug nuke has no legality check at all (see Game.debugNuke) — any
    // tile is always a valid click for either half of its two-click flow.
    // Fog: a warship order shows as refused unless both the tile under the
    // cursor and the water it snaps to are discovered. Green over the black
    // would say "there is water here, and a way to it". The sim refuses the
    // same orders (resolveWarshipLaunch); the ghost does not lean on that.
    const warshipOk = !!warshipPreview && warshipPreview.ok &&
      !(fog && (blind || this.fogHides(warshipPreview.dest)));
    // A Scout is bought with a click anywhere, and nothing it can be refused
    // for (a Port, the cap, gold) depends on the tile, so one answer holds for
    // the whole map, the black included: the ghost is the same over land,
    // water and the unknown, and says nothing the viewer has not seen.
    const ok = UI.placing === 'warship'
      ? warshipOk
      : UI.placing === 'scout'
        ? !UI.scoutReason()
        : isNuke
          ? nukePreview.ok
          : isDebugNuke
            ? true
            : UI.placing === 'drill'
              ? !Game.drillBlockReason(Game.me, tile)
            : (hoverB && hoverB.type === UI.placing)
              ? Game.canUpgrade(Game.me, tile)
              : Game.canBuild(Game.me, UI.placing, tile);

    const px = (tile % w - this.cam.x) * s + cw / 2;
    const py = (((tile / w) | 0) - this.cam.y) * s + ch / 2;

    // City or Factory only — whichever is armed — and skipped for the
    // upgrade-hover case (hovering an already-built structure of that same
    // type), since upgrading never touches the rail network. A Factory
    // always shows its own recruiting ring (TRAIN_STATION_MAX_RANGE, the
    // same radius onStructureCompleted's factory branch actually uses) even
    // with nothing in range yet — useful on its own as a planning aid. A
    // City has no recruiting reach of its own: per onStructureCompleted's
    // city branch it only joins the network at all once a Factory is
    // already within that same range, so its ring only appears once
    // Game.previewCityConnections confirms there's actually something to
    // connect to — an empty ring here would just be noise. Drawn before the
    // tile highlight below so that small, more important square/ring sits
    // on top rather than under a dashed line.
    // Fort placement: show the protection radius while hovering. Read live
    // from Game.fortRange() rather than hardcoded, so the preview ring always
    // matches the coverage a fort actually gives.
    if (UI.placing === 'fort' && !(hoverB && hoverB.type === 'fort')) {
      const cx = px + s / 2, cy = py + s / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Game.fortRange() * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(130, 215, 255, 0.09)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = 'rgba(130, 215, 255, 0.55)';
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The Drill: the starting circle it would open with (r0, the radius that
    // just covers every land tile), so the player sees what "the world" is.
    if (UI.placing === 'drill' && !Game.drill) {
      const r0 = this.drillPreviewRadius(tile % w, (tile / w) | 0);
      const cx = px + s / 2, cy = py + s / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r0 * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 106, 77, 0.05)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, this.dpr * 2);
      ctx.strokeStyle = 'rgba(255, 106, 77, 0.8)';
      ctx.setLineDash([8 * this.dpr, 6 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // SAM Launcher placement: show the range a fresh (level-1) SAM would
    // cover. Skipped on the upgrade-hover case — an existing SAM's range
    // ring is already drawn every frame in drawStructures above, so a second
    // one here would just double up.
    if (UI.placing === 'sam' && !(hoverB && hoverB.type === 'sam')) {
      const cx = px + s / 2, cy = py + s / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Game.samRange(1) * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(139, 224, 139, 0.09)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = 'rgba(139, 224, 139, 0.55)';
      ctx.stroke();
    }

    // Radio Tower placement (fog matches): the disc it would uncover once
    // built. Discovery is per vision cell, so the ring is centred on the
    // hovered tile's cell rather than the tile — the same disc
    // Game.revealAround stamps (radius r + 0.5 cells). Geometry only: it is
    // drawn over the fog and says nothing about what is under it.
    if (UI.placing === 'radio') {
      const C = Game.VISION_CELL, x = tile % w, y = (tile / w) | 0;
      const cx = ((((x / C) | 0) + 0.5) * C - this.cam.x) * s + cw / 2;
      const cy = ((((y / C) | 0) + 0.5) * C - this.cam.y) * s + ch / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, (Game.VISION_SIGHT_RADIO + 0.5) * C * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(111, 211, 224, 0.07)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = 'rgba(111, 211, 224, 0.6)';
      ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Warship placement: a click can land anywhere now (Game.resolveWarship
    // Launch does the snapping), so the ghost shows what will ACTUALLY
    // happen rather than the raw hovered tile — the route it'll sail from
    // whichever owned Port got picked, plus the patrol radius it wanders
    // once it arrives at the (possibly snapped) destination, same dashed-
    // ring language as Fort's protection radius above.
    if (warshipOk) {
      const dx = (warshipPreview.dest % w + 0.5 - this.cam.x) * s + cw / 2;
      const dy = (((warshipPreview.dest / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      ctx.beginPath();
      ctx.arc(dx, dy, Game.WARSHIP_PATROL_RANGE * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(160, 200, 255, 0.06)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = 'rgba(160, 200, 255, 0.5)';
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
      ctx.lineWidth = Math.max(1, this.dpr * 1.2);
      ctx.strokeStyle = 'rgba(160, 200, 255, 0.8)';
      ctx.beginPath();
      let movedRoute = false;
      for (const t of warshipPreview.path) {
        // The route is found on the real map and may cross water the viewer
        // has not discovered; those stretches are left out of the line.
        if (fog && this.fogHides(t)) { movedRoute = false; continue; }
        const lx = (t % w + 0.5 - this.cam.x) * s + cw / 2;
        const ly = (((t / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
        if (!movedRoute) { ctx.moveTo(lx, ly); movedRoute = true; } else ctx.lineTo(lx, ly);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Nuke targeting: inner (guaranteed-kill) and outer (falling-off blast)
    // radii at the hovered tile — Game.NUKE_MAGNITUDES for whichever bomb is
    // armed — plus a straight dashed line back to whichever ready Silo would
    // actually launch it, once resolveNukeLaunch confirms one's available.
    // The line is drawn even when nukePreview isn't ok (no Silo/on cooldown/
    // short on gold), same restraint the tile square/ring below already
    // gives every other placement — only the radii need a real launch to be
    // worth showing.
    if (isNuke) {
      // MIRV (ticket #28) has no NUKE_MAGNITUDES entry of its own — the
      // mothership has no single blast, it splits into MIRV_WARHEAD_COUNT
      // scattered warheads (see nukes.js's own comment on why) — so its
      // ghost shows the whole possible spread (MIRV_RANGE) as one dashed
      // ring instead of the inner/outer blast pair every other nuke type
      // gets below.
      const cx = px + s / 2, cy = py + s / 2;
      if (UI.placing === 'mirv') {
        ctx.beginPath();
        ctx.arc(cx, cy, Game.MIRV_RANGE * s, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 120, 90, 0.04)';
        ctx.fill();
        ctx.lineWidth = Math.max(1, this.dpr * 1.2);
        ctx.strokeStyle = 'rgba(255, 120, 90, 0.5)';
        ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const mag = Game.NUKE_MAGNITUDES[UI.placing];
        ctx.beginPath();
        ctx.arc(cx, cy, mag.outer * s, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 120, 90, 0.06)';
        ctx.fill();
        ctx.lineWidth = Math.max(1, this.dpr * 1.2);
        ctx.strokeStyle = 'rgba(255, 120, 90, 0.45)';
        ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(cx, cy, mag.inner * s, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 70, 40, 0.14)';
        ctx.fill();
        ctx.lineWidth = Math.max(1, this.dpr * 1.5);
        ctx.strokeStyle = 'rgba(255, 90, 60, 0.8)';
        ctx.stroke();
      }

      if (nukePreview.ok) {
        // Same parabola drawNukes' contrail traces for a nuke actually in
        // flight (lerp from Silo to target, sine-arced upward by height
        // scaled off trip distance) so the preview line IS the trajectory,
        // not just a straight stand-in — matters once missile defense needs
        // to read where an incoming nuke will actually pass overhead.
        const from = { x: nukePreview.silo.tile % w, y: (nukePreview.silo.tile / w) | 0 };
        const to = { x: tile % w, y: (tile / w) | 0 };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const arcHeight = Math.min(dist * 0.35, 40);
        const steps = Math.max(2, Math.ceil(dist));
        ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
        ctx.lineWidth = Math.max(1, this.dpr * 1.2);
        ctx.strokeStyle = 'rgba(255, 160, 90, 0.8)';
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const u = i / steps;
          const ua = Math.sin(Math.PI * u);
          const ux = (from.x + (to.x - from.x) * u + 0.5 - this.cam.x) * s + cw / 2;
          const uy = (from.y + (to.y - from.y) * u - ua * arcHeight + 0.5 - this.cam.y) * s + ch / 2;
          if (i === 0) ctx.moveTo(ux, uy); else ctx.lineTo(ux, uy);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Debug panel nuke: same blast-radius ghost as the real nuke preview
    // above, keyed off UI.debugNukeType instead of UI.placing since
    // 'debugnuke' isn't itself a bomb type. Once the first click has picked
    // a launch point (UI.debugNukeSrc >= 0), also traces the same arced
    // trajectory the real preview draws from its resolved Silo — here from
    // that explicit source tile instead — plus a small marker pinning it in
    // place, since the tile-square ghost below always tracks the mouse
    // (now hovering the destination for the second click), not the source.
    if (isDebugNuke) {
      const mag = Game.NUKE_MAGNITUDES[UI.debugNukeType];
      const cx = px + s / 2, cy = py + s / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, mag.outer * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 120, 90, 0.06)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.2);
      ctx.strokeStyle = 'rgba(255, 120, 90, 0.45)';
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(cx, cy, mag.inner * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 70, 40, 0.14)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = 'rgba(255, 90, 60, 0.8)';
      ctx.stroke();

      if (UI.debugNukeSrc >= 0) {
        const from = { x: UI.debugNukeSrc % w, y: (UI.debugNukeSrc / w) | 0 };
        const to = { x: tile % w, y: (tile / w) | 0 };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const arcHeight = Math.min(dist * 0.35, 40);
        const steps = Math.max(2, Math.ceil(dist));
        ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
        ctx.lineWidth = Math.max(1, this.dpr * 1.2);
        ctx.strokeStyle = 'rgba(255, 160, 90, 0.8)';
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const u = i / steps;
          const ua = Math.sin(Math.PI * u);
          const ux = (from.x + (to.x - from.x) * u + 0.5 - this.cam.x) * s + cw / 2;
          const uy = (from.y + (to.y - from.y) * u - ua * arcHeight + 0.5 - this.cam.y) * s + ch / 2;
          if (i === 0) ctx.moveTo(ux, uy); else ctx.lineTo(ux, uy);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        const srcx = (from.x + 0.5 - this.cam.x) * s + cw / 2;
        const srcy = (from.y + 0.5 - this.cam.y) * s + ch / 2;
        ctx.beginPath();
        ctx.arc(srcx, srcy, Math.max(s * 0.35, 5 * this.dpr), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 160, 90, 0.9)';
        ctx.fill();
      }
    }

    // Port joins the rail network exactly like City does (see
    // onStructureCompleted/previewCityConnections) — same preview branch.
    if ((UI.placing === 'factory' || UI.placing === 'city' || UI.placing === 'port') &&
        !(hoverB && hoverB.type === UI.placing)) {
      let lines = UI.placing === 'factory'
        ? Game.previewFactoryConnections(tile)
        : Game.previewCityConnections(tile);
      // The preview links to any station in range, whoever owns it, and the
      // range is far longer than anyone's sight. In fog a line is shown only
      // if the viewer could have worked it out: it ends on a station they have
      // discovered and runs over land they have discovered the whole way
      // (fogRailPreview), and a City or Port shows any at all only when a
      // Factory they can see is in range. The sim's own answer is found on the
      // real map, so drawing it would say whether the tile under the cursor,
      // and the ground between it and the station, is land.
      if (fog && lines.length) {
        if (UI.placing !== 'factory' && !this.fogSeesFactoryNear(tile)) lines = [];
        else lines = lines.map(path => this.fogRailPreview(path[0], path[path.length - 1])).filter(Boolean);
      }

      if (lines.length || UI.placing === 'factory') {
        const cx = px + s / 2, cy = py + s / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, Game.TRAIN_STATION_MAX_RANGE * s, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, this.dpr);
        ctx.strokeStyle = 'rgba(255, 225, 140, 0.35)';
        ctx.stroke();
      }

      if (lines.length) {
        ctx.setLineDash([6 * this.dpr, 5 * this.dpr]);
        ctx.lineWidth = Math.max(1, this.dpr * 1.2);
        ctx.strokeStyle = 'rgba(255, 225, 140, 0.8)';
        ctx.beginPath();
        for (const path of lines) {
          let moved2 = false;
          for (const t of path) {
            const lx = (t % w + 0.5 - this.cam.x) * s + cw / 2;
            const ly = (((t / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
            if (!moved2) { ctx.moveTo(lx, ly); moved2 = true; }
            else ctx.lineTo(lx, ly);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.fillStyle = ok ? 'rgba(109, 255, 150, 0.45)' : 'rgba(255, 90, 90, 0.45)';
    ctx.fillRect(px, py, Math.max(1, s), Math.max(1, s));

    // A single tile is a few pixels at map-fit zoom, so the ring — not the
    // square — is what the eye actually follows.
    ctx.beginPath();
    ctx.arc(px + s / 2, py + s / 2, Math.max(s * 0.9, 11 * this.dpr), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.strokeStyle = ok ? 'rgba(109, 255, 150, 0.9)' : 'rgba(255, 90, 90, 0.9)';
    ctx.stroke();
  },

  // --- Battle Royale: the Drill's circle ---------------------------------------
  // All client-side and read-only: nothing here writes Game. The cached land
  // data below is derived once per map from GameMap, never from the circle.
  _brKey: null,
  _br: null,

  // Once per map: each row's first and last land x (the farthest land tile from
  // any point is always one of these, so the placement ghost's r0 needs ~2*h
  // distance checks instead of a full-map pass, and equals Game.drillStartRadius
  // exactly), plus two low-res land masks (dark dead-zone tint, red danger tint)
  // at <= ~1000 px wide, so the per-frame cost is two clipped drawImage calls.
  brLand() {
    const key = GameMap.terrain;
    if (this._brKey === key && this._br) return this._br;
    const w = GameMap.width, h = GameMap.height, owner = GameMap.owner;
    const lo = new Int32Array(h).fill(-1), hi = new Int32Array(h).fill(-1);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        if (owner[i] !== WATER) { if (lo[y] < 0) lo[y] = x; hi[y] = x; }
      }
    }
    const step = Math.max(1, Math.ceil(Math.max(w, h) / 1000));
    const mw = Math.ceil(w / step), mh = Math.ceil(h / step);
    const mk = (r, g, b, a) => {
      const c = document.createElement('canvas'); c.width = mw; c.height = mh;
      const cx = c.getContext('2d'), img = cx.createImageData(mw, mh), d = img.data;
      const half = step >> 1;
      for (let y = 0; y < mh; y++) {
        const sy = Math.min(h - 1, y * step + half);
        for (let x = 0; x < mw; x++) {
          if (owner[sy * w + Math.min(w - 1, x * step + half)] === WATER) continue;
          const o = (y * mw + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
        }
      }
      cx.putImageData(img, 0, 0);
      return c;
    };
    this._brKey = key;
    // Dead land itself is drawn from Game.drillDead on the tile layer
    // (paintTile/tintDead); this mask is only the 30 s danger forecast.
    return this._br = { lo, hi, step, warn: mk(255, 60, 40, 120) };
  },

  // r0 in whole tiles for a Drill at (cx, cy): the same integer as
  // Game.drillStartRadius, cheap enough to run every frame.
  drillPreviewRadius(cx, cy) {
    const { lo, hi } = this.brLand();
    let m = 0;
    for (let y = 0; y < lo.length; y++) {
      if (lo[y] < 0) continue;
      const dy = y - cy, a = lo[y] - cx, b = hi[y] - cx;
      const d = dy * dy + Math.max(a * a, b * b);
      if (d > m) m = d;
    }
    let r = Math.ceil(Math.sqrt(m));
    while (r * r < m) r++;
    while (r > 0 && (r - 1) * (r - 1) >= m) r--;
    return r;
  },

  // True when any of p's border tiles lies outside the circle as it will be in
  // secs seconds. Called by UI at 1 Hz; walks the border set only.
  ownLandDoomed(p, secs) {
    const d = Game.drill;
    if (!d) return false;
    const r = Game.drillRadius(Game.ticks + secs * Game.TICKS_PER_SEC);
    if (r >= d.r0 * Game.DRILL_FP) return false;
    for (const t of p.borderTiles) if (!Game.drillInside(t, r)) return true;
    return false;
  },

  // Dead-zone veil, circle edge, the 30-second danger band, the centre marker
  // and the placement ping. Cost is a handful of path ops and one drawImage
  // of ~1000x500 whatever the map size.
  drawDrill() {
    const d = Game.drill;
    if (!d) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const FP = Game.DRILL_FP, tps = Game.TICKS_PER_SEC, now = performance.now();
    const px = (d.cx + 0.5 - this.cam.x) * s + cw / 2;
    const py = (d.cy + 0.5 - this.cam.y) * s + ch / 2;
    const rNow = d.r / FP, shrinking = d.r < d.r0 * FP;
    const rSoon = Game.drillRadius(Game.ticks + 30 * tps) / FP;
    const br = this.brLand();
    const mapX = (-this.cam.x) * s + cw / 2, mapY = (-this.cam.y) * s + ch / 2;
    const mw = GameMap.width * s, mh = GameMap.height * s;
    ctx.imageSmoothingEnabled = false;

    if (shrinking) {
      // The dead zone. Dead land is already tinted on the tile layer, tile
      // for tile from Game.drillDead (paintTile); this veil darkens the rest
      // of the outside, the dead water, so the whole zone reads as one. One
      // path fill, whatever the map size.
      ctx.beginPath();
      ctx.rect(0, 0, cw, ch);
      ctx.arc(px, py, Math.max(0, rNow * s), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(16, 0, 26, 0.38)';
      ctx.fill('evenodd');
      // Land that dies within 30 s: a pulsing red band, on top.
      if (rSoon < rNow) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, rNow * s, 0, Math.PI * 2);
        ctx.arc(px, py, rSoon * s, 0, Math.PI * 2);
        ctx.clip('evenodd');
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(now / 280);
        ctx.drawImage(br.warn, mapX, mapY, mw, mh);
        ctx.restore();
      }
    }

    // The edge: soft glow under a bright line; dashed while it is only a
    // promise (countdown), solid once it moves.
    ctx.beginPath();
    ctx.arc(px, py, Math.max(0, rNow * s), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(4, 6 * this.dpr);
    ctx.strokeStyle = 'rgba(255, 70, 40, 0.22)';
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.strokeStyle = 'rgba(255, 150, 110, 0.95)';
    if (!shrinking) ctx.setLineDash([10 * this.dpr, 7 * this.dpr]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Centre marker.
    const size = Math.max(22 * this.dpr, 3 * s);
    ctx.beginPath();
    ctx.arc(px, py, size * 0.75 + 2 * this.dpr * (1 + Math.sin(now / 400)), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, 2 * this.dpr);
    ctx.strokeStyle = 'rgba(255, 150, 110, 0.9)';
    ctx.stroke();
    const img = this.icon('drill', size);
    if (img) ctx.drawImage(img, px - size / 2, py - size / 2, size, size);

    // Placement ping: three expanding rings around the Drill in the seconds
    // after it is built (UI sets the banner window the same way).
    const age = UI._drillBannerUntil ? (now - (UI._drillBannerUntil - 8000)) / 1000 : 99;
    if (age >= 0 && age < 4.5) {
      for (let k = 0; k < 3; k++) {
        const a = age - k * 0.45;
        if (a < 0 || a > 1.8) continue;
        ctx.beginPath();
        ctx.arc(px, py, (14 + 90 * (a / 1.8)) * this.dpr, 0, Math.PI * 2);
        ctx.lineWidth = 3 * this.dpr;
        ctx.strokeStyle = 'rgba(255, 120, 80, ' + (0.9 * (1 - a / 1.8)).toFixed(2) + ')';
        ctx.stroke();
      }
    }
  },

  // Partitions an attack's live frontier into disconnected segments using
  // 8-connected BFS (diagonal touches still count as one front — otherwise a
  // border running at 45 degrees fragments into a chain of singletons), then
  // returns one representative tile per segment: whichever tile in the
  // cluster sits closest to that cluster's own centroid, so the label always
  // lands on real border rather than in the gap between two fronts.
  // Ported from OpenFront's AttackImpl.clusterBorderTiles — same 30-tile
  // minimum and top-2 cap, so a nation fighting on two separated fronts gets
  // a number on each, but three-plus fragments (or a second sliver too small
  // to matter) still collapse down to the biggest ones.
  // `tiles` is the attack's live border Set (Game.stepAttack keeps it in step
  // with the conquest heap, which may hold the same tile more than once and so
  // can't be clustered directly); an array is still accepted.
  clusterBorderTiles(tiles, minSize, maxClusters) {
    const borderSet = tiles instanceof Set ? tiles : new Set(tiles);
    if (borderSet.size === 0) return [];
    const w = GameMap.width, h = GameMap.height;
    const visited = new Set();
    const clusters = [];

    for (const start of tiles) {
      if (visited.has(start)) continue;
      const queue = [start];
      visited.add(start);
      let qi = 0, sumX = 0, sumY = 0, count = 0;
      while (qi < queue.length) {
        const t = queue[qi++];
        const tx = t % w, ty = (t / w) | 0;
        sumX += tx; sumY += ty; count++;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = tx + dx, ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nt = ny * w + nx;
            if (borderSet.has(nt) && !visited.has(nt)) {
              visited.add(nt);
              queue.push(nt);
            }
          }
        }
      }

      const cx = sumX / count, cy = sumY / count;
      let best = queue[0], bestDist = Infinity;
      for (const t of queue) {
        const tx = t % w, ty = (t / w) | 0;
        const ddx = tx - cx, ddy = ty - cy;
        const dist = ddx * ddx + ddy * ddy;
        if (dist < bestDist) { bestDist = dist; best = t; }
      }
      clusters.push({ tile: best, size: count });
    }

    clusters.sort((a, b) => b.size - a.size);
    if (clusters.length <= 1) return clusters.map(c => c.tile);
    const significant = clusters.filter(c => c.size >= minSize);
    if (significant.length === 0) return [clusters[0].tile];
    return significant.slice(0, maxClusters).map(c => c.tile);
  },

  // Live troop counter on every active front, sat on the leading edge(s).
  // Read live from the attack each frame, so reinforcing a push simply makes
  // the number climb rather than spawning a second marker. A single nation
  // can be fighting the same enemy across two disconnected stretches of
  // border at once, so each front is clustered and labelled independently
  // rather than averaged into one point hovering in the no-man's-land
  // between them.
  drawFronts() {
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const fog = this.fogged;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const a of Game.attacks) {
      if (a.troops <= 0) continue;   // fully cancelled; cleared later this tick
      // The player's own pushes and incoming Nation attacks carry a number;
      // wars between other nations still show as a front line, but Tribes
      // attacking the player are low-effort filler AI — a live count for
      // every Tribe front is noise nobody reads.
      if (a.attacker !== Game.me && a.target !== Game.me) continue;
      if (a.target === Game.me && a.attacker !== Game.me && Game.players[a.attacker].isTribe) continue;
      // Unclaimed land isn't contested — there's no defender to fight over
      // the number with, so it's just noise on an ordinary expansion.
      if (a.target < 0) continue;
      if (a.border.size <= 0) continue;

      const fronts = this.clusterBorderTiles(a.border, 30, 2);
      if (!fronts.length) continue;

      // Every front reaching this point already involves the player one way
      // or the other: blue for a push they're making, red for one landing on
      // them. A retreating front reads as grey — it's on its way out, not
      // fighting for the ground its number still sits on.
      const colour = a.retreating ? '#9aa4b2' : (a.attacker === Game.me ? '#6db4ff' : '#ff6b6b');
      const font = Math.max(13 * this.dpr, Math.min(19 * this.dpr, s * 1.6));
      ctx.font = '600 ' + font.toFixed(1) + 'px system-ui, sans-serif';
      ctx.lineWidth = Math.max(2.5, font * 0.34);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = colour;
      const text = formatCountTight(a.troops);

      for (const tile of fronts) {
        const px = (tile % w + 0.5 - this.cam.x) * s + cw / 2;
        const py = ((tile / w | 0) + 0.5 - this.cam.y) * s + ch / 2;
        if (px < -60 || py < -60 || px > cw + 60 || py > ch + 60) continue;
        if (fog && this.fogHides(tile)) continue;
        ctx.strokeText(text, px, py);
        ctx.fillText(text, px, py);
      }
    }
  },

  // A small bitmap circle — filled square "dots" on a disc of radius R,
  // rather than ctx.arc()'s smooth curve — so the boat reads as deliberately
  // chunky/pixel-art, matching the map's own hard-edged tile blit instead of
  // the softer vector shapes the rest of the overlay (fronts, structures)
  // uses. Built once and reused; the shape itself never changes.
  BOAT_DOT_RADIUS: 3,
  buildBoatDots() {
    const R = this.BOAT_DOT_RADIUS;
    const dots = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy <= R * R) dots.push([dx, dy]);
      }
    }
    return dots;
  },

  // Extends (or, on a retreat crossing back over a tile boundary, rebuilds)
  // `b`'s cached trail — a Path2D in tile-space (tile+0.5 so it lands on the
  // same cell centers every other tile-based draw call uses) covering
  // path[0..idx]. A Path2D can only grow (no "remove the last segment" op),
  // so a retreating boat — whose idx counts back down as it sails home, see
  // stepBoats — can't be shrunk in place; it's cheaper to detect that case
  // and rebuild from scratch than to carry a second data structure just for
  // it. Either way this only pays for the tiles crossed since the last
  // draw (normally 0 or 1) instead of the whole route every frame.
  updateBoatTrail(b, idx, w) {
    if (b._trailBuiltIdx === undefined || idx < b._trailBuiltIdx) {
      const path = new Path2D();
      const p0 = b.path[0];
      path.moveTo((p0 % w) + 0.5, ((p0 / w) | 0) + 0.5);
      for (let k = 1; k <= idx; k++) {
        const t = b.path[k];
        path.lineTo((t % w) + 0.5, ((t / w) | 0) + 0.5);
      }
      b._trailPath = path;
    } else {
      for (let k = b._trailBuiltIdx + 1; k <= idx; k++) {
        const t = b.path[k];
        b._trailPath.lineTo((t % w) + 0.5, ((t / w) | 0) + 0.5);
      }
    }
    b._trailBuiltIdx = idx;
  },

  // Boats in transit, drawn as a pixelated dot with a trail line back to
  // where it launched from. The trail's traveled-so-far geometry is cached
  // per boat (see updateBoatTrail) rather than rebuilt tile-by-tile every
  // frame — needs no cleanup of its own beyond that, since it vanishes the
  // instant the boat does (landed, sunk, refunded, recalled home), the
  // resolved boat object simply isn't in Game.boats to iterate over anymore.
  // Stroked via a camera-matching canvas transform (rather than this file's
  // usual manual per-point toScreen math) so the cached tile-space path
  // stays valid across pan/zoom — only the transform changes, not the path.
  drawBoats() {
    if (!Game.boats.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const dots = this._boatDots || (this._boatDots = this.buildBoatDots());
    // Overall radius on screen, in pixels, split across BOAT_DOT_RADIUS dots
    // so the whole cluster scales as one shape. The floor is kept small so
    // boats don't dwarf the map when zoomed out.
    const size = Math.max(2.5 * this.dpr, Math.min(13 * this.dpr, s * 1.05));
    const unit = size / this.BOAT_DOT_RADIUS;
    const fog = this.fogged;

    for (const b of Game.boats) {
      const idx = Math.min(b.path.length - 1, Math.floor(b.pos));
      const frac = Math.min(1, b.pos - idx);
      const a = b.path[idx], c = b.path[Math.min(idx + 1, b.path.length - 1)];
      const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;

      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;
      // Fog: the viewer's own boats included. A boat reveals nothing, so it
      // is out of sight while it crosses water its nation has not discovered.
      // (Its trail picks up from wherever it was last drawn: updateBoatTrail
      // extends over every tile crossed since.)
      if (fog && this.fogHidesAt(tx, ty)) continue;

      const owner = Game.players[b.attacker];
      let colour = owner ? `rgb(${owner.color[0]}, ${owner.color[1]}, ${owner.color[2]})` : 'rgba(235,240,250,0.9)';
      if (b.retreating) colour = '#9aa4b2';

      // Trail: the actual sea route travelled so far, tile by tile, not a
      // straight line — seaPath curves around coastlines, so a direct line
      // from launch to here would cut across land. Same idea as OpenFront's
      // own boat trail. The cached path covers whole tiles crossed so far;
      // the sub-tile leading edge up to the boat's exact position changes
      // every frame, so it's drawn fresh as a single short segment instead
      // of being folded into the cache.
      this.updateBoatTrail(b, idx, w);
      ctx.setTransform(s, 0, 0, s, cw / 2 - this.cam.x * s, ch / 2 - this.cam.y * s);
      ctx.lineWidth = Math.max(1, this.dpr) / s;
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.35;
      ctx.stroke(b._trailPath);
      ctx.beginPath();
      ctx.moveTo(ax + 0.5, ay + 0.5);
      ctx.lineTo(tx + 0.5, ty + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Dark backing a hair larger than the coloured dots, same trick the
      // troop-count text's stroke uses, so the dot stays legible over light
      // water rather than just blending in.
      const pad = unit * 0.3;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      for (const [dx, dy] of dots) {
        ctx.fillRect(px + dx * unit - unit / 2 - pad / 2, py + dy * unit - unit / 2 - pad / 2, unit + pad, unit + pad);
      }
      ctx.fillStyle = colour;
      for (const [dx, dy] of dots) {
        ctx.fillRect(px + dx * unit - unit / 2, py + dy * unit - unit / 2, unit, unit);
      }
    }
  },

  // Trains in transit, drawn with the same pixelated-dot technique drawBoats
  // uses for a consistent "chunky" unit look — but skips the trail line
  // drawBoats needs to show its route, since a train's whole route is
  // already permanently visible as a rail (see drawRailroads).
  drawTrains() {
    if (!Game.trains.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const dots = this._boatDots || (this._boatDots = this.buildBoatDots());
    const size = Math.max(5 * this.dpr, Math.min(13 * this.dpr, s * 1.05));
    const unit = size / this.BOAT_DOT_RADIUS;
    const fog = this.fogged;

    for (const t of Game.trains) {
      // trainTilePos walks the same orthogonal elbow waypoints drawRailroads
      // renders (see connectStations/buildTrainRoute), not a discrete
      // per-tile path, so the dot glides smoothly along each horizontal/
      // vertical leg and pivots cleanly at the bend instead of hopping tile
      // to tile.
      const { x: tx, y: ty } = Game.trainTilePos(t);

      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;
      if (fog && this.fogHidesAt(tx, ty)) continue;

      const owner = Game.players[t.owner];
      const c2 = owner ? owner.color : [200, 200, 200];
      const colour = `rgb(${c2[0]}, ${c2[1]}, ${c2[2]})`;

      const pad = unit * 0.3;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      for (const [dx, dy] of dots) {
        ctx.fillRect(px + dx * unit - unit / 2 - pad / 2, py + dy * unit - unit / 2 - pad / 2, unit + pad, unit + pad);
      }
      ctx.fillStyle = colour;
      for (const [dx, dy] of dots) {
        ctx.fillRect(px + dx * unit - unit / 2, py + dy * unit - unit / 2, unit, unit);
      }
    }
  },

  // Trade ships in transit between two Ports, drawn as a single flat circle
  // in their source nation's own colour — no trail (unlike drawBoats/
  // drawTrains' pixelated-dot cluster), since with dozens of ships in flight
  // on long cross-map sea routes, redrawing each one's entire travelled path
  // as a fresh line every frame was the actual cost driver, not the dot
  // itself. One arc+fill (plus a thin dark outline for contrast against
  // water) replaces what used to be a moveTo/lineTo per travelled waypoint
  // and ~2*BOAT_DOT_RADIUS^2 fillRect calls.
  drawTradeShips() {
    if (!Game.tradeShips.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const radius = Math.max(3.5 * this.dpr, Math.min(8 * this.dpr, s * 0.65));
    const fog = this.fogged;

    for (const ship of Game.tradeShips) {
      const idx = Math.min(ship.path.length - 1, Math.floor(ship.pos));
      const frac = Math.min(1, ship.pos - idx);
      const a = ship.path[idx], c = ship.path[Math.min(idx + 1, ship.path.length - 1)];
      const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;

      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;
      if (fog && this.fogHidesAt(tx, ty)) continue;   // the viewer's own included, like boats

      const owner = Game.players[ship.owner];
      const col = owner ? owner.color : [200, 200, 200];

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 0.6);
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.stroke();
    }
  },

  // CSS-pixel (client-coordinate) position of a warship — the same space
  // screenToTile/findStructureNear use for hit-testing (UI's shift-drag box
  // select and click-to-relocate), distinct from the device-pixel math
  // drawWarships uses below to actually paint it.
  warshipClientPos(w) {
    const s = this.cam.scale;
    const p = Game.pathPos(w);
    return {
      x: (p.x + 0.5 - this.cam.x) * s + window.innerWidth / 2,
      y: (p.y + 0.5 - this.cam.y) * s + window.innerHeight / 2
    };
  },

  // Warships: a persistent combat unit, not a transient boat/trade-ship
  // crossing, so it gets a heavier, distinct hull silhouette (an elongated
  // hexagon, rotated to face its current heading) instead of the pixel-dot
  // or flat-circle treatment those get — plus a health bar once damaged and
  // a selection ring + patrol-radius ring for whichever of the player's own
  // are currently shift-drag selected (see UI.selectedWarships).
  drawWarships() {
    if (!Game.warships.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, mw = GameMap.width;
    const r = Math.max(7 * this.dpr, Math.min(18 * this.dpr, s * 1.0));
    // Fog: culled on position like everything else, the viewer's own
    // included. By design a warship reveals the water around it as it sails
    // (docs/fog-of-war.md), which is what keeps one's own fleet in view.
    const fog = this.fogged;

    if (UI.selectedWarships.size) {
      for (const w of Game.warships) {
        if (!UI.selectedWarships.has(w)) continue;
        const { x: sx, y: sy } = this.warshipClientPos(w);
        const px = sx * this.dpr, py = sy * this.dpr;
        if (fog) {
          const p = Game.pathPos(w);
          if (this.fogHidesAt(p.x, p.y)) continue;   // no rings round a hull that isn't drawn
        }
        if (px >= -60 && py >= -60 && px <= cw + 60 && py <= ch + 60) {
          ctx.beginPath();
          ctx.arc(px, py, r * 1.8, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = Math.max(1.5, this.dpr * 1.5);
          ctx.setLineDash([3 * this.dpr, 3 * this.dpr]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Centered on the ship's live position, not patrolTile, so the ring
        // follows it while under way instead of sitting at its destination
        // (patrolTile is set the instant an order is issued — see
        // moveWarships/buildWarship).
        ctx.beginPath();
        ctx.arc(px, py, Game.WARSHIP_PATROL_RANGE * s, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = Math.max(1, this.dpr);
        ctx.setLineDash([5 * this.dpr, 5 * this.dpr]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Destination marker: only while actually en route (still short of
        // the last path tile), so an arrived/patrolling ship doesn't show a
        // marker on top of itself.
        if (w.pos < w.path.length - 1 && !(fog && this.fogHides(w.path[w.path.length - 1]))) {
          const destTile = w.path[w.path.length - 1];
          const dx = (destTile % mw + 0.5 - this.cam.x) * s + cw / 2;
          const dy = (((destTile / mw) | 0) + 0.5 - this.cam.y) * s + ch / 2;
          const m = Math.max(4 * this.dpr, Math.min(9 * this.dpr, s * 0.3));
          ctx.beginPath();
          ctx.moveTo(dx, dy - m);
          ctx.lineTo(dx + m, dy);
          ctx.lineTo(dx, dy + m);
          ctx.lineTo(dx - m, dy);
          ctx.closePath();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = Math.max(1.5, this.dpr * 1.5);
          ctx.stroke();
        }
      }
    }

    for (const w of Game.warships) {
      const idx = Math.min(w.path.length - 1, Math.floor(w.pos));
      const frac = Math.min(1, w.pos - idx);
      const a = w.path[idx], c = w.path[Math.min(idx + 1, w.path.length - 1)];
      const ax = a % mw, ay = (a / mw) | 0, cx = c % mw, cy = (c / mw) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;
      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;
      if (fog && this.fogHidesAt(tx, ty)) continue;

      const owner = Game.players[w.owner];
      const col = owner ? owner.color : [200, 200, 200];

      // Rotationally symmetric (a ring inside a ring), so no heading/rotate
      // needed unlike the old hexagon hull this replaced.
      ctx.save();
      ctx.translate(px, py);

      ctx.beginPath();
      ctx.arc(0, 0, r * 0.95, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${(col[0] * 0.55) | 0}, ${(col[1] * 0.55) | 0}, ${(col[2] * 0.55) | 0})`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
      ctx.lineWidth = Math.max(1.2, r * 0.16);
      ctx.stroke();

      // Inner ring: same stroked-not-filled treatment the old turret square
      // used, just circular now.
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.stroke();
      ctx.restore();

      // Health bar: only once damaged, matching the rest of the HUD's
      // "only surface what's changed from the default" restraint.
      if (w.health < w.maxHealth) {
        const bw = r * 2.1, bh = Math.max(2, r * 0.22);
        const bx = px - bw / 2, by = py - r * 1.5;
        const pct = Math.max(0, w.health / w.maxHealth);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = pct > 0.5 ? '#7ee787' : pct > 0.25 ? '#f0c674' : '#ff6b6b';
        ctx.fillRect(bx, by, bw * pct, bh);
      }
    }
  },

  // CSS-pixel position of a scout, for the hit-tests (see warshipClientPos).
  scoutClientPos(sc) {
    const s = this.cam.scale;
    const p = Game.pathPos(sc);
    return {
      x: (p.x + 0.5 - this.cam.x) * s + window.innerWidth / 2,
      y: (p.y + 0.5 - this.cam.y) * s + window.innerHeight / 2
    };
  },

  // The scout (anyone's) under a CSS-pixel point, or null. Fog: one the viewer
  // cannot see is not drawn and so is not there to find.
  findScoutNear(sx, sy) {
    if (!Game.scouts.length) return null;
    const s = this.cam.scale, w = GameMap.width;
    // The drawn hull's radius in CSS px (see drawScouts), plus some slop.
    const buffer = Math.max(7, Math.min(18, s)) * 1.6;
    let best = null, bestDist = Infinity;
    for (const sc of Game.scouts) {
      const idx = Math.min(sc.path.length - 1, Math.floor(sc.pos));
      const frac = Math.min(1, sc.pos - idx);
      const a = sc.path[idx], c = sc.path[Math.min(idx + 1, sc.path.length - 1)];
      const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;
      if (!this.canSee(Math.floor(ty + 0.5) * w + Math.floor(tx + 0.5))) continue;
      const bx = (tx + 0.5 - this.cam.x) * s + window.innerWidth / 2;
      const by = (ty + 0.5 - this.cam.y) * s + window.innerHeight / 2;
      const d = Math.hypot(bx - sx, by - sy);
      if (d <= buffer && d < bestDist) { best = sc; bestDist = d; }
    }
    return best;
  },

  // Scouts (fog matches only): an unarmed ship that exists to uncover the map,
  // drawn as an arrowhead in its owner's colour pointing the way it is sailing,
  // so it cannot be taken for a warship's pair of rings. Culled by the fog on
  // position like every other pass; a scout lights up the water round it, so
  // the player's own are always in view in practice.
  //
  // WHAT IS NEVER DRAWN: the route. A scout's `path` is found on the real map
  // and runs through water the owner has not discovered, so a line along it
  // would trace unseen coastlines. The heading below reads only the few tiles
  // right around the hull, which are discovered by construction, and the
  // destination marker (drawScoutOrders) is the raw tile the player clicked.
  // While a route is still being found, the owner's scout shows a small
  // spinner, and nothing else.
  drawScouts() {
    if (!Game.scouts.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, mw = GameMap.width;
    const r = Math.max(7 * this.dpr, Math.min(18 * this.dpr, s * 1.0));
    const fog = this.fogged;

    for (const sc of Game.scouts) {
      const path = sc.path, end = path.length - 1;
      const idx = Math.min(end, Math.floor(sc.pos));
      const frac = Math.min(1, sc.pos - idx);
      const a = path[idx], c = path[Math.min(idx + 1, end)];
      const ax = a % mw, ay = (a / mw) | 0, cx = c % mw, cy = (c / mw) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;
      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;
      if (fog && this.fogHidesAt(tx, ty)) continue;

      // Heading: along the tiles it is sailing through, from where the hull
      // is to a few tiles ahead, or from a few tiles back once it is at the
      // end. Straight up while it has no path yet (just launched, or just
      // re-ordered).
      let angle = -Math.PI / 2;
      const j = Math.min(end, idx + 4), i = j > idx ? idx : Math.max(0, end - 4);
      if (j !== i) {
        const hx = path[j] % mw - path[i] % mw, hy = ((path[j] / mw) | 0) - ((path[i] / mw) | 0);
        if (hx !== 0 || hy !== 0) angle = Math.atan2(hy, hx);
      }

      const owner = Game.players[sc.owner];
      const col = owner ? owner.color : [200, 200, 200];
      const mine = sc.owner === Game.me;

      // Own scout: a selection ring, and a spinner while its route is found.
      if (mine && UI.selectedScouts.has(sc)) {
        ctx.beginPath();
        ctx.arc(px, py, r * 1.8, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = Math.max(1.5, this.dpr * 1.5);
        ctx.stroke();
      }
      if (mine && sc.routing && sc.pos >= end) {
        const spin = Game.renderElapsed * 5;
        ctx.beginPath();
        ctx.arc(px, py, r * 1.45, spin, spin + Math.PI * 1.1);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = Math.max(1.2, this.dpr * 1.2);
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
      }

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(r * 1.15, 0);
      ctx.lineTo(-r * 0.8, -r * 0.75);
      ctx.lineTo(-r * 0.35, 0);
      ctx.lineTo(-r * 0.8, r * 0.75);
      ctx.closePath();
      ctx.fillStyle = `rgb(${(col[0] * 0.55) | 0}, ${(col[1] * 0.55) | 0}, ${(col[2] * 0.55) | 0})`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
      ctx.lineWidth = Math.max(1.2, r * 0.16);
      ctx.lineJoin = 'round';
      ctx.stroke();
      // The lens.
      ctx.beginPath();
      ctx.arc(r * 0.2, 0, r * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();

      // Health bar: only once damaged, exactly as a warship's.
      if (sc.health < sc.maxHealth) {
        const bw = r * 2.1, bh = Math.max(2, r * 0.22);
        const bx = px - bw / 2, by = py - r * 1.5;
        const pct = Math.max(0, sc.health / sc.maxHealth);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = pct > 0.5 ? '#7ee787' : pct > 0.25 ? '#f0c674' : '#ff6b6b';
        ctx.fillRect(bx, by, bw * pct, bh);
      }
    }
  },

  // Where the viewer's own scouts are headed: a hollow diamond on the tile
  // each was last sent to, exactly as clicked, quiet for one under way and
  // brighter for a selected one. Drawn over the fog because the click may
  // have been into the black; it is the player's own input, not the map. Gone
  // once the scout has stopped, since a scout that could not get all the way
  // there stopped somewhere else.
  drawScoutOrders() {
    if (!Game.scouts.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, mw = GameMap.width;
    const m = Math.max(4 * this.dpr, Math.min(9 * this.dpr, s * 0.3));
    for (const sc of Game.scouts) {
      if (sc.owner !== Game.me) continue;
      if (!sc.routing && sc.pos >= sc.path.length - 1) continue;
      const dx = (sc.destTile % mw + 0.5 - this.cam.x) * s + cw / 2;
      const dy = (((sc.destTile / mw) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      if (dx < -20 || dy < -20 || dx > cw + 20 || dy > ch + 20) continue;
      ctx.beginPath();
      ctx.moveTo(dx, dy - m);
      ctx.lineTo(dx + m, dy);
      ctx.lineTo(dx, dy + m);
      ctx.lineTo(dx - m, dy);
      ctx.closePath();
      ctx.strokeStyle = UI.selectedScouts.has(sc) ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = Math.max(1.5, this.dpr * 1.5);
      ctx.stroke();
    }
  },

  // A warship's shells in flight — see Game.warshipShootAt (spawns one at the
  // firing warship's position) and stepShells (advances shell.x/y toward the
  // target's live position every tick, resolving the hit — and removing the
  // shell — the instant it closes within range, so it never lingers at or
  // sails past a stale point once the target is hit or gone). Position is
  // whatever stepShells last computed, same tick-granularity look as
  // drawBoats/drawWarships rather than a smoothed lerp. Rendered as a small
  // blinking dot in the firing player's colour so a kill reads as "the shell
  // got there", not instant, matching drawWarships' health-bar-only-when-
  // damaged restraint by staying tiny and simple rather than a sprite/trail
  // effect.
  drawShells() {
    if (!Game.shells.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const r = Math.max(3 * this.dpr, Math.min(7 * this.dpr, s * 0.4));
    const fog = this.fogged;

    for (const sh of Game.shells) {
      const px = (sh.x + 0.5 - this.cam.x) * s + cw / 2;
      const py = (sh.y + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -20 || py < -20 || px > cw + 20 || py > ch + 20) continue;
      if (fog && this.fogHidesAt(sh.x, sh.y)) continue;

      const owner = Game.players[sh.ownerId];
      const col = owner ? owner.color : [255, 255, 255];
      // Blink driven by elapsed time (not travel progress) so it reads as a
      // hot, flickering tracer the whole way, not something fading in/out
      // with distance.
      const blink = 0.5 + 0.5 * Math.sin(Game.renderElapsed * 30 + sh.born * 17);

      ctx.beginPath();
      ctx.arc(px, py, r * (1.3 + blink * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${0.25 + blink * 0.35})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(px, py, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = blink > 0.5 ? '#fff8dc' : '#ffcf6b';
      ctx.fill();
    }
  },

  // The MIRV mothership in flight (ticket #28) — see Game.launchMirv/
  // stepMirvs, and nukes.js's own "MIRV" class comment for the full
  // explanation of why this game's MIRV keeps the straight-line-plus-arc
  // convention every other nuke here uses instead of porting OpenFront's
  // real cubic-Bezier parabola pathfinder. What IS real now: from/to are the
  // Silo and the actual mid-air separation point (launchMirv's own
  // formula), and arcHeight below now matches the real source's own control-
  // point height (getParabolaControlPoints: max(distance/3, 50)) rather than
  // an unrelated guess, so the visual apex lines up with what the real
  // pathfinder would have produced even though the curve shape underneath
  // it (sine vs. cubic Bezier) doesn't. Kept as its own function rather than
  // folded into drawNukes because Game.mirvs is a separate array from
  // Game.nukes (see Game.stepMirvs' own comment on why) and because a MIRV
  // reads as visually distinct from an ordinary nuke: a bigger warhead disc,
  // a brighter/wider contrail, and no target-ring preview (drawNukeTarget
  // needs a NUKE_MAGNITUDES entry, and the mothership has none — see
  // nukes.js's own comment on why; the precise impact points aren't known
  // until it splits, so nothing to ring yet).
  //
  // Fog: draw() calls this twice, like drawNukes (see there). `overFog` picks
  // the viewer's own motherships, drawn above the fog layer; without it the
  // call draws everyone else's, culled to the discovered area.
  drawMirvs(overFog) {
    if (!Game.mirvs.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const fog = this.fogged;

    for (const m of Game.mirvs) {
      const mine = m.ownerId === Game.me;
      if (fog && mine !== !!overFog) continue;
      const t = Math.max(0, Math.min(1, (Game.renderElapsed - m.born) / m.duration));
      const arc = Math.sin(Math.PI * t);
      const dist = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
      const arcHeight = Math.max(dist / 3, 50);

      const tx = m.from.x + (m.to.x - m.from.x) * t;
      const ty = m.from.y + (m.to.y - m.from.y) * t - arc * arcHeight;
      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;
      if (fog && !mine && this.fogHidesAt(tx, Math.max(0, ty))) continue;

      const colour = '#ff2a2a';
      const radius = Math.max(9 * this.dpr, Math.min(20 * this.dpr, s * 0.65));

      const steps = Math.max(2, Math.ceil(t * 24));
      ctx.setTransform(s, 0, 0, s, cw / 2 - this.cam.x * s, ch / 2 - this.cam.y * s);
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = t * i / steps;
        const ua = Math.sin(Math.PI * u);
        const ux = m.from.x + (m.to.x - m.from.x) * u + 0.5;
        const uy = m.from.y + (m.to.y - m.from.y) * u - ua * arcHeight + 0.5;
        if (i === 0) ctx.moveTo(ux, uy); else ctx.lineTo(ux, uy);
      }
      ctx.lineWidth = Math.max(2, this.dpr * 1.5) / s;
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      const flash = 0.5 + 0.5 * Math.sin(performance.now() / 90);
      ctx.globalAlpha = 0.55 * flash;
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = Math.max(1.5, this.dpr);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  },

  // A nuke in flight — see Game.launchNuke (fixed from/to tile-space points
  // and a born/duration pair, exactly like a warship's own shell) and
  // Game.stepNukes (detonates once duration elapses). Unlike a shell's
  // straight lerp, this arcs: a real ballistic missile climbs and falls
  // rather than skimming the ground, and OpenFront's own nuke path is a
  // literal parabola (ParabolaUniversalPathFinder) — this reproduces the
  // LOOK of that with a cheap sine offset in screen space rather than
  // porting the real curve-fitting pathfinder, since travel duration (the
  // part that actually matters for gameplay) is already exact off the
  // straight-line distance in Game.launchNuke. Warhead drawn as a plain
  // disc — round, so unlike the old rocket silhouette it needs no tangent/
  // angle bookkeeping to orient itself along the arc.
  //
  // Fog: the viewer's own missiles are the one thing they are shown over
  // undiscovered ground, so in a fog match draw() calls this twice. The first
  // call (no argument) runs under the fog layer and draws everyone else's,
  // each only while the warhead as drawn is inside the discovered area; the
  // contrail behind it is cut off by the layer where it leaves that area.
  // The second (`overFog`) runs above the layer and draws the viewer's own,
  // whole. With fog off there is one call and it draws them all.
  drawNukes(overFog) {
    if (!Game.nukes.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const fog = this.fogged;

    for (const n of Game.nukes) {
      const mine = n.ownerId === Game.me;
      if (fog && mine !== !!overFog) continue;
      // Ticket #25: a nuke heading for the player's land also marks where
      // it will hit — a pulsing red ring at its outer blast radius plus a
      // solid one at the guaranteed-destroyed inner radius. Drawn before the
      // warhead's own off-screen skip below, so the target still shows when
      // the missile itself is out of view. Skipped for mirvwarhead: up to
      // MIRV_WARHEAD_COUNT of these can be airborne from one strike, and
      // nukes.js's own updateNukeAlert already skips individual warhead rows
      // in favour of one alert for the mothership — this keeps the on-map
      // rings consistent with that same "warn once, not 350 times" call
      // (ui.js's own comment on it) and avoids up to 350 extra ring draws a
      // frame.
      const isWarhead = n.nukeType === 'mirvwarhead';
      if (!isWarhead && UI.nukeThreatensMe(n)) this.drawNukeTarget(n, s, cw, ch);

      // Clamped on the low end too, unlike a plain Math.min(1, ...): a
      // mirvwarhead can have a `born` still in the FUTURE while it waits out
      // its own per-warhead spawn delay (spawnMirvWarheads' own comment) —
      // without the floor, a negative t here would lerp/arc backward past
      // `from` instead of just sitting at it. A no-op for every other nuke
      // type, whose born is never later than the current tick.
      const t = Math.max(0, Math.min(1, (Game.renderElapsed - n.born) / n.duration));
      // Same arc the sim's SAM check uses (Game.nukeArcPos), so the drawn
      // warhead is exactly where interception thinks it is.
      const { x: tx, y: ty } = Game.nukeArcPos(n, t);
      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -30 || py < -30 || px > cw + 30 || py > ch + 30) continue;
      // The arc can lift a warhead past the top of the map, where there is no
      // fog to ask; the top row answers for it.
      if (fog && !mine && this.fogHidesAt(tx, Math.max(0, ty))) continue;

      const colour = '#ff2a2a';
      const radius = Math.max(6 * this.dpr, Math.min(14 * this.dpr, s * 0.45));

      // Contrail: the parabola traced from launch (Silo) up to the nuke's
      // current position, left on screen for the rest of the flight — same
      // "shows you where it came from" idea as a boat's own trail (see
      // drawBoats/updateBoatTrail), just rebuilt fresh off the arc formula
      // above every frame instead of cached tile-by-tile, since a nuke's
      // whole flight is a few seconds and a handful of sample points, not a
      // boat's much longer sea route. Stroked via the same camera-matching
      // transform trick drawBoats uses so it stays correct across pan/zoom.
      // mirvwarhead gets a flat 2-point contrail (a straight line to its
      // current position) instead of the full up-to-24-segment arced
      // polyline every other nuke draws — with up to MIRV_WARHEAD_COUNT of
      // these on screen from one strike, a full per-warhead polyline is real
      // per-frame cost for a detail that reads as visual noise at that
      // density anyway. atombomb/hydrogenbomb keep the full polyline.
      const steps = isWarhead ? 1 : Math.max(2, Math.ceil(t * 24));
      ctx.setTransform(s, 0, 0, s, cw / 2 - this.cam.x * s, ch / 2 - this.cam.y * s);
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = t * i / steps;
        const p = Game.nukeArcPos(n, u);
        const ux = p.x + 0.5, uy = p.y + 0.5;
        if (i === 0) ctx.moveTo(ux, uy); else ctx.lineTo(ux, uy);
      }
      ctx.lineWidth = Math.max(1, this.dpr) / s;
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.45;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // Warhead as a plain filled disc at the tip — orientation-free, so no
      // tangent/angle computation needed unlike the old rocket silhouette.
      // It flashes in flight (wall-clock pulse, same idea as drawNukeTarget's
      // ring, so it's fine to run off performance.now() here in render.js)
      // by brightening toward white so it reads against its own owner colour
      // rather than blending into it.
      const flash = 0.5 + 0.5 * Math.sin(performance.now() / 90);
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.globalAlpha = 0.55 * flash;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  },

  // Target marker for an incoming nuke — see drawNukes. Render-only; the
  // pulse runs off the wall clock, which is fine outside the sim.
  drawNukeTarget(n, s, cw, ch) {
    const mag = Game.NUKE_MAGNITUDES[n.nukeType];
    if (!mag) return;
    const ctx = this.ctx;
    const cx = (n.to.x + 0.5 - this.cam.x) * s + cw / 2;
    const cy = (n.to.y + 0.5 - this.cam.y) * s + ch / 2;
    const outer = mag.outer * s, inner = mag.inner * s;
    if (cx + outer < 0 || cy + outer < 0 || cx - outer > cw || cy - outer > ch) return;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);

    ctx.save();
    ctx.lineWidth = 2 * this.dpr;
    ctx.strokeStyle = '#ff4040';
    ctx.globalAlpha = 0.35 + 0.45 * pulse;
    ctx.setLineDash([8 * this.dpr, 6 * this.dpr]);
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.12 + 0.1 * pulse;
    ctx.fillStyle = '#ff2020';
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.stroke();
    ctx.restore();
  },

  // The shockwave left by a detonation — see Game.detonateNuke's push to
  // nukeBlasts and Game.stepNukes' own aging/pruning. An expanding ring from
  // inner to outer radius over NUKE_BLAST_FX_DURATION, fading out, plus a
  // brief bright flash at the core — purely cosmetic feedback, since the
  // actual lasting effect (the crater) is already visible in the terrain
  // itself the instant GameMap.owner flips to WATER.
  drawNukeBlasts() {
    if (!Game.nukeBlasts.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const fog = this.fogged;

    for (const b of Game.nukeBlasts) {
      // Fog: a detonation on undiscovered ground is not shown, the viewer's
      // own included; the missile is theirs to watch, the result is not.
      if (fog && this.fogHidesAt(b.x, b.y)) continue;
      const t = Math.min(1, (Game.renderElapsed - b.born) / Game.NUKE_BLAST_FX_DURATION);
      const px = (b.x + 0.5 - this.cam.x) * s + cw / 2;
      const py = (b.y + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -b.outer * s || py < -b.outer * s || px > cw + b.outer * s || py > ch + b.outer * s) continue;

      const alpha = Math.max(0, 1 - t);
      const ringR = (b.inner + (b.outer - b.inner) * t) * s;
      ctx.beginPath();
      ctx.arc(px, py, ringR, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, s * 0.06 * alpha);
      ctx.strokeStyle = `rgba(255, 150, 60, ${0.7 * alpha})`;
      ctx.stroke();

      if (t < 0.35) {
        const flashAlpha = (1 - t / 0.35) * 0.6;
        ctx.beginPath();
        ctx.arc(px, py, b.inner * s, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 240, 200, ${flashAlpha})`;
        ctx.fill();
      }
    }
  },

  // An intercept kill — see Game.stepSAMs' push to samFlashes and its own
  // aging/pruning. A quick expanding ring, deliberately smaller and much
  // faster than drawNukeBlasts' own shockwave — this is confirming a nuke
  // got shot down before it could go off, not the detonation itself.
  drawSamFlashes() {
    if (!Game.samFlashes.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const fog = this.fogged;

    for (const f of Game.samFlashes) {
      if (fog && this.fogHidesAt(f.x, Math.max(0, f.y))) continue;   // an intercept happens up on the arc, like drawNukes
      // Lower-bound clamp is load-bearing, not just tidy: an unclamped
      // negative t here fed straight into `maxR * t` below as a ctx.arc
      // radius — Game.fastForward() can spawn one with `born` set from an
      // `elapsed` far ahead of renderElapsed (which only advances inside
      // main.js's frame loop); see Game.dynamicSamRange's comment for the
      // first place this exact crash shape was caught.
      const t = Math.max(0, Math.min(1, (Game.renderElapsed - f.born) / Game.SAM_FLASH_FX_DURATION));
      const px = (f.x + 0.5 - this.cam.x) * s + cw / 2;
      const py = (f.y + 0.5 - this.cam.y) * s + ch / 2;
      const maxR = 4 * s;
      if (px < -maxR || py < -maxR || px > cw + maxR || py > ch + maxR) continue;

      const alpha = Math.max(0, 1 - t);
      ctx.beginPath();
      ctx.arc(px, py, maxR * t, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, s * 0.05 * alpha);
      ctx.strokeStyle = `rgba(150, 220, 255, ${0.8 * alpha})`;
      ctx.stroke();

      if (t < 0.4) {
        ctx.beginPath();
        ctx.arc(px, py, s * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${(1 - t / 0.4) * 0.7})`;
        ctx.fill();
      }
    }
  },

  // The live shift-drag marquee rectangle — see Input's `selecting` state.
  // Drawn last, in raw device-pixel canvas space (Input tracks it in
  // CSS-pixel client coordinates, same space as every other pointer handler,
  // so it's scaled up by dpr here rather than everywhere it's touched).
  drawSelectionBox() {
    const sel = Input.selecting;
    if (!sel || !sel.active) return;
    const ctx = this.ctx, d = this.dpr;
    const x0 = Math.min(sel.x0, sel.x1) * d, y0 = Math.min(sel.y0, sel.y1) * d;
    const x1 = Math.max(sel.x0, sel.x1) * d, y1 = Math.max(sel.y0, sel.y1) * d;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(130, 215, 255, 0.12)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = 'rgba(130, 215, 255, 0.8)';
    ctx.lineWidth = Math.max(1, d);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  },

  // "+gold" labels that drift up and fade out over each city a train just
  // paid — Game.stepTrains/stepTradeShips record these through Fx.goldPopup
  // for every owner alike, and this is where they become the local player's
  // view of them: the ownerId filter below is the only thing that decides
  // whose money the viewer watches tick up (a payout at a foreign or allied
  // city is not theirs to see). Ageing is on the render clock too, so nothing
  // about these labels touches the simulation. Same warm-gold palette as the
  // level badge in drawStructures so a payout reads as the same kind of "you
  // got richer" as leveling up.
  drawGoldPopups() {
    const now = Game.renderElapsed;
    Fx.prune(now);
    if (!Fx.goldPopups.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const life = Fx.GOLD_POPUP_LIFETIME;
    const fog = this.fogged;

    for (const g of Fx.goldPopups) {
      if (g.ownerId !== Game.me) continue;
      // Fog: the viewer's money, but paid over a port they may not have found.
      if (fog && this.fogHides(g.tile)) continue;
      const tx = g.tile % w, ty = (g.tile / w) | 0;
      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -60 || py < -60 || px > cw + 60 || py > ch + 60) continue;

      const frac = Math.max(0, Math.min(1, (now - g.born) / life));
      const rise = frac * 22 * this.dpr;
      const alpha = 1 - frac;

      const font = Math.max(11 * this.dpr, Math.min(18 * this.dpr, s * 1.4));
      ctx.font = '700 ' + font.toFixed(1) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2.5, font * 0.3);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(0, 0, 0, ${(alpha * 0.85).toFixed(3)})`;
      ctx.fillStyle = `rgba(255, 233, 168, ${alpha.toFixed(3)})`;
      // Rounded to the nearest thousand rather than formatGold's exact
      // decimal ("10.0k") — a popup is a quick flash, not a ledger entry, so
      // it reads as a clean "+10k" the same way trainGold's own values
      // (multiples of 5000) round with zero remainder.
      const k = Math.round(g.amount / 1000);
      const text = '+' + (k > 0 ? k + 'k' : g.amount);
      const ly = py - font * 1.1 - rise;
      ctx.strokeText(text, px, ly);
      ctx.fillText(text, px, ly);
    }
  },

  // "+gold" pop-up over a nation, tribe or player the viewer just finished
  // off. Same viewer-only filter and render-clock ageing as drawGoldPopups;
  // larger, with a brief pop-in, and held fully visible for the first part of
  // its life before fading so it's readable.
  drawKillPopups() {
    const now = Game.renderElapsed;
    Fx.pruneKills(now);
    if (!Fx.killPopups.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const life = Fx.KILL_POPUP_LIFETIME;
    const fog = this.fogged;

    for (const g of Fx.killPopups) {
      if (g.ownerId !== Game.me) continue;
      if (fog && this.fogHides(g.tile)) continue;
      const tx = g.tile % w, ty = (g.tile / w) | 0;
      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -80 || py < -80 || px > cw + 80 || py > ch + 80) continue;

      const frac = Math.max(0, Math.min(1, (now - g.born) / life));
      const alpha = frac < 0.6 ? 1 : 1 - (frac - 0.6) / 0.4;
      const pop = frac < 0.12 ? 0.6 + 0.4 * (frac / 0.12) : 1;
      const rise = frac * 30 * this.dpr;

      const font = 22 * this.dpr * pop;
      ctx.font = '800 ' + font.toFixed(1) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(3, font * 0.25);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(0, 0, 0, ${(alpha * 0.9).toFixed(3)})`;
      ctx.fillStyle = `rgba(255, 214, 90, ${alpha.toFixed(3)})`;
      const text = '+' + formatGold(g.amount);
      const ly = py - rise;
      ctx.strokeText(text, px, ly);
      ctx.fillText(text, px, ly);
    }
  },

  // Opens a label sweep: snapshots who is worth labelling and clears the
  // shared `seen` buffer once for the whole sweep. Clearing once here rather
  // than per nation is exactly what the old single-pass version did and is
  // still correct, because a nation's flood fill below only ever expands into
  // its OWN tiles — two nations can never mark the same tile, so one nation's
  // marks can't leak into another's walk later in the same sweep.
  beginLabelSweep() {
    const size = GameMap.owner.length;
    if (!this.seenBuf || this.seenBuf.length !== size) {
      this.seenBuf = new Uint8Array(size);
      this.queueBuf = new Int32Array(size);
    }
    this.seenBuf.fill(0);
    this.labelQueue = [];
    for (const p of Game.players) {
      if (p.alive && p.tiles.size > 0) this.labelQueue.push(p.id);
    }
    this.labelsPending = [];
    this.labelSweeping = true;
  },

  // Anchors ONE nation's label in its largest contiguous landmass, and is the
  // unit of work a sweep is sliced into — see drawLabels for the pacing.
  //
  // Walking every nation in a single call (what this used to do) meant flood-
  // filling every owned tile on the map in one frame: measured at 32ms on an
  // Extra Large map mid-match, fired 3.3x a second, which is a dropped frame
  // every time and was the single largest source of client-side hitching.
  // The work per sweep is unchanged — it is just spread a nation per frame,
  // so the same rebuild costs ~1.3ms a frame instead of 32ms in one.
  computeLabelSlice(playerId) {
    const w = GameMap.width, owner = GameMap.owner;
    const seen = this.seenBuf, queue = this.queueBuf;
    const nb = this.labelNb || (this.labelNb = new Int32Array(4));
    const labels = this.labelsPending;

    {
      const p = Game.players[playerId];
      if (!p || !p.alive || p.tiles.size === 0) return;
      let best = null;

      for (const start of p.tiles) {
        if (seen[start]) continue;
        let head = 0, tail = 0, sx = 0, sy = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        queue[tail++] = start; seen[start] = 1;
        while (head < tail) {
          const i = queue[head++];
          const x = i % w, y = (i / w) | 0;
          sx += x; sy += y;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          const n = GameMap.neighbors(i, nb);
          for (let k = 0; k < n; k++) {
            const j = nb[k];
            if (owner[j] === p.id && !seen[j]) { seen[j] = 1; queue[tail++] = j; }
          }
        }
        if (!best || tail > best.count) {
          best = { count: tail, cx: sx / tail, cy: sy / tail,
                   bw: maxX - minX + 1, bh: maxY - minY + 1 };
        }
      }
      if (!best) return;

      // The centroid of a concave or horseshoe-shaped nation can sit on enemy
      // land or open sea, so snap the anchor to the nearest tile the nation
      // actually owns. Re-running the fill keeps `queue` holding that component.
      let ax = Math.round(best.cx), ay = Math.round(best.cy);
      const centreIdx = GameMap.idx(Math.max(0, Math.min(w - 1, ax)), Math.max(0, Math.min(GameMap.height - 1, ay)));
      if (owner[centreIdx] !== p.id) {
        let bestD = Infinity;
        for (const i of p.tiles) {
          const x = i % w, y = (i / w) | 0;
          const d = (x - best.cx) * (x - best.cx) + (y - best.cy) * (y - best.cy);
          if (d < bestD) { bestD = d; ax = x; ay = y; }
        }
      }
      labels.push({ id: p.id, x: ax, y: ay, count: best.count, bw: best.bw, bh: best.bh });
    }
  },

  // Advances the label sweep by exactly one nation per frame, starting a fresh
  // sweep once LABEL_INTERVAL has passed since the last one BEGAN. The visible
  // set only swaps in when a sweep finishes, so labels never render half-built
  // — they are at most one sweep stale, which is what the old timer already
  // gave them.
  stepLabels() {
    const now = performance.now();
    if (!this.labelSweeping) {
      if (now - this.labelsAt <= this.LABEL_INTERVAL) return;
      this.labelsAt = now;
      this.beginLabelSweep();
    }
    if (this.labelQueue.length > 0) this.computeLabelSlice(this.labelQueue.pop());
    if (this.labelQueue.length === 0) {
      this.labels = this.labelsPending;
      this.labelSweeping = false;
    }
  },

  // --- Label sprites -----------------------------------------------------------
  // Each nation's label (icons, name, troop count) is rasterised once into its
  // own small canvas and stamped with drawImage every frame, instead of being
  // re-lettered with strokeText/fillText every frame. On the World map several
  // hundred labels come on screen together early in a match, and outlined canvas
  // text is slow, especially in Safari: that was the frame-rate drop players saw
  // "as soon as the names appear". A sprite is redrawn only when what it shows
  // changes (troop text, icons, name) or its whole-pixel font size does, and at
  // most LABEL_REDRAW_MAX sprites / LABEL_REDRAW_MS of that work happens per
  // frame, oldest sprite first; the rest keep showing their previous image
  // (scaled to the right size) for a frame or two.
  //
  // The count cap matters as much as the time budget: the first stamp of a
  // just-redrawn sprite pays to hand the changed bitmap to the GPU (~0.5ms each
  // in Chromium at 2x DPR, several times the redraw itself), and that cost lands
  // in drawImage, outside the time budget. Troop counts change every tick and a
  // growing nation's font creeps up a pixel at a time, so troop and size
  // changes wait LABEL_REFRESH_MS since that sprite was last drawn; a new
  // label, a renamed one or an icon change goes straight into the queue.
  // See docs/perf-label-rendering.md.
  LABEL_REDRAW_MS: 2,
  LABEL_REDRAW_MIN: 2,        // always make at least this much progress per frame
  LABEL_REDRAW_MAX: 8,
  LABEL_REFRESH_MS: 500,
  LABEL_UPSCALE_MAX: 1.1,     // stretch an old sprite at most this much before redrawing it
  LABEL_ICON_BITS: [['target', 1], ['teammate', 2], ['ally', 4], ['traitor', 8], ['embargo', 16]],
  labelSprites: new Map(),    // player id -> sprite (see labelSprite)
  labelFrame: 0,
  labelDrawList: [],
  labelStaleList: [],

  labelSprite(id) {
    let sp = this.labelSprites.get(id);
    if (!sp) {
      sp = { canvas: null, w: 0, h: 0, ox: 0, oy: 0, font: 0, name: null, troops: null, icons: 0,
             nameEm: 0, troopsEm: 0, measuredName: null, measuredTroops: null,
             drawnAt: -1, drawnMs: -Infinity, usedAt: 0, px: 0, py: 0, want: 0, wantIcons: 0, wantTroops: '', wantName: '',
             bmp: null, bmpW: 0, bmpH: 0, bmpOx: 0, bmpOy: 0, bmpFont: 0, bmpGen: 0, bmpFresh: false };
      this.labelSprites.set(id, sp);
    }
    return sp;
  },

  // Width of `text` in ems at the label's name weight, from one context whose
  // font is set once — measuring never touches the main canvas's font state.
  labelEm(text) {
    if (!this.measureCtx) {
      this.measureCtx = document.createElement('canvas').getContext('2d');
      this.measureCtx.font = '600 100px system-ui, sans-serif';
    }
    return this.measureCtx.measureText(text).width / 100;
  },

  // Rasterises `sp` at its wanted whole-pixel font. Layout matches what
  // drawLabels used to letter directly onto the map: icons then the name on
  // one line, the troop count centred under it, both outlined in black.
  renderLabelSprite(sp, now) {
    const font = sp.want, icons = sp.wantIcons;
    let nIcons = 0;
    for (const [, bit] of this.LABEL_ICON_BITS) if (icons & bit) nIcons++;
    const iconStep = 1.3;                        // icon (1.05em) + gap (0.25em), in ems
    // Measured at the real size: small text renders wider than its 100px
    // em-width scales to (hinting), which clipped the end of longer names.
    this.labelEm('');
    const mc = this.measureCtx;
    mc.font = '600 ' + font + 'px system-ui, sans-serif';
    const nameW = mc.measureText(sp.wantName).width + nIcons * iconStep * font;
    mc.font = font + 'px system-ui, sans-serif';
    const troopsW = mc.measureText(sp.wantTroops).width;
    mc.font = '600 100px system-ui, sans-serif';
    const pad = Math.ceil(font * 0.15 + 2);
    const w = Math.ceil(Math.max(nameW, troopsW)) + pad * 2;
    const h = Math.ceil(font * 2.6) + pad * 2;

    let c = sp.canvas;
    if (!c) c = sp.canvas = document.createElement('canvas');
    if (c.width < w || c.height < h) {
      c.width = Math.max(c.width, Math.ceil(w * 1.2));
      c.height = Math.max(c.height, h);
    }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);

    const cx = w / 2, cy = pad + font * 1.3;
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(2, font * 0.2);
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.fillStyle = '#ffffff';

    const nameY = cy - font * 0.55;
    let x = cx - nameW / 2;
    let missingIcon = false;
    const iconSize = font * 1.05;
    for (const [name, bit] of this.LABEL_ICON_BITS) {
      if (!(icons & bit)) continue;
      const img = this.icon(name, iconSize);
      if (img) g.drawImage(img, Math.round(x), Math.round(nameY - img.height / 2));
      else missingIcon = true;
      x += iconStep * font;
    }
    g.font = '600 ' + font + 'px system-ui, sans-serif';
    g.textAlign = 'left';
    g.strokeText(sp.wantName, x, nameY);
    g.fillText(sp.wantName, x, nameY);

    g.font = font + 'px system-ui, sans-serif';
    g.textAlign = 'center';
    g.strokeText(sp.wantTroops, cx, cy + font * 0.6);
    g.fillText(sp.wantTroops, cx, cy + font * 0.6);

    sp.w = w; sp.h = h; sp.ox = cx; sp.oy = cy;
    sp.font = font;
    sp.name = sp.wantName;
    sp.troops = sp.wantTroops;
    // An icon whose SVG hasn't loaded yet leaves the sprite marked stale, so it
    // is redrawn once the image arrives.
    sp.icons = missingIcon ? -1 : icons;
    sp.drawnAt = this.labelFrame;
    sp.drawnMs = now;
    this.snapshotLabelSprite(sp);
  },

  // Firefox copies a canvas to its GPU process on every drawImage from it,
  // changed or not, which with a few hundred labels on screen was ~2ms a
  // frame of copying (2026-09-28 profile). An ImageBitmap is immutable, so it
  // is uploaded once and reused; stamp that, and keep stamping the previous
  // bitmap (with its own size) until the new one resolves.
  snapshotLabelSprite(sp) {
    if (this.labelNoBitmap) return;
    const gen = ++sp.bmpGen;
    sp.bmpFresh = false;
    const w = sp.w, h = sp.h, ox = sp.ox, oy = sp.oy, font = sp.font;
    let req;
    try {
      req = createImageBitmap(sp.canvas, 0, 0, w, h);
    } catch (e) {
      this.labelNoBitmap = true;
      return;
    }
    req.then(bmp => {
      if (sp.bmpGen !== gen || sp.dead) { bmp.close(); return; }
      if (sp.bmp) sp.bmp.close();
      sp.bmp = bmp;
      sp.bmpW = w; sp.bmpH = h; sp.bmpOx = ox; sp.bmpOy = oy; sp.bmpFont = font;
      sp.bmpFresh = true;
    }, () => { this.labelNoBitmap = true; });
  },

  dropLabelSprite(id, sp) {
    sp.dead = true;
    if (sp.bmp) { sp.bmp.close(); sp.bmp = null; }
    this.labelSprites.delete(id);
  },

  drawLabels() {
    this.stepLabels();
    const frame = ++this.labelFrame;
    const now = performance.now();

    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    const draws = this.labelDrawList, stale = this.labelStaleList;
    draws.length = 0;
    stale.length = 0;

    const meP = Game.players[Game.me];
    const marked = meP ? Game.transitiveTargets(meP) : null;
    const fog = this.fogged;
    for (const L of this.labels) {
      const p = Game.players[L.id];
      L.font = 0;                        // 0 = no name drawn; drawDiploBadges reads it
      if (!p || p.tiles.size === 0) continue;

      const px = (L.x + 0.5 - this.cam.x) * s + cw / 2;
      const py = (L.y + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -80 || py < -80 || px > cw + 80 || py > ch + 80) continue;
      // Fog: a nation is named only where its label sits, the middle of its
      // largest landmass. Land of it seen at the edge of the fog goes unnamed
      // until that is discovered; moving the label to the visible part would
      // put a size-scaled name on a sliver.
      if (fog && this.fogHides(L.y * GameMap.width + L.x)) continue;

      // Size against the blob's real on-screen box and the measured text, not
      // sqrt(area) — a long thin nation has plenty of tiles but no room to
      // letter, and would otherwise spill its name across a neighbour.
      const boxW = L.bw * s, boxH = L.bh * s;
      const areaSpan = Math.sqrt(L.count) * s;
      const minFont = 9 * this.dpr;
      let font = Math.min(22 * this.dpr, areaSpan * 0.24, boxH * 0.30);
      if (font < minFont) continue;

      // Troops at home — the same figure the bar shows, and the one that
      // actually defends, so a nation that has emptied itself reads as soft.
      const troops = formatCountTight(p.troops);
      // Diplomacy is legible straight off the map: who you have a pact with,
      // and who has just broken one and is worth attacking while it lasts.
      // Icons (see icon()) sit in front of the name, in this order:
      //   target    marked as a target by us or an ally (ticket #30)
      //   teammate  on our team (issue #31) — permanent, unlike an alliance
      //   ally      allied with us
      //   traitor   recently broke a pact
      //   embargo   trade with us is blocked, by either side's embargo
      const noTrade = !p.isTribe && Game.me >= 0 && p.id !== Game.me && !Game.canTrade(Game.me, p.id);
      let icons = 0, nIcons = 0;
      if (marked && marked.has(p.id)) { icons |= 1; nIcons++; }
      if (Game.onSameTeam(Game.me, p.id)) { icons |= 2; nIcons++; }
      else if (Game.areAllied(Game.me, p.id)) { icons |= 4; nIcons++; }
      if (Game.isTraitor(p)) { icons |= 8; nIcons++; }
      if (noTrade) { icons |= 16; nIcons++; }

      const sp = this.labelSprite(p.id);
      if (sp.measuredName !== p.name) { sp.measuredName = p.name; sp.nameEm = this.labelEm(p.name); }
      if (sp.measuredTroops !== troops) { sp.measuredTroops = troops; sp.troopsEm = this.labelEm(troops); }

      // Icons scale with the font, so the whole name line does too and the
      // shrink-to-fit below stays a single proportional step.
      const nameW = (sp.nameEm + nIcons * 1.3) * font;   // icon (1.05em) + gap (0.25em), in ems
      const widest = Math.max(nameW, sp.troopsEm * font);
      if (widest > boxW * 0.92) {
        font *= boxW * 0.92 / widest;         // shrink to fit rather than overflow
        if (font < minFont) continue;
      }
      // Whole device pixels, so a settled sprite is stamped 1:1 and stays crisp.
      font = Math.round(font);

      sp.want = font;
      sp.wantIcons = icons;
      sp.wantTroops = troops;
      sp.wantName = p.name;
      sp.px = px;
      sp.py = py;
      sp.usedAt = frame;
      draws.push(sp);
      // A size or troop change can wait for the refresh interval: in the
      // meantime the old sprite is stamped scaled to the new size, which is all
      // a nation growing a pixel needs. Growing past LABEL_UPSCALE_MAX (zooming
      // in) can't wait: an upscaled sprite is visibly blurry.
      if (!sp.canvas || sp.icons !== icons || sp.name !== p.name || font > sp.font * this.LABEL_UPSCALE_MAX ||
          ((sp.font !== font || sp.troops !== troops) && now - sp.drawnMs >= this.LABEL_REFRESH_MS)) stale.push(sp);
      L.font = font;
    }

    // Redraw what changed, longest-stale first (never-drawn sprites sort ahead
    // of everything), until this frame's budget runs out.
    if (stale.length) {
      stale.sort((a, b) => a.drawnAt - b.drawnAt);
      const until = now + this.LABEL_REDRAW_MS;
      const n = Math.min(stale.length, this.LABEL_REDRAW_MAX);
      for (let k = 0; k < n; k++) {
        if (k >= this.LABEL_REDRAW_MIN && performance.now() > until) break;
        this.renderLabelSprite(stale[k], now);
      }
    }

    // A sprite still waiting its turn is shown at its old size scaled to the
    // new one; smoothing is switched off for the tile blit, so turn it back on.
    ctx.imageSmoothingEnabled = true;
    for (const sp of draws) {
      if (!sp.canvas) continue;
      // Until the latest redraw's bitmap arrives, stamp the canvas itself (one
      // copy, this frame only) rather than the previous, now stale bitmap.
      if (sp.bmp && sp.bmpFresh) {
        const k = sp.want / sp.bmpFont, w = sp.bmpW, h = sp.bmpH, ox = sp.bmpOx, oy = sp.bmpOy;
        if (k === 1) ctx.drawImage(sp.bmp, Math.round(sp.px - ox), Math.round(sp.py - oy));
        else ctx.drawImage(sp.bmp, 0, 0, w, h, sp.px - ox * k, sp.py - oy * k, w * k, h * k);
        continue;
      }
      const k = sp.want / sp.font;
      if (k === 1) {
        ctx.drawImage(sp.canvas, 0, 0, sp.w, sp.h, Math.round(sp.px - sp.ox), Math.round(sp.py - sp.oy), sp.w, sp.h);
      } else {
        ctx.drawImage(sp.canvas, 0, 0, sp.w, sp.h, sp.px - sp.ox * k, sp.py - sp.oy * k, sp.w * k, sp.h * k);
      }
    }

    // Drop sprites for nations that haven't been on screen for a while (dead,
    // or panned away), so the cache tracks what is actually being looked at.
    if (frame % 300 === 0) {
      for (const [id, sp] of this.labelSprites) {
        if (frame - sp.usedAt > 600) this.dropLabelSprite(id, sp);
      }
    }
  },

  // Seconds before an alliance ends at which its badge appears. Earlier than
  // this the renewal banner (Game.ALLIANCE_EXTEND_WINDOW) is the only prompt.
  ALLIANCE_EXPIRY_BADGE: 15,

  // Pulsing badges above the nations you have a diplomatic decision pending
  // with, so they can be spotted on the map and not just in the banner:
  //   gold, ally icon       a nation is offering YOU peace; the ring drains over the offer's 20s
  //   orange, expiring icon an alliance of yours ends within ALLIANCE_EXPIRY_BADGE seconds and
  //                         you have not yet agreed to renew it; the ring drains over that span
  // Screen-space sized, so they stay readable zoomed out; each sits above the
  // nation's name when one is drawn.
  drawDiploBadges() {
    if (Game.me < 0) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr, dpr = this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;

    const badges = [];
    for (const req of Game.requests) {
      if (req.to !== Game.me) continue;
      badges.push({
        id: req.from, icon: 'ally', color: '#ffd65a', halo: '255,214,90',
        left: (Game.ALLIANCE_REQUEST_DURATION - (Game.elapsed - req.createdAt)) / Game.ALLIANCE_REQUEST_DURATION
      });
    }
    for (const al of Game.alliances) {
      if (al.a !== Game.me && al.b !== Game.me) continue;
      const remaining = al.expiresAt - Game.elapsed;
      if (remaining > this.ALLIANCE_EXPIRY_BADGE || Game.agreedToExtend(al, Game.me)) continue;
      badges.push({
        id: al.a === Game.me ? al.b : al.a, icon: 'expiring', color: '#ff8a4c', halo: '255,138,76',
        left: remaining / this.ALLIANCE_EXPIRY_BADGE
      });
    }

    for (const b of badges) {
      const L = this.labels.find(l => l.id === b.id);
      if (!L) continue;

      const px = (L.x + 0.5 - this.cam.x) * s + cw / 2;
      const py = (L.y + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -60 || py < -60 || px > cw + 60 || py > ch + 60) continue;
      // Fog: a request can come from a nation the viewer has not found (it
      // reaches them as "Unknown nation"); a badge would point straight at it.
      if (this.fogged && this.fogHides(L.y * GameMap.width + L.x)) continue;

      const r = 18 * dpr;
      const cy = py - (L.font ? L.font * 1.25 : 0) - r - 4 * dpr;
      const left = Math.max(0, Math.min(1, b.left));
      const pulse = 0.5 + 0.5 * Math.sin(Game.renderElapsed * 6);

      ctx.save();
      // Soft halo that breathes, then the badge itself.
      ctx.beginPath();
      ctx.arc(px, cy, r + (3 + 4 * pulse) * dpr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + b.halo + ',' + (0.18 + 0.22 * pulse).toFixed(3) + ')';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(px, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,24,36,0.9)';
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.stroke();

      // Time-remaining arc, clockwise from 12 o'clock.
      ctx.beginPath();
      ctx.arc(px, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      ctx.strokeStyle = b.color;
      ctx.lineCap = 'round';
      ctx.stroke();

      const img = this.icon(b.icon, r * 1.15);
      if (img) ctx.drawImage(img, Math.round(px - img.width / 2), Math.round(cy - img.height / 2));
      ctx.restore();
    }
  }
};
