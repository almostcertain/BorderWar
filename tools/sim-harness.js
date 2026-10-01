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
const NEUTRAL_ALLOWED = [];
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
  const sim = vm.runInContext('({ Game, GameMap, Hash, Executor })', ctx);
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
  { name: 'fog-crowded-small-12345', size: 'small', seed: 12345, bots: 40, tribes: 12, ticks: 2000, fogOfWar: true }
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

  // Groups: none for a tribe, one per team, one each for everyone else.
  const groupByKey = new Map();
  for (const p of Game.players) {
    const g = groupOf[p.id];
    if (p.isTribe) { if (g !== -1) fail(`tribe ${name(p.id)} has vision group ${g}`); continue; }
    if (!(g >= 0 && g < G)) fail(`${name(p.id)} has no vision group`);
    const key = Game.teams && p.team ? `team:${p.team}` : `player:${p.id}`;
    if (groupByKey.has(key) ? groupByKey.get(key) !== g : [...groupByKey.values()].includes(g)) fail(`vision groups do not follow teams at ${name(p.id)}`);
    groupByKey.set(key, g);
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
    const want = a.id === b.id || g < 0 || g === groupOf[b.id] || fogHas(met, b.id * W, g);
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
  return { groups: Game.visionGroups, words: Game.visionWords, cells: total, humanDiscoveredPct: pct(Game.visionGroupOf[0]),
    minPct: Math.min(...all), maxPct: Math.max(...all), metPairs: `${metPairs}/${pairs}` };
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
  // Right after an alliance forms the two sides have met and hold one map.
  const accept = Game.acceptAlliance;
  Game.acceptAlliance = function (req) {
    const ok = accept.call(this, req);
    if (!ok) return ok;
    const ga = this.visionGroupOf[req.from], gb = this.visionGroupOf[req.to];
    if (!this.hasMet(req.from, req.to) || !this.hasMet(req.to, req.from)) throw new Error(`FOG INVARIANT ${cfg.name}: new allies ${req.from} and ${req.to} have not met`);
    for (let base = 0; base < this.visionCells.length; base += this.visionWords) {
      if (fogHas(this.visionCells, base, ga) !== fogHas(this.visionCells, base, gb)) throw new Error(`FOG INVARIANT ${cfg.name}: new allies ${req.from} and ${req.to} hold different maps`);
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
  return { checkpoints, digest: digest(Game, GameMap), simulationTicks: Game.ticks, coverage, stats: fogStats(sim) };
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
        if (dx * dx + dy * dy <= r2 && x >= 0 && y >= 0 && x < cw && y < ch) want[g][y * cw + x] = 1;
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
  const cfg = { name: 'fog-off-small-12345', size: 'small', seed: 12345, bots: 8, tribes: 12, ticks: 6000 };
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
  fogSpawnControl();
  fogSpawnMultiHuman();
  const fogTotals = Object.fromEntries(fogMethods.map(k => [k, 0]));
  for (const cfg of kept) {
    const began = performance.now();
    fogSpawnChecks(cfg);
    const first = fogRun(cfg, false), second = fogRun(cfg, true);
    for (let i = 0; i < first.checkpoints.length; i++) {
      const p = first.checkpoints[i], q = second.checkpoints[i];
      if (p.hash !== q.hash) throw new Error(`FOG DIVERGENCE ${cfg.name} tick ${p.tick}: run 1 ${p.hash}, run 2 ${q.hash}`);
    }
    for (const key of ['digest', 'simulationTicks', 'coverage']) {
      if (JSON.stringify(first[key]) !== JSON.stringify(second[key])) throw new Error(`FOG DIVERGENCE ${cfg.name}: final ${key} differs between the two runs`);
    }
    for (const name of fogMethods) fogTotals[name] += first.coverage[name];
    console.log(`${cfg.name}: 2 x ${cfg.ticks} ticks (${first.simulationTicks} simulation ticks), ${first.checkpoints.length} checkpoints identical, final hash ${first.checkpoints[first.checkpoints.length - 1].hash}, ownerFNV ${first.digest.ownerFNV}, ${((performance.now() - began) / 1000).toFixed(2)}s`);
    console.log('Vision:', JSON.stringify(first.stats));
  }
  console.log('Coverage:', JSON.stringify(fogTotals));
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
