# Hosting BorderWar on a cloud box

How to run the live server (borderwar.io) on a rented Linux machine instead of
the owner's PC. Nothing about the game or the server changes: it is the same
`node server/index.js` behind a Cloudflare Tunnel, on a machine that stays on.

The live site has run this way since 2026-10-05, on a DigitalOcean Droplet.

## Quick reference

| What | Where |
|---|---|
| Code | `/opt/borderwar` (a git checkout of `main`, owned by user `borderwar`) |
| Data (accounts database, backups, admin token, chart history) | `/opt/borderwar/server/data` |
| Server service | `borderwar` (`tools/cloud/borderwar.service`) |
| Tunnel service | `cloudflared`, config in `/etc/cloudflared/`; the tunnel is named `borderwar-cloud` |
| Update to latest `main` | `bash /opt/borderwar/tools/cloud/update.sh` |
| Admin page Restart / Pull latest buttons | one-time `bash /opt/borderwar/tools/cloud/install-admin-update.sh` (see below) |
| Server log | `journalctl -u borderwar -f` |
| Stop now (players are told) | `systemctl stop borderwar` |
| Start | `systemctl start borderwar` |
| Account admin commands | `cd /opt/borderwar && runuser -u borderwar -- node server/accounts/admin.js ...` |

## Why this shape

- **A plain always-on box.** Matches live in the server's memory and accounts
  live in a SQLite file, so the host must not sleep when idle and must keep its
  disk. That rules out the free "scale to zero" platforms.
- **Still behind a tunnel.** Cloudflare Tunnel dials out from the box, so no
  inbound port is open except SSH, HTTPS is handled by Cloudflare, and the
  server's rate limiting keeps seeing real player addresses
  (`CF-Connecting-IP`, trusted only from loopback; see `docs/accounts-auth.md`).
  The box has its own tunnel (`borderwar-cloud`), so no other machine holds
  credentials that can serve the site.
- **A git checkout, not a build.** The server reads its build ID from git
  (`tools/build-info.js`), and clients must match it. Never edit files on the
  box: a modified checkout marks the build as dirty.

## First-time setup

### 1. Create the box (owner, in the provider's site)

Any provider works (Hetzner, DigitalOcean, Vultr and so on). Pick:

- **Ubuntu 24.04 LTS**, the smallest regular size (1 vCPU, 1 to 2 GB RAM). The
  server relays turns and does no simulation, so this is plenty.
- **A region near most players.** Every turn goes through this box.
- **SSH key sign-in**, not a password.
- **The provider's automatic backups**, if offered. The daily database backups
  sit on the same disk as the database, so they do not survive losing the box.

### 2. Install everything (on the box, as root)

```
curl -fsSLo setup.sh https://raw.githubusercontent.com/almostcertain/BorderWar/main/tools/cloud/setup.sh
bash setup.sh
```

This installs Node 22 and cloudflared, clones the repo, installs the service
and turns on the firewall (SSH only). It does not start anything yet.

### 3. Move the data (optional)

Skip this to start with an empty accounts database. To keep existing accounts,
stop the old host first (`node tools/drain-server.js` lets matches finish),
then copy its `server/data` folder from that machine, replacing `BOX` with the
box's public IP address:

```
scp -r server/data root@BOX:/root/bw-data
```

It holds the accounts database, its backups, the admin token and the chart
history, so treat it as secret. Then on the box:

```
cp -a /root/bw-data/. /opt/borderwar/server/data/
chown -R borderwar:borderwar /opt/borderwar/server/data
chmod 700 /opt/borderwar/server/data
rm -rf /root/bw-data
```

### 4. Start the server and connect the tunnel

On the box:

```
systemctl start borderwar
curl http://localhost:8124/buildinfo.json
```

The box uses its own tunnel rather than one shared with another machine. On a
computer already signed in to Cloudflare (`cloudflared tunnel login`), create
it and copy its credentials file to the box:

```
cloudflared tunnel create borderwar-cloud
scp ~/.cloudflared/<tunnel-id>.json root@BOX:/etc/cloudflared/
```

`create` prints the tunnel ID and where it wrote the file. On the box, write
`/etc/cloudflared/config.yml` with that ID in both lines:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: borderwar.io
    service: http://localhost:8124
  - service: http_status:404
```

Then:

```
chmod 600 /etc/cloudflared/<tunnel-id>.json
cloudflared service install
systemctl status cloudflared --no-pager
```

Last, point the domain at the tunnel. In the Cloudflare dashboard, open
borderwar.io, then DNS, then Records, and set the `borderwar.io` CNAME's target
to `<tunnel-id>.cfargotunnel.com`, proxied.

Use the dashboard for this, not `cloudflared tunnel route dns`. On a machine
whose `~/.cloudflared/config.yml` names another tunnel, that command routed the
domain to the config's tunnel instead of the one given, and `--overwrite-dns`
then refused to replace the record.

Then check from any browser: `https://borderwar.io` loads, sign-in works, and
`https://borderwar.io/admin` accepts the token in
`/opt/borderwar/server/data/admin-token.txt`. Both services start on their own
after a reboot. Cloudflare error 1033 means the tunnel is not connected: look
at `journalctl -u cloudflared -n 30`.

### 5. Retire the other hosts

Do not run `tools/live server deploy.bat` or `tools/live-mac.command` to serve
borderwar.io while the box is live: each machine would have its own copy of the
accounts. They use the older `borderwar` tunnel, which the domain no longer
points at. `win-server.bat` (a temporary trycloudflare link) and the local dev
servers are unaffected.

## Updating the live game

After pushing to `main`, on the box:

```
bash /opt/borderwar/tools/cloud/update.sh
```

It blocks new games, waits up to 30 minutes for matches in progress to finish
(pass a different number of minutes as the argument), then pulls, installs and
starts the new build and prints its build ID. If the box is already on the
latest commit it does nothing.

### From the admin page

The admin page's **Restart** and **Pull latest & restart** buttons do the same
drain-then-start, without SSH. The server itself can't restart or pull (it runs
unprivileged and can't write its own code); a button only writes
`server/data/update-request`. `borderwar-update.path` (root) sees the file and
runs `admin-update.sh`, which drains and then restarts or calls `update.sh`.

Turn it on once, as root on the box, then restart the server:

```
bash /opt/borderwar/tools/cloud/install-admin-update.sh
systemctl restart borderwar   # players are told; pick a quiet moment
```

The scripts root runs are copies in `/usr/local/lib/borderwar/`, because the
checkout is writable by the server user. Run the installer again after any
change to `update.sh` or `admin-update.sh`. Pulling from the admin page never
replaces the systemd unit file; use `update.sh` over SSH for that. Progress is in
`journalctl -u borderwar-update`.

## Going back to a home machine

Stop both services on the box (`systemctl stop cloudflared borderwar`), copy
`/opt/borderwar/server/data` over that machine's `server/data` to keep the
accounts, point the `borderwar.io` CNAME at that machine's tunnel in the
Cloudflare dashboard, and run its live script.

## Notes

- **Restarts still end matches.** The turn log is in memory
  (`docs/multiplayer-architecture.md` §6.1). The box removes the "PC went to
  sleep" cause, not the limitation.
- **A reboot stops the server at once**, after telling connected players. Use
  `update.sh` or `node tools/drain-server.js` beforehand to let matches finish.
- **System updates.** `unattended-upgrades` installs security patches but does
  not reboot. Reboot at a quiet time when `/var/run/reboot-required` exists.
- **Node version.** Setup installs Node 22 (accounts need its built-in
  `node:sqlite`). To move to a newer major, change `NODE_MAJOR` in
  `tools/cloud/setup.sh` and run it again.
- **If the box may have been compromised**, follow `docs/breach-response.md`.
  "Stop the tunnel" there is `systemctl stop cloudflared` on the box.
