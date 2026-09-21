// Enough distinct hues to fill a crowded Extra Large map without two nations
// sharing a colour. Ordered so that the first handful stay far apart, which is
// what a small game actually sees.
const PLAYER_COLORS = [
  [ 90, 160, 255], [235,  90,  90], [ 95, 205, 130], [245, 175,  70],
  [190, 120, 240], [ 80, 215, 215], [240, 130, 195], [175, 190,  95],
  [130, 145, 235], [225, 120,  60], [110, 200, 175], [205,  95, 150],
  [140, 210, 255], [255, 140, 110], [ 70, 170,  95], [215, 200,  90],
  [155,  95, 210], [ 60, 165, 185], [255, 175, 210], [125, 150,  70],
  [ 95, 110, 200], [190,  85,  45], [150, 225, 200], [235, 145, 175],
  [175, 205, 255], [200,  70,  95], [125, 235, 145], [205, 150,  60],
  [225, 175, 255], [ 45, 130, 150], [255, 205, 130], [ 90, 125, 115]
];

const BOT_NAMES = [
  'Varra', 'Kessel', 'Dorne', 'Ashfall', 'Mirek', 'Solane', 'Torvik', 'Halcyon',
  'Brackwater', 'Ondar', 'Vesper', 'Karth', 'Selvane', 'Cadros', 'Umbra', 'Feltmark',
  'Nyral', 'Hastrel', 'Drakemoor', 'Iselle', 'Corvane', 'Ptarmis', 'Weldenreach', 'Oskaia',
  'Tanvar', 'Ryndel', 'Jocelan', 'Almace', 'Verdholt', 'Sarnis', 'Kolveig', 'Enthara'
];

// OpenFront calls this player type "Bots" internally and shows them in-game
// as "Tribes" (openfront.wiki/Bots, openfront.wiki/Tribes) — filler AI that
// nibbles a few tiles at a time, never builds, never allies, never sails.
// Their real names are "two randomly-generated words"; these two banks are
// combined with a coprime stride (gcd(7,16)=1, and 6i=13 mod 16 has no
// solution) so no index ever pairs a word with itself.
const TRIBE_NAME_A = [
  'Grey', 'Ash', 'Old', 'Stone', 'Salt', 'Elm', 'Reed', 'Moss',
  'Flint', 'Thorn', 'Bramble', 'Hollow', 'Fen', 'Bluff', 'Marsh', 'Wren'
];
const TRIBE_NAME_B = [
  'Hollow', 'Warren', 'Reach', 'Hold', 'Camp', 'Fen', 'Bluff', 'Marsh',
  'Glade', 'Watch', 'Vale', 'Ridge', 'Bend', 'Crag', 'Mire', 'Yard'
];
function tribeName(i) {
  return TRIBE_NAME_A[i % 16] + ' ' + TRIBE_NAME_B[(i * 7 + 3) % 16];
}

// Muted, low-saturation earth tones — deliberately duller than PLAYER_COLORS'
// vivid hues so a tribe reads as wilderness-to-be-conquered at a glance,
// distinct from the Nations actually contesting the map.
const TRIBE_COLORS = [
  [150, 140, 120], [130, 120, 100], [110, 100,  85], [160, 150, 130],
  [120, 115,  95], [140, 125, 105], [100,  95,  80], [155, 140, 115],
  [125, 110,  90], [145, 135, 115], [115, 105,  90], [135, 120, 100],
  [105, 100,  90], [150, 130, 105], [120, 110, 100], [140, 130, 110],
  [110, 115, 100], [130, 125, 110], [145, 140, 125], [100, 105,  95]
];

// Troop counts, never wider than four digits: 9999 -> 10k -> 999k -> 1.2M.
function formatCount(n) {
  n = Math.max(0, Math.floor(n));
  if (n < 10000) return String(n);
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  if (n < 1e7) return (n / 1e6).toFixed(1) + 'M';
  return Math.round(n / 1e6) + 'M';
}

// Population readout for front pushes and the label floating over each
// player: below 1k it's an exact count ("455"); from 1k up to 100k it
// keeps one decimal so movement is still visible tick to tick ("55.6K");
// past 100k the digit-to-digit jitter isn't worth reading, so it rounds.
function formatCountTight(n) {
  n = Math.max(0, n);
  if (n < 1000) return String(Math.round(n));
  if (n < 1e5) return (n / 1000).toFixed(1) + 'K';
  const k = Math.round(n / 1000);
  if (k < 1000) return k + 'K';
  return Math.round(n / 1e6) + 'M';
}

// Population readout for the hover panel: one decimal place in the thousands
// (e.g. "7.6k"), matching OpenFront's stat-bar style rather than formatCount's
// rounded-to-nearest-k, which loses too much precision for a bar this small.
function formatPop(n) {
  n = Math.max(0, n);
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

// Treasury readout. Gold runs to six and seven figures long before troops do,
// so it keeps a decimal in the thousands rather than formatCount's rounding —
// at a four-figure income a "612k" display would sit still for whole seconds,
// and a "1.2M" one for a minute and a half.
function formatGold(n) {
  n = Math.max(0, n);
  if (n < 1000) return String(Math.floor(n));
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Collapse the last few, disputed bits of a float onto a value every engine
// agrees on. See Game.det below for why this exists at all; this is just the
// quantizer itself.
//
// Relative (12 significant digits), not a fixed grid. An earlier draft of
// docs/multiplayer-architecture.md called for Math.round(v * 1e9) / 1e9 — that
// is wrong: v * 1e9 passes Number.MAX_SAFE_INTEGER (~9.0e15) as soon as v is
// above roughly 9e6, and maxTroopsRaw/growthPerSecond on a large empire are
// comfortably past that, so a fixed grid silently loses precision exactly
// where the numbers get big. toPrecision holds at every magnitude, and
// ECMA-262 specifies it as correctly rounded, so the quantizer is itself
// deterministic.
//
// NaN and ±Infinity pass straight through — "Infinity".toPrecision() is a
// string that would round-trip fine but there is nothing to quantize, and
// running non-finite values through the string path is pure risk for no gain.
// Zero passes through too, which also preserves -0 (since -0 === 0).
function detQuantize(v) {
  if (!Number.isFinite(v) || v === 0) return v;
  return Number(v.toPrecision(12));
}

