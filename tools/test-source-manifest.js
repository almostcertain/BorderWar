'use strict';
// Exercise the harness's real manifest gate with in-memory source changes.
// Never modify protected source files or the recorded golden files.
const assert = require('node:assert/strict');
const common = require('./split-common');
const { fs, path, vm, root, loader } = common;
const harness = fs.readFileSync(path.join(__dirname, 'sim-harness.js'), 'utf8');
const goldenFile = path.join(root, 'tools/golden/small-12345.json');
const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
assert(golden.manifest, 'Record manifest goldens before running this test');
const reachedSimulation = new Error('manifest gate passed');
function exercise({ changed, added, transformGolden } = {}) {
  const fakeFs = { ...fs, readFileSync(file, options) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (file === goldenFile && transformGolden) {
      const copy = JSON.parse(JSON.stringify(golden));
      transformGolden(copy);
      return JSON.stringify(copy);
    }
    if (relative === added) return Buffer.from('// in-memory added file\n');
    const bytes = fs.readFileSync(file, options);
    return relative === changed ? Buffer.concat([Buffer.from(bytes), Buffer.from('\n')]) : bytes;
  } };
  const fakeCommon = { ...common, fs: fakeFs,
    loader() {
      const names = loader();
      if (added) names.splice(names.indexOf('ai'), 0, added.slice(3, -3));
      return names;
    },
    vm: { ...vm, createContext() { throw reachedSimulation; } }
  };
  try {
    vm.runInNewContext(harness, {
      require(name) { return name === './split-common' ? fakeCommon : require(name); },
      process: { argv: [process.execPath, 'sim-harness.js', 'compare'] },
      performance, console
    }, { filename: 'sim-harness.js' });
    assert.fail('Harness unexpectedly returned');
  } catch (error) { return error; }
}
function rejects(options, file) {
  const error = exercise(options);
  assert.notEqual(error, reachedSimulation, `Manifest gate missed ${file}`);
  assert.match(error.message, /MANIFEST MISMATCH/);
  assert(error.message.includes(file), `Error did not name ${file}: ${error.message}`);
}
const protectedFiles = Object.keys(golden.manifest).filter(file => !file.startsWith('js/game/'));
for (const file of protectedFiles) rejects({ changed: file }, file);
rejects({ added: 'js/manifest-fixture.js' }, 'js/manifest-fixture.js');
rejects({ transformGolden(g) { g.manifest['js/no-longer-loaded.js'] = '0'.repeat(64); } }, 'js/no-longer-loaded.js');
rejects({ transformGolden(g) { delete g.manifest['js/ai.js']; } }, 'js/ai.js');
assert.match(exercise({ transformGolden(g) { delete g.manifest; } }).message, /missing source manifest/);
assert.equal(exercise({ changed: 'js/game/core.js' }), reachedSimulation);
assert.equal(exercise({ added: 'js/game/manifest-fixture.js' }), reachedSimulation);
assert.equal(exercise(), reachedSimulation);
console.log(`MANIFEST GATE TESTS OK (${protectedFiles.length} protected-file mutations; added/removed/missing entries; game-file exemptions; unchanged input)`);
