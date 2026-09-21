#!/usr/bin/env bash
# =====================================================================
# dev-up.sh — 拉起开发依赖服务（postgres / redis / minio）
#
# 与 dev-up.ps1 **行为等价**，供 macOS / Linux 使用（本机为 macOS）。
# 步骤：
#   1. 校验 infra/.env 存在（缺失则从 .env.example 复制并提示填密钥）
#   2. docker compose build postgres（自建镜像，首次要源码编译 pg_bigm）
#   3. docker compose up -d
#   4. 轮询直到三服务 healthy
#   5. 跑 pg-verify.mjs（证明 vector + pg_bigm 真的可用）
#
# 用法：
#   bash infra/scripts/dev-up.sh
#   bash infra/scripts/dev-up.sh --no-build
#   bash infra/scripts/dev-up.sh --recreate
#   bash infra/scripts/dev-up.sh --timeout 300
# =====================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.yml"
ENV_FILE="$INFRA_DIR/.env"
ENV_SAMPLE="$INFRA_DIR/.env.example"

DO_BUILD=1
RECREATE=0
TIMEOUT_SEC=120

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --recreate) RECREATE=1 ;;
    --timeout)  shift; TIMEOUT_SEC="${1:-120}" ;;
    -h|--help)  sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'; C_D=$'\033[90m'; C_X=$'\033[0m'
step() { printf '\n%s=== %s ===%s\n' "$C_C" "$1" "$C_X"; }
ok()   { printf '  %s[OK]%s %s\n' "$C_G" "$C_X" "$1"; }
warn() { printf '  %s[!!]%s %s\n' "$C_Y" "$C_X" "$1"; }
fail() { printf '\n%s[FAIL]%s %s\n' "$C_R" "$C_X" "$1" >&2; exit 1; }

compose() {
  if [ -f "$ENV_FILE" ]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

# -- 0. 前置检查 ------------------------------------------------------
step 'Preflight'

docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
  || fail 'Docker engine 不可达。请先启动 Docker Desktop / OrbStack。'
ok 'Docker engine 可达'

if [ ! -f "$ENV_FILE" ]; then
  warn 'infra/.env 不存在，从 .env.example 复制'
  cp "$ENV_SAMPLE" "$ENV_FILE"
  warn '请在 infra/.env 填 CREDENTIAL_MASTER_KEY（生成：node -e "console.log(require(\x27crypto\x27).randomBytes(32).toString(\x27base64\x27))"）'
fi

if grep -qE '^[[:space:]]*CREDENTIAL_MASTER_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$ENV_FILE"; then
  ok "env 文件: ${ENV_FILE}（CREDENTIAL_MASTER_KEY 已设置）"
else
  warn "env 文件: ${ENV_FILE} —— CREDENTIAL_MASTER_KEY 为空（P0-1-3 配置校验会拒绝启动）"
fi

# -- 1. 构建自建 PG 镜像 ----------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  step '构建 postgres 镜像（pgvector + pg_bigm；首次会在镜像内编译 pg_bigm）'
  compose build postgres || fail 'docker compose build postgres 失败'
  ok '镜像构建完成'
else
  step '构建 postgres 镜像'
  warn '已跳过（--no-build）'
fi

# -- 2. 启动服务 ------------------------------------------------------
step '启动服务'
if [ "$RECREATE" -eq 1 ]; then
  compose up -d --force-recreate || fail 'docker compose up 失败'
else
  compose up -d || fail 'docker compose up 失败'
fi
ok '容器已启动'

# -- 3. 等健康 --------------------------------------------------------
step "等待健康（超时 ${TIMEOUT_SEC}s）"

HEALTH_FORMAT='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
deadline=$(( $(date +%s) + TIMEOUT_SEC ))
pending='postgres redis minio'

while [ -n "$pending" ] && [ "$(date +%s)" -lt "$deadline" ]; do
  rest=''
  for svc in $pending; do
    cid="$(compose ps -q "$svc" 2>/dev/null | head -1)"
    if [ -z "$cid" ]; then rest="$rest $svc"; continue; fi
    state="$(docker inspect --format "$HEALTH_FORMAT" "$cid" 2>/dev/null)"
    if [ "$state" = 'healthy' ] || [ "$state" = 'running' ]; then
      ok "$svc -> $state"
    else
      rest="$rest $svc"
    fi
  done
  pending="${rest# }"
  [ -n "$pending" ] && sleep 2
done

if [ -n "$pending" ]; then
  warn "超时未就绪：$pending"
  printf '  %s诊断: docker compose -f "%s" logs --tail=50 <service>%s\n' "$C_D" "$COMPOSE_FILE" "$C_X"
  exit 1
fi

# -- 4. 验收：扩展真的编进去了吗 --------------------------------------
step '验收 PG 扩展（vector + pg_bigm）'
node "$SCRIPT_DIR/pg-verify.mjs" --env-file "$ENV_FILE" \
  || fail 'PG 扩展验收未通过，见上方输出'

# -- 5. 汇总 ----------------------------------------------------------
step 'Ready'

env_value() {
  awk -F= -v k="$1" '$1==k {print $2; found=1} END{if(!found) print ""}' "$ENV_FILE" 2>/dev/null
}

pg_port="$(env_value POSTGRES_PORT)";      pg_port="${pg_port:-5432}"
redis_port="$(env_value REDIS_PORT)";      redis_port="${redis_port:-6379}"
minio_api="$(env_value MINIO_API_PORT)";   minio_api="${minio_api:-9000}"
minio_con="$(env_value MINIO_CONSOLE_PORT)"; minio_con="${minio_con:-9001}"
pg_user="$(env_value POSTGRES_USER)";      pg_user="${pg_user:-doubulea}"
pg_db="$(env_value POSTGRES_DB)";          pg_db="${pg_db:-doubulea}"

printf '  %sPostgreSQL    127.0.0.1:%s  (db=%s user=%s)%s\n' "$C_D" "$pg_port" "$pg_db" "$pg_user" "$C_X"
printf '  %sRedis         127.0.0.1:%s%s\n' "$C_D" "$redis_port" "$C_X"
printf '  %sMinIO API     127.0.0.1:%s%s\n' "$C_D" "$minio_api" "$C_X"
printf '  %sMinIO console http://127.0.0.1:%s%s\n' "$C_D" "$minio_con" "$C_X"
printf '\n  %s停止: bash infra/scripts/dev-down.sh%s\n' "$C_D" "$C_X"
