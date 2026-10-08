// js/game/attacks.js — Attack lifecycle & conquest frontier.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // A retreat is ordered instantly, but the troops leave the field after
  // RETREAT_DELAY: stepAttack stops conquering at once and the survivors
  // return to the reserve when the timer runs out, docked
  // ATTACK_RETREAT_MALUS if the front was pushing on another player.
  RETREAT_DELAY: 2,
  ATTACK_RETREAT_MALUS: 0.25,

  canRetreatAttack(a) { return !!a && !a.retreating; },

  retreatAttack(a) {
    if (!this.canRetreatAttack(a)) return false;
    a.retreating = true;
    a.retreatAt = this.elapsed + this.RETREAT_DELAY;
    return true;
  },

  // Recalls a boat already at sea. Rather than the artificial tick delay a
  // land front needs, the boat just reverses along the route it already
  // sailed — the crossing itself supplies the wait — and pays the same
  // ATTACK_RETREAT_MALUS on reaching home if it was headed at another player.
  canRetreatBoat(b) { return !!b && !b.retreating; },

  retreatBoat(b) {
    if (!this.canRetreatBoat(b)) return false;
    b.retreating = true;
    return true;
  },

  // Launches an attack from `attacker` against every tile of `targetId` that
  // touches their border. targetId may be NEUTRAL for unclaimed land.
  //
  // `landmassId`, when given, scopes it to one landmass (GameMap.landmassId):
  // a click on one island must not also push a front against the same enemy
  // on another, so consolidation only folds together attacks with the same
  // landmassId, and refreshFrontier only scans that landmass's border.
  // `null` (the AI's calls) is unscoped and only ever consolidates with
  // other landmassId:null attacks.
  launchAttack(attackerId, targetId, troops, landmassId = null) {
    const attacker = this.players[attackerId];
    if (troops < 20 || attacker.troops < troops) return false;
    if (targetId === attackerId) return false;
    // A peace deal holds the border shut. Attacking an ally means breaking the
    // alliance first, and wearing the traitor mark for it.
    if (this.areAllied(attackerId, targetId)) return false;
    // Marching on someone answers their proposal, as OpenFront's
    // AttackExecution.rejectIncomingAllianceRequests does.
    if (targetId >= 0) this.dropRequestsBetween(attackerId, targetId);
    // ...and, like AttackExecution, closes the victim's markets to the
    // attacker for a while. Every attack order, top-ups included.
    this.embargoOnAttack(attackerId, targetId);

    // Every existing attack against this target on the same landmass folds
    // into one survivor, which then re-scans that landmass's border
    // (refreshFrontier). A retreating front is skipped: folding a fresh push
    // into it would re-arm troops committed to leaving, so a new attack is
    // opened alongside it.
    let survivor = null;
    for (let i = this.attacks.length - 1; i >= 0; i--) {
      const at = this.attacks[i];
      if (at.attacker !== attackerId || at.target !== targetId || at.retreating) continue;
      if (at.landmassId !== landmassId) continue;
      if (survivor === null) survivor = at;
      else { survivor.troops += at.troops; this.attacks.splice(i, 1); }
    }
    // The survivor is mutated in place and keeps its id, so cancel_attack
    // intents already in flight stay valid. The attacks folded into it lose
    // their ids for good. See nextAttackId.
    if (survivor) {
      survivor.troops += troops;
      attacker.troops -= troops;
      this.refreshFrontier(survivor);
      return true;
    }

    // Minted before the frontier check, so a launch that finds no border to
    // push on burns an id. Harmless: every client runs this same code path
    // with the same state and burns the same id on the same turn, and ids are
    // deliberately never reused (see nextAttackId).
    const a = { id: this.nextAttackId++, attacker: attackerId, target: targetId, troops,
                heapTile: [], heapPrio: [], border: new Set(), landmassId,
                frontSeed: ((this.rng() * 0x7fffffff) | 0) || 1 };
    if (!this.refreshFrontier(a)) return false;

    attacker.troops -= troops;
    this.attacks.push(a);
    // Only a brand-new front counts: topping up an existing one (above) is the
    // same war, already paid for.
    if (targetId >= 0) {
      this.provokeByAttack(attacker, this.players[targetId]);
      this.noteFreshFront(attacker, this.players[targetId]);
      // Fog of war: being attacked tells the victim who it was.
      if (this.fog) this.markMet(targetId, attackerId);
    }
    return true;
  },

  // Stamps a brand-new nation-vs-nation front (land here, boats in
  // launchNavalInvasion) on its target, for AI.freshFrontLocked. Tribes on
  // either side don't count — their pushes are a nuisance, not a war.
  noteFreshFront(attacker, target) {
    if (attacker.isTribe || target.isTribe) return;
    target.frontOpenedAt = this.elapsed;
    target.frontOpenedBy = attacker.id;
  },

  // Two nations pushing into each other are one battle: their committed
  // forces destroy each other and whichever side has anything left keeps
  // advancing. Otherwise the two pushes pass straight through one another.
  resolveOpposingFronts() {
    for (let i = 0; i < this.attacks.length; i++) {
      const a = this.attacks[i];
      // A retreating front has already stopped fighting — its troops are
      // walking home, not contesting the ground a counter-push meets them on.
      if (a.target < 0 || a.troops <= 0 || a.retreating) continue;
      for (let j = i + 1; j < this.attacks.length; j++) {
        const b = this.attacks[j];
        if (b.target < 0 || b.troops <= 0 || b.retreating) continue;
        if (a.attacker !== b.target || b.attacker !== a.target) continue;
        const clash = Math.min(a.troops, b.troops);
        a.troops -= clash;
        b.troops -= clash;
        if (a.troops <= 0) break;
      }
    }
  },

  // --- Conquest frontier: a priority queue ----------------------------------
  // Keyed on frontierPriority's local, non-accumulating score (an
  // accumulated cost gives a rigid Dijkstra contour). The heap deliberately
  // holds duplicate entries per tile.
  heapPush(a, tile, prio) {
    const T = a.heapTile, P = a.heapPrio;
    let i = T.length;
    T.push(tile); P.push(prio);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (P[parent] <= P[i]) break;
      const t = T[parent]; T[parent] = T[i]; T[i] = t;
      const p = P[parent]; P[parent] = P[i]; P[i] = p;
      i = parent;
    }
  },

  heapPop(a) {
    const T = a.heapTile, P = a.heapPrio;
    const top = T[0], last = T.length - 1;
    T[0] = T[last]; P[0] = P[last];
    T.pop(); P.pop();
    let i = 0;
    const n = T.length;
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let small = i;
      if (l < n && P[l] < P[small]) small = l;
      if (r < n && P[r] < P[small]) small = r;
      if (small === i) break;
      const t = T[small]; T[small] = T[i]; T[i] = t;
      const p = P[small]; P[small] = P[i]; P[i] = p;
      i = small;
    }
    return top;
  },

  // Rebuilds an attack's queue from the attacker's *current* border with
  // the target. A slow advance drains the queue faster than conquests refill
  // it, so without this an attack aborts with most of its troops unspent.
  // Returns false when the two no longer touch.
  //
  // Scans attacker.borderTiles (kept live by setOwner/updateBorderTile), not
  // every owned tile: only a border tile can neighbour the target.
  refreshFrontier(a) {
    const attacker = this.players[a.attacker];
    const border = new Set(), nb = this.nbuf, dead = this.drillDead;
    a.heapTile = []; a.heapPrio = []; a.border = border;
    // a.landmassId null (the AI's unscoped attacks) scans every border tile
    // the attacker owns, same as before landmass scoping existed. A real
    // landmassId — a click on a specific island — restricts the scan to
    // border tiles on that landmass only, which is what keeps a push on one
    // island from also advancing a front on another.
    for (const i of attacker.borderTiles) {
      if (a.landmassId !== null && GameMap.landmassId[i] !== a.landmassId) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        // Battle Royale's dead zone (game/drill.js) is NEUTRAL forever: an
        // attack on unclaimed land never queues it.
        if (GameMap.owner[j] === a.target && !dead[j]) {
          border.add(j);
          this.heapPush(a, j, this.frontierPriority(j, a));
        }
      }
    }
    return a.heapTile.length > 0;
  },

  // Once a nation is down to scraps, grinding out the remainder tile by tile
  // costs the attacker real time for a foregone conclusion, and leaves confetti
  // on the map. OpenFront's own threshold is 100 tiles. Tiles go to whichever
  // neighbour touches them, the attacker winning any tie, so a nation boxed in
  // by three rivals is carved up rather than teleporting to whoever landed last.
  DEAD_DEFENDER_TILES: 100,

  // Presentation only: floats the killing blow's payout over the victim's
  // territory. Anchors on the tile nearest the territory's centroid, so it
  // lands inside the land even for a crescent-shaped or split nation.
  spoilsPopup(tiles, amount, ownerId) {
    if (!(amount >= 1) || !tiles.size) return;
    const w = GameMap.width;
    let sx = 0, sy = 0;
    for (const t of tiles) { sx += t % w; sy += (t / w) | 0; }
    const cx = sx / tiles.size, cy = sy / tiles.size;
    let best = -1, bestD = Infinity;
    for (const t of tiles) {
      const dx = (t % w) - cx, dy = ((t / w) | 0) - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = t; }
    }
    Fx.killPopup(best, amount, ownerId);
  },

  handleDeadDefender(defenderId, attackerId) {
    const defender = this.players[defenderId];
    const attacker = this.players[attackerId];
    const nb = this.abuf;

    // Spoils. The land is divided among every neighbour that touches it,
    // but the treasury goes whole to the nation that landed the killing
    // blow. The spoils are halved when the conquered player is Human. The
    // branch is on the *defender's type*, never on who is viewing, which
    // would give different clients different treasuries.
    if (attacker) {
      const spoils = defender.isHuman ? defender.gold / 2 : defender.gold;
      // Located before the carve-up below reassigns every tile.
      this.spoilsPopup(defender.tiles, spoils, attackerId);
      attacker.gold += spoils;
      defender.gold = 0;
    }

    // Several passes: a tile with no living neighbour this round may gain one
    // as the carve-up proceeds inward.
    for (let pass = 0; pass < 6 && defender.tiles.size; pass++) {
      let changed = false;
      for (const i of [...defender.tiles]) {
        let claim = -1;
        const n = GameMap.neighbors(i, nb);
        for (let k = 0; k < n; k++) {
          const o = GameMap.owner[nb[k]];
          if (o === attackerId) { claim = attackerId; break; }
          if (o >= 0 && o !== defenderId && claim < 0) claim = o;
        }
        if (claim >= 0) { this.setOwner(i, claim); changed = true; }
      }
      if (!changed) break;
    }
    // Anything still landlocked among its own kind falls to the attacker.
    for (const i of [...defender.tiles]) this.setOwner(i, attackerId);

    // This carve-up moves ownership in bulk, not through stepAttack's
    // per-tile losses, so the defender's troops are never spent down.
    // Left alone, a 0-tile nation would sit on troops regrowing toward
    // BASE_POP forever, alive with no defeat screen (the tick() sweep
    // only catches troops < 20). So it is finalized here, as in
    // annexRegion.
    defender.troops = 0;
    this.eliminatePlayer(defender);
  },

  stepAttack(a) {
    const attacker = this.players[a.attacker];

    // Ordered to retreat: no further conquest, just waiting out RETREAT_DELAY
    // before the survivors are handed back to the reserve.
    if (a.retreating) {
      if (this.elapsed < a.retreatAt) return true;
      const malus = a.target >= 0 ? this.ATTACK_RETREAT_MALUS : 0;
      attacker.troops += a.troops * (1 - malus);
      return false;
    }

    const defender = a.target >= 0 ? this.players[a.target] : null;
    const nb = this.nbuf;

    // A flat ATTACK_TICK_BUDGET this tick, spent tile by tile against
    // attackTickFraction. `progress` is a local: anything left over is
    // dropped, not carried into the next tick.
    //
    // The width a front is credited with wobbles a few tiles a tick, so
    // two pushes of identical size don't advance in step.
    const borderTiles = a.border.size + this.frontRand(a, 5);
    let progress = this.ATTACK_TICK_BUDGET;

    let guard = 20000;
    while (guard-- > 0) {
      // Checked at the TOP of the loop, NOT as a 'can I afford this
      // tile' gate before conquering. The first tile each tick is
      // always taken, whatever it costs; only a further tile the same
      // tick needs budget left. See the note at the conquest below.
      if (progress <= 0) break;

      // OpenFront's own top-of-loop test (`if (troopCount < 1) { attack.delete() }`).
      // A front runs out of troops here and nowhere else — see the tile-cost
      // charge below for why that distinction matters.
      if (a.troops < 1) break;
      if (a.heapTile.length === 0) break;

      // Best-scoring ground first — see frontierPriority: mostly how far the
      // line has already wrapped around this tile, nudged by terrain and a
      // per-tile roll, aged by the tick it was discovered on.
      const tile = a.heapTile[0];

      if (GameMap.owner[tile] !== a.target || this.drillDead[tile]) { a.border.delete(tile); this.heapPop(a); continue; }

      // The queue was built from a border that may have moved. Without
      // re-checking contact, the wave rolls on and leaves a disconnected
      // snake of territory. The entry is dropped; conquering a tile beside
      // it re-enqueues it, and refreshFrontier picks it up if the queue
      // runs dry.
      if (!this.touchesPlayer(tile, a.attacker)) { a.border.delete(tile); this.heapPop(a); continue; }

      // Skipped tiles cost no budget; only ground taken does.
      //
      // NOT gated on `progress >= move`: a narrow front, tough terrain or
      // a troop disadvantage can make the cheapest tile cost MORE than one
      // tick's flat budget, and with no carry-over a check-before-spend
      // gate would leave that tile, and so the whole front, permanently
      // stuck. One tile of progress per tick is guaranteed, and
      // `progress` may go negative, as `a.troops` does below.
      const move = this.attackTickFraction(attacker, defender, a.troops, GameMap.terrain[tile], tile, borderTiles);

      // Charged unconditionally, even when it overdraws the stack: the
      // front gets the tile it paid for, and the attack ends on the next
      // iteration. Bailing out when the stack couldn't afford one more
      // tile threw away the remaining force, worst inside a fort aura.
      const cost = this.tileCost(attacker, defender, a.troops, GameMap.terrain[tile], tile);

      this.heapPop(a);
      a.border.delete(tile);
      progress -= move;
      a.troops -= cost;
      if (defender) {
        defender.troops = Math.max(0, defender.troops - this.defenderLossPerTile(defender));
      }

      // Neighbours are scored BEFORE this tile changes hands. That
      // ordering is load-bearing: a tile whose only attacker-side
      // neighbour is the one being taken now scores numOwnedByMe = 0 and
      // goes to the back of the queue, while a flanked tile jumps the
      // line. That makes the edge reach out in fingers and fill in behind.
      //
      // No dedup set: a tile adjacent to three conquests is enqueued three
      // times, each with its own roll and a higher numOwnedByMe, and the
      // heap serves the best. `a.border` (the Set) is what the front's
      // width is read off, so duplicates never inflate the advance rate.
      const n = GameMap.neighbors(tile, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] === a.target && !this.drillDead[j]) {
          a.border.add(j);
          this.heapPush(a, j, this.frontierPriority(j, a));
        }
      }

      this.setOwner(tile, a.attacker);

      // No lower bound on purpose: the tile just taken was the defender's, so
      // a size of 0 means it was their last. Skipping that case stranded the
      // treasury of any nation that had regrown a lone tile after an earlier
      // kill (boats or attacks still in flight), and the spoils vanished.
      if (defender && defender.tiles.size <= this.DEAD_DEFENDER_TILES) {
        this.handleDeadDefender(a.target, a.attacker);
        break;
      }
    }

    // Same threshold as the loop's own check, so an attack left holding a
    // sub-troop remainder ends here rather than idling forever unable to buy a
    // tile. Math.max guards the overdraw the tile charge above now permits.
    if (a.troops < 1) {
      attacker.troops += Math.max(0, a.troops);
      return false;
    }

    // Queue spent but troops left: re-scan the live border and keep pressing.
    // Only when the two genuinely no longer touch does the attack end.
    if (a.heapTile.length === 0 && !this.refreshFrontier(a)) {
      attacker.troops += Math.max(0, a.troops);
      return false;
    }
    return true;
  },

  // Live attack fronts, used for both rendering and AI target scoring.
  frontierTilesOf(playerId) {
    let n = 0;
    for (const a of this.attacks) if (a.attacker === playerId) n += a.border.size;
    return n;
  },

});
