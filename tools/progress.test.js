// node --test tools/progress.test.js
// Achievement tracking (js/progress.js): storage, counters, the pure judging
// of a match summary, and the per-tick watchers against a stub sim.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const store = new Map();
let storageBroken = false;
global.localStorage = {
  getItem(k) { if (storageBroken) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { if (storageBroken) throw new Error('denied'); store.set(k, String(v)); },
  removeItem(k) { if (storageBroken) throw new Error('denied'); store.delete(k); }
};
global.Replay = { active: false };
global.Tutorial = { active: false };
global.Fx = { killPopups: [] };
global.ProgressDefs = require(path.join(__dirname, '..', 'js', 'progress-defs.js'));
const Progress = require(path.join(__dirname, '..', 'js', 'progress.js'));
const Defs = global.ProgressDefs;

function fresh(saved) {
  store.clear();
  storageBroken = false;
  if (saved !== undefined) store.set(Progress.KEY, typeof saved === 'string' ? saved : JSON.stringify(saved));
  Progress.onUnlock = null;
  Progress.onChange = null;
  Progress.matchEarned.length = 0;
  Progress.init();
}

// A singleplayer win that meets R2, with nothing else going for it.
function summary(over) {
  return Object.assign({
    singleplayer: true, humans: 1, bots: 9, nations: 10, difficulty: 'medium',
    map: 'procedural', size: 'medium', fog: false, team: false,
    ticks: 20000, over: true, alive: true, won: true, place: 1, lastOut: false,
    battleRoyale: false, drillMine: false,
    nationKills: 0, peakLandPct: 10, fellBelow: false, allied: true, seaLanding: false,
    nukes: 1, samKills: 0, startKnown: true, startLost: true, betrayed: false
  }, over);
}
const earns = (id, over) => Progress.evaluate(summary(over)).includes(id);

// --- Storage -----------------------------------------------------------------

test('init: missing storage gives an empty state', () => {
  fresh();
  assert.deepStrictEqual(Progress.state, {
    v: 1, unlocked: {}, counters: { wins: 0 }, equipped: { title: null, emblem: null, banner: null }
  });
});

test('init: corrupt storage is tolerated', () => {
  for (const bad of ['{not json', '42', '"x"', '[]', 'null', '{"unlocked":7,"counters":"x","equipped":[]}']) {
    fresh(bad);
    assert.deepStrictEqual(Progress.state.unlocked, {});
    assert.strictEqual(Progress.state.counters.wins, 0);
    assert.strictEqual(Progress.state.equipped.title, null);
  }
});

test('init: storage that throws is tolerated, and so is saving to it', () => {
  fresh();
  storageBroken = true;
  Progress.init();
  assert.deepStrictEqual(Progress.state.unlocked, {});
  assert.strictEqual(Progress.unlock('victory'), true);
  assert.strictEqual(Progress.has('victory'), true);
});

test('init: unknown ids and bad values are dropped, good ones kept', () => {
  fresh({
    v: 1,
    unlocked: { victory: 1700000000000, nope: 5, pact: 'yesterday', toString: 3, landlord: -1 },
    counters: { wins: 3.7, junk: 9 },
    equipped: { title: 'title_veteran', emblem: 'banner_iron', banner: 'no_such', hat: 'x' }
  });
  assert.deepStrictEqual(Progress.state.unlocked, { victory: 1700000000000 });
  assert.deepStrictEqual(Progress.state.counters, { wins: 3 });
  assert.deepStrictEqual(Progress.state.equipped, { title: 'title_veteran', emblem: null, banner: null });
  assert.strictEqual(Progress.has('toString'), false);
});

test('init: a stored counter already past a threshold unlocks it', () => {
  fresh({ counters: { wins: 6 } });
  assert.strictEqual(Progress.has('wins_5'), true);
  assert.strictEqual(Progress.has('wins_25'), false);
});

test('save round-trips through storage', () => {
  fresh();
  Progress.unlock('pact');
  Progress.bump('wins', 2);
  const saved = JSON.parse(store.get('borderwar_progress'));
  assert.strictEqual(saved.v, 1);
  assert.strictEqual(saved.counters.wins, 2);
  assert.ok(saved.unlocked.pact > 0);
  const at = Progress.state.unlocked.pact;
  Progress.init();
  assert.strictEqual(Progress.state.unlocked.pact, at);
  assert.strictEqual(Progress.state.counters.wins, 2);
});

// --- Unlocks and counters ----------------------------------------------------

test('unlock is idempotent and fires the hooks once', () => {
  fresh();
  const unlocked = [];
  let changes = 0;
  Progress.onUnlock = (id) => unlocked.push(id);
  Progress.onChange = () => changes++;
  assert.strictEqual(Progress.unlock('first_blood'), true);
  const at = Progress.state.unlocked.first_blood;
  assert.ok(at > 0);
  assert.strictEqual(Progress.unlock('first_blood'), false);
  assert.strictEqual(Progress.state.unlocked.first_blood, at);
  assert.deepStrictEqual(unlocked, ['first_blood']);
  assert.deepStrictEqual(Progress.matchEarned, ['first_blood']);
  assert.strictEqual(changes, 1);
});

test('unlock ignores unknown and disabled ids', () => {
  fresh();
  assert.strictEqual(Progress.unlock('no_such_thing'), false);
  assert.strictEqual(Progress.unlock('constructor'), false);
  const def = Defs.ACHIEVEMENTS.pact;
  def.enabled = false;
  try {
    assert.strictEqual(Progress.unlock('pact'), false);
    assert.strictEqual(Progress.has('pact'), false);
    assert.ok(!Progress.list().some((e) => e.id === 'pact'));
  } finally { delete def.enabled; }
  assert.deepStrictEqual(Progress.state.unlocked, {});
});

test('bump unlocks counter achievements exactly at their thresholds', () => {
  fresh();
  Progress.bump('wins', 4);
  assert.strictEqual(Progress.has('wins_5'), false);
  Progress.bump('wins');
  assert.strictEqual(Progress.state.counters.wins, 5);
  assert.strictEqual(Progress.has('wins_5'), true);
  assert.strictEqual(Progress.has('wins_25'), false);
  Progress.bump('wins', 19);
  assert.strictEqual(Progress.has('wins_25'), false);
  Progress.bump('wins', 1);
  assert.strictEqual(Progress.has('wins_25'), true);
  Progress.bump('wins', 75);
  assert.strictEqual(Progress.has('wins_100'), true);
});

test('bump ignores unknown counters and bad amounts', () => {
  fresh();
  Progress.bump('losses', 3);
  Progress.bump('wins', -2);
  Progress.bump('wins', NaN);
  assert.deepStrictEqual(Progress.state.counters, { wins: 0 });
});

test('list covers every enabled achievement in table order, with counter progress', () => {
  fresh();
  Progress.bump('wins', 7);
  const list = Progress.list();
  const ids = Object.keys(Defs.ACHIEVEMENTS).filter((id) => Defs.ACHIEVEMENTS[id].enabled !== false);
  assert.deepStrictEqual(list.map((e) => e.id), ids);
  const by = Object.fromEntries(list.map((e) => [e.id, e]));
  assert.strictEqual(by.wins_5.def, Defs.ACHIEVEMENTS.wins_5);
  assert.deepStrictEqual(by.wins_5.progress, { have: 5, need: 5 });
  assert.ok(by.wins_5.unlockedAt > 0);
  assert.deepStrictEqual(by.wins_25.progress, { have: 7, need: 25 });
  assert.strictEqual(by.wins_25.unlockedAt, null);
  assert.strictEqual(by.victory.progress, null);
});

// --- R2 eligibility ----------------------------------------------------------

test('R2: a singleplayer win needs enough nations and Medium or Hard bots', () => {
  assert.strictEqual(Progress.isWin(summary()), true);
  assert.strictEqual(Progress.isWin(summary({ nations: Defs.SP_MIN_NATIONS })), true);
  assert.strictEqual(Progress.isWin(summary({ nations: Defs.SP_MIN_NATIONS - 1 })), false);
  assert.strictEqual(Progress.isWin(summary({ difficulty: 'easy' })), false);
  assert.strictEqual(Progress.isWin(summary({ difficulty: 'hard' })), true);
  assert.strictEqual(Progress.isWin(summary({ won: false })), false);
});

test('R2: a multiplayer win always counts', () => {
  assert.strictEqual(Progress.isWin(summary({ singleplayer: false, humans: 2, bots: 0, nations: 2, difficulty: 'easy' })), true);
});

test('R2: an ineligible win earns no win achievement but keeps the others', () => {
  const got = Progress.evaluate(summary({
    nations: 3, difficulty: 'hard', map: 'world', fog: true, nukes: 0, allied: false,
    drillMine: true, battleRoyale: true, ticks: 10, startLost: false, fellBelow: true,
    nationKills: 2, peakLandPct: 60, seaLanding: true
  }));
  assert.deepStrictEqual(got.sort(), ['first_blood', 'landlord', 'sea_legs']);
});

test('a loss earns no win achievement', () => {
  const got = Progress.evaluate(summary({ won: false, place: 4, alive: false, nukes: 0, allied: false, startLost: false }));
  assert.deepStrictEqual(got, []);
});

// --- evaluate, one achievement at a time -------------------------------------

test('victory', () => {
  assert.ok(earns('victory'));
  assert.ok(!earns('victory', { won: false }));
});

test('first_blood', () => {
  assert.ok(earns('first_blood', { nationKills: 1 }));
  assert.ok(!earns('first_blood'));
});

test('landlord', () => {
  assert.ok(earns('landlord', { peakLandPct: 25 }));
  assert.ok(!earns('landlord', { peakLandPct: 24.99 }));
});

test('sea_legs', () => {
  assert.ok(earns('sea_legs', { seaLanding: true }));
  assert.ok(!earns('sea_legs'));
});

test('pact', () => {
  assert.ok(earns('pact', { allied: true, won: false }));
  assert.ok(!earns('pact', { allied: false }));
});

test('win_hard', () => {
  assert.ok(earns('win_hard', { difficulty: 'hard' }));
  assert.ok(!earns('win_hard'));
  assert.ok(!earns('win_hard', { difficulty: 'hard', won: false }));
  assert.ok(!earns('win_hard', { singleplayer: false, difficulty: 'hard', bots: 0 }));
});

test('win_world and win_large', () => {
  assert.ok(earns('win_world', { map: 'world', size: 'world' }));
  assert.ok(!earns('win_world'));
  assert.ok(earns('win_large', { size: 'large' }));
  assert.ok(earns('win_large', { map: 'world', size: 'world' }));
  assert.ok(!earns('win_large', { size: 'small' }));
  assert.ok(!earns('win_large', { size: 'large', won: false }));
});

test('win_br, win_fog, win_team', () => {
  assert.ok(earns('win_br', { battleRoyale: true }));
  assert.ok(!earns('win_br'));
  assert.ok(earns('win_fog', { fog: true }));
  assert.ok(!earns('win_fog'));
  assert.ok(earns('win_team', { team: true }));
  assert.ok(!earns('win_team'));
  assert.ok(!earns('win_team', { team: true, won: false }));
});

test('mp_champion and mp_podium need multiplayer with enough humans', () => {
  const mp = { singleplayer: false, humans: Defs.MP_MIN_HUMANS, bots: 0, nations: Defs.MP_MIN_HUMANS };
  assert.ok(earns('mp_champion', mp));
  assert.ok(earns('mp_podium', mp));
  assert.ok(!earns('mp_champion', Object.assign({}, mp, { humans: Defs.MP_MIN_HUMANS - 1 })));
  assert.ok(!earns('mp_podium', Object.assign({}, mp, { humans: Defs.MP_MIN_HUMANS - 1 })));
  assert.ok(!earns('mp_champion', { humans: 8 }), 'singleplayer never counts');
  assert.ok(!earns('mp_podium', { humans: 8 }), 'singleplayer never counts');
  const lost = Object.assign({}, mp, { won: false, alive: false });
  assert.ok(earns('mp_podium', Object.assign({}, lost, { place: 3 })));
  assert.ok(!earns('mp_podium', Object.assign({}, lost, { place: 4 })));
  assert.ok(!earns('mp_podium', Object.assign({}, lost, { place: null })));
  assert.ok(!earns('mp_champion', Object.assign({}, lost, { place: 2 })));
});

test('clean_hands', () => {
  assert.ok(earns('clean_hands', { nukes: 0 }));
  assert.ok(!earns('clean_hands', { nukes: 1 }));
  assert.ok(!earns('clean_hands', { nukes: 0, won: false }));
});

test('lone_wolf', () => {
  assert.ok(earns('lone_wolf', { allied: false }));
  assert.ok(!earns('lone_wolf', { allied: true }));
  assert.ok(!earns('lone_wolf', { allied: false, team: true }));
  assert.ok(!earns('lone_wolf', { allied: false, won: false }));
});

test('blitz', () => {
  const limit = Defs.ACHIEVEMENTS.blitz.n * 600;
  assert.ok(earns('blitz', { ticks: limit - 1 }));
  assert.ok(!earns('blitz', { ticks: limit }));
  assert.ok(!earns('blitz', { ticks: 10, won: false }));
});

test('comeback', () => {
  assert.ok(earns('comeback', { fellBelow: true }));
  assert.ok(!earns('comeback'));
  assert.ok(!earns('comeback', { fellBelow: true, won: false }));
});

test('fortress', () => {
  assert.ok(earns('fortress', { startKnown: true, startLost: false }));
  assert.ok(!earns('fortress', { startKnown: true, startLost: true }));
  assert.ok(!earns('fortress', { startKnown: false, startLost: false }));
  assert.ok(!earns('fortress', { startKnown: true, startLost: false, won: false }));
});

test('driller', () => {
  assert.ok(earns('driller', { drillMine: true, battleRoyale: true }));
  assert.ok(!earns('driller', { battleRoyale: true }));
  assert.ok(!earns('driller', { drillMine: true, won: false }));
});

test('iron_dome and scorched', () => {
  assert.ok(earns('iron_dome', { samKills: Defs.ACHIEVEMENTS.iron_dome.n, won: false }));
  assert.ok(!earns('iron_dome', { samKills: Defs.ACHIEVEMENTS.iron_dome.n - 1 }));
  assert.ok(earns('scorched', { nukes: Defs.ACHIEVEMENTS.scorched.n, won: false }));
  assert.ok(!earns('scorched', { nukes: Defs.ACHIEVEMENTS.scorched.n - 1 }));
});

test('so_close and betrayed', () => {
  assert.ok(earns('so_close', { won: false, alive: false, place: 2, lastOut: true }));
  assert.ok(!earns('so_close', { won: false, alive: false, place: 2 }));
  assert.ok(earns('betrayed', { won: false, alive: false, place: 5, betrayed: true }));
  assert.ok(!earns('betrayed', { won: false, alive: false, place: 5 }));
});

test('evaluate only names known achievements, and none of the deferred ones', () => {
  const everything = summary({
    singleplayer: false, humans: 9, difficulty: 'hard', map: 'world', size: 'world', fog: true, team: false,
    ticks: 100, battleRoyale: true, drillMine: true, nationKills: 3, peakLandPct: 80, fellBelow: true,
    allied: false, seaLanding: true, nukes: 0, samKills: 9, startLost: false
  });
  const got = Progress.evaluate(everything);
  for (const id of got) assert.ok(Defs.ACHIEVEMENTS[id], id);
  assert.strictEqual(new Set(got).size, got.length);
  for (const id of ['founder', 'admiral', 'pacifist_econ', 'kingmaker', 'wins_5']) assert.ok(!got.includes(id), id);
});

// --- Tracking against a stub sim ---------------------------------------------

// A 40x20 map, all land on one landmass except x >= 30 (a second one), with
// player 0 the human on a full starting disc at (10, 10).
function world(opts) {
  opts = opts || {};
  const w = 40, h = 20;
  const bots = opts.bots === undefined ? 9 : opts.bots, tribes = opts.tribes === undefined ? 2 : opts.tribes;
  const humans = opts.humans || 1;
  const owner = new Int16Array(w * h).fill(-1);
  const landmassId = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) landmassId[i] = (i % w) >= 30 ? 1 : 0;
  const players = [];
  for (let i = 0; i < humans + bots + tribes; i++) {
    players.push({
      id: i, alive: true, isHuman: i < humans, isBot: i >= humans && i < humans + bots, isTribe: i >= humans + bots,
      tiles: new Set(), units: {}, gold: 500, lastDonationAt: new Map()
    });
  }
  global.GameMap = {
    width: w, height: h, landTiles: w * h, owner, landmassId,
    neighbors(i, out) {
      const x = i % w, y = (i / w) | 0;
      let n = 0;
      if (x > 0) out[n++] = i - 1;
      if (x < w - 1) out[n++] = i + 1;
      if (y > 0) out[n++] = i - w;
      if (y < h - 1) out[n++] = i + w;
      return n;
    }
  };
  global.Game = {
    TICK_DT: 0.1, ticks: 0, get elapsed() { return this.ticks * this.TICK_DT; },
    me: 0, players, humanCount: humans, nationCount: humans + bots,
    difficulty: opts.difficulty || 'medium', sizeKey: opts.sizeKey || 'medium', fog: !!opts.fog,
    teams: opts.teams || null, teamOf: (id) => (opts.teamOf ? opts.teamOf(id) : null),
    spawning: true, winnerId: null, drill: null, humanReserveTiles: [10 + 10 * w],
    placements: new Map(), alliances: [], boats: [], nukes: [], mirvs: [], samFlashes: [],
    buildings: new Map()
  };
  global.Fx.killPopups = [];
  give(0, disc(10, 10));
  return global.Game;
}
function disc(cx, cy) {
  const out = [];
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
    if (dx * dx + dy * dy <= 29) out.push((cy + dy) * GameMap.width + cx + dx);
  }
  return out;
}
function give(id, tiles) {
  for (const t of tiles) {
    const old = GameMap.owner[t];
    if (old >= 0) Game.players[old].tiles.delete(t);
    GameMap.owner[t] = id;
    if (id >= 0) Game.players[id].tiles.add(t);
  }
}
function begin(opts, sp) {
  fresh();
  const G = world(opts);
  Replay.active = false;
  Tutorial.active = false;
  Progress.beginMatch({ info: {}, myPlayerId: 0, singleplayer: sp !== false });
  G.spawning = false;
  return G;
}
// One turn: optional intent-phase work, one tick, optional in-tick work.
function turn(beforeTick, inTick) {
  if (beforeTick) beforeTick();
  Game.ticks++;
  if (inTick) inTick();
  Progress.sample();
}
function kill(id, byId) {
  const p = Game.players[id];
  give(byId === undefined ? -1 : byId, Array.from(p.tiles));
  if (!p.isTribe) Game.placements.set(id, Game.players.filter((q) => !q.isTribe && q.alive).length);
  p.alive = false;
  if (byId !== undefined) Fx.killPopups.push({ tile: 0, amount: p.gold, ownerId: byId, born: Game.elapsed });
}

test('R3: replays and the tutorial are not tracked', () => {
  fresh();
  world();
  Replay.active = true;
  Progress.beginMatch({ singleplayer: true });
  assert.strictEqual(Progress.match, null);
  Replay.active = false;
  Tutorial.active = true;
  Progress.beginMatch({ singleplayer: true });
  assert.strictEqual(Progress.match, null);
  Tutorial.active = false;
  Game.spawning = false;
  Game.winnerId = 0;
  Game.ticks = 5;
  Progress.sample();
  assert.deepStrictEqual(Progress.state.unlocked, {});
  assert.strictEqual(Progress.state.counters.wins, 0);
});

test('beginMatch reads the match facts and clears matchEarned', () => {
  fresh();
  Progress.unlock('pact');
  world({ difficulty: 'hard', sizeKey: 'world', fog: true });
  Progress.beginMatch({ singleplayer: true });
  assert.deepStrictEqual(Progress.matchEarned, []);
  const m = Progress.match;
  assert.strictEqual(m.singleplayer, true);
  assert.strictEqual(m.nations, 10);
  assert.strictEqual(m.bots, 9);
  assert.strictEqual(m.humans, 1);
  assert.strictEqual(m.difficulty, 'hard');
  assert.strictEqual(m.map, 'world');
  assert.strictEqual(m.fog, true);
});

test('nothing happens during the spawn phase', () => {
  const G = begin();
  G.spawning = true;
  G.winnerId = 0;
  Progress.sample();
  assert.deepStrictEqual(Progress.state.unlocked, {});
});

test('a singleplayer win is awarded once and bumps the wins counter once', () => {
  const G = begin();
  turn();
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('victory'));
  assert.ok(Progress.has('lone_wolf'));
  assert.ok(Progress.has('clean_hands'));
  assert.ok(Progress.has('fortress'));
  assert.ok(Progress.has('blitz'));
  assert.strictEqual(Progress.state.counters.wins, 1);
  assert.strictEqual(Progress.match.place, 1);
  Progress.sample();
  Progress.sample();
  assert.strictEqual(Progress.state.counters.wins, 1);
  assert.ok(Progress.matchEarned.includes('victory'));
});

test('a win in too small a singleplayer match counts for nothing', () => {
  const G = begin({ bots: 3 });
  turn(null, () => { G.winnerId = 0; });
  assert.ok(!Progress.has('victory'));
  assert.strictEqual(Progress.state.counters.wins, 0);
});

test('someone else winning is not a win', () => {
  const G = begin();
  turn(null, () => { give(1, [0, 1, 2]); G.winnerId = 1; });
  assert.ok(!Progress.has('victory'));
  assert.strictEqual(Progress.state.counters.wins, 0);
  assert.strictEqual(Progress.match.place, 2);
});

test('a team win counts for a member who is already out', () => {
  const G = begin({ teams: {}, teamOf: (id) => (id <= 1 ? 'Red' : 'Blue') });
  turn();
  turn(null, () => kill(0));
  assert.strictEqual(Progress.match.alive, false);
  assert.ok(!Progress.has('victory'));
  turn(null, () => { G.winnerTeam = 'Red'; G.winnerId = 1; });
  assert.ok(Progress.has('victory'));
  assert.ok(Progress.has('win_team'));
  assert.ok(!Progress.has('lone_wolf'));
  assert.strictEqual(Progress.state.counters.wins, 1);
});

test('losing team gets nothing', () => {
  const G = begin({ teams: {}, teamOf: (id) => (id <= 1 ? 'Red' : 'Blue') });
  turn(null, () => { G.winnerTeam = 'Blue'; G.winnerId = 2; });
  assert.ok(!Progress.has('victory'));
});

test('first_blood: a nation I eliminate', () => {
  begin();
  turn();
  turn(null, () => kill(3, 0));
  assert.ok(Progress.has('first_blood'));
  assert.strictEqual(Progress.match.nationKills, 1);
});

test('first_blood: not for a tribe, someone else\'s kill, or an unattributed death', () => {
  const G = begin();
  turn(null, () => kill(G.players.length - 1, 0));   // a tribe
  turn(null, () => kill(3, 4));                      // a bot kills a bot
  turn(null, () => kill(5));                         // swept, no blow
  assert.ok(!Progress.has('first_blood'));
});

test('first_blood: not when the blow could have been the tribe that died with it', () => {
  const G = begin();
  turn(null, () => { kill(G.players.length - 1, 0); kill(3, 4); });
  assert.ok(!Progress.has('first_blood'));
  // Two blows of mine, one tribe and one nation dead: one of them hit the nation.
  turn(null, () => { kill(G.players.length - 2, 0); kill(5, 0); });
  assert.ok(Progress.has('first_blood'));
});

test('first_blood: retaking a dead nation\'s stray tile is not a kill', () => {
  begin();
  turn(null, () => kill(3, 4));
  turn(null, () => {
    Fx.killPopups.push({ tile: 0, amount: 0, ownerId: 0, born: Game.elapsed });
    kill(5);
  });
  assert.ok(!Progress.has('first_blood'));
});

test('landlord unlocks the moment a quarter of the land is held', () => {
  begin();
  const quarter = GameMap.landTiles / 4;
  const mine = [];
  for (let t = 0; mine.length + Game.players[0].tiles.size < quarter - 1; t++) {
    if (GameMap.owner[t] !== 0) mine.push(t);
  }
  turn(null, () => give(0, mine));
  assert.ok(!Progress.has('landlord'));
  turn(null, () => give(0, [GameMap.owner.indexOf(-1)]));
  assert.ok(Progress.has('landlord'));
});

test('comeback: falling under 2% only counts after holding 4%', () => {
  const G = begin();
  const me = G.players[0];
  // 97 of 800 tiles is 12%: the peak is high enough.
  turn();
  turn(null, () => give(1, Array.from(me.tiles).slice(0, 85)));
  assert.strictEqual(Progress.match.fellBelow, true);
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('comeback'));
});

test('comeback: a small nation that was never big has not come back', () => {
  const G = begin();
  const me = G.players[0];
  give(1, Array.from(me.tiles).slice(0, 80));   // 17 tiles, 2.1%, before the first tick
  turn();
  turn(null, () => give(1, Array.from(me.tiles).slice(0, 10)));
  assert.strictEqual(Progress.match.fellBelow, false);
  turn(null, () => { G.winnerId = 0; });
  assert.ok(!Progress.has('comeback'));
});

test('fortress: the starting tile is found, and losing it is noticed', () => {
  const G = begin();
  turn();
  assert.strictEqual(Progress.match.startKnown, true);
  assert.strictEqual(Progress._start, 10 + 10 * GameMap.width);
  turn(null, () => give(1, [10 + 10 * GameMap.width]));
  turn(null, () => give(0, [10 + 10 * GameMap.width]));
  assert.strictEqual(Progress.match.startLost, true);
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('victory'));
  assert.ok(!Progress.has('fortress'));
});

test('fortress: a disc clipped by the coast still gives one centre, or none', () => {
  fresh();
  const G = world();
  // Sea two columns west of the capital, and a second capital hard on the edge.
  give(-1, Array.from(G.players[0].tiles));
  for (let y = 0; y < GameMap.height; y++) for (let x = 0; x < 3; x++) GameMap.owner[y * GameMap.width + x] = -2;
  give(0, disc(5, 10).filter((t) => GameMap.owner[t] === -1));
  Progress.beginMatch({ singleplayer: true });
  G.spawning = false;
  turn();
  assert.strictEqual(Progress._start, 5 + 10 * GameMap.width);
});

test('fortress: fog matches start on the reserve tile', () => {
  begin({ fog: true });
  turn();
  assert.strictEqual(Progress._start, Game.humanReserveTiles[0]);
});

test('pact and lone_wolf follow Game.alliances', () => {
  const G = begin();
  turn();
  assert.ok(!Progress.has('pact'));
  turn(null, () => G.alliances.push({ a: 4, b: 5 }));
  assert.ok(!Progress.has('pact'));
  turn(null, () => G.alliances.push({ a: 2, b: 0 }));
  assert.ok(Progress.has('pact'));
  turn(null, () => { G.alliances.length = 0; });
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('victory'));
  assert.ok(!Progress.has('lone_wolf'));
});

test('betrayed: eliminated by a nation I had been allied with', () => {
  const G = begin();
  turn(null, () => G.alliances.push({ a: 0, b: 2 }));
  turn(null, () => { G.alliances.length = 0; });
  turn(null, () => kill(0, 2));
  assert.ok(Progress.has('betrayed'));
});

test('betrayed: not by a stranger, and not without a blow', () => {
  let G = begin();
  turn(null, () => G.alliances.push({ a: 0, b: 2 }));
  turn(null, () => kill(0, 3));
  assert.ok(!Progress.has('betrayed'));
  G = begin();
  turn(null, () => G.alliances.push({ a: 0, b: 2 }));
  turn(null, () => kill(0));
  assert.ok(!Progress.has('betrayed'));
});

test('so_close: the last nation to fall, known once the match ends', () => {
  const G = begin();
  turn(null, () => { for (let i = 2; i < 10; i++) kill(i, 1); });
  turn(null, () => kill(0, 1));
  assert.ok(!Progress.has('so_close'));
  assert.strictEqual(Progress.match.place, 2);
  turn(null, () => { G.winnerId = 1; });
  assert.ok(Progress.has('so_close'));
  assert.ok(!Progress.has('victory'));
});

test('so_close: not when another nation falls after me', () => {
  const G = begin();
  turn(null, () => kill(0, 1));
  turn(null, () => kill(2, 1));
  turn(null, () => { G.winnerId = 1; });
  assert.ok(!Progress.has('so_close'));
});

// Sails from the water tile east of my capital's disc, (16, 10).
function boat(landingTile) {
  const water = 10 * GameMap.width + 16;
  GameMap.owner[water] = -2;
  return { id: 1, attacker: 0, target: 1, troops: 100, pos: 0, landingTile, path: [water, water, water, water, landingTile] };
}

test('sea_legs: a boat that lands on another landmass', () => {
  const G = begin();
  const landing = 10 * GameMap.width + 35;
  const b = boat(landing);
  turn(() => G.boats.push(b));
  turn(null, () => { b.pos = 2; });
  assert.ok(!Progress.has('sea_legs'));
  turn(null, () => { b.pos = 4; G.boats.length = 0; give(0, [landing]); });
  assert.ok(Progress.has('sea_legs'));
});

test('sea_legs: not for the same landmass, a sunk boat, a recalled boat, or a tile already mine', () => {
  let G = begin();
  let landing = 10 * GameMap.width + 25;                 // same landmass
  let b = boat(landing);
  turn(() => G.boats.push(b));
  turn(null, () => { b.pos = 4; G.boats.length = 0; give(0, [landing]); });
  assert.ok(!Progress.has('sea_legs'));

  G = begin();
  landing = 10 * GameMap.width + 35;
  b = boat(landing);
  turn(() => G.boats.push(b));
  turn(null, () => { b.pos = 2; G.boats.length = 0; }); // sunk mid-crossing
  assert.ok(!Progress.has('sea_legs'));

  G = begin();
  b = boat(landing);
  turn(() => G.boats.push(b));
  turn(null, () => { b.retreating = true; b.pos = 0; G.boats.length = 0; });
  assert.ok(!Progress.has('sea_legs'));

  G = begin();
  give(0, [landing]);
  b = boat(landing);
  turn(() => G.boats.push(b));
  turn(null, () => { b.pos = 4; G.boats.length = 0; });
  assert.ok(!Progress.has('sea_legs'));
});

function structure(type, tile) {
  const b = { type, tile, built: true, level: 1, siloQueue: [], samQueue: [], samRangeUpgrade: null };
  Game.buildings.set(tile, b);
  give(0, [tile]);
  Game.players[0].units[type] = (Game.players[0].units[type] || 0) + 1;
  return b;
}
function launch(silo, opts) {
  silo.siloQueue.push(Game.elapsed);
  if (!(opts && opts.shotDown)) Game.nukes.push({ ownerId: 0, nukeType: 'atombomb', born: Game.elapsed });
}

test('nukes: each launch of mine is counted once, and a win after one is not clean', () => {
  const G = begin();
  const silo = structure('silo', 5);
  turn();
  turn(() => launch(silo));
  assert.strictEqual(Progress.match.nukes, 1);
  turn();
  turn();
  assert.strictEqual(Progress.match.nukes, 1);
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('victory'));
  assert.ok(!Progress.has('clean_hands'));
});

test('nukes: a launch shot down on its first tick still counts', () => {
  begin();
  const silo = structure('silo', 5);
  turn();
  turn(() => launch(silo, { shotDown: true }));
  assert.strictEqual(Progress.match.nukes, 1);
});

test('nukes: a launch whose Silo is destroyed that tick still counts', () => {
  begin();
  const silo = structure('silo', 5);
  turn();
  turn(() => launch(silo), () => { Game.buildings.delete(5); Game.players[0].units.silo = 0; });
  assert.strictEqual(Progress.match.nukes, 1);
});

test('nukes: two launches in one turn, and a MIRV', () => {
  begin();
  const a = structure('silo', 5), b = structure('silo', 6);
  turn();
  turn(() => { launch(a); launch(b); });
  assert.strictEqual(Progress.match.nukes, 2);
  turn(() => { a.siloQueue.push(Game.elapsed); Game.mirvs.push({ ownerId: 0, nukeType: 'mirv', born: Game.elapsed }); });
  assert.strictEqual(Progress.match.nukes, 3);
});

test('nukes: not a Silo upgrade, a bot\'s launch, a MIRV warhead, or a captured Silo\'s history', () => {
  const G = begin();
  const silo = structure('silo', 5);
  turn();
  turn(null, () => silo.siloQueue.push(Game.elapsed));   // upgrade finishing, stamped in-tick
  turn();
  turn(null, () => Game.nukes.push({ ownerId: 3, nukeType: 'atombomb', born: Game.elapsed }));
  turn(() => Game.nukes.push({ ownerId: 0, nukeType: 'mirvwarhead', born: Game.elapsed }));
  // A bot fires from its Silo in-tick; I capture the Silo on the next tick.
  const theirs = { type: 'silo', tile: 700, built: true, level: 1, siloQueue: [], samQueue: [] };
  G.buildings.set(700, theirs);
  give(3, [700]);
  turn(null, () => theirs.siloQueue.push(Game.elapsed));
  turn(null, () => { give(0, [700]); G.players[0].units.silo = 2; });
  turn();
  assert.strictEqual(Progress.match.nukes, 0);
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('clean_hands'));
});

test('scorched unlocks on the tenth launch', () => {
  begin();
  const silo = structure('silo', 5);
  turn();
  for (let i = 0; i < Defs.ACHIEVEMENTS.scorched.n - 1; i++) turn(() => launch(silo));
  assert.ok(!Progress.has('scorched'));
  turn(() => launch(silo));
  assert.ok(Progress.has('scorched'));
});

test('iron_dome: counts my SAMs\' kills, not other SAMs\' or an upgrade stamp', () => {
  const G = begin();
  const sam = structure('sam', 5);
  const theirs = { type: 'sam', tile: 700, built: true, level: 1, siloQueue: [], samQueue: [], samRangeUpgrade: null };
  G.buildings.set(700, theirs);
  give(3, [700]);
  const shoot = (b) => { b.samQueue.push(Game.elapsed); G.samFlashes.push({ x: 0, y: 0, born: Game.elapsed }); };
  turn();
  turn(null, () => shoot(theirs));
  assert.strictEqual(Progress.match.samKills, 0);
  turn(null, () => shoot(sam));
  assert.strictEqual(Progress.match.samKills, 1);
  turn();
  assert.strictEqual(Progress.match.samKills, 1);
  // A level-up finishes on the same tick another SAM fires.
  turn(null, () => {
    sam.samQueue.push(Game.elapsed);
    sam.samRangeUpgrade = { startAt: Game.elapsed };
    shoot(theirs);
  });
  assert.strictEqual(Progress.match.samKills, 1);
  for (let i = 1; i < Defs.ACHIEVEMENTS.iron_dome.n - 1; i++) turn(null, () => shoot(sam));
  assert.ok(!Progress.has('iron_dome'));
  turn(null, () => { shoot(sam); shoot(sam); });
  assert.ok(Progress.has('iron_dome'));
});

test('driller and win_br read the Drill', () => {
  let G = begin();
  turn(null, () => { G.drill = { ownerId: 0 }; });
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('driller'));
  assert.ok(Progress.has('win_br'));
  G = begin();
  turn(null, () => { G.drill = { ownerId: 4 }; });
  turn(null, () => { G.winnerId = 0; });
  assert.ok(!Progress.has('driller'));
  assert.ok(Progress.has('win_br'));
});

test('mp_podium is settled when I fall, mp_champion when I win', () => {
  let G = begin({ humans: 8, bots: 0 }, false);
  turn(null, () => { for (let i = 3; i < 8; i++) kill(i, 1); });
  turn(null, () => kill(0, 1));
  assert.strictEqual(Progress.match.place, 3);
  assert.ok(Progress.has('mp_podium'));
  assert.ok(!Progress.has('mp_champion'));
  G = begin({ humans: 8, bots: 0 }, false);
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('mp_champion'));
  assert.ok(Progress.has('mp_podium'));
  assert.strictEqual(Progress.state.counters.wins, 1);
  G = begin({ humans: 7, bots: 1 }, false);
  turn(null, () => { G.winnerId = 0; });
  assert.ok(Progress.has('victory'));
  assert.ok(!Progress.has('mp_champion'));
});

test('the sim is never written', () => {
  const G = begin();
  const silo = structure('silo', 5);
  const frozen = (o) => { Object.freeze(o); return o; };
  frozen(silo.siloQueue);
  for (const p of G.players) frozen(p);
  frozen(G.alliances); frozen(G.boats); frozen(G.nukes); frozen(G.mirvs); frozen(G.samFlashes);
  const keys = Object.keys(G).sort().join();
  turn();
  turn();
  turn(null, () => { G.winnerId = 0; });
  assert.strictEqual(Object.keys(G).sort().join(), keys);
  assert.ok(Progress.has('victory'));
});

// --- Account sync ------------------------------------------------------------

// Stands in for the server's merge (server/accounts/routes.js).
function fakeAccount(userId, stored) {
  const acct = { stored: stored || Defs.empty(), posts: [] };
  global.Account = {
    available: true,
    user: userId ? { id: userId } : null,
    saveProgress(body) {
      acct.posts.push(JSON.parse(JSON.stringify(body)));
      const m = Defs.merge(acct.stored, Defs.sanitize(body));
      m.equipped = Defs.equippable(body.equipped ? Object.assign({}, m, { equipped: Defs.sanitize(body).equipped }) : Object.assign({}, m, { equipped: acct.stored.equipped }));
      acct.stored = m;
      return Promise.resolve({ unlocked: m.unlocked, counters: m.counters, equipped: m.equipped });
    }
  };
  return acct;
}
const settle = () => new Promise(r => setTimeout(r, 0));

test('sync: guest progress merges into the account on sign-in, account loadout wins', async () => {
  fresh({ unlocked: { pact: 500 }, counters: { wins: 2 } });
  const stored = Defs.sanitize({ unlocked: { pact: 100, sea_legs: 200 }, counters: { wins: 1 }, equipped: { emblem: 'emblem_anchor' } });
  const acct = fakeAccount(7, stored);
  Progress.accountChanged();
  await settle();
  assert.strictEqual(acct.posts[0].equipped, undefined);
  assert.deepStrictEqual(Progress.state.unlocked, { pact: 100, sea_legs: 200 });
  assert.strictEqual(Progress.state.counters.wins, 2);
  assert.strictEqual(Progress.state.equipped.emblem, 'emblem_anchor');
  assert.strictEqual(store.get(Progress.OWNER_KEY), '7');
  delete global.Account;
});

test('sync: an unlock while signed in is pushed', async () => {
  fresh();
  const acct = fakeAccount(7);
  Progress.accountChanged();
  await settle();
  Progress.unlock('pact');
  await settle();
  assert.ok(acct.stored.unlocked.pact > 0);
  delete global.Account;
});

test('sync: signing out clears the cache, and nothing is uploaded to the next account', async () => {
  fresh({ unlocked: { pact: 500 } });
  fakeAccount(7);
  Progress.accountChanged();
  await settle();
  global.Account.user = null;
  Progress.accountChanged();
  assert.deepStrictEqual(Progress.state.unlocked, {});
  assert.strictEqual(store.has(Progress.OWNER_KEY), false);
  const other = fakeAccount(8);
  Progress.accountChanged();
  await settle();
  assert.deepStrictEqual(other.stored.unlocked, {});
  delete global.Account;
});

test('sync: no account server leaves guest progress alone', () => {
  fresh({ unlocked: { pact: 500 } });
  global.Account = { available: false, user: null };
  Progress.accountChanged();
  assert.deepStrictEqual(Progress.state.unlocked, { pact: 500 });
  delete global.Account;
});

// --- Cosmetics ---------------------------------------------------------------

test('equip: only an unlocked cosmetic of the right type', () => {
  fresh({ unlocked: { sea_legs: 5 } });
  Progress.equip('emblem', 'emblem_crown');
  assert.strictEqual(Progress.state.equipped.emblem, null);
  Progress.equip('title', 'emblem_anchor');
  assert.strictEqual(Progress.state.equipped.title, null);
  Progress.equip('emblem', 'emblem_anchor');
  assert.strictEqual(Progress.state.equipped.emblem, 'emblem_anchor');
  Progress.equip('emblem', null);
  assert.strictEqual(Progress.state.equipped.emblem, null);
});

test('loadout: an equipped item that is not unlocked is left out', () => {
  fresh({ unlocked: {}, equipped: { title: 'title_admiral' } });
  assert.strictEqual(Progress.loadout().title, null);
});

test('cosmetics: read from the roster, own loadout in a local match', () => {
  fresh({ unlocked: { sea_legs: 5 }, equipped: { emblem: 'emblem_anchor' } });
  global.Game = { players: [], me: -1 };
  Progress.beginMatch({ info: { players: [{ playerId: 1, cosmetics: { title: 'title_veteran', emblem: 'nope' } }] }, myPlayerId: 0, singleplayer: true });
  assert.strictEqual(Progress.titleOf(1), 'Veteran');
  assert.strictEqual(Progress.emblemOf(1), '');
  assert.strictEqual(Progress.emblemOf(0), Defs.COSMETICS.emblem_anchor.glyph);
  assert.strictEqual(Progress.titleOf(2), '');
  Progress.beginMatch({ info: { players: [] }, myPlayerId: 0, singleplayer: false });
  assert.strictEqual(Progress.emblemOf(0), '');
});

test('wins: one multiplayer match counts once on this browser', () => {
  fresh();
  assert.strictEqual(Progress._firstWin('g1'), true);
  assert.strictEqual(Progress._firstWin('g1'), false);
  assert.strictEqual(Progress._firstWin('g2'), true);
  assert.strictEqual(Progress._firstWin(null), true);
  assert.strictEqual(Progress._firstWin(null), true);
});
