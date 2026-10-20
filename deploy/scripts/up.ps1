# ═══════════════════════════════════════════════════════════════════════
# up.ps1 - start the containers on Windows (Docker Desktop, Linux containers)
#
# WHY SEPARATE FROM up.sh: Windows cannot use Linux `--network host`, and the
#   in-container path `/var/run/docker.sock` does not exist (the daemon listens
#   on a named pipe). So on Windows the backend publishes ports and reaches the
#   daemon over TCP; sandbox containers call back through a relay.
#
# PREREQUISITE (one-time, in Docker Desktop):
#   Settings -> General -> "Expose daemon on tcp://localhost:2375 without TLS"
#
# USAGE (PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\up.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\up.ps1 -NoBuild
#   powershell -ExecutionPolicy Bypass -File scripts\up.ps1 -ResetDb   # destructive
#
# NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI
#   unless the file has a UTF-8 BOM, so non-ASCII would be mojibake.
# ═══════════════════════════════════════════════════════════════════════

[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$ResetDb,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$DeployDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvFile   = if ($env:DEPLOY_ENV_FILE) { $env:DEPLOY_ENV_FILE } else { Join-Path $DeployDir 'deploy.env' }
$GenDir    = Join-Path $DeployDir '.generated'
$DockerDir = Join-Path $DeployDir 'docker'

function Write-Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Info($m) { Write-Host "  [--] $m" -ForegroundColor DarkGray }
function Write-Warn2($m){ Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "`n  [FAIL] $m`n" -ForegroundColor Red; exit 1 }

# ---- read deploy.env (KEY=VALUE, no code execution) -------------------
function Read-EnvFile($path) {
    $map = @{}
    if (-not (Test-Path $path)) { return $map }
    foreach ($line in Get-Content -Path $path -Encoding UTF8) {
        if ($line -match '^\s*#') { continue }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $matches[1]
            $v = $matches[2].Trim()
            if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
                $v = $v.Substring(1, $v.Length - 2)
            }
            $map[$k] = $v
        }
    }
    return $map
}

if (-not (Test-Path $EnvFile)) {
    Fail @"
missing $EnvFile
  copy the template first:
    Copy-Item deploy\env\deploy.env.example deploy\deploy.env
  then fill: CREDENTIAL_MASTER_KEY / POSTGRES_PASSWORD / S3_SECRET / INSTANCE_IP
"@
}
$cfg = Read-EnvFile $EnvFile
function Cfg($key, $default) { if ($cfg.ContainsKey($key) -and $cfg[$key] -ne '') { return $cfg[$key] } else { return $default } }

$Mode          = Cfg 'MODE' 'all'
$ManageInfra   = Cfg 'MANAGE_INFRA' '0'
$ImageSource   = Cfg 'IMAGE_SOURCE' 'local'
$ImageRegistry = Cfg 'IMAGE_REGISTRY' ''
$ImageTag      = Cfg 'IMAGE_TAG' '2'
$InstanceId    = Cfg 'INSTANCE_ID' 'local'
$InstanceIp    = Cfg 'INSTANCE_IP' '127.0.0.1'
$BackendPort   = Cfg 'BACKEND_PORT' '13000'
$GatewayPort   = Cfg 'GATEWAY_PORT' '13100'
$FrontendPort  = Cfg 'FRONTEND_PORT' '8080'
$NodeRole      = Cfg 'DOUBULEA_NODE_ROLE' 'taskAgent'
$MasterKey     = Cfg 'CREDENTIAL_MASTER_KEY' ''
$PgPassword    = Cfg 'POSTGRES_PASSWORD' ''
$S3Secret      = Cfg 'S3_SECRET' ''
$PgUser        = Cfg 'POSTGRES_USER' 'doubulea'
$PgDb          = Cfg 'POSTGRES_DB' 'doubulea'
$S3Key         = Cfg 'S3_KEY' 'doubulea'
$Tz            = Cfg 'TZ' 'Asia/Shanghai'
$PgPort        = Cfg 'POSTGRES_PORT' '15432'
$RedisPort     = Cfg 'REDIS_PORT' '16379'
$MinioApiPort  = Cfg 'MINIO_API_PORT' '19000'
$MinioConPort  = Cfg 'MINIO_CONSOLE_PORT' '19001'
$CallbackPort  = Cfg 'SANDBOX_CALLBACK_PORT' '13001'

$prefix = ''
if ($ImageSource -eq 'registry' -and $ImageRegistry -ne '') { $prefix = $ImageRegistry.TrimEnd('/') + '/' }
$ImgBackend  = "${prefix}doubulea-backend:$ImageTag"
$ImgGateway  = "${prefix}doubulea-gateway:$ImageTag"
$ImgFrontend = "${prefix}doubulea-frontend:$ImageTag"
$ImgPostgres = "${prefix}doubulea/postgres:pg16-vector-bigm"

# ---- validate --------------------------------------------------------
$problems = @()
if ($MasterKey -eq '' -or $MasterKey.StartsWith('CHANGE_ME')) { $problems += 'CREDENTIAL_MASTER_KEY (run: openssl rand -base64 32)' }
if ($MasterKey.Length -lt 44) { $problems += 'CREDENTIAL_MASTER_KEY length < 44 chars' }
if ($PgPassword -eq '' -or $PgPassword.StartsWith('CHANGE_ME')) { $problems += 'POSTGRES_PASSWORD' }
if ($S3Secret -eq '' -or $S3Secret.StartsWith('CHANGE_ME')) { $problems += 'S3_SECRET' }
if ($Mode -ne 'all' -and $Mode -ne 'node') { $problems += "MODE must be all or node, got '$Mode'" }
if ($problems.Count -gt 0) {
    Write-Host "`n  config incomplete ($EnvFile):" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "    - $p" }
    Fail 'fill the items above and re-run'
}
Write-Ok "config ok: MODE=$Mode INSTANCE_ID=$InstanceId"

# ---- dependency addresses -------------------------------------------
$pgHost    = Cfg 'REMOTE_PG_HOST' '127.0.0.1'
$pgPortV   = Cfg 'REMOTE_PG_PORT' $PgPort
$redisHost = Cfg 'REMOTE_REDIS_HOST' '127.0.0.1'
$redisPortV= Cfg 'REMOTE_REDIS_PORT' $RedisPort
$s3Host    = Cfg 'REMOTE_S3_HOST' '127.0.0.1'
$s3PortV   = Cfg 'REMOTE_S3_PORT' $MinioApiPort
$dbUrl     = "postgresql://${PgUser}:${PgPassword}@${pgHost}:${pgPortV}/${PgDb}?schema=public"
$redisUrl  = "redis://${redisHost}:${redisPortV}"
$s3Endp    = "http://${s3Host}:${s3PortV}"
$workspace = Cfg 'WORKSPACE_ROOT' (Join-Path $env:USERPROFILE 'doubulea\workspaces')
$workspace = [System.IO.Path]::GetFullPath($workspace)
if (-not (Test-Path $workspace)) { New-Item -ItemType Directory -Path $workspace -Force | Out-Null }
New-Item -ItemType Directory -Path $GenDir -Force | Out-Null

Write-Info "workspace: $workspace"
Write-Info "deps: PG ${pgHost}:${pgPortV}  Redis ${redisHost}:${redisPortV}  S3 ${s3Host}:${s3PortV}"

# ---- docker helpers --------------------------------------------------
function Running($name) { (& docker inspect -f '{{.State.Running}}' $name 2>$null) -eq 'true' }
function Exists($name)  { & docker inspect $name *> $null; return ($LASTEXITCODE -eq 0) }
function Drop($name)    { if (Exists $name) { & docker rm -f $name *> $null } }

function Ensure-Image($image) {
    & docker image inspect $image *> $null
    if ($LASTEXITCODE -eq 0) { Write-Ok $image; return }
    switch ($ImageSource) {
        'registry' {
            Write-Info "pulling $image"
            & docker pull $image *> $null
            if ($LASTEXITCODE -ne 0) { Fail "cannot pull $image (check IMAGE_REGISTRY / docker login, or use IMAGE_SOURCE=local)" }
            Write-Ok "$image pulled"
        }
        'local' { Fail "image $image not found locally - docker load -i <tar>, or set IMAGE_SOURCE=registry" }
        'build' {
            if ($NoBuild) { Fail "image $image missing and -NoBuild given" }
            Fail 'IMAGE_SOURCE=build on Windows: run pnpm backend:build-image / gateway:build / frontend:build-image in the source tree first, then use IMAGE_SOURCE=local'
        }
        default { Fail "IMAGE_SOURCE must be registry / local / build, got $ImageSource" }
    }
}

function Wait-Up($name, $timeoutSec) {
    $i = 0
    while ($i -lt $timeoutSec) {
        $state = (& docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $name 2>$null)
        $hasHealth = (& docker inspect -f '{{if .State.Health}}yes{{else}}no{{end}}' $name 2>$null)
        if ($state -eq 'healthy') { Write-Ok "$name ready"; return }
        if ($state -eq 'running' -and $hasHealth -eq 'no') { Write-Ok "$name running"; return }
        if ($state -eq 'unhealthy') { & docker logs --tail 40 $name; Fail "$name unhealthy" }
        Start-Sleep -Seconds 2
        $i += 2
    }
    & docker logs --tail 40 $name
    Fail "$name not ready within ${timeoutSec}s"
}

function Test-Tcp($hostName, $port) {
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect($hostName, [int]$port); $c.Close(); return $true }
    catch { return $false }
}

# ---- images ----------------------------------------------------------
Write-Step 'Images'
if ($ManageInfra -eq '1') { Ensure-Image $ImgPostgres }
Ensure-Image $ImgBackend
if ($Mode -eq 'all') { Ensure-Image $ImgGateway; Ensure-Image $ImgFrontend }
if ($NodeRole -eq 'taskAgent') {
    foreach ($img in @('docker:27-cli', 'node:22-bookworm-slim')) {
        & docker image inspect $img *> $null
        if ($LASTEXITCODE -ne 0) { Write-Info "pulling $img"; & docker pull $img *> $null }
    }
}

# ---- base services ---------------------------------------------------
if ($ManageInfra -eq '1') {
    Write-Step 'Base services (MANAGE_INFRA=1)'
    if ($ResetDb) {
        Write-Warn2 'ResetDb: removing deploy volumes (data loss)'
        foreach ($c in @('doubulea-postgres', 'doubulea-redis', 'doubulea-minio')) { Drop $c }
        foreach ($v in @('doubulea-deploy-pgdata', 'doubulea-deploy-redisdata', 'doubulea-deploy-miniodata')) { & docker volume rm -f $v *> $null }
    }
    foreach ($v in @('doubulea-deploy-pgdata', 'doubulea-deploy-redisdata', 'doubulea-deploy-miniodata')) { & docker volume create $v *> $null }

    if (-not ((Running 'doubulea-postgres') -and -not $Force)) {
        Drop 'doubulea-postgres'
        & docker run -d --name doubulea-postgres --restart unless-stopped `
            -e POSTGRES_USER=$PgUser -e POSTGRES_PASSWORD=$PgPassword -e POSTGRES_DB=$PgDb -e TZ=$Tz `
            -e 'POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C.UTF-8' `
            -p "${PgPort}:5432" -v doubulea-deploy-pgdata:/var/lib/postgresql/data `
            --health-cmd "pg_isready -U $PgUser -d $PgDb -q" --health-interval 5s --health-timeout 5s --health-retries 30 --health-start-period 30s `
            $ImgPostgres *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'postgres failed to start' }
        Write-Ok 'postgres started'
    } else { Write-Ok 'postgres already running' }

    if (-not ((Running 'doubulea-redis') -and -not $Force)) {
        Drop 'doubulea-redis'
        & docker run -d --name doubulea-redis --restart unless-stopped `
            -p "${RedisPort}:6379" -v doubulea-deploy-redisdata:/data `
            --health-cmd 'redis-cli ping' --health-interval 5s --health-timeout 3s --health-retries 30 `
            redis:7-alpine redis-server --appendonly yes --appendfsync everysec --maxmemory-policy noeviction *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'redis failed to start' }
        Write-Ok 'redis started'
    } else { Write-Ok 'redis already running' }

    if (-not ((Running 'doubulea-minio') -and -not $Force)) {
        Drop 'doubulea-minio'
        & docker run -d --name doubulea-minio --restart unless-stopped `
            -e MINIO_ROOT_USER=$S3Key -e MINIO_ROOT_PASSWORD=$S3Secret -e TZ=$Tz `
            -p "${MinioApiPort}:9000" -p "${MinioConPort}:9001" -v doubulea-deploy-miniodata:/data `
            --health-cmd 'curl -fsS http://127.0.0.1:9000/minio/health/live || exit 1' `
            --health-interval 5s --health-timeout 5s --health-retries 30 `
            minio/minio:latest server /data --console-address ':9001' *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'minio failed to start' }
        Write-Ok 'minio started'
    } else { Write-Ok 'minio already running' }

    Wait-Up 'doubulea-postgres' 240
    Wait-Up 'doubulea-redis' 90
    Wait-Up 'doubulea-minio' 120
} else {
    Write-Step 'Base services (reuse existing, do not create or stop)'
    Write-Info "PG ${pgHost}:${pgPortV}  Redis ${redisHost}:${redisPortV}  S3 ${s3Host}:${s3PortV}"
    if (-not (Test-Tcp $pgHost $pgPortV))       { Fail "cannot reach PG ${pgHost}:${pgPortV} (MANAGE_INFRA=0 will not start it; check REMOTE_PG_HOST/PORT)" }
    if (-not (Test-Tcp $redisHost $redisPortV)) { Fail "cannot reach Redis ${redisHost}:${redisPortV}" }
    Write-Ok 'dependencies reachable'
}

# ---- migrate + seed --------------------------------------------------
if ($Mode -eq 'all' -or $ManageInfra -eq '1') {
    Write-Step 'Migrate'
    & docker run --rm --network host `
        -e DATABASE_URL=$dbUrl -e REDIS_URL=$redisUrl -e S3_ENDPOINT=$s3Endp -e S3_KEY=$S3Key -e S3_SECRET=$S3Secret -e S3_BUCKET=$PgDb `
        -e CREDENTIAL_MASTER_KEY=$MasterKey -e TZ=$Tz `
        --entrypoint sh $ImgBackend -lc 'cd /app/backend && /app/node_modules/.bin/prisma migrate deploy'
    if ($LASTEXITCODE -ne 0) { Fail 'migrate failed' }
    Write-Ok 'schema up to date'

    Write-Step 'Seed accounts'
    $seedArgs = @('run', '--rm', '--network', 'host',
        '-e', "DATABASE_URL=$dbUrl", '-e', "REDIS_URL=$redisUrl", '-e', "S3_ENDPOINT=$s3Endp",
        '-e', "S3_KEY=$S3Key", '-e', "S3_SECRET=$S3Secret", '-e', "S3_BUCKET=$PgDb",
        '-e', "CREDENTIAL_MASTER_KEY=$MasterKey", '-e', "TZ=$Tz",
        '-e', "SEED_ADMIN_USERNAME=$(Cfg 'SEED_ADMIN_USERNAME' 'admin')",
        '-e', "SEED_ADMIN_PASSWORD=$(Cfg 'SEED_ADMIN_PASSWORD' '')",
        '-e', "SEED_MEMBER_USERNAME=$(Cfg 'SEED_MEMBER_USERNAME' 'member')",
        '-e', "SEED_MEMBER_PASSWORD=$(Cfg 'SEED_MEMBER_PASSWORD' '')",
        '--entrypoint', 'sh', $ImgBackend, '-lc', 'node /app/backend/dist/backend/prisma/seed.js')
    $seedOut = & docker @seedArgs 2>&1
    $seedOut | Set-Content -Path (Join-Path $GenDir 'seed.log') -Encoding UTF8
    $seedOut | Select-String -Pattern 'created|skipped|reset|password' | ForEach-Object { Write-Info $_.Line.Trim() }
    Write-Ok "seed done (log: $GenDir\seed.log)"
}

# ---- backend ---------------------------------------------------------
# Windows specifics vs Linux/macOS:
#   * no --network host        -> publish ports
#   * no /var/run/docker.sock  -> DOCKER_HOST=tcp://host.docker.internal:2375
#   * no socket gid needed
Write-Step 'Backend'
if (-not ((Running 'doubulea-backend') -and -not $Force)) {
    Drop 'doubulea-backend'
    & docker run -d --name doubulea-backend --restart unless-stopped `
        -p "${BackendPort}:${BackendPort}" -p "${CallbackPort}:${CallbackPort}" `
        -v "${workspace}:${workspace}" `
        -v doubulea-node-infra:/opt/node-infra -v doubulea-egress-policy:/opt/egress-policy `
        -v doubulea-docker-bin:/opt/doubulea-docker-bin:ro -v doubulea-docker-buildx:/usr/local/libexec/docker/cli-plugins:ro `
        -e NODE_ENV=production -e LOG_PRETTY=false -e TZ=$Tz `
        -e "DATABASE_URL=$dbUrl" -e "REDIS_URL=$redisUrl" `
        -e "S3_ENDPOINT=$s3Endp" -e "S3_KEY=$S3Key" -e "S3_SECRET=$S3Secret" -e "S3_BUCKET=$PgDb" `
        -e "CREDENTIAL_MASTER_KEY=$MasterKey" `
        -e "SESSION_TTL_HOURS=$(Cfg 'SESSION_TTL_HOURS' '12')" `
        -e "CHATBOT_CONCURRENCY=$(Cfg 'CHATBOT_CONCURRENCY' '50')" `
        -e "SANDBOX_CONCURRENCY=$(Cfg 'SANDBOX_CONCURRENCY' '10')" `
        -e "SANDBOX_CALLBACK_PORT=$CallbackPort" `
        -e "SANDBOX_INSTANCE_ID=$InstanceId" `
        -e "SANDBOX_INSTANCE_ADVERTISE_ADDR=${InstanceIp}:${BackendPort}" `
        -e "BACKEND_PORT=$BackendPort" -e "WORKSPACE_ROOT=$workspace" `
        -e DOUBULEA_SANDBOX_ROLE=backend -e "DOUBULEA_NODE_ROLE=$NodeRole" `
        -e 'DOUBULEA_HOST_PLATFORM=win32' `
        -e 'DOCKER_HOST=tcp://host.docker.internal:2375' `
        -e 'SANDBOX_DOCKER_BIN=/opt/doubulea-docker-bin/docker' `
        -e 'PATH=/opt/doubulea-docker-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' `
        -e 'SANDBOX_RUNTIME_BUILD_CONTEXT=/app/infra/sandbox/runtime' `
        -e 'SANDBOX_EGRESS_PROXY_URL=http://doubulea-egress:3128' -e 'SANDBOX_EGRESS_ALLOW_HOSTS=*' `
        -e 'SANDBOX_LISTEN_HOST=0.0.0.0' -e 'SANDBOX_BACKEND_URL=http://doubulea-sandbox-relay:13001' `
        -e 'EGRESS_IMAGE=node:22-bookworm-slim' -e 'RELAY_IMAGE=node:22-bookworm-slim' -e 'DOCKER_CLI_IMAGE=docker:27-cli' `
        --add-host host.docker.internal:host-gateway `
        --health-cmd "node -e `"fetch('http://127.0.0.1:${BackendPort}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`"" `
        --health-interval 15s --health-timeout 5s --health-retries 10 --health-start-period 40s `
        $ImgBackend *> $null
    if ($LASTEXITCODE -ne 0) { Fail 'backend failed to start (docker logs doubulea-backend)' }
    Write-Ok 'backend started'
} else { Write-Ok 'backend already running' }
Wait-Up 'doubulea-backend' 180

# ---- sandbox sidecars ------------------------------------------------
if ($NodeRole -eq 'taskAgent') {
    Write-Step 'Sandbox (sidecar / egress / relay)'
    foreach ($v in @('doubulea-docker-bin', 'doubulea-docker-buildx', 'doubulea-node-infra', 'doubulea-egress-policy')) {
        & docker volume create $v *> $null
        & docker run --rm --entrypoint sh -v "${v}:/vol" $ImgBackend -c 'chmod 0777 /vol' *> $null
    }
    if (-not (Running 'doubulea-docker-cli')) {
        Drop 'doubulea-docker-cli'
        & docker run -d --name doubulea-docker-cli --restart unless-stopped --network none `
            -v doubulea-docker-bin:/opt/bin -v doubulea-docker-buildx:/opt/plugins `
            --entrypoint /bin/sh docker:27-cli -lc 'mkdir -p /opt/bin /opt/plugins /usr/local/libexec/docker/cli-plugins && cp /usr/local/bin/docker /opt/bin/docker && chmod 0755 /opt/bin/docker && if [ -f /usr/local/libexec/docker/cli-plugins/docker-buildx ]; then cp /usr/local/libexec/docker/cli-plugins/docker-buildx /opt/plugins/docker-buildx && chmod 0755 /opt/plugins/docker-buildx; fi && exec sleep infinity' *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'docker-cli sidecar failed to start' }
        Write-Ok 'docker-cli sidecar started'
    } else { Write-Ok 'docker-cli sidecar already running' }

    # sandbox network is created by the backend at startup
    $netOk = $false
    for ($i = 0; $i -lt 60; $i++) {
        & docker network inspect doubulea-sandbox *> $null
        if ($LASTEXITCODE -eq 0) { $netOk = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $netOk) { Fail 'network doubulea-sandbox not found (did the backend start? docker logs doubulea-backend)' }

    if (-not (Running 'doubulea-egress')) {
        Drop 'doubulea-egress'
        & docker run -d --name doubulea-egress --restart unless-stopped --network doubulea-sandbox `
            -v "${DockerDir}\egress-proxy.mjs:/app/egress-proxy.mjs:ro" `
            -e EGRESS_PORT=3128 -e EGRESS_LISTEN_HOST=0.0.0.0 -e 'EGRESS_ALLOW=*' `
            --entrypoint node node:22-bookworm-slim /app/egress-proxy.mjs *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'egress failed to start' }
        & docker network connect bridge doubulea-egress *> $null
        Write-Ok 'egress started (3128)'
    } else { Write-Ok 'egress already running'; & docker network connect doubulea-sandbox doubulea-egress *> $null }

    if (-not (Running 'doubulea-sandbox-relay')) {
        Drop 'doubulea-sandbox-relay'
        & docker run -d --name doubulea-sandbox-relay --restart unless-stopped `
            --network bridge --add-host host.docker.internal:host-gateway `
            -v "${DockerDir}\sandbox-relay.mjs:/app/sandbox-relay.mjs:ro" `
            -e "RELAY_TARGET=host.docker.internal:${CallbackPort}" `
            --entrypoint node node:22-bookworm-slim /app/sandbox-relay.mjs *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'relay failed to start' }
        & docker network connect doubulea-sandbox doubulea-sandbox-relay *> $null
        Write-Ok 'sandbox-relay started'
    } else { Write-Ok 'sandbox-relay already running'; & docker network connect doubulea-sandbox doubulea-sandbox-relay *> $null }
} else {
    Write-Step 'Sandbox'
    Write-Info "DOUBULEA_NODE_ROLE=$NodeRole - no sandbox, skipping sidecars"
}

# ---- gateway + frontend ----------------------------------------------
if ($Mode -eq 'all') {
    Write-Step 'Gateway'
    if (-not ((Running 'doubulea-gateway') -and -not $Force)) {
        Drop 'doubulea-gateway'
        & docker run -d --name doubulea-gateway --restart unless-stopped `
            -e DOUBULEA_SANDBOX_ROLE=router -e NODE_ENV=production -e LOG_PRETTY=false -e TZ=$Tz `
            -e ROUTER_HOST=0.0.0.0 -e "ROUTER_PORT=$GatewayPort" `
            -e "ROUTER_UPSTREAMS=host.docker.internal:${BackendPort}" `
            -e ROUTER_DISCOVERY_SEC=10 -e ROUTER_LOAD_AWARE=true `
            -e ROUTER_UPSTREAM_TIMEOUT_MS=30000 -e ROUTER_UPSTREAM_TIMEOUT_LONG_MS=900000 `
            -e SANDBOX_INSTANCE_HEARTBEAT_SEC=30 -e SANDBOX_OWNER_KEY_PREFIX=sandbox:owner `
            -e "BACKEND_PORT=$BackendPort" -e "REDIS_URL=$redisUrl" `
            -p "${GatewayPort}:${GatewayPort}" --add-host host.docker.internal:host-gateway `
            --health-cmd "node -e `"fetch('http://127.0.0.1:${GatewayPort}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`"" `
            --health-interval 15s --health-timeout 5s --health-retries 10 --health-start-period 20s `
            --entrypoint node $ImgGateway /app/backend/dist/backend/src/router/main.js *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'gateway failed to start' }
        Write-Ok 'gateway started'
    } else { Write-Ok 'gateway already running' }
    Wait-Up 'doubulea-gateway' 120

    Write-Step 'Frontend'
    if (-not ((Running 'doubulea-frontend') -and -not $Force)) {
        Drop 'doubulea-frontend'
        & docker run -d --name doubulea-frontend --restart unless-stopped `
            -e "ROUTER_UPSTREAM=http://host.docker.internal:${GatewayPort}" -e CLIENT_MAX_BODY_MB=100 `
            --add-host host.docker.internal:host-gateway -p "${FrontendPort}:80" `
            --health-cmd 'wget -qO- http://127.0.0.1/ >/dev/null || exit 1' `
            --health-interval 15s --health-timeout 5s --health-retries 10 --health-start-period 5s `
            $ImgFrontend *> $null
        if ($LASTEXITCODE -ne 0) { Fail 'frontend failed to start' }
        Write-Ok 'frontend started'
    } else { Write-Ok 'frontend already running' }
    Wait-Up 'doubulea-frontend' 90
}

Write-Step 'Ready'
if ($Mode -eq 'all') { Write-Host "  browser:  http://${InstanceIp}:${FrontendPort}" -ForegroundColor Green }
Write-Host "  backend:  http://127.0.0.1:${BackendPort}/health"
if ($Mode -eq 'all') {
    Write-Host "  gateway:  http://127.0.0.1:${GatewayPort}/health"
    Write-Host "  accounts: see $GenDir\seed.log"
}
Write-Host "`n  logs:  docker logs -f doubulea-backend"
Write-Host "  stop:  powershell -ExecutionPolicy Bypass -File scripts\down.ps1`n"
