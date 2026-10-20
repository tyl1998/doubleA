# =====================================================================
# dev-down.ps1 - stop dev dependencies
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-down.ps1
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-down.ps1 -RemoveImages
#
# This script NEVER deletes data volumes (pgdata / redisdata / miniodata).
#   Database, queue and uploaded files live there and cannot be recovered.
#   A plain "dev-down" must not have that kind of destructive power
#   (requested 2026-10-20). To wipe data, run the two commands printed below
#   deliberately:
#     docker compose -f infra/docker-compose.yml --env-file infra/.env down -v
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
    # Kept only to reject the old flag loudly instead of silently ignoring it.
    Write-Host '-Purge is no longer supported: this script does not delete data volumes.' -ForegroundColor Red
    Write-Host '  To wipe data on purpose (IRREVERSIBLE):' -ForegroundColor Red
    Write-Host '    docker compose -f infra/docker-compose.yml --env-file infra/.env down -v' -ForegroundColor Red
    exit 2
}

# NOTE: deliberately no '-v'. Containers stop, volumes stay, so the next
#   dev-up brings back the same database. '-v' is a one-way door.
Invoke-Compose @('down', '--remove-orphans')
Write-Host '[OK] services stopped (data volumes kept)' -ForegroundColor Green

if ($RemoveImages) {
    Write-Host '[*] removing project images ...' -ForegroundColor Cyan
    & docker image rm 'doubulea/postgres:pg16-vector-bigm' 2>$null
    Write-Host '[OK] image removed (dev-up will rebuild it)' -ForegroundColor Green
}

Write-Host '    restart: powershell -ExecutionPolicy Bypass -File infra/scripts/dev-up.ps1' -ForegroundColor DarkGray
