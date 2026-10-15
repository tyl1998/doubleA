#!/usr/bin/env bash
# =====================================================================
# install-java-version.sh <版本>  —— 构建期装一个指定 JDK（P1-17a 增量）
#
# 【为什么要它】Debian bookworm 的 apt（含 backports）**只有 openjdk-17**，装不了 8 / 11 / 21 …
#   这里从 **Adoptium（Eclipse Temurin）** 官方 API 下 JDK tarball：
#     https://api.adoptium.net/v3/binary/latest/<ver>/ga/linux/<arch>/jdk/hotspot/normal/eclipse
#   参数 `ver` 是**特性版本**（`8` / `11` / `17` / `21` / …）。
#
# 【装到哪 / 怎么被找到】解到 `/opt/jdk-<ver>`，软链 `/usr/local/bin/{java,javac,jar,keytool,jshell}`
#   （PATH 里 /usr/local/bin 在前）。go / java / rust 在本层**独占**（toolkit 不带），故用**系统命令名**。
#   ⚠️ `maven` 由 `runtime/Dockerfile` 的 java 分支用 apt 另装（mvn 走 PATH 上的 `java` ⇒ 即本 JDK）。
#
# 【源可换】`JAVA_DIST_MIRROR` 环境变量（默认指向 Adoptium 的 binary/latest 前缀）。
# 【容器里没有 curl/wget】⇒ 用 base 自带 `node` 的 `fetch` 落盘（会自动跟随 Adoptium 的重定向）。
# =====================================================================

set -euo pipefail

version="${1:-}"
if [ -z "${version}" ]; then
  echo '用法: install-java-version.sh <特性版本，如 21 / 17 / 11 / 8>' >&2
  exit 1
fi

mirror="${JAVA_DIST_MIRROR:-https://api.adoptium.net/v3/binary/latest}"

case "$(uname -m)" in
  aarch64 | arm64) arch=aarch64 ;;
  x86_64 | amd64) arch=x64 ;;
  *)
    echo "不支持的 CPU 架构：$(uname -m)" >&2
    exit 1
    ;;
esac

url="${mirror}/${version}/ga/linux/${arch}/jdk/hotspot/normal/eclipse"
echo "安装 Temurin JDK ${version}（linux/${arch}）：${url}"

# 1) 下载（Adoptium 会 302 到实际 tarball；fetch 默认跟随重定向；流式落盘）。
node -e 'const { Readable } = require("node:stream"); const { pipeline } = require("node:stream/promises"); const fs = require("node:fs"); (async () => { const r = await fetch(process.argv[1]); if (!r.ok) throw new Error(String(r.status)); await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(process.argv[2])); })().catch((e) => { console.error(String(e)); process.exit(1); })' "${url}" /tmp/jdk.tar.gz

# 2) 解到 /opt/jdk-<ver>（tarball 顶层是 `jdk-<full>/`，用 strip-components 抹掉）。
dest="/opt/jdk-${version}"
rm -rf "${dest}"
mkdir -p "${dest}"
tar -xzf /tmp/jdk.tar.gz -C "${dest}" --strip-components=1
rm -f /tmp/jdk.tar.gz

# 3) 软链系统命令名（PATH 里 /usr/local/bin 在前）。
for bin in java javac jar keytool jshell javadoc; do
  if [ -x "${dest}/bin/${bin}" ]; then
    ln -sf "${dest}/bin/${bin}" "/usr/local/bin/${bin}"
  fi
done

# 4) 非 root（agent）也要能读/执行。
chmod -R a+rX "${dest}"

# 5) 断言能跑（并核对特性版本；8 显示成 `1.8.0_…`，故 `(1\.)?` 兼容）。
java -version
java -version 2>&1 | grep -qE "version \"(1\.)?${version}" || { echo "JDK 版本不符：期望 ${version}" >&2; exit 1; }
javac -version
echo "java 就绪：$(readlink -f /usr/local/bin/java)"
