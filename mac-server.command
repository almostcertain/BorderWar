#!/bin/bash
# Local BorderWar multiplayer server (no tunnel). Double-click from Finder.
# Serves the game and the WebSocket on http://localhost:8124 (LAN: http://<ip>:8124).
# For the public borderwar.io server, use tools/live-mac.command.
# Close the window (or press Ctrl+C) to stop it.

PORT=8124
cd "$(dirname "${BASH_SOURCE[0]}")/server" || exit 1

if ! command -v node >/dev/null; then
  echo "node not found. Install it with: brew install node"
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

# First run: install the server's dependencies (just `ws`).
[ -d node_modules ] || npm install || exit 1

# Give the server a moment to start listening before the browser opens.
( sleep 1 && open "http://localhost:$PORT" ) &

node index.js
