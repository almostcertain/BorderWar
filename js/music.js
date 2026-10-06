// Background music: a generative ambient score synthesized with Web Audio, so
// there are no audio files to ship or license. Client-only and cosmetic: it
// reads no sim state and writes none, and its randomness is Math.random, never
// Game.rng. It plays only while a match is on screen (#overlay hidden), plus a
// preview while the Options volume slider is in use. Options owns the on/off
// and volume settings and pushes them in through set().
const Music = (function() {
  const STEP = 0.45;              // seconds per half-beat (~67 BPM)
  const STEPS_PER_CHORD = 16;     // one chord every 7.2 s
  const CHORDS_PER_CYCLE = 4;
  const LOOKAHEAD = 1.2;          // seconds of notes kept scheduled ahead
  const TIMER_MS = 200;
  const FADE_IN = 3;

  const MINOR = [0, 2, 3, 5, 7, 8, 10];
  const PENTA = [0, 3, 5, 7, 10];
  const KEYS = [36, 38, 40, 41];  // MIDI C2, D2, E2, F2: one per match
  // Chord roots as degrees of the natural minor scale.
  const PROGRESSIONS = [
    [0, 5, 2, 6],   // i VI III VII
    [0, 3, 5, 4],   // i iv VI v
    [0, 6, 5, 6],   // i VII VI VII
    [0, 2, 3, 5],   // i III iv VI
    [0, 5, 3, 4]    // i VI iv v
  ];

  const PAD_GAIN = 0.06, PAD_ATTACK = 2.5, PAD_RELEASE = 4;
  const BASS_GAIN = 0.12;

  const overlay = document.getElementById('overlay');
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, mix = null, master = null, impulse = null, broken = !AC;
  let on = true, volume = 0.7, previewing = false;
  let session = null, timer = null;

  const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);
  const pick = a => a[Math.floor(Math.random() * a.length)];
  // The slider is linear; loudness is not.
  const level = () => volume * volume * 1.3;

  function ensureContext() {
    if (ctx) return true;
    if (broken) return false;
    try {
      ctx = new AC();
      // Sessions mix into the compressor; the volume comes after it, so the
      // music has the same dynamics at every slider position.
      mix = ctx.createDynamicsCompressor();
      mix.threshold.value = -16;
      mix.ratio.value = 3;
      mix.attack.value = 0.03;
      mix.release.value = 0.4;
      master = ctx.createGain();
      master.gain.value = level();
      mix.connect(master);
      master.connect(ctx.destination);
      // Reverb impulse: decaying stereo noise. Shared by every session.
      const len = Math.floor(ctx.sampleRate * 3.5);
      impulse = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = impulse.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    } catch (e) {
      console.error('[music]', e);
      broken = true;
      ctx = null;
      return false;
    }
    return true;
  }

  function gainNode(value, dest) {
    const g = ctx.createGain();
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  function lowpass(freq) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    return f;
  }

  // One session per match: its own mix bus, reverb and echo, so stopping can
  // fade and drop the whole graph without the last match's tails leaking into
  // the next. `fade` only ever ramps up and `out` only ever decays, so the two
  // automations never have to be cancelled against each other.
  function openSession() {
    const out = gainNode(1, mix);
    const fade = gainNode(0, out);
    const t = ctx.currentTime;
    fade.gain.setValueAtTime(0, t);
    fade.gain.linearRampToValueAtTime(1, t + FADE_IN);
    const bus = gainNode(1, fade);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulse;
    const reverbTone = lowpass(2600);
    reverb.connect(reverbTone);
    reverbTone.connect(gainNode(0.6, fade));

    const delay = ctx.createDelay(2);
    delay.delayTime.value = STEP * 1.5;
    const delayTone = lowpass(1800);
    delay.connect(delayTone);
    delayTone.connect(gainNode(0.42, delay));
    const echo = gainNode(0.5, bus);
    delayTone.connect(echo);
    echo.connect(reverb);

    return {
      out, bus, delay,
      verbLo: gainNode(0.4, reverb),    // pads and drums: a little room
      verbHi: gainNode(0.9, reverb),    // bells: mostly room
      key: pick(KEYS),
      step: 0, nextTime: 0, cycle: 0,
      prog: null, bass: true, melody: false, drum: false, bright: 1, mel: 4
    };
  }

  // Frees a note's nodes once its last oscillator has stopped.
  function freeAfter(osc, env) {
    osc.onended = () => env.disconnect();
  }

  function pad(s, t, rootDeg, dur) {
    // Every chord is folded into the same one-octave window, which gives
    // smooth voice leading between chords for free.
    const lo = s.key + 17;
    const degs = [rootDeg, rootDeg + 2, rootDeg + 4];
    if (Math.random() < 0.3) degs.push(rootDeg + 6);
    const end = t + dur + PAD_RELEASE;

    const tone = lowpass(0);
    tone.Q.value = 0.6;
    const f0 = 420 * s.bright;
    tone.frequency.setValueAtTime(f0, t);
    tone.frequency.linearRampToValueAtTime(f0 * 2.2, t + dur * 0.6);
    tone.frequency.linearRampToValueAtTime(f0, end);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(PAD_GAIN, t + PAD_ATTACK);
    env.gain.setValueAtTime(PAD_GAIN, t + dur);
    env.gain.linearRampToValueAtTime(0, end);
    tone.connect(env);
    env.connect(s.bus);
    env.connect(s.verbLo);

    let osc = null;
    for (const deg of degs) {
      const midi = lo + ((s.key + MINOR[deg % 7] - lo) % 12 + 12) % 12;
      for (const cents of [-9, 9]) {
        osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz(midi);
        osc.detune.value = cents + Math.random() * 4 - 2;
        osc.connect(tone);
        osc.start(t);
        osc.stop(end + 0.1);
      }
    }
    freeAfter(osc, env);
  }

  function bass(s, t, rootDeg, dur) {
    const semis = MINOR[rootDeg];
    const midi = s.key + (semis > 7 ? semis - 12 : semis);
    const end = t + dur + 1.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(BASS_GAIN, t + 1.2);
    env.gain.setValueAtTime(BASS_GAIN, t + dur - 0.5);
    env.gain.linearRampToValueAtTime(0, end);
    env.connect(s.bus);

    const sub = ctx.createOscillator();
    sub.frequency.value = hz(midi);
    sub.connect(env);
    // An octave up, so the line survives laptop and phone speakers.
    const upper = ctx.createOscillator();
    upper.type = 'triangle';
    upper.frequency.value = hz(midi + 12);
    upper.connect(gainNode(0.3, env));
    for (const o of [sub, upper]) { o.start(t); o.stop(end + 0.1); }
    freeAfter(upper, env);
  }

  function bell(s, t, midi, vel) {
    const end = t + 3;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vel, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(s.bus);
    env.connect(s.delay);
    env.connect(s.verbHi);

    let osc = null;
    for (const [ratio, amp] of [[1, 1], [2, 0.25], [4.02, 0.06]]) {
      osc = ctx.createOscillator();
      osc.frequency.value = hz(midi) * ratio;
      osc.connect(gainNode(amp, env));
      osc.start(t);
      osc.stop(end + 0.1);
    }
    freeAfter(osc, env);
  }

  function drum(s, t, vel) {
    const end = t + 1.1;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vel, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(s.bus);
    env.connect(s.verbLo);

    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.22);
    osc.connect(env);
    osc.start(t);
    osc.stop(end + 0.1);
    freeAfter(osc, env);
  }

  function playStep(s, t) {
    const pos = s.step % STEPS_PER_CHORD;
    if (pos === 0) {
      const chord = (s.step / STEPS_PER_CHORD) % CHORDS_PER_CYCLE;
      // Layers come and go by cycle (drums, bass, pad colour) and by half
      // cycle (melody), so the piece keeps moving. A match opens on pad and
      // bass alone.
      if (chord === 0) {
        const first = s.cycle++ === 0;
        s.prog = pick(PROGRESSIONS);
        s.bass = first || Math.random() < 0.85;
        s.drum = !first && Math.random() < 0.4;
        s.bright = 0.8 + Math.random() * 0.6;
      }
      if (chord % 2 === 0) s.melody = s.step > 0 && Math.random() < 0.7;
      const dur = STEPS_PER_CHORD * STEP;
      pad(s, t, s.prog[chord], dur);
      if (s.bass) bass(s, t, s.prog[chord], dur);
    }

    if (s.drum) {
      if (pos === 0) drum(s, t, 0.4);
      else if (pos === 8) drum(s, t, 0.22);
      else if (pos === 14 && Math.random() < 0.3) drum(s, t, 0.16);
    }

    // A sparse random walk over two octaves of minor pentatonic, which sits
    // safely on every chord above.
    if (s.melody) {
      const chance = pos === 0 ? 0.45 : pos % 2 === 0 ? 0.26 : 0.08;
      if (Math.random() < chance) {
        s.mel = Math.max(0, Math.min(9, s.mel + pick([-2, -1, -1, 1, 1, 2])));
        const midi = s.key + 24 + 12 * Math.floor(s.mel / 5) + PENTA[s.mel % 5];
        bell(s, t, midi, 0.06 + Math.random() * 0.05);
      }
    }
  }

  function schedule() {
    const s = session;
    if (!s) return;
    // The timer was starved (a throttled tab): pick up from now.
    if (s.nextTime < ctx.currentTime) s.nextTime = ctx.currentTime + 0.1;
    while (s.nextTime < ctx.currentTime + LOOKAHEAD) {
      playStep(s, s.nextTime);
      s.step++;
      s.nextTime += STEP;
    }
  }

  // Starts the clock: on a new session and when the tab comes back.
  function wake() {
    if (!session || document.hidden) return;
    ctx.resume();
    if (!timer) timer = setInterval(schedule, TIMER_MS);
    schedule();
  }

  // A hidden tab goes silent, and a suspended context costs nothing.
  function sleep() {
    clearInterval(timer);
    timer = null;
    if (ctx) ctx.suspend();
  }

  function start() {
    if (!ensureContext()) return;
    session = openSession();
    wake();
  }

  function stop() {
    const s = session;
    session = null;
    clearInterval(timer);
    timer = null;
    s.out.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    setTimeout(() => {
      s.out.disconnect();
      if (!session) ctx.suspend();
    }, 1500);
  }

  function sync() {
    const want = on && volume > 0 && (previewing || overlay.classList.contains('hidden'));
    if (want && !session) start();
    else if (!want && session) stop();
  }

  new MutationObserver(sync).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (document.hidden) sleep(); else wake(); });
  // Safari only starts a context from inside a user gesture, and a match can
  // begin without one (a multiplayer start): the next tap or key does it.
  const unlock = () => { if (session && !document.hidden && ctx.state !== 'running') ctx.resume(); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  return {
    set(isOn, vol) {
      on = !!isOn;
      volume = vol;
      if (master) master.gain.setTargetAtTime(level(), ctx.currentTime, 0.08);
      sync();
    },
    // Lets the Options volume slider be heard from the (otherwise silent) menu.
    preview(isOn) {
      previewing = !!isOn;
      sync();
    }
  };
})();
