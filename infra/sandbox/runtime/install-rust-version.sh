#!/usr/bin/env bash
# =====================================================================
# install-rust-version.sh <版本>  —— 构建期装一个指定 Rust 工具链（P1-17a 增量）
#
# 【为什么要它】Debian bookworm 的 apt 只有 `rustc 1.63`，装不了别的版本。这里用 **rust-lang 官方
#   standalone 安装包**（不是 rustup）：下 `rust-<full>-<target>.tar.gz`，跑其中的 `install.sh`
#   装到 `/usr/local`（`rustc` / `cargo` 直接进 PATH）。
#   ⚠️ **刻意不用 rustup**：rustup 的代理二进制要靠 `RUSTUP_HOME` 环境变量在**运行期**才能找到
#      toolchain，而容器运行期不注入该 env（rootfs 只读、CARGO_HOME 落 tmpfs）⇒ 用 standalone 免掉这层。
#
# 【版本形态】`stable` / `beta` / `nightly`（去 `channel-rust-<channel>.toml` 解析出具体版本），
#   或直接给完整版本（`1.80.0`）。
#
# 【装到哪 / 怎么被找到】装到 `/usr/local`（bin 进 PATH）。go / java / rust 在本层**独占**（toolkit 不带），
#   故用**系统命令名**。
#
# 【源可换】`RUST_DIST_MIRROR` 环境变量（默认 `https://static.rust-lang.org/dist`）。
# 【容器里没有 curl/wget】⇒ 用 base 自带 `node` 的 `fetch` 落盘。
# =====================================================================

set -euo pipefail

version="${1:-stable}"
if [ -z "${version}" ]; then
  echo '用法: install-rust-version.sh <版本，如 stable / 1.80.0>' >&2
  exit 1
fi

mirror="${RUST_DIST_MIRROR:-https://static.rust-lang.org/dist}"

case "$(uname -m)" in
  aarch64 | arm64) target=aarch64-unknown-linux-gnu ;;
  x86_64 | amd64) target=x86_64-unknown-linux-gnu ;;
  *)
    echo "不支持的 CPU 架构：$(uname -m)" >&2
    exit 1
    ;;
esac

# 1) 解析具体版本（stable/beta/nightly → 形如 1.80.0；已是数字版本则原样）。
case "${version}" in
  stable | beta | nightly)
    # ⚠️ channel toml 里第一个 `version =` 是 cargo 的（形如 `0.100.0`）⇒ 必须取 `[pkg.rust]` 段的，
    #    且其值带哈希后缀（`1.99.0 (b940084d7 2026-09-28)`）⇒ 取第一个空白前的部分。
    full="$(node -e 'fetch(process.argv[1]).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text() }).then((t) => { const m = /\[pkg\.rust\]\s+version\s*=\s*"([^"]+)"/.exec(t); if (!m) { console.error("解析 channel 版本失败"); process.exit(1); } process.stdout.write(m[1].split(" ")[0]); })' "${mirror}/channel-rust-${version}.toml")"
    ;;
  *)
    full="${version}"
    ;;
esac
echo "安装 Rust ${full}（${target}）"

# 2) 下载 standalone 安装包（流式落盘；官方源在本机实测被限速到几十 KB/s ⇒ 建议换镜像）。
url="${mirror}/rust-${full}-${target}.tar.gz"
node -e 'const { Readable } = require("node:stream"); const { pipeline } = require("node:stream/promises"); const fs = require("node:fs"); (async () => { const r = await fetch(process.argv[1]); if (!r.ok) throw new Error(String(r.status)); await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(process.argv[2])); })().catch((e) => { console.error(String(e)); process.exit(1); })' "${url}" /tmp/rust.tar.gz

# 3) 解包并跑官方 install.sh（装到 /usr/local；跳过 docs 省体积）。
rm -rf /tmp/rust-install
mkdir -p /tmp/rust-install
tar -xzf /tmp/rust.tar.gz -C /tmp/rust-install
rm -f /tmp/rust.tar.gz
cd /tmp/rust-install
"./rust-${full}-${target}/install.sh" --prefix=/usr/local --without=rust-docs --disable-ldconfig
cd /tmp
rm -rf /tmp/rust-install

# 4) 非 root（agent）也要能读/执行（lib/rustlib 里有标准库）。
chmod -R a+rX /usr/local/lib/rustlib 2>/dev/null || true

# 5) 断言能跑。
rustc --version
cargo --version
rustc --version | grep -qF "${full}" || { echo "Rust 版本不符：期望 ${full}" >&2; exit 1; }
echo "rustc 就绪：$(command -v rustc)"
