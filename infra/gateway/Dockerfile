# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════
# doubulea-gateway —— **路由网关专用镜像**（P1-14 · R1；2026-10-19 从平台镜像拆出）
#
# 依据：`docs/子方案/沙箱多机部署.md` §八 3（拓扑）/ §八 4（网关配置）；`docs/06` §五·补 P1-14 · R1。
#
# 【为什么单独一个镜像】
#   网关真正依赖的只有 **fastify + ioredis + zod**（`backend/src/router/*` 的外部 import 就这几个），
#   但 R1 最初让它和业务后端共用平台镜像 ⇒ 那份 `node_modules` 整包拷进去 **531MB**
#   （`@prisma/*` ~330MB、`antd` ~120MB、`vite`/`typescript` 等构建期依赖），镜像 813MB，
#   其中 99% 是网关永远加载不到的东西。拆开后：`node:22-slim` + 三个运行期依赖 + `router/` 产物。
#
# 【构建】`pnpm gateway:build`（`infra/scripts/gateway-image.mjs`）——
#   tag 只从 `infra/sandbox/versions.mjs` 读（同沙箱镜像的纪律）。
#   ⚠️ 构建上下文是**仓库根**；`.dockerignore` 已排除 `node_modules` / `dist` / 任何 `.env`。
#
# 【运行形态】网关**不挂** `docker.sock`、**不设** `SANDBOX_INSTANCE_ID`、`DOUBULEA_SANDBOX_ROLE=router`
#   （否则会抢实例名、把自己登记成上游 ⇒ 回环）。见 `infra/router/docker-compose.router.yml`。
# ═══════════════════════════════════════════════════════════════════════

ARG NODE_IMAGE=node:22-bookworm-slim

# ── ① 构建层：只要 shared + backend 的产物（不装前端 / Prisma / 测试链）────────
# ⚠️ 这里用**完整** workspace 依赖来构建（tsc 需要 zod 的类型、workspace 链接），
#    但产物只取 `shared/dist` 与 `backend/dist/.../router` —— 运行层不拷这份 node_modules。
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.4.2
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# `--ignore-scripts`：构建期不需要 prisma generate（router 代码不碰 Prisma）
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY shared ./shared
COPY backend ./backend
COPY infra/gateway/tsconfig.json ./infra/gateway/tsconfig.json
# 只编译 shared + **路由网关的入口图**（`infra/gateway/tsconfig.json`：include 仅 `backend/src/router/**`）。
# ⚠️ 不能用 `backend/tsconfig.json`：它包含全部后端源码，其中 workspace / 任务链路依赖 Prisma 生成物，
#    而本镜像刻意不跑 `prisma generate`（网关不碰 DB）。漏了会被 tsc 以 TS7006 之类报出来。
RUN pnpm --filter @doubulea/shared build
# ⚠️ 用绝对路径：`pnpm --filter … exec` 的 cwd 是包目录（/app/backend），相对路径在不同 pnpm 版本下解析不一致
RUN pnpm --filter @doubulea/backend exec tsc -p /app/infra/gateway/tsconfig.json
RUN find shared/dist backend/dist-gateway -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' | xargs -r rm -f

# ── ② 运行层：三个运行期依赖（从构建层的 pnpm store 里精拷）────────────────────
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

# tini 作 PID 1（优雅退出）；ca-certificates 给 Redis TLS / 上游 HTTPS 用
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 非 root 运行（uid/gid 固定 10001，与沙箱镜像里的 `agent` 同号）
RUN groupadd --gid 10001 doubulea \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin doubulea

# ★ 依赖：只拷网关真正 import 的包及其**运行期闭包**（58 个目录，含嵌套的 `node_modules`）。
#   清单按 Node 的解析规则（逐层向上找 node_modules）算出 —— 只拷顶层包会漏掉 fastify / ajv /
#   light-my-request / thread-stream 的**嵌套**依赖，症状是运行期 `Cannot find module 'ret'`。
#   ⚠️ 升级 fastify / ioredis / zod 后重跑 `node infra/scripts/gateway-deps.mjs`，把输出替换到本段。
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@fastify/ajv-compiler ./node_modules/@fastify/ajv-compiler
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@fastify/error ./node_modules/@fastify/error
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@fastify/fast-json-stringify-compiler ./node_modules/@fastify/fast-json-stringify-compiler
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@fastify/forwarded ./node_modules/@fastify/forwarded
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@fastify/merge-json-schemas ./node_modules/@fastify/merge-json-schemas
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@fastify/proxy-addr ./node_modules/@fastify/proxy-addr
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@ioredis/commands ./node_modules/@ioredis/commands
COPY --from=build --chown=doubulea:doubulea /app/node_modules/@pinojs/redact ./node_modules/@pinojs/redact
COPY --from=build --chown=doubulea:doubulea /app/node_modules/abstract-logging ./node_modules/abstract-logging
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ajv ./node_modules/ajv
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ajv-formats ./node_modules/ajv-formats
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ajv/node_modules/fast-uri ./node_modules/ajv/node_modules/fast-uri
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ajv/node_modules/json-schema-traverse ./node_modules/ajv/node_modules/json-schema-traverse
COPY --from=build --chown=doubulea:doubulea /app/node_modules/atomic-sleep ./node_modules/atomic-sleep
COPY --from=build --chown=doubulea:doubulea /app/node_modules/avvio ./node_modules/avvio
COPY --from=build --chown=doubulea:doubulea /app/node_modules/cluster-key-slot ./node_modules/cluster-key-slot
COPY --from=build --chown=doubulea:doubulea /app/node_modules/debug ./node_modules/debug
COPY --from=build --chown=doubulea:doubulea /app/node_modules/denque ./node_modules/denque
COPY --from=build --chown=doubulea:doubulea /app/node_modules/dequal ./node_modules/dequal
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fast-decode-uri-component ./node_modules/fast-decode-uri-component
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fast-deep-equal ./node_modules/fast-deep-equal
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fast-json-stringify ./node_modules/fast-json-stringify
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fast-querystring ./node_modules/fast-querystring
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fast-uri ./node_modules/fast-uri
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fastify ./node_modules/fastify
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fastify/node_modules/find-my-way ./node_modules/fastify/node_modules/find-my-way
COPY --from=build --chown=doubulea:doubulea /app/node_modules/fastq ./node_modules/fastq
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ioredis ./node_modules/ioredis
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ipaddr.js ./node_modules/ipaddr.js
COPY --from=build --chown=doubulea:doubulea /app/node_modules/json-schema-ref-resolver ./node_modules/json-schema-ref-resolver
COPY --from=build --chown=doubulea:doubulea /app/node_modules/light-my-request ./node_modules/light-my-request
COPY --from=build --chown=doubulea:doubulea /app/node_modules/light-my-request/node_modules/cookie ./node_modules/light-my-request/node_modules/cookie
COPY --from=build --chown=doubulea:doubulea /app/node_modules/light-my-request/node_modules/process-warning ./node_modules/light-my-request/node_modules/process-warning
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ms ./node_modules/ms
COPY --from=build --chown=doubulea:doubulea /app/node_modules/on-exit-leak-free ./node_modules/on-exit-leak-free
COPY --from=build --chown=doubulea:doubulea /app/node_modules/pino ./node_modules/pino
COPY --from=build --chown=doubulea:doubulea /app/node_modules/pino-abstract-transport ./node_modules/pino-abstract-transport
COPY --from=build --chown=doubulea:doubulea /app/node_modules/pino-std-serializers ./node_modules/pino-std-serializers
COPY --from=build --chown=doubulea:doubulea /app/node_modules/process-warning ./node_modules/process-warning
COPY --from=build --chown=doubulea:doubulea /app/node_modules/quick-format-unescaped ./node_modules/quick-format-unescaped
COPY --from=build --chown=doubulea:doubulea /app/node_modules/real-require ./node_modules/real-require
COPY --from=build --chown=doubulea:doubulea /app/node_modules/redis-errors ./node_modules/redis-errors
COPY --from=build --chown=doubulea:doubulea /app/node_modules/require-from-string ./node_modules/require-from-string
COPY --from=build --chown=doubulea:doubulea /app/node_modules/ret ./node_modules/ret
COPY --from=build --chown=doubulea:doubulea /app/node_modules/reusify ./node_modules/reusify
COPY --from=build --chown=doubulea:doubulea /app/node_modules/rfdc ./node_modules/rfdc
COPY --from=build --chown=doubulea:doubulea /app/node_modules/safe-regex2 ./node_modules/safe-regex2
COPY --from=build --chown=doubulea:doubulea /app/node_modules/safe-stable-stringify ./node_modules/safe-stable-stringify
COPY --from=build --chown=doubulea:doubulea /app/node_modules/secure-json-parse ./node_modules/secure-json-parse
COPY --from=build --chown=doubulea:doubulea /app/node_modules/semver ./node_modules/semver
COPY --from=build --chown=doubulea:doubulea /app/node_modules/set-cookie-parser ./node_modules/set-cookie-parser
COPY --from=build --chown=doubulea:doubulea /app/node_modules/sonic-boom ./node_modules/sonic-boom
COPY --from=build --chown=doubulea:doubulea /app/node_modules/split2 ./node_modules/split2
COPY --from=build --chown=doubulea:doubulea /app/node_modules/standard-as-callback ./node_modules/standard-as-callback
COPY --from=build --chown=doubulea:doubulea /app/node_modules/thread-stream ./node_modules/thread-stream
COPY --from=build --chown=doubulea:doubulea /app/node_modules/thread-stream/node_modules/real-require ./node_modules/thread-stream/node_modules/real-require
COPY --from=build --chown=doubulea:doubulea /app/node_modules/toad-cache ./node_modules/toad-cache
COPY --from=build --chown=doubulea:doubulea /app/node_modules/zod ./node_modules/zod
COPY --from=build --chown=doubulea:doubulea /app/shared/dist ./shared/dist
COPY --from=build --chown=doubulea:doubulea /app/backend/dist-gateway/backend/src/router ./backend/dist/backend/src/router
COPY --chown=doubulea:doubulea package.json ./
COPY --chown=doubulea:doubulea shared/package.json ./shared/package.json
RUN mkdir -p node_modules/@doubulea \
 && ln -sfn ../../shared node_modules/@doubulea/shared \
 && test -f node_modules/@doubulea/shared/dist/index.js

USER doubulea
EXPOSE 13000
ENTRYPOINT ["/usr/bin/tini", "--"]
# ⚠️ 绝对路径：compose 覆盖 command 时没有 WORKDIR 语义
CMD ["node", "/app/backend/dist/backend/src/router/main.js"]
