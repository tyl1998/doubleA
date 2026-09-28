#!/usr/bin/env bash
# =====================================================================
# dev-stop.sh — 收掉 dev-run.sh 起的后台进程
#
# 默认只停**应用层**（后端 + 前端），依赖服务（pg/redis/minio）留着。
#
# 用法：
#   bash infra/scripts/dev-stop.sh              # 停后端 + 前端
#   bash infra/scripts/dev-stop.sh --infra      # 连依赖服务一起停（保留数据卷）
#   bash infra/scripts/dev-stop.sh --purge      # 再删数据卷（⚠️ PG/Redis/MinIO 数据全丢）
#   bash infra/scripts/dev-stop.sh --force      # pid 文件丢了也按端口强收
#
# 收进程的顺序：pid 文件里的 pid 先 SIGINT（后端 SIGINT 是**优雅退出**：停接流 →
# 关 PG/Redis → flush 日志）→ 等 10s → 端口仍然被占就按端口 SIGTERM → 再 SIGKILL。
# 之所以要有"按端口兜底"这一步：pnpm 只是壳，tsx / vite 是它的子进程，
# 壳先退出时子进程可能还活着（端口还在监听）。
# =====================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
ENV_FILE="$INFRA_DIR/.env"
PID_DIR="$REPO_ROOT/.pids"

DO_INFRA=0
DO_PURGE=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --infra) DO_INFRA=1 ;;
    --purge) DO_INFRA=1; DO_PURGE=1 ;;
    --force) FORCE=1 ;;
    --) : ;;   # pnpm 透传时可能带孤立 --
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'; C_D=$'\033[90m'; C_X=$'\033[0m'
step() { printf '\n%s=== %s ===%s\n' "$C_C" "$1" "$C_X"; }
ok()   { printf '  %s[OK]%s %s\n' "$C_G" "$C_X" "$1"; }
warn() { printf '  %s[!!]%s %s\n' "$C_Y" "$C_X" "$1"; }
info() { printf '  %s[--]%s %s\n' "$C_D" "$C_X" "$1"; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_pids() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | tr '\n' ' '; }

stop_one() { # <名称> <pid文件> <端口>
  local name="$1" pidf="$2" port="$3" pid='' i=0 alive=0

  [ -f "$pidf" ] && pid="$(cat "$pidf" 2>/dev/null)"

  if [ -z "$pid" ]; then
    if port_busy "$port"; then
      warn "${name}：没有 pid 文件，但端口 $port 被占（$(port_pids "$port")）"
      if [ "$FORCE" -eq 1 ]; then
        info "--force：按端口强收"
      else
        warn "不敢动它（可能是别的项目 / 你手工起的）⇒ 跳过。确定要收加 --force"
        return 0
      fi
    else
      info "${name}：没在跑"
      return 0
    fi
  fi

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    info "${name}：SIGINT → pid $pid"
    kill -INT "$pid" 2>/dev/null
  fi

  while [ "$i" -lt 10 ]; do
    alive=0
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1
    if [ "$alive" -eq 0 ] && ! port_busy "$port"; then break; fi
    sleep 1; i=$((i + 1))
  done

  if port_busy "$port"; then
    warn "${name}：端口 $port 仍被占（$(port_pids "$port")）→ SIGTERM"
    kill -TERM $(port_pids "$port") 2>/dev/null
    sleep 2
  fi
  if port_busy "$port"; then
    warn "${name}：还在 → SIGKILL"
    kill -KILL $(port_pids "$port") 2>/dev/null
    sleep 1
  fi

  rm -f "$pidf"
  if port_busy "$port"; then
    warn "${name}：端口 $port 仍被占（不是我收得动的进程）"
    return 1
  fi
  ok "$name 已停止"
}

env_value() {
  [ -f "$ENV_FILE" ] || { echo ''; return; }
  awk -F= -v k="$1" '$1==k {print $2; found=1} END{if(!found) print ""}' "$ENV_FILE" 2>/dev/null
}

cd "$REPO_ROOT" || exit 1
BACKEND_PORT="$(env_value BACKEND_PORT)"; [ -n "$BACKEND_PORT" ] || BACKEND_PORT=13000
FRONTEND_PORT=5174

step '停止应用层'
stop_one '前端' "$PID_DIR/frontend.pid" "$FRONTEND_PORT"
stop_one '后端' "$PID_DIR/backend.pid"  "$BACKEND_PORT"

if [ "$DO_INFRA" -eq 1 ]; then
  step '停止依赖服务'
  if [ "$DO_PURGE" -eq 1 ]; then
    bash "$SCRIPT_DIR/dev-down.sh" --purge || exit 1
  else
    bash "$SCRIPT_DIR/dev-down.sh" || exit 1
  fi
  printf '\n'
else
  step '依赖服务'
  info '保留（postgres / redis / minio 继续跑）—— 要一起停加 --infra'
fi

printf '\n  %s重新启动%s  bash infra/scripts/dev-run.sh\n\n' "$C_D" "$C_X"
