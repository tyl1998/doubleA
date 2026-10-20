# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════
# doubulea-router —— **业务后端 + 路由网关**共用的平台镜像（P1-14 · R1）
#
# 依据：`docs/子方案/沙箱多机部署.md` §八 1（后端容器硬约束）/ §八 2（每台机器上跑什么）/ §八 4（网关）。
#
# 【为什么一个镜像两个角色】
#   后端与网关共享 `node_modules`（几 GB）与 `dist`，拆两个镜像只会让"改一行转到另一个角色"
#   变成两条构建链路。角色是**启动命令 + 一个 env**（`DOUBULEA_SANDBOX_ROLE`，见
#   `backend/src/sandbox/roleOverride.ts`）：
#     · 后端（每台容器宿主一个）：CMD 用默认值          → `node dist/backend/src/index.js`
#     · 网关（一个或 ≥2 副本）：CMD 覆盖成              → `node dist/backend/src/router/main.js`
#
# 【构建】唯一入口 `pnpm router:build`（`infra/scripts/router-image.mjs`）——
#   版本 tag 只从 `infra/sandbox/versions.mjs` 读，避免"改一处漏两处"（同沙箱镜像的纪律）。
#   ⚠️ 构建上下文是**仓库根**（要 `pnpm-lock.yaml` / 三包源码）；`.dockerignore` 在根目录，
#      它把 `node_modules` / `dist` / `infra/.env` 全部排除 —— 镜像里**不允许有任何本机 .env**。
#
# 【运行形态（部署约束，代码层只能告警）】
#   · `network_mode: host`：出口② 的 listener 绑的是**沙箱网桥的网关地址**（宿主接口）；非 host 网络绑不上；
#   · 挂 `/var/run/docker.sock`：后端经**宿主** daemon 起沙箱（兄弟容器 DooD），不是容器内嵌套 Docker；
#   · 网关容器**不挂** docker.sock、不设 `SANDBOX_INSTANCE_ID`（否则会抢实例名）。
# ═══════════════════════════════════════════════════════════════════════

ARG NODE_IMAGE=node:22-bookworm-slim

# ── ① 依赖层：只装 workspace 的依赖（改了源码不重装依赖）─────────────
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION=12.4.2
WORKDIR /app
# pnpm 走 corepack（与仓库 `packageManager` 同版本 ⇒ lockfile 语义一致）
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# 先只拷清单：`--frozen-lockfile` 在依赖没变时能命中这一层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# ⚠️ `--ignore-scripts`：pnpm 10+ 默认拦 postinstall；本镜像**不需要** esbuild 的平台二进制
#    （构建产物是 tsc 出的 JS，前端是 Vite 的静态包，都已在构建期完成）。prisma / bcrypt 的运行期
#    二进制由各自包自带的预编译文件提供（bcrypt 的 `node-gyp-build` 在装包时就已解析）。
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── ② 构建层：shared → backend → frontend（三包一次产出 dist）─────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend
# 运维脚本与沙箱构建上下文：**运行层**要从 build 阶段拷（`COPY --from=build` 不会跟随软链，
# 但对普通目录无妨）；放在这里是为了让 build 阶段也能 test 一下存在性
COPY infra ./infra
# 部署包（运行层要 `COPY --from=build /app/deploy`；不含密钥，见根 .dockerignore）
COPY deploy ./deploy
# prisma generate 需要 schema（`backend/prisma` 已在上一行随 backend 拷入）；生成到 `backend/generated`
RUN pnpm -r build
# 只留运行期产物（tsc 的声明/映射文件对运行没意义，删掉省几十 MB）
RUN find shared/dist backend/dist -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' | xargs -r rm -f

# ── ③ 运行层 ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION=12.4.2
# ⚠️ `TZ` 与宿主一致：时区问题（Prisma `timestamptz` 偏移，见 `06` §七 8）与本机同口径，
#    不要在镜像里悄悄改成 UTC —— 那会让"本机行为"与"容器行为"分叉。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
# tini 做 PID 1：`docker stop` 的 SIGTERM 能直达 node（本项目有优雅退出流程，见 `backend/src/index.ts`）
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# 非 root 运行；uid/gid 固定 10001（与沙箱镜像里的 `agent` 用户同号，避免卷属主来回变）
RUN groupadd --gid 10001 doubulea \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin doubulea
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# 依赖与产物：整包拷贝 `node_modules`（hoisted 布局 ⇒ 依赖全在根）
COPY --from=deps --chown=doubulea:doubulea /app/node_modules ./node_modules
COPY --from=build --chown=doubulea:doubulea /app/shared/dist ./shared/dist
# ★ workspace 包 `@doubulea/shared` 在 node_modules 里是一个**软链**（`@doubulea/shared -> ../../shared`）。
#   `COPY --from` **不跟随软链**（Go 的 fs.CopyDir 语义）⇒ 软链指向的目录在镜像里不存在，
#   症状是运行期 `ERR_MODULE_NOT_FOUND: Cannot find package '@doubulea/shared'`（构建期一条错都没有）。
#   ⇒ 这里显式重建同样的链接（必须在 `shared/dist` 拷进来**之后**：链接要能立刻解析到）。
RUN mkdir -p node_modules/@doubulea \
 && ln -sfn ../../shared node_modules/@doubulea/shared \
 && test -f node_modules/@doubulea/shared/dist/index.js
COPY --from=build --chown=doubulea:doubulea /app/backend/dist ./backend/dist
COPY --from=build --chown=doubulea:doubulea /app/backend/generated ./backend/generated
# ★ Prisma 的 **schema / migrations / seed / 配置**也打进镜像（2026-10-20）：
#   在此之前运行层只有生成的 client，建表必须回到源码目录 `pnpm db:deploy` ⇒ 别人拿到镜像**起不来
#   （表都没建）。打进来之后 `doubulea-backend:2` 能自己完成「迁移 → 种子 → 分区续期」，
#   `deploy/` 里的一键脚本就是靠它做到"只有一个镜像也能跑"。
#   ⚠️ 体积只有几十 KB（迁移 SQL + 两个 ts 文件）；改迁移就要 +1 层版本（infra/sandbox/versions.mjs）。
COPY --from=build --chown=doubulea:doubulea /app/backend/prisma ./backend/prisma
COPY --from=build --chown=doubulea:doubulea /app/backend/prisma.config.ts ./backend/prisma.config.ts
# ⚠️ `prisma.config.ts` 会 `export default` 且 import `prisma/config` ⇒ 只在 `"type": "module"` 的包里
#    才能被加载；镜像根 `package.json` 就是（backend 是 ESM）。`backend/package.json` 同样带 type=module。
# `prisma.config.ts` 用 `prisma` 与 `tsx` 两个 CLI（后者跑 seed）：两者都在根 node_modules（devDeps 也装进镜像）
RUN test -x node_modules/.bin/prisma && test -x node_modules/.bin/tsx \
 && test -f backend/prisma/schema.prisma && test -d backend/prisma/migrations
COPY --from=build --chown=doubulea:doubulea /app/frontend/dist ./frontend/dist
# package.json 只为 `node` 解析 `"type": "module"`（backend 是 ESM）
COPY --chown=doubulea:doubulea package.json ./
COPY --chown=doubulea:doubulea shared/package.json ./shared/package.json
COPY --chown=doubulea:doubulea backend/package.json ./backend/package.json

# ★ 运维脚本与沙箱构建上下文**打包进镜像**（2026-10-19 用户定案）：
#   节点自举（`POST /api/admin/node/bootstrap`）要执行 `infra/scripts/egress-up.sh` / `relay-up.sh`
#   与 `sandbox-build.mjs --toolkit-only`，这三样都在仓库里。打进来之后，**一台新节点只需要分发镜像**，
#   不必再拷源码目录（compose 里的 `infra/scripts` 挂载因此变成可选覆盖）。
#   ⚠️ 体积很小（脚本 + Dockerfile 若干 KB）；改它们要 +1 镜像层版本（见 `infra/sandbox/versions.mjs`）。
COPY --from=build --chown=doubulea:doubulea /app/infra/scripts ./infra/scripts
COPY --from=build --chown=doubulea:doubulea /app/infra/sandbox ./infra/sandbox
# ★ 部署包**也打进镜像**（2026-10-20）：新机器只要分发这一个镜像，就能把 `deploy/` 整个取出来
#   在**宿主**上执行（`docker run --rm -v $PWD:/out ... cp -r /app/deploy /out/`），
#   不需要 git clone、也不需要单独分发启动脚本。
#   ⚠️ 只拷脚本与模板：`deploy/deploy.env`（真实密钥）与 `deploy/.generated/`（种子初始密码）
#      已由根 `.dockerignore` 排除 —— **不要**为了"方便"把它们打进来。
#   ⚠️ 体积只有几十 KB（几个 shell + 两个零依赖 .mjs + 文档）；改它要 +1 层版本（versions.mjs）。
COPY --from=build --chown=doubulea:doubulea /app/deploy ./deploy
# 断言换源脚本三份副本都在（自举的 toolkit 构建与按需运行时构建都 `COPY apt-source.sh`）；
# 缺了会在"一键初始化"时才失败，而那时人已经不在看构建日志了。
RUN test -f infra/sandbox/base/apt-source.sh \
 && test -f infra/sandbox/toolkit/apt-source.sh \
 && test -f infra/sandbox/runtime/apt-source.sh
# 部署包断言：脚本与模板在，**真实配置与生成物不在**（打进来就是密钥泄漏）
RUN test -f deploy/scripts/up.sh \
 && test -f deploy/scripts/_lib.sh \
 && test -f deploy/env/deploy.env.example \
 && test -f deploy/docker/egress-proxy.mjs \
 && test -f deploy/docker/sandbox-relay.mjs \
 && test ! -e deploy/deploy.env \
 && test ! -e deploy/.generated
# 自举默认就用镜像内的这两份（不再依赖挂载；挂载仍可覆盖以支持热修脚本）
ENV DOUBULEA_EGRESS_SCRIPT=/app/infra/scripts/egress-up.sh \
    DOUBULEA_RELAY_SCRIPT=/app/infra/scripts/relay-up.sh \
    DOUBULEA_SANDBOX_BUILD_SCRIPT=/app/infra/scripts/sandbox-build.mjs \
    SANDBOX_RUNTIME_BUILD_CONTEXT=/app/infra/sandbox/runtime
# ⚠️ **不要**在这里设 `DOUBULEA_HOST_INFRA_DIR`：它表示"脚本在**宿主**上的路径"（热修挂载模式）。
#   镜像内置脚本时该路径在宿主上不存在 ⇒ 自举会把脚本写进命名卷 `/opt/node-infra` 再给兄弟容器用。
#   若这里写成 `/app/infra/scripts`，自举会误判为"已在宿主可见"而跳过中转 ⇒ 兄弟容器挂到空目录
#   （`MODULE_NOT_FOUND /app/sandbox-relay.mjs`）。

# Prisma 运行期只需要生成的 client 与 query engine：两者都在根 `node_modules`
# （`node_modules/.prisma` / `@prisma/client`），已随上面的整包拷贝进来 ——— 运行层不再跑 install。
USER doubulea

# 默认角色 = 业务后端；网关容器在 compose 里覆盖 CMD
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
# ⚠️ 必须写**绝对路径**：compose 的 `command:` 覆盖 CMD 时没有 `WORKDIR` 语义
CMD ["node", "/app/backend/dist/backend/src/index.js"]
