#!/bin/bash
# Local static server for testing in a browser (no multiplayer, no tunnel).
# Needed now that the World map is fetched from maps/world/ at runtime --
# double-clicking index.html directly (file://) blocks that fetch, so this
# is the same one-liner .claude/launch.json's "borderwar" config runs.
# Close the window (or press Ctrl+C in it) to stop the server.

PORT=8123

# Serve from this script's own directory regardless of where it's launched from.
cd "$(dirname "$0")"

node tools/build-info.js 2>/dev/null

# Give the server a moment to start listening before the browser opens.
( sleep 1 && open "http://localhost:$PORT" ) &

python3 -m http.server "$PORT" --directory .
