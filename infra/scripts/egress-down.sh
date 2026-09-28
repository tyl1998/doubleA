#!/usr/bin/env bash
# =====================================================================
# egress-down.sh — 收掉 egress 代理容器
#
# 只删容器，**不动** `doubulea-sandbox` 网络（它属后端，由后端自己的对账器管）。
# 也**不**改 `infra/.env`：里面那行 `SANDBOX_EGRESS_PROXY_URL` 留着无害
# （它只是个地址；代理不在时派活会在建容器那一步连接失败），想清掉自己改。
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
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
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
