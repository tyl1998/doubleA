# ═══════════════════════════════════════════════════════════════════════
# down.ps1 - stop the containers on Windows
#
#   powershell -ExecutionPolicy Bypass -File scripts\down.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\down.ps1 -All     # only acts when MANAGE_INFRA=1
#   powershell -ExecutionPolicy Bypass -File scripts\down.ps1 -Purge   # destructive: deletes deploy volumes
#
# Base services (PG / Redis / MinIO) are only stopped when MANAGE_INFRA=1.
# The backend is stopped with `docker stop` (graceful) so it can unregister itself.
#
# NOTE: ASCII-only on purpose (PowerShell 5.1 reads .ps1 as ANSI).
# ═══════════════════════════════════════════════════════════════════════

[CmdletBinding()]
param(
    [switch]$All,
    [switch]$Purge
)

$ErrorActionPreference = 'Continue'

$DeployDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile   = if ($env:DEPLOY_ENV_FILE) { $env:DEPLOY_ENV_FILE } else { Join-Path $DeployDir 'deploy.env' }

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Info($m) { Write-Host "  [--] $m" -ForegroundColor DarkGray }

function Read-EnvValue($path, $key) {
    if (-not (Test-Path $path)) { return '' }
    foreach ($line in Get-Content -Path $path -Encoding UTF8) {
        if ($line -match '^\s*#') { continue }
        if ($line -match ("^\s*" + [regex]::Escape($key) + "\s*=\s*(.*)$")) {
            return $matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return ''
}

function Exists($name) { & docker inspect $name *> $null; return ($LASTEXITCODE -eq 0) }

$manageInfra = Read-EnvValue $EnvFile 'MANAGE_INFRA'
if ($manageInfra -eq '') { $manageInfra = '0' }

Write-Step 'Stopping application containers'
foreach ($c in @('doubulea-frontend', 'doubulea-gateway', 'doubulea-egress', 'doubulea-sandbox-relay', 'doubulea-docker-cli')) {
    if (Exists $c) { & docker stop --time 15 $c *> $null; & docker rm -f $c *> $null; Write-Ok $c }
}
# graceful stop so the backend can unregister its instance key
if (Exists 'doubulea-backend') {
    & docker stop --time 25 doubulea-backend *> $null
    & docker rm -f doubulea-backend *> $null
    Write-Ok 'doubulea-backend (graceful)'
}

if ($All -and $manageInfra -eq '1') {
    Write-Step 'Stopping base services (MANAGE_INFRA=1)'
    foreach ($c in @('doubulea-minio', 'doubulea-redis', 'doubulea-postgres')) {
        if (Exists $c) { & docker stop --time 20 $c *> $null; Write-Ok $c }
        if ($Purge) { & docker rm -f $c *> $null }
    }
    if ($Purge) {
        foreach ($v in @('doubulea-deploy-pgdata', 'doubulea-deploy-redisdata', 'doubulea-deploy-miniodata')) {
            & docker volume rm -f $v *> $null
        }
        Write-Host '  [!!] deploy volumes removed (-Purge)' -ForegroundColor Yellow
    }
} elseif ($All) {
    Write-Info 'MANAGE_INFRA=0 - base services are not managed here; left untouched'
}

Write-Host "`n  stopped. restart: powershell -ExecutionPolicy Bypass -File scripts\up.ps1`n"
