// Password hashing (AU-1, docs/accounts-auth.md §4): crypto.scrypt with the
// parameters written into the stored string, "scrypt$N$r$p$salt$hash", so they
// can be raised later and old hashes still verify.
'use strict';

const crypto = require('crypto');

const DEFAULT_PARAMS = { N: 1 << 15, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Async on purpose: one hash is ~100 ms of CPU, which would stall the turn
// loop if it ran on the main thread. crypto.scrypt runs on the thread pool.
function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    // scrypt needs 128 * N * r bytes; Node's default cap is just under that at N=2^15.
    const opts = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r };
    crypto.scrypt(password, salt, KEY_BYTES, opts, (err, key) => err ? reject(err) : resolve(key));
  });
}

async function hash(password, params) {
  params = params || DEFAULT_PARAMS;
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function parse(stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  return { params: { N, r, p }, salt: Buffer.from(parts[4], 'base64'), key: Buffer.from(parts[5], 'base64') };
}

async function verify(password, stored) {
  const parsed = parse(stored);
  if (!parsed || parsed.key.length !== KEY_BYTES) return false;
  let key;
  try { key = await derive(password, parsed.salt, parsed.params); } catch (e) { return false; }
  return crypto.timingSafeEqual(key, parsed.key);
}

// True when `stored` was made with different parameters than `params`, so a
// successful login should replace it.
function needsRehash(stored, params) {
  params = params || DEFAULT_PARAMS;
  const parsed = parse(stored);
  return !parsed || parsed.params.N !== params.N || parsed.params.r !== params.r || parsed.params.p !== params.p;
}

module.exports = { hash, verify, needsRehash, DEFAULT_PARAMS };
