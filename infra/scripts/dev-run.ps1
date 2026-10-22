# =====================================================================
# dev-run.ps1 - one-shot dev environment starter (Windows / PowerShell)
#
# Windows counterpart of infra/scripts/dev-run.sh. Brings up a browser-
# usable dev environment in five steps (each individually skippable):
#   1. dependency services postgres / redis / minio  (reuses dev-up.ps1)
#   2. db:deploy / db:seed / db:partitions          (all idempotent)
#   3. backend  (pnpm dev:backend -> tsx watch)      http://127.0.0.1:<BACKEND_PORT+1>
#   4. router gateway (pnpm router:dev)              http://127.0.0.1:<ROUTER_PORT | BACKEND_PORT>
#   5. frontend (pnpm dev:frontend -> vite)          http://localhost:5174
#
# The gateway is ON by default so the browser traffic really goes through
# the router (sticky routing / instance discovery / load-aware) exactly like
# production nginx -> gateway. The backend therefore moves to the internal
# port BACKEND_PORT+1 and the Vite dev proxy targets the gateway.
# Use -NoGateway for the old single-process layout (frontend -> backend).
#
# 3, 4 and 5 run in the background; logs -> .dev-logs/*.log ; pids -> .pids/*.pid
# (both directories are git-ignored).
#
# Stop:  powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1
#        powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1 -Infra
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1 -NoInfra
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1 -NoDb
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1 -NoInstall
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1 -NoGateway
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1 -Force
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1 -TimeoutSec 180
#
# NOTE: ASCII-only on purpose - Windows PowerShell 5.1 reads .ps1 in the
#   system ANSI codepage unless a UTF-8 BOM is present. Keep comments/
#   messages ASCII (mirrors the other infra/*.ps1).
# =====================================================================

[CmdletBinding()]
param(
    [switch]$NoInfra,
    [switch]$NoDb,
    [switch]$NoInstall,
    [switch]$NoGateway,
    [switch]$Force,
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraDir  = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $InfraDir
$EnvFile   = Join-Path $InfraDir '.env'
$LogDir    = Join-Path $RepoRoot '.dev-logs'
$PidDir    = Join-Path $RepoRoot '.pids'

$FrontendPort = 5174
$BackendPort  = 13000   # infra/.env value; with the gateway on it is the GATEWAY port
$BackendInternalPort = $null
$GatewayPort = $null
$RouterDiscoverySec = '0'
$InfraReady   = $false

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "  [--] $msg" -ForegroundColor DarkGray }
function Fail($msg) { Write-Host "`n[FAIL] $msg" -ForegroundColor Red; exit 1 }

function Get-EnvValue($key, $default) {
    if (-not (Test-Path $EnvFile)) { return $default }
    $lines = Get-Content $EnvFile
    $line = $lines | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if (-not $line) { return $default }
    return ($line -replace "^\s*$key\s*=", '').Trim()
}

function Test-HttpCode($url) {
    # Probe an HTTP endpoint with the .NET stack instead of curl.exe - curl.exe
    # is missing on some Windows builds (and in PowerShell 5.1 `curl` is an alias
    # for Invoke-WebRequest with incompatible args). Also bypass any system proxy
    # so localhost is always hit directly.
    try {
        $req = [System.Net.WebRequest]::Create($url)
        $req.Timeout = 3000
        $req.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
        $resp = $req.GetResponse()
        $code = [string]$resp.StatusCode.value__
        $resp.Close()
        return $code
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $c = [string]$_.Exception.Response.StatusCode.value__
            $_.Exception.Response.Close()
            return $c
        }
        return '000'
    } catch { return '000' }
}

function Test-PortBusy($port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

function Test-PortPids($port) {
    return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess)
}

function Test-PidAlive($targetPid) {
    if (-not $targetPid) { return $false }
    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    return ($null -ne $p)
}

function Wait-Until($desc, $secs, $scriptBlock) {
    $i = 0
    while ($i -lt $secs) {
        if (& $scriptBlock) { return $true }
        Start-Sleep -Seconds 1
        $i++
    }
    Write-Warn2 "timeout waiting: $desc ($secs s)"
    return $false
}

function Test-BackendUp() {
    return ((Test-HttpCode "http://127.0.0.1:$BackendInternalPort/health") -eq '200')
}
function Test-GatewayUp() {
    return ((Test-HttpCode "http://127.0.0.1:$GatewayPort/health") -eq '200')
}
function Test-FrontendUp() {
    if ((Test-HttpCode "http://localhost:$FrontendPort/") -eq '200') { return $true }
    if ((Test-HttpCode "http://[::1]:$FrontendPort/") -eq '200') { return $true }
    return $false
}

# launch pnpm <script> in the background, merging stdout+stderr into one log
# file and redirecting stdin from NUL (vite treats stdin EOF as Ctrl+D and exits).
# Start-Process cannot redirect BOTH streams to the SAME file, so we let cmd.exe
# perform the "2>&1" merge - this mirrors the bash script's >>log 2>&1.
#
# $envPairs: process-scoped overrides (name -> value), emitted as a chain of
# `set` statements before the command. This is how the backend is moved to BACKEND_PORT+1 and
# how the gateway gets ROUTER_PORT / ROUTER_UPSTREAMS: the repo's config loaders
# give the process environment priority over infra/.env.
function Start-BackgroundPnpm($scriptName, $logFile, $envPairs) {
    # Launch in a HIDDEN window (its own console) instead of -NoNewWindow.
    # -NoNewWindow shares the parent console, so a Ctrl+C in the parent terminal
    # hits this process too and cmd prompts "Terminate batch job (Y/N)?" - and
    # since stdin is NUL it can never answer, which looks like a hard hang.
    # cmd.exe metacharacters are escaped with ^ because Start-Process only
    # joins -ArgumentList and PowerShell would otherwise treat them literally.
    $sets = ''
    if ($envPairs) {
        foreach ($k in $envPairs.Keys) {
            $sets += "set `"$k=$($envPairs[$k])`" ^&^& "
        }
    }
    $cmd = "$sets pnpm $scriptName > `"$logFile`" 2^>^&1 ^< NUL"
    return (Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd `
                -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru)
}

# -- 0. preflight -----------------------------------------------------
Write-Step 'Preflight'

Set-Location $RepoRoot

# pnpm must be on PATH
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) { Fail 'pnpm not found (install via corepack enable / npm i -g pnpm)' }
Write-Ok "pnpm $(pnpm --version)"

# Node >= 22 gate (Prisma 7 needs ESM-only deps; Node 20 breaks db:deploy)
$nodeVer = & node -v 2>$null
if (-not $nodeVer) { Fail 'node not found (this repo requires Node >=22). Use nvm/n: install 22 and switch.' }
$nodeMajor = [int]($nodeVer -replace '^v?(\d+).*', '$1')
if ($nodeMajor -lt 22) {
    Fail "Node too old: $nodeVer (requires >=22). Prisma 7 will crash with ERR_REQUIRE_ESM on db:deploy. Switch to 22 first."
}
Write-Ok "Node $nodeVer"

if (-not $NoInfra) {
    & docker version --format '{{.Server.Version}}' *> $null
    if ($LASTEXITCODE -ne 0) { Fail 'Docker engine unreachable. Start Docker Desktop first.' }
    Write-Ok 'Docker engine reachable'
}

if (-not (Test-Path $EnvFile)) {
    Fail "missing $EnvFile (copy from infra/.env.example and fill secrets; dev-up.ps1 can also scaffold it)"
}
Write-Ok "env file: $EnvFile"

$envPort = Get-EnvValue 'BACKEND_PORT' ''
if ($envPort) { $BackendPort = [int]$envPort }

# Gateway port: ROUTER_PORT from infra/.env when set (router:dev reads it too),
# otherwise BACKEND_PORT (the compose/dev.sh convention).
$routerPortEnv = Get-EnvValue 'ROUTER_PORT' ''
if ($NoGateway) {
    $GatewayPort = $null
    $BackendInternalPort = $BackendPort
    Write-Ok "backend port: $BackendInternalPort (from infra/.env; -NoGateway: frontend connects directly)"
} else {
    $GatewayPort = if ($routerPortEnv) { [int]$routerPortEnv } else { $BackendPort }
    $BackendInternalPort = $BackendPort + 1
    if ($BackendInternalPort -gt 65535) { Fail "BACKEND_PORT=$BackendPort is too large: the gateway layout needs +1 for the backend" }
    # Discovery is off by default in dev: the local Redis is often shared with a
    # deployed stack whose registrations (host.docker.internal:13000, other
    # machines) are not reachable from the host and would poison the upstream
    # table. Set DEV_ROUTER_DISCOVERY_SEC=10 in infra/.env to exercise discovery.
    $RouterDiscoverySec = Get-EnvValue 'DEV_ROUTER_DISCOVERY_SEC' '0'
    if (-not $RouterDiscoverySec) { $RouterDiscoverySec = '0' }
    Write-Ok "backend internal port: $BackendInternalPort (+1, gateway upstream)  gateway port: $GatewayPort"
    Write-Info "router discovery: ROUTER_DISCOVERY_SEC=$RouterDiscoverySec (0 = off; DEV_ROUTER_DISCOVERY_SEC=10 to enable)"
}
Write-Ok "frontend port: $FrontendPort (vite strictPort)"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
if (-not (Test-Path $PidDir)) { New-Item -ItemType Directory -Path $PidDir | Out-Null }

# -- already running? -------------------------------------------------
$already = $false
$bp = Join-Path $PidDir 'backend.pid'
$gp = Join-Path $PidDir 'gateway.pid'
$fp = Join-Path $PidDir 'frontend.pid'
if (Test-Path $bp) { $bpid = (Get-Content $bp -Raw).Trim(); if (Test-PidAlive $bpid) { Write-Warn2 "backend already running (pid $bpid)"; $already = $true } }
if (Test-Path $gp) { $gpid = (Get-Content $gp -Raw).Trim(); if (Test-PidAlive $gpid) { Write-Warn2 "gateway already running (pid $gpid)"; $already = $true } }
if (Test-Path $fp) { $fpid = (Get-Content $fp -Raw).Trim(); if (Test-PidAlive $fpid) { Write-Warn2 "frontend already running (pid $fpid)"; $already = $true } }
if ($already) {
    if ($Force) {
        Write-Info '-Force: stopping existing processes first'
        & $ScriptDir/dev-stop.ps1 -Force
        if ($LASTEXITCODE -ne 0) { Fail 'dev-stop.ps1 failed; clean up manually then retry' }
    } else {
        Fail "already running. To restart: dev-run.ps1 -Force (or run dev-stop.ps1 first)"
    }
}

# NOTE: the backend no longer listens on BACKEND_PORT directly when the
# gateway is on - that port belongs to the gateway.
$portsToCheck = @($BackendInternalPort)
if ($GatewayPort) { $portsToCheck += $GatewayPort }
$portsToCheck += $FrontendPort
foreach ($p in $portsToCheck) {
    if (Test-PortBusy $p) {
        $owners = (Test-PortPids $p) -join ','
        Write-Warn2 "port $p occupied by: $owners"
        Write-Warn2 "(frontend is strictPort; if occupied it exits immediately; gateway/backend occupied = another project or leftover)"
        Fail "port conflict; resolve the occupant first (or dev-stop.ps1 -Force)"
    }
}
Write-Ok "ports $($portsToCheck -join ' / ') free"

# -- dependency install (first time) ----------------------------------
if (-not $NoInstall -and -not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Step 'Installing dependencies (first time; node_modules missing)'
    Write-Info 'output is verbose; writing to .dev-logs/install.log, printing tail on failure'
    & pnpm install *> (Join-Path $LogDir 'install.log')
    if ($LASTEXITCODE -ne 0) {
        Get-Content (Join-Path $LogDir 'install.log') -Tail 20 | Write-Host
        Fail "pnpm install failed; full log: $LogDir/install.log"
    }
    Write-Ok 'dependencies installed'
} else {
    Write-Info 'dependencies already present (skipping pnpm install; use pnpm install to force)'
}

# -- 1. dependency services -------------------------------------------
if (-not $NoInfra) {
    Write-Step '1. dependency services postgres / redis / minio'
    $upArgs = @{}
    & docker image inspect 'doubulea/postgres:pg16-vector-bigm' *> $null
    if ($LASTEXITCODE -eq 0) { $upArgs['NoBuild'] = $true; Write-Info 'PG image exists -> skip rebuild (rebuild with: pnpm infra:build)' }
    $upArgs['TimeoutSec'] = $TimeoutSec
    & $ScriptDir/dev-up.ps1 @upArgs
    if ($LASTEXITCODE -ne 0) { Fail 'dev-up.ps1 failed; see output above' }
    $InfraReady = $true
} else {
    Write-Step '1. dependency services'
    Write-Info 'skipped (-NoInfra) -- make sure pg/redis/minio are already running, or 2/3 will fail'
}

# -- 2. db:deploy / db:seed / db:partitions --------------------------
if (-not $NoDb) {
    Write-Step '2. db:deploy / db:seed / db:partitions (idempotent)'
    Write-Info 'db:deploy (apply existing migrations, no diff)'
    & pnpm db:deploy *> (Join-Path $LogDir 'db.log')
    if ($LASTEXITCODE -ne 0) {
        Get-Content (Join-Path $LogDir 'db.log') -Tail 20 | Write-Host
        Fail "pnpm db:deploy failed; full log: $LogDir/db.log"
    }
    Write-Ok 'migrations applied'

    Write-Info 'db:seed (idempotent: existing accounts are skipped, never re-hashed)'
    & pnpm db:seed *> (Join-Path $LogDir 'seed.log')
    if ($LASTEXITCODE -ne 0) {
        Get-Content (Join-Path $LogDir 'seed.log') -Tail 20 | Write-Host
        Write-Warn2 'common cause: backend/generated/prisma is half-generated (last prisma generate interrupted)'
        Write-Warn2 '  fix: rm -rf backend/generated/prisma; pnpm db:generate; rerun this script'
        Fail "pnpm db:seed failed; full log: $LogDir/seed.log"
    }
    Write-Ok 'seed done'
    $seedLog = Join-Path $LogDir 'seed.log'
    $seedHits = Get-Content $seedLog | Where-Object { $_ -match 'admin|member|password' } | Select-Object -First 4
    if ($seedHits) {
        Write-Warn2 "initial passwords print only once -> $seedLog (do not lose them!)"
        $seedHits | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    }

    Write-Info 'db:partitions (monthly partition rollover for messages / usage_records)'
    & pnpm db:partitions *> (Join-Path $LogDir 'partitions.log')
    if ($LASTEXITCODE -eq 0) { Write-Ok 'partitions rolled' }
    else { Write-Warn2 "partition rollover failed (non-fatal; only blows up on cross-month writes): $LogDir/partitions.log" }
} else {
    Write-Step '2. db:deploy / db:seed'
    Write-Info 'skipped (-NoDb)'
}

# -- 3. backend -------------------------------------------------------
Write-Step "3. backend (tsx watch) -> http://127.0.0.1:$BackendInternalPort"
$backendLog = Join-Path $LogDir 'backend.log'

# Instance identity: the default is os.hostname(), and a deployed backend on
# the same host already holds sandbox:instance:<hostname> (claim on startup),
# which would make the dev backend refuse to start. Use a "-dev" suffix unless
# infra/.env pins SANDBOX_INSTANCE_ID. The advertise address must point at the
# real (internal) port - the default is hostname:BACKEND_PORT, i.e. the gateway.
$instEnv = Get-EnvValue 'SANDBOX_INSTANCE_ID' ''
$backendInstanceId = if ($instEnv) { $instEnv } else { "$env:COMPUTERNAME-dev" }
$advEnv = Get-EnvValue 'SANDBOX_INSTANCE_ADVERTISE_ADDR' ''
$advHost = if ($advEnv) { ($advEnv -split ':')[0] } else { $env:COMPUTERNAME }
$backendAdvertise = "${advHost}:${BackendInternalPort}"

$beEnv = @{
    'BACKEND_PORT'                      = "$BackendInternalPort"
    'SANDBOX_INSTANCE_ID'               = $backendInstanceId
    'SANDBOX_INSTANCE_ADVERTISE_ADDR'   = $backendAdvertise
}
$beProc = Start-BackgroundPnpm 'dev:backend' $backendLog $beEnv
$backendPid = $beProc.Id
Set-Content -Path $bp -Value $backendPid
Write-Info "started in background (pid $backendPid, log $backendLog)"
Write-Info "listening on port $BackendInternalPort; instance $backendInstanceId advertises $backendAdvertise"

if (Wait-Until 'backend /health = 200' $TimeoutSec { Test-BackendUp }) {
    Write-Ok "backend ready -- http://127.0.0.1:$BackendInternalPort/health"
} else {
    Write-Host "`n--- backend.log tail ---" -ForegroundColor DarkGray
    Get-Content $backendLog -Tail 25 | Write-Host
    Write-Host ''
    Fail "backend did not come up within $TimeoutSec s (config validation failed? see log above)"
}

# -- 4. router gateway ------------------------------------------------
if ($GatewayPort) {
    Write-Step "4. router gateway (tsx) -> http://127.0.0.1:$GatewayPort"
    $gatewayLog = Join-Path $LogDir 'gateway.log'
    # Same overrides compose uses: port + static upstream = this machine's backend.
    # Discovery is pinned explicitly (dev default 0) so a shared Redis registry
    # with unreachable deployed instances cannot poison the upstream table.
    $gwEnv = @{
        'ROUTER_HOST'          = '127.0.0.1'
        'ROUTER_PORT'          = "$GatewayPort"
        'ROUTER_UPSTREAMS'     = "127.0.0.1:$BackendInternalPort"
        'ROUTER_DISCOVERY_SEC' = $RouterDiscoverySec
        'BACKEND_PORT'         = "$BackendInternalPort"
    }
    $gwProc = Start-BackgroundPnpm 'router:dev' $gatewayLog $gwEnv
    $gatewayPid = $gwProc.Id
    Set-Content -Path $gp -Value $gatewayPid
    Write-Info "started in background (pid $gatewayPid, log $gatewayLog)"
    Write-Info "ROUTER_UPSTREAMS=127.0.0.1:$BackendInternalPort (static seed)"

    if (Wait-Until "gateway $GatewayPort /health = 200" $TimeoutSec { Test-GatewayUp }) {
        Write-Ok "gateway ready -- http://127.0.0.1:$GatewayPort/health"
    } else {
        Write-Host "`n--- gateway.log tail ---" -ForegroundColor DarkGray
        Get-Content $gatewayLog -Tail 25 | Write-Host
        Write-Host ''
        Write-Warn2 "backend is up and still running in background (pid $((Get-Content $bp -Raw).Trim()))"
        Write-Warn2 "to tear everything down: powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1"
        Fail "gateway did not come up within $TimeoutSec s ($GatewayPort occupied / ROUTER_* invalid? see log above)"
    }
} else {
    Write-Step '4. router gateway'
    Write-Info 'skipped (-NoGateway) -- frontend connects to the backend directly; routing/sticky layer not exercised'
}

# -- 5. frontend ------------------------------------------------------
# Dev proxy target: the gateway when on (browser traffic really goes through
# it, the same shape as nginx -> gateway in production), else the backend.
$proxyPort = if ($GatewayPort) { $GatewayPort } else { $BackendInternalPort }
Write-Step "5. frontend (vite) -> http://localhost:$FrontendPort"
$frontendLog = Join-Path $LogDir 'frontend.log'
$feEnv = @{ 'VITE_DEV_PROXY_TARGET' = "http://127.0.0.1:$proxyPort" }
$feProc = Start-BackgroundPnpm 'dev:frontend' $frontendLog $feEnv
$frontendPid = $feProc.Id
Set-Content -Path $fp -Value $frontendPid
Write-Info "started in background (pid $frontendPid, log $frontendLog)"
Write-Info "VITE_DEV_PROXY_TARGET=http://127.0.0.1:$proxyPort (without it vite silently proxies to another project)"

if (Wait-Until 'frontend 5174 reachable' $TimeoutSec { Test-FrontendUp }) {
    Write-Ok "frontend ready -- http://localhost:$FrontendPort/"
} else {
    Write-Host "`n--- frontend.log tail ---" -ForegroundColor DarkGray
    Get-Content $frontendLog -Tail 25 | Write-Host
    Write-Host ''
    Write-Warn2 "backend/gateway are up and still running in background"
    Write-Warn2 "to tear everything down: powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1"
    Fail "frontend did not come up within $TimeoutSec s (5174 occupied / deps missing? see log above)"
}

# -- summary ----------------------------------------------------------
Write-Step 'Ready'
$pgPort    = Get-EnvValue 'POSTGRES_PORT' '5432'
$redisPort = Get-EnvValue 'REDIS_PORT' '6379'
$minioApi  = Get-EnvValue 'MINIO_API_PORT' '9000'
Write-Host "  PostgreSQL    127.0.0.1:$pgPort" -ForegroundColor DarkGray
Write-Host "  Redis         127.0.0.1:$redisPort" -ForegroundColor DarkGray
Write-Host "  MinIO API     127.0.0.1:$minioApi" -ForegroundColor DarkGray
Write-Host "  backend       http://127.0.0.1:$BackendInternalPort" -ForegroundColor DarkGray
if ($GatewayPort) {
    Write-Host "  gateway       http://127.0.0.1:$GatewayPort (/api goes through here)" -ForegroundColor DarkGray
} else {
    Write-Host "  gateway       -- (-NoGateway: frontend connects to the backend directly)" -ForegroundColor DarkGray
}
Write-Host "  frontend      http://localhost:$FrontendPort/" -ForegroundColor Green
Write-Host "`n  logs    tail -f .dev-logs/backend.log   /   tail -f .dev-logs/gateway.log   /   tail -f .dev-logs/frontend.log" -ForegroundColor DarkGray
Write-Host "  accounts admin / member (initial password in .dev-logs/seed.log; both force-reset on first login)" -ForegroundColor DarkGray
Write-Host "  stop    powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1" -ForegroundColor DarkGray
Write-Host "  hint    proxy misconfigured? curl.exe -s --noproxy '*' http://localhost:$FrontendPort/api/auth/me should return this project's 401 envelope" -ForegroundColor DarkGray
if ($GatewayPort) {
    Write-Host "  hint    which upstreams the gateway sees: curl.exe -s --noproxy '*' http://127.0.0.1:$GatewayPort/health" -ForegroundColor DarkGray
}
if ($InfraReady) {
    Write-Host "  note    to dispatch into the sandbox you still need to push the image to its tag: pnpm sandbox:build (see README stage-3 acceptance prereqs)" -ForegroundColor Yellow
}
Write-Host ''
