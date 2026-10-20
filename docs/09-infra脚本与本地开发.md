# infra/scripts 脚本说明

`infra/scripts` 下的运维脚本，按用途分五类。所有脚本都可以**单独执行**，不需要先跑别的。

> 平台差异：`.sh` 用于 Linux / macOS，`.ps1` 用于 Windows（**只写 ASCII**，PowerShell 5.1 按 ANSI 读）。
> Windows 版与 bash 版**行为等价**，参数名用 PowerShell 风格（`-Purge` 而不是 `--purge`）。

---

## 一、镜像构建（5 个）

生产部署用这组。**镜像 tag 与版本号唯一来源是 `infra/sandbox/versions.mjs`**，不要手敲 `docker build`。


| 脚本                 | 作用                                                                         | 命令                                  | 产物                                                    |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------- |
| `router-image.mjs`   | 构建**业务后端**镜像（全量依赖 + Prisma）                                    | `pnpm backend:build-image`            | `doubulea-backend:2`（814MB）                           |
| `gateway-image.mjs`  | 构建**路由网关**镜像（只装 fastify / ioredis / zod）                         | `pnpm gateway:build`                  | `doubulea-gateway:2`（273MB）                           |
| `frontend-image.mjs` | 构建**前端**镜像（nginx + 静态产物）                                         | `pnpm frontend:build-image`           | `doubulea-frontend:2`（64MB）                           |
| `sandbox-build.mjs`  | 构建**沙箱**镜像（base → toolkit → 运行时）                                | `pnpm sandbox:build`                  | `doubulea/sandbox-base:6`、`doubulea/sandbox-toolkit:8` |
| `gateway-deps.mjs`   | 打印网关的**运行期依赖闭包**（给 `infra/gateway/Dockerfile` 的 COPY 清单用） | `node infra/scripts/gateway-deps.mjs` | stdout                                                  |

四个构建脚本都支持同一组参数：

```bash
--no-cache              # 不用 layer cache
--save <out.tar>        # 构建后 docker save（无 registry 时多机分发）
--push                  # 构建后 push（需先 docker login）
--tag <ref>             # 覆盖镜像 tag
--dry-run               # 只打印将执行的 docker 命令
```

`sandbox-build.mjs` 另有 `--base-only` / `--toolkit-only` / `--prune`，详见脚本文件头。

**多机注意**：必须**一台构建、分发到各台**（`docker save` + `docker load`，或推私有 registry）。
每台各自 build 会产生"同 tag 不同内容"的镜像。

---

## 二、节点部署（4 个）

在新机器上起一个后端实例。


| 脚本            | 作用                                                 | 命令                                                                 |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `node-up.sh`    | 起后端 + docker-cli 侧车 + 命名卷，等 `/health` 就绪 | `bash infra/scripts/node-up.sh`                                      |
| `node-down.sh`  | 停掉上面起的两个容器                                 | `bash infra/scripts/node-down.sh`                                    |
| `node-up.ps1`   | Windows 版（发布端口 + TCP 连 Docker + relay）       | `powershell -ExecutionPolicy Bypass -File infra\scripts\node-up.ps1` |
| `node-down.ps1` | Windows 版停止                                       | 同上                                                                 |

`node-up.sh` 用法：

```bash
bash node-up.sh                                   # 读 infra/router/.env.node + .env.node.shared
bash node-up.sh --env ./.env.node --shared ./.env.node.shared
bash node-up.sh --force                           # 已在跑也重建
```

它**不做**：建表、起网关/前端、补 egress/relay/toolkit（这些由管理页「一键初始化」或部署包负责）。

> **与 `deploy/scripts/up.sh` 的关系**：`node-up.sh` 是**只有镜像的新机器**用的自包含版本；
> `deploy/` 是完整部署包（能建表、可选起网关前端）。两者是**两份独立实现**，
> 改 `docker run` 参数（socket gid、卷、侧车、换源变量）时**两边都要看**。
> 部署包已打进 `doubulea-backend:2` 的 `/app/deploy`，可以这样取出来用：
>
> ```bash
> docker run --rm -v "$PWD":/out --entrypoint sh doubulea-backend:2 \
>   -c 'cp -r /app/deploy /out/ && chmod +x /out/deploy/scripts/*.sh'
> ```

---

## 三、沙箱外围（5 个 + 2 个本体）

沙箱容器要出公网、要回调后端，这两条链路各需要一个辅助容器。


| 脚本                    | 作用                                                       | 命令                                          |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `egress-up.sh`          | 起沙箱出网代理（两条腿：沙箱网 + 公网）                    | `bash infra/scripts/egress-up.sh --allow-all` |
| `egress-down.sh`        | 收掉代理容器                                               | `bash infra/scripts/egress-down.sh`           |
| `relay-up.sh`           | 起容器→后端中转（macOS/Windows 上 Docker 在 VM 里时必需） | `bash infra/scripts/relay-up.sh`              |
| `relay-down.sh`         | 收掉中转                                                   | `bash infra/scripts/relay-down.sh`            |
| `egress-probe.mjs`      | 从**沙箱网络里**验证代理连通（零依赖）                     | `node infra/scripts/egress-probe.mjs <url>`   |
| `egress-proxy.mjs`      | 代理**本体**（零依赖，被 `egress-up.sh` 挂进容器）         | 不直接执行                                    |
| `sandbox-relay.mjs`     | 中转**本体**（零依赖，被 `relay-up.sh` 挂进容器）          | 不直接执行                                    |
| `egress-idle-smoke.mjs` | 冒烟测试：模型端点隧道的空闲上限                           | `pnpm egress:idle-smoke`                      |

> ⚠️ 这两个容器的名字是**固定**的（`doubulea-egress` / `doubulea-sandbox-relay`），
> 后端自检按名字认它们。同一台机器跑多个实例时由**先起的实例**负责，后起的复用。

---

## 四、本地开发（9 个）

日常改代码用这组。**与生产部署无关**。


| 脚本                   | 作用                                            | 命令                                |
| ------------------------ | ------------------------------------------------- | ------------------------------------- |
| `dev-run.sh` / `.ps1`  | 一键起完整开发环境（依赖 + 迁移 + 后端 + 前端） | `pnpm dev` / `pnpm dev:stop`        |
| `dev-stop.sh` / `.ps1` | 收掉 dev-run 起的后台进程                       | `bash infra/scripts/dev-stop.sh`    |
| `dev-up.sh` / `.ps1`   | 只起依赖服务 PG / Redis / MinIO                 | `bash infra/scripts/dev-up.sh`      |
| `dev-down.sh` / `.ps1` | 停依赖服务（**永不删数据卷**）                  | `bash infra/scripts/dev-down.sh`    |
| `infra.mjs`            | 跨平台入口，按当前系统选 `.sh` 或 `.ps1`        | `pnpm infra:up` / `pnpm infra:down` |

---

## 五、自检与杂项（3 个）


| 脚本                       | 作用                                                        | 命令                 |
| ---------------------------- | ------------------------------------------------------------- | ---------------------- |
| `pg-verify.mjs`            | 12 项验收：pgvector + pg_bigm 是否可用                      | `pnpm infra:verify`  |
| `router-compose-check.mjs` | 校验两套 compose 配置（不需要 daemon）                      | `pnpm router:config` |
| `check-batch-marker.mjs`   | 批次标识自检                                                | `pnpm check:batch`   |
| `link-workspace.mjs`       | 补齐 workspace 软链（`pnpm install` 的 postinstall 自动跑） | 不用手动执行         |

---

# 本地开发环境：完整命令

## 首次（一次性）

```bash
# 1. 依赖
git clone <仓库> doubleA && cd doubleA
nvm use 22 || nvm install 22      # 必须 Node 22（Node 20 会在 prisma generate 上崩）
corepack enable && pnpm install
pnpm -r build

# 2. 环境变量
cp infra/.env.example infra/.env
#   必填 CREDENTIAL_MASTER_KEY（生成见下）与 POSTGRES_PASSWORD / S3_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 3. 沙箱镜像（只有要跑 Code 模式 / taskAgent 才需要）
export SANDBOX_NPM_REGISTRY=https://registry.npmmirror.com   # 内网必须
pnpm sandbox:build
#   跑完会把两行 SANDBOX_IMAGE / SANDBOX_IMAGE_BASE 打印出来，抄进 infra/.env
```

## 日常

```bash
pnpm dev
```

它做四件事：起依赖服务 → `db:deploy` + `db:seed` + `db:partitions` → 后端（tsx watch，:13000）→ 前端（vite，:5174）。


| 地址                          | 用途                                   |
| ------------------------------- | ---------------------------------------- |
| http://localhost:5174         | 前端（改代码热更新）                   |
| http://127.0.0.1:13000/health | 后端健康检查                           |
| http://127.0.0.1:19001        | MinIO 控制台                           |
| `.dev-logs/`                  | 后端 / 前端 / 数据库日志               |
| `.dev-logs/seed.log`          | 种子账号初始密码（`admin` / `member`） |

常用变体：

```bash
pnpm dev -- --no-infra      # 依赖服务已在跑，跳过
pnpm dev -- --no-db         # 跳过迁移/种子
pnpm dev -- --force         # 已在跑就重启
pnpm dev:stop               # 只停后端 + 前端
```

## Windows

PowerShell 没有 bash，用对应的 `.ps1`：

```powershell
powershell -ExecutionPolicy Bypass -File infra\scripts\dev-run.ps1
powershell -ExecutionPolicy Bypass -File infra\scripts\dev-stop.ps1
```

## 单独操作

```bash
pnpm infra:up           # 只起 PG / Redis / MinIO
pnpm infra:down         # 停它们（数据卷保留）
pnpm infra:verify       # 验收 pgvector + pg_bigm
pnpm infra:ps           # 看容器状态
pnpm infra:logs         # 跟踪日志

pnpm db:deploy          # 应用迁移
pnpm db:seed            # 种子账号（幂等，不改已有密码）
pnpm db:partitions      # 分区续期
pnpm db:status          # 迁移状态

pnpm verify:chat-sse    # 各项 UI 自检（chat-sse / chat-home / workspace / admin …）
```

## 停止

```bash
pnpm dev:stop                        # 只停应用（依赖服务继续跑）
bash infra/scripts/dev-stop.sh --infra   # 连依赖服务一起停
bash infra/scripts/dev-down.sh           # 停依赖服务（数据卷保留）
```

> ⚠️ `dev-down.sh` **不会删除数据卷**。要清空数据必须手动执行，且不可恢复：
> `docker compose -f infra/docker-compose.yml --env-file infra/.env down -v`

## 常见问题


| 症状                                      | 原因                         | 处理                                                                                                       |
| ------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `ERR_REQUIRE_ESM` on `prisma generate`    | Node 20                      | `nvm use 22`                                                                                               |
| 前端串到 3000 端口的陌生服务              | 忘了 `VITE_DEV_PROXY_TARGET` | 用 `pnpm dev`（会自动传）；验证 `curl --noproxy '*' http://localhost:5174/api/auth/me` 应得本项目 401 信封 |
| 5174 被占                                 | 端口固定不顺延               | 停掉占用方，脚本**不会**自动换端口                                                                         |
| Code 模式报 `EACCES /var/run/docker.sock` | socket gid 不对              | 设 `DOCKER_SOCKET_GID`（取容器视角的 gid）                                                                 |
| 沙箱构建卡在 `npm install` 十几分钟       | 直连 npmjs 被拦              | 设 `SANDBOX_NPM_REGISTRY`                                                                                  |
| `pnpm dev` 起不来                         | 依赖服务端口被占             | 改 `infra/.env` 的端口，别停别人的容器                                                                     |
