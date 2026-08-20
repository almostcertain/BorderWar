const Input = {
  pointers: new Map(),
  lastPinch: 0,
  moved: 0,
  downAt: 0,
  holdTimer: null,

  // OpenFront's LONG_PRESS_MS. Long enough not to fire while you are settling
  // into a drag, short enough that it does not feel like the game ignored you.
  LONG_PRESS_MS: 800,

  setup(canvas) {
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointermove', e => this.onHover(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.onUp(e));
    canvas.addEventListener('pointerleave', e => this.onHover(e));
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => {
      e.preventDefault();
      this.openMenu(e.clientX, e.clientY);
    });
  },

  // Desktop-only nation inspector: a mouse resting over any owned land — your
  // own included — shows that nation's stats at the top of the screen. Touch
  // reports pointermove only while a finger is down, which onMove already
  // spends on panning, so gating on pointerType keeps the two from fighting
  // over the same event.
  onHover(e) {
    // With a build armed the cursor is a placement cursor, so it tracks the tile
    // for the ghost instead of inspecting whoever owns it. Preferring a nearby
    // same-type structure over the exact tile under the cursor keeps the
    // ghost/hint preview honest about what a tap will actually do — see
    // UI.onTap, which resolves upgrades through the same buffered search.
    if (UI.placing && e.pointerType === 'mouse') {
      if (e.type === 'pointerleave') {
        UI.placeHover = -1;
      } else {
        const near = Render.findStructureNear(e.clientX, e.clientY, UI.placing);
        if (near) {
          UI.placeHover = near.tile;
        } else {
          const railSnap = UI.placing === 'city' ? Render.findRailSnapTile(e.clientX, e.clientY) : -1;
          const coastSnap = UI.placing === 'port'
            ? Game.nearestOwnedCoastNear(Game.me, Render.screenToTile(e.clientX, e.clientY), Game.PORT_SNAP_MAX_DIST) : -1;
          UI.placeHover = railSnap >= 0 ? railSnap : coastSnap >= 0 ? coastSnap : Render.screenToTile(e.clientX, e.clientY);
        }
      }
      UI.hideHoverPanel();
      return;
    }
    if (e.pointerType !== 'mouse' || e.buttons !== 0 || e.type === 'pointerleave' ||
        !Game.running || Radial.isOpen()) {
      UI.hideHoverPanel();
      return;
    }
    const tile = Render.screenToTile(e.clientX, e.clientY);
    if (tile < 0) { UI.hideHoverPanel(); return; }
    const owner = GameMap.owner[tile];
    if (owner < 0) { UI.hideHoverPanel(); return; }
    UI.hoverTile = tile;
    UI.showHoverPanel(owner);
  },

  // Only the primary button commits troops. Touch and pen both report button 0,
  // so this costs them nothing while keeping right- and middle-click off the
  // attack path entirely.
  //
  // Leaning on `!Radial.isOpen()` to suppress the right-click's tap was the bug:
  // it only holds when the menu actually opened, and openMenu declines on empty
  // ground, your own land, open sea, and inside the radial's 300ms reopen
  // cooldown. In every one of those cases the right-button pointerup fell
  // straight through to UI.onTap and launched an attack — most visibly as
  // right-clicking unclaimed land expanding into it. Reading the button settles
  // it at the source, whatever the menu does and whatever order the browser
  // fires contextmenu in.
  isPrimary(e) { return e.button === 0; },

  onDown(e) {
    this.canvas = e.currentTarget;
    // Capture is best-effort: a pointer that has already gone away (fired in
    // practice by synthetic/replayed events, and reportedly by some browsers on
    // a fast tap) throws NotFoundError. Losing capture only means a drag that
    // leaves the canvas stops updating; it must not also skip the state setup
    // below, or this pointer's eventual pointerup finds nothing in `pointers`
    // and silently drops the tap.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    // The button is recorded per pointer rather than on `this`, so a second
    // finger landing cannot rewrite what the first one was.
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, primary: this.isPrimary(e) });
    if (this.pointers.size === 1) {
      this.moved = 0;
      this.downAt = performance.now();
      this.clearHold();
      // Touch has no right button, so holding is how the menu is reached there.
      // The tap handler's own 400ms ceiling means a press this long can never
      // also be read as an attack. A held right button is skipped because
      // contextmenu has already opened the menu — arming it too would fire
      // openMenu a second time and fight the reopen cooldown.
      if (this.isPrimary(e)) {
        const x = e.clientX, y = e.clientY;
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          this.openMenu(x, y);
        }, this.LONG_PRESS_MS);
      }
    }
    if (this.pointers.size === 2) { this.clearHold(); this.lastPinch = this.pinchDistance(); }
  },

  onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (this.pointers.size === 1) {
      this.moved += Math.abs(dx) + Math.abs(dy);
      // Same 12px tolerance the tap test uses, so a hold and a tap agree on
      // what counts as having stayed still.
      if (this.moved >= 12) this.clearHold();
      Render.cam.x -= dx / Render.cam.scale;
      Render.cam.y -= dy / Render.cam.scale;
    } else if (this.pointers.size === 2) {
      const d = this.pinchDistance();
      if (this.lastPinch > 0) Render.cam.scale *= d / this.lastPinch;
      this.lastPinch = d;
      this.moved += 20;
    }
  },

  onUp(e) {
    const wasSingle = this.pointers.size === 1;
    // Read before the delete: whether this press may become a tap depends on the
    // button it started with, not on whichever button happens to be releasing.
    const p = this.pointers.get(e.pointerId);
    const wasPrimary = !!p && p.primary;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.lastPinch = 0;
    this.clearHold();

    if (wasSingle && wasPrimary && !Radial.isOpen() && this.moved < 12 &&
        performance.now() - this.downAt < 400) {
      UI.onTap(e.clientX, e.clientY);
    }
  },

  clearHold() {
    if (this.holdTimer !== null) { clearTimeout(this.holdTimer); this.holdTimer = null; }
  },

  // Anything but your own land has something to offer: another nation gets
  // the full diplomacy menu, neutral land and open water still get the Boat
  // slot (a right-click on the ocean targets the nearest unclaimed shore near
  // it, same as OpenFront).
  openMenu(sx, sy) {
    if (!Game.running) return;
    const tile = Render.screenToTile(sx, sy);
    if (tile < 0) return;
    const owner = GameMap.owner[tile];
    if (owner === Game.me) return;
    Radial.open(sx, sy, owner, tile);
  },

  onWheel(e) {
    e.preventDefault();
    Render.cam.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
  },

  pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
};
