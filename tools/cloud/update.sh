#!/bin/bash
# Updates the cloud box to the latest main. Run as root on the box:
#
#   bash /opt/borderwar/tools/cloud/update.sh [max-minutes]
#
# Blocks new games, waits for matches in progress to finish (at most
# max-minutes, default 30), then pulls, installs and starts the new build.
# The code is only pulled once the server has stopped: it serves the game's
# files straight from this checkout, so pulling under a running server would
# hand players a client that doesn't match it.
#
# FROM_ADMIN=1 (the admin page's button, via admin-update.sh) leaves the systemd
# unit alone: it would be copied from a checkout the server can write.
set -euo pipefail

APP_DIR=/opt/borderwar
APP_USER=borderwar
APP_HOME=/var/lib/borderwar

as_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" "$@"; }

# Everything runs inside main so bash has read the whole file before the pull
# replaces it.
main() {
  local max_minutes="${1:-30}"

  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this as root (sudo bash update.sh)." >&2
    exit 1
  fi

  cd "$APP_DIR"
  as_app git fetch origin main
  if [ "$(as_app git rev-parse HEAD)" = "$(as_app git rev-parse origin/main)" ] && systemctl is-active --quiet borderwar; then
    echo "Already on the latest build ($(as_app git rev-parse --short HEAD))."
    exit 0
  fi

  as_app node tools/drain-server.js --max-minutes "$max_minutes"
  systemctl stop borderwar

  as_app git merge --ff-only origin/main
  (cd server && as_app npm ci --omit=dev)
  # Pick up changes to the unit file itself.
  if [ -z "${FROM_ADMIN:-}" ] && ! cmp -s tools/cloud/borderwar.service /etc/systemd/system/borderwar.service; then
    cp tools/cloud/borderwar.service /etc/systemd/system/borderwar.service
    systemctl daemon-reload
  fi

  systemctl start borderwar
  sleep 2
  echo "Now running: $(curl -fsS http://localhost:8124/buildinfo.json)"
}

main "$@"; exit
