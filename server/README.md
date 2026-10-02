# Running the BorderWar server (self-hosted, D3)

Per `docs/multiplayer-architecture.md` §6.1: this server runs on the owner's own
Windows 11 machine, no cloud. `GameManager`/`GameServer` do no simulation — a
desktop CPU is wildly over-provisioned for a turn relay — so the only real
question is *reachability*, and it has three answers depending on who needs to
reach it.

## Quick reference

| Tier | Scope | Setup | Use when |
|---|---|---|---|
| **1** | Same machine | `cd server && npm install && node index.js`, open `http://localhost:8124` in two tabs | Development, automated two-client tests |
| **2** | Same house / LAN | Add a Windows Defender Firewall inbound rule for the port on *private* networks, then `http://<lan-ip>:8124` from another device | Local playtesting |
| **3** | Over the internet | Cloudflare Tunnel (`cloudflared`) in front of the local port; connect over `wss://` | Friends elsewhere |

Starting the server from cold is four commands:

```
cd server
npm install
node index.js
```

(or `npm start`, which just runs `node index.js`). It listens on port `8124` by
default; override with `PORT=<n> node index.js`. Ctrl+C sends `SIGINT`, which
the server handles gracefully (terminates open sockets, then exits).

### Mac quick start

Prereqs (once): Node (`brew install node`) and, for internet play,
`brew install cloudflared`. Then:

- **Local only** (no multiplayer, static page): double-click `local-mac.command`
  → `http://localhost:8123`.
- **Local multiplayer server** (no tunnel): double-click `mac-server.command`.
  It installs `server/node_modules` on first run, starts the server on
  `http://localhost:8124` and opens it in your browser. Ctrl+C stops it.
- **Live server (borderwar.io)**: double-click `tools/live-mac.command`. It
  opens one Terminal window for the server and one for the Cloudflare tunnel.
  Close a window or press Ctrl+C to stop that piece.
- **borderwar.io (one-time setup)**: `tools/live-mac.command` serves `https://borderwar.io`
  once a named tunnel called `borderwar` exists on this Mac; until then it falls
  back to a random quick-tunnel link. `borderwar.io` must be a zone in your
  Cloudflare account.
  ```
  cloudflared tunnel login                      # browser: pick borderwar.io
  cloudflared tunnel create borderwar
  cloudflared tunnel route dns borderwar borderwar.io
  ```
  If the tunnel already exists (e.g. from the Windows machine), skip `create`
  and `route dns`; copy its `<uuid>.json` credentials file and `cert.pem` into
  `~/.cloudflared/` instead. Don't run it on both machines at once, or
  Cloudflare splits visitors between them.
- **Stay awake while hosting** (a sleep kills running matches):
  `tools/live-mac.command` does this automatically while its server window is
  open. For `mac-server.command`, run `caffeinate -dims` in another tab.
- **LAN play**: macOS asks "allow incoming connections for node?" the first
  time; click Allow. Find your IP with `ipconfig getifaddr en0` and browse to
  `http://<ip>:8124` from the other device.
- First double-click of a `.command` file may be blocked by Gatekeeper;
  right-click → Open once, or run `chmod +x *.command`.

---

## Tier 1 — Same machine

**Verified in this environment** with a scripted Node `ws` client, the same
technique used to verify MP-2.1/MP-2.2 (two clients joining one lobby get a
byte-identical turn stream).

What was run (against a throwaway port, 18124, so it wouldn't collide with a
real dev instance):

1. `GET http://localhost:18124/` → `200`, `5757` bytes (the game's `index.html`).
2. Two `ws` clients connected to `ws://localhost:18124/ws`, each sent a `join`
   for the same `gameID`.
3. The lobby's `GameServer.start()` was invoked once both had joined (there is
   no wire-level "start" message yet — MP-2.3's lobby UI owns that trigger;
   MP-2.2's own verification called `start()` directly the same way).
4. One `spawn` intent was sent from client "alice".

Actual output:

```
--- HTTP static check ---
GET / -> { status: 200, len: 5757 }
--- WS join + turn stream check ---
alice clientID= 0 bob clientID= 1
alice turns received: 6
bob turns received: 6
byte-identical turn stream (first 6 turns): true
at least one turn carried an intent: true
intent stamped with server-assigned clientID: true
sample turn with intent: {"turnNumber":0,"intents":[{"type":"spawn","tile":12345,"clientID":"0"}]}
```

Both clients received the identical sequence of `turn` messages, and the
`spawn` intent came back stamped with the *server-assigned* `clientID` ("0"),
not anything the client could have forged — confirming the authorship
guarantee from `GameServer.handleIntent` still holds end to end over a real
socket, not just in-process.

---

## Tier 2 — Same house / LAN

**What §6.1 specifies:** add a Windows Defender Firewall *inbound* rule scoped
to the **Private** network profile for the server's port, then reach it from
another device on the same network at `http://<lan-ip>:PORT`.

**What was actually verified here, and what wasn't:**

This machine has no second physical device to test from as a genuine remote
client, so the "another device on the LAN" half of the story is not something
this task can literally reproduce. What *is* directly testable, and was
tested, is the actual failure mode a firewall rule exists to fix: whether the
server is listening on all interfaces or only on loopback, and whether a
client using the machine's real LAN IP (not `localhost`) can actually reach it.

**(a) Bind address.** Started the server for real (`PORT=18125 node index.js`)
and checked with `netstat`:

```
> netstat -ano | findstr :18125
  TCP    0.0.0.0:18125          0.0.0.0:0              LISTENING       8756
  TCP    [::]:18125             [::]:0                 LISTENING       8756
```

`0.0.0.0` / `[::]`, not `127.0.0.1` — Node's default `server.listen(PORT)` (no
host argument) binds every interface, so nothing here needs changing to make
LAN reachability possible in principle.

**(b) This machine's LAN-facing IP.** From `ipconfig`, the Ethernet adapter's
IPv4 address is a private `192.168.x.x` address (a VPN virtual adapter
also shows up in `ipconfig`, irrelevant here).

**(c) A scripted client connecting to that IP instead of `localhost`.** Real
output:

```
HTTP GET http://192.168.x.x:18125/ -> 200 5757 bytes
WS OPEN via ws://192.168.x.x:18125/ws
sent join message over the LAN-IP socket
WS opened and join sent via LAN IP with no error/close in 1.5s -- OK
```

Both the static page and the WebSocket upgrade answered on the LAN IP exactly
as they did on `localhost` — meaningful evidence the bind itself is not
loopback-restricted (the thing that would otherwise make a firewall rule
pointless). This is **not** the same as proving a second physical machine can
reach it across the network — only this host's own bind behavior was checked.

**(d) The firewall rule itself.** Not independently verified in this
environment, and no firewall rule was created or modified as part of this task
(changing firewall/security configuration is outside this task's scope). Two
things worth knowing, found while checking (read-only), not changed:

- This machine's Ethernet interface is currently categorized by Windows as
  **Public**, not Private (`Get-NetConnectionProfile`).
- A pre-existing inbound rule, "Node.js JavaScript Runtime", already allows
  Node on the **Public** profile — which is why the LAN-IP test above
  succeeded without any new rule. That rule is broader than what §6.1
  recommends (Private-profile-only) and predates this task; it was not
  created for this verification and was left untouched.

Do not rely on that pre-existing rule for a real session — it's an artifact of
this particular machine's history, not something this task set up, and it's
wider than needed. Follow the steps below to add a properly scoped rule.

**Documented, not independently verified in this environment:** the exact
steps to open a Private-only inbound rule for the game's port.

GUI (Windows Defender Firewall with Advanced Security):

1. Win+R → `wf.msc` → Enter.
2. Inbound Rules → New Rule…
3. Rule type: **Port**.
4. **TCP**, Specific local ports: `8124` (or whatever `PORT` is set to).
5. Action: **Allow the connection**.
6. Profile: check **Private** only (uncheck Domain and Public).
7. Name it something identifiable, e.g. `BorderWar Server (LAN)`.

Command line (run as Administrator), equivalent to the above:

```
netsh advfirewall firewall add rule name="BorderWar Server (LAN)" dir=in action=allow protocol=TCP localport=8124 profile=private
```

Then from another device on the same private network, browse to
`http://192.168.x.x:8124` (substitute this machine's actual current LAN IP —
it can change between sessions on most home routers).

---

## Tier 3 — Over the internet (Cloudflare Tunnel)

**§6.1's recommendation, and why:** Cloudflare Tunnel over port forwarding,
because it needs no router configuration, works behind CGNAT (which breaks
port forwarding outright and is common on residential ISPs), doesn't expose
the home IP, and terminates HTTPS for free — which is what makes the
`wss://`-from-`https://` requirement (below) a non-issue for this tier.

**Checked in this environment:** `cloudflared --version` → not found (`command
not found`, and no `cloudflared` on `PATH`). No install or account-creation
step was attempted — installing software and creating a Cloudflare account
are both outside this task's authority (see the architecture doc's task scope
and the general constraint against actions requiring a login/account/payment).

So Tier 3 is **documented from the official Cloudflare Tunnel docs' current
published steps, not live-tested in this environment.**

1. Install `cloudflared`:
   - Windows: download the installer/binary from
     `https://github.com/cloudflare/cloudflared/releases` (or, if you use
     `winget`: `winget install --id Cloudflare.cloudflared`).
2. Authenticate once (opens a browser to your Cloudflare account/domain):
   ```
   cloudflared tunnel login
   ```
3. Create a named tunnel:
   ```
   cloudflared tunnel create borderwar
   ```
   This writes a credentials file and prints the tunnel's UUID.
4. Create a config file (e.g. `%USERPROFILE%\.cloudflared\config.yml`) pointing
   the tunnel at the local server:
   ```yaml
   tunnel: borderwar
   credentials-file: C:\Users\<you>\.cloudflared\<tunnel-uuid>.json
   ingress:
     - hostname: borderwar.yourdomain.com
       service: http://localhost:8124
     - service: http_status:404
   ```
5. Point a DNS record at the tunnel (requires a domain on Cloudflare):
   ```
   cloudflared tunnel route dns borderwar borderwar.yourdomain.com
   ```
6. Run it:
   ```
   cloudflared tunnel run borderwar
   ```
7. Share `https://borderwar.yourdomain.com` with remote friends. The game page
   loads over `https://`; the browser client (`js/net/transport.js`) must open
   its socket as `wss://`, derived from `location`, never hardcoded — see
   "Wire origin" below.

If a domain isn't available, `cloudflared tunnel --url http://localhost:8124`
(the "quick tunnel" mode) needs no login or domain and hands back a random
`*.trycloudflare.com` HTTPS URL — the lowest-friction option for a one-off
playtest, at the cost of the URL changing every run.

### The one thing that *was* checked without a tunnel

`server/index.js` doesn't need to know anything about HTTPS/WSS — TLS
termination happens at the tunnel, not in this Node process; the server always
speaks plain HTTP/WS. A grep of everything under `server/` (excluding
`node_modules`) for a hardcoded scheme found exactly two hits, neither a
problem:

```
server/package-lock.json:16:  "resolved": "https://registry.npmjs.org/ws/-/ws-8.21.3.tgz"   (npm metadata, irrelevant)
server/index.js:121:  console.log('[frontline-server] listening on http://localhost:' + PORT ...)  (a startup log line, not used to build any response or served URL)
```

Nothing in `server/` builds a response, a redirect, or a served URL using a
hardcoded `http://`/`ws://` — the server is scheme-agnostic by construction,
which is exactly what being fronted by a tunnel requires.

**Wire origin — this is a browser-side requirement, not a server one.**
Because the tunnel serves the page over HTTPS, the browser will refuse to open
an insecure `ws://` socket from a secure `https://` page (mixed content). That
requirement is enforced in `js/net/transport.js` (`Transport.connectRemote`,
per the architecture doc §6.1: derive `wss://` vs `ws://` from
`location.protocol`, never hardcode). This server-side task has nothing further
to verify about that beyond the grep above — the server doesn't do anything
scheme-specific that would conflict with being fronted by a tunnel.

**Full end-to-end proof deferred.** A real played match between two people on
different networks through a live tunnel is explicitly **not** attempted here:
`cloudflared` isn't installed in this environment, and separately,
`Transport.connectRemote` in the browser client is still a stub that throws as
of this task (MP-2.3, the lobby UI, is what wires up a real remote connection,
and is a separate, parallel task). The wire-level pieces this task *can* prove
— HTTP works over the tunnel's protocol boundary, the server is
scheme-agnostic, the WS upgrade path works the same regardless of scheme — are
proven above; the played-match proof is deferred until MP-2.3 lands.

---

## Two operational caveats (§6.1) — easy to forget under pressure

### 1. The turn log is in memory only

A server restart, a crash, or the machine going to sleep kills every in-flight
match — there is no persistence and no resume (fixing this, a turn-log flush
to disk, is out of scope here; see §6.1 and Phase 5 of the architecture doc).
**This is acceptable for playtesting.** If you're hosting a real session,
disable the machine's sleep timer for the duration.

Abandoned games are cleaned up: an empty lobby is removed at once, and a
running match with no connected players for 2 minutes
(`GameServer.abandonedTimeout`) is ended and reaped. A player who reconnects
inside that window keeps the match alive.

Verified command (checked against this machine's actual `powercfg /change`
help text, not guessed):

```
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
```

`0` means "never sleep" (the value is in minutes). `-ac` is while plugged in,
`-dc` is on battery — set both, since a laptop can flip between them mid-session.
To restore normal behavior afterward, set both back to a real number of
minutes (Windows' own default is commonly `30`, but check
Settings → System → Power & battery for this machine's prior value before
assuming).

On this machine, `standby-timeout` was already set to `0` (never) on both AC
and DC in the active power scheme (`High performance`) — checked with
`powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`, not changed. A
different machine may not start out this way; run the two commands above to
be sure before a real hosted session.

### 2. The host's own client gets no special treatment

The person running `node index.js` connects to their own server exactly like
anyone else — an ordinary client on `localhost`, nothing more. `GameServer`
has no concept of "the host" at all (see `gameserver.js`: `joinClient` treats
every connection identically regardless of where it came from). Do not let
"am I the host" creep in anywhere as a trust decision later — under lockstep,
nobody is authoritative except the turn relay itself, and that's true whether
the machine running it happens to also be someone's living-room PC.

---

## What this task did and did not touch

Only `server/README.md` (this file) was added. `.gitignore` was checked, not
changed: `node_modules/` (no leading slash, so it matches at any depth) already
covers `server/node_modules` — confirmed with
`git check-ignore -v server/node_modules` before deciding not to add a
redundant entry. No file under `js/`, `index.html`, or any of
`server/gameserver.js` / `server/gamemanager.js` / `server/client.js` /
`server/index.js` was modified.
