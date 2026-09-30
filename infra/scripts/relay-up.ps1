# =====================================================================
# relay-up.ps1 - start the sandbox relay container (exit 2: container -> backend)
#
# WHY: sandbox containers sit on `doubulea-sandbox` (Internal: true) and can
#   only reach that bridge's gateway. On Docker Desktop (Windows/macOS) that
#   gateway is a Linux VM, NOT the host running the backend, so containers
#   cannot reach the backend (P0-3-3 measured ENETUNREACH). This relay is a
#   raw TCP forwarder dual-homed on the default bridge + the sandbox network.
#   Production (backend on the Docker host) does NOT need it.
#
# PREREQ: the `doubulea-sandbox` network is created by the BACKEND at startup
#   (backend/src/sandbox/listener.ts) => start the backend first.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infra/scripts/relay-up.ps1
#   powershell -ExecutionPolicy Bypass -File infra/scripts/relay-up.ps1 -WriteEnv
#   powershell -ExecutionPolicy Bypass -File infra/scripts/relay-up.ps1 -Target 10.0.0.5:13001
#
# NOTE: this file is intentionally ASCII-only.
#   Windows PowerShell 5.1 reads .ps1 as the system ANSI codepage unless the
#   file starts with a UTF-8 BOM. Non-ASCII text here would be mojibake and
#   could even break parsing. Keep it ASCII, or add a BOM if Chinese is needed.
#
# NOTE: Go template strings passed to docker are held in VARIABLES.
#   An inline single-quoted '{{...}}' is misparsed by PowerShell 5.1 as a
#   nested script block. Keep them in variables.
# =====================================================================

[CmdletBinding()]
param(
    [string]$Name = 'doubulea-sandbox-relay',
    [int]$Port = 13001,
    [string]$Network = 'doubulea-sandbox',
    [string]$Image = 'node:22-bookworm-slim',
    [string]$Target = 'host.docker.internal',
    [int]$TargetPort = 0,
    [switch]$WriteEnv
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraDir  = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $InfraDir
$EnvFile   = Join-Path $InfraDir '.env'
$RelaySrc  = Join-Path $ScriptDir 'sandbox-relay.mjs'

if ($TargetPort -eq 0) { $TargetPort = $Port }

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "  [--] $msg" -ForegroundColor DarkGray }
function Fail($msg) { Write-Host "`n[FAIL] $msg" -ForegroundColor Red; exit 1 }

# Build a tiny node TCP-connect one-liner (uses only double quotes so the
# PowerShell single-quoted wrapper stays clean).
function New-TcpProbeJs($host_, $port_) {
    $js = 'const net=require("net");const s=net.connect(__PORT__,"__HOST__");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),3000)'
    return $js.Replace('__PORT__', [string]$port_).Replace('__HOST__', [string]$host_)
}

# TCP-connect from a throwaway container inside $Net.
function Test-TcpFromNetwork($net_, $host_, $port_) {
    $js = New-TcpProbeJs $host_ $port_
    & docker run --rm --network $net_ $Image node -e $js *> $null
    return ($LASTEXITCODE -eq 0)
}

# TCP-connect from inside the running relay container.
function Test-TcpInContainer($container_, $host_, $port_) {
    $js = New-TcpProbeJs $host_ $port_
    & docker exec $container_ node -e $js *> $null
    return ($LASTEXITCODE -eq 0)
}

# Set KEY=value in infra/.env (replace the first match, else append).
function Set-EnvValue($key, $value) {
    if (-not (Test-Path $EnvFile)) { Fail "missing $EnvFile (copy from .env.example first)" }
    $lines = @(Get-Content $EnvFile)
    $pattern = '^\s*' + [regex]::Escape($key) + '\s*='
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = "$key=$value"
            $done = $true
            break
        }
    }
    if (-not $done) { $lines += "$key=$value" }
    Set-Content -Path $EnvFile -Value $lines -Encoding UTF8
}

# -- 0. preflight -----------------------------------------------------
Write-Step 'Preflight'

& docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker engine is not running. Start Docker Desktop first.' }
Write-Ok 'docker reachable'

if (-not (Test-Path $RelaySrc)) { Fail "missing relay source $RelaySrc" }
Write-Ok "relay source: $RelaySrc"

& docker image inspect $Image *> $null
if ($LASTEXITCODE -ne 0) { Fail "image $Image is not present locally (this script deliberately does not pull; it must run offline)" }
Write-Ok "image present: $Image"

& docker network inspect $Network *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "sandbox network $Network does not exist. It is created by the BACKEND at startup (backend/src/sandbox/listener.ts) => run the backend first (pnpm dev / pnpm dev:backend), then re-run this script. Do NOT docker network create it by hand: the backend validates labels and the Internal flag."
}
Write-Ok "sandbox network exists: $Network"

# -- 1. run container (backend leg = default bridge) -------------------
Write-Step "Starting relay container $Name"

& docker container inspect $Name *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Info 'a container with this name exists; removing it first'
    & docker rm -f $Name *> $null
    if ($LASTEXITCODE -ne 0) { Fail "cannot remove old container $Name" }
}

& docker run -d --name $Name `
    --network bridge --restart unless-stopped `
    --add-host "host.docker.internal:host-gateway" `
    -e "RELAY_LISTEN_HOST=0.0.0.0" `
    -e "RELAY_LISTEN_PORT=$Port" `
    -e "RELAY_TARGET_HOST=$Target" `
    -e "RELAY_TARGET_PORT=$TargetPort" `
    -v "${RelaySrc}:/app/sandbox-relay.mjs:ro" `
    $Image node /app/sandbox-relay.mjs *> $null
if ($LASTEXITCODE -ne 0) { Fail "container failed to start (see: docker logs $Name)" }
Write-Ok 'started (backend leg = default bridge)'

# -- 2. attach the sandbox leg ----------------------------------------
Write-Step "Attaching sandbox leg $Network"

& docker network connect $Network $Name *> $null
if ($LASTEXITCODE -ne 0) {
    $fmt = '{{range .Containers}}{{.Name}} {{end}}'
    $members = (& docker network inspect $Network --format $fmt 2>$null)
    if ($members -match ("(^|\s)" + [regex]::Escape($Name) + "(\s|$)")) {
        Write-Info "already attached to $Network"
    } else {
        Fail "failed to attach to $Network"
    }
} else {
    Write-Ok "attached to $Network"
}

# -- 3. health probes -------------------------------------------------
Write-Step 'Health probes'

Start-Sleep -Seconds 1
if (Test-TcpInContainer $Name '127.0.0.1' $Port) {
    Write-Ok "relay process is listening on $Port"
} else {
    & docker logs --tail 20 $Name 2>&1 | Out-Host
    Fail 'relay did not come up (container logs above)'
}

if (Test-TcpFromNetwork $Network $Name $Port) {
    Write-Ok "reachable from a container in $Network at ${Name}:${Port} - both legs OK"
} else {
    Fail "not reachable from within $Network at ${Name}:${Port} (sandbox leg not attached?)"
}

if (Test-TcpInContainer $Name $Target $TargetPort) {
    Write-Ok "relay can reach target ${Target}:${TargetPort}"
} else {
    Write-Warn2 "relay cannot reach ${Target}:${TargetPort} right now - is the backend listener up? Start the backend (pnpm dev) and re-run this script."
}

# -- 4. result --------------------------------------------------------
$Url = "http://${Name}:${Port}"
Write-Step 'Ready'
Write-Host "  SANDBOX_BACKEND_URL=$Url" -ForegroundColor Green
Write-Host "  SANDBOX_LISTEN_HOST=0.0.0.0`n" -ForegroundColor Green

if ($WriteEnv) {
    Set-EnvValue 'SANDBOX_BACKEND_URL' $Url
    Set-EnvValue 'SANDBOX_LISTEN_HOST' '0.0.0.0'
    Write-Ok 'written to infra/.env'
    Write-Warn2 'the backend reads env at STARTUP => restart it: pnpm dev:stop ; pnpm dev'
} else {
    Write-Info 'to write infra/.env run: relay-up.ps1 -WriteEnv'
}

Write-Host "`n  logs: docker logs -f $Name" -ForegroundColor DarkGray
Write-Host "  stop: powershell -ExecutionPolicy Bypass -File infra/scripts/relay-down.ps1" -ForegroundColor DarkGray
Write-Host "`n  NOTE: production (backend on the Docker host) does NOT need this relay:" -ForegroundColor DarkGray
Write-Host "        leave SANDBOX_BACKEND_URL / SANDBOX_LISTEN_HOST empty there." -ForegroundColor DarkGray
