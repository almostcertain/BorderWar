// js/tutorial.js — the guided first match (client-only, docs/tutorial.md).
//
// A normal singleplayer match on a fixed small map with easy bots, plus a
// coach panel at the top of the HUD that walks through one thing at a time
// and moves on when the player has done it. Every step is detected by reading
// the sim; nothing here sends an intent, so the player's own taps go down the
// ordinary pipeline and what they learn is the real game.
//
// TUTORIAL BYPASS — free gold. The one thing this file writes into the sim.
// A first match earns nowhere near a Missile Silo in the few minutes a
// tutorial should take, so while a build step is up the player's treasury is
// topped up to that build's price (see frame). It is the same exception, for
// the same reason and behind the same gate, as ui.js's DEBUG BYPASS #1: there
// is no gold intent, so this is singleplayer only (Transport.isLocal) and can
// never run in a networked match. A match with it cannot be replayed from its
// turns either, so main.js does not record tutorial matches.
const Tutorial = {
  // Set by main.js, which owns connections: { start(config), exit() }.
  host: null,

  // A tutorial match is running and its panel is live.
  active: false,
  // Between asking for the match and its `start` arriving (see matchReady).
  _pending: false,

  step: 0,
  _shown: -1,       // the step the panel currently shows
  _glowEl: null,
  _latched: false,  // the current step's condition was seen true
  _framed: false,   // the camera has been brought in on the new capital

  // Freeze while reading. The match is held (LocalServer's pause, so this is
  // singleplayer scheduling and nothing the sim can see) whenever the panel is
  // waiting on the player, so the nations do not grow, or attack, while a
  // newcomer reads. It runs again the moment the player does something, for
  // long enough to see what came of it, and for as long as one of their
  // buildings is going up (the Warship and Atom Bomb steps wait on one).
  //
  // "Does something" is a tap on the map or an order reaching the server.
  // The tap counts on its own because not every tap becomes an order (too few
  // troops, a refused placement), and a held match regrows no troops: without
  // it such a player would be stuck.
  frozen: false,      // this file is holding the match
  userPaused: false,  // the player's own Pause, which outranks the above
  _runUntil: 0,       // performance.now() the match runs on until
  STEP_RUN_MS: 2500,  // after a step completes, to watch it land
  ACT_RUN_MS: 4000,   // after the player acts

  // Two landmasses, so there is a coast to build a Port on and somewhere to
  // sail to. Fog off: a new player should see the map they are learning.
  CONFIG: {
    seed: 20261005,
    map: 'procedural',
    mapSize: 'small',
    mapGen: { landform: 'twin' },
    bots: 3,
    tribes: 40,
    difficulty: 'easy',
    gameMode: 'ffa',
    fogOfWar: false
  },

  // Shown in the spawn banner in place of UI.SPAWN_HINT (the HUD, and so the
  // panel, is hidden until the capital is placed). Short: the banner is one
  // line and has to fit a phone.
  SPAWN_HINT: 'Tap land near the sea to place your capital',

  // One entry per step, in order.
  //   text(touch)  what to do; `touch` picks the wording for a phone
  //   glow         selector of the control to point at, if any
  //   gold         unit type whose price the treasury is topped up to
  //   done(me)     the sim says the player has done it
  STEPS: [
    {
      title: 'Grow your nation',
      text: () => 'Tap unclaimed land next to your border. Your troops march out and claim it.',
      done: me => Game.attacks.some(a => a.attacker === me.id)
    },
    {
      title: 'Choose how many troops to send',
      text: () => 'The bar is your troops. They regrow fastest when it is a little under half full. ' +
        'The slider sets the share sent with each attack: move it to continue.',
      glow: '#ratioRow',
      done: () => Math.abs(UI.ratio - UI.DEFAULT_RATIO) > 0.001
    },
    {
      title: 'Build a City',
      text: () => 'Cities raise your maximum troops. Gold is free during the tutorial. ' +
        'Tap the City button, then tap your own land.',
      glow: '.buildBtn[data-type="city"]', gold: 'city',
      done: me => Tutorial.has(me, 'city')
    },
    {
      title: 'Attack a neighbour',
      text: () => 'Tap land that belongs to a neighbouring nation or tribe. A bigger share of your troops hits harder.',
      done: me => Game.attacks.some(a => a.attacker === me.id && a.target >= 0)
    },
    {
      title: 'Make peace',
      text: touch => 'Nations are the brightly coloured territories; the beige ones are tribes, which make no alliances. ' +
        (touch ? 'Press and hold' : 'Right-click') + ' a nation and choose Peace. Allies cannot attack each other. ' +
        (touch ? 'Pinch' : 'Scroll') + ' to zoom out if none is in view.',
      done: me => Game.requests.some(r => r.from === me.id) ||
        Game.alliances.some(a => a.a === me.id || a.b === me.id)
    },
    {
      title: 'Build a Port',
      text: () => 'Ports earn gold from trade ships and launch your navy. Tap the Port button, then tap your coastline. ' +
        'No coast yet? Keep expanding toward the sea.',
      glow: '.buildBtn[data-type="port"]', gold: 'port',
      done: me => Tutorial.has(me, 'port')
    },
    {
      title: 'Cross the sea',
      text: touch => (touch ? 'Press and hold' : 'Right-click') +
        ' land across the water and choose Boat. Your troops sail over and attack where they land.',
      done: me => Game.boats.some(b => b.attacker === me.id)
    },
    {
      title: 'Launch a Warship',
      text: () => 'Warships sink enemy boats and capture trade ships. Once your Port has finished building, ' +
        'tap the Warship button, then tap open water near your coast.',
      glow: '.buildBtn[data-type="warship"]', gold: 'warship',
      done: me => Game.warships.some(w => w.owner === me.id)
    },
    {
      title: 'Build a Missile Silo',
      text: () => 'Nukes are launched from Silos. Tap the Missile Silo button, then tap your own land.',
      glow: '.buildBtn[data-type="silo"]', gold: 'silo',
      done: me => Tutorial.has(me, 'silo')
    },
    {
      title: 'Launch an Atom Bomb',
      text: () => 'Once the Silo has finished building, tap the Atom Bomb button, then tap a rival\'s land. ' +
        'A SAM Launcher shoots nukes down: theirs can stop yours, and yours can stop theirs.',
      glow: '.buildBtn[data-type="atombomb"]', gold: 'atombomb',
      done: me => Game.nukes.some(n => n.ownerId === me.id && n.nukeType === 'atombomb')
    }
  ],

  // Placed counts: the step is about placing it, and the next step's text
  // covers the wait where a finished one is needed.
  has(me, type) { return Game.unitsOwned(me, type) + Game.unitsPending(me, type) >= 1; },

  setup() {
    this.el = document.getElementById('tutorial');
    document.getElementById('tutorialBtn').addEventListener('click', () => this.start());
    document.getElementById('tutSkip').addEventListener('click', () => this.advance());
    document.getElementById('tutExit').addEventListener('click', () => this.exit());
    document.getElementById('tutKeep').addEventListener('click', () => this.stop());
    document.getElementById('tutMenu').addEventListener('click', () => this.exit());
    document.getElementById('game').addEventListener('pointerup', () => {
      if (this.active) this._runUntil = performance.now() + this.ACT_RUN_MS;
    });
  },

  // UI.togglePause hands the Pause button and the P key here during a
  // tutorial, so the player's pause and the freeze cannot undo each other.
  togglePause() {
    this.userPaused = !this.userPaused;
    this.applyPause();
  },

  applyPause() {
    const want = this.userPaused || this.frozen;
    if (LocalServer.paused !== want) LocalServer.setPaused(want);
  },

  start() {
    this._pending = true;
    this.host.start(this.CONFIG);
  },

  // A match is starting (main.js's `start` handler, every match). It is a
  // tutorial only if start() just asked for it.
  matchReady() {
    this.stop();
    this.active = this._pending;
    this._pending = false;
  },

  // Put the panel away and leave the match as an ordinary one.
  stop() {
    this.active = false;
    this.step = 0;
    this._shown = -1;
    this._latched = false;
    this._framed = false;
    this._runUntil = 0;
    this.setGlow(null);
    if (this.el) this.el.classList.add('hidden');
    // Hand the match back running. Only if this file was the one holding it:
    // stop() also runs at the start of every ordinary match.
    if (this.frozen || this.userPaused) {
      this.frozen = this.userPaused = false;
      this.applyPause();
    }
  },

  exit() {
    this.stop();
    this.host.exit();
  },

  advance() {
    this.step++;
    this._latched = false;
    this._runUntil = performance.now() + this.STEP_RUN_MS;
  },

  // Whether the match should be held right now (see `frozen`).
  shouldFreeze(me) {
    if (!this.STEPS[this.step] || this._latched || !Transport.isLocal) return false;
    const now = performance.now();
    // An order waiting for the next turn, or just sent.
    if (LocalServer.intents.length > 0) this._runUntil = Math.max(this._runUntil, now + this.ACT_RUN_MS);
    if (now < this._runUntil) return false;
    for (const type in me.unitsPending) if (me.unitsPending[type] > 0) return false;
    return true;
  },

  setFrozen(frozen) {
    if (this.frozen !== frozen) {
      this.frozen = frozen;
      document.getElementById('tutPaused').classList.toggle('off', !frozen);
    }
    this.applyPause();
  },

  setGlow(el) {
    if (this._glowEl === el) return;
    if (this._glowEl) this._glowEl.classList.remove('tutGlow');
    this._glowEl = el;
    if (el) el.classList.add('tutGlow');
  },

  // Once a frame, after UI.update (main.js's loop).
  frame() {
    if (!this.active) return;
    const me = Game.players[Game.me];
    // Spawn phase: the banner carries the prompt. Dead or decided: the end
    // screen has the floor.
    if (Game.spawning || !me || !me.alive || Game.winnerId !== null) {
      this.el.classList.add('hidden');
      this.setGlow(null);
      this.setFrozen(false);
      return;
    }
    this.el.classList.remove('hidden');

    // The match opens on the whole map, where a new capital is a dot. Bring
    // the view in on it once, about 110 tiles across the shorter side; the
    // player is free to move it from there. Camera only.
    if (!this._framed) {
      this._framed = true;
      const tile = me.tiles.values().next().value;
      if (tile !== undefined) {
        Render.jumpToTile(tile % GameMap.width, (tile / GameMap.width) | 0);
        Render.cam.scale = Math.min(window.innerWidth, window.innerHeight) / 110;
      }
    }

    const s = this.STEPS[this.step];
    if (s) {
      // Latched, then acted on next frame: some of these (a short attack, a
      // boat) are only true for a moment.
      if (this._latched) this.advance();
      else if (s.done(me)) this._latched = true;
      // TUTORIAL BYPASS (see the header): keep the build this step asks for
      // affordable, however the last gift was spent. Not once it is placed,
      // or the price of the next one would be handed over too.
      else if (s.gold && Transport.isLocal) {
        const cost = Game.unitCost(me, s.gold);
        if (me.gold < cost) me.gold = cost;
      }
    }
    if (this._shown !== this.step) this.show();
    this.setFrozen(this.shouldFreeze(me));

    // The build bar is rebuilt when a match's fog setting differs from the
    // last one's, so the element is looked up again if it has gone.
    const cur = this.STEPS[this.step];
    if (cur && cur.glow) {
      if (!this._glowEl || !this._glowEl.isConnected) this.setGlow(document.querySelector(cur.glow));
    } else {
      this.setGlow(null);
    }
  },

  show() {
    this._shown = this.step;
    this.setGlow(null);
    const s = this.STEPS[this.step];
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const finished = !s;
    document.getElementById('tutStep').textContent = finished ? '' : (this.step + 1) + '/' + this.STEPS.length;
    document.getElementById('tutTitle').textContent = finished ? 'You are ready' : s.title;
    document.getElementById('tutText').textContent = finished
      ? 'That is the whole toolkit. Forts hold a border, Factories earn gold by rail, and the bigger bombs are further ' +
        'along the build bar. ' + (touch ? '' : 'Rest the mouse on any button to see what it does. ') +
        'Gold is no longer free from here.'
      : s.text(touch);
    document.getElementById('tutSkip').classList.toggle('hidden', finished);
    document.getElementById('tutExit').classList.toggle('hidden', finished);
    document.getElementById('tutBtns').classList.toggle('hidden', !finished);
    document.getElementById('tutPaused').classList.toggle('hidden', finished);
    // Restart the arrival animation.
    this.el.classList.remove('tutNew');
    void this.el.offsetWidth;
    this.el.classList.add('tutNew');

    if (s && s.glow) {
      const el = document.querySelector(s.glow);
      this.setGlow(el);
      // The build bar scrolls sideways on a narrow screen.
      if (el && el.classList.contains('buildBtn')) el.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }
};
