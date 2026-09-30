#!/usr/bin/env bash
# =====================================================================
# relay-up.sh — 起一个「两条腿」的沙箱中转容器（出口②：容器 → 后端）
#
# 【什么时候需要】只在「后端与 Docker 不同宿主」时 —— macOS（OrbStack）/
#   Windows（Docker Desktop）上 Docker 跑在 Linux VM 里，bridge 网关是那台
#   VM，容器到不了跑后端的宿主（P0-3-3 实测 `ENETUNREACH`）。
#   生产（后端与 Docker 同宿主）**不需要**它：`manager.ts` 会把
#   `SANDBOX_BACKEND_URL` 兜底成 `http://<沙箱网网关>:13001`。
#
# 【两条腿】沙箱容器挂在 `doubulea-sandbox`（`Internal: true`）上：
#   · 默认 bridge          → 够得着 host.docker.internal（后端那条腿）
#   · doubulea-sandbox     → 沙箱容器够得着本中转（沙箱那条腿）
#   只有一条腿的中转，在 internal 网络上等于没有。
#
# 【前置】`doubulea-sandbox` 这张网由**后端启动时**的 listener 建出来
#   （`backend/src/sandbox/listener.ts`）⇒ 顺序是「先起后端、再起中转」。
#   网不在时会直接告诉你。
#
# 用法：
#   bash infra/scripts/relay-up.sh                    # 默认 host.docker.internal:13001
#   bash infra/scripts/relay-up.sh --write-env        # 顺便把两个 env 写进 infra/.env
#   bash infra/scripts/relay-up.sh --target 10.0.0.5:13001   # 后端在别的机器
#   bash infra/scripts/relay-up.sh --port 13001 --name doubulea-sandbox-relay
#
# 停止：bash infra/scripts/relay-down.sh
# Windows：infra/scripts/relay-up.ps1（同一套逻辑）
# =====================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
ENV_FILE="$INFRA_DIR/.env"
RELAY_SRC="$SCRIPT_DIR/sandbox-relay.mjs"

NAME=doubulea-sandbox-relay
PORT=13001
NET=doubulea-sandbox
IMAGE=node:22-bookworm-slim
TARGET=host.docker.internal
TARGET_PORT=''
WRITE_ENV=0

while [ $# -gt 0 ]; do
  case "$1" in
    --name)      shift; NAME="${1:-doubulea-sandbox-relay}" ;;
    --port)      shift; PORT="${1:-13001}" ;;
    --network)   shift; NET="${1:-doubulea-sandbox}" ;;
    --image)     shift; IMAGE="${1:-node:22-bookworm-slim}" ;;
    --target)    shift
                 TARGET="${1:-host.docker.internal}"
                 case "$TARGET" in
                   *:*) TARGET_PORT="${TARGET##*:}"; TARGET="${TARGET%%:*}" ;;
                 esac ;;
    --write-env) WRITE_ENV=1 ;;
    --)          : ;;   # `pnpm relay:up -- --write-env` 会把孤立 -- 传进来
    -h|--help)   sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$TARGET_PORT" ] || TARGET_PORT="$PORT"

C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'; C_D=$'\033[90m'; C_X=$'\033[0m'
step() { printf '\n%s=== %s ===%s\n' "$C_C" "$1" "$C_X"; }
ok()   { printf '  %s[OK]%s %s\n' "$C_G" "$C_X" "$1"; }
warn() { printf '  %s[!!]%s %s\n' "$C_Y" "$C_X" "$1"; }
info() { printf '  %s[--]%s %s\n' "$C_D" "$C_X" "$1"; }
fail() { printf '\n%s[FAIL]%s %s\n' "$C_R" "$C_X" "$1" >&2; exit 1; }

env_value() {
  [ -f "$ENV_FILE" ] || { echo ''; return; }
  awk -F= -v k="$1" '$1==k {print $2; found=1} END{if(!found) print ""}' "$ENV_FILE" 2>/dev/null
}

env_upsert() {
  [ -f "$ENV_FILE" ] || fail "没有 ${ENV_FILE}（先从 infra/.env.example 复制一份）"
  local k="$1" v="$2" tmp="${ENV_FILE}.relay-tmp"
  awk -v k="$k" -v v="$v" '
    $0 ~ "^"k"=" { print k "=" v; done=1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}

cd "$REPO_ROOT" || fail "无法进入仓库根: $REPO_ROOT"

# -- 0. 前置 -----------------------------------------------------------

step 'Preflight'

DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
if [ -z "$DOCKER_BIN" ] && [ -x /usr/local/bin/docker ]; then
  DOCKER_BIN=/usr/local/bin/docker
  export PATH="/usr/local/bin:$PATH"
fi
[ -n "$DOCKER_BIN" ] || fail "找不到 docker（macOS/OrbStack 下它在 /usr/local/bin/docker）"
"$DOCKER_BIN" info >/dev/null 2>&1 || fail "docker daemon 不通（Docker Desktop / OrbStack 起了吗？）"
ok "docker 可用：$DOCKER_BIN"

[ -f "$RELAY_SRC" ] || fail "缺中转实现 $RELAY_SRC"
ok "中转实现：$RELAY_SRC"

"$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1 || fail "本地没有镜像 ${IMAGE}（本脚本刻意不联网拉：它必须离线可跑）"
ok "镜像已在本地：$IMAGE"

if "$DOCKER_BIN" network inspect "$NET" >/dev/null 2>&1; then
  ok "沙箱网络已存在：$NET"
else
  fail "沙箱网络 ${NET} 不存在。它由**后端启动时**的 listener 建出来
       （backend/src/sandbox/listener.ts）⇒ 先跑一次 pnpm dev（或 pnpm dev:backend），
       看到启动日志里「沙箱状态」那行之后再回来。
       ⚠️ 别手工 docker network create：后端会校验标签与 Internal 标志，不认手工建的网。"
fi

# -- 1. 起容器（后端腿 = 默认 bridge）----------------------------------

step "起中转容器 ${NAME}"

if "$DOCKER_BIN" container inspect "$NAME" >/dev/null 2>&1; then
  info "同名容器已存在，先删掉重来"
  "$DOCKER_BIN" rm -f "$NAME" >/dev/null 2>&1 || fail "删不掉旧容器 $NAME"
fi

"$DOCKER_BIN" run -d --name "$NAME" \
  --network bridge --restart unless-stopped \
  --add-host "host.docker.internal:host-gateway" \
  -e "RELAY_LISTEN_HOST=0.0.0.0" \
  -e "RELAY_LISTEN_PORT=${PORT}" \
  -e "RELAY_TARGET_HOST=${TARGET}" \
  -e "RELAY_TARGET_PORT=${TARGET_PORT}" \
  -v "$RELAY_SRC:/app/sandbox-relay.mjs:ro" \
  "$IMAGE" node /app/sandbox-relay.mjs >/dev/null || fail "容器起不来（$DOCKER_BIN logs $NAME 看原因）"
ok "已启动（后端腿 = 默认 bridge）"

# -- 2. 接上沙箱腿 -----------------------------------------------------

step "接上沙箱腿 ${NET}"

if "$DOCKER_BIN" network connect "$NET" "$NAME" 2>/dev/null; then
  ok "已接入 ${NET}"
else
  if "$DOCKER_BIN" network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}' | grep -qw "$NAME"; then
    info "本来就已经在 ${NET} 里"
  else
    fail "接入 ${NET} 失败"
  fi
fi

# -- 3. 健康探针 -------------------------------------------------------

step '健康探针'

probe() { # probe <network> <host> <port>  → 0=通
  local net="$1" host="$2" port="$3"
  "$DOCKER_BIN" run --rm --network "$net" "$IMAGE" \
    node -e "const net=require('net');const s=net.connect(${port},'${host}');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)" \
    >/dev/null 2>&1
}

sleep 1
if "$DOCKER_BIN" exec "$NAME" node -e "const net=require('net');const s=net.connect(${PORT},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)" >/dev/null 2>&1; then
  ok "中转进程在监听 ${PORT}"
else
  "$DOCKER_BIN" logs --tail 20 "$NAME" >&2
  fail "中转没起来（上面是容器日志）"
fi

# ★ 从**沙箱网里**再探一次：这才是"两条腿都对"的证明
if probe "$NET" "$NAME" "$PORT"; then
  ok "从 ${NET} 里的容器可达 ${NAME}:${PORT} —— 两条腿都对"
else
  fail "沙箱网里够不着 ${NAME}:${PORT}（沙箱腿没接上？）"
fi

# 目标可达性：后端 listener 可能还没起，只告警不失败
if "$DOCKER_BIN" exec "$NAME" node -e "const net=require('net');const s=net.connect(${TARGET_PORT},'${TARGET}');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)" >/dev/null 2>&1; then
  ok "中转够得着目标 ${TARGET}:${TARGET_PORT}"
else
  warn "中转此刻够不着 ${TARGET}:${TARGET_PORT} —— 后端 listener 起了吗？
       本机通常是：先 pnpm dev（后端起 listener + 建沙箱网），再回来重跑本脚本。"
fi

# -- 4. 结论 -----------------------------------------------------------

URL="http://${NAME}:${PORT}"
step 'Ready'
printf '  %sSANDBOX_BACKEND_URL=%s%s\n' "$C_G" "$URL" "$C_X"
printf '  %sSANDBOX_LISTEN_HOST=0.0.0.0%s\n\n' "$C_G" "$C_X"

if [ "$WRITE_ENV" -eq 1 ]; then
  env_upsert SANDBOX_BACKEND_URL "$URL"
  env_upsert SANDBOX_LISTEN_HOST "0.0.0.0"
  ok "已写进 infra/.env"
  warn "后端是**启动时读 env** 的 ⇒ 要重启才生效：bash infra/scripts/dev-stop.sh && bash infra/scripts/dev-run.sh"
else
  info "写进 infra/.env 用：bash infra/scripts/relay-up.sh --write-env"
fi

cat <<EOF

  日志：$DOCKER_BIN logs -f $NAME
  停止：bash infra/scripts/relay-down.sh

  ⚠️ 生产（后端与 Docker 同宿主）**不需要**本中转：把 infra/.env 里
     SANDBOX_BACKEND_URL / SANDBOX_LISTEN_HOST 留空即可（后端自动取沙箱网网关）。
EOF
