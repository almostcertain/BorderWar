// Per-address and per-socket abuse limits for the WebSocket side of the host
// (docs/cloud-hosting.md, "Abuse limits"). Not a security control: an attacker
// with many addresses still gets through. It stops one source starving everyone
// else on the single Node thread.
'use strict';

// IPv4 as is. IPv6 collapses to its /64, since one subscriber or VPS holds
// the whole block and could otherwise rotate addresses past every limit.
// Loopback and unknown addresses return null: local development, tests, and
// the tunnel peer when it sent no CF-Connecting-IP. Those are never limited.
function addressKey(ip) {
  if (!ip || typeof ip !== 'string') return null;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return null;
  if (ip.startsWith('::ffff:') && ip.indexOf('.') !== -1) return ip.slice(7);
  if (ip.indexOf(':') === -1) return ip;

  const halves = ip.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  let groups = head;
  if (halves.length > 1) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const zeros = new Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
    groups = head.concat(zeros, tail);
  }
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':');
}

// Admits or refuses new sockets: per address (concurrent and per-window), plus
// a high global ceiling that only a distributed flood reaches. Refusals do
// not spend the global budget, so one abusive address can't use it up.
class AddressGuard {
  constructor(opts) {
    opts = opts || {};
    this.now = opts.now || Date.now;
    this.openPerAddress = opts.openPerAddress || 24;
    this.newPerWindow = opts.newPerWindow || 30;
    this.windowMs = opts.windowMs || 10 * 1000;
    this.globalPerSecond = opts.globalPerSecond || 100;
    this._byKey = new Map(); // key -> { open, windowStart, count }
    this._globalStart = 0;
    this._globalCount = 0;
  }

  // null when admitted (and counted as open until release); else 'open',
  // 'rate' or 'busy'.
  admit(ip) {
    const key = addressKey(ip);
    if (key === null) return null;
    const t = this.now();
    if (this._byKey.size > 5000) this._prune(t);

    let e = this._byKey.get(key);
    if (!e) e = { open: 0, windowStart: t, count: 0 };
    if (t - e.windowStart >= this.windowMs) { e.windowStart = t; e.count = 0; }
    if (e.open >= this.openPerAddress) return 'open';
    if (e.count >= this.newPerWindow) return 'rate';

    if (t - this._globalStart >= 1000) { this._globalStart = t; this._globalCount = 0; }
    if (this._globalCount >= this.globalPerSecond) return 'busy';

    this._globalCount++;
    e.count++;
    e.open++;
    this._byKey.set(key, e);
    return null;
  }

  // Pair every admit() that returned null with one release() on socket close.
  release(ip) {
    const key = addressKey(ip);
    if (key === null) return;
    const e = this._byKey.get(key);
    if (e && e.open > 0) e.open--;
  }

  _prune(t) {
    for (const [key, e] of this._byKey) {
      if (e.open === 0 && t - e.windowStart >= this.windowMs) this._byKey.delete(key);
    }
  }
}

// At most `max` events per key in each fixed `windowMs`.
class WindowCounter {
  constructor(opts) {
    this.now = opts.now || Date.now;
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this._byKey = new Map(); // key -> { start, count }
  }

  // True and counted when within the limit, false when over it.
  hit(key) {
    const t = this.now();
    if (this._byKey.size > 5000) {
      for (const [k, e] of this._byKey) if (t - e.start >= this.windowMs) this._byKey.delete(k);
    }
    let e = this._byKey.get(key);
    if (!e || t - e.start >= this.windowMs) {
      e = { start: t, count: 0 };
      this._byKey.set(key, e);
    }
    if (e.count >= this.max) return false;
    e.count++;
    return true;
  }
}

// Token bucket for one connection's inbound messages. A legitimate client
// sends at most the intent cap (20 a turn, 10 turns a second = 200/s) plus a
// ping and a hash now and then, so only a flood drains it.
class MessageBudget {
  constructor(opts) {
    opts = opts || {};
    this.now = opts.now || Date.now;
    this.capacity = opts.capacity || 400;
    this.perSecond = opts.perSecond || 220;
    this.kickAfter = opts.kickAfter || 400; // dropped in one second
    this._tokens = this.capacity;
    this._at = this.now();
    this._dropStart = this._at;
    this._drops = 0;
  }

  // 'ok', 'drop' (discard this message) or 'kick' (close the socket).
  take() {
    const t = this.now();
    this._tokens = Math.min(this.capacity, this._tokens + (t - this._at) * this.perSecond / 1000);
    this._at = t;
    if (this._tokens >= 1) {
      this._tokens -= 1;
      return 'ok';
    }
    if (t - this._dropStart >= 1000) { this._dropStart = t; this._drops = 0; }
    return ++this._drops > this.kickAfter ? 'kick' : 'drop';
  }
}

module.exports = { AddressGuard, MessageBudget, WindowCounter, addressKey };
