// Re-runs a submitted Daily Challenge replay through the real sim and scores
// it (docs/daily-leaderboard.md). Runs as a child process of the server, one
// job per process: the sim is loaded into this process's own globals (about 3x
// faster than a vm sandbox) and must never block the game server's event loop.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// The sim's scripts, in index.html's load order, up to the bots.
function simFiles() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/\[([^\]]+)\]\.forEach\(name\s*=>/);
  if (!m) throw new Error('cannot find the script list in index.html');
  const names = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  const skip = new Set(['render', 'input', 'ui', 'radial', 'main', 'perf', 'watch']);
  return names.slice(0, names.indexOf('ai') + 1).filter(n => !skip.has(n))
    .map(n => 'js/' + n + '.js').concat(['js/daily-core.js']);
}

let booted = false;
function boot() {
  if (booted) throw new Error('one verify per process');
  booted = true;
  for (const f of simFiles()) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  return vm.runInThisContext('({ Game, GameMap, Hash, Executor, Protocol, Replay, DailyCore })');
}

class Rejected extends Error {}

// The settings a daily's gameStartInfo must carry, as LocalServer.start writes them.
function expectedConfig(sim, day) {
  const c = sim.DailyCore.challenge(day).config;
  return {
    seed: c.seed >>> 0,
    config: {
      map: sim.Protocol.normalizeMap(c.map), mapSize: c.mapSize, mapGen: sim.Protocol.normalizeMapGen(c.mapGen),
      bots: c.bots | 0, tribes: c.tribes | 0, difficulty: c.difficulty, gameMode: 'ffa',
      fogOfWar: c.fogOfWar === true, pointsOfInterest: c.pointsOfInterest === true
    }
  };
}

function sameSettings(sim, info, day) {
  const want = expectedConfig(sim, day), cfg = info.config || {};
  if (info.seed !== want.seed) return false;
  for (const k of Object.keys(want.config)) {
    if (JSON.stringify(cfg[k]) !== JSON.stringify(want.config[k])) return false;
  }
  return cfg.playerTeams === undefined || cfg.playerTeams === null;
}

// Returns { score, won, secs, place, nations, peak, title, turns } or throws
// Rejected with a message for the player.
function verify(record, day, opts) {
  opts = opts || {};
  const sim = boot();
  const { Game, GameMap, Hash, Executor, Protocol, Replay, DailyCore } = sim;
  const err = Replay.validate(record);
  if (err) throw new Rejected(err);
  const info = record.gameStartInfo;
  const players = info.players;
  if (!Array.isArray(players) || players.length !== 1 || players[0].playerId !== 0 ||
      players[0].clientID !== record.myClientID || record.myPlayerId !== 0) {
    throw new Rejected('Not a Daily Challenge match.');
  }
  if (!sameSettings(sim, info, day)) throw new Rejected('Not Daily Challenge #' + day + '.');
  const maxTurns = opts.maxTurns || 54000;
  if (record.turnCount > maxTurns) throw new Rejected('Match too long to check.');

  Executor.setRoster(players);
  Game.init(info, 0);
  const byTurn = new Map(record.turns.map(t => [t[0], t[1]]));
  const hashes = new Map(record.hashes.map(h => [h[0], h[1]]));
  const tr = DailyCore.tracker();
  let title = null, turn = 0;
  for (; turn < record.turnCount; turn++) {
    Executor.applyTurn({ turnNumber: turn, intents: byTurn.get(turn) || [] });
    Game.tick();
    if (turn % Protocol.HASH_INTERVAL === 0 && hashes.has(turn) && Hash.compute() !== hashes.get(turn)) {
      throw new Rejected('This match was played on a different version of the game.');
    }
    DailyCore.step(tr, Game, GameMap, 0);
    title = DailyCore.endTitle(Game, 0);
    if (title) { turn++; break; }
  }
  if (!title) {
    if (Game.spawning) throw new Rejected('The match ended before it began.');
    title = 'Left';
  }
  const e = DailyCore.settle(tr, Game, GameMap, 0, title);
  if (!e.won && e.secs < DailyCore.MIN_SECS) throw new Rejected('Too short to count.');
  return {
    score: DailyCore.score(e), won: e.won, secs: e.secs, place: e.place, nations: e.nations,
    peak: Math.round(e.peakPct * 10) / 10, title, turns: turn
  };
}

module.exports = { verify, Rejected, simFiles };

if (require.main === module) {
  process.once('message', (job) => {
    let out;
    try {
      out = { ok: true, result: verify(job.record, job.day, job.opts) };
    } catch (e) {
      out = e instanceof Rejected ? { ok: false, message: e.message }
        : { ok: false, message: 'The server could not check this match.', crash: String(e && e.stack || e) };
    }
    process.send(out, () => process.exit(0));
  });
}
