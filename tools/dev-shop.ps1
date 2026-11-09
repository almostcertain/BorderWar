# Starts the local server with the Paddle sandbox shop on (docs/monetization.md §8.4).
# Keys are kept in server/data/paddle-sandbox.env, which git ignores. Asked for once.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not (Test-Path 'server/accounts/paddle.js')) {
  Write-Host 'This branch has no shop. Switch first:  git checkout feature/monetization' -ForegroundColor Yellow
  exit 1
}

$keyFile = 'server/data/paddle-sandbox.env'
$names = 'PADDLE_API_KEY', 'PADDLE_CLIENT_TOKEN', 'PADDLE_WEBHOOK_SECRET'
$keys = @{}
if (Test-Path $keyFile) {
  foreach ($line in Get-Content $keyFile) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') { $keys[$Matches[1]] = $Matches[2] }
  }
}
$missing = $names | Where-Object { -not $keys[$_] }
if ($missing) {
  Write-Host 'Paste your Paddle sandbox keys (saved to' $keyFile 'for next time).'
  foreach ($n in $missing) { $keys[$n] = (Read-Host $n).Trim() }
  New-Item -ItemType Directory -Force 'server/data' | Out-Null
  ($names | ForEach-Object { "$_=$($keys[$_])" }) | Set-Content -Encoding ascii $keyFile
}

$busy = Get-NetTCPConnection -LocalPort 8124 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.OwningProcess)"
  Write-Host "Port 8124 is in use by: $($p.CommandLine) (pid $($p.ProcessId))" -ForegroundColor Yellow
  if ((Read-Host 'Stop it? (y/n)') -ne 'y') { exit 1 }
  Stop-Process -Id $p.ProcessId
  Start-Sleep -Milliseconds 500
}

$env:PADDLE_ENV = 'sandbox'
foreach ($n in $names) { Set-Item "env:$n" $keys[$n] }
try {
  Write-Host 'Open http://localhost:8124  (Ctrl+C to stop)' -ForegroundColor Green
  node server/index.js
} finally {
  foreach ($n in $names + 'PADDLE_ENV') { Remove-Item "env:$n" -ErrorAction SilentlyContinue }
}
