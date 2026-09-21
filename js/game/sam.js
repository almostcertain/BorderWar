// js/game/sam.js — SAM Launchers & interceptors.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- SAM Launcher & Interceptors ------------------------------------------
  // Ported against OpenFront's real SAMLauncherExecution.ts/
  // SAMMissileExecution.ts/Config.ts source (github.com/openfrontio/
  // OpenFrontIO), not guessed — see feedback-openfront-source-porting memory.
  //
  // Charges: verbatim UnitImpl's own model. A SAM's `samQueue` holds one
  // elapsed-time entry per charge currently mid-reload, capacity-capped at
  // its `level` — `queue.length === level` means fully saturated (no free
  // charge), exactly matching real UnitImpl.isInCooldown(). A level-2 SAM
  // therefore has two independent SAM_COOLDOWN timers, not one shared one:
  // firing both at once (two nukes converging in the same tick) reloads them
  // back-to-back rather than serially, and firing just one leaves the other
  // charge free to answer a second launch immediately. Leveling up doesn't
  // hand over its new charge for free either — increaseLevel pushes a fresh
  // queue entry the same way a real launch does, so the extra capacity has
  // to reload once before it's usable (see updateConstruction's upgrade
  // branch, which does the equivalent push).
  //
  // Range: samRange(level) is their exact rational curve, asymptotically
  // approaching SAM_MAX_RANGE (150 tiles, unscaled — see NUKE_MAGNITUDES'
  // own comment on why OpenFront's map dimensions need no rescaling here):
  // level 1 = 70, level 3 = 90, level 5 = 102. It also doesn't jump the
  // instant an upgrade completes — dynamicSamRange ramps it linearly over
  // SAM_UPGRADE_RAMP seconds, matching their own samLauncherState/
  // dynamicSamRange pair.
  //
  // Targeting/interception is the one piece that couldn't be a literal
  // port: the real SAMTargetingSystem walks a nuke's discretized per-tile
  // trajectory (from its own ParabolaUniversalPathFinder) looking for a tile
  // both in range and reachable in time. This game's nukes don't have that
  // — Game.launchNuke gives a nuke only fixed from/to endpoints and a
  // born/duration pair, a continuous straight-line flight (see that
  // section's own comment on why). samSolveIntercept below is the
  // continuous-time equivalent of the same question — algebraically solving
  // "where do these two constant-velocity paths meet" instead of stepping
  // tile by tile — which is exactly as precise while fitting this game's own
  // data shape.

  SAM_MAX_RANGE: 150,
  // Config.ts's SAMCooldown(): 90 ticks, same conversion SILO_COOLDOWN's own
  // comment already explains (TICKS_PER_SEC=10) — and, tellingly, the exact
  // same raw value as SiloCooldown, so the two structures share a cooldown
  // pace even though nothing in the real source ties them together.
  SAM_COOLDOWN: 9,
  // Config.ts's samUpgradeDuration(): floor(SAMCooldown()/2) ticks, in this
  // file's own seconds scale rather than raw ticks.
  SAM_UPGRADE_RAMP: 4.5,
  // Config.ts's defaultSamMissileSpeed(): 12 tiles/tick raw = 120 tiles/sec,
  // a 1.2x ratio over their own raw nukeSpeed (100 tiles/sec — see
  // NUKE_SPEED's comment). Applied to THIS game's own slowed-down NUKE_SPEED
  // (45, not the raw 100) to preserve that same 1.2x ratio rather than the
  // real absolute number, same reasoning NUKE_SPEED's own comment gives for
  // why it was slowed in the first place.
  SAM_MISSILE_SPEED: 54,
  // No OpenFront equivalent, same as NUKE_BLAST_FX_DURATION just above it —
  // purely how long the intercept-confirmation ring (see stepSamMissiles)
  // stays on screen.
  SAM_FLASH_FX_DURATION: 0.5,

  samRange(level) {
    return this.SAM_MAX_RANGE - 480 / (level + 5);
  },

  // Config.ts's dynamicSamRange: while a level-up is still ramping (see
  // updateConstruction's `b.samRangeUpgrade` hook), the effective range
  // slides linearly from whatever range was actually in effect the instant
  // the upgrade landed, up to the new level's — otherwise it's just the
  // static value for the current level. `now` is passed explicitly (rather
  // than always reading this.elapsed) so stepSAMs' intercept solve can ask
  // "what will the range be at the tick the interceptor actually arrives",
  // matching the real source's own ticks+expTicks lookahead — the ramp
  // formula is a pure function of elapsed-since-upgrade, so it extrapolates
  // correctly into the future with no special-casing needed.
  //
  // Clamped on BOTH ends, not just the upper one: render.js reads this with
  // Game.renderElapsed, which only tracks Game.elapsed frame-by-frame inside
  // main.js's normal animation loop (see renderElapsed's own comment) — but
  // Game.fastForward() drives many ticks through Game.tick() directly,
  // without ever touching renderElapsed. An upgrade whose `startAt` lands
  // mid-burst leaves renderElapsed sitting BEFORE state.startAt until the
  // next real animation frame catches up, which un-clamped produced a large
  // negative `elapsed` here — extrapolating the ramp backwards into a
  // negative range and crashing ctx.arc's radius in drawStructures (caught
  // live via a fastForward-shaped repro while verifying this feature).
  // Clamping elapsed<=0 to the pre-upgrade startRange is the correct
  // behavior anyway, not just a crash guard: from that reader's-clock
  // perspective the ramp hasn't started yet.
  dynamicSamRange(b, now) {
    const state = b.samRangeUpgrade;
    if (!state) return this.samRange(b.level);
    const elapsed = now - state.startAt;
    if (elapsed <= 0) return state.startRange;
    if (elapsed >= this.SAM_UPGRADE_RAMP) return this.samRange(state.targetLevel);
    const targetRange = this.samRange(state.targetLevel);
    return state.startRange + (targetRange - state.startRange) * elapsed / this.SAM_UPGRADE_RAMP;
  },

  // Solves "where do these two constant-velocity paths meet" — the
  // continuous-time equivalent of SAMTargetingSystem's per-tile trajectory
  // walk (see the section comment above). `samPos` is fixed; the nuke moves
  // along its own fixed from/to line. An interceptor launched THIS INSTANT
  // at SAM_MISSILE_SPEED needs travel time t solving
  // |nukePos(now+t) - samPos| = SAM_MISSILE_SPEED * t — a standard
  // turret-lead-the-target quadratic in t. Returns the smallest positive
  // root and the meeting point, or null if the nuke's already gone, the
  // quadratic has no positive real root (SAM_MISSILE_SPEED can't catch it in
  // time), or the meeting point would land at-or-after the nuke's own
  // detonation.
  samSolveIntercept(samPos, nuke, now) {
    const remaining = nuke.born + nuke.duration - now;
    if (remaining <= 0) return null;
    const dx = nuke.to.x - nuke.from.x, dy = nuke.to.y - nuke.from.y;
    const vx = dx / nuke.duration, vy = dy / nuke.duration;
    const u = (now - nuke.born) / nuke.duration;
    const px = nuke.from.x + dx * u, py = nuke.from.y + dy * u;
    const rx = px - samPos.x, ry = py - samPos.y;
    const speed2 = this.SAM_MISSILE_SPEED * this.SAM_MISSILE_SPEED;
    const a = (vx * vx + vy * vy) - speed2;
    const bq = 2 * (rx * vx + ry * vy);
    const cq = rx * rx + ry * ry;
    let t;
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(bq) < 1e-9) return null;
      t = -cq / bq;
    } else {
      const disc = bq * bq - 4 * a * cq;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      const t1 = (-bq + sq) / (2 * a), t2 = (-bq - sq) / (2 * a);
      t = Infinity;
      if (t1 > 1e-6) t = Math.min(t, t1);
      if (t2 > 1e-6) t = Math.min(t, t2);
      if (!isFinite(t)) return null;
    }
    // A hair of margin before the nuke's own detonation, not exactly on it —
    // avoids a same-tick float-coincidence race between stepSamMissiles'
    // resolution and stepNukes' own duration check.
    if (t <= 0 || t >= remaining - 0.01) return null;
    return { t, x: px + vx * t, y: py + vy * t };
  },

  // Config.ts's SAMTargetingSystem.computeTargetScore, translated off this
  // game's own nuke shape (dst/nukeType/born/duration rather than a
  // trajectory array) — a tiebreaker for which nuke a multi-charge SAM fires
  // at first when several are interceptable the same tick: Hydrogen Bombs
  // outrank Atom Bombs, impacts closer to the SAM outrank farther ones, and
  // soon-to-land nukes edge out ones with more time left. The real source
  // calls this "only a very minor tiebreaker" since every candidate here is
  // already guaranteed interceptable — it just orders which charge answers
  // which nuke first, not whether an interception happens at all.
  samTargetScore(b, cand) {
    const w = GameMap.width;
    const dstX = cand.nuke.dst % w, dstY = (cand.nuke.dst / w) | 0;
    const samX = b.tile % w, samY = (b.tile / w) | 0;
    const distToSam = Math.abs(dstX - samX) + Math.abs(dstY - samY);
    const typeBonus = cand.nuke.nukeType === 'hydrogenbomb' ? 70001 : 0;
    const distanceBonus = Math.max(0, 200000 - distToSam * 1000);
    const remaining = (cand.nuke.born + cand.nuke.duration) - this.elapsed;
    const urgencyBonus = Math.max(0, 10000 - remaining * this.TICKS_PER_SEC * 100);
    return typeBonus + distanceBonus + urgencyBonus;
  },

  // Config.ts's SAMLauncherExecution.tick, adapted to this game's continuous
  // clock: reload any charges whose SAM_COOLDOWN has elapsed, settle a
  // finished range ramp, then — while a charge remains free — fire at
  // whichever interceptable, not-already-targeted enemy nuke scores highest.
  // "Interceptable" means samSolveIntercept finds a real future meeting
  // point AND that point sits inside the SAM's dynamic range at the tick the
  // interceptor would actually arrive (dynamicSamRange called with a future
  // `now`, matching the real source's own lookahead — see its own comment).
  // Allied nukes are skipped outright rather than porting the real source's
  // narrow endgame exception (only intercept an ally's nuke once a winner
  // already exists and they're on the same team) — this game has no
  // team/winner system for that exception to hook into. A SAM can fire more
  // than one charge in the same tick, exactly like the real source's own
  // `for (target of targets) { if (cooldown) break; launch }` loop — a
  // level-2+ SAM with several nukes converging on it isn't limited to one
  // shot per tick.
  stepSAMs() {
    const w = GameMap.width;
    for (const b of this.buildings.values()) {
      if (b.type !== 'sam' || !b.built) continue;

      while (b.samQueue.length && this.elapsed - b.samQueue[0] >= this.SAM_COOLDOWN) b.samQueue.shift();
      if (b.samRangeUpgrade && this.elapsed - b.samRangeUpgrade.startAt >= this.SAM_UPGRADE_RAMP) {
        b.samRangeUpgrade = null;
      }
      if (b.samQueue.length >= b.level) continue;

      const ownerId = GameMap.owner[b.tile];
      if (ownerId < 0) continue;
      const samPos = { x: b.tile % w + 0.5, y: ((b.tile / w) | 0) + 0.5 };

      const candidates = [];
      for (const n of this.nukes) {
        if (n.targetedBySAM || n.ownerId === ownerId || this.areAllied(ownerId, n.ownerId)) continue;
        const solved = this.samSolveIntercept(samPos, n, this.elapsed);
        if (!solved) continue;
        const distSq = (solved.x - samPos.x) ** 2 + (solved.y - samPos.y) ** 2;
        const range = this.dynamicSamRange(b, this.elapsed + solved.t);
        if (distSq > range * range) continue;
        candidates.push({ nuke: n, solved, score: 0 });
      }
      if (!candidates.length) continue;
      for (const c of candidates) c.score = this.samTargetScore(b, c);
      candidates.sort((x, y) => y.score - x.score);

      for (const c of candidates) {
        if (b.samQueue.length >= b.level) break;
        b.samQueue.push(this.elapsed);
        c.nuke.targetedBySAM = true;
        this.samMissiles.push({
          ownerId,
          from: samPos, to: { x: c.solved.x, y: c.solved.y },
          born: this.elapsed, duration: Math.max(0.05, c.solved.t),
          target: c.nuke
        });
      }
    }
  },

  // Advances every in-flight SAM interceptor (see stepSAMs) and resolves the
  // kill once its precomputed intercept time elapses. Unlike stepShells'
  // guarded fizzle, the target is always still in this.nukes at that point —
  // samSolveIntercept only ever commits to an intercept that lands strictly
  // before the nuke's own detonation (with a small safety margin — see its
  // own comment), and targetedBySAM prevents any other SAM from
  // double-claiming the same nuke — so there's nothing to validate here.
  // Must run before stepNukes in Game.tick so a killed nuke never also
  // detonates the same frame. render.js's drawSamMissiles reads
  // from/to/born/duration directly, same as drawShells.
  stepSamMissiles() {
    for (let i = this.samMissiles.length - 1; i >= 0; i--) {
      const m = this.samMissiles[i];
      if (this.elapsed - m.born < m.duration) continue;
      this.samMissiles.splice(i, 1);
      const ni = this.nukes.indexOf(m.target);
      if (ni >= 0) {
        this.nukes.splice(ni, 1);
        this.samFlashes.push({ x: m.to.x, y: m.to.y, born: this.elapsed });
      }
    }
    for (let i = this.samFlashes.length - 1; i >= 0; i--) {
      if (this.elapsed - this.samFlashes[i].born > this.SAM_FLASH_FX_DURATION) this.samFlashes.splice(i, 1);
    }
  }
});
