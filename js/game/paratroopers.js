// js/game/paratroopers.js — Planes, paratroopers & anti-air
// (docs/paratroopers-spec.md). Extends the Game singleton declared in
// game/core.js.
//
// ONE PLANE, THREE ROLES. A level 2+ City holds one ready plane. What the
// plane does falls out of its load, not a mode: the attack-ratio slider's
// troops ride along when there are at least PARA_MIN_TROOPS of them (an
// invasion), otherwise it flies empty (a scout in fog matches, and a decoy
// either way — no other player can tell the two apart). Every launch also
// spends PILOT_COST troops that never come back, because planes are one-way.
//
// FLIGHT is a straight line from the launching city to the clicked tile at
// PARA_SPEED, its position a pure function of (born, duration) the same way a
// nuke's is, so render.js can draw it off its own clock with no extra state.
//
// TARGETING NEVER READS THE FOG. Like the Scout ship (game/scouts.js), a
// destination may be any tile at all, undiscovered ones included, and the
// only refusals that look at the tile are for discovered tiles. Who the drop
// lands on is decided at arrival (resolvePlaneArrival), not at launch: under
// fog the player may not even know who owns the tile they clicked. That is
// also what lets a plane be sent at an ally — the alliance is only checked on
// arrival, so breaking it while the plane is in the air turns the flight into
// a real invasion.
//
// ANTI-AIR (stepAntiAir) is every built, level 2+, upgradable structure:
// City, Factory, Port, Silo and SAM. Each fires at most once per AA_RELOAD
// at one non-allied plane inside aaRange(level), hitting on a Game.rng roll.
// A plane at 0 hp is gone and its troops with it.
//
// DETERMINISM. planes is an array in launch order; buildings is a Map in
// insertion order; paraReadyAt/aaReadyAt are Maps keyed by structure tile and
// only ever looked up, never iterated. rng is drawn only when a gun fires, so
// a match where nobody launches a plane draws exactly what it always did.
//
// Per-structure timers live in those two Maps rather than on the building
// record, so the record keeps the shape every other system already hashes.
// They are keyed by tile, so a captured city keeps its cooldown, and an entry
// left behind by a destroyed structure is harmless: nothing iterates them.
Object.assign(Game, {
  PARA_MIN_LEVEL: 2,
  // Smallest load that drops — the same 20 a boat needs. Below it the plane
  // flies empty.
  PARA_MIN_TROOPS: 20,
  // Spent on every launch, loaded or empty, and never refunded.
  PILOT_COST: 1,
  // Tiles per second: faster than a boat (BOAT_SPEED 10), far slower than a
  // nuke (NUKE_SPEED 45).
  PARA_SPEED: 15,
  // Seconds per city. Starts the moment the plane is sent, so a city can have
  // its next plane ready while the last one is still flying.
  PARA_COOLDOWN: 20,
  MAX_PLANES_PER_PLAYER: 3,
  PLANE_HP: 3,
  // Vision cells revealed around a plane in a fog match — the Scout's sight.
  PLANE_SIGHT: 5,
  // aaRange(level) = AA_BASE_RANGE + AA_RANGE_STEP * (level - 2), capped.
  AA_BASE_RANGE: 6,
  AA_RANGE_STEP: 4,
  AA_MAX_RANGE: 30,
  AA_RELOAD: 1.5,
  AA_HIT_CHANCE: 0.35,
  // Cosmetic only: how long a tracer stays on screen.
  AA_FLASH_FX_DURATION: 0.35,

  // Planes in the air: { id, owner, src, dst, troops, hp, born, duration,
  // cell }. `troops` is the load (0 for an empty plane). `cell` is the vision
  // cell it last revealed from. Ids come from nextPlaneId, the same scheme as
  // nextBoatId.
  planes: [],
  nextPlaneId: 1,
  // Structure tile -> Game.elapsed at which its next plane is ready. Missing
  // means ready now.
  paraReadyAt: new Map(),
  // Structure tile -> Game.elapsed at which its gun has reloaded.
  aaReadyAt: new Map(),
  // Tracers, cosmetic (Game.COSMETIC_STATE): { fx, fy, x, y, hit, born }.
  aaFlashes: [],
  // Drop tile -> the player who landed there, for every drop whose tile that
  // player still holds. A pocket holding one is never annexed (airdropHolds).
  // Entries whose tile has changed hands are dropped each tick in stepPlanes,
  // so the map only ever holds live drop zones. Insertion order, lookups only.
  dropZones: new Map(),

  initPlanes() {
    this.planes = [];
    this.nextPlaneId = 1;
    this.paraReadyAt = new Map();
    this.aaReadyAt = new Map();
    this.aaFlashes = [];
    this.dropZones = new Map();
  },

  planeById(id) {
    for (const p of this.planes) if (p.id === id) return p;
    return null;
  },

  planeCount(playerId) {
    let n = 0;
    for (const p of this.planes) if (p.owner === playerId) n++;
    return n;
  },

  aaRange(level) {
    return Math.min(this.AA_MAX_RANGE, this.AA_BASE_RANGE + this.AA_RANGE_STEP * (level - 2));
  },

  // Whether this structure carries an anti-air gun.
  hasAntiAir(b) {
    if (!b.built || b.level < this.PARA_MIN_LEVEL) return false;
    const def = this.unitDef(b.type);
    return !!def && !!def.upgradable;
  },

  // A level 2+ city of `playerId`'s at `tile`, or null.
  planeCity(playerId, tile) {
    const b = this.buildings.get(tile);
    if (!b || b.type !== 'city' || !b.built || b.level < this.PARA_MIN_LEVEL) return null;
    return GameMap.owner[tile] === playerId ? b : null;
  },

  // Seconds until the city at `tile` has a plane ready; 0 when it has one.
  planeCooldownLeft(tile) {
    const at = this.paraReadyAt.get(tile);
    return at === undefined ? 0 : Math.max(0, at - this.elapsed);
  },

  // What a slider request of `troops` actually loads: all of it, or nothing.
  planeLoad(troops) {
    return troops >= this.PARA_MIN_TROOPS ? troops : 0;
  },

  // Why `playerId` can't send a plane from `cityTile` to `dstTile` with
  // `troops` aboard, or null. Same null-or-reason shape as
  // navalInvasionBlockReason. Every refusal about the destination is for a
  // discovered tile only — see the file comment.
  planeBlockReason(playerId, cityTile, dstTile, troops) {
    const launch = this.planeLaunchBlockReason(playerId, cityTile, troops);
    if (launch) return launch;
    if (!(dstTile >= 0 && dstTile < GameMap.owner.length)) return 'Off the map';
    if (this.fog && !this.isDiscovered(playerId, dstTile)) return null;
    const owner = GameMap.owner[dstTile];
    if (owner === playerId) return 'Your own land';
    if (owner >= 0 && this.onSameTeam(playerId, owner)) return 'Teammate';
    return null;
  },

  // The half of planeBlockReason that doesn't depend on where the plane is
  // going — what the city button asks before arming the targeting cursor.
  planeLaunchBlockReason(playerId, cityTile, troops) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    if (!this.planeCity(playerId, cityTile)) return 'Needs a level 2 city';
    if (this.planeCooldownLeft(cityTile) > 0) return 'Plane not ready';
    if (this.planeCount(playerId) >= this.MAX_PLANES_PER_PLAYER) return 'Plane limit reached';
    if (!(troops >= 0) || p.troops < this.planeLoad(troops) + this.PILOT_COST) return 'Not enough troops';
    return null;
  },

  canLaunchPlane(playerId, cityTile, dstTile, troops) {
    return !this.planeBlockReason(playerId, cityTile, dstTile, troops);
  },

  launchPlane(playerId, cityTile, dstTile, troops) {
    if (this.planeBlockReason(playerId, cityTile, dstTile, troops)) return false;
    const p = this.players[playerId];
    const load = this.planeLoad(troops);
    p.troops -= load + this.PILOT_COST;
    this.paraReadyAt.set(cityTile, this.elapsed + this.PARA_COOLDOWN);
    const w = GameMap.width;
    const dx = (dstTile % w) - (cityTile % w), dy = ((dstTile / w) | 0) - ((cityTile / w) | 0);
    // sqrt is IEEE-exact on every engine; see Game.det.
    const dist = Math.sqrt(dx * dx + dy * dy);
    const duration = Math.max(this.TICK_DT, dist / this.PARA_SPEED);
    this.planes.push({ id: this.nextPlaneId++, owner: playerId, src: cityTile, dst: dstTile, troops: load,
                       hp: this.PLANE_HP, born: this.elapsed, duration, cell: -1 });
    return true;
  },

  // Where plane `pl` is at time `now`, in tile coordinates (floats). `now` is
  // passed in so render.js can ask with Game.renderElapsed.
  planePos(pl, now) {
    const w = GameMap.width;
    const t = Math.max(0, Math.min(1, (now - pl.born) / pl.duration));
    const sx = pl.src % w, sy = (pl.src / w) | 0;
    const ex = pl.dst % w, ey = (pl.dst / w) | 0;
    return { x: sx + (ex - sx) * t, y: sy + (ey - sy) * t };
  },

  // Each tick, before stepPlanes: every anti-air structure whose gun has
  // reloaded fires at one hostile plane in range — the most damaged, the
  // earliest launched on a tie. Allies (teammates included, see teams.js)
  // and the plane's own owner never fire. The load never enters the choice:
  // that is what makes an empty plane a decoy.
  stepAntiAir() {
    const flashes = this.aaFlashes;
    for (let i = flashes.length - 1; i >= 0; i--) {
      if (this.elapsed - flashes[i].born > this.AA_FLASH_FX_DURATION) flashes.splice(i, 1);
    }
    if (!this.planes.length) return;

    const w = GameMap.width, now = this.elapsed;
    // Positions once per tick, not once per structure.
    const pos = this.planes.map(pl => this.planePos(pl, now));
    for (const b of this.buildings.values()) {
      if (!this.hasAntiAir(b)) continue;
      const ownerId = GameMap.owner[b.tile];
      if (ownerId < 0) continue;
      const ready = this.aaReadyAt.get(b.tile);
      if (ready !== undefined && ready > now) continue;

      const bx = b.tile % w, by = (b.tile / w) | 0;
      const range = this.aaRange(b.level), rangeSq = range * range;
      let best = -1;
      for (let i = 0; i < this.planes.length; i++) {
        const pl = this.planes[i];
        if (pl.hp <= 0 || pl.owner === ownerId || this.areAllied(ownerId, pl.owner)) continue;
        const dx = pos[i].x - bx, dy = pos[i].y - by;
        if (dx * dx + dy * dy > rangeSq) continue;
        if (best < 0 || pl.hp < this.planes[best].hp) best = i;
      }
      if (best < 0) continue;

      this.aaReadyAt.set(b.tile, now + this.AA_RELOAD);
      const pl = this.planes[best];
      const hit = this.rng() < this.AA_HIT_CHANCE;
      if (hit) pl.hp--;
      flashes.push({ fx: bx, fy: by, x: pos[best].x, y: pos[best].y, hit, born: now });
      if (pl.hp <= 0) Fx.planeEvent('shotdown', pl.owner, ownerId, pl.dst, pl.troops);
    }
  },

  // Removes crashed planes and planes whose nation has fallen, moves the
  // rest (revealing as they enter new vision cells in a fog match), and
  // resolves the ones that have arrived.
  stepPlanes() {
    const now = this.elapsed;
    // A drop zone lasts exactly as long as its lander holds the tile.
    for (const [tile, ownerId] of this.dropZones) {
      if (GameMap.owner[tile] !== ownerId) this.dropZones.delete(tile);
    }
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const pl = this.planes[i];
      if (pl.hp <= 0 || !this.players[pl.owner].alive) { this.planes.splice(i, 1); continue; }
      if (this.fog) {
        const { x, y } = this.planePos(pl, now);
        const tile = GameMap.idx(Math.round(x), Math.round(y));
        const cell = this.visionCellOf(tile);
        if (cell !== pl.cell) {
          pl.cell = cell;
          this.revealAround(pl.owner, tile, this.PLANE_SIGHT);
        }
      }
      if (now - pl.born < pl.duration) continue;
      this.planes.splice(i, 1);
      this.resolvePlaneArrival(pl);
    }
  },

  // Arrival, after naval.js's resolveLanding — see docs/paratroopers-spec.md
  // §3 for the five cases.
  resolvePlaneArrival(pl) {
    const tile = pl.dst;
    const owner = this.players[pl.owner];
    this.revealAround(pl.owner, tile, this.PLANE_SIGHT);
    if (pl.troops <= 0) return;

    const targetId = GameMap.owner[tile];
    const refund = pl.troops * (1 - this.BOAT_RETREAT_MALUS);
    // Still allied (or a teammate, which areAllied covers): the plane turns
    // away without provoking anyone.
    if (targetId >= 0 && this.areAllied(pl.owner, targetId)) {
      owner.troops += refund;
      Fx.planeEvent('allied', pl.owner, targetId, tile, pl.troops);
      return;
    }
    // Water, unclaimed land, or already ours: nothing to drop on.
    if (targetId < 0 || targetId === pl.owner || !GameMap.isLand(tile)) {
      owner.troops += refund;
      Fx.planeEvent('nodrop', pl.owner, targetId, tile, pl.troops);
      return;
    }

    this.dropRequestsBetween(pl.owner, targetId);
    this.setOwner(tile, pl.owner);
    this.embargoOnAttack(pl.owner, targetId);
    if (this.fog) this.markMet(targetId, pl.owner);
    this.provokeByAttack(owner, this.players[targetId]);
    this.noteFreshFront(owner, this.players[targetId]);
    Fx.planeEvent('landed', pl.owner, targetId, tile, pl.troops);
    this.dropZones.set(tile, pl.owner);
    this.openBeachhead(pl.owner, targetId, tile, pl.troops);
  },

  // A drop lands as a one-tile island inside enemy land, which the
  // annexation rule (annex.js) would hand to whoever surrounds it — straight
  // back to the defender on the next sweep, or to a third nation that
  // conquers the land around it — with no fight at all. So a pocket of
  // `ownerId`'s holding a drop tile they still own is never annexable: to
  // take it, someone has to attack it across the border like any other land.
  // Once the drop tile itself is lost in combat the protection goes with it.
  airdropHolds(ownerId, tiles) {
    if (!this.dropZones.size) return false;
    for (const [tile, owner] of this.dropZones) {
      if (owner === ownerId && GameMap.owner[tile] === ownerId && tiles.includes(tile)) return true;
    }
    return false;
  },
});
