// js/game/sam.js — SAM Launchers & interceptors.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- SAM Launcher & Interceptors ------------------------------------------
  // Charges: a SAM's `samQueue` holds one elapsed-time entry per charge
  // mid-reload, capped at its `level`; `queue.length === level` means no free
  // charge. A level-2 SAM therefore has two independent SAM_COOLDOWN timers.
  // A level-up's new charge starts out reloading (see updateConstruction's
  // upgrade branch).
  //
  // Range: samRange(level) is a rational curve approaching SAM_MAX_RANGE
  // (level 1 = 70, level 3 = 90, level 5 = 102 tiles). After an upgrade,
  // dynamicSamRange ramps it linearly over SAM_UPGRADE_RAMP seconds.
  //
  // Interception: there is no interceptor projectile. Any hostile nuke whose
  // current position is inside a SAM's dynamic range is destroyed the same
  // tick, if that SAM has a free charge (see stepSAMs). Allied and own
  // nukes are exempt.

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

  // While a level-up is ramping (`b.samRangeUpgrade`), the effective range
  // slides linearly from the range in effect when the upgrade landed up to
  // the new level's; otherwise it is the static value for the level. `now`
  // is passed explicitly so render.js can ask with Game.renderElapsed while
  // stepSAMs asks with the sim clock.
  //
  // Clamped on BOTH ends: renderElapsed can sit BEFORE state.startAt (a
  // burst of ticks with no frame in between), and an unclamped negative
  // `elapsed` extrapolates the ramp to a negative range, which crashes
  // ctx.arc in drawStructures.
  dynamicSamRange(b, now) {
    const state = b.samRangeUpgrade;
    if (!state) return this.samRange(b.level);
    const elapsed = now - state.startAt;
    if (elapsed <= 0) return state.startRange;
    if (elapsed >= this.SAM_UPGRADE_RAMP) return this.samRange(state.targetLevel);
    const targetRange = this.samRange(state.targetLevel);
    return state.startRange + (targetRange - state.startRange) * elapsed / this.SAM_UPGRADE_RAMP;
  },

  // Which nukes a SAM spends its charges on when more hostile nukes are in
  // range than it has free charges: Hydrogen Bombs outrank Atom Bombs,
  // impacts closer to the SAM outrank farther ones, and soon-to-land nukes
  // edge out ones with more time left.
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
  // finished range ramp, then, while a charge is free, destroy the
  // highest-scoring hostile nuke inside the SAM's dynamic range. The kill is
  // instant and spends one charge. A nuke moves only a few tiles per tick
  // against a range of 70+, so none can skip past between ticks. Must run
  // before stepNukes in Game.tick so a killed nuke never also detonates.
  // buildings (a Map) and nukes (an array) iterate in insertion order, so
  // the SAM that claims a nuke is the same on every client. samFlashes is
  // cosmetic (Game.COSMETIC_STATE).
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
        const { x, y } = this.nukeArcPos(n, u);
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
        this.noteNukeShot(c.nuke);
        this.samFlashes.push({ x: c.x, y: c.y, born: this.elapsed });
      }
    }
    for (let i = this.samFlashes.length - 1; i >= 0; i--) {
      if (this.elapsed - this.samFlashes[i].born > this.SAM_FLASH_FX_DURATION) this.samFlashes.splice(i, 1);
    }
  },

  // What a Nation knows of its own bombs lost to SAMs, kept on the player as
  // `nukeLoss`: the tile the last one was aimed at, when it was shot down,
  // and how many aimed at that tile went the same way within one
  // SAM_COOLDOWN. AI.reviewStrike reads it to tell a strike that was shot
  // down from one that landed. MIRV warheads are not strikes of their own.
  noteNukeShot(nuke) {
    const p = this.players[nuke.ownerId];
    if (!p || !p.isBot || nuke.nukeType === 'mirvwarhead') return;
    const last = p.nukeLoss;
    const again = last && last.dst === nuke.dst && this.elapsed - last.at < this.SAM_COOLDOWN;
    p.nukeLoss = { dst: nuke.dst, n: again ? last.n + 1 : 1, at: this.elapsed };
  }
});
