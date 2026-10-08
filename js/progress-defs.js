// Achievement and cosmetic tables (docs/metaprogression.md §3–§5). Pure data,
// client-only for the sim's purposes; the Node server requires this same file
// to validate IDs. IDs are stable once shipped: never rename or reuse one.
//
// Achievement fields: name, desc, group; optional `hidden` (shown as ??? until
// earned), `mp` (multiplayer only), `n` (the threshold `desc` quotes), `counter`
// (earned when that counter reaches `n`), `unlocks` (a cosmetic id), and
// `enabled: false` for one whose condition isn't tracked yet (never shown).
const ProgressDefs = {
  VERSION: 1,

  // Singleplayer wins only count in a match at least this big and this hard (R2).
  SP_MIN_NATIONS: 8,
  SP_MIN_DIFFICULTY: 'medium',
  // "8+ humans" for the multiplayer placement achievements.
  MP_MIN_HUMANS: 8,

  GROUPS: [
    { id: 'first', name: 'First steps' },
    { id: 'mastery', name: 'Mastery' },
    { id: 'style', name: 'Style' },
    { id: 'hidden', name: 'Hidden' }
  ],

  COUNTERS: ['wins'],

  ACHIEVEMENTS: {
    first_blood:   { group: 'first', name: 'First Blood', desc: 'Eliminate a nation.' },
    founder:       { group: 'first', name: 'Founder', desc: 'Finish the tutorial.' },
    landlord:      { group: 'first', name: 'Landlord', desc: 'Hold 25% of the map\'s land.', n: 25 },
    victory:       { group: 'first', name: 'Victory', desc: 'Win a match.' },
    sea_legs:      { group: 'first', name: 'Sea Legs', desc: 'Land a naval invasion on another landmass.', unlocks: 'emblem_anchor' },
    pact:          { group: 'first', name: 'Pact', desc: 'Form an alliance.' },

    wins_5:        { group: 'mastery', name: 'Veteran', desc: 'Win 5 matches.', counter: 'wins', n: 5, unlocks: 'title_veteran' },
    wins_25:       { group: 'mastery', name: 'Warlord', desc: 'Win 25 matches.', counter: 'wins', n: 25, unlocks: 'banner_warlord' },
    wins_100:      { group: 'mastery', name: 'Conqueror', desc: 'Win 100 matches.', counter: 'wins', n: 100, unlocks: 'emblem_crown' },
    win_hard:      { group: 'mastery', name: 'Hard Target', desc: 'Win against Hard bots.', unlocks: 'banner_iron' },
    win_world:     { group: 'mastery', name: 'World Power', desc: 'Win on the world map.', unlocks: 'emblem_globe' },
    win_large:     { group: 'mastery', name: 'Big Country', desc: 'Win on a large map.', unlocks: 'title_big_country' },
    win_br:        { group: 'mastery', name: 'Last One Standing', desc: 'Win a Battle Royale.', unlocks: 'banner_last_standing' },
    win_fog:       { group: 'mastery', name: 'In the Dark', desc: 'Win a fog-of-war match.', unlocks: 'emblem_eye' },
    win_team:      { group: 'mastery', name: 'Team Player', desc: 'Win a team match.', unlocks: 'title_team_player' },
    mp_podium:     { group: 'mastery', name: 'Podium', desc: 'Finish in the top 3 of a match with 8 or more humans.', mp: true, unlocks: 'title_contender' },
    mp_champion:   { group: 'mastery', name: 'Champion', desc: 'Win a match with 8 or more humans.', mp: true, unlocks: 'title_champion' },

    clean_hands:   { group: 'style', name: 'Clean Hands', desc: 'Win without launching a nuke.', unlocks: 'title_clean_hands' },
    lone_wolf:     { group: 'style', name: 'Lone Wolf', desc: 'Win without ever being in an alliance.', unlocks: 'title_lone_wolf' },
    pacifist_econ: { group: 'style', name: 'Pacifist Economy', desc: 'Reach the highest gold income in the match before your first attack on a nation.', enabled: false, unlocks: 'emblem_coin' },
    blitz:         { group: 'style', name: 'Blitz', desc: 'Win in under 15 minutes of match time.', n: 15, unlocks: 'title_blitz' },
    comeback:      { group: 'style', name: 'Comeback', desc: 'Win after falling below 2% of the map.', n: 2, unlocks: 'title_comeback' },
    fortress:      { group: 'style', name: 'Fortress', desc: 'Win without losing your starting tile.', unlocks: 'title_unbroken' },
    admiral:       { group: 'style', name: 'Admiral', desc: 'Sink 10 enemy boats with warships in one match.', n: 10, enabled: false, unlocks: 'title_admiral' },
    iron_dome:     { group: 'style', name: 'Iron Dome', desc: 'Shoot down 5 nukes with SAMs in one match.', n: 5, unlocks: 'emblem_shield' },
    driller:       { group: 'style', name: 'Driller', desc: 'Place the Drill and win.', unlocks: 'emblem_drill' },

    so_close:      { group: 'hidden', name: 'So Close', desc: 'Be the last nation eliminated.', hidden: true },
    betrayed:      { group: 'hidden', name: 'Betrayed', desc: 'Be eliminated by a nation you were allied with in that match.', hidden: true, unlocks: 'title_betrayed' },
    scorched:      { group: 'hidden', name: 'Scorched Earth', desc: 'Launch 10 nukes in one match.', hidden: true, n: 10, unlocks: 'emblem_flame' },
    kingmaker:     { group: 'hidden', name: 'Kingmaker', desc: 'Donate to an ally who goes on to win a free-for-all.', hidden: true, enabled: false, unlocks: 'title_kingmaker' }
  },

  COSMETIC_TYPES: ['title', 'emblem', 'banner'],

  COSMETICS: {
    title_veteran:        { type: 'title', name: 'Veteran' },
    title_big_country:    { type: 'title', name: 'the Great' },
    title_team_player:    { type: 'title', name: 'Comrade' },
    title_contender:      { type: 'title', name: 'Contender' },
    title_champion:       { type: 'title', name: 'Champion' },
    title_clean_hands:    { type: 'title', name: 'the Merciful' },
    title_lone_wolf:      { type: 'title', name: 'Lone Wolf' },
    title_blitz:          { type: 'title', name: 'the Swift' },
    title_comeback:       { type: 'title', name: 'the Undying' },
    title_unbroken:       { type: 'title', name: 'the Unbroken' },
    title_admiral:        { type: 'title', name: 'Admiral' },
    title_betrayed:       { type: 'title', name: 'the Betrayed' },
    title_kingmaker:      { type: 'title', name: 'Kingmaker' },

    emblem_anchor:        { type: 'emblem', name: 'Anchor', glyph: '⚓\uFE0E' },
    emblem_crown:         { type: 'emblem', name: 'Crown', glyph: '♛' },
    emblem_globe:         { type: 'emblem', name: 'Globe', glyph: '🌐' },
    emblem_eye:           { type: 'emblem', name: 'Eye', glyph: '👁\uFE0E' },
    emblem_coin:          { type: 'emblem', name: 'Coin', glyph: '🪙' },
    emblem_shield:        { type: 'emblem', name: 'Shield', glyph: '🛡\uFE0E' },
    emblem_drill:         { type: 'emblem', name: 'Drill bit', glyph: '⛏\uFE0E' },
    emblem_flame:         { type: 'emblem', name: 'Flame', glyph: '🔥' },

    banner_warlord:       { type: 'banner', name: 'Warlord' },
    banner_iron:          { type: 'banner', name: 'Iron' },
    banner_last_standing: { type: 'banner', name: 'Last Standing' }
  }
};

// Progress helpers (docs/metaprogression.md §5.2), run by the browser and by the
// account server, so they stay dependency-free and never throw.
ProgressDefs.COUNTER_MAX = 1e6;

ProgressDefs._own = function (obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
};

ProgressDefs.empty = function () {
  return { v: ProgressDefs.VERSION, unlocked: {}, counters: {}, equipped: { title: null, emblem: null, banner: null } };
};

// A clean progress object from untrusted input; anything unknown or malformed is
// dropped. With `now` (unix ms), unlock dates later than that are pulled back to it.
ProgressDefs.sanitize = function (raw, now) {
  const D = ProgressDefs, own = D._own, out = D.empty();
  if (!raw || typeof raw !== 'object') return out;
  const limit = (typeof now === 'number' && isFinite(now) && now >= 1) ? Math.floor(now) : 8.64e15;
  for (const id in D.ACHIEVEMENTS) {
    if (!own(D.ACHIEVEMENTS, id) || !own(raw.unlocked, id)) continue;
    const t = raw.unlocked[id];
    if (typeof t !== 'number' || !isFinite(t) || t < 1) continue;
    out.unlocked[id] = Math.min(Math.floor(t), limit);
  }
  for (let i = 0; i < D.COUNTERS.length; i++) {
    const c = D.COUNTERS[i];
    if (!own(raw.counters, c)) continue;
    const n = raw.counters[c];
    if (typeof n !== 'number' || !isFinite(n) || n < 0) continue;
    out.counters[c] = Math.min(Math.floor(n), D.COUNTER_MAX);
  }
  for (let i = 0; i < D.COSMETIC_TYPES.length; i++) {
    const type = D.COSMETIC_TYPES[i];
    const id = own(raw.equipped, type) ? raw.equipped[type] : null;
    if (typeof id === 'string' && own(D.COSMETICS, id) && D.COSMETICS[id].type === type) out.equipped[type] = id;
  }
  return out;
};

// Merges two sanitized copies into a new one: earlier unlock date, larger
// counter, and `equipped` from `b` (pass the copy whose loadout should win as b).
ProgressDefs.merge = function (a, b) {
  const D = ProgressDefs, own = D._own, out = D.empty();
  const pair = [a || {}, b || {}];
  for (let k = 0; k < 2; k++) {
    const u = pair[k].unlocked, c = pair[k].counters;
    for (const id in u) {
      if (own(u, id) && (!own(out.unlocked, id) || u[id] < out.unlocked[id])) out.unlocked[id] = u[id];
    }
    for (const id in c) {
      if (own(c, id) && (!own(out.counters, id) || c[id] > out.counters[id])) out.counters[id] = c[id];
    }
  }
  const eq = pair[1].equipped;
  for (let i = 0; i < D.COSMETIC_TYPES.length; i++) {
    const type = D.COSMETIC_TYPES[i];
    if (own(eq, type) && eq[type]) out.equipped[type] = eq[type];
  }
  return out;
};

// `progress.equipped` with every item cleared whose unlocking achievement (the
// one whose `unlocks` is that cosmetic) isn't in `progress.unlocked`.
ProgressDefs.equippable = function (progress) {
  const D = ProgressDefs, own = D._own, out = D.empty().equipped;
  if (!progress) return out;
  const earned = {};
  for (const id in D.ACHIEVEMENTS) {
    if (own(D.ACHIEVEMENTS, id) && D.ACHIEVEMENTS[id].unlocks && own(progress.unlocked, id)) {
      earned[D.ACHIEVEMENTS[id].unlocks] = true;
    }
  }
  for (let i = 0; i < D.COSMETIC_TYPES.length; i++) {
    const type = D.COSMETIC_TYPES[i];
    const id = own(progress.equipped, type) ? progress.equipped[type] : null;
    if (typeof id === 'string' && earned[id] === true) out[type] = id;
  }
  return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = ProgressDefs;
