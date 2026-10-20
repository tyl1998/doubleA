#!/usr/bin/env bash
# =====================================================================
# status.sh —— 看一眼当前状态（Linux / macOS，只读，不启停任何东西）
#
#   bash scripts/status.sh
# =====================================================================

set -uo pipefail
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

INSTANCE_ID="$(env_get INSTANCE_ID local)"
assign_container_names
bp="$(env_get BACKEND_PORT 13000)"
gp="$(env_get GATEWAY_PORT 13100)"
fp="$(env_get FRONTEND_PORT 8080)"

step '容器'
printf '  %-26s %-22s %s\n' NAME STATUS PORTS
# 本实例的容器在前；再补上**同宿主其它实例**（名字带 -<id> 后缀的那些），
# 否则「a 在跑、我配的是 demo」时只会看到一半容器，容易误判。
# ⚠️ 去重：本实例的名字本身就带后缀，扫描会把它再列一次（否则同一行出现两遍）
OTHER=$(docker ps -a --format '{{.Names}}' 2>/dev/null \
  | grep -E '^doubulea-(backend|gateway|frontend)-' \
  | grep -vxF -e "$C_BACKEND" -e "$C_GATEWAY" -e "$C_FRONTEND" | tr '\n' ' ')
for c in "$C_PG" "$C_REDIS" "$C_MINIO" "$C_BACKEND" "$C_DOCKER_CLI" "$C_EGRESS" "$C_RELAY" "$C_GATEWAY" "$C_FRONTEND" $OTHER; do
  if exists "$c"; then
    line="$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)"
    ports="$(docker inspect -f '{{range $p, $v := .NetworkSettings.Ports}}{{if $v}}{{(index $v 0).HostPort}} {{end}}{{end}}' "$c" 2>/dev/null)"
    printf '  %-26s %-22s %s\n' "$c" "${line:-unknown}" "${ports:-—}"
  else
    printf '  %-26s %-22s %s\n' "$c" '（不存在）' '—'
  fi
done

step '健康检查'
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsS --noproxy '*' --max-time 3 "$1" 2>/dev/null
  else node -e "fetch('$1').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" 2>/dev/null; fi
}

body="$(http_get "http://127.0.0.1:$bp/health")" && {
  ok "后端  http://127.0.0.1:$bp/health"
  printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s).data;console.log(`        实例 ${j.instanceId}  状态 ${j.status}  已运行 ${j.uptimeSec}s`);const bad=(j.checks||[]).filter(c=>!c.ok);if(bad.length)console.log("        依赖异常："+bad.map(c=>c.target).join(", "))}catch{}})' 2>/dev/null
} || warn "后端  不可达 http://127.0.0.1:$bp/health"

gbody="$(http_get "http://127.0.0.1:$gp/health")" && {
  ok "网关  http://127.0.0.1:$gp/health"
} || warn "网关  不可达 http://127.0.0.1:$gp/health"

http_get "http://127.0.0.1:$fp/" >/dev/null && ok "前端  http://127.0.0.1:$fp/" || warn "前端  不可达 http://127.0.0.1:$fp/"

if [ -n "${gbody:-}" ]; then
  step '实例（网关视角）'
  printf '%s' "$gbody" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const d=JSON.parse(s), disc=d.discovery||{};
    console.log("  上游表    "+((d.upstreams||[]).join("  ")||"（空）"));
    console.log("  自动发现  "+((disc.discovered||[]).join("  ")||"（无）"));
    console.log("  未就绪    "+((disc.unready||[]).join("  ")||"（无）"));
    for (const [t,l] of Object.entries(d.load||{}))
      console.log(`  ${t}  槽位 ${l.slotsUsed}/${l.slotsTotal}  队列 ${l.queueDepth}  负载 ${Math.round((l.ageMs||0)/1000)}s 前`);
  }catch{console.log("  （无法解析网关响应）")}
})' || true
fi

printf '\n  加机器：改 deploy.env（INSTANCE_ID / INSTANCE_IP / MODE=node）后 bash scripts/up.sh\n\n'
