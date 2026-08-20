const Render = {
  canvas: null,
  ctx: null,
  tileCanvas: null,
  tileCtx: null,
  image: null,
  pixels: null,
  terrain: null,     // Uint32Array of base water/land colours
  fillColor: null,   // per-player packed colour
  borderColor: null,
  cam: { x: 0, y: 0, scale: 3 },

  labels: [],
  labelsAt: 0,
  LABEL_INTERVAL: 300,   // ms; flood-filling every frame would be wasteful

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
  },

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

    // Unclaimed ground, one tone per terrain: grassy plains, dun highland,
    // bare grey mountain.
    const water = this.packed(18, 34, 60);
    const bare = [this.packed(78, 94, 72), this.packed(104, 96, 66), this.packed(122, 120, 114)];
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
  },

  // Rebuilds the hover overlay for whichever nation UI.hoverId names. Only
  // called when that changes or the map's ownership does (draw() passes
  // territoryChanged through) — not every frame, so resting the mouse over a
  // huge nation costs one Set walk on the change, not one every 16ms.
  buildHoverOverlay(id) {
    const px = this.hoverPixels;
    px.fill(0);
    const p = Game.players[id];
    if (!p) { this.hoverCtx.putImageData(this.hoverImage, 0, 0); return; }

    // If the tile actually under the cursor sits in a patch of this nation's
    // land that's fully walled in by ours, tint just that patch gold instead
    // of the plain whole-nation wash — a visible "tap to annex free" cue
    // ahead of the click, and distinct from hovering their untouched
    // mainland (same nation, same id, not enclosed) which still gets the
    // ordinary tint below.
    const region = id !== Game.me ? Game.enclosedRegion(UI.hoverTile, Game.me) : null;
    if (region) {
      const c = this.packed(255, 215, 60, 130);
      for (const t of region) px[t] = c;
    } else {
      // Low alpha, plain white: brightens whatever colour is already there
      // rather than imposing one of its own, so it reads the same over a
      // vivid Nation and a muted Tribe alike.
      const c = this.packed(255, 255, 255, 60);
      for (const t of p.tiles) px[t] = c;
    }
    this.hoverCtx.putImageData(this.hoverImage, 0, 0);
  },

  drawHoverHighlight(territoryChanged, ctx) {
    const id = UI.hoverId;
    if (id < 0) { this.hoverBuiltFor = -1; return; }
    const now = performance.now();
    const tileMoved = UI.hoverTile !== this.hoverBuiltForTile;
    // Territory changes and nation switches rebuild immediately — only a
    // same-nation tile move (the expensive enclosure recheck) is throttled.
    if (id !== this.hoverBuiltFor || territoryChanged ||
        (tileMoved && now - this.hoverAnnexAt > this.ANNEX_HOVER_INTERVAL)) {
      this.buildHoverOverlay(id);
      this.hoverBuiltFor = id;
      this.hoverBuiltForTile = UI.hoverTile;
      this.hoverAnnexAt = now;
    }
    ctx.drawImage(this.hoverCanvas, -this.cam.x, -this.cam.y);
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
    if (o < 0) { px[i] = this.terrain[i]; return; }
    const edge =
      (x > 0 && owner[i - 1] !== o) ||
      (x < w - 1 && owner[i + 1] !== o) ||
      (y > 0 && owner[i - w] !== o) ||
      (y < h - 1 && owner[i + w] !== o);
    px[i] = edge ? this.borderColor[o] : this.fillColor[o][GameMap.terrain[i]];
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
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (const i of dirtyTiles) {
      const x = i % w, y = (i / w) | 0;
      this.paintTile(i, x, y, w, h, owner, px);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0) return;
    this.tileCtx.putImageData(this.image, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
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

  draw() {
    // Captured before the rebuild below consumes the flags, so the hover
    // overlay knows whether ownership moved this frame too.
    const territoryChanged = Game.dirty || Game.dirtyTiles.size > 0;
    if (Game.dirty) {
      this.buildTiles();
      Game.dirty = false;
      Game.dirtyTiles.clear();
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
    ctx.drawImage(this.tileCanvas, -this.cam.x, -this.cam.y);
    this.drawHoverHighlight(territoryChanged, ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    this.drawRailroads();
    this.drawStructures();
    this.drawPlacement();
    this.drawLabels();
    this.drawFronts();
    this.drawBoats();
    this.drawTrains();
    this.drawTradeShips();
    this.drawWarships();
    this.drawGoldPopups();
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

    ctx.strokeStyle = 'rgba(210, 190, 150, 0.55)';
    ctx.lineWidth = Math.max(1, this.dpr * 1.1);
    ctx.beginPath();
    for (const r of Game.railroads) {
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

  // Finds the structure of `type` whose drawn disc a tap (in CSS-pixel client
  // coordinates, same space as screenToTile's input) actually falls near — not
  // just the single tile it happens to be anchored to. The disc reads as a
  // big, tappable icon, so a tap anywhere across it (plus a little slop past
  // its own edge) should count as tapping the structure, exactly as it looks
  // like it should. Picks the closest match when discs overlap.
  findStructureNear(sx, sy, type) {
    const r = this.structureRadius();
    const buffer = r * 1.5;
    const w = GameMap.width;
    let best = null, bestDist = Infinity;
    for (const b of Game.buildings.values()) {
      if (b.type !== type) continue;
      const bx = (b.tile % w + 0.5 - this.cam.x) * this.cam.scale + window.innerWidth / 2;
      const by = (((b.tile / w) | 0) + 0.5 - this.cam.y) * this.cam.scale + window.innerHeight / 2;
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
        if (d < bestDist) { bestDist = d; bestTile = GameMap.idx(snapX, snapY); }
      }
    }
    return bestTile;
  },

  drawStructures() {
    if (!Game.buildings.size) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;

    // First pass: draw protection radii for all built forts, behind everything.
    for (const b of Game.buildings.values()) {
      if (b.type !== 'fort' || !b.built) continue;
      const px = (b.tile % w + 0.5 - this.cam.x) * s + cw / 2;
      const py = (((b.tile / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      const owner = GameMap.owner[b.tile];
      const c = owner >= 0 ? Game.players[owner].color : [200, 200, 200];
      const rr = Game.FORT_RANGE * s;
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

    const r = this.structureRadius() * this.dpr;
    ctx.lineWidth = Math.max(1.5, r * 0.18);   // reset per frame; the bar below borrows this ctx
    for (const b of Game.buildings.values()) {
      const px = (b.tile % w + 0.5 - this.cam.x) * s + cw / 2;
      const py = (((b.tile / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;

      const owner = GameMap.owner[b.tile];
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

      const def = Game.unitDef(b.type);
      if (def) {
        // Under construction: the icon sits dimmed so a finished structure
        // still reads as the visually "solid" one at a glance.
        ctx.globalAlpha = b.built ? 1 : 0.45;
        // Hand-drawn glyphs rather than the unit's emoji: colour emoji carry
        // their own built-in colours and ignore fillStyle, so on platforms
        // with a colour emoji font the icon rendered washed out against the
        // disc instead of the solid white this needs to be.
        ctx.fillStyle = '#ffffff';
        if (b.type === 'factory') {
          // A single low, wide block with a smokestack — deliberately
          // squatter than the city's skyline so the two read as different
          // silhouettes even at a glance, not just a different badge.
          const bodyW = r * 0.95, bodyH = r * 0.5;
          const bx = px - bodyW / 2, by = py + r * 0.3 - bodyH;
          ctx.fillRect(bx, by, bodyW, bodyH);
          const stackW = r * 0.16;
          ctx.fillRect(px + bodyW * 0.18, by - r * 0.35, stackW, r * 0.35);
        } else if (b.type === 'fort') {
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
        } else if (b.type === 'port') {
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

      // Level, above the disc — only once there's something to say. A fresh
      // level-1 structure looks identical to the old unleveled ones, so nobody
      // has to parse a permanent "1" on every single city on the map.
      if (b.built && b.level > 1) {
        const badgeFont = Math.max(9 * this.dpr, Math.min(15 * this.dpr, r * 0.6));
        ctx.font = '700 ' + badgeFont.toFixed(1) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, badgeFont * 0.3);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillStyle = '#ffe9a8';
        const ly = py - r - badgeFont * 0.85;
        ctx.strokeText(String(b.level), px, ly);
        ctx.fillText(String(b.level), px, ly);
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

  // Where the armed structure would land. Mouse only — touch has no hover, so
  // there the hint line under the build bar is the whole of the feedback.
  drawPlacement() {
    if (!UI.placing || UI.placeHover < 0) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const tile = UI.placeHover;
    const hoverB = Game.buildings.get(tile);
    // Warship resolution (which Port it launches from, the route it sails)
    // runs a real seaPath per candidate Port — too expensive to redo every
    // animation frame while the mouse just sits still. Cached by hovered
    // tile, same idea render.js's own hoverAnnexAt throttle uses for a
    // different expensive per-frame check.
    const warshipPreview = UI.placing === 'warship' ? this.warshipLaunchPreview(tile) : null;
    // Hovering an existing structure of the same type while armed previews an
    // upgrade instead of a blocked build — same ghost, different legality
    // check, matching what UI.onTap actually does on tap. Warship has no
    // buildings-map entry (and no upgrade) at all — it's always checked
    // against the cached resolution above instead.
    const ok = UI.placing === 'warship'
      ? warshipPreview.ok
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
    // Fort placement: show the 30-tile protection radius while hovering.
    if (UI.placing === 'fort' && !(hoverB && hoverB.type === 'fort')) {
      const cx = px + s / 2, cy = py + s / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Game.FORT_RANGE * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(130, 215, 255, 0.09)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, this.dpr * 1.5);
      ctx.strokeStyle = 'rgba(130, 215, 255, 0.55)';
      ctx.setLineDash([4 * this.dpr, 4 * this.dpr]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Warship placement: a click can land anywhere now (Game.resolveWarship
    // Launch does the snapping), so the ghost shows what will ACTUALLY
    // happen rather than the raw hovered tile — the route it'll sail from
    // whichever owned Port got picked, plus the patrol radius it wanders
    // once it arrives at the (possibly snapped) destination, same dashed-
    // ring language as Fort's protection radius above.
    if (UI.placing === 'warship' && warshipPreview.ok) {
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
        const lx = (t % w + 0.5 - this.cam.x) * s + cw / 2;
        const ly = (((t / w) | 0) + 0.5 - this.cam.y) * s + ch / 2;
        if (!movedRoute) { ctx.moveTo(lx, ly); movedRoute = true; } else ctx.lineTo(lx, ly);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Port joins the rail network exactly like City does (see
    // onStructureCompleted/previewCityConnections) — same preview branch.
    if ((UI.placing === 'factory' || UI.placing === 'city' || UI.placing === 'port') &&
        !(hoverB && hoverB.type === UI.placing)) {
      const lines = UI.placing === 'factory'
        ? Game.previewFactoryConnections(tile)
        : Game.previewCityConnections(tile);

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

  // Live troop counter on every active front, sat on the leading edge.
  // Read live from the attack each frame, so reinforcing a push simply makes
  // the number climb rather than spawning a second marker.
  drawFronts() {
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
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
      const live = a.heapTile.length;
      if (live <= 0) continue;

      // Centroid of the leading edge, sampled so a huge front stays cheap.
      const step = Math.max(1, Math.floor(live / 96));
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < a.heapTile.length; i += step) {
        const t = a.heapTile[i];
        sx += t % w; sy += (t / w) | 0; n++;
      }
      if (!n) continue;

      const px = (sx / n + 0.5 - this.cam.x) * s + cw / 2;
      const py = (sy / n + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -60 || py < -60 || px > cw + 60 || py > ch + 60) continue;

      // Every front reaching this point already involves the player one way
      // or the other: blue for a push they're making, red for one landing on
      // them. A retreating front reads as grey — it's on its way out, not
      // fighting for the ground its number still sits on.
      const colour = a.retreating ? '#9aa4b2' : (a.attacker === Game.me ? '#6db4ff' : '#ff6b6b');

      const font = Math.max(13 * this.dpr, Math.min(19 * this.dpr, s * 1.6));
      ctx.font = '600 ' + font.toFixed(1) + 'px system-ui, sans-serif';
      ctx.lineWidth = Math.max(2.5, font * 0.34);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.fillStyle = colour;
      const text = formatCountTight(a.troops);
      ctx.strokeText(text, px, py);
      ctx.fillText(text, px, py);
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
    // Overall radius on screen, in pixels — slightly larger than the old
    // arrow icon's own [4,10]*dpr clamp — split across BOAT_DOT_RADIUS dots
    // so the whole cluster scales as one shape.
    const size = Math.max(5 * this.dpr, Math.min(13 * this.dpr, s * 1.05));
    const unit = size / this.BOAT_DOT_RADIUS;

    for (const b of Game.boats) {
      const idx = Math.min(b.path.length - 1, Math.floor(b.pos));
      const frac = Math.min(1, b.pos - idx);
      const a = b.path[idx], c = b.path[Math.min(idx + 1, b.path.length - 1)];
      const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;

      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;

      let colour = 'rgba(235,240,250,0.9)';
      if (b.attacker === Game.me) colour = '#6db4ff';
      else if (b.target === Game.me) colour = '#ff6b6b';
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

    for (const ship of Game.tradeShips) {
      const idx = Math.min(ship.path.length - 1, Math.floor(ship.pos));
      const frac = Math.min(1, ship.pos - idx);
      const a = ship.path[idx], c = ship.path[Math.min(idx + 1, ship.path.length - 1)];
      const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
      const tx = ax + (cx - ax) * frac, ty = ay + (cy - ay) * frac;

      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -40 || py < -40 || px > cw + 40 || py > ch + 40) continue;

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
    const r = Math.max(6 * this.dpr, Math.min(16 * this.dpr, s * 0.9));

    if (UI.selectedWarships.size) {
      for (const w of Game.warships) {
        if (!UI.selectedWarships.has(w)) continue;
        const { x: sx, y: sy } = this.warshipClientPos(w);
        const px = sx * this.dpr, py = sy * this.dpr;
        if (px >= -60 && py >= -60 && px <= cw + 60 && py <= ch + 60) {
          ctx.beginPath();
          ctx.arc(px, py, r * 1.8, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = Math.max(1.5, this.dpr * 1.5);
          ctx.setLineDash([3 * this.dpr, 3 * this.dpr]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        const patX = (w.patrolTile % mw + 0.5 - this.cam.x) * s + cw / 2;
        const patY = (((w.patrolTile / mw) | 0) + 0.5 - this.cam.y) * s + ch / 2;
        ctx.beginPath();
        ctx.arc(patX, patY, Game.WARSHIP_PATROL_RANGE * s, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = Math.max(1, this.dpr);
        ctx.setLineDash([5 * this.dpr, 5 * this.dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
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

      // Heading persists across frames where the ship isn't moving (idle,
      // or holding station to fire) rather than snapping back to 0.
      if (a !== c) w._heading = Math.atan2(cy - ay, cx - ax);
      const heading = w._heading || 0;

      const owner = Game.players[w.owner];
      const col = owner ? owner.color : [200, 200, 200];

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(heading);

      const len = r * 1.9, wid = r * 0.85;
      ctx.beginPath();
      ctx.moveTo(len * 0.55, 0);
      ctx.lineTo(len * 0.2, -wid);
      ctx.lineTo(-len * 0.35, -wid);
      ctx.lineTo(-len * 0.55, 0);
      ctx.lineTo(-len * 0.35, wid);
      ctx.lineTo(len * 0.2, wid);
      ctx.closePath();
      ctx.fillStyle = `rgb(${(col[0] * 0.55) | 0}, ${(col[1] * 0.55) | 0}, ${(col[2] * 0.55) | 0})`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${col[0]}, ${col[1]}, ${col[2]})`;
      ctx.lineWidth = Math.max(1.2, r * 0.16);
      ctx.stroke();

      // Turret: a small hollow square amidships, same stroked-not-filled
      // treatment the Port anchor glyph uses in drawStructures.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.strokeRect(-r * 0.22, -r * 0.22, r * 0.44, r * 0.44);
      ctx.restore();

      // Health bar: only once damaged, matching the rest of the HUD's
      // "only surface what's changed from the default" restraint.
      if (w.health < w.maxHealth) {
        const bw = len * 1.1, bh = Math.max(2, r * 0.22);
        const bx = px - bw / 2, by = py - r * 1.5;
        const pct = Math.max(0, w.health / w.maxHealth);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = pct > 0.5 ? '#7ee787' : pct > 0.25 ? '#f0c674' : '#ff6b6b';
        ctx.fillRect(bx, by, bw * pct, bh);
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
  // paid — Game.stepTrains spawns and ages these, this just draws whatever's
  // still alive. Same warm-gold palette as the level badge in drawStructures
  // so a payout reads as the same kind of "you got richer" as leveling up.
  drawGoldPopups() {
    if (!Game.goldPopups.length) return;
    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height, w = GameMap.width;
    const life = Game.GOLD_POPUP_LIFETIME;

    for (const g of Game.goldPopups) {
      const tx = g.tile % w, ty = (g.tile / w) | 0;
      const px = (tx + 0.5 - this.cam.x) * s + cw / 2;
      const py = (ty + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -60 || py < -60 || px > cw + 60 || py > ch + 60) continue;

      const frac = Math.min(1, g.age / life);
      const rise = frac * 22 * this.dpr;
      const alpha = 1 - frac;

      const font = Math.max(11 * this.dpr, Math.min(18 * this.dpr, s * 1.4));
      ctx.font = '700 ' + font.toFixed(1) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2.5, font * 0.3);
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

  // Anchor each nation's label in its largest contiguous landmass. Recomputed
  // on a timer rather than per frame — it is a full flood fill of the map.
  computeLabels() {
    const w = GameMap.width, owner = GameMap.owner;
    const size = owner.length;
    if (!this.seenBuf || this.seenBuf.length !== size) {
      this.seenBuf = new Uint8Array(size);
      this.queueBuf = new Int32Array(size);
    }
    const seen = this.seenBuf, queue = this.queueBuf, nb = new Int32Array(4);
    seen.fill(0);
    const labels = [];

    for (const p of Game.players) {
      if (!p.alive || p.tiles.size === 0) continue;
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
      if (!best) continue;

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
    this.labels = labels;
  },

  drawLabels() {
    const now = performance.now();
    if (now - this.labelsAt > this.LABEL_INTERVAL) { this.computeLabels(); this.labelsAt = now; }

    const ctx = this.ctx, s = this.cam.scale * this.dpr;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const L of this.labels) {
      const p = Game.players[L.id];
      if (!p || p.tiles.size === 0) continue;

      const px = (L.x + 0.5 - this.cam.x) * s + cw / 2;
      const py = (L.y + 0.5 - this.cam.y) * s + ch / 2;
      if (px < -80 || py < -80 || px > cw + 80 || py > ch + 80) continue;

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
      const name = (Game.areAllied(Game.me, p.id) ? '🤝 ' : '') +
                   (Game.isTraitor(p) ? '🗡 ' : '') + p.name;
      ctx.font = '600 ' + font.toFixed(1) + 'px system-ui, sans-serif';
      const widest = Math.max(ctx.measureText(name).width, ctx.measureText(troops).width);
      if (widest > boxW * 0.92) {
        font *= boxW * 0.92 / widest;         // shrink to fit rather than overflow
        if (font < minFont) continue;
      }

      ctx.lineWidth = Math.max(2, font * 0.2);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = '#ffffff';

      ctx.font = '600 ' + font.toFixed(1) + 'px system-ui, sans-serif';
      ctx.strokeText(name, px, py - font * 0.55);
      ctx.fillText(name, px, py - font * 0.55);

      ctx.font = font.toFixed(1) + 'px system-ui, sans-serif';
      ctx.strokeText(troops, px, py + font * 0.6);
      ctx.fillText(troops, px, py + font * 0.6);
    }
  }
};
