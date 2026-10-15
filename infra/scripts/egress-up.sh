#!/usr/bin/env bash
# =====================================================================
# egress-up.sh — 起一个「两条腿」的 egress 正向代理容器，供沙箱出公网
#
# 【为什么需要】沙箱容器挂在 `doubulea-sandbox`（`Internal: true`）上，
#   没有公网路由 ⇒ 出公网**只可能**经出口①。`SANDBOX_EGRESS_PROXY_URL`
#   留空时 `ensureSandbox()` 会**显式拒绝**派活（`manager.ts` 第 153 行），
#   错误卡文案就是"未配置 SANDBOX_EGRESS_PROXY_URL"。
#
# 【两条腿】README 前置 ③ 的硬要求：
#   · 默认 bridge       → 能上网（公网腿）
#   · doubulea-sandbox  → 沙箱容器够得着（沙箱腿；`Internal: true`，只有接进去才通）
#   只有一条腿的代理，在 internal 网络上等于没有。
#
# 【白名单】默认**自动**从库里 `enabled = true` 的 `model_providers.base_url`
#   取主机名 ⇒ 正好落实"只放行模型池 baseURL"。要加别的目标用 `--allow`。
#   ⚠️ 空白名单不是"全放行"，是**拒启**（别让"忘了配"退化成"全放行"）。
#   ⚠️ 指到 `127.0.0.1` 的 provider 会被**跳过并告警** —— 沙箱经代理到不了宿主回环
#      （macOS 上 Docker 在 VM 里，bridge 网关在 VM 内）。要用宿主上的假 LLM，
#      把它的 base_url 改成 `host.docker.internal:<port>`（代理那台容器够得着宿主）。
#
# 【前置】`doubulea-sandbox` 这张网由**后端启动时**的 listener 建出来
#   （`listener.ts` 第 77 行）⇒ 顺序是「先起后端、再起代理」。网不在时会直接告诉你。
#
# 用法：
#   bash infra/scripts/egress-up.sh                      # 自动取模型池白名单
#   bash infra/scripts/egress-up.sh --write-env          # 顺便写进 infra/.env
#   bash infra/scripts/egress-up.sh --allow api.foo.com  # 追加白名单（可重复）
#   bash infra/scripts/egress-up.sh --allow-all          # 关白名单（只建议临时排查）
#   bash infra/scripts/egress-up.sh --no-auto            # 不自动取库，只用 --allow / --deny
#   bash infra/scripts/egress-up.sh --deny bad.example.com  # 追加黑名单（命中即拒）
#   bash infra/scripts/egress-up.sh --watch              # ★ 起完代理后保持前台，每 30s 从库刷新策略
#   bash infra/scripts/egress-up.sh --daemon             # ★★ 同 --watch，但**常驻后台**（pid → .pids/egress-watch.pid，
#                                                        #     日志 → .dev-logs/egress.log；egress-down.sh 一并收掉）
#   bash infra/scripts/egress-up.sh --port 3128 --name doubulea-egress --image node:22-bookworm-slim
#
# 【出网策略（黑白名单）】代理挂载一个**策略文件**（`${TMPDIR:-/tmp}/doubulea-egress-allow/policy.json`），
#   代理进程每 5s 轮询该文件、内容变了就热更新 —— 平台改策略 / 库里增删 provider **不需要重启代理**。
#   策略来源（并集）：平台表 `egress_policy`（`/admin/egress` 页配）+ 模型池主机（白名单非空时并集注入）
#   + `--allow/--deny` + `infra/.env` 的 `SANDBOX_EGRESS_ALLOW_HOSTS`（`*` = 全放行）。
#   语义：deny 优先；两张表都空 = **全放行**（默认）；只配白名单 = 只放行白名单；只配黑名单 = 除黑名单外全放行。
#   · 本脚本**每次运行**时写一次（临时文件 + `mv`，原子写）；
#   · `--watch` 模式起一个前台循环，每 30s 重新查库，变了就重写文件（代理 ≤5s 后热更新）。
#   Ctrl+C 只停同步循环，代理容器照常跑（策略停在最后一次一致状态）。
#   ⚠️ 不跑 `--watch` 的话是"启动时抓一次"的语义 —— 平台改完要重跑本脚本或起 `--watch`。
#
# 【模型端点隧道空闲上限】策略文件里额外带一份 `modelHosts`（= 模型池主机），代理对**这些目标**
#   在隧道建成后仍留一个空闲上限（`infra/.env` 的 `SANDBOX_EGRESS_MODEL_IDLE_TIMEOUT_MS`，默认 180s）。
#   目的：上游"回了响应头、正文长时间没数据"（实测出现过静默 356s）时把隧道掐掉，让容器里的引擎
#   收到流错误、走它自己的 `auto_retry`（只重发这一次 provider 请求，不重跑整轮工具）。
#   非模型目标（registry / git）不受影响 —— npm/pytest 本来就可能长时间静默。
#
# 停止：bash infra/scripts/egress-down.sh
# =====================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
ENV_FILE="$INFRA_DIR/.env"
PROXY_SRC="$SCRIPT_DIR/egress-proxy.mjs"

NAME=doubulea-egress
PORT=3128
NET=doubulea-sandbox
IMAGE=node:22-bookworm-slim
PG_CONTAINER=doubulea-postgres

# ★ P1-16a：平台出网范围（`egress_policy.scope`）
#   ⚠️ **2026-10-14 用户定案：出网范围配在平台出网策略里（`/admin/egress`）**，**不在会话里配**。
#   · 从库 `egress_policy.scope` 读（`ALL` 默认全放行 / `NONE` 仅模型 / `REGISTRY` 模型 + 取包）；
#   · 本脚本把它**解析成代理要的 `allow` / `deny` 两张表**（`ALL`⇒`['*']`；`NONE`/`REGISTRY`⇒白名单，
#     见 `compute_policy` 的 scope 分支）⇒ 代理侧不认识 scope、也不做 per-conversation。
#   · 白名单（`allow_hosts`）与范围**并列补充**（额外的零散主机）；黑名单（`deny_hosts`）永远硬拒。
# `SANDBOX_EGRESS_REGISTRY_HOSTS` / `SANDBOX_EGRESS_GIT_HOSTS`（.env，逗号分隔）可覆盖下面两份默认
#   （`REGISTRY` 档 = 模型池 ∪ 注册表 ∪ git）。默认值属 `子方案` §十三 待决 13 ④（暂只放官方公共源）。
DEFAULT_REGISTRY_HOSTS='registry.npmjs.org,registry.yarnpkg.com,pypi.org,files.pythonhosted.org,proxy.golang.org,sum.golang.org,repo.maven.apache.org,repo1.maven.org,index.crates.io,static.crates.io,crates.io'
DEFAULT_GIT_HOSTS='github.com,*.github.com,gitlab.com,*.gitlab.com,bitbucket.org,*.bitbucket.org'

# 策略文件（挂进代理容器，代理每 5s 轮询热更新 —— 改平台策略不用重启代理）
ALLOW_DIR_HOST="${TMPDIR:-/tmp}/doubulea-egress-allow"
POLICY_FILE_HOST="$ALLOW_DIR_HOST/policy.json"
POLICY_FILE_CONTAINER=/egress-allow/policy.json

# 常驻（--daemon）的 pid / 日志（与 dev-run.sh 同一套目录，gitignore 里已放行）
LOG_DIR="$REPO_ROOT/.dev-logs"
PID_DIR="$REPO_ROOT/.pids"
WATCH_LOG="$LOG_DIR/egress.log"
WATCH_PID_FILE="$PID_DIR/egress-watch.pid"

ALLOW_ALL=0
FORCE_ALLOW_ALL=0
WRITE_ENV=0
NO_AUTO=0
WATCH=0
DAEMON=0
WATCH_INTERVAL_SEC=30
EXTRA_ALLOW=()
EXTRA_DENY=()

while [ $# -gt 0 ]; do
  case "$1" in
    --name)      shift; NAME="${1:-doubulea-egress}" ;;
    --port)      shift; PORT="${1:-3128}" ;;
    --network)   shift; NET="${1:-doubulea-sandbox}" ;;
    --image)     shift; IMAGE="${1:-node:22-bookworm-slim}" ;;
    --allow)     shift; EXTRA_ALLOW+=("${1:-}") ;;
    --deny)      shift; EXTRA_DENY+=("${1:-}") ;;
    --allow-all) FORCE_ALLOW_ALL=1 ;;
    --no-auto)   NO_AUTO=1 ;;
    --write-env) WRITE_ENV=1 ;;
    --watch)     WATCH=1 ;;
    --daemon)    DAEMON=1; WATCH=1 ;;
    --watch-interval) shift; WATCH_INTERVAL_SEC="${1:-30}" ;;
    --)          : ;;   # `pnpm egress:up -- --write-env` 会把孤立 -- 传进来
    -h|--help)   sed -n '2,54p' "$0"; exit 0 ;;
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

env_value() {
  [ -f "$ENV_FILE" ] || { echo ''; return; }
  awk -F= -v k="$1" '$1==k {print $2; found=1} END{if(!found) print ""}' "$ENV_FILE" 2>/dev/null
}

cd "$REPO_ROOT" || fail "无法进入仓库根: $REPO_ROOT"

# -- 0. 前置 -----------------------------------------------------------

step 'Preflight'

DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
if [ -z "$DOCKER_BIN" ] && [ -x /usr/local/bin/docker ]; then
  DOCKER_BIN=/usr/local/bin/docker
  export PATH="/usr/local/bin:$PATH"
fi
[ -n "$DOCKER_BIN" ] || fail "找不到 docker（OrbStack 下它在 /usr/local/bin/docker）"
"$DOCKER_BIN" info >/dev/null 2>&1 || fail "docker daemon 不通（OrbStack 起了吗？）"
ok "docker 可用：$DOCKER_BIN"

[ -f "$PROXY_SRC" ] || fail "缺代理实现 $PROXY_SRC"
ok "代理实现：$PROXY_SRC"

"$DOCKER_BIN" image inspect "$IMAGE" >/dev/null 2>&1 || fail "本地没有镜像 ${IMAGE}（本脚本刻意不联网拉：它必须离线可跑）"
ok "镜像已在本地：$IMAGE"

if "$DOCKER_BIN" network inspect "$NET" >/dev/null 2>&1; then
  ok "沙箱网络已存在：$NET"
else
  fail "沙箱网络 ${NET} 不存在。它由**后端启动时**的 listener 建出来
       （backend/src/sandbox/listener.ts 第 77 行）⇒ 先跑一次 pnpm dev（或 pnpm dev:backend），
       看到启动日志里「沙箱状态」那行之后再回来。
       ⚠️ 别手工 docker network create：后端会校验标签与 Internal 标志，不认手工建的网。"
fi

# -- 1. 组装出网策略（黑白名单）---------------------------------------

step '出网策略'

# 三个集合：ALLOW（白名单，含 `*`）/ DENY（黑名单）/ MODEL（模型池主机，白名单非空时并集注入）
ALLOW=()
DENY=()
MODEL=()
ALLOW_ALL=0
# ★ P1-16a：平台出网范围（`ALL`/`NONE`/`REGISTRY`，默认 `ALL`）+ 注册表 / git 主机名单（REGISTRY 档用）
SCOPE=ALL
REGISTRY_HOSTS=()
GIT_HOSTS=()

add_allow() {
  local item="$1" existing
  [ -n "$item" ] || return 0
  for existing in ${ALLOW[@]+"${ALLOW[@]}"}; do [ "$existing" = "$item" ] && return 0; done
  ALLOW+=("$item")
}
add_deny() {
  local item="$1" existing
  [ -n "$item" ] || return 0
  for existing in ${DENY[@]+"${DENY[@]}"}; do [ "$existing" = "$item" ] && return 0; done
  DENY+=("$item")
}
add_model() {
  local item="$1" existing
  [ -n "$item" ] || return 0
  for existing in ${MODEL[@]+"${MODEL[@]}"}; do [ "$existing" = "$item" ] && return 0; done
  MODEL+=("$item")
}

SKIPPED_LOOPBACK=()

# 从库里取 enabled 的 model_providers 主机名（候选白名单成员，见 compute_policy ⑤）
db_model_hosts() {
  [ "$NO_AUTO" -eq 1 ] && return 0
  local PG_USER PG_DB urls h
  PG_USER="$(env_value POSTGRES_USER)"; [ -n "$PG_USER" ] || PG_USER=doubulea
  PG_DB="$(env_value POSTGRES_DB)";     [ -n "$PG_DB" ]   || PG_DB=doubulea

  urls="$("$DOCKER_BIN" exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A \
            -c "SELECT base_url FROM model_providers WHERE enabled = true;" 2>/dev/null)"
  if [ -z "$urls" ]; then
    return 1
  fi
  while IFS= read -r u; do
    [ -n "$u" ] || continue
    h="$(printf '%s' "$u" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://([^/:]+).*#\1#')"
    case "$h" in
      127.0.0.1|localhost|::1|0.0.0.0)
        SKIPPED_LOOPBACK+=("$u")
        ;;
      *)
        add_model "$h"
        ;;
    esac
  done <<< "$urls"
  return 0
}

# 从库里取平台策略 `egress_policy`（单行；范围 + 两张表。两张表以空格分隔的 host 列表）。
# 表 / 列可能还不存在（迁移没跑）⇒ psql 报错、返回 1，调用方按默认口径处理。
# ★ P1-16a：一并取 `scope`（`ALL`/`NONE`/`REGISTRY`），写进全局 `SCOPE`。
db_policy_hosts() {
  [ "$NO_AUTO" -eq 1 ] && return 0
  local PG_USER PG_DB row rest allow_csv deny_csv scope item
  PG_USER="$(env_value POSTGRES_USER)"; [ -n "$PG_USER" ] || PG_USER=doubulea
  PG_DB="$(env_value POSTGRES_DB)";     [ -n "$PG_DB" ]   || PG_DB=doubulea

  row="$("$DOCKER_BIN" exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -t -A -F'|' \
            -c "SELECT array_to_string(allow_hosts, ' '), array_to_string(deny_hosts, ' '), scope FROM egress_policy WHERE id = 'default';" 2>/dev/null)"
  [ -n "$row" ] || return 1
  allow_csv="${row%%|*}"
  rest="${row#*|}"
  deny_csv="${rest%%|*}"
  scope="${rest##*|}"
  case "$scope" in
    ALL|NONE|REGISTRY) SCOPE="$scope" ;;
    *) SCOPE=ALL ;;
  esac
  for item in $allow_csv; do add_allow "$item"; done
  for item in $deny_csv; do add_deny "$item"; done
  return 0
}

# CSV → 全局数组（用于 REGISTRY / GIT 主机名单；空值 → 空数组）
csv_to_array() {
  local csv="$1" name="$2" item
  local -a out=() items=()
  if [ -n "$csv" ]; then
    IFS=',' read -r -a items <<< "$csv"
    for item in ${items[@]+"${items[@]}"}; do
      item="$(printf '%s' "$item" | tr -d '[:space:]')"
      [ -n "$item" ] && out+=("$item")
    done
  fi
  # ⚠️ bash 3.2（macOS `/bin/bash`）+ `set -u`：**空数组**的 `"${out[@]}"` 会报
  #    `out[@]: unbound variable` ⇒ 必须分开写（`${out[@]+…}` 在这里也救不了，因为它是 eval 出去的赋值语句）。
  if [ "${#out[@]}" -gt 0 ]; then
    eval "$name=(\"\${out[@]}\")"
  else
    eval "$name=()"
  fi
}

# 重算策略 → 填 ALLOW / DENY / MODEL / ALLOW_ALL（再由 write_policy_file 落成 JSON）。
# 参数 `quiet`：非空 = 不打启动期日志（watch 每轮调一次，不能刷屏）。
# 返回 0 = 已装好（**永远** 0：默认全放行，DB 读不到不阻塞启动）。
compute_policy() {
  local quiet="${1:-}"
  ALLOW=(); DENY=(); MODEL=(); ALLOW_ALL=0
  SCOPE=ALL
  SKIPPED_LOOPBACK=()
  # ★ P1-16a：注册表 / git 主机名单（.env 可覆盖默认；仅 REGISTRY 档用）
  csv_to_array "$(env_value SANDBOX_EGRESS_REGISTRY_HOSTS)" REGISTRY_HOSTS
  [ "${#REGISTRY_HOSTS[@]}" -gt 0 ] || csv_to_array "$DEFAULT_REGISTRY_HOSTS" REGISTRY_HOSTS
  csv_to_array "$(env_value SANDBOX_EGRESS_GIT_HOSTS)" GIT_HOSTS
  [ "${#GIT_HOSTS[@]}" -gt 0 ] || csv_to_array "$DEFAULT_GIT_HOSTS" GIT_HOSTS

  # ① 平台策略（egress_policy 表：范围 + 两张表）
  if db_policy_hosts; then
    [ -z "$quiet" ] && info "平台策略：范围 ${SCOPE} / allow ${#ALLOW[@]} 条 / deny ${#DENY[@]} 条"
  elif [ -z "$quiet" ]; then
    warn "从库里没取到 egress_policy（迁移没跑 / 容器 ${PG_CONTAINER} 不在？）—— 按默认口径处理（范围 ALL）"
  fi

  # ② 模型池主机（候选白名单成员）
  if db_model_hosts; then
    [ -z "$quiet" ] && info "库里的模型池主机：${MODEL[*]:-（无）}"
  elif [ -z "$quiet" ]; then
    warn "从库里没取到 enabled 的 model_providers（容器 ${PG_CONTAINER} 在跑吗？）"
  fi

  # ③ --allow / --deny 追加
  local extra
  for extra in ${EXTRA_ALLOW[@]+"${EXTRA_ALLOW[@]}"}; do add_allow "$extra"; done
  for extra in ${EXTRA_DENY[@]+"${EXTRA_DENY[@]}"}; do add_deny "$extra"; done

  # ④ env 通道：SANDBOX_EGRESS_ALLOW_HOSTS（`*` = 全放行 / 列表 = 追加白名单）、SANDBOX_EGRESS_DENY_HOSTS（追加黑名单）
  local env_allow env_item
  env_allow="$(env_value SANDBOX_EGRESS_ALLOW_HOSTS)"
  if [ "$env_allow" = '*' ]; then
    ALLOW_ALL=1
  elif [ -n "$env_allow" ]; then
    IFS=',' read -r -a env_items <<< "$env_allow"
    for env_item in ${env_items[@]+"${env_items[@]}"}; do
      add_allow "$(printf '%s' "$env_item" | tr -d '[:space:]')"
    done
  fi
  local env_deny
  env_deny="$(env_value SANDBOX_EGRESS_DENY_HOSTS)"
  if [ -n "$env_deny" ]; then
    IFS=',' read -r -a env_deny_items <<< "$env_deny"
    for env_item in ${env_deny_items[@]+"${env_deny_items[@]}"}; do
      add_deny "$(printf '%s' "$env_item" | tr -d '[:space:]')"
    done
  fi
  # `--allow-all` 命令行开关（优先级最高）
  if [ "$FORCE_ALLOW_ALL" -eq 1 ]; then
    ALLOW_ALL=1
  fi

  # ★ P1-16a ⑤：平台出网范围 → 解析进 ALLOW（`ALL` ⇒ 全放行；`NONE` ⇒ 仅模型池；
  #   `REGISTRY` ⇒ 模型池 ∪ 注册表 ∪ git）。白名单（上面）与范围**并列补充**，黑名单永远硬拒。
  local sc_item
  case "$SCOPE" in
    ALL)
      [ "$ALLOW_ALL" -eq 0 ] && ALLOW_ALL=1
      ;;
    NONE)
      for sc_item in ${MODEL[@]+"${MODEL[@]}"}; do add_allow "$sc_item"; done
      ;;
    REGISTRY)
      for sc_item in ${MODEL[@]+"${MODEL[@]}"} ${REGISTRY_HOSTS[@]+"${REGISTRY_HOSTS[@]}"} ${GIT_HOSTS[@]+"${GIT_HOSTS[@]}"}; do
        add_allow "$sc_item"
      done
      ;;
  esac

  # ★ P1-16a ⑥：白名单非空 ⇒ **并集注入模型池主机**（"模型默认放行"）；白名单为空 ⇒ 不并
  #    （空 = 全放行 / 黑名单，模型主机本就放行，并进去反而会把模式变成"仅白名单"）
  if [ "${#ALLOW[@]}" -gt 0 ] && [ "$ALLOW_ALL" -ne 1 ]; then
    local m
    for m in ${MODEL[@]+"${MODEL[@]}"}; do add_allow "$m"; done
  fi
  if [ "$ALLOW_ALL" -eq 1 ]; then
    ALLOW=('*')
  fi

  # ★ P1-16a ⑦：收窄档（NONE/REGISTRY）而放行集仍为空 ⇒ 显式拒绝一切
  #    （否则两张空表会被代理解成"全放行"，与语义正好相反）
  if [ "$ALLOW_ALL" -ne 1 ] && [ "${#ALLOW[@]}" -eq 0 ]; then
    DENY=('*')
  fi
  return 0
}

# 一组规则 → JSON 数组字面量（只接受合法 host 形状；其余丢弃，避免把坏值写进 JSON）
json_host_array() {
  local out='' item
  for item in "$@"; do
    if [ "$item" = '*' ] || [[ "$item" =~ ^(\*\.)?[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
      out="${out}\"${item}\","
    fi
  done
  printf '[%s]' "${out%,}"
}

# 原子写策略文件（临时文件 + mv：代理轮询读的是路径，mv 后立即可见新内容）
# ⚠️ 形状 = 代理认识的 `{allow,deny,modelHosts}`（scope 已在 `compute_policy` 解析进 allow/deny；
#    `modelHosts` 不参与放行判定，只用来给"模型端点隧道"挂空闲上限 —— 见代理文件头 ★）。
write_policy_file() {
  mkdir -p "$ALLOW_DIR_HOST"
  local tmp="$POLICY_FILE_HOST.tmp"
  local allow_json='[]' deny_json='[]' model_json='[]'
  [ "${#ALLOW[@]}" -gt 0 ] && allow_json="$(json_host_array "${ALLOW[@]}")"
  [ "${#DENY[@]}" -gt 0 ] && deny_json="$(json_host_array "${DENY[@]}")"
  [ "${#MODEL[@]}" -gt 0 ] && model_json="$(json_host_array "${MODEL[@]}")"
  printf '{"allow":%s,"deny":%s,"modelHosts":%s}\n' "$allow_json" "$deny_json" "$model_json" > "$tmp"
  mv "$tmp" "$POLICY_FILE_HOST"
}

compute_policy
write_policy_file
if [ "$ALLOW_ALL" -eq 1 ]; then
  warn "全放行模式（范围 ALL / 白名单关闭 / 两张表皆空）—— 任何目标都放行"
elif [ "${#ALLOW[@]}" -gt 0 ]; then
  ok "白名单模式（范围 ${SCOPE}）：放行 ${#ALLOW[@]} 个主机（含模型池主机）"
else
  ok "黑名单模式：拒绝 ${#DENY[@]} 个主机，其余放行"
fi

for skipped in ${SKIPPED_LOOPBACK[@]+"${SKIPPED_LOOPBACK[@]}"}; do
  warn "跳过 ${skipped} —— 它指宿主回环，沙箱经代理到不了
       （macOS 上 Docker 在 VM 里，bridge 网关在 VM 内 = README 里那堵墙 a）。
       要用宿主上的假 LLM：把该 provider 的 base_url 改成 http://host.docker.internal:<port>/v1，
       再重跑本脚本（代理那台容器在默认 bridge 上够得着宿主）。"
done

# 策略落盘（挂进容器；代理轮询它做热更新）
info "出网策略已写入 ${POLICY_FILE_HOST}（代理挂载 + 热更新；含 modelHosts ${#MODEL[@]} 条）"

# -- 1.5 模型端点隧道空闲上限（★ 掐掉"只回头、不回正文"的模型流，交给引擎 auto_retry）------
# 为什么只对模型端点设：非模型目标（registry / git / 长下载）本来就可能长时间静默，
# 设了会误杀；模型流正常时是**持续吐 delta** 的，静默到这么久基本等于死链。
# 来源：infra/.env 的 SANDBOX_EGRESS_MODEL_IDLE_TIMEOUT_MS（默认 180000；0 = 关）。
MODEL_IDLE_TIMEOUT_MS="$(env_value SANDBOX_EGRESS_MODEL_IDLE_TIMEOUT_MS)"
[ -n "$MODEL_IDLE_TIMEOUT_MS" ] || MODEL_IDLE_TIMEOUT_MS=180000
info "模型端点空闲上限：${MODEL_IDLE_TIMEOUT_MS}ms（0 = 关；只对 modelHosts 命中目标生效）"

# -- 2. 起容器（公网腿）------------------------------------------------

step "起代理容器 ${NAME}"

if "$DOCKER_BIN" container inspect "$NAME" >/dev/null 2>&1; then
  info "同名容器已存在，先删掉重来"
  "$DOCKER_BIN" rm -f "$NAME" >/dev/null 2>&1 || fail "删不掉旧容器 $NAME"
fi

"$DOCKER_BIN" run -d --name "$NAME" \
  --network bridge --restart unless-stopped \
  -e "EGRESS_PORT=${PORT}" \
  -e "EGRESS_POLICY_FILE=${POLICY_FILE_CONTAINER}" \
  -e "EGRESS_MODEL_IDLE_TIMEOUT_MS=${MODEL_IDLE_TIMEOUT_MS}" \
  -v "$PROXY_SRC:/app/egress-proxy.mjs:ro" \
  -v "$ALLOW_DIR_HOST:/egress-allow:ro" \
  "$IMAGE" node /app/egress-proxy.mjs >/dev/null || fail "容器起不来（$DOCKER_BIN logs $NAME 看原因）"
ok "已启动（公网腿 = 默认 bridge）"

# -- 3. 接上沙箱腿 -----------------------------------------------------

step "接上沙箱腿 ${NET}"

if "$DOCKER_BIN" network connect "$NET" "$NAME" 2>/dev/null; then
  ok "已接入 ${NET}"
else
  # 已接入时 connect 会报错；确认一下到底是"已接入"还是真失败
  if "$DOCKER_BIN" network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}' | grep -qw "$NAME"; then
    info "本来就已经在 ${NET} 里"
  else
    fail "接入 ${NET} 失败"
  fi
fi

# 容器内的健康探针（此刻两条腿都在，先确认进程活着）
sleep 1
if "$DOCKER_BIN" exec "$NAME" node -e "fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  ok "代理进程在监听 ${PORT}"
else
  "$DOCKER_BIN" logs --tail 20 "$NAME" >&2
  fail "代理没起来（上面是容器日志）"
fi

# ★ 从**沙箱网里**再探一次：这才是"两条腿都对"的证明
if "$DOCKER_BIN" run --rm --network "$NET" "$IMAGE" \
     node -e "fetch('http://${NAME}:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  ok "从 ${NET} 里的容器可达 http://${NAME}:${PORT} —— 两条腿都对"
else
  fail "沙箱网里够不着 http://${NAME}:${PORT}（沙箱腿没接上？）"
fi

# -- 4. 结论 -----------------------------------------------------------

URL="http://${NAME}:${PORT}"
step 'Ready'
printf '  %sSANDBOX_EGRESS_PROXY_URL=%s%s\n\n' "$C_G" "$URL" "$C_X"

if [ "$WRITE_ENV" -eq 1 ]; then
  [ -f "$ENV_FILE" ] || fail "没有 ${ENV_FILE}（先从 infra/.env.example 复制一份）"
  old="$(env_value SANDBOX_EGRESS_PROXY_URL)"
  tmp="${ENV_FILE}.egress-tmp"
  awk -v v="$URL" '
    $0 ~ /^SANDBOX_EGRESS_PROXY_URL=/ { print "SANDBOX_EGRESS_PROXY_URL=" v; done=1; next }
    { print }
    END { if (!done) print "SANDBOX_EGRESS_PROXY_URL=" v }
  ' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  ok "已写进 infra/.env（原值：${old:-空}）"
  warn "后端是**启动时读 env** 的 ⇒ 要重启才生效：bash infra/scripts/dev-stop.sh && bash infra/scripts/dev-run.sh"
else
  info "写进 infra/.env 用：bash infra/scripts/egress-up.sh --write-env"
fi

cat <<EOF

  三条验证（比一个正例重要 —— 白名单的坏法是"看起来配了、其实全通"）。
  ⚠️ 用本仓的 egress-probe.mjs 而不是 \`fetch\`：Node 的全局 fetch **不读**代理环境变量
     （undici 默认 dispatcher 是裸 Agent）⇒ 直接 fetch 会误判成"代理不工作"。
     沙箱里能通是因为 pi 显式装了 \`undici.EnvHttpProxyAgent\`。

    PROBE='$SCRIPT_DIR/egress-probe.mjs'
    # ① 放行：OK 401（通了，只是没带 key）
    $DOCKER_BIN run --rm --network $NET -e HTTPS_PROXY=$URL -v "\$PROBE":/app/probe.mjs:ro $IMAGE \\
      node /app/probe.mjs https://tokenrhythm.studio/v1/models
    # ② 拦截：BLOCKED 403（不在白名单）
    $DOCKER_BIN run --rm --network $NET -e HTTPS_PROXY=$URL -v "\$PROBE":/app/probe.mjs:ro $IMAGE \\
      node /app/probe.mjs https://example.com/
    # ③ 无代理：FAIL（证明 internal 网真的没路由 ⇒ ① 的通不是"本来就通"）
    $DOCKER_BIN run --rm --network $NET -v "\$PROBE":/app/probe.mjs:ro $IMAGE \\
      node /app/probe.mjs https://tokenrhythm.studio/v1/models

  日志：$DOCKER_BIN logs -f $NAME
  停止：bash infra/scripts/egress-down.sh
  策略热更新：代理每 5s 轮询 ${POLICY_FILE_HOST}，平台改了策略会在 ≤5s 内生效（不用重启代理）
EOF

# -- 5. 出网策略自动同步（--watch / --daemon）--------------------------

# 常驻循环本体（函数 → 前台直调或后台子 shell 都能复用）
# 每轮从库（`egress_policy` + 模型池）重算策略、原子写文件；内容没变就不打日志。
watch_loop() {
  last_saved="$(cat "$POLICY_FILE_HOST" 2>/dev/null || true)"
  while true; do
    sleep "$WATCH_INTERVAL_SEC"
    compute_policy quiet
    write_policy_file
    local current
    current="$(cat "$POLICY_FILE_HOST" 2>/dev/null || true)"
    if [ "$current" != "$last_saved" ]; then
      last_saved="$current"
      ok "出网策略已同步 → 代理 ≤5s 内热更新（${current:-空}）"
    fi
  done
}

if [ "$WATCH" -eq 1 ]; then
  step "出网策略自动同步（每 ${WATCH_INTERVAL_SEC}s 从库刷新）"

  if [ "$NO_AUTO" -eq 1 ]; then
    warn "--watch/--daemon 与 --no-auto 同时出现：库里没有可刷的来源，只会在 --allow 变化时更新（但 --allow 是启动参数，运行中不变 ⇒ 实际上不会更新）"
  fi

  if [ "$DAEMON" -eq 1 ]; then
    if [ -f "$WATCH_PID_FILE" ] && kill -0 "$(cat "$WATCH_PID_FILE" 2>/dev/null)" 2>/dev/null; then
      info "同步已在常驻（pid $(cat "$WATCH_PID_FILE")），不重复起"
    else
      mkdir -p "$LOG_DIR" "$PID_DIR"
      : >"$WATCH_LOG"
      watch_loop </dev/null >>"$WATCH_LOG" 2>&1 &
      WATCH_PID=$!
      echo "$WATCH_PID" >"$WATCH_PID_FILE"
      ok "白名单同步已常驻（pid ${WATCH_PID}，日志 ${WATCH_LOG}）"
      info "停止：bash infra/scripts/egress-down.sh（容器 + 同步一起收）"
    fi
  else
    info "代理保持运行；Ctrl+C 只停同步循环（白名单停在最后一次一致状态）"
    watch_loop
  fi
fi
