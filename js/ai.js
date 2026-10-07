// Bot behaviour: expansion, and — since alliances exist — diplomacy.
//
// OpenFront branches almost every diplomatic decision on a difficulty setting.
// The thresholds below are their MEDIUM column; PROFILES carries the few that
// the Easy and Hard tiers move, and profile() picks the row for the match.
const AI = {
  // What a difficulty changes about how a Nation *plays*. Troop start, cap
  // and growth are Game.NATION_DIFFICULTY in game/economy.js. Tribes ignore
  // both.
  //
  // MEDIUM MUST STAY THE BASELINE (the sim goldens pin it). Tune Easy and
  // Hard around it.
  //
  //   thinkMult / navalMult  scale the gap between land / naval decisions.
  //   confusion              1-in-n chance an alliance answer is a coin flip;
  //                          0 = never.
  //   betrayHelpless         betray an ally whose army is under 1/n of ours.
  //   betrayOpportunist      also betray a traitor who can't punish it, or the
  //                          last neighbour on the map.
  //   nukes                  whether it builds Silos and fires warheads at all.
  //   nukeChance / hydrogenChance  1-in-n roll per economy cycle to fire, and
  //                          to make that warhead a Hydrogen Bomb.
  //   mirvChance             1-in-n roll, on a Hydrogen-worthy strike (see
  //                          maybeNuke), to use a MIRV instead. 0 = never.
  //   retaliateChance        1-in-n roll per economy cycle to nuke a nation
  //                          actively eating our land (maybeRetaliate);
  //                          0 = never.
  //   salvo                  the most Atom Bombs it fires as one strike to get
  //                          past SAM cover (see nukeTarget). 1 = single shots
  //                          only, never into cover.
  //   embargoLiftAt          relation at which a nation lifts an embargo it
  //                          placed.
  //   scouts                 fog of war only: how many Scouts it keeps afloat
  //                          (see scoutThink).
  //
  // How much a strike commits is not a difficulty knob: see rollTraits.
  PROFILES: {
    easy: {
      thinkMult: 1.6, navalMult: 1.6,
      confusion: 10,
      betrayHelpless: 20, betrayOpportunist: false,
      nukes: false, nukeChance: 0, hydrogenChance: 4, mirvChance: 0, retaliateChance: 0, salvo: 1,
      embargoLiftAt: 0, scouts: 1
    },
    medium: {
      thinkMult: 1, navalMult: 1,
      confusion: 20,
      betrayHelpless: 10, betrayOpportunist: true,
      nukes: true, nukeChance: 8, hydrogenChance: 4, mirvChance: 6, retaliateChance: 2, salvo: 3,
      embargoLiftAt: 0, scouts: 2
    },
    hard: {
      thinkMult: 0.7, navalMult: 0.7,
      confusion: 0,
      betrayHelpless: 5, betrayOpportunist: true,
      nukes: true, nukeChance: 5, hydrogenChance: 3, mirvChance: 4, retaliateChance: 1, salvo: 5,
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
        p.nextNavalThink = (7.5 + Game.rng() * 5) * prof.navalMult;
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

  // Troop donations, team games only (Game.donateBlockReason): a Nation
  // reinforcing a teammate or ally that is actively fighting. One-directional;
  // nobody asks for help. 1-in-n per check; 0 = never (Easy).
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

  // Bots have to spend, or only the human's cap ever grows. Buy whenever
  // affordable: the price doubling per unit owned is the rate limiter.
  //
  // Cost-pooled types (Port/Factory share one price) need care: building one
  // doubles the price of the other within the same call. Bots pick ONE member
  // of the pool per cycle (see economy() and PORTS_PER_FACTORY).

  // How many SAM Launchers to plant for coverage before further spend goes
  // into levelling up the weakest one (see economy()).
  SAM_COVERAGE_TARGET: 2,

  // --- Strategic savings ---------------------------------------------------
  // economy() buys whatever it can afford, which alone would keep the
  // Silo/nuke/SAM half of the tech tree out of reach: a Fort's price is
  // linear and capped, and fortSite() always finds another border tile, so
  // a mature nation would sink every 250k into Forts.
  //
  //   (a) FORT_CAP_BASE bounds the Fort sink.
  //   (b) savingsGoal()/savingsReserve() give the bot ONE big-ticket item to
  //       save for and stop cheaper purchases eating into that reserve.
  //
  // A bot may hold this many Forts plus one per City it owns.
  FORT_CAP_BASE: 2,

  // Don't hoard for a Silo out of a small economy: maxTroops keys off City
  // level, so a bot that stops developing stops being able to fight. Three
  // cities is roughly where income can refill a reserve.
  SILO_MIN_CITIES: 3,

  // How many Ports, and separately how many Warships, a nation may buy even
  // while savingsGoal is holding gold back. One of each: the Port unlocks
  // trade income and the navy, and one ship patrols the home coast. Anything
  // past that waits its turn behind the Silo/SAM/bomb reserve like any other
  // purchase.
  NAVY_EXEMPT_COUNT: 1,

  // Which single big-ticket purchase this bot is banking toward, or null
  // for 'spend freely'. One goal at a time, in this order:
  //
  //   1. Silo: no nuke can be launched without one.
  //   2. SAM cover, once somebody else's Silo exists, up to
  //      SAM_COVERAGE_TARGET.
  //   3. Otherwise keep an Atom Bomb's price banked, so a built Silo is an
  //      armed one. If the last strike weighed needed a salvo (p.aiSalvo,
  //      see maybeNuke), bank that many bombs and first build the Silo
  //      slots to fire them together.
  //
  // All counts come off ONE walk of Game.buildings (this runs per bot per
  // economy cycle). The rival count includes the human's Silos.
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
        if (owner === p.id) ownSilos += b.level;
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
    if (nukes && ownSilos < (p.aiSalvo || 0)) return 'silo';
    if (rivalSilos > 0 && ownSams < this.SAM_COVERAGE_TARGET) return 'sam';
    return nukes ? 'atombomb' : null;
  },

  savingsReserve(p, goal) {
    if (goal === 'drill') return Game.unitCost(p, 'drill') + this.DRILL_RESERVE;
    if (goal === 'atombomb') return Game.unitCost(p, goal) * Math.max(1, p.aiSalvo || 0);
    return goal ? Game.unitCost(p, goal) : 0;
  },

  // --- The Drill (Battle Royale) ---------------------------------------------
  // A bot goes for the Drill only once the match has stalled (drillStalled):
  // DRILL_STALL_AFTER seconds have passed, no nation holds more than
  // DRILL_STALL_SHARE of the land, and the bot is not the land leader.
  //
  // The Drill then becomes its savings goal (DRILL_COST + DRILL_RESERVE);
  // without that no bot ever saves enough. With the gold in hand it must
  // still win a 1-in-DRILL_CHANCE roll per economy cycle. Derived from live
  // state only; the roll is drawn only when every other gate passes, so
  // pre-stall matches consume no extra rng. Never runs once Game.drill exists.
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
    this.reviewStrike(p);
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
      // `action` units (Warship, bombs, Scout) never go through
      // buildBlockReason/build; each has its own purchase call below. Silo
      // is an ordinary structure and rides this loop. fogOnly (the Radio
      // Tower) has buyRadio, and with fog off must not even reach
      // buildSite, which draws from Game.rng.
      if (u.action || u.fogOnly) continue;
      if (consideredTypes.has(u.type)) continue;
      const pool = u.costGroup || [u.type];
      for (const t of pool) consideredTypes.add(t);

      let type = pool[0];
      if (pool.length > 1) {
        // Factory or Port: PORTS_PER_FACTORY Ports per Factory, since a
        // trade ship pays several times what a train does. The Port leads:
        // the two share one price curve, and while saving for a Silo only
        // the (reserve-exempt) Port is affordable. Whichever has no site
        // worth its price gives way to the other below.
        const owned = t => Game.unitsOwned(p, t) + Game.unitsPending(p, t);
        type = owned('port') < this.PORTS_PER_FACTORY * (owned('factory') + 1) ? 'port' : 'factory';
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

      if (spendable(type) < Game.unitCost(p, type) &&
          (pool.length < 2 || spendable('port') < Game.unitCost(p, 'port'))) continue;

      // A SAM's payoff past the first couple of launchers is charges, not
      // range: its samQueue cap is its level, so a level-2 SAM can stop
      // two converging nukes. buildSite would keep finding fresh tiles
      // and scatter level-1 SAMs forever, so once SAM_COVERAGE_TARGET
      // launchers exist, further spend upgrades the weakest one.
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

      let tile = -1;
      if (pool.length > 1) {
        const cost = Game.unitCost(p, type), order = [type, type === 'port' ? 'factory' : 'port'];
        for (const t of order) {
          if (spendable(t) < cost) continue;
          tile = t === 'port' ? this.portSite(p) : this.factorySite(p);
          if (tile >= 0) { type = t; break; }
        }
        // No site for either: grow whichever it already has, below.
        if (tile < 0 && this.weakestBuilt(p, type) < 0) type = order[1];
      } else {
        tile = type === 'fort' ? this.fortSite(p) : type === 'city' ? this.citySite(p) : this.buildSite(p);
      }
      if (tile >= 0) Game.build(p.id, type, tile);
      // No fresh site at all (a small/landlocked/built-out nation) but the
      // type still has room to grow in place — upgrade the weakest one
      // rather than leaving this cycle's gold unspent. Fort/Warship/the
      // bombs are upgradable:false, so this only ever fires for
      // City/Factory/Port/Silo/SAM, and never fights the branch above for SAM.
      else if (Game.unitDef(type).upgradable && spendable(type) >= Game.unitCost(p, type)) {
        const upgradeTile = this.weakestBuilt(p, type);
        if (upgradeTile >= 0 && Game.canUpgrade(p.id, upgradeTile)) Game.upgrade(p.id, upgradeTile);
      }
    }

    // `action` units need their own site/target selection and purchase
    // call. A Warship needs a Port (Game.resolveWarshipLaunch); checked here
    // to skip a coastalTiles scan for a purchase that would fail.
    if (Game.unitsOwned(p, 'port') >= 1 && spendable('warship') >= Game.unitCost(p, 'warship')) {
      const site = this.warshipSite(p);
      if (site >= 0) Game.buildWarship(p.id, site);
    }

    // Fog of war: a Scout, once scoutThink has somewhere to send one. After
    // the build order above, so it is paid for out of what that leaves.
    if (Game.fog) { this.scoutPoll(p); this.buyScout(p); this.buyRadio(p); }

    this.maybeNuke(p);
  },

  // --- Fog of war: Radio Towers (docs/fog-of-war.md) -------------------------
  // economy()'s hook, fog matches only. A nation with no shore on the ocean
  // can launch no Scout, so a Radio Tower is its way to see past its border.
  // Nations that reach the ocean explore by Scout instead.
  //
  // One tower at a time, RADIO_CAP in a match. The site is whichever of up
  // to RADIO_SITE_SAMPLES border tiles, spread evenly round the border, has
  // the most undiscovered cells in the tower's disc; nothing is bought unless
  // it uncovers at least RADIO_MIN_CELLS. Not held back by the savings reserve.
  //
  // Draws nothing from Game.rng: p.borderTiles is walked in its insertion
  // order, which every client shares.
  RADIO_CAP: 3,
  RADIO_SITE_SAMPLES: 8,
  RADIO_MIN_CELLS: 60,

  buyRadio(p) {
    if (Game.unitsPending(p, 'radio') > 0 || Game.unitsBuilt(p, 'radio') >= this.RADIO_CAP) return;
    if (p.gold < Game.unitCost(p, 'radio')) return;
    if (this.hasOceanCoast(p)) return;
    const tile = this.radioSite(p);
    if (tile >= 0) Game.build(p.id, 'radio', tile);
  },

  // Whether any of p's land touches the ocean (the largest body of water,
  // see fogCoast) — a lake shore launches no Scout that gets anywhere.
  hasOceanCoast(p) {
    const ocean = this.fogCoast().ocean, wc = GameMap.waterComponentId, nb = Game.abuf;
    for (const t of p.borderTiles) {
      const n = GameMap.neighbors(t, nb);
      for (let k = 0; k < n; k++) if (wc[nb[k]] === ocean) return true;
    }
    return false;
  },

  radioSite(p) {
    const step = Math.max(1, Math.floor(p.borderTiles.size / this.RADIO_SITE_SAMPLES));
    let best = -1, bestHidden = this.RADIO_MIN_CELLS - 1, i = 0;
    for (const t of p.borderTiles) {
      if (i++ % step !== 0 || Game.structureTooClose(t)) continue;
      const hidden = Game.visionHiddenAround(p.id, t, Game.VISION_SIGHT_RADIO);
      if (hidden > bestHidden) { bestHidden = hidden; best = t; }
    }
    return best;
  },

  // A bot with a ready Silo and a warhead's worth of gold banked (see
  // savingsGoal) occasionally fires an Atom Bomb at the rival it borders or
  // fights the most (the `contact` signal from borderTargets). Tribes and
  // neutral land are skipped. Rolled 1-in-nukeChance per economy() cycle.
  // nukeTarget() aims at the target's structures.
  //
  // A Hydrogen Bomb costs far more for a much wider blast, so it only pays
  // against a large rival: HYDROGEN_WORTHY gates on the target outweighing
  // the bot, and PROFILES.hydrogenChance rations it further.
  maybeNuke(p) {
    const prof = this.profile();
    if (!prof.nukeChance) return;
    if (p.gold < Game.unitCost(p, 'atombomb')) return;
    // hasReadySilo(), not unitsOwned(p, 'silo'): it also tests
    // SILO_COOLDOWN, and it reads the real buildings map. The p.units
    // running total has been seen to go negative, which would disarm the
    // bot for the rest of the match.
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
    // How many Atom Bombs that aim point takes (0: more than this tier will
    // fire) and the tile the strike is meant for. Scratch, so read it now.
    const salvo = this.salvo, watch = this.salvoWatch;
    p.aiSalvo = 0;

    const hydrogenWorthy = target.tiles.size > p.tiles.size || target.troops > p.troops;
    // MIRV: the tier above Hydrogen, only worth its price against a rival that
    // dwarfs us. Returns early on a hit, so no second warhead the same cycle.
    // Its 350 warheads swamp any SAM cover, so it needs no salvo.
    const mirvWorthy = hydrogenWorthy && target.tiles.size > p.tiles.size * 1.5;
    if (mirvWorthy && p.gold >= Game.unitCost(p, 'mirv') && this.chance(prof.mirvChance)) {
      Game.launchMirv(p.id, targetTile);
      return;
    }
    if (hydrogenWorthy && p.gold >= Game.unitCost(p, 'hydrogenbomb') && this.chance(prof.hydrogenChance)) {
      const tile = this.standoff(p, target, watch, 'hydrogenbomb');
      if (tile >= 0 && this.fireSalvo(p, tile, 1, 'hydrogenbomb')) return;
    }
    if (!salvo) return;
    // Not enough gold or Silo slots for the whole salvo yet: hold fire and
    // bank for it (savingsGoal) instead of feeding the SAMs one bomb at a time.
    if (!this.fireSalvo(p, targetTile, salvo)) p.aiSalvo = salvo;
  },

  // --- Nukes against SAM cover -------------------------------------------------
  // A SAM destroys any hostile nuke inside its range the tick it has a free
  // charge (Game.stepSAMs), and a charge takes SAM_COOLDOWN to come back, so
  // one bomb at a covered target is wasted. A nation works out what a strike
  // will meet before paying for it:
  //
  //   - predictSalvo flies the bombs ahead of time against every SAM the
  //     nation knows of, charges and reloads included. Third parties count.
  //   - nukeTarget weighs each aim point by what it destroys per bomb, so an
  //     open City can beat a covered Silo, and a SAM is worth a salvo because
  //     it uncovers everything behind it.
  //   - a blast destroys every structure inside its outer radius, so a bomb
  //     can land short. standoff pulls the aim point back toward the Silo
  //     until the flight stays outside the cover: one bomb instead of a
  //     salvo. A Hydrogen Bomb's blast is wider than a low-level SAM's range.
  //   - otherwise a covered target gets one bomb more than the cover has
  //     charges, all launched the same tick (fireSalvo), up to the tier's
  //     `salvo`. Short of gold or Silo slots, it saves up (p.aiSalvo). A
  //     Hydrogen Bomb flies alone or not at all.
  //   - a strike that fails was shot down by something the prediction
  //     missed. The nation remembers that as cover over the spot (p.aiCover)
  //     and sends one bomb more next time.
  //
  // Fog of war: an undiscovered SAM is not in the prediction. It still
  // shoots, which is what the last point is for.
  //
  // predictSalvo draws nothing from Game.rng and writes nothing.

  // Whether each of `shots` ({ type, dst }, in launch order, all fired this
  // tick) would land: an array of booleans, or null when p has too few ready
  // Silo slots to fire them all. `anySilo` plans ahead instead: a shot with
  // no free slot left flies from the nearest Silo regardless.
  predictSalvo(p, shots, anySilo) {
    const w = GameMap.width, dt = Game.TICK_DT, now = Game.elapsed;
    const silos = [];
    for (const b of Game.buildings.values()) {
      if (b.type !== 'silo' || !b.built || GameMap.owner[b.tile] !== p.id) continue;
      silos.push({ tile: b.tile, free: Game.siloFreeSlots(b) });
    }
    // Each shot leaves the nearest Silo with a slot, as resolveNukeLaunch
    // picks it; the first of equals, as its stable sort does.
    const nukes = [];
    let ticks = 0;
    for (const shot of shots) {
      let from = null, any = null, fromD = Infinity, anyD = Infinity;
      for (const s of silos) {
        const d = Game.tileDistSq(s.tile, shot.dst);
        if (d < anyD) { anyD = d; any = s; }
        if (s.free > 0 && d < fromD) { fromD = d; from = s; }
      }
      if (from) from.free--;
      else if (anySilo && any) from = any;
      else return null;
      const fx = from.tile % w, fy = (from.tile / w) | 0, tx = shot.dst % w, ty = (shot.dst / w) | 0;
      const dist = Game.det.hypot(tx - fx, ty - fy);
      const duration = Math.max(0.3, dist / Game.NUKE_SPEED[shot.type]);
      ticks = Math.max(ticks, Math.ceil(duration / dt) + 1);
      nukes.push({
        fx, fy, tx, ty, duration, x: fx, y: fy, score: 0,
        rise: Math.min(dist * 0.35, 40),   // Game.nukeArcPos' arc height
        bonus: shot.type === 'hydrogenbomb' ? 70001 : 0,
        state: 0   // 0 flying, 1 landed, 2 shot down
      });
    }

    // Only SAMs a flight can come within range of: the straight line from
    // Silo to target, widened by the arc that lifts the missile off it.
    const sams = [];
    for (const b of Game.buildings.values()) {
      if (b.type !== 'sam' || !b.built) continue;
      const owner = GameMap.owner[b.tile];
      if (owner < 0 || owner === p.id || Game.areAllied(owner, p.id)) continue;
      if (Game.fog && !Game.isDiscovered(p.id, b.tile)) continue;
      const x = b.tile % w, y = (b.tile / w) | 0, range = Game.samRange(b.level);
      for (const n of nukes) {
        const sx = n.tx - n.fx, sy = n.ty - n.fy, len2 = sx * sx + sy * sy;
        const u = len2 ? Math.max(0, Math.min(1, ((x - n.fx) * sx + (y - n.fy) * sy) / len2)) : 0;
        const dx = n.fx + sx * u - x, dy = n.fy + sy * u - y, reach = range + n.rise;
        if (dx * dx + dy * dy > reach * reach) continue;
        sams.push({ b, x, y, queue: b.samQueue.slice() });
        break;
      }
    }

    const landed = nukes.map(() => true);
    if (!sams.length) return landed;
    let flying = nukes.length;
    // Tick by tick as Game.tick will: stepSAMs, then stepNukes. The launch
    // tick itself is over by the time AI.update runs.
    for (let k = 1; k <= ticks && flying; k++) {
      const since = k * dt, t = now + since;
      for (const n of nukes) {
        if (n.state) continue;
        // Game.nukeArcPos.
        const u = Math.min(1, since / n.duration), c = u * (1 - u);
        n.x = n.fx + (n.tx - n.fx) * u;
        n.y = n.fy + (n.ty - n.fy) * u - 16 * c / (5 - 4 * c) * n.rise;
      }
      for (const sam of sams) {
        const q = sam.queue, level = sam.b.level;
        while (q.length && t - q[0] >= Game.SAM_COOLDOWN) q.shift();
        if (q.length >= level) continue;
        const range = Game.dynamicSamRange(sam.b, t), range2 = range * range;
        const inRange = [];
        for (const n of nukes) {
          if (n.state) continue;
          const dx = n.x - sam.x, dy = n.y - sam.y;
          if (dx * dx + dy * dy > range2) continue;
          // Game.samTargetScore, on this prediction's clock.
          n.score = n.bonus +
            Math.max(0, 200000 - (Math.abs(n.tx - sam.x) + Math.abs(n.ty - sam.y)) * 1000) +
            Math.max(0, 10000 - (n.duration - since) * Game.TICKS_PER_SEC * 100);
          inRange.push(n);
        }
        if (inRange.length > 1) inRange.sort((a, c) => c.score - a.score);
        for (const n of inRange) {
          if (q.length >= level) break;
          q.push(t);
          n.state = 2;
          flying--;
        }
      }
      for (const n of nukes) {
        if (!n.state && since >= n.duration) { n.state = 1; flying--; }
      }
    }
    for (let i = 0; i < nukes.length; i++) landed[i] = nukes[i].state !== 2;
    return landed;
  },

  // The fewest bombs of `type`, all aimed at `dst` and fired together, that
  // put one on the ground: 1 for an open target, 0 when `max` are not enough
  // (or, without `anySilo`, when the ready Silo slots run out first). One
  // flight of `max` shows how many the cover eats; the answer is one more,
  // checked, since a smaller salvo leaves from fewer Silos.
  salvoSize(p, type, dst, max, anySilo) {
    if (max < 1) return 0;
    const shots = [{ type, dst }];
    let landed = this.predictSalvo(p, shots, anySilo);
    if (!landed) return 0;
    if (landed[0]) return 1;
    while (shots.length < max) shots.push(shots[0]);
    while (shots.length > 1 && !(landed = this.predictSalvo(p, shots, anySilo))) {
      if (anySilo) return 0;
      shots.pop();   // only as many as there are ready slots
    }
    if (!landed || !landed.includes(true)) return 0;
    const most = shots.length;
    let n = most - landed.filter(Boolean).length + 1;
    for (; n < most; n++) {
      shots.length = n;
      if (this.predictSalvo(p, shots, anySilo).includes(true)) break;
      while (shots.length < most) shots.push(shots[0]);
    }
    return n;
  },

  // Fires `n` bombs (Atom unless `type` says otherwise) at `tile` this tick,
  // if p can pay for them all and has the Silo slots to get one through. All
  // or nothing. What it fired is noted for reviewStrike.
  fireSalvo(p, tile, n, type = 'atombomb') {
    if (p.gold < Game.unitCost(p, type) * n) return false;
    const landed = this.predictSalvo(p, new Array(n).fill({ type, dst: tile }));
    if (!landed || !landed.includes(true)) return false;
    for (let i = 0; i < n; i++) Game.launchNuke(p.id, type, tile);
    this.noteStrike(p, tile, n);
    return true;
  },

  // An aim point from which ONE `type` bomb both lands and destroys
  // whatever stands on `tile`, or -1. Each STANDOFF entry is how far to
  // pull the aim back from the structure toward the firing Silo; the first
  // whose flight gets through wins. A pulled-back point must be the
  // target's own discovered land, and the blast must stay off p's side
  // (blastSafe), which a Hydrogen Bomb is held to even at 0.
  STANDOFF: { atombomb: [12, 24], hydrogenbomb: [0, 30, 60, 90] },

  standoff(p, target, tile, type) {
    const w = GameMap.width, h = GameMap.height;
    if (this.coverAt(p, tile)) return -1;
    let silo = -1, best = Infinity;
    for (const b of Game.buildings.values()) {
      if (b.type !== 'silo' || !b.built || GameMap.owner[b.tile] !== p.id || Game.siloFreeSlots(b) < 1) continue;
      const d = Game.tileDistSq(b.tile, tile);
      if (d < best) { best = d; silo = b.tile; }
    }
    if (silo < 0) return -1;
    const tx = tile % w, ty = (tile / w) | 0;
    const dx = (silo % w) - tx, dy = ((silo / w) | 0) - ty;
    const len = Game.det.hypot(dx, dy);
    for (const back of this.STANDOFF[type]) {
      if (back >= len) break;
      const x = back ? Math.round(tx + dx / len * back) : tx, y = back ? Math.round(ty + dy / len * back) : ty;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const aim = y * w + x;
      if (back && (GameMap.owner[aim] !== target.id || (Game.fog && !Game.isDiscovered(p.id, aim)))) continue;
      if ((back || type === 'hydrogenbomb') && !this.blastSafe(p, aim, type)) continue;
      const landed = this.predictSalvo(p, [{ type, dst: aim }]);
      if (landed && landed[0]) return aim;
    }
    return -1;
  },

  // Whether a `type` blast at `tile` keeps clear of p's side: none of p's
  // structures or its allies' inside the outer radius, no allied land (either
  // would break the alliance, see Game.maybeBreakNukeAlliances), and p's own
  // land no more than BLAST_OWN_LIMIT of what a coarse grid over the blast
  // finds owned.
  BLAST_OWN_LIMIT: 0.1,

  blastSafe(p, tile, type) {
    const mag = Game.NUKE_MAGNITUDES[type];
    const w = GameMap.width, h = GameMap.height;
    const cx = tile % w, cy = (tile / w) | 0, outer2 = mag.outer * mag.outer;
    for (const b of Game.buildings.values()) {
      if (Game.tileDistSq(tile, b.tile) >= outer2) continue;
      const o = GameMap.owner[b.tile];
      if (o === p.id || (o >= 0 && Game.areAllied(p.id, o))) return false;
    }
    const step = Math.max(1, Math.round(mag.outer / 15));
    let mine = 0, owned = 0;
    for (let y = Math.max(0, cy - mag.outer); y <= Math.min(h - 1, cy + mag.outer); y += step) {
      for (let x = Math.max(0, cx - mag.outer); x <= Math.min(w - 1, cx + mag.outer); x += step) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > outer2) continue;
        const o = GameMap.owner[y * w + x];
        if (o < 0) continue;
        if (o === p.id) mine++;
        else if (Game.areAllied(p.id, o)) return false;
        owned++;
      }
    }
    return mine <= owned * this.BLAST_OWN_LIMIT;
  },

  // Learning from a failed strike. noteStrike records where `n` bombs were
  // aimed; once the last is due, reviewStrike checks p.nukeLoss, the sim's
  // record of p's bombs shot down (Game.noteNukeShot). All `n` lost means
  // unpredicted cover: it becomes p.aiCover, `n` charges over the spot for
  // COVER_MEMORY seconds, which coverAt adds to later plans within SAM
  // range. One strike and one patch of cover at a time: the latest.
  COVER_MEMORY: 180,

  noteStrike(p, tile, n) {
    let eta = Game.elapsed;
    for (const k of Game.nukes) if (k.ownerId === p.id) eta = Math.max(eta, k.born + k.duration);
    p.aiStrike = { tile, n, at: Game.elapsed, eta: eta + 1 };
  },

  reviewStrike(p) {
    const s = p.aiStrike;
    if (!s || Game.elapsed < s.eta) return;
    p.aiStrike = null;
    const loss = p.nukeLoss, unseen = this.coverAt(p, s.tile);
    if (loss && loss.dst === s.tile && loss.at >= s.at && loss.n >= s.n) {
      p.aiCover = { tile: s.tile, n: s.n + unseen, until: Game.elapsed + this.COVER_MEMORY };
    } else if (unseen) p.aiCover = null;
  },

  // Charges of unseen cover p has learned of over `tile`; 0 for none.
  coverAt(p, tile) {
    const c = p.aiCover, r = Game.SAM_MAX_RANGE;
    return c && Game.elapsed < c.until && Game.tileDistSq(c.tile, tile) <= r * r ? c.n : 0;
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

  // Last-ditch retaliation; maybeNuke alone rarely answers an attacker.
  //
  // Triggers when the bot lost at least RETALIATE_LOSS_FRAC of its land
  // (RETALIATE_MIN_LOSS tiles minimum) since its previous economy cycle
  // while a non-Tribe nation has a live attack on it. The target is the
  // attacker with the most troops committed against us. The warhead goes on
  // the attacker's land just behind the front (retaliationTarget), killing
  // troops and leaving a fallout belt across the push.
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
      if (tile >= 0) return this.fireSalvo(p, tile, 1, 'hydrogenbomb');
    }
    const tile = this.retaliationTarget(p, hitter, 'atombomb');
    return tile >= 0 && this.fireSalvo(p, tile, this.salvo);
  },

  // Candidate aim points: from a sample of the front tiles under attack
  // (a.border holds OUR tiles next to their land), step into the attacker's
  // territory at a few depths; plus their structures. Each is scored on a
  // coarse grid over the blast's outer circle: attacker land counts for it,
  // our land against it (rejected past RETALIATE_OWN_LIMIT), and any ally
  // land or structure, or any structure of ours, rejects it outright
  // (maybeBreakNukeAlliances would fire). Returns -1 when no candidate is
  // clean enough.
  //
  // SAM cover: an aim point is scored per bomb it takes to land one there
  // with the gold and ready Silo slots p has now (plus learned cover,
  // coverAt), and dropped if p cannot fire that many. The count for the
  // point returned is left in this.salvo. A Hydrogen Bomb goes alone.
  //
  // Fog of war: p aims only at what it has discovered. Its own land and its
  // allies' is always discovered, so the safety checks lose nothing.
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
    const maxSalvo = type === 'atombomb'
      ? Math.min(this.profile().salvo, Math.floor(p.gold / Game.unitCost(p, type))) : 1;
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
      if (score <= bestScore) continue;
      let n = this.salvoSize(p, type, c, maxSalvo);
      if (n) n += this.coverAt(p, c);
      if (!n || n > maxSalvo) continue;
      score /= n;
      if (score > bestScore) { bestScore = score; best = c; this.salvo = n; }
    }
    return best;
  },

  // Where to put the warhead. Aim at the target's structures, ranked by
  // what hurts most to lose: Silo, then SAM cover, then the economy.
  // Jittered so repeated strikes don't land on one tile. Falls back to a
  // random owned tile when the target has nothing built.
  //
  // SAM cover: the best NUKE_AIM_CANDIDATES structures are each priced in
  // Atom Bombs (the salvo needed to land one), and the pick is the most
  // priority per bomb. If none can be reached, any lesser structure one bomb
  // gets to will do, then up to NUKE_LAND_TRIES random tiles of open ground.
  // this.salvo holds the count for the tile returned; 0 means everything is
  // covered past the tier's `salvo`, and the tile is then just the top
  // structure (a MIRV can still use it). The count assumes Silo slots p may
  // not have yet: maybeNuke saves up for the difference. The tile is the
  // structure's own, or a standoff point short of it; this.salvoWatch is the
  // structure either way.
  //
  // Fog of war: p aims only at a structure or tile of the target's it has
  // discovered. -1 when it can see none of the target's land.
  NUKE_TARGET_PRIORITY: { silo: 4, sam: 3, city: 2, factory: 1, port: 1 },
  NUKE_AIM_CANDIDATES: 6,
  NUKE_LAND_TRIES: 4,
  // Atom Bombs the aim point last returned by nukeTarget / retaliationTarget
  // takes. Scratch, read back in the same call chain; never sim state.
  salvo: 1,
  salvoWatch: -1,
  _aims: [],

  nukeTarget(target, p) {
    const max = this.profile().salvo;
    const open = this.nukeTargetOpen(target, p);
    this.salvo = 0;
    this.salvoWatch = open;
    if (open < 0) return -1;
    const aims = this._aims;
    if (!aims.length) {
      const unseen = this.coverAt(p, open);
      const n = this.salvoSize(p, 'atombomb', open, max - unseen, true);
      this.salvo = n && n + unseen;
      return open;
    }
    let best = open, bestValue = 0;
    for (let i = 0; i < aims.length; i++) {
      // Past the leading candidates a structure is only a way out of having
      // no shot at all, and only if a single bomb reaches it.
      const deep = i < this.NUKE_AIM_CANDIDATES;
      if (!deep && bestValue) break;
      const c = aims[i], unseen = this.coverAt(p, c.tile);
      let aim = c.tile, n = this.salvoSize(p, 'atombomb', aim, (deep ? max : 1) - unseen, true);
      if (n) n += unseen;
      if (n !== 1 && deep) {
        const off = this.standoff(p, target, c.tile, 'atombomb');
        if (off >= 0) { aim = off; n = 1; }
      }
      if (n && c.score / n > bestValue) { bestValue = c.score / n; best = aim; this.salvo = n; this.salvoWatch = c.tile; }
    }
    if (bestValue) return best;
    // Every structure is out of reach: open ground, for the troops on it.
    for (let i = 0; i < this.NUKE_LAND_TRIES; i++) {
      const tile = this.randomTile(target, p);
      if (tile < 0 || this.coverAt(p, tile) || this.salvoSize(p, 'atombomb', tile, 1, true) !== 1) continue;
      this.salvo = 1;
      return this.salvoWatch = tile;
    }
    return best;
  },

  // nukeTarget's pick before SAM cover is weighed. When that is a structure,
  // every structure worth a bomb is left in this._aims, best first.
  nukeTargetOpen(target, p) {
    const fog = Game.fog;
    const aims = this._aims = [];
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
      aims.push({ tile: b.tile, score });
    }
    if (best >= 0) {
      // Stable, so equal scores keep Game.buildings' own order.
      aims.sort((a, c) => c.score - a.score);
      return best;
    }
    return this.randomTile(target, p);
  },

  // A random tile of `target`'s; under fog, one p has discovered (-1 if none).
  randomTile(target, p) {
    const fog = Game.fog;
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
      if (tile < 0 || Game.structureTooClose(tile)) continue;
      if (Game.drill &&!Game.drillInside(tile, soon)) continue;
      if (fallback < 0) fallback = tile;
      if (this.isInterior(p, tile)) return tile;
    }
    return fallback;
  },

  // A Fort on the literal front line dies for free (it is destroyed when
  // its tile changes hands), so it is set back fortBorderBuffer() tiles
  // from the border or coast: still border-adjacent, to cover contested
  // ground. The bonus doesn't stack (Game.fortInRange is a boolean), so a
  // candidate already covered by a fort, built or under construction, is
  // skipped.
  //
  // The setback is a FRACTION of the protection radius, since it trades
  // forward coverage for survivability.
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
      if (tile < 0 || Game.structureTooClose(tile)) continue;
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

  // --- Trade network ----------------------------------------------------------
  // Where Cities, Factories and Ports go decides what they earn.
  //
  //   Rail (game/rail.js): only a Factory starts trains, and it links the
  //   Cities and Ports within TRAIN_STATION_MAX_RANGE that a straight or
  //   one-bend track can reach. So a Factory goes where it links the most
  //   stop value (railValue), never where it links nothing; a City goes
  //   inside a Factory's reach, or failing that beside another City.
  //
  //   Sea (game/trade.js): a trade ship pays by the length of its route and
  //   only sails to another nation's Port on the same body of water. So a
  //   Port goes on the coast whose partners are furthest off (portSite), and
  //   not at all on water with nobody to trade with.
  //
  // A ship pays both ends several times what a train stop does, so the shared
  // Factory/Port budget buys PORTS_PER_FACTORY Ports per Factory (economy).
  //
  // Fog of war: another nation's structure counts only once discovered.
  PORTS_PER_FACTORY: 2,
  RAIL_SITE_TRIES: 16,
  // Weight of "not on the border" against rail value: a structure changes
  // hands with its tile, so the border is the worst place for one.
  RAIL_SITE_INTERIOR: 5,
  PORT_SITE_SAMPLES: 24,
  // With no partner Port on it yet, a body of water is worth a Port only if
  // it is at least this share of all the map's water: the sea, not a lake.
  PORT_MIN_WATER: 0.02,
  // Hostile land this close marks a stretch of coast as contested.
  PORT_HOSTILE_RADIUS: 15,

  // What a `type` built on `tile` adds to p's rail trade. A Factory: the
  // stops it would link, each at its train-gold rate for p (own 1, another
  // nation's 2.5, an ally's 3.5, as TRAIN_GOLD_*), plus 1 for a stop no
  // network reaches yet. A City or Port: 2 inside a Factory's reach, 1 beside
  // one of p's Cities, else 0. Structures still going up count.
  railValue(p, type, tile) {
    const r2 = Game.TRAIN_STATION_MAX_RANGE * Game.TRAIN_STATION_MAX_RANGE;
    let value = 0;
    for (const b of Game.buildings.values()) {
      const hub = b.type === 'factory';
      // A Factory looks for stops; a stop looks for a Factory, or a City.
      if (type === 'factory' ? b.type !== 'city' && b.type !== 'port' : !hub && (value || b.type !== 'city')) continue;
      if (Game.tileDistSq(tile, b.tile) > r2) continue;
      const o = GameMap.owner[b.tile];
      if (o < 0 || (o !== p.id && type !== 'factory' && !hub)) continue;
      if (o !== p.id && (!Game.canTrade(p.id, o) || (Game.fog && !Game.isDiscovered(p.id, b.tile)))) continue;
      const track = Game.orthogonalPath(tile, b.tile);
      if (!track || Game.pathLength(track) > Game.RAILROAD_MAX_TILES) continue;
      if (type !== 'factory') { if (hub) return 2; value = 1; }
      else value += (o === p.id ? 1 : Game.areAllied(p.id, o) ? 3.5 : 2.5) + (b.station ? 0 : 1);
    }
    return value;
  },

  // The best of RAIL_SITE_TRIES random tiles of p's for a City or Factory, by
  // railValue and distance from the border. -1 for a Factory with nothing in
  // reach to link: it would never run a train.
  railSite(p, type) {
    const soon = Game.drill ? Game.drillRadius(Game.ticks + this.DRILL_BUILD_HORIZON * Game.TICKS_PER_SEC) : 0;
    let best = -1, bestScore = -1;
    for (const tile of this.sampleTiles(p, this.RAIL_SITE_TRIES)) {
      if (Game.structureTooClose(tile)) continue;
      if (Game.drill && !Game.drillInside(tile, soon)) continue;
      const value = this.railValue(p, type, tile);
      if (type === 'factory' && !value) continue;
      const score = value * 2 + (this.isInterior(p, tile) ? this.RAIL_SITE_INTERIOR : 0);
      if (score > bestScore) { bestScore = score; best = tile; }
    }
    return best;
  },

  citySite(p) { return this.railSite(p, 'city'); },
  factorySite(p) { return this.railSite(p, 'factory'); },

  // `count` random tiles of p's, in p.tiles' own order, off one walk of it
  // (sampleTile walks it once per tile).
  sampleTiles(p, count) {
    const size = p.tiles.size, picks = [], out = [];
    if (!size) return out;
    for (let i = 0; i < count; i++) picks.push(Math.floor(Game.rng() * size));
    picks.sort((a, b) => a - b);
    let i = 0, k = 0;
    for (const t of p.tiles) {
      while (k < count && picks[k] === i) { if (out[out.length - 1] !== t) out.push(t); k++; }
      if (k >= count) break;
      i++;
    }
    return out;
  },

  // The bodies of water `tile` touches, as GameMap.waterComponentId ids.
  seasAt(tile) {
    const wc = GameMap.waterComponentId, nb = Game.abuf, out = [];
    const n = GameMap.neighbors(tile, nb);
    for (let k = 0; k < n; k++) {
      const c = wc[nb[k]];
      if (c >= 0 && !out.includes(c)) out.push(c);
    }
    return out;
  },

  // Tile count of every body of water, and of all of them. Fixed geography,
  // worked out once a map: the same on every client, and not sim state.
  _waterSizes: null,

  waterSizes() {
    const wc = GameMap.waterComponentId;
    let ws = this._waterSizes;
    if (ws && ws.map === wc) return ws;
    ws = this._waterSizes = { map: wc, sizes: [], total: 0 };
    for (let t = 0; t < wc.length; t++) {
      const c = wc[t];
      if (c < 0) continue;
      ws.sizes[c] = (ws.sizes[c] || 0) + 1;
      ws.total++;
    }
    return ws;
  },

  // A Port must touch water (Game.buildBlockReason). Up to
  // PORT_SITE_SAMPLES of p's coastal tiles, spread evenly round its border,
  // are each scored by the gold a ship from there would average: every Port
  // p could trade with on the same body of water, weighted by level as
  // Game.tradingPorts does, at Game.tradeShipGold for the straight-line
  // distance. A Factory in reach adds a little; hostile land close by takes
  // some away. Before anyone else has a Port the biggest body of water wins.
  // -1 when no stretch of coast is worth one (see PORT_MIN_WATER).
  //
  // Draws nothing from Game.rng: p.borderTiles is walked in its insertion
  // order, which every client shares.
  portSite(p) {
    const coast = [];
    for (const t of p.borderTiles) if (GameMap.isCoastal(t)) coast.push(t);
    if (!coast.length) return -1;

    const partners = [];
    for (const b of Game.buildings.values()) {
      if (b.type !== 'port' || !b.built) continue;
      const o = GameMap.owner[b.tile];
      if (o < 0 || o === p.id || !Game.players[o].alive || !Game.canTrade(p.id, o)) continue;
      if (Game.fog && !Game.isDiscovered(p.id, b.tile)) continue;
      partners.push({ b, seas: this.seasAt(b.tile) });
    }

    const ws = this.waterSizes();
    const w = GameMap.width, h = GameMap.height, r = this.PORT_HOSTILE_RADIUS, d = Math.round(r * 0.7);
    const ring = [r, 0, d, d, 0, r, -d, d, -r, 0, -d, -d, 0, -r, d, -d];
    const soon = Game.drill ? Game.drillRadius(Game.ticks + this.DRILL_BUILD_HORIZON * Game.TICKS_PER_SEC) : 0;
    const stride = Math.max(1, Math.floor(coast.length / this.PORT_SITE_SAMPLES));
    let best = -1, bestScore = 0;
    for (let i = 0; i < coast.length; i += stride) {
      const t = coast[i];
      if (Game.structureTooClose(t)) continue;
      if (Game.drill && !Game.drillInside(t, soon)) continue;
      const seas = this.seasAt(t);
      let gold = 0, levels = 0, water = 0;
      for (const c of seas) water = Math.max(water, ws.sizes[c] / ws.total);
      for (const { b, seas: theirs } of partners) {
        if (!seas.some(c => theirs.includes(c))) continue;
        gold += b.level * Game.tradeShipGold(Game.manhattanDist(t, b.tile));
        levels += b.level;
      }
      if (!levels && water < this.PORT_MIN_WATER) continue;

      const x = t % w, y = (t / w) | 0;
      let hostile = 0;
      for (let k = 0; k < ring.length; k += 2) {
        const rx = x + ring[k], ry = y + ring[k + 1];
        if (rx < 0 || ry < 0 || rx >= w || ry >= h) continue;
        const o = GameMap.owner[ry * w + rx];
        if (o >= 0 && o !== p.id && !Game.areAllied(p.id, o)) hostile++;
      }
      // `water` (under 1) only separates sites with no partner yet.
      const score = ((levels ? gold / levels : 0) + water) *
        (this.railValue(p, 'port', t) === 2 ? 1.15 : 1) * (1 - hostile / 16);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  },

  // Picks a coastal destination to send a new Warship toward (the launch
  // Port is Game.resolveWarshipLaunch's choice). Uses the coastalTiles()
  // scan, then snaps each candidate shore tile onto open water touching it.
  warshipSite(p) {
    for (const t of this.coastalTiles(p)) {
      const water = Game.nearestOwnedWaterNear(p.id, t, Game.WARSHIP_SNAP_MAX_DIST);
      if (water >= 0) return water;
    }
    return -1;
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
  // entirely owned by `p`, capped at `cap`. fortSite needs the depth (not
  // isInterior's yes/no) so it can rank a small nation's best site.
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
  // A human can retreat a failing push and get most of the committed troops
  // home (Game.ATTACK_RETREAT_MALUS); reviewAttacks gives bots the same out.
  //
  // 'Failing' is two conditions: the front is down to RETREAT_REMAINING of
  // the most troops it ever held, AND the defender's pool exceeds what is
  // left by RETREAT_DEFENDER_EDGE. Losing most of a stack is normal in a
  // winning push, so the loss alone proves nothing. Tribes are skipped, as
  // is a defender close to handleDeadDefender's collapse threshold.
  RETREAT_REMAINING: 0.35,
  RETREAT_DEFENDER_EDGE: 1.5,
  // After retreating from someone, think()/navalScore treat them as a much
  // poorer target for a while. Without this the bot's troops get back in two
  // seconds and the very next think() relaunches at the same border at full strength,
  // paying the 25% malus over and over for the same lost fight.
  RETREAT_COOLDOWN: 60,
  RETREAT_PENALTY: 0.15,

  // --- Weighing a new enemy -------------------------------------------------
  // provocation() prices the diplomatic side of a fight: its multiplier goes
  // into the target's score, and a fresh enemy priced below RISK_FLOOR is
  // not attacked at all. It only bites on a *fresh* enemy; someone already
  // at war with us, or who hates us, costs nothing new and gets a small bonus.
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
  // An attack is aimed at a nation, not a place, so a bot heads for the
  // Drill by choosing WHO to fight: drillPull scores each neighbour by the
  // share of the shared border where their side is nearer the Drill than
  // ours. DRILL_PULL_OUT for a neighbour wholly behind us, DRILL_PULL_IN for
  // one wholly in the way, DRILL_CENTRE_BONUS on top for whoever holds the
  // Drill's tile. Null without a Drill, and for the nation holding the Drill
  // tile.
  //
  // With a pull in play, think() also drops provocation and the full-trigger
  // wait, and will open a front on an inward nation during another war.
  // allianceDecision, maybeBetray, navalThink and buildSite carry the rest.
  // Nothing here draws rng or runs without a Drill.
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

  // An ally has marked a target (Game.targetPlayer), so go hit it. Only
  // answers an ally it still feels Friendly toward, and each answer costs
  // some of that goodwill. A teammate skips the relation gate.
  //
  // Runs ahead of the scoring loop and ignores provocation() and
  // freshFrontLocked(): piling on is the point of a mark. Only answers a
  // mark on a land neighbour.
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

  // Naval counterpart to think(): the same weak-neighbour, neutral and
  // traitor scoring, with a landmass's total size standing in for border
  // contact.
  //
  // navalDistanceFactor discounts a candidate the farther its beach is from
  // the player's own coast (see navalScore). A soft bias, not a cutoff, so a
  // bot with nothing nearby can still cross open ocean.
  //
  // Only the top NAVAL_CANDIDATES beaches get the expensive sea-path search.
  NAVAL_CANDIDATES: 3,

  // Ranking-time distance is straight-line (see nearestDist), not a real sea
  // route — cheap enough to run for every candidate landmass. Cap how many of
  // the player's own coastal tiles feed that estimate so a sprawling empire's
  // navalThink stays bounded; it's only ever used to rank candidates, not to
  // pick the exact launch point (launchNavalInvasion does that separately).
  NAVAL_COAST_SAMPLE_CAP: 40,

  // A real sea route can be far longer than the straight line that ranked
  // it (around a peninsula or a continent). isRouteTooIndirect compares
  // the two.
  NAVAL_MAX_DETOUR: 2.5,

  // How long (ticks) a bot leaves a landmass alone after failing to find a
  // sea route to it. Failed searches are the expensive ones (they run the
  // whole node guard). Only real failures count; a search skipped by the
  // per-tick budget says nothing about the route.
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

    // OpenFront's maybeAttack: free land the nation touches is taken first and
    // ends the turn, so a bot with room to expand at home doesn't boat. Then a
    // 1-in-5 roll (1-in-10 with a land enemy next door) gates each launch.
    const touching = this.borderTargets(p);
    if (touching.has(NEUTRAL)) return;
    if (!this.chance(touching.size === 0 ? 5 : 10)) return;

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

    // A boat carries a flat 20% of current troops, for neutral and
    // enemy targets alike.
    //
    // At most one failed route search per think. The failure is
    // remembered (navalNoRoute), so the next think tries other candidates.
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

  // 1 at dist=0, fading to 0.25 at 'comfortable raiding range' (scaled off
  // the map's dimensions) and toward 0 beyond: a soft discount, not a range
  // cap. Squared, because a linear falloff still let a bigger landmass
  // across the map routinely outscore a decent one nearby.
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

  // True when the real crossing is a bad detour, or no route within the
  // detour limit exists. The search is capped at that limit, so it fails
  // fast. A route it finds is memoised for the tick (see
  // Game.nearestCoastPath) and reused by the launch that follows.
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
  // With fog off navalThink ranks landmasses by GameMap's coastSample (the
  // first twelve coastal tiles in scan order). Under fog a nation may only
  // weigh a beach it has discovered, so a fog match samples the coast all
  // the way round every landmass: one coastal tile for each vision cell
  // (game/vision.js) the coast runs through, thinned evenly to FOG_BEACH_CAP
  // a landmass. A beach is somewhere to land a boat once discovered, and
  // somewhere to send a Scout until then.
  //
  // Only coast on the ocean, the largest body of water, is sampled.
  //
  // The table is fixed geography, worked out from the map alone, so it is
  // the same on every client and is not sim state: it lives on AI and
  // nothing hashes it. update() builds it a slice a tick from the start of a
  // fog match; fogCoast() finishes whatever is left before it answers, so a
  // caller's result never depends on how the slices fell.
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
  // A nation with a Port on the ocean keeps Scouts (game/scouts.js) at sea.
  // Each is sent one voyage at a time to the undiscovered beach nearest the
  // nation's own coast (straight-line, as navalThink ranks beaches).
  //
  // A nation knows where the sample beaches are (fogCoast), never what is on
  // them: nothing about an undiscovered tile is read here but its position.
  // A voyage is judged by looking at the map afterwards:
  //   - the beach is discovered: good, on to the next;
  //   - the Scout has stopped and the beach is still black: it could not get
  //     there, and that beach is written off (`tried`);
  //   - the Scout is gone: every beach within SCOUT_LOSS_RADIUS of the one
  //     it was sailing for is written off.
  // A Scout that fails SCOUT_MAX_FAILS voyages running is left where it is,
  // which also bounds the route searches spent on it.
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
  // scoutThink runs on navalThink's beat and again when a voyage ends; each
  // run scans only the sample beaches, never the vision grid.
  //
  // A replacement for a lost Scout waits SCOUT_REPLACE_TICKS after the last
  // purchase.
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
  // Not held back by the savings reserve (see NAVY_EXEMPT_COUNT).
  //
  // Bought toward the water beside one of p's own Ports on the ocean (a
  // Scout launched into a lake would never leave it), and given its real
  // order straight afterwards. The order comes from scoutThink, not `want`,
  // because the launch itself reveals the sea round the Port.
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

  // Annexes every fully-enclosed pocket of targetId's land for free, the
  // bot equivalent of a human tapping a surrounded nation (see UI.onTap).
  // Game.enclosedPocketsOf scans only the contact points along p's border.
  annexIfEnclosed(p, targetId) {
    if (targetId < 0) return false; // NEUTRAL land can't be annexed
    return Game.annexEnclosedPockets(targetId, p.id) > 0;
  }
};

// Tribe behaviour. A tribe has no diplomacy(), economy() or navalThink(),
// but it is not timid per attack: on a fixed 4-8s beat it commits
// everything above a reserve, and unclaimed land only has to clear the
// small `expand` reserve. Tribes are kept weak by their small cap and slow
// growth (TRIBE_TROOP_CAP_MULT / TRIBE_GROWTH_MULT in economy.js).
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
