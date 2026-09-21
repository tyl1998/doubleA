# =====================================================================
# dev-up.ps1 - bring up dev dependencies (postgres / redis / minio)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-up.ps1
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-up.ps1 -NoBuild
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-up.ps1 -Recreate
#
# Steps:
#   1. verify infra/.env exists (copy from .env.example if missing)
#   2. docker compose build  (self-built PG image; first run compiles pg_bigm)
#   3. docker compose up -d
#   4. poll until all three services are healthy
#   5. run pg-verify.mjs  (proves vector + pg_bigm are actually usable)
#
# NOTE: this file is intentionally ASCII-only.
#   Windows PowerShell 5.1 reads .ps1 as the system ANSI codepage unless the
#   file starts with a UTF-8 BOM. Non-ASCII text here would be mojibake and
#   could even break parsing. Keep it ASCII, or add a BOM if Chinese is needed.
#
# NOTE: Go template strings passed to docker are held in VARIABLES.
#   An inline single-quoted '{{...}}' is misparsed by PowerShell 5.1 as a
#   nested script block ("if statement is missing its ( after if").
# =====================================================================

[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$Recreate,
    [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'

# -- locate paths (this file lives at <repoRoot>/infra/scripts/) --
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraDir   = Split-Path -Parent $ScriptDir
$RepoRoot   = Split-Path -Parent $InfraDir
$ComposeArg = Join-Path $InfraDir 'docker-compose.yml'
$EnvFile    = Join-Path $InfraDir '.env'
$EnvSample  = Join-Path $InfraDir '.env.example'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`n[FAIL] $msg" -ForegroundColor Red; exit 1 }

function Invoke-Compose {
    param([string[]]$ComposeArgs)
    & docker compose -f $ComposeArg --env-file $EnvFile @ComposeArgs
    if ($LASTEXITCODE -ne 0) { Fail "docker compose $($ComposeArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

# -- 0. preflight -----------------------------------------------------
Write-Step 'Preflight'

$VersionFormat = '{{.Server.Version}}'
& docker version --format $VersionFormat *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker engine is not running. Start Docker Desktop first.' }
Write-Ok 'Docker engine reachable'

if (-not (Test-Path $EnvFile)) {
    Write-Warn2 'infra/.env not found; copying from .env.example'
    Copy-Item $EnvSample $EnvFile
    Write-Warn2 'Fill CREDENTIAL_MASTER_KEY in infra/.env (generate with: node -e "console.log(require(''crypto'').randomBytes(32).toString(''base64''))")'
}

$envLines = Get-Content $EnvFile
if (-not ($envLines | Where-Object { $_ -match '^\s*CREDENTIAL_MASTER_KEY\s*=\s*\S' })) {
    Write-Warn2 'CREDENTIAL_MASTER_KEY is empty - fine for P0-1-2, but P0-1-3 config validation will refuse to start'
}

Write-Ok "env file: $EnvFile"

# -- 1. build the self-built PG image ---------------------------------
if (-not $NoBuild) {
    Write-Step 'Building postgres image (pgvector + pg_bigm; first run compiles pg_bigm)'
    Invoke-Compose @('build', 'postgres')
    Write-Ok 'Image built'
} else {
    Write-Step 'Building postgres image'
    Write-Warn2 'skipped (-NoBuild)'
}

# -- 2. start services ------------------------------------------------
Write-Step 'Starting services'
$upArgs = @('up', '-d')
if ($Recreate) { $upArgs += '--force-recreate' }
Invoke-Compose $upArgs
Write-Ok 'Containers started'

# -- 3. wait for health ----------------------------------------------
Write-Step "Waiting for health (timeout ${TimeoutSec}s)"

# Go template held in a variable - see header note.
$HealthFormat = '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'

$services = @('postgres', 'redis', 'minio')
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$pending  = [System.Collections.ArrayList]::new($services)

while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
    foreach ($svc in @($pending)) {
        $cid = (& docker compose -f $ComposeArg --env-file $EnvFile ps -q $svc 2>$null | Select-Object -First 1)
        if (-not $cid) { continue }
        $state = (& docker inspect --format $HealthFormat $cid 2>$null)
        if ($state -eq 'healthy' -or $state -eq 'running') {
            Write-Ok "$svc -> $state"
            [void]$pending.Remove($svc)
        }
    }
    if ($pending.Count -gt 0) { Start-Sleep -Seconds 2 }
}

if ($pending.Count -gt 0) {
    Write-Warn2 "not ready within ${TimeoutSec}s: $($pending -join ', ')"
    Write-Host "  diagnose: docker compose -f `"$ComposeArg`" logs --tail=50 <service>" -ForegroundColor DarkGray
    exit 1
}

# -- 4. accept: are the extensions really compiled in? ---------------
Write-Step 'Verifying PG extensions (vector + pg_bigm)'
& node (Join-Path $ScriptDir 'pg-verify.mjs') --env-file $EnvFile
if ($LASTEXITCODE -ne 0) { Fail 'PG extension verification failed; see output above' }

# -- 5. summary -------------------------------------------------------
Write-Step 'Ready'

function Get-EnvValue($key, $default) {
    $line = $envLines | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if (-not $line) { return $default }
    return ($line -replace "^\s*$key\s*=\s*", '').Trim()
}

$pgPort    = Get-EnvValue 'POSTGRES_PORT' '5432'
$redisPort = Get-EnvValue 'REDIS_PORT' '6379'
$minioApi  = Get-EnvValue 'MINIO_API_PORT' '9000'
$minioCon  = Get-EnvValue 'MINIO_CONSOLE_PORT' '9001'
$pgUser    = Get-EnvValue 'POSTGRES_USER' 'doubulea'
$pgDb      = Get-EnvValue 'POSTGRES_DB' 'doubulea'

Write-Host "  PostgreSQL    127.0.0.1:$pgPort  (db=$pgDb user=$pgUser)" -ForegroundColor DarkGray
Write-Host "  Redis         127.0.0.1:$redisPort" -ForegroundColor DarkGray
Write-Host "  MinIO API     127.0.0.1:$minioApi" -ForegroundColor DarkGray
Write-Host "  MinIO console http://127.0.0.1:$minioCon" -ForegroundColor DarkGray
Write-Host "`n  stop: powershell -ExecutionPolicy Bypass -File infra/scripts/dev-down.ps1" -ForegroundColor DarkGray
