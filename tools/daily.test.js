// Daily Challenge rules shared by client and server (js/daily-core.js).
// Run: node --test tools/daily.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../js/daily-core.js');

const day = (score, extra) => Object.assign({ score, won: false, secs: 600, place: 5, nations: 21, peak: 4.2, tries: 1 }, extra);

test('score: land, outlasted nations, win and speed', () => {
  assert.strictEqual(D.score({ peakPct: 10, nations: 21, place: 5, won: false, secs: 900 }), 200 + 16 * 15);
  assert.strictEqual(D.score({ peakPct: 80, nations: 21, place: 1, won: true, secs: 900 }), 1600 + 300 + 1000 + 700);
  assert.strictEqual(D.score({ peakPct: 80, nations: 21, place: 1, won: true, secs: 9000 }), 1600 + 300 + 1000);
});

test('dayAt counts from the epoch in UTC', () => {
  assert.strictEqual(D.dayAt(D.EPOCH), 1);
  assert.strictEqual(D.dayAt(D.EPOCH + D.DAY_MS - 1), 1);
  assert.strictEqual(D.dayAt(D.EPOCH + 12 * D.DAY_MS), 13);
});

test('sanitize drops junk, future days and absurd values', () => {
  const s = D.sanitize({
    streak: 99, bestStreak: 'x', last: 12,
    days: { 3: day(500), 20: day(900), abc: day(1), 4: { score: 'no' }, 5: day(1e9, { tries: -3, peak: 400 }), __proto__: day(1) }
  }, 13);
  assert.deepStrictEqual(Object.keys(s.days).sort(), ['3', '5']);
  assert.strictEqual(s.days[5].score, 1e5);
  assert.strictEqual(s.days[5].tries, 1);
  assert.strictEqual(s.days[5].peak, 100);
  assert.strictEqual(s.streak, 12, 'streak cannot exceed the day it ends on');
  assert.strictEqual(s.bestStreak, 12);
  assert.deepStrictEqual(D.sanitize(null), { streak: 0, bestStreak: 0, last: 0, days: {} });
});

test('merge keeps the better score per day and the most tries', () => {
  const a = D.sanitize({ last: 10, streak: 1, bestStreak: 4, days: { 10: day(800, { tries: 3 }) } });
  const b = D.sanitize({ last: 10, streak: 1, bestStreak: 2, days: { 10: day(900, { tries: 1, won: true }) } });
  const m = D.merge(a, b);
  assert.strictEqual(m.days[10].score, 900);
  assert.strictEqual(m.days[10].won, true);
  assert.strictEqual(m.days[10].tries, 3);
  assert.strictEqual(m.bestStreak, 4);
});

test('merge joins days played on two devices into one streak', () => {
  const a = D.sanitize({ last: 12, streak: 3, bestStreak: 3, days: { 10: day(1), 11: day(1), 12: day(1) } });
  const b = D.sanitize({ last: 13, streak: 1, bestStreak: 1, days: { 13: day(1) } });
  const m = D.merge(a, b);
  assert.strictEqual(m.last, 13);
  assert.strictEqual(m.streak, 4);
  assert.strictEqual(m.bestStreak, 4);
});

test('merge keeps a streak longer than the days it still holds', () => {
  const a = D.sanitize({ last: 100, streak: 90, bestStreak: 90, days: { 99: day(1), 100: day(1) } });
  const m = D.merge(a, D.sanitize({}));
  assert.strictEqual(m.streak, 90);
});

test('merge is repeat-safe and keeps at most KEEP_DAYS', () => {
  const days = {};
  for (let d = 1; d <= 80; d++) days[d] = day(d);
  const a = D.sanitize({ last: 80, streak: 80, bestStreak: 80, days }, 80);
  assert.strictEqual(Object.keys(a.days).length, D.KEEP_DAYS);
  const b = D.sanitize({ last: 79, streak: 2, bestStreak: 2, days: { 78: day(5000), 79: day(1) } });
  const m = D.merge(a, b);
  assert.deepStrictEqual(D.merge(m, a), m);
  assert.deepStrictEqual(D.merge(m, b), m);
  assert.strictEqual(m.days[78].score, 5000);
});
