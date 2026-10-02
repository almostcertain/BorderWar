// Right-click / long-press menu for acting on another nation.
//
// Built as an SVG overlay rather than drawn into the map canvas: the map is a
// pixel blit that gets rebuilt whenever territory changes, and hit-testing arcs
// against it by hand would buy nothing. OpenFront's own menu is SVG for the
// same reason. Geometry follows theirs — menuSize 190 (so a 95 outer radius),
// mainMenuInnerRadius 40, centerButtonSize 30, 300ms reopen cooldown.
//
// Four quadrants: trade toggle (north), Boat/Betray (east), Peace/Renew
// (south), Target (west, non-allied players only). In a team game the centre
// button on a friendly nation opens a second ring, Donate, with Troops and
// Gold; its centre goes back. Everywhere else the centre just closes the menu.
const Radial = {
  el: null,
  menuEl: null,
  targetId: -1,
  tile: -1,
  shown: false,
  lastHide: 0,
  key: '',
  validatedAt: 0,   // last time refresh() re-ran the wedge validators
  mode: 'main',     // 'main' ring, or the 'donate' sub-ring

  OUTER: 92,
  INNER: 38,
  CENTER: 30,
  GAP: 0.05,          // radians of dead space between wedges
  REOPEN_MS: 300,

  setup() {
    this.el = document.getElementById('radial');
    this.menuEl = document.getElementById('radialMenu');

    // A tap on the backdrop dismisses. The overlay covers the canvas while it
    // is up, so that tap can never also launch an attack.
    this.el.addEventListener('pointerdown', e => {
      if (e.target === this.el) this.hide();
    });
    this.menuEl.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) { this.hide(); return; }
      if (e.target.closest('[data-donate]')) { this.setMode('donate'); return; }
      if (e.target.closest('[data-back]')) { this.setMode('main'); return; }
      const path = e.target.closest('path[data-slot]');
      if (path) this.activate(+path.dataset.slot);
    });
    window.addEventListener('keydown', e => { if (e.key === 'Escape') this.hide(); });
  },

  isOpen() { return this.shown; },

  // targetId is a player id for another nation's land, or NEUTRAL/WATER for
  // unclaimed ground and open sea — those still get the Boat slot, just none
  // of the diplomacy ones, so there's no living player to validate here.
  open(sx, sy, targetId, tile) {
    if (performance.now() - this.lastHide < this.REOPEN_MS) return;
    if (targetId === Game.me) return;
    // Fog of war: no menu on the black. Opening one at all would say whether
    // the tile is someone's land, unclaimed or sea. A tile the viewer can see
    // always belongs to a nation they have met (docs/fog-of-war.md), so the
    // name in the hub needs no further check; UI.knows() is asked anyway, so
    // the menu can never introduce a nation.
    if (!Render.canSee(tile) || (targetId >= 0 && !UI.knows(targetId))) return;
    if (targetId >= 0) {
      const p = Game.players[targetId];
      if (!p || !p.alive) return;
    }

    this.targetId = targetId;
    this.tile = tile;
    this.shown = true;
    this.mode = 'main';
    this.key = '';
    this.el.classList.remove('hidden');
    this.place(sx, sy);
    this.refresh();
  },

  setMode(mode) {
    this.mode = mode;
    this.key = '';
    this.refresh();
  },

  // The centre opens Donate only where a donation could ever apply: a team
  // game and a friendly (teammate or allied) nation. A cooldown still opens
  // it, and the wedges say how long is left.
  canOpenDonate() {
    const t = this.targetId;
    return !!Game.teams && t >= 0 && Game.areAllied(Game.me, t);
  },

  hide() {
    if (!this.shown) return;
    this.shown = false;
    this.lastHide = performance.now();
    this.el.classList.add('hidden');
  },

  // Keep the whole menu on screen; on a phone a corner tap would otherwise put
  // half the wedges past the edge.
  place(sx, sy) {
    const span = (this.OUTER + 6) * 2;
    const m = 8;
    const x = Math.max(m, Math.min(window.innerWidth - span - m, sx - span / 2));
    const y = Math.max(m, Math.min(window.innerHeight - span - m - 30, sy - span / 2));
    this.menuEl.style.left = x + 'px';
    this.menuEl.style.top = y + 'px';
    this.menuEl.style.width = span + 'px';
  },

  // What each quadrant does right now. Index 0 = north, then clockwise —
  // matching OpenFront's own d3.pie layout in RadialMenu.ts exactly (their
  // startAngle is -π/n, which centers item 0 at north and walks clockwise
  // through east/south/west for the rest).
  //
  // Positions are ported from their rootMenuElement's actual slot order for
  // a non-owned tile: [Info, Boat‖Betray, Renew‖Peace, Attack‖Donate]. We
  // have no Info panel or radial Attack (attack is a direct tap on the map
  // here), so north carries the trade toggle OpenFront keeps in its Info
  // panel and west carries Target (also an Info-panel action upstream) — but
  // Boat/Betray at east and Peace/Renew at south match their real layout, not
  // a guess.
  // Note the split each slot now makes. `note`/`disabled` come from the
  // *BlockReason validators, run right here on the current state, so a wedge
  // that cannot be pressed says so the instant the menu opens — no round trip.
  // `act` sends an intent and answers nothing: whether the action actually
  // happened is decided a turn later, inside the Executor, by the same
  // validators re-run on every client (MP-1.5, §5). Advisory here,
  // authoritative there.
  //
  // `me` stays in this file: it is Game.me, a view pointer, and every use of it
  // below is about what to draw for the player looking at the screen. It is
  // deliberately absent from the intents themselves — the server stamps the
  // author, so a client cannot act as anyone but itself.
  slots() {
    if (this.mode === 'donate') return this.donateSlots();
    const me = Game.me, t = this.targetId;
    const out = [null, null, null, null];

    // Diplomacy only makes sense against another living nation — neutral
    // land and open water skip straight to the Boat slot below.
    if (t >= 0) {
      const al = Game.allianceBetween(me, t);
      if (al) {
        // Betray takes the east slot Boat would otherwise hold — you can't
        // invade an ally, so the moment one is boat-blocked it opens up for
        // the other action that only makes sense against one.
        out[1] = {
          icon: 'traitor', label: 'Betray', cls: 'danger',
          act: () => Transport.sendIntent(Protocol.intent.breakAlliance(t))
        };
        if (Game.extendWindowOpen(al)) {
          const waiting = Game.agreedToExtend(al, me);
          out[2] = {
            icon: 'expiring', label: waiting ? 'Sent' : 'Renew', cls: 'good',
            note: waiting ? 'Awaiting reply' : Math.ceil(al.expiresAt - Game.elapsed) + 's left',
            disabled: waiting,
            act: () => Transport.sendIntent(Protocol.intent.allianceExtension(t))
          };
        }
      } else {
        const reason = Game.allianceBlockReason(me, t);
        out[2] = {
          icon: 'ally', label: 'Peace', cls: 'good',
          note: reason, disabled: !!reason,
          act: () => Transport.sendIntent(Protocol.intent.allianceRequest(t))
        };
      }
    }

    // Target (ticket #30): mark a non-allied player for your allies to focus
    // — OpenFront's Target button. West was the free quadrant.
    if (t >= 0 && !Game.areAllied(me, t)) {
      const reason = Game.targetBlockReason(me, t);
      const marked = Game.activeTargets(Game.players[me]).includes(t);
      out[3] = {
        icon: 'target', label: marked ? 'Marked' : 'Target', cls: 'danger',
        note: marked ? null : reason, disabled: marked || !!reason,
        act: () => Transport.sendIntent(Protocol.intent.targetPlayer(t))
      };
    }

    // Trade toggle — OpenFront's "Stop trading" / "Start trading" button.
    // Nations only; tribes never trade.
    if (t >= 0 && !Game.players[t].isTribe) out[0] = this.tradeSlot(me, t);

    // Boat: a deliberate sea route to the exact tile the menu was opened on,
    // available against any target — including one already reachable by
    // land, as a shortcut, exactly like OpenFront's own Boat button. Only
    // fills the east slot when Betray hasn't already claimed it above.
    if (!out[1]) {
      const troops = Math.floor(Game.players[me].troops * UI.ratio);
      const reason = Game.navalInvasionBlockReason(me, this.tile, troops);
      out[1] = {
        icon: 'boat', label: 'Boat', cls: 'good',
        note: reason, disabled: !!reason,
        act: () => Transport.sendIntent(Protocol.intent.boat(this.tile, troops))
      };
    }

    return out;
  },

  // The Donate sub-ring: Troops west, Gold east, amounts off the same ratio
  // slider Boat and attacks use. Absolute amounts go on the wire (see
  // Protocol's donate_gold note). One cooldown covers both, as upstream.
  donateSlots() {
    const me = Game.me, t = this.targetId, p = Game.players[me];
    const reason = Game.donateBlockReason(me, t);
    const troops = Math.floor(p.troops * UI.ratio);
    const gold = Math.floor(p.gold * UI.ratio);
    return [null, {
      icon: 'gold', label: 'Gold', cls: 'good',
      note: reason || formatCount(gold), disabled: !!reason || gold < 1,
      act: () => Transport.sendIntent(Protocol.intent.donateGold(t, gold))
    }, null, {
      icon: 'troops', label: 'Troops', cls: 'good',
      note: reason || formatCount(troops), disabled: !!reason || troops < 1,
      act: () => Transport.sendIntent(Protocol.intent.donateTroops(t, troops))
    }];
  },

  tradeSlot(me, t) {
    const mine = Game.players[me].embargoes.get(t);
    const theirs = Game.hasEmbargoAgainst(t, me);
    if (mine) {
      const left = Game.TEMPORARY_EMBARGO_DURATION - (Game.elapsed - mine.createdAt);
      return {
        icon: 'trade', label: 'Trade', cls: 'good',
        note: theirs ? 'They refuse too' : mine.temporary ? 'Auto · ' + Math.ceil(left) + 's' : 'Embargoed',
        act: () => Transport.sendIntent(Protocol.intent.embargo(t, 'stop'))
      };
    }
    return {
      icon: 'embargo', label: 'Stop trade', cls: 'danger',
      note: theirs ? 'They refuse you' : null,
      act: () => Transport.sendIntent(Protocol.intent.embargo(t, 'start'))
    };
  },

  activate(i) {
    const s = this.slots()[i];
    if (!s || s.disabled) return;
    s.act();
    this.hide();
  },

  // Rebuilt only when something a player can see has actually changed — this is
  // called every frame from UI.update so the cooldown and renewal countdowns
  // stay live, and rewriting the SVG at 60Hz would be silly.
  // How often the wedges are re-validated while the menu sits open. slots()
  // is not a cheap read of existing state — the Boat wedge's own note comes
  // from navalInvasionBlockReason, which resolves a landing tile and then
  // runs a real sea route search to fill it in. Doing that at 60Hz for a menu
  // whose only live text is a whole-second countdown was pure waste; a
  // re-validation every 200ms keeps that countdown honest and the wedge's
  // enabled/disabled state current within a fifth of a second.
  REVALIDATE_MS: 200,

  refresh() {
    if (!this.shown) return;
    let p = null;
    if (this.targetId >= 0) {
      p = Game.players[this.targetId];
      if (!p || !p.alive) { this.hide(); return; }
    }

    // open() clears `key`, so the menu still validates instantly on the frame
    // it appears rather than waiting out a first interval.
    const now = performance.now();
    if (this.key !== '' && now - this.validatedAt < this.REVALIDATE_MS) return;
    this.validatedAt = now;

    const slots = this.slots();
    const key = this.mode + (this.canOpenDonate() ? '+' : '') + '/' +
      slots.map(s => s ? [s.icon, s.label, s.note, s.disabled].join('|') : '-').join('/');
    if (key === this.key) return;
    this.key = key;
    this.menuEl.innerHTML = this.render(slots, p);
  },

  // Annulus sector. Angles are radians clockwise from twelve o'clock, which
  // makes the quadrant midpoints simply 0, π/2, π, 3π/2.
  wedge(c, r0, r1, a0, a1) {
    const pt = (r, a) => [(c + r * Math.sin(a)).toFixed(2), (c - r * Math.cos(a)).toFixed(2)];
    const [ax, ay] = pt(r1, a0), [bx, by] = pt(r1, a1);
    const [cx, cy] = pt(r0, a1), [dx, dy] = pt(r0, a0);
    return `M${ax} ${ay}A${r1} ${r1} 0 0 1 ${bx} ${by}L${cx} ${cy}A${r0} ${r0} 0 0 0 ${dx} ${dy}Z`;
  },

  render(slots, p) {
    const c = this.OUTER + 6, span = c * 2;
    const mid = (this.INNER + this.OUTER) / 2;
    let paths = '', text = '';

    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const s = slots[i];
      const cls = s ? (s.disabled ? 'disabled' : s.cls) : 'empty';
      const slotAttr = s && !s.disabled ? ` data-slot="${i}"` : '';
      paths += `<path class="rSlot ${cls}"${slotAttr} d="` +
        this.wedge(c, this.INNER, this.OUTER, a - Math.PI / 4 + this.GAP,
                   a + Math.PI / 4 - this.GAP) + `"></path>`;
      if (!s) continue;

      const x = (c + mid * Math.sin(a)).toFixed(1);
      const y = +(c - mid * Math.cos(a)).toFixed(1);
      const dim = s.disabled ? ' dim' : '';
      text += `<image class="rIcon${dim}" href="assets/icons/${s.icon}.svg" x="${x - 11}" y="${y - 19}" width="22" height="22"></image>` +
              `<text class="rLabel${dim}" x="${x}" y="${y + 12}">${s.label}</text>`;
      if (s.note) text += `<text class="rNote${dim}" x="${x}" y="${y + 25}">${s.note}</text>`;
    }

    // Water/neutral has no nation to show — a plain grey hub and a label
    // naming what's actually there instead of a name and troop count.
    const colour = p ? `rgb(${p.color[0]},${p.color[1]},${p.color[2]})` : 'rgb(120,135,150)';
    const traitor = p && Game.isTraitor(p) ? ' ' + iconHtml('traitor') : '';
    const label = p ? `${escapeHtml(p.name)}${traitor} · ${formatCount(p.troops)}`
                     : (this.targetId === NEUTRAL ? 'Unclaimed land' : 'Open water');
    // Back and Donate are icons; Close stays a plain ✕ glyph (not an emoji).
    const centre = this.mode === 'donate' ? { attr: 'data-back', icon: 'back' }
                 : this.canOpenDonate() ? { attr: 'data-donate', icon: 'gift' }
                 : { attr: 'data-close', text: '✕' };
    return `<svg viewBox="0 0 ${span} ${span}" width="${span}" height="${span}">` +
      paths +
      `<circle class="rCentre" ${centre.attr}="1" cx="${c}" cy="${c}" r="${this.CENTER}" fill="${colour}"></circle>` +
      (centre.icon
        ? `<image class="rCentreIcon" href="assets/icons/${centre.icon}.svg" x="${c - 10}" y="${c - 10}" width="20" height="20"></image>`
        : `<text class="rCentreIcon" x="${c}" y="${c}">${centre.text}</text>`) +
      text +
      `</svg><div class="rName">${label}</div>`;
  }
};
