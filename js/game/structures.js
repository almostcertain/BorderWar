// js/game/structures.js — Structures & construction.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Structures ----------------------------------------------------------
  // OpenFront's build menu. City is the first entry; the rest of their list
  // (port, defence post, silo, SAM, warship, the bombs) slots in here as each
  // is built, which is why this is a table rather than a special case.
  //
  // Cost follows their unitInfo exactly: min(maxCost, 2^n * baseCost), where
  // n is verbatim their costWrapper's own reduce — min(unitsOwned(type),
  // unitsConstructed(type)) — not unitsOwned alone. unitsConstructed is a
  // separate lifetime counter (Player.numUnitsConstructed in their source)
  // that only increments on this player's own buildUnit()/upgradeUnit()
  // calls; capturing a unit reassigns ownership and nothing else, so it can
  // raise unitsOwned without ever touching unitsConstructed. The min() is
  // what that buys: capturing cities you never built cannot itself inflate
  // your price past what your own build history already set as the ceiling,
  // though it can let a currently-owned count that fell behind (from losing
  // a built city) climb back up toward that same ceiling. Every one you
  // build OR upgrade doubles the price of the next until it plateaus, so a
  // self-built/upgraded run costs 125k, 250k, 500k, 1M, then 1M forever —
  // verified against their PlayerImpl.upgradeUnit, which calls the exact same
  // recordUnitConstructed() a fresh build does.
  //
  // `unitsOwned` (units[type] below) is therefore a SUM OF LEVELS, not a
  // headcount — verbatim PlayerImpl.unitsOwned: a built unit contributes its
  // level, a still-under-construction one contributes a flat 1. A second city
  // and a first city upgraded to level 2 cost, and are worth, exactly the
  // same. See maxTroopsRaw, which spends that same sum on the pop bonus.
  //
  // buildTime is seconds of construction after placement, ticked in
  // Game.tick — see updateConstruction. Chosen short enough to stay a visible
  // pause rather than a real commitment; the gold cost is already the real
  // one. OpenFront's own upgrades are instant (UpgradeStructureExecution has
  // no tick phase at all) — the timer here is this game's own addition, so
  // upgrading reuses buildTime rather than a ported duration.
  UNITS: [
    {
      type: 'city', name: 'City', icon: '🏙', hotkey: '1',
      baseCost: 125000, maxCost: 1000000, buildTime: 8, upgradable: true
    },
    // OpenFront's UnitType.Factory: same cost curve as City, and the same
    // constructionDuration ratio (both 2*10 ticks in their config — 1:1 —
    // which is why this reuses city's own non-ported buildTime dial rather
    // than inventing a different one). Their costWrapper actually pools
    // Factory's count together with Port (see Port's own entry below, added
    // later) rather than pricing against its own count alone — costGroup
    // below is what wires that in. What a Factory actually DOES — recruiting
    // nearby cities into a rail network and running trains between them for
    // gold — lives in the "Rail network & trains" section below, hooked in
    // through updateConstruction() the instant one finishes.
    {
      type: 'factory', name: 'Factory', icon: '🏭', hotkey: '2',
      baseCost: 125000, maxCost: 1000000, buildTime: 8, upgradable: true,
      costGroup: ['factory', 'port']
    },
    // OpenFront's UnitType.Port: same exponential cost curve as City/Factory,
    // but Config.ts's real costWrapper for Port explicitly pools its count
    // together with Factory (costWrapper(fn, UnitType.Port, UnitType.Factory))
    // rather than pricing against its own count alone — building either one
    // makes the next Port OR Factory more expensive. See unitCost's costGroup
    // handling below, and the Factory entry's own comment (written before
    // Port existed) noting this was the one deliberate gap left to close once
    // Port arrived. constructionDuration is 5*10 ticks in their config (2.5x
    // City/Factory's own 2*10) but buildTime here is this game's own pacing
    // dial, not a literal tick port (see the class comment above), so this
    // just reuses the same 8s City/Factory already use as fellow members of
    // the upgradable/exponential family.
    {
      type: 'port', name: 'Port', icon: '⚓', hotkey: '3',
      baseCost: 125000, maxCost: 1000000, buildTime: 8, upgradable: true,
      costGroup: ['factory', 'port']
    },
    // OpenFront's UnitType.DefensePost. Cost curve is LINEAR (not exponential):
    // (n+1)*50k, capped at 250k — first fort is 50k, second 100k, fifth+ is 250k.
    // defensePostRange=30, defensePostDefenseBonus=5x, defensePostSpeedBonus=3x,
    // constructionDuration=5*10 ticks. Not upgradable. See FORT_* constants and
    // fortInRange() below for the combat hooks, and tileCost()/stepAttack() for
    // where those bonuses fire.
    {
      type: 'fort', name: 'Defense Fort', icon: '🛡', hotkey: '4',
      baseCost: 50000, maxCost: 250000, buildTime: 5, upgradable: false, linear: true
    },
    // OpenFront's UnitType.Warship: cost is LINEAR like Fort (not pooled with
    // anything else) — Config.ts's real costWrapper is
    // `(numUnits+1)*250_000` capped at 1_000_000. Not upgradable (OpenFront
    // has no warship upgrade path either). Placed on WATER near the player's
    // own coast rather than on owned land — see warshipBlockReason/
    // buildWarship in the "Warships" section below, which this entry's
    // buildTime is NOT read by: a warship spawns instantly (matching
    // OpenFront's own SpawnExecution, which has no construction phase for
    // units the way City/Factory/Port/Fort do here), it's carried only so
    // the build-bar hint text has a number to show.
    // `action: true` marks a UNITS entry that is never placed on a land tile
    // via the normal buildBlockReason/build path and never lands in
    // Game.buildings — AI.economy's generic cost-group loop skips these
    // (see its own comment) and gives each its own purchase call instead
    // (buildWarship / launchNuke). Warship predates this flag; it's added
    // retroactively here to close a real latent gap the flag's own
    // introduction (for the two nuke types just below) surfaced: without it,
    // economy()'s generic loop was quietly attempting
    // Game.build(p.id, 'warship', buildSite(p)) every cycle — buildTime:0
    // meant a hit would silently plant a phantom "warship" entry in
    // Game.buildings that instantly completed and incremented
    // units.warship, inflating the REAL buildWarship price curve (unitCost
    // sums unitsOwned+unitsPending) with builds that never touched the
    // fleet at all. Never actually observed misfiring in practice — buildSite
    // only offers a tile once a nation already has land, by which point a
    // bot's real Port-gated Warship purchase below usually wins the cycle
    // first — but a latent bug wasn't worth leaving in place while adding two
    // more UNITS entries in exactly the same danger zone.
    {
      type: 'warship', name: 'Warship', icon: '🚢', hotkey: '5',
      baseCost: 250000, maxCost: 1000000, buildTime: 0, upgradable: false, linear: true, action: true
    },
    // OpenFront's UnitType.MissileSilo: cost is FLAT — Config.ts's real
    // costWrapper is `() => 1_000_000` with the numUnits argument ignored
    // entirely, unlike every cost curve above (exponential City/Factory/Port,
    // linear Fort/Warship) — a 2nd or 5th Silo costs exactly what the 1st
    // did. See unitCost's `flat` handling. Their config marks it
    // upgradable:true, but no per-level effect for it surfaced anywhere in
    // Config.ts/MissileSiloExecution.ts/UnitImpl.ts while porting (unlike
    // City, where a level directly feeds maxTroops) — rather than invent a
    // fabricated bonus, this was first left NOT upgradable. Ticket #41 found
    // the effect: UnitImpl gives a Silo the same _missileTimerQueue a SAM
    // has, capped at its level, so each level is one more missile slot that
    // reloads on its own SILO_COOLDOWN (see siloFreeSlots). Placement is the
    // ordinary own-land buildBlockReason/build path (territoryBound, exactly
    // like City) — nothing structure-specific to add there. What it actually
    // DOES — hosting nuke launches on a cooldown — lives in the "Missile
    // Silo & Nukes" section below.
    {
      type: 'silo', name: 'Missile Silo', icon: '🚀', hotkey: '6',
      baseCost: 1000000, maxCost: 1000000, buildTime: 8, upgradable: true, flat: true
    },
    // OpenFront's UnitType.AtomBomb/HydrogenBomb: also flat-cost (see Silo's
    // own comment on the `flat` curve), and `action: true` for the same
    // reason Warship is — a bomb click means "launch one at this tile from my
    // nearest ready Silo," not "place one exactly here," resolved through
    // resolveNukeLaunch/launchNuke rather than buildBlockReason/build. See
    // the "Missile Silo & Nukes" section for the launch/flight/detonation
    // logic and nukeMagnitudes for the inner/outer blast radii each type
    // ports from Config.ts. buildTime carried only for build-bar consistency,
    // same as Warship's own comment — a nuke launches the instant it's
    // ordered, no construction phase.
    {
      type: 'atombomb', name: 'Atom Bomb', icon: '☢', hotkey: '7',
      baseCost: 750000, maxCost: 750000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    {
      type: 'hydrogenbomb', name: 'Hydrogen Bomb', icon: '💥', hotkey: '8',
      baseCost: 5000000, maxCost: 5000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // OpenFront's UnitType.SAMLauncher — the defensive interceptor the
    // "Missile Silo & Nukes" section's own class comment flagged as
    // deliberately deferred ("SAM Launcher... left for a later pass"), now
    // ported against the real SAMLauncherExecution.ts/SAMMissileExecution.ts/
    // Config.ts source. Named "SAM Launcher" rather than reusing "Missile
    // Silo" even though the user described it that way — this game already
    // has a structure called Missile Silo (the offensive nuke launcher
    // above), and OpenFront itself treats these as two entirely separate
    // buildings with separate names, so keeping them separate here avoids a
    // straight naming collision. Cost is LINEAR like Fort — their real
    // costWrapper is `min(3_000_000, (numUnits+1)*1_500_000)`: first SAM
    // 1.5M, second+ pinned at the 3M cap. Territory-bound placement (own
    // land only) needs no special-casing, same as City/Fort/Silo. What it
    // actually DOES — charges, range-per-level, and shooting down incoming
    // nukes — lives in the "SAM Launcher & Interceptors" section below.
    {
      type: 'sam', name: 'SAM Launcher', icon: '📡', hotkey: '9',
      baseCost: 1500000, maxCost: 3000000, buildTime: 8, upgradable: true, linear: true
    },
    // OpenFront's UnitType.MIRV (ticket #28) — the top-tier multi-warhead
    // strike, ported against MIRVExecution.ts/Config.ts. Same `action: true`
    // "strike here" shape as the two bomb types above (resolveNukeLaunch/
    // launchMirv, not buildBlockReason/build), but its cost does NOT follow
    // baseCost/maxCost/flat/linear/costGroup the way every other entry here
    // does: Config.ts's real cost is 25_000_000 + 15_000_000 per MIRV any
    // player has EVER launched this match — a whole-match counter, not this
    // player's own build history — so Game.unitCost special-cases
    // type==='mirv' and returns before ever consulting this entry's
    // baseCost/maxCost/flat fields. They're carried anyway (set to
    // MIRV_BASE_COST, matching nukes.js's own constant) purely so this
    // entry has SOME non-garbage number if anything ever reads it before
    // unitCost's special case fires — not a claim they're the real curve.
    // See nukes.js's "MIRV" section for the launch/flight/split/detonation
    // logic and its own MIRV_WARHEAD_COUNT/MIRV_RANGE comments for what was
    // scoped down from the real 350-warhead port and why.
    {
      type: 'mirv', name: 'MIRV', icon: '🛰', hotkey: '0',
      baseCost: 25000000, maxCost: 25000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // Fog of war's Scout (docs/fog-of-war.md, game/scouts.js): an unarmed
    // ship that uncovers the map. This game's own unit, no OpenFront
    // counterpart. Flat 25k, and `action: true` for the same reason Warship
    // is: a click means "send one toward this tile from one of my Ports"
    // (resolveScoutLaunch/buildScout), not "place one here". `fogOnly` marks
    // an entry that only exists in fog matches: buildScout refuses with fog
    // off, and the build bar leaves the entry out. It has no hotkey for the
    // same reason. Last in the table so no other entry's position moves.
    {
      type: 'scout', name: 'Scout', icon: '🔭',
      baseCost: 25000, maxCost: 25000, buildTime: 0, upgradable: false, flat: true, action: true, fogOnly: true
    },
    // Battle Royale's Drill (docs/battle-royale.md, game/drill.js). This
    // game's own unit. Flat 20M (DRILL_COST). `action: true` because it never
    // lands in Game.buildings: placement is drillBlockReason/placeDrill
    // (own land, instant, one per match), not buildBlockReason/build — and
    // the flag is also what keeps AI.economy's generic loop from buying it.
    // No hotkey yet; the build bar entry is BR-5. Last in the table so no
    // other entry's position moves.
    {
      type: 'drill', name: 'The Drill', icon: '🌀',
      baseCost: 20000000, maxCost: 20000000, buildTime: 0, upgradable: false, flat: true, action: true
    }
  ],

  unitDef(type) { return this.UNITS.find(u => u.type === type) || null; },

  // Sum of levels across this player's built structures of `type`, plus a
  // flat 1 for each one still under construction — see the UNITS comment.
  // Floored at 0: `|| 0` alone only catches falsy values, so a genuine
  // negative count (a bug elsewhere) would otherwise sail through into
  // unitCost's exponent and underprice the next build.
  unitsOwned(p, type) { return Math.max(0, (p && p.units && p.units[type]) || 0); },

  // Lifetime count of this player's own builds/upgrades of `type` — never
  // decremented, whether by losing the unit or by it being captured away.
  unitsBuilt(p, type) { return Math.max(0, (p && p.unitsBuilt && p.unitsBuilt[type]) || 0); },

  // Still-under-construction structures this player has paid for. See the
  // field comment on Player.unitsPending.
  unitsPending(p, type) { return Math.max(0, (p && p.unitsPending && p.unitsPending[type]) || 0); },

  unitCost(p, type) {
    const def = this.unitDef(type);
    if (!def) return Infinity;
    // MIRV: Config.ts's real cost formula reads game.mirvsLaunched() — a
    // whole-match, EVERY-player lifetime counter (see nukes.js's
    // launchMirv/Game.mirvsLaunched) — not this player's own unitsOwned/
    // unitsBuilt history the way every curve below does, so it can't be
    // expressed as flat/linear/exponential over `n` at all and gets its own
    // early return. See the UNITS 'mirv' entry's own comment.
    if (type === 'mirv') return this.MIRV_BASE_COST + this.mirvsLaunched * this.MIRV_COST_STEP;
    // Silo/AtomBomb/HydrogenBomb: costWrapper's callback ignores numUnits
    // entirely in Config.ts, so the price never moves regardless of how many
    // you've bought — no n/costGroup accounting applies at all. See the
    // UNITS entries' own comments.
    if (def.flat) return def.baseCost;
    // Committed = finished-and-owned plus still-building — so queuing a
    // second one before the first finishes still prices at the doubled rate,
    // not the base rate `units` alone would show until completion.
    // costGroup (Port/Factory — see their UNITS entries) sums this same
    // per-type min() across every type in the group instead of just this
    // one, matching Config.ts's real costWrapper reduce: building either one
    // raises the price of both, not just its own kind.
    const types = def.costGroup || [type];
    let n = 0;
    for (const t of types) {
      const committed = this.unitsOwned(p, t) + this.unitsPending(p, t);
      n += Math.min(committed, this.unitsBuilt(p, t));
    }
    // Fort uses a LINEAR curve: (n+1)*baseCost, capped at maxCost.
    // City/factory/port use the exponential: 2^n * baseCost, capped at maxCost.
    //
    // This Math.pow is deliberately NOT routed through Game.det: base 2 with a
    // small non-negative integer exponent is exactly representable, so every
    // engine returns the identical double with no approximation involved. It
    // is the one exempt case in the determinism audit (architecture doc §7.2)
    // — leave it alone rather than "fixing" it.
    return def.linear
      ? Math.min(def.maxCost, (n + 1) * def.baseCost)
      : Math.min(def.maxCost, Math.pow(2, n) * def.baseCost);
  },

  // Why a structure cannot go here, for the UI to say out loud. null when it
  // can, in the same shape as allianceBlockReason.
  //
  // OpenFront marks a City territoryBound, which is the only placement rule
  // there is: your own land, and not on top of something already standing.
  buildBlockReason(playerId, type, tile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    if (!this.unitDef(type)) return 'Unknown structure';
    if (tile < 0 || GameMap.owner[tile] !== playerId) return 'Your own land only';
    if (this.buildings.has(tile)) return 'Already built here';
    // OpenFront's UnitType.Port is territoryBound AND requires an ocean
    // shore tile — a Port sitting one tile inland could never actually touch
    // water for a trade ship to sail from. The placement UI snaps a click
    // near the coast onto the nearest valid tile first (see
    // nearestOwnedCoastNear), so this only fires for a tap too far inland to
    // snap at all.
    if (type === 'port' && !GameMap.isCoastal(tile)) return 'Ports must be on the coast';
    if (p.gold < this.unitCost(p, type)) return 'Not enough gold';
    return null;
  },

  canBuild(playerId, type, tile) { return !this.buildBlockReason(playerId, type, tile); },

  build(playerId, type, tile) {
    if (!this.canBuild(playerId, type, tile)) return false;
    const p = this.players[playerId];
    const def = this.unitDef(type);
    p.gold -= this.unitCost(p, type);   // priced before any count goes up
    // Placed immediately, but not functional until `built` flips — see
    // updateConstruction. `progress`/`buildTime` are what the small bar drawn
    // in Render.drawStructures reads. `level` is set once construction
    // completes, matching UnitImpl's own default of 1.
    // station/rails/lastTrainAt are only ever touched for city/factory types
    // (see the "Rail network & trains" section) but are cheap enough to carry
    // on every building rather than special-case the record shape by type.
    this.buildings.set(tile, {
      type, tile, built: false, progress: 0, buildTime: def.buildTime, level: 0, upgrading: false,
      station: false, rails: new Map(), lastTrainAt: -Infinity,
      // Port-only fields (see "Ports & trade ships"), carried on every
      // building for the same reason station/rails/lastTrainAt are: cheaper
      // to always have the slot than to special-case the record shape.
      tradeRejections: 0, lastTradeCheckAt: -Infinity,
      // Silo-only (see "Missile Silo & Nukes"), carried on every building for
      // the same reason as the Port fields above. One launch time per missile
      // slot still reloading, capped at `level` — the Silo's copy of
      // UnitImpl's _missileTimerQueue, same model as samQueue below.
      siloQueue: [],
      // SAM-only (see "SAM Launcher & Interceptors"). samQueue holds one
      // timestamp per charge currently reloading — UnitImpl's real
      // _missileTimerQueue — capacity-capped at `level` (isInCooldown there
      // is verbatim `queue.length === level`), so a level-2 SAM can have two
      // independent charges reloading on their own clocks at once.
      // samRangeUpgrade holds the in-progress range ramp after a level-up
      // (null once settled) — see dynamicSamRange.
      samQueue: [], samRangeUpgrade: null
    });
    // The lifetime counter unitCost actually prices against — see unitCost's
    // comment. Only this call site and upgrade() touch it; setOwner()'s
    // capture path deliberately does not.
    p.unitsBuilt[type] = this.unitsBuilt(p, type) + 1;
    p.unitsPending[type] = this.unitsPending(p, type) + 1;
    return true;
  },

  // Why an existing structure can't be upgraded right now, for the UI to say
  // out loud — same null-or-reason shape as buildBlockReason. Priced and
  // gated exactly like a fresh build (see UNITS' cost comment): the next
  // level costs whatever unitCost says the next unit of this type costs,
  // because a level and a unit are the same pricing pool.
  upgradeBlockReason(playerId, tile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    const b = this.buildings.get(tile);
    if (!b) return 'Nothing built here';
    if (GameMap.owner[tile] !== playerId) return 'Your own land only';
    const def = this.unitDef(b.type);
    if (!def || !def.upgradable) return 'Cannot be upgraded';
    if (!b.built) return 'Still under construction';
    if (b.upgrading) return 'Already upgrading';
    if (p.gold < this.unitCost(p, b.type)) return 'Not enough gold';
    return null;
  },

  canUpgrade(playerId, tile) { return !this.upgradeBlockReason(playerId, tile); },

  upgrade(playerId, tile) {
    if (!this.canUpgrade(playerId, tile)) return false;
    const p = this.players[playerId];
    const b = this.buildings.get(tile);
    const def = this.unitDef(b.type);
    p.gold -= this.unitCost(p, b.type);   // priced before the level goes up
    b.upgrading = true;
    b.progress = 0;
    b.buildTime = def.buildTime;   // the upgrade timer, reusing the same bar
    // Same two counters a fresh build touches — an in-flight upgrade prices
    // the next build/upgrade higher immediately, exactly like a queued build
    // does, and unitsBuilt's ceiling climbs the moment gold is committed.
    p.unitsBuilt[b.type] = this.unitsBuilt(p, b.type) + 1;
    p.unitsPending[b.type] = this.unitsPending(p, b.type) + 1;
    return true;
  },

  // Advances every structure still under construction OR mid-upgrade, and
  // hands the level increase to its owner — units[type] += 1, unlocking
  // whatever it grants (a city's pop cap) — the instant its timer runs out.
  // A fresh build's first level and an upgrade's next level are the same
  // += 1 here, since units[type] is a sum of levels, not a headcount — see
  // the UNITS comment. Ownership is read fresh off the tile rather than
  // cached on the building, so a structure captured mid-upgrade (or a Fort
  // captured mid-build) never reaches here at all: setOwner() unwinds that
  // in-flight progress on capture instead of letting it finish under a new
  // flag. A non-Fort captured mid-*build*, though, is deliberately left
  // alone by setOwner() and DOES keep ticking here — reading ownership off
  // the tile is exactly what lets it finish under its new owner with no
  // other bookkeeping.
  updateConstruction() {
    for (const b of this.buildings.values()) {
      if (!b.built) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.built = true;
        b.level = 1;
        const owner = GameMap.owner[b.tile];
        if (owner < 0) continue;
        const p = this.players[owner];
        p.unitsPending[b.type] = Math.max(0, this.unitsPending(p, b.type) - 1);
        p.units[b.type] = this.unitsOwned(p, b.type) + 1;
        // Joining the rail network is a one-time event on first completion —
        // see the "Rail network & trains" section. An upgrade (the branch
        // below) never re-triggers it.
        this.onStructureCompleted(b);
      } else if (b.upgrading) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.upgrading = false;
        // UnitImpl.increaseLevel: a SAM's range doesn't jump instantly on
        // upgrade, it ramps smoothly (see dynamicSamRange) — captured before
        // b.level++ so the ramp starts from whatever range is actually in
        // effect right now (mid-ramp or settled), matching the real source's
        // own chained-upgrade behavior rather than resetting hard each time.
        // The freshly gained charge slot also starts consumed/reloading
        // immediately, exactly like a real launch — increaseLevel pushes the
        // queue the same way for SAMLauncher.
        if (b.type === 'sam') {
          b.samRangeUpgrade = {
            startAt: this.elapsed,
            startRange: this.dynamicSamRange(b, this.elapsed),
            targetLevel: b.level + 1
          };
          b.samQueue.push(this.elapsed);
        }
        // Same for a Silo: increaseLevel pushes its missile queue too, so the
        // new slot reloads once before it can fire.
        if (b.type === 'silo') b.siloQueue.push(this.elapsed);
        b.level++;
        const owner = GameMap.owner[b.tile];
        if (owner < 0) continue;
        const p = this.players[owner];
        p.unitsPending[b.type] = Math.max(0, this.unitsPending(p, b.type) - 1);
        p.units[b.type] = this.unitsOwned(p, b.type) + 1;
      }
    }
  },

});
