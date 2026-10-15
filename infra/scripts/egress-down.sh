#!/usr/bin/env bash
# =====================================================================
# egress-down.sh — 收掉 egress 代理容器（及 --daemon 常驻的白名单同步）
#
# 只删容器 + 停同步循环，**不动** `doubulea-sandbox` 网络（它属后端，
# 由后端自己的对账器管）。也**不**改 `infra/.env`：里面那行
# `SANDBOX_EGRESS_PROXY_URL` 留着无害（它只是个地址；代理不在时派活会在
# 建容器那一步连接失败），想清掉自己改。
#
# 用法：
#   bash infra/scripts/egress-down.sh
#   bash infra/scripts/egress-down.sh --name doubulea-egress
# =====================================================================

set -uo pipefail

NAME=doubulea-egress

while [ $# -gt 0 ]; do
  case "$1" in
    --name)    shift; NAME="${1:-doubulea-egress}" ;;
    --)        : ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_D=$'\033[90m'; C_X=$'\033[0m'
ok()   { printf '  %s[OK]%s %s\n' "$C_G" "$C_X" "$1"; }
info() { printf '  %s[--]%s %s\n' "$C_D" "$C_X" "$1"; }
warn() { printf '  %s[!!]%s %s\n' "$C_Y" "$C_X" "$1"; }

DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
if [ -z "$DOCKER_BIN" ] && [ -x /usr/local/bin/docker ]; then
  DOCKER_BIN=/usr/local/bin/docker
fi
[ -n "$DOCKER_BIN" ] || { printf '%s找不到 docker%s\n' "$C_R" "$C_X" >&2; exit 1; }

# ★ 先收 --daemon 常驻的白名单同步（pid 文件与 egress-up.sh 同一份）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
WATCH_PID_FILE="$REPO_ROOT/.pids/egress-watch.pid"
if [ -f "$WATCH_PID_FILE" ]; then
  WATCH_PID="$(cat "$WATCH_PID_FILE" 2>/dev/null || true)"
  if [ -n "$WATCH_PID" ] && kill -0 "$WATCH_PID" 2>/dev/null; then
    # ⚠️ `$WATCH_PID` 后面紧跟全角字符时必须写成 `${WATCH_PID}`：bash 3.2（macOS `/bin/bash`）
    #    会把多字节字符的第一个字节当成变量名的一部分 ⇒ `WATCH_PID?: unbound variable`。
    kill "$WATCH_PID" 2>/dev/null && ok "已停白名单同步（pid ${WATCH_PID}）" || warn "停同步失败（pid ${WATCH_PID}）"
  else
    info "同步进程本来就不在（幂等）"
  fi
  rm -f "$WATCH_PID_FILE"
fi

if ! "$DOCKER_BIN" container inspect "$NAME" >/dev/null 2>&1; then
  info "容器 ${NAME} 本来就不在（幂等，无操作）"
  exit 0
fi

"$DOCKER_BIN" rm -f "$NAME" >/dev/null 2>&1 && ok "已收掉 ${NAME}" || warn "删 ${NAME} 失败"

if "$DOCKER_BIN" ps -a --filter "name=^${NAME}$" --format '{{.Names}}' | grep -q .; then
  warn "容器还在：$DOCKER_BIN ps -a --filter name=${NAME}"
else
  ok "确认已消失"
fi

info "沙箱网络未被改动（它属后端）；infra/.env 里的 SANDBOX_EGRESS_PROXY_URL 也保留"
