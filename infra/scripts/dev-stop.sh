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
# 收进程的顺序：按**进程树**（pid 文件里的 pid + 它的全部后代）先 SIGINT（后端 SIGINT 是
# 优雅退出：停接流 → 关 PG/Redis → flush 日志）→ 等 10s → 仍未干净就 SIGTERM 整棵树 →
# 再 SIGKILL；最后补一发**本仓路径限定**的模式清理，兜住"父先死、子被 reparent 到 1"的孤儿。
#
# ⚠️ 为什么必须按树、而不是只按端口：`nohup pnpm dev:backend &` 记下的是 **pnpm 壳**的 pid，
#   真正监听端口的是它最底层的 `node … tsx … src/index.ts`。只按端口杀子进程会释放端口，
#   却留下一整串壳进程存活（ppid 变 1）—— 下次启动时新旧两棵树会互相抢端口。
#   同理，SIGINT 必须打到树里的 node 进程，pnpm 壳并不转发信号。
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

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

# pid 及其**全部后代**（先父后子）。存在的理由见 stop_one 的文件头注释：
# `nohup pnpm dev:backend &` 记下的是 **pnpm 壳**的 pid，真正监听端口的是它最底层的
# `node …/tsx … src/index.ts`；只按端口杀子进程会留下一串壳进程（ppid 变 1 成孤儿）。
# 收进程必须按这棵树来。
tree_pids() { # <pid>
  local root="$1" child
  [ -n "$root" ] || return 0
  echo "$root"
  for child in $(pgrep -P "$root" 2>/dev/null); do
    tree_pids "$child"
  done
}

# 去重（保持首次出现顺序）：tree_pids 与 port_pids 会有交集
uniq_words() { awk '!seen[$0]++'; }

# 把多行/空格分隔的 pid 收成一行空格分隔的、去重后的 pid 串
join_pids() { tr ' ' '\n' | sed '/^$/d' | uniq_words | tr '\n' ' '; }

stop_one() { # <名称> <pid文件> <端口>
  local name="$1" pidf="$2" port="$3"
  local pid='' tree='' portpids='' targets='' i=0

  [ -f "$pidf" ] && pid="$(cat "$pidf" 2>/dev/null)"

  if alive "$pid"; then tree="$(tree_pids "$pid")"; fi
  portpids="$(port_pids "$port")"
  targets="$(printf '%s\n%s\n' "$tree" "$portpids" | join_pids)"

  if [ -z "$targets" ]; then
    info "${name}：没在跑"
    rm -f "$pidf"
    return 0
  fi

  # pid 文件丢了/失效但端口被占：可能是别的项目或你手工起的 ⇒ 非 --force 不动
  if ! alive "$pid" && [ -n "$portpids" ] && [ "$FORCE" -ne 1 ]; then
    warn "${name}：没有有效 pid 文件，但端口 $port 被占（$portpids）"
    warn "不敢动它（可能是别的项目 / 你手工起的）⇒ 跳过。确定要收加 --force"
    return 0
  fi

  # ① 优雅：对整个进程树发 SIGINT —— 后端的「优雅退出」处理器（停接流→关 PG/Redis→flush 日志）
  #    只有**直接**收到 SIGINT 才会跑；只对 pnpm 壳发是收不到的（壳不转发）。
  info "${name}：SIGINT → $targets"
  kill -INT $targets 2>/dev/null

  while [ "$i" -lt 10 ]; do
    if ! alive "$pid" && ! port_busy "$port"; then break; fi
    sleep 1; i=$((i + 1))
  done

  # ② 没干净 → SIGTERM（重算一次，接住 tsx watch 在这 10s 内可能新起的子进程）
  if alive "$pid" || port_busy "$port"; then
    if alive "$pid"; then tree="$(tree_pids "$pid")"; fi
    targets="$(printf '%s\n%s\n' "$tree" "$(port_pids "$port")" | join_pids)"
    warn "${name}：SIGINT 未收干净 → SIGTERM → $targets"
    kill -TERM $targets 2>/dev/null
    sleep 2
  fi

  # ③ 还在 → SIGKILL 整棵树 + 端口占用者
  if alive "$pid" || port_busy "$port"; then
    warn "${name}：仍在 → SIGKILL"
    kill -KILL $targets $(port_pids "$port") 2>/dev/null
    sleep 1
  fi

  # ④ 兜底：进程树可能已经断裂（父进程先死、子进程被 reparent 到 1，不再出现在 tree_pids 里）
  #    ⇒ 用**本仓路径**限定的模式清理，既兜住孤儿，又不会误伤别的项目。
  if alive "$pid" || port_busy "$port"; then
    warn "${name}：仍未收干净 → 按本仓路径模式强收"
    pkill -KILL -f "$REPO_ROOT/node_modules/.bin/tsx watch" 2>/dev/null
    pkill -KILL -f "$REPO_ROOT/node_modules/.bin/vite" 2>/dev/null
    pkill -KILL -f "pnpm dev:backend" 2>/dev/null
    pkill -KILL -f "pnpm dev:frontend" 2>/dev/null
    sleep 1
  fi

  rm -f "$pidf"
  if alive "$pid" || port_busy "$port"; then
    warn "${name}：仍未收干净（pid=$pid，端口 $port 占用者=$(port_pids "$port")）"
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
