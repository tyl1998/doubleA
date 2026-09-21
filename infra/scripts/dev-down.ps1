# =====================================================================
# dev-down.ps1 - stop dev dependencies
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-down.ps1
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-down.ps1 -Purge
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-down.ps1 -Purge -RemoveImages
#
# -Purge deletes pgdata / redisdata / miniodata.
#   Database, queue and uploaded files are gone for good. Use with care.
#
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 reads .ps1 in the
#   system ANSI codepage unless a UTF-8 BOM is present.
# =====================================================================

[CmdletBinding()]
param(
    [switch]$Purge,
    [switch]$RemoveImages
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraDir   = Split-Path -Parent $ScriptDir
$ComposeArg = Join-Path $InfraDir 'docker-compose.yml'
$EnvFile    = Join-Path $InfraDir '.env'

if (-not (Test-Path $EnvFile)) {
    Write-Host '[!!] infra/.env not found; falling back to compose defaults' -ForegroundColor Yellow
}

function Invoke-Compose {
    param([string[]]$ComposeArgs)
    if (Test-Path $EnvFile) {
        & docker compose -f $ComposeArg --env-file $EnvFile @ComposeArgs
    } else {
        & docker compose -f $ComposeArg @ComposeArgs
    }
}

if ($Purge) {
    Write-Host 'WARNING: stopping services AND deleting all data volumes' -ForegroundColor Red
    Write-Host '         (PG data / Redis AOF / MinIO objects). This cannot be undone.' -ForegroundColor Red
    Write-Host '         Starting in 3 seconds; press Ctrl+C to cancel...' -ForegroundColor Red
    Start-Sleep -Seconds 3
    Invoke-Compose @('down', '-v', '--remove-orphans')
    Write-Host '[OK] services stopped, data volumes removed' -ForegroundColor Green
} else {
    Invoke-Compose @('down', '--remove-orphans')
    Write-Host '[OK] services stopped (data volumes kept)' -ForegroundColor Green
}

if ($RemoveImages) {
    Write-Host '[*] removing project images ...' -ForegroundColor Cyan
    & docker image rm 'doubulea/postgres:pg16-vector-bigm' 2>$null
    Write-Host '[OK] image removed (dev-up will rebuild it)' -ForegroundColor Green
}

Write-Host '    restart: powershell -ExecutionPolicy Bypass -File infra/scripts/dev-up.ps1' -ForegroundColor DarkGray
