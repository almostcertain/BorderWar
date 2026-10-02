#!/bin/bash
# Live server: starts the BorderWar server and a Cloudflare tunnel to
# https://borderwar.io, each in its own Terminal window. Double-click from Finder.
# (For a local-only server, use mac-server.command in the repo root.)
# Close a window (or press Ctrl+C in it) to stop that piece.

PORT=8124
TUNNEL_NAME=borderwar   # named tunnel routed to borderwar.io (see server/README.md)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CLOUDFLARED="$(command -v cloudflared || true)"
if [ -z "$CLOUDFLARED" ]; then
  echo "cloudflared not found."
  echo "Install it with: brew install cloudflared"
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "node not found. Install it with: brew install node"
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

# First run: install the server's dependencies (just `ws`).
if [ ! -d "$DIR/server/node_modules" ]; then
  (cd "$DIR/server" && npm install) || exit 1
fi

open_window() {
  osascript >/dev/null <<EOF
tell application "Terminal"
  activate
  do script "$1"
end tell
EOF
}

open_window "cd '$DIR/server' && node index.js"

# Give the server a moment to start listening before the tunnel connects.
sleep 3

if "$CLOUDFLARED" tunnel info "$TUNNEL_NAME" >/dev/null 2>&1; then
  open_window "'$CLOUDFLARED' tunnel --url http://localhost:$PORT run $TUNNEL_NAME"
  echo
  echo "Live at https://borderwar.io"
else
  echo
  echo "Named tunnel '$TUNNEL_NAME' not set up on this Mac -- using a temporary quick tunnel."
  echo "For borderwar.io, do the one-time setup in server/README.md (Mac quick start)."
  open_window "'$CLOUDFLARED' tunnel --url http://localhost:$PORT"
  echo "Look in the tunnel window for the https://...trycloudflare.com link to share."
fi
sleep 5
