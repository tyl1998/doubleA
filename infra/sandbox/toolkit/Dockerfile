# 沙箱 toolkit 层（P0-3-1）—— 依据 `docs/子方案/沙箱与引擎集成.md` §五 1 / §五 2
#
# ⚠️ 同 base：**刻意不写 `# syntax=docker/dockerfile:1`**（没用 BuildKit 独有语法，而那条指令
#    会去拉一份外部 frontend 镜像，本机曾因此 403）。理由详见 base/Dockerfile 头部。
# ═══════════════════════════════════════════════════════════════════════════
# 【这一层存在的唯一理由 —— 它解的是一个死结】
#   egress 白名单只放行模型池出口（§四 3）⇒ 容器内 `pip install pandas` / `npm i` **必然失败**；
#   而阶段三的验收场景「分析这份 CSV 出汇总表」**恰恰要 pandas**。
#   ⇒ 判据（§五 2）：**验收场景与已知任务类型所需的一切依赖，必须在构建期进本层；
#      运行期安装一律不做、也不为它开任何出口。**
#
# 【配套两条纪律，都体现在这个文件里】
#   ① 末步跑**依赖自检**（`selfcheck.sh`），缺一个就让 build 失败 —— 否则症状是
#      「镜像 build 成功、派活时才发现少个库」，而那时错误只会是一条含糊的引擎 stderr。
#   ② 新增依赖 = 重建本层 + 改 `TOOLKIT_LAYER_VERSION`（`infra/sandbox/versions.mjs`），
#      不是运行时补。
#
# 【为什么这几个包、为什么是这个装法】
#   装法：**全走 apt**（Debian bookworm 自带 `python3-pandas` / `python3-openpyxl`），不引 pip。
#     理由两条：① pip 要联网，而我们刻意不留"运行期安装"这条路；
#               ② apt 的 pandas 与 python3 是**同一个发行版基线**，不会出现 wheel 与解释器错配。
#   ① 刻意**不装 `python3-pip` / `python3-venv`**：装了就会有人（包括模型自己）去试
#      `pip install`，然后在 egress 上失败得莫名其妙。没有 pip ⇒ 失败得更早、更好解释。
#   ② 刻意**不装 curl/wget**：同样与"只有两条出口"配套。真需要取外部数据，走 MCP（§七）或模型。
#   ③ `git` / `ripgrep` 来自上游 `containerization.md` 的包清单；pi 的 `bash` 工具里
#      让人（和模型）用得上，且都是纯本地命令、不碰网络。
#
# ⚠️ 同样**不要手敲 docker build**：`BASE_IMAGE` 由 `pnpm sandbox:build` 注入。
# ═══════════════════════════════════════════════════════════════════════════

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Debian 源主机名（可空 = 官方）。由 sandbox-build.mjs 的 `--apt-mirror` 注入，理由同 base。
ARG APT_MIRROR

# base 层结尾是 `USER agent` ⇒ 装包前必须切回 root（apt 不能以非 root 跑）。装完再切回去，
# 这样 toolkit 的**镜像默认用户**与 base 一致 —— 别忘了这一句，否则容器默认以 root 跑（§四 2 的
# "非 root"要求会静默失效，而 `--cap-drop ALL` 的意义也随之减半）。
USER root

# ⚠️ BuildKit **缓存挂载**（与 base 同款，见 `infra/sandbox/base/Dockerfile` 那一段的完整理由）：
#    这一层是本仓最慢的网络段（`python3-pandas` / `numpy` / `openpyxl` 加起来上百 MB），而它**每次
#    base 变了都要重跑**（`FROM ${BASE_IMAGE}` 的父层 ID 一变，这条 `RUN` 的缓存就失效）⇒ 把 apt
#    的包体与索引挂在构建缓存里，重跑时**不再重新下载**，只做解包与配置（这是本批提速的主要来源）。
#    ⚠️ 同理**不再** `rm -rf /var/lib/apt/lists/*`（它现在挂在缓存上，删了等于白挂）。
#    ⚠️ 同样**刻意不写** `# syntax=docker/dockerfile:1`（见文件头）：缓存挂载不需要它。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    if [ -n "${APT_MIRROR:-}" ]; then \
      echo "把 Debian 源换成 ${APT_MIRROR}（本机实测快十几倍）"; \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-numpy \
        python3-pandas \
        python3-openpyxl \
        jq \
        git \
        ripgrep

# 自检脚本 COPY 进镜像（而不只是 inline RUN）：出问题时能在**活着的容器里**重跑同一份脚本，
# 不必回头去翻构建日志（P0-3-3/4 排障会用到）。
COPY selfcheck.sh /opt/sandbox-selfcheck.sh
RUN set -eux; chmod 0755 /opt/sandbox-selfcheck.sh

USER agent

# 末步：**依赖自检**。以 agent（非 root）的身份跑，顺带把"非 root 下这些工具真的能用"一起验了
# —— 以 root 跑的自检会放过一堆权限问题。
RUN /opt/sandbox-selfcheck.sh
