#!/bin/sh
# 把 Debian 源换成 `$1`（**主机名** 或 `http(s)://host[:port]`），并处理"容器到底能不能出网"的三种现实：
#
#   · 给的是**主机名**时一律用 **HTTP**（国内镜像的 HTTPS 常要另配证书 / 证书链不全）；
#     要 HTTPS 就显式写 `https://host`。
#   · `$1` 为空 ⇒ 只做下面的 IPv4 / 闸门，源保持镜像原样（= 官方 deb.debian.org）。
#   · IPv6 兜底：很多内网/公司出口**没有 IPv6 路由**，而解析常先给 AAAA ⇒ apt 卡在
#     `Ign:` 上每行重试 3×60s（一条 `apt-get update` 能挂 12 分钟，正是"一键部署卡在 apt"的样子）。
#     这里按容器真实路由决定是否写 `Acquire::ForceIPv4`。
#   · 通了但极慢：apt 对"慢"只会一直 `Wait for headers`/`Ign:`，看起来和卡死一样（实测官方源在
#     一个只能出公网 443 的出口上是 28 KB/s ⇒ 一条 update 要 5 分半）。故默认带 **网速闸门**
#     （`APT_MIN_BPS`，默认 32 KB/s，`sandbox-build.mjs` 用 `--apt-min-bps` 注入；`0` = 关）：
#     速度不达标 ⇒ 停 apt、换下一个候选源。
#   · 候选顺序：替换源 → 其它国内镜像（`APT_FALLBACK_MIRRORS`，默认 ustc/nju）→ 最后才回官方源；
#     全都不行才打印可操作提示并以 100 退出（让 build 明确失败，而不是后面装包时报"没有安装候选"）。
#
# ⚠️ **这个文件在 base / toolkit / runtime 三个构建上下文里各有一份**（内容必须**逐字相同**：
#    `infra/scripts/sandbox-build.mjs` 与 `backend/src/sandbox/runtimeBuild.ts` 会校验，不一致直接拒建）。
#    为什么复制而不是软链：`docker build` 的上下文**不跟随软链**，也不许 `COPY ../x`（越界）⇒
#    共享一份就只能改 Dockerfile 的 `-f`/上下文布局，那会牵动自举链路，代价更大。
#
# 用法（Dockerfile）：
#   COPY apt-source.sh /usr/local/bin/
#   RUN sh /usr/local/bin/apt-source.sh "${APT_MIRROR}"; apt-get install -y --no-install-recommends ...
# ⚠️ 同一个 RUN 里换源后若忽略 `apt-get update` 的失败继续装，lists 是空的 ⇒ 报
#    `Package 'ca-certificates' has no installation candidate`，看起来像"源的问题"、其实是没网。
# ⚠️ 只换"官方 host"这一处，不改 suite / components。
set -u

MIRROR="${1:-}"
SOURCES=/etc/apt/sources.list.d/debian.sources
LEGACY=/etc/apt/sources.list
OFFICIAL=deb.debian.org

restore() {
  [ -f "$SOURCES.orig" ] && cp -f "$SOURCES.orig" "$SOURCES"
  [ -f "$LEGACY.orig" ] && cp -f "$LEGACY.orig" "$LEGACY"
}

# 把 `$1` 写进 sources（deb822 的 `URIs:` 与老式单行都支持）
# ⚠️ 每次都从**原始备份**改（不是在上一次的改写结果上再改）：否则第二个候选源会匹配不到
#    官方 host、sources 还停在上一个源的地址上 —— 实测表现是"换了源却还在拉前一个源"。
apply_mirror() {
  if [ -f "$SOURCES.orig" ]; then
    cp -f "$SOURCES.orig" "$SOURCES"
    sed -i "s|^URIs: [a-z]*://${OFFICIAL}|URIs: $1|" "$SOURCES"
  fi
  if [ -f "$LEGACY.orig" ]; then
    cp -f "$LEGACY.orig" "$LEGACY"
    sed -i "s|[a-z]*://${OFFICIAL}|$1|g" "$LEGACY"
  fi
}

# 候选源（按顺序试；**主机名**会在下面补 `http://`）：
#   ① 第一个用 `APT_MIRROR`（sandbox-build 默认清华 / 后端用 `SANDBOX_APT_MIRROR`）；
#   ② 后面几个用 `APT_FALLBACK_MIRRORS`（逗号分隔，默认 ustc + nju）；显式给空串 = 不回退。
#   ③ 全都不行才回官方源（在只放行 443 的出口上它只 28 KB/s，所以排在最后）。
export APT_CANDIDATES="${MIRROR}${MIRROR:+,}${APT_FALLBACK_MIRRORS-mirrors.ustc.edu.cn,mirrors.nju.edu.cn}"

if [ -f "$SOURCES" ] || [ -f "$LEGACY" ]; then
  [ -f "$SOURCES.orig" ] || { [ -f "$SOURCES" ] && cp -f "$SOURCES" "$SOURCES.orig"; }
  [ -f "$LEGACY.orig" ] || { [ -f "$LEGACY" ] && cp -f "$LEGACY" "$LEGACY.orig"; }
fi

# ⚠️ 只给主机名时必须补 scheme：写进 deb822 的 `URIs:` 若没有 `http://`，apt 直接报
#    `E: Malformed entry 1 in sources file … (URI parse)`，随后整份 sources 不可读
#    ⇒ 症状是"明明换了清华源却还在拉官方源"（2026-10-20 实际撞到过）。
normalize() {
  case "$1" in
    *://*) echo "$1" ;;
    *)     echo "http://$1" ;;
  esac
}

echo "== 候选源：${APT_CANDIDATES} =="

if ip -6 route show default 2>/dev/null | grep -q default; then
  echo '== 容器有 IPv6 默认路由 ⇒ 不改 apt 的地址族选择 =='
else
  echo '== 无 IPv6 默认路由 ⇒ apt 强制 IPv4（否则 AAAA 先解析会 Ign: 重试到超时）=='
  printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4
fi

# 网速闸门：apt 对"慢"没有超时语义 ⇒ 用 `timeout` 把一次 update 关在 `APT_UPDATE_TIMEOUT` 秒内；
# 跑完用"下载字节数 ÷ 耗时"算 KB/s，不够 `APT_MIN_BPS` 就判该源失败。
# ⚠️ 只影响构建期，不进镜像。
# ⚠️ 默认 32 而不是 60：实测官方源在"只放行 443"的出口上是 **28–68 KB/s 且抖动**，
#    60 的闸门会把镜像源和官方源一起判死（9 MB 索引约 3 分钟，还能接受）。要更快就调高。
MIN_BPS="${APT_MIN_BPS:-32}"
UPDATE_TIMEOUT="${APT_UPDATE_TIMEOUT:-180}"

update_once() {
  # ⚠️ `--mount=type=cache,target=/var/lib/apt/lists` 是 **tmpfs**，`du` 在它上面报 0
  #    （实测 9 MB 索引仍显示 0 KB）⇒ 速率改用 "本次下载的字节数 ÷ 耗时"，取输出里的 TB 行。
  started=$(date +%s)
  LOG=/tmp/apt-update.log
  if [ "$UPDATE_TIMEOUT" != 0 ] && command -v timeout >/dev/null 2>&1; then
    timeout "$UPDATE_TIMEOUT" apt-get update 2>&1 | tee "$LOG"
  else
    apt-get update 2>&1 | tee "$LOG"
  fi
  # ⚠️ 管道 ⇒ `$?` 是 tee 的，不能用来判 apt 的成败（而且 apt 在所有源都 Err 时也可能返回 0：
  #    "Some index files failed to download … they have been ignored"）⇒ 只看输出里的 `Err:`/`E:`。
  rc=0
  if grep -qE '^(Err|E):' "$LOG"; then
    rc=1
  fi
  elapsed=$(( $(date +%s) - started ))
  [ "$elapsed" -lt 1 ] && elapsed=1
  # 单位可能是 B / kB / MB（apt 按大小自动换）⇒ 逐行折算成 KB 再求和。
  # ⚠️ 尺寸字段带方括号（`[8689 kB]`）⇒ 先把方括号去掉再按空格取字段（实测不去括号会全 0）。
  kb=$(tr -d '[],' < "$LOG" | awk '
    /^Get:[0-9]+/ {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^(B|kB|MB|GB)$/ && i > 1) {
          v = $(i-1) + 0
          if ($i == "B") v = v / 1024
          else if ($i == "MB") v = v * 1024
          else if ($i == "GB") v = v * 1024 * 1024
          s += v
          break
        }
      }
    }
    END { printf "%d\n", s }')
  kb=${kb:-0}
  [ "$kb" -lt 0 ] && kb=0
  bps=$(( kb / elapsed ))
  echo "== apt-get update：退出码 ${rc}，耗时 ${elapsed}s，下载 ${kb} KB ⇒ ${bps} KB/s（下限 ${MIN_BPS}，上限 ${UPDATE_TIMEOUT}s）==" >&2
  [ "$rc" -ne 0 ] && return 1
  if [ "$MIN_BPS" -gt 0 ] && [ "$bps" -lt "$MIN_BPS" ]; then
    echo "== 速度 ${bps} KB/s 低于 ${MIN_BPS} KB/s 的闸门 ⇒ 判该源不可用 ==" >&2
    return 1
  fi
  return 0
}

TRIED_ANY=0
OLD_IFS=$IFS
IFS=,
for CANDIDATE in $APT_CANDIDATES; do
  IFS=$OLD_IFS
  [ -n "$CANDIDATE" ] || continue
  URL=$(normalize "$CANDIDATE")
  echo "== Debian 源 → ${URL} =="
  apply_mirror "$URL"
  TRIED_ANY=1
  if update_once; then
    exit 0
  fi
done
IFS=$OLD_IFS

if [ "$TRIED_ANY" = 1 ]; then
  echo "== 所有候选镜像源都不可用 ⇒ 恢复镜像原始源（${OFFICIAL}）作为最后手段 ==" >&2
  restore
  if update_once; then
    exit 0
  fi
fi

echo '== apt-get update 失败：这个构建容器连不上（或慢到不可用）任何一个 Debian 源 ==' >&2
echo '   ① 有内网镜像 ⇒ 给后端容器设 SANDBOX_APT_MIRROR=<host>（默认走 HTTP，如 mirrors.ustc.edu.cn 或 http://内网mirror:8080）后重启，再点「一键初始化」；' >&2
echo '   ② 或在一台能出网的机器上构建好沙箱镜像，docker save / docker load 导入本节点（见 README「新节点需要哪些镜像」）。' >&2
exit 100
