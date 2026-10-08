// Client-local presentation effects. Nothing in here is simulation state:
// Fx is not part of Game, so the state hash cannot see it and it can hold
// per-viewer detail freely.
//
// The contract with the simulation is one-directional:
//   - the sim CALLS INTO Fx, unconditionally, for every player alike,
//     passing along whose event it was;
//   - the sim NEVER READS anything back out of Fx;
//   - the renderer decides what the local viewer (`Game.me`) sees.
// The moment a sim branch reads Fx, Fx becomes sim state.
const Fx = {
  // Seconds a "+gold" label drifts upward and fades before it disappears.
  // Lives here rather than on Game because nothing but the renderer has any
  // use for it — the sim no longer ages these at all.
  GOLD_POPUP_LIFETIME: 1.2,

  // Hard ceiling on live popups, oldest dropped first. Every owner's
  // payouts are recorded (filtering happens at draw time), and a burst runs
  // many ticks with no frame to prune in, so the array must be bounded
  // however the sim is driven.
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

  // Seconds a finished Radio Tower's scan plays (fog matches). The tower's
  // record is gone from the sim the tick it finishes, so this is all that is
  // ever seen of a built one: its icon fading while rings sweep the disc it
  // uncovered (Render.drawRadioScans).
  RADIO_SCAN_LIFETIME: 2,

  // { tile, ownerId, born } — same append-in-order/prune-from-front contract
  // as the popup lists. Rare, so it needs no cap.
  radioScans: [],

  // Called from Game.init. Effects are per-match, same as everything they
  // decorate; carrying a previous match's popups into a new map would draw
  // them over unrelated tiles.
  reset() {
    this.goldPopups.length = 0;
    this.killPopups.length = 0;
    this.donationToasts.length = 0;
    this.radioScans.length = 0;
  },

  // Record a Radio Tower finishing on `tile` for `ownerId`. Called
  // unconditionally by Game.updateConstruction; the renderer leaves out the
  // ones the fog hides from the viewer.
  radioScan(tile, ownerId) {
    const born = Game.elapsed;
    this.pruneRadioScans(born);
    this.radioScans.push({ tile, ownerId, born });
  },

  pruneRadioScans(now) {
    const list = this.radioScans, life = this.RADIO_SCAN_LIFETIME;
    let i = 0;
    while (i < list.length && now - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
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

  // Drop everything that has finished fading as of `now`. Called on push
  // (sim clock) and before drawing (render clock), never from inside tick().
  // `born` only increases, so the expired entries are a prefix.
  prune(now) {
    const list = this.goldPopups, life = this.GOLD_POPUP_LIFETIME;
    let i = 0;
    while (i < list.length && now - list[i].born >= life) i++;
    if (i > 0) list.splice(0, i);
  }
};
