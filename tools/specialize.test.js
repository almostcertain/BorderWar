// node --test tools/specialize.test.js
// City specializations (js/game/specialize.js, docs/city-specialization.md):
// the rules, the fee, each effect, capture, and bots using it in a real match.
const test = require('node:test');
const assert = require('node:assert');
const { fs, path, vm, root, loader } = require('./split-common');

function boot(cfg) {
  const names = loader();
  const sources = names.slice(0, names.indexOf('ai') + 1)
    .filter(n => !['render', 'input', 'ui', 'radial', 'main'].includes(n));
  const ctx = vm.createContext({ console });
  for (const n of sources) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', n + '.js'), 'utf8'), ctx, { filename: n });
  }
  const sim = vm.runInContext('({ Game, GameMap, Hash, Executor, Protocol })', ctx);
  sim.Game.init(sim.Hash._syntheticGameStartInfo(cfg), 0);
  sim.Game.chooseSpawn(sim.Hash.firstLegalSpawn());
  until(sim, () => !sim.Game.spawning);
  return sim;
}

// Ticks until `done`, failing rather than hanging if it never comes.
function until(sim, done) {
  for (let n = 0; !done(); n++) {
    assert.ok(n < 5000, 'sim never got there (running: ' + sim.Game.running + ')');
    sim.Game.tick();
  }
}

// The human with gold to spend. One bot, or the match is won on tick one.
function solo() {
  const sim = boot({ size: 'small', seed: 12345, bots: 1, tribes: 0 });
  sim.me = sim.Game.players[0];
  sim.me.gold = 1e9;
  return sim;
}

// Builds a City on the player's land and raises it to `level`.
function cityAt(sim, level, skip) {
  const { Game } = sim;
  let tile = -1, n = skip || 0;
  for (const t of sim.me.tiles) {
    if (!Game.buildBlockReason(0, 'city', t) && n-- <= 0) { tile = t; break; }
  }
  assert.ok(tile >= 0, 'a site for the city');
  assert.ok(Game.build(0, 'city', tile));
  const b = Game.buildings.get(tile);
  until(sim, () => b.built);
  for (let want = 2; want <= level; want++) {
    assert.ok(Game.upgrade(0, tile));
    until(sim, () => b.level === want);
  }
  return b;
}

test('only a level 3 City, once', () => {
  const sim = solo(), { Game } = sim;
  const b = cityAt(sim, 2);
  assert.match(Game.specializeBlockReason(0, b.tile, 'metropolis'), /level 3/);
  assert.equal(Game.specialize(0, b.tile, 'metropolis'), false);
  Game.upgrade(0, b.tile);
  until(sim, () => b.level === 3);
  assert.equal(Game.specializeBlockReason(0, b.tile, 'nonsense'), 'Unknown specialization');
  assert.equal(Game.specializeBlockReason(0, b.tile), null);
  assert.ok(Game.specialize(0, b.tile, 'metropolis'));
  assert.equal(b.spec, 'metropolis');
  assert.equal(Game.specializeBlockReason(0, b.tile, 'treasury'), 'Already specialized');
});

test('fee doubles across types and needs the gold', () => {
  const sim = solo(), { Game } = sim;
  const a = cityAt(sim, 3, 0), b = cityAt(sim, 3, 0), c = cityAt(sim, 3, 0);
  assert.equal(Game.specCost(sim.me), 250000);
  let before = sim.me.gold;
  Game.specialize(0, a.tile, 'metropolis');
  assert.equal(before - sim.me.gold, 250000);
  assert.equal(Game.specCost(sim.me), 500000);
  before = sim.me.gold;
  Game.specialize(0, b.tile, 'treasury');
  assert.equal(before - sim.me.gold, 500000);
  Game.tick();
  assert.equal(Game.specCost(sim.me), 1000000);
  sim.me.gold = 999999;
  assert.equal(Game.specializeBlockReason(0, c.tile, 'garrison'), 'Not enough gold');
});

test('Metropolis raises the cap per level', () => {
  const sim = solo(), { Game } = sim;
  const b = cityAt(sim, 3);
  const cap = Game.maxTroops(sim.me);
  Game.specialize(0, b.tile, 'metropolis');
  assert.equal(Math.round(Game.maxTroops(sim.me) - cap), 45000);
  Game.upgrade(0, b.tile);
  until(sim, () => b.level === 4);
  Game.tick();
  // One more city level (25k) plus one more Metropolis level (15k).
  assert.equal(Math.round(Game.maxTroops(sim.me) - cap), 85000);
});

test('Treasury and Garrison Town', () => {
  const sim = solo(), { Game } = sim;
  const a = cityAt(sim, 3), b = cityAt(sim, 3);
  sim.me.troops = Game.maxTroops(sim.me) * 0.3;
  const gold = Game.goldPerSecond(sim.me), growth = Game.growthPerSecond(sim.me);
  Game.specialize(0, a.tile, 'treasury');
  Game.specialize(0, b.tile, 'garrison');
  assert.equal(Game.goldPerSecond(sim.me) - gold, 1500);
  assert.ok(Math.abs(Game.growthPerSecond(sim.me) / growth - 1.15) < 1e-9);
  sim.me.spec.garrison = 99;
  assert.ok(Math.abs(Game.growthPerSecond(sim.me) / growth - 1.5) < 1e-9, 'capped');
});

test('Trade Hub scales a train stop', () => {
  const sim = solo(), { Game } = sim;
  const b = cityAt(sim, 3);
  assert.equal(Game.specTrainGold(b, 10000), 10000);
  Game.specialize(0, b.tile, 'tradehub');
  assert.equal(Game.specTrainGold(b, 10000), 17500);
});

test('survives capture and follows the new owner', () => {
  const sim = solo(), { Game } = sim;
  const b = cityAt(sim, 3);
  Game.specialize(0, b.tile, 'metropolis');
  Game.tick();
  assert.equal(sim.me.spec.metropolis, 3);
  const foe = Game.players[1];
  Game.setOwner(b.tile, 1);
  Game.updateSpecTotals();
  assert.equal(b.spec, 'metropolis');
  assert.equal(sim.me.spec.held, 0);
  assert.equal(foe.spec.metropolis, 3);
  // Captured, not bought: the captor's own price has not moved.
  assert.equal(Game.specCost(foe), 250000);
  assert.equal(Game.specCost(sim.me), 250000);
});

test('the intent validates and reaches the sim', () => {
  const sim = solo(), { Game, Protocol, Executor } = sim;
  const b = cityAt(sim, 3);
  assert.ok(Protocol.validateIntent(Protocol.intent.specializeStructure(b.tile, 'bogus')));
  const it = Protocol.intent.specializeStructure(b.tile, 'treasury');
  assert.equal(Protocol.validateIntent(it), null);
  assert.ok(Executor.HANDLERS.specialize_structure(0, it));
  assert.equal(b.spec, 'treasury');
});

test('bots specialize in a real match', () => {
  const sim = boot({ size: 'medium', seed: 12345, bots: 10, tribes: 10 }), { Game } = sim;
  for (let t = 0; t < 9000 && Game.running; t++) Game.tick();
  const counts = {};
  for (const b of Game.buildings.values()) if (b.spec) counts[b.spec] = (counts[b.spec] || 0) + 1;
  console.log('after', Game.ticks, 'ticks:', JSON.stringify(counts));
  assert.ok(Object.keys(counts).length > 0, 'at least one specialized city');
  for (const p of Game.players) if (p.isTribe) assert.equal(p.specsBought, 0);
});
