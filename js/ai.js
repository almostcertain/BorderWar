// Bot behaviour: expansion, and — since alliances exist — diplomacy.
//
// OpenFront branches almost every diplomatic decision on a difficulty setting.
// This game has none yet, so every threshold below is their MEDIUM column,
// noted at each site so the rest can be filled in when difficulty arrives.
const AI = {
  // OpenFront's Relation enum is a banding of the raw [-100, 100] value:
  // < -50 Hostile, < 0 Distrustful, < 50 Neutral, >= 50 Friendly.
  DISTRUSTFUL: 0,
  FRIENDLY: 50,

  // Real OpenFront's own AI gives Tribes no special targeting priority (its
  // only Tribe-specific rule is the neutral-tile toll discount and the
  // human-only 20% defense discount ported into Game.tileCost) — this is a
  // deliberate gameplay tweak on top of that fidelity, not a port. Without it
  // Nations treat a weak, isolated Tribe as just another low-density
  // neighbour, competing on equal footing with juicier, better-defended
  // rival nations for attention — and since a Tribe's border is usually tiny
  // next to a real nation-vs-nation front, the `contact` term alone buries it
  // in that comparison almost every time, early game or late.
  //
  // First cut of this (2026-08-18) decayed the bonus all the way to 1x (none)
  // by 4 minutes in, on the theory that Tribes were purely an early-game land
  // grab. Verified in-browser that this was wrong on two counts: (1) a bot
  // locked in a long war only ever re-picks a target when that attack
  // resolves — measured 7 of 9 bots mid-attack while directly bordering a
  // live Tribe just 30s into a match — so a Tribe can easily still be sitting
  // there once the bonus has already expired; (2) with it fully expired,
  // scoring reverts to raw contact/density where a small-bordered Tribe
  // almost never outscores an established rival front, so it never gets
  // picked up even on a free cycle. Fix: the bonus now fades from a strong
  // kickoff bump down to a small PERMANENT floor instead of down to nothing,
  // so a lingering Tribe stays a mildly attractive pick for the rest of the
  // match rather than only the opening minutes. Deliberately not touching the
  // one-attack-at-a-time gate in think() — interrupting a real war just to
  // snipe a Tribe would be the "hard priority" behaviour this is explicitly
  // meant to avoid; it should pick one up as soon as that war frees it up
  // naturally.
  TRIBE_PRIORITY_BONUS: 2,        // up to 3x score at kickoff
  TRIBE_PRIORITY_FLOOR: 0.5,      // never decays below 1.5x, for the rest of the match
  TRIBE_PRIORITY_WINDOW: 240,     // linearly fades from kickoff bonus to the floor over 4 minutes

  update() {
    for (const p of Game.players) {
      if (!p.isBot || !p.alive) continue;

      p.nextThink -= Game.TICK_DT;
      if (p.nextThink <= 0) {
        p.nextThink = 2 + Game.rng() * 3;
        this.diplomacy(p);
        this.economy(p);
        this.think(p);
      }

      // Separate, slower cooldown: navalThink runs a sea-path BFS rather than
      // a cheap map scan, so it doesn't get to think on land's cadence.
      p.nextNavalThink -= Game.TICK_DT;
      if (p.nextNavalThink <= 0) {
        p.nextNavalThink = 15 + Game.rng() * 10;
        this.navalThink(p);
      }
    }
  },

  // 1-in-n, matching OpenFront's PseudoRandom.chance.
  chance(n) { return Game.rng() * n < 1; },
  pct() { return Math.floor(Game.rng() * 101); },   // 0..100, as nextInt(0, 100)
  range(lo, hi) { return lo + Math.floor(Game.rng() * (hi - lo)); },

  diplomacy(p) {
    this.handleRequests(p);
    this.handleExtensions(p);
    this.maybeBetray(p);
    this.maybeSendRequests(p);
  },

  handleRequests(p) {
    for (const req of Game.requests.filter(r => r.to === p.id)) {
      if (this.allianceDecision(p, Game.players[req.from], true)) Game.acceptAlliance(req);
      else Game.rejectAlliance(req);
    }
  },

  // Only answer a renewal the ally has already asked for. A bot never opens
  // the renewal itself, exactly as OpenFront's nations behave — whichever
  // side of the alliance p is (human or NPC), the *other* side has to make
  // the first move. Not human-specific: with more than one human in a match
  // this fires identically for every alliance a bot holds, human ally or not.
  handleExtensions(p) {
    for (const al of Game.alliances) {
      if (al.a !== p.id && al.b !== p.id) continue;
      if (!Game.awaitingExtension(al, p.id)) continue;
      const otherId = al.a === p.id ? al.b : al.a;
      if (this.allianceDecision(p, Game.players[otherId], true)) {
        Game.requestExtension(p.id, otherId);
      }
    }
  },

  maybeSendRequests(p) {
    for (const [targetId] of this.borderTargets(p)) {
      if (targetId < 0) continue;
      if (!this.chance(30)) continue;
      if (!Game.canRequestAlliance(p.id, targetId)) continue;
      if (!this.allianceDecision(p, Game.players[targetId], false)) continue;
      Game.requestAlliance(p.id, targetId);
    }
  },

  // OpenFront's getAllianceDecision, Medium column throughout. `isResponse` is
  // true when answering someone else's offer rather than opening one.
  allianceDecision(p, other, isResponse) {
    if (!other || !other.alive) return false;

    // Medium nations are confused 5% of the time, and then simply flip a coin.
    if (this.chance(20)) return this.chance(2);

    // Nearly always refuse a traitor. This is the sharpest edge of the betrayal
    // penalty: for half a minute nobody will deal with you.
    if (Game.isTraitor(other) && this.pct() >= 10) return false;

    // A neighbour with 2.5x our army is not someone to refuse.
    if (other.troops > p.troops * 2.5) return true;

    if (Game.relation(p, other.id) < this.DISTRUSTFUL) return false;
    if (Game.relation(p, other.id) >= this.FRIENDLY) return true;

    // Don't ally with the whole map.
    if (p.allies.size >= this.range(4, 6)) return false;

    // Early on, say yes to almost anyone: first 3 minutes, 70% of the time.
    if (Game.elapsed < 180 && this.pct() >= 30) return true;

    return this.similarlyStrong(p, other);
  },

  // Worth allying with if they bring comparable weight — measured on the whole
  // nation, marching troops included, so someone who has just committed an army
  // is not misread as weak.
  similarlyStrong(p, other) {
    const mine = Game.totalTroops(p), theirs = Game.totalTroops(other);
    const troopThreshold = mine * (this.range(70, 80) / 100);
    const tileThreshold = p.tiles.size * (this.range(80, 90) / 100);
    if (theirs > troopThreshold) return true;
    return other.tiles.size > tileThreshold && theirs > mine * 0.5;
  },

  // OpenFront's maybeBetray, Medium column: stab the helpless, stab a traitor
  // who cannot punish you for it, and stab your last neighbour when the map is
  // otherwise yours.
  maybeBetray(p) {
    if (p.allies.size === 0) return;
    const borderCount = [...this.borderTargets(p, true).keys()].filter(id => id >= 0).length;

    for (const allyId of [...p.allies]) {
      const other = Game.players[allyId];
      if (!other || !other.alive) continue;

      // Medium's weak-ally test is the blunt one — ten times their army. The
      // sharper maxTroops-aware version is Hard and Impossible only, and
      // triggers far more often, so using it here would make bots backstab at
      // roughly the rate their hardest difficulty does.
      const helpless = p.troops >= other.troops * 10;
      const stabbable = Game.isTraitor(other) && other.troops < p.troops * 1.2;
      const alone = borderCount === 1 && other.troops * 3 < p.troops;

      if (helpless || stabbable || alone) {
        Game.breakAlliance(p.id, allyId);
        return;   // one betrayal per think; two at once reads as a bug
      }
    }
  },

  // Bots have to spend, or the human is the only nation on the map whose cap
  // ever grows and the build menu is a straight handout. Buy whenever it is
  // affordable: the price doubling with each one owned is already the rate
  // limiter, and nothing else competes for the money yet. When it does — a silo
  // is worth saving for in a way a fourth city is not — this becomes a choice
  // rather than a reflex.
  //
  // Cost-pooled types (Port/Factory share one price — see their UNITS entry)
  // need special handling here: a straight walk over Game.UNITS tries one
  // member of the pool before the other every single cycle, and building it
  // immediately doubles the shared price for the rest of this same call —
  // pricing its sibling out before it ever gets a turn. Left that way, bots
  // build only whichever pool member happens to come first in Game.UNITS and
  // never touch the other at all (measured live: 8 Factories / 0 Ports —
  // see project memory). Picking whichever pool member the bot currently
  // owns fewer of, instead of a fixed member, makes purchases alternate
  // between them as the shared price climbs rather than fixating on one.
  // How many separate SAM Launchers to plant for territorial coverage before
  // further spend switches to leveling up the weakest one instead — see
  // economy()'s own comment on why charges (per-structure) matter more past
  // that point than range (which barely moves per level anyway). Not an
  // OpenFront difficulty column port — their AI files weren't scoped for
  // this session, same disclaimer as TRIBE_PRIORITY_BONUS/maybeNuke above —
  // just a number small enough to spread a couple of launchers across a
  // nation's coastline/border before committing to upgrades.
  SAM_COVERAGE_TARGET: 2,

  // --- Strategic savings ---------------------------------------------------
  // economy() below buys whatever it can afford as it walks Game.UNITS, and
  // that alone is enough to put the entire Silo/nuke/SAM half of the tech
  // tree permanently out of a bot's reach. Fort is the culprit: its price is
  // LINEAR and capped at 250k (see its UNITS entry), and fortSite() finds a
  // fresh border tile essentially forever, so a mature nation buys another
  // Fort every time its treasury crosses 250k and never climbs past it.
  // Measured headless over a 20-minute, 9-bot large-map match before this
  // change: 230 Forts for 52.9M gold — 69% of all bot spending — median bot
  // treasury peaking at 60k against a 1M Silo, and across every seed tried,
  // zero Silos, zero SAM Launchers and zero nukes launched, ever. Bots
  // weren't declining to go nuclear; they were structurally incapable of it.
  //
  // Two fixes, both here rather than in the cost table (prices are ported
  // from OpenFront's Config.ts and shouldn't be retuned to paper over an AI
  // problem):
  //
  //   (a) FORT_CAP_BASE below bounds the Fort sink, so a treasury can grow.
  //   (b) savingsGoal()/savingsReserve() give the bot ONE big-ticket item it
  //       is currently saving for and forbid every cheaper purchase from
  //       eating into that reserve — the "when it does [compete for the
  //       money], this becomes a choice rather than a reflex" the economy()
  //       comment above has been anticipating.
  //
  // Forts protect what a nation has built, so their cap scales with what
  // there is to protect rather than with raw territory: a bot may hold this
  // many Forts plus one per City it owns. Generous enough that a big nation
  // still fortifies a real front (a 9-city nation gets 11), tight enough that
  // Fort stops being an infinite hole in the budget.
  FORT_CAP_BASE: 2,

  // Don't start hoarding for a 1M Silo out of a two-city economy — the pause
  // in City/Factory/Port growth would cost more than the missile is worth,
  // and maxTroops keys off City level, so a bot that stops developing stops
  // being able to fight at all. Three cities is roughly where a bot's income
  // (flat GOLD_PER_SEC plus train/trade-ship lumps) can refill a reserve
  // without freezing everything else for the rest of the match.
  SILO_MIN_CITIES: 3,

  // Which single big-ticket purchase this bot is currently banking toward, or
  // null for "nothing — spend freely." Strictly ordered, one goal at a time:
  // a bot that tried to save for a Silo and a SAM at once would reserve 2.5M
  // and never buy either.
  //
  //   1. Silo first. Without one, no nuke of any kind can ever be launched
  //      (resolveNukeLaunch rejects outright), and it's the gate on the whole
  //      branch.
  //   2. Then SAM cover, but only once somebody else's Silo actually exists
  //      to defend against — a launcher bought before anyone can nuke you is
  //      1.5M spent on nothing. Capped at SAM_COVERAGE_TARGET, matching the
  //      coverage-then-upgrade rule economy() already applies.
  //   3. Otherwise keep an Atom Bomb's price in the bank permanently, so a
  //      built Silo is an armed Silo. Without this the bot buys the Silo,
  //      immediately spends the next 250k it sees on a Fort, and the launcher
  //      sits empty — which is exactly the failure this whole block exists to
  //      stop, one rung further up the ladder.
  //
  // All three counts come off ONE walk of Game.buildings rather than the two
  // countBuilt() calls plus a separate rival scan the obvious spelling would
  // make: this runs per bot per economy() cycle, and countBuilt is already a
  // whole-map walk on its own. The rival count includes the human's Silos —
  // "who can nuke me" has nothing to do with who is a bot.
  savingsGoal(p) {
    if (Game.unitsOwned(p, 'city') < this.SILO_MIN_CITIES) return null;

    let ownSilos = Game.unitsPending(p, 'silo');
    let ownSams = 0, rivalSilos = 0;
    for (const b of Game.buildings.values()) {
      if (!b.built) continue;
      const owner = GameMap.owner[b.tile];
      if (b.type === 'silo') {
        if (owner === p.id) ownSilos++;
        else if (owner >= 0 && !Game.areAllied(p.id, owner)) rivalSilos++;
      } else if (b.type === 'sam' && owner === p.id) {
        ownSams++;
      }
    }

    if (ownSilos < 1) return 'silo';
    if (rivalSilos > 0 && ownSams < this.SAM_COVERAGE_TARGET) return 'sam';
    return 'atombomb';
  },

  savingsReserve(p, goal) {
    return goal ? Game.unitCost(p, goal) : 0;
  },

  economy(p) {
    // The one thing this bot is banking toward, and the treasury floor every
    // OTHER purchase below has to respect — see savingsGoal's comment. The
    // goal type itself is exempt (its reserve IS its price), so the branch
    // that finally buys it isn't blocked by its own savings.
    const goal = this.savingsGoal(p);
    const reserve = this.savingsReserve(p, goal);
    const spendable = t => p.gold - (t === goal ? 0 : reserve);

    const consideredTypes = new Set();
    for (const u of Game.UNITS) {
      // Warship/AtomBomb/HydrogenBomb (see their own UNITS entries'
      // `action: true`) never land on a land tile via buildBlockReason/
      // build — each gets its own dedicated purchase call below instead.
      // Silo has no flag: it's an ordinary territory-bound structure like
      // City/Factory/Port/Fort, so it rides this generic loop and
      // buildSite(p) (the ternary below's fallback) same as they do.
      if (u.action) continue;
      if (consideredTypes.has(u.type)) continue;
      const pool = u.costGroup || [u.type];
      for (const t of pool) consideredTypes.add(t);

      let type = pool[0];
      if (pool.length > 1) {
        let bestOwned = Infinity;
        for (const t of pool) {
          const owned = Game.unitsOwned(p, t) + Game.unitsPending(p, t);
          if (owned < bestOwned) { bestOwned = owned; type = t; }
        }
      }

      // Forts, Silos, and SAM Launchers are only worth building once there's
      // at least one city to defend/support — a Silo in particular is the
      // single most expensive flat-cost purchase in the game (1M, same as a
      // maxed-out City), and a SAM Launcher's own 1.5M starting price is
      // higher still, neither worth a fresh nation's very first gold.
      if ((type === 'fort' || type === 'silo' || type === 'sam') && Game.unitsOwned(p, 'city') < 1) continue;

      // Fort's own cap — see FORT_CAP_BASE. Checked before the price test so
      // a built-out nation's Fort gold is left in the treasury for the
      // savings goal instead of being handed to a 231st Defense Fort.
      if (type === 'fort' &&
          this.countBuilt(p, 'fort') + Game.unitsPending(p, 'fort') >=
            this.FORT_CAP_BASE + Game.unitsOwned(p, 'city')) continue;

      if (spendable(type) < Game.unitCost(p, type)) continue;

      // SAM's real payoff past its first couple of launchers is charges, not
      // range: samRange(level) asymptotes almost immediately (level 1→2 gains
      // barely a tile), but a SAM's samQueue cap IS its level — a level-2 SAM
      // can shoot down two converging nukes without waiting on SAM_COOLDOWN,
      // a level-1 one can't (see stepSAMs/dynamicSamRange). buildSite alone
      // never surfaces that: on any nation past a trivial size it keeps
      // finding a fresh tile every cycle, so bots would scatter unlimited
      // lone level-1 SAMs and never once upgrade one — real coverage, but
      // no nation ever gets a SAM that can actually stop a two-nuke strike.
      // Once SAM_COVERAGE_TARGET launchers already give the territory
      // spread, further SAM spend concentrates on leveling up the weakest
      // one instead of planting yet another single-charge launcher.
      if (type === 'sam' && this.countBuilt(p, 'sam') >= this.SAM_COVERAGE_TARGET) {
        // Unconditional continue, even when nothing is upgradable THIS cycle
        // (every SAM already mid-upgrade) — falling through to buildSite
        // below would otherwise plant a fresh 3rd/4th/... SAM the moment the
        // existing ones are all busy, defeating the whole point of capping
        // structure count in favor of levels.
        const upgradeTile = this.weakestBuilt(p, 'sam');
        if (upgradeTile >= 0 && Game.canUpgrade(p.id, upgradeTile)) Game.upgrade(p.id, upgradeTile);
        continue;
      }

      const tile = type === 'fort' ? this.fortSite(p) : type === 'port' ? this.portSite(p) : this.buildSite(p);
      if (tile >= 0) Game.build(p.id, type, tile);
      // No fresh site at all (a small/landlocked/built-out nation) but the
      // type still has room to grow in place — upgrade the weakest one
      // rather than leaving this cycle's gold unspent. Fort/Silo/Warship/
      // the bombs are all upgradable:false, so this only ever fires for
      // City/Factory/Port/SAM, and never fights the branch above for SAM.
      else if (Game.unitDef(type).upgradable) {
        const upgradeTile = this.weakestBuilt(p, type);
        if (upgradeTile >= 0 && Game.canUpgrade(p.id, upgradeTile)) Game.upgrade(p.id, upgradeTile);
      }
    }

    // Warship/AtomBomb/HydrogenBomb are `action: true` (see the loop's own
    // comment above) — none of them land in Game.buildings, so each needs
    // its own site/target selection and its own purchase call rather than
    // the generic build() the loop above uses. A Port is a hard requirement
    // for Warship (per Game.resolveWarshipLaunch's own comment — a
    // deliberate user design request, not an OpenFront fidelity thing),
    // checked here too so a bot without one skips straight past instead of
    // wasting a coastalTiles scan on a purchase that's going to fail anyway.
    if (Game.unitsOwned(p, 'port') >= 1 && spendable('warship') >= Game.unitCost(p, 'warship') &&
        Game.warships.filter(w => w.owner === p.id).length < Game.MAX_WARSHIPS_PER_PLAYER) {
      const site = this.warshipSite(p);
      if (site >= 0) Game.buildWarship(p.id, site);
    }

    this.maybeNuke(p);
  },

  // A bot with a ready Silo and a warhead's worth of gold banked (see
  // savingsGoal — keeping that gold banked is what makes this reachable at
  // all) occasionally fires an Atom Bomb at whichever rival it currently
  // borders/fights the most, using the same `contact` signal think() already
  // computes via borderTargets. Tribes and neutral land are skipped: a
  // Tribe's whole army is already Fort/Warship-tier cheap to just walk over,
  // and nuking unclaimed land destroys nothing worth destroying. Gated at
  // 1-in-8 per economy() cycle (which itself runs every 2-5s per bot) so a
  // bot with a ready Silo doesn't nuke on literally the first opportunity
  // every time.
  //
  // Still not a port of OpenFront's own nuke-targeting AI (Config.ts/the bot
  // behaviour files have real troop-cluster alertness scoring for this that
  // wasn't part of this session's scope), but no longer a blind random tile
  // either — nukeTarget() below aims at the target's own hardware, which is
  // the part that actually made a strike feel deliberate rather than random
  // when watched.
  //
  // Hydrogen Bomb chance, on top of the base 1-in-8: it's 6.67x the Atom
  // Bomb's price (5M vs 750k) for 3.3x the outer blast radius (see
  // NUKE_MAGNITUDES), so it only pays for itself against a rival with enough
  // territory/troops for that radius to actually land on something —
  // dropped on a nation the size of a Tribe it would mostly detonate over
  // empty conquered dirt. HYDROGEN_WORTHY below gates on the target
  // outweighing the bot itself; this chance then further rations it so a
  // flush bot doesn't reach for the biggest bomb every single time the
  // worthy-target condition holds.
  HYDROGEN_NUKE_CHANCE: 4,

  maybeNuke(p) {
    if (p.gold < Game.unitCost(p, 'atombomb')) return;
    // hasReadySilo() rather than the cheaper unitsOwned(p, 'silo') check this
    // replaced, for two reasons. It tests SILO_COOLDOWN as well as ownership,
    // so a reloading Silo doesn't burn the 1-in-8 roll below on a
    // launchNuke() that can only return false. And it reads the real
    // buildings map instead of the p.units running total, which is observably
    // capable of going NEGATIVE (seen headless: a bot ending a match at
    // units.silo === -1 while still holding land) — an unrelated bookkeeping
    // bug in setOwner's capture/destroy accounting, but one that would
    // silently disarm a bot's Silo for the rest of the match if this gate
    // depended on that counter.
    if (!this.hasReadySilo(p)) return;
    if (!this.chance(8)) return;

    let best = -1, bestContact = 0;
    for (const [targetId, contact] of this.borderTargets(p)) {
      if (targetId < 0) continue;
      const t = Game.players[targetId];
      if (!t || !t.alive || t.isTribe) continue;
      if (contact > bestContact) { bestContact = contact; best = targetId; }
    }
    if (best < 0) return;

    const target = Game.players[best];
    const targetTile = this.nukeTarget(target);
    if (targetTile < 0) return;

    const hydrogenWorthy = target.tiles.size > p.tiles.size || target.troops > p.troops;
    const type = hydrogenWorthy && p.gold >= Game.unitCost(p, 'hydrogenbomb') && this.chance(this.HYDROGEN_NUKE_CHANCE)
      ? 'hydrogenbomb' : 'atombomb';
    Game.launchNuke(p.id, type, targetTile);
  },

  // At least one owned, completed, off-cooldown Silo — the same test
  // resolveNukeLaunch applies, checked here so maybeNuke can bail before
  // spending its 1-in-8 roll.
  hasReadySilo(p) {
    for (const b of Game.buildings.values()) {
      if (b.type !== 'silo' || !b.built) continue;
      if (GameMap.owner[b.tile] !== p.id) continue;
      if (Game.elapsed - b.lastLaunchAt >= Game.SILO_COOLDOWN) return true;
    }
    return false;
  },

  // Where to actually put the warhead. A nuke's whole value is what the blast
  // destroys — structures change hands with the ground and die with it — so
  // aim at the target's own hardware rather than a uniformly random tile of a
  // nation that may be 90% empty conquered dirt. Ranked by what hurts most to
  // lose: their Silo first (it's the only thing that can nuke back), then
  // their SAM cover (removing it clears the way for the next strike), then
  // the economy. Jittered so a nation under repeated fire doesn't eat every
  // warhead on the same tile — and deliberately NOT a full scoring pass over
  // blast-radius contents, which is the OpenFront-fidelity version this still
  // isn't.
  //
  // Falls back to a random owned tile when the target has nothing built,
  // which is also the pre-existing behaviour for every target.
  NUKE_TARGET_PRIORITY: { silo: 4, sam: 3, city: 2, factory: 1, port: 1 },

  nukeTarget(target) {
    let best = -1, bestScore = 0;
    for (const b of Game.buildings.values()) {
      if (!b.built) continue;
      if (GameMap.owner[b.tile] !== target.id) continue;
      const weight = this.NUKE_TARGET_PRIORITY[b.type] || 0;
      if (weight === 0) continue;
      // Jitter is strictly smaller than one priority step, so it shuffles
      // between equally-valuable targets without ever letting a Port outrank
      // a Silo.
      const score = weight * 4 + Math.floor(Game.rng() * 4);
      if (score > bestScore) { bestScore = score; best = b.tile; }
    }
    if (best >= 0) return best;

    if (target.tiles.size === 0) return -1;
    let n = Math.floor(Game.rng() * target.tiles.size);
    for (const t of target.tiles) if (n-- <= 0) return t;
    return -1;
  },

  // Inland by preference: a city on the front line is a gift to whoever takes
  // that tile, since structures change hands with the ground. Sampled rather
  // than scanned — a large nation owns thousands of tiles and this runs on
  // every bot's think.
  buildSite(p) {
    if (p.tiles.size === 0) return -1;
    let fallback = -1;
    for (let attempt = 0; attempt < 10; attempt++) {
      const tile = this.sampleTile(p);
      if (tile < 0 || Game.buildings.has(tile)) continue;
      if (fallback < 0) fallback = tile;
      if (this.isInterior(p, tile)) return tile;
    }
    return fallback;
  },

  // Fort placed exactly on the front line was found to die for free: the
  // instant the enemy took a single tile it stood on, it was destroyed
  // before its protection bonus ever mattered (a fort is destroyed, not
  // captured, when its tile changes hands — see Game.setOwner's fort
  // branch). Set back fortBorderBuffer() tiles from
  // the border/coast instead — still border-adjacent by preference (the
  // opposite of buildSite's interior bias) so it covers contested ground
  // with its protection radius, just no longer the literal first tile lost.
  // The defense/speed bonus doesn't stack (Game.fortInRange is a boolean
  // "any fort in range", not a count), so a second fort inside an existing
  // one's radius buys nothing but wastes gold and a build slot — skip
  // any candidate tile already covered, built or still under construction.
  //
  // The setback is a FRACTION of the protection radius, not the flat 4 tiles
  // this held while Game.fortRange() was a flat 30. Those two numbers are the
  // same knob read twice: the buffer buys survivability by trading away
  // forward coverage, and 4/30 is the ratio that was tuned. Left absolute, a
  // medium-map fort (radius 7.5) set back 4 tiles would reach only 3.5 tiles
  // past the border — a bot spending up to 250k gold on an aura that covers
  // essentially none of the ground being fought over. Scaled, xlarge still
  // gets exactly 4 and the smaller sizes get 1-2.
  FORT_BUFFER_RATIO: 4 / 30,

  fortBorderBuffer() {
    return Math.max(1, Math.round(Game.fortRange() * this.FORT_BUFFER_RATIO));
  },

  fortSite(p) {
    if (p.tiles.size === 0) return -1;
    const buffer = this.fortBorderBuffer();
    let fallback = -1;
    let fallbackDepth = -1;
    for (let attempt = 0; attempt < 15; attempt++) {
      const tile = this.sampleTile(p);
      if (tile < 0 || Game.buildings.has(tile)) continue;
      if (Game.fortInRange(tile, p.id, true)) continue;
      // How many full rings of owned tiles surround this candidate, capped
      // at the buffer — small nations that don't own enough depth anywhere
      // still get their best available candidate via fallbackDepth rather
      // than skipping the fort entirely.
      const depth = this.interiorDepth(p, tile, buffer);
      if (depth > fallbackDepth) { fallback = tile; fallbackDepth = depth; }
      if (depth >= buffer) return tile;
    }
    return fallback;
  },

  // Coastal by requirement, not preference — a Port only ever succeeds on a
  // tile that actually touches water (Game.buildBlockReason), so this can't
  // reuse buildSite's random-tile-then-filter-for-interior approach: on a
  // large empire, coastal tiles can be a small fraction of the total, and
  // blind random sampling missed often enough in testing that bots
  // effectively never built a Port at all. Reuses navalThink's own real
  // (if capped) coastalTiles() scan instead, which finds actual coastal
  // tiles deterministically rather than hoping a handful of random picks
  // land on one.
  portSite(p) {
    for (const t of this.coastalTiles(p)) {
      if (!Game.buildings.has(t)) return t;
    }
    return -1;
  },

  // Picks a sensible coastal destination to send a new Warship toward — not
  // where it launches from any more (Game.resolveWarshipLaunch always picks
  // the nearest owned Port for that part). Reuses the same real
  // coastalTiles() scan portSite does (blind random sampling misses the
  // coast too often on a large empire, per that function's own comment),
  // then snaps each candidate shore tile out onto the nearest actual open
  // water touching it.
  warshipSite(p) {
    for (const t of this.coastalTiles(p)) {
      const water = Game.nearestOwnedWaterNear(p.id, t, Game.WARSHIP_SNAP_MAX_DIST);
      if (water >= 0) return water;
    }
    return -1;
  },

  // How many completed structures of `type` p currently owns — distinct from
  // Game.unitsOwned, which sums LEVELS rather than counting placements (see
  // the UNITS comment in game.js on why). Needed wherever a per-STRUCTURE
  // effect (SAM's charge slots) has to be told apart from a per-LEVEL sum
  // that prices identically either way.
  countBuilt(p, type) {
    let n = 0;
    for (const b of Game.buildings.values()) {
      if (b.type === type && b.built && GameMap.owner[b.tile] === p.id) n++;
    }
    return n;
  },

  // The owned, completed, not-already-upgrading structure of `type` with the
  // lowest level — spending an upgrade here first keeps a nation's set of
  // that type from ending up with one maxed one and the rest permanently
  // stuck at level 1.
  weakestBuilt(p, type) {
    let best = -1, bestLevel = Infinity;
    for (const b of Game.buildings.values()) {
      if (b.type !== type || !b.built || b.upgrading) continue;
      if (GameMap.owner[b.tile] !== p.id) continue;
      if (b.level < bestLevel) { bestLevel = b.level; best = b.tile; }
    }
    return best;
  },

  sampleTile(p) {
    let n = Math.floor(Game.rng() * p.tiles.size);
    for (const t of p.tiles) if (n-- <= 0) return t;
    return -1;
  },

  isInterior(p, tile) {
    const nb = Game.abuf;
    const n = GameMap.neighbors(tile, nb);
    if (n < 4) return false;                   // coast or map edge
    for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] !== p.id) return false;
    return true;
  },

  // Ring-by-ring BFS out from `tile`, counting how many full rings stay
  // entirely owned by `p` before hitting a non-owned tile or the map edge
  // (fortSite's border/coast signal), capped at `cap` since callers only
  // care up to their required buffer depth. Distinct from isInterior above
  // (a single-ring yes/no used by buildSite) — fortSite needs the actual
  // depth so it can still rank a too-small nation's best-available site
  // instead of only ever getting a hard yes/no at one fixed radius.
  interiorDepth(p, tile, cap) {
    const nb = Game.abuf;
    let ring = [tile];
    const seen = new Set(ring);
    let depth = 0;
    while (depth < cap) {
      const next = [];
      for (const t of ring) {
        const n = GameMap.neighbors(t, nb);
        if (n < 4) return depth;                // coast or map edge
        for (let k = 0; k < n; k++) {
          const nt = nb[k];
          if (GameMap.owner[nt] !== p.id) return depth;
          if (!seen.has(nt)) { seen.add(nt); next.push(nt); }
        }
      }
      ring = next;
      depth++;
    }
    return depth;
  },

  // Update (2026-08-19): live-tested TRIBE_PRIORITY_BONUS/FLOOR alone and it
  // still wasn't enough — watched a match at the 5-6 minute mark with a dozen
  // Tribes still unconquered, all money left on the table. Root cause wasn't
  // the scoring, it was that scoring never runs at all: most bots by then are
  // already committed to a nation-vs-nation war, and the one-attack-total gate
  // (previously `if (Game.attacks.some(a => a.attacker === p.id)) return;`)
  // means think() bails before it ever compares targets, so a directly-
  // bordering Tribe can sit there for the entire length of that war.
  //
  // The 2026-08-18 note above deliberately left that gate alone, reasoning
  // that yanking a bot off a real war to chase a Tribe would be the "hard
  // priority" behaviour the fading bonus was explicitly designed to avoid.
  // Still agree with that for nation-vs-nation fights. The gap is that
  // avoiding a hard interrupt doesn't require a single global gate — a bot
  // can keep its main war attack fully intact and *also* run one small,
  // separately-funded skirmish against a bordering Tribe, the way a real
  // nation garrisons its main front while a reserve column mops up a weak
  // neighbour elsewhere. That's what tribeAttackActive/atWar below implement:
  // still at most one attack against any given Tribe at a time (no stacking),
  // and a Tribe skirmish is sized off current reserves at TRIBE_SKIRMISH_RATIO
  // rather than the normal 55%, so it can't gut the main war's troop pool.
  //
  // To reverse this and go back to strict one-attack-total: delete the
  // tribeAttackActive/atWar block below and restore the single line
  // `if (Game.attacks.some(a => a.attacker === p.id)) return;` right after
  // the p.tiles.size check.
  TRIBE_SKIRMISH_RATIO: 0.2,   // vs. the normal 0.55 for a fresh nation attack

  think(p) {
    if (p.tiles.size === 0) return;
    if (p.troops < Game.maxTroops(p) * 0.35) return;

    const myAttacks = Game.attacks.filter(a => a.attacker === p.id);
    // Never stack a second attack on the same Tribe — or a second Tribe
    // skirmish at all — while one is still resolving.
    if (myAttacks.some(a => Game.players[a.target] && Game.players[a.target].isTribe)) return;
    // True once *any* other attack (nation war or neutral land grab) is
    // already in flight — the case that used to block think() outright.
    const atWar = myAttacks.length > 0;

    const targets = this.borderTargets(p);
    if (targets.size === 0) return;

    let best = null, bestScore = -Infinity;
    for (const [targetId, contact] of targets) {
      // Mid-war, this cycle exists only to look for a Tribe side-skirmish —
      // the main front is untouched and re-evaluated on its own next cycle.
      if (atWar && !(targetId >= 0 && Game.players[targetId].isTribe)) continue;
      let score;
      if (targetId === NEUTRAL) {
        score = contact * 1.4;
      } else {
        const t = Game.players[targetId];
        const myDensity = p.troops / Math.max(1, p.tiles.size);
        const theirDensity = t.troops / Math.max(1, t.tiles.size);
        // Prefer weak, softly-defended neighbours; avoid suiciding into a bigger army.
        score = contact * (myDensity / Math.max(0.5, theirDensity)) * 0.9;
        if (theirDensity > myDensity * 1.6) score *= 0.15;
        // A traitor is cheaper and quicker to carve up, and everyone knows it.
        if (Game.isTraitor(t)) score *= 2;
        // Grudges steer aggression: someone who betrayed you, or betrayed a
        // neighbour of yours, becomes the obvious next target.
        if (Game.relation(p, targetId) < 0) score *= 1.5;
        if (t.isTribe) score *= this.tribePriorityMult();
      }
      if (score > bestScore) { bestScore = score; best = targetId; }
    }

    if (best === null) return;
    if (this.annexIfEnclosed(p, best)) return;
    const ratio = atWar ? this.TRIBE_SKIRMISH_RATIO : (best === NEUTRAL ? 0.35 : 0.55);
    Game.launchAttack(p.id, best, Math.floor(p.troops * ratio));
  },

  // Naval counterpart to think(): same weak-neighbour / neutral-bonus /
  // traitor-bonus scoring, but there's no "border contact count" for a beach
  // reachable only by sea, so a landmass's total size stands in for it —
  // both are a proxy for how much is worth having, and this keeps a big
  // island preferred over a speck without inventing a second scoring model.
  //
  // Checked against OpenFront's actual AiAttackBehavior.ts: its own overseas
  // targeting (findNearestIslandEnemy) explicitly sorts candidates by
  // distance from the player's centre and picks the nearest one almost every
  // time — only a 33% chance to fall back to the 2nd-nearest of the first two
  // REACHABLE candidates, never further. It never just takes the single
  // highest-value target on the whole map regardless of range. This game's
  // opportunity/density scoring originally had no distance term at all, so a
  // big weak landmass clear across the map always beat an equally-good one
  // next door — the "boats to seemingly random distant lands" behaviour.
  // navalDistanceFactor fixes that by discounting a candidate's score the
  // farther its beach is from any of the player's own coastal tiles; see
  // navalScore. It's a soft bias rather than a hard cutoff (real OpenFront
  // isn't a hard cutoff either), so a bot with nothing worthwhile nearby can
  // still cross open ocean for a genuinely good target.
  //
  // Only the top NAVAL_CANDIDATES beaches (by that opportunity score) get the
  // actual sea-path BFS, since that's the expensive part and most bots have
  // several landmasses in view at once.
  NAVAL_CANDIDATES: 3,

  // Ranking-time distance is straight-line (see nearestDist), not a real sea
  // route — cheap enough to run for every candidate landmass. Cap how many of
  // the player's own coastal tiles feed that estimate so a sprawling empire's
  // navalThink stays bounded; it's only ever used to rank candidates, not to
  // pick the exact launch point (launchNavalInvasion does that separately).
  NAVAL_COAST_SAMPLE_CAP: 40,

  // A real sea route can be far longer than straight-line distance suggests
  // — hugging around a peninsula or the whole far side of a continent to
  // reach a beach that looked close on the map. isRouteTooIndirect catches
  // that case (the actual "wraps around the continent" symptom) by comparing
  // the real seaPath length against the straight-line estimate that ranked
  // it, after distance-scoring already filtered the field down to a handful
  // of plausible candidates.
  NAVAL_MAX_DETOUR: 2.5,

  navalThink(p) {
    if (p.tiles.size === 0) return;
    if (p.troops < Game.maxTroops(p) * 0.35) return;
    if (Game.boats.filter(b => b.attacker === p.id).length >= Game.MAX_BOATS_PER_PLAYER) return;

    const homeCoast = this.coastalTiles(p);
    if (homeCoast.length === 0) return;

    const candidates = [];
    for (const lm of GameMap.landmasses) {
      let bestTile = -1, bestTileScore = -Infinity, bestTarget = -1;
      for (const tile of lm.coastSample) {
        const owner = GameMap.owner[tile];
        if (owner === p.id || p.allies.has(owner)) continue;
        // Same landmass we already hold ground on — think() already handles
        // this as a land target (its own conquest wave will reach it over
        // time even before it's directly bordered), so routing a boat there
        // too would just waste one.
        if (Game.onSameLandmass(p.id, tile)) continue;
        const dist = this.nearestDist(homeCoast, tile);
        const score = this.navalScore(p, owner, lm.size, dist);
        if (score > bestTileScore) { bestTileScore = score; bestTile = tile; bestTarget = owner; }
      }
      if (bestTile >= 0) candidates.push({ tile: bestTile, target: bestTarget, score: bestTileScore });
    }
    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.score - a.score);

    // OpenFront's boatAttackAmount default — a flat 20% of current troops,
    // used consistently for both neutral and enemy targets (its AI's own
    // attackWithRandomBoat/sendBoatAttack both compute troops/5 verbatim).
    const troops = Math.floor(p.troops / 5);
    for (const c of candidates.slice(0, this.NAVAL_CANDIDATES)) {
      if (this.isRouteTooIndirect(p, homeCoast, c.tile)) continue;
      if (Game.launchNavalInvasion(p.id, c.tile, troops)) return;
    }
  },

  navalScore(p, targetId, opportunity, dist) {
    const distFactor = this.navalDistanceFactor(dist);
    if (targetId === NEUTRAL) return opportunity * 1.4 * distFactor;
    const t = Game.players[targetId];
    if (!t || !t.alive) return -Infinity;
    const myDensity = p.troops / Math.max(1, p.tiles.size);
    const theirDensity = t.troops / Math.max(1, t.tiles.size);
    let score = opportunity * (myDensity / Math.max(0.5, theirDensity)) * 0.9;
    if (theirDensity > myDensity * 1.6) score *= 0.15;
    if (Game.isTraitor(t)) score *= 2;
    if (Game.relation(p, targetId) < 0) score *= 1.5;
    if (t.isTribe) score *= this.tribePriorityMult();
    return score * distFactor;
  },

  // 1 at dist=0, fading to 0.5 at "comfortable raiding range" (scaled off the
  // current map's own dimensions, so the bias means the same thing on a 250-
  // wide small map as a 2000-wide xlarge one) and asymptoting toward 0 well
  // beyond that — a soft discount, not a hard range cap, matching how real
  // OpenFront's own overseas targeting stays nearest-biased without ever
  // being strictly forbidden from a long crossing.
  navalDistanceFactor(dist) {
    const comfort = (GameMap.width + GameMap.height) * 0.08;
    return comfort / (comfort + dist);
  },

  // Manhattan distance from `tile` to the closest of `points` — cheap
  // coordinate math for ranking candidates, not a real sea route (that's
  // isRouteTooIndirect's job, only run on the few candidates that make it
  // through this ranking).
  nearestDist(points, tile) {
    const w = GameMap.width;
    const tx = tile % w, ty = (tile / w) | 0;
    let best = Infinity;
    for (const pt of points) {
      const px = pt % w, py = (pt / w) | 0;
      const d = Math.abs(px - tx) + Math.abs(py - ty);
      if (d < best) best = d;
    }
    return best;
  },

  // True only when we can positively confirm the real crossing is a bad
  // detour — no route at all is left to launchNavalInvasion's own "No sea
  // route" handling rather than treated as indirect here.
  isRouteTooIndirect(p, homeCoast, targetTile) {
    const straight = this.nearestDist(homeCoast, targetTile);
    if (straight < 8) return false; // too short for the ratio to mean anything
    const path = Game.nearestCoastPath(p.id, targetTile);
    return !!path && path.length > straight * this.NAVAL_MAX_DETOUR;
  },

  // 1+BONUS (3x) at kickoff, fading linearly down to a 1+FLOOR (1.5x) floor
  // by TRIBE_PRIORITY_WINDOW and staying there for the rest of the match —
  // never back to 1x/no bonus. Shared by think()'s land scoring and
  // navalScore() so an overseas Tribe gets the same pull as one next door.
  tribePriorityMult() {
    const fade = Math.max(0, 1 - Game.elapsed / this.TRIBE_PRIORITY_WINDOW);
    return 1 + this.TRIBE_PRIORITY_FLOOR + (this.TRIBE_PRIORITY_BONUS - this.TRIBE_PRIORITY_FLOOR) * fade;
  },

  // All of p's own coastal tiles the AI treats as potential boat launch
  // points, capped at NAVAL_COAST_SAMPLE_CAP — used both to gate navalThink
  // (empty means landlocked) and to rank candidates by nearestDist.
  coastalTiles(p) {
    const out = [];
    for (const t of p.tiles) {
      if (!GameMap.isCoastal(t)) continue;
      out.push(t);
      if (out.length >= this.NAVAL_COAST_SAMPLE_CAP) break;
    }
    return out;
  },

  // Map of neighbouring owner -> number of contacted border tiles. Allies are
  // omitted by default, which is the single chokepoint that keeps bots off
  // their friends' land: an ally never appears as a target to score in the
  // first place. Callers asking who a nation simply *touches* — the betrayal
  // check, the fallout from breaking a pact — pass includeAllies.
  borderTargets(p, includeAllies) {
    const counts = new Map();
    const nb = Game.nbuf;
    // p.borderTiles (kept live by Game.setOwner), not p.tiles — only a
    // border tile can have a non-owned neighbour, and walking every tile a
    // bot owns on each think() cycle was a perimeter-vs-area hitch of its
    // own once a bot's territory grew large, same as refreshFrontier's.
    for (const i of p.borderTiles) {
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const o = GameMap.owner[nb[k]];
        if (o === WATER || o === p.id) continue;
        if (!includeAllies && p.allies.has(o)) continue;
        counts.set(o, (counts.get(o) || 0) + 1);
      }
    }
    return counts;
  },

  // Annexes every fully-enclosed pocket of targetId's land for free — the
  // bot/tribe equivalent of a human noticing a surrounded nation and tapping
  // it, taking the whole scatter in one go exactly as that tap now does (see
  // UI.onTap). Without this, only the human ever benefits from encirclement
  // and tribes only ever die to a human's click. Game.enclosedPocketsOf scans
  // just the contact points along p's border, so it doesn't add real cost to
  // a think() cycle that already walks the same border for borderTargets.
  annexIfEnclosed(p, targetId) {
    if (targetId < 0) return false; // NEUTRAL land can't be annexed
    return Game.annexEnclosedPockets(targetId, p.id) > 0;
  }
};

// Tribe behaviour, after openfront.wiki/Bots — the "simple Bot" type deliberately
// kept dumb: no diplomacy(), no economy(), no navalThink(). A tribe just picks a
// random bordering neighbour (unclaimed land included) and nibbles at it. This is
// the whole AI; every strength cut that makes that nibbling stay weak forever
// (half pop cap, 30% slower growth, the human-attacker discount, cheap neutral
// land) lives in Game, not here — see TRIBE_TROOP_CAP_MULT / TRIBE_GROWTH_MULT /
// tileCost.
const TribeAI = {
  update() {
    for (const p of Game.players) {
      if (!p.isTribe || !p.alive) continue;
      p.nextThink -= Game.TICK_DT;
      if (p.nextThink <= 0) {
        p.nextThink = 3 + Game.rng() * 4;
        this.think(p);
      }
    }
  },

  think(p) {
    if (p.tiles.size === 0) return;
    // One nibble in flight at a time, same restraint AI.think applies to
    // Nations — a tribe never stacks a second attack on top of the first.
    if (Game.attacks.some(a => a.attacker === p.id)) return;

    const targets = AI.borderTargets(p);
    if (targets.size === 0) return;
    const ids = [...targets.keys()];
    const target = ids[Math.floor(Game.rng() * ids.length)];
    if (AI.annexIfEnclosed(p, target)) return;

    // openfront.wiki/Bots: "Bots use 5% of their troops" per attack, a fifth
    // of the 20% a human or Nation commits — the source of the "extremely
    // small-scale attacks... a few pixels of land at a time" behaviour.
    const troops = Math.floor(p.troops / 20);
    if (troops < 20) return;
    Game.launchAttack(p.id, target, troops);
  }
};
