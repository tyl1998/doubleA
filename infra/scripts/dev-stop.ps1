# =====================================================================
# dev-stop.ps1 - stop the dev-run.ps1 background processes (Windows)
#
# Windows counterpart of infra/scripts/dev-stop.sh. By default stops only
# the application layer (frontend + gateway + backend); dependency services
# stay up. Frontend first, then the gateway, then the backend, so the entry
# point is gone before the process behind it.
#
# Ports match dev-run.ps1: with the gateway on (default) the backend listens
# on BACKEND_PORT+1 (internal) and the gateway on ROUTER_PORT (or
# BACKEND_PORT when ROUTER_PORT is unset). The backend stop covers both ports
# so a -NoGateway layout is cleaned up as well.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1 -Infra
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1 -Purge
#   powershell -ExecutionPolicy Bypass -File infra/scripts/dev-stop.ps1 -Force
#
# Order of operations per service: try a graceful Stop-Process on the whole
# process tree (recorded pid + descendants) -> wait 10s -> force kill the
# tree -> force kill port owners -> path-scoped cleanup that also catches
# orphans whose parent died and got reparented to pid 1.
#
# NOTE on graceful shutdown: Windows has no reliable per-process SIGINT for
# console Node processes, so this script escalates to forced termination.
# That is fine for a dev script because all real state lives in Postgres /
# Redis (AOF everysec + noeviction). The recorded pid is the pnpm shell; the
# actual listener is the deepest node (tsx watch / vite), so we always act on
# the whole tree, never just the port-owning leaf.
#
# NOTE: ASCII-only on purpose - same reason as the other infra/*.ps1.
# =====================================================================

[CmdletBinding()]
param(
    [switch]$Infra,
    [switch]$Purge,
    [switch]$Force
)

if ($Purge) { $Infra = $true }

$ErrorActionPreference = 'Stop'
# never let any cmdlet pop an interactive prompt (a script that waits for
# confirmation input looks exactly like a hang when run non-interactively)
$ConfirmPreference = 'None'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InfraDir  = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $InfraDir
$EnvFile   = Join-Path $InfraDir '.env'
$PidDir    = Join-Path $RepoRoot '.pids'

$FrontendPort = 5174
$BackendPort  = 13000
$BackendInternalPort = $BackendPort + 1
$GatewayPort  = $BackendPort

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "  [--] $msg" -ForegroundColor DarkGray }

function Get-EnvValue($key, $default) {
    if (-not (Test-Path $EnvFile)) { return $default }
    $lines = Get-Content $EnvFile
    $line = $lines | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
    if (-not $line) { return $default }
    return ($line -replace "^\s*$key\s*=", '').Trim()
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

# all descendant pids of $root (parent/child via Win32_Process)
# NOTE: do NOT implement the queue shift as @($stack[1..($stack.Count-1)]) --
# when Count=1 the range 1..0 is a DESCENDING range (1,0), so the element is
# never removed and the loop spins forever. Use a real Queue + children map.
function Get-DescendantPids($root) {
    if (-not $root) { return @() }
    try { $rootId = [int]$root } catch { return @() }
    $procs = Get-CimInstance Win32_Process
    $childrenOf = @{}
    foreach ($p in $procs) {
        $ppid = [int]$p.ParentProcessId
        $cpid = [int]$p.ProcessId
        if (-not $childrenOf.ContainsKey($ppid)) { $childrenOf[$ppid] = @() }
        $childrenOf[$ppid] += $cpid
    }
    $result = @()
    $visited = @{}
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($rootId)
    while ($queue.Count -gt 0) {
        $cur = $queue.Dequeue()
        if ($visited.ContainsKey($cur)) { continue }
        $visited[$cur] = $true
        foreach ($c in $childrenOf[$cur]) {
            if (-not $visited.ContainsKey($c)) {
                $result += $c
                $queue.Enqueue($c)
            }
        }
    }
    return $result
}

# owner pids listening on ANY of $ports (deduped): the backend lives on a
# different port depending on whether the gateway layout is in use.
function Test-PortsPids($ports) {
    $all = @()
    foreach ($p in $ports) { if ($p) { $all += Test-PortPids $p } }
    return ($all | Where-Object { $_ } | Sort-Object -Unique)
}
function Test-AnyPortBusy($ports) {
    foreach ($p in $ports) { if ($p -and (Test-PortBusy $p)) { return $true } }
    return $false
}

function Stop-One($name, $pidFile, $ports) {
    $ports = @($ports | Where-Object { $_ })
    $portList = $ports -join ','
    $svcPid = $null
    if (Test-Path $pidFile) { $svcPid = (Get-Content $pidFile -Raw).Trim() }
    $alive = Test-PidAlive $svcPid
    $tree = if ($alive) { @($svcPid) + (Get-DescendantPids $svcPid) } else { @() }
    $portPids = Test-PortsPids $ports
    $targets = (@($tree) + $portPids) | Sort-Object -Unique

    if ($targets.Count -eq 0) {
        Write-Info "$name : not running"
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return
    }

    # pid file missing/invalid but port occupied: another project / manual -> do not touch unless -Force
    if (-not $alive -and $portPids -and -not $Force) {
        Write-Warn2 "$name : no valid pid file, but port $portList occupied ($($portPids -join ','))"
        Write-Warn2 "  not touching it (could be another project / manual) -> skipped. Use -Force to override"
        return
    }

    # 1. graceful attempt (Stop-Process without -Force; escalates below)
    Write-Info "$name : Stop-Process -> $($targets -join ' ')"
    foreach ($t in $targets) { try { Stop-Process -Id $t -ErrorAction SilentlyContinue -Confirm:$false } catch {} }
    $i = 0
    while ($i -lt 10) {
        $still = $false
        if ($alive -and (Test-PidAlive $svcPid)) { $still = $true }
        if (-not $still -and (Test-AnyPortBusy $ports)) { $still = $true }
        if (-not $still) { break }
        Start-Sleep -Seconds 1; $i++
    }

    # 2. force kill tree (+ any new children tsx watch may have spawned)
    if (($alive -and (Test-PidAlive $svcPid)) -or (Test-AnyPortBusy $ports)) {
        if ($alive) { $tree = @($svcPid) + (Get-DescendantPids $svcPid) }
        $targets = (@($tree) + (Test-PortsPids $ports)) | Sort-Object -Unique
        Write-Warn2 "$name : graceful failed -> force kill -> $($targets -join ' ')"
        foreach ($t in $targets) { try { Stop-Process -Id $t -Force -ErrorAction SilentlyContinue -Confirm:$false } catch {} }
        Start-Sleep -Seconds 2
    }

    # 3. still holding a port? nuke port owners
    if (Test-AnyPortBusy $ports) {
        Write-Warn2 "$name : still up -> force kill port owners"
        foreach ($t in (Test-PortsPids $ports)) { try { Stop-Process -Id $t -Force -ErrorAction SilentlyContinue -Confirm:$false } catch {} }
        Start-Sleep -Seconds 1
    }

    # 4. path-scoped cleanup: catch orphans (parent died, reparented to 1)
    if ((Test-PidAlive $svcPid) -or (Test-AnyPortBusy $ports)) {
        Write-Warn2 "$name : still not clean -> path-scoped cleanup"
        $markers = @('tsx watch', 'vite', 'dev:backend', 'dev:frontend', 'router:dev', 'router/main.ts')
        Get-CimInstance Win32_Process | Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains($RepoRoot) -and
            ($markers | Where-Object { $_.CommandLine.Contains($_) })
        } | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue -Confirm:$false } catch {}
        }
        Start-Sleep -Seconds 1
    }

    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    if ((Test-PidAlive $svcPid) -or (Test-AnyPortBusy $ports)) {
        $owners = (Test-PortsPids $ports) -join ','
        Write-Warn2 "$name : still not clean (pid=$svcPid, port $portList owners=$owners)"
        return
    }
    Write-Ok "$name stopped"
}

Set-Location $RepoRoot
$BackendPort = [int](Get-EnvValue 'BACKEND_PORT' '13000')
$routerPortEnv = Get-EnvValue 'ROUTER_PORT' ''
$GatewayPort = if ($routerPortEnv) { [int]$routerPortEnv } else { $BackendPort }
$BackendInternalPort = $BackendPort + 1

$frontendPidFile = Join-Path $PidDir 'frontend.pid'
$gatewayPidFile  = Join-Path $PidDir 'gateway.pid'
$backendPidFile  = Join-Path $PidDir 'backend.pid'

Write-Step 'Stopping application layer'
Stop-One 'frontend' $frontendPidFile @($FrontendPort)
Stop-One 'gateway'  $gatewayPidFile  @($GatewayPort)
# backend: gateway layout listens on BACKEND_PORT+1, -NoGateway layout on
# BACKEND_PORT -- cover both; with a valid pid file the tree decides.
Stop-One 'backend'  $backendPidFile  @($BackendInternalPort, $BackendPort)

if ($Infra) {
    Write-Step 'Stopping dependency services'
    if ($Purge) {
        & $ScriptDir/dev-down.ps1 -Purge
    } else {
        & $ScriptDir/dev-down.ps1
    }
    if ($LASTEXITCODE -ne 0) { exit 1 }
    Write-Host ''
} else {
    Write-Step 'Dependency services'
    Write-Info 'kept running (postgres / redis / minio) -- add -Infra to stop them too'
}

Write-Host "`n  restart: powershell -ExecutionPolicy Bypass -File infra/scripts/dev-run.ps1`n" -ForegroundColor DarkGray
