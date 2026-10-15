# 沙箱**运行时层**（P1-17a）—— 依据 `docs/子方案/Code模式工作区.md` §五之二 2
#
# ⚠️ 同 base/toolkit：**刻意不写 `# syntax=docker/dockerfile:1`**（没用 BuildKit 独有语法，
#    而那条指令会去拉一份外部 frontend 镜像，本机曾因此 403）。理由详见 base/Dockerfile 头部。
# ═══════════════════════════════════════════════════════════════════════════
# 【这一层解的是什么】
#   Code 会话要"跑项目"（`npm test` / `pytest` / `go build` / `mvn` / `cargo`），而 toolkit 只有
#   python3 + 常用 CLI。本层按 `COMPONENTS` 给最终镜像**补语言运行时**（预烘焙）。
#   ★ **只装运行时、不装依赖**（依赖是无限集合、不能白名单，运行期经注册表拉，见 P1-17b）。
#
# 【COMPONENTS —— "任意组合"，2026-10-15 起版本也不再枚举】
#   本层接受一个**语言清单** `COMPONENTS=lang=ver,lang=ver,…`（如 `python=3.12,node=20`）。
#   ⇒ 后端在**用户勾了语言、填了版本后按需 `docker build`**（把同一份 Dockerfile 复用），
#     运维不必预先猜组合、也不必为每个组合/版本手改这里。
#   约定：`lang ∈ {node, python, go, java, rust}`；`ver` 是该语言的版本字符串。
#   各语言的**装法**（版本不再枚举；装法落在这几个脚本里）：
#     · node：`22` = base 自带；其余 = `install-node-version.sh`（官方发行站 tarball → `node<ver>`）；
#     · python：`3.11` = 系统自带；其余 = `install-python-version.sh`（uv 从 pypi 拉 → `python<ver>`）；
#     · go：`install-go-version.sh`（go.dev 官方 tarball → 系统 `go`）；
#     · java：`install-java-version.sh`（Adoptium/Temurin → 系统 `java`/`javac`，另装 maven）；
#     · rust：`install-rust-version.sh`（rust-lang 官方 standalone → 系统 `rustc`/`cargo`）。
#   ⚠️ node / python 有 base/toolkit 必须保留的固定版本（pi 用 node 22、pandas 挂 python 3.11）⇒
#      非自带版本一律**带版本号的命令名**（`node20` / `python3.12`）；go / java / rust 本层独占 ⇒ 用系统命令名。
#   ⚠️ 空 `COMPONENTS` = 不装语言运行时（只有 toolkit），等价于 `none`。
#
# ⚠️ 不要手敲 docker build：`BASE_IMAGE` / `COMPONENTS` 由 `pnpm sandbox:build` 或后端注入；
#    缺参数会在下面第一道断言上大声失败，而不是默默烤出一个"不知道装了什么"的镜像。
# ═══════════════════════════════════════════════════════════════════════════

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG COMPONENTS
ARG APT_MIRROR
# Node 发行站（装非自带 node 版本时用）。默认官方；可指向镜像站（如
# `https://registry.npmmirror.com/-/binary/node`），见 `install-node-version.sh` 文件头。
ARG NODE_DIST_MIRROR
# Rust 发行站（装 rust 时用）。默认官方；官方在本机实测被限速到几十 KB/s ⇒ 建议指向镜像站
# （如 `https://mirrors.ustc.edu.cn/rust-static/dist`），见 `install-rust-version.sh` 文件头。
ARG RUST_DIST_MIRROR

# base 层结尾是 `USER agent` ⇒ 装包前必须切回 root；装完再切回去（理由同 toolkit/Dockerfile）。
USER root

# 版本化运行时的安装脚本。
# ⚠️ 必须**先 COPY、后那条 apt RUN** —— 同一个 RUN 里没法先 COPY 再执行，故脚本单独提前 COPY。
COPY install-python-version.sh install-node-version.sh install-go-version.sh install-java-version.sh install-rust-version.sh /tmp/
RUN set -eux; chmod 0755 /tmp/install-*.sh

# 与 toolkit 同款：Debian 源可换（本机实测官方源慢十几倍），apt 体量与索引挂构建缓存。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    if [ -n "${APT_MIRROR:-}" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    apt-get update; \
    if [ -z "${COMPONENTS:-}" ]; then \
      echo 'COMPONENTS 为空：不额外装语言运行时（只有 toolkit）'; \
    else \
      for component in $(echo "${COMPONENTS}" | tr ',' ' '); do \
        lang="${component%%=*}"; \
        ver="${component#*=}"; \
        echo "=== 组件：${lang}=${ver} ==="; \
        case "${lang}" in \
          node) \
            if [ "${ver}" = "22" ]; then \
              echo "node 22 = base 自带（node:22），无需另装"; \
            else \
              NODE_DIST_MIRROR="${NODE_DIST_MIRROR:-https://nodejs.org/dist}" /tmp/install-node-version.sh "${ver}" || exit 1; \
            fi ;; \
          python) \
            apt-get install -y --no-install-recommends python3-pip python3-venv; \
            if [ "${ver}" = "3.11" ]; then \
              echo "python ${ver} = 系统自带（bookworm），无需另装"; \
            else \
              /tmp/install-python-version.sh "${ver}" || exit 1; \
            fi ;; \
          go) \
            /tmp/install-go-version.sh "${ver}" || exit 1 ;; \
          java) \
            /tmp/install-java-version.sh "${ver}" || exit 1; \
            apt-get install -y --no-install-recommends maven ;; \
          rust) \
            RUST_DIST_MIRROR="${RUST_DIST_MIRROR:-https://static.rust-lang.org/dist}" /tmp/install-rust-version.sh "${ver}" || exit 1 ;; \
          *) \
            echo "未知的组件语言 ${lang}（应为 node/python/go/java/rust）" >&2; exit 1 ;; \
        esac; \
      done; \
    fi

# 自检脚本：与 toolkit 同款 —— 出问题时能在活容器里重跑同一份（见该脚本文件头）。
COPY selfcheck.sh /opt/sandbox-runtime-selfcheck.sh
RUN set -eux; chmod 0755 /opt/sandbox-runtime-selfcheck.sh

USER agent

# 末步：以 agent（非 root）身份跑运行时自检（顺带验"非 root 下这些运行时真能用"）。
RUN /opt/sandbox-runtime-selfcheck.sh "${COMPONENTS}"
