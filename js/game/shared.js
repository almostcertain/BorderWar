// Enough distinct hues that nations on a crowded map don't share a colour.
// Ordered so the first handful stay far apart.
// Append only, never reorder: the golden tests' low bot/tribe counts index
// the first 32 via `% .length`, and inserting earlier would shift those
// indices and break every recorded golden.
const PLAYER_COLORS = [
  [ 90, 160, 255], [235,  90,  90], [ 95, 205, 130], [245, 175,  70],
  [190, 120, 240], [ 80, 215, 215], [240, 130, 195], [175, 190,  95],
  [130, 145, 235], [225, 120,  60], [110, 200, 175], [205,  95, 150],
  [140, 210, 255], [255, 140, 110], [ 70, 170,  95], [215, 200,  90],
  [155,  95, 210], [ 60, 165, 185], [255, 175, 210], [125, 150,  70],
  [ 95, 110, 200], [190,  85,  45], [150, 225, 200], [235, 145, 175],
  [175, 205, 255], [200,  70,  95], [125, 235, 145], [205, 150,  60],
  [225, 175, 255], [ 45, 130, 150], [255, 205, 130], [ 90, 125, 115],
  [235, 165, 205], [ 65, 145, 100], [215, 110, 190], [100, 180, 235],
  [230, 200, 140], [ 85, 200, 165], [180, 140, 255], [210, 235, 120],
  [150, 100, 70 ], [ 70, 210, 245], [245, 120, 130], [120, 160, 110],
  [200, 175, 220], [255, 150, 60 ], [110, 130, 175], [190, 220, 190],
  [160,  75, 130], [ 75, 175, 140], [235, 190,  90], [130, 115, 200],
  [220, 145, 100], [ 90, 205, 205], [175,  95,  95], [140, 225, 105],
  [205, 120, 225], [ 60, 140, 195], [255, 185, 165], [100, 145,  60],
  [190, 165, 255], [225,  80, 155], [115, 200, 130], [170, 170,  80],

  [ 77, 194, 203], [215,  80, 166], [133, 226,  85], [113, 118, 214],
  [213, 103,  68], [ 72, 224, 153], [191, 101, 210], [207, 221, 105],
  [ 59, 155, 222], [207,  89, 124], [ 94, 218,  93], [135,  98, 228],
  [203, 150,  77], [ 80, 215, 198], [226,  85, 204], [168, 214, 113],
  [ 68, 105, 213], [224,  77,  72], [101, 210, 137], [177, 105, 221],
  [222, 207,  59], [ 89, 183, 207], [218,  93, 156], [126, 228,  98],
  [ 87,  77, 203], [215, 130,  80], [ 85, 226, 178], [209, 113, 214],
  [177, 213,  68], [ 72, 142, 224], [210, 101, 120], [105, 221, 119],
  [126,  59, 222], [207, 172,  89], [ 93, 218, 218], [228,  98, 191],
  [130, 203,  77], [ 80,  98, 215], [226, 108,  85], [113, 214, 159]
];

const BOT_NAMES = [
  'Varra', 'Kessel', 'Dorne', 'Ashfall', 'Mirek', 'Solane', 'Torvik', 'Halcyon',
  'Brackwater', 'Ondar', 'Vesper', 'Karth', 'Selvane', 'Cadros', 'Umbra', 'Feltmark',
  'Nyral', 'Hastrel', 'Drakemoor', 'Iselle', 'Corvane', 'Ptarmis', 'Weldenreach', 'Oskaia',
  'Tanvar', 'Ryndel', 'Jocelan', 'Almace', 'Verdholt', 'Sarnis', 'Kolveig', 'Enthara',
  'Brenmoor', 'Calyx', 'Dresh', 'Eldrin', 'Fenwick', 'Gorrath', 'Harrow', 'Ithria',
  'Jareth', 'Kavros', 'Lorne', 'Mendrel', 'Norvash', 'Orlath', 'Pellyn', 'Quorin',
  'Ravendell', 'Sylth', 'Thane', 'Uskar', 'Vardrel', 'Wrenmark', 'Xandor', 'Ylvane',
  'Zerath', 'Ambrose', 'Brindal', 'Corwyth', 'Duskraven', 'Emberlyn', 'Fenrath', 'Grimshaw',

  'Alcombe', 'Bastian', 'Cindral', 'Delmora', 'Estwick', 'Farrow', 'Grethel', 'Holwick',
  'Isambard', 'Jettrel', 'Korvath', 'Linnith', 'Marrow', 'Nesbit', 'Ondrelle', 'Presket',
  'Quennith', 'Rothmere', 'Sabrelle', 'Trewick', 'Ulvane', 'Vantrell', 'Wexley', 'Yarrick',
  'Zelmora', 'Abington', 'Brellow', 'Croswick', 'Dettram', 'Everholt', 'Farnwick', 'Grisdale',
  'Hollowmere', 'Ivarrow', 'Jendrel', 'Kelmarsh', 'Lowther', 'Merrivale', 'Nordholt', 'Ostwick'
];

// Tribes: filler AI that never builds, allies or sails. Names are two
// words, combined from these banks with a coprime stride so no index
// pairs a word with itself.
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

// Same scale as formatGold, without the decimal digit — for the hover panel,
// which is glanced at from a distance and doesn't need the extra precision.
function formatGoldTight(n) {
  n = Math.max(0, n);
  if (n < 1000) return String(Math.floor(n));
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  return Math.round(n / 1e6) + 'M';
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
// agrees on (see Game.det).
//
// Relative (12 significant digits), not a fixed grid: Math.round(v * 1e9)
// passes Number.MAX_SAFE_INTEGER once v is above roughly 9e6, which large
// empires exceed. toPrecision holds at every magnitude and is specified as
// correctly rounded, so the quantizer is itself deterministic.
//
// NaN, ±Infinity and zero pass straight through (which preserves -0).
function detQuantize(v) {
  if (!Number.isFinite(v) || v === 0) return v;
  return Number(v.toPrecision(12));
}

