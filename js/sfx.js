// Sound effects, synthesized with Web Audio like js/music.js: no audio files.
// Client-only and cosmetic. frame() watches sim state for things worth a sound
// and never writes any; its randomness is Math.random, never Game.rng.
// Options owns the on/off and volume settings (docs/retention-pack.md §1).
const Sfx = (function() {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, master = null, noiseBuf = null, broken = !AC;
  let on = true, volume = 0.7;

  // Least ms between two plays of the same sound, so a burst reads as one.
  const GAP = { click: 40, march: 180, alarm: 2500, build: 250, coin: 450, conquer: 400,
    ping: 600, launch: 300, siren: 4000, boom: 150, start: 1000, achieve: 500 };
  const lastAt = {};

  function ensure() {
    if (ctx) return true;
    if (broken) return false;
    try {
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = volume * volume;
      master.connect(comp);
      comp.connect(ctx.destination);
      const len = ctx.sampleRate;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) {
      broken = true;
      return false;
    }
    return true;
  }

  // One enveloped oscillator: freq f0 gliding to f1 over `dur` seconds.
  function tone(type, f0, f1, at, dur, gain, attack) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + (attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    g.connect(master);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  // Filtered noise burst; the filter sweeps from c0 to c1 Hz.
  function noise(kind, c0, c1, at, dur, gain, attack) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    s.loop = true;
    f.type = kind;
    f.frequency.setValueAtTime(c0, at);
    f.frequency.exponentialRampToValueAtTime(Math.max(10, c1), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + (attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f);
    f.connect(g);
    g.connect(master);
    s.start(at, Math.random() * 0.5);
    s.stop(at + dur + 0.05);
  }

  const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);
  // Notes in a row, `step` seconds apart.
  function notes(type, midis, at, step, dur, gain) {
    for (let i = 0; i < midis.length; i++) tone(type, hz(midis[i]), hz(midis[i]), at + i * step, dur, gain);
  }

  const SOUNDS = {
    click(t) { tone('triangle', 660, 520, t, 0.05, 0.2); },
    // Two drum hits: troops moving out.
    march(t) {
      tone('sine', 150, 55, t, 0.16, 0.5);
      tone('sine', 130, 50, t + 0.13, 0.18, 0.4);
      noise('lowpass', 900, 200, t, 0.08, 0.12);
    },
    // A falling two-note horn: someone is coming for you.
    alarm(t) {
      for (let i = 0; i < 2; i++) {
        tone('sawtooth', 392, 380, t + i * 0.36, 0.3, 0.14, 0.03);
        tone('sawtooth', 294, 286, t + i * 0.36, 0.3, 0.14, 0.03);
      }
    },
    build(t) {
      noise('bandpass', 2400, 1200, t, 0.05, 0.35);
      tone('triangle', hz(72), hz(72), t + 0.03, 0.22, 0.22);
      tone('triangle', hz(79), hz(79), t + 0.1, 0.3, 0.2);
    },
    coin(t) {
      tone('square', hz(88), hz(88), t, 0.06, 0.09);
      tone('square', hz(93), hz(93), t + 0.06, 0.18, 0.09);
    },
    conquer(t) { notes('triangle', [60, 64, 67, 72], t, 0.09, 0.3, 0.14); },
    ping(t) { notes('sine', [81, 86], t, 0.12, 0.35, 0.14); },
    launch(t) {
      noise('bandpass', 300, 3200, t, 0.9, 0.45, 0.25);
      tone('sawtooth', 70, 240, t, 0.9, 0.14, 0.2);
    },
    siren(t) {
      for (let i = 0; i < 3; i++) {
        tone('square', 520, 780, t + i * 0.5, 0.25, 0.14, 0.03);
        tone('square', 780, 520, t + i * 0.5 + 0.25, 0.25, 0.14, 0.03);
      }
    },
    boom(t) {
      tone('sine', 110, 28, t, 1.3, 0.8);
      noise('lowpass', 1800, 60, t, 1.6, 0.6);
    },
    start(t) { notes('triangle', [57, 64, 69], t, 0.12, 0.5, 0.13); },
    achieve(t) { notes('triangle', [72, 76, 79, 84], t, 0.08, 0.45, 0.12); },
    victory(t) {
      notes('sawtooth', [60, 64, 67], t, 0.16, 0.3, 0.07);
      for (const m of [60, 64, 67, 72]) tone('sawtooth', hz(m), hz(m), t + 0.48, 1.4, 0.06, 0.04);
      tone('sine', hz(36), hz(36), t + 0.48, 1.4, 0.3);
    },
    defeat(t) {
      notes('triangle', [67, 63, 60], t, 0.3, 0.6, 0.12);
      tone('sine', hz(41), hz(36), t + 0.6, 1.6, 0.3, 0.05);
    }
  };

  function play(name, gain) {
    if (!on || volume <= 0 || !SOUNDS[name] || !ensure()) return;
    if (ctx.state === 'suspended') {
      // Before the first tap or key, a browser refuses to start audio.
      ctx.resume().catch(() => {});
      if (ctx.state === 'suspended') return;
    }
    const now = performance.now();
    if (now - (lastAt[name] || 0) < (GAP[name] || 0)) return;
    lastAt[name] = now;
    if (gain !== undefined && gain !== 1) {
      // A quieter play: run the sound through its own gain for its lifetime.
      const real = master, g = ctx.createGain();
      g.gain.value = gain;
      g.connect(real);
      master = g;
      try { SOUNDS[name](ctx.currentTime + 0.01); } finally { master = real; }
      setTimeout(() => g.disconnect(), 4000);
      return;
    }
    SOUNDS[name](ctx.currentTime + 0.01);
  }

  // --- Watching the match ----------------------------------------------------

  let seen = new WeakSet();
  let match = null, wasSpawning = false, units = 0, requests = 0;
  let killBorn = -1, goldBorn = -1, giftBorn = -1;

  function unitTotal(me) {
    let n = 0;
    for (const k in me.units) n += me.units[k];
    return n;
  }

  // Called once per drawn frame. `quiet` marks what is there as heard without
  // playing it: a replay, a seek, or a rejoin working through its backlog.
  function frame(quiet) {
    const me = Game.players && Game.players[Game.me];
    if (!me) return;
    // A new match: whatever is already there is not news.
    if (match !== Game.players) {
      match = Game.players;
      seen = new WeakSet();
      wasSpawning = Game.spawning;
      units = unitTotal(me);
      requests = 0;
      killBorn = goldBorn = giftBorn = -1;
    }
    const id = Game.me;
    const say = quiet ? () => {} : play;

    if (wasSpawning && !Game.spawning) say('start');
    wasSpawning = Game.spawning;
    if (Game.spawning) return;

    for (const a of Game.attacks) {
      if (seen.has(a)) continue;
      seen.add(a);
      if (a.attacker === id) say('march');
      else if (a.target === id && a.troops > 0 && !Game.players[a.attacker].isTribe) say('alarm');
    }
    for (const b of Game.boats) {
      if (seen.has(b)) continue;
      seen.add(b);
      if (b.attacker === id) say('march');
      else if (b.target === id && b.troops > 0) say('alarm');
    }

    for (const list of [Game.nukes, Game.mirvs]) {
      for (const n of list) {
        if (seen.has(n) || n.born > Game.elapsed) continue;
        seen.add(n);
        if (n.nukeType === 'mirvwarhead') continue;
        if (n.ownerId === id) say('launch');
        else if (UI.nukeThreatensMe(n)) say('siren');
      }
    }
    for (const b of Game.nukeBlasts) {
      if (seen.has(b)) continue;
      seen.add(b);
      const tile = GameMap.idx(Math.max(0, Math.min(GameMap.width - 1, b.x | 0)), Math.max(0, Math.min(GameMap.height - 1, b.y | 0)));
      if (Game.fog && !Game.isDiscovered(id, tile)) continue;
      // Loud on screen, a rumble off it.
      const cam = Render.cam;
      const onScreen = Math.abs(b.x - cam.x) * cam.scale < window.innerWidth / 2 + b.outer * cam.scale &&
        Math.abs(b.y - cam.y) * cam.scale < window.innerHeight / 2 + b.outer * cam.scale;
      say('boom', onScreen ? 1 : 0.3);
    }

    const total = me.alive ? unitTotal(me) : 0;
    if (total > units) say('build');
    units = total;

    // Fx lists are appended in `born` order; anything newer than the last one
    // heard is new.
    let born = killBorn;
    for (const k of Fx.killPopups) if (k.born > killBorn && k.ownerId === id) { say('conquer'); born = Math.max(born, k.born); }
    killBorn = Math.max(born, Fx.killPopups.length ? Fx.killPopups[Fx.killPopups.length - 1].born : born);
    born = goldBorn;
    for (const g of Fx.goldPopups) if (g.born > goldBorn && g.ownerId === id) { say('coin'); born = Math.max(born, g.born); }
    goldBorn = Math.max(born, Fx.goldPopups.length ? Fx.goldPopups[Fx.goldPopups.length - 1].born : born);
    born = giftBorn;
    for (const d of Fx.donationToasts) if (d.born > giftBorn && d.toId === id) { say('coin'); born = Math.max(born, d.born); }
    giftBorn = born;

    let mine = 0;
    for (const r of Game.requests) if (r.to === id) mine++;
    if (mine > requests) say('ping');
    requests = mine;
  }

  // Every button gets the same small click, without touching each handler.
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('button, .modeTab, select, input[type="checkbox"]')) play('click');
  }, true);

  return {
    play, frame,
    set(isOn, vol) {
      on = !!isOn;
      volume = vol;
      if (master) master.gain.value = volume * volume;
    }
  };
})();
