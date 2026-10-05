'use strict';
// Top functions by self time in a V8 .cpuprofile: where the CPU actually went,
// without the per-phase wrappers sim-profile.js uses. See docs/perf-tools.md.
//   node --cpu-prof --cpu-prof-dir=DIR tools/sim-profile.js 3000 world 12345 82 400
//   node tools/cpu-top.js DIR|FILE.cpuprofile [rows=40]
const fs = require('node:fs');
const path = require('node:path');
let file = process.argv[2];
const ROWS = +process.argv[3] || 40;
if (!file) { console.error('usage: node tools/cpu-top.js DIR|FILE.cpuprofile [rows]'); process.exit(1); }
if (fs.statSync(file).isDirectory()) {
  // The newest profile in the directory.
  const found = fs.readdirSync(file).filter(f => f.endsWith('.cpuprofile'))
    .map(f => path.join(file, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!found.length) { console.error('no .cpuprofile in', file); process.exit(1); }
  file = found[0];
}
const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const self = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const f = byId.get(profile.samples[i]).callFrame;
  const key = `${f.functionName || '(anonymous)'} ${path.basename(f.url)}:${f.lineNumber + 1}`;
  const dt = profile.timeDeltas[i];
  self.set(key, (self.get(key) || 0) + dt);
  total += dt;
}
console.log(file);
console.log('total', (total / 1e6).toFixed(1), 's');
for (const [key, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, ROWS)) {
  console.log((us / 1e3).toFixed(0).padStart(8), 'ms', (100 * us / total).toFixed(1).padStart(5) + '%', key);
}
