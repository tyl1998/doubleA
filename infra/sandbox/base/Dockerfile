# 沙箱 base 层（P0-3-1）—— 依据 `docs/子方案/沙箱与引擎集成.md` §五 1
#
# ⚠️ **刻意不写 `# syntax=docker/dockerfile:1`**：本文件（以及 toolkit）**没有用任何 BuildKit 独有语法**
#    （无 heredoc、无 `--mount=type=cache`），而那条指令会让构建先去 registry 拉一份 frontend 镜像
#    （`docker/dockerfile:1`）。P0-3-1 实测本机那次 HEAD 请求被 registry 镜像站回了 **403** ⇒
#    `failed to resolve source metadata for docker.io/docker/dockerfile:1`，一个与镜像内容无关的失败。
#    将来真要加 BuildKit 独有语法，再把指令加回来，并接受"构建依赖一个外部 frontend 镜像"这件事。
# ═══════════════════════════════════════════════════════════════════════════
# 【这一层装什么】
#   Node 运行时 + **pin 版本的 pi** + 桥扩展 + 非 root 用户 + 只读层里的 pi 配置。
#
# 【这一层刻意不装什么】
#   python / pandas / jq / git / ripgrep —— 全在 toolkit 层。
#   分层的理由（§五 1）：改一层不必重建全镜像，且同一只读层在宿主上**只有一份**，
#   10 个容器共用（§九 1 的磁盘账本全靠这个）。
#
# 【怎么构建 —— ⚠️ 不要手敲 docker build】
#   本文件里 `PI_VERSION` / `NODE_IMAGE` 这类值**没有**有意义的默认值，它们由
#     `pnpm sandbox:build`（= `infra/scripts/sandbox-build.mjs`）从
#     `infra/sandbox/versions.mjs` 读出来注入。
#   手敲时缺参数会在下面第一道断言上**大声失败**（这是刻意的：唯一事实来源 + 显式失败，
#   同 `06` §六 第 27 条）。要手敲调试就照脚本打印出来的那条 `docker build …` 抄。
# ═══════════════════════════════════════════════════════════════════════════

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# 构建参数（由 sandbox-build.mjs 注入；见文件头「怎么构建」）
ARG PI_PACKAGE
ARG PI_VERSION
ARG NPM_REGISTRY

# ── 1. 系统依赖 ──────────────────────────────────────────────────────────
#   bash             → pi 的 `bash` 工具要用它（slim 镜像只有 sh）
#   ca-certificates  → **必须显式装**。基础镜像不保证带它，而缺了它的症状是 pi 调模型池时
#                      抛一个 TLS 证书链错误 —— 看起来像"容器网络不通"（§四 3 的出口①），
#                      会把人引到 iptables 上去查。本文件末尾有断言把它钉死。
#   tini             → PID 1 的僵尸回收（pi 会反复起 bash 子进程）。也可以在 docker run 时
#                      加 `--init`，但那把"必需项"交给启动方记着；镜像里带更不容易漏。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        tini; \
    rm -rf /var/lib/apt/lists/*

# ── 2. Node 版本门槛（pi 的 engines 要求 >=22.19.0）─────────────────────
#   上游 `node:22-bookworm-slim` 当前远超这个下限，但**镜像标签是浮动的** ⇒ 用一条断言把
#   "Node 被降到 22.19 以下"变成构建期失败，而不是等到派活时 pi 起不来。
#   （本仓为沙箱镜像与后端选了同一个 Node 大版本线，见 versions.mjs 的注释。）
RUN set -eux; \
    node -e "const [maj, min] = process.versions.node.split('.').map(Number); \
      if (maj < 22 || (maj === 22 && min < 19)) { \
        console.error('FATAL: node ' + process.versions.node + ' 低于 pi 要求的 22.19.0'); process.exit(1); \
      }"; \
    node -p "'node ' + process.versions.node + ' OK'"

# ── 3. pi（**构建期预烘焙，运行期零安装**；§五 2 / §六 4 坑 4）──────────
#   --ignore-scripts 是上游 containerization.md 的官方写法：pi 交付的是 bundle 过的 dist，
#   不依赖生命周期脚本。（这也顺带解释了为什么本仓 pnpm 的 allowBuilds 纪律在这里不适用：
#   镜像内用 npm 装全局包，不走 pnpm。）
#   `npm cache clean` 清掉 ~/.npm —— 不清的话几百 MB 的 tarball 缓存会永久留在只读层里。
#
#   ⚠️ 装完**立刻**断言"命令在 + 版本逐字相符"。
#   不这么做的症状是「镜像 build 成功、派活时才发现 pi 不存在/是别的版本」——而那时错误只会
#   以一条含糊的引擎 stderr 出现（§六 3 最后一行：引擎 stderr 不进 SSE、只进后端日志）。
#   ⚠️ `--fetch-timeout` / `--fetch-retries` 是**为失败而不是为成功**配的：
#   源不通时 npm 默认会**静默挂着**（5 分钟/次 × 重试），看起来像"卡住了"。
#   P0-3-1 实测本机容器直连 registry.npmjs.org 不通，详见 `versions.mjs` 的注释。
RUN set -eux; \
    test -n "$PI_PACKAGE" || { echo 'FATAL: 缺少 --build-arg PI_PACKAGE（详见 Dockerfile 头部「怎么构建」）'; exit 1; }; \
    test -n "$PI_VERSION"  || { echo 'FATAL: 缺少 --build-arg PI_VERSION（详见 Dockerfile 头部「怎么构建」）'; exit 1; }; \
    npm install -g --ignore-scripts \
      --fetch-timeout 90000 --fetch-retries 2 \
      --registry "${NPM_REGISTRY:-https://registry.npmjs.org}" \
      "${PI_PACKAGE}@${PI_VERSION}"; \
    npm cache clean --force; \
    pi --version | grep -qF "$PI_VERSION"; \
    pi --help > /dev/null; \
    echo "pi ${PI_VERSION} installed OK"

# ── 4. 非 root 用户 ─────────────────────────────────────────────────────
#   uid **固定 10001**（而不是随机的）：具名卷的属主靠它。
#   Docker 首次把**空具名卷**挂到一个已存在的目录上时，会把该目录的内容与**属主**复制进卷；
#   固定 uid 才不会出现「卷在 A 机器上是 agent 的、在 B 机器上是 root 的」这类
#   "换台机器就写不进去"的怪事（§四 2 的 work 卷）。
#   `--create-home` 是给 python/pip/工具链留一个可写的 HOME（rootfs 只读时靠 tmpfs，见 P0-3-3）。
RUN set -eux; \
    groupadd --gid 10001 agent; \
    useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent; \
    id agent

# ── 5. pi 配置 + 桥扩展（**只读层里的种子**，不落 work 卷；§五 1 / §五 3）──
#   `/opt/pi/agent` 是**只读的种子**（不是 pi 的工作目录！），内容按上游 `configuration.md` 的
#   `<agent-dir>` 排布：settings.json / extensions / skills / sessions 都在它下面。
#
#   三条刻意的决定：
#   ① **根属主 + 0755/0644 ⇒ agent 可读不可写**：种子属于镜像、不属于会话。
#   ② **里面没有 `auth.json`**：模型 Key 一律走容器环境变量注入（§五 3），
#      即"Key 只在进程环境里、不在任何文件里"。
#   ③ 桥扩展（`extensions/mcp-bridge/`）**本批只预烘焙空壳**，MCP 工具注册属 P0-3-9b。
#
#   ⚠️⚠️ **pi 不能直接跑在这个目录上**（构建期实测，见 entrypoint.sh 头部）：
#   pi 读 settings.json 会先在同目录加锁，加不上就把整份 settings **判为 invalid 并忽略**。
#   ⇒ 运行期的 agent-dir 必须可写，由 entrypoint 把种子**种**过去（`/tmp/pi-agent`）。
#   这也解释了为什么这条不能靠"把这里 chmod 放宽"来修：P0-3-3 起 rootfs 只读，放宽也没用。
COPY pi-agent/ /opt/pi/agent/
RUN set -eux; \
    chown -R root:root /opt/pi/agent; \
    find /opt/pi/agent -type d -exec chmod 0755 {} +; \
    find /opt/pi/agent -type f -exec chmod 0644 {} +; \
    test -f /opt/pi/agent/settings.json; \
    test -f /opt/pi/agent/extensions/mcp-bridge/index.ts

# entrypoint：播种（只读种子 → 可写 agent-dir）后 `exec pi "$@"`
# 这里只做**语法**检查（`bash -n`）—— 播种的**行为**由 toolkit 的 selfcheck 真跑一次来验
# （它才是最终镜像；base 层单独跑时 PI_CODING_AGENT_DIR 还没被播种过，验不出什么）。
COPY entrypoint.sh /opt/pi/entrypoint.sh
RUN set -eux; chmod 0755 /opt/pi/entrypoint.sh; bash -n /opt/pi/entrypoint.sh

# PI_AGENT_SEED = 只读种子；PI_CODING_AGENT_DIR = pi 实际使用的（**可写**）agent-dir。
# 指到 `/tmp` 而不是 `/work` 是刻意的：`/work` 是产物扫描的范围（§十一），
# 而 session 文件在 §五 3 的硬约束里属于"绝不能带上 Key 的东西"。
ENV PI_AGENT_SEED=/opt/pi/agent
ENV PI_CODING_AGENT_DIR=/tmp/pi-agent

# ── 6. 运行期形态 ───────────────────────────────────────────────────────
#   `/work` 必须**在镜像里就存在、且属 agent**：具名卷首次挂载时继承挂载点的属主（同第 4 节）。
#   产物唯一落点就是它（§四 2），P0-3-3 再加 `--storage-opt` 配额。
RUN set -eux; install -d -o agent -g agent -m 0755 /work

USER agent
WORKDIR /work

#   入口 = `tini -- entrypoint.sh`（脚本内 `exec pi`，不残留中间进程），参数留成 CMD ⇒
#   P0-3-2 用 dockerode 建容器时**直接覆盖 Cmd**（`--mode rpc` / `--model` / `--no-session` …）
#   即可，无需绕过 ENTRYPOINT。
#   ⚠️ tini **不碰 stdout/stderr**（只透传）—— 这是硬要求：RPC 通道就是 pi 的 stdout，
#   任何给 stdout 加前缀的 init 都会把 JSONL 打坏（§六 1）。
#   ⚠️ 这里给的默认 CMD 是"手 run 一个能说话"的形态，不是最终形态：
#   `--model`/`--provider`/Key 注入属 P0-3-4。
CMD ["--mode", "rpc"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/pi/entrypoint.sh"]
