#!/usr/bin/env bash
# =====================================================================
# install-go-version.sh <版本>  —— 构建期装一个指定 Go 工具链（P1-17a 增量）
#
# 【为什么要它】Debian bookworm 的 apt 只有 `golang-1.19`（backports 到 1.23），无法覆盖任意版本；
#   这里从 **go.dev 官方发行站**下官方 tarball（`go<full>.linux-<arch>.tar.gz`），解到 `/usr/local/go`。
#
# 【版本形态】可给大版本/小版本（`1.22`）—— 会去 `?mode=json&include=all` 里解析出该线**最新补丁**
#   （如 `1.22.12`）；也可给完整版本（`1.22.12`）。
#
# 【装到哪 / 怎么被找到】解到 `/usr/local/go`，软链 `/usr/local/bin/go` / `gofmt`（PATH 里在前）。
#   go 由可执行文件真实路径推 `GOROOT` ⇒ 软链后仍正确。go / java / rust 在本层**独占**（toolkit 不带），
#   故用**系统命令名**（不需要 `go<版本>`）。
#
# 【源可换】`GO_DIST_MIRROR` 环境变量（默认 `https://go.dev/dl`）。
# 【容器里没有 curl/wget】⇒ 用 base 自带 `node` 的 `fetch` 落盘。
# =====================================================================

set -euo pipefail

version="${1:-}"
if [ -z "${version}" ]; then
  echo '用法: install-go-version.sh <版本，如 1.22 / 1.22.12>' >&2
  exit 1
fi

mirror="${GO_DIST_MIRROR:-https://go.dev/dl}"

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *)
    echo "不支持的 CPU 架构：$(uname -m)" >&2
    exit 1
    ;;
esac

# 1) 解析出该版本线的**最新补丁**（`1.22` → `1.22.12`；已是完整版本则原样返回）。
full="$(node -e '
const want = String(process.argv[1] || "").replace(/^go/, "");
fetch("https://go.dev/dl/?mode=json&include=all")
  .then((r) => r.json())
  .then((list) => {
    const nums = list
      .map((x) => String(x.version || "").replace(/^go/, ""))
      .filter((v) => v === want || v.startsWith(want + "."));
    if (nums.length === 0) { console.error("找不到 Go 版本：" + want); process.exit(1); }
    const cmp = (a, b) => { const A = a.split(".").map(Number); const B = b.split(".").map(Number); for (let i = 0; i < 3; i += 1) { const d = (A[i] || 0) - (B[i] || 0); if (d !== 0) return d; } return 0; };
    nums.sort(cmp);
    process.stdout.write(nums[nums.length - 1]);
  })
  .catch((e) => { console.error(String(e)); process.exit(1); });
' "${version}")"
echo "安装 Go ${full}（linux/${arch}）"

# 2) 下载官方 tarball（流式落盘）。
url="${mirror}/go${full}.linux-${arch}.tar.gz"
node -e 'const { Readable } = require("node:stream"); const { pipeline } = require("node:stream/promises"); const fs = require("node:fs"); (async () => { const r = await fetch(process.argv[1]); if (!r.ok) throw new Error(String(r.status)); await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(process.argv[2])); })().catch((e) => { console.error(String(e)); process.exit(1); })' "${url}" /tmp/go.tar.gz

# 3) 解到 /usr/local/go（tarball 里就是 `go/` 目录）。
rm -rf /usr/local/go
tar -xzf /tmp/go.tar.gz -C /usr/local
rm -f /tmp/go.tar.gz

# 4) 软链系统命令名（PATH 里 /usr/local/bin 在前）。
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# 5) 非 root（agent）也要能读/执行。
chmod -R a+rX /usr/local/go

# 6) 断言能跑（并核对版本线）。
go version
go version | grep -qF "go${full}" || { echo "Go 版本不符：期望 ${full}" >&2; exit 1; }
echo "go 就绪：$(readlink -f /usr/local/bin/go)"
