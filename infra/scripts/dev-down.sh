#!/usr/bin/env bash
# =====================================================================
# dev-down.sh — 停止开发依赖服务
#
# 与 dev-down.ps1 **行为等价**，供 macOS / Linux 使用。
#
# 用法：
#   bash infra/scripts/dev-down.sh
#   bash infra/scripts/dev-down.sh --purge
#   bash infra/scripts/dev-down.sh --purge --remove-images
#
# --purge 会删除 pgdata / redisdata / miniodata 三个数据卷，
#   数据库、队列与已上传文件将**不可恢复**，慎用。
# =====================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.yml"
ENV_FILE="$INFRA_DIR/.env"

PURGE=0
REMOVE_IMAGES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)         PURGE=1 ;;
    --remove-images) REMOVE_IMAGES=1 ;;
    -h|--help)       sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'; C_D=$'\033[90m'; C_X=$'\033[0m'

if [ ! -f "$ENV_FILE" ]; then
  printf '%s[!!]%s infra/.env 不存在，改用 compose 默认值\n' "$C_Y" "$C_X"
fi

compose() {
  if [ -f "$ENV_FILE" ]; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

if [ "$PURGE" -eq 1 ]; then
  printf '%s警告：将停止服务并删除全部数据卷%s\n' "$C_R" "$C_X"
  printf '%s      （PG 数据 / Redis AOF / MinIO 对象），不可恢复。%s\n' "$C_R" "$C_X"
  printf '%s      3 秒后执行，按 Ctrl+C 取消……%s\n' "$C_R" "$C_X"
  sleep 3
  compose down -v --remove-orphans || exit 1
  printf '  %s[OK]%s 服务已停止，数据卷已删除\n' "$C_G" "$C_X"
else
  compose down --remove-orphans || exit 1
  printf '  %s[OK]%s 服务已停止（数据卷保留）\n' "$C_G" "$C_X"
fi

if [ "$REMOVE_IMAGES" -eq 1 ]; then
  printf '%s[*] 删除项目镜像 ……%s\n' "$C_C" "$C_X"
  docker image rm 'doubulea/postgres:pg16-vector-bigm' 2>/dev/null
  printf '  %s[OK]%s 镜像已删除（dev-up 会重新构建）\n' "$C_G" "$C_X"
fi

printf '  %s重新启动: bash infra/scripts/dev-up.sh%s\n' "$C_D" "$C_X"
