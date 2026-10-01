// js/game/diplomacy.js — Diplomacy & alliances.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Diplomacy, after OpenFront ------------------------------------------
  // OpenFront states these in ticks at 10/sec; they are seconds here because
  // that is what Game.elapsed counts. traitorDuration 30*10, allianceDuration
  // 300*10, allianceRequestDuration 20*10, allianceRequestCooldown 30*10, and
  // allianceExtensionPromptOffset 300 — a renewal window 30s before expiry.
  TRAITOR_DURATION: 30,
  ALLIANCE_DURATION: 300,
  ALLIANCE_REQUEST_DURATION: 20,
  ALLIANCE_REQUEST_COOLDOWN: 30,
  ALLIANCE_EXTEND_WINDOW: 30,

  isTraitor(p) { return !!p && this.elapsed < p.traitorUntil; },

  areAllied(a, b) {
    return a >= 0 && b >= 0 && a !== b && this.players[a].allies.has(b);
  },

  // Alliances are bounded by the nation count, so a flat scan beats any index.
  allianceBetween(a, b) {
    for (const al of this.alliances) {
      if ((al.a === a && al.b === b) || (al.a === b && al.b === a)) return al;
    }
    return null;
  },

  pendingRequest(fromId, toId) {
    return this.requests.find(r => r.from === fromId && r.to === toId) || null;
  },

  relation(p, otherId) { return p.relations.get(otherId) || 0; },

  adjustRelation(p, otherId, delta) {
    p.relations.set(otherId, Math.max(-100, Math.min(100, this.relation(p, otherId) + delta)));
  },

  // Marching on someone is not free of consequences: the victim's opinion of the
  // attacker craters, and the victim's allies — who now have a reason to fear
  // the same treatment — cool toward the attacker too. Without this an attack
  // was invisible to the relation system, so nobody ever became an enemy by
  // being attacked and the AI had no standing to weigh. Attacking a traitor is
  // exempt (everyone already wants them punished), and tribes hold no opinions.
  ATTACK_RELATION_HIT: -50,
  ATTACK_ALLY_RELATION_HIT: -20,

  provokeByAttack(attacker, target) {
    if (attacker.isTribe || target.isTribe || this.isTraitor(target)) return;
    this.adjustRelation(target, attacker.id, this.ATTACK_RELATION_HIT);
    this.provokeAllies(attacker, target);
  },

  provokeAllies(attacker, target) {
    for (const allyId of target.allies) {
      if (allyId !== attacker.id) this.adjustRelation(this.players[allyId], attacker.id, this.ATTACK_ALLY_RELATION_HIT);
    }
  },

  // OpenFront's canSendAllianceRequest. A request already coming the other way
  // is not a blocker but a shortcut — requestAlliance accepts it rather than
  // opening a mirror-image request nobody needs to answer.
  canRequestAlliance(fromId, toId) {
    if (fromId === toId || fromId < 0 || toId < 0) return false;
    const from = this.players[fromId], to = this.players[toId];
    if (!from || !to || !from.alive || !to.alive) return false;
    // Tribes never answer — they run no diplomacy() pass at all (TribeAI has
    // no equivalent), so a request against one would just sit until it times
    // out. Block it up front instead of leaving a dead offer on the table.
    if (from.isTribe || to.isTribe) return false;
    if (this.areAllied(fromId, toId)) return false;
    if (this.pendingRequest(fromId, toId)) return false;
    if (this.pendingRequest(toId, fromId)) return true;
    const last = this.lastRequestAt.get(fromId + ':' + toId);
    return last === undefined || this.elapsed - last >= this.ALLIANCE_REQUEST_COOLDOWN;
  },

  // Why a peace offer is unavailable, for the radial menu to show. null when it
  // is available.
  allianceBlockReason(fromId, toId) {
    const to = this.players[toId];
    if (to && to.isTribe) return 'Tribes do not ally';
    if (this.onSameTeam(fromId, toId)) return 'Teammate';
    if (this.areAllied(fromId, toId)) return null;
    if (this.pendingRequest(fromId, toId)) return 'Offer already pending';
    if (this.pendingRequest(toId, fromId)) return null;
    const last = this.lastRequestAt.get(fromId + ':' + toId);
    if (last !== undefined) {
      const wait = this.ALLIANCE_REQUEST_COOLDOWN - (this.elapsed - last);
      if (wait > 0) return 'Wait ' + Math.ceil(wait) + 's';
    }
    return null;
  },

  requestAlliance(fromId, toId) {
    if (!this.canRequestAlliance(fromId, toId)) return false;
    const incoming = this.pendingRequest(toId, fromId);
    if (incoming) { this.acceptAlliance(incoming); return true; }
    this.lastRequestAt.set(fromId + ':' + toId, this.elapsed);
    this.requests.push({ from: fromId, to: toId, createdAt: this.elapsed });
    return true;
  },

  dropRequest(req) {
    const i = this.requests.indexOf(req);
    if (i >= 0) this.requests.splice(i, 1);
  },

  dropRequestsBetween(x, y) {
    const a = this.pendingRequest(x, y), b = this.pendingRequest(y, x);
    if (a) this.dropRequest(a);
    if (b) this.dropRequest(b);
  },

  rejectAlliance(req) { this.dropRequest(req); },

  acceptAlliance(req) {
    this.dropRequest(req);
    if (this.areAllied(req.from, req.to)) return false;
    const a = this.players[req.from], b = this.players[req.to];
    if (!a || !b || !a.alive || !b.alive) return false;

    a.allies.add(b.id);
    b.allies.add(a.id);
    a.relations.set(b.id, 100);
    b.relations.set(a.id, 100);
    this.alliances.push({
      a: a.id, b: b.id, createdAt: this.elapsed,
      expiresAt: this.elapsed + this.ALLIANCE_DURATION,
      extendA: false, extendB: false
    });
    // Fog of war: the two have now met, and share their maps while this lasts.
    if (this.fog) this.visionAllianceFormed(a.id, b.id);
    // A deal signed while the armies are already in the field has to recall
    // them, or the front carries on eating your new ally's land. Boats are
    // deliberately NOT recalled here — OpenFront's own TransportShipExecution
    // doesn't cancel an in-flight invasion when peace is signed either; it
    // still takes its one landing tile for free on arrival, then just brings
    // the rest of the troops home instead of attacking further (see
    // resolveLanding's areAllied branch).
    this.cancelAttacksBetween(a.id, b.id);
    // AllianceRequestExecution: only the automatic (attack) embargoes lift.
    // A deliberate one survives the handshake.
    this.endTemporaryEmbargo(a.id, b.id);
    this.endTemporaryEmbargo(b.id, a.id);
    return true;
  },

  cancelAttacksBetween(x, y) {
    for (let i = this.attacks.length - 1; i >= 0; i--) {
      const at = this.attacks[i];
      if ((at.attacker === x && at.target === y) || (at.attacker === y && at.target === x)) {
        this.players[at.attacker].troops += Math.max(0, at.troops);
        this.attacks.splice(i, 1);
      }
    }
  },

  removeAlliance(al) {
    const i = this.alliances.indexOf(al);
    if (i >= 0) this.alliances.splice(i, 1);
    this.players[al.a].allies.delete(al.b);
    this.players[al.b].allies.delete(al.a);
    // Fog of war: map sharing stops; both keep what they have discovered.
    if (this.fog) this.visionRefreshShare();
  },

  // OpenFront marks the breaker a traitor unless the other side already is one,
  // so unpicking an alliance with someone who has just stabbed a third party
  // costs nothing. Letting an alliance lapse never marks anyone either — only
  // this, a deliberate break, does.
  breakAlliance(breakerId, otherId) {
    const al = this.allianceBetween(breakerId, otherId);
    if (!al) return false;
    const breaker = this.players[breakerId], other = this.players[otherId];

    this.removeAlliance(al);

    if (!this.isTraitor(other)) {
      breaker.traitorUntil = this.elapsed + this.TRAITOR_DURATION;
      breaker.betrayals++;
    }

    // The betrayed party writes you off entirely; everyone who can see the
    // border takes note. That standing cost is most of what makes betrayal a
    // decision rather than a free tempo gain.
    this.adjustRelation(other, breakerId, -100);
    for (const [neighbourId] of AI.borderTargets(breaker, true)) {
      if (neighbourId < 0 || neighbourId === otherId) continue;
      this.adjustRelation(this.players[neighbourId], breakerId, -40);
    }
    return true;
  },

  extendWindowOpen(al) {
    return al.expiresAt - this.elapsed <= this.ALLIANCE_EXTEND_WINDOW;
  },

  // Renewal takes both signatures. One side asking alone does nothing but tell
  // the other that the offer is on the table; the alliance still lapses.
  requestExtension(playerId, otherId) {
    const al = this.allianceBetween(playerId, otherId);
    if (!al || !this.extendWindowOpen(al)) return false;
    if (al.a === playerId) al.extendA = true; else al.extendB = true;
    if (al.extendA && al.extendB) {
      al.extendA = al.extendB = false;
      al.expiresAt = this.elapsed + this.ALLIANCE_DURATION;
    }
    return true;
  },

  agreedToExtend(al, playerId) {
    return al.a === playerId ? al.extendA : al.extendB;
  },

  // True when the other side has asked to renew and this player has not
  // answered — OpenFront's onlyOneAgreedToExtend, from one side's point of view.
  awaitingExtension(al, playerId) {
    if (al.extendA === al.extendB) return false;
    return !this.agreedToExtend(al, playerId);
  },

  // OpenFront's decayRelations: 0.05 a tick toward zero, every tick, for every
  // player. At 10 ticks/sec that is half a point a second, so the -40 a
  // betrayal earns you with the neighbours is forgotten in about 80 seconds and
  // the -100 with the injured party in rather longer. Grudges fade; that is
  // what stops a long match calcifying into permanent enemies.
  RELATION_DECAY_PER_SEC: 0.5,

  decayRelations(p) {
    const step = this.RELATION_DECAY_PER_SEC * this.TICK_DT;
    for (const [id, r] of p.relations) {
      if (Math.abs(r) <= step * 2) p.relations.set(id, 0);
      else p.relations.set(id, r - Math.sign(r) * step);
    }
  },

  // --- Embargoes, after OpenFront -------------------------------------------
  // Ported from PlayerImpl (addEmbargo/stopEmbargo/endTemporaryEmbargo/
  // canTrade), EmbargoExecution, EmbargoAllExecution and AttackExecution.
  // p.embargoes maps the embargoed player's id to {createdAt, temporary}.
  // Either side holding one stops ALL trade between the pair — trade ships,
  // and trains through each other's stations. Manual embargoes last until
  // lifted; the temporary one an attack triggers lapses after
  // TEMPORARY_EMBARGO_DURATION, or the moment the two sides ally.
  // OpenFront states these in ticks: temporaryEmbargoDuration 300*10 and
  // embargoAllCooldown 10*10.
  TEMPORARY_EMBARGO_DURATION: 300,
  EMBARGO_ALL_COOLDOWN: 10,

  hasEmbargoAgainst(fromId, toId) {
    const p = this.players[fromId];
    return !!p && p.embargoes.has(toId);
  },

  // PlayerImpl.canTrade. Self isn't "trade" — callers that pay out to their
  // own stations check a === b first, as TrainStation.tradeAvailable does.
  canTrade(a, b) {
    if (a < 0 || b < 0 || a === b) return false;
    return !this.hasEmbargoAgainst(a, b) && !this.hasEmbargoAgainst(b, a);
  },

  // A manual embargo is never downgraded to a temporary one; re-adding a
  // temporary one restarts its clock (OpenFront overwrites createdAt).
  addEmbargo(fromId, toId, temporary) {
    const p = this.players[fromId];
    const e = p.embargoes.get(toId);
    if (e && !e.temporary) return;
    p.embargoes.set(toId, { createdAt: this.elapsed, temporary });
  },

  stopEmbargo(fromId, toId) {
    return this.players[fromId].embargoes.delete(toId);
  },

  endTemporaryEmbargo(fromId, toId) {
    const e = this.players[fromId].embargoes.get(toId);
    if (e && e.temporary) this.stopEmbargo(fromId, toId);
  },

  // AttackExecution.init: the victim stops trading with the attacker for
  // five minutes. Tribes are skipped both ways — OpenFront's "Bot" players
  // can't trade anyway.
  embargoOnAttack(attackerId, targetId) {
    if (targetId < 0 || attackerId === targetId) return;
    if (this.players[attackerId].isTribe || this.players[targetId].isTribe) return;
    this.addEmbargo(targetId, attackerId, true);
  },

  // Why the manual toggle is unavailable, for the radial menu. null when it
  // is available. Tribes have no ports and never trade by rail, so an
  // embargo against one would be a button that does nothing.
  embargoBlockReason(fromId, toId) {
    if (fromId === toId || fromId < 0 || toId < 0) return 'Invalid';
    const from = this.players[fromId], to = this.players[toId];
    if (!from || !to || !from.alive || !to.alive) return 'Invalid';
    if (to.isTribe) return 'Tribes do not trade';
    return null;
  },

  // EmbargoExecution. 'start' adds a permanent embargo (upgrading a
  // temporary one); 'stop' lifts whatever is there, temporary included.
  setEmbargo(fromId, toId, action) {
    if (this.embargoBlockReason(fromId, toId)) return false;
    if (action === 'start') {
      const e = this.players[fromId].embargoes.get(toId);
      if (e && !e.temporary) return false;
      this.addEmbargo(fromId, toId, false);
      return true;
    }
    return this.stopEmbargo(fromId, toId);
  },

  // Players EmbargoAllExecution acts on: every living non-tribe but you and
  // your teammates (canEmbargoAll's isOnSameTeam skip).
  embargoAllTargets(fromId) {
    const out = [];
    for (const p of this.players) {
      if (p.id === fromId || !p.alive || p.isTribe || this.onSameTeam(fromId, p.id)) continue;
      out.push(p.id);
    }
    return out;
  },

  // PlayerImpl.canEmbargoAll, as a reason string. null when available.
  embargoAllBlockReason(fromId) {
    const p = this.players[fromId];
    if (!p || !p.alive) return 'Invalid';
    const wait = this.EMBARGO_ALL_COOLDOWN - (this.elapsed - p.lastEmbargoAllAt);
    if (wait > 0) return 'Wait ' + Math.ceil(wait) + 's';
    if (this.embargoAllTargets(fromId).length === 0) return 'No one to embargo';
    return null;
  },

  // EmbargoAllExecution. Starting skips anyone already embargoed (so a
  // temporary embargo stays temporary, as upstream); stopping lifts every
  // embargo this player holds against a non-tribe.
  setEmbargoAll(fromId, action) {
    if (this.embargoAllBlockReason(fromId)) return false;
    for (const id of this.embargoAllTargets(fromId)) {
      if (action === 'start') {
        if (!this.hasEmbargoAgainst(fromId, id)) this.addEmbargo(fromId, id, false);
      } else {
        this.stopEmbargo(fromId, id);
      }
    }
    this.players[fromId].lastEmbargoAllAt = this.elapsed;
    return true;
  },

  // PlayerExecution's per-tick sweep of lapsed temporary embargoes.
  expireEmbargoes(p) {
    for (const [id, e] of p.embargoes) {
      if (e.temporary && this.elapsed - e.createdAt > this.TEMPORARY_EMBARGO_DURATION) {
        p.embargoes.delete(id);
      }
    }
  },

  // --- Donations, after OpenFront -------------------------------------------
  // Ported from PlayerImpl (canDonateGold/canDonateTroops/donateGold/
  // donateTroops), DonateGoldExecution and DonateTroopExecution. OpenFront
  // gates both on isFriendly(), which is isOnSameTeam() OR isAlliedWith() —
  // areAllied() here, since game/teams.js puts teammates in each other's
  // allies. Donations are also limited to team games for now (a design call,
  // not OpenFront's rule): Game.teams only exists in a team match.
  // OpenFront also refuses a donation while the game config's donateGold()/
  // donateTroops() flag is off (a lobby-settings toggle) — this game has no
  // per-lobby toggle for it, so that check is simply absent rather than
  // hardcoded true.
  //
  // OpenFront's cooldown (donateCooldown(): 10*10 ticks at 10 ticks/sec) is
  // 10 seconds; Game.elapsed is already in seconds, so it ports as a flat 10.
  // One shared table (Player.lastDonationAt) covers both gold and troops, per
  // recipient — exactly PlayerImpl.sentDonations, which canDonateGold and
  // canDonateTroops both walk.
  DONATE_COOLDOWN: 10,

  canDonate(fromId, toId) {
    if (fromId === toId || fromId < 0 || toId < 0) return false;
    const from = this.players[fromId], to = this.players[toId];
    if (!from || !to || !from.alive || !to.alive) return false;
    if (!this.teams || !this.areAllied(fromId, toId)) return false;
    const last = from.lastDonationAt.get(toId);
    return last === undefined || this.elapsed - last >= this.DONATE_COOLDOWN;
  },

  // Why a donation is unavailable, for the radial menu. null when available.
  donateBlockReason(fromId, toId) {
    if (fromId === toId || fromId < 0 || toId < 0) return 'Invalid';
    const from = this.players[fromId], to = this.players[toId];
    if (!from || !to || !from.alive || !to.alive) return 'Invalid';
    if (!this.teams) return 'Team games only';
    if (!this.areAllied(fromId, toId)) return 'Not allied';
    const last = from.lastDonationAt.get(toId);
    if (last !== undefined) {
      const wait = this.DONATE_COOLDOWN - (this.elapsed - last);
      if (wait > 0) return 'Wait ' + Math.ceil(wait) + 's';
    }
    return null;
  },

  // DonateTroopExecution's getMinTroopsForRelationUpdate, Medium column
  // (the only tier this game's AI.PROFILES borrows verbatim rather than
  // re-tuning — see AI.PROFILES' own header): a random 1/11..1/9 slice of the
  // recipient's cap. Sending less than this still moves the troops but buys
  // no goodwill — DonateTroopExecution's own anti-cheese rule ("Prevent
  // players from just buying a good relation by sending 1% troops").
  // Expressed as a fraction of Game.maxTroops(recipient), which is already in
  // this game's own troop units, so the OpenFront ratio ports without any
  // rescaling.
  minDonationForRelation(toId) {
    const cap = this.maxTroops(this.players[toId]);
    const lo = cap / 11, hi = cap / 9;
    return lo + this.rng() * (hi - lo);
  },

  // DonateTroopExecution.tick: move troops, capped to what the sender
  // actually has and to the recipient's free headroom under their own cap
  // (mg.config().maxTroops(recipient) - recipient.troops(), computed in
  // upstream's init() before the transfer). A donation crossing the minimum
  // above earns the recipient's goodwill; PlayerType.Nation-only auto-emoji
  // reply is skipped — this game's Fx/emoji layer has no such reaction yet.
  donateTroops(fromId, toId, troops) {
    if (!this.canDonate(fromId, toId)) return false;
    const from = this.players[fromId], to = this.players[toId];
    const headroom = Math.max(0, this.maxTroops(to) - to.troops);
    const amount = Math.min(Math.max(0, troops), from.troops, headroom);
    if (amount <= 0) return false;
    from.troops -= amount;
    to.troops += amount;
    from.lastDonationAt.set(toId, this.elapsed);
    Fx.donationToast(toId, fromId, 'troops', amount);
    if (amount >= this.minDonationForRelation(toId)) {
      this.adjustRelation(to, fromId, 50);
    }
    return true;
  },

  // DonateGoldExecution's getGoldChunkSize()/calculateRelationUpdate, rescaled:
  // upstream's chunk sizes (2,500 Easy .. 25,000 Impossible) are tuned for
  // OpenFront's own gold economy and don't transfer to this game's
  // independently-dialed one (see economy.js's GOLD_PER_SEC comment — gold
  // here is "a dial, not a ported constant"). Same shape ported instead: a
  // difficulty-scaled chunk, growing with match progress, worth 5 relation per
  // complete chunk donated, capped at 100. The chunk is sized off this game's
  // own GOLD_PER_SEC so it stays meaningful across the tuned economy: 30
  // seconds of baseline income for Medium, scaled the same 0.5/1/1.5x the
  // Nation difficulty tiers already use for growth (NATION_DIFFICULTY).
  GOLD_CHUNK_SECONDS: 30,
  GOLD_CHUNK_DIFFICULTY_MULT: { easy: 0.5, medium: 1, hard: 1.5 },

  goldChunkSize() {
    const mult = this.GOLD_CHUNK_DIFFICULTY_MULT[this.difficulty]
      || this.GOLD_CHUNK_DIFFICULTY_MULT[this.DEFAULT_DIFFICULTY];
    return this.GOLD_PER_SEC * this.GOLD_CHUNK_SECONDS * mult;
  },

  // ticks / (3000 + numSpawnPhaseTurns), OpenFront's own scale-free growth
  // multiplier — 5 real-time minutes at their 10 ticks/sec, expressed here in
  // Game.elapsed seconds against SPAWN_PHASE_TURNS converted the same way.
  goldRelationUpdate(gold) {
    const chunk = this.goldChunkSize();
    const growthWindow = 300 + this.SPAWN_PHASE_TURNS * this.TICK_DT;
    const adjustedChunk = chunk + chunk * (this.elapsed / growthWindow);
    const chunks = Math.floor(gold / adjustedChunk);
    return Math.min(100, chunks * 5);
  },

  donateGold(fromId, toId, gold) {
    if (!this.canDonate(fromId, toId)) return false;
    const from = this.players[fromId], to = this.players[toId];
    const amount = Math.min(Math.max(0, gold), from.gold);
    if (amount <= 0) return false;
    from.gold -= amount;
    to.gold += amount;
    from.lastDonationAt.set(toId, this.elapsed);
    Fx.donationToast(toId, fromId, 'gold', amount);
    const bump = this.goldRelationUpdate(amount);
    if (bump > 0) this.adjustRelation(to, fromId, bump);
    return true;
  },

  // --- Target marking, after OpenFront (ticket #30) --------------------------
  // Ported from TargetPlayerExecution and PlayerImpl's canTarget/target/
  // targets/transitiveTargets. Marking an enemy tells your allies who to
  // focus: allied nations pile onto it (AI.assistAllies), and you and your
  // allies see 🎯 on its name. The target learns of it the hard way — its
  // relation toward you drops by 40.
  //
  // OpenFront's targetDuration() is 10*10 ticks and targetCooldown() 15*10,
  // at 10 ticks/sec; Game.elapsed is in seconds, so they port as 10 and 15.
  // The cooldown is on marking anyone at all, not per target — canTarget
  // walks every entry. TargetPlayerExecution is inactive during the spawn
  // phase, so marking is refused until the match starts.
  TARGET_DURATION: 10,
  TARGET_COOLDOWN: 15,
  TARGET_RELATION_HIT: -40,

  targetBlockReason(fromId, toId) {
    if (fromId === toId || fromId < 0 || toId < 0) return 'Invalid';
    const from = this.players[fromId], to = this.players[toId];
    if (!from || !to || !from.alive || !to.alive) return 'Invalid';
    if (this.spawning) return 'Not started';
    if (this.areAllied(fromId, toId)) return 'Allied';
    for (const t of from.targets) {
      const wait = this.TARGET_COOLDOWN - (this.elapsed - t.at);
      if (wait > 0) return 'Wait ' + Math.ceil(wait) + 's';
    }
    return null;
  },

  canTarget(fromId, toId) { return this.targetBlockReason(fromId, toId) === null; },

  targetPlayer(fromId, toId) {
    if (!this.canTarget(fromId, toId)) return false;
    const from = this.players[fromId];
    // OpenFront keeps every mark forever and filters on read; entries past
    // the cooldown can never matter again (it outlasts the duration), so
    // drop them here to keep the list at one entry.
    from.targets = from.targets.filter(t => this.elapsed - t.at < this.TARGET_COOLDOWN);
    from.targets.push({ at: this.elapsed, id: toId });
    this.adjustRelation(this.players[toId], fromId, this.TARGET_RELATION_HIT);
    return true;
  },

  // Live marks: player ids p marked within TARGET_DURATION, still alive.
  activeTargets(p) {
    const out = [];
    for (const t of p.targets) {
      if (this.elapsed - t.at < this.TARGET_DURATION && this.players[t.id].alive) out.push(t.id);
    }
    return out;
  },

  // Everything p or any of p's allies has marked — what p sees as 🎯.
  transitiveTargets(p) {
    const out = new Set(this.activeTargets(p));
    for (const allyId of p.allies) {
      for (const id of this.activeTargets(this.players[allyId])) out.add(id);
    }
    return out;
  },

  updateDiplomacy() {
    for (const p of this.players) {
      if (!p.alive) continue;
      this.decayRelations(p);
      this.expireEmbargoes(p);
    }

    for (let i = this.requests.length - 1; i >= 0; i--) {
      const r = this.requests[i];
      if (!this.players[r.from].alive || !this.players[r.to].alive ||
          this.elapsed - r.createdAt > this.ALLIANCE_REQUEST_DURATION) {
        this.requests.splice(i, 1);
      }
    }
    for (let i = this.alliances.length - 1; i >= 0; i--) {
      const al = this.alliances[i];
      // Expiry is silent: no traitor mark, no relation hit.
      if (!this.players[al.a].alive || !this.players[al.b].alive ||
          this.elapsed >= al.expiresAt) {
        this.removeAlliance(al);
      }
    }
  },

});
