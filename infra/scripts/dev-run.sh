#!/usr/bin/env bash
# =====================================================================
# dev-run.sh — 一键拉起「浏览器能打开」的完整开发环境
#
# 覆盖四步（每步都可单独跳过）：
#   ① 依赖服务 postgres / redis / minio —— 复用 dev-up.sh，已在跑则跳过
#   ② 建表 + 种子账号 + 分区续期 —— db:deploy / db:seed / db:partitions（全部幂等）
#   ③ 后端  tsx watch  → http://127.0.0.1:<BACKEND_PORT>（默认 13000）
#   ④ 前端  vite       → http://localhost:5174（自动带 VITE_DEV_PROXY_TARGET）
#
# ③④ 在**后台**跑；日志 → .dev-logs/{backend,frontend,db,seed}.log
#                      pid  → .pids/{backend,frontend}.pid
# （两个目录都在 .gitignore 里；不要往里放别的东西）
#
# 停止：bash infra/scripts/dev-stop.sh（只收应用层，依赖服务留着）
#      bash infra/scripts/dev-stop.sh --infra （连依赖服务一起停）
#
# 用法：
#   bash infra/scripts/dev-run.sh
#   bash infra/scripts/dev-run.sh --no-infra     # 依赖服务已在跑，跳过 ①
#   bash infra/scripts/dev-run.sh --no-db        # 跳过 ②（不想每次跑迁移/种子）
#   bash infra/scripts/dev-run.sh --no-install   # 不自动补 pnpm install
#   bash infra/scripts/dev-run.sh --force        # 已在跑？先停再起
#   bash infra/scripts/dev-run.sh --timeout 180  # 单步等待上限（秒，默认 90）
#
# ⚠️ 起完仍然**派不了活给沙箱**：那还需要 `pnpm sandbox:build` 把镜像推到
#    版本线对应的 tag（见 README「阶段三出口验收」前置 ②③）。本脚本只管开发环境。
# =====================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
ENV_FILE="$INFRA_DIR/.env"
LOG_DIR="$REPO_ROOT/.dev-logs"
PID_DIR="$REPO_ROOT/.pids"

FRONTEND_PORT=5174
BACKEND_PORT=13000

DO_INFRA=1
DO_DB=1
DO_INSTALL=1
FORCE=0
TIMEOUT_SEC=90

while [ $# -gt 0 ]; do
  case "$1" in
    --no-infra)   DO_INFRA=0 ;;
    --no-db)      DO_DB=0 ;;
    --no-install) DO_INSTALL=0 ;;
    --force)      FORCE=1 ;;
    --timeout)    shift; TIMEOUT_SEC="${1:-90}" ;;
    --)           : ;;   # `pnpm dev -- --no-infra` 会把孤立 -- 传进来，忽略
    -h|--help)    sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'; C_D=$'\033[90m'; C_X=$'\033[0m'
step() { printf '\n%s=== %s ===%s\n' "$C_C" "$1" "$C_X"; }
ok()   { printf '  %s[OK]%s %s\n' "$C_G" "$C_X" "$1"; }
warn() { printf '  %s[!!]%s %s\n' "$C_Y" "$C_X" "$1"; }
info() { printf '  %s[--]%s %s\n' "$C_D" "$C_X" "$1"; }
fail() { printf '\n%s[FAIL]%s %s\n' "$C_R" "$C_X" "$1" >&2; exit 1; }

# -- 小工具 ------------------------------------------------------------

env_value() {
  [ -f "$ENV_FILE" ] || { echo ''; return; }
  awk -F= -v k="$1" '$1==k {print $2; found=1} END{if(!found) print ""}' "$ENV_FILE" 2>/dev/null
}

# curl 打 localhost 必带 --noproxy '*'；打不通返回 000
http_code() {
  curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 3 "$1" 2>/dev/null || echo 000
}

port_busy()  { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_pids()  { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | tr '\n' ' '; }

pid_alive() { # <pid文件>
  [ -f "$1" ] || return 1
  local p; p="$(cat "$1" 2>/dev/null)"
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

wait_until() { # <描述> <秒> <判定命令…>
  local desc="$1" secs="$2"; shift 2
  local i=0
  while [ "$i" -lt "$secs" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  warn "等待超时：${desc}（${secs}s）"
  return 1
}

backend_up()  { [ "$(http_code "http://127.0.0.1:${BACKEND_PORT}/health")" = '200' ]; }
frontend_up() {
  [ "$(http_code "http://localhost:${FRONTEND_PORT}/")" = '200' ] && return 0
  # vite 只绑 IPv6 [::1]：localhost 解析到 127.0.0.1 优先时要补这一发
  [ "$(http_code "http://[::1]:${FRONTEND_PORT}/")" = '200' ]
}

# -- 0. 前置 -----------------------------------------------------------

cd "$REPO_ROOT" || fail "无法进入仓库根: $REPO_ROOT"

step 'Preflight'

# macOS + OrbStack：docker 不在非交互 shell 的 PATH 里
DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
if [ -z "$DOCKER_BIN" ] && [ -x /usr/local/bin/docker ]; then
  DOCKER_BIN=/usr/local/bin/docker
  export PATH="/usr/local/bin:$PATH"
fi

command -v pnpm >/dev/null 2>&1 || fail '找不到 pnpm（先装：corepack enable / npm i -g pnpm）'
ok "pnpm $(pnpm --version)"

if [ "$DO_INFRA" -eq 1 ]; then
  [ -n "$DOCKER_BIN" ] || fail '找不到 docker（OrbStack / Docker Desktop 装了吗）'
  "$DOCKER_BIN" version --format '{{.Server.Version}}' >/dev/null 2>&1 \
    || fail 'Docker engine 不可达。请先启动 OrbStack / Docker Desktop。'
  ok "Docker engine 可达（$(basename "$DOCKER_BIN")）"
fi

if [ ! -f "$ENV_FILE" ]; then
  fail "缺少 ${ENV_FILE}（可从 infra/.env.example 复制；dev-up.sh 也会自动补，但请先填好密钥）"
fi
ok "env 文件: infra/.env"

env_port="$(env_value BACKEND_PORT)"; [ -n "$env_port" ] && BACKEND_PORT="$env_port"
ok "后端端口: ${BACKEND_PORT}（来自 infra/.env） 前端端口: ${FRONTEND_PORT}（vite strictPort）"

mkdir -p "$LOG_DIR" "$PID_DIR"

# -- 已在跑？ ----------------------------------------------------------

already=0
pid_alive "$PID_DIR/backend.pid"  && { warn "后端已在跑（pid $(cat "$PID_DIR/backend.pid")）";  already=1; }
pid_alive "$PID_DIR/frontend.pid" && { warn "前端已在跑（pid $(cat "$PID_DIR/frontend.pid")）"; already=1; }
if [ "$already" -eq 1 ]; then
  if [ "$FORCE" -eq 1 ]; then
    info '--force：先停掉这两个进程再起'
    bash "$SCRIPT_DIR/dev-stop.sh" || fail 'dev-stop.sh 失败，先手工收干净再重试'
  else
    fail "已在运行。要重启：bash infra/scripts/dev-run.sh --force（或先跑 dev-stop.sh）"
  fi
fi

for p in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if port_busy "$p"; then
    warn "端口 $p 已被别的进程占用：$(port_pids "$p")"
    warn "（前端是 strictPort，占了会直接退出；多半是别的项目或上次没收干净）"
    fail "端口冲突，先处理掉占用再重试（或 bash infra/scripts/dev-stop.sh --force）"
  fi
done
ok "端口 ${BACKEND_PORT} / ${FRONTEND_PORT} 空闲"

# -- 依赖安装（首次） ---------------------------------------------------

if [ "$DO_INSTALL" -eq 1 ] && [ ! -d "$REPO_ROOT/node_modules" ]; then
  step '安装依赖（首次，node_modules 不存在）'
  info '输出较多，先写进 .dev-logs/install.log，失败时再打印末尾'
  if ! pnpm install >"$LOG_DIR/install.log" 2>&1; then
    tail -20 "$LOG_DIR/install.log" >&2
    fail "pnpm install 失败，完整日志 $LOG_DIR/install.log"
  fi
  ok '依赖安装完成'
else
  info '依赖已就位（跳过 pnpm install；要强制装用 pnpm install）'
fi

# -- ① 依赖服务 --------------------------------------------------------

INFRA_READY=0
if [ "$DO_INFRA" -eq 1 ]; then
  step '① 依赖服务 postgres / redis / minio'

  infra_ready() {
    local c st
    for c in doubulea-postgres doubulea-redis doubulea-minio; do
      st="$("$DOCKER_BIN" inspect --format \
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)"
      case "$st" in healthy|running) ;; *) return 1 ;; esac
    done
    return 0
  }

  if infra_ready; then
    ok '三个服务已在跑（跳过 dev-up.sh）'
  else
    info '调 dev-up.sh（构建/拉起/等健康/验收 PG 扩展）'
    extra=''
    "$DOCKER_BIN" image inspect 'doubulea/postgres:pg16-vector-bigm' >/dev/null 2>&1 \
      && extra='--no-build'
    [ -n "$extra" ] && info 'PG 镜像已存在 → 跳过重建（要重建：pnpm infra:build）'
    bash "$SCRIPT_DIR/dev-up.sh" $extra --timeout 180 || fail 'dev-up.sh 失败，见上方输出'
  fi
  INFRA_READY=1
else
  step '① 依赖服务'
  info '已跳过（--no-infra）—— 请确认 pg/redis/minio 已在跑，否则 ②③ 会失败'
fi

# -- ② 建表 + 种子 + 分区 ----------------------------------------------

if [ "$DO_DB" -eq 1 ]; then
  step '② 建表 / 种子账号 / 分区续期（幂等）'

  info 'db:deploy（应用已有迁移，不做 diff）'
  pnpm db:deploy >"$LOG_DIR/db.log" 2>&1 || {
    tail -20 "$LOG_DIR/db.log" >&2
    fail "pnpm db:deploy 失败，完整日志 $LOG_DIR/db.log"
  }
  ok '迁移已应用'

  info 'db:seed（幂等：已存在的账号只跳过、绝不改密码）'
  pnpm db:seed >"$LOG_DIR/seed.log" 2>&1 || {
    tail -20 "$LOG_DIR/seed.log" >&2
    warn '本仓高频原因：backend/generated/prisma 是"半生成"态（上次 prisma generate 被中断过）'
    warn '  修法：rm -rf backend/generated/prisma && pnpm db:generate，再重跑本脚本'
    fail "pnpm db:seed 失败，完整日志 $LOG_DIR/seed.log"
  }
  ok '种子完成'
  if grep -qE '初始密码|initialPassword|密码' "$LOG_DIR/seed.log" 2>/dev/null; then
    warn "种子账号的初始密码只打印一次 → $LOG_DIR/seed.log（别忘了它！）"
    printf '      %s' "$(grep -E 'admin|member|密码' "$LOG_DIR/seed.log" 2>/dev/null | head -4 | tr '\n' ' ' | cut -c1-200)"
    printf '%s\n' "$C_X"
  fi

  info 'db:partitions（messages / usage_records 按月分区续期）'
  pnpm db:partitions >"$LOG_DIR/partitions.log" 2>&1 \
    && ok '分区已续期' \
    || warn "分区续期失败（不致命 —— 只在跨月写库时才炸）：$LOG_DIR/partitions.log"
else
  step '② 建表 / 种子'
  info '已跳过（--no-db）'
fi

# -- ③ 后端 ------------------------------------------------------------

step "③ 后端（tsx watch）→ http://127.0.0.1:${BACKEND_PORT}"

: >"$LOG_DIR/backend.log"
# ⚠️ 顺手接走 stdin（</dev/null）：vite 把 stdin 的 EOF 当作 Ctrl+D，stdin 一关它就退出
#    （症状 = 日志 "VITE ready" 之后紧跟 [ELIFECYCLE] Command failed）。backend 是 tsx watch、
#    不理会 stdin，一并接走以保持一致。
nohup pnpm dev:backend >>"$LOG_DIR/backend.log" 2>&1 </dev/null &
BACKEND_PID=$!
echo "$BACKEND_PID" >"$PID_DIR/backend.pid"
info "已后台启动（pid ${BACKEND_PID}，日志 ${LOG_DIR}/backend.log）"

if wait_until '后端 /health = 200' "$TIMEOUT_SEC" backend_up; then
  ok "后端就绪 —— http://127.0.0.1:${BACKEND_PORT}/health"
else
  printf '\n%s--- backend.log 末尾 ---%s\n' "$C_D" "$C_X"
  tail -25 "$LOG_DIR/backend.log"
  printf '\n'
  fail "后端 ${TIMEOUT_SEC}s 内没起来（配置校验失败？见上面的日志）"
fi

# -- ④ 前端 ------------------------------------------------------------

step "④ 前端（vite）→ http://localhost:${FRONTEND_PORT}"

: >"$LOG_DIR/frontend.log"
VITE_DEV_PROXY_TARGET="http://127.0.0.1:${BACKEND_PORT}" \
  nohup pnpm dev:frontend >>"$LOG_DIR/frontend.log" 2>&1 </dev/null &
FRONTEND_PID=$!
echo "$FRONTEND_PID" >"$PID_DIR/frontend.pid"
info "已后台启动（pid ${FRONTEND_PID}，日志 ${LOG_DIR}/frontend.log）"
info "VITE_DEV_PROXY_TARGET=http://127.0.0.1:${BACKEND_PORT}（不传会静默串到别的项目）"

if wait_until '前端 5174 可访问' "$TIMEOUT_SEC" frontend_up; then
  ok "前端就绪 —— http://localhost:${FRONTEND_PORT}/"
else
  printf '\n%s--- frontend.log 末尾 ---%s\n' "$C_D" "$C_X"
  tail -25 "$LOG_DIR/frontend.log"
  printf '\n'
  warn "后端这时候已经起来了、还在后台跑（pid $(cat "$PID_DIR/backend.pid" 2>/dev/null)）"
  warn "整体收掉：bash infra/scripts/dev-stop.sh"
  fail "前端 ${TIMEOUT_SEC}s 内没起来（5174 被占 / 依赖没装？见上面的日志）"
fi

# -- 汇总 --------------------------------------------------------------

step 'Ready'

pg_port="$(env_value POSTGRES_PORT)";        printf '  %sPostgreSQL   127.0.0.1:%s%s\n' "$C_D" "${pg_port:-5432}" "$C_X"
redis_port="$(env_value REDIS_PORT)";        printf '  %sRedis        127.0.0.1:%s%s\n' "$C_D" "${redis_port:-6379}" "$C_X"
minio_api="$(env_value MINIO_API_PORT)";     printf '  %sMinIO API    127.0.0.1:%s%s\n' "$C_D" "${minio_api:-9000}" "$C_X"
printf '  %s后端         http://127.0.0.1:%s%s\n' "$C_D" "$BACKEND_PORT" "$C_X"
printf '  %s前端         http://localhost:%s/%s\n' "$C_G" "$FRONTEND_PORT" "$C_X"

printf '\n  %s日志%s  tail -f .dev-logs/backend.log   /   tail -f .dev-logs/frontend.log\n' "$C_D" "$C_X"
printf '  %s账号%s  admin / member（初始密码见 .dev-logs/seed.log；俩都是首登改密态）\n' "$C_D" "$C_X"
printf '  %s停止%s  bash infra/scripts/dev-stop.sh\n' "$C_D" "$C_X"
printf '  %s提示%s  代理没串对？curl -s --noproxy '"'"'*'"'"' http://localhost:%s/api/auth/me 应返回本项目 401 信封\n' "$C_D" "$C_X" "$FRONTEND_PORT"
if [ "$INFRA_READY" -eq 1 ]; then
  printf '  %s注意%s  要往沙箱派活还得先把镜像推到对应 tag：pnpm sandbox:build（README「阶段三出口验收」前置 ②③）\n' "$C_Y" "$C_X"
fi
printf '\n'
