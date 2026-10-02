@echo off
rem Starts the BorderWar host: game server + Cloudflare Tunnel (borderwar.io).
rem Each runs in its own window; close a window to stop that piece.
rem Needs node and cloudflared on PATH, and the tunnel config in %USERPROFILE%\.cloudflared.

set "REPO=%~dp0.."

start "BorderWar server" /D "%REPO%" cmd /k node server/index.js
start "BorderWar tunnel" /D "%REPO%" cmd /k cloudflared tunnel run borderwar
