// js/game/teams.js — Team game modes (issue #31), after OpenFront.
//
// Ported from OpenFront's Game.ts (GameMode, ColoredTeams, Duos/Trios/Quads/
// HumansVsNations), TeamAssignment.ts (resolveTeamsList, assignTeams,
// getMaxTeamSize), GameImpl.addPlayers/maybeAssignTeam, PlayerImpl
// (isOnSameTeam/isFriendly), WinCheckExecution.checkWinnerTeam and the client
// theme's teamColors/generateTeamColors.
//
// The lobby config carries two fields, both in gameStartInfo.config so every
// lockstep client builds the same teams:
//   gameMode:    'ffa' (default, and anything unrecognised) | 'team'
//   playerTeams: an integer team count (2+), or 'Duos' | 'Trios' | 'Quads' |
//                'Humans Vs Nations' — OpenFront's TeamCountConfig verbatim.
//
// Teammates are made friendly by adding each to the others' `allies` set at
// init, with no Alliance record behind it. That routes them through every
// existing areAllied / p.allies check (attacks, boats, nukes, SAMs, warships,
// port trade, annexation, AI targeting) without touching those call sites,
// and since no record exists the pairing can't be broken, expire or be
// renegotiated — breakAlliance and updateDiplomacy only ever act on records.
//
// FFA DIGEST NOTE: tools/sim-harness.js digests every data key on Game and
// every field on every player. So this file keeps its constants on its own
// `Teams` global rather than on Game, and the per-match state (Game.teams,
// Game.winnerTeam, p.team) only exists in a team game — an FFA match has
// exactly the keys it had before this mode existed.
const Teams = {
  MODE_FFA: 'ffa',
  MODE_TEAM: 'team',
  DUOS: 'Duos',
  TRIOS: 'Trios',
  QUADS: 'Quads',
  HUMANS_VS_NATIONS: 'Humans Vs Nations',

  // OpenFront's PERCENT_TILES_OWNED_TO_WIN (Config.percentageTilesOwnedToWin,
  // overtime off). Current upstream uses the same 80 for FFA and teams; this
  // port's FFA check still uses its own 95% (issue #33 is where that moves),
  // so only team games use this.
  WIN_PERCENT: 80,

  // default-theme.json's teamColors.
  COLORS: {
    Red: '#eb3333', Blue: '#2962ff', Teal: '#06b6d4', Purple: '#9234ea',
    Yellow: '#e7b008', Orange: '#ff7f0e', Green: '#41be52',
    Humans: '#2962ff', Nations: '#eb3333'
  },

  // Whitelists a lobby's mode fields. null means free-for-all.
  normalize(config) {
    config = config || {};
    if (config.gameMode !== this.MODE_TEAM) return null;
    const pt = config.playerTeams;
    if (pt === this.DUOS || pt === this.TRIOS || pt === this.QUADS || pt === this.HUMANS_VS_NATIONS) return pt;
    if (Number.isInteger(pt) && pt >= 2) return pt;
    return 2;
  },

  isDuosTriosQuads(pt) { return pt === this.DUOS || pt === this.TRIOS || pt === this.QUADS; },

  // TeamAssignment.resolveTeamsList.
  resolveTeamsList(pt, totalPlayers) {
    if (pt === this.HUMANS_VS_NATIONS) return ['Humans', 'Nations'];
    let numTeams;
    if (typeof pt !== 'number') {
      const divisor = pt === this.DUOS ? 2 : pt === this.TRIOS ? 3 : 4;
      numTeams = Math.max(2, Math.ceil(totalPlayers / divisor));
    } else {
      numTeams = pt;
    }
    if (numTeams < 8) {
      const teams = ['Red', 'Blue'];
      if (numTeams >= 3) teams.push('Yellow');
      if (numTeams >= 4) teams.push('Green');
      if (numTeams >= 5) teams.push('Purple');
      if (numTeams >= 6) teams.push('Orange');
      if (numTeams >= 7) teams.push('Teal');
      return teams;
    }
    const out = [];
    for (let i = 0; i < numTeams; i++) out.push('Team ' + (i + 1));
    return out;
  },

  // Base colour of a team as [r, g, b]. "Team N" names (8+ teams) have no
  // theme entry upstream either — they fall back to a player palette colour.
  baseColor(team, index) {
    const hex = this.COLORS[team];
    if (!hex) return PLAYER_COLORS[index % PLAYER_COLORS.length].slice();
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  },

  // generateTeamColors: index 0 is the base colour; later members spread
  // hue ±6° (golden-angle stepped), saturation ±10% and lightness ±18 around
  // it, lightness clamped 25..80, so teammates read as one team but can still
  // be told apart. Upstream works in LCH with Math.sin; this uses HSL and a
  // triangle wave instead, so it is plain arithmetic. Cosmetic either way:
  // nothing in the sim reads p.color.
  variation(rgb, k) {
    if (k === 0) return rgb.slice();
    // Triangle wave standing in for sin: 0 at x=0, period 1, range [-1, 1].
    const wave = x => { const y = x + 0.25, f = y - Math.floor(y); return 1 - 4 * Math.abs(f - 0.5); };
    const golden = 137.508;
    let [h, s, l] = this.rgbToHsl(rgb);
    h = (h + ((k * golden) % 12) - 6 + 360) % 360;
    s = Math.max(10, Math.min(100, s * (1 + 0.1 * wave(k * 0.7 / (2 * Math.PI)))));
    l = Math.max(25, Math.min(80, l + 18 * wave(k * golden / 360)));
    return this.hslToRgb(h, s, l);
  },

  rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  },

  hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
};

Object.assign(Game, {
  // Called from init() once the players exist. FFA returns before touching
  // anything (and before any rng draw), so an FFA match is unchanged.
  setupTeams(config, humanCount, botCount) {
    delete this.teams;
    delete this.winnerTeam;
    const pt = Teams.normalize(config);
    if (pt === null) return;

    const humans = this.players.slice(0, humanCount);
    const nations = this.players.slice(humanCount, humanCount + botCount);
    let teams;
    if (pt === Teams.HUMANS_VS_NATIONS) {
      teams = ['Humans', 'Nations'];
      for (const p of humans) p.team = 'Humans';
      for (const p of nations) p.team = 'Nations';
    } else {
      teams = Teams.resolveTeamsList(pt, humans.length + nations.length);
      this.assignTeams(humans, nations, teams, Teams.isDuosTriosQuads(pt));
    }
    this.teams = teams;

    // Tribes are OpenFront's Bot team, which isOnSameTeam never matches —
    // teamless here, so they stay everyone's target and never win.
    for (const p of this.players) if (p.team === undefined) p.team = null;

    // Mutual friendship, in id order. Colours: each team's members, in id
    // order, take successive variations of its base colour.
    const seen = new Map();
    for (const p of this.players) {
      if (!p.team) continue;
      const k = seen.get(p.team) || 0;
      seen.set(p.team, k + 1);
      p.color = Teams.variation(Teams.baseColor(p.team, teams.indexOf(p.team)), k);
      for (const q of this.players) {
        if (q !== p && q.team === p.team) p.allies.add(q.id);
      }
    }
  },

  // TeamAssignment.assignTeams, minus clans and friends (neither exists
  // here) and the matchmaker's pinned slots. Humans first in roster order,
  // then nations in a shuffled order — upstream shuffles with a PseudoRandom
  // seeded off the first nation's id; this draws from Game.rng. Duos/Trios/
  // Quads fill the fullest team that still has room (so teams complete one
  // at a time); a fixed team count fills the emptiest.
  assignTeams(humans, nations, teams, isDuosTriosQuads) {
    const order = humans.slice();
    const shuffled = nations.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    order.push(...shuffled);

    const maxTeamSize = Math.ceil(order.length / teams.length);
    const counts = new Map(teams.map(t => [t, 0]));
    for (const p of order) {
      let best = null, bestSize = isDuosTriosQuads ? -1 : Infinity;
      for (const t of teams) {
        const size = counts.get(t);
        if (size >= maxTeamSize) continue;
        if (isDuosTriosQuads ? size > bestSize : size < bestSize) { best = t; bestSize = size; }
      }
      // Upstream "kicks" a player no team has room for; without clans that
      // can't happen, but leave them teamless rather than fail if it does.
      p.team = best;
      if (best !== null) counts.set(best, counts.get(best) + 1);
    }
  },

  isTeamGame() { return !!this.teams; },

  teamOf(id) {
    const p = id >= 0 ? this.players[id] : null;
    return (p && p.team) || null;
  },

  // PlayerImpl.isOnSameTeam.
  onSameTeam(a, b) {
    if (!this.teams || a === b) return false;
    const ta = this.teamOf(a);
    return ta !== null && ta === this.teamOf(b);
  },

  teamTiles(team) {
    let n = 0;
    for (const p of this.players) if (p.alive && p.team === team) n += p.tiles.size;
    return n;
  },

  // WinCheckExecution.checkWinnerTeam: the team holding the most land wins
  // once its combined share of non-fallout land passes WIN_PERCENT. Plus
  // this port's own last-side-standing rule (the FFA check has it too): if
  // every nation still holding land is on one team and no tribe is left, that
  // team has won. Sets winnerTeam, and winnerId to that team's biggest member
  // so the existing winner vote and hash keep working unchanged.
  checkTeamWin() {
    if (this.winnerId !== null) return;
    const tiles = new Map(this.teams.map(t => [t, 0]));
    let others = 0;
    const standing = new Set();
    for (const p of this.players) {
      if (!p.alive || p.tiles.size === 0) continue;
      if (p.team) { tiles.set(p.team, tiles.get(p.team) + p.tiles.size); standing.add(p.team); }
      else others++;
    }

    let winner = null;
    if (standing.size === 1 && others === 0) {
      winner = standing.values().next().value;
    } else {
      let top = null, topTiles = -1;
      for (const t of this.teams) {
        if (tiles.get(t) > topTiles) { top = t; topTiles = tiles.get(t); }
      }
      const denominator = GameMap.landTiles - this.fallout.size;
      if (denominator > 0 && topTiles * 100 > denominator * Teams.WIN_PERCENT) winner = top;
    }
    if (winner === null) return;

    let best = null;
    for (const p of this.players) {
      if (p.team !== winner || !p.alive) continue;
      if (!best || p.tiles.size > best.tiles.size) best = p;
    }
    this.winnerTeam = winner;
    this.winnerId = best ? best.id : null;
    if (this.winnerId !== null) this.running = false;
  },

  // PlayerImpl.canBuild's nuke rules for team games: no nuking a teammate's
  // land, and no nuke whose outer blast radius would reach a teammate's
  // structure (upstream exempts MIRVs from the second rule). null in FFA.
  teamNukeBlockReason(playerId, nukeType, clickTile) {
    if (!this.teams || clickTile < 0) return null;
    if (this.onSameTeam(playerId, GameMap.owner[clickTile])) return 'Cannot nuke a teammate';
    const magnitude = this.NUKE_MAGNITUDES[nukeType];
    if (!magnitude || nukeType === 'mirv') return null;
    const outer2 = magnitude.outer * magnitude.outer;
    for (const b of this.buildings.values()) {
      if (this.tileDistSq(clickTile, b.tile) < outer2 &&this.onSameTeam(playerId, GameMap.owner[b.tile])) {
        return 'Would hit a teammate';
      }
    }
    return null;
  }
});
