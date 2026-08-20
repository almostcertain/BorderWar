(() => {
  const canvas = document.getElementById('game');
  Render.setup(canvas);
  Input.setup(canvas);
  Radial.setup();
  UI.setup();

  let lastFrame = 0;
  let accumulator = 0;
  const STEP = 0.1;

  // A bigger board on its own barely lengthens a match: the same handful of
  // conquests still decides it. What stretches a game is more nations, so each
  // one you beat is a smaller share of the world — which is how OpenFront's
  // large maps stay long. These defaults follow the map size, and are just
  // defaults; the field stays editable.
  //
  // OpenFront itself doesn't tie a bot/player count to map size at all —
  // config.bots() is a free host setting regardless of which map is loaded —
  // so there's no real number to port here. Rescaled from the old defaults to
  // match MAP_SIZES' now-real dimensions (small shrank; large and xlarge grew
  // substantially), capped at 31 to stay within PLAYER_COLORS/BOT_NAMES' 32
  // entries (31 bots + the human).
  const BOTS_FOR_SIZE = { small: 5, medium: 10, large: 20, xlarge: 31 };

  // Tribes are OpenFront's low-effort filler (openfront.wiki/Bots): weak and
  // half-capped individually, so a map can carry more of them than Nations
  // without the early game turning into an unbeatable wall. Roughly double
  // the Nation count at each size, same free-editable-field treatment.
  const TRIBES_FOR_SIZE = { small: 8, medium: 16, large: 32, xlarge: 50 };

  const sizeSelect = document.getElementById('mapSize');
  const botInput = document.getElementById('botCount');
  const tribeInput = document.getElementById('tribeCount');
  sizeSelect.addEventListener('change', () => {
    botInput.value = BOTS_FOR_SIZE[sizeSelect.value] || 9;
    tribeInput.value = TRIBES_FOR_SIZE[sizeSelect.value] || 16;
  });

  function start() {
    const bots = Math.max(2, Math.min(31, parseInt(botInput.value, 10) || 9));
    const tribes = Math.max(0, Math.min(80, parseInt(tribeInput.value, 10) || 0));
    const mapSize = sizeSelect.value;
    Game.init(bots, tribes, (Math.random() * 1e9) | 0, mapSize);
    Render.onMapReady();
    Render.centerOnMap();
    UI.reset();
    UI.enterSpawnSelect();

    document.getElementById('overlay').classList.add('hidden');
    document.getElementById('endOverlay').classList.add('hidden');
    lastFrame = performance.now();
    accumulator = 0;
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (!Render.tileCanvas) return;

    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;

    accumulator += dt;
    while (accumulator >= STEP) {
      Game.tick(STEP);
      accumulator -= STEP;
    }

    Render.draw();
    UI.update();
    if (Game.running) UI.checkEndGame();
  }

  document.getElementById('startBtn').addEventListener('click', start);
  document.getElementById('restartBtn').addEventListener('click', () => {
    document.getElementById('endOverlay').classList.add('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    // The finished match's player still exists until Game.init() runs again,
    // which would otherwise leave the debug panel floating over this menu.
    document.getElementById('debugPanel').classList.add('hidden');
  });

  requestAnimationFrame(loop);
})();
