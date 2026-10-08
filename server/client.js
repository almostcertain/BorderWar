// Client: a thin wrapper around one WebSocket connection, plus its
// server-assigned identity and liveness state.
class Client {
  constructor(ws) {
    this.ws = ws;

    // Liveness. `isAlive` is the sweep's verdict: GameServer flips it false
    // once, when it synthesizes the disconnect intent, so a client is never
    // processed twice. `lastPing` is the Date.now() the sweep measures silence
    // against; set on construction so a new client can't time out at once.
    this.isAlive = true;
    this.lastPing = Date.now();

    // Populated by GameServer.joinClient / rejoinClient.
    this.clientID = null;   // string — server-assigned, short, per-game public id
    this.username = null;   // string — from the `join` message
    this.spectator = false; // bool — from the `join` message
    this.active = false;    // bool — true while counted in the roster
    this.persistentID = null; // string from `join`; never logged or broadcast
    this.cosmetics = null;    // { title, emblem, banner } or null (server/loadouts.js)

    // Intents sent since the last endTurn() reset. A cap on flooding
    // traffic, not a security control (D2).
    this.intentsThisTurn = 0;
  }

  // Send a Protocol `error` message (best-effort) and close the connection.
  // Takes a raw `ws`, not a Client: GameManager calls this before any Client
  // exists for the connection.
  static closeWithError(ws, error, message) {
    const Protocol = require('../js/net/protocol.js');
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(Protocol.msg.error(error, message)));
      }
    } catch (e) {
      // Socket already closing/closed — nothing to do.
    }
    try {
      ws.close(1008, error); // 1008 Policy Violation
    } catch (e) {
      // Already closed.
    }
  }
}

module.exports = Client;
