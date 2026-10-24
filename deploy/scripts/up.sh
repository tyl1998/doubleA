#!/usr/bin/env bash
# =====================================================================
# up.sh —— 一键起全部服务（Linux / macOS），**纯 docker run，不用 compose**
#
#   bash scripts/up.sh                # 起全部（按 MODE）
#   bash scripts/up.sh --no-build     # IMAGE_SOURCE=build 时跳过构建
#   bash scripts/up.sh --reset-db     # ⚠️ 删库重建（数据全丢）
#   bash scripts/up.sh --force        # 已在跑也重建容器（改了镜像 tag 后用）
#
# 幂等：已在跑的容器不会被重建；迁移/种子本身幂等，可重复执行。
#
# MODE=all  : ①依赖服务 ②建表+种子 ③后端 ④egress ⑤relay ⑥网关 ⑦前端
# MODE=node : ③后端 ④egress ⑤relay          （依赖/建表/网关/前端都在 all 那台）
# =====================================================================

set -uo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

do_build=1; reset_db=0; force=0
NODE_ENV_FILE=''; SHARED_ENV_FILE_ARG=''
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) do_build=0 ;;
    --reset-db) reset_db=1 ;;
    --force)    force=1 ;;
    # ★ 兼容旧入口（原 `infra/scripts/node-up.sh`，已删除；它做的"合成配置"搬到了这里）：
    #   老机器上习惯 `--env .env.node --shared .env.node.shared` 两份文件，
    #   这里直接接受，按"共享值打底、本机值覆盖"合成一份临时 deploy.env，
    #   然后**设成 DEPLOY_ENV_FILE** 继续走同一套流程（不另维护一份实现）。
    --env)      shift; NODE_ENV_FILE="${1:-}" ;;
    --shared)   shift; SHARED_ENV_FILE_ARG="${1:-}" ;;
    -h|--help)  sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "未知参数：$1（见 --help）" ;;
  esac
  shift
done

# 两份 env 输入 ⇒ 合成一份（只在本机没显式给 DEPLOY_ENV_FILE 时生效）
if [ -n "$NODE_ENV_FILE" ] || [ -n "$SHARED_ENV_FILE_ARG" ]; then
  [ -n "$NODE_ENV_FILE" ] || die '--shared 需要同时给 --env（本机那份）'
  [ -f "$NODE_ENV_FILE" ] || die "找不到 $NODE_ENV_FILE"
  if [ -z "${DEPLOY_ENV_FILE:-}" ]; then
    DEPLOY_ENV_FILE="$(mktemp -t doubulea-up-XXXXXX.env)"
    export DEPLOY_ENV_FILE
    synth_from_two_envs "$NODE_ENV_FILE" "${SHARED_ENV_FILE_ARG:-}" >"$DEPLOY_ENV_FILE"
    chmod 600 "$DEPLOY_ENV_FILE"
    trap 'rm -f "$DEPLOY_ENV_FILE"' EXIT
    info "已把两份 env 合成临时配置：$NODE_ENV_FILE + ${SHARED_ENV_FILE_ARG:-（无）}"
  fi
fi

prepare
require_cmd docker '安装 Docker（macOS 可用 OrbStack / Docker Desktop）'
docker info >/dev/null 2>&1 || die 'Docker daemon 不通'

# 起容器：已在跑就跳过（除非 --force）
up_if_needed() {
  local name="$1"; shift
  if running "$name" && [ "$force" -eq 0 ]; then
    ok "$name 已在运行（跳过）"
    return
  fi
  drop "$name"
  docker "$@" >/dev/null || die "$name 起不来：见上面的 docker 报错，或 docker logs $name"
  ok "$name 已启动"
}

# ── 镜像 ──────────────────────────────────────────────────────────────
step '镜像'
if [ "$IMAGE_SOURCE" = 'build' ] && [ "$do_build" -eq 0 ]; then
  info '--no-build：跳过构建'
else
  [ "$MANAGE_INFRA" = '1' ] && ensure_image "$IMG_POSTGRES"
  ensure_image "$IMG_BACKEND"
  if [ "$MODE" = 'all' ]; then
    ensure_image "$IMG_GATEWAY"
    ensure_image "$IMG_FRONTEND"
  fi
fi
# 沙箱宿主还要两个运行时镜像（能联网时让 Docker 自己拉）
if [ "$NODE_ROLE" = 'taskAgent' ]; then
  for img in docker:27-cli node:22-bookworm-slim; do
    docker image inspect "$img" >/dev/null 2>&1 || { info "拉取 $img"; docker pull "$img" >/dev/null 2>&1 || warn "拉不到 ${img}（沙箱初始化时会再试）"; }
  done
fi

# ── ① 依赖服务 ────────────────────────────────────────────────────────
# ★ MANAGE_INFRA=0（默认）时**一行都不碰**基础服务：只探测连通性。
#   别人的 PG/Redis/MinIO 由运维或另一个 compose 管着，本包去 stop/rm 就是事故。
if [ "$MANAGE_INFRA" = '1' ]; then
  step '基础服务（本包管理）'
  if [ "$reset_db" -eq 1 ]; then
    warn '--reset-db：删除本包的数据卷（数据库 / 对象存储全丢）'
    for c in "$C_PG" "$C_REDIS" "$C_MINIO"; do drop "$c"; done
    docker volume rm -f doubulea-deploy-pgdata doubulea-deploy-redisdata doubulea-deploy-miniodata >/dev/null 2>&1 || true
  fi
  docker volume create doubulea-deploy-pgdata    >/dev/null
  docker volume create doubulea-deploy-redisdata >/dev/null
  docker volume create doubulea-deploy-miniodata >/dev/null

  up_if_needed "$C_PG" run -d --name "$C_PG" --restart unless-stopped \
    -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -e POSTGRES_DB="$POSTGRES_DB" \
    -e TZ="$TZ" -e POSTGRES_INITDB_ARGS='--encoding=UTF8 --locale=C.UTF-8' \
    -p "${POSTGRES_PORT}:5432" -v doubulea-deploy-pgdata:/var/lib/postgresql/data \
    --health-cmd "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB -q" --health-interval 5s --health-timeout 5s \
    --health-retries 30 --health-start-period 30s \
    "$IMG_POSTGRES"

  up_if_needed "$C_REDIS" run -d --name "$C_REDIS" --restart unless-stopped \
    -p "${REDIS_PORT}:6379" -v doubulea-deploy-redisdata:/data \
    --health-cmd 'redis-cli ping' --health-interval 5s --health-timeout 3s --health-retries 30 \
    redis:7-alpine redis-server --appendonly yes --appendfsync everysec --maxmemory-policy noeviction

  up_if_needed "$C_MINIO" run -d --name "$C_MINIO" --restart unless-stopped \
    -e MINIO_ROOT_USER="$S3_KEY" -e MINIO_ROOT_PASSWORD="$S3_SECRET" -e TZ="$TZ" \
    -p "${MINIO_API_PORT}:9000" -p "${MINIO_CONSOLE_PORT}:9001" -v doubulea-deploy-miniodata:/data \
    --health-cmd 'curl -fsS http://127.0.0.1:9000/minio/health/live || exit 1' \
    --health-interval 5s --health-timeout 5s --health-retries 30 \
    minio/minio:latest server /data --console-address ':9001'

  wait_up "$C_PG" 240
  wait_up "$C_REDIS" 90
  wait_up "$C_MINIO" 120
else
  step '基础服务（复用现有，不创建不停止）'
  info "PG ${PG_HOST}:${PG_PORT}   Redis ${REDIS_HOST}:${REDIS_PORT_V}   S3 ${S3_HOST}:${S3_PORT_V}"
  wait_tcp "$PG_HOST" "$PG_PORT" 15 || die "连不上 PG ${PG_HOST}:${PG_PORT}（MANAGE_INFRA=0 不会替你起它；检查 REMOTE_PG_HOST/PORT）"
  wait_tcp "$REDIS_HOST" "$REDIS_PORT_V" 15 || die "连不上 Redis ${REDIS_HOST}:${REDIS_PORT_V}"
  wait_tcp "$S3_HOST" "$S3_PORT_V" 15 || warn "连不上 S3 ${S3_HOST}:${S3_PORT_V}（后端会报上传相关错误）"
fi

# ── ② 建表 + 种子（MODE=all / node 之外）──────────────────────────────
if [ "$MODE" = 'all' ] || [ "$MANAGE_INFRA" = '1' ]; then
  step '建表'
  info 'prisma migrate deploy'
  if run_in_backend_image 'cd /app/backend && /app/node_modules/.bin/prisma migrate deploy' >"$GEN_DIR/migrate.log" 2>&1; then
    ok '表结构已是最新'
  else
    tail -25 "$GEN_DIR/migrate.log"
    die "迁移失败（完整日志 $GEN_DIR/migrate.log）"
  fi

  step '种子账号'
  info '已存在则跳过、绝不改密码'
  if run_in_backend_image 'node /app/backend/dist/backend/prisma/seed.js' >"$GEN_DIR/seed.log" 2>&1; then
    grep -E '初始密码|已存在|已创建|已重置' "$GEN_DIR/seed.log" | sed 's/^ */     /' || true
    ok "完成（完整日志 $GEN_DIR/seed.log）"
  else
    tail -20 "$GEN_DIR/seed.log"
    die "种子失败（完整日志 $GEN_DIR/seed.log）"
  fi
fi

# ── ③ 后端 ────────────────────────────────────────────────────────────
step '后端'
BACKEND_ARGS=(
  run -d --name "$C_BACKEND" --restart unless-stopped
  --network host
  # 工作区：Code 模式 / 产物都要它，两种档位都挂
  -v "${WORKSPACE_ROOT}:${WORKSPACE_ROOT}"
  # 业务配置
  -e NODE_ENV=production -e LOG_PRETTY=false -e TZ="$TZ"
  -e DATABASE_URL="$DATABASE_URL" -e REDIS_URL="$REDIS_URL"
  -e S3_ENDPOINT="$S3_ENDPOINT" -e S3_KEY="$S3_KEY" -e S3_SECRET="$S3_SECRET" -e S3_BUCKET="$POSTGRES_DB"
  -e CREDENTIAL_MASTER_KEY="$CREDENTIAL_MASTER_KEY"
  -e SESSION_TTL_HOURS="${SESSION_TTL_HOURS:-12}"
  # ★ 会话 Cookie 的 Secure 位：**必须能透传**（未配 TLS 的 HTTP 直连内置默认 true ⇒ 浏览器
  #   丢弃 Cookie，症状是"登录成功却立刻未登录"）。留空 = 跟随 NODE_ENV（生产 true），
  #   与"不传"等价（后端 optionalBoolVar 把空串当未设置，见 backend/src/config.ts）。
  -e SESSION_COOKIE_SECURE="${SESSION_COOKIE_SECURE:-}"
  # ★ CORS 白名单：同源反代（前端 nginx /api → 网关）时可不设；设了可消掉生产的 WARN。
  -e CORS_ORIGINS="${CORS_ORIGINS:-}"
  -e CHATBOT_CONCURRENCY="${CHATBOT_CONCURRENCY:-50}" -e SANDBOX_CONCURRENCY="${SANDBOX_CONCURRENCY:-10}"
  -e SANDBOX_CALLBACK_PORT="${SANDBOX_CALLBACK_PORT:-13001}"
  # 实例身份（网关靠它发现本机）
  -e SANDBOX_INSTANCE_ID="$INSTANCE_ID"
  -e SANDBOX_INSTANCE_ADVERTISE_ADDR="$ADVERTISE_ADDR"
  -e BACKEND_PORT="$BACKEND_PORT" -e WORKSPACE_ROOT="$WORKSPACE_ROOT"
  -e DOUBULEA_SANDBOX_ROLE=backend -e DOUBULEA_NODE_ROLE="$NODE_ROLE"
  -e DOUBULEA_CONTAINER_NAME="$C_BACKEND"
  # 沙箱
  -e SANDBOX_IDLE_TTL_MIN="${SANDBOX_IDLE_TTL_MIN:-30}"
  -e SANDBOX_IMAGE="${SANDBOX_IMAGE:-doubulea/sandbox-toolkit:8}"
  -e SANDBOX_IMAGE_BASE="${SANDBOX_IMAGE_BASE:-doubulea/sandbox-base:6}"
  -e SANDBOX_EGRESS_PROXY_URL=http://doubulea-egress:3128
  -e SANDBOX_EGRESS_ALLOW_HOSTS='*'
  -e SANDBOX_LISTEN_HOST=0.0.0.0
  -e SANDBOX_BACKEND_URL=http://doubulea-sandbox-relay:13001
  -e SANDBOX_RUNTIME_BUILD_CONTEXT=/app/infra/sandbox/runtime
  -e SANDBOX_DOCKER_BIN=/opt/doubulea-docker-bin/docker
  -e DOCKER_HOST=unix:///var/run/docker.sock
  -e PATH=/opt/doubulea-docker-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  -e EGRESS_IMAGE=node:22-bookworm-slim -e RELAY_IMAGE=node:22-bookworm-slim -e DOCKER_CLI_IMAGE=docker:27-cli
  -e NODE_OPS_SECRET="${NODE_OPS_SECRET:-}"
  # 构建期换源（可选）：沙箱自举调 `sandbox-build.mjs` 时按这几个变量决定 npm / apt / node / rust 源。
  # ⚠️ 内网机器直连官方源通常不通（toolkit 会卡在 `npm install -g pi` 或 apt 上），
  #    而**空值**会让脚本回落到官方源 —— 所以这里原样透传空串，由容器侧自己决定。
  #    构建脚本按这几个变量决定源（漏一个就是"某台构建特别慢"）。
  -e SANDBOX_NPM_REGISTRY="${SANDBOX_NPM_REGISTRY:-}"
  -e SANDBOX_APT_MIRROR="${SANDBOX_APT_MIRROR:-}"
  -e SANDBOX_APT_MIN_BPS="${SANDBOX_APT_MIN_BPS:-}"
  -e SANDBOX_NODE_DIST_MIRROR="${SANDBOX_NODE_DIST_MIRROR:-}"
  -e SANDBOX_RUST_DIST_MIRROR="${SANDBOX_RUST_DIST_MIRROR:-}"
  --health-cmd "node -e \"fetch('http://127.0.0.1:${BACKEND_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
  --health-interval 15s --health-timeout 5s --health-retries 10 --health-start-period 40s
)
# 沙箱专属挂载与补组：**只有 taskAgent 档位需要**（chatbot 不建容器 ⇒ 不挂 socket / 侧车卷，
# 也就不需要 socket 的组）。见 `backend/src/sandbox/roleOverride.ts` 的档位判据。
if [ "$NODE_ROLE" = 'taskAgent' ]; then
  BACKEND_ARGS+=(
    # ★ 驱动宿主 daemon 起沙箱（DooD）
    -v /var/run/docker.sock:/var/run/docker.sock
    # ★ 内置脚本的中转卷 / egress 策略卷 / 按需构建用的 docker CLI
    -v doubulea-node-infra:/opt/node-infra
    -v doubulea-egress-policy:/opt/egress-policy
    -v doubulea-docker-bin:/opt/doubulea-docker-bin:ro
    -v doubulea-docker-buildx:/usr/local/libexec/docker/cli-plugins:ro
    # ★ socket 组：镜像内以 uid 10001 运行，宿主 socket 通常是 root:docker 660
    --group-add "$DOCKER_SOCKET_GID"
  )
fi
BACKEND_ARGS+=( "$IMG_BACKEND" )
up_if_needed "$C_BACKEND" "${BACKEND_ARGS[@]}"
wait_up "$C_BACKEND" 180
ok "后端 http://127.0.0.1:${BACKEND_PORT}/health"

# 沙箱宿主：侧车 + egress + relay
if [ "$NODE_ROLE" = 'taskAgent' ]; then
  step '沙箱依赖（侧车 / egress / relay）'
  for vol in doubulea-docker-bin doubulea-docker-buildx doubulea-node-infra doubulea-egress-policy; do
    docker volume create "$vol" >/dev/null
    # 卷默认 root:root 755，容器内是 uid 10001 ⇒ 放权（只装脚本/二进制，不敏感）
    docker run --rm --entrypoint sh -v "${vol}:/vol" "$IMG_BACKEND" -c 'chmod 0777 /vol' >/dev/null 2>&1 || true
  done

  # docker CLI 侧车：后端自检按**容器名**认得它
  if ! running "$C_DOCKER_CLI"; then
    drop "$C_DOCKER_CLI"
    docker run -d --name "$C_DOCKER_CLI" --restart unless-stopped --network none \
      -v doubulea-docker-bin:/opt/bin -v doubulea-docker-buildx:/opt/plugins \
      --entrypoint /bin/sh docker:27-cli -lc '
        mkdir -p /opt/bin /opt/plugins /usr/local/libexec/docker/cli-plugins
        cp /usr/local/bin/docker /opt/bin/docker && chmod 0755 /opt/bin/docker
        if [ -f /usr/local/libexec/docker/cli-plugins/docker-buildx ]; then
          cp /usr/local/libexec/docker/cli-plugins/docker-buildx /opt/plugins/docker-buildx && chmod 0755 /opt/plugins/docker-buildx
        fi
        exec sleep infinity' >/dev/null || die "侧车起不来（docker logs ${C_DOCKER_CLI}）"
    ok 'docker-cli 侧车已启动'
  else
    ok 'docker-cli 侧车已在运行'
  fi

  # egress：网是**后端**建的 ⇒ 必须等它出现（见 listener.ts）
  for i in $(seq 1 60); do
    [ "$(docker network inspect -f '{{.Name}}' doubulea-sandbox 2>/dev/null)" = 'doubulea-sandbox' ] && break
    sleep 2
  done
  [ "$(docker network inspect -f '{{.Name}}' doubulea-sandbox 2>/dev/null)" = 'doubulea-sandbox' ] \
    || die '找不到 doubulea-sandbox 网（后端没建出来？docker logs doubulea-backend）'

  if ! running "$C_EGRESS"; then
    drop "$C_EGRESS"
    docker run -d --name "$C_EGRESS" --restart unless-stopped \
      --network doubulea-sandbox \
      -v "$DOCKER_DIR/egress-proxy.mjs:/app/egress-proxy.mjs:ro" \
      -e EGRESS_PORT=3128 -e EGRESS_LISTEN_HOST=0.0.0.0 -e EGRESS_ALLOW='*' \
      --entrypoint node node:22-bookworm-slim /app/egress-proxy.mjs >/dev/null \
      || die "egress 起不来（docker logs ${C_EGRESS}）"
    # 两条腿：沙箱网 + 默认 bridge（代理自己还要出公网）
    docker network connect bridge "$C_EGRESS" >/dev/null 2>&1 || true
    ok 'egress 已启动（3128，已接沙箱网 + 出网）'
  else
    ok 'egress 已在运行'
    docker network connect doubulea-sandbox "$C_EGRESS" >/dev/null 2>&1 || true
  fi

  # relay：后端与 Docker 不同宿主时（macOS / Windows）需要；Linux 原生也拉起无害
  if ! running "$C_RELAY"; then
    drop "$C_RELAY"
    docker network connect bridge "$C_BACKEND" >/dev/null 2>&1 || true
    docker network connect doubulea-sandbox "$C_BACKEND" >/dev/null 2>&1 || true
    docker run -d --name "$C_RELAY" --restart unless-stopped \
      --network bridge --add-host host.docker.internal:host-gateway \
      -v "$DOCKER_DIR/sandbox-relay.mjs:/app/sandbox-relay.mjs:ro" \
      -e RELAY_TARGET="host.docker.internal:${SANDBOX_CALLBACK_PORT:-13001}" \
      --entrypoint node node:22-bookworm-slim /app/sandbox-relay.mjs >/dev/null \
      || die "relay 起不来（docker logs ${C_RELAY}）"
    docker network connect doubulea-sandbox "$C_RELAY" >/dev/null 2>&1 || true
    ok 'sandbox-relay 已启动（13001）'
  else
    ok 'sandbox-relay 已在运行'
    docker network connect doubulea-sandbox "$C_RELAY" >/dev/null 2>&1 || true
  fi
else
  step '沙箱'
  info "DOUBULEA_NODE_ROLE=$NODE_ROLE — 不跑沙箱，跳过侧车/egress/relay"
fi

# ── 网关 + 前端（MODE=all）──────────────────────────────────────────────
if [ "$MODE" = 'all' ]; then
  step '网关'
  up_if_needed "$C_GATEWAY" run -d --name "$C_GATEWAY" --restart unless-stopped \
    -e DOUBULEA_SANDBOX_ROLE=router -e NODE_ENV=production -e LOG_PRETTY=false -e TZ="$TZ" \
    -e ROUTER_HOST=0.0.0.0 -e ROUTER_PORT="$GATEWAY_PORT" \
    -e ROUTER_UPSTREAMS="$ADVERTISE_ADDR" \
    -e ROUTER_DISCOVERY_SEC=10 -e ROUTER_LOAD_AWARE=true \
    -e ROUTER_UPSTREAM_TIMEOUT_MS=30000 -e ROUTER_UPSTREAM_TIMEOUT_LONG_MS=900000 \
    -e SANDBOX_INSTANCE_HEARTBEAT_SEC=30 -e SANDBOX_OWNER_KEY_PREFIX=sandbox:owner \
    -e BACKEND_PORT="$BACKEND_PORT" -e REDIS_URL="$REDIS_URL" \
    -p "${GATEWAY_PORT}:${GATEWAY_PORT}" \
    --health-cmd "node -e \"fetch('http://127.0.0.1:${GATEWAY_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
    --health-interval 15s --health-timeout 5s --health-retries 10 --health-start-period 20s \
    --add-host host.docker.internal:host-gateway \
    --entrypoint node "$IMG_GATEWAY" /app/backend/dist/backend/src/router/main.js
  wait_up "$C_GATEWAY" 120
  ok "网关 http://127.0.0.1:${GATEWAY_PORT}/health"

  step '前端'
  up_if_needed "$C_FRONTEND" run -d --name "$C_FRONTEND" --restart unless-stopped \
    -e ROUTER_UPSTREAM="http://host.docker.internal:${GATEWAY_PORT}" \
    -e CLIENT_MAX_BODY_MB=100 \
    --add-host host.docker.internal:host-gateway \
    -p "${FRONTEND_PORT}:80" \
    --health-cmd 'wget -qO- http://127.0.0.1/ >/dev/null || exit 1' \
    --health-interval 15s --health-timeout 5s --health-retries 10 --health-start-period 5s \
    "$IMG_FRONTEND"
  wait_up "$C_FRONTEND" 90
fi

# ── 汇总 ──────────────────────────────────────────────────────────────
step '就绪'
if [ "$MODE" = 'all' ]; then
  printf '  浏览器      %shttp://%s:%s%s\n' "$C_OK" "$INSTANCE_IP" "$FRONTEND_PORT" "$C_X"
fi
printf '  后端健康    http://127.0.0.1:%s/health\n' "$BACKEND_PORT"
if [ "$MODE" = 'all' ]; then
  printf '  网关健康    http://127.0.0.1:%s/health\n' "$GATEWAY_PORT"
  printf '  控制台      http://%s:%s（MinIO）\n' "$INSTANCE_IP" "$MINIO_CONSOLE_PORT"
  printf '  账号        %s / %s（初始密码见 .generated/seed.log）\n' "${SEED_ADMIN_USERNAME:-admin}" "${SEED_MEMBER_USERNAME:-member}"
fi
printf '\n  下一步：新建一个 Code 会话发句话（首次会拉沙箱镜像，1-2 分钟）\n'
printf '  看日志：docker logs -f %s\n' "$C_BACKEND"
printf '  状态：  bash scripts/status.sh    停止：bash scripts/down.sh\n\n'
