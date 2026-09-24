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
  // Interception deliberately departs from OpenFront (ticket #21): there is
  // no interceptor projectile. Any hostile nuke whose current position is
  // inside a SAM's dynamic range is destroyed the same tick, as long as that
  // SAM has a free charge — see stepSAMs. Charges, cooldown, level-scaled
  // range and the ally/own-nuke exemption all still apply; only the missile
  // flight (and its lead-the-target intercept solve) is gone.

  SAM_MAX_RANGE: 150,
  // Config.ts's SAMCooldown(): 90 ticks, same conversion SILO_COOLDOWN's own
  // comment already explains (TICKS_PER_SEC=10) — and, tellingly, the exact
  // same raw value as SiloCooldown, so the two structures share a cooldown
  // pace even though nothing in the real source ties them together.
  SAM_COOLDOWN: 9,
  // Config.ts's samUpgradeDuration(): floor(SAMCooldown()/2) ticks, in this
  // file's own seconds scale rather than raw ticks.
  SAM_UPGRADE_RAMP: 4.5,
  // No OpenFront equivalent, same as NUKE_BLAST_FX_DURATION just above it —
  // purely how long the intercept-confirmation ring (see stepSAMs)
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
  // than always reading this.elapsed) so render.js can ask with its own
  // Game.renderElapsed clock while stepSAMs asks with the sim's.
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

  // Config.ts's SAMTargetingSystem.computeTargetScore, translated off this
  // game's own nuke shape (dst/nukeType/born/duration rather than a
  // trajectory array) — decides which nukes a SAM spends its limited charges
  // on when more hostile nukes are inside its range the same tick than it
  // has free charges: Hydrogen Bombs outrank Atom Bombs, impacts closer to
  // the SAM outrank farther ones, and soon-to-land nukes edge out ones with
  // more time left.
  samTargetScore(b, nuke) {
    const w = GameMap.width;
    const dstX = nuke.dst % w, dstY = (nuke.dst / w) | 0;
    const samX = b.tile % w, samY = (b.tile / w) | 0;
    const distToSam = Math.abs(dstX - samX) + Math.abs(dstY - samY);
    const typeBonus = nuke.nukeType === 'hydrogenbomb' ? 70001 : 0;
    const distanceBonus = Math.max(0, 200000 - distToSam * 1000);
    const remaining = (nuke.born + nuke.duration) - this.elapsed;
    const urgencyBonus = Math.max(0, 10000 - remaining * this.TICKS_PER_SEC * 100);
    return typeBonus + distanceBonus + urgencyBonus;
  },

  // Each tick: reload any charges whose SAM_COOLDOWN has elapsed, settle a
  // finished range ramp, then — while a charge remains free — destroy the
  // highest-scoring hostile nuke whose current position lies inside the
  // SAM's dynamic range. No projectile: the kill is instant and spends one
  // charge. Nukes fly at most NUKE_SPEED/TICKS_PER_SEC (~4.5) tiles per
  // tick against a range of 70+, so none can skip past a radius between
  // ticks. Allied and own nukes are skipped, as before. Must run before
  // stepNukes in Game.tick so a killed nuke never also detonates the same
  // tick. buildings (a Map) and nukes (an array) both iterate in insertion
  // order, so the SAM that claims a nuke two SAMs cover is the same on
  // every client. samFlashes is cosmetic (Game.COSMETIC_STATE) — nothing
  // reads it back.
  stepSAMs() {
    const w = GameMap.width;
    for (const b of this.buildings.values()) {
      if (b.type !== 'sam' || !b.built) continue;

      while (b.samQueue.length && this.elapsed - b.samQueue[0] >= this.SAM_COOLDOWN) b.samQueue.shift();
      if (b.samRangeUpgrade && this.elapsed - b.samRangeUpgrade.startAt >= this.SAM_UPGRADE_RAMP) {
        b.samRangeUpgrade = null;
      }
      if (b.samQueue.length >= b.level || !this.nukes.length) continue;

      const ownerId = GameMap.owner[b.tile];
      if (ownerId < 0) continue;
      const samX = b.tile % w, samY = (b.tile / w) | 0;
      const range = this.dynamicSamRange(b, this.elapsed);
      const rangeSq = range * range;

      const candidates = [];
      for (const n of this.nukes) {
        if (n.ownerId === ownerId || this.areAllied(ownerId, n.ownerId)) continue;
        const u = Math.max(0, Math.min(1, (this.elapsed - n.born) / n.duration));
        const x = n.from.x + (n.to.x - n.from.x) * u;
        const y = n.from.y + (n.to.y - n.from.y) * u;
        const dx = x - samX, dy = y - samY;
        if (dx * dx + dy * dy > rangeSq) continue;
        candidates.push({ nuke: n, x, y, score: this.samTargetScore(b, n) });
      }
      if (!candidates.length) continue;
      // Stable sort, so equal scores keep this.nukes' own order.
      candidates.sort((p, q) => q.score - p.score);

      for (const c of candidates) {
        if (b.samQueue.length >= b.level) break;
        b.samQueue.push(this.elapsed);
        this.nukes.splice(this.nukes.indexOf(c.nuke), 1);
        this.samFlashes.push({ x: c.x, y: c.y, born: this.elapsed });
      }
    }
    for (let i = this.samFlashes.length - 1; i >= 0; i--) {
      if (this.elapsed - this.samFlashes[i].born > this.SAM_FLASH_FX_DURATION) this.samFlashes.splice(i, 1);
    }
  }
});
