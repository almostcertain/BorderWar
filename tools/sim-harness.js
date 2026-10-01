'use strict';
const crypto = require('node:crypto');
const { fs, path, vm, root, loader, stable } = require('./split-common');
const mode = process.argv[2];
if (!['record', 'compare', 'baseline', 'neutral'].includes(mode)) throw new Error('Usage: node tools/sim-harness.js record|compare|baseline|neutral [--perturb]');
const perturb = process.argv.includes('--perturb');
if (perturb && mode !== 'compare') throw new Error('--perturb is compare-only');
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
if (only && mode !== 'neutral') throw new Error('--only is neutral-only');
if (only) {
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
const totals = Object.fromEntries(methods.map(k => [k, 0]));
const suitePeaks = Object.fromEntries(entities.map(k => [k, 0]));
const results = [];
for (const cfg of scenarios) {
  const began = performance.now();
  const target = path.join(root, 'tools/golden', `${cfg.name}.json`);
  const golden = mode === 'compare' ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  if (golden) checkManifest(golden.manifest, cfg.name);
  const expected = golden ? Object.fromEntries(Object.entries(golden).filter(([key]) => key !== 'manifest')) : null;
  if (expected && JSON.stringify(expected.scenario) !== JSON.stringify(cfg)) throw new Error(`${cfg.name}: scenario configuration changed`);
  const ctx = vm.createContext({ console });
  // Fail immediately if simulation code starts consuming nondeterministic input.
  vm.runInContext('Math.random = () => { throw new Error("Math.random in simulation"); }; Date = class { constructor() { throw new Error("Date in simulation"); } static now() { throw new Error("Date.now in simulation"); } };', ctx);
  for (const { file, bytes } of sources) {
    vm.runInContext(bytes.toString('utf8'), ctx, { filename: file });
  }
  const { Game, GameMap, Hash } = vm.runInContext('({ Game, GameMap, Hash })', ctx);
  const coverage = Object.fromEntries(methods.map(k => [k, 0]));
  for (const name of methods) {
    const original = Game[name];
    if (typeof original !== 'function') throw new Error(`Missing method ${name}`);
    Game[name] = function (...args) { coverage[name]++; return original.apply(this, args); };
  }
  if (cfg.map === 'world') {
    // No fetch() in this harness (nor in the sim it's checking, on purpose —
    // see js/net/worldmap.js) — read the same static asset a browser would
    // fetch directly off disk instead.
    const worldManifest = JSON.parse(fs.readFileSync(path.join(root, 'maps/world/manifest.json'), 'utf8'));
    const worldBytes = fs.readFileSync(path.join(root, 'maps/world/map.bin'));
    GameMap.worldData = { manifest: worldManifest.map, bytes: new Uint8Array(worldBytes.buffer, worldBytes.byteOffset, worldBytes.length) };
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
