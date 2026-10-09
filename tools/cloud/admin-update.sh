#!/bin/bash
# Runs as root when the admin page asks for a restart or an update, started by
# borderwar-update.path. Installed by install-admin-update.sh to
# /usr/local/lib/borderwar/, where the server user can't edit it.
#
# The request file holds one word, written by the server (server/admin.js):
#   restart  drain, then start the server again on the same code
#   update   the same, with a pull first (update.sh)
set -euo pipefail

APP_DIR=/opt/borderwar
APP_USER=borderwar
APP_HOME=/var/lib/borderwar
REQUEST="$APP_DIR/server/data/update-request"
LIB=/usr/local/lib/borderwar
MAX_MINUTES=30

as_app() { runuser -u "$APP_USER" -- env HOME="$APP_HOME" "$@"; }

# The server user wrote this file: act on two exact words, nothing else.
mode=$(head -c 16 "$REQUEST" 2>/dev/null | tr -d '[:space:]' || true)
rm -f "$REQUEST"

case "$mode" in
  update)
    FROM_ADMIN=1 bash "$LIB/update.sh" "$MAX_MINUTES"
    ;;
  restart)
    cd "$APP_DIR"
    as_app node tools/drain-server.js --max-minutes "$MAX_MINUTES"
    systemctl start borderwar
    sleep 2
    echo "Now running: $(curl -fsS http://localhost:8124/buildinfo.json)"
    ;;
  *)
    echo "Ignoring an update request that says '$mode'." >&2
    exit 1
    ;;
esac
