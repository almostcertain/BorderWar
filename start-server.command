#!/bin/bash
# Double-click entry point for start-server.sh — Finder only auto-runs
# scripts ending in .command, not .sh.
cd "$(dirname "${BASH_SOURCE[0]}")"
./start-server.sh
