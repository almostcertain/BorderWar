// Input rules for account fields (docs/accounts-auth.md §3, §4). Each function
// returns the cleaned value, or null when the input is not acceptable.
'use strict';

const { COMMON_PASSWORDS } = require('./common-passwords');

// Trimmed, lower-cased, <= 254 chars, shaped like x@y.z. Nothing is ever
// mailed to it, so nothing stricter is worth having.
function email(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

// 1-20 chars after trimming, no control characters, and no [ ] (they would
// collide with the "[TAG] name" convention read by Teams.tagOf).
function displayName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length < 1 || s.length > 20 || /[\u0000-\u001f\u007f\[\]]/.test(s)) return null;
  return s;
}

// Same shape the menu's tag field produces: up to 5 letters or digits, upper case.
function tag(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9]{0,5}$/.test(s) ? s : null;
}

// 8-128 chars, no composition rules, not one of the bundled common passwords.
function password(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 128) return null;
  if (COMMON_PASSWORDS.has(v.toLowerCase())) return null;
  return v;
}

// A plain object that serialises to at most 2000 chars.
function settings(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let json;
  try { json = JSON.stringify(v); } catch (e) { return null; }
  return json.length <= 2000 ? json : null;
}

module.exports = { email, displayName, tag, password, settings };
