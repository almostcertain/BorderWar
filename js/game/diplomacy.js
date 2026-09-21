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
    // A deal signed while the armies are already in the field has to recall
    // them, or the front carries on eating your new ally's land. Boats are
    // deliberately NOT recalled here — OpenFront's own TransportShipExecution
    // doesn't cancel an in-flight invasion when peace is signed either; it
    // still takes its one landing tile for free on arrival, then just brings
    // the rest of the troops home instead of attacking further (see
    // resolveLanding's areAllied branch).
    this.cancelAttacksBetween(a.id, b.id);
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

  updateDiplomacy() {
    for (const p of this.players) if (p.alive) this.decayRelations(p);

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
