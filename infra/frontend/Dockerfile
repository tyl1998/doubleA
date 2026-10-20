# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════
# doubulea-frontend —— **前端静态站点镜像（nginx）**（P1-14 · R1 的第三块；2026-10-19 新增）
#
# 依据：`docs/子方案/沙箱多机部署.md` §八 3（拓扑：`nginx：托管 SPA + 反代 /api、/health`）。
#
# 【为什么现在才有】
#   原平台镜像把 `frontend/dist` 打进了后端镜像，但**没有任何进程 serve 它**（后端是 Fastify、只挂
#   `/api`；网关只转发）。⇒ 前端一直缺一个"托管 + 反代"的部署形态，本文件补上：
#     · 静态：`/` → SPA（history 路由兜底到 `index.html`）
#     · 反代：`/api/*` 与 `/health` → `ROUTER_UPSTREAM`（路由网关）
#     · SSE：`/api/.../chat|stream|workspace/events` 关闭缓冲、放长读超时（否则模型静默期被掐断）
#
# 【构建】`pnpm frontend:build-image`（`infra/scripts/frontend-image.mjs`）——
#   tag 只从 `infra/sandbox/versions.mjs#frontendImageRef()` 读。
#   ⚠️ 构建上下文是**仓库根**（要 pnpm-lock/workspace 才能构建 frontend 包）。
#
# 【运行】`docker run -e ROUTER_UPSTREAM=http://10.73.100.153:13000 -p 8080:80 doubulea-frontend:2`
#   ⚠️ `ROUTER_UPSTREAM`（带 scheme，给人看）在启动时由入口脚本折算成 `ROUTER_HOSTPORT`（nginx upstream 要
#      纯 `host:port`）再替换进配置 —— 同一个镜像可指向不同网关。
# ═══════════════════════════════════════════════════════════════════════

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine

# ── ① 构建层：只构建 frontend（shared 是类型依赖，走 workspace 源码）──────────
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=12.4.2
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# ⚠️ `--ignore-scripts`：与后端镜像同口径（本镜像不需要 prisma / 原生模块的 postinstall）
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY shared ./shared
COPY frontend ./frontend
# `frontend:build` = `tsc --noEmit && vite build`；`VITE_API_BASE_URL` 留空 = 同源（由本 nginx 反代）
RUN pnpm --filter @doubulea/shared build
RUN pnpm --filter @doubulea/frontend build

# ── ② 运行层：nginx + 静态产物 + 模板 ───────────────────────────────────
FROM ${NGINX_IMAGE} AS runtime

# nginx 官方镜像默认用 `envsubst` 处理 `/etc/nginx/templates/*.template`（`docker-entrypoint.d/20-envsubst-on-templates.sh`）
ENV ROUTER_UPSTREAM=http://doubulea-router:13000 \
    ROUTER_HOSTPORT=doubulea-router:13000 \
    CLIENT_MAX_BODY_MB=100

# ⚠️ 覆盖（而不是放进 templates）：官方镜像自带的 `/etc/nginx/conf.d/default.conf` 优先级更高，
#    只放 templates 会被它的默认站点占住（症状：访问 `/` 得到 nginx 欢迎页、`/api` 不反代）。
COPY infra/frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
# 「安装时」删掉默认站点；⚠️ 不要只在 entrypoint 里删 —— 容器重启会复用镜像里那份
RUN rm -f /etc/nginx/conf.d/default.conf
# 入口脚本：`ROUTER_UPSTREAM`（带 scheme）→ `ROUTER_HOSTPORT`（nginx upstream 要的纯 host:port）。
# ⚠️ 必须排在 `20-envsubst-on-templates.sh` **之前**（脚本按文件名字典序执行）—— 排在后面
#    的话模板展开时 `ROUTER_HOSTPORT` 还是镜像里的默认值，表现为忽略了传入的 `ROUTER_UPSTREAM`。
# ⚠️ 用 `.envsh` 后缀：入口脚本只 **source** `.envsh`（不另起子进程），而 `.sh` 是在子 shell 里跑，
#    子进程里的 `export` 传不回父进程 ⇒ 后一步 envsubst 拿不到折算后的 `ROUTER_HOSTPORT`。
COPY infra/frontend/docker-entrypoint.d/19-router-upstream.envsh /docker-entrypoint.d/19-router-upstream.envsh
RUN chmod +x /docker-entrypoint.d/19-router-upstream.envsh
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80
# 镜像自带的 healthcheck 脚本会打 `/`（`50x.html` 那条）；这里换成"静态页 200"更贴合本服务
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
