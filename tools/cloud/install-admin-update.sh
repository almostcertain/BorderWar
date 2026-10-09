#!/bin/bash
# Turns on the admin page's Restart and Pull latest buttons. Run as root on the
# box, from the repo checkout. Safe to run again, and needed again whenever
# update.sh or admin-update.sh changes: the copies in /usr/local/lib/borderwar
# are root-owned on purpose, so the server user can't edit what root runs.
#
#   bash /opt/borderwar/tools/cloud/install-admin-update.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
LIB=/usr/local/lib/borderwar

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo bash install-admin-update.sh)." >&2
  exit 1
fi

install -d -o root -g root -m 755 "$LIB"
install -o root -g root -m 755 "$SRC/update.sh" "$SRC/admin-update.sh" "$LIB/"
install -o root -g root -m 644 "$SRC/borderwar-update.service" "$SRC/borderwar-update.path" /etc/systemd/system/

# The server turns the buttons on when this is set (server/index.js).
mkdir -p /etc/systemd/system/borderwar.service.d
cat > /etc/systemd/system/borderwar.service.d/admin-update.conf <<'CONF'
[Service]
Environment=BORDERWAR_UPDATE_FILE=/opt/borderwar/server/data/update-request
CONF

systemctl daemon-reload
systemctl enable --now borderwar-update.path
echo "Installed. Restart the server once to turn the buttons on: systemctl restart borderwar"
