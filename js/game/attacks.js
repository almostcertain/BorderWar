// js/game/attacks.js — Attack lifecycle & conquest frontier.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // openfront.wiki/Retreating: ordered instantly by the X next to an attack,
  // but the troops don't actually leave the field for RETREAT_DELAY (their 20
  // ticks, 2s at 10/sec) — stepAttack stops conquering the moment this flips,
  // and the survivors return to the reserve once the timer runs out. Docked
  // ATTACK_RETREAT_MALUS if the front was pushing on another player; walking
  // away from empty land costs nothing.
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
  // `landmassId`, when given, scopes the whole thing to one landmass —
  // GameMap.landmassId's connected-component id, so two separate islands
  // always carry different values. A click on one island must not also push
  // on a front against the same enemy held on another island entirely, so
  // consolidation below only folds together attacks sharing the same
  // landmassId, and refreshFrontier only scans that landmass's border. This
  // is a deliberate deviation from OpenFront's own AttackExecution, which
  // consolidates across the attacker's whole border regardless of landmass.
  // `null` (the AI's own calls, which have no clicked tile to scope by, and
  // any legacy caller) keeps that original unscoped behaviour — it only ever
  // consolidates with, and scans borders alongside, other landmassId:null
  // attacks, never with a real landmass id.
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

    // Every existing attack against this target *on the same landmass*
    // consolidates into one shared siege pool: all of them fold their troops
    // into a single survivor, which then re-scans that landmass's current
    // border (refreshFrontier) so the combined pool pushes on every front it
    // touches there. A beachhead on another landmass entirely is left alone —
    // that is the fix for the island-bleed this used to have.
    // A retreating front is on its way out — folding a fresh push into it
    // would just re-arm troops already committed to leaving, so it's skipped
    // here and a brand new attack is opened alongside it instead.
    let survivor = null;
    for (let i = this.attacks.length - 1; i >= 0; i--) {
      const at = this.attacks[i];
      if (at.attacker !== attackerId || at.target !== targetId || at.retreating) continue;
      if (at.landmassId !== landmassId) continue;
      if (survivor === null) survivor = at;
      else { survivor.troops += at.troops; this.attacks.splice(i, 1); }
    }
    // The survivor is an existing attack object, mutated in place, so it keeps
    // the id it was born with — a fresh id here would silently invalidate every
    // cancel_attack already in flight against this front, which is the one
    // thing consolidation must not do. The attacks folded *into* it lose their
    // ids permanently; a cancel_attack naming one of those simply resolves to
    // nothing, on every client alike. See nextAttackId.
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
    if (targetId >= 0) this.provokeByAttack(attacker, this.players[targetId]);
    return true;
  },

  // Two nations pushing into each other are one battle, not two independent
  // ones. Their committed forces meet and destroy each other, so blunting an
  // attack costs the attacker the troops it stopped and whichever side has
  // anything left is the one still advancing. Without this the two pushes pass
  // straight through one another, each holding its full strength and each
  // drawing its own counter on the same stretch of border.
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

  // --- Conquest frontier: OpenFront's own priority queue -------------------
  // A plain FIFO advances in strict distance order, so the wave crosses a ridge
  // at the same moment it crosses a meadow and terrain only changes the bill.
  // A priority queue is what gives a front its shape instead — but *what* it is
  // ordered by is the whole question, and the answer is not accumulated cost
  // (that is a Dijkstra contour, which is what made these fronts read as rigid).
  // See frontierPriority for the local, non-accumulating score this is keyed on,
  // and note that the heap deliberately holds duplicate entries per tile.
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

  // Rebuilds an attack's queue from the attacker's *current* border with the
  // target. The queue is a snapshot of a border that moves under it, and a
  // slow advance drains it faster than conquests refill it, so without this an
  // attack aborts with most of its troops unspent and every front churns
  // without ever breaking. Returns false when the two no longer touch at all.
  //
  // Scans attacker.borderTiles (owned tiles with a non-owned neighbour, kept
  // live by setOwner/updateBorderTile) rather than every tile the attacker
  // owns — only a border tile can possibly neighbour the target, so this is
  // exactly equivalent, just perimeter-sized instead of area-sized. A launch
  // (or troop top-up) against a sprawling empire used to re-walk its entire
  // territory synchronously on every click; this is the fix for that hitch.
  refreshFrontier(a) {
    const attacker = this.players[a.attacker];
    const border = new Set(), nb = this.nbuf;
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
        if (GameMap.owner[j] === a.target) {
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

    // Spoils. The land is divided among every neighbour that touches it, but a
    // treasury cannot be split along a border — it goes whole to the nation
    // that landed the killing blow. That asymmetry is the point: a rival who
    // has been hoarding is worth finishing off yourself rather than leaving to
    // the vultures, and the reward for it arrives as gold, which the population
    // curve cannot claw back the way it does conquered land.
    // OpenFront's conquerGoldAmount halves the spoils specifically when the
    // player being conquered is Human — Bot/Nation kills pay out in full. So
    // the branch is on the *defender's type*, not on whether the defender is
    // the viewing client: with several humans in a lockstep match "the human"
    // is no longer a single id, and a per-viewer branch would hand different
    // clients different treasuries.
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

    // This carve-up is a shortcut around the normal tile-by-tile siege —
    // ownership moves in bulk via setOwner above, never through stepAttack's
    // per-tile defenderLossPerTile deduction — so unlike an ordinary kill,
    // troops here are never actually reduced to near-zero as tiles run out.
    // Left alone, a defender with any real reserve (e.g. most of it already
    // committed elsewhere, to a boat or another front, so the DEAD_DEFENDER_
    // TILES threshold triggered before combat spent it down) becomes a
    // 0-tile nation sitting on troops that regrow toward maxTroops' BASE_POP
    // floor forever: alive, but with nothing left to hold or retake — and no
    // defeat screen, since the tick() elimination sweep only catches troops
    // < 20. Finalized here instead, the same way annexRegion's wipe-out route
    // already has to (see its own comment) for the identical reason: no
    // combat to zero it out.
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
    // attackTickFraction until it runs out. `progress` is a plain local, not
    // a field on `a`: real AttackExecution.tick() resets its own `tickBudget`
    // fresh every tick too, so anything left over when the loop stops below
    // is simply dropped rather than carried into the next tick.
    //
    // OpenFront's own `attack.borderSize() + random.nextInt(0, 5)`: the width
    // a front is credited with wobbles a few tiles a tick, so two pushes of
    // identical size don't advance in lockstep with each other.
    const borderTiles = a.border.size + this.frontRand(a, 5);
    let progress = this.ATTACK_TICK_BUDGET;

    let guard = 20000;
    while (guard-- > 0) {
      // Real `while (tickBudget > 0)`: checked at the TOP of the loop, before
      // a tile is even looked at — NOT as a "can I afford this one" gate
      // before conquering it (that check used to sit right before the
      // conquest below; see the 2026-09-10 fix note there for why moving it
      // here is load-bearing, not cosmetic). One full tick's budget is spent
      // unconditionally on the very first tile every tick, however much that
      // tile costs, and only a SECOND tile this same tick is gated on budget
      // actually remaining.
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

      if (GameMap.owner[tile] !== a.target) { a.border.delete(tile); this.heapPop(a); continue; }

      // The queue was built from a border that may since have moved — a
      // counter-attack can retake the tiles this wave advanced through. Without
      // re-checking contact, the wave rolls on into enemy land and leaves a
      // disconnected snake of territory behind their front. The entry is simply
      // dropped (OpenFront's own `continue`): if the front fights its way back
      // into contact, conquering any tile beside this one re-enqueues it, and
      // refreshFrontier picks it up wholesale if the queue ever runs dry.
      if (!this.touchesPlayer(tile, a.attacker)) { a.border.delete(tile); this.heapPop(a); continue; }

      // Skipped tiles above cost no budget; only ground actually taken does.
      // attackTickFraction folds in terrain, the troop-ratio speed ramp, the
      // fort/fallout bonuses and border width all at once — see its own
      // comment for why that single division replaced this file's old
      // separate speed-ratio/fort/fallout multipliers.
      //
      // NOT gated on `progress >= move` here (2026-09-10 fix, after a user
      // report of pushes freezing solid with thousands of troops still
      // committed): a narrow front, tough terrain or a middling troop
      // disadvantage can easily cost MORE than one whole tick's flat budget
      // for even the single cheapest tile in queue, and since `progress`
      // resets to a flat 1 every tick with no carry-over (see above), a
      // check-before-spend gate here meant that tile — and every tile behind
      // it, since it's always back at the top of the heap — could never be
      // afforded, ever: not slow, just permanently stuck. Real
      // AttackExecution.tick() has no such gate either: it always conquers
      // whatever `toConquer.dequeue()` returns and only checks budget before
      // trying a FURTHER tile the same tick (the `progress <= 0` check at the
      // top of this loop) — guaranteeing at least one tile of progress every
      // tick a front has troops and contact, however expensive, and letting
      // `progress` go negative exactly the way `a.troops` already does below.
      const move = this.attackTickFraction(attacker, defender, a.troops, GameMap.terrain[tile], tile, borderTiles);

      // Charged unconditionally, even when it overdraws the stack. The old
      // guard here bailed with `if (a.troops < cost) { a.troops = 0; break; }`,
      // which deleted the entire remaining force the instant it could not
      // afford ONE more tile — OpenFront never does that. Theirs subtracts the
      // loss, lets troopCount go negative, and only ends the attack on the next
      // iteration's `troopCount < 1`. The gap is proportional to the per-tile
      // cost, so it was invisible on open ground (~11 troops thrown away) and
      // five times worse inside a fort aura (~55), i.e. it bit hardest exactly
      // where a push was already struggling. Now the front always gets the tile
      // it paid for and simply stops.
      const cost = this.tileCost(attacker, defender, a.troops, GameMap.terrain[tile], tile);

      this.heapPop(a);
      a.border.delete(tile);
      progress -= move;
      a.troops -= cost;
      if (defender) {
        defender.troops = Math.max(0, defender.troops - this.defenderLossPerTile(defender));
      }

      // Neighbours are scored BEFORE this tile changes hands, exactly as
      // OpenFront's tick() calls addNeighbors(tileToConquer) ahead of
      // conquer(). The ordering is load-bearing, not incidental: it means a
      // tile whose only attacker-side neighbour is the one being taken right
      // now scores numOwnedByMe = 0 and lands at the very back of the queue,
      // while a tile already flanked scores 2 or 3 and jumps the line. That
      // is what makes the edge reach out in fingers and fill in behind them
      // rather than advancing as one contour.
      //
      // No dedup set here either — OpenFront's toConquer holds duplicates on
      // purpose. A tile adjacent to three separate conquests is enqueued three
      // times, each with its own roll and a higher numOwnedByMe than the last,
      // and the heap serves the best of them. Re-scoring ground as the line
      // wraps around it is half of why pockets snap shut instead of lingering
      // as holes. `a.border` (the Set) is what the front's real width is read
      // off, so the duplicates never inflate the advance rate.
      const n = GameMap.neighbors(tile, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] === a.target) {
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
