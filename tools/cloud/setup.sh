#!/bin/bash
# One-time setup of a fresh Ubuntu/Debian cloud box as the BorderWar host.
# Run as root. Safe to run again. Full walkthrough: docs/cloud-hosting.md.
#
#   curl -fsSLo setup.sh https://raw.githubusercontent.com/almostcertain/BorderWar/main/tools/cloud/setup.sh
#   bash setup.sh
#
# Installs Node and cloudflared, clones the repo to /opt/borderwar, installs the
# systemd service and closes every inbound port except SSH. It does not start
# the server or the tunnel: copy the data and tunnel credentials over first.
set -euo pipefail

REPO_URL=https://github.com/almostcertain/BorderWar.git
APP_DIR=/opt/borderwar
APP_USER=borderwar
APP_HOME=/var/lib/borderwar
NODE_MAJOR=22

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo bash setup.sh)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
as_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" "$@"; }

echo "== Packages"
apt-get update
apt-get install -y git curl ca-certificates gnupg ufw unattended-upgrades

echo "== Node $NODE_MAJOR"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_$NODE_MAJOR.x" | bash -
  apt-get install -y nodejs
fi
# Accounts need the built-in node:sqlite (server/accounts/db.js).
node -e "require('node:sqlite')" 2>/dev/null || { echo "This Node has no node:sqlite; accounts would be disabled." >&2; exit 1; }

echo "== cloudflared"
if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg > /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi

echo "== User and code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$APP_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DIR"
  as_app git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR/server"
as_app npm ci --omit=dev
# Holds the accounts database, its backups and the admin token.
as_app mkdir -p "$APP_DIR/server/data"
chmod 700 "$APP_DIR/server/data"

echo "== Service"
cp "$APP_DIR/tools/cloud/borderwar.service" /etc/systemd/system/borderwar.service
systemctl daemon-reload
systemctl enable borderwar

echo "== Firewall"
# Players arrive through the Cloudflare Tunnel, which dials out. Nothing needs
# to reach this box from the internet except SSH.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH || ufw allow 22/tcp
ufw --force enable

echo
echo "Setup done. The server is installed but not started."
echo "Next: copy the data and tunnel credentials over (docs/cloud-hosting.md, step 3)."
