// Client — a thin wrapper around one WebSocket connection.
//
// MP-2.2 fills in the identity fields MP-2.1 left as a TODO (see that task's
// scope note, still true of the shape below): a joined connection needs a
// server-assigned `clientID`, the roster info that came with its `join`
// (`username`, `spectator`), and whether it currently counts toward the
// active roster (`active`). `isAlive` was added in MP-2.1 for MP-3.4's
// ping/pong liveness sweep; that sweep is this file's own change below.
class Client {
  constructor(ws) {
    this.ws = ws;

    // Liveness (MP-3.4). `isAlive` is the verdict a sweep has already reached
    // ("still counts as connected" vs "timed out and already handled") —
    // GameServer's sweep flips it false once, the moment it synthesizes the
    // disconnect intent, so the same client is never re-processed on a later
    // tick (see GameServer._sweepLiveness). `lastPing` is the raw
    // `Date.now()` timestamp a sweep actually measures staleness against — a
    // boolean alone can only say "connected or not right now", not "how long
    // has it been silent", which is the question a 30s timeout needs
    // answered. Set on construction so a freshly-joined client isn't
    // immediately eligible for a timeout before its first real message.
    this.isAlive = true;
    this.lastPing = Date.now();

    // Populated by GameServer.joinClient / rejoinClient (server/gameserver.js).
    // Stays at these defaults for a connection that never gets past the
    // lobby's join check — that connection is simply closed, never added to
    // a GameServer's roster.
    this.clientID = null;   // string — server-assigned, short, per-game public id
    this.username = null;   // string — from the `join` message
    this.spectator = false; // bool — from the `join` message
    this.active = false;    // bool — true while counted in the roster

    // MP-4.3: intents this client has sent since the last endTurn() reset
    // this to 0 (see GameServer.handleIntent / GameServer.endTurn). Not a
    // security control (see docs/multiplayer-architecture.md D2) — just a
    // cap on malformed/flooding traffic, not a defense against a modified
    // client that stays within the intent grammar.
    this.intentsThisTurn = 0;
  }

  // Send a Protocol `error` message (best-effort — the socket may already be
  // on its way down) and close the connection. This is the "reject cleanly"
  // primitive both GameManager (a malformed first message) and GameServer
  // (joinClient's mid-game-join rejection, rejoinClient's no-such-game/
  // nothing-to-rejoin rejections) need, so it lives here rather than being
  // copy-pasted in both call sites.
  //
  // Takes a raw `ws`, not a Client — GameManager calls this before any
  // Client has been constructed for the connection (the first message hasn't
  // even been validated yet), and GameServer calls it with `client.ws`.
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
