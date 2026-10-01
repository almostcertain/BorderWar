const Input = {
  pointers: new Map(),
  lastPinch: 0,
  moved: 0,
  downAt: 0,
  holdTimer: null,
  // Live shift-drag ship box-select, or null when not dragging one — see
  // onDown/onMove/onUp below and Render.drawSelectionBox.
  selecting: null,

  // OpenFront's LONG_PRESS_MS. Long enough not to fire while you are settling
  // into a drag, short enough that it does not feel like the game ignored you.
  LONG_PRESS_MS: 800,

  // WASD pan / up-down arrow zoom, held keys only — see keys below and
  // updateKeyPan(), which main.js's loop() calls once per frame.
  keys: new Set(),
  PAN_SPEED: 600,   // tiles/sec at scale 1, i.e. screen-independent map speed
  ZOOM_SPEED: 1.6,  // multiplier per second

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
      // With a build armed, right-click puts it away instead of opening the menu.
      if (UI.cancelPlacing()) return;
      this.openMenu(e.clientX, e.clientY);
    });
    window.addEventListener('keydown', e => this.onKeyDown(e));
    window.addEventListener('keyup', e => {
      this.keys.delete(e.code);
      if (e.code === 'Space') Render.setAltView(false);
    });
    // A held key stops repeating (and panning) the instant focus leaves the
    // window — alt-tabbing away with W held would otherwise pan forever.
    // Same for Space: the keyup never arrives, so the alt view would stick.
    window.addEventListener('blur', () => { this.keys.clear(); Render.setAltView(false); });
  },

  onKeyDown(e) {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (this.PAN_KEYS.has(e.code)) this.keys.add(e.code);
    // Hold Space for the alternate view (Render.setAltView). preventDefault
    // stops it also clicking whatever button last had focus.
    if (e.code === 'Space' && Game.running) {
      e.preventDefault();
      Render.setAltView(true);
    }
  },

  PAN_KEYS: new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown']),

  // Called once per rendered frame from main.js's loop(). Real wall-clock dt,
  // not the sim tick — panning is a rendering concern and must stay smooth
  // regardless of turn cadence.
  updateKeyPan(dtSeconds) {
    if (this.keys.size === 0) return;
    const panDist = this.PAN_SPEED * dtSeconds / Render.cam.scale;
    if (this.keys.has('KeyA')) Render.cam.x -= panDist;
    if (this.keys.has('KeyD')) Render.cam.x += panDist;
    if (this.keys.has('KeyW')) Render.cam.y -= panDist;
    if (this.keys.has('KeyS')) Render.cam.y += panDist;
    const zoomFactor = Math.pow(this.ZOOM_SPEED, dtSeconds);
    if (this.keys.has('ArrowUp')) Render.cam.scale *= zoomFactor;
    if (this.keys.has('ArrowDown')) Render.cam.scale /= zoomFactor;
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
          // Warship placement has no click-time snap at all — a click can
          // land anywhere on the map (Game.resolveWarshipLaunch snaps it to
          // the nearest open water and picks a launching Port on its own).
          // UI.placeHover just tracks the raw hovered tile, same as any tile
          // that isn't near a rail/coast for city/port.
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
    // A boat's dot floats over open sea, well away from any owned tile, so
    // it's checked first — otherwise hovering one would just fall through
    // to "no owner here" and hide the panel instead of naming who sent it.
    const boat = Render.findBoatNear(e.clientX, e.clientY);
    if (boat) { UI.hoverTile = -1; UI.showHoverPanel(boat.attacker); return; }
    // A scout is the same kind of thing: afloat, away from any owned tile.
    // The panel names whoever owns it only if the viewer has met them
    // (showHoverPanel checks), so an unmet nation's scout shows nothing.
    const scout = Render.findScoutNear(e.clientX, e.clientY);
    if (scout) { UI.hoverTile = -1; UI.showHoverPanel(scout.owner); return; }
    const tile = Render.screenToTile(e.clientX, e.clientY);
    // Fog: an undiscovered tile has no inspector, whoever owns it.
    if (tile < 0 || !Render.canSee(tile)) { UI.hideHoverPanel(); return; }
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
      // Shift held down on the primary button starts a ship (warship and scout)
      // box-select drag instead of panning — mouse only (touch has no shift), and only
      // when there's actually a map to select on. `active` flips true once
      // the drag clears the same 12px tolerance onMove's pan-vs-tap test
      // uses, so a plain shift-click (no drag) still falls through to
      // selectShipAt in onUp below rather than opening an empty box.
      if (this.isPrimary(e) && e.shiftKey && e.pointerType === 'mouse' &&
          Game.running && !Game.spawning && !UI.placing && !Radial.isOpen()) {
        this.clearHold();
        this.selecting = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, active: false };
      }
    }
    if (this.pointers.size === 2) { this.clearHold(); this.selecting = null; this.lastPinch = this.pinchDistance(); }
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
      if (this.selecting) {
        this.selecting.x1 = e.clientX;
        this.selecting.y1 = e.clientY;
        if (this.moved >= 12) this.selecting.active = true;
        return;   // a selection drag never pans the camera
      }
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

    if (wasSingle && wasPrimary && this.selecting) {
      const sel = this.selecting;
      this.selecting = null;
      if (sel.active) {
        UI.selectShipsInBox(Math.min(sel.x0, sel.x1), Math.min(sel.y0, sel.y1),
                              Math.max(sel.x0, sel.x1), Math.max(sel.y0, sel.y1));
      } else {
        UI.selectShipAt(e.clientX, e.clientY);
      }
      return;
    }
    this.selecting = null;

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
    const zoomIn = (e.deltaY < 0) !== Options.get('invertZoom');
    Render.cam.scale *= zoomIn ? 1.15 : 1 / 1.15;
  },

  pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
};
