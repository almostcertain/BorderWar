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

  update(dt) {
    for (const p of Game.players) {
      if (!p.isBot || !p.alive) continue;

      p.nextThink -= dt;
      if (p.nextThink <= 0) {
        p.nextThink = 2 + Game.rng() * 3;
        this.diplomacy(p);
        this.economy(p);
        this.think(p);
      }

      // Separate, slower cooldown: navalThink runs a sea-path BFS rather than
      // a cheap map scan, so it doesn't get to think on land's cadence.
      p.nextNavalThink -= dt;
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

  // Only answer a renewal the ally has already asked for. A bot never opens the
  // renewal itself, exactly as OpenFront's nations behave — the human's ally
  // has to make the first move.
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
  economy(p) {
    const consideredTypes = new Set();
    for (const u of Game.UNITS) {
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

      // Forts are only worth building once there's at least one city to defend.
      if (type === 'fort' && Game.unitsOwned(p, 'city') < 1) continue;
      if (p.gold < Game.unitCost(p, type)) continue;
      const tile = type === 'fort' ? this.fortSite(p) : type === 'port' ? this.portSite(p) : this.buildSite(p);
      if (tile >= 0) Game.build(p.id, type, tile);
    }

    // Warship isn't in the UNITS cost-group loop above — it doesn't land in
    // Game.buildings at all, so it needs its own site-selection (a coastal
    // destination to send it toward, not a land tile) and its own build call
    // (buildWarship, not build). A Port is a hard requirement (per
    // Game.resolveWarshipLaunch's own comment — a deliberate user design
    // request, not an OpenFront fidelity thing), checked here too so a
    // bot without one skips straight past instead of wasting a coastalTiles
    // scan on a purchase that's going to fail anyway.
    if (Game.unitsOwned(p, 'port') >= 1 && p.gold >= Game.unitCost(p, 'warship') &&
        Game.warships.filter(w => w.owner === p.id).length < Game.MAX_WARSHIPS_PER_PLAYER) {
      const site = this.warshipSite(p);
      if (site >= 0) Game.buildWarship(p.id, site);
    }
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
  // before its FORT_RANGE bonus ever mattered (a fort is destroyed, not
  // captured, when its tile changes hands — see Game.setOwner's fort
  // branch). Set back FORT_BORDER_BUFFER tiles from
  // the border/coast instead — still border-adjacent by preference (the
  // opposite of buildSite's interior bias) so it covers contested ground
  // with its protection radius, just no longer the literal first tile lost.
  // The defense/speed bonus doesn't stack (Game.fortInRange is a boolean
  // "any fort in range", not a count), so a second fort inside an existing
  // one's FORT_RANGE buys nothing but wastes gold and a build slot — skip
  // any candidate tile already covered, built or still under construction.
  FORT_BORDER_BUFFER: 4,

  fortSite(p) {
    if (p.tiles.size === 0) return -1;
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
      const depth = this.interiorDepth(p, tile, this.FORT_BORDER_BUFFER);
      if (depth > fallbackDepth) { fallback = tile; fallbackDepth = depth; }
      if (depth >= this.FORT_BORDER_BUFFER) return tile;
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
    for (const i of p.tiles) {
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

  // Checks every point where p's border actually touches targetId's land for
  // a fully-enclosed pocket and annexes the first one found for free — the
  // bot/tribe equivalent of a human noticing a surrounded nation and tapping
  // it. Without this, only the human ever benefits from encirclement and
  // tribes only ever die to a human's click. Scans just the contact tiles
  // (not the whole border), so it doesn't add real cost to a think() cycle
  // that already walks the same border for borderTargets.
  annexIfEnclosed(p, targetId) {
    if (targetId < 0) return false; // NEUTRAL land can't be annexed
    const nb = Game.nbuf;
    const checked = this._annexChecked || (this._annexChecked = new Set());
    checked.clear();
    for (const i of p.tiles) {
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] !== targetId || checked.has(j)) continue;
        checked.add(j);
        const region = Game.enclosedRegion(j, p.id);
        if (region) { Game.annexRegion(region, p.id); return true; }
      }
    }
    return false;
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
  update(dt) {
    for (const p of Game.players) {
      if (!p.isTribe || !p.alive) continue;
      p.nextThink -= dt;
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
