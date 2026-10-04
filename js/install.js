// "Add to Home Screen" button on the main menu, phones and tablets only
// (ticket #49). Client-only; nothing here touches the sim.
//
// Chromium browsers on Android fire beforeinstallprompt once the page meets
// their install criteria (manifest.webmanifest plus HTTPS). We hold on to it,
// and the button replays it, opening the browser's own install dialog. Safari
// on iOS and Firefox have no such event, so there the button opens a short
// guide to the browser's own menu instead.
//
// There is deliberately no service worker: the server sends every file
// no-store and the loader cache-busts every script, so an installed copy
// always loads the current build and is never turned away as out of date.
const Install = (function() {
  const btn = document.getElementById('installBtn');
  const guideEl = document.getElementById('installGuide');
  const stepsEl = document.getElementById('installSteps');
  let deferred = null;

  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch points give it away.
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isMobile = isIOS || /Android/.test(ua) || window.matchMedia('(pointer: coarse)').matches;

  function installed() {
    return navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  }

  function refresh() {
    btn.classList.toggle('hidden', !isMobile || installed());
  }

  function steps() {
    if (isIOS) {
      return /CriOS|FxiOS|EdgiOS/.test(ua)
        ? ['Tap the <b>Share</b> button in the address bar.', 'Choose <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.']
        : ['Tap the <b>Share</b> button in Safari (on newer iPhones it is under the <b>•••</b> menu).', 'Scroll down and choose <b>Add to Home Screen</b>.', 'Tap <b>Add</b>.'];
    }
    return ['Open the browser menu (<b>⋮</b> or <b>☰</b>).', 'Choose <b>Install app</b> or <b>Add to Home screen</b>.', 'Confirm.'];
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();   // no browser mini-infobar; our button asks instead
    deferred = e;
    refresh();
  });
  window.addEventListener('appinstalled', () => { deferred = null; refresh(); });

  btn.addEventListener('click', () => {
    if (deferred) {
      const e = deferred;
      deferred = null;   // a prompt can only be shown once
      e.prompt();
      e.userChoice.finally(refresh);
      return;
    }
    stepsEl.innerHTML = steps().map(s => '<li>' + s + '</li>').join('');
    guideEl.classList.remove('hidden');
  });
  document.getElementById('installClose').addEventListener('click', () => guideEl.classList.add('hidden'));
  guideEl.addEventListener('click', e => { if (e.target === guideEl) guideEl.classList.add('hidden'); });

  refresh();
  return { installed };
})();
