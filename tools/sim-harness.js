'use strict';
const crypto = require('node:crypto');
const { fs, path, vm, root, loader, stable } = require('./split-common');
const mode = process.argv[2];
if (!['record', 'compare', 'baseline', 'neutral', 'fog'].includes(mode)) throw new Error('Usage: node tools/sim-harness.js record|compare|baseline|neutral|fog [--perturb]');
const perturb = process.argv.includes('--perturb');
if (perturb && mode !== 'compare' && mode !== 'fog') throw new Error('--perturb is compare- and fog-only');
const methods = ['launchAttack', 'launchNavalInvasion', 'resolveLanding', 'annexRegion', 'acceptAlliance', 'breakAlliance', 'build', 'upgrade', 'spawnTrain', 'buildWarship', 'warshipShootAt', 'launchNuke', 'detonateNuke'];
const entities = ['tradeShips', 'shells', 'trains'];
const scenarios = ['small', 'medium'].flatMap(size => [12345, 67890].map(seed => ({ name: `${size}-${seed}`, size, seed, bots: 8, tribes: 12, ticks: 6000 })));
scenarios.push({ name: 'large-12345', size: 'large', seed: 12345, bots: 8, tribes: 12, ticks: 2000 });
// OpenFront's real, baked "World" map (js/map.js's loadWorld) rather than a
// procedural one — `size` is irrelevant here (see core.js's Game.init) but is
// still recorded on the scenario so a scenario-configuration change is caught
// the same way as any other.
scenarios.push({ name: 'world-12345', map: 'world', seed: 12345, bots: 8, tribes: 12, ticks: 2000 });
scenarios.push({ name: 'late-medium-24680', size: 'medium', seed: 24680, bots: 8, tribes: 12, ticks: 6000, gold: 100000000 });
// Nation difficulty tiers (Medium is every scenario above). The late-game pair
// carries the same bot treasury as late-medium so nuke behaviour shows up.
scenarios.push({ name: 'medium-easy-67890', size: 'medium', seed: 67890, bots: 8, tribes: 12, ticks: 6000, difficulty: 'easy' });
scenarios.push({ name: 'medium-hard-12345', size: 'medium', seed: 12345, bots: 8, tribes: 12, ticks: 6000, difficulty: 'hard' });
scenarios.push({ name: 'late-medium-easy-24680', size: 'medium', seed: 24680, bots: 8, tribes: 12, ticks: 6000, gold: 100000000, difficulty: 'easy' });
scenarios.push({ name: 'late-medium-hard-24680', size: 'medium', seed: 24680, bots: 8, tribes: 12, ticks: 6000, gold: 100000000, difficulty: 'hard' });
// Team mode (issue #31): 4 teams, long enough for Red to pass the team win
// share (~tick 2400), so assignment, teammate friendliness and checkTeamWin
// are all covered.
scenarios.push({ name: 'teams4-small-12345', size: 'small', seed: 12345, bots: 8, tribes: 12, ticks: 3000, gameMode: 'team', playerTeams: 4 });
// `neutral --only small-12345,teams4` runs just the scenarios whose name
// contains one of the given strings: a quick check while iterating. The full
// suite is still the bar before a task is called done.
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? String(process.argv[onlyAt + 1] || '').split(',').filter(Boolean) : null;
if (only && mode !== 'neutral' && mode !== 'fog') throw new Error('--only is neutral- and fog-only');
if (only && mode === 'neutral') {
  const kept = scenarios.filter(s => only.some(part => s.name.includes(part)));
  if (!kept.length) throw new Error(`--only matched no scenario: ${only.join(',')}`);
  scenarios.length = 0;
  scenarios.push(...kept);
}
// `baseline` / `neutral`: a behaviour-neutrality check for work that adds new
// sim state (so `compare`'s whole-state digest and Hash checkpoints can't
// match). `baseline` snapshots the current tree into tools/.neutral/
// (untracked); `neutral` reruns and requires the same map ownership, tick
// count, coverage and peaks, and the same value for every top-level Game
// field that existed at baseline. New top-level fields are ignored. A
// pre-existing field that is meant to differ (e.g. a new UNITS entry) goes in
// NEUTRAL_ALLOWED with a reason.
const neutralDir = path.join(root, 'tools/.neutral');
const NEUTRAL_ALLOWED = [
  'UNITS' // fog tasks 5 and 11: the table gained the Scout and Radio Tower entries, which a fog-off match can never buy
];
function keyDigests(Game) {
  const omitted = new Set(Game.COSMETIC_STATE);
  const keys = {};
  for (const key of Object.keys(Game).sort()) {
    if (omitted.has(key) || typeof Game[key] === 'function') continue;
    keys[key] = crypto.createHash('sha256').update(JSON.stringify(stable(Game[key]))).digest('hex');
  }
  return keys;
}
const neutralFailures = [];
function digest(Game, GameMap) {
  let fnv = 2166136261;
  for (const owner of GameMap.owner) {
    for (let shift = 0; shift < 32; shift += 8) fnv = Math.imul(fnv ^ ((owner >>> shift) & 255), 16777619) >>> 0;
  }
  const omitted = new Set(Game.COSMETIC_STATE);
  const state = {};
  for (const key of Object.keys(Game).sort()) {
    if (!omitted.has(key) && typeof Game[key] !== 'function') state[key] = Game[key];
  }
  return { ownerFNV: fnv, stateSHA256: crypto.createHash('sha256').update(JSON.stringify(stable(state))).digest('hex') };
}
const start = performance.now();
const names = loader();
// Hash and execute the same bytes, captured once for the entire suite.
const sources = names.slice(0, names.indexOf('ai') + 1)
  .filter(name => !['render', 'input', 'ui', 'radial', 'main'].includes(name))
  .map(name => {
    const file = path.posix.normalize(`js/${name}.js`);
    return { file, bytes: fs.readFileSync(path.join(root, file)) };
  });
const manifest = Object.fromEntries(sources.map(({ file, bytes }) =>
  [file, crypto.createHash('sha256').update(bytes).digest('hex')]));
function checkManifest(recorded, scenario) {
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) {
    throw new Error(`${scenario}: missing source manifest; record goldens before comparing`);
  }
  for (const file of new Set([...Object.keys(recorded), ...Object.keys(manifest)])) {
    // Game files are expected to change during extraction; parity checks them.
    if (file.startsWith('js/game/')) continue;
    if (recorded[file] !== manifest[file]) {
      throw new Error(`MANIFEST MISMATCH ${scenario}: ${file}: recorded ${recorded[file] ?? '(not loaded)'}, current ${manifest[file] ?? '(not loaded)'}`);
    }
  }
}
// A fresh VM context with the sim loaded into it, and the World map's bytes
// in place if the scenario asks for that map. Nothing is initialised yet.
function boot(cfg) {
  const ctx = vm.createContext({ console });
  // Fail immediately if simulation code starts consuming nondeterministic input.
  vm.runInContext('Math.random = () => { throw new Error("Math.random in simulation"); }; Date = class { constructor() { throw new Error("Date in simulation"); } static now() { throw new Error("Date.now in simulation"); } };', ctx);
  for (const { file, bytes } of sources) {
    vm.runInContext(bytes.toString('utf8'), ctx, { filename: file });
  }
  const sim = vm.runInContext('({ Game, GameMap, Hash, Executor, Protocol, AI })', ctx);
  if (cfg.map === 'world') {
    // No fetch() in this harness (nor in the sim it's checking, on purpose —
    // see js/net/worldmap.js) — read the same static asset a browser would
    // fetch directly off disk instead.
    const worldManifest = JSON.parse(fs.readFileSync(path.join(root, 'maps/world/manifest.json'), 'utf8'));
    const worldBytes = fs.readFileSync(path.join(root, 'maps/world/map.bin'));
    sim.GameMap.worldData = { manifest: worldManifest.map, bytes: new Uint8Array(worldBytes.buffer, worldBytes.byteOffset, worldBytes.length) };
  }
  return sim;
}
// --- `fog`: fog-of-war determinism, invariants and rules --------------------
// Fog-on matches have no goldens yet, so this mode checks them against
// themselves and against the rules in docs/fog-of-war.md:
//   - each scenario runs twice, in two fresh VM contexts, and must produce
//     the same Hash checkpoints and the same final whole-state digest. The
//     second run also calls the read-only vision API all over the map at
//     every checkpoint, which must change nothing;
//   - fogInvariants holds after the spawn, every 250 ticks and at the end, in
//     both runs, and the map is identical for both sides right after every
//     alliance the match forms;
//   - fogRules drives the rules directly: one-sided contact, alliance
//     sharing and its end, the attack, landing and nuke hooks;
//   - fogOff confirms a fog-off match allocates no vision state and never
//     reaches the code that would write it.
//   - fogBotWatch (task 9) rides along in every one of those runs: it fails
//     the run the moment a Nation acts on, or weighs, something the fog hides
//     from it, and counts what the bots' Scouts uncover. fogBotWatchControl
//     shows it can fail, and fogBotsOff that a fog-off match never reaches
//     any of the bots' fog code.
// `--perturb` flips one vision bit in each scenario's second run, which has to
// be reported as a divergence: the negative control. `--only` filters the
// scenarios by name and skips nothing else.
const fogScenarios = [
  { name: 'fog-small-12345', size: 'small', seed: 12345, bots: 8, tribes: 12, ticks: 6000, fogOfWar: true },
  { name: 'fog-medium-67890', size: 'medium', seed: 67890, bots: 8, tribes: 12, ticks: 6000, fogOfWar: true },
  { name: 'fog-teams4-small-12345', size: 'small', seed: 12345, bots: 8, tribes: 12, ticks: 3000, gameMode: 'team', playerTeams: 4, fogOfWar: true },
  // Rich bots, so nukes fly and their hits make contact.
  { name: 'fog-late-medium-24680', size: 'medium', seed: 24680, bots: 8, tribes: 12, ticks: 6000, gold: 100000000, fogOfWar: true },
  // 41 vision groups: bitmasks two words wide.
  { name: 'fog-crowded-small-12345', size: 'small', seed: 12345, bots: 40, tribes: 12, ticks: 2000, fogOfWar: true },
  // Easy Nations keep one Scout, not two (AI.PROFILES).
  { name: 'fog-easy-small-67890', size: 'small', seed: 67890, bots: 8, tribes: 12, ticks: 5000, difficulty: 'easy', fogOfWar: true }
];
const fogMethods = [...methods, 'markMet', 'visionStamp', 'visionAllianceFormed', 'visionRefreshShare'];
const fogHas = (arr, base, g) => (arr[base + (g >>> 5)] & (1 << (g & 31))) !== 0;

// Everything that must be true of the vision state at any moment. `prev` is
// what the last call returned (or null), for the "never shrinks" check.
function fogInvariants({ Game, GameMap }, prev, where) {
  const fail = msg => { throw new Error(`FOG INVARIANT ${where}: ${msg}`); };
  const C = Game.VISION_CELL, W = Game.visionWords, G = Game.visionGroups;
  const cw = Game.visionCellsW, ch = Game.visionCellsH;
  const cells = Game.visionCells, stamped = Game.visionStamped, met = Game.visionMet, groupOf = Game.visionGroupOf;
  const w = GameMap.width, owner = GameMap.owner;
  const name = id => `${id} (${Game.players[id].name})`;

  // Groups: none for a tribe, one each for everyone else (teammates share
  // through the share masks, not a common group).
  const seenGroups = new Set();
  for (const p of Game.players) {
    const g = groupOf[p.id];
    if (p.isTribe) { if (g !== -1) fail(`tribe ${name(p.id)} has vision group ${g}`); continue; }
    if (!(g >= 0 && g < G)) fail(`${name(p.id)} has no vision group`);
    if (seenGroups.has(g)) fail(`vision group ${g} is shared at ${name(p.id)}`);
    seenGroups.add(g);
  }

  // Every owned tile is discovered by its owner's group, and its owner has
  // been met by every group that has discovered the cell it is in.
  for (let t = 0; t < owner.length; t++) {
    const o = owner[t];
    if (o < 0) continue;
    const base = ((((t / w) | 0) / C | 0) * cw + ((t % w) / C | 0)) * W;
    const g = groupOf[o];
    if (g >= 0 && !(fogHas(cells, base, g) && fogHas(stamped, base, g) && Game.isDiscovered(o, t))) fail(`tile ${t} is not discovered by its owner ${name(o)}`);
    for (let k = 0; k < W; k++) if (cells[base + k] & ~met[o * W + k]) fail(`a group has discovered tile ${t} without meeting its owner ${name(o)}`);
  }

  // Border sight: a group that has held land in a cell has discovered the
  // whole disc around it, and so has every group it is allied with now. On
  // the same pass, visionCount is each group's discovered-cell count.
  const allies = Array.from({ length: G }, () => []);
  for (const al of Game.alliances) {
    const ga = groupOf[al.a], gb = groupOf[al.b];
    if (ga >= 0 && gb >= 0 && ga !== gb) { allies[ga].push(gb); allies[gb].push(ga); }
    if (!Game.hasMet(al.a, al.b) || !Game.hasMet(al.b, al.a)) fail(`allies ${name(al.a)} and ${name(al.b)} have not met`);
  }
  for (const a of Game.players) for (const b of Game.players) {
    const ga = groupOf[a.id], gb = groupOf[b.id];
    if (ga >= 0 && gb >= 0 && Game.onSameTeam(a.id, b.id) && !allies[ga].includes(gb)) allies[ga].push(gb);
  }
  const R = Game.VISION_SIGHT_BORDER, r2 = R * R + R;
  const counts = new Array(G).fill(0);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const base = (cy * cw + cx) * W;
    for (let g = 0; g < G; g++) {
      if (fogHas(cells, base, g)) counts[g]++;
      if (!fogHas(stamped, base, g)) continue;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx, y = cy + dy;
        if (dx * dx + dy * dy > r2 || x < 0 || y < 0 || x >= cw || y >= ch) continue;
        const at = (y * cw + x) * W;
        if (!fogHas(cells, at, g)) fail(`group ${g} holds land in cell ${cx},${cy} but has not discovered cell ${x},${y}`);
        for (const a of allies[g]) if (!fogHas(cells, at, a)) fail(`group ${a} is allied with group ${g} but has not discovered its cell ${x},${y}`);
      }
    }
  }
  for (let g = 0; g < G; g++) if (counts[g] !== Game.visionCount[g]) fail(`visionCount[${g}] is ${Game.visionCount[g]}, counted ${counts[g]}`);

  // Share masks are exactly the live alliances.
  for (let g = 0; g < G; g++) for (let o = 0; o < G; o++) {
    if (fogHas(Game.visionShare, g * W, o) !== (o === g || allies[g].includes(o))) fail(`share mask of group ${g} is wrong about group ${o}`);
  }

  // hasMet: self and teammates always, tribes are never gated, the rest is
  // the met bit.
  for (const a of Game.players) for (const b of Game.players) {
    const g = groupOf[a.id];
    const want = a.id === b.id || g < 0 || g === groupOf[b.id] || Game.onSameTeam(a.id, b.id) || fogHas(met, b.id * W, g);
    if (Game.hasMet(a.id, b.id) !== want) fail(`hasMet(${a.id}, ${b.id}) is ${!want}`);
  }

  // Discovery and contact are permanent.
  if (prev) {
    for (const key of ['visionCells', 'visionStamped', 'visionMet']) {
      const was = prev[key], now = Game[key];
      for (let i = 0; i < was.length; i++) if (was[i] & ~now[i]) fail(`${key} lost a bit at word ${i}`);
    }
  }
  return { visionCells: cells.slice(), visionStamped: stamped.slice(), visionMet: met.slice() };
}

// Read-only queries, all over the map. Run 2 makes these and run 1 does not.
function fogProbe({ Game, GameMap }) {
  const n = Game.players.length, tiles = GameMap.owner.length;
  for (let a = -1; a <= n; a++) {
    Game.visionGroup(a);
    for (let b = -1; b <= n; b++) Game.hasMet(a, b);
    for (let t = a; t < tiles; t += 997) { Game.isDiscovered(a, t); if (t >= 0) Game.visionCellOf(t); }
  }
}

function fogStats({ Game }) {
  const total = Game.visionCellsW * Game.visionCellsH;
  const pct = g => Math.round(100 * Game.visionCount[g] / total);
  const nations = Game.players.filter(p => !p.isTribe);
  let pairs = 0, metPairs = 0;
  for (const a of nations) for (const b of nations) if (a !== b) { pairs++; if (Game.hasMet(a.id, b.id)) metPairs++; }
  const all = Array.from(Game.visionCount, (_, g) => pct(g));
  const sorted = [...all].sort((a, b) => a - b);
  return { groups: Game.visionGroups, words: Game.visionWords, cells: total, humanDiscoveredPct: pct(Game.visionGroupOf[0]),
    minPct: Math.min(...all), medianPct: sorted[sorted.length >> 1], maxPct: Math.max(...all), metPairs: `${metPairs}/${pairs}` };
}

// --- fog bots (task 9): Nations are bound by the fog, and they scout ---------
// fogBotWatch wraps everything a Nation can do to another nation, and the AI
// helpers that weigh one, in a fog match. The checks are made on the call
// itself, before the sim's own gates (task 7) get a say, so a bot that merely
// asks for something the fog forbids fails the run even though the gate would
// have refused it. It reads and counts; it never changes what a call returns.
//   - a boat: the tile and its landing coast are discovered, the owner is met
//   - a nuke or MIRV: the target tile is discovered, its owner is met
//   - a warship order: discovered water
//   - an embargo, alliance request, donation or target mark: the nation is met
//   - AI.navalScore / provocation / similarlyStrong / nukeTarget /
//     retaliationTarget: never asked about a nation the bot has not met, and
//     never answer with a tile it has not discovered
//   - AI.borderTargets / hostiles: every nation they name is one the bot has
//     met (the rest of the AI leans on a land neighbour always being met)
//   - Scouts: never over the tier's cap, only ever ordered to an undiscovered
//     sample beach, never bought while one of the bot's own is standing idle
// `stats.scoutCells` is the number of vision cells the bots' Scouts were the
// first to show their owners: "their discovered area grows".
const fogBotCounters = ['boats', 'boatChecks', 'nukes', 'nukeAims', 'retaliationAims', 'warshipOrders', 'embargoes', 'allianceRequests',
  'strangerAnswers', 'donations', 'targetMarks', 'navalScores', 'provocations', 'neighbours', 'scoutsBought', 'scoutOrders', 'scoutCells'];
function fogBotWatch(sim, name) {
  const { Game, GameMap, AI } = sim;
  const stats = Object.fromEntries(fogBotCounters.map(k => [k, 0]));
  const fail = msg => { throw new Error(`FOG BOTS ${name}: ${msg}`); };
  const bot = id => { const p = Game.players[id]; return !!p && p.isBot; };
  const who = id => `${id} (${Game.players[id].name})`;
  const seen = (id, tile) => Game.isDiscovered(id, tile);
  const met = (id, other) => Game.hasMet(id, other);
  const xy = t => `${t % GameMap.width},${(t / GameMap.width) | 0}`;
  // `check(args)` runs before the call and may return a function to run on its result.
  const watch = (obj, method, check) => {
    const original = obj[method];
    if (typeof original !== 'function') throw new Error(`Missing method ${method}`);
    obj[method] = function (...args) {
      const after = check(args);
      const r = original.apply(this, args);
      if (after) after(r);
      return r;
    };
  };
  const ownerMet = (id, tile, what) => {
    const o = GameMap.owner[tile];
    if (o >= 0 && o !== id && !met(id, o)) fail(`${who(id)} ${what} ${xy(tile)}, land of ${who(o)}, whom it has not met`);
  };
  const atRest = s => s.pos >= s.path.length - 1;

  watch(Game, 'navalInvasionBlockReason', ([id]) => bot(id) && (r => { stats.boatChecks++; if (r === 'Undiscovered') fail(`${who(id)} asked for a boat the fog refuses`); }));
  watch(Game, 'launchNavalInvasion', ([id, tile]) => {
    if (!bot(id)) return null;
    const landing = Game.nearestOwnedCoast(tile);
    if (!seen(id, tile) || landing < 0 || !seen(id, landing)) fail(`${who(id)} sent a boat at ${xy(tile)}, which it has not discovered`);
    ownerMet(id, landing, 'sent a boat at');
    return r => { if (r) stats.boats++; };
  });
  for (const method of ['launchNuke', 'launchMirv']) {
    watch(Game, method, args => {
      const id = args[0], tile = args[args.length - 1];
      if (!bot(id)) return null;
      if (!seen(id, tile)) fail(`${who(id)} fired at ${xy(tile)}, which it has not discovered`);
      ownerMet(id, tile, 'fired at');
      return r => { if (r) stats.nukes++; };
    });
  }
  watch(Game, 'buildWarship', ([id, tile]) => {
    if (bot(id) && !seen(id, tile)) fail(`${who(id)} sent a new warship to ${xy(tile)}, which it has not discovered`);
    return r => { if (r && bot(id)) stats.warshipOrders++; };
  });
  watch(Game, 'moveWarships', ([, tile, id]) => {
    if (bot(id) && !seen(id, tile)) fail(`${who(id)} moved a warship to ${xy(tile)}, which it has not discovered`);
    return r => { if (r && bot(id)) stats.warshipOrders++; };
  });
  // Only a deliberate embargo is the bot's doing; an attack's temporary one is
  // the sim's (embargoOnAttack), placed on the attacker by its victim.
  watch(Game, 'addEmbargo', ([from, to, temporary]) => {
    if (temporary || !bot(from)) return null;
    if (!met(from, to)) fail(`${who(from)} embargoed ${who(to)}, whom it has not met`);
    if (!Game.hasEmbargoAgainst(from, to)) stats.embargoes++;
    return null;
  });
  for (const method of ['setEmbargo', 'requestAlliance', 'donateTroops', 'donateGold', 'targetPlayer']) {
    const key = { setEmbargo: 'embargoes', requestAlliance: 'allianceRequests', targetPlayer: 'targetMarks' }[method] || 'donations';
    watch(Game, method, ([from, to]) => {
      if (!bot(from)) return null;
      if (!met(from, to)) fail(`${who(from)} called ${method} on ${who(to)}, whom it has not met`);
      return r => { if (r) stats[key]++; };
    });
  }

  // The AI's own weighing of another nation.
  watch(AI, 'navalScore', ([p, targetId]) => {
    if (targetId >= 0) { stats.navalScores++; if (!met(p.id, targetId)) fail(`${who(p.id)} weighed a beach of ${who(targetId)}, whom it has not met`); }
    return null;
  });
  watch(AI, 'provocation', ([p, t]) => {
    stats.provocations++;
    if (!met(p.id, t.id)) fail(`${who(p.id)} weighed the cost of attacking ${who(t.id)}, whom it has not met`);
    return null;
  });
  watch(AI, 'similarlyStrong', ([p, other]) => {
    if (!met(p.id, other.id)) fail(`${who(p.id)} compared its strength with ${who(other.id)}, whom it has not met`);
    return null;
  });
  watch(AI, 'strangerDecision', () => { stats.strangerAnswers++; return null; });
  watch(AI, 'borderTargets', ([p]) => p.isBot && (r => {
    for (const id of r.keys()) {
      if (id < 0) continue;
      stats.neighbours++;
      if (!met(p.id, id)) fail(`${who(p.id)} borders ${who(id)} and has not met it`);
    }
  }));
  watch(AI, 'hostiles', ([p]) => (r => {
    for (const id of r) if (!met(p.id, id)) fail(`${who(p.id)} counts ${who(id)}, whom it has not met, as an enemy`);
  }));
  watch(AI, 'nukeTarget', ([target, p]) => {
    if (!met(p.id, target.id)) fail(`${who(p.id)} picked a nuke target in ${who(target.id)}, whom it has not met`);
    return r => {
      if (r < 0) return;
      stats.nukeAims++;
      if (!seen(p.id, r) || GameMap.owner[r] !== target.id) fail(`${who(p.id)} aimed a nuke at ${xy(r)}, which it has not discovered or is not ${who(target.id)}'s`);
    };
  });
  watch(AI, 'retaliationTarget', ([p, attackerId]) => {
    if (!met(p.id, attackerId)) fail(`${who(p.id)} aimed retaliation at ${who(attackerId)}, whom it has not met`);
    return r => {
      if (r < 0) return;
      stats.retaliationAims++;
      if (!seen(p.id, r)) fail(`${who(p.id)} aimed retaliation at ${xy(r)}, which it has not discovered`);
    };
  });

  // Scouts.
  const isBeach = tile => AI.fogCoast().beaches.some(list => list.includes(tile));
  watch(Game, 'buildScout', ([id]) => {
    if (!bot(id)) return null;
    // Buying is for when no Scout of its own is free to be sent instead.
    const st = Game.players[id].aiScout;
    for (const sc of Game.scouts) {
      if (sc.owner !== id || sc.routing || !atRest(sc)) continue;
      const rec = st && st.ships.find(x => x.id === sc.id);
      if (!rec || rec.fails < AI.SCOUT_MAX_FAILS) fail(`${who(id)} bought a Scout while its Scout ${sc.id} stood idle`);
    }
    return r => {
      if (!r) return;
      stats.scoutsBought++;
      if (Game.scoutCount(id) > AI.scoutCap()) fail(`${who(id)} has ${Game.scoutCount(id)} Scouts, over this tier's ${AI.scoutCap()}`);
    };
  });
  watch(Game, 'moveScouts', ([list, tile, id]) => {
    if (!bot(id)) return null;
    if (seen(id, tile) || !isBeach(tile)) fail(`${who(id)} sent a Scout to ${xy(tile)}, which is ${seen(id, tile) ? 'already discovered' : 'not a sample beach'}`);
    for (const sc of list) if (!atRest(sc)) fail(`${who(id)} redirected Scout ${sc.id} in the middle of a voyage`);
    return r => { if (r) stats.scoutOrders++; };
  });
  watch(Game, 'revealAround', ([id, , radius]) => {
    if (!bot(id) || radius !== Game.VISION_SIGHT_SCOUT) return null;
    const g = Game.visionGroupOf[id], had = Game.visionCount[g];
    return () => { stats.scoutCells += Game.visionCount[g] - had; };
  });
  return stats;
}

// What must be true of every Nation's scouting state (AI.scoutThink) at the
// end of a run. Called after the run's digest is taken: the last check may
// draw from Game.rng.
function fogBotScoutEnd(sim, name) {
  const { Game, AI } = sim;
  const fail = msg => { throw new Error(`FOG BOTS ${name}: ${msg}`); };
  const out = { scoutNations: 0, finished: 0, writtenOff: 0, afloat: 0, radioTowers: 0 };
  for (const p of Game.players) {
    // Radio Towers (task 11): only a Nation with no ocean shore buys them.
    const towers = Game.unitsBuilt(p, 'radio');
    if (towers > AI.RADIO_CAP) fail(`player ${p.id} built ${towers} Radio Towers`);
    out.radioTowers += towers;
    const st = p.aiScout;
    if (!st) continue;
    if (!p.isBot) fail(`player ${p.id}, not a Nation, has scouting state`);
    out.scoutNations++;
    out.writtenOff += st.tried.size;
    if (!p.alive) continue;
    if (st.ships.length > AI.scoutCap()) fail(`Nation ${p.id} tracks ${st.ships.length} Scouts`);
    for (const rec of st.ships) {
      const sc = Game.scoutById(rec.id);
      // A Scout sunk since the Nation last looked is still on its books.
      if (sc && sc.owner !== p.id) fail(`Nation ${p.id} tracks Scout ${rec.id}, which is not its own`);
      if (sc) out.afloat++;
    }
    if (st.done) {
      out.finished++;
      const retired = st.ships.filter(rec => rec.fails >= AI.SCOUT_MAX_FAILS).length;
      const gaveUp = st.ships.length >= AI.scoutCap() && retired === st.ships.length;
      if (!gaveUp && AI.scoutTarget(p, st.home, st, []) >= 0) fail(`Nation ${p.id} stopped scouting with a beach still to find`);
    }
  }
  return out;
}

// Negative control: each rule fogBotWatch enforces is broken on purpose, by a
// Nation, and has to be reported.
function fogBotWatchControl() {
  const cfg = { name: 'fog-bot-control', size: 'small', seed: 12345, bots: 8, tribes: 12, fogOfWar: true };
  const sim = boot(cfg);
  const { Game, GameMap, Hash, AI } = sim;
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  while (Game.spawning) Game.tick();
  fogBotWatch(sim, cfg.name);
  const nations = Game.players.filter(p => p.isBot && p.alive);
  let a = null, b = null;
  for (const x of nations) for (const y of nations) if (!a && x !== y && !Game.hasMet(x.id, y.id)) { a = x; b = y; }
  if (!a) throw new Error('FOG BOTS CONTROL: no two Nations that have not met');
  const theirs = b.tiles.values().next().value;
  let dark = -1, darkCoast = -1;
  for (let t = 0; t < GameMap.owner.length && (dark < 0 || darkCoast < 0); t++) {
    if (Game.isDiscovered(a.id, t)) continue;
    if (dark < 0) dark = t;
    if (darkCoast < 0 && GameMap.isLand(t) && GameMap.isCoastal(t)) darkCoast = t;
  }
  if (dark < 0 || darkCoast < 0 || Game.isDiscovered(a.id, theirs)) throw new Error('FOG BOTS CONTROL: nothing undiscovered to break the rules with');
  const mine = a.tiles.values().next().value;
  const breaches = {
    'a boat at an undiscovered coast': () => Game.launchNavalInvasion(a.id, darkCoast, 100),
    'a nuke at an undiscovered tile': () => Game.launchNuke(a.id, 'atombomb', dark),
    'a MIRV at an undiscovered tile': () => Game.launchMirv(a.id, dark),
    'a warship to undiscovered water': () => Game.buildWarship(a.id, dark),
    'an embargo on an unmet nation': () => Game.addEmbargo(a.id, b.id, false),
    'an alliance request to an unmet nation': () => Game.requestAlliance(a.id, b.id),
    'a donation to an unmet nation': () => Game.donateTroops(a.id, b.id, 10),
    'weighing an unmet nation\'s beach': () => AI.navalScore(a, b.id, 100, 10, new Set()),
    'weighing an attack on an unmet nation': () => AI.provocation(a, b, null, new Set()),
    'comparing strength with an unmet nation': () => AI.similarlyStrong(a, b),
    'a nuke target in an unmet nation': () => AI.nukeTarget(b, a),
    'an unmet nation counted as an enemy': () => { a.relations.set(b.id, -10); try { AI.hostiles(a, new Map([[b.id, 1]])); } finally { a.relations.delete(b.id); } },
    'a Scout sent to a discovered tile': () => Game.moveScouts([], mine, a.id)
  };
  for (const [what, breach] of Object.entries(breaches)) {
    let caught = false;
    try { breach(); } catch (err) { caught = /^FOG BOTS /.test(err.message); if (!caught) throw err; }
    if (!caught) throw new Error(`FOG BOTS CONTROL: ${what} was not reported`);
  }
  console.log(`fog-bots control: ${Object.keys(breaches).length} deliberate breaches by a Nation, every one reported: ok`);
}

// An alliance offer from a nation the bot has not met ("Unknown nation") is
// answered, either way, without the bot looking the sender up: fogBotWatch
// fails the run if it compares strengths with it.
function fogBotStrangerOffer() {
  const cfg = { name: 'fog-bot-stranger', size: 'small', seed: 12345, bots: 8, tribes: 12, fogOfWar: true };
  const sim = boot(cfg);
  const { Game, Hash, AI } = sim;
  const expect = (ok, msg) => { if (!ok) throw new Error(`FOG BOTS STRANGER: ${msg}`); };
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  while (Game.spawning) Game.tick();
  const stats = fogBotWatch(sim, cfg.name);
  const answers = { offers: 0, accepted: 0, declined: 0 };
  // Past the opening minutes, so the answer is not the early "yes to almost anyone".
  for (const elapsedTicks of [0, 2000]) {
    while (Game.ticks < elapsedTicks) Game.tick();
    for (const b of Game.players) {
      if (!b.isBot || !b.alive || !Game.players[0].alive || Game.hasMet(b.id, 0) || Game.areAllied(0, b.id)) continue;
      // The human has seen the bot; the bot has not seen the human.
      Game.markMet(0, b.id);
      Game.lastRequestAt.delete('0:' + b.id);
      expect(Game.requestAlliance(0, b.id) === true && Game.pendingRequest(0, b.id), `the offer to ${b.id} was not sent`);
      expect(!Game.hasMet(b.id, 0), 'receiving an offer made the bot meet its sender');
      answers.offers++;
      AI.handleRequests(b);
      expect(Game.pendingRequest(0, b.id) === null, `${b.id} left the offer unanswered`);
      if (Game.areAllied(0, b.id)) { answers.accepted++; expect(Game.hasMet(b.id, 0), 'accepting did not make the bot meet its new ally'); }
      else { answers.declined++; expect(!Game.hasMet(b.id, 0), 'declining made the bot meet the sender'); }
    }
  }
  expect(answers.offers > 0 && stats.strangerAnswers > 0, 'no offer from an unmet nation was answered as one');
  expect(answers.accepted > 0 && answers.declined > 0, `the answers were all one way: ${JSON.stringify(answers)}`);
  console.log(`fog-bots stranger: ${answers.offers} offers from an unmet nation, ${answers.accepted} accepted, ${answers.declined} declined, ${stats.strangerAnswers} decided blind, none by looking the sender up: ok`);
}

// A fog-off match never reaches the bots' fog code, and leaves none of its
// state behind.
function fogBotsOff() {
  const cfg = { name: 'fog-off-bots-small-12345', size: 'small', seed: 12345, bots: 8, tribes: 12, ticks: 6000 };
  const { Game, Hash, AI } = boot(cfg);
  const fail = msg => { throw new Error(`FOG OFF BOTS: ${msg}`); };
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  if (!Game.chooseSpawn(Hash.firstLegalSpawn())) fail('no legal human spawn');
  for (const name of ['fogCoast', 'fogCoastStep', 'scoutThink', 'scoutPoll', 'scoutTarget', 'scoutWriteOff', 'buyScout', 'scoutLaunchWater', 'scoutCap', 'strangerDecision', 'buyRadio', 'radioSite', 'hasOceanCoast']) {
    if (typeof AI[name] !== 'function') fail(`AI.${name} is missing`);
    AI[name] = () => fail(`AI.${name} was reached in a fog-off match`);
  }
  let thinks = 0;
  const naval = AI.navalThink, decide = AI.allianceDecision, economy = AI.economy;
  AI.navalThink = function (...args) { thinks++; return naval.apply(this, args); };
  AI.economy = function (...args) { thinks++; return economy.apply(this, args); };
  AI.allianceDecision = function (...args) { thinks++; return decide.apply(this, args); };
  for (let tick = 1; tick <= cfg.ticks; tick++) Game.tick();
  if (!thinks) fail('the bots never thought, so nothing was tested');
  if (AI._fogCoast !== null) fail('the beach table was built');
  for (const p of Game.players) if ('aiScout' in p) fail(`player ${p.id} carries scouting state`);
  console.log(`fog-off-bots: none of the bots' fog code reached in ${cfg.ticks} ticks (${thinks} bot decisions), no beach table, no scouting state: ok`);
}

function fogRun(cfg, second) {
  const sim = boot(cfg);
  const { Game, GameMap, Hash } = sim;
  const coverage = Object.fromEntries(fogMethods.map(k => [k, 0]));
  for (const name of fogMethods) {
    const original = Game[name];
    if (typeof original !== 'function') throw new Error(`Missing method ${name}`);
    Game[name] = function (...args) { coverage[name]++; return original.apply(this, args); };
  }
  const bots = fogBotWatch(sim, cfg.name);
  // Right after an alliance forms the two sides have met and each holds what the other saw itself.
  const accept = Game.acceptAlliance;
  Game.acceptAlliance = function (req) {
    const ok = accept.call(this, req);
    if (!ok) return ok;
    const ga = this.visionGroupOf[req.from], gb = this.visionGroupOf[req.to];
    if (!this.hasMet(req.from, req.to) || !this.hasMet(req.to, req.from)) throw new Error(`FOG INVARIANT ${cfg.name}: new allies ${req.from} and ${req.to} have not met`);
    for (let base = 0; base < this.visionCells.length; base += this.visionWords) {
      if (fogHas(this.visionOwn, base, ga) && !fogHas(this.visionCells, base, gb)) throw new Error(`FOG INVARIANT ${cfg.name}: new ally ${req.to} lacks a cell ${req.from} saw itself`);
      if (fogHas(this.visionOwn, base, gb) && !fogHas(this.visionCells, base, ga)) throw new Error(`FOG INVARIANT ${cfg.name}: new ally ${req.from} lacks a cell ${req.to} saw itself`);
    }
    return ok;
  };
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  if (Game.fog !== true) throw new Error(`${cfg.name}: fog is not on`);
  // Fog matches place every human themselves; nobody picks (fogSpawnChecks).
  if (Game.players[0].tiles.size === 0) throw new Error(`${cfg.name}: the human has no spawn after init`);
  if (cfg.gold) for (const p of Game.players) if (p.isBot) p.gold += cfg.gold;
  const tampered = second && perturb;
  let prev = fogInvariants(sim, null, `${cfg.name} after spawn`);
  const checkpoints = [];
  for (let tick = 1; tick <= cfg.ticks; tick++) {
    Game.tick();
    if (tampered && tick === 500) Game.visionMet[Game.visionMet.length - 1] ^= 1;
    if (tick % 50 === 0) {
      if (second) fogProbe(sim);
      checkpoints.push({ tick, hash: Hash.compute() });
    }
    if (!tampered && (tick % 250 === 0 || tick === cfg.ticks)) prev = fogInvariants(sim, prev, `${cfg.name} tick ${tick}`);
  }
  const result = { checkpoints, digest: digest(Game, GameMap), simulationTicks: Game.ticks, coverage, stats: fogStats(sim), bots: { ...bots } };
  // After the digest: this check may draw from Game.rng.
  if (!tampered) result.scouting = fogBotScoutEnd(sim, cfg.name);
  return result;
}

function fogRules() {
  const cfg = { name: 'fog-rules', size: 'small', seed: 12345, bots: 8, tribes: 12, fogOfWar: true };
  const sim = boot(cfg);
  const { Game, GameMap, Hash } = sim;
  const expect = (ok, msg) => { if (!ok) throw new Error(`FOG RULES: ${msg}`); };
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  expect(Game.players[0].tiles.size > 0, 'the human has no spawn after init');
  while (Game.spawning) Game.tick();
  fogInvariants(sim, null, 'fog-rules after the spawn phase');

  const nations = () => Game.players.filter(p => !p.isTribe && p.alive && p.tiles.size > 0).map(p => p.id);
  // Two nations, neither of which has met the other.
  const strangers = () => {
    const ids = nations();
    for (const a of ids) for (const b of ids) {
      if (a < b && !Game.hasMet(a, b) && !Game.hasMet(b, a) && !Game.areAllied(a, b)) return [a, b];
    }
    throw new Error('FOG RULES: no two nations that have not met');
  };
  const count = id => Game.visionCount[Game.visionGroupOf[id]];
  const firstTile = id => Game.players[id].tiles.values().next().value;
  const undiscovered = (...ids) => {
    for (let t = 0; t < GameMap.owner.length; t++) if (ids.every(id => !Game.isDiscovered(id, t))) return t;
    throw new Error('FOG RULES: nothing left undiscovered');
  };
  const calls = [];
  const markMet = Game.markMet;
  Game.markMet = function (observer, subject) { calls.push(`${observer}>${subject}`); return markMet.call(this, observer, subject); };

  // Contact is one-sided and reveals nothing.
  const [a, b] = strangers();
  let before = count(a);
  Game.markMet(a, b);
  expect(Game.hasMet(a, b) && !Game.hasMet(b, a), 'markMet is not one-sided');
  expect(count(a) === before, 'markMet revealed something');

  // A nuke hit tells the victim who launched it, and nothing else.
  const [e, f] = strangers();
  const sum = () => Game.visionCount.reduce((s, v) => s + v, 0);
  before = sum();
  calls.length = 0;
  Game.detonateNuke({ ownerId: f, nukeType: 'atombomb', dst: firstTile(e) });
  expect(calls.includes(`${e}>${f}`) && Game.hasMet(e, f), 'a nuke hit did not make the victim meet the launcher');
  expect(!Game.hasMet(f, e), 'a nuke hit made the launcher meet the victim');
  expect(sum() === before, 'a nuke revealed something');

  // An alliance: both sides meet, and each gets the other's map.
  const [c, d] = strangers();
  calls.length = 0;
  expect(Game.acceptAlliance({ from: c, to: d }) === true, 'alliance refused');
  expect(calls.includes(`${c}>${d}`) && calls.includes(`${d}>${c}`) && Game.hasMet(c, d) && Game.hasMet(d, c), 'new allies have not met');
  expect(Game.isDiscovered(c, firstTile(d)) && Game.isDiscovered(d, firstTile(c)), 'new allies cannot see each other');
  expect(count(c) === count(d), 'new allies hold different maps');
  // While it lasts, what one reveals the other sees; nobody else does.
  const t1 = undiscovered(...nations());
  const bystander = nations().find(id => id !== c && id !== d && !Game.areAllied(id, c) && !Game.areAllied(id, d));
  // The disc reaches VISION_SIGHT_SCOUT cells along the row and no further.
  const reach = t1 + Game.VISION_SIGHT_SCOUT * Game.VISION_CELL, beyond = reach + Game.VISION_CELL;
  const sameRow = (beyond % GameMap.width) > (t1 % GameMap.width);
  const beyondBefore = Game.isDiscovered(c, beyond);
  Game.revealAround(c, t1, Game.VISION_SIGHT_SCOUT);
  expect(Game.isDiscovered(c, t1) && Game.isDiscovered(d, t1), 'a reveal did not reach the ally');
  expect(!Game.isDiscovered(bystander, t1), 'a reveal reached a bystander');
  if (sameRow) expect(Game.isDiscovered(c, reach) && Game.isDiscovered(c, beyond) === beyondBefore, 'a reveal is not the radius it was asked for');
  // When it ends, sharing stops and both keep what they have.
  Game.removeAlliance(Game.allianceBetween(c, d));
  const t2 = undiscovered(c, d);
  Game.revealAround(c, t2, Game.VISION_SIGHT_SCOUT);
  expect(Game.isDiscovered(c, t2) && !Game.isDiscovered(d, t2), 'a reveal reached a former ally');
  expect(Game.isDiscovered(d, t1) && Game.hasMet(c, d) && Game.hasMet(d, c), 'a former ally lost what it had');

  // Tribes have no vision group and are never gated; off-map ids are safe.
  const tribe = Game.players.find(p => p.isTribe).id;
  before = sum();
  Game.revealAround(tribe, t2, Game.VISION_SIGHT_RADIO);
  Game.markMet(tribe, a);
  expect(sum() === before, 'a tribe revealed something');
  expect(Game.visionGroup(tribe) === -1 && Game.isDiscovered(tribe, undiscovered(a)) && Game.hasMet(tribe, a), 'a tribe is gated');
  expect(!Game.hasMet(a, -1) && !Game.hasMet(-1, a) && !Game.hasMet(a, NaN) && !Game.isDiscovered(a, -1) && !Game.isDiscovered(a, GameMap.owner.length), 'an off-map id was answered yes');
  expect(Game.hasMet(a, a) && Game.visionGroup(-1) === -1 && Game.visionGroup(Game.players.length) === -1, 'self or off-map ids are wrong');
  before = sum();
  Game.revealAround(a, NaN, Game.VISION_SIGHT_RADIO);
  Game.revealAround(a, -1, Game.VISION_SIGHT_RADIO);
  Game.revealAround(undefined, t2, Game.VISION_SIGHT_RADIO);
  Game.markMet(a, undefined);
  expect(sum() === before && Game.visionGroup(undefined) === -1 && !Game.hasMet(undefined, undefined) && !Game.isDiscovered(a, NaN), 'a missing id or tile was acted on');

  // A land attack and a boat landing each tell the target who it was. Wait
  // for two nations to share a border with no front open between them yet.
  const nb = new Int32Array(4);
  const neighbours = () => {
    for (const x of nations()) for (const tile of Game.players[x].borderTiles) {
      const n = GameMap.neighbors(tile, nb);
      for (let k = 0; k < n; k++) {
        const y = GameMap.owner[nb[k]];
        if (y < 0 || y === x || Game.areAllied(x, y) || Game.players[x].troops < 40) continue;
        if (!Game.attacks.some(at => at.attacker === x && at.target === y)) return [x, y];
      }
    }
    return null;
  };
  let pair = neighbours();
  for (let t = 0; !pair && t < 3000; t++) { Game.tick(); pair = neighbours(); }
  expect(pair, 'no two bordering nations to attack with');
  const [x, y] = pair;
  calls.length = 0;
  expect(Game.launchAttack(x, y, 20) === true, 'attack refused');
  expect(calls.includes(`${y}>${x}`) && !calls.includes(`${x}>${y}`), 'a land attack did not make the target meet the attacker');
  calls.length = 0;
  Game.resolveLanding({ id: 0, attacker: y, target: x, troops: 100, path: [], pos: 0, landingTile: firstTile(x) });
  expect(calls.includes(`${x}>${y}`) && !calls.includes(`${y}>${x}`), 'a boat landing did not make the target meet the attacker');

  fogInvariants(sim, null, 'fog-rules end');
  console.log('fog-rules: one-sided contact, nuke hit, alliance sharing and its end, tribes, land attack, boat landing: ok');
}

// --- Fixed fog spawns (docs/fog-of-war.md, task 3) --------------------------
// Everything for the spawn rules lives in the fogSpawn* functions below, so it
// merges cleanly with the other fog checks in this mode.
const FOG_SPAWN_TURNS = 50;
// A tile findSpawns' own rules would let a human pick: neutral land with enough
// land around it. Fog matches must refuse it anyway.
function fogSpawnPickable({ Game, GameMap }) {
  const w = GameMap.width;
  for (let t = 0; t < GameMap.owner.length; t++) {
    if (GameMap.isLand(t) && GameMap.owner[t] === -1 && GameMap.landAround(t % w, (t / w) | 0, 5) >= 90) return t;
  }
  return -1;
}
// Every cell a group has border sight over, worked out independently of
// vision.js from the tiles its members own right now.
function fogSpawnExpectedCells({ Game, GameMap }) {
  const C = Game.VISION_CELL, cw = Game.visionCellsW, ch = Game.visionCellsH, w = GameMap.width;
  const R = Game.VISION_SIGHT_BORDER, r2 = R * R + R;
  const want = Array.from({ length: Game.visionGroups }, () => new Uint8Array(cw * ch));
  for (const p of Game.players) {
    const g = Game.visionGroupOf[p.id];
    if (g < 0) continue;
    for (const t of p.tiles) {
      const cx = ((t % w) / C) | 0, cy = (((t / w) | 0) / C) | 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx, y = cy + dy;
        if (dx * dx + dy * dy <= r2 && x >= 0 && y >= 0 && x < cw && y < ch) {
          want[g][y * cw + x] = 1;
          // Teammates share each other's sight.
          for (const q of Game.players) if (Game.onSameTeam(p.id, q.id)) want[Game.visionGroupOf[q.id]][y * cw + x] = 1;
        }
      }
    }
  }
  return want;
}
function fogSpawnSameOwners(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// Run the countdown, returning how many turns it took and a Hash every 10.
function fogSpawnCountdown({ Game, Hash }) {
  const hashes = [Hash.compute()];
  let turns = 0;
  while (Game.spawning) {
    Game.tick();
    turns++;
    if (turns % 10 === 0) hashes.push(Hash.compute());
    if (turns > 1000) throw new Error('FOG SPAWN: the countdown never ended');
  }
  return { turns, hashes };
}
// One scenario's spawn rules, plus the same match with fog off as a reference.
function fogSpawnChecks(cfg) {
  const fail = msg => { throw new Error(`FOG SPAWN ${cfg.name}: ${msg}`); };
  const run = () => {
    const sim = boot(cfg);
    sim.Game.init(sim.Hash._syntheticGameStartInfo(cfg), 0);
    return sim;
  };
  const sim = run(), { Game, GameMap, Hash, Executor } = sim;
  if (!Game.fog) fail('fog is not on');

  // The human is on land before the first turn, on the reserve tile.
  const reserve = Game.humanReserveTiles[0];
  if (!(Game.players[0].tiles.size > 0 && GameMap.owner[reserve] === 0)) fail('the human does not own their reserve tile right after init');
  if (!Game.spawning || Game.spawnPhaseTicks !== 0) fail('the countdown has not started');
  if (Game.SPAWN_PHASE_TURNS !== FOG_SPAWN_TURNS) fail(`SPAWN_PHASE_TURNS is ${Game.SPAWN_PHASE_TURNS}`);

  // A spawn is refused, by the sim and through the executor, and changes nothing.
  const pick = fogSpawnPickable(sim);
  if (pick < 0) fail('no tile a human could have picked');
  const reason = Game.spawnBlockReason(pick);
  if (typeof reason !== 'string' || !reason) fail('spawnBlockReason does not refuse a spawn');
  Executor.setRoster([{ clientID: 'harness', playerId: 0 }]);
  const before = GameMap.owner.slice(), mine = Game.players[0].tiles.size;
  if (Game.chooseSpawn(pick, 0) !== false) fail('chooseSpawn accepted a spawn');
  if (Executor.apply({ type: 'spawn', tile: pick, clientID: 'harness' }) !== false) fail('the executor applied a spawn intent');
  if (!fogSpawnSameOwners(before, GameMap.owner) || Game.players[0].tiles.size !== mine || !Game.spawning) fail('a refused spawn changed something');
  // The same tile is a legal pick with fog off, so it is fog that refuses it.
  const offCfg = { ...cfg, fogOfWar: false };
  const off = boot(offCfg);
  off.Game.init(off.Hash._syntheticGameStartInfo(offCfg), 0);
  if (off.Game.spawnBlockReason(pick) !== null) fail(`tile ${pick} is not a legal pick with fog off, so the refusal proves nothing`);

  // Team seating and the spawn tiles are what a fog-off match deals.
  const seats = g => JSON.stringify({ teams: g.teams || null, team: g.players.map(p => p.team === undefined ? null : p.team), reserve: g.humanReserveTiles });
  if (seats(Game) !== seats(off.Game)) fail('teams or reserve tiles differ from the fog-off match');

  // The countdown: 5 s, and nobody's land moves during it.
  const start = GameMap.owner.slice();
  const first = fogSpawnCountdown(sim);
  if (first.turns !== FOG_SPAWN_TURNS) fail(`the countdown lasted ${first.turns} turns, not ${FOG_SPAWN_TURNS}`);
  if (!fogSpawnSameOwners(start, GameMap.owner)) fail('territory changed during the countdown');
  if (Game.spawning || !Game.running) fail('the countdown did not hand over to the match');

  // Discovered area is exactly border sight around where everyone stands: no trail.
  const want = fogSpawnExpectedCells(sim), W = Game.visionWords;
  for (let g = 0; g < Game.visionGroups; g++) {
    let n = 0;
    for (let cell = 0; cell < want[g].length; cell++) {
      const has = fogHas(Game.visionCells, cell * W, g);
      if (has !== (want[g][cell] === 1)) fail(`group ${g} cell ${cell}: discovered ${has}, border sight says ${want[g][cell] === 1}`);
      n += want[g][cell];
    }
    if (n !== Game.visionCount[g]) fail(`visionCount[${g}] is ${Game.visionCount[g]}, border sight is ${n} cells`);
  }
  fogInvariants(sim, null, `${cfg.name} after the fixed-spawn countdown`);

  // A second, fresh run agrees turn for turn.
  const again = run(), second = fogSpawnCountdown(again);
  if (JSON.stringify(first.hashes) !== JSON.stringify(second.hashes)) fail('two runs of the countdown hash differently');
  if (JSON.stringify(digest(Game, GameMap)) !== JSON.stringify(digest(again.Game, again.GameMap))) fail('two runs end the countdown in different states');
  console.log(`fog-spawn ${cfg.name}: human placed in init, spawn refused (${JSON.stringify(reason)}), ${first.turns}-turn countdown with no territory moved, discovery is exactly border sight, 2 runs identical: ok`);
}
// Negative control: with fog off the same countdown does move bots, so the
// "no territory moved" check above is capable of failing.
function fogSpawnControl() {
  const cfg = { name: 'fog-spawn-control', size: 'small', seed: 12345, bots: 8, tribes: 12 };
  const { Game, GameMap, Hash } = boot(cfg);
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  const start = GameMap.owner.slice();
  const { turns } = fogSpawnCountdown({ Game, Hash });
  if (turns !== 100) throw new Error(`FOG SPAWN CONTROL: a fog-off single-human countdown is ${turns} turns, not 100`);
  if (fogSpawnSameOwners(start, GameMap.owner)) throw new Error('FOG SPAWN CONTROL: bots did not move during a fog-off countdown, so the fog check proves nothing');
  console.log('fog-spawn control: fog off, 100-turn countdown, bots wobble their spawn: ok');
}
// Several humans: each is seated on their own reserve tile and the countdown
// ends without moving anyone. Run as a free-for-all and as a clan team game.
function fogSpawnMultiHuman() {
  const names = ['[AB] One', 'Two', '[AB] Three', '[CD] Four'];
  const players = names.map((username, playerId) => ({ clientID: 'c' + playerId, username, playerId }));
  const base = { gameID: 'fog-spawn', seed: 12345, players };
  const configs = [
    { name: 'ffa', config: { mapSize: 'small', bots: 8, tribes: 12 } },
    { name: 'teams', config: { mapSize: 'small', bots: 8, tribes: 12, gameMode: 'team', playerTeams: 3 } }
  ];
  for (const { name, config } of configs) {
    const fail = msg => { throw new Error(`FOG SPAWN multi-human ${name}: ${msg}`); };
    const run = fogOfWar => {
      const sim = boot({ size: 'small' });
      sim.Game.init({ ...base, config: { ...config, fogOfWar } }, 2);
      return sim;
    };
    const sim = run(true), { Game, GameMap, Executor } = sim;
    const reserve = Game.humanReserveTiles;
    if (reserve.length !== players.length || new Set(reserve).size !== players.length) fail('the reserve tiles are not distinct');
    const sizes = [];
    for (let p = 0; p < players.length; p++) {
      if (GameMap.owner[reserve[p]] !== p) fail(`human ${p} does not own their reserve tile ${reserve[p]} right after init`);
      sizes.push(Game.players[p].tiles.size);
    }
    if (sizes.some(n => n === 0)) fail(`a human has no land: ${sizes}`);
    if (Game.SPAWN_PHASE_TURNS !== FOG_SPAWN_TURNS) fail(`SPAWN_PHASE_TURNS is ${Game.SPAWN_PHASE_TURNS} with several humans`);
    Executor.setRoster(players);
    const pick = fogSpawnPickable(sim), before = GameMap.owner.slice();
    for (const { clientID } of players) {
      if (Executor.apply({ type: 'spawn', tile: pick, clientID }) !== false) fail(`the executor applied a spawn intent from ${clientID}`);
    }
    if (!fogSpawnSameOwners(before, GameMap.owner)) fail('refused spawns changed something');
    const { turns } = fogSpawnCountdown(sim);
    if (turns !== FOG_SPAWN_TURNS) fail(`the countdown lasted ${turns} turns`);
    if (!fogSpawnSameOwners(before, GameMap.owner)) fail('territory changed during the countdown');
    fogInvariants(sim, null, `fog-spawn multi-human ${name}`);
    if (Game.teams) {
      // Clans are seated together, exactly as in a fog-off match.
      const off = run(false);
      const seats = g => JSON.stringify(g.players.map(p => p.team === undefined ? null : p.team));
      if (seats(Game) !== seats(off.Game)) fail('teams differ from the fog-off match');
      if (Game.players[0].team !== Game.players[2].team) fail('the [AB] clan was not seated together');
    }
    console.log(`fog-spawn multi-human ${name}: ${players.length} humans on distinct reserve tiles (${sizes.join('/')} tiles), spawns refused, ${turns}-turn countdown, nobody moved: ok`);
  }
}

function fogOff() {
  // Long enough for the first nukes, and the alliance one of them breaks
  // (about tick 6400 in this match): the coverage check below needs both.
  const cfg = { name: 'fog-off-small-12345', size: 'small', seed: 12345, bots: 8, tribes: 12, ticks: 9000 };
  const { Game, Hash } = boot(cfg);
  const check = where => {
    for (const key of ['visionGroupOf', 'visionCells', 'visionStamped', 'visionShare', 'visionMet', 'visionCount']) {
      if (Game[key] !== null) throw new Error(`FOG OFF ${where}: Game.${key} is allocated`);
    }
    for (const key of ['visionCellsW', 'visionCellsH', 'visionGroups', 'visionWords']) {
      if (Game[key] !== 0) throw new Error(`FOG OFF ${where}: Game.${key} is ${Game[key]}`);
    }
    if (Game.fog !== false || Game.isDiscovered(0, 0) !== true || Game.hasMet(0, 1) !== true || Game.visionGroup(0) !== -1) {
      throw new Error(`FOG OFF ${where}: the vision API is gating a fog-off match`);
    }
  };
  // A fog-on match first, so the fog-off one after it has something to clear.
  Game.init(Hash._syntheticGameStartInfo({ ...cfg, fogOfWar: true }), 0);
  if (!Game.visionCells) throw new Error('FOG OFF: the fog-on match allocated nothing');
  // Only exactly `true` turns fog on.
  for (const value of [false, 1, 'true', undefined]) {
    Game.init(Hash._syntheticGameStartInfo({ ...cfg, fogOfWar: value }), 0);
    check(`init with fogOfWar ${value}`);
  }
  // The public mutators are safe to call and do nothing.
  Game.revealAround(0, 0, 3);
  Game.markMet(0, 1);
  // Everything in vision.js that writes. A fog-off match must not get here.
  for (const name of ['visionTileGained', 'visionStamp', 'visionMeetCell', 'visionRefreshShare', 'visionAllianceFormed', 'markMet', 'revealAround']) {
    Game[name] = () => { throw new Error(`FOG OFF: ${name} was reached in a fog-off match`); };
  }
  const coverage = { launchAttack: 0, resolveLanding: 0, acceptAlliance: 0, breakAlliance: 0, detonateNuke: 0 };
  for (const name of Object.keys(coverage)) {
    const original = Game[name];
    Game[name] = function (...args) { coverage[name]++; return original.apply(this, args); };
  }
  if (!Game.chooseSpawn(Hash.firstLegalSpawn())) throw new Error('FOG OFF: no legal human spawn');
  for (let tick = 1; tick <= cfg.ticks; tick++) Game.tick();
  check(`after ${cfg.ticks} ticks`);
  const unused = Object.keys(coverage).filter(name => coverage[name] === 0);
  if (unused.length) throw new Error(`FOG OFF: hooks not exercised: ${unused.join(', ')}`);
  console.log(`fog-off: nothing allocated, no vision code reached in ${cfg.ticks} ticks (${JSON.stringify(coverage)}): ok`);
}

// --- `fog`: Scouts and warship sight (fog task 5) ---------------------------
// Bots do not buy Scouts, so this drives them itself, through the Executor:
// four humans and no bots or tribes, which leaves a match where nothing
// happens unless an intent says so. One human is the scouting nation, one
// its ally, one a bystander and one an enemy with a warship.
//   fogScoutsRun  one pass over the whole script, checking as it goes
//   fogScouts     runs it twice in fresh contexts and compares the hashes
//   fogScoutsOff  a fog-off match can hold no Scout and reaches none of this
const fogScoutCfg = { name: 'fog-scouts-small-67890', size: 'small', seed: 67890 };

function fogScoutsRun(second) {
  const cfg = fogScoutCfg;
  const sim = boot(cfg);
  const { Game, GameMap, Hash, Executor, Protocol } = sim;
  const expect = (ok, msg) => { if (!ok) throw new Error(`FOG SCOUTS: ${msg}`); };
  const roster = [0, 1, 2, 3].map(id => ({ clientID: `scout-harness-${id}`, username: `Human ${id}`, playerId: id }));
  Game.init({ gameID: cfg.name, seed: cfg.seed, config: { mapSize: cfg.size, bots: 0, tribes: 0, fogOfWar: true }, players: roster }, 0);
  expect(Game.fog === true && Game.scouts.length === 0, 'the match did not start with fog on and no Scouts');
  Executor.setRoster(roster);
  // Every order below goes the way a click does: an intent, stamped, applied.
  const send = (id, intent) => {
    const stamped = Protocol.stamp(intent, roster[id].clientID);
    expect(Protocol.validateIntent(stamped) === null, `intent ${intent.type} is not valid on the wire: ${Protocol.validateIntent(stamped)}`);
    return Executor.apply(stamped);
  };

  const w = GameMap.width, owner = GameMap.owner, wc = GameMap.waterComponentId, WATER = -2;
  const xy = t => `${t % w},${(t / w) | 0}`;
  const dist = (a, b) => Math.abs((a % w) - (b % w)) + Math.abs(((a / w) | 0) - ((b / w) | 0));
  const count = id => Game.visionCount[Game.visionGroupOf[id]];
  // Is the whole disc of `r` cells around `tile` discovered by `id`?
  const discSeen = (id, tile, r) => {
    const C = Game.VISION_CELL, cx = ((tile % w) / C) | 0, cy = (((tile / w) | 0) / C) | 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy;
      if (dx * dx + dy * dy > r * r + r || x < 0 || y < 0 || x >= Game.visionCellsW || y >= Game.visionCellsH) continue;
      if (!Game.isDiscovered(id, y * C * w + x * C)) return false;
    }
    return true;
  };

  // Every route search: inside its own cap, inside the tick's budget, and a
  // real route (water only, one step at a time).
  const budget = Game.SEA_PATH_NODE_BUDGET_PER_TICK;
  const search = { searches: 0, slices: 0, budgetWaits: 0, slotWaits: 0, mostSlices: 0, worstSlice: 0, worstSearch: 0, worstTickNodes: 0, blind: 0, unfinished: 0 };
  const slicesOf = new WeakMap();
  const towardRun = Game.seaTowardRun, towardPath = Game.seaTowardPath;
  Game.seaTowardRun = function (st, slice) {
    const had = st.nodes, begun = st.begun;
    const r = towardRun.call(this, st, slice);
    if (r === null) { search.budgetWaits++; expect(st.nodes === had && st.begun === begun, 'a search that had no room in the tick ran anyway'); return r; }
    search.slices++;
    slicesOf.set(st, (slicesOf.get(st) || 0) + 1);
    search.worstSlice = Math.max(search.worstSlice, st.nodes - had);
    expect(st.nodes - had <= slice && st.nodes - had + Game.SEA_PATH_SEARCH_COST <= budget, `one slice of a route search explored ${st.nodes - had} tiles`);
    expect(this._inTick, 'a Scout route search ran outside the tick');
    search.worstTickNodes = Math.max(search.worstTickNodes, this._seaPathNodesThisTick);
    expect(this._seaPathNodesThisTick <= budget, `a route search took its tick to ${this._seaPathNodesThisTick} tiles, over the budget of ${budget}`);
    if (r) {
      search.searches++;
      search.mostSlices = Math.max(search.mostSlices, slicesOf.get(st));
      search.worstSearch = Math.max(search.worstSearch, st.nodes);
      if (!st.reachable) search.blind++;
      if (!st.arrived && !st.exhausted) search.unfinished++;
      expect(st.nodes <= Game.SEA_PATH_GUARD, `a route search explored ${st.nodes} tiles in all`);
    }
    return r;
  };
  // Every route: starts where the ship is, water only, one step at a time.
  Game.seaTowardPath = function (st) {
    const route = towardPath.call(this, st);
    expect(route[0] === st.from, 'a route does not start where the ship is');
    for (let i = 0; i < route.length; i++) {
      expect(owner[route[i]] === WATER, `a route crosses land at ${xy(route[i])}`);
      if (i) expect(dist(route[i - 1], route[i]) === 1, `a route jumps from ${xy(route[i - 1])} to ${xy(route[i])}`);
    }
    return route;
  };

  // One tick, then everything that must hold after any tick.
  const checkpoints = [];
  let ally = -1, probeTile = 0, scoutShells = 0, ticks = 0;
  const step = () => {
    Game.tick();
    ticks++;
    for (const s of Game.scouts) {
      const t = Game.scoutTile(s);
      expect(owner[t] === WATER, `Scout ${s.id} is on land at ${xy(t)}`);
      expect(discSeen(s.owner, t, Game.VISION_SIGHT_SCOUT), `Scout ${s.id} has not revealed its sight radius at ${xy(t)}`);
      if (ally >= 0 && Game.areAllied(s.owner, ally)) expect(discSeen(ally, t, Game.VISION_SIGHT_SCOUT), `the ally cannot see what Scout ${s.id} revealed at ${xy(t)}`);
    }
    for (const ws of Game.warships) {
      const t = ws.path[Math.min(ws.path.length - 1, Math.floor(ws.pos))];
      expect(discSeen(ws.owner, t, Game.VISION_SIGHT_WARSHIP), `warship ${ws.id} has not revealed its sight radius at ${xy(t)}`);
    }
    for (const sh of Game.shells) if (sh.targetKind === 'scout') scoutShells++;
    // One search at a time: whoever holds it is still owed a route, and any
    // other Scout owed one is waiting its turn.
    const held = Game.scoutSearch;
    if (held) {
      const holder = Game.scoutById(held.scoutId);
      if (holder) {
        expect(holder.routing, `a route search is held for Scout ${holder.id}, which is not waiting for one`);
        for (const s of Game.scouts) if (s !== holder && s.routing && s.pos >= s.path.length - 1) search.slotWaits++;
      }
    }
    // Run 2 also asks the read-only questions a UI would, which must change nothing.
    if (second) {
      for (const p of roster) {
        Game.scoutBlockReason(p.playerId, probeTile); Game.canBuildScout(p.playerId, probeTile); Game.scoutCount(p.playerId);
      }
      Game.scoutById(1); Game.scoutById(ticks);
      probeTile = (probeTile + 7919) % owner.length;
    }
    if (ticks % 50 === 0) checkpoints.push({ tick: ticks, hash: Hash.compute() });
  };
  const run = n => { for (let i = 0; i < n; i++) step(); };
  const arrive = (s, limit, what) => {
    let n = 0;
    while (Game.scouts.includes(s) && (s.routing || s.pos < s.path.length - 1)) {
      expect(n++ < limit, `${what}: the Scout is still under way after ${limit} ticks`);
      step();
    }
    expect(Game.scouts.includes(s), `${what}: the Scout was lost on the way`);
    return Game.scoutTile(s);
  };

  // Setup. The humans take their reserved spawns, then anyone not yet on the
  // main sea expands over neutral land until they are.
  while (Game.spawning) Game.tick();
  const seaSizes = new Map();
  for (let t = 0; t < wc.length; t++) if (wc[t] >= 0) seaSizes.set(wc[t], (seaSizes.get(wc[t]) || 0) + 1);
  const bySize = [...seaSizes].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const sea = bySize[0][0];
  const nb = new Int32Array(4);
  const seaCoast = id => {
    for (const t of Game.players[id].tiles) {
      const n = GameMap.neighbors(t, nb);
      for (let k = 0; k < n; k++) if (wc[nb[k]] === sea) return t;
    }
    return -1;
  };
  for (let i = 0; roster.some(p => seaCoast(p.playerId) < 0); i++) {
    expect(i < 3000, 'the humans did not all reach the main sea');
    if (i % 20 === 0) for (const p of roster) {
      const me = Game.players[p.playerId];
      if (seaCoast(p.playerId) < 0) send(p.playerId, Protocol.intent.attack(Protocol.NEUTRAL_TARGET, Math.floor(me.troops / 2), me.tiles.values().next().value));
    }
    step();
  }
  for (let i = 0; Game.attacks.length && i < 3000; i++) step();
  expect(Game.attacks.length === 0, 'the opening land grabs never finished');

  // A scouts, B is its ally, E (the human furthest from A) is the enemy, C watches.
  const A = 0;
  const home = id => Game.players[id].tiles.values().next().value;
  const others = [1, 2, 3].sort((p, q) => dist(home(q), home(A)) - dist(home(p), home(A)) || p - q);
  const E = others[0], B = others[1], C = others[2];
  const me = Game.players[A];
  const portA = seaCoast(A), portE = seaCoast(E);
  const pick = (ok, score) => {
    let best = -1, bestScore = -Infinity;
    for (let t = 0; t < owner.length; t++) {
      if (!ok(t)) continue;
      const sc = score(t);
      if (sc > bestScore) { best = t; bestScore = sc; }
    }
    expect(best >= 0, 'the map has no tile this script needs');
    return best;
  };
  // Every tile's straight grid distance to the main sea: what "the closest
  // water it can reach" has to mean for a Scout that sails that sea.
  const seaFar = new Int32Array(owner.length).fill(-1);
  {
    const queue = new Int32Array(owner.length);
    let head = 0, tail = 0;
    for (let t = 0; t < owner.length; t++) if (wc[t] === sea) { seaFar[t] = 0; queue[tail++] = t; }
    while (head < tail) {
      const t = queue[head++], n = GameMap.neighbors(t, nb);
      for (let k = 0; k < n; k++) if (seaFar[nb[k]] < 0) { seaFar[nb[k]] = seaFar[t] + 1; queue[tail++] = nb[k]; }
    }
  }
  const seaDist = t => seaFar[t];

  // 1. No Port, no Scout.
  me.gold = 1e6;
  expect(Game.scoutBlockReason(A, portA) === 'Build a Port first', `without a Port the reason is ${Game.scoutBlockReason(A, portA)}`);
  expect(send(A, Protocol.intent.buildUnit('scout', portA)) === false && Game.scouts.length === 0 && me.gold === 1e6, 'a Scout was bought without a Port');
  expect(send(A, Protocol.intent.moveScout([1], portA)) === false, 'a Scout that does not exist took an order');

  // Ports for A and E, and an alliance between A and B.
  for (const [id, tile] of [[A, portA], [E, portE]]) {
    Game.players[id].gold = 1e6;
    expect(send(id, Protocol.intent.buildUnit('port', tile)) === true, `human ${id} could not place a Port`);
  }
  run(100);
  expect(Game.buildings.get(portA).built && Game.buildings.get(portE).built, 'the Ports did not finish');
  expect(Game.acceptAlliance({ from: A, to: B }) === true, 'alliance refused');
  ally = B;

  // 2. Nothing about the tile changes the answer: with a Port, the cap not
  // reached and the gold in hand, a Scout can be bought toward any tile on
  // the map, and the same goes for the other reasons.
  me.gold = Game.unitCost(me, 'scout') - 1;
  for (let t = 0; t < owner.length; t += 97) expect(Game.scoutBlockReason(A, t) === 'Not enough gold', `the reason depends on the tile at ${xy(t)}`);
  expect(send(A, Protocol.intent.buildUnit('scout', portA)) === false && Game.scouts.length === 0, 'a Scout was bought without the gold');
  me.gold = 1e6;
  const kinds = { discoveredWater: 0, undiscoveredWater: 0, discoveredLand: 0, undiscoveredLand: 0, lake: 0 };
  for (let t = 0; t < owner.length; t += 97) {
    expect(Game.scoutBlockReason(A, t) === null, `a Scout order toward ${xy(t)} is refused: ${Game.scoutBlockReason(A, t)}`);
    kinds[owner[t] === WATER && wc[t] !== sea ? 'lake' : (Game.isDiscovered(A, t) ? 'discovered' : 'undiscovered') + (owner[t] === WATER ? 'Water' : 'Land')]++;
  }
  expect(Object.values(kinds).every(n => n > 0), `the sweep missed a kind of tile: ${JSON.stringify(kinds)}`);
  expect(Game.scoutBlockReason(A, -1) === 'Off the map' && Game.scoutBlockReason(A, owner.length) === 'Off the map', 'an off-map tile was accepted');

  // 3. Open water the nation can see: the Scout sails there and stops on it.
  const open = pick(t => wc[t] === sea && Game.isDiscovered(A, t) && GameMap.shoreDist[t] >= 3 && dist(t, portA) >= 15 && dist(t, portA) <= 40, t => -dist(t, portA));
  let before = count(A);
  expect(send(A, Protocol.intent.buildUnit('scout', open)) === true, 'a Scout toward open water was refused');
  expect(Game.scouts.length === 1 && me.gold === 1e6 - 25000, 'buying a Scout did not cost 25,000 for one Scout');
  const s1 = Game.scouts[0];
  expect(s1.owner === A && s1.destTile === open && s1.health === Game.SCOUT_MAX_HEALTH && dist(Game.scoutTile(s1), portA) === 1, 'the Scout did not launch beside its Port');
  expect(discSeen(A, Game.scoutTile(s1), Game.VISION_SIGHT_SCOUT) && discSeen(B, Game.scoutTile(s1), Game.VISION_SIGHT_SCOUT), 'the launch did not reveal');
  expect(arrive(s1, 400, 'open water') === open, `the Scout sent to open water ${xy(open)} stopped at ${xy(Game.scoutTile(s1))}`);

  // The hash covers Scouts.
  const h0 = Hash.compute();
  s1.health -= 1; const h1 = Hash.compute(); s1.health += 1;
  s1.destTile += 1; const h2 = Hash.compute(); s1.destTile -= 1;
  expect(h1 !== h0 && h2 !== h0 && Hash.compute() === h0, 'the hash does not cover Scouts');

  // 4. Land in the black: never refused, and the Scout ends on the water
  // closest to the click.
  const inland = pick(t => owner[t] !== WATER && !Game.isDiscovered(A, t) && !Game.isDiscovered(B, t), t => seaFar[t]);
  expect(send(A, Protocol.intent.buildUnit('scout', inland)) === true, 'a Scout toward undiscovered land was refused');
  const s2 = Game.scouts[1];
  const inlandEnd = arrive(s2, 2000, 'undiscovered land');
  expect(owner[inlandEnd] === WATER && s2.destTile === inland, 'the Scout sent to land did not end on water');
  expect(dist(inlandEnd, inland) === seaDist(inland), `the Scout sent to land at ${xy(inland)} stopped ${dist(inlandEnd, inland)} tiles off at ${xy(inlandEnd)}; the closest water is ${seaDist(inland)} off`);
  expect(count(A) > before && Game.isDiscovered(A, inlandEnd) && Game.isDiscovered(B, inlandEnd), 'the voyage to land revealed nothing');

  // 5. The cap.
  expect(Game.scoutCount(A) === Game.MAX_SCOUTS_PER_PLAYER, 'this script expects the cap to be two');
  for (let t = 0; t < owner.length; t += 97) expect(Game.scoutBlockReason(A, t) === 'Scout limit reached', `at the cap the reason depends on the tile at ${xy(t)}`);
  before = me.gold;
  expect(send(A, Protocol.intent.buildUnit('scout', open)) === false && Game.scouts.length === 2 && me.gold === before, 'a third Scout was bought');

  // 6. A lake the Scout cannot sail into: never refused, and it ends on the
  // sea, as close to the lake as the sea gets. Somebody else's Scout, and a
  // list with a dead id in it, are not this player's to move.
  expect(bySize.length > 1, 'this map has no lake');
  const lake = pick(t => wc[t] >= 0 && wc[t] !== sea, t => seaFar[t]);
  expect(send(B, Protocol.intent.moveScout([s1.id], lake)) === false && s1.destTile === open, 'another player moved the Scout');
  expect(send(A, Protocol.intent.moveScout([999, s1.id], lake)) === true && s1.destTile === lake && s1.routing, 'a Scout order toward a lake was refused');
  const lakeEnd = arrive(s1, 2000, 'lake');
  expect(wc[lakeEnd] === sea, 'the Scout sent to a lake left the sea');
  expect(dist(lakeEnd, lake) === seaDist(lake), `the Scout sent to the lake at ${xy(lake)} stopped ${dist(lakeEnd, lake)} tiles off at ${xy(lakeEnd)}; the sea comes within ${seaDist(lake)}`);

  // A goal too far from the Scout's sea to have a known closest point is
  // searched for blind: the search steers at the goal itself and takes the
  // best tile it finds. No map this size has such a goal, so the snap
  // distance is shortened for this one voyage.
  const snap = Game.SEA_TOWARD_SNAP_DIST, blindFrom = Game.scoutTile(s1);
  Game.SEA_TOWARD_SNAP_DIST = 8;
  expect(send(A, Protocol.intent.moveScout([s1.id], inland)) === true, 'a Scout order toward land far from the sea was refused');
  const blindEnd = arrive(s1, 3000, 'blind');
  Game.SEA_TOWARD_SNAP_DIST = snap;
  expect(search.blind > 0 && search.unfinished > 0, 'the blind search did not run');
  expect(wc[blindEnd] === sea && dist(blindEnd, inland) <= dist(blindFrom, inland), 'the Scout searching blind ended further from its goal than it began');

  // Any tile at all is an order a Scout takes.
  for (const t of [0, owner.length - 1, inland, lake, open, portA]) {
    expect(send(A, Protocol.intent.moveScout([s1.id], t)) === true, `a Scout order toward ${xy(t)} was refused`);
  }
  // Land just behind a coast nobody on A's side has seen: it stops off that coast.
  const beach = pick(t => owner[t] !== WATER && seaFar[t] >= 3 && seaFar[t] <= 20 && !Game.isDiscovered(A, t), t => -dist(t, Game.scoutTile(s1)));
  // Both Scouts are sent in one order, with the search slowed to a crawl so
  // that it takes several ticks: one Scout has to wait for the other's route.
  const perTick = Game.SCOUT_PATH_NODES, waited = search.slotWaits, sliced = search.slices;
  Game.SCOUT_PATH_NODES = 200;
  expect(send(A, Protocol.intent.moveScout([s1.id, s2.id], beach)) === true && s1.routing && s2.routing, 'a Scout order toward an unseen coast was refused');
  for (let i = 0; s1.routing || s2.routing; i++) {
    expect(i < 2000, 'two Scouts sent together never both found a route');
    step();
  }
  Game.SCOUT_PATH_NODES = perTick;
  expect(search.slotWaits > waited && search.slices - sliced > 2, 'no Scout waited for the other one\'s search');
  const beachEnd = arrive(s1, 2000, 'unseen coast');
  expect(wc[beachEnd] === sea && dist(beachEnd, beach) === seaFar[beach], `the Scout sent to the coast at ${xy(beach)} stopped ${dist(beachEnd, beach)} tiles off; the sea is ${seaFar[beach]} off`);
  expect(dist(arrive(s2, 2000, 'unseen coast, second Scout'), beach) === seaFar[beach], 'the second Scout sent to the same coast stopped somewhere else');
  expect(Game.isDiscovered(A, beach) && Game.isDiscovered(B, beach), 'the Scout did not reveal the coast it stopped off');

  // 7. Off into unexplored sea, and redirected half way. Both targets are far
  // from where the enemy's warship will be, so this Scout outlives it.
  const unseen = t => wc[t] === sea && ![A, B, C, E].some(id => Game.isDiscovered(id, t));
  const far1 = pick(unseen, t => dist(t, Game.scoutTile(s2)));
  const far2 = pick(t => unseen(t) && dist(t, far1) > 60, t => Math.min(dist(t, portE), 2 * Game.WARSHIP_TARGET_RANGE) * 1000 + dist(t, far1));
  expect(dist(far2, portE) > Game.WARSHIP_TARGET_RANGE + Game.WARSHIP_PATROL_RANGE, 'no unexplored sea out of the warship\'s reach');
  before = count(A);
  const beforeB = count(B), beforeC = count(C);
  expect(send(A, Protocol.intent.moveScout([s2.id], far1)) === true, 'a Scout order into unexplored sea was refused');
  run(40);
  expect(s2.pos > 0 && s2.pos < s2.path.length - 1, 'the Scout is not under way');
  const turnedAt = Game.scoutTile(s2);
  expect(send(A, Protocol.intent.moveScout([s2.id], far2)) === true && s2.destTile === far2 && s2.routing && Game.scoutTile(s2) === turnedAt, 'the redirect did not take');
  expect(arrive(s2, 3000, 'unexplored sea') === far2, `the Scout sent to ${xy(far2)} stopped at ${xy(Game.scoutTile(s2))}`);
  expect(count(A) > before && count(B) > beforeB, 'the voyage into unexplored sea revealed nothing');
  expect(Game.isDiscovered(A, far2) && Game.isDiscovered(B, far2), 'the owner and its ally cannot see where the Scout is');
  expect(count(C) === beforeC && !Game.isDiscovered(C, far2), 'a bystander saw what the Scout revealed');
  fogInvariants(sim, null, `${cfg.name} after the voyages`);

  // 8. A warship reveals as it sails, and sinks the Scout that comes near.
  const enemy = Game.players[E];
  const station = pick(t => wc[t] === sea && Game.isDiscovered(E, t), t => dist(t, portE));
  enemy.gold = 1e6;
  before = count(E);
  const landE = enemy.tiles.size;
  expect(send(E, Protocol.intent.buildUnit('warship', station)) === true && Game.warships.length === 1, 'the enemy could not launch a warship');
  const ship = Game.warships[0];
  expect(discSeen(E, ship.path[0], Game.VISION_SIGHT_WARSHIP), 'launching a warship did not reveal');
  // The Scout goes looking for the warship, wherever that has got to (it may
  // be off chasing a trade ship), until it is close enough to be shot at.
  const shipTile = () => ship.path[Math.min(ship.path.length - 1, Math.floor(ship.pos))];
  for (let i = 0; Game.scouts.includes(s1); i++) {
    if (i % 50 === 0) expect(send(A, Protocol.intent.moveScout([s1.id], shipTile())) === true, 'a Scout order toward the enemy was refused');
    expect(i < 4000, `the enemy warship never sank the Scout (Scout at ${xy(Game.scoutTile(s1))}, health ${s1.health}; warship at ${xy(shipTile())})`);
    step();
  }
  for (let i = 0; ship.ordered && i < 2000; i++) step();
  expect(!ship.ordered, 'the enemy warship never reached its station');
  expect(scoutShells > 0 && s1.health <= 0, 'the Scout was not sunk by shells');
  expect(Game.scouts.length === 1 && Game.scouts[0] === s2 && Game.scoutCount(A) === 1, 'the wrong Scout was sunk');
  expect(Game.warships.includes(ship) && ship.health === Game.WARSHIP_MAX_HEALTH, 'the unarmed Scout hurt the warship');
  expect(count(E) > before && enemy.tiles.size === landE, 'the warship revealed nothing as it sailed');
  me.gold = 1e6;
  expect(Game.scoutBlockReason(A, open) === null, 'a sunk Scout did not free its slot');
  fogInvariants(sim, null, `${cfg.name} after the sinking`);

  // 9. The budget rule, asked directly: a search waits when the tick has no
  // room for its whole cap, runs when it has exactly enough, and is clamped
  // to the budget however much it is offered.
  expect(Game.scoutSearch === null, 'a route search is still in flight with every Scout at rest');
  const fixed = Game.SEA_PATH_SEARCH_COST, slice = Game.SCOUT_PATH_NODES, here = Game.scoutTile(s2);
  const scratch = [Game._seaPathNodesThisTick, Game._seaPathSearchesThisTick];
  const probe = Game.seaTowardStart(here, beach);
  Game._inTick = true;
  Game._seaPathNodesThisTick = budget - fixed - slice + 1;
  expect(towardRun.call(Game, probe, slice) === null && !probe.begun && probe.nodes === 0, 'a search started without room in the tick');
  Game._seaPathNodesThisTick = budget - fixed - slice;
  let over = towardRun.call(Game, probe, slice);
  expect(over !== null && probe.begun && (over ? probe.nodes <= slice : probe.nodes === slice), 'a search that just fits did not run its slice');
  expect(Game._seaPathNodesThisTick === budget - slice + probe.nodes, 'a search did not count its tiles against the tick');
  if (!over) {
    // A later slice has no fixed cost to pay, and still waits for room.
    expect(towardRun.call(Game, probe, slice) === null && probe.nodes === slice, 'a second slice ran without room in the tick');
    Game._seaPathNodesThisTick = 0;
    over = towardRun.call(Game, probe, 1e9);
    expect(probe.nodes - slice <= budget - fixed && Game._seaPathNodesThisTick === probe.nodes - slice, `a slice offered any number of tiles explored ${probe.nodes - slice}`);
  }
  while (!over) { Game._seaPathNodesThisTick = 0; over = towardRun.call(Game, probe, slice); }
  expect(probe.nodes <= Game.SEA_PATH_GUARD && probe.arrived && dist(probe.aim, beach) === seaFar[beach], 'the probe search did not arrive at the water closest to its goal');
  Game._inTick = false;
  [Game._seaPathNodesThisTick, Game._seaPathSearchesThisTick] = scratch;

  // 10. Losing the Port changes nothing for a Scout afloat; losing the nation
  // takes its Scouts with it, as it does its warships.
  Game.setOwner(portA, E);
  expect(owner[portA] === E && Game.scoutBlockReason(A, open) === 'Build a Port first', 'the Port did not change hands');
  expect(send(A, Protocol.intent.moveScout([s2.id], far1)) === true, 'a Scout with no Port left refused an order');
  run(50);
  expect(Game.scouts.includes(s2) && s2.pos > 0, 'a Scout with no Port left stopped sailing');
  Game.eliminatePlayer(me);
  run(1);
  expect(Game.scouts.length === 0, 'a dead nation kept its Scout');
  while (ticks % 50) step();

  expect(search.mostSlices > 1 && search.worstSlice === Game.SCOUT_PATH_NODES, 'no route search ran a full slice and carried on, so the budget went untested');
  return { checkpoints, digest: digest(Game, GameMap), ticks, search, budget, scoutShells,
    ends: { open: xy(open), inland: `${xy(inland)} -> ${xy(inlandEnd)}`, lake: `${xy(lake)} -> ${xy(lakeEnd)}`,
      blind: `${xy(inland)} from ${xy(blindFrom)} (${dist(blindFrom, inland)} off) -> ${xy(blindEnd)} (${dist(blindEnd, inland)} off, closest possible ${seaFar[inland]})`, coast: `${xy(beach)} -> ${xy(beachEnd)}`, sea: `${xy(far1)} then ${xy(far2)}` } };
}

function fogScouts() {
  const began = performance.now();
  const first = fogScoutsRun(false), second = fogScoutsRun(true);
  if (first.checkpoints.length !== second.checkpoints.length) throw new Error('FOG SCOUTS DIVERGENCE: the two runs took a different number of ticks');
  for (let i = 0; i < first.checkpoints.length; i++) {
    const p = first.checkpoints[i], q = second.checkpoints[i];
    if (p.hash !== q.hash) throw new Error(`FOG SCOUTS DIVERGENCE tick ${p.tick}: run 1 ${p.hash}, run 2 ${q.hash}`);
  }
  if (JSON.stringify(first.digest) !== JSON.stringify(second.digest)) throw new Error('FOG SCOUTS DIVERGENCE: final digest differs between the two runs');
  console.log(`${fogScoutCfg.name}: 2 x ${first.ticks} ticks, ${first.checkpoints.length} checkpoints identical, final hash ${first.checkpoints[first.checkpoints.length - 1].hash}, ${((performance.now() - began) / 1000).toFixed(2)}s`);
  console.log('Scout voyages:', JSON.stringify(first.ends));
  console.log(`Scout route searches: ${JSON.stringify(first.search)}, tick budget ${first.budget}, ${first.scoutShells} shell-ticks at Scouts`);
  console.log('fog-scouts: Port and cap, no refusal for terrain, open water, land, lake, unexplored sea, redirect, ally sight, warship sight, sinking, lost Port, lost nation, budget: ok');
}

function fogScoutsOff() {
  const cfg = { name: 'fog-off-scouts-small-12345', size: 'small', seed: 12345, bots: 8, tribes: 12, ticks: 6000 };
  const { Game, GameMap, Hash, Executor, Protocol } = boot(cfg);
  const fail = msg => { throw new Error(`FOG OFF SCOUTS: ${msg}`); };
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  if (!Game.chooseSpawn(Hash.firstLegalSpawn())) fail('no legal human spawn');
  const scout = Game.UNITS.find(u => u.type === 'scout');
  if (!scout || !scout.action || !scout.fogOnly || scout.hotkey !== undefined) fail('the Scout entry is not marked action, fogOnly and without a hotkey');
  // Everything Scout- or sight-related that does work. A fog-off match must
  // not get to any of it.
  for (const name of ['stepScouts', 'scoutRoute', 'seaTowardStart', 'seaTowardRun', 'seaTowardPath', 'seaTowardArena', 'nearestWaterInComponent', 'scoutTargetFor', 'warshipReveal']) {
    Game[name] = () => fail(`${name} was reached in a fog-off match`);
  }
  const human = Game.players[0];
  const buy = Protocol.stamp(Protocol.intent.buildUnit('scout', 0), Executor.LOCAL_CLIENT_ID);
  const move = Protocol.stamp(Protocol.intent.moveScout([1], 0), Executor.LOCAL_CLIENT_ID);
  let warships = 0;
  for (let tick = 1; tick <= cfg.ticks; tick++) {
    if (tick % 100 === 0) {
      const gold = human.gold;
      human.gold = 1e9;
      const reason = Game.scoutBlockReason(0, tick);
      if (human.alive && reason !== 'Scouts need fog of war') fail(`the block reason is ${reason}`);
      if (Executor.apply(buy) !== false || Executor.apply(move) !== false || human.gold !== 1e9) fail('a Scout order was accepted');
      human.gold = gold;
    }
    Game.tick();
    warships = Math.max(warships, Game.warships.length);
    if (Game.scouts.length !== 0 || Game.nextScoutId !== 1 || Game.scoutSearch !== null || Game._seaTowardArena !== null) fail('a Scout or its search exists');
  }
  if (!warships) fail('no warship sailed, so warship sight went untested');
  if (Game.warships.some(ws => 'visionCell' in ws)) fail('a warship carries vision state');
  // The fog-off digest does not read Game.scouts at all.
  const h = Hash.compute();
  Game.scouts.push({ id: 1, owner: 0, path: [0], pos: 0, destTile: 0, routing: false, health: 1 });
  if (Hash.compute() !== h) fail('the fog-off hash reads Game.scouts');
  Game.scouts.pop();
  console.log(`fog-off-scouts: no Scout bought, moved or stepped and no warship sight in ${cfg.ticks} ticks (peak ${warships} warships): ok`);
}

// --- fog gating (task 7): the rules of "What is blocked" and "Meeting a nation"
// in docs/fog-of-war.md, driven through the real intent path (Executor.apply)
// wherever an intent exists. Self-contained: each function boots its own match.
function fogGatingHarness(cfg) {
  const sim = boot(cfg);
  const { Game, GameMap, Hash } = sim;
  // Executor, Protocol and WATER are top-level bindings of the sim context, so
  // they are reachable through that context's own Function constructor.
  const inCtx = name => Game.constructor.constructor(`return ${name}`)();
  const Executor = inCtx('Executor'), Protocol = inCtx('Protocol'), WATER = inCtx('WATER');
  const expect = (ok, msg) => { if (!ok) throw new Error(`FOG GATING: ${msg}`); };
  // One intent, as `playerId`'s client, through grammar, actor and handler.
  const act = (playerId, intent) => {
    Executor.setRoster([{ clientID: 'gate', playerId }]);
    try { return Executor.apply({ ...intent, clientID: 'gate' }); } finally { Executor.reset(); }
  };
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  // Fog matches seat the human in init (task 3); fog-off ones still pick.
  if (Game.fog) expect(Game.players[0].tiles.size > 0, 'the human owns no land after init');
  else expect(Game.chooseSpawn(Hash.firstLegalSpawn()), 'no legal human spawn');
  while (Game.spawning) Game.tick();
  const nations = () => Game.players.filter(p => !p.isTribe && p.alive && p.tiles.size > 0).map(p => p.id);
  const strangers = () => {
    const ids = nations();
    for (const a of ids) for (const b of ids) {
      if (a < b && !Game.hasMet(a, b) && !Game.hasMet(b, a) && !Game.areAllied(a, b)) return [a, b];
    }
    throw new Error('FOG GATING: no two nations that have not met');
  };
  const tileOf = id => Game.players[id].tiles.values().next().value;
  const coastOf = id => {
    for (const t of Game.players[id].tiles) if (GameMap.isCoastal(t) && !Game.buildings.has(t)) return t;
    return -1;
  };
  return { Game, GameMap, Protocol, WATER, expect, act, nations, strangers, tileOf, coastOf };
}

function fogGatingDiplomacy() {
  const { Game, Protocol: P, expect, act, strangers } = fogGatingHarness({ name: 'fog-gating', size: 'small', seed: 12345, bots: 8, tribes: 12, fogOfWar: true });
  const requested = (from, to) => Game.pendingRequest(from, to) !== null;

  // Alliance request: only toward a nation the sender has met.
  let [a, b] = strangers();
  expect(!act(a, P.intent.allianceRequest(b)) && !requested(a, b), 'an alliance request to an unmet nation went through');
  expect(Game.canRequestAlliance(a, b) === false && Game.allianceBlockReason(a, b) === 'Not met', 'canRequestAlliance/allianceBlockReason do not refuse an unmet nation');
  Game.markMet(a, b);
  expect(Game.allianceBlockReason(a, b) === null && act(a, P.intent.allianceRequest(b)) && requested(a, b), 'an alliance request to a met nation was refused');
  expect(!Game.hasMet(b, a), 'receiving a request made the recipient meet the sender');
  // The recipient has not met the sender, so it may not request back, but it can accept.
  expect(!Game.canRequestAlliance(b, a), 'the unmet recipient could send its own request');
  expect(act(b, P.intent.allianceAccept(a)) && Game.areAllied(a, b), 'a request from an unmet sender could not be accepted');
  expect(Game.hasMet(a, b) && Game.hasMet(b, a), 'accepting did not make both sides meet');
  // Declining works just as well and does not make the decliner meet the sender.
  const [c, d] = strangers();
  Game.markMet(c, d);
  expect(act(c, P.intent.allianceRequest(d)) && act(d, P.intent.allianceReject(c)) && !requested(c, d), 'a request from an unmet sender could not be declined');
  expect(!Game.hasMet(d, c), 'declining made the decliner meet the sender');

  // Embargo: one nation at a time, and embargo-all.
  [a, b] = strangers();
  expect(!act(a, P.intent.embargo(b, 'start')) && !Game.hasEmbargoAgainst(a, b) && Game.embargoBlockReason(a, b) === 'Not met', 'an embargo on an unmet nation went through');
  Game.markMet(a, b);
  expect(act(a, P.intent.embargo(b, 'start')) && Game.hasEmbargoAgainst(a, b) && Game.embargoBlockReason(a, b) === null, 'an embargo on a met nation was refused');
  expect(act(a, P.intent.embargo(b, 'stop')) && !Game.hasEmbargoAgainst(a, b), 'an embargo on a met nation could not be lifted');
  [a, b] = strangers();
  const met = [], unmet = [];
  for (const p of Game.players) {
    if (p.isTribe || p.id === a || !p.alive) continue;
    (Game.hasMet(a, p.id) ? met : unmet).push(p.id);
  }
  expect(unmet.length > 0, 'the embargo-all test needs an unmet nation');
  if (!met.length) { Game.markMet(a, unmet[0]); met.push(unmet.shift()); }
  expect(act(a, P.intent.embargoAll('start')), 'embargo-all with someone met was refused');
  expect(met.every(id => Game.hasEmbargoAgainst(a, id)), 'embargo-all missed a met nation');
  expect(unmet.every(id => !Game.hasEmbargoAgainst(a, id)), 'embargo-all reached an unmet nation');

  // Target marking.
  [a, b] = strangers();
  expect(!act(a, P.intent.targetPlayer(b)) && Game.targetBlockReason(a, b) === 'Not met' && Game.players[a].targets.length === 0, 'a target mark on an unmet nation went through');
  Game.markMet(a, b);
  expect(act(a, P.intent.targetPlayer(b)) && Game.players[a].targets.length === 1, 'a target mark on a met nation was refused');
  console.log('fog-gating diplomacy: alliance request, accept and decline, embargo, embargo-all, target mark: ok');
}

function fogGatingDonate() {
  const cfg = { name: 'fog-gating-teams', size: 'small', seed: 12345, bots: 8, tribes: 12, gameMode: 'team', playerTeams: 4, fogOfWar: true };
  const { Game, Protocol: P, expect, act, strangers } = fogGatingHarness(cfg);
  expect(Game.teams, 'the donation test needs a team match');
  // Allies always have met, so the gate can only be seen by forcing two nations
  // into an ally state that skips the alliance handshake.
  const [a, b] = strangers();
  const A = Game.players[a], B = Game.players[b];
  A.allies.add(b);
  B.allies.add(a);
  A.gold = 1e6; A.troops = Math.max(A.troops, 5000); B.troops = 0;
  const gold = B.gold, troops = A.troops;
  expect(!act(a, P.intent.donateGold(b, 1000)) && B.gold === gold && Game.donateBlockReason(a, b) === 'Not met', 'a donation to an unmet ally went through');
  expect(!act(a, P.intent.donateTroops(b, 100)) && A.troops === troops, 'a troop donation to an unmet ally went through');
  Game.markMet(a, b);
  expect(Game.donateBlockReason(a, b) === null && act(a, P.intent.donateGold(b, 1000)) && B.gold === gold + 1000, 'a donation to a met ally was refused');
  A.lastDonationAt.delete(b);   // the gold gift above started the donation cooldown
  expect(act(a, P.intent.donateTroops(b, 100)) && A.troops < troops, 'a troop donation to a met ally was refused');
  console.log('fog-gating donations: refused toward an unmet ally, allowed once met: ok');
}

function fogGatingActions() {
  const { Game, GameMap, Protocol: P, WATER, expect, act, nations, tileOf, coastOf } = fogGatingHarness({ name: 'fog-gating', size: 'small', seed: 12345, bots: 8, tribes: 12, fogOfWar: true });
  const sum = () => Game.visionCount.reduce((s, v) => s + v, 0);
  // A water tile `id` has (or has not) discovered, reachable by sea from `from`.
  const waterTile = (id, from, wantDiscovered) => {
    for (let t = 0; t < GameMap.owner.length; t += 37) {
      if (GameMap.owner[t] === WATER && Game.isDiscovered(id, t) === wantDiscovered && Game.seaPath([from], t)) return t;
    }
    return -1;
  };
  // The two coastal strangers furthest apart, so the ticks it takes to build
  // things do not bring them into contact.
  let pair = null, far = -1;
  for (const a of nations()) for (const b of nations()) {
    if (a >= b || Game.hasMet(a, b) || Game.hasMet(b, a) || coastOf(a) < 0 || coastOf(b) < 0) continue;
    const d = Game.tileDistSq(tileOf(a), tileOf(b));
    if (d > far) { far = d; pair = [a, b]; }
  }
  expect(pair, 'no two coastal strangers');
  const [p1, p2] = pair;
  const A = Game.players[p1], B = Game.players[p2];
  A.gold = B.gold = 1e10; A.troops = Math.max(A.troops, 100000);

  // A Port each, a Silo and a City for p1, a City for p2: placed now, built by ticking.
  const free = id => [...Game.players[id].tiles].find(t => !Game.buildings.has(t));
  const portA = coastOf(p1), portB = coastOf(p2);
  expect(Game.build(p1, 'port', portA) && Game.build(p2, 'port', portB), 'could not place the Ports');
  const siloTile = free(p1);
  expect(Game.build(p1, 'silo', siloTile), 'could not place the Silo');
  const cityA = free(p1), cityB = free(p2);
  expect(Game.build(p1, 'city', cityA) && Game.build(p2, 'city', cityB), 'could not place the Cities');
  const built = () => [portA, portB, siloTile].every(t => Game.buildings.get(t).built);
  for (let i = 0; i < 200 && !built(); i++) Game.tick();
  expect(built(), 'the buildings were not finished');
  expect(!Game.hasMet(p1, p2) && !Game.hasMet(p2, p1), 'the two nations met while the buildings went up');
  A.gold = B.gold = 1e10; A.troops = Math.max(A.troops, 100000);
  const PA = Game.buildings.get(portA), PB = Game.buildings.get(portB);

  // --- Naval invasion: an undiscovered landing is refused, a discovered one is not.
  let U = -1;
  for (let t = 0; t < GameMap.owner.length && U < 0; t += 11) {
    if (!GameMap.isLand(t) || !GameMap.isCoastal(t) || Game.isDiscovered(p1, t)) continue;
    if (GameMap.owner[t] === p1 || Game.areAllied(p1, GameMap.owner[t]) || Game.nearestOwnedCoast(t) !== t) continue;
    if (Game.nearestCoastPath(p1, t)) U = t;
  }
  expect(U >= 0, 'no undiscovered coast to invade');
  const boats = Game.boats.length, troops = A.troops;
  expect(Game.navalInvasionBlockReason(p1, U, 1000) === 'Undiscovered', 'the invasion reason for an undiscovered coast is not "Undiscovered"');
  expect(!act(p1, P.intent.boat(U, 1000)) && Game.boats.length === boats && A.troops === troops, 'an invasion onto an undiscovered coast launched');
  Game.revealAround(p1, U, 1);
  expect(Game.navalInvasionBlockReason(p1, U, 1000) === null, 'the invasion reason for a discovered coast is not null');
  expect(act(p1, P.intent.boat(U, 1000)) && Game.boats.length === boats + 1 && A.troops === troops - 1000, 'an invasion onto a discovered coast did not launch');
  // A refusal never says what is under the fog: inland, water and coast clicks
  // the sender cannot see all get the same reason.
  let inland = -1, sea = -1;
  for (let t = 0; t < GameMap.owner.length && (inland < 0 || sea < 0); t += 13) {
    if (Game.isDiscovered(p1, t)) continue;
    if (inland < 0 && GameMap.isLand(t) && !GameMap.isCoastal(t)) inland = t;
    if (sea < 0 && GameMap.owner[t] === WATER) sea = t;
  }
  expect(inland >= 0 && sea >= 0 && Game.navalInvasionBlockReason(p1, inland, 1000) === 'Undiscovered' && Game.navalInvasionBlockReason(p1, sea, 1000) === 'Undiscovered', 'an inland or water click under the fog was described by a terrain reason');

  // --- Warships: launch and move, discovered water only.
  const W = waterTile(p1, portA, false);
  expect(W >= 0, 'no undiscovered water to send a warship to');
  const warships = Game.warships.length, gold = A.gold;
  expect(Game.warshipBlockReason(p1, W) === 'Undiscovered' && Game.resolveWarshipLaunch(p1, W).reason === 'Undiscovered', 'the warship reason for undiscovered water is not "Undiscovered"');
  expect(!act(p1, P.intent.buildUnit('warship', W)) && Game.warships.length === warships && A.gold === gold, 'a warship launched toward undiscovered water');
  const seen = waterTile(p1, portA, true);
  expect(seen >= 0 && Game.warshipBlockReason(p1, seen) === null, 'a warship cannot be sent to discovered water');
  expect(act(p1, P.intent.buildUnit('warship', seen)) && Game.warships.length === warships + 1, 'a warship toward discovered water was refused');
  const warship = Game.warships[Game.warships.length - 1];
  const W2 = waterTile(p1, warship.path[0], false);
  expect(W2 >= 0, 'no undiscovered water to move a warship to');
  const path = warship.path, patrol = warship.patrolTile;
  expect(!act(p1, P.intent.moveWarship([warship.id], W2)) && warship.path === path && warship.patrolTile === patrol, 'a warship was moved to undiscovered water');
  Game.revealAround(p1, W2, 1);
  expect(act(p1, P.intent.moveWarship([warship.id], W2)) && warship.patrolTile !== patrol, 'a warship could not be moved to water that is now discovered');

  // --- Nukes: any tile is a legal target, and a launch reveals nothing.
  let N = -1;
  for (let t = 0; t < GameMap.owner.length && N < 0; t += 29) if (!Game.isDiscovered(p1, t)) N = t;
  expect(N >= 0, 'no undiscovered tile to nuke');
  const nukes = Game.nukes.length, seenBefore = sum();
  expect(Game.nukeBlockReason(p1, 'atombomb', N) === null, 'nukeBlockReason refuses an undiscovered tile');
  expect(act(p1, P.intent.buildUnit('atombomb', N)) && Game.nukes.length === nukes + 1 && sum() === seenBefore, 'a nuke at an undiscovered tile was refused or revealed something');

  // --- Trade: Ports, trade ships and trains.
  const trades = (from, to) => Game.tradingPorts(from).includes(to);
  expect(!Game.canTrade(p1, p2) && !trades(PA, PB) && !trades(PB, PA), 'two nations that have not met can trade');
  const tradeShip = (owner, src, dst) => ({ owner, srcPort: src, dstPort: dst, path: Array(400).fill(src), pos: 0 });
  const unmetShip = tradeShip(p1, portA, portB);
  Game.tradeShips.push(unmetShip);
  Game.stepTradeShips();
  expect(!Game.tradeShips.includes(unmetShip), 'a trade ship to a nation the sender has not met was not scrapped');
  // Rail: a nation's own stations always pay; a stranger's never do.
  expect(Game.tradeAvailable(p1, p1) && Game.tradeAvailable(p2, p2) && !Game.tradeAvailable(p2, p1) && !Game.tradeAvailable(p1, p2), 'tradeAvailable is wrong for own and unmet stations');
  const train = (owner, stopTile) => ({ id: 9e6 + Game.trains.length, owner, waypoints: [stopTile, stopTile], cum: [0, 1], stops: [{ dist: 0.001, tile: stopTile }], pos: 0, nextStop: 0, stopsVisited: 0 });
  const own = train(p1, cityA), foreign = train(p1, cityB);
  Game.trains.push(own, foreign);
  const aBefore = A.gold, bBefore = B.gold;
  Game.stepTrains();
  expect(!Game.trains.includes(foreign) && B.gold === bBefore, 'a train toward an unmet nation was not stopped');
  expect(!Game.trains.includes(own) && A.gold - aBefore === Game.trainGold(0, 'self'), 'a train between a nation\'s own stations did not pay');
  // One side meeting is not enough; both is.
  Game.markMet(p1, p2);
  expect(!Game.canTrade(p1, p2) && !Game.canTrade(p2, p1) && !trades(PA, PB) && !trades(PB, PA), 'trade opened after only one side had met');
  Game.markMet(p2, p1);
  expect(Game.canTrade(p1, p2) && Game.canTrade(p2, p1) && trades(PA, PB) && trades(PB, PA), 'two nations that have met each other cannot trade');
  const metShip = tradeShip(p1, portA, portB);
  Game.tradeShips.push(metShip);
  Game.stepTradeShips();
  expect(Game.tradeShips.includes(metShip), 'a trade ship between two nations that have met was scrapped');
  const aGold = A.gold, bGold = B.gold;
  Game.trains.push(train(p1, cityB));
  Game.stepTrains();
  expect(A.gold > aGold && B.gold > bGold, 'a train between two nations that have met did not pay both');
  // An embargo still stops trade between nations that have met.
  Game.addEmbargo(p1, p2, false);
  expect(!Game.canTrade(p1, p2) && !trades(PA, PB), 'an embargo no longer stops trade between nations that have met');
  console.log('fog-gating actions: invasion, warship launch and move, nukes, trade, trains, trade ships: ok');
}

// The same actions in a fog-off match are unchanged: no contact needed.
function fogGatingOff() {
  const { Game, Protocol: P, expect, act, nations } = fogGatingHarness({ name: 'fog-gating-off', size: 'small', seed: 12345, bots: 8, tribes: 12 });
  expect(Game.fog === false, 'fog is on');
  const [a, b] = nations();
  expect(Game.canTrade(a, b) && act(a, P.intent.allianceRequest(b)) && Game.pendingRequest(a, b) !== null, 'a fog-off match gates trade or diplomacy');
  expect(act(a, P.intent.embargo(b, 'start')) && Game.hasEmbargoAgainst(a, b) && act(a, P.intent.targetPlayer(b)), 'a fog-off match gates embargoes or target marks');
  console.log('fog-gating off: no contact needed in a fog-off match: ok');
}

// --- `fog`: the Radio Tower (fog task 11) -----------------------------------
// Placed through the ordinary build intent on the builder's own land. Shows
// nothing until it finishes, then every cell of its disc at once, and is
// refused where there is nothing left to show. Bots buy one only without an
// ocean shore. A fog-off match can hold none.
function fogRadio() {
  const { Game, GameMap, Protocol: P, expect, act, nations, tileOf } = fogGatingHarness({ name: 'fog-radio', size: 'small', seed: 12345, bots: 8, tribes: 12, fogOfWar: true });
  const AI = Game.constructor.constructor('return AI')();
  const R = Game.VISION_SIGHT_RADIO, human = Game.players[0];
  const def = Game.unitDef('radio');
  expect(def && def.fogOnly && !def.action && !def.upgradable && def.hotkey === undefined, 'the Radio Tower entry is not a fogOnly, non-action, non-upgradable structure without a hotkey');
  const count = () => Game.visionCount[Game.visionGroupOf[0]];
  const site = tileOf(0);
  const hidden = Game.visionHiddenAround(0, site, R);
  expect(hidden > 0, 'the human has nothing left to uncover at the start');

  human.gold = 0;
  expect(Game.buildBlockReason(0, 'radio', site) === 'Not enough gold' && !act(0, P.intent.buildUnit('radio', site)), 'a tower was sold for no gold');
  human.gold = 1000000;
  const foreign = tileOf(nations().find(id => id !== 0));
  expect(Game.buildBlockReason(0, 'radio', foreign) === 'Your own land only' && !act(0, P.intent.buildUnit('radio', foreign)), 'a tower went up on land the builder does not own');
  expect(Game.unitCost(human, 'radio') === 50000, `the first tower costs ${Game.unitCost(human, 'radio')}`);

  let before = count();
  expect(act(0, P.intent.buildUnit('radio', site)), 'the build intent was refused');
  const b = Game.buildings.get(site);
  expect(b && b.type === 'radio' && !b.built && human.gold === 950000, 'the tower was not placed and paid for');
  expect(count() === before && Game.visionHiddenAround(0, site, R) === hidden, 'a tower under construction revealed something');
  expect(Game.unitCost(human, 'radio') === 100000, 'the second tower is not priced on the linear curve');
  for (let i = 0; i < def.buildTime * Game.TICKS_PER_SEC + 5 && !b.built; i++) Game.tick();
  expect(b.built && GameMap.owner[site] === 0, 'the tower did not finish while the human held it');
  expect(Game.visionHiddenAround(0, site, R) === 0, 'the finished tower left part of its disc undiscovered');
  expect(count() - before >= hidden, `the tower uncovered ${count() - before} cells, fewer than the ${hidden} that were hidden`);
  expect(Game.unitsOwned(human, 'radio') === 1 && Game.unitsPending(human, 'radio') === 0, 'the tower is not counted as built');
  // It does not stand on: the record is gone, the tile is free again, and the next one still costs more.
  expect(!Game.buildings.has(site) && !Game.structureTooClose(site), 'the finished tower is still on the map');
  expect(Game.unitCost(human, 'radio') === 100000, 'the price fell back once the tower was gone');

  // Nothing left to show from here, so a second one is refused and costs nothing.
  let spare = -1;
  for (const t of human.tiles) if (!Game.buildings.has(t) && Game.visionHiddenAround(0, t, R) === 0) { spare = t; break; }
  expect(spare >= 0, 'no free tile inside the uncovered disc');
  const gold = human.gold;
  expect(Game.buildBlockReason(0, 'radio', spare) === 'Nothing left to uncover here' && !act(0, P.intent.buildUnit('radio', spare)) && human.gold === gold, 'a tower that would show nothing was sold');
  expect(!Game.canUpgrade(0, site), 'a Radio Tower can be upgraded');

  // Bots: a Nation on the ocean leaves towers alone; one with no ocean shore
  // builds one on its border, one at a time, and draws nothing from the rng.
  const bot = Game.players.find(p => p.isBot && !p.isTribe && p.alive && p.tiles.size > 0 && AI.hasOceanCoast(p) && AI.radioSite(p) >= 0);
  expect(!!bot, 'no coastal Nation with somewhere to put a tower');
  bot.gold = 1000000;
  const rng = Game.rng;
  Game.rng = () => { throw new Error('FOG GATING: buyRadio drew from Game.rng'); };
  AI.buyRadio(bot);
  expect(Game.unitsPending(bot, 'radio') === 0, 'a Nation on the ocean bought a Radio Tower');
  const realCoast = AI.hasOceanCoast;
  AI.hasOceanCoast = () => false;
  AI.buyRadio(bot);
  let tower = null;
  for (const x of Game.buildings.values()) if (x.type === 'radio' && GameMap.owner[x.tile] === bot.id) tower = x;
  expect(tower && Game.unitsPending(bot, 'radio') === 1 && bot.borderTiles.has(tower.tile), 'a landlocked Nation did not put a tower on its border');
  expect(Game.visionHiddenAround(bot.id, tower.tile, R) >= AI.RADIO_MIN_CELLS, 'the tower the Nation built uncovers too little');
  AI.buyRadio(bot);
  expect(Game.unitsPending(bot, 'radio') === 1, 'a Nation started a second tower before the first was finished');
  AI.hasOceanCoast = realCoast;
  Game.rng = rng;
  console.log(`fog-radio: gold, own land, linear price, nothing shown until built, whole disc on completion (${hidden} cells), refused where nothing is left, bots only when landlocked: ok`);

  const off = fogGatingHarness({ name: 'fog-radio-off', size: 'small', seed: 12345, bots: 8, tribes: 12 });
  off.Game.players[0].gold = 1000000;
  off.expect(off.Game.buildBlockReason(0, 'radio', off.tileOf(0)) === 'Fog of war matches only' && !off.act(0, off.Protocol.intent.buildUnit('radio', off.tileOf(0))), 'a fog-off match sold a Radio Tower');
  off.expect(off.Game.visionHiddenAround(0, off.tileOf(0), R) === 0, 'visionHiddenAround answers in a fog-off match');
  console.log('fog-radio off: refused in a fog-off match: ok');
}

function fogGating() {
  fogGatingDiplomacy();
  fogGatingDonate();
  fogGatingActions();
  fogGatingOff();
}

function runFog() {
  const kept = only ? fogScenarios.filter(s => only.some(part => s.name.includes(part))) : fogScenarios;
  if (!kept.length) throw new Error(`--only matched no fog scenario: ${only.join(',')}`);
  fogOff();
  fogRules();
  fogGating();
  fogRadio();
  fogSpawnControl();
  fogSpawnMultiHuman();
  fogScoutsOff();
  fogScouts();
  fogBotsOff();
  fogBotWatchControl();
  fogBotStrangerOffer();
  const fogTotals = Object.fromEntries(fogMethods.map(k => [k, 0]));
  const botTotals = Object.fromEntries(fogBotCounters.map(k => [k, 0]));
  for (const cfg of kept) {
    const began = performance.now();
    fogSpawnChecks(cfg);
    const first = fogRun(cfg, false), second = fogRun(cfg, true);
    for (let i = 0; i < first.checkpoints.length; i++) {
      const p = first.checkpoints[i], q = second.checkpoints[i];
      if (p.hash !== q.hash) throw new Error(`FOG DIVERGENCE ${cfg.name} tick ${p.tick}: run 1 ${p.hash}, run 2 ${q.hash}`);
    }
    for (const key of ['digest', 'simulationTicks', 'coverage', 'bots', 'scouting']) {
      if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) throw new Error(`FOG DIVERGENCE ${cfg.name}: final ${key} differs between the two runs`);
    }
    for (const name of fogMethods) fogTotals[name] += first.coverage[name];
    for (const name of fogBotCounters) botTotals[name] += first.bots[name];
    // Bots that buy Scouts see more for it.
    if (first.bots.scoutsBought > 0 && !(first.bots.scoutCells > 0)) throw new Error(`FOG BOTS ${cfg.name}: ${first.bots.scoutsBought} Scouts bought and nothing discovered by them`);
    console.log(`${cfg.name}: 2 x ${cfg.ticks} ticks (${first.simulationTicks} simulation ticks), ${first.checkpoints.length} checkpoints identical, final hash ${first.checkpoints[first.checkpoints.length - 1].hash}, ownerFNV ${first.digest.ownerFNV}, ${((performance.now() - began) / 1000).toFixed(2)}s`);
    console.log('Vision:', JSON.stringify(first.stats));
    console.log('Bots:', JSON.stringify({ ...first.bots, ...first.scouting }));
  }
  console.log('Coverage:', JSON.stringify(fogTotals));
  console.log('Bot coverage:', JSON.stringify(botTotals));
  // Every rule fogBotWatch enforces has to have been exercised by a bot, or
  // passing it says nothing.
  const idleBots = ['boats', 'nukes', 'nukeAims', 'warshipOrders', 'embargoes', 'allianceRequests', 'donations', 'neighbours', 'navalScores', 'provocations', 'scoutsBought', 'scoutOrders', 'scoutCells'].filter(name => botTotals[name] === 0);
  if (idleBots.length && !only) throw new Error(`Fog bot coverage missing: ${idleBots.join(', ')}`);
  const missing = ['acceptAlliance', 'breakAlliance', 'detonateNuke', 'resolveLanding', 'markMet', 'visionAllianceFormed'].filter(name => fogTotals[name] === 0);
  if (missing.length && !only) throw new Error(`Fog coverage missing: ${missing.join(', ')}`);
  console.log(`FOG OK (${kept.length} scenarios run twice, ${kept.reduce((sum, s) => sum + s.ticks, 0) * 2} ticks), ${((performance.now() - start) / 1000).toFixed(2)}s`);
}
const totals = Object.fromEntries(methods.map(k => [k, 0]));
const suitePeaks = Object.fromEntries(entities.map(k => [k, 0]));
const results = [];
for (const cfg of mode === 'fog' ? [] : scenarios) {
  const began = performance.now();
  const target = path.join(root, 'tools/golden', `${cfg.name}.json`);
  const golden = mode === 'compare' ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  if (golden) checkManifest(golden.manifest, cfg.name);
  const expected = golden ? Object.fromEntries(Object.entries(golden).filter(([key]) => key !== 'manifest')) : null;
  if (expected && JSON.stringify(expected.scenario) !== JSON.stringify(cfg)) throw new Error(`${cfg.name}: scenario configuration changed`);
  const { Game, GameMap, Hash } = boot(cfg);
  const coverage = Object.fromEntries(methods.map(k => [k, 0]));
  for (const name of methods) {
    const original = Game[name];
    if (typeof original !== 'function') throw new Error(`Missing method ${name}`);
    Game[name] = function (...args) { coverage[name]++; return original.apply(this, args); };
  }
  Game.init(Hash._syntheticGameStartInfo(cfg), 0);
  const peaks = Object.fromEntries(entities.map(k => [k, Game[k].length]));
  const tile = Hash.firstLegalSpawn();
  if (tile < 0 || !Game.chooseSpawn(tile)) throw new Error(`${cfg.name}: no legal human spawn`);
  // Same treasury addition as ui.js's debug gold button, applied to bots early.
  if (cfg.gold) for (const p of Game.players) if (p.isBot) p.gold += cfg.gold;
  const checkpoints = [];
  for (let tick = 1; tick <= cfg.ticks; tick++) {
    Game.tick();
    for (const name of entities) peaks[name] = Math.max(peaks[name], Game[name].length);
    if (perturb && tick === 500) Game.players[1].troops += 1;
    if (tick % 50 === 0) {
      const checkpoint = { tick, hash: Hash.compute() };
      checkpoints.push(checkpoint);
      if (expected && JSON.stringify(checkpoint) !== JSON.stringify(expected.checkpoints[checkpoints.length - 1])) {
        throw new Error(`DIVERGENCE ${cfg.name} tick ${tick}: expected ${expected.checkpoints[checkpoints.length - 1]?.hash}, got ${checkpoint.hash}`);
      }
    }
  }
  const result = { scenario: cfg, checkpoints, digest: digest(Game, GameMap), simulationTicks: Game.ticks, coverage, peaks };
  if (expected && JSON.stringify(result) !== JSON.stringify(expected)) throw new Error(`DIVERGENCE ${cfg.name} tick ${cfg.ticks}: final digest, coverage, or tick count differs`);
  results.push({ target, result: { manifest, ...result } });
  if (mode === 'baseline' || mode === 'neutral') {
    const snap = { scenario: cfg, ownerFNV: result.digest.ownerFNV, simulationTicks: result.simulationTicks, coverage, peaks, keys: keyDigests(Game) };
    const file = path.join(neutralDir, `${cfg.name}.json`);
    if (mode === 'baseline') {
      fs.mkdirSync(neutralDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
    } else {
      const base = JSON.parse(fs.readFileSync(file, 'utf8'));
      const diffs = [];
      for (const field of ['scenario', 'ownerFNV', 'simulationTicks', 'coverage', 'peaks']) {
        if (JSON.stringify(base[field]) !== JSON.stringify(snap[field])) diffs.push(field);
      }
      for (const key of Object.keys(base.keys)) {
        if (base.keys[key] !== snap.keys[key] && !NEUTRAL_ALLOWED.includes(key)) diffs.push(`Game.${key}`);
      }
      if (diffs.length) neutralFailures.push(`${cfg.name}: ${diffs.join(', ')}`);
      console.log(`${cfg.name}: ${diffs.length ? 'DIFFERS (' + diffs.join(', ') + ')' : 'neutral'}`);
    }
  }
  for (const name of methods) totals[name] += coverage[name];
  for (const name of entities) suitePeaks[name] = Math.max(suitePeaks[name], peaks[name]);
  console.log(`${cfg.name}: ${cfg.ticks} ticks (${Game.ticks} simulation ticks), ${((performance.now() - began) / 1000).toFixed(2)}s`);
  console.log('Peaks:', JSON.stringify(peaks));
}
if (mode === 'fog') {
  runFog();
} else {
  console.log('Coverage:', JSON.stringify(totals));
  console.log('Suite peaks:', JSON.stringify(suitePeaks));
  const missing = [...methods.filter(name => totals[name] === 0), ...entities.filter(name => suitePeaks[name] === 0)];
  if (missing.length && !only) throw new Error(`Coverage missing: ${missing.join(', ')}`);
  if (neutralFailures.length) throw new Error(`NOT NEUTRAL:\n  ${neutralFailures.join('\n  ')}`);
  if (mode === 'record') {
    fs.mkdirSync(path.join(root, 'tools/golden'), { recursive: true });
    for (const { target, result } of results) fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n');
  }
  if (mode === 'record' || mode === 'compare') console.log(`MANIFEST ${mode === 'record' ? 'RECORDED' : 'OK'} (${sources.length} loaded files, ${Object.keys(manifest).filter(file => !file.startsWith('js/game/')).length} protected files outside js/game/)`);
  console.log(`${mode.toUpperCase()} OK (${scenarios.length} scenarios, ${scenarios.reduce((sum, s) => sum + s.ticks, 0)} ticks), ${((performance.now() - start) / 1000).toFixed(2)}s`);
}
