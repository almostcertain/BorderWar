@echo off
REM Local static server for testing in a browser (no multiplayer, no tunnel).
REM Needed now that the World map is fetched from maps/world/ at runtime —
REM double-clicking index.html directly (file://) blocks that fetch, so this
REM is the same one-liner .claude/launch.json's "borderwar" config runs.
REM Close the window (or press Ctrl+C in it) to stop the server.

set PORT=8123

REM Give the server a moment to start listening before the browser connects.
start "" cmd /c "timeout /t 1 /nobreak >nul && start http://localhost:%PORT%"

REM "%~dp0" ends in a trailing backslash, and a quoted Windows argument ending
REM in \" gets misparsed as an escaped quote — merging this argument with
REM whatever follows it and serving the wrong (or no) directory, which is
REM what produced the 404. Appending "." sidesteps it without changing the
REM path it resolves to.
node tools\build-info.js 2>nul
python -m http.server %PORT% --directory "%~dp0."

pause
