'use strict';

// Fetches OpenFront's real "World" map data (maps/world/{manifest.json,
// map.bin}) once per page load and hands the parsed bytes to GameMap.loadWorld
// via GameMap.worldData. Kept out of js/game/*: fetch() is exactly the kind of
// non-deterministic, environment-dependent call the sim must never make (see
// CLAUDE.md's determinism rules), so the network access happens here, in
// ordinary client code, and only the resulting bytes — identical for every
// client, since it's a static asset, not per-seed data — ever reach the sim.
//
// Preloaded eagerly at startup (main.js) so it is normally already resolved
// by the time a match actually starts; ensure() is also awaited right before
// Game.init as a safety net for a slow or just-opened connection.
const WorldMapLoader = {
  _promise: null,

  // Idempotent: safe to call from multiple places without triggering extra
  // fetches. Resolves once GameMap.worldData is populated. A failure clears
  // the cached promise rather than poisoning it forever, so a later call
  // (e.g. clicking Start again after a transient network error) retries the
  // fetch instead of replaying the same rejection for the rest of the tab's
  // life.
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
