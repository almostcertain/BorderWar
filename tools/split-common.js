'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function loader() {
  const match = read('index.html').match(/\[([^\]]+)\]\.forEach\(name\s*=>/);
  if (!match) throw new Error('Cannot find classic script loader');
  const names = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (!names.includes('ai')) throw new Error('Loader has no ai entry');
  return names;
}
function load(context, file) {
  vm.runInContext(read(file), context, { filename: file });
}
// Realm-independent, type-preserving serialization. Object keys are sorted;
// Map/Set insertion order is retained because simulation iteration observes it.
//
// A true ancestor cycle (an object reachable from itself, e.g. two warships
// each holding the other as `.target` while a shell fired at one holds the
// same object again) can't be inlined without recursing forever, so it's cut
// off with a marker instead of walked. This does not make the digest blind to
// that state: the object is still fully hashed in full at whatever top-level
// slot actually owns it (Game.warships' own entries) — only the redundant,
// already-infinite tail through the back-reference is dropped.
function stable(value, ancestors = new Set()) {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'function') return ['function', value.toString()];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
  if (Object.is(value, -0)) return ['number', '-0'];
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return ['Cycle'];
  ancestors.add(value);
  const recur = v => stable(v, ancestors);
  const tag = Object.prototype.toString.call(value);
  let result;
  if (tag === '[object Map]') result = ['Map', [...value].map(([k, v]) => [recur(k), recur(v)])];
  else if (tag === '[object Set]') result = ['Set', [...value].map(recur)];
  else if (ArrayBuffer.isView(value)) result = [tag, Array.from(value, recur)];
  else if (Array.isArray(value)) result = ['Array', value.map(recur)];
  else result = ['Object', Object.keys(value).sort().map(k => [k, recur(value[k])])];
  ancestors.delete(value);
  return result;
}
module.exports = { fs, path, vm, root, read, loader, load, stable };
