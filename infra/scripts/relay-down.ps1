# =====================================================================
# relay-down.ps1 - remove the sandbox relay container (exit 2 relay)
#
# Only removes the container; it does NOT touch the `doubulea-sandbox`
# network (that belongs to the backend) and does NOT edit infra/.env.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infra/scripts/relay-down.ps1
#   powershell -ExecutionPolicy Bypass -File infra/scripts/relay-down.ps1 -Name doubulea-sandbox-relay
#
# NOTE: this file is intentionally ASCII-only (see relay-up.ps1).
# =====================================================================

[CmdletBinding()]
param(
    [string]$Name = 'doubulea-sandbox-relay'
)

$ErrorActionPreference = 'Stop'

function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  [--] $msg" -ForegroundColor DarkGray }
function Write-Warn2($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }

& docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'docker engine is not running' -ForegroundColor Red; exit 1 }

& docker container inspect $Name *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Info "container $Name is not present (idempotent, no-op)"
    exit 0
}

& docker rm -f $Name *> $null
if ($LASTEXITCODE -eq 0) { Write-Ok "removed $Name" } else { Write-Warn2 "failed to remove $Name" }

$fmt = '{{.Names}}'
$still = (& docker ps -a --filter "name=^${Name}$" --format $fmt 2>$null)
if ($still) {
    Write-Warn2 "container still present: docker ps -a --filter name=$Name"
} else {
    Write-Ok 'confirmed gone'
}

Write-Info 'sandbox network untouched (belongs to the backend); SANDBOX_BACKEND_URL in infra/.env kept'
