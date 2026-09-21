'use strict';
const { vm, read, loader, load, stable } = require('./split-common');
const baseline = ['tools/baseline/game.orig.js'];
// Before Step 1 the current game is the unchanged-copy candidate.
const candidate = loader().filter(n => n === 'game' || n.startsWith('game/')).map(n => `js/${n}.js`);
if (!candidate.length) throw new Error('No game scripts in loader');
function context(files) {
  const ctx = vm.createContext({ GameMap: {}, Fx: {}, AI: {}, TribeAI: {} });
  for (const file of files) {
    // Extension files must only add data properties, with no silent overwrite.
    // Compare before/after descriptors without modifying the loaded source.
    let before;
    try { before = vm.runInContext('Object.getOwnPropertyDescriptors(Game)', ctx); } catch (_) {}
    if (before) {
      const source = read(file);
      if (!/^\s*Object\.assign\(Game,\s*\{/m.test(source)) throw new Error(`${file}: expected Game extension`);
      // Observe the assign source before getters could be evaluated or keys lost.
      vm.runInContext(`Object.assign = ((assign) => function(target, ...sources) {
        if (target === Game) for (const source of sources) {
          for (const key of Reflect.ownKeys(source)) {
            const d = Object.getOwnPropertyDescriptor(source, key);
            if (d.get || d.set) throw new Error('Extension accessor: ' + String(key));
            if (Object.prototype.hasOwnProperty.call(target, key)) throw new Error('Duplicate Game property: ' + String(key));
          }
        }
        return assign(target, ...sources);
      })(Object.assign);`, ctx);
    }
    load(ctx, file);
  }
  return ctx;
}
const a = context(baseline), b = context(candidate);
const original = vm.runInContext('Game', a), current = vm.runInContext('Game', b);
const errors = [];
const equal = (x, y) => JSON.stringify(stable(x)) === JSON.stringify(stable(y));
const keys = new Set([...Reflect.ownKeys(original), ...Reflect.ownKeys(current)]);
for (const key of keys) {
  const x = Object.getOwnPropertyDescriptor(original, key);
  const y = Object.getOwnPropertyDescriptor(current, key);
  if (!x || !y) { errors.push(`${String(key)}: missing ${x ? 'candidate' : 'baseline'} property`); continue; }
  if (!equal(x, y)) errors.push(`${String(key)}: descriptor/value/function source differs`);
}
// Probe every identifier occurring in either source, in addition to globalThis
// keys. This includes lexical const/let/class globals invisible to Object.keys.
const identifiers = new Set([...baseline, ...candidate].flatMap(file => read(file).match(/[A-Za-z_$][\w$]*/g) || []));
function globals(ctx) {
  const names = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', ctx));
  for (const name of identifiers) {
    try {
      // Assignment-target parsing excludes keywords without assigning anything.
      new vm.Script(`() => { ${name} = 0; }`);
      vm.runInContext(name, ctx);
      names.add(name);
    } catch (_) { /* not an accessible global binding */ }
  }
  return [...names].sort();
}
const globalA = globals(a), globalB = globals(b);
for (const name of globalA) if (!globalB.includes(name)) errors.push(`Global ${name}: missing from candidate`);
for (const name of globalB) if (!globalA.includes(name)) errors.push(`Global ${name}: added by candidate`);
// Shared global values and helper function bodies also have to remain verbatim.
const empty = vm.createContext({ GameMap: {}, Fx: {}, AI: {}, TribeAI: {} });
const builtins = new Set(globals(empty));
for (const name of globals(a)) {
  if (name === 'Game' || builtins.has(name)) continue;
  try {
    if (!equal(vm.runInContext(name, a), vm.runInContext(name, b))) errors.push(`Global ${name}: value/source differs`);
  } catch (error) { errors.push(`Global ${name}: ${error.message}`); }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`PARITY OK (${keys.size} properties)`);
