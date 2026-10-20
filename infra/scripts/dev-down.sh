#!/usr/bin/env bash
# =====================================================================
# dev-down.sh — 停止开发依赖服务
#
# 与 dev-down.ps1 **行为等价**，供 macOS / Linux 使用。
#
# 用法：
#   bash infra/scripts/dev-down.sh
#   bash infra/scripts/dev-down.sh --remove-images
#
# ⚠️ 本脚本**永不删除数据卷**（pgdata / redisdata / miniodata）。
#    数据库、队列、已上传文件都在里面，误删不可恢复 —— 一条 `dev-down` 不该有这种破坏力
#    （2026-10-20 用户要求）。
#    真要清空数据，**手动**执行下面这条，看清楚再回车：
#      docker compose -f infra/docker-compose.yml --env-file infra/.env down -v
#    或者 `docker volume rm doubulea_pgdata doubulea_redisdata doubulea_miniodata`。
# =====================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$INFRA_DIR/docker-compose.yml"
ENV_FILE="$INFRA_DIR/.env"

REMOVE_IMAGES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)
      # 兼容旧参数：现在**只提示不动手**。以前 `--purge` 会 `compose down -v`，
      # 对"手滑多打一个参数"的人来说代价太大（数据全丢），已改为显式拒绝。
      printf '\033[31m--purge 已废弃：本脚本不再删除数据卷\033[0m\n' >&2
      printf '  要清空数据请手动执行（不可恢复，确认后再跑）：\n' >&2
      printf '    docker compose -f infra/docker-compose.yml --env-file infra/.env down -v\n' >&2
      exit 2
      ;;
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

# ⚠️ 这里**刻意不带 `-v`**：只停容器、保留数据卷。
#    容器删了数据还在卷里，下次 `dev-up` 起来就是原来的库；反之 `-v` 一旦执行就回不去了。
compose down --remove-orphans || exit 1
printf '  %s[OK]%s 服务已停止（数据卷保留）\n' "$C_G" "$C_X"

if [ "$REMOVE_IMAGES" -eq 1 ]; then
  printf '  %s[--]%s 删除本项目构建的镜像（不动数据卷）\n' "$C_D" "$C_X"
  docker image rm -f doubulea/postgres:pg16-vector-bigm >/dev/null 2>&1 || true
fi

if [ "$REMOVE_IMAGES" -eq 1 ]; then
  printf '%s[*] 删除项目镜像 ……%s\n' "$C_C" "$C_X"
  docker image rm 'doubulea/postgres:pg16-vector-bigm' 2>/dev/null
  printf '  %s[OK]%s 镜像已删除（dev-up 会重新构建）\n' "$C_G" "$C_X"
fi

printf '  %s重新启动: bash infra/scripts/dev-up.sh%s\n' "$C_D" "$C_X"
