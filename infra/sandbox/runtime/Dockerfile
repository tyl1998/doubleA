# 沙箱**运行时层**（P1-17a）—— 依据 `docs/子方案/Code模式工作区.md` §五之二 2
#
# ⚠️ 同 base/toolkit：**刻意不写 `# syntax=docker/dockerfile:1`**（没用 BuildKit 独有语法，
#    而那条指令会去拉一份外部 frontend 镜像，本机曾因此 403）。理由详见 base/Dockerfile 头部。
# ═══════════════════════════════════════════════════════════════════════════
# 【这一层解的是什么】
#   Code 会话要"跑项目"（`npm test` / `pytest` / `go build` / `mvn` / `cargo`），而 toolkit 只有
#   python3 + 常用 CLI。本层按 `COMPONENTS` 给最终镜像**补语言运行时**（有限集合 ⇒ 预烘焙）。
#   ★ **只装运行时、不装依赖**（依赖是无限集合、不能白名单，运行期经注册表拉，见 P1-17b）。
#
# 【COMPONENTS —— 不再是"一栈一分支"，而是"任意组合"】
#   2026-10-14 修订（用户定案 B：按需自动构建）：本层不再按写死的 `RUNTIME` 名分支，而是接受
#   一个**组件清单** `COMPONENTS=lang=ver,lang=ver,…`（如 `python=3.10,node=22`）。
#   ⇒ 后端可以在**用户选了本机没有的组合时按需 `docker build`**（把同一份 Dockerfile 复用），
#     运维不必预先猜组合、也不必为每个组合手改这里。
#   约定：`lang ∈ {node, python, go, java, rust}`；`ver` 是该语言的版本字符串（python 用 `3.10`）。
#   ⚠️ 空 `COMPONENTS` = 不装语言运行时（只有 toolkit），等价于旧的 `none`。
#
# ⚠️ 不要手敲 docker build：`BASE_IMAGE` / `COMPONENTS` 由 `pnpm sandbox:build` 或后端注入；
#    缺参数会在下面第一道断言上大声失败，而不是默默烤出一个"不知道装了什么"的镜像。
# ═══════════════════════════════════════════════════════════════════════════

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG COMPONENTS
ARG APT_MIRROR

# base 层结尾是 `USER agent` ⇒ 装包前必须切回 root；装完再切回去（理由同 toolkit/Dockerfile）。
USER root

# 版本化 python 的安装脚本（python 版本 != 系统自带时调它）。
# ⚠️ 必须**先 COPY、后那条 apt RUN** —— 同一个 RUN 里没法先 COPY 再执行，故脚本单独提前 COPY。
COPY install-python-version.sh /tmp/install-python-version.sh
RUN set -eux; chmod 0755 /tmp/install-python-version.sh

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
            echo "node ${ver}：由 base 的 node:22 提供（若 ${ver} != 22 需换 base 镜像，本层不支持改 node 版本）" ;; \
          python) \
            apt-get install -y --no-install-recommends python3-pip python3-venv; \
            if [ "${ver}" = "3.11" ]; then \
              echo "python ${ver} = 系统自带（bookworm），无需另装"; \
            else \
              /tmp/install-python-version.sh "${ver}" || exit 1; \
            fi ;; \
          go) \
            apt-get install -y --no-install-recommends golang-go ;; \
          java) \
            apt-get install -y --no-install-recommends openjdk-17-jdk-headless maven ;; \
          rust) \
            apt-get install -y --no-install-recommends rustc cargo ;; \
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
