@echo off
REM Starts the BorderWar server and a Cloudflare quick tunnel, each in its own window.
REM Close a window (or press Ctrl+C in it) to stop that piece.

set PORT=8124
set CLOUDFLARED=C:\Program Files (x86)\cloudflared\cloudflared.exe

if not exist "%CLOUDFLARED%" (
  echo cloudflared not found at "%CLOUDFLARED%"
  echo Install it with: winget install --id Cloudflare.cloudflared
  pause
  exit /b 1
)

start "BorderWar Server" /D "%~dp0server" cmd /k node index.js

REM Give the server a moment to start listening before the tunnel connects.
timeout /t 3 /nobreak >nul

start "BorderWar Tunnel" cmd /k ""%CLOUDFLARED%" tunnel --url http://localhost:%PORT%"

echo.
echo Look in the "BorderWar Tunnel" window for the https://...trycloudflare.com link to share.
timeout /t 5 >nul
