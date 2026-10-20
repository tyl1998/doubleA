# 沙箱 toolkit 层（P0-3-1）—— 依据 `docs/子方案/沙箱与引擎集成.md` §五 1 / §五 2
#
# ⚠️ 同 base：**刻意不写 `# syntax=docker/dockerfile:1`**（没用 BuildKit 独有语法，而那条指令
#    会去拉一份外部 frontend 镜像，本机曾因此 403）。理由详见 base/Dockerfile 头部。
# ═══════════════════════════════════════════════════════════════════════════
# 【这一层的定位（P1-17b 起口径有更新）】
#   P0 时期：egress 只放行模型池 ⇒ 运行期装包必然失败 ⇒ "所有依赖构建期预烘焙"是死结的唯一解。
#   P1-17 起：**运行时预烘焙（有限、可白名单）+ 依赖运行期经注册表出网拉（无限）**（§五之二）——
#     本层仍预烘焙"验收场景与常见任务所需的一切"（python3/pandas/openpyxl/jq/git/rg…），
#     让开箱即用；语言运行时按栈另有 `runtime/*` 层；项目依赖（`node_modules` 等）**运行期拉**，
#     且**不进产物 / 冷备 / 源码配额**（`workspace/dependencyModel.ts`）。
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
#   ① 刻意**不装 `python3-pip` / `python3-venv`**：本层是 `none` / `node` 运行时的底座，
#      不含 pip。P1-17b 起"运行期装依赖"是开着的，但**只装在 python 运行时层**
#      （`infra/sandbox/runtime/Dockerfile` 的 `python)` 分支）—— 需要 pip 依赖就选 python 运行时，
#      不在底座层留一条"装了却不知道该不该用"的路（`selfcheck.sh` 有一条负向断言守它）。
#   ② 刻意**不装 curl/wget**：同样与"只有两条出口"配套。真需要取外部数据，走 MCP（§七）或模型。
#   ③ `git` / `ripgrep` 来自上游 `containerization.md` 的包清单；pi 的 `bash` 工具里
#      让人（和模型）用得上，且都是纯本地命令、不碰网络。
#   ④ `openssh-client`（P1-9 · R11 补）：`SSH_KEY` 型 git 凭据要在容器里跑 `ssh`（`GIT_SSH_COMMAND`），
#      没有它 `git clone git@…` 直接 `ssh: not found`（只装客户端、不装 `openssh-server`）。
#      ⚠️ 装客户端**不等于** SSH 出网可用：SSH(22) 不经 HTTP 代理，仍需平台侧放行 22（见 §7.5）。
#
# ⚠️ 同样**不要手敲 docker build**：`BASE_IMAGE` 由 `pnpm sandbox:build` 注入。
# ═══════════════════════════════════════════════════════════════════════════

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Debian 源主机名（可空 = 官方）。由 sandbox-build.mjs 的 `--apt-mirror` 注入，理由同 base。
ARG APT_MIRROR
ARG APT_MIN_BPS=32

# base 层结尾是 `USER agent` ⇒ 装包前必须切回 root（apt 不能以非 root 跑）。装完再切回去，
# 这样 toolkit 的**镜像默认用户**与 base 一致 —— 别忘了这一句，否则容器默认以 root 跑（§四 2 的
# "非 root"要求会静默失效，而 `--cap-drop ALL` 的意义也随之减半）。
USER root

# 换源 / IPv4 兜底 / 不通回落（与 base **同一份**脚本，见 apt-source.sh 文件头）
COPY apt-source.sh /usr/local/bin/apt-source.sh

# ⚠️ BuildKit **缓存挂载**（与 base 同款，见 `infra/sandbox/base/Dockerfile` 那一段的完整理由）：
#    这一层是本仓最慢的网络段（`python3-pandas` / `numpy` / `openpyxl` 加起来上百 MB），而它**每次
#    base 变了都要重跑**（`FROM ${BASE_IMAGE}` 的父层 ID 一变，这条 `RUN` 的缓存就失效）⇒ 把 apt
#    的包体与索引挂在构建缓存里，重跑时**不再重新下载**，只做解包与配置（这是本批提速的主要来源）。
#    ⚠️ 同理**不再** `rm -rf /var/lib/apt/lists/*`（它现在挂在缓存上，删了等于白挂）。
#    ⚠️ 同样**刻意不写** `# syntax=docker/dockerfile:1`（见文件头）：缓存挂载不需要它。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    sh /usr/local/bin/apt-source.sh "${APT_MIRROR:-}"; \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-numpy \
        python3-pandas \
        python3-openpyxl \
        jq \
        git \
        openssh-client \
        ripgrep

# 自检脚本 COPY 进镜像（而不只是 inline RUN）：出问题时能在**活着的容器里**重跑同一份脚本，
# 不必回头去翻构建日志（P0-3-3/4 排障会用到）。
COPY selfcheck.sh /opt/sandbox-selfcheck.sh
RUN set -eux; chmod 0755 /opt/sandbox-selfcheck.sh

# git 凭据 helper（P1-9 · R11 修订）：**按需拉取** —— 容器侧两个无状态脚本，git 用时才回调平台
# 换凭据（详见各自文件头）。不落任何秘密、不受只读 rootfs 限制（SSH 私钥写到可写的 /tmp）。
# 属主 root、全局可读可执行：它们本身不含凭据。
COPY git-credential-doubulea.mjs git-ssh-doubulea.mjs /opt/sandbox-git/
RUN set -eux; chmod 0755 /opt/sandbox-git/git-credential-doubulea.mjs /opt/sandbox-git/git-ssh-doubulea.mjs

USER agent

# 末步：**依赖自检**。以 agent（非 root）的身份跑，顺带把"非 root 下这些工具真的能用"一起验了
# —— 以 root 跑的自检会放过一堆权限问题。
RUN /opt/sandbox-selfcheck.sh
