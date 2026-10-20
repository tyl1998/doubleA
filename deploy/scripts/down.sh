#!/usr/bin/env bash
# =====================================================================
# down.sh —— 停服务（Linux / macOS，纯 docker，不用 compose）
#
#   bash scripts/down.sh            # 停应用容器（后端/网关/前端/egress/relay/侧车），保留依赖与数据
#   bash scripts/down.sh --all      # 连依赖服务一起停（数据卷保留）
#   bash scripts/down.sh --purge    # ⚠️ 连数据卷一起删（数据库/对象存储全丢）
#
# ⚠️ 后端用 `docker stop`（SIGTERM → 优雅退出 → 摘掉实例注册键），不要 `rm -f`：
#    强杀会让 sandbox:instance:<id> 键留到 TTL 过期，那期间同 id 的新实例会撞冲突。
# =====================================================================

set -uo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

all=0; purge=0
NODE_ENV_FILE=''; SHARED_ENV_FILE_ARG=''
while [ $# -gt 0 ]; do
  case "$1" in
    --all) all=1 ;;          # 只对 MANAGE_INFRA=1 有意义
    --purge) all=1; purge=1 ;;
    # 与 up.sh 同一组兼容参数：只用来算出**实例 id**（容器名要靠它）
    --env)    shift; NODE_ENV_FILE="${1:-}" ;;
    --shared) shift; SHARED_ENV_FILE_ARG="${1:-}" ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "未知参数：$1（见 --help）" ;;
  esac
  shift
done

if [ -n "$NODE_ENV_FILE" ] && [ -z "${DEPLOY_ENV_FILE:-}" ]; then
  [ -f "$NODE_ENV_FILE" ] || die "找不到 $NODE_ENV_FILE"
  DEPLOY_ENV_FILE="$(mktemp -t doubulea-down-XXXXXX.env)"
  export DEPLOY_ENV_FILE
  synth_from_two_envs "$NODE_ENV_FILE" "${SHARED_ENV_FILE_ARG:-}" >"$DEPLOY_ENV_FILE"
  trap 'rm -f "$DEPLOY_ENV_FILE"' EXIT
fi

# down 不校验必填（配置可能已删），但**必须**知道实例 id 才能算出容器名
MODE="$(env_get MODE all)"
INSTANCE_ID="$(env_get INSTANCE_ID local)"
assign_container_names
info "实例 ${INSTANCE_ID} ⇒ 容器 ${C_BACKEND} / ${C_GATEWAY} / ${C_FRONTEND}"

step '停止应用容器'

# ★ 只停**本实例自己的**容器（2026-10-20 修）：以前这里无条件 `drop` 前端/网关，
#   MODE=node 的机器跑一次 down 会把**主节点**的网关/前端一起删掉（它们不在本机的
#   MODE 管辖范围，`up.sh` 也不会重建）⇒ 只能靠 compose 手工拉回来，而且形态就变了。
#   现在按 MODE 决定范围 + 组件**共享容器名**时才对"最后一家"动手（见下方 *）。

# ① 网关 / 前端：只有 MODE=all 的机器才会创建它们
if [ "$MODE" = 'all' ]; then
  for c in "$C_FRONTEND" "$C_GATEWAY"; do
    if running "$c"; then docker stop --timeout 15 "$c" >/dev/null 2>&1 && ok "$c"; fi
    drop "$c"
  done
else
  info "MODE=$MODE ⇒ 本机不起网关/前端，跳过（不会碰别人的）"
fi

# ② 沙箱外围是**全机共享**的固定名（后端自检按名字认它们）：
#    只有在"这就是本机最后一个实例"时才停，否则另一个实例会立刻变成未就绪。
other_instances() {
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -E "^doubulea-backend(-.+)?$" | grep -vxF -e "$C_BACKEND"
}
others="$(other_instances || true)"
if [ -n "$others" ]; then
  info "同机还有其它实例在跑（$(echo "$others" | tr '\n' ' ')）⇒ egress / relay / docker-cli 保留"
else
  for c in "$C_EGRESS" "$C_RELAY" "$C_DOCKER_CLI"; do
    if running "$c"; then docker stop --timeout 15 "$c" >/dev/null 2>&1 && ok "$c"; fi
    drop "$c"
  done
fi

# ③ 后端最后停（优雅退出能让网关立刻把它摘出候选）
if exists "$C_BACKEND"; then
  docker stop --timeout 25 "$C_BACKEND" >/dev/null 2>&1 && ok "$C_BACKEND 已优雅退出" || warn "$C_BACKEND 停止超时，强杀"
  drop "$C_BACKEND"
fi

# ⚠️ 基础服务**只在本包管理时**才停（MANAGE_INFRA=1）；默认一行不碰
if [ "$all" -eq 1 ] && [ "$(env_get MANAGE_INFRA 0)" = '1' ]; then
  step '停止基础服务（MANAGE_INFRA=1）'
  for c in "$C_MINIO" "$C_REDIS" "$C_PG"; do
    if exists "$c"; then docker stop --timeout 20 "$c" >/dev/null 2>&1 && ok "$c"; fi
    [ "$purge" -eq 1 ] && drop "$c"
  done
  if [ "$purge" -eq 1 ]; then
    docker volume rm -f doubulea-deploy-pgdata doubulea-deploy-redisdata doubulea-deploy-miniodata >/dev/null 2>&1 || true
    warn '数据卷已删除（--purge）'
  fi
elif [ "$all" -eq 1 ]; then
  info 'MANAGE_INFRA=0 ⇒ 基础服务不归本包管，跳过（未停止 PG/Redis/MinIO）'
fi

printf '\n  已停止应用容器。重新启动：bash scripts/up.sh\n\n'
