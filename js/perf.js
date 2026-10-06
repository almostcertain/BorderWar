// Performance metering (docs/perf-tools.md). Client-only: it times the sim and
// the renderer from outside and never writes sim state. Nothing measured here
// is fed back into the game.
//
// Three parts, top to bottom:
//   - always-on series (frame interval, sim ms per turn, draw ms, UI ms), fed
//     by main.js's loop. They cost a few performance.now() calls a frame, and
//     back both the Show FPS readout and report();
//   - detail(): wraps the Render.draw* / UI.update* methods and the sim's tick
//     phases in timers for a per-method breakdown. Off unless asked for;
//   - bench(): a fixed, hand-paced run for the Browser pane, which has no
//     requestAnimationFrame to drive the real loop.
const Perf = (function () {
  const N = 1200;   // samples kept per series: 20 s of frames, 2 min of turns

  function makeSeries() { return { buf: new Float32Array(N), n: 0, i: 0 }; }
  function push(s, v) {
    s.buf[s.i] = v;
    s.i = (s.i + 1) % N;
    if (s.n < N) s.n++;
  }
  // The newest `count` samples, oldest first.
  function recent(s, count) {
    const n = Math.min(s.n, count), out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = s.buf[(s.i - n + k + N) % N];
    return out;
  }
  const round = v => Math.round(v * 100) / 100;
  function stats(s, count) {
    const a = recent(s, count || N);
    if (!a.length) return null;
    let sum = 0;
    for (const v of a) sum += v;
    a.sort();
    const q = p => round(a[Math.floor(p * (a.length - 1))]);
    return { n: a.length, mean: round(sum / a.length), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
  }

  let frame, sim, draw, ui, lastFrameAt, startedAt, lastTick, frames, turns, over33, over50, over100;
  function reset() {
    frame = makeSeries(); sim = makeSeries(); draw = makeSeries(); ui = makeSeries();
    lastFrameAt = 0; startedAt = performance.now(); lastTick = Game.ticks;
    frames = turns = over33 = over50 = over100 = 0;
    for (const k in detailMs) { delete detailMs[k]; delete detailCalls[k]; }
    detailFrames = detailTurns = 0;
  }

  // --- Feeds (main.js) ---------------------------------------------------------

  function simTurn(ms) {
    push(sim, ms);
    turns++;
    detailTurns++;
  }

  // One drawn frame. `now` is the frame's own timestamp; the interval to the
  // previous one is what the player sees as frame rate. bench passes `workMs`
  // instead: its frames are paced by hand, so the interval between them says
  // nothing, and the frame's cost is the work done in it.
  function drawn(now, drawMs, uiMs, workMs) {
    // A new match starts its tick count again: don't mix two matches' numbers.
    if (Game.ticks < lastTick) reset();
    lastTick = Game.ticks;
    if (lastFrameAt || workMs !== undefined) {
      const dt = workMs !== undefined ? workMs : now - lastFrameAt;
      // A gap this long is a hidden tab or a paused debugger, not a frame.
      if (dt < 2000) {
        push(frame, dt);
        if (dt > 33.4) over33++;
        if (dt > 50) over50++;
        if (dt > 100) over100++;
      }
    }
    lastFrameAt = now;
    push(draw, drawMs);
    push(ui, uiMs);
    frames++;
    detailFrames++;
  }

  // --- Per-method breakdown ------------------------------------------------------

  const RENDER_METHODS = /^(draw|releaseTiles|enqueueDirty|buildTiles|flushLayerPuts|refreshLayer|updateFog|stepLabels|renderLabelSprite|updateAltRelations|buildHoverOverlay)/;
  const SIM_PHASES = ['updateConstruction', 'resolveOpposingFronts', 'stepAttack', 'checkAnnexations', 'stepBoats',
    'updateFactoryStations', 'stepTrains', 'updatePortTrade', 'stepTradeShips', 'stepWarships', 'stepShells',
    'stepSAMs', 'stepNukes', 'updateDiplomacy', 'seaPath', 'stepScouts', 'seaTowardRun', 'stepDrill'];
  const detailMs = {}, detailCalls = {};
  let detailFrames = 0, detailTurns = 0, wrapped = null;

  // Self-nested calls (a method that calls itself, or draw calling drawLayer
  // twice) are timed once, at the outermost call. A label's time includes the
  // labels it calls: R.draw contains every other R.* row.
  function wrap(obj, name, label) {
    const fn = obj[name];
    if (typeof fn !== 'function') return;
    let depth = 0;
    obj[name] = function () {
      if (depth) return fn.apply(this, arguments);
      depth = 1;
      const s = performance.now();
      try { return fn.apply(this, arguments); }
      finally {
        depth = 0;
        detailMs[label] = (detailMs[label] || 0) + performance.now() - s;
        detailCalls[label] = (detailCalls[label] || 0) + 1;
      }
    };
    wrapped.push([obj, name, fn]);
  }

  function detail(on) {
    if (!!on === !!wrapped) return;
    if (!on) {
      for (const [obj, name, fn] of wrapped) obj[name] = fn;
      wrapped = null;
      return;
    }
    wrapped = [];
    for (const k in detailMs) { delete detailMs[k]; delete detailCalls[k]; }
    detailFrames = detailTurns = 0;
    for (const k of Object.keys(Render)) if (RENDER_METHODS.test(k)) wrap(Render, k, 'R.' + k);
    for (const k of Object.keys(UI)) if (/^update/.test(k)) wrap(UI, k, 'UI.' + k);
    for (const k of SIM_PHASES) wrap(Game, k, 'sim.' + k);
    wrap(Game, 'tick', 'sim.tick');
    wrap(AI, 'update', 'sim.AI.update');
    if (typeof TribeAI !== 'undefined') wrap(TribeAI, 'update', 'sim.TribeAI.update');
  }

  // [label, ms per frame (or per turn for sim.*), calls per frame/turn], largest first.
  function detailRows(prefix, per) {
    if (!wrapped || !per) return [];
    return Object.keys(detailMs)
      .filter(k => (k.startsWith('sim.')) === (prefix === 'sim.'))
      .map(k => [k, Math.round(detailMs[k] / per * 1000) / 1000, round(detailCalls[k] / per)])
      .sort((a, b) => b[1] - a[1]);
  }

  // --- Reports -------------------------------------------------------------------

  // `paced` is set by bench: frameMs is then work per frame (turn + draw + UI),
  // and fps is what that work alone would allow, not a measured frame rate.
  function report(paced) {
    const f = stats(frame);
    const mem = performance.memory;
    let alive = 0;
    for (const p of Game.players) if (p.alive) alive++;
    const canvas = Render.canvas;
    return {
      build: typeof window.BUILD_ID === 'string' ? window.BUILD_ID : null,
      userAgent: navigator.userAgent,
      cores: navigator.hardwareConcurrency || null,
      screen: {
        css: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio || 1,
        canvas: canvas ? [canvas.width, canvas.height] : null,
        lowGfx: Options.get('lowGfx'), saveBattery: Options.get('saveBattery'),
        // A hidden tab's canvas work is not representative: see docs/perf-tools.md.
        hidden: document.hidden
      },
      match: {
        map: [GameMap.width, GameMap.height], tick: Game.ticks, players: Game.players.length, alive,
        buildings: Game.buildings.size, tradeShips: Game.tradeShips.length, boats: Game.boats.length,
        fog: !!Game.fog, online: !Transport.isLocal, zoom: Render.cam ? round(Render.cam.scale) : null
      },
      paced: !!paced,
      seconds: round((performance.now() - startedAt) / 1000),
      frames, turns,
      fps: f ? round(1000 / f.mean) : null,
      frameMs: f,
      longFrames: { over33: over33, over50: over50, over100: over100 },
      simMs: stats(sim),
      drawMs: stats(draw),
      uiMs: stats(ui),
      heapMB: mem ? round(mem.usedJSHeapSize / 1048576) : null,
      detail: wrapped ? { render: detailRows('R.', detailFrames), sim: detailRows('sim.', detailTurns) } : null
    };
  }

  // The same report as text, for pasting into an issue or a chat.
  function text(r) {
    r = r || report();
    const line = (name, s) => s
      ? `${name.padEnd(9)} mean ${s.mean}  p50 ${s.p50}  p95 ${s.p95}  p99 ${s.p99}  max ${s.max}  (n=${s.n})`
      : `${name.padEnd(9)} no samples`;
    const out = [
      `BorderWar perf · build ${r.build || '?'} · ${r.seconds}s · ${r.frames} frames · ${r.turns} turns`,
      r.userAgent,
      `screen ${r.screen.css.join('x')} css @${r.screen.dpr}x, canvas ${r.screen.canvas ? r.screen.canvas.join('x') : '?'}, ` +
        `lowGfx ${r.screen.lowGfx}, saver ${r.screen.saveBattery}, cores ${r.cores || '?'}` +
        (r.screen.hidden ? ', TAB HIDDEN (canvas timings unreliable)' : ''),
      `match map ${r.match.map.join('x')}, tick ${r.match.tick}, alive ${r.match.alive}/${r.match.players}, ` +
        `buildings ${r.match.buildings}, tradeShips ${r.match.tradeShips}, boats ${r.match.boats}, ` +
        `fog ${r.match.fog}, online ${r.match.online}, zoom ${r.match.zoom}`,
      `${r.paced ? 'paced bench, frame ms = work per frame · ' : 'fps ' + r.fps + ' · '}frames over 33/50/100 ms: ${r.longFrames.over33}/${r.longFrames.over50}/${r.longFrames.over100}` +
        (r.heapMB !== null ? ` · heap ${r.heapMB} MB` : ''),
      line('frame ms', r.frameMs), line('sim ms', r.simMs), line('draw ms', r.drawMs), line('ui ms', r.uiMs)
    ];
    if (r.detail) {
      out.push('render, ms per frame (calls):');
      for (const [k, ms, calls] of r.detail.render.slice(0, 20)) out.push(`  ${k.padEnd(26)} ${ms}  (${calls})`);
      out.push('sim, ms per turn (calls):');
      for (const [k, ms, calls] of r.detail.sim.slice(0, 20)) out.push(`  ${k.padEnd(26)} ${ms}  (${calls})`);
    }
    return out.join('\n');
  }

  // What the Show FPS readout adds after the frame rate: the last 5 s of turns
  // and the last 2 s of frames.
  function hud() {
    const s = stats(sim, 50), d = stats(draw, 120);
    if (!s || !d) return '';
    return `sim ${s.mean.toFixed(0)}/${s.max.toFixed(0)} ms · draw ${d.mean.toFixed(1)} ms`;
  }

  // --- Paced benchmark -----------------------------------------------------------
  // For the Browser pane, where rAF does not fire and the real loop never runs.
  // Drives `frames` frames paced to `paceMs`, with one turn every `turnEvery`
  // frames (6 = the real 10 turns a second at 60 fps). Frames have to be paced:
  // run back to back, the GPU falls behind and the stall shows up in whichever
  // call touches a canvas next.
  //
  // Turns go through the ordinary pipeline (LocalServer.endTurn -> Runner ->
  // Executor), never a bare Game.tick, so a bench leaves a match that is still
  // a valid recording. Singleplayer only.
  let benching = false, last = null;
  async function bench(opts) {
    opts = Object.assign({ frames: 300, turnEvery: 6, paceMs: 16.7, detail: true }, opts);
    if (!Transport.isLocal) throw new Error('Perf.bench: singleplayer only');
    if (!Render.tileCanvas || Game.spawning) throw new Error('Perf.bench: start a match and place the capital first');
    if (benching) throw new Error('Perf.bench: already running');
    benching = true;
    const wasPaused = LocalServer.paused, hadDetail = !!wrapped;
    LocalServer.setPaused(true);          // holds the 5 ms pump; endTurn below is gate-free
    const mc = new MessageChannel();      // setTimeout is throttled to 1 s in a hidden tab
    const yieldNow = () => new Promise(r => { mc.port1.onmessage = r; mc.port2.postMessage(0); });
    try {
      while (Runner.pendingTurns() > 0) { Runner.executeNextTurn(); Transport.turnComplete(); }
      reset();
      detail(false);
      if (opts.detail) detail(true);
      for (let f = 0; f < opts.frames && Game.winnerId === null; f++) {
        const start = performance.now();
        let turnMs = 0;
        if (opts.turnEvery > 0 && f % opts.turnEvery === 0) {
          LocalServer.endTurn();
          const s = performance.now();
          Runner.executeNextTurn();
          Transport.turnComplete();
          turnMs = performance.now() - s;
          simTurn(turnMs);
        }
        const phase = opts.turnEvery > 0 ? (f % opts.turnEvery) * opts.paceMs / 1000 : 0;
        Game.renderElapsed = Game.elapsed + Math.min(Game.TICK_DT, phase);
        const d0 = performance.now();
        Render.draw();
        const d1 = performance.now();
        UI.update();
        const d2 = performance.now();
        drawn(start, d1 - d0, d2 - d1, turnMs + d2 - d0);
        while (performance.now() - start < opts.paceMs) await yieldNow();
      }
      return last = report(true);
    } finally {
      if (!hadDetail) detail(false);
      LocalServer.setPaused(wasPaused);
      benching = false;
    }
  }

  // Runs a singleplayer match forward to `toTick` without drawing, to reach a
  // mid-game state to measure. Same pipeline as bench; takes the first legal
  // spawn if the capital is not placed yet. Stops early after `budgetMs`
  // (default 20 s, to stay inside one Browser-pane script call) and returns
  // the tick reached, so call it again until it gets there.
  function advance(toTick, budgetMs) {
    if (!Transport.isLocal) throw new Error('Perf.advance: singleplayer only');
    if (!Render.tileCanvas) throw new Error('Perf.advance: start a match first');
    const wasPaused = LocalServer.paused;
    LocalServer.setPaused(true);
    if (Game.spawning) Transport.sendIntent(Protocol.intent.spawn(Hash.firstLegalSpawn()));
    const end = performance.now() + (budgetMs || 20000);
    while (Game.ticks < toTick && Game.winnerId === null && performance.now() < end) {
      if (Runner.pendingTurns() === 0) LocalServer.endTurn();
      const s = performance.now();
      Runner.executeNextTurn();
      Transport.turnComplete();
      simTurn(performance.now() - s);
    }
    LocalServer.setPaused(wasPaused);
    return Game.ticks;
  }

  reset();

  return {
    simTurn, drawn, hud, report, text, reset, detail, bench, advance,
    get benching() { return benching; },
    // The last bench's report, e.g. Perf.text(Perf.last).
    get last() { return last; }
  };
})();
