#!/usr/bin/env bash
# =====================================================================
# _lib.sh —— deploy/ 下所有脚本共用（被 source，不单独执行）
#
# 设计前提：**不使用 docker compose**。全部是 `docker run` / `docker stop`，
# 这样公司的单机流水线（Jenkins / GitLab CI / 任意 shell 步骤）可以直接调用。
#
# 只做三件事：读 deploy.env → 校验 → 算好所有派生值
# =====================================================================

set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN_DIR="$DEPLOY_DIR/.generated"
# ⚠️ 必须在**每次** prepare 时重新解析：`up.sh --env/--shared` 会在运行期把
#    合成出来的临时文件写进 DEPLOY_ENV_FILE，这里若在 source 时就定死，就永远读原路径。
resolve_env_file() { ENV_FILE="${DEPLOY_ENV_FILE:-$DEPLOY_DIR/deploy.env}"; }
resolve_env_file
ENV_SAMPLE="$DEPLOY_DIR/env/deploy.env.example"
DOCKER_DIR="$DEPLOY_DIR/docker"

# 容器名（脚本靠名字幂等）
#
# ⚠️ 分两类，**不能一概加后缀**：
#   · **可多实例**（backend / gateway / frontend）：同一台机器要跑第二个实例时，名字必须带
#     `INSTANCE_ID`，否则第二个实例会覆盖第一个（`--name` 冲突 ⇒ 先删后起）。
#   · **不可改名**（egress / relay / docker-cli）：后端自检按**固定容器名**认它们
#     （`backend/src/sandbox/nodeBootstrap.ts` 的 `EGRESS_NAME` / `RELAY_NAME` / `DOCKER_HOST_NAME`），
#     改了名就一律报"未运行" ⇒ 实例永远未就绪。同理 `SANDBOX_EGRESS_PROXY_URL` 里的
#     `http://doubulea-egress:3128` 也是按名字解析的。
#   ⚠️ 因此**同一台宿主推荐只跑一个实例**；多实例是给"临时验证 / 共存灰度"用的，
#      此时 egress/relay/侧车由先起的那个实例负责（后起的会复用它们）。
BASE_NAME=doubulea
unset C_PG C_REDIS C_MINIO C_BACKEND C_DOCKER_CLI C_EGRESS C_RELAY C_GATEWAY C_FRONTEND
# 在 prepare() 里按 INSTANCE_ID 赋值（见下方 assign_container_names）

assign_container_names() {
  # 实例后缀：默认实例（local / a / 空）沿用老名字，保证**已有部署升级后名字不变**
  local suffix=''
  case "$INSTANCE_ID" in
    ''|local|a) suffix='' ;;
    *) suffix="-$INSTANCE_ID" ;;
  esac
  C_PG="doubulea-postgres"
  C_REDIS="doubulea-redis"
  C_MINIO="doubulea-minio"
  # ★ 可多实例
  C_BACKEND="doubulea-backend$suffix"
  C_GATEWAY="doubulea-gateway$suffix"
  C_FRONTEND="doubulea-frontend$suffix"
  # ★ 固定名（后端自检认得；不要加后缀）
  C_DOCKER_CLI="doubulea-docker-cli"
  C_EGRESS="doubulea-egress"
  C_RELAY="doubulea-sandbox-relay"
}

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[90m'; C_X=$'\033[0m'

step() { printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
ok()   { printf '  %s[OK]%s %s\n' "$C_OK" "$C_X" "$1"; }
info() { printf '  %s[--]%s %s\n' "$C_DIM" "$C_X" "$1"; }
warn() { printf '  %s[!!]%s %s\n' "$C_WARN" "$C_X" "$1"; }
die()  { printf '\n  %s[FAIL]%s %s\n\n' "$C_ERR" "$C_X" "$1" >&2; exit 1; }

# ── 读 env ────────────────────────────────────────────────────────────
env_get() {
  local key="$1" fallback="${2:-}"
  [ -f "$ENV_FILE" ] || { printf '%s' "$fallback"; return; }
  local value
  value="$(awk -v k="$key" '
    /^[[:space:]]*#/ { next }
    index($0, k "=") == 1 { v = substr($0, length(k) + 2); gsub(/^["'"'"']|["'"'"']$/, "", v); print v; exit }
  ' "$ENV_FILE")"
  printf '%s' "${value:-$fallback}"
}

load_env() {
  [ -f "$ENV_FILE" ] || die "缺 $ENV_FILE
       cp deploy/env/deploy.env.example deploy/deploy.env
     必填：CREDENTIAL_MASTER_KEY / POSTGRES_PASSWORD / S3_SECRET / INSTANCE_IP"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || die "找不到 $1${2:+（$2）}"; }

# ── 校验 ──────────────────────────────────────────────────────────────
validate_env() {
  local problems=()
  case "${CREDENTIAL_MASTER_KEY:-}" in ''|CHANGE_ME*) problems+=('CREDENTIAL_MASTER_KEY（openssl rand -base64 32）') ;; esac
  if [ -n "${CREDENTIAL_MASTER_KEY:-}" ] && [ "${#CREDENTIAL_MASTER_KEY}" -lt 44 ]; then
    problems+=('CREDENTIAL_MASTER_KEY 长度不足（应为 44 字符 base64）')
  fi
  case "${POSTGRES_PASSWORD:-}" in ''|CHANGE_ME*) problems+=('POSTGRES_PASSWORD（数据库密码）') ;; esac
  case "${S3_SECRET:-}" in ''|CHANGE_ME*) problems+=('S3_SECRET（对象存储密钥，≥8 位）') ;; esac
  case "${MODE:-}" in all|node) ;; *) problems+=("MODE 只能是 all 或 node，当前='${MODE:-}'") ;; esac
  if [ "${#problems[@]}" -gt 0 ]; then
    printf '\n  配置不完整：%s\n' "$ENV_FILE"
    local p; for p in "${problems[@]}"; do printf '    · %s\n' "$p"; done
    printf '\n  生成密钥：openssl rand -base64 32\n\n'
    exit 1
  fi
  case "${INSTANCE_IP:-}" in
    ''|127.0.0.1|localhost) warn "INSTANCE_IP=$INSTANCE_IP 只能本机访问；多机部署要填内网 IP" ;;
  esac
  ok "配置校验通过：MODE=$MODE  INSTANCE_ID=${INSTANCE_ID:-local}"
}

# ── 平台与宿主事实 ────────────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Darwin) printf 'macos' ;;
    Linux)  printf 'linux' ;;
    *)      printf 'unsupported' ;;
  esac
}

# 宿主 docker.sock 的 gid。
#
# ⚠️ **必须按"容器内看到的属主"取**，不能只看宿主 stat（2026-10-20 实测）：
#   OrbStack 上宿主是 `srw-rw---- atan:staff`（gid=1，= macOS 的 daemon 组），
#   但挂进 Linux 容器后是 `srw-rw---- root:root`（gid=0）。
#   照宿主取值 ⇒ `--group-add 1` 加了个容器里无关的组 ⇒ 后端访问 socket 报
#   `permission denied`，实例自检 docker 项红，沙箱完全起不来。
#   ⇒ 直接让一个临时容器 stat 那个 socket，拿容器视角的 gid。
detect_socket_gid() {
  [ -S /var/run/docker.sock ] || { printf ''; return; }
  local gid=''
  # 容器视角（首选）：任取本地镜像跑一次 stat
  local img
  img="$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '<none>' | head -1)"
  if [ -n "$img" ]; then
    gid="$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock --entrypoint stat \
      "$img" -c '%g' /var/run/docker.sock 2>/dev/null | tr -d '[:space:]')"
  fi
  # 兜底：宿主 stat
  if [ -z "$gid" ]; then
    if [ "$(detect_platform)" = 'macos' ]; then gid="$(stat -f '%g' /var/run/docker.sock 2>/dev/null)"
    else gid="$(stat -c '%g' /var/run/docker.sock 2>/dev/null)"; fi
  fi
  printf '%s' "$gid"
}

# ── 派生值 ────────────────────────────────────────────────────────────
prepare() {
  resolve_env_file
  load_env
  validate_env
  PLATFORM="$(detect_platform)"
  [ "$PLATFORM" = 'unsupported' ] && die '只支持 Linux / macOS（Windows 用 scripts\\up.ps1）'

  MODE="${MODE:-all}"
  INSTANCE_ID="${INSTANCE_ID:-local}"
  assign_container_names
  BACKEND_PORT="${BACKEND_PORT:-13000}"
  GATEWAY_PORT="${GATEWAY_PORT:-13100}"
  FRONTEND_PORT="${FRONTEND_PORT:-8080}"
  POSTGRES_PORT="${POSTGRES_PORT:-15432}"
  REDIS_PORT="${REDIS_PORT:-16379}"
  MINIO_API_PORT="${MINIO_API_PORT:-19000}"
  MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-19001}"
  POSTGRES_USER="${POSTGRES_USER:-doubulea}"
  POSTGRES_DB="${POSTGRES_DB:-doubulea}"
  S3_KEY="${S3_KEY:-doubulea}"
  TZ="${TZ:-Asia/Shanghai}"
  IMAGE_TAG="${IMAGE_TAG:-2}"
  IMAGE_SOURCE="${IMAGE_SOURCE:-local}"
  IMAGE_PREFIX=''
  if [ "$IMAGE_SOURCE" = 'registry' ] && [ -n "${IMAGE_REGISTRY:-}" ]; then IMAGE_PREFIX="${IMAGE_REGISTRY%/}/"; fi
  # ★ 镜像全名可**逐个覆盖**（2026-10-20，与旧 `node-up.sh` 的 BACKEND_IMAGE 语义一致）：
  #   仓库地址不规整时（如 `harbor.corp/a/b/backend:2`、或后端与网关不在同一前缀下，写成
  #   `BACKEND_IMAGE=...` 即可，不必再拼 IMAGE_REGISTRY + IMAGE_TAG。未设置时仍按前缀 + tag 拼。
  #   ⚠️ 这些必须**同时**用于"检查有没有这个镜像"和"run 用哪个镜像"—— 两处不一致就是
  #      "拉取成功了但启动的还是旧的"。
  IMG_BACKEND="${BACKEND_IMAGE:-${IMAGE_PREFIX}doubulea-backend:${IMAGE_TAG}}"
  IMG_GATEWAY="${GATEWAY_IMAGE:-${IMAGE_PREFIX}doubulea-gateway:${IMAGE_TAG}}"
  IMG_FRONTEND="${FRONTEND_IMAGE:-${IMAGE_PREFIX}doubulea-frontend:${IMAGE_TAG}}"
  IMG_POSTGRES="${POSTGRES_IMAGE:-${IMAGE_PREFIX}doubulea/postgres:pg16-vector-bigm}"

  # ★ MANAGE_INFRA 决定**会不会碰** PG / Redis / MinIO（2026-10-20 教训）：
  #   · 0（默认）= 本部署包**不动基础服务**，只假设它们已经在跑，用 REMOTE_* 或本机端口连
  #      —— 别人的机器上这些服务可能由运维/另一个 compose 管着，本包去 `stop`/`rm` 就是事故。
  #   · 1 = 本包负责创建它们（只在**专用机器**上用；卷名带 doubulea-deploy- 前缀，绝不与现有重名）
  MANAGE_INFRA="${MANAGE_INFRA:-0}"
  case "$MANAGE_INFRA" in 0|1) ;; *) die "MANAGE_INFRA 只能是 0 或 1，当前=$MANAGE_INFRA" ;; esac

  # 依赖服务地址：显式 REMOTE_* 优先；否则用本机端口
  PG_HOST="${REMOTE_PG_HOST:-127.0.0.1}"; PG_PORT="${REMOTE_PG_PORT:-$POSTGRES_PORT}"
  REDIS_HOST="${REMOTE_REDIS_HOST:-127.0.0.1}"; REDIS_PORT_V="${REMOTE_REDIS_PORT:-$REDIS_PORT}"
  S3_HOST="${REMOTE_S3_HOST:-127.0.0.1}"; S3_PORT_V="${REMOTE_S3_PORT:-$MINIO_API_PORT}"
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PG_HOST}:${PG_PORT}/${POSTGRES_DB}?schema=public"
  REDIS_URL="redis://${REDIS_HOST}:${REDIS_PORT_V}"
  S3_ENDPOINT="http://${S3_HOST}:${S3_PORT_V}"

  # 工作区：宿主绝对路径，容器内用**同一路径**（bind mount 源由宿主 daemon 解析）
  WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HOME/doubulea/workspaces}"
  mkdir -p "$WORKSPACE_ROOT" 2>/dev/null || true
  [ -d "$WORKSPACE_ROOT" ] || die "工作区目录建不出来：$WORKSPACE_ROOT"
  chmod 0777 "$WORKSPACE_ROOT" 2>/dev/null || true

  # ★ 网关/前端与后端**不同容器**：它们看不到彼此的 127.0.0.1。
  #   后端用的是 host 网络（硬约束），所以 bridge 容器要经 host.docker.internal 访问它。
  #   MODE=all 时用这个；MODE=node 时后端在别的机器上，用 REMOTE_*（或 INSTANCE_IP）。
  HOST_GATEWAY="${HOST_GATEWAY:-host.docker.internal}"
  if [ "$MODE" = 'all' ]; then
    ADVERTISE_HOST="${ADVERTISE_HOST:-$HOST_GATEWAY}"
  else
    ADVERTISE_HOST="${ADVERTISE_HOST:-$INSTANCE_IP}"
  fi
  ADVERTISE_ADDR="${ADVERTISE_HOST}:${BACKEND_PORT}"

  NODE_ROLE="${DOUBULEA_NODE_ROLE:-taskAgent}"
  DOCKER_SOCKET_GID="${DOCKER_SOCKET_GID:-$(detect_socket_gid)}"
  if [ "$NODE_ROLE" = 'taskAgent' ] && [ -z "$DOCKER_SOCKET_GID" ]; then
    die '读不到 docker.sock 的 gid（Docker 起了吗？）可在 deploy.env 里手动设 DOCKER_SOCKET_GID'
  fi
  mkdir -p "$GEN_DIR"

  INFRA_MODE_NOTE="复用现有（MANAGE_INFRA=0）"
  [ "$MANAGE_INFRA" = '1' ] && INFRA_MODE_NOTE='本包管理（MANAGE_INFRA=1）'
  info "平台 $PLATFORM   工作区 $WORKSPACE_ROOT   socket gid ${DOCKER_SOCKET_GID:-不需要}"
  info "基础服务：$INFRA_MODE_NOTE"
  info "依赖 PG ${PG_HOST}:${PG_PORT}  Redis ${REDIS_HOST}:${REDIS_PORT_V}  S3 ${S3_HOST}:${S3_PORT_V}"
}

# ── docker 小工具 ─────────────────────────────────────────────────────
running()   { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = 'true' ]; }
exists()    { docker inspect "$1" >/dev/null 2>&1; }

# 删掉同名容器（存在但没在跑 / 或需要重建时用）
drop() { exists "$1" && docker rm -f "$1" >/dev/null 2>&1; return 0; }

# 等到 healthy（或 running）。$2 = 超时秒数
wait_up() {
  local name="$1" timeout="${2:-180}" i=0 state
  while [ "$i" -lt "$timeout" ]; do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$state" in
      healthy) ok "$name 就绪"; return 0 ;;
      unhealthy) die "$name 不健康：docker logs --tail 50 $name" ;;
      running)
        # 无 healthcheck 的容器：running 即算就绪
        if [ "$(docker inspect -f '{{if .State.Health}}yes{{else}}no{{end}}' "$name" 2>/dev/null)" = 'no' ]; then
          ok "$name 运行中"; return 0
        fi ;;
    esac
    i=$((i + 2)); sleep 2
  done
  die "$name 在 ${timeout}s 内没就绪：docker logs --tail 50 $name"
}

# 等到某个端口能连（不依赖容器健康检查）
wait_tcp() {
  local host="$1" port="$2" timeout="${3:-180}" i=0
  while [ "$i" -lt "$timeout" ]; do
    (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null && { ok "${host}:${port} 可连接"; return 0; }
    i=$((i + 2)); sleep 2
  done
  die "等不到 ${host}:${port}"
}

# ── 镜像来源 ──────────────────────────────────────────────────────────
ensure_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 && { ok "$image"; return; }
  case "$IMAGE_SOURCE" in
    registry)
      info "拉取 $image"
      docker pull "$image" >/dev/null || die "拉不到 $image
       ① 检查 IMAGE_REGISTRY（deploy.env） ② 是否已 docker login
       ③ 内网不通就改 IMAGE_SOURCE=local，先 docker load -i <tar>"
      ok "$image 已拉取" ;;
    local)
      die "本地没有 $image —— 先 docker load -i <镜像>.tar，或把 IMAGE_SOURCE 改成 registry" ;;
    build)
      build_image "$image" ;;
    *)
      die "IMAGE_SOURCE 只能是 registry / local / build，当前=$IMAGE_SOURCE" ;;
  esac
}

build_image() {
  local image="$1" src script
  src="$(cd "$DEPLOY_DIR/$([[ "${SRC_DIR:-..}" = /* ]] && echo "${SRC_DIR}" || echo "${SRC_DIR:-..}")" 2>/dev/null && pwd)" \
    || die "SRC_DIR 不存在：${SRC_DIR:-..}"
  case "$image" in
    *doubulea/postgres*) script='' ;;
    *doubulea-backend*)  script='backend:build-image' ;;
    *doubulea-gateway*)  script='gateway:build' ;;
    *doubulea-frontend*) script='frontend:build-image' ;;
    *) die "不知道如何构建 $image" ;;
  esac
  if [ -z "$script" ]; then
    info "构建 ${image}（首次编译 pg_bigm / pgvector，约 5-10 分钟）"
    docker build -t "$image" "$src/infra/postgres" || die "构建 $image 失败"
    return
  fi
  [ -f "$src/pnpm-workspace.yaml" ] || die "SRC_DIR=$src 不是源码根（缺 pnpm-workspace.yaml）"
  command -v pnpm >/dev/null 2>&1 || die 'IMAGE_SOURCE=build 需要 Node 22 + pnpm'
  info "从源码构建 $image"
  ( cd "$src" && pnpm "$script" ) || die "构建失败：$image"
}

# 在**后端镜像里**跑一条命令（建表 / 种子用）。
# ⚠️ `--network host`：依赖服务在宿主端口上，bridge 里容器自己的 127.0.0.1 是它自己。
run_in_backend_image() {
  docker run --rm --network host \
    -e DATABASE_URL="$DATABASE_URL" -e REDIS_URL="$REDIS_URL" \
    -e S3_ENDPOINT="$S3_ENDPOINT" -e S3_KEY="$S3_KEY" -e S3_SECRET="$S3_SECRET" -e S3_BUCKET="$POSTGRES_DB" \
    -e CREDENTIAL_MASTER_KEY="$CREDENTIAL_MASTER_KEY" \
    -e SEED_ADMIN_USERNAME="${SEED_ADMIN_USERNAME:-admin}" -e SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-}" \
    -e SEED_MEMBER_USERNAME="${SEED_MEMBER_USERNAME:-member}" -e SEED_MEMBER_PASSWORD="${SEED_MEMBER_PASSWORD:-}" \
    -e TZ="$TZ" \
    --entrypoint sh "$IMG_BACKEND" -lc "$1"
}

# ── 两份 env ⇒ 一份 deploy.env（兼容已删除的 `node-up.sh` 的输入方式）──────
# 规则与旧 node-up.sh 一致：**共享值打底，本机值覆盖**。
# 为什么要在这里做：node-up.sh 与 deploy/ 曾经各写一份 docker run，已经漂移过
# （socket gid 只在 deploy 侧修了）。把"读两份 env"这件事收进部署包，旧入口就能删掉。
_from_file() {   # $1=file $2=key
  local f="$1" k="$2"
  [ -f "$f" ] || return 0
  awk -v k="$k" '
    /^[[:space:]]*#/ { next }
    index($0, k "=") == 1 { v = substr($0, length(k) + 2); gsub(/^["'"'"']|["'"'"']$/, "", v); print v; exit }
  ' "$f"
}
_two() {         # 本机优先，其次共享，最后默认值
  local key="$1" def="${2:-}" v
  v="$(_from_file "$NODE_ENV_FILE" "$key")"
  [ -n "$v" ] || v="$(_from_file "$SHARED_ENV_FILE_ARG" "$key")"
  printf '%s' "${v:-$def}"
}
# 拆 URL：scheme://user:pass@host:port/db（node 解析，避免在这写脆弱的正则）
_url_part() { node -e '
  try { const u = new URL(process.argv[1]); const w = process.argv[2]
    const o = { host: u.hostname, port: u.port, user: decodeURIComponent(u.username),
                pass: decodeURIComponent(u.password), db: u.pathname.replace(/^\//, "") }
    console.log(o[w] ?? "")
  } catch { console.log("") }' "$1" "$2"; }

synth_from_two_envs() {
  local own="$1" shared="$2"
  NODE_ENV_FILE="$own"; SHARED_ENV_FILE_ARG="$shared"

  local INSTANCE_ID ADVERTISE DB_URL RD_URL S3_EP
  INSTANCE_ID="$(_two SANDBOX_INSTANCE_ID)"
  ADVERTISE="$(_two SANDBOX_INSTANCE_ADVERTISE_ADDR)"
  [ -n "$INSTANCE_ID" ] || die 'SANDBOX_INSTANCE_ID 未设置（每台唯一：a / b / c）'
  [ -n "$ADVERTISE" ]   || die 'SANDBOX_INSTANCE_ADVERTISE_ADDR 未设置（如 10.73.100.195:13000）'

  DB_URL="$(_two DATABASE_URL)"; RD_URL="$(_two REDIS_URL)"; S3_EP="$(_two S3_ENDPOINT)"
  local pg_host pg_port pg_user pg_pass pg_db rd_host rd_port s3_host s3_port
  pg_host="$(_url_part "$DB_URL" host)"; pg_port="$(_url_part "$DB_URL" port)"
  pg_user="$(_url_part "$DB_URL" user)"; pg_pass="$(_url_part "$DB_URL" pass)"
  pg_db="$(_url_part "$DB_URL" db)"
  rd_host="$(_url_part "$RD_URL" host)"; rd_port="$(_url_part "$RD_URL" port)"
  s3_host="$(_url_part "$S3_EP" host)"; s3_port="$(_url_part "$S3_EP" port)"

  cat <<EOF
# 由 deploy/scripts/up.sh --env/--shared 合成（共享值打底、本机值覆盖）—— 临时文件，用完即删
MODE=node
MANAGE_INFRA=0
IMAGE_SOURCE=local
BACKEND_IMAGE=$(_two BACKEND_IMAGE doubulea-backend:2)
IMAGE_TAG=${IMAGE_TAG:-2}
INSTANCE_ID=$INSTANCE_ID
INSTANCE_IP=${ADVERTISE%%:*}
BACKEND_PORT=${ADVERTISE##*:}
GATEWAY_PORT=${GATEWAY_PORT:-13100}
FRONTEND_PORT=${FRONTEND_PORT:-8080}
CREDENTIAL_MASTER_KEY=$(_two CREDENTIAL_MASTER_KEY)
POSTGRES_PASSWORD=$pg_pass
POSTGRES_USER=${pg_user:-doubulea}
POSTGRES_DB=${pg_db:-doubulea}
S3_SECRET=$(_two S3_SECRET)
S3_KEY=$(_two S3_KEY doubulea)
REMOTE_PG_HOST=$pg_host
REMOTE_PG_PORT=${pg_port:-5432}
REMOTE_REDIS_HOST=$rd_host
REMOTE_REDIS_PORT=${rd_port:-6379}
REMOTE_S3_HOST=$s3_host
REMOTE_S3_PORT=${s3_port:-9000}
WORKSPACE_ROOT=$(_two WORKSPACE_ROOT "$HOME/doubulea/workspaces")
DOCKER_SOCKET_GID=$(_two DOCKER_SOCKET_GID)
DOUBULEA_NODE_ROLE=$(_two DOUBULEA_NODE_ROLE taskAgent)
SANDBOX_IMAGE=$(_two SANDBOX_IMAGE doubulea/sandbox-toolkit:8)
SANDBOX_IMAGE_BASE=$(_two SANDBOX_IMAGE_BASE doubulea/sandbox-base:6)
SANDBOX_CONCURRENCY=$(_two SANDBOX_CONCURRENCY 10)
SANDBOX_IDLE_TTL_MIN=$(_two SANDBOX_IDLE_TTL_MIN 30)
SESSION_TTL_HOURS=$(_two SESSION_TTL_HOURS 12)
SESSION_COOKIE_SECURE=$(_two SESSION_COOKIE_SECURE)
CORS_ORIGINS=$(_two CORS_ORIGINS)
CHATBOT_CONCURRENCY=$(_two CHATBOT_CONCURRENCY 50)
SANDBOX_CALLBACK_PORT=$(_two SANDBOX_CALLBACK_PORT 13001)
NODE_OPS_SECRET=$(_two NODE_OPS_SECRET)
SANDBOX_NPM_REGISTRY=$(_two SANDBOX_NPM_REGISTRY)
SANDBOX_APT_MIRROR=$(_two SANDBOX_APT_MIRROR)
SANDBOX_APT_MIN_BPS=$(_two SANDBOX_APT_MIN_BPS)
SANDBOX_NODE_DIST_MIRROR=$(_two SANDBOX_NODE_DIST_MIRROR)
SANDBOX_RUST_DIST_MIRROR=$(_two SANDBOX_RUST_DIST_MIRROR)
TZ=$(_two TZ Asia/Shanghai)
EOF
}
