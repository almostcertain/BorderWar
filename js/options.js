// Player options: per-browser, client-only display and input preferences,
// opened from the main menu's Options button. Nothing here touches the sim.
// Values persist in localStorage as one JSON blob and apply the moment they
// change.
const Options = (function() {
  const KEY = 'borderwar_options';
  // Battery saver starts on for phones and tablets, off where there is a mouse.
  const touchDevice = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const DEFAULTS = { lowGfx: false, saveBattery: touchDevice, showPerf: false, hideHint: false, uiScale: 1, invertZoom: false, musicOn: true, musicVol: 0.7 };
  const values = Object.assign({}, DEFAULTS);

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const k in DEFAULTS) if (typeof saved[k] === typeof DEFAULTS[k]) values[k] = saved[k];
    } else if (localStorage.getItem('borderwar_lowgfx') === '1') {
      values.lowGfx = true;   // the old standalone Low graphics setting
    }
  } catch (e) { /* ignore */ }

  const perfEl = document.getElementById('perfStats');
  let frames = 0, sampleStart = 0;

  function apply() {
    Render.setLowRes(values.lowGfx);
    MenuBg.setEnabled(!values.lowGfx);
    document.body.classList.toggle('noHint', values.hideHint);
    document.documentElement.style.setProperty('--ui-scale', values.uiScale);
    perfEl.classList.toggle('hidden', !values.showPerf);
    if (!values.showPerf) { frames = 0; sampleStart = 0; }
    Music.set(values.musicOn, values.musicVol);
  }

  function set(key, value) {
    values[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch (e) { /* ignore */ }
    // Music is also toggled from outside this dialog (the in-game button, M).
    if (boxes[key]) document.getElementById(boxes[key]).checked = value;
    apply();
  }

  // Called once per rendered frame; refreshes the readout twice a second.
  function perfFrame(now) {
    if (!values.showPerf) return;
    if (!sampleStart) sampleStart = now;
    frames++;
    if (now - sampleStart < 500) return;
    let text = Math.round(frames * 1000 / (now - sampleStart)) + ' fps';
    if (Transport.rtt !== null && !Transport.isLocal) text += ' · ' + Transport.rtt + ' ms';
    perfEl.textContent = text;
    frames = 0; sampleStart = now;
  }

  const overlayEl = document.getElementById('optionsOverlay');
  const boxes = { lowGfx: 'optLowGfx', saveBattery: 'optSaveBattery', showPerf: 'optShowPerf', hideHint: 'optHideHint', invertZoom: 'optInvertZoom', musicOn: 'optMusicOn' };
  for (const key in boxes) {
    const el = document.getElementById(boxes[key]);
    el.checked = values[key];
    el.addEventListener('change', () => set(key, el.checked));
  }
  const scaleEl = document.getElementById('optUiScale');
  scaleEl.value = String(values.uiScale);
  if (scaleEl.value !== String(values.uiScale)) scaleEl.value = '1';
  scaleEl.addEventListener('change', () => set('uiScale', parseFloat(scaleEl.value)));
  // Menus are silent, so moving the slider plays the music until the dialog
  // closes: otherwise there would be nothing to set the volume against.
  const volEl = document.getElementById('optMusicVol');
  volEl.value = String(values.musicVol);
  volEl.addEventListener('input', () => {
    Music.preview(true);
    set('musicVol', parseFloat(volEl.value));
  });

  const close = () => { overlayEl.classList.add('hidden'); Music.preview(false); };
  document.getElementById('optionsBtn').addEventListener('click', () => overlayEl.classList.remove('hidden'));
  document.getElementById('optionsClose').addEventListener('click', close);
  overlayEl.addEventListener('click', e => { if (e.target === overlayEl) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlayEl.classList.contains('hidden')) close();
  });

  apply();
  return { get: key => values[key], set, perfFrame };
})();
