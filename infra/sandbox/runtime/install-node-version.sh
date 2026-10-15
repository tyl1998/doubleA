#!/usr/bin/env bash
# =====================================================================
# install-node-version.sh <版本>  —— 构建期为"版本化运行时"装一个指定 Node.js（P1-17a 增量）
#
# 【为什么要它】base 层是 `node:22-…`，容器里只有 **Node 22**（pi 依赖它、不能动）。要别的版本
#   （20 / 18 / …）就得**构建期**另装一个（运行期装版本违背"运行时预烘焙"的定案，且 egress 只放行注册表）。
#   这里从 **Node 官方发行站**下官方二进制 tarball，与系统 `node` **并存**、各叫各的名字。
#
# 【装到哪 / 怎么被找到】
#   · 解包进 `/opt/node-v<版本>`（**不是 root 家目录** —— 运行期容器用户是 `agent`，读不到 /root）；
#     装完 `chmod -R a+rX` 让 agent 能执行。
#   · **软链** `/usr/local/bin/node<版本>` / `npm<版本>` / `npx<版本>` → 该发行版（PATH 里 /usr/local/bin 在前）
#     ⇒ 用户在容器里直接 `node20 -m …` / `npm20 ci` 即可。
#   · ⚠️ **不动系统 `node`**（那仍是 base 的 22）：多版本**并存**，各叫各的名字。
#
# 【版本形态】大版本（`20`）走发行站的 `latest-v20.x/`（自动取该线最新补丁）；含点的完整版本
#   （`20.11.1`）走 `v20.11.1/`。
#
# 【源可换】`NODE_DIST_MIRROR` 环境变量（由 `runtime/Dockerfile` 的 build-arg 注入）可指向镜像站
#   （如 `https://registry.npmmirror.com/-/binary/node`）；默认走官方 `https://nodejs.org/dist`。
#
# 【容器里没有 curl/wget】⇒ 下载一律用 base 自带 `node` 的全局 `fetch` 落盘（同 toolkit 的取数约定）。
#   下完**校验 sha256**（哈希取自同目录的 `SHASUMS256.txt`），校验不过就让 build **红**。
# =====================================================================

set -euo pipefail

version="${1:-}"
if [ -z "${version}" ]; then
  echo '用法: install-node-version.sh <版本，如 20 / 20.11.1>' >&2
  exit 1
fi

mirror="${NODE_DIST_MIRROR:-https://nodejs.org/dist}"

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *)
    echo "不支持的 CPU 架构：$(uname -m)" >&2
    exit 1
    ;;
esac

# 大版本 → `latest-v<ver>.x`（取该线最新补丁）；完整版本 → `v<ver>`。
if printf '%s' "${version}" | grep -q '\.'; then
  base="${mirror}/v${version}"
else
  base="${mirror}/latest-v${version}.x"
fi

# 1) 拉 SHASUMS256.txt，解析出该版本 / 该架构的 tarball 名与哈希。
sums="$(node -e 'fetch(process.argv[1]).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text() }).then((t) => process.stdout.write(t))' "${base}/SHASUMS256.txt")"
line="$(printf '%s\n' "${sums}" | grep -E "node-v${version}(\.[0-9]+)*-linux-${arch}\.tar\.gz$" | head -n1)"
if [ -z "${line}" ]; then
  echo "在 ${base}/SHASUMS256.txt 里找不到 node-v${version}*-linux-${arch}.tar.gz" >&2
  exit 1
fi
sha="$(printf '%s\n' "${line}" | awk '{print $1}')"
file="$(printf '%s\n' "${line}" | awk '{print $2}')"
echo "安装 Node.js ${file}（sha256 ${sha}）"

# 2) 下载（用 base 自带 node 的 fetch **流式**落盘，避免把整包读进内存）。
node -e 'const { Readable } = require("node:stream"); const { pipeline } = require("node:stream/promises"); const fs = require("node:fs"); (async () => { const r = await fetch(process.argv[1]); if (!r.ok) throw new Error(String(r.status)); await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(process.argv[2])); })().catch((e) => { console.error(String(e)); process.exit(1); })' "${base}/${file}" /tmp/node.tar.gz

# 3) 校验（哈希取自官方 SHASUMS256.txt）。
echo "${sha}  /tmp/node.tar.gz" | sha256sum -c -

# 4) 解包到 /opt/node-v<版本>（与 base 的 node 并存，不动它）。
dest="/opt/node-v${version}"
rm -rf "${dest}"
mkdir -p "${dest}"
tar -xzf /tmp/node.tar.gz -C "${dest}" --strip-components=1
rm -f /tmp/node.tar.gz

# 5) 软链成 node<版本> / npm<版本> / npx<版本>（PATH 里 /usr/local/bin 在前）。
ln -sf "${dest}/bin/node" "/usr/local/bin/node${version}"
ln -sf "${dest}/bin/npm" "/usr/local/bin/npm${version}"
ln -sf "${dest}/bin/npx" "/usr/local/bin/npx${version}"

# 6) 非 root（agent，uid 10001）也要能读/执行。
chmod -R a+rX "${dest}"

# 7) 断言能跑（跑不起来就让 build 红，别等派活时才在引擎 stderr 里现形）。
"node${version}" --version
"npm${version}" --version
echo "node${version} 就绪：$(readlink -f "/usr/local/bin/node${version}")"
