#!/bin/bash
# Starts the BorderWar server and a Cloudflare quick tunnel, each in its own
# Terminal window. Close a window (or press Ctrl+C in it) to stop that piece.
# Mac equivalent of start-server.bat.

PORT=8124
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found on PATH."
  echo "Install it with: brew install cloudflared"
  read -p "Press Return to exit..."
  exit 1
fi

osascript <<EOF
tell application "Terminal"
  do script "cd \"$DIR/server\" && node index.js"
  set custom title of front window to "BorderWar Server"
end tell
EOF

# Give the server a moment to start listening before the tunnel connects.
sleep 3

osascript <<EOF
tell application "Terminal"
  do script "cloudflared tunnel --url http://localhost:$PORT"
  set custom title of front window to "BorderWar Tunnel"
end tell
EOF

echo
echo "Look in the \"BorderWar Tunnel\" window for the https://...trycloudflare.com link to share."
sleep 5
