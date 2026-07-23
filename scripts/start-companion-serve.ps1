# Start Zelari companion host in a VISIBLE window (must stay open).
# Usage:
#   powershell -File scripts/start-companion-serve.ps1
#   powershell -File scripts/start-companion-serve.ps1 -Bind 0.0.0.0 -Port 7421
#   powershell -File scripts/start-companion-serve.ps1 -Bind 192.168.1.40

param(
  [string]$Bind = "127.0.0.1",
  [int]$Port = 7421,
  [string]$Project = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Project) { $Project = $Root }

$node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $node) {
  Write-Host "Node.js not found on PATH. Install Node 20+." -ForegroundColor Red
  exit 1
}

$cli = Join-Path $Root "bin\zelari-code.js"
if (-not (Test-Path $cli)) {
  Write-Host "CLI not found: $cli" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Starting Zelari companion serve..." -ForegroundColor Cyan
Write-Host "  Bind:    $Bind"
Write-Host "  Port:    $Port"
Write-Host "  Project: $Project"
Write-Host "  Health:  http://127.0.0.1:$Port/health"
Write-Host ""
Write-Host "Leave this window OPEN. Ctrl+C to stop." -ForegroundColor Yellow
Write-Host ""

# Run in THIS console so you see logs and the process cannot vanish silently.
Set-Location $Root
$env:ZELARI_SKIP_PREFLIGHT = "1"
$env:ANATHEMA_DEV = "1"
& $node $cli serve --bind $Bind --port $Port --project $Project
