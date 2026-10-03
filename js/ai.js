// Bot behaviour: expansion, and — since alliances exist — diplomacy.
//
// OpenFront branches almost every diplomatic decision on a difficulty setting.
// The thresholds below are their MEDIUM column; PROFILES carries the few that
// the Easy and Hard tiers move, and profile() picks the row for the match.
const AI = {
  // What a difficulty changes about how a Nation *plays*. The other half — how
  // many troops it starts with, how high its cap and growth run — is
  // Game.NATION_DIFFICULTY in game/economy.js. Tribes ignore both.
  //
  // MEDIUM MUST STAY THE BASELINE: every value in that row is the constant it
  // replaced, so a Medium match plays exactly as it did before difficulty
  // existed (the sim goldens pin this). Tune Easy and Hard around it.
  //
  //   thinkMult / navalMult  scale the gap between land / naval decisions —
  //                          Easy reacts slowly, Hard reacts quickly.
  //   (How much a strike commits is not a difficulty knob: like OpenFront,
  //   every nation waits for its rolled trigger fill and sends everything
  //   above its rolled reserve — see rollTraits.)
  //   confusion              1-in-n chance an alliance answer is a coin flip
  //                          instead of a decision; 0 = never confused.
  //   betrayHelpless         betray an ally whose army is under 1/n of ours.
  //   betrayOpportunist      also betray a traitor who can't punish it, or the
  //                          last neighbour on the map.
  //   nukes                  whether it builds Silos and fires warheads at all.
  //   nukeChance / hydrogenChance  1-in-n roll per economy cycle to fire, and
  //                          to make that warhead a Hydrogen Bomb.
  //   mirvChance             1-in-n roll, on top of an already-Hydrogen-
  //                          worthy strike (see maybeNuke), to reach for a
  //                          MIRV instead — gated by MIRV's own much larger
  //                          treasury requirement, so this mostly matters
  //                          for a bot that has been sitting on a ready Silo
  //                          for a long time. 0 = never.
  //   retaliateChance        1-in-n roll per economy cycle to nuke a nation
  //                          that is actively eating our land (maybeRetaliate);
  //                          0 = never.
  //   embargoLiftAt          relation at which a nation lifts an embargo it
  //                          placed on someone it came to hate. OpenFront:
  //                          Neutral, but Hard holds out for Friendly.
  //   scouts                 fog of war only: how many Scouts it keeps afloat
  //                          (see scoutThink). Never read with fog off.
  PROFILES: {
    easy: {
      thinkMult: 1.6, navalMult: 1.6,
      confusion: 10,
      betrayHelpless: 20, betrayOpportunist: false,
      nukes: false, nukeChance: 0, hydrogenChance: 4, mirvChance: 0, retaliateChance: 0,
      embargoLiftAt: 0, scouts: 1
    },
    medium: {
      thinkMult: 1, navalMult: 1,
      confusion: 20,
      betrayHelpless: 10, betrayOpportunist: true,
      nukes: true, nukeChance: 8, hydrogenChance: 4, mirvChance: 6, retaliateChance: 2,
      embargoLiftAt: 0, scouts: 2
    },
    hard: {
      thinkMult: 0.7, navalMult: 0.7,
      confusion: 0,
      betrayHelpless: 5, betrayOpportunist: true,
      nukes: true, nukeChance: 5, hydrogenChance: 3, mirvChance: 4, retaliateChance: 1,
      embargoLiftAt: 50, scouts: 2
    }
  },

  // AiAttackBehavior's per-nation rolls, the same ones TribeAI uses: hold
  // fire until troops reach `trigger` of the cap, then send everything above
  // `reserve` (or above `expand` for free land). That keeps a nation near the
  // ~42% growth peak instead of repeatedly spending itself down below it.
  rollTraits() {
    const r = (lo, hi) => lo + Math.floor(Game.rng() * (hi - lo + 1));
    return {
      trigger: r(50, 60) / 100,
      reserve: r(30, 40) / 100,
      expand: r(10, 20) / 100
    };
  },

  // Troops a fresh strike commits: everything above the rolled floor.
  sendAmount(p, target) {
    const tr = p.aiTraits;
    const keep = Game.maxTroops(p) * (target === NEUTRAL ? tr.expand : tr.reserve);
    return Math.floor(p.troops - keep);
  },

  profile() {
    return this.PROFILES[Game.difficulty] || this.PROFILES[Game.DEFAULT_DIFFICULTY];
  },


  // OpenFront's Relation enum is a banding of the raw [-100, 100] value:
  // < -50 Hostile, < 0 Distrustful, < 50 Neutral, >= 50 Friendly.
  DISTRUSTFUL: 0,
  FRIENDLY: 50,

  // A fresh strike on a Tribe commits the same restrained share as a neutral
  // grab, not a full nation-vs-nation opener: the full 55% (stacked on the
  // priority bonus and tileCost's Tribe discount) erased a bordering Tribe's
  // edge before its own slow AI could show any growth.
  TRIBE_ATTACK_RATIO: 0.35,   // vs. everything above the reserve for a fresh nation attack

  // Not an OpenFront port: OpenFront's AI gives Tribes no targeting priority.
  // Without a bonus, a Tribe's small border loses the `contact` comparison to
  // any real front. The bonus fades from a kickoff bump to a permanent floor
  // so a Tribe that outlasts an early war is still a mild pick. See
  // TRIBE_SKIRMISH_RATIO for how Tribes get attacked mid-war.
  TRIBE_PRIORITY_BONUS: 2,        // up to 3x score at kickoff
  TRIBE_PRIORITY_FLOOR: 0.5,      // never decays below 1.5x, for the rest of the match
  TRIBE_PRIORITY_WINDOW: 240,     // linearly fades from kickoff bonus to the floor over 4 minutes

  update() {
    const prof = this.profile();
    // Fog of war: the beach table, a slice a tick until it is built.
    if (Game.fog && !(this._fogCoast && this._fogCoast.ready && this._fogCoast.map === GameMap.landmasses)) {
      this.fogCoastStep(Math.ceil(2 * GameMap.height / this.FOG_COAST_TICKS));
    }
    for (const p of Game.players) {
      if (!p.isBot || !p.alive) continue;

      p.nextThink -= Game.TICK_DT;
      if (p.nextThink <= 0) {
        p.nextThink = (2 + Game.rng() * 3) * prof.thinkMult;
        this.diplomacy(p);
        this.economy(p);
        this.reviewAttacks(p);
        this.think(p);
      }

      // Separate, slower cooldown: navalThink runs a sea-path BFS rather than
      // a cheap map scan, so it doesn't get to think on land's cadence.
      p.nextNavalThink -= Game.TICK_DT;
      if (p.nextNavalThink <= 0) {
        p.nextNavalThink = (15 + Game.rng() * 10) * prof.navalMult;
        this.navalThink(p);
      }
    }
  },

  // 1-in-n, matching OpenFront's PseudoRandom.chance.
  chance(n) { return Game.rng() * n < 1; },
  pct() { return Math.floor(Game.rng() * 101); },   // 0..100, as nextInt(0, 100)
  range(lo, hi) { return lo + Math.floor(Game.rng() * (hi - lo)); },

  diplomacy(p) {
    this.updateRelationsFromEmbargoes(p);
    this.handleEmbargoes(p);
    this.handleRequests(p);
    this.handleExtensions(p);
    this.maybeBetray(p);
    this.maybeSendRequests(p);
    this.maybeDonate(p);
  },

  // Below OpenFront's Hostile band (-50) a nation stops trading with you.
  HOSTILE: -50,
  EMBARGO_RELATION_HIT: -20,

  // NationExecution.updateRelationsFromEmbargos: being embargoed by someone
  // costs them 20 points of this nation's goodwill, once, refunded when the
  // embargo lifts.
  updateRelationsFromEmbargoes(p) {
    for (const other of Game.players) {
      if (other === p || other.isTribe) continue;
      // Fog of war: an embargo from a nation p has not met is from "Unknown
      // nation", so there is nobody to hold it against yet.
      if (Game.fog && !Game.hasMet(p.id, other.id)) continue;
      const embargoed = Game.hasEmbargoAgainst(other.id, p.id);
      const applied = p.embargoMalusFrom.has(other.id);
      if (embargoed && !applied) {
        Game.adjustRelation(p, other.id, this.EMBARGO_RELATION_HIT);
        p.embargoMalusFrom.add(other.id);
      } else if (!embargoed && applied) {
        Game.adjustRelation(p, other.id, -this.EMBARGO_RELATION_HIT);
        p.embargoMalusFrom.delete(other.id);
      }
    }
  },

  // NationExecution.handleEmbargoesToHostileNations: a nation that hates you
  // stops trading with you, and only starts again once relations recover to
  // the profile's embargoLiftAt. Also lifts a temporary (attack) embargo
  // early, as upstream's stopEmbargo does. No team-game branch — no teams.
  handleEmbargoes(p) {
    const liftAt = this.profile().embargoLiftAt;
    for (const other of Game.players) {
      if (other === p || !other.alive || other.isTribe) continue;
      // Fog of war: the contact rule a human's embargo goes through
      // (Game.embargoBlockReason). A relation can sour before contact (a
      // nuke angers its target at launch), so this is not a formality.
      if (Game.fog && !Game.hasMet(p.id, other.id)) continue;
      const rel = Game.relation(p, other.id);
      const has = Game.hasEmbargoAgainst(p.id, other.id);
      if (rel < this.HOSTILE && !has) Game.addEmbargo(p.id, other.id, false);
      else if (rel >= liftAt && has) Game.stopEmbargo(p.id, other.id);
    }
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

  // AiAttackBehavior.donateTroops. Upstream only donates in team
  // games ("Only donate in team games" / "Don't donate in public games (To
  // balance HvN)"), and so does this game (Game.donateBlockReason): a
  // Nation reinforcing a teammate or ally that's actively fighting. No
  // OpenFront equivalent asks allies *for* help (see diplomacy.js's donate
  // section and this ticket's report) — donation here is one-directional,
  // exactly as upstream.
  //
  // Difficulty gating ported verbatim from AiAttackBehavior: Easy never
  // donates, Medium 1-in-4, Hard 1-in-2 (upstream's Impossible tier, always,
  // has no row in this game's three-tier PROFILES — Hard already reacts
  // fastest and it lacks a fourth tier to reuse, so it stops at 1-in-2).
  DONATE_CHANCE: { easy: 0, medium: 14, hard: 8 },
  // After giving, a nation sits out this many seconds (rolled per gift), and
  // it hands over only a random slice of its spare troops, so a push doesn't
  // draw a synchronized flood of donations from every ally at once.
  DONATE_COOLDOWN: [90, 240],
  DONATE_SHARE: [0.1, 0.45],
  // Fraction of Game.maxTroops(p) this nation always keeps at home — mirrors
  // AiAttackBehavior's own per-nation reserveRatio (a random 30-40% picked at
  // spawn); this game's AI has no per-nation persisted field for that, so a
  // fixed midpoint of upstream's range stands in.
  DONATE_RESERVE_RATIO: 0.35,

  maybeDonate(p) {
    if (!Game.teams) return;
    const n = this.DONATE_CHANCE[Game.difficulty];
    if (!n || !this.chance(n)) return;
    if (p.allies.size === 0) return;
    if (Game.elapsed < (p.nextDonateAt || 0)) return;

    // Allies currently fighting — either side of an attack, matching
    // upstream's incomingAttacks().length > 0 || outgoingAttacks().length > 0.
    let weakest = null, weakestRatio = Infinity;
    for (const allyId of p.allies) {
      const ally = Game.players[allyId];
      if (!ally || !ally.alive) continue;
      const fighting = Game.attacks.some(a => a.attacker === allyId || a.target === allyId);
      if (!fighting) continue;
      if (!Game.canDonate(p.id, allyId)) continue;
      const ratio = ally.troops / Math.max(1, Game.maxTroops(ally));
      if (ratio < weakestRatio) { weakestRatio = ratio; weakest = allyId; }
    }
    if (weakest === null) return;

    const keep = Game.maxTroops(p) * this.DONATE_RESERVE_RATIO;
    const available = p.troops - keep;
    if (available < 1) return;
    const [sLo, sHi] = this.DONATE_SHARE, [cLo, cHi] = this.DONATE_COOLDOWN;
    Game.donateTroops(p.id, weakest, available * (sLo + Game.rng() * (sHi - sLo)));
    p.nextDonateAt = Game.elapsed + cLo + Game.rng() * (cHi - cLo);
  },

  // OpenFront's getAllianceDecision, Medium column throughout bar the
  // confusion rate. `isResponse` is true when answering someone else's offer
  // rather than opening one.
  allianceDecision(p, other, isResponse) {
    if (!other || !other.alive) return false;
    // Battle Royale: only one nation leaves the circle, so no new pacts and
    // no renewals once a Drill is down.
    if (Game.drill) return false;

    // Medium nations are confused 5% of the time, and then simply flip a coin.
    // Easy ones twice as often; Hard ones never are.
    const confusion = this.profile().confusion;
    if (confusion && this.chance(confusion)) return this.chance(2);

    // Fog of war: an offer from a nation p has not met arrives as coming from
    // "Unknown nation". p may still answer it, but not by reading the
    // sender's army, land, record or standing.
    if (Game.fog && !Game.hasMet(p.id, other.id)) return this.strangerDecision(p);

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

  // Fog of war only: allianceDecision for a sender p knows nothing about.
  // The two tests that need no knowledge of the other side are kept as they
  // are; the strength comparison that would settle the rest becomes a coin.
  strangerDecision(p) {
    if (p.allies.size >= this.range(4, 6)) return false;
    if (Game.elapsed < 180 && this.pct() >= 30) return true;
    return this.chance(2);
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
  // otherwise yours. Easy keeps only a much blunter form of the first; Hard
  // stabs the merely weak.
  maybeBetray(p) {
    if (p.allies.size === 0) return;
    const prof = this.profile();
    const borderCount = [...this.borderTargets(p, true).keys()].filter(id => id >= 0).length;
    // Battle Royale: once the circle is moving, an ally standing between p
    // and the Drill is the way in, pact or no pact — see drillPull.
    const pull = Game.drill && Game.ticks >= Game.drill.startTick ? this.drillPull(p) : null;

    for (const allyId of [...p.allies]) {
      const other = Game.players[allyId];
      if (!other || !other.alive) continue;
      // Teammates sit in p.allies too (game/teams.js) but can't be betrayed.
      if (Game.onSameTeam(p.id, allyId)) continue;

      if (pull && (pull.get(allyId) || 0) >= (this.DRILL_PULL_IN + this.DRILL_PULL_OUT) / 2) {
        Game.breakAlliance(p.id, allyId);
        return;
      }

      // Medium's weak-ally test is the blunt one — ten times their army. The
      // sharper maxTroops-aware version is Hard and Impossible only, and
      // triggers far more often, so using it here would make bots backstab at
      // roughly the rate their hardest difficulty does.
      const helpless = p.troops >= other.troops * prof.betrayHelpless;
      const stabbable = prof.betrayOpportunist && Game.isTraitor(other) && other.troops < p.troops * 1.2;
      const alone = prof.betrayOpportunist && borderCount === 1 && other.troops * 3 < p.troops;

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
  // immediately doubles the shared price for the rest of this same call.
  // Bots therefore build whichever pool member they own fewer of, so
  // purchases alternate as the shared price climbs.

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
  // Without a cap, mature bots spent most of their gold on Forts and never
  // reached a Silo, SAM Launcher or nuke.
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

  // How many Ports, and separately how many Warships, a nation may buy even
  // while savingsGoal is holding gold back. One of each: the Port unlocks
  // trade income and the navy, and one ship patrols the home coast. Anything
  // past that waits its turn behind the Silo/SAM/bomb reserve like any other
  // purchase.
  NAVY_EXEMPT_COUNT: 1,

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
    // Battle Royale (BR-8): in a stalled match a non-leading nation banks for
    // the Drill ahead of everything else — see drillStalled.
    if (this.drillStalled(p)) return 'drill';
    if (Game.unitsOwned(p, 'city') < this.SILO_MIN_CITIES) return null;

    let ownSilos = Game.unitsPending(p, 'silo');
    let ownSams = 0, rivalSilos = 0;
    for (const b of Game.buildings.values()) {
      if (!b.built) continue;
      const owner = GameMap.owner[b.tile];
      if (b.type === 'silo') {
        if (owner === p.id) ownSilos++;
        // Fog of war: only a Silo p can see is a reason to buy cover.
        else if (owner >= 0 && !Game.areAllied(p.id, owner) && (!Game.fog || Game.isDiscovered(p.id, b.tile))) rivalSilos++;
      } else if (b.type === 'sam' && owner === p.id) {
        ownSams++;
      }
    }

    // A tier that never fires has no use for a Silo or a warhead's reserve, but
    // still wants cover against someone else's.
    const nukes = this.profile().nukes;
    if (nukes && ownSilos < 1) return 'silo';
    if (rivalSilos > 0 && ownSams < this.SAM_COVERAGE_TARGET) return 'sam';
    return nukes ? 'atombomb' : null;
  },

  savingsReserve(p, goal) {
    if (goal === 'drill') return Game.unitCost(p, 'drill') + this.DRILL_RESERVE;
    return goal ? Game.unitCost(p, goal) : 0;
  },

  // --- The Drill (Battle Royale, BR-7, tuned in BR-8) -----------------------
  // A bot goes for the Drill only once the match has stalled (drillStalled):
  // DRILL_STALL_AFTER seconds of match time have passed, no nation holds more
  // than DRILL_STALL_SHARE of the land (so nobody is about to win normally),
  // and the bot is not the land leader — the Drill is a way out for the
  // nations stuck behind the leader, not for the leader itself.
  //
  // From then on the Drill is the bot's savings goal (savingsGoal), so it
  // banks DRILL_COST + DRILL_RESERVE instead of spending on structures: BR-8
  // found that without this no bot ever got past ~1.6M, so none ever built
  // one, even in an hour-long three-way stalemate. Once it has the gold it
  // still has to win a 1-in-DRILL_CHANCE roll per economy cycle, so several
  // flush bots don't all fire on the same think. Derived from live state
  // only (no history); the roll is drawn only when every other gate passes,
  // so pre-stall matches consume no extra rng. Never runs once Game.drill
  // exists.
  DRILL_STALL_AFTER: 1500,    // 25 minutes of match time
  // BR-8: was 0.5. Two bot matches froze for 30-65 minutes with the leader
  // at ~77% (short of the 90% win), and nobody could go for the Drill.
  DRILL_STALL_SHARE: 0.8,     // no nation above 80% of land
  DRILL_RESERVE: 2000000,     // gold kept after paying
  DRILL_CHANCE: 3,

  drillStalled(p) {
    if (Game.drill || p.isTribe || !p.alive || p.tiles.size === 0) return false;
    if (Game.elapsed < this.DRILL_STALL_AFTER) return false;
    let top = 0;
    for (const q of Game.players) if (q.alive && q.tiles.size > top) top = q.tiles.size;
    if (top > GameMap.landTiles * this.DRILL_STALL_SHARE) return false;
    // Ties with the leader count as leading.
    return p.tiles.size < top;
  },

  maybeDrill(p) {
    if (Game.drill || p.isTribe || Game.elapsed < this.DRILL_STALL_AFTER) return;
    if (p.gold < Game.unitCost(p, 'drill') + this.DRILL_RESERVE) return;
    if (!this.drillStalled(p)) return;
    if (!this.chance(this.DRILL_CHANCE)) return;
    const tile = this.drillSite(p);
    if (tile < 0 || Game.drillBlockReason(p.id, tile)) return;
    Game.placeDrill(p.id, tile);
  },

  // The owned tile closest to the centre of mass of the bot's land (ties go to
  // the first in Set insertion order, which is deterministic).
  drillSite(p) {
    const w = GameMap.width;
    let sx = 0, sy = 0, n = 0;
    for (const t of p.tiles) { const x = t % w; sx += x; sy += (t - x) / w; n++; }
    if (!n) return -1;
    const cx = sx / n, cy = sy / n;
    let best = -1, bestD = Infinity;
    for (const t of p.tiles) {
      const x = t % w, dx = x - cx, dy = (t - x) / w - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  },

  economy(p) {
    this.maybeDrill(p);
    // Before any spending: a bot being overrun fires with this cycle's full
    // treasury rather than whatever the build loop leaves over.
    this.maybeRetaliate(p);

    // The one thing this bot is banking toward, and the treasury floor every
    // OTHER purchase below has to respect — see savingsGoal's comment. The
    // goal type itself is exempt (its reserve IS its price), so the branch
    // that finally buys it isn't blocked by its own savings.
    const goal = this.savingsGoal(p);
    const reserve = this.savingsReserve(p, goal);
    // A coastal nation's first Port and its first Warship are exempt from the
    // reserve too (see NAVY_EXEMPT_COUNT). Without this a 3-city nation banks
    // for its 1M Silo before it has ever built a Port, and since a Warship
    // needs a Port, nations effectively never put a ship in the water.
    const navyExempt = t =>
      (t === 'port' && Game.unitsOwned(p, 'port') + Game.unitsPending(p, 'port') < this.NAVY_EXEMPT_COUNT) ||
      (t === 'warship' && this.warshipCount(p) < this.NAVY_EXEMPT_COUNT);
    const spendable = t => p.gold - (t === goal || navyExempt(t) ? 0 : reserve);

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
        // A coastal nation's first Port jumps the Factory/Port queue. Port
        // and Factory share one price curve, so a Factory bought first makes
        // the Port twice as dear and a mid-game nation never gets round to
        // it; and while saving for a Silo only the (reserve-exempt) Port is
        // affordable at all, so picking the Factory would stall for good.
        if (pool.includes('port') && navyExempt('port') && this.hasCoast(p)) type = 'port';
      }

      // Forts, Silos, and SAM Launchers are only worth building once there's
      // at least one city to defend/support — a Silo in particular is the
      // single most expensive flat-cost purchase in the game (1M, same as a
      // maxed-out City), and a SAM Launcher's own 1.5M starting price is
      // higher still, neither worth a fresh nation's very first gold.
      if ((type === 'fort' || type === 'silo' || type === 'sam') && Game.unitsOwned(p, 'city') < 1) continue;

      // A Silo is only ever worth its 1M to a nation that will fire from it.
      if (type === 'silo' && !this.profile().nukes) continue;

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
      // rather than leaving this cycle's gold unspent. Fort/Warship/the
      // bombs are upgradable:false, so this only ever fires for
      // City/Factory/Port/Silo/SAM, and never fights the branch above for SAM.
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
        this.warshipCount(p) < Game.MAX_WARSHIPS_PER_PLAYER) {
      const site = this.warshipSite(p);
      if (site >= 0) Game.buildWarship(p.id, site);
    }

    // Fog of war: a Scout, once scoutThink has somewhere to send one. After
    // the build order above, so it is paid for out of what that leaves.
    if (Game.fog) { this.scoutPoll(p); this.buyScout(p); }

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
  // (1-in-n; the per-difficulty value lives in PROFILES.hydrogenChance.)
  maybeNuke(p) {
    const prof = this.profile();
    if (!prof.nukeChance) return;
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
    if (!this.chance(prof.nukeChance)) return;

    let best = -1, bestContact = 0;
    for (const [targetId, contact] of this.borderTargets(p)) {
      if (targetId < 0) continue;
      const t = Game.players[targetId];
      if (!t || !t.alive || t.isTribe) continue;
      if (contact > bestContact) { bestContact = contact; best = targetId; }
    }
    if (best < 0) return;

    const target = Game.players[best];
    const targetTile = this.nukeTarget(target, p);
    if (targetTile < 0) return;

    const hydrogenWorthy = target.tiles.size > p.tiles.size || target.troops > p.troops;
    // MIRV: the tier above Hydrogen, only worth its price against a rival that
    // dwarfs us. Returns early on a hit, so no second warhead the same cycle.
    const mirvWorthy = hydrogenWorthy && target.tiles.size > p.tiles.size * 1.5;
    if (mirvWorthy && p.gold >= Game.unitCost(p, 'mirv') && this.chance(prof.mirvChance)) {
      Game.launchMirv(p.id, targetTile);
      return;
    }
    const type = hydrogenWorthy && p.gold >= Game.unitCost(p, 'hydrogenbomb') && this.chance(prof.hydrogenChance)
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
      if (Game.siloFreeSlots(b) > 0) return true;
    }
    return false;
  },

  // Last-ditch retaliation. maybeNuke above is opportunistic and often fires
  // at a quiet neighbour or a City far behind the lines, so a bot being pushed
  // down rarely answered its attacker.
  //
  // Triggers when the bot lost at least RETALIATE_LOSS_FRAC of its land
  // (RETALIATE_MIN_LOSS tiles minimum) since its previous economy cycle while
  // a non-Tribe nation has a live attack on it. The target is whichever
  // attacker has the most troops committed against us — same rule think()
  // uses for its land counter-attack. The warhead goes onto the attacker's
  // own land just behind the front (retaliationTarget): that kills their
  // troops and attack columns per tile destroyed, and leaves a fallout belt
  // that is slow and costly to cross, which is what actually blunts a push.
  RETALIATE_LOSS_FRAC: 0.005,
  RETALIATE_MIN_LOSS: 5,

  maybeRetaliate(p) {
    // Sampled every cycle, before any early return, so the loss is always
    // measured against the previous cycle.
    const prev = p.aiTilesSeen;
    p.aiTilesSeen = p.tiles.size;
    const prof = this.profile();
    if (!prof.retaliateChance || prev === undefined) return false;
    if (prev - p.tiles.size < Math.max(this.RETALIATE_MIN_LOSS, prev * this.RETALIATE_LOSS_FRAC)) return false;
    if (p.gold < Game.unitCost(p, 'atombomb')) return false;

    let hitter = -1, biggest = 0;
    for (const a of Game.attacks) {
      if (a.target !== p.id || a.retreating || a.attacker < 0 || a.troops <= biggest) continue;
      const t = Game.players[a.attacker];
      if (!t || !t.alive || t.isTribe || Game.areAllied(p.id, a.attacker)) continue;
      // Fog of war: only a nation p has met. An attack is itself contact
      // (Game.launchAttack, Game.resolveLanding), so this holds for every
      // attacker; it is here so the rule does not rest on that.
      if (Game.fog && !Game.hasMet(p.id, a.attacker)) continue;
      biggest = a.troops; hitter = a.attacker;
    }
    if (hitter < 0) return false;
    if (!this.hasReadySilo(p)) return false;
    if (!this.chance(prof.retaliateChance)) return false;

    const target = Game.players[hitter];
    // Hydrogen only when it is worth it (same test as maybeNuke) AND a spot
    // exists where its 100-tile blast stays off our own land.
    if ((target.tiles.size > p.tiles.size || target.troops > p.troops) &&
        p.gold >= Game.unitCost(p, 'hydrogenbomb') && this.chance(prof.hydrogenChance)) {
      const tile = this.retaliationTarget(p, hitter, 'hydrogenbomb');
      if (tile >= 0) return Game.launchNuke(p.id, 'hydrogenbomb', tile);
    }
    const tile = this.retaliationTarget(p, hitter, 'atombomb');
    return tile >= 0 && Game.launchNuke(p.id, 'atombomb', tile);
  },

  // Candidate aim points: from a sample of the front tiles the attack is
  // eating (a.border holds OUR tiles next to their land), step across into
  // the attacker's territory at a few depths. Plus their structures, so a
  // Silo/City sitting near the front is preferred when it is in reach. Each
  // candidate is scored on a coarse grid over the blast's outer circle:
  // attacker land counts for it, our land against it (and rejects it past
  // RETALIATE_OWN_LIMIT), and any ally land or structure — or any structure of
  // ours — rejects it outright, since maybeBreakNukeAlliances would fire on
  // either. Returns -1 when no candidate is clean enough; the bot then holds
  // fire rather than crater itself.
  //
  // Fog of war: p aims only at what it has discovered. An aim point, a
  // structure or a tile of the blast that lies in the black is not there as
  // far as p knows, so it is neither a candidate nor counted in a score. p's
  // own land and its allies' is always discovered, so the checks that keep
  // the blast off them lose nothing.
  RETALIATE_FRONT_SAMPLES: 12,
  RETALIATE_OWN_LIMIT: 0.1,

  retaliationTarget(p, attackerId, type) {
    const fog = Game.fog;
    const mag = Game.NUKE_MAGNITUDES[type];
    const w = GameMap.width, h = GameMap.height;
    const candidates = [];
    const nb = Game.nbuf;
    const depths = [Math.round(mag.inner * 0.5), mag.inner, Math.round(mag.outer * 0.7)];
    for (const a of Game.attacks) {
      if (a.attacker !== attackerId || a.target !== p.id || a.retreating) continue;
      // Evenly spaced picks through the front, not the first N (which all
      // cluster wherever the front started).
      const stride = Math.max(1, Math.floor(a.border.size / this.RETALIATE_FRONT_SAMPLES));
      let i = 0;
      for (const f of a.border) {
        if (i++ % stride) continue;
        const n = GameMap.neighbors(f, nb);
        let dx = 0, dy = 0;
        for (let k = 0; k < n; k++) {
          if (GameMap.owner[nb[k]] !== attackerId) continue;
          dx += (nb[k] % w) - (f % w); dy += ((nb[k] / w) | 0) - ((f / w) | 0);
        }
        if (dx === 0 && dy === 0) continue;
        // Sign-only direction (8-way) so the unit length is exact: no
        // Math.hypot in sim code, whose rounding isn't pinned across engines.
        dx = Math.sign(dx); dy = Math.sign(dy);
        const len = dx && dy ? Math.SQRT2 : 1;
        for (const d of depths) {
          const x = Math.round((f % w) + dx / len * d), y = Math.round(((f / w) | 0) + dy / len * d);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (fog && !Game.isDiscovered(p.id, y * w + x)) continue;
          if (GameMap.owner[y * w + x] === attackerId) candidates.push(y * w + x);
        }
      }
    }
    for (const b of Game.buildings.values()) {
      if (fog && !Game.isDiscovered(p.id, b.tile)) continue;
      if (b.built && GameMap.owner[b.tile] === attackerId && this.NUKE_TARGET_PRIORITY[b.type]) candidates.push(b.tile);
    }

    const step = Math.max(1, Math.round(mag.outer / 15));
    const outer2 = mag.outer * mag.outer, inner2 = mag.inner * mag.inner;
    let best = -1, bestScore = 0;
    for (const c of candidates) {
      const cx = c % w, cy = (c / w) | 0;
      let theirs = 0, mine = 0, ally = false;
      for (let y = Math.max(0, cy - mag.outer); y <= Math.min(h - 1, cy + mag.outer) && !ally; y += step) {
        for (let x = Math.max(0, cx - mag.outer); x <= Math.min(w - 1, cx + mag.outer); x += step) {
          const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
          if (d2 > outer2) continue;
          if (fog && !Game.isDiscovered(p.id, y * w + x)) continue;
          const o = GameMap.owner[y * w + x];
          const wt = d2 <= inner2 ? 2 : 1;
          if (o === attackerId) theirs += wt;
          else if (o === p.id) mine += wt;
          else if (o >= 0 && Game.areAllied(p.id, o)) { ally = true; break; }
        }
      }
      if (ally || theirs === 0 || mine > theirs * this.RETALIATE_OWN_LIMIT) continue;
      let score = theirs - mine * 5;
      for (const b of Game.buildings.values()) {
        if (Game.tileDistSq(c, b.tile) >= outer2) continue;
        if (fog && !Game.isDiscovered(p.id, b.tile)) continue;
        const o = GameMap.owner[b.tile];
        if (o === p.id || (o >= 0 && Game.areAllied(p.id, o))) { score = -1; break; }
        if (o === attackerId) score += (this.NUKE_TARGET_PRIORITY[b.type] || 0) * 20;
      }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
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
  //
  // Fog of war: `p`, the nation firing, aims only at what it has discovered:
  // a structure it can see or, failing that, a tile of the target's it can
  // see. -1 when it can see none of the target's land.
  NUKE_TARGET_PRIORITY: { silo: 4, sam: 3, city: 2, factory: 1, port: 1 },

  nukeTarget(target, p) {
    const fog = Game.fog;
    let best = -1, bestScore = 0;
    for (const b of Game.buildings.values()) {
      if (!b.built) continue;
      if (GameMap.owner[b.tile] !== target.id) continue;
      const weight = this.NUKE_TARGET_PRIORITY[b.type] || 0;
      if (weight === 0) continue;
      if (fog && !Game.isDiscovered(p.id, b.tile)) continue;
      // Jitter is strictly smaller than one priority step, so it shuffles
      // between equally-valuable targets without ever letting a Port outrank
      // a Silo.
      const score = weight * 4 + Math.floor(Game.rng() * 4);
      if (score > bestScore) { bestScore = score; best = b.tile; }
    }
    if (best >= 0) return best;

    if (target.tiles.size === 0) return -1;
    let n = Math.floor(Game.rng() * target.tiles.size);
    if (fog) {
      // The same random start, then the first tile from there on that p has
      // discovered, wrapping round to the start of the set.
      let wrapped = -1;
      for (const t of target.tiles) {
        if (Game.isDiscovered(p.id, t)) {
          if (n <= 0) return t;
          if (wrapped < 0) wrapped = t;
        }
        n--;
      }
      return wrapped;
    }
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
    // Battle Royale: nothing goes up on ground the circle takes within
    // DRILL_BUILD_HORIZON seconds.
    const soon = Game.drill ? Game.drillRadius(Game.ticks + this.DRILL_BUILD_HORIZON * Game.TICKS_PER_SEC) : 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const tile = this.sampleTile(p);
      if (tile < 0 || Game.buildings.has(tile)) continue;
      if (Game.drill && !Game.drillInside(tile, soon)) continue;
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

  // Whether p owns any shore at all. Coastal tiles always touch non-owned
  // water, so walking borderTiles is enough and far cheaper than p.tiles
  // for a big landlocked nation.
  hasCoast(p) {
    for (const t of p.borderTiles) if (GameMap.isCoastal(t)) return true;
    return false;
  },

  warshipCount(p) {
    let n = 0;
    for (const w of Game.warships) if (w.owner === p.id) n++;
    return n;
  },

  // How many completed structures of `type` p currently owns — distinct from
  // Game.unitsOwned, which sums LEVELS rather than counting placements (see
  // the UNITS comment in game/structures.js on why). Needed wherever a per-STRUCTURE
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

  // Bots run a small, separately-funded skirmish against a bordering Tribe
  // alongside their main war (tribeAttackActive/atWar): at most one attack per
  // Tribe, sized off reserves at this ratio so it can't gut the main front.
  TRIBE_SKIRMISH_RATIO: 0.2,   // vs. everything above the reserve for a fresh nation attack

  // Unclaimed land is claimed before any player target is weighed, whenever p
  // borders it and has no grab running. A fresh grab commits everything above
  // the expand floor; one opened alongside a war is a small side column, like
  // a Tribe skirmish. Leftover troops walk home when the pocket runs out.
  NEUTRAL_SKIRMISH_RATIO: 0.2,

  // --- Cutting losses ------------------------------------------------------
  // A human can retreat a failing push and get 75% of the committed troops
  // home (Game.ATTACK_RETREAT_MALUS); reviewAttacks gives bots the same out.
  //
  // "Failing" is deliberately two conditions, not one: the front is down to
  // RETREAT_REMAINING of the most troops it has ever held, AND the defender's
  // pool still exceeds what is left of it by RETREAT_DEFENDER_EDGE. Losing most
  // of a stack is normal in a push that is winning ground, so the loss alone
  // proves nothing — it is the defender still standing well above the remainder
  // that says the rest would be thrown away. Cost per tile also climbs as an
  // attack shrinks (tileCost's strength/attackTroops ratio), so waiting only
  // makes the same retreat more expensive. Tribes are skipped — their defence
  // is engineered weak (BOT_DEFENDER_LOSS_MULT) — as is a defender close to
  // handleDeadDefender's collapse threshold, where staying in is the win.
  RETREAT_REMAINING: 0.35,
  RETREAT_DEFENDER_EDGE: 1.5,
  // After retreating from someone, think()/navalScore treat them as a much
  // poorer target for a while. Without this the bot's troops get back in two
  // seconds and the very next think() relaunches at the same border at full strength,
  // paying the 25% malus over and over for the same lost fight.
  RETREAT_COOLDOWN: 60,
  RETREAT_PENALTY: 0.15,

  // --- Weighing a new enemy -------------------------------------------------
  // Score alone (contact x density) made every soft neighbour a target no
  // matter who they were friends with or what else was going on, so bots picked
  // fights "willy-nilly". provocation() prices the diplomatic side of a fight —
  // the returned multiplier goes straight into the target's score, and a fresh
  // enemy priced below RISK_FLOOR is simply not attacked at all.
  //
  // It only bites on a *fresh* enemy. Someone already at war with us, or who
  // hates us, is a feud we're already in: no new cost, and a small bonus for
  // hitting back.
  RISK_FLOOR: 0.2,
  FEUD_BONUS: 1.25,
  // What a target's coalition may weigh, relative to ours, before it starts to
  // count against attacking: past this, the multiplier is RISK_STRENGTH_EDGE/ratio.
  RISK_STRENGTH_EDGE: 0.8,
  RISK_TIES_PENALTY: 0.3,       // the target is allied to one of OUR allies
  RISK_FRIEND_PENALTY: 0.4,     // relation is already Friendly — an ally in waiting
  RISK_PROSPECT_PENALTY: 0.6,   // not hostile, and strong enough to be worth allying with
  RISK_PER_HOSTILE: 0.6,        // per enemy we already have, i.e. per open second front
  RISK_MAX_HOSTILES: 3,

  // Real players who are, right now, a problem for p: anyone attacking it, and
  // any neighbour whose opinion of it is already negative. Tribes don't count —
  // they hold no grudges and their attacks are a nuisance, not a war.
  hostiles(p, contact) {
    const out = new Set();
    for (const a of Game.attacks) {
      if (a.target !== p.id || a.attacker === p.id) continue;
      const atk = Game.players[a.attacker];
      if (atk && atk.alive && !atk.isTribe) out.add(a.attacker);
    }
    // A nuke inbound on p's land is an attack just like an army.
    for (const n of Game.nukes) {
      if (n.ownerId === p.id || GameMap.owner[n.dst] !== p.id) continue;
      // Fog of war: until it lands, a nuke from a nation p has not met is
      // from "Unknown nation".
      if (Game.fog && !Game.hasMet(p.id, n.ownerId)) continue;
      const atk = Game.players[n.ownerId];
      if (atk && atk.alive && !atk.isTribe) out.add(n.ownerId);
    }
    if (contact) {
      for (const id of contact.keys()) {
        const o = id >= 0 && Game.players[id];
        if (o && o.alive && !o.isTribe && Game.relation(p, id) < 0) out.add(id);
      }
    }
    return out;
  },

  // Multiplier on a target's attractiveness for the diplomatic cost of making
  // an enemy of `t`. 1 = free; below RISK_FLOOR = not worth it. `contact` (the
  // borderTargets map) says which of t's allies can reach us overland; naval
  // callers pass null and get the half-weight, since an ally has to cross water
  // too.
  provocation(p, t, contact, hostiles) {
    if (t.isTribe) return 1;
    if (hostiles.has(t.id)) return this.FEUD_BONUS;
    // Punishing a traitor is popular; nobody minds.
    if (Game.isTraitor(t)) return 1;

    let f = 1;
    const mine = Math.max(1, Game.totalTroops(p));
    const theirs = Game.totalTroops(t);

    // The coalition we would be up against, not just the target on its own.
    let backing = theirs;
    for (const allyId of t.allies) {
      const ally = Game.players[allyId];
      if (!ally || !ally.alive) continue;
      if (p.allies.has(allyId)) { f *= this.RISK_TIES_PENALTY; continue; }
      // Fog of war: a backer p has never met is one it does not know of.
      if (Game.fog && !Game.hasMet(p.id, allyId)) continue;
      backing += Game.totalTroops(ally) * (contact && contact.has(allyId) ? 1 : 0.5);
    }
    const ratio = backing / mine;
    if (ratio > this.RISK_STRENGTH_EDGE) f *= Math.max(0.1, this.RISK_STRENGTH_EDGE / ratio);

    // A neighbour we're on decent terms with is worth more as a friend.
    const rel = Game.relation(p, t.id);
    if (rel >= this.FRIENDLY) f *= this.RISK_FRIEND_PENALTY;
    else if (rel >= 0 && theirs >= mine * 0.7) f *= this.RISK_PROSPECT_PENALTY;

    // Every enemy we already have is a front we can't give our full attention.
    f *= Math.pow(this.RISK_PER_HOSTILE, Math.min(this.RISK_MAX_HOSTILES, hostiles.size));
    return f;
  },

  reviewAttacks(p) {
    const watch = p.attackWatch || (p.attackWatch = new Map());
    const live = new Set();
    for (const a of Game.attacks) {
      if (a.attacker !== p.id) continue;
      live.add(a.id);
      // Peak, not launch size: a consolidated top-up raises the bar the
      // remainder is measured against instead of tripping the threshold.
      const peak = Math.max(watch.get(a.id) || 0, a.troops);
      watch.set(a.id, peak);

      if (a.retreating || a.target < 0) continue;
      const t = Game.players[a.target];
      if (!t || !t.alive || t.isTribe) continue;
      if (t.tiles.size <= Game.DEAD_DEFENDER_TILES * 3) continue;
      if (a.troops > peak * this.RETREAT_REMAINING) continue;
      if (t.troops <= a.troops * this.RETREAT_DEFENDER_EDGE) continue;

      if (Game.retreatAttack(a)) {
        (p.retreatedFrom || (p.retreatedFrom = new Map())).set(a.target, Game.elapsed);
      }
    }
    for (const id of watch.keys()) if (!live.has(id)) watch.delete(id);
  },

  // For FRESH_FRONT_LOCKOUT seconds after anyone opens a fresh front on t, no
  // other nation may open one too, so nations don't pile onto one victim in a
  // tick or two. Exempt: a target already hostile to p (hitting back isn't
  // piling on) and traitors.
  FRESH_FRONT_LOCKOUT: 3,

  freshFrontLocked(p, t, hostiles) {
    if (t.isTribe || t.frontOpenedBy === p.id) return false;
    if (Game.elapsed - t.frontOpenedAt >= this.FRESH_FRONT_LOCKOUT) return false;
    return !hostiles.has(t.id) && !Game.isTraitor(t);
  },

  // 1 normally; RETREAT_PENALTY inside RETREAT_COOLDOWN of a retreat from
  // targetId. Shared by think()'s land scoring and navalScore().
  retreatPenalty(p, targetId) {
    const at = p.retreatedFrom && p.retreatedFrom.get(targetId);
    return at !== undefined && Game.elapsed - at < this.RETREAT_COOLDOWN ? this.RETREAT_PENALTY : 1;
  },

  // --- Battle Royale: converging on the Drill --------------------------------
  // An attack is aimed at a nation, not a place, so a bot heads for the Drill
  // by choosing WHO to fight: drillPull scores each neighbour by the share of
  // the shared border where their side is nearer the Drill than ours.
  // DRILL_PULL_OUT for a neighbour wholly behind us (their land dies before
  // ours does), DRILL_PULL_IN for one wholly in the way, DRILL_CENTRE_BONUS
  // on top for whoever holds the Drill's own tile. Null without a Drill, and
  // for the nation holding the Drill tile — it is already where it needs to
  // be, and fights as usual.
  //
  // With a pull in play, think() also drops the diplomatic caution
  // (provocation) and the full-trigger wait, and will open a front on an
  // inward nation while another war is still running: the ground behind is
  // going regardless. allianceDecision, maybeBetray, navalThink and buildSite
  // carry the rest. Nothing here draws rng or runs without a Drill.
  DRILL_PULL_IN: 3,
  DRILL_PULL_OUT: 0.3,
  DRILL_CENTRE_BONUS: 2,
  DRILL_BUILD_HORIZON: 120,   // seconds
  // Naval: extra weight on a beach of the landmass the Drill sits on. Large
  // enough to beat navalDistanceFactor's discount for a longer crossing.
  DRILL_LANDMASS_BONUS: 8,

  drillPull(p) {
    const d = Game.drill;
    if (!d || GameMap.owner[d.tile] === p.id) return null;
    const inward = new Map(), total = new Map();
    const nb = Game.nbuf;
    for (const i of p.borderTiles) {
      const mine = Game.drillDist2(i);
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const o = GameMap.owner[nb[k]];
        if (o === WATER || o === p.id) continue;
        total.set(o, (total.get(o) || 0) + 1);
        if (Game.drillDist2(nb[k]) < mine) inward.set(o, (inward.get(o) || 0) + 1);
      }
    }
    const centre = GameMap.owner[d.tile];
    const out = new Map();
    for (const [o, n] of total) {
      let m = this.DRILL_PULL_OUT + (this.DRILL_PULL_IN - this.DRILL_PULL_OUT) * (inward.get(o) || 0) / n;
      if (o >= 0 && o === centre) m *= this.DRILL_CENTRE_BONUS;
      out.set(o, m);
    }
    return out;
  },

  // Squared distance from the Drill to p's nearest border tile.
  drillHome2(p) {
    let best = Infinity;
    for (const i of p.borderTiles) {
      const d2 = Game.drillDist2(i);
      if (d2 < best) best = d2;
    }
    return best;
  },

  think(p) {
    if (p.tiles.size === 0) return;
    // Free land only waits for the reserve fill, not the full trigger: gating
    // expansion on 50-60% of cap left nations sitting still between grabs.
    if (p.troops < Game.maxTroops(p) * p.aiTraits.reserve) return;
    const pull = this.drillPull(p);   // null unless a Drill is down

    const myAttacks = Game.attacks.filter(a => a.attacker === p.id);
    const targets = this.borderTargets(p);
    if (targets.size === 0) return;

    // Free land first. See NEUTRAL_SKIRMISH_RATIO.
    if (targets.has(NEUTRAL) && !myAttacks.some(a => a.target === NEUTRAL)) {
      const n = myAttacks.length > 0 ? Math.floor(p.troops * this.NEUTRAL_SKIRMISH_RATIO) : this.sendAmount(p, NEUTRAL);
      if (n >= 1 && Game.launchAttack(p.id, NEUTRAL, n)) return;
    }

    if (!pull && p.troops < Game.maxTroops(p) * p.aiTraits.trigger) return;
    if (this.assistAllies(p, targets, myAttacks)) return;

    // Never stack a second attack on the same Tribe — or a second Tribe
    // skirmish at all — while one is still resolving.
    if (myAttacks.some(a => Game.players[a.target] && Game.players[a.target].isTribe)) return;
    // True once *any* other attack (nation war or neutral land grab) is
    // already in flight — the case that used to block think() outright.
    const atWar = myAttacks.length > 0;

    const hostiles = this.hostiles(p, targets);
    let best = null, bestScore = -Infinity;
    for (const [targetId, contact] of targets) {
      // Mid-war, this cycle exists only to look for a Tribe side-skirmish —
      // the main front is untouched and re-evaluated on its own next cycle.
      // Battle Royale: a nation in the way of the Drill is worth a second front.
      const inward = pull && targetId >= 0 && pull.get(targetId) > 1 && !myAttacks.some(a => a.target === targetId);
      if (atWar && !inward && !(targetId >= 0 && Game.players[targetId].isTribe)) continue;
      let score;
      if (targetId === NEUTRAL) {
        score = contact * 1.4;
      } else {
        const t = Game.players[targetId];
        if (this.freshFrontLocked(p, t, hostiles)) continue;
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
        score *= this.retreatPenalty(p, targetId);
        const risk = pull ? 1 : this.provocation(p, t, targets, hostiles);
        if (risk < this.RISK_FLOOR) continue;   // not worth the enemy it makes
        score *= risk;
      }
      if (pull) score *= pull.get(targetId) || 1;
      if (score > bestScore) { bestScore = score; best = targetId; }
    }

    if (best === null) return;
    if (this.annexIfEnclosed(p, best)) return;
    const skirmish = atWar && !(pull && best >= 0 && !Game.players[best].isTribe);
    const n = skirmish ? Math.floor(p.troops * this.TRIBE_SKIRMISH_RATIO)
      : (best !== NEUTRAL && Game.players[best].isTribe ? Math.floor(p.troops * this.TRIBE_ATTACK_RATIO)
      : this.sendAmount(p, best));
    if (n >= 1) Game.launchAttack(p.id, best, n);
  },

  // AiAttackBehavior.assistAllies: an ally has marked a target
  // (Game.targetPlayer), so go hit it. Upstream only answers an ally it still
  // feels Friendly toward, and each answer costs 20 of that goodwill. A
  // teammate skips the relation gate (teammates are permanent here, and team
  // relations would otherwise decay out of Friendly within ~2 minutes).
  //
  // Deliberately ahead of the scoring loop, and ignoring both provocation()
  // and freshFrontLocked(): piling onto one enemy is the whole point of a
  // mark. Upstream's sendAttack would boat to a target that doesn't border
  // us; this only answers a mark on a land neighbour.
  ASSIST_RELATION_COST: -20,

  assistAllies(p, targets, myAttacks) {
    for (const allyId of p.allies) {
      const ally = Game.players[allyId];
      if (!ally.alive || ally.targets.length === 0) continue;
      const marks = Game.activeTargets(ally);
      if (marks.length === 0) continue;
      const teammate = Game.onSameTeam(p.id, allyId);
      if (!teammate && Game.relation(p, allyId) < this.FRIENDLY) continue;
      for (const id of marks) {
        if (id === p.id || p.allies.has(id) || !targets.has(id)) continue;
        if (myAttacks.some(a => a.target === id)) continue;
        const n = this.sendAmount(p, id);
        if (n < 1 || !Game.launchAttack(p.id, id, n)) continue;
        if (!teammate) Game.adjustRelation(p, allyId, this.ASSIST_RELATION_COST);
        return true;
      }
    }
    return false;
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

  // How long (ticks) a bot leaves a landmass alone after failing to find a
  // sea route to it. Failed searches are the expensive ones — they run the
  // whole node guard, ~50 ms each on Extra Large — and before this about
  // half of them were a bot re-asking for a route it had just failed to
  // find. Only real failures count; a search skipped by the per-tick
  // budget says nothing about the route.
  NAVAL_NO_ROUTE_TICKS: 600,

  // Reserve fraction of maxTroops required before shipping any troops
  // overseas. Doubled while someone is actively attacking p at home — a
  // bot already fighting a land war has no business opening a second front
  // across the water, and this is what actually keeps a beleaguered nation's
  // defenders in place instead of bleeding troops onto boats mid-siege.
  NAVAL_RESERVE: 0.35,
  NAVAL_RESERVE_UNDER_ATTACK: 0.6,

  // How far (in navalComfortDist units) an unclaimed beach still jumps the
  // queue ahead of player targets. Past this it falls back to plain scoring,
  // so a bot doesn't sail across the map for a speck.
  NAVAL_NEUTRAL_RANGE: 2,

  navalThink(p) {
    if (p.tiles.size === 0) return;

    const homeCoast = this.coastalTiles(p);
    if (homeCoast.length === 0) return;

    // Fog of war: Scouts get their orders on this beat too, ahead of the
    // returns below, so a nation with its hands full still explores.
    const fog = Game.fog;
    if (fog) this.scoutThink(p, homeCoast);

    const hostiles = this.hostiles(p, null);
    const reserve = hostiles.size > 0 ? this.NAVAL_RESERVE_UNDER_ATTACK : this.NAVAL_RESERVE;
    if (p.troops < Game.maxTroops(p) * reserve) return;
    if (Game.boats.filter(b => b.attacker === p.id).length >= Game.MAX_BOATS_PER_PLAYER) return;

    // Landmasses p already holds ground on, gathered once — the per-sample
    // Game.onSameLandmass check this replaces walked all of p.tiles for every
    // coast sample of every landmass, which on The World added up to a
    // third of navalThink's cost.
    const heldLandmasses = new Set();
    for (const t of p.tiles) heldLandmasses.add(GameMap.landmassId[t]);

    const drill = Game.drill;
    const drillSoon = drill ? Game.drillRadius(Game.ticks + this.DRILL_BUILD_HORIZON * Game.TICKS_PER_SEC) : 0;
    const drillHome = drill ? this.drillHome2(p) : 0;
    const drillLandmass = drill ? GameMap.landmassId[drill.tile] : -1;

    const candidates = [];
    // Fog of war: the beaches come from fogCoast instead of coastSample.
    const beaches = fog ? this.fogCoast().beaches : null;
    for (const lm of GameMap.landmasses) {
      let bestTile = -1, bestTileScore = -Infinity, bestTarget = -1, bestDist = 0;
      for (const tile of (beaches ? beaches[lm.id] : lm.coastSample)) {
        // Fog of war: a beach p has not discovered is not a candidate. First,
        // so nothing about it is read, ranked or routed to. Its owner, if it
        // has one, is then a nation p has met (game/vision.js).
        if (fog && !Game.isDiscovered(p.id, tile)) continue;
        const owner = GameMap.owner[tile];
        if (owner === p.id || p.allies.has(owner)) continue;
        // Same landmass we already hold ground on — think() already handles
        // this as a land target (its own conquest wave will reach it over
        // time even before it's directly bordered), so routing a boat there
        // too would just waste one.
        if (heldLandmasses.has(GameMap.landmassId[tile])) continue;
        const dist = this.nearestDist(homeCoast, tile);
        let score = this.navalScore(p, owner, lm.size, dist, hostiles);
        // Battle Royale: never sail for a beach the circle is about to take,
        // and prefer one nearer the Drill than anything p holds.
        if (drill) {
          if (!Game.drillInside(tile, drillSoon)) continue;
          score *= Game.drillDist2(tile) < drillHome ? this.DRILL_PULL_IN : this.DRILL_PULL_OUT;
          // An island bot has no land route in, so the Drill's own landmass is
          // the only place a boat does it any good.
          if (GameMap.landmassId[tile] === drillLandmass) score *= this.DRILL_LANDMASS_BONUS;
        }
        if (score > bestTileScore) { bestTileScore = score; bestTile = tile; bestTarget = owner; bestDist = dist; }
      }
      if (bestTile >= 0) candidates.push({ tile: bestTile, target: bestTarget, score: bestTileScore, dist: bestDist });
    }
    if (candidates.length === 0) return;
    // Free land first: an unclaimed beach within NAVAL_NEUTRAL_RANGE is tried
    // before any player's.
    const neutralRange = this.navalComfortDist() * this.NAVAL_NEUTRAL_RANGE;
    const tier = c => (c.target === NEUTRAL && c.dist <= neutralRange ? 1 : 0);
    candidates.sort((a, b) => (tier(b) - tier(a)) || (b.score - a.score));

    // OpenFront's boatAttackAmount default — a flat 20% of current troops,
    // used consistently for both neutral and enemy targets (its AI's own
    // attackWithRandomBoat/sendBoatAttack both compute troops/5 verbatim).
    //
    // At most one failed route search per think: several in a row stacked
    // into 100+ ms ticks on Extra Large. The failure is remembered
    // (navalNoRoute), so the next think moves on to the other candidates.
    const troops = Math.floor(p.troops / 5);
    for (const [lm, until] of p.navalNoRoute) if (until <= Game.ticks) p.navalNoRoute.delete(lm);
    let tried = 0;
    for (const c of candidates) {
      if (tried >= this.NAVAL_CANDIDATES) break;
      const lm = GameMap.landmassId[c.tile];
      if (p.navalNoRoute.has(lm)) continue;
      tried++;
      const searchesBefore = Game._seaPathSearchesThisTick;
      if (this.isRouteTooIndirect(p, homeCoast, c.tile)) {
        if (Game._seaPathSearchesThisTick > searchesBefore) {
          p.navalNoRoute.set(lm, Game.ticks + this.NAVAL_NO_ROUTE_TICKS);
          return;
        }
        continue;
      }
      if (Game.launchNavalInvasion(p.id, c.tile, troops)) return;
    }
  },

  navalScore(p, targetId, opportunity, dist, hostiles) {
    const distFactor = this.navalDistanceFactor(dist);
    if (targetId === NEUTRAL) return opportunity * 1.4 * distFactor;
    const t = Game.players[targetId];
    if (!t || !t.alive) return -Infinity;
    if (this.freshFrontLocked(p, t, hostiles)) return -Infinity;
    const myDensity = p.troops / Math.max(1, p.tiles.size);
    const theirDensity = t.troops / Math.max(1, t.tiles.size);
    let score = opportunity * (myDensity / Math.max(0.5, theirDensity)) * 0.9;
    if (theirDensity > myDensity * 1.6) score *= 0.15;
    if (Game.isTraitor(t)) score *= 2;
    if (Game.relation(p, targetId) < 0) score *= 1.5;
    if (t.isTribe) score *= this.tribePriorityMult();
    const risk = Game.drill ? 1 : this.provocation(p, t, null, hostiles);
    if (risk < this.RISK_FLOOR) return -Infinity;   // same veto as think()
    return score * risk * distFactor * this.retreatPenalty(p, targetId);
  },

  // 1 at dist=0, fading to 0.25 at "comfortable raiding range" (scaled off
  // the current map's own dimensions, so the bias means the same thing on a
  // 250-wide small map as a 2000-wide xlarge one) and asymptoting toward 0
  // well beyond that — a soft discount, not a hard range cap, matching how
  // real OpenFront's own overseas targeting stays nearest-biased without
  // ever being strictly forbidden from a long crossing. Squared rather than
  // linear: a linear falloff (0.5 at comfort range) still let a merely
  // bigger or softer landmass clear across the map consistently outscore a
  // decent one nearby, which read as "AI boats keep going to the far side of
  // the map" — the squared curve keeps that possible but no longer typical.
  navalDistanceFactor(dist) {
    const comfort = this.navalComfortDist();
    const f = comfort / (comfort + dist);
    return f * f;
  },

  navalComfortDist() {
    return (GameMap.width + GameMap.height) * 0.08;
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

  // True when the real crossing is a bad detour, or when no route within
  // the detour limit exists at all. The search itself is capped at that
  // limit, so a target only reachable the long way round fails fast rather
  // than walking the whole ocean first. A route it does find is memoised
  // for the tick (see Game.nearestCoastPath), so the launch that follows
  // reuses it instead of searching again.
  isRouteTooIndirect(p, homeCoast, targetTile) {
    const straight = this.nearestDist(homeCoast, targetTile);
    if (straight < 8) return false; // too short for the ratio to mean anything
    const limit = straight * this.NAVAL_MAX_DETOUR;
    const path = Game.nearestCoastPath(p.id, targetTile, Math.floor(limit));
    return !path || path.length > limit;
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

  // --- Fog of war: beaches (docs/fog-of-war.md) ------------------------------
  // With the whole map in view navalThink ranks landmasses by a few sample
  // tiles each, GameMap's coastSample: the first twelve coastal tiles in scan
  // order, which is one landmass's northern tip. Under fog a nation may only
  // weigh a beach it has discovered, and those twelve are the wrong sample
  // for that: it could see the whole southern shore of the island next door
  // and still have nothing to send a boat to. So a fog match samples the
  // coast its own way, all the way round every landmass: one coastal tile
  // for each vision cell (game/vision.js, the unit discovery is counted in)
  // the coast runs through, thinned evenly to FOG_BEACH_CAP a landmass. A
  // beach is somewhere to land a boat once it is discovered, and somewhere to
  // send a Scout until then.
  //
  // Only coast on the ocean, the largest body of water, is sampled. A lake
  // shore is no use to a nation that is not already on that lake, and a beach
  // no Scout or boat can sail to would keep being picked and never reached.
  //
  // The table is fixed geography, worked out from the map alone, so it is the
  // same on every client and is not sim state: it lives here on AI, not on
  // Game, and nothing hashes it. The scan behind it reads every tile once
  // (about 20 ms on a 2000x1000 map). update() runs it a slice a tick from
  // the start of a fog match, so it is long finished by the first navalThink;
  // fogCoast() finishes whatever is left before it answers, so what a caller
  // gets never depends on how the slices fell.
  FOG_BEACH_CAP: 24,
  FOG_COAST_TICKS: 20,
  _fogCoast: null,

  // { beaches: one array of tiles per landmass (index = landmass id), ocean:
  // that body of water's GameMap.waterComponentId }.
  fogCoast() {
    let fc = this._fogCoast;
    while (!fc || fc.map !== GameMap.landmasses || !fc.ready) fc = this.fogCoastStep(Infinity);
    return fc;
  },

  // Advances the scan by `rows` map rows. Two passes over the map: the size
  // of every body of water, then the coast.
  fogCoastStep(rows) {
    let fc = this._fogCoast;
    if (!fc || fc.map !== GameMap.landmasses) {
      fc = this._fogCoast = {
        map: GameMap.landmasses, ready: false, row: 0, ocean: -1,
        sizes: [], seen: new Set(), beaches: GameMap.landmasses.map(() => [])
      };
    }
    if (fc.ready) return fc;
    const w = GameMap.width, h = GameMap.height;
    const owner = GameMap.owner, wc = GameMap.waterComponentId, lmOf = GameMap.landmassId;
    const cells = Game.visionCellsW * Game.visionCellsH;
    const end = Math.min(2 * h, fc.row + rows);
    for (; fc.row < end; fc.row++) {
      if (fc.row < h) {
        const sizes = fc.sizes;
        for (let t = fc.row * w, e = t + w; t < e; t++) {
          const c = wc[t];
          if (c >= 0) sizes[c] = (sizes[c] || 0) + 1;
        }
        if (fc.row === h - 1) {
          // The largest; the lowest id among equals.
          let most = 0;
          for (let c = 0; c < sizes.length; c++) if (sizes[c] > most) { most = sizes[c]; fc.ocean = c; }
        }
        continue;
      }
      const y = fc.row - h, ocean = fc.ocean;
      for (let x = 0, t = y * w; x < w; x++, t++) {
        if (owner[t] === WATER) continue;
        if (!((x > 0 && wc[t - 1] === ocean) || (x < w - 1 && wc[t + 1] === ocean) ||
              (y > 0 && wc[t - w] === ocean) || (y < h - 1 && wc[t + w] === ocean))) continue;
        const lm = lmOf[t];
        const key = lm * cells + Game.visionCellOf(t);
        if (lm < 0 || fc.seen.has(key)) continue;
        fc.seen.add(key);
        fc.beaches[lm].push(t);
      }
    }
    if (fc.row >= 2 * h) {
      const cap = this.FOG_BEACH_CAP;
      for (let i = 0; i < fc.beaches.length; i++) {
        const all = fc.beaches[i];
        if (all.length <= cap) continue;
        const kept = [];
        for (let k = 0; k < cap; k++) kept.push(all[Math.floor(k * all.length / cap)]);
        fc.beaches[i] = kept;
      }
      fc.sizes = fc.seen = null;
      fc.ready = true;
    }
    return fc;
  },

  // --- Fog of war: scouting (docs/fog-of-war.md) -----------------------------
  // Border sight alone shows a nation very little coast, so a nation with a
  // Port on the ocean keeps Scouts (game/scouts.js) at sea. Each is sent one
  // voyage at a time to the beach the nation most wants to see: the
  // undiscovered one nearest its own coast, by the same straight-line
  // distance navalThink ranks beaches with. Everything the Scout passes on
  // the way is revealed too, which is where most of a nation's contacts with
  // other nations come from.
  //
  // What a nation knows going in is where the sample beaches are (fogCoast),
  // never what is on them: nothing about an undiscovered tile is read here
  // but its position. Whether a voyage worked is judged the way a player
  // would judge it, by looking at the map afterwards:
  //   - the beach is discovered: good, on to the next;
  //   - the Scout has stopped and the beach is still black: it could not get
  //     there, and that beach is written off (`tried`);
  //   - the Scout is gone: the way there is watched, and every beach within
  //     SCOUT_LOSS_RADIUS of the one it was sailing for is written off, so
  //     the replacement is not sent after it.
  // A Scout that fails SCOUT_MAX_FAILS voyages running has run out of coast
  // it can get to (a Scout's route search gives up on the far side of a big
  // continent) and is left where it is. Each failure costs a full route
  // search, so the limit is also what bounds that.
  //
  // All of it is per nation, on `p.aiScout`, which only a nation with a Port
  // in a fog match ever gets:
  //   ships    one { id, tile, fails } per Scout afloat: its id, the beach it
  //            is sailing for (-1 when it has no order) and how many voyages
  //            in a row have failed
  //   tried    beaches (tiles) written off
  //   home     navalThink's last coastalTiles(p), for scoutPoll
  //   want     the beach the next Scout should be bought for, or -1
  //   bought   Scouts bought so far; lastBuy, the tick of the last purchase
  //   done     nothing left to find, or nobody left to look: stop thinking
  //
  // Cost. scoutThink runs on navalThink's beat (once a nation every 15-25 s)
  // and again when a voyage ends. Each run scans the sample beaches, under a
  // thousand tiles on The World; the vision grid itself is never walked.
  // scoutPoll and buyScout, on economy's beat, are a few comparisons.
  //
  // A replacement for a lost Scout waits SCOUT_REPLACE_TICKS after the last
  // purchase, so a nation whose Scouts keep being sunk pays for one every two
  // minutes at most.
  SCOUT_REPLACE_TICKS: 1200,
  SCOUT_MAX_FAILS: 3,
  SCOUT_LOSS_RADIUS: 80,

  scoutCap() {
    return Math.min(Game.MAX_SCOUTS_PER_PLAYER, this.profile().scouts);
  },

  // navalThink's hook, fog matches only. `homeCoast` is navalThink's own
  // coastalTiles(p) sample.
  scoutThink(p, homeCoast) {
    let st = p.aiScout;
    if (!st) {
      if (Game.unitsOwned(p, 'port') < 1) return;
      st = p.aiScout = { ships: [], tried: new Set(), home: null, want: -1, bought: 0, lastBuy: 0, done: false };
    }
    if (st.done) return;
    st.home = homeCoast;

    // What became of each order since the last look. `taken` collects the
    // beaches a Scout is still sailing for.
    const taken = [];
    for (let i = st.ships.length - 1; i >= 0; i--) {
      const rec = st.ships[i];
      const s = Game.scoutById(rec.id);
      if (!s) {
        if (rec.tile >= 0 && !Game.isDiscovered(p.id, rec.tile)) this.scoutWriteOff(st, rec.tile);
        st.ships.splice(i, 1);
        continue;
      }
      if (rec.tile >= 0 && !s.routing && s.pos >= s.path.length - 1) {
        if (Game.isDiscovered(p.id, rec.tile)) rec.fails = 0;
        else { rec.fails++; st.tried.add(rec.tile); }
        rec.tile = -1;
      }
      if (rec.tile >= 0) taken.push(rec.tile);
    }

    // A Scout with no order is sent on, rather than a new one bought.
    let none = false, retired = 0;
    for (const rec of st.ships) {
      if (rec.fails >= this.SCOUT_MAX_FAILS) { retired++; continue; }
      if (rec.tile >= 0 || none) continue;
      const tile = this.scoutTarget(p, homeCoast, st, taken);
      if (tile < 0) { none = true; continue; }
      if (!Game.moveScouts([Game.scoutById(rec.id)], tile, p.id)) continue;
      rec.tile = tile;
      taken.push(tile);
    }

    // Room for another: say which beach economy() should buy it for.
    const room = st.ships.length < this.scoutCap();
    st.want = room && !none ? this.scoutTarget(p, homeCoast, st, taken) : -1;
    if (room && st.want < 0) none = true;
    if ((none && taken.length === 0) || (!room && retired === st.ships.length)) st.done = true;
  },

  // A Scout bound for `tile` was sunk: write off that beach and its
  // neighbours.
  scoutWriteOff(st, tile) {
    const w = GameMap.width, tx = tile % w, ty = (tile / w) | 0;
    for (const list of this.fogCoast().beaches) {
      for (const b of list) {
        if (Math.abs((b % w) - tx) + Math.abs(((b / w) | 0) - ty) <= this.SCOUT_LOSS_RADIUS) st.tried.add(b);
      }
    }
  },

  // economy()'s hook, fog matches only: a Scout that has finished its voyage
  // (or been sunk on it) gets scoutThink's attention now, on economy's 2-5 s
  // beat, instead of drifting until the next navalThink.
  scoutPoll(p) {
    const st = p.aiScout;
    if (!st || st.done || !st.home) return;
    for (const rec of st.ships) {
      if (rec.tile < 0) continue;
      const s = Game.scoutById(rec.id);
      if (!s || (!s.routing && s.pos >= s.path.length - 1)) { this.scoutThink(p, st.home); return; }
    }
  },

  // The undiscovered beach nearest p's own coast, or -1. Skips beaches
  // written off, and beaches a Scout already under way (`taken`, the tiles
  // they are bound for) will reveal on arrival. Equal distances are settled
  // by Game.rng, which is drawn from only then.
  scoutTarget(p, homeCoast, st, taken) {
    const w = GameMap.width, sight = Game.VISION_SIGHT_SCOUT * Game.VISION_CELL;
    // nearestDist's distance, with the home coast's coordinates worked out
    // once rather than once per beach: this is the scan's whole cost.
    const n = homeCoast.length, hx = new Int32Array(n), hy = new Int32Array(n);
    for (let i = 0; i < n; i++) { hx[i] = homeCoast[i] % w; hy[i] = (homeCoast[i] / w) | 0; }
    let bestDist = Infinity;
    const ties = [];
    for (const list of this.fogCoast().beaches) {
      for (const tile of list) {
        if (Game.isDiscovered(p.id, tile) || st.tried.has(tile)) continue;
        const tx = tile % w, ty = (tile / w) | 0;
        let d = Infinity;
        for (let i = 0; i < n; i++) {
          let dx = hx[i] - tx, dy = hy[i] - ty;
          if (dx < 0) dx = -dx;
          if (dy < 0) dy = -dy;
          if (dx + dy < d) d = dx + dy;
        }
        if (d > bestDist) continue;
        let covered = false;
        for (const t of taken) {
          if (Math.abs((t % w) - tx) + Math.abs(((t / w) | 0) - ty) <= sight) { covered = true; break; }
        }
        if (covered) continue;
        if (d < bestDist) { bestDist = d; ties.length = 0; }
        ties.push(tile);
      }
    }
    if (ties.length === 0) return -1;
    return ties.length === 1 ? ties[0] : ties[Math.floor(Game.rng() * ties.length)];
  },

  // economy()'s hook, fog matches only: buys the Scout scoutThink asked for.
  // Not held back by the savings reserve, for the reason the first Port and
  // Warship are not (NAVY_EXEMPT_COUNT): at 25k it is a fortieth of a Silo.
  //
  // Bought toward the water beside one of p's own Ports on the ocean, and
  // given its real order straight afterwards. Game.buildScout launches from
  // the Port nearest the tile it is given, and a Scout launched into a lake
  // would never leave it; given discovered water, it launches onto that body
  // of water. The order comes from scoutThink rather than from `want`
  // because the launch itself reveals the sea round the Port, which can be
  // enough to show the beach that was wanted.
  buyScout(p) {
    const st = p.aiScout;
    if (!st || st.want < 0) return;
    if (Game.unitsOwned(p, 'port') < 1 || p.gold < Game.unitCost(p, 'scout')) return;
    if (st.bought >= this.scoutCap() && Game.ticks - st.lastBuy < this.SCOUT_REPLACE_TICKS) return;
    // One attempt per request: scoutThink asks again on its next beat.
    const beach = st.want;
    st.want = -1;
    if (Game.isDiscovered(p.id, beach)) return;
    const from = this.scoutLaunchWater(p, beach);
    if (from < 0 || !Game.buildScout(p.id, from)) return;
    st.ships.push({ id: Game.scouts[Game.scouts.length - 1].id, tile: -1, fails: 0 });
    st.bought++;
    st.lastBuy = Game.ticks;
    this.scoutThink(p, st.home);
  },

  // An ocean tile beside p's built Port nearest `beach`, or -1 when p has no
  // Port on the ocean. p's own shore, so always discovered.
  scoutLaunchWater(p, beach) {
    const ocean = this.fogCoast().ocean, wc = GameMap.waterComponentId, nb = Game.abuf;
    let best = -1, bestDist = Infinity;
    for (const b of Game.buildings.values()) {
      if (b.type !== 'port' || !b.built || GameMap.owner[b.tile] !== p.id) continue;
      const d = Game.tileDistSq(b.tile, beach);
      if (d >= bestDist) continue;
      const n = GameMap.neighbors(b.tile, nb);
      for (let k = 0; k < n; k++) {
        if (wc[nb[k]] === ocean) { best = nb[k]; bestDist = d; break; }
      }
    }
    return best;
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

// Tribe behaviour, ported from OpenFront's TribeExecution + AiAttackBehavior
// (the wiki's "bots spend 5% of their troops" is the old attackAmount, which the
// tribe code no longer calls). A tribe is still the "simple Bot" type — no
// diplomacy(), no economy(), no navalThink() — but it is NOT timid per attack:
// on a fixed 4-8s beat it commits everything above a reserve, and unclaimed
// land only has to clear the small `expand` reserve. What keeps tribes weak is
// their small cap and slow growth (TRIBE_TROOP_CAP_MULT / TRIBE_GROWTH_MULT in
// economy.js), which bound how much any one of those attacks can carry.
const TribeAI = {
  // TribeExecution's constructor rolls, per tribe. Drawn once at init.
  rollTraits() {
    const r = (lo, hi) => lo + Math.floor(Game.rng() * (hi - lo + 1));
    const beatTicks = r(40, 80);
    return {
      beat: beatTicks / Game.TICKS_PER_SEC,        // seconds between decisions
      phase: r(0, beatTicks) / Game.TICKS_PER_SEC, // wait before the first one
      trigger: r(50, 60) / 100,  // fill ratio needed before picking a fight
      reserve: r(30, 40) / 100,  // fill ratio kept back when fighting a player
      expand: r(10, 20) / 100,   // fill ratio kept back when grabbing free land
      opened: false
    };
  },

  update() {
    for (const p of Game.players) {
      if (!p.isTribe || !p.alive) continue;
      const tr = p.tribeTraits;
      if (!tr) continue;
      // The first beat is the per-tribe phase offset, every later one is the
      // fixed beat (OpenFront: ticks % attackRate === attackTick).
      if (p.tribeNextAt === undefined) p.tribeNextAt = tr.phase;
      p.tribeNextAt -= Game.TICK_DT;
      if (p.tribeNextAt <= 0) {
        p.tribeNextAt += tr.beat;
        this.think(p);
      }
    }
  },

  // AiAttackBehavior.sendAttack for a tribe: everything above the reserve goes
  // out in one push. No cap on concurrent attacks — launchAttack folds any
  // second push at the same target into the first, as OpenFront's does.
  sendAttack(p, target) {
    const tr = p.tribeTraits;
    const keep = Game.maxTroops(p) * (target === NEUTRAL ? tr.expand : tr.reserve);
    const troops = Math.floor(p.troops - keep);
    if (troops < 1) return false;
    return Game.launchAttack(p.id, target, troops);
  },

  think(p) {
    if (p.tiles.size === 0) return;
    const tr = p.tribeTraits;
    const targets = AI.borderTargets(p);

    // First decision ever: grab free land straight away, then wait a beat.
    if (!tr.opened) {
      tr.opened = true;
      if (targets.has(NEUTRAL)) this.sendAttack(p, NEUTRAL);
      return;
    }

    // Free land always comes first, and does not wait on the trigger ratio.
    if (targets.has(NEUTRAL) && this.sendAttack(p, NEUTRAL)) return;

    // attackRandomTarget: save up to the trigger ratio before fighting anyone.
    if (p.troops / Game.maxTroops(p) < tr.trigger) return;

    // Retaliate against whoever has the biggest push aimed at us.
    let hitter = -1, biggest = 0;
    for (const a of Game.attacks) {
      if (a.target !== p.id || a.retreating || a.troops <= biggest) continue;
      if (p.allies.has(a.attacker)) continue;
      biggest = a.troops; hitter = a.attacker;
    }
    if (hitter >= 0 && this.attackPlayer(p, hitter)) return;

    // Otherwise a random bordering player, shuffled. Nations and humans are
    // skipped on a coin flip, so tribes mostly pick on each other.
    const ids = [...targets.keys()].filter(id => id >= 0);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Game.rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (const id of ids) {
      if (!Game.players[id].isTribe && Game.rng() < 0.5) continue;
      if (this.attackPlayer(p, id)) return;
    }
  },

  attackPlayer(p, target) {
    if (AI.annexIfEnclosed(p, target)) return true;
    return this.sendAttack(p, target);
  }
};
