'use strict';

// Fetches a baked map (maps/<id>/{manifest.json, map.bin}) once per page load
// and hands the parsed bytes to GameMap.loadWorld via GameMap.mapData[id].
// Kept out of the sim: fetch() is non-deterministic, so only the resulting
// bytes (a static asset, identical everywhere) reach it. 'world' is preloaded
// at startup (main.js); ensure(id) is awaited again before Game.init.
const WorldMapLoader = {
  _promises: {},

  // Idempotent per id. Resolves once GameMap.mapData[id] is populated. A
  // failure clears the cached promise, so a later call retries.
  ensure(id) {
    id = id || 'world';
    if (!this._promises[id]) {
      const fetchJSON = (url) => fetch(url).then(r => {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.json();
      });
      const fetchBytes = (url) => fetch(url).then(r => {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.arrayBuffer();
      });
      this._promises[id] = Promise.all([
        fetchJSON('maps/' + id + '/manifest.json'),
        fetchBytes('maps/' + id + '/map.bin')
      ]).then(([manifest, buf]) => {
        GameMap.mapData[id] = { manifest: manifest.map, bytes: new Uint8Array(buf) };
      }).catch((err) => {
        delete this._promises[id];
        throw err;
      });
    }
    return this._promises[id];
  }
};
