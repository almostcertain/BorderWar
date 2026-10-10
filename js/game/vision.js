// js/game/vision.js — Fog of war: vision state (docs/fog-of-war.md).
// Extends the Game singleton declared in game/core.js.
//
// What each nation has discovered, and which nations it has met. This is sim
// state, not presentation: bots branch on it, so it is deterministic (integer
// math over typed arrays indexed by cell, group and player id — nothing here
// iterates a Map or a Set, and nothing draws from Game.rng) and it goes in the
// desync hash (net/hash.js).
//
// FOG OFF: initVision() nulls every field below and returns, so nothing is
// allocated, and every hook into this file is gated on Game.fog at its call
// site. A fog-off match never reaches the rest of this file.
//
// VISION GROUPS. Discovery belongs to a group, not a player. In a free-for-all
// every human and every Nation is its own group; in a team game teammates
// still have a group each but always share each other's stamps (see
// visionRefreshShare), so they share the map and their contacts, while an
// ally one teammate makes reaches only that teammate. Tribes
// get no group: they only ever act on their own border, so they are never
// gated, and the queries below answer "yes" for them.
//
// THE GRID. Discovery is tracked per cell of VISION_CELL x VISION_CELL tiles,
// one bitmask of groups per cell. Cell-major, visionWords 32-bit words each:
//   cell  = cy * Game.visionCellsW + cx          (cx = (x / VISION_CELL) | 0)
//   word  = Game.visionCells[cell * Game.visionWords + (group >>> 5)]
//   bit   = 1 << (group & 31)
// Discovery is permanent: bits are only ever set.
//
// READING IT (render, UI, bots). Everything here is read-only outside this
// file. Game.isDiscovered / Game.hasMet answer the per-tile and per-nation
// questions. For a fog layer, read the grid directly with the layout above,
// using g = Game.visionGroup(viewerId), and watch Game.visionCount[g]: it is
// g's discovered-cell count, so it changes exactly when g's discovered set
// does and never otherwise.
//
// MET. visionMet holds, per player, the groups that have met that player.
// Contact is one-sided. A group has met a player once any of that player's
// land has been inside the group's discovered area — however the area got
// there, an ally's shared map included — or once that player has attacked a
// member (markMet, called where a land attack, a boat landing and a nuke hit
// are resolved; that reveals who, not where). Two things keep the first rule
// true without ever rescanning the map:
//   - a cell newly discovered by anyone has its tiles scanned for owners
//     (visionMeetCell);
//   - a tile changing hands is met by every group that has already
//     discovered its cell (visionTileGained).
Object.assign(Game, {
  // Tuning dials. Sight radii are in cells, not tiles.
  VISION_CELL: 8,
  VISION_SIGHT_BORDER: 3,
  VISION_SIGHT_SCOUT: 5,
  VISION_SIGHT_WARSHIP: 3,
  VISION_SIGHT_RADIO: 18,

  // Per-match state, built by initVision. All of it is null/0 in a fog-off
  // match.
  visionCellsW: 0,
  visionCellsH: 0,
  // Number of vision groups, and 32-bit words per group bitmask.
  visionGroups: 0,
  visionWords: 0,
  // Int16Array, player id -> group id, -1 for tribes.
  visionGroupOf: null,
  // Uint32Array, cells * visionWords: groups that have discovered each cell.
  visionCells: null,
  // Same shape: groups that have already stamped their border sight from a
  // tile they own in each cell, so the steady-state cost of gaining a tile is
  // one test (see visionTileGained).
  visionStamped: null,
  // Same shape: cells a group has seen from its own sources (border, scouts,
  // ships, radio) — not ones an ally showed it. Only this crosses over when an
  // alliance forms, so an ally's ally's map never reaches you.
  visionOwn: null,
  // Uint32Array, visionGroups * visionWords: the bits one of this group's
  // stamps sets — its own, plus every group it is currently allied with.
  visionShare: null,
  // Uint32Array, players * visionWords: groups that have met each player.
  visionMet: null,
  // Uint32Array, visionGroups: cells each group has discovered.
  visionCount: null,

  // Called from init() once players and teams exist, before anyone claims a
  // tile. Draws nothing from Game.rng.
  initVision() {
    this.visionCellsW = this.visionCellsH = this.visionGroups = this.visionWords = 0;
    this.visionGroupOf = this.visionCells = this.visionStamped = this.visionOwn = null;
    this.visionShare = this.visionMet = this.visionCount = null;
    if (!this.fog) return;

    // Every human and Nation is its own group, in player-id order (so a
    // group id is a player id minus the tribes before it). Teammates share
    // through the share masks, not through a common group, so an ally one
    // teammate makes reaches only that teammate.
    const n = this.players.length;
    const groupOf = new Int16Array(n).fill(-1);
    let groups = 0;
    for (let id = 0; id < n; id++) {
      if (!this.players[id].isTribe) groupOf[id] = groups++;
    }

    const C = this.VISION_CELL;
    const cw = ((GameMap.width + C - 1) / C) | 0, ch = ((GameMap.height + C - 1) / C) | 0;
    const W = Math.max(1, (groups + 31) >>> 5);
    this.visionCellsW = cw;
    this.visionCellsH = ch;
    this.visionGroups = groups;
    this.visionWords = W;
    this.visionGroupOf = groupOf;
    this.visionCells = new Uint32Array(cw * ch * W);
    this.visionStamped = new Uint32Array(cw * ch * W);
    this.visionOwn = new Uint32Array(cw * ch * W);
    this.visionShare = new Uint32Array(groups * W);
    this.visionMet = new Uint32Array(n * W);
    this.visionCount = new Uint32Array(groups);
    this.visionRefreshShare();
  },

  // --- Queries (read-only; safe from render, UI and bots) -------------------

  // The player's vision group, or -1 if it has none: a tribe, an id that is
  // not a player, or any player at all in a fog-off match.
  visionGroup(playerId) {
    if (!this.fog) return -1;
    const g = this.visionGroupOf[playerId];
    return g === undefined ? -1 : g;
  },

  // The cell index a tile falls in — for a caller that wants to know when a
  // moving unit has crossed into a new cell before calling revealAround.
  // Only meaningful in a fog match, for a tile on the map.
  visionCellOf(tile) {
    const C = this.VISION_CELL, w = GameMap.width;
    return (((tile / w) | 0) / C | 0) * this.visionCellsW + ((tile % w) / C | 0);
  },

  // Has `playerId` discovered `tile`? Always true with fog off, and for a
  // player with no vision group (tribes). False for a tile off the map.
  isDiscovered(playerId, tile) {
    if (!this.fog) return true;
    const g = this.visionGroup(playerId);
    if (g < 0) return true;
    if (!(tile >= 0 && tile < GameMap.owner.length)) return false;
    return (this.visionCells[this.visionCellOf(tile) * this.visionWords + (g >>> 5)] & (1 << (g & 31))) !== 0;
  },

  // Has player `a` met player `b`? One-sided: hasMet(a, b) says nothing
  // about hasMet(b, a). Always true with fog off. With fog on:
  //   - either id is not a player (NEUTRAL, WATER): false;
  //   - a === b: true;
  //   - a is a tribe (no vision group): true — tribes are never gated;
  //   - a and b share a vision group (teammates): true;
  //   - otherwise, whether a's group has met b. A tribe is met like any
  //     other owner of land, so hasMet(a, tribe) is false until a has seen
  //     its land or been attacked by it.
  // Teammates always know each other; an ally's contacts are not shared.
  hasMet(a, b) {
    if (!this.fog) return true;
    const n = this.visionGroupOf.length;
    if (!(a >= 0 && a < n && b >= 0 && b < n)) return false;
    if (a === b) return true;
    const g = this.visionGroupOf[a];
    if (g < 0 || g === this.visionGroupOf[b] || this.onSameTeam(a, b)) return true;
    return (this.visionMet[b * this.visionWords + (g >>> 5)] & (1 << (g & 31))) !== 0;
  },

  // How many cells of the disc revealAround(playerId, tile, radiusCells)
  // would stamp are still undiscovered by `playerId`'s group: what a Radio
  // Tower there would add. 0 with fog off, for a player with no vision group
  // and for a tile off the map. Reads the group's own discovered set only.
  visionHiddenAround(playerId, tile, radiusCells) {
    if (!this.fog || !(tile >= 0 && tile < GameMap.owner.length)) return 0;
    const g = this.visionGroup(playerId);
    if (g < 0) return 0;
    const C = this.VISION_CELL, w = GameMap.width;
    const cw = this.visionCellsW, ch = this.visionCellsH, W = this.visionWords;
    const cells = this.visionCells, gw = g >>> 5, gb = 1 << (g & 31);
    const cx = (tile % w) / C | 0, cy = ((tile / w) | 0) / C | 0;
    const r = radiusCells, r2 = r * r + r;
    let hidden = 0;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= ch) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx;
        if (x < 0 || x >= cw) continue;
        if (!(cells[(y * cw + x) * W + gw] & gb)) hidden++;
      }
    }
    return hidden;
  },

  // --- Mutators (sim only) ---------------------------------------------------

  // Reveals a disc of `radiusCells` cells around `tile` to `playerId`'s group
  // and to the groups it is currently allied with. For scouts, warships and
  // the radio tower (VISION_SIGHT_*). Calling it again for a cell already
  // revealed changes nothing, so a moving unit may call it every step.
  revealAround(playerId, tile, radiusCells) {
    if (!this.fog || !(tile >= 0 && tile < GameMap.owner.length)) return;
    const g = this.visionGroup(playerId);
    if (g < 0) return;
    const C = this.VISION_CELL, w = GameMap.width;
    this.visionStamp(g, (tile % w) / C | 0, ((tile / w) | 0) / C | 0, radiusCells);
  },

  // `observerId` has now met `subjectId` — the attack half of the contact
  // rule. The observer's whole group gains the contact; nothing is revealed,
  // and the subject learns nothing about the observer.
  markMet(observerId, subjectId) {
    if (!this.fog || !(subjectId >= 0 && subjectId < this.visionGroupOf.length)) return;
    const g = this.visionGroup(observerId);
    if (g < 0) return;
    const W = this.visionWords, base = subjectId * W;
    this.visionMet[base + (g >>> 5)] |= 1 << (g & 31);
    // A team shares its contacts: the observer's teammates meet the subject too.
    if (this.teams) {
      for (let i = 0; i < this.players.length; i++) {
        const t = this.visionGroupOf[i];
        if (t >= 0 && i !== observerId && this.onSameTeam(observerId, i)) this.visionMet[base + (t >>> 5)] |= 1 << (t & 31);
      }
    }
  },

  // setOwner's hook: `owner` (a real player) has just taken `tile`.
  visionTileGained(tile, owner) {
    const C = this.VISION_CELL, w = GameMap.width, W = this.visionWords;
    const cx = (tile % w) / C | 0, cy = ((tile / w) | 0) / C | 0;
    const base = (cy * this.visionCellsW + cx) * W;
    const g = this.visionGroupOf[owner];
    if (g >= 0) {
      const at = base + (g >>> 5), bit = 1 << (g & 31);
      if (!(this.visionStamped[at] & bit)) {
        this.visionStamped[at] |= bit;
        this.visionStamp(g, cx, cy, this.VISION_SIGHT_BORDER);
      }
    }
    // Everyone who has discovered this cell now has this owner's land in view.
    const cells = this.visionCells, met = this.visionMet, mb = owner * W;
    for (let k = 0; k < W; k++) met[mb + k] |= cells[base + k];
  },

  // Sets group g's share mask on every cell within `r` cells of (cx, cy).
  // The cutoff is r*r + r rather than r*r — the integer form of a radius of
  // r + 0.5 — so a small disc is round instead of a plus with four spikes.
  visionStamp(g, cx, cy, r) {
    const cw = this.visionCellsW, ch = this.visionCellsH, W = this.visionWords;
    const cells = this.visionCells, share = this.visionShare, count = this.visionCount, own = this.visionOwn;
    const sb = g * W, r2 = r * r + r, ow = g >>> 5, ob = 1 << (g & 31);
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= ch) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = cx + dx;
        if (x < 0 || x >= cw) continue;
        const base = (y * cw + x) * W;
        own[base + ow] |= ob;
        let fresh = false;
        for (let k = 0; k < W; k++) {
          let add = share[sb + k] & ~cells[base + k];
          if (!add) continue;
          cells[base + k] |= add;
          fresh = true;
          // One count per group that just gained the cell, lowest bit first.
          do {
            const low = add & -add;
            count[(k << 5) + 31 - Math.clz32(low)]++;
            add ^= low;
          } while (add);
        }
        if (fresh) this.visionMeetCell(x, y, base);
      }
    }
  },

  // A cell has just been discovered by someone new: every group that has
  // discovered it meets every owner of land inside it. ORing in the cell's
  // whole mask is exact, not just convenient — the groups that had it already
  // have met these owners by the same two rules.
  visionMeetCell(cx, cy, base) {
    const C = this.VISION_CELL, w = GameMap.width, W = this.visionWords;
    const owner = GameMap.owner, cells = this.visionCells, met = this.visionMet;
    const x0 = cx * C, x1 = Math.min(w, x0 + C);
    const y0 = cy * C, y1 = Math.min(GameMap.height, y0 + C);
    let last = -1;
    for (let y = y0; y < y1; y++) {
      for (let t = y * w + x0, end = y * w + x1; t < end; t++) {
        const o = owner[t];
        if (o < 0 || o === last) continue;
        last = o;
        for (let k = 0, mb = o * W; k < W; k++) met[mb + k] |= cells[base + k];
      }
    }
  },

  // Rebuilds every group's share mask from the live alliance records: its
  // own bit, its teammates' bits, plus each group it holds an alliance with.
  // Called whenever an alliance forms or ends. Sharing is direct only — an
  // ally's ally gets nothing, and a teammate's ally is not your ally.
  visionRefreshShare() {
    const W = this.visionWords, share = this.visionShare, groupOf = this.visionGroupOf;
    share.fill(0);
    for (let g = 0; g < this.visionGroups; g++) share[g * W + (g >>> 5)] = 1 << (g & 31);
    if (this.teams) {
      for (let a = 0; a < groupOf.length; a++) {
        if (groupOf[a] < 0) continue;
        for (let b = a + 1; b < groupOf.length; b++) {
          if (groupOf[b] < 0 || !this.onSameTeam(a, b)) continue;
          share[groupOf[a] * W + (groupOf[b] >>> 5)] |= 1 << (groupOf[b] & 31);
          share[groupOf[b] * W + (groupOf[a] >>> 5)] |= 1 << (groupOf[a] & 31);
        }
      }
    }
    for (let i = 0; i < this.alliances.length; i++) {
      const ga = groupOf[this.alliances[i].a], gb = groupOf[this.alliances[i].b];
      if (ga < 0 || gb < 0 || ga === gb) continue;
      share[ga * W + (gb >>> 5)] |= 1 << (gb & 31);
      share[gb * W + (ga >>> 5)] |= 1 << (ga & 31);
    }
  },

  // acceptAlliance's hook, called once the alliance record exists. The two
  // players meet, each side's map is ORed into the other's, and from here on
  // each one's stamps reach the other too (visionRefreshShare). When the
  // alliance ends, removeAlliance refreshes the masks again: sharing stops
  // and both keep what they have.
  visionAllianceFormed(aId, bId) {
    this.markMet(aId, bId);
    this.markMet(bId, aId);
    this.visionRefreshShare();
    const ga = this.visionGroupOf[aId], gb = this.visionGroupOf[bId];
    if (ga < 0 || gb < 0 || ga === gb || this.onSameTeam(aId, bId)) return;

    const cw = this.visionCellsW, ch = this.visionCellsH, W = this.visionWords;
    const cells = this.visionCells, count = this.visionCount, own = this.visionOwn;
    const wa = ga >>> 5, ba = 1 << (ga & 31), wb = gb >>> 5, bb = 1 << (gb & 31);
    for (let cy = 0, base = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++, base += W) {
        // Only what each side saw with its own eyes crosses over — never what
        // it was itself shown by an ally.
        const giveB = (own[base + wa] & ba) !== 0 && (cells[base + wb] & bb) === 0;
        const giveA = (own[base + wb] & bb) !== 0 && (cells[base + wa] & ba) === 0;
        if (!giveA && !giveB) continue;
        if (giveB) { cells[base + wb] |= bb; count[gb]++; }
        if (giveA) { cells[base + wa] |= ba; count[ga]++; }
        this.visionMeetCell(cx, cy, base);
      }
    }
  }
});
