'use strict';
// Fog of war: how busy is a match? Runs bots-only matches headless and counts
// what the bots do, each seed once with fog off and once with fog on, so the
// two can be compared (docs/fog-of-war.md, task 9: "the mode must not feel
// empty"). Measurement only: it wraps sim methods to count calls and never
// changes what they return.
//   node tools/fog-activity.js [map=small|medium|large|world] [bots=8] [tribes=12] [ticks=6000]
//        [--seeds 12345,67890] [--teams N] [--difficulty easy|medium|hard] [--gold N]
//        [--only fog|nofog] [--every 1000] [--timeline] [--json] [--set SCOUT_LOSS_RADIUS=120,...]
// Both modes seat the one (idle) human on its reserve tile, so a pair of runs
// differs only in the fog setting. A match is chaotic: one seed says little,
// so compare the means over several.
const { fs, path, vm, root, loader } = require('./split-common');
const argv = process.argv.slice(2);
const VALUED = ['--seeds', '--teams', '--difficulty', '--gold', '--only', '--every', '--set'];
const flag = name => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (VALUED.includes(argv[i])) i++; continue; }
  positional.push(argv[i]);
}
const MAP = positional[0] || 'small';
const BOTS = positional[1] === undefined ? 8 : +positional[1], TRIBES = positional[2] === undefined ? 12 : +positional[2];
const TICKS = +positional[3] || 6000;
const SEEDS = String(opt('--seeds', '12345')).split(',').map(Number);
const TEAMS = +opt('--teams', 0), EVERY = +opt('--every', 1000), GOLD = +opt('--gold', 0);
const DIFFICULTY = opt('--difficulty', undefined), ONLY = opt('--only', null);
// --set NAME=value,NAME=value overrides AI tuning constants for the run (experiments).
const SETS = String(opt('--set', '')).split(',').filter(Boolean).map(kv => { const [k, v] = kv.split('='); return [k, JSON.parse(v)]; });

const names = loader();
const sources = names.slice(0, names.indexOf('ai') + 1).filter(n => !['render', 'input', 'ui', 'radial', 'main'].includes(n))
  .map(n => ({ file: `js/${n}.js`, text: fs.readFileSync(path.join(root, `js/${n}.js`), 'utf8') }));
let world = null;
if (MAP === 'world') {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'maps/world/manifest.json')));
  const b = fs.readFileSync(path.join(root, 'maps/world/map.bin'));
  world = { manifest: m.map, bytes: new Uint8Array(b.buffer, b.byteOffset, b.length) };
}

function run(seed, fog) {
  const ctx = vm.createContext({ console });
  for (const { file, text } of sources) vm.runInContext(text, ctx, { filename: file });
  const { Game, GameMap, Hash, AI } = vm.runInContext('({Game,GameMap,Hash,AI})', ctx);
  for (const [k, v] of SETS) AI[k] = v;
  const cfg = MAP === 'world' ? { map: 'world', seed, bots: BOTS, tribes: TRIBES } : { size: MAP, seed, bots: BOTS, tribes: TRIBES };
  if (fog) cfg.fogOfWar = true;
  if (TEAMS) { cfg.gameMode = 'team'; cfg.playerTeams = TEAMS; }
  if (DIFFICULTY) cfg.difficulty = DIFFICULTY;
  if (world) GameMap.worldData = world;

  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  // Fog matches seat the human in init; a fog-off one takes the same tile.
  if (!Game.fog && !Game.chooseSpawn(Game.humanReserveTiles[0])) throw new Error('the reserve tile is not a legal spawn');
  if (GOLD) for (const p of Game.players) if (p.isBot) p.gold += GOLD;

  const c = {
    invasions: 0, landings: 0, invasionChecks: 0, refusedUndiscovered: 0, refusedOther: 0,
    landAttacks: 0, allianceRequests: 0, alliances: 0, betrayals: 0, embargoes: 0, donations: 0,
    builds: 0, warships: 0, tradeShips: 0, trains: 0, nukes: 0, mirvs: 0, seaPathCalls: 0, seaPathSearches: 0,
    scoutsBought: 0, scoutOrders: 0, scoutsSunk: 0, scoutsLostWithNation: 0, scoutVoyagesOk: 0, scoutVoyagesFailed: 0,
    scoutRoutes: 0, scoutWaitTicks: 0, scoutLongestWait: 0
  };
  const count = (name, key, when) => {
    const original = Game[name];
    Game[name] = function (...args) {
      const r = original.apply(this, args);
      if (when ? when(r, args) : r) c[key]++;
      return r;
    };
  };
  count('launchNavalInvasion', 'invasions');
  count('resolveLanding', 'landings', () => true);
  count('requestAlliance', 'allianceRequests');
  count('acceptAlliance', 'alliances');
  count('breakAlliance', 'betrayals');
  count('launchAttack', 'landAttacks');
  count('build', 'builds');
  count('buildWarship', 'warships');
  count('spawnTrain', 'trains', () => true);
  count('launchNuke', 'nukes');
  count('launchMirv', 'mirvs');
  count('seaPath', 'seaPathCalls', () => true);
  count('buildScout', 'scoutsBought');
  count('moveScouts', 'scoutOrders');
  count('donateTroops', 'donations');
  count('donateGold', 'donations');
  const reason = Game.navalInvasionBlockReason;
  Game.navalInvasionBlockReason = function (...args) {
    const r = reason.apply(this, args);
    c.invasionChecks++;
    if (r === 'Undiscovered') c.refusedUndiscovered++; else if (r) c.refusedOther++;
    return r;
  };
  // A permanent embargo newly placed (the bots' own; attack embargoes are temporary).
  const add = Game.addEmbargo;
  Game.addEmbargo = function (from, to, temporary) {
    if (!temporary && !this.hasEmbargoAgainst(from, to)) c.embargoes++;
    return add.call(this, from, to, temporary);
  };

  // A voyage that ended with its beach discovered, or still black (AI.scoutThink).
  if (Game.fog && typeof AI.scoutThink === 'function') {
    const think = AI.scoutThink;
    AI.scoutThink = function (p, home) {
      const before = new Map();
      if (p.aiScout) for (const rec of p.aiScout.ships) before.set(rec.id, rec);
      const had = new Map([...before].map(([id, rec]) => [id, { tile: rec.tile, fails: rec.fails }]));
      const r = think.call(this, p, home);
      for (const [id, was] of had) {
        const rec = before.get(id);
        if (was.tile < 0 || !p.aiScout.ships.includes(rec) || rec.tile === was.tile) continue;
        if (rec.fails > was.fails) c.scoutVoyagesFailed++; else c.scoutVoyagesOk++;
      }
      return r;
    };
  }

  const nations = Game.players.filter(p => !p.isTribe);
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const timeline = [];
  const seenShips = new WeakSet(), waiting = new Map();
  let liveScouts = new Map();
  const sample = tick => {
    const alive = nations.filter(p => p.alive && p.tiles.size > 0);
    const top = Game.players.reduce((best, p) => (p.tiles.size > best.tiles.size ? p : best), Game.players[0]);
    const row = { tick, nations: alive.length, topPct: +(100 * top.tiles.size / (GameMap.landTiles - Game.fallout.size)).toFixed(1),
      invasions: c.invasions, tradeShips: c.tradeShips, ports: 0, warships: Game.warships.length };
    for (const b of Game.buildings.values()) if (b.type === 'port' && b.built) row.ports++;
    if (Game.fog) {
      const total = Game.visionCellsW * Game.visionCellsH;
      const pcts = alive.filter(p => p.isBot).map(p => 100 * Game.visionCount[Game.visionGroupOf[p.id]] / total);
      let pairs = 0, met = 0, mutual = 0;
      for (const a of alive) for (const b of alive) {
        if (a === b || Game.visionGroupOf[a.id] === Game.visionGroupOf[b.id]) continue;
        pairs++;
        if (Game.hasMet(a.id, b.id)) { met++; if (Game.hasMet(b.id, a.id)) mutual++; }
      }
      Object.assign(row, { seenMin: pcts.length ? +Math.min(...pcts).toFixed(1) : 0, seenMed: +median(pcts).toFixed(1), seenMax: pcts.length ? +Math.max(...pcts).toFixed(1) : 0,
        metPct: pairs ? +(100 * met / pairs).toFixed(1) : 100, mutualPct: pairs ? +(100 * mutual / pairs).toFixed(1) : 100, scouts: Game.scouts.length, scoutsBought: c.scoutsBought });
    }
    timeline.push(row);
  };

  const began = performance.now();
  let ended = null;
  for (let t = 1; t <= TICKS; t++) {
    Game.tick();
    c.seaPathSearches += Game._seaPathSearchesThisTick || 0;
    for (const s of Game.tradeShips) if (!seenShips.has(s)) { seenShips.add(s); c.tradeShips++; }
    if (Game.fog) {
      // How long a Scout that has been given an order stands still before its
      // route search finishes: its own search, plus its turn in the queue.
      const now = new Set();
      for (const s of Game.scouts) {
        now.add(s.id);
        if (s.routing && s.pos >= s.path.length - 1) {
          waiting.set(s.id, (waiting.get(s.id) || 0) + 1);
          c.scoutWaitTicks++;
        } else if (waiting.has(s.id)) {
          c.scoutLongestWait = Math.max(c.scoutLongestWait, waiting.get(s.id));
          c.scoutRoutes++;
          waiting.delete(s.id);
        }
      }
      for (const [id, owner] of liveScouts) {
        if (now.has(id)) continue;
        if (Game.players[owner].alive) c.scoutsSunk++; else c.scoutsLostWithNation++;
        waiting.delete(id);
      }
      liveScouts = new Map(Game.scouts.map(s => [s.id, s.owner]));
    }
    if (Game.ticks > 0 && Game.ticks % EVERY === 0 && (!timeline.length || timeline[timeline.length - 1].tick !== Game.ticks)) sample(Game.ticks);
    if (!Game.running && !Game.spawning) { ended = Game.ticks; break; }
  }
  if (!timeline.length || timeline[timeline.length - 1].tick !== Game.ticks) sample(Game.ticks);
  const last = timeline[timeline.length - 1];
  c.endTick = ended === null ? Game.ticks : ended;
  c.won = ended === null ? 0 : 1;
  c.nationsLeft = last.nations;
  c.topPct = last.topPct;
  if (Game.fog) {
    // What the bots' scouting made of the map (AI.scoutThink's own bookkeeping).
    const states = Game.players.filter(p => p.isBot && p.aiScout).map(p => p.aiScout);
    c.scoutBots = states.length;
    c.scoutBotsDone = states.filter(st => st.done).length;
    c.scoutsRetired = states.reduce((sum, st) => sum + st.ships.filter(rec => rec.fails >= AI.SCOUT_MAX_FAILS).length, 0);
    c.beachesWrittenOff = states.reduce((sum, st) => sum + st.tried.size, 0);
    c.seenMed = last.seenMed; c.seenMin = last.seenMin; c.seenMax = last.seenMax;
    c.metPct = last.metPct; c.mutualPct = last.mutualPct;
  }
  return { seed, fog: Game.fog, counts: c, timeline, landmasses: GameMap.landmasses.length, seconds: +((performance.now() - began) / 1000).toFixed(1), hash: Hash.compute() };
}

const results = [];
for (const seed of SEEDS) for (const fog of [false, true]) {
  if ((ONLY === 'fog' && !fog) || (ONLY === 'nofog' && fog)) continue;
  const r = run(seed, fog);
  results.push(r);
  if (!flag('--json')) console.error(`  seed ${seed} fog ${fog ? 'on ' : 'off'}: ${r.counts.endTick} ticks${r.counts.won ? ' (won)' : ''}, ${r.seconds}s, hash ${r.hash}`);
}
if (flag('--json')) console.log(JSON.stringify(results));
else {
  console.log(`${MAP}, ${BOTS} bots, ${TRIBES} tribes${TEAMS ? ', ' + TEAMS + ' teams' : ''}${DIFFICULTY ? ', ' + DIFFICULTY : ''}, up to ${TICKS} ticks, seeds ${SEEDS.join(', ')} (means over ${SEEDS.length}), ${results[0].landmasses} landmasses on the first`);
  const mean = (rows, key) => rows.length ? rows.reduce((s, r) => s + (r.counts[key] || 0), 0) / rows.length : NaN;
  const off = results.filter(r => !r.fog), on = results.filter(r => r.fog);
  const keys = Object.keys((on[0] || off[0]).counts);
  const table = {};
  for (const key of keys) {
    const a = mean(off, key), b = mean(on, key);
    table[key] = { fogOff: off.length && key in off[0].counts ? +a.toFixed(1) : '', fogOn: on.length ? +b.toFixed(1) : '',
      ratio: off.length && on.length && key in off[0].counts && a > 0 ? +(b / a).toFixed(2) : '' };
  }
  console.table(table);
  if (flag('--timeline')) for (const r of results) {
    console.log(`seed ${r.seed}, fog ${r.fog ? 'on' : 'off'}:`);
    console.table(r.timeline);
  }
}
