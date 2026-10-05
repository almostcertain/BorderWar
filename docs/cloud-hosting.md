# Hosting BorderWar on a cloud box

How to run the live server (borderwar.io) on a rented Linux machine instead of
the owner's PC. Nothing about the game or the server changes: it is the same
`node server/index.js` behind the same Cloudflare Tunnel, on a machine that
stays on.

## Quick reference

| What | Where |
|---|---|
| Code | `/opt/borderwar` (a git checkout of `main`, owned by user `borderwar`) |
| Data (accounts database, backups, admin token, chart history) | `/opt/borderwar/server/data` |
| Server service | `borderwar` (`tools/cloud/borderwar.service`) |
| Tunnel service | `cloudflared`, config in `/etc/cloudflared/` |
| Update to latest `main` | `bash /opt/borderwar/tools/cloud/update.sh` |
| Server log | `journalctl -u borderwar -f` |
| Stop now (players are told) | `systemctl stop borderwar` |
| Start | `systemctl start borderwar` |
| Account admin commands | `cd /opt/borderwar && runuser -u borderwar -- node server/accounts/admin.js ...` |

## Why this shape

- **A plain always-on box.** Matches live in the server's memory and accounts
  live in a SQLite file, so the host must not sleep when idle and must keep its
  disk. That rules out the free "scale to zero" platforms.
- **The tunnel stays.** Cloudflare Tunnel dials out from the box, so no inbound
  port is open except SSH, HTTPS is handled by Cloudflare, and the server's
  rate limiting keeps seeing real player addresses (`CF-Connecting-IP`, trusted
  only from loopback; see `docs/accounts-auth.md`). The tunnel is the same one
  the PC used, so DNS does not change and the move is instant.
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

### 3. Move the data and the tunnel (the cutover)

From here until step 4 finishes, borderwar.io is down. It takes a few minutes.

**On the PC:** stop the live server and its tunnel (close both windows, or run
`node tools/drain-server.js` first to let matches finish). Then, from the repo
folder in PowerShell, replacing `BOX` with the box's IP address:

```
scp -r server/data root@BOX:/root/bw-data
scp "$env:USERPROFILE\.cloudflared\c365c7e6-faf3-4bed-a7dd-3e2873cb0519.json" root@BOX:/root/
```

The first copies the accounts database, its backups, the admin token and the
chart history. The second is the tunnel's credentials file. Both are secrets:
do not paste them anywhere else.

**On the box:**

```
cp -a /root/bw-data/. /opt/borderwar/server/data/
chown -R borderwar:borderwar /opt/borderwar/server/data
chmod 700 /opt/borderwar/server/data
rm -rf /root/bw-data

mkdir -p /etc/cloudflared
mv /root/c365c7e6-faf3-4bed-a7dd-3e2873cb0519.json /etc/cloudflared/
chmod 600 /etc/cloudflared/c365c7e6-faf3-4bed-a7dd-3e2873cb0519.json
cat > /etc/cloudflared/config.yml <<'EOF'
tunnel: c365c7e6-faf3-4bed-a7dd-3e2873cb0519
credentials-file: /etc/cloudflared/c365c7e6-faf3-4bed-a7dd-3e2873cb0519.json
ingress:
  - hostname: borderwar.io
    service: http://localhost:8124
  - service: http_status:404
EOF
```

### 4. Start it

```
systemctl start borderwar
curl http://localhost:8124/buildinfo.json
cloudflared service install
systemctl status cloudflared --no-pager
```

Then check from any browser: `https://borderwar.io` loads, an existing account
can sign in, and `https://borderwar.io/admin` accepts the same admin token as
before. Both services start on their own after a reboot.

### 5. Retire the PC as a host

Do not run `tools/live server deploy.bat` (or `tools/live-mac.command`) again
while the box is live: two machines on one tunnel split visitors between them,
and each would have its own copy of the accounts. `win-server.bat` (a temporary
trycloudflare link) and the local dev servers are unaffected.

## Updating the live game

After pushing to `main`, on the box:

```
bash /opt/borderwar/tools/cloud/update.sh
```

It blocks new games, waits up to 30 minutes for matches in progress to finish
(pass a different number of minutes as the argument), then pulls, installs and
starts the new build and prints its build ID. If the box is already on the
latest commit it does nothing.

## Going back to the PC

Stop both services on the box (`systemctl stop cloudflared borderwar`), copy
`/opt/borderwar/server/data` back over the PC's `server/data` if accounts were
created in the meantime, and run `tools/live server deploy.bat`.

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
