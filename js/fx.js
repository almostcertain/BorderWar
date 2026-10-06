// Client-local presentation effects. Nothing in here is simulation state.
//
// Why this file exists at all: under deterministic lockstep every client runs
// the identical simulation and a state hash (MP-0.5) compares them turn by
// turn. Anything living on `Game` is therefore a candidate for that hash, and
// anything on `Game` that legitimately *differs* per client — because it is
// filtered by who happens to be watching — is either a permanent exception to
// remember or a source of false desync alarms. `Fx` sidesteps both: it is not
// part of `Game`, so the hash cannot see it, and it can hold per-viewer detail
// freely.
//
// The contract with the simulation is one-directional and deliberately thin:
//   - the sim CALLS INTO Fx, unconditionally, for every player alike, passing
//     along whose event it was;
//   - the sim NEVER READS anything back out of Fx;
//   - the renderer decides what the local viewer (`Game.me`) actually sees.
// Keep it that way. The moment a sim branch reads Fx, Fx becomes sim state.
const Fx = {
  // Seconds a "+gold" label drifts upward and fades before it disappears.
  // Lives here rather than on Game because nothing but the renderer has any
  // use for it — the sim no longer ages these at all.
  GOLD_POPUP_LIFETIME: 1.2,

  // Hard ceiling on live popups, oldest dropped first.
  //
  // This matters more than it looks. Popups used to be pushed only for the
  // local player, so a big map produced a trickle; now every owner's payouts
  // are recorded (the filtering having moved to draw time), which is ~30x the
  // volume on a crowded map. Normally that is still self-limiting because
  // expiry prunes them continuously — but `Game.fastForward` runs thousands of
  // ticks synchronously with no frame in between, so nothing would be pruned
  // for the whole burst. prune() below handles that case on its own (it ages
  // against the sim clock, which does advance during a burst), and this cap is
  // the belt-and-braces guarantee that the array can never grow without bound
  // no matter how the caller drives the sim.
  MAX_GOLD_POPUPS: 512,

  // { tile, amount, ownerId, born } — `born` in Game.elapsed seconds, matching
  // the `born` idiom nukeBlasts/samFlashes already use. Appended in order, so
  // `born` is non-decreasing and prune() can trim from the front.
  goldPopups: [],

  // Seconds a conquest-spoils label stays up. Longer and bigger than a trade
  // payout's — a kill is a moment worth reading, not a background trickle.
  KILL_POPUP_LIFETIME: 1.5,

  // { tile, amount, ownerId, born } — same shape and ordering guarantee as
  // goldPopups, kept in its own list because prune() relies on one uniform
  // lifetime per list. Kills are rare, so it needs no cap.
  killPopups: [],

  // Seconds a donation-received toast stays on screen before it's gone,
  // fading out over the same span (ticket #36). Not tile-anchored like the
  // popups above — a donation has no map location the recipient is
  // necessarily looking at, so this is a HUD toast instead (see
  // UI.updateDonationAlert), and just needs a lifetime to age against.
  DONATION_TOAST_LIFETIME: 3,

  // { toId, fromId, kind ('gold'|'troops'), amount, born } — same
  // append-in-order/prune-from-front contract as the popup lists.
  donationToasts: [],
  // Plane outcomes (game/paratroopers.js): { kind, ownerId, otherId, tile,
  // troops, born }. kind is 'shotdown' (otherId fired the gun), 'landed',
  // 'allied' (turned away over a still-allied nation) or 'nodrop'. Recorded
  // for every plane; UI.updatePlaneAlert decides who is told what, and never
  // tells anyone but the owner what a plane carried.
  PLANE_TOAST_LIFETIME: 3,
  planeToasts: [],

  // Called from Game.init. Effects are per-match, same as everything they
  // decorate; carrying a previous match's popups into a new map would draw
  // them over unrelated tiles.
  reset() {
    this.goldPopups.length = 0;
    this.killPopups.length = 0;
    this.donationToasts.length = 0;
    this.planeToasts.length = 0;
  },

  // Record the spoils of eliminating a nation/tribe/player over `tile`. Called
  // unconditionally by the sim; the renderer shows it only to `ownerId`.
  killPopup(tile, amount, ownerId) {
    const born = Game.elapsed;
    const list = this.killPopups, life = this.KILL_POPUP_LIFETIME;
    let i = 0;
    while (i < list.length && born - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
    list.push({ tile, amount, ownerId, born });
  },

  pruneKills(now) {
    const list = this.killPopups, life = this.KILL_POPUP_LIFETIME;
    let i = 0;
    while (i < list.length && now - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
  },

  // Record a donation landing on `toId` from `fromId` (ticket #36). Called
  // unconditionally by Game.donateGold/donateTroops for every recipient;
  // UI.updateDonationAlert filters to Game.me the same way drawGoldPopups
  // filters goldPopups.
  donationToast(toId, fromId, kind, amount) {
    const born = Game.elapsed;
    const list = this.donationToasts, life = this.DONATION_TOAST_LIFETIME;
    let i = 0;
    while (i < list.length && born - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
    list.push({ toId, fromId, kind, amount, born });
  },

  planeEvent(kind, ownerId, otherId, tile, troops) {
    const born = Game.elapsed;
    const list = this.planeToasts, life = this.PLANE_TOAST_LIFETIME;
    let i = 0;
    while (i < list.length && born - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
    list.push({ kind, ownerId, otherId, tile, troops, born });
  },
  pruneDonations(now) {
    const list = this.donationToasts, life = this.DONATION_TOAST_LIFETIME;
    let i = 0;
    while (i < list.length && now - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
  },

  // Record a payout label over `tile`. Called unconditionally by the sim for
  // every owner — `ownerId` is carried along so drawGoldPopups can show the
  // viewer only their own money. No Game.me test may ever appear here.
  goldPopup(tile, amount, ownerId) {
    const born = Game.elapsed;
    this.prune(born);
    const list = this.goldPopups;
    if (list.length >= this.MAX_GOLD_POPUPS) list.splice(0, list.length - this.MAX_GOLD_POPUPS + 1);
    list.push({ tile, amount, ownerId, born });
  },

  // Drop everything that has finished fading as of `now`. Called on push (with
  // the sim clock) and before drawing (with the render clock) — never from
  // inside tick(), which is the whole point: cosmetic ageing is off the
  // simulation's critical path and out of its state.
  //
  // `born` only ever increases, so the expired entries are a prefix and one
  // splice clears them.
  prune(now) {
    const list = this.goldPopups, life = this.GOLD_POPUP_LIFETIME;
    let i = 0;
    while (i < list.length && now - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
  }
};
