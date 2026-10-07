'use strict';

// Fetches the World map data (maps/world/{manifest.json, map.bin}) once per
// page load and hands the parsed bytes to GameMap.loadWorld via
// GameMap.worldData. Kept out of the sim: fetch() is non-deterministic, so
// only the resulting bytes (a static asset, identical everywhere) reach it.
// Preloaded at startup (main.js); ensure() is awaited again before Game.init.
const WorldMapLoader = {
  _promise: null,

  // Idempotent. Resolves once GameMap.worldData is populated. A failure
  // clears the cached promise, so a later call retries.
  ensure() {
    if (!this._promise) {
      const fetchJSON = (url) => fetch(url).then(r => {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.json();
      });
      const fetchBytes = (url) => fetch(url).then(r => {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.arrayBuffer();
      });
      this._promise = Promise.all([
        fetchJSON('maps/world/manifest.json'),
        fetchBytes('maps/world/map.bin')
      ]).then(([manifest, buf]) => {
        GameMap.worldData = { manifest: manifest.map, bytes: new Uint8Array(buf) };
      }).catch((err) => {
        this._promise = null;
        throw err;
      });
    }
    return this._promise;
  }
};
