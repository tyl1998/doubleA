# doubuleA 工程手册（原根 README）

> ⚠️ **2026-10-24 迁入 `docs/`**：根 `README.md` 已改写为**项目门面式 README**（定位 / 技术栈 /
> 功能概览 / 快速开始 / 部署 / 文档索引）。本文件是**原根 README 的完整存档** —— 环境准备、
> 端测步骤、批次验收记录、目录规划等工程手册内容仍在这里，按需查阅。
> 返回门面：`README.md`。

> 公司内部 Agent 平台：**问知识、派任务、接工具**。
> 全新建设，单组织内部使用，无商业化能力。
>
> 本仓库是**单仓 monorepo**（pnpm workspace），同时承载设计文档与全部工程代码。技术底座：TypeScript 单体后端 + React 前端 + PostgreSQL(pgvector + pg_bigm) + Redis + 对象存储 + Docker 沙箱。

---


## 〇、文件地图（2026-09-26 拆分后）

> 本文件原为单文件 **414KB**。2026-09-26 按「**活件留主文件、完成态入归档**」拆分：
> 主文件只留"**现在要做的事**"，**已完成批次的端测步骤与历史记录**移入 `docs/归档/`（按需查阅、不必整读）。

| 内容 | 位置 |
|------|------|
| **一键起整套**（`pnpm dev` / `pnpm dev:stop`） | 本文 **§一**（脚本 `infra/scripts/dev-run.sh` / `dev-stop.sh`；日志 `.dev-logs/`、pid `.pids/`） |
| 环境准备 / 起依赖 / 起后端 / 起前端 / 常用命令 | 本文 **§一** |
| **沙箱 egress 代理**（`egress-up.sh` / `egress-down.sh` / `egress-proxy.mjs` / `egress-probe.mjs`，均在 `infra/scripts/`） | 本文 **§一**（一键起整套）+「阶段三出口验收」前置 ③ |
| **浏览器端测 · MCP**（阶段二唯一浏览器端测点，**待人工取证**） | 本文 **§一** |
| **阶段一出口验收（人工）** / **阶段二出口验收（人工）** / **阶段三出口验收（人工 · P0-3-13 收尾）** | 本文 **§一**（**未验，待人工执行**；⚠️ 阶段三那条自带环境前置，见该节开头） |
| P0-1 的五个浏览器端测小节（登录 / 智能体 / 对话 / 知识库 / 管理页） | → `归档/README-浏览器端测-P0-1.md` |
| `手工端测 · 命令行`（P0-1-9 起的 curl 步骤） | → `归档/README-命令行端测.md` |
| 各 `verify:*` 档的历史断言清单（脚本已删，仅作记录） | → `归档/README-历史验收集.md` |
| 版本记录 | → `归档/README-版本记录.md` |
| 文档清单 / 核心决策速查 / 实施路线 / 目录规划 | 本文 **§二 ~ §五** |

> ⚠️ **正文里的引用对照**（拆分后请这样读）：凡出现「**手工端测 · 命令行**」㉑~㉔、
> 「**浏览器端测**」（登录）／「浏览器端测 · **智能体**」／「浏览器端测 · **对话**」／
> 「浏览器端测 · **知识库**」／「浏览器端测 · **管理页**」这些字样，**步骤都在上面两张表指向的归档文件里** ——
> 小节标题与编号**原样未变**，照抄即可，只是换了个文件。
> **例外**：「**浏览器端测 · MCP**」仍在本文 §一（它是阶段二唯一、且**尚未取证**的浏览器端测点）。

> 另两份文档同日做了同类拆分：`docs/06-实施计划.md`（主文件 648KB → 57KB）、`docs/02-后端设计.md`。

---

## 一、快速开始

> **环境有两套，同一仓库通用**（命令除注明外两平台一致）：
>
> | 平台 | pnpm 来源 | 启停脚本 |
> |------|-----------|----------|
> | Windows + Git Bash | corepack 提供，**必须用系统 node 启动**（受管 node 下 pnpm shim 失效） | `infra/scripts/dev-*.ps1` |
> | macOS / Linux | 同样 corepack 提供：`corepack enable pnpm` 后 `pnpm` 直接可用 | `infra/scripts/dev-*.sh` |
>
> `pnpm infra:up` / `pnpm infra:down` 经 `infra/scripts/infra.mjs` **自动按平台选脚本**，
> 故下方命令不必记平台；也可直接调对应平台的脚本。

```bash
# 安装依赖（三包一次装齐）
pnpm install

# 全量构建（三包依次产出 dist）
pnpm -r build

# 单独构建（独立构建/独立部署能力的地基，见 docs/06 §二·补）
pnpm --filter @doubulea/shared   build
pnpm --filter @doubulea/backend  build     # → backend/dist
pnpm --filter @doubulea/frontend build     # → frontend/dist（纯静态）
```

> 后端/前端 dev 命令见各包 `scripts`（本机脚本一律走 Node / 平台原生脚本，不依赖 Git Bash 工具链）。

### 一键起整套（推荐）

```bash
pnpm dev          # 依赖服务 → 建表/种子 → 后端(13000) → 前端(5174)：一条命令到浏览器能打开
pnpm dev:stop     # 收掉后端 + 前端（依赖服务留着）；--infra 连依赖一起停
```

> 后端 / 前端在**后台**跑：日志 `.dev-logs/{backend,frontend,db,seed}.log`，pid `.pids/`（两目录都在 `.gitignore` 里）。
> 步骤是**幂等**的（依赖服务已在跑就跳过；迁移/种子本来就幂等）⇒ 反复跑这条命令是安全的。
> 常用开关：`--no-infra`（依赖已在跑）/ `--no-db`（不想每次跑迁移种子）/ `--force`（已在跑就重启）/
> `--timeout N`；完整清单 `bash infra/scripts/dev-run.sh --help`。
> ⚠️ 它**不含沙箱镜像、也不含 egress 代理** —— 要往沙箱派活还得另做三件事（见「阶段三出口验收」前置 ②③）：
> ① `pnpm sandbox:build`（把镜像推到版本线对应的 tag，并写回 `infra/.env`）；② `bash infra/scripts/egress-up.sh --write-env`
> （沙箱出公网的代理，**必须在后端起来之后**再跑）；③ 一个**有额度**的模型池。三者缺一，界面上的症状各不相同。
> 想分步做、或想在前台看热更新输出，就往下看各小节，用 `pnpm infra:up` / `pnpm dev:backend` / `pnpm dev:frontend`。

### 沙箱出公网的代理（只有跑沙箱 / 阶段三出口验收才需要）

```bash
bash infra/scripts/egress-up.sh --write-env   # 起代理（两条腿）+ 把地址写进 infra/.env
bash infra/scripts/egress-down.sh             # 收工（只删代理容器，不动沙箱网络）
```

> 沙箱容器挂在 `doubulea-sandbox`（`Internal: true`）上**没有公网路由** ⇒ 出公网**只可能**经这个代理；
> `SANDBOX_EGRESS_PROXY_URL` 留空时 `ensureSandbox()` 会**直接拒绝**派活（不是"卡住不动"）。
> ⚠️ **顺序**：那张网由**后端启动时**的 listener 建出来 ⇒ 先 `pnpm dev`（看到「沙箱状态」那行），再跑本脚本。
> 白名单默认自动取库里 `enabled` 的 `model_providers` 主机名（**空白名单 = 拒启**，不是全放行）。
> 完整形态要求（两条腿 / 无鉴权）、验证三条、macOS 两堵墙，见「阶段三出口验收」前置 ③。

### 多机部署：构建两个平台镜像 + 两套 compose（P1-14 · R1 起；2026-10-19 拆成后端 / 网关两个镜像）

```bash
pnpm backend:build-image               # 业务后端 doubulea-backend:2（全量依赖 + Prisma，813MB）
pnpm gateway:build                     # 路由网关 doubulea-gateway:2（只装 fastify / ioredis / zod，273MB）
pnpm frontend:build-image              # 前端静态站点 doubulea-frontend:2（nginx + dist，64MB）
pnpm backend:build-image -- --save out.tar   # 无 registry 的多机分发：scp 到各台后 docker load -i
pnpm gateway:build -- --save gateway.tar     # 同上（三个镜像各自分发）
pnpm router:config                     # 两套 compose 的配置自检（不需要 daemon 起来）
```

```bash
# 每台机器（A / B / C）：backend + egress
cp infra/router/.env.node.example infra/router/.env.node     # 改 SANDBOX_INSTANCE_ID / ADVERTISE_ADDR
cp <三台共用那份 env> infra/router/.env.node.shared          # DATABASE_URL / REDIS_URL / S3_* / SANDBOX_IMAGE …
docker compose -f infra/router/docker-compose.host.yml --env-file infra/router/.env.node up -d

# 网关（一个入口；**当前按 1 副本部署**，多副本经决定暂不做，见 子方案 §八·补）
cp infra/router/.env.router.example infra/router/.env.router # 改 ROUTER_UPSTREAMS / REDIS_URL

# 前端（nginx 托管 SPA，并把 /api、/health 反代到网关）
cp infra/frontend/.env.frontend.example infra/frontend/.env.frontend # 改 ROUTER_UPSTREAM（指向网关，**不是**后端）
docker compose -f infra/frontend/docker-compose.yml --env-file infra/frontend/.env.frontend up -d
docker compose -f infra/router/docker-compose.router.yml --env-file infra/router/.env.router up -d
```

> **两个镜像**（2026-10-19 拆分）：`doubulea-backend:2` 跑业务后端（`node /app/backend/dist/backend/src/index.js`）；
> `doubulea-gateway:2` 跑路由网关（`node /app/backend/dist/backend/src/router/main.js`，只装 fastify/ioredis/zod，
> 不含 Prisma / antd / vite —— 原"一个镜像两个角色"时网关镜像 813MB，其中 531MB 是它永远加载不到的依赖）。
> 网关容器仍**必须**带 `DOUBULEA_SANDBOX_ROLE=router`。
> 网关是**非沙箱宿主**：不抢 `sandbox:instance:{id}`、不登记心跳、不对账、不起出口② listener
> （判据见 `backend/src/sandbox/roleOverride.ts`；不配该 env 时"配了 `SANDBOX_IMAGE` 且本机有 Docker"才算宿主）。
> **上游表** = 静态 `ROUTER_UPSTREAMS` ∪ 自动发现（`ROUTER_DISCOVERY_SEC`，默认 10s 扫 `sandbox:instance:*`）；
> 网关 `/health` 的 `discovery` 段能直接看出"看见了哪几台、哪台被判过期"。
> **负载感知（R3/R4）**：实例心跳把 `slotsUsed/slotsTotal/queueDepth/chatbotInFlight` 写进注册值；网关对**新落点**
> 按 P2C 挑较空的实例（`ROUTER_LOAD_AWARE`，默认开；`false` = 纯轮询），粘性命中的会话永远回原机；
> `/health` 的 `load` 段给出每台上游的占用 / 队深 / 负载年龄 `ageMs` / 是否 `stale`（阈值 `ROUTER_LOAD_STALE_MS`，缺省 2× 心跳）。
> **运行时与实例（P1-17a × P1-14，2026-10-19）**：实例心跳带上 `runtimes`（本机已就绪的变体 id）与
> `canBuild`；`GET /api/sandbox/runtimes` 的 `instances[]` 给出**每台**的能力（`known=false` = 该实例没上报，显示"未知"）。
> Code 会话在工作区头部**一个按钮**打开「运行位置与环境」弹窗（按实例列卡片、显示繁忙度与环境并集）。
> 点环境 = 选「实例 + 运行时」→ `POST /api/conversations/:id/runtime` + `POST /:id/instance`（点名，已有 owner 指向别台时 409）。
> 选「自动」= `instanceId: null` + `runtime`：后端挑一台**具备该环境（否则能构建）**的实例并按较空闲（占用率→队深）选点；
> **原 owner 仍满足 ⇒ 不动目录**（`auto`），不满足 ⇒ 覆盖 owner 重选（`auto-reselected` + `hint`，B 方案）。
> ⚠️ 覆盖只换目录，不跨机清理原实例的容器/工作区（由原实例的空闲回收/启动对账兜底）。
> 按需构建要求后端容器能读到 `infra/sandbox`：`docker-compose.host.yml` 已把它挂到 `/app/infra/sandbox:ro`
> 并设 `SANDBOX_RUNTIME_BUILD_CONTEXT=/app/infra/sandbox/runtime`，否则页面上的「+ 去创建环境」不会出现。
> **在哪台构建**：构建任务是**进程内**的 ⇒ 任务状态/取消走 `/api/sandbox/runtimes/build/<instanceId>/<buildId>`，
> 启动请求带 `?instanceId=`（网关对这两个位置做**点名路由**：粘性 > 点名 > P2C；点名不在上游表里则忽略）。
> 后端容器里没有 docker CLI、而 macOS 宿主的 docker 是 Mach-O ⇒ compose 里加了 `docker-cli` 侧车，
> 把 Linux 版 `docker` 与 `docker-buildx` 复制进命名卷，backend 只读挂 `/opt/doubulea-docker-bin` 与
> `/usr/local/libexec/docker/cli-plugins`；构建强制 `DOCKER_BUILDKIT=1`（Dockerfile 有 `RUN --mount=type=cache`）。
> 多机端到端（`子方案` §八 6 R1~R6 + §九·补 6 R7~R10）需 ≥2 台宿主。
> ⚠️ 后端容器必须 `network_mode: host` + 挂 `/var/run/docker.sock`（见 `infra/router/docker-compose.host.yml` 文件头）。

#### 第二台机器接入步骤（以 10.73.100.153 为 A、10.73.100.195 为 B，共享 A 上的 PG/Redis/MinIO）

> 前置：A 的 `infra/.env` 已能起依赖服务；A 上三件套已跑通（`:8080` 能登录、`/health` 的
> `discovery` 至少有一台）。B 只需要**后端 + egress**，网关与前端仍是**一份**（在 A 上）。

```bash
# —— B 上 ——（以下命令按顺序粘贴即可；会交互的两步写在注解里）
# ① 代码 + 依赖（Node ≥22：pnpm 的 prepare 会跑 Prisma，Node 20 会 ERR_REQUIRE_ESM）
git clone <仓库地址> doubleA && cd doubleA
nvm use 22 || nvm install 22          # .nvmrc 已是 22
corepack enable pnpm && pnpm install
pnpm -r build

# ② 沙箱镜像：B 必须**与本机同版本线**（versions.mjs 的 base/toolkit/runtime 层版本）
pnpm sandbox:build                     # 内网先 export SANDBOX_NPM_REGISTRY=https://registry.npmmirror.com
#    或者从 A 导出后拷贝：docker save doubulea/sandbox-base:6 doubulea/sandbox-toolkit:8 \
#      doubulea/sandbox-runtime:node22-python310-v2 | ssh 用户@10.73.100.195 'docker load'

# ③ 三份 env（都不进 git）
#    .env.node.shared：与 A **同一份**（含 CREDENTIAL_MASTER_KEY / S3_*）；
#      ⚠️ 容器内不能用 127.0.0.1 ⇒ 宿主侧依赖一律写 10.73.100.153
#    .env.node：SANDBOX_INSTANCE_ID=b、SANDBOX_INSTANCE_ADVERTISE_ADDR=10.73.100.195:13000
#    DOCKER_SOCKET_GID：stat -c '%g' /var/run/docker.sock（macOS 用 stat -f '%g'）

# ④ 后端（+ egress 容器）
docker compose -f infra/router/docker-compose.host.yml --env-file infra/router/.env.node up -d backend

# ⑤ 出口①：网由后端启动时创建 ⇒ 必须**在后端起来之后**再起
bash infra/scripts/egress-up.sh --allow-all

# —— A 上验证 ——
curl -s http://127.0.0.1:13100/health      # 网关 /health：discovery.discovered 应出现 10.73.100.195:13000
curl -s http://127.0.0.1:8080/health | node -e '…'  # load 段应同时有 A、B 两台
```

踩过的坑（两台都会遇到，已修进 compose / 脚本）：

| 症状 | 原因 | 修法（已落地） |
|---|---|---|
| `EACCES /var/run/docker.sock`，沙箱起不来 | 容器内 uid 10001，宿主 socket 是 `root:docker 660`（Ubuntu）或 `root:root 660` | `docker-compose.host.yml` 的 `group_add: ${DOCKER_SOCKET_GID}`；每台用 `stat` 填 |
| 容器内后端监听 3000，healthcheck 打 13000 失败 | `environment:` 不自动透传 `--env-file` 的键 | 已显式 `BACKEND_PORT: ${BACKEND_PORT:-13000}` |
| Code 模式报 `EACCES: permission denied, mkdir '/var/lib/doubulea'` | 同上：`WORKSPACE_ROOT` 没透传，回落到 Linux 默认且容器内 uid 10001 建不了 `/var/lib` | 已显式 `WORKSPACE_ROOT: ${WORKSPACE_ROOT:-…}`（且与 bind mount 源路径逐字一致） |
| 同一台起网关时端口冲突 | `network_mode: host` 与发布端口都想占 13000 | 网关放 A（或换 `ROUTER_PORT`），后端 13000 只留给实例 |
| `SANDBOX_INSTANCE_ID 与在线的另一实例冲突 ⇒ 拒绝启动` | 同 id 的旧心跳 TTL 未过期（3× 心跳） | 等 ~90s；确属旧实例残留再 `DEL sandbox:instance:<id>` |
| 冒烟对话能过、Code 沙箱里模型 `EAI_AGAIN` | 沙箱 `fetch()` 默认不吃 `HTTP(S)_PROXY`（Node 内置 undici 不读） | 见「已知问题」——引擎侧用 `EnvHttpProxyAgent` 时不受影响 |

> **端口口径（2026-10-19 定）**：`13000` 是**每台实例后端**的端口（`SANDBOX_INSTANCE_ADVERTISE_ADDR`、
> `ROUTER_UPSTREAMS` 都指向它）；**网关默认 `13100`**（`ROUTER_PORT`），前端 `ROUTER_UPSTREAM` 指 `http://<网关>:13100`。
> 同一台机器同时跑后端与网关时，两者若都用 13000，在 macOS 上会因 host 网络与端口转发争用而失败。
>
> ⚠️ **本机（macOS + OrbStack）的实测边界**（2026-10-19）：`network_mode: host`、DooD 起兄弟容器、
> 宿主同名路径 bind mount 三项**成立**；但后端容器**不能**与网关/宿主共用 13000（OrbStack 的端口转发
> 与 host 网络争用），因此 153 上实证验收用的是「后端进程 + 网关容器 + 前端容器」。Linux 上以 compose 形态为常态。

#### 节点档位与实例管理（2026-10-19 起；部署减负）

每台节点只需起**一个后端容器**，角色由 env 决定：

| `DOUBULEA_NODE_ROLE` | 起什么 | 是否需要 docker.sock / egress / relay | 进实例列表 |
|---|---|---|---|
| `chatbot` | 只起后端 | **都不需要** | 否（不登记心跳） |
| `taskAgent` | 后端 + 沙箱依赖 | 需要（可在管理页一键补齐） | 是 |

**镜像里已自带运维脚本**：`infra/scripts` 与 `infra/sandbox`（构建上下文）打进 `doubulea-backend:2` 的
`/app/infra/`，因此新节点**只需要 `docker load` 这一个后端镜像**，不必再拷源码目录；自举要用脚本时
后端会把它们写进命名卷 `doubulea-node-infra`（容器内 `/opt/node-infra`），兄弟容器用同一个卷挂到 `/app`。
只有想"热修脚本不重建镜像"时才用覆盖文件：
`docker compose -f docker-compose.host.yml -f docker-compose.host.dev.yml ... up -d backend`。

`/admin/sandbox-instances` 是**实例管理**页：每台实例一行，展开即见该实例的自检结果
（Docker / 沙箱网 / egress / relay / 构建上下文 / toolkit / 运行时 / 工作区），并可在**那一行**上
点「一键初始化」。**未就绪的实例可见但不可选**（表格标「未就绪」，会话的「运行位置与环境」弹窗里置灰）。

```bash
# 只做对话的节点：不用挂 socket
docker run -d --name doubulea-backend -p 13000:13000 --env-file infra/.env \
  -e DOUBULEA_NODE_ROLE=chatbot doubulea-backend:2

# 沙箱宿主节点：两种起法（效果等价）
#   ① 一条命令（推荐；新机器只有镜像时用这个）——读 .env.node + .env.node.shared，
#      自动建命名卷、准备 docker CLI、起后端并等 /health 就绪
#      ⚠️ 2026-10-20 起它是**兼容入口**：实际执行的是 deploy/scripts/up.sh（只保留一份实现，
#         避免 socket gid / 卷 / 侧车在两处漂移 —— 之前就因此漏修过一次）
bash infra/scripts/node-up.sh
#   ② compose（会带出 docker-cli 侧车）
docker compose -f infra/router/docker-compose.host.yml --env-file infra/router/.env.node up -d backend
# 停止：bash infra/scripts/node-down.sh（不动 egress/relay/卷）

# 管理任意实例（本机直跑；远端经签名转发到那台执行）
curl -s -b cookies.txt 'http://10.73.100.153:8080/api/admin/node/self?instanceId=b' | jq '.data.ready, .data.items'
curl -s -b cookies.txt -X POST -H 'content-type: application/json' \
  -d '{"instanceId":"b"}' http://10.73.100.153:8080/api/admin/node/bootstrap | jq '.data.steps'
```

**一键初始化只修未就绪的项**（幂等；健康的项显示"跳过"，不会重建容器；全部健康时按钮禁用，防误触）：
① 建沙箱网 ② `docker-cli` 侧车检查（缺镜像先 `docker pull $DOCKER_CLI_IMAGE`）③ **toolkit**：缺了才先
`docker pull ${SANDBOX_TOOLKIT_PULL_FROM}`（配置了才拉）、拉不到再用仓库脚本 `--toolkit-only` 构建
④ `egress` 未运行/未接沙箱网时重建（缺 `$EGRESS_IMAGE` 先拉）⑤ macOS/Windows 的 `relay` 未运行才拉起
（缺 `$RELAY_IMAGE` 先拉；Linux 判定为"不需要"）。
> 脚本本身刻意"离线可跑"（不拉镜像）；**拉取只发生在初始化**这一步，走宿主 Docker 网络。拉不到如实报
> "请离线导入或配置内网镜像源"（`EGRESS_IMAGE` / `RELAY_IMAGE` / `DOCKER_CLI_IMAGE` 都可改指向内网）。
> **四个命名卷**（`node-up.sh` 会建好）：`doubulea-docker-bin`（构建用 CLI）、`doubulea-docker-buildx`、
> `doubulea-node-infra`（内置脚本中转，兄弟容器挂 `/app`）、`doubulea-egress-policy`（出网策略中转，
> egress 挂 `/egress-allow`）。后两个存在的原因：脚本可能运行在**后端容器内**，而 `docker run -v` 的源
> 由**宿主**解析 —— 用卷才能让"写策略的那一方"和"读策略的容器"看到同一份文件。

**跨实例**：A 的后端用 `NODE_OPS_SECRET`（三台**同一份**）签发一次性令牌，转发到目标实例的
`/internal/node/*`；目标校验签名 + 消费 nonce（Redis `SET NX`，防重放）后执行。未配置该密钥 ⇒
只能管理本机（错误里会写明）。内部端点**只做自检/自举**，不接受任意命令。

镜像只需 **toolkit**（空环境）+ 按需构建的语言运行时；`sandbox-base` 只在构建 toolkit 时用到。

#### 新节点需要哪些镜像（2026-10-19）

一台新节点**只靠后端镜像不够**：容器里没有 docker CLI，自举/按需构建都要它。清单：

| 镜像 | 是否必需 | 153 上导出 | 195 上导入 |
|---|---|---|---|
| `doubulea-backend:2` | 必需 | `docker save doubulea-backend:2 -o backend.tar` | `docker load -i backend.tar` |
| `docker:27-cli` | **必需**（`node-up` 用它填 `doubulea-docker-bin` 卷） | `docker save docker:27-cli -o docker-cli.tar` | `docker load -i docker-cli.tar` |
| `node:22-bookworm-slim` | 必需（egress / relay 的运行时） | `docker save node:22-bookworm-slim -o node22.tar` | `docker load -i node22.tar`；能联网时初始化会自动拉 |
| `doubulea/sandbox-toolkit:8` | 建议（空环境） | `docker save doubulea/sandbox-toolkit:8 -o toolkit.tar` | 或者在初始化时按 `SANDBOX_TOOLKIT_PULL_FROM` 拉 / 本地构建 |
| `doubulea/sandbox-runtime:*` | 可选（语言运行时） | 按需 | 按需；也可在实例上「构建新环境」 |

`node-up.sh` / `node-up.ps1` 在拉不到 `$DOCKER_CLI_IMAGE` 时会直接打印这份清单与两条命令（不静默失败）。
内网有镜像源时，把 `.env.node` 的 `DOCKER_CLI_IMAGE` / `EGRESS_IMAGE` / `RELAY_IMAGE` 改成内网地址即可。

> **`node-up` 也会带出 `docker-cli` 侧车**（`nodeBootstrap.ts#DOCKER_HOST_NAME` 按**容器名**
> `doubulea-docker-cli` 认它；`bootstrapNode` 刻意不就地起它，见该函数注释）。侧车已在跑 ⇒ 幂等跳过；
> 构建侧按需的 `sandbox-build.mjs` 在容器里**只认 `DOCKER_BIN` / `SANDBOX_DOCKER_BIN`**（后者即卷里那个
> 二进制），所以 `node-up` 同时给后端注入 `PATH=/opt/doubulea-docker-bin:…` —— 缺了它，「一键初始化」
> 的 toolkit 构建会报「找不到 docker 可执行文件」，页面则显示「侧车未运行」。

#### Windows 节点（`node-up.ps1`）

Windows 上 `node-up.sh` 跑不了（没有 bash），而且 **Linux 容器不支持 `--network host`**（Docker Desktop
的已知限制），所以 `node-up.ps1` 走的是另一条腿：**发布端口** + `host.docker.internal` + relay。

```powershell
# 前提：Docker Desktop 已开「Settings → General → Expose daemon on tcp://localhost:2375 without TLS」
docker load -i backend.tar
powershell -ExecutionPolicy Bypass -File infra\scripts\node-up.ps1 `
  -EnvFile infra\router\.env.node -SharedFile infra\router\.env.node.shared
# 停止
powershell -ExecutionPolicy Bypass -File infra\scripts\node-down.ps1
```

与 macOS/Linux 的差异（`node-up.ps1` 已内置）：

| 项 | macOS / Linux | Windows |
|---|---|---|
| 网络 | `--network host` | `-p 13000:13000 -p 13001:13001` |
| 后端访问宿主 Docker | 挂 `/var/run/docker.sock` | **不挂**（宿主是 named pipe）；`DOCKER_HOST=tcp://host.docker.internal:2375` |
| socket gid | `--group-add <gid>` | 不需要（走 TCP） |
| 出口② | listener 绑沙箱网桥网关 | relay（`DOUBULEA_HOST_PLATFORM=win32` ⇒ 自举判定需要 relay） |
| 工作区 | `$HOME/doubulea/workspaces` | `%USERPROFILE%\doubulea\workspaces`（bind mount 必须是 Windows 绝对路径） |

> ⚠️ Windows 这条路径**尚未在真机上验证**（本仓库只在 macOS/OrbStack 上跑过）：代码里
> `needsRelayFor()` 已按 `win32` 判定、脚本已按上表实现，但 2375 的 daemon 暴露与 named pipe 的
> 差异只有在 Windows 机器上才能最终确认。首次使用请先跑 `docker run --rm alpine nc -zv host.docker.internal 2375`。

### 起依赖服务（postgres / redis / minio）

```bash
# 一键：构建自建 PG 镜像 → 拉起三服务 → 等健康 → 自动验收扩展（跨平台）
pnpm infra:up

# 等价写法：
#   Windows  powershell -ExecutionPolicy Bypass -File infra/scripts/dev-up.ps1
#   macOS    bash infra/scripts/dev-up.sh

# 停服（保留数据卷）
pnpm infra:down            # 或 dev-down.ps1 / dev-down.sh

# 停服并删除数据卷（⚠️ 数据全丢）
pnpm infra:down -- --purge
```

| 服务 | 地址 | 说明 |
|------|------|------|
| PostgreSQL | `127.0.0.1:15432` | 自建镜像 `doubulea/postgres:pg16-vector-bigm`（pgvector + pg_bigm） |
| Redis | `127.0.0.1:16379` | AOF everysec（重启不丢队列与锁） |
| MinIO API | `127.0.0.1:19000` | S3 兼容 |
| MinIO 控制台 | http://127.0.0.1:19001 | 账号见 `infra/.env` |

> ⚠️ **端口以 `infra/.env` 为准，上表是当前本机的实际值**。macOS 本机 5432/6379/9000/9001
> 已被另一项目（`apitest-server`）的容器占用，故整组后移到 1xxxx；compose 文件里端口本就是
> `宿主端口 ← 环境变量`，冲突时只改 `.env`，**不要动 compose，也不要停别人的容器**。

> **首次使用**先 `cp infra/.env.example infra/.env`（Windows：`Copy-Item`），并填入 `CREDENTIAL_MASTER_KEY`
> （生成：`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`）。
> 单独只跑 PG 扩展验收：`pnpm infra:verify`（12 项检查，含 `bigm_similarity` 中文相似度）。

### 构建沙箱镜像（P0-3-1 起；⚠️ 只构建，现在还派不了活）

TaskAgent 的沙箱是**三层结构**（`子方案③` §五）：`base`（Node + pin 版 pi + 桥扩展）、
`toolkit`（**构建期预烘焙**的 python/pandas/openpyxl/jq/git/rg）、`workspace`（**不是镜像**，是每会话的卷）。
版本号只有一个来源：`infra/sandbox/versions.mjs`。

```bash
pnpm sandbox:build                     # base → toolkit；末尾直接打印该写进 infra/.env 的两行
pnpm sandbox:build -- --no-cache       # 不用 layer cache（改了 apt 源/想彻底重来时）
pnpm sandbox:build -- --toolkit-only   # 只重建 toolkit（加了一个 python 库就用它）
pnpm sandbox:build -- --dry-run        # 只打印将要执行的 docker 命令，不真构建

# ⚠️ 本机（内网）**容器直连 registry.npmjs.org 不通** ⇒ 本机构建要换源（二选一）：
pnpm sandbox:build -- --registry https://registry.npmmirror.com
# 或写进 shell profile，之后照常用 pnpm sandbox:build
#   export SANDBOX_NPM_REGISTRY=https://registry.npmmirror.com
```

> ⚠️ **这个坑的症状很有欺骗性**（P0-3-1 实测）：容器**能通 HTTPS**（`deb.debian.org`、`baidu.com`
> 都是 200）、`apt-get update` 也过（它走**明文 HTTP**），**只有 npmjs 被拦**；而 npm 源不通时是
> **静默挂起**（默认 5 分钟/次 × 重试）⇒ 看起来像"卡住/包很大"，不是报错。
> base 层已配 `--fetch-timeout 90000 --fetch-retries 2`，源不通时会在 1~3 分钟内**失败**。

| 项 | 值 |
|----|----|
| base 镜像 | `doubulea/sandbox-base:5`（P0-3-14 起；`:3` 只注册 MCP 工具，`:2` 里是**空壳**桥扩展，`:1` 还缺 `gen-models.mjs` 那一步） |
| toolkit 镜像（**= 最终镜像**，`SANDBOX_IMAGE` 指它） | `doubulea/sandbox-toolkit:5` |
| pin 的引擎 | `@earendil-works/pi-coding-agent@0.87.1`（Node ≥ 22.19.0，镜像内实为 22.23.3） |
| 镜像内用户 | `agent`（uid 10001，**非 root**）；可写点只有 `/work`（卷）与 `/tmp`（P0-3-3 起是 tmpfs） |
| pi 配置 | **只读种子**烤进 `/opt/pi/agent`（`PI_AGENT_SEED`，对 agent 只读）；入口 `entrypoint.sh` 把它 `cp -an` **播种**到可写的 `/tmp/pi-agent`（`PI_CODING_AGENT_DIR`）后再 `exec pi`。⚠️ 必须两步：pi 读 `settings.json` 会**先在同目录加锁**，只读目录上加不上锁 ⇒ 整份 settings 被判 invalid 并**静默忽略**。里面**没有 `auth.json`**（Key 走容器环境变量）；**P0-3-4 起播种后多一步 `gen-models.mjs`** ⇒ 运行期生成 `models.json`，而它的 `apiKey` 只是 `${DOUBULEA_LLM_API_KEY}` **引用**（见「沙箱 LLM 注入」一节） |
| 依赖自检 | 构建末步跑 `toolkit/selfcheck.sh`，缺一个依赖就让 **build 失败** |
| 桥扩展 | `/opt/pi/agent/extensions/mcp-bridge/index.ts` —— **P0-3-9b 起是真实现**（`session_start` 拉 `GET /api/sandbox/mcp/tools` 并逐个 `pi.registerTool`；MCP 调用转成 `POST /api/sandbox/mcp/call`）。**P0-3-14 起还注册内置工具**（`builtinTools` 段里的 `knowledge_search` / `list_knowledge`，转成 `POST /api/sandbox/builtin/call`）⇒ 绑知识库的 TaskAgent 能检索。它**不含任何凭据**，只读容器 env 的 `SANDBOX_BACKEND_URL` / `SANDBOX_TOKEN` / `SANDBOX_PROXY_TIMEOUT_MS`（`sandbox/spec.ts` 是这三个名字的源头） |

```bash
# 在活容器里重跑依赖自检（排障时先跑它，能把"镜像问题"与"用法问题"分开）
docker run --rm --entrypoint /opt/sandbox-selfcheck.sh doubulea/sandbox-toolkit:5
# 手 run 一个"能说话"的容器（默认 CMD 就是 --mode rpc）
docker run --rm -i -v doubulea-sandbox-smoke:/work doubulea/sandbox-toolkit:5 --help
```

> ⚠️ **为什么 toolkit 必须构建期预烘焙**：egress 白名单只放行模型池 ⇒ 容器内 `pip install pandas` /
> `npm i` **必然失败**，而阶段三的验收场景「分析这份 CSV 出汇总表」恰恰要 pandas（`子方案③` §五 2）。
> 新增依赖 = 重建 toolkit 层 + 改 `versions.mjs` 里的层版本号，**不是运行时补**。
>
> ⚠️ **P1-17b 起口径更新**：运行时（语言栈）预烘焙、**依赖运行期经注册表出网拉**（§五之二）。
> 依赖目录（`node_modules` / `venv` / `target` / `dist` …）**不进产物 / 冷备 / 源码配额**。

**运行时层（P1-17a）—— 一变体一份镜像，按会话的 `runtime` 选**

```bash
# 构建 base → toolkit → 运行时层（默认 none/node/python/go/java/rust/multi + 版本化变体），
# 末尾打印要写进 infra/.env 的几行（SANDBOX_IMAGE_BASE / SANDBOX_IMAGE / SANDBOX_RUNTIME_REPO）
pnpm sandbox:build
# 只重建某几个变体（`--runtime` 可多选：逗号分隔或重复给；不给则全建）
pnpm sandbox:build -- --toolkit-only --runtime node22,python311
# 造版本化 / 组合变体（变体 id = 组件按语言顺序用 '-' 连接）
pnpm sandbox:build -- --toolkit-only --runtime python310,node22-python38
```

- **运行时列表来自后端探测**：后端扫本机镜像（`SANDBOX_RUNTIME_REPO` 前缀 + tag 约定 `<repo>:<变体>-v<层版本>`）得到"已就绪的运行时"，前端据它渲染；`SANDBOX_IMAGE` 是**回退镜像**（toolkit）。
- **按需构建（不用运维预先猜组合）**：用户要的组合本机没有时，在工作区头部点「**+**」勾选语言/版本 ⇒ 调 `POST /api/sandbox/runtimes/build` ⇒ **后端自动 `docker build`**（串行 + 同 tag 去重），成功后自动选用。组合即镜像 tag ⇒ 第二次命中缓存。后端能否构建取决于 `SANDBOX_RUNTIME_BUILD_CONTEXT`（dev 自动推断 `infra/sandbox/runtime`；生产镜像里通常没有 ⇒ `canBuild=false`）。
- **运行时 = 组件（语言+版本）的组合**：变体 id = 组件按语言顺序排序后用 `-` 连接（如 `node22-python310`）。组件目录在 `shared/src/runtime.ts`（与 `infra/sandbox/versions.mjs` **两处一致**）；加组件/版本要同时改这两处。
- **多栈并存 / 版本化**：例如「Python 3.10 + Node 22」= 组件 `python310 + node22`（多版本 python 由 `runtime/install-python-version.sh` 在**构建期**用 uv 装，系统 `python3` 仍是 3.11；各版本按 `python3.10`/`python3.8` 并存）。
- 只装运行时、**不装依赖**；依赖运行期在容器里经注册表出网拉，且**不进产物/冷备/源码配额**。

**人工端测（P1-17 · 运行时 + 依赖 + 凭据分相）**：
1. `pnpm sandbox:build`（本机需换源：见上 `--registry` / `--apt-mirror`）→ 把打印的几行写进 `infra/.env`（含 `SANDBOX_RUNTIME_REPO`）；
2. `pnpm dev` 起来后开一个 Code 会话，在工作区面板头部选运行时（下拉即后端探测到的列表），发一条「建一个最小 node 项目并跑 `npm test`」；
3. 预期：容器里 `npm ci` 成功（依赖经出网拉）、测试通过；工作区文件树里**看不到** `node_modules`（它不进索引/产物/冷备、不顶爆源码配额）；
4. 同一会话里再让 agent `git clone` 一个私有仓库 ⇒ 因已跑过 `npm`（进入 `run` 相），凭据请求被拒（后端日志 `CREDENTIAL_ISOLATED`）：这是**分相**的兑现，新开一个没跑过代码的会话仍能 clone。
5. ⚠️ 真跑取证由你完成（构建镜像 + 选运行时 + 真 clone）；本条只声明契约与配置已接好。


**构建提速与清理（P0-3-14 起）**：

- ⭐ **换 Debian 源**（本机最大的提速点）：官方 `deb.debian.org` 本机实测只 **~0.4MB/s**，而清华源
  `mirrors.tuna.tsinghua.edu.cn` **~6MB/s**（十几倍）⇒ **默认就用清华源**；海外/CI 用
  `--apt-mirror ''`（或 `SANDBOX_APT_MIRROR=`）显式回到官方：
  ```bash
  pnpm sandbox:build -- --registry https://registry.npmmirror.com --apt-mirror mirrors.tuna.tsinghua.edu.cn
  # 等价环境变量：SANDBOX_APT_MIRROR=mirrors.tuna.tsinghua.edu.cn
  # 显式留空（--apt-mirror ''）就是走官方源（CI / 海外环境用这个）
  ```
- ⭐ **apt 的三道保险**（2026-10-20；`infra/sandbox/apt-source.sh`，base/toolkit/runtime **共用一份**）：
  ① **IPv6 兜底** —— 构建容器没有 v6 默认路由时写 `Acquire::ForceIPv4`（否则 AAAA 先解析，
  apt 会 `Ign:` 重试 3×60s，一条 update 就是 12 分钟）；② **网速闸门** —— apt 对"慢"没有超时语义
  （实测官方源在只放行 443 的出口上 **28 KB/s**、一条 update 5 分半，看起来就是卡死），低于
  `--apt-min-bps`（`SANDBOX_APT_MIN_BPS`，默认 32 KB/s）就判该源不可用；③ **不通/不达标自动回落**
  —— 替换源不行就回镜像自带的官方源再试一次，都不行才失败，并打印"该配哪个变量 / 或离线导入镜像"。
  ⚠️ 新节点**一键初始化**构建 toolkit 时同样生效：在 `infra/router/.env.node` 里设
  `SANDBOX_APT_MIRROR=<host>`（如内网 mirror:8080）后重启后端，再点「一键初始化」。
- ⭐ **BuildKit 缓存挂载**：base / toolkit 的 `apt` 与 `npm` 步骤改成 `RUN --mount=type=cache` ⇒
  包里与索引留在**构建缓存**、不进镜像层；改了扩展导致 toolkit 重跑时，**不再重新下载**同样的 deb。
  ⚠️ 它**不需要** `# syntax=docker/dockerfile:1`（仍是刻意不写，见 Dockerfile 头部）；但要求 daemon 开 BuildKit（现代 Docker 默认开）。
- ⭐ **`--prune` 回收**：Docker **从不自动删**旧镜像/缓存。加 `--prune` 后，构建完自动清掉
  **不在保护名单**的旧 `doubulea/sandbox-*` tag、悬空镜像、已停的 sandbox 容器与无主卷，
  以及 **24h 之前**的构建缓存（保护名单 = 本次构建的两个 tag + `infra/.env` 正在用的 tag）：
  ```bash
  pnpm sandbox:build -- --registry https://registry.npmmirror.com --prune
  ```
  ⚠️ 想连近 24h 的缓存也一起清：`docker builder prune -f`（本机曾一次回收 ~30GB）。
  ⚠️ 只重建该变的层可省最多时间：`--base-only`（只改 pi/扩展）/ `--toolkit-only`（只加依赖）。
> ⚠️ **本步不是可端测里程碑**：容器生命周期**已落地**（P0-3-2，见下一节）、两条网络出口（P0-3-3）、
> 模型 Key 注入（P0-3-4，见后面「沙箱 LLM 注入」一节）都已落地，但**引擎桥还没接**（P0-3-5/6）
> ⇒ **当时还不能派活**。⚠️ 那条路已经走完：**P0-3-11 是端测里程碑（已落地）**，批次的镜像版本
> **已到 `:3`**（P0-3-9b 的桥扩展实现）—— 下面的 `:3` 才是当前该用的 tag。

### 沙箱容器生命周期（P0-3-2 起；⚠️ 仍然派不了活）

**这一段能验的不是"能不能发任务"**（那要等 P0-3-5/6 接上引擎桥），而是
**「会话即容器」的记账与清道夫在真 Docker 上确实在动** —— 尤其是那条最容易被当成玄学的
**孤儿回收器**：没有它，后端崩一次就会**永久吃掉并发名额**，症状是"**明明没人用却在排队**"。

代码在 `backend/src/sandbox/`（六个模块 + 一个出口 `index.ts`）：

| # | 是什么 | 判据 / 落点 |
|---|--------|-------------|
| ① | `sandboxes` 落库（`CREATING → RUNNING → RECYCLED`/`FAILED`） | 表 `sandboxes`；`container_id` **可空**（★ **行先落、容器后建**） |
| ② | **label 即归属** —— "这东西是不是我们的"只有这一个判据 | `doubulea.role=sandbox` + `doubulea.conversation=<id>`；`sandboxes` 表只回答"**该不该活着**" |
| ③ | 启动对账 `reconcileOnBoot()` | 后端一起来就把**所有**带 label 的容器与卷清掉（★ 理由：引擎是**后端进程的子进程**，进程一死容器就没有对话者 ⇒ 一律重建、不复用） |
| ④ | 周期对账 `reapOrphans()` + `reapIdleSandboxes()` | 每 `SANDBOX_REAP_INTERVAL_SEC` 秒一轮。**孤儿**判据 = 会话不再 `ACTIVE`，或账本没有活体行；**空闲**判据 = `last_active_at`（= 最后一次**引擎事件**的时间，不是 CPU） |
| ⑤ | 并发满时的排队 | Redis **ZSET**：`ZRANK` 给位次（"1 = 下一个"）、score 给**单项 TTL**，而 **TTL 同时是等待预算** |

**新增 4 个 env**（`infra/.env` 的 `[B] 沙箱与产物` 段，都有默认值）：
`SANDBOX_QUEUE_KEY=sandbox:queue`、`SANDBOX_QUEUE_TTL_SEC=600`、`SANDBOX_REAP_INTERVAL_SEC=60`、
`SANDBOX_CREATE_GRACE_SEC=120`（⚠️ **必须 > `SANDBOX_REAP_INTERVAL_SEC`**，否则后端启动时直接报错退出）。

**想亲眼看它在动**（把两个窗口调小，看"启动对账 + 一轮周期对账"）：

```bash
# ① 造两个"我们的"对象（label 是唯一判据；本批还没有入口能建沙箱，所以手工造）
docker volume create \
  --label doubulea.role=sandbox --label doubulea.conversation=00000000-0000-7000-8000-000000000001 \
  doubulea-work-00000000-0000-7000-8000-000000000001
docker create \
  --label doubulea.role=sandbox --label doubulea.conversation=00000000-0000-7000-8000-000000000001 \
  --network none -i doubulea/sandbox-toolkit:2
docker ps -a --filter label=doubulea.role=sandbox        # 应看到刚造的那个（Created）
docker volume ls --filter label=doubulea.role=sandbox    # 应看到刚造的卷

# ② 起后端（把窗口调小，方便看一轮）
#    需先起依赖：pnpm infra:up（或 infra 下的 compose）
cd backend && LOG_LEVEL=info SANDBOX_REAP_INTERVAL_SEC=5 SANDBOX_IDLE_TTL_MIN=1 \
  npx tsx src/index.ts
# 日志里应出现两行（启动阶段）：
#   沙箱状态（启动时：名额册必然为空）
#   沙箱启动对账完成（Docker 29.4.0）：清理遗留容器与卷；⚠️ 本进程重启会让容器内引擎失去对话者 ⇒ 一律重建，不复用
#     → containers: "1/1"  volumes: "1/1"  removalFailures: 0

# ③ 复核：那两个对象已经没了
docker ps -a --filter label=doubulea.role=sandbox        # 空
docker volume ls --filter label=doubulea.role=sandbox    # 空
```

> ⚠️ **本机注意**：`docker` 不在**非交互 shell** 的 PATH 里（OrbStack 托管）⇒ 脚本里请用全路径
> `/usr/local/bin/docker` 或补上 `~/.orbstack/bin`。后端自己**不 shell out**（走 `docker.sock`），不受影响。
> ⚠️ **为什么 `LOG_LEVEL=info` 看不到周期对账**：一轮"什么都没干"的对账**刻意只打 `debug`**（默认 60 秒一轮，
> 否则会把别的日志冲掉）⇒ 看不到**不代表它没跑**；想看每轮痕迹就 `LOG_LEVEL=debug`。
> 有变化时是 `info`，一眼可辨：`孤儿回收完成` / `空闲沙箱回收完成` / `沙箱已回收` / `清理了过期的沙箱排队项`。
> ⚠️ **写代码的人注意（P0-3-2 发现的跨批次坑）**：本机 PG 会话时区不是 UTC ⇒ `@prisma/adapter-pg`
> 读写 `timestamptz` **各偏 8 小时且往返恒等** ⇒ **凡要参与"与 JS 侧时间比较"的时间列，必须由 JS 侧
> 显式写入**，别依赖 `@default(now())`（`sandboxes` 两列已按此办理）。详见 `docs/02` §3.1 的"已知问题"。
> ⚠️ **仍然不能端测**：本批**没有任何入口能创建沙箱**（调用方 = TaskAgent `/chat`，属 P0-3-5/6）
> ⇒ **最早可端测的点仍是 P0-3-11**。

### 沙箱安全与网络（P0-3-3 起；⚠️ 仍然派不了活）

**本批把"沙箱"从"能跑"变成"关得住"**：网络只剩两条白名单出口、rootfs 只读、能力清空、
内存/CPU/进程数有上限、跑在非 root 用户上。**改点集中在一处** ——
`backend/src/sandbox/spec.ts#buildSandboxContainerSpec` 的 `HostConfig`（上一批那句
"`NetworkMode: 'none'` 是临时取值"到本批兑现）。

| # | 关掉了什么 | 落点 / 判据 |
|---|-----------|-------------|
| ① | **专用 internal bridge**（不再用默认 bridge） | `network.ts`：具名 `doubulea-sandbox`（`172.31.240.0/24`），`Internal: true` ⇒ **公网无路由**；归属判据同容器/卷 = **标签**（`doubulea.role=sandbox-network`）；名字被**别人**占了 ⇒ **大声失败**，绝不挂上去 |
| ② | **两条白名单出口** | 出口① = `HTTP(S)_PROXY` → `SANDBOX_EGRESS_PROXY_URL`（容器出公网的**唯一**可能）；出口② = 后端沙箱代理 listener（**独立 Fastify 实例**，只挂 `/api/sandbox/*`，默认只绑 bridge 网关地址）。**其余默认拒绝** |
| ③ | 只读 rootfs + 两处 tmpfs | `ReadonlyRootfs`；`/tmp`（`noexec`）与 `$HOME`（⚠️ **必须带 `uid/gid`**，否则 agent 写不动自己的 HOME） |
| ④ | 非 root + cap-drop | 镜像 `USER agent`（uid 10001）；建容器前**再断言一次** `Config.User` 非 root；`CapDrop: ALL` + `no-new-privileges` |
| ⑤ | mem / cpu / pids 限额 | `Memory` + **`MemorySwap` 必须等于它**（否则 swap 让限额形同虚设）+ `NanoCpus` + `PidsLimit` |
| ⑥ | work 卷体量 | ⚠️ **没有硬配额**（见下），降级为**周期巡检 + 超限告警 + 人工介入**：`reaper.ts#auditWorkVolumes` |

**新增 2 个 env**（`infra/.env` 的 `[B] 沙箱与产物` 段，都可留空）：

- `SANDBOX_BACKEND_URL` —— **容器眼里**后端沙箱代理的地址。留空 = 自动取「专用 bridge 网关地址 +
  `SANDBOX_CALLBACK_PORT`」（= 后端与 Docker **同宿主**的形态，即生产）。
- `SANDBOX_LISTEN_HOST` —— listener 的绑定地址。留空 = 只绑专用 bridge 的网关地址。

> ⚠️ **macOS 上会撞到的一堵墙**（实测，不是推测）：Docker 跑在 OrbStack 的 **Linux VM** 里
> ⇒ bridge 网关是那台 VM，**不是 macOS** ⇒ 跑在 macOS 上的后端**够不着**（容器侧 `ENETUNREACH`）。
> 生产（后端与 Docker 同宿主）没这个问题；本机要把 `SANDBOX_BACKEND_URL` 显式指到一个与沙箱网络
> **双宿的中转**，并把 `SANDBOX_LISTEN_HOST` 填成 `0.0.0.0`（细节见 `sandbox/network.ts` 文件头三条实测）。
> 顺带一条同类实况：`--storage-opt size=` 在本机被守护进程**直接拒绝**
> （`only for overlay over xfs with 'pquota'`）—— 所以它**没有**写进创建参数，`SANDBOX_WORK_VOLUME_MB`
> 只是**告警阈值**，不是配额（详细三条理由见 `buildSandboxContainerSpec` 上方那段）。

**想自己验一遍**（"应该失败"的五条比"应该成功"更重要 —— 白名单最常见的坏法是**看起来配了、其实全通**）：

```bash
# ① 先建一张卷（代码里是显式建的，带标签）
docker volume create \
  --label doubulea.role=sandbox --label doubulea.conversation=00000000-0000-7000-8000-000000000002 \
  doubulea-work-00000000-0000-7000-8000-000000000002
# ② 起一个"与代码同参数"的加固容器（默认 CMD = --mode rpc，它会等着 stdin）
#    ⚠️ 变量先备好：PROXY / GW 两处替换成你的值（GW = docker network inspect doubulea-sandbox 的网关）
docker run -d --name sandbox-sec-probe \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -m 2048m --memory-swap 2048m --cpus 1.5 --pids-limit 512 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --tmpfs /home/agent:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0755 \
  --mount type=volume,src=doubulea-work-00000000-0000-7000-8000-000000000002,dst=/work \
  --network doubulea-sandbox \
  -e HTTP_PROXY=http://PROXY:3128 -e HTTPS_PROXY=http://PROXY:3128 -e NO_PROXY=GW:13001 \
  doubulea/sandbox-toolkit:2

# ③ 逐条取证（期望值写在行尾）
docker exec sandbox-sec-probe node -e "require('fs').writeFileSync('/x','a')"        # EROFS（只读 rootfs）
docker exec sandbox-sec-probe node -e "require('fs').writeFileSync('/work/x','a')"   # 成功（具名卷可写）
docker exec sandbox-sec-probe node -e "console.log(process.getuid())"                # 10001（非 root）
docker exec sandbox-sec-probe sh -c "grep CapEff /proc/self/status"                  # 0000000000000000（无能力）
docker exec sandbox-sec-probe node -e "fetch('https://www.baidu.com/').then(r=>console.log('通了',r.status)).catch(e=>console.log('不可达',e.cause&&e.cause.code))"
                                                                                     # 不可达 EAI_AGAIN（公网只在代理背后）
docker exec sandbox-sec-probe sh -c "curl -s --noproxy '*' http://GW:13000/health"   # ⚠️ 本机必失败（见上面那堵墙）
# ④ 清场
docker rm -f sandbox-sec-probe && docker volume rm doubulea-work-00000000-0000-7000-8000-000000000002
```

> ⚠️ **`--storage-opt size=` 不要加**：本机加了它**建容器这一步就失败**（原因见上）。
> ⚠️ **仍然不能端测**：本批**没有任何入口能创建沙箱**（调用方 = TaskAgent `/chat`，属 P0-3-5/6），
> listener 也**还没有端点**（`/api/sandbox/*` 属 P0-3-9b）⇒ **最早可端测的点仍是 P0-3-11**。
> 上面那段是**手工起容器**看隔离，不是"跑通了一条业务链路"。

### 沙箱 LLM 注入（P0-3-4 起；⚠️ 仍然派不了活）

**这一批解决的是「容器里的引擎怎么知道该调哪个模型」** —— 答案不是把 Key 烤进镜像，而是
**后端在起容器时算好、只用容器环境变量带进去**，并且**磁盘上任何一份 pi 配置里都不出现 Key 明文**。

| # | 是什么 | 判据 / 落点 |
|---|--------|-------------|
| ① | `agent.model_id` → 解密 Key | **复用** `services/model.service.ts#resolveChatTarget()`（不另写一套解密/校验）；落点 `backend/src/sandbox/llm.ts`。⚠️ 它排在"动容器"**之前** ⇒ 拿不到就 `MODEL_NOT_AVAILABLE`、**容器根本不建** |
| ② | 六个容器环境变量 | `DOUBULEA_LLM_{API_KEY,BASE_URL,API,MODEL,PROVIDER,LABEL}`（常量 `SANDBOX_LLM_ENV`）。**没有新增任何宿主 env** |
| ③ | `models.json` 只写**引用** | `apiKey` 恒为 `${DOUBULEA_LLM_API_KEY}` —— pi 的 `apiKey`/`headers` 支持 `${ENV}` 插值，而 `baseUrl`/`api` **不支持** ⇒ 后两个只能由后端算成实值再传。生成脚本末尾有**自检**：序列化结果里出现 Key 明文就 `exit(1)`，**容器起不来** |
| ④ | 三协议映射 | `OPENAI_COMPAT`→`openai-completions` / `OPENAI_RESPONSES`→`openai-responses` / `ANTHROPIC_MESSAGES`→`anthropic-messages`（唯一落点 `spec.ts#piApiForProtocol`；容器侧只照抄 api 名） |
| ⑤ | `baseUrl` 归一 | 我方契约要求 baseUrl **自带 `/v1`**（`llm/client.ts` 是字符串拼接 `${baseUrl}${chatPath}`）；OpenAI SDK 同口径，而 **Anthropic SDK 自己加 `/v1`** ⇒ `piBaseUrlFor()` 对 anthropic **去掉尾部 `/v1`** |
| ⑥ | 「模型换了但容器还活着」 | 容器标签多一个 **`doubulea.model=<id>`**：复用前比对 `llm.modelId`，不一致 ⇒ 回收后**新建**（⚠️ 标签读不出来一律按"重建"处理；它**不参与对账**） |

**想自己验一遍**（⚠️ **这一步是人工取证**：`06` §六 第 30 条「验收一律人工，智能体不代跑」——
它要证的是"真跑一轮之后 Key 没落在可写区任何文件里"，而**假上游回什么都不影响这条结论**，
所以下面第三台服务器**故意回 500**）：

```bash
# ① 假"模型池"：只把收到的 路径 + 鉴权头 打出来，然后**故意回 500**
#    —— 要证的是"请求打到了哪条路径、带了什么头"，不是"模型答得对"（那属 P0-3-5/6）
node --input-type=module -e '
const http = await import("node:http");
const srv = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  console.log("[假模型池] " + req.method + " " + req.url);
  console.log("           authorization=" + (req.headers["authorization"] ?? "(无)") +
              " | x-api-key=" + (req.headers["x-api-key"] ?? "(无)") +
              " | anthropic-version=" + (req.headers["anthropic-version"] ?? "(无)"));
  res.writeHead(500, { "content-type": "application/json" })
     .end(JSON.stringify({ error: { message: "probe-only" } }));
});
srv.listen(0, "0.0.0.0", () => console.log("LLMPORT=" + srv.address().port));
'
#  → LLMPORT=<port>。契约要求 baseUrl **自带 /v1** ⇒ 下面填 http://host.docker.internal:<port>/v1

# ② 起一个真跑一轮 pi 的容器（⚠️ 命令跑完不退出，好让 ③ 进去取证）
#    哨兵 Key 取一个一眼能认出来的串；`doubulea` = SANDBOX_PI_PROVIDER_ID
docker run -d --name sandbox-llm-probe \
  -v doubulea-sandbox-llm-probe:/work \
  -e DOUBULEA_LLM_API_KEY=sk-probe-DO-NOT-LEAK-000000000000 \
  -e DOUBULEA_LLM_BASE_URL=http://host.docker.internal:LLMPORT/v1 \
  -e DOUBULEA_LLM_API=openai-completions \
  -e DOUBULEA_LLM_MODEL=probe-model \
  -e DOUBULEA_LLM_LABEL=探针模型 \
  --entrypoint sh doubulea/sandbox-toolkit:2 -c \
  '/opt/pi/entrypoint.sh -p "你好" --no-approve --provider doubulea --model probe-model; echo "--- pi exit=$? ---"; sleep 900'
#  ⚠️ macOS/OrbStack 上 host.docker.internal 指向宿主；不通就用 `docker network inspect bridge` 的网关 IP
#  ⚠️ 假上游屏幕上应出现一行 POST（路径 = /v1/chat/completions，或 responses/messages 看 api 取值）
#     —— 那一行就是 ④⑤ 两条映射的**直接取证**；只换 DOUBULEA_LLM_API 重跑本步可得另两条

# ③ 取证三条（期望值写在行尾）
docker exec sandbox-llm-probe sh -c 'cat /tmp/pi-agent/models.json'
#   → apiKey 必须是 "${DOUBULEA_LLM_API_KEY}"，**不是** sk-probe-…（这是本条最要紧的一条）
docker exec sandbox-llm-probe sh -c 'rg -F -l sk-probe-DO-NOT-LEAK /work /tmp /home/agent || echo "OK：一个文件都没命中"'
#   → 期望打印 "OK：…"（rg 无命中退出码 1）⇒ Key 没落进 work 卷、没落进 session 文件
docker exec sandbox-llm-probe sh -c 'ls -l /tmp/pi-sessions/ ; du -sh /tmp/pi-sessions ; df -h /tmp | tail -n 1'
#   → session 文件的位置与体积；`df` 一行是 tmpfs 的已用/总量（⚠️ 它**不在** work 卷上）

# ④ 清场
docker rm -f sandbox-llm-probe && docker volume rm doubulea-sandbox-llm-probe
```

> ⚠️ **为什么"三协议都支持"这件事值得单独记一句**：它把 `子方案③` §十三 **待决 1 关掉了** —— 原先
> 担心 `ANTHROPIC_MESSAGES` 不吃，得在选模型的界面上加一条"不支持任务型 Agent"的收窄判定；实际
> pi 有 `dist/api/anthropic-messages.js`，三条都有对应实现 ⇒ **不需要收窄**。
> ⚠️ **仍然不能端测**：`ensureSandbox()` 仍是**模块内部路径**（入口 = TaskAgent `/chat`，属 P0-3-5/6），
> 上面那段是**手工起容器**做一次取证，不是"跑通了一条业务链路" ⇒ **最早可端测的点仍是 P0-3-11**。

### 沙箱引擎桥（P0-3-5 起；⚠️ 仍然派不了活）

**这一批解决的是「后端怎么跟容器里的 pi 说上话」** —— 答案不是再起一个进程，而是**接上容器主进程
本来就有的 stdin / stdout**，在上面跑 pi 的 RPC 协议（JSONL over stdio）。落点是
`backend/src/sandbox/jsonl.ts`（分帧，纯逻辑）+ `backend/src/sandbox/bridge.ts`（协议层）。

| # | 是什么 | 判据 / 落点 |
|---|--------|-------------|
| ① | 桥 = **容器主进程的 stdio** | `docker.ts#attachSandboxStdio()`：`container.attach({ hijack: true })`。镜像收尾是 `exec pi "$@"` ⇒ **pi 就是容器主进程**，于是"容器活着"与"引擎可对话"变成同一件事（若改用 `exec` 另起一个，容器里就有**两个**引擎） |
| ② | 为什么必须 `demuxStream` | 本仓容器 **`Tty: false`**（P0-3-2 实测"不设 `Tty` 才起得来"）⇒ Docker 的 stdio 是 **8 字节头（流号 + 大端长度）+ 载荷** 的多路复用格式。不解复用直接读 ⇒ 症状是"**每条记录都解析失败**"，而现场离真因隔着两层 |
| ③ | 分帧**只认 `LF`** | **不许用 `node:readline`**：它把 `U+2028` / `U+2029` 也当行边界，而这两个字符**在 JSON 字符串里合法** ⇒ 记录被静默切成两半（上游 `docs/rpc.md` 点名警告）。另设单条记录上限 **8MB**，超了抛错 —— 不让一条坏流把内存吃光 |
| ④ | 一轮的收尾信号 = **`{"type":"agent_settled"}`** | **不是 `agent_end`** —— 后者之后还可能跟重试 / 溢出恢复 / 上下文压缩 / 跟进动作，拿它当收尾会**提前落库**（症状："回答少了一截，但历史里看着是完整的"） |
| ⑤ | **订阅先于派活** | 先登记 `agent_settled` 的等待者，**再**发 `prompt`（上游 `docs/rpc.md`：`Subscribe before sending a prompt to avoid missing a fast completion`）。反过来写，极快的收尾必丢 |
| ⑥ | 引擎 stderr | **进后端日志、绝不进 SSE**：`redactSecret()` 脱敏（用容器 `Env` 里那把 Key 当脱敏词）+ 保尾 8KB + 默认 `debug` 级 |
| ⑦ | 启动参数 | `spec.ts#piRpcArgv()` → `--mode rpc --provider doubulea --model <上游模型名> --no-approve`。⚠️ **`--no-approve` 不能省**：非交互下 pi 的项目信任提示恒答"否"，省了会卡在信任那一关 |
| ⑧ | 断开 ≠ 杀容器 | `close()` 只拆连接（`StdinOnce: false` ⇒ 容器 stdin 不关，pi 原地等下一次 attach）—— 这是"**复用容器**"能成立的前提。真要结束引擎走 `recycleSandbox`（那才是"杀"） |

**想自己验一遍**（⚠️ **这一步同样是人工取证**：`06` §六 第 30 条。它要证的两件事 ——
"真容器上的 stdio 真能收发"（② 的正身）与"完成后真的收到 `agent_settled`"（④ 的正身）——
都属于"跑起来才知道"，用一对内存流做出来的假通道证明不了）：

```bash
# ① 起一台容器，让它以 RPC 模式等我们说话
#    ⚠️ 必须 -i：否则容器没有 stdin，attach 上去也发不出命令
docker run -d -i --name sandbox-rpc-probe \
  -e DOUBULEA_LLM_API_KEY=sk-probe-DO-NOT-LEAK-000000000000 \
  -e DOUBULEA_LLM_BASE_URL=http://host.docker.internal:9/v1 \
  -e DOUBULEA_LLM_API=openai-completions \
  -e DOUBULEA_LLM_MODEL=probe-model \
  --entrypoint sh doubulea/sandbox-toolkit:2 -c \
  '/opt/pi/entrypoint.sh --mode rpc --provider doubulea --model probe-model --no-approve; echo "--- pi exit=$? ---"; sleep 900'
#  → baseUrl 故意指向一个**打不通的端口**：这一步验的是"协议通不通"，不是"模型答得对"

# ② 先订阅、再派活 —— 用 attach（不是 exec）接主进程的 stdin/stdout，这正是后端在做的事
( printf '%s\n' '{"id":"1","type":"prompt","message":"你好"}'; sleep 30 ) | docker attach sandbox-rpc-probe
#  → 屏幕上应当是逐行 JSONL。要盯的是这两条：
#      {"id":"1","type":"response","command":"prompt","success":true}   ← 命令被接受
#      {"type":"agent_settled"}                                        ← ★ ④ 的**直接取证**
#    ⚠️ 只有 agent_end 而始终没有 agent_settled ⇒ 收尾信号认错了（这正是坑 2）
#  ⚠️ 模型池打不通 ⇒ 这一轮大概率以**报错收场**，那也正常：本步证的是协议与收尾信号，
#    不是"模型答得对"。要连真上游就按上一节的假上游 / 真 Provider 换 DOUBULEA_LLM_BASE_URL

# ③ 清场（⚠️ attach 断开**不会**关容器 —— 这是 ⑧ 的设计，所以必须显式删）
docker rm -f sandbox-rpc-probe
```

> ⚠️ **仍然不能端测**：`openSandboxRpc()` 是**模块内部路径**，本批交付的是"通道"、
> **没有任何 HTTP / SSE 面**（谁派活、事件怎么映射成前端的卡，**已由 P0-3-6 落地 —— 见下一节**）⇒ **最早可端测的点仍是 P0-3-11**。

### 沙箱派活与事件映射（P0-3-6 起；⚠️ 仍不可端测）

**这一批把"通道"接成了"链路"**：后端开始**按智能体类型分流**（`CHATBOT` 仍走 P0-1-27 那套编排，
`TASK_AGENT` 走新的沙箱编排层），并定死了「容器里的 pi 说了什么 → 前端收到什么卡」的**逐条映射**。
落点是 `backend/src/sandbox/map.ts`（映射，纯逻辑）+ `backend/src/orchestrator/taskAgent.ts`（编排层）
+ `backend/src/orchestrator/persist.ts`（落库，**从 `chatBot.ts` 原样抽出**、两个编排器共用一份口径）。

| # | 是什么 | 判据 / 落点 |
|---|--------|-------------|
| ① | 分流点是 **库里的 `agent.type`** | `resolveChatProducer(agentType)`（`orchestrator/index.ts`）。`assertConversationSendable` 顺手把 `agent.type` 读出来交给路由 ⇒ **不加前端参数、也不信前端参数** |
| ② | 引擎 tool → **`tool_call{kind:SANDBOX}`** | `tool_execution_start` ⇒ 一张 `RUNNING` 卡（`inputSummary` = 截断 200 的摘要）；`tool_execution_end` ⇒ **同一 `callId`** 的 `SUCCESS` / `ERROR` 卡（`output` = 截断后的正文） |
| ③ | ⚠️ `tool_execution_end` **不带 `args`** | 所以"同一张卡的两帧必须共用同一份摘要"要靠一小块 `callId → 摘要` 的记忆（`map.ts` 里那块 Map；防呆上界 **200**，正常路径记一条删一条，只在**工具执行中途被打断**时兜底）。⚠️ 同一个记忆还给**落库那份**补 `arguments`：完整入参**只留档、不上线** ⇒ 落库记录与 SSE 帧**只差这一个字段** |
| ④ | 增量 → **`delta` / `thinking`** | 认 `message_update` 里 `assistantMessageEvent.type` 的 `text_delta` / `thinking_delta`；**其余子类型一律不发** |
| ⑤ | session stats → **`done.usage`** | 引擎顶层 `usage` 是 **latest cumulative**（原话）⇒ **覆盖**而不是相加（与 ChatBot 那边"一轮调了好几次上游 ⇒ 相加"是两件事）；字段名 `input`/`output` 只在 `readEngineUsage()` 里翻译一次；两个都取不到给 `null`（**不编一个 0**） |
| ⑥ | ★ **三类刻意不发**（每条都有反例，别顺手补） | **`agent_end`** —— 收尾认的是 `agent_settled`（`bridge.ts` 直接消费、不到映射层）；拿它当收尾会**提前落库**（症状"回答少了一截、但历史里看着是完整的"）／**`toolcall_*` 子类型** —— 那是"模型**打算**调"，`tool_execution_*` 才是"**正在跑**"，两处都发会造出**两张同 `callId` 的卡**、前端 upsert 时状态来回跳／**会话内部状态类**（`queue_update` / `thinking_level_changed` / `session_info_changed` / `entry_appended`）—— 界面上没有对应的卡。⚠️ **`tool_execution_update` 自 2026-10-15 起已不在本表**：改映射成 **`tool_output`**（实时输出快照，覆盖语义、不落库、不进上下文）—— 治 `bash` 长命令"界面像卡死" |
| ⑦ | **可解释性有两个可核查的出口** | 每条引擎事件过一遍 `KNOWN_ENGINE_EVENT_TYPES`：**认识但不发** = `known:true`；**完全没见过**（版本漂移）= `known:false` —— 两者都**不进事件流**，区别只在编排层要不要留痕。另一条 `anomaly` = **认识、但载荷用不了**（如 `tool_execution_start` 缺 `toolCallId`）⇒ **当场 warn**。两条实况进"本轮结束"日志的 `unknownEngineEvents` / `engineAnomalies` —— **非空即意味着映射表要跟着引擎升级** |
| ⑧ | 失败码 → 出口 | `SandboxAcquireFailure` 六种 ⇒ `sandboxAcquireError()`；`TurnFailureReason` 五种 ⇒ `engineFailureError()`。★★ **两者的出口其实是同一个：流内 `error{code}` 帧**（这点容易想错）—— `producer` 是 `streamChatReply` 在 **`reply.hijack()` 之后**才调用的 ⇒ 编排层抛的 `AppError` 一定被出口层接住、走 `error` 帧（HTTP 早已是 200 的 SSE）。**JSON 信封只属于"在 `streamChatReply` 之前就抛"的那一类**（未登录 / 参数 / 会话不是我的 / 会话只读 / 缺凭据 —— 全在 `assertConversationSendable` 里）。于是"选哪个工厂"的唯一作用 = **选 `error` 帧里的 `code`**（前端按它取文案）。⚠️ **pi 的原文只进日志、不进 SSE**（用户读到的是我们自己写的中文）；⚠️ `ABORTED` **不是失败**而是"用户在排队时点了停止" ⇒ 按**中断**收尾（落库 + `done{STOPPED}`） |

**想自己验一遍**（⚠️ **同上一节，这一步也是人工取证**：映射表的价值在"喂一串真事件、比结果"，
而**沙箱路径要 `SANDBOX_IMAGE` + `SANDBOX_EGRESS_PROXY_URL` 都就绪**才会往下走 ——
`ensureSandbox()` 会**显式拒绝**没配好的环境，这一条本身就是本批的一个正确行为）：

```bash
# ① 起依赖 + 起后端（务必看启动日志里那两行「沙箱状态 / 沙箱启动对账完成」）
pnpm infra:up
cd backend && node --import tsx src/index.ts

# ② 造一个 TASK_AGENT 智能体（⚠️ 类型在库里，不在请求里）
#    admin / doubulea-admin-A1；type 只能是 CHATBOT 或 TASK_AGENT
curl -sS --noproxy '*' -X POST http://127.0.0.1:13000/api/agents \
  -H 'content-type: application/json' -b cookies.txt \
  -d '{"name":"沙箱探针","type":"TASK_AGENT","modelId":"<上一步建好的模型 id>","systemPrompt":"用 bash 看看 /work"}'
#  → 然后用它建一个会话、POST /api/conversations/:id/chat 看 SSE 流

# ③ 要盯的三种行（都在**后端日志**里，不在浏览器里）：
#    · 「本轮结束」那行带 unknownEngineEvents / engineAnomalies / tokensIn / tokensOut
#      → 前两个**必须是 0**；非 0 就是映射表落后于引擎版本（这正是 ⑦ 的用处）
#    · 引擎的抱怨（pi 原文）**只**出现在日志里 ⇒ 用 curl 看 SSE 流时**不应该**看到英文报错
#    · 拿不到沙箱时（没配 SANDBOX_IMAGE 等）应当看到一帧 error{code:"INTERNAL"} 且**没有落库**
#      → 换个会话翻一遍消息历史：那一轮**不该**留下"只有问题、没有答案"的记录（⑧ 的正身）

# ④ 清场：容器/卷按「沙箱容器生命周期」那一节复核；新建的 agent 用 DELETE /api/agents/:id 删
```

> ⚠️ **本批仍然不可端测**：这是第一次有了"能派活"的入口（TaskAgent 会话的 `POST /chat`），
> 但 ① 沙箱路径要求 `SANDBOX_IMAGE` + `SANDBOX_EGRESS_PROXY_URL` 就绪、② **产物面板与预览属 P0-3-7~11**
> ⇒ 端到端仍不成立。**最早可端测的点仍是 P0-3-11**，别把上面那段当"跑通了一条业务链路"。

### 跨请求提问原语（P0-3-6b 起；⚠️ 无调用方、无 HTTP 面）

**这一批把"确认卡"这套机制从"只有发消息那条流内部调得到"变成"另一个 HTTP 请求也调得到"。**
背景：`awaitConfirm` 是 SSE 通道的**实例方法**，而通道实例是 `streamChatReply()` 里的一个局部变量
⇒ 跨请求**只有"回答"的路**（`POST /:id/confirm` 往应答槽写），**没有"提问"的路**。
而沙箱的 MCP 代理（P0-3-9b）恰恰是一条**独立的请求**：容器里的引擎要动一个危险工具时，
它得向"这个会话那条 SSE 流"问一句"用户同意吗"。

落点只有 `backend/src/orchestrator/sse.ts` 两处：模块级 `Map<conversationId, SseChannel>`
（构造后**登记**、`dispose()` 所在 `finally` 里**注销**）+ 导出 `askConversation(conversationId, question)`。

| # | 判据 | 一句话理由 |
|---|------|-----------|
| ① | 出口是**四值**：`AskConfirmOutcome` = `ConfirmDecision` 加 `'NO_CHANNEL'` | `NO_CHANNEL`（本进程里没有该会话的通道）**必须与 `REJECTED`（用户点了取消）分得开** —— 混起来就是把"我们的状态问题"说成"用户的决定"，模型会向用户复述一件没发生过的事 |
| ② | ★ **查不到通道 ⇒ 按"拒绝执行"处理**（回"无法确认 ⇒ 未执行"） | **不是静默放行、也不是当成功**。安全默认拒绝：查不到只可能是因为流已经结束（那这一轮本来也该结束） |
| ③ | **注销按身份撤销**（表里那个位置还是自己时才删） | 锁有 TTL ⇒ 同一会话可能已开出**第二条流**并覆盖登记；直接按 id 删会删掉**新通道**的登记，此后该会话的危险工具**全说"无法确认"且没有任何报错** |
| ④ | **中断照旧抛出**（`ChatStoppedError`），不并进那四种结局 | 用户停止 / 断连 / 锁丢失是"**这一轮结束了**"，不是"确认的结局"（与既有的 `ConfirmDecision` 口径一致） |
| ⑤ | ⚠️ **本表不是"谁是主人"的判据** | 主人判据仍然只有 Redis 活跃流锁（`chat.active:*`）；本表只答"该 id 的通道实例在不在**本进程**里"。⚠️ 进程内 ⇒ 与 `SANDBOX_CONCURRENCY` 是**同一条扩容前提**，且扩容时**不能只是把 `Map` 换成 Redis**（"提问"要往一条具体的响应流写帧） |

> ⚠️ **这一批现在还验不了任何东西**：`askConversation()` **没有任何调用点**（调用方是 P0-3-9b 的代理端点），
> 也**没有任何 HTTP 面** ⇒ 无界面增量、无命令行可敲的东西。它与「沙箱引擎桥（P0-3-5）」是同一种批次切分：
> **先有通道，再有链路**。**最早可端测的点仍是 P0-3-11**。
> ⚠️ 另一条**仍未接线**的路是"**引擎主动问**"（pi 的 RPC-only events）：桥会把这类记录当**未知事件**
> 扇给映射层、映射层只留痕不派发 ⇒ 要接通需另立批次。

### 沙箱产物收集（P0-3-7 起；⚠️ 无 HTTP 面，下载/预览属 P0-3-9/10）

**这一批把"引擎写了什么文件"变成"平台上看得见、下得了的产物"**：TaskAgent 每一轮
**派活之前**拍一次 work 卷基线（`find -printf`，cmd 走数组不经 shell），`agent_settled` 之后
对照 ⇒ 新出现或修改过的文件 → `cat` 读出 → 传 MinIO（`artifacts/{会话}/{uuid}/{名}`）→ 建
`artifacts` 行 → 流里发 `artifact` 帧 → 落 `messages.content.artifacts` 段。保留期
`ARTIFACT_RETENTION_DAYS`（默认 7 天）由**沙箱对账器同一轮 tick** 收口（对象删成功才删行）。

判据速查（全部带日志、不静默丢）：隐藏文件（路径任一段 `.` 开头）与 `node_modules` 跳过；
单文件 > `ARTIFACT_MAX_FILE_MB`（50MB）或单轮 > `ARTIFACT_SCAN_MAX_FILES`（200 个）跳过/截断并告警；
**先传对象再建行**，建行失败补偿删对象；**收集失败 ≠ 这一轮失败**（编排层只 warn）。

真跑一轮后的人工观察步骤（前提 = `SANDBOX_IMAGE` + `SANDBOX_EGRESS_PROXY_URL` 已就绪，
即「沙箱派活与事件映射」那节能真派活）：

```bash
# ① 派一个"会写文件"的活（沿用上一节造好的 TASK_AGENT 会话；content 例：
#    "用 python 把 1..10 的平方写成 CSV 存到 /work/squares.csv"）
#    curl 走 SSE 时应看到 artifact 帧（形如：event: artifact  data: {"artifactId":"…","fileName":"squares.csv",…}）

# ② MinIO 里应有对象（桶名与端口见 infra/.env 的 S3_*；键形如 artifacts/<会话id>/<uuid>/squares.csv）
#    可用 docker exec doubulea-minio mc… 或控制台 http://127.0.0.1:19001 浏览

# ③ 库里应有行（psql 连 127.0.0.1:15432，库名 doubulea）
#    SELECT id, file_name, size, mime, created_at FROM artifacts ORDER BY created_at DESC LIMIT 5;
#    → file_name 是相对 /work 的路径；mime 按扩展名定（csv → text/csv）

# ④ 复用容器再派第二轮：写一个**别的**文件
#    → 第二轮只报新文件；第一轮的 squares.csv 不再出现（基线 = 上一轮收尾态）
#    → 后端日志有「本轮产物收集完成 collected: …」而无重复告警

# ⑤ 保留期清理（可选，慢）：把 infra/.env 的 ARTIFACT_RETENTION_DAYS 改成 1 并重启后端，
#    等对账轮（默认 60s 一轮）→ 对象与行一起消失（日志「产物保留期清理完成」）
```

> ⚠️ **本批（P0-3-7）无 HTTP 面**：`GET /:id/artifacts` 与 `GET /artifacts/:id/download` 已在
> **P0-3-9** 落地（见后面的「产物列表与下载」一节，那里有可照抄的 curl），`/content`（预览）已在
> **P0-3-10** 落地（见再后面的「产物预览」一节）⇒ 现在**浏览器里**仍然只能在 MinIO / psql 里看产物
> （界面入口属 P0-3-11）。**最早可端测的点仍是 P0-3-11**。
> ⚠️ 清理挂在沙箱对账器里 ⇒ **未配置 `SANDBOX_IMAGE` 时清理不跑**（没有镜像就没有 TaskAgent、
> 产物不再新增；存量要清可手工删或临时配回镜像）。

### 沙箱停止（P0-3-8 起；⚠️ 不可端测，只能在 Docker 侧观察）

`POST /api/conversations/:id/stop` 对 TaskAgent 会话的行为：写停止信号 → 引擎中断
（+ 15s 宽限等 `agent_settled`）→ **已生成内容照常落库** → **产物照常收集** → **容器与具名卷一并回收**。
下一轮消息会重新建容器（"停止 → 会话恢复" = 重发即可）。已知边界：**客户端断线不回收**
（容器留给复用，30min 空闲回收兜底）；正常完成的轮也不回收（复用是"会话即容器"的初衷）。

```bash
# 前置：沿用「沙箱产物收集」那节造好的 TASK_AGENT 会话（$CONV、$COOKIE 都在同一个 shell 里）

# ① 派一个长活（够你来得及点停止），另开一个终端 curl -N 看 SSE 流
curl --noproxy '*' -sN -X POST "http://127.0.0.1:13000/api/conversations/$CONV/chat" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{"content":"用 python 逐个打印 1..200 的平方，每个之间 sleep 1 秒"}'

# ② 生成中途点停止
curl --noproxy '*' -s -X POST "http://127.0.0.1:13000/api/conversations/$CONV/stop" \
  -H "Cookie: $COOKIE" | jq .
#   → {"data":{"id":"…","signaled":true}}；SSE 流应以 done{finishReason:"STOPPED"} 收尾

# ③ 取证四条（都在停止后立刻看）
#   a. 容器与具名卷都没了（label 是唯一判据）
/usr/local/bin/docker ps -a --filter label=doubulea.role=sandbox --format '{{.ID}} {{.Names}}'   # → 空
/usr/local/bin/docker volume ls --filter label=doubulea.role=sandbox --format '{{.Name}}'       # → 空
#   b. 后端日志有「用户停止：沙箱已回收」与「TaskAgent 本轮结束」（finishReason=STOPPED）
#   c. 半截回答落了库：翻会话消息历史，那一轮应有已生成的部分文本
#      （01 决策 15：停止即中断、已生成内容保留）
#   d. 账本行 = RECYCLED：psql 连 127.0.0.1:15432
#      SELECT status, count(*) FROM sandboxes GROUP BY status;   -- RUNNING 应为 0

# ④ 会话恢复 = 重发：再 POST 一次 /chat（内容随意）
#   → 后端日志重新出现「沙箱容器已就绪」（新容器、reused:false）
```

> ⚠️ 停止后回收失败不会让"停止"失败（`done{STOPPED}` 照发）—— 残留的容器/卷留给对账器
> （按 label 找得到）；看到 ③ 里对象还在时先看后端日志有没有「回收沙箱失败」的 warn。
> ⚠️ `docker` 不在非交互 shell 的 PATH（OrbStack 托管）⇒ 上面用全路径，或先 `~/.orbstack/bin` 进 PATH。

### 产物列表与下载（P0-3-9 起；⚠️ 命令行档 —— 浏览器档见「浏览器端测 · 任务型对话页」）

**这一批把"库里有一行产物"变成"用户拿得到这个文件"**（P0-3-7 只做到"行建出来、事件发出去"，
没有 HTTP 面）。两条端点：

| 端点 | 说明 |
|------|------|
| `GET /api/conversations/:id/artifacts` | 产物列表 `?offset=&limit=`（**仅本人**；`{items,total,offset,limit}`，按 `created_at` 倒序）。它是**"刷新后产物还在"的唯一出口** —— `artifact` 事件只发一次、历史消息里的 `content.artifacts` 只覆盖那一轮 |
| `GET /api/artifacts/:id/download` | 下载原文件：**字节流**（`attachment` + RFC 6266/5987 双写 + `nosniff` + `private, no-store`），**不套信封**（本仓第三个，前两个是文档下载与 SSE；失败仍是标准 JSON 信封 ⇒ 客户端按响应形状分支） |

四条定案：① **下载是后端流式代理，不是签名 URL**（`02` §4.8 原文的"签名 URL 30 分钟"已废 ——
决定性理由是 **HTML/SVG 的 CSP 隔离头只有我方响应头加得上**）⇒ `ARTIFACT_URL_TTL_MIN`
**P0 不生效但保留登记**，"时效"由"链接不可分享"兜住；② **归属 = 产物 → 会话 → 本人**
（与知识库文档下载那条"登录即可"**刻意不同**，照抄它就漏掉归属校验），别人的一律 **404 不是 403**
（403 等于确认这个 id 有效）；③ `Content-Type` 的**唯一来源**是 `artifacts.mime`（不是 S3 对象元数据、
也不是扩展名的运行期再判）；④ **"行在对象没了" ⇒ 404 + 专句文案、不动数据库**
（保留期清理删了对象、行还在时的兜底；不删行是因为它是"这个会话产出过什么"的历史）。

```bash
# 前置：起依赖 + 起后端（另一终端）
pnpm infra:up
cd backend && node --import tsx src/index.ts

# ① 登录拿 Cookie（admin / doubulea-admin-A1；**全程同一个 shell**，-c / -b 用同一个文件）
curl -sS --noproxy '*' -c cookies.txt -X POST http://127.0.0.1:13000/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"doubulea-admin-A1"}'

# ② 产物列表（CONV 换成你自己的会话 id；没有产物时也是 200 → {items:[],total:0,offset:0,limit:20}）
CONV=<你的会话 id>
curl -sS --noproxy '*' -b cookies.txt \
  "http://127.0.0.1:13000/api/conversations/$CONV/artifacts?limit=20" | jq .

# ③ 归属（**必须用另一个账号**，判据才成立）：
#    用 member 登录另一份 cookie 文件，再打 ② 里那条 ⇒ 404（不是 403）
#    同理：拿 ② 里某个 artifactId，换 member 打 ④ 的下载 ⇒ 404

# ④ 下载（ART 取 ② 的 .data.items[0].artifactId）
ART=<产物 id>
curl -sS --noproxy '*' -b cookies.txt -D /tmp/art-head.txt -o /tmp/art.bin \
  "http://127.0.0.1:13000/api/artifacts/$ART/download"
cat /tmp/art-head.txt
#   → content-disposition: attachment; filename="squares.csv"; filename*=UTF-8''squares.csv
#   → content-type 取 artifacts.mime（如 text/csv）；另有 nosniff 与 cache-control: private, no-store
wc -c /tmp/art.bin     # → 应与列表里的 size 一致

# ⑤ 不存在的 id（或"行在对象没了"）⇒ 404 的**标准信封**，不是字节流
curl -sS --noproxy '*' -b cookies.txt \
  "http://127.0.0.1:13000/api/artifacts/00000000-0000-0000-0000-000000000000/download" | jq .
```

> ⚠️ **浏览器里还没有入口**：产物面板 + 预览弹层属 **P0-3-11**（预览端点 `/content` 已于 **P0-3-10**
> 落地，见下一节）⇒ 上面这段是**命令行档**（能亲手跑通"列表 → 下载 → 越权 404"这条链），
> **最早可端测的点仍是 P0-3-11**。
> 要真看到产物，得先跑出一轮 TaskAgent（前提 = `SANDBOX_IMAGE` + `SANDBOX_EGRESS_PROXY_URL` 就绪，
> 见「沙箱产物收集」那一节；也可以按那一节的 ③ 直接从 psql 里取 `artifacts.id` 填进 ④）。
> ⚠️ 下载**不支持 Range**（`子方案④` §八 2）⇒ 大文件整份下载后才显示；产物单文件 ≤ `ARTIFACT_MAX_FILE_MB`（50MB）。

### 产物预览（P0-3-10 起；⚠️ 命令行档 —— 浏览器档见「浏览器端测 · 任务型对话页」）

**这一批给产物加了第二条出口**：`GET /api/artifacts/:id/content`（`inline`）与上一节的 `/download`
（`attachment`）**共用同一个取流函数与同一条归属判据**，差的**只有响应头** —— 而那组头正是"预览"
这件事的全部（`子方案④` §三 1：两条出口刻意不合成"一个端点 + 一个 `?disposition=` 参数"，
那会把安全策略变成调用方可选的参数）。

响应头按 `artifacts.mime` **一处**分派，判据是 `shared#previewKindOf(mime)`（前端选渲染器用的
是**同一个函数** ⇒ 不可能分叉）：

| `previewKindOf(mime)` | 触发（举例） | `Content-Type` | 隔离头 | `Content-Disposition` |
|---|---|---|---|---|
| `html` | `text/html`、**`image/svg+xml`** | 原 mime + `; charset=utf-8` | **CSP `sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'`** | `inline` |
| `image` | `image/png`、`image/webp` | 原 mime | 无（`<img>` 上下文不执行脚本） | `inline` |
| `pdf` | `application/pdf` | `application/pdf` | **刻意不加 CSP**（加了 PDF 渲染不出来） | `inline` |
| `text` | `text/markdown`、`text/csv`、`text/plain`、`application/json` | **一律 `text/plain; charset=utf-8`** | 无 | `inline` |
| `none` | zip / docx / 未知类型 | `application/octet-stream` | 无 | **`attachment`**（当作下载） |

**每一路都带** `X-Content-Type-Options: nosniff` 与 `Cache-Control: private, no-store`。
★ 两条最值得亲手看的：`image/svg+xml` 必须带 CSP（它是能带 `<script>` 的文档，`<img>` 里安全、
"在新标签页打开"就会以我们站点的源执行）；`text/csv` 必须回 `text/plain`（把 URL 贴进地址栏
看到的是源码，而不是被浏览器当表格或 HTML 解释）。

```bash
# 前置：沿用「产物列表与下载」那一节的 cookies.txt 与 $ART（**全程同一个 shell**）

# ① 只看响应头（-D - 打到 stdout，-o /dev/null 丢掉正文）
curl -sS --noproxy '*' -b cookies.txt -D - -o /dev/null \
  "http://127.0.0.1:13000/api/artifacts/$ART/content"
#   → content-disposition: inline; filename="squares.csv"; filename*=UTF-8''squares.csv
#   → content-type: text/plain; charset=utf-8      ← text 那一路被压平了（下载那条才是 text/csv）
#   → x-content-type-options: nosniff / cache-control: private, no-store

# ② 换一个 HTML 或 SVG 的产物 id 再打一次（ART2=它的 id）⇒ 多一行 CSP
ART2=<一个 html 或 svg 产物 id>
curl -sS --noproxy '*' -b cookies.txt -D - -o /dev/null \
  "http://127.0.0.1:13000/api/artifacts/$ART2/content" | grep -i 'content-security-policy'
#   → content-security-policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'
#   ⚠️ 直接把这个 URL 贴进浏览器地址栏（**不经 iframe**）脚本也不该执行 —— 那时唯一生效的就是这一行

# ③ 越权（**必须用另一个账号**）：member 登录后打 ① ⇒ 404 标准信封（不是 403）
# ④ 不存在的 id ⇒ 404；"行在对象没了" ⇒ 404 + 专句文案（与下载那条同款）
curl -sS --noproxy '*' -b cookies.txt \
  "http://127.0.0.1:13000/api/artifacts/00000000-0000-0000-0000-000000000000/content" | jq .

# ⑤ 前端纯逻辑档（不起后端、不连依赖）：26 项 / 七组
pnpm verify:artifact-preview
```

> ⚠️ **浏览器入口已于 P0-3-11 落地**（产物面板 + 「预览」按钮 + 六个渲染器）：本批交付的是"预览能力"
> 本身（端点 + 分派判据 + 弹层），**接入点**在下一节「**浏览器端测 · 任务型对话页**」。
> 那一节把这些"只有浏览器能验"的项逐条列了出来：HTML/SVG 在 iframe 里**不执行脚本**、
> 直接把 `/content` 贴进地址栏**也不执行**、`image/svg+xml` 走的是 **iframe 而不是 `<img>`**、
> MD 产物里的**外链图片不发起请求**（DevTools Network 里没有那个地址 —— 这是**预期行为**，不是 bug）、
> 以及 **PDF 加 / 不加 CSP sandbox 各渲染一次**（`子方案④` §十 待决 2，仍未实测）。

### 沙箱 MCP 代理（P0-3-9b 起；⚠️ 命令行档 —— 浏览器档见下一节）

**这一批让 TaskAgent 真的能用 MCP 工具，而容器里的引擎一个字都碰不到 MCP 凭据。** 定案（`子方案③` §七）：
**容器 → 后端**。容器侧只有一个瘦扩展（`mcp-bridge`，烤在 base 层），它把每次工具调用转成对后端的一次内网 HTTP 请求：

```
pi（容器内）的 mcp_* 工具（桥扩展在 session_start 里注册的）
  → POST {SANDBOX_BACKEND_URL}/api/sandbox/mcp/call      头: x-sandbox-token
  → 后端（**沙箱代理 listener**，端口 SANDBOX_CALLBACK_PORT；⚠️ 不在公网 listener 上）
       ① 令牌 ⇒ {conversationId, userId, agentId}     ← 三个身份都**不在请求体里**，只从令牌解析
       ② serverAlias ⇒ serverId                       ← 只能调"这个 agent 绑定的" server（否则 403）
       ③ 危险判定（口径：只有 readOnlyHint===true 且**未**声明 destructiveHint===true 才算安全）
             → 危险 ⇒ 复用 P0-3-6b 的跨请求提问 ⇒ 对话区弹确认卡 ⇒ 用户确认 / 取消 / 超时
       ④ 调 MCP（用**会话发起者**的凭据）→ 回 {isError, text}
```

⇒ 一句话：**凭据不进容器**（MCP 凭据留在后端）、公网出口仍然只有模型池（模型 Key 是刻意的例外，见「沙箱 LLM 注入」）、
危险调用拦得住。★ 判据：**只有"跨出容器边界"的动作才需要确认卡** —— 容器内的 `bash`/`read`/`write`/`edit` **不做**逐工具确认。

**前置**（四样，缺一样就走不到后面）：

1. 依赖服务 + 后端（13000）起着；
2. ⭐ **镜像必须重建到当前版本（`:5`）** —— 桥扩展在 P0-3-1 只是个**空壳**（当时只证明"扩展能被 pi 加载"），
   真实现是 P0-3-9b 落的、P0-3-14 又加了内置工具注册：
   `pnpm sandbox:build -- --registry https://registry.npmmirror.com`，
   再把 `infra/.env` 的 `SANDBOX_IMAGE` 改成打印出来的 `doubulea/sandbox-toolkit:5`；
   ⚠️ 不重建的症状最隐蔽：后端日志**一条错都没有**，只是"模型从来不调 MCP 工具"（空壳没注册任何工具）；
3. ⭐ **一个绑了 MCP server 的 `TASK_AGENT`** —— 绑定入口见「浏览器端测 · MCP」那一节（管理页）或
   `POST /api/agents/:id/components`；⚠️ **那台 server 必须有工具缓存**（在 `/mcp` 点一次「测试」拉
   `tools/list`），否则清单是空的（后端日志有一行 warn 会指出这一点）；
4. 一个**会去调工具**的模型 —— 真厂商模型，或一句明确到不能再明确的提示（"用你手上的 MCP 工具把 X 查一下"）。

```bash
# ① 重建镜像（base 层内容变了 ⇒ base 与 toolkit 的层版本号都 +1 到 3）
pnpm sandbox:build -- --registry https://registry.npmmirror.com
#   → 末尾打印该写进 infra/.env 的两行（SANDBOX_IMAGE_BASE / SANDBOX_IMAGE），照抄

# ② 派活之后，**在容器里**直接打一次代理端点。
#    ⚠️ 镜像刻意**没有 curl / wget**（toolkit Dockerfile 第 ② 条），但 Node 在 —— 用全局 fetch 当探针。
#    容器 env 里本来就有后端地址与令牌（SANDBOX_BACKEND_URL / SANDBOX_TOKEN）。
docker ps --filter 'label=doubulea.role=sandbox' --format '{{.ID}}  {{.Names}}'
CID=<上面那台的 ID>
docker exec "$CID" node -e 'fetch(process.env.SANDBOX_BACKEND_URL+"/api/sandbox/mcp/tools",{headers:{"x-sandbox-token":process.env.SANDBOX_TOKEN}}).then(async r=>console.log(r.status,(await r.text()).slice(0,300)))'
#   → 200 {"servers":[{"alias":"s1","id":"…","name":"…"}],"tools":[{"name":"mcp_s1_…","serverAlias":"s1","toolName":"…",…}]}
#   ⚠️ tools 是**空数组** ⇒ 那台 server 没有工具缓存（回前置 3）；servers 空数组 ⇒ Agent 没绑 MCP

# ③ 两个负例：令牌不认 ⇒ 401（**不套信封**，这一侧的契约见 sandbox/proxy.ts）；
#    路径写错 ⇒ 404 但它**套统一信封**（由 listener 的 setNotFoundHandler 给）
docker exec "$CID" node -e 'fetch(process.env.SANDBOX_BACKEND_URL+"/api/sandbox/mcp/tools",{headers:{"x-sandbox-token":"nope"}}).then(async r=>console.log(r.status,(await r.text()).slice(0,200)))'
#   → 401 {"error":{"code":"UNAUTHORIZED","message":"沙箱代理令牌无效或已过期。"}}
docker exec "$CID" node -e 'fetch(process.env.SANDBOX_BACKEND_URL+"/api/sandbox/nope").then(async r=>console.log(r.status,(await r.text()).slice(0,200)))'
#   → 404 {"code":"NOT_FOUND","msg":"沙箱代理端点上没有 GET /api/sandbox/nope",…}   ← 统一信封
#   （顺带证一件事：**容器能摸到的只有这两个端点** —— 登录 / 会话 / 管理路由一条都不在这台 listener 上）

# ④ 在对话页发一句会用到那个 MCP 工具的任务，然后盯**后端日志**这三行：
#    · 已为沙箱签发代理令牌（容器建起来之前就写好了 ⇒ 扩展一起来就能拉清单）
#    · 容器已拉取 MCP 工具清单（沙箱代理端点）            ← 扩展真的连上来了（这一步不通 ⇒ 先查镜像版本）
#    · 沙箱代理收到一次 MCP 调用（凭据主语 = 会话发起者）   ← 调用真的走到了后端
#    并且那张工具卡显示的是 **server 名 + 原始工具名**（带 serverId 的 `kind: MCP` 卡，不是沙箱卡）

# ⑤ 危险调用 ⇒ 弹确认卡（口径：只有 readOnlyHint===true 且未声明 destructiveHint===true 才算安全）
#    挑一个"会改东西"的工具（annotations 里 destructiveHint 为真，或压根没声明 readOnlyHint）
#    → 对话区出现确认卡；点「取消」⇒ 模型读到"用户取消了这次工具调用，未执行。"（**不是**报错卡）
#    → 点「确认」⇒ 工具真跑、卡片转成功；**不理它** ⇒ 超时后回"等待用户确认超时，未执行。"
```

**已知边界（别当 bug）**：

- ⚠️ **改了 Agent 的 MCP 绑定，在同一个容器活着期间不生效** —— 清单是"每个容器一份"的快照
  （`proxy.ts#ensureSandboxMcpCatalog`），新派活（或容器被回收后重建）才换新清单；
- ⚠️ **非危险调用中途不可中断**：那一趟 HTTP 没有挂"用户停止"的信号（危险那一路由确认流覆盖）。
  用户停止时，危险调用会被后端写成"这一轮已被中断，该工具未执行。"回给模型；
- ⚠️ **工具名是后端改过的**：`mcp_<别名>_<原工具名>`，别名 = `s1`/`s2`…（**本次会话**的编号）
  ⇒ 别把 `s1` 当成稳定的 server 标识（`slug` 刻意不唯一，所以别名才由后端按会话分配）；
- ⚠️ **`mcp_` 这个前缀不构成"这是 MCP 工具"的判据**：卡片是不是 `kind: MCP`，取决于**后端那份清单里
  有没有这个工具**（容器里一个恰好叫 `mcp_foo` 的脚本仍然是**沙箱**工具卡）；
- ⚠️ **工具缓存是清单的来源**：`tools/list` 是"点「测试」/`?refresh=1`"时才拉的，清单端点**只读缓存、
  绝不联网**（与 ChatBot 路径同一条取舍 —— 派活的第一帧不该等一次几秒的网络请求）。

> **⚠️ 这一档证明什么、不证明什么**：后端侧只有**跨文件接线批次的那一次 `pnpm -r typecheck`** + `pnpm check:batch`；
> 扩展跑在**容器里**、由 pi 用 jiti 加载（无构建步骤），**智能体不代跑浏览器、也不代跑容器**（用户 2026-09-23 定案）
> ⇒ 上面每一条都要你自己动手。⚠️ 其中"**扩展到底加载上没有、注册成功没有**"只有**重建镜像到 `:3` 之后**才验得到；
> 另外 pi 的扩展 API 形状（`session_start` / `registerTool` / **`throw` 才算失败**）来自上游文档，
> 本仓没有类型可查（`infra/` 不在任何 tsconfig 的 include 里）。

### TaskAgent 知识库（P0-3-14 起；⚠️ 浏览器/命令行档）

**一句话**：给 **TaskAgent**（沙箱里的 pi 引擎）绑知识库，现在它**能识别并使用知识库**了 ——
和 ChatBot 走**同一套**检索口径（`knowledge_search` / `list_knowledge`），只是工具经**沙箱代理**由后端代跑。

**它修的是哪半条漏接**：知识库原先**只接在 ChatBot 上** —— `chatBot.ts` 才下发两个内置工具、才注入「可用知识库」
清单；`taskAgent.ts` 既没有 system 通道、沙箱清单（`buildSandboxMcpCatalog`）又只认 `componentType:'MCP'`
⇒ 模型**不知道有库、也没有检索能力**（P0-3-13 的清单因此把 `citations` 空数组写成"刻意边界"，本批把它补上）。

**链路**（与 MCP 同一条代理思路，执行体与 ChatBot 共用 `orchestrator/knowledgeTools.ts`）：

```
pi（容器内）的 knowledge_search / list_knowledge（桥扩展在 session_start 里按 builtinTools 段注册）
  → POST {SANDBOX_BACKEND_URL}/api/sandbox/builtin/call      头: x-sandbox-token   体: {name, arguments}
  → 后端：① 令牌 ⇒ 会话身份  ② 清单里确实下发过这个内置工具  ③ 现查 Agent 绑定的知识库
         ④ executeKnowledgeTool(...)（与 ChatBot 逐字同一份）→ 回 {isError, text}
```

⇒ 模型看到的工具卡是 **`kind: BUILTIN` + serverName「知识库」**（与 ChatBot 路径同一个 kind，**没有 serverId**
⇒ 卡上不出现「去配置凭据」）。**意识通道**：TaskAgent 只有 pi 的 `prompt` 一条消息（没有 system），
所以「知识库能力说明 + 引用规则 + 可用知识库清单」作为**前缀**拼进发给引擎的那份（落库仍是用户原文）。

**前置**：① 沙箱镜像**重建**（扩展改了 ⇒ 层版本 +1；不重建的症状同 MCP —— 后端日志一条错都没有，只是模型不调知识库工具）；
② 给一个 `TASK_AGENT` **绑一个有 READY 文档的知识库**；③ 一个会调工具的模型。

```bash
# 建/绑：管理页给 TaskAgent 勾一个知识库（或 POST /api/agents/:id/components），库里至少一篇 READY 文档
# 派活后，在容器里看清单是否带内置工具：
docker exec "$CID" node -e 'fetch(process.env.SANDBOX_BACKEND_URL+"/api/sandbox/mcp/tools",{headers:{"x-sandbox-token":process.env.SANDBOX_TOKEN}}).then(async r=>{const j=await r.json();console.log(j.builtinTools)})'
#   → [{"name":"list_knowledge",…},{"name":"knowledge_search",…}]   （没绑库 ⇒ []）
# 问「你有哪些知识库」⇒ 模型调 list_knowledge（卡：kind BUILTIN / 知识库）；
# 问一个只可能在库里的问题 ⇒ 调 knowledge_search ⇒ 回答基于检索原文。
```

**已知边界（别当 bug）**：① 改了 Agent 的知识库绑定，同一容器活着期间**不生效**（同 MCP 的"容器即会话"）；
② 沙箱路径**不发引用卡**（`citations` 仍空 —— 那是 ChatBot 的渲染），命中以 `tool_calls` 落库/展示；
③ 内置工具卡没有 `serverId`（不是 MCP server）。

### TaskAgent 计量（P0-3-12 起；⚠️ 命令行档 —— 无界面增量）

**一句话**：TaskAgent 每**真派活**一轮，收尾时在**落库的同一个事务**里写一条 `usage_records`（账）。
本批同时把**一张按月的分区表**（`usage_records`）上线（手写 DDL + `ensure_usage_records_partition()` +
续期脚本，**分区套路照 `messages`**），并**订正了 P0-3-6 留下的用量口径错**（见下表最后一行）。

**是什么 / 判据 · 落点**：

| 是什么 | 判据 · 落点 |
|--------|-------------|
| **一行 = 一轮派活** | 不是"一次上游调用一行"、也不是"一个会话一行"；落点 `orchestrator/persist.ts#persistRoundQuietly`（与消息落库同一个 `$transaction`） |
| **只 TaskAgent 写** | `engineStarted` 为真才写（**纯排队失败 / 没真派活 ⇒ 不记**）；ChatBot 路径**仍不写**（`02` §6.2 ⑦） |
| **token 可空、不编 0** | 引擎没上报（`usage` **全 0** 或取不到）⇒ `NULL` —— "**不知道**"与"**真的用了 0**"是两件事 |
| **`duration_ms` / `rounds` 兜底** | 两个**我方量**：本派活墙钟（ms）+ 引擎 `turn_start` 条数 ⇒ 即便没有 token，账上也留得下信息（`01` 决策 20 的"按时长 + 轮次记条目"） |
| ★ **用量口径 = 同 turn 覆盖、跨 turn 相加** | 引擎的 `usage` 是「**这一个 assistant turn**」的累积值，而**一个 turn = 一次模型请求** ⇒ 同一 turn 内**覆盖**、跨 turn 走 `sumUsages` **相加**（`turn_start`/`turn_end` 划边界）。⚠️ P0-3-6 只做了"覆盖"这半句 ⇒ 多轮工具循环**只记了最后一轮**的 token（数字偏小、看着合理、不报错） |
| **`created_at` 由 JS 侧写** | 本机 PG 会话时区非 UTC ⇒ 凡参与 JS 侧比较的时间列都由 JS 侧显式写入（`02` §3.1 已知问题） |
| **按月分区** | `PARTITION BY RANGE (created_at)` + 复合主键 `(id, created_at)`；`ensure_usage_records_partition()` 动态建窗口、`pnpm db:partitions` 幂等续期 |

**人工观察步骤**（前置 = 同「沙箱派活与事件映射」：能**真派活** —— `SANDBOX_IMAGE` +
`SANDBOX_EGRESS_PROXY_URL` 就绪 + 一个 `TASK_AGENT` + 一个会干活的模型）：

```bash
# ① 派一轮活（沿用上一节造好的 TASK_AGENT 会话），等 SSE 收口
#    curl 走 SSE 时 done 帧里应有 usage（形如：event: done  data: {"finishReason":"COMPLETE","usage":{"tokensIn":…,"tokensOut":…}}）

# ② 库里应有行（psql 连 127.0.0.1:15432，库名 doubulea）
#    SELECT created_at, model, tokens_in, tokens_out, duration_ms, rounds
#      FROM usage_records ORDER BY created_at DESC LIMIT 5;
#    → tokens_in/out 可能为 NULL —— 那是"模型在流式阶段没报"（= 不知道），**不是 0**
#    → rounds ≥ 1（引擎发了几个 turn_start）；duration_ms = 这一轮派活的墙钟毫秒
#    → 多轮工具循环时 rounds > 1，且 token 是**各 turn 相加**（不是只留最后一轮）—— 这正是本批订正的点

# ③ 一行都没写？先看后端"本轮结束"那行日志有没有 usage 字段；
#    纯排队失败 / 没真派活而**没有这一行是刻意的**（判据 = "这一轮真的发生过"）
```

**已知边界（别当 bug）**：

- ⚠️ **ChatBot 不写这张表**：ChatBot 的收尾只做"计量**透传**"（`done.usage` + 日志）；账要挂
  `user_id + agent_id`，而 ChatBot 的生产路径没有这两者 ⇒ 它的接回点（`PersistRoundInput.usageRecord`）
  留成了真接口，接线是**另一批**的事；
- ⚠️ **`tokens_*` 为 `NULL` 是正常的**：多数 provider 在**流式阶段**不报 usage，只有收口才给；
  引擎侧这句原文是"it can remain zero until completion"；
- ⚠️ **`rounds = 0` 是可能真实的**（引擎一个 `turn_start` 都没发就结束）；
- ⚠️ **没有查询端点**：`02` §四 的 `GET /api/usage/summary` **报表仍属 P1** —— 本批只落账，看账靠 psql。

> **⚠️ 这一档证明什么、不证明什么**：契约侧只有**跨文件接线的那一次 `pnpm -r typecheck`** + `pnpm check:batch`；
> 表已 `pnpm db:deploy` 应用、DDL 形状过了 `prisma migrate diff --exit-code`（无差异）与 psql 的 `relkind = 'p'`。
> ⚠️ **本批零新增 env、零 HTTP 面、零前端改动**（就一个迁移 + 一个新表 + 编排层收口），
> 所以"账记得对不对"（token 有没有真的相加、`NULL` 与 `0` 有没有分对）只能**你自己派一轮活、再 psql 里看**。

### 浏览器端测 · 任务型对话页（⭐ **阶段三唯一的浏览器端测点**：P0-3-11 起）

**这一档终于有界面了。** P0-3-1~10 全部落在后端与纯逻辑层（镜像 / 生命周期 / 加固 / Key 注入 /
stdio 桥 / 事件映射 / 产物收集 / 停止回收 / 列表与下载 / 五种格式预览），每一节末尾都写着
"浏览器仍不可端测"。本批把**产物面板**（第三列）与**预览弹层**接上 ⇒
「派活 → 过程可见 → 预览 / 下载产物 → 停止 → 刷新后产物还在」这条链第一次能在浏览器里亲手走完。

**前置**（四样，缺一样就走不到后半段）：
1. 同「浏览器端测」首节：**依赖服务 + 迁移 + 后端（13000）+ 前端（5174）**两个进程都起着；
2. ⭐ **沙箱镜像 + 出口代理** —— `SANDBOX_IMAGE` 与 `SANDBOX_EGRESS_PROXY_URL` 两个 env 必须就绪，
   否则 TaskAgent 一发消息就会被 `ensureSandbox` **显式拒绝**（会话里出现一条错误卡，而不是"卡住不动"）。
   镜像构建见「构建沙箱镜像」，出口代理见「沙箱安全与网络」；
3. ⭐ **一个会真的去写文件的"模型"** —— **真模型不会主动写文件**。用假 LLM，或给一句**明确到不能再明确**的
   提示词（例如"请把 1 到 100 的平方写成沙箱工作目录下的 `squares.csv`，然后用一句话告诉我行数"）；
4. **一个 `TASK_AGENT` 类型的智能体** —— 产物面板**只有**它那一页会出现（判据是类型，不是"有没有产物"）。

⚠️ 本档**不需要真厂商模型**（假 LLM 即可）。⭐ **"任务里调危险 MCP 工具 ⇒ 弹确认卡"自 P0-3-9b 起可验了**，
但它**不在本表**里：它要求"Agent 绑了 MCP server + 真模型会去调它 + 镜像重建到 `:3`"，步骤单列在上一节
「**沙箱 MCP 代理**」（本表 ③ 里的工具卡就是那条链的第一段）。

| # | 该测的路径 | 预期 |
|---|-----------|------|
| ① | 用一个 **ChatBot** 智能体进对话页 | **只有两栏**（侧栏 + 消息流）、**没有产物面板** —— 第三列是 TaskAgent 独有的 |
| ② | 换 **TaskAgent** 进对话页；再把窗口**拉到 1280px 以下**、然后拉回来 | 变成**三栏**：右侧「产物 · 0」+ 底部那句"产物保存在沙箱工作目录…"；窄屏下第三列**收起来**，而消息流里的产物卡**仍然带 [预览][下载]**（能力没消失） |
| ③ | ⭐ 发一句会让它写文件的话（见前置 3） | 消息流**逐字长出来**：思考块 → 工具卡（**沙箱工具**，运行中 → 成功）→ 正文 → **产物卡**；同时右侧面板出现同一条，那一行写的是「**刚生成**」 |
| ④ | ⭐ 等这一轮收口（几秒） | 面板里那条从「刚生成」变成**真正的时间读数**（"1 分钟前"…）—— 这是"这一轮结束后产物列表被失效重取"的可见凭据，不是界面在表演 |
| ⑤ | 点产物卡（或面板里那条）的「**预览**」 | 右侧抽屉打开：标题是文件名、右上角有「下载」；**MD / CSV(TSV) / 图片 / PDF / HTML 五种各有形态**（CSV 是表格、MD 是排版后的富文本、图片居中、PDF 是浏览器原生 viewer、HTML 在 iframe 里） |
| ⑥ | 点抽屉里的「下载」 | 浏览器开始下载，文件名与列表里一致；⚠️ 中文名走 RFC 5987（`filename*`），别把乱码当 bug |
| ⑦ | 点产物卡上的「下载」（**不**先开预览） | 同一条文件 —— 两个入口共用**同一份**实现（`useArtifactDownload`） |
| ⑧ | ⭐ 若有 zip / docx 之类的产物 | 那张卡上**没有**「预览」按钮、只有「下载」—— 能力有无是**事实**，不是"暂不可用"（刻意不做置灰按钮） |
| ⑨ | ⭐ 点一次「停止」 | 消息流收口为「已停止 · 已生成的内容保留」；**面板与产物卡还在**（那一轮真的产出过）；`docker ps` 里那台容器**消失**（P0-3-8 的回收） |
| ⑩ | ⭐ **刷新页面** | 面板里的产物**还在**（这正是 `GET /api/conversations/:id/artifacts` 的意义：`artifact` 事件只发一次、历史消息里的产物段只覆盖那一轮）；点「预览」照样打得开 |
| ⑪ | 切到别的会话 / 新建会话 | 面板换成那个会话的清单（**不带**上一个会话的产物）；⚠️ 已经打开的预览抽屉**不会自己关**（用户点开的东西不该被后台悄悄关掉） |
| ⑫ | ⭐ **MD 产物里带外链图片**（`![](http://…)`） | 预览里是**可点击的链接 + 一句说明**，**不自动加载**；DevTools 的 Network 里**没有那个外链地址** —— 这是**预期行为**，不是 bug |
| ⑬ | ⭐ **HTML / SVG 产物** | 预览里正常渲染、**不执行脚本**（没有弹窗、console 无输出）；★ 再**直接把 `/api/artifacts/<id>/content` 贴进地址栏**（**不经 iframe**）⇒ **仍然不执行**（那时唯一生效的是**响应头**的 CSP `sandbox`） |
| ⑭ | ⭐ **SVG 产物** | 走的是 **iframe 而不是 `<img>`**（"查看框架源代码"能看出区别 —— `子方案④` §六 判据 ③） |
| ⑮ | ⭐ **PDF 产物**（`子方案④` §十 待决 2） | 先按现状渲染一次（**不加** CSP sandbox）；再把后端那行的 CSP 加上试一次 ⇒ 把"加了是不是真渲染不出来"记下来。**这是本批唯一留给实测的取舍** |
| ⑯ | 造一份**超过 5000 行**的 CSV 产物 | 表格**截断**，且读数报的是**原始总数**（"仅显示前 5000 行（共 6000 行）"），不是截断后的数 |
| ⑰ | 造一份 **GBK 编码的 CSV**（`iconv -f GBK -t UTF-8` 的反向） | 明确提示「这个文件的编码不是 UTF-8」+ 下载建议，而**不是**满屏 `�` |
| ⑱ | 造一份 **> 10 MiB 的 PNG** | 那张卡上**没有**「预览」、只有「下载」 |
| ⑲ | 面板里有 **> 100 个**产物时（可选） | 底部出现"仅显示最近 100 个（共 N 个）"—— 那个数不拿"这一页有多少条"冒充 |

**已知边界（别当 bug）**：
- ⚠️ **"这份 CSV 从哪来"本身还没有入口**（`01` §五 的留注）：P0 的做法是**让模型自己在沙箱里造**
  （前置 3 的提示词）或走知识库文档。所以本档验的是"**产物这条链**"，不是"用户上传一份文件让它分析"；
- ⭐ **"任务里调危险 MCP 工具 ⇒ 弹确认卡"自 P0-3-9b 起可验**（那条链的步骤在上一节「沙箱 MCP 代理」）：
  它需要 **Agent 绑 MCP server + 镜像重建到 `:3` + 一个真会调工具的模型**，与本表的前置不同；
- ⚠️ **沙箱是"会话即容器"**：空闲 30 分钟会被回收（面板底部那句说明就是它）。回收后**产物照旧在**（对象存储），
  但"再发一句"会**重建容器**（新容器的工作目录是空的 ⇒ 上一轮的中间文件不在那儿了）；
- ⚠️ **1280px 以下第三列不显示**（原型定下）；**能力没消失**（消息流里的产物卡照样带两个按钮）；
- ⚠️ **面板一页最多 100 条**（写明的边界，底部那行读数会说）；
- ⚠️ **预览抽屉不随会话切换而关闭**；若那个产物所属的会话被删了，取内容会 404 并如实提示（不是白屏）；
- ⚠️ **`preview_ready` 列恒为 `false`、列表也不带它** —— 能不能预览是**现算**的（`previewKindOf` + 体积闸门），
  不是一列布尔（`02` §三 定案）；
- ⚠️ **超大产物不影响下载**：闸门只管"要不要在线预览"，「下载」拿到的始终是**没有改过字节的原文件**。

> **⚠️ 这一节证明什么、不证明什么**：智能体侧**没有**代跑浏览器（用户 2026-09-23 定案）。
> 判据侧只有**无依赖纯逻辑档** `pnpm verify:artifact-panel`（**19 项 / 五组**：面板出现判据 /
> 两个来源的合流与去重 / 时间读数三档 / 溢出读数 / 三个文案常量 —— 全是**纯函数**，
> **不起浏览器、不起后端、不经 vite**）⇒ 它只证明"**判据与契约接对了**"。
> 表格长什么样、抽屉有没有真的打开、脚本有没有真的被拦下，**只在你自己动手的这一刻才算数**。
> ⚠️ 本档要**真产物** ⇒ 前置 2/3 不齐时只能验到 ①（两栏/三栏）与 ②（面板存在），验不到 ③~⑲。
> ⭐ **阶段三的收口清单**（把整条出口链串一趟 + 三条"包级才成立"的附加门槛）在本文 **「阶段三出口验收（人工 · P0-3-13 收尾）」** 一节。

### 后端配置自检（P0-1-3 起）

后端启动时自己读 `infra/.env`（`backend/src/config.ts`，zod 校验）：**缺必填项会直接退出并列出
「哪一项 + 怎么修」**，不会带着半截配置跑起来。不加不启动服务，只想看当前生效配置：

```bash
pnpm config:check      # 校验 + 打印脱敏后的生效配置（密码/密钥只报长度，不出明文）
```

| 调试开关（进程环境变量，不写进 `.env`） | 用途 |
|------|------|
| `DOUBULEA_ENV_FILE=/path/to/.env` | 指定另一个 env 文件，忽略自动发现 |
| `DOUBULEA_SKIP_ENV_FILE=1` | 完全不读 env 文件，只校验进程环境（CI/容器场景） |

> 优先级：**进程环境变量 > `infra/.env`**（已存在的变量不会被文件覆盖）。
> 本机 `BACKEND_PORT` 已避让为 **13000**（3000 被别的项目占用）；前端 dev 代理需同步
> `VITE_DEV_PROXY_TARGET=http://localhost:13000 pnpm dev:frontend`。

### 静态检查与验收（P0-1-4 起；数据层从 P0-1-5 起；会话从 P0-1-6 起；认证从 P0-1-7 起；用户管理从 P0-1-8 起；端到端从 P0-1-9 起；模型池从 P0-1-10/11/12 起；embedding 从 P0-1-13 起；知识库数据层从 P0-1-14 起；知识库 CRUD 从 P0-1-15 起；文档上传从 P0-1-16 起；异步队列与 worker 从 P0-1-17 起；空文本检测与分块从 P0-1-18 起；入库与覆盖重建从 P0-1-19 起；双路检索与 RRF 从 P0-1-20 起；列表/下载与包验收从 P0-1-21 起；Agent CRUD 与组件绑定从 P0-1-22/23 起；**会话管理从 P0-1-25 起；SSE 出口（发消息 / 停止 / 互斥 / 心跳）从 P0-1-26 起；ChatBot 编排循环（检索块 / 流式透传 / 引用 / 落库 / 并发闸）从 P0-1-27 起；消息历史（游标分页 / `content` 原样透出）从 P0-1-28 起**；对话包验收从 P0-1-29 起；**前端从 P0-1-30 起**；**知识库页面的判据从 P0-1-35 起**；**管理页的判据从 P0-1-36 起；上游协议扩展（Provider `protocol`：OpenAI Responses / Anthropic 原生 Messages）从 P0-1-37 起**；**MCP client 从 P0-2-1 起；MCP server 注册与连通测试从 P0-2-2 起**；**MCP 页面的判据（MCP 管理页 / 我的凭据页 / 确认卡）从 P0-2-11 起**）

> ⚠️ **2026-09-24：本节的验收脚本已全部移除**（`backend/scripts/**` 连同假上游夹具由用户删除，
> `package.json` 里 26+26 条指向它们的 `verify:*` / `serve:upstreams` 条目也一并清掉 ——
> 清的是**根**与**后端**那两处，`frontend/package.json` 里那几条**没动**，见下面的订正）。
> **验收改走人工端测**：命令与「看什么」见下文「手工端测 · 命令行」与「浏览器端测」两族小节 ——
> 那是**现在唯一有效的验收入口**。下面块里保留的只有静态检查与批次自检；
> 历史上那些 `verify:*` 的名字**只作记录**（用来记住各批「当年验过什么」），照着敲会报 `Command not found`。
>
> ⚠️ **订正（2026-09-24，P0-2-11 回写时发现）**：上面那句只对**后端/接口级**的 `verify:*` 成立。
> **前端有四档无依赖纯逻辑档仍然存在且可跑** —— `pnpm verify:chat-sse` / `verify:knowledge-ui` /
> `verify:admin-ui` / `verify:mcp-ui`（`frontend/scripts/*.mjs`，跑源码、**不起后端、不起浏览器、不经 vite**）。
> ⚠️ 但**"存在 ≠ 要跑"**：按用户 2026-09-24 定案，**验收一律人工端测**，智能体不再把这几档当收尾动作；
> 它们的价值是"判据与契约接对了"这一层，**不证明**界面点得动。

```bash
pnpm lint              # ESLint（扁平配置；业务代码禁 console，必须走 pino）
pnpm -r typecheck      # tsc strict（三包：shared / backend / frontend）
pnpm -r build          # 三包依次产出 dist
pnpm check:batch       # 批次标识自检：docs/06 最后一个 [✓] 的批次号 vs index.ts 启动信封的 step（不一致即 exit 1）
#
# ⚠️ 历史上还有一整套 `pnpm verify:***`（接口级 / 数据层 / 会话 / 各包验收）。
#    其中后端那批已于 2026-09-24 随 `backend/scripts/**` 一起移除 ⇒ 敲它们报 Command not found。
#    ⚠️ 例外：前端四档无依赖纯逻辑档**还在**（verify:chat-sse / knowledge-ui / admin-ui / mcp-ui）——
#    可跑，但按用户定案「验收一律人工端测」，**存在 ≠ 要跑**（见上一段的订正）。
pnpm verify:mcp-ui     # P0-2-11 前端 MCP 页 / 凭据页 / 确认卡 判据档（53 项，跑源码）
```

> ⚠️ **2026-09-26 拆分**：下面这块"**各 verify 档到底验了什么**"的逐档断言清单（P0-1 时期的历史记录）
> 已迁至 **`归档/README-历史验收集.md`**。⚠️ 那批脚本已于 2026-09-24 删除 —— 清单留着是为了记住
> 当年验过什么，**照着敲会报 `Command not found`**。

### 数据模型与迁移（P0-1-5 起）

Prisma 7（Rust-free 客户端 + `@prisma/adapter-pg` 驱动适配器）。schema 在
`backend/prisma/schema.prisma`，Prisma CLI 的配置在 `backend/prisma.config.ts`
（v7 起连接串/迁移目录/seed 都从那里读，`schema.prisma` 的 `datasource.url` 已废弃）。

```bash
# 0) 建库前先起依赖（postgres）
pnpm infra:up

# 1) 应用迁移（首次建表 / 拉到新迁移后同步）
pnpm db:migrate         # = prisma migrate dev（开发态：应用 + 生成迁移 + 校验）
pnpm db:deploy          # = prisma migrate deploy（生产/CI 部署：只应用，不做 diff）
pnpm db:status          # 迁移状态

# 2) 生成客户端（build / typecheck 会自动带上，一般不用手动跑）
pnpm db:generate

# 3) 造第一个账号（P0-1-9 起）—— admin（首登改密态）+ member；见下方「第一个账号从哪来」
pnpm db:seed

# 4) 数据层验收（需要真实 PG，17 项断言；CI 里跑的是不需要依赖的 verify:app）
pnpm verify:db

# 附：messages 按月分区的续期（幂等；建议每月或每季跑一次）
pnpm db:partitions
```

> **第一个账号从哪来**（`POST /api/users` 要求调用者是 ADMIN，而系统里第一个 ADMIN 没有 API 能造）：
>
> ```bash
> pnpm db:seed        # = db:generate && tsx prisma/seed.ts；默认造 admin(ADMIN) + member(MEMBER)
> ```
>
> 两个账号都是**首登改密态**（`mustChangePassword=true`）—— 与"admin 建号"完全同构，
> 所以**admin 也要先改密才能建别人的号**（首登闸门白名单不含 `/api/users`）。
> 初始密码在脚本 stdout 上**只打印一次**；忘了就重发一枚：
> `SEED_RESET_PASSWORD=1 pnpm db:seed`（会把该账号打回首登改密态）。
> 也可自己定密码与用户名：`SEED_ADMIN_PASSWORD=… SEED_MEMBER_PASSWORD=… pnpm db:seed`
> （变量清单见 `infra/.env.example` 的 `[G]` 段；这些变量**不进应用配置**，只在种子脚本进程内生效）。
>
> ⚠️ 种子脚本**默认幂等**：已存在的账号只跳过、**绝不改密码**。这不是便利性取舍而是安全属性 ——
> `db:seed` 会被反复执行，若每次都覆盖密码，"自己改过密码的人"会在下一次 seed 后突然登录不上。
> 覆盖密码必须显式 `SEED_RESET_PASSWORD=1`。

> **为什么 `messages` 要按月分区**：它是全系统写入量最大的表，按月分区让「删旧数据」退化成
> `DROP TABLE messages_YYYY_MM`（秒级、不产生 vacuum 压力），也让热数据留在小索引里（`docs/02` §三）。
> 分区由迁移里的 `ensure_messages_partition(月份)` 动态建「上个月 ~ 未来 12 个月」，
> **缺分区时插入会立刻报错**（`no partition of relation "messages" found for row`）——
> 这是刻意选的失败模式：吵但清晰，好过悄悄写进一个 DEFAULT 分区、等到要 attach 正式分区时才炸。
>
> **Prisma 侧的注意点**：分区键必须在主键里，故 `messages` 是复合主键 `(id, created_at)`，
> `findUnique` 要写 `where: { id_createdAt: { id, createdAt } }`。其余用法与普通模型一样 ——
> 实测 Prisma 的内省能正确识别分区，`migrate dev` 不会尝试重建它（`docs/06` §七 待决事项 1）。

### 起后端 + 健康检查

```bash
# 1) 先起依赖（postgres / redis / minio）
pnpm infra:up

# 2) 起后端——两条路按需选
pnpm dev:backend        # 【开发态·推荐】tsx watch 直接跑 TS 源码，改文件自动重启，不需要先 build
pnpm start:backend      # 【产物态】跑 backend/dist 的编译产物（先 pnpm -r build）

# 3) 探活（macOS/Linux 若走系统代理，务必加 --noproxy '*'，否则会被代理拦成 502）
curl -s --noproxy '*' http://127.0.0.1:13000/health | jq .
```

> `pnpm dev:backend` = `tsx watch src/index.ts`：**编译产物与开发进程解耦**——想单独看类型错误用
> `pnpm --filter @doubulea/backend watch:types`（`tsc --watch`），两个可以同时开。
> Ctrl-C 即优雅退出（SIGINT → 停接流 → 关 PG/Redis → flush 日志）。

`/health` **恒返 HTTP 200**，依赖状态在 body 里：`data.status` 为 `ok` / `degraded`，
`data.checks[]` 逐项给出 `target / ok / latencyMs / detail`。停掉某个依赖（如
`docker compose -f infra/docker-compose.yml --env-file infra/.env stop redis`）后
`/health` 仍返 200、只把 redis 标成不可用，且 `detail` 直接给出原因（如
`connect ECONNREFUSED 127.0.0.1:16379`）；依赖起回后**无需重启进程**即自愈。

| 端点 | 说明 |
|------|------|
| `GET /health` | 探活 PG / Redis / S3（`docs/02` §4.9） |
| `POST /api/auth/login` | 账号密码登录 → 下发 HttpOnly 会话 Cookie；失败态口径见 `docs/02` §4.1 |
| `POST /api/auth/logout` | 注销会话（幂等） |
| `GET /api/auth/me` | 当前用户（含 `mustChangePassword`） |
| `POST /api/auth/password` | 改密 `{oldPassword, newPassword}`（首登强制也走这里） |
| `GET /api/users` | 用户列表 `?offset=&limit=`（仅 ADMIN；`nickname` 可为 null） |
| `POST /api/users` | 建号 `{username, nickname?, role?}` → **一次性初始密码**（仅 ADMIN） |
| `PATCH /api/users/:id` | 启停 / 改角色 `{status?, role?}`（仅 ADMIN；不能操作自己） |
| `POST /api/users/:id/reset-password` | 重置密码 → 新的**一次性初始密码**（仅 ADMIN；不能重置自己） |
| `GET /api/model-providers` | Provider 列表 `?offset=&limit=`（仅 ADMIN；**只回 `hasKey` + `apiKeyPreview` 掩码**） |
| `POST /api/model-providers` | 新建 Provider `{name, baseUrl, type, enabled?, apiKey?}`（仅 ADMIN；`apiKey` 立即加密落库） |
| `PATCH /api/model-providers/:id` | 部分更新；`apiKey` 三态：**不带=不动 / `null`=清空 / 有值=写入**（空串 400） |
| `DELETE /api/model-providers/:id` | 删除（级联删其下模型；有模型被 Agent 引用时 409） |
| `GET /api/models` | 模型列表 `?offset=&limit=&type=&providerId=&enabled=`（仅 ADMIN；含停用项） |
| `POST /api/models` | 新建模型 `{providerId, modelName, label, type, maxContext?, supportsVision?, enabled?}`（仅 ADMIN） |
| `PATCH /api/models/:id` | 部分更新；`maxContext` 三态：**不带=不动 / `null`=清空 / 数字=设置**；`providerId` 不可改 |
| `DELETE /api/models/:id` | 删除（被 Agent 引用时 409；**软删的 Agent 也算**） |
| `GET /api/models/available` | **全员可选模型列表** `?type=CHAT`（登录即可；只回"能用的"，给建智能体的下拉用） |
| `GET /api/model-providers/:id/remote-models` | **拉取该配置的上游实际提供的模型列表**（仅 ADMIN；通则 `GET {baseUrl}/models`，**只读探测不落库**；不要求 Provider 启用、也不要求配 Key） |
| 其余 `/api/**` | P0-1-10 起逐个落地（未注册路由得到统一信封 404）。数据模型（P0-1-5 ✅）、会话（P0-1-6 ✅）、认证（P0-1-7 ✅）、用户管理（P0-1-8 ✅）、**种子脚本 + 端到端验收（P0-1-9 ✅）** 已就位 |

### 起前端（P0-1-30 起：登录页 + 强制改密 + 路由守卫 + 全局布局；P0-1-31/32 起：智能体列表、对话页；P0-1-35 起：知识库列表 + 详情页 + 检索测试；P0-1-36 起：用户管理 + 模型池管理页；**P0-1-37 起：模型池 Provider 可选上游协议（OpenAI 兼容 / OpenAI Responses / Anthropic 原生 Messages）—— 表单多「上游协议」下拉、Provider 表多「上游协议」列，该 Provider 下已有向量模型时协议锁定为 OpenAI 兼容**；**P0-2-11 起：MCP 管理页 + 我的凭据页 —— `/mcp`、凭据页两条占位页换成真页面（凭据页后与 MCP 解耦，路由为 `/settings/credentials`），`03` §二 的 P0 十条路由至此全部落地、界面里再没有 `BatchPlaceholderPage`**；**P0-3-11 起：任务型对话页 —— TaskAgent 的对话页多出第三列「产物面板」，产物卡上的 [预览][下载] 由 disabled 变可点（预览弹层 / 六种渲染器 / 五种格式），整条链路可在浏览器里亲手跑，清单见「浏览器端测 · 任务型对话页」**）

```bash
# 必须显式带代理目标：vite.config.ts 里 /api 的默认值是 localhost:3000，
# 那是**别的项目**的 node（本机 3000 被占，本项目后端在 13000）→ 不传会静默串到陌生服务
VITE_DEV_PROXY_TARGET=http://127.0.0.1:13000 pnpm dev:frontend
# → http://localhost:5174/
```

**端口固定为 5174，不再顺延**（`vite.config.ts` 的 `server.port = 5174` + `strictPort: true`）：
5174 被占时 vite 会**直接报错退出**（`Port 5174 is already in use`），而不是静默跳到 5175
—— 顺延会让 README / `docs/02` 的 `CORS_ORIGINS` / 验收脚本里写死的 origin 全部对不上，
症状是"地址看起来对、请求却打在别处"。该端口与仓库其余文档保持同一口径。

> 验证代理有没有串对：`curl -s --noproxy '*' http://localhost:5174/api/auth/me` —— 应得到**本项目的**
> 401 信封 `{"code":"UNAUTHORIZED",...}`；若返 404/502 或别的响应，就是代理打到陌生服务上了。
> 同理 `curl -s --noproxy '*' http://localhost:5174/health` 应得到本项目的探活 JSON
> —— `/health` **不带 `/api` 前缀**，所以它在 `vite.config.ts` 里有一条**自己的代理规则**（P0-1-30 补）。

**技术栈**：Vite + React 18 + AntD 5 + React Router 6 + TanStack Query 5 + Zustand
（版本口径见 `docs/03` §一）。主题令牌由 `frontend/src/styles/tokens.css` 单一来源定义、
`app/theme.ts` 读 CSS 变量注入 `ConfigProvider`（暗色因此免费）。

> ⚠️ **2026-09-26 拆分**：**P0-1 的五个浏览器端测小节**（登录 / 智能体 / 对话 / 知识库 / 管理页）已迁至
> **`归档/README-浏览器端测-P0-1.md`**（对应批次 P0-1-30/31/32~34/35/36 均已 `[✓]`）。
> ⚠️ **下面紧接着的「浏览器端测 · MCP」不在此列** —— 它是**阶段二唯一**的浏览器端测点，**待人工取证**。

### 浏览器端测 · MCP（⭐ **阶段二唯一的浏览器端测点**：P0-2-11 起）

**前置**（三样都得有，缺一样就走不到后半段）：
1. 同「浏览器端测」首节：**依赖服务 + 迁移 + 后端（13000）+ 前端（5174）**两个进程都起着；
2. **一台可注册的 MCP server** —— 直接用「手工端测 · 命令行」**㉒/㉓ 里那个内联假上游**（另开一个终端跑着它）。
   它是 Streamable HTTP 单 URL，正好当"一台真的 server"用；
3. ⭐ **一个会主动要工具的"模型"** —— ⚠️ **最容易漏的一步**：**真模型不会主动去调一个刚注册的工具**。
   所以在 `/admin/models` 建一个 Provider 指向 **㉓ 里那个假 LLM**（它按帧序要求"拿到工具结果之后才给正文"），
   再用它建一个 `CHAT` 模型 + 一个智能体。
   ⇒ **只做 1、2 也能测"建 server / 填凭据 / 工具清单"，但"对话里触发工具"这一步走不到。**

⚠️ 本批**不做代码语法高亮**之类的无关项；也**不需要真厂商**（用假 LLM）。

| # | 该测的路径 | 预期 |
|---|-----------|------|
| ① | 左侧导航点「MCP」 | 是**真列表页**（不再是"属哪个批次"的占位说明）；顶部一条 Alert 说明**任何登录用户都可以注册 / 调用**，但**「测试连通 / 编辑 / 删除」只有「所属人」或管理员能操作**（⚠️ 2026-10-16 起「测试」也收窄）；连通测试与工具列表用的是**所属人**的凭据，调用工具注入的是**你自己**的凭据；右上角有「我的凭据」入口，带**未配置数量**徽标 |
| ② | 点「注册 server」：填名称 + endpoint（假上游的 URL）+ 在**模板编辑器**里加一行（`token` / 说明 / 注入位置选 **请求头（HEADER）**）→ 保存 | 提示「已注册…」；列表出现该行。⚠️ **工具数列此时显示 `—`**（**没测过 = 说不出来**，不是 `0`）；状态列写「**未测试**」（不是「异常」）。**「所属人」列显示你自己的名字**（昵称优先、没设昵称就是用户名）。⚠️ **警告：`test.ok` 恒 `false`**，因为此时你还没填凭据 —— 回包里那句「所属人尚未在「我的凭据」里配齐参数」是**预期行为**（见下面的【所属人】组）。 |
| ③ | 点该行「测试」→ 再点「工具数」那一列 | 测试成功给一条提示（⚠️ **`/:id/test` 恒 200**，连不上是**结论**不是报错）；工具数变成真数字；工具清单弹窗列出 `echo` / `boom` / `purge` 等，底部标「**刚刚拉取**」；**关掉再点开** ⇒ 标「**来自缓存**」；点「重新拉取」⇒ 又是「刚刚拉取」 |
| ④ | 点「我的凭据」 | 未配置的 server **置顶**并红字列出缺哪些参数；**只填 `token` 一个 key** → 「保存该 server 的凭据」⇒ 成功 |
| ⑤ | ⭐ 回 `/mcp`，编辑该 server，**再加一行** `site`（注入位置选 **查询参数（QUERY）**）→ 保存 | 保存成功后弹一句影响提示，含「新增的参数：site（需要在「我的凭据」里填）」并**必须**带「**已填的值不会被自动清理**」；⚠️ **不许出现「已清理」「已删除」**（那是承诺，系统只提示不清理） |
| ⑥ | ⭐ 回凭据页 | 已存的 `token` 显示「**已配置 ✓**」+ **一个空输入框**（占位符「留空 = 不变」）；⚠️ **空框是对的、不是丢了**（凭据永不下发、连掩码都不给）。**这次只填 `site` 保存** ⇒ 再回来：**`token` 与 `site` 两个都显示已配置** —— 这就是"**只填一个 key 保存、再回来另一个 key 仍在**" |
| ⑦ | 建/编智能体，看第 4 区的 MCP 多选框 | 是真多选框（不再是一句空态说明）；勾选后保存成功。若当前用户**没配**该 server 的凭据，勾选项旁有「未配置凭据」红点 + 「去配置凭据」链接 |
| ⑧ | 点⑦那个「去配置凭据」 | 跳到 `/settings/credentials?serverId=…`，页面**自动滚到该 server 的分组**并**高亮闪一下**（不是停在页面顶部） |
| ⑨ | 用该智能体进对话页，发一句会触发工具的话 | 看到**工具卡状态流转**（运行中 → 成功）；展开能看到入参与出参摘要 |
| ⑩ | ⭐ 触发**危险工具**（假上游里的 `purge` —— 它**没有**声明"只读"） | **输入区被锁**、确认卡**弹出来**：倒计时**在真的倒数**、说明行写着这是**平台按危险判定**发起的确认（`PLATFORM`） |
| ⑪ | **点「取消」** | 卡消失；工具卡变**失败**并写着"用户已取消（未执行）"；**模型继续回答**、这一轮正常收尾（⚠️ **不是**整轮失败 —— 取消后流程可继续） |
| ⑫ | 再触发一次，**点「确认」** | 工具**真的执行**（假上游终端里的请求计数 **+1**），工具卡变成功 |
| ⑬ | 再触发一次，**什么都不点**，等倒计时走完 | 读数停在「**已超时**」、两个按钮变灰（那正是此时的事实：点了也只会拿到 `applied:false`）；服务端按取消处理，**流程照样继续**。想快点看这条：给后端注入 `MCP_CONFIRM_TIMEOUT_SEC=2` 再重启 |
| ⑭ | **刷新页面**看刚才那一轮 | 历史里的工具卡**还在**（`tool_calls` 落库并在 `messageToView` 里还原）；⚠️ **确认卡不会自己回来**（那一轮已经往下走了，这不是 bug） |
| ⑮ | 回 `/mcp` 编辑 server，**删掉** `site` 那一行 → 保存 → 回凭据页 | 影响提示说「已移除的参数：site …」+「已填的值将**不再被注入**」；而凭据页里**那个 key 的已填值仍在**（只是不再被注入）—— 这就是「**不会被自动清理**」的实证 |

**已知边界（别当 bug）** —— P0-2-11 之后：
- ⚠️ **真模型不会主动给一个陌生工具发调用**（见前置 3）⇒ "对话里触发工具"必须用假 LLM 或明确的提示词；
- ⚠️ **`source=SERVER` 的确认卡（MCP 反向发起的 `elicitation/create`）本档验不到** —— 与命令行档 ㉓/㉔ 同一条边界，
  假上游不发 elicitation（所以卡片上那句"由服务端发起"的文案，两种来源里只有一种能被你看到）；
- **「工具数」列在没测过之前是 `—` 不是 `0`**：`0` 的含义是"拉过、真的没有工具"（两个不同的结论）；
- **状态列的「未测试」不是「异常」**：没握过手就是没握过手；
- **凭据值永远不回填**（空框 + 「已配置 ✓」是对的）；**「清除凭据」是另一个显式动作**（不是"把框清空再保存"）；
- **凭据保存是合并语义**（只动你这次填的 key）—— 与智能体 `components` 的**整体替换**刻意相反：
  不可回填的字段只能合并；因此"留空"= 不变，绝不能被当成"清空"；
- **模板校验与后端是同一份**：`key` 撞平台保留头（`accept` 等）/ 含空格 `QUERY` 名含 `&=`/`BODY` 名撞 `jsonrpc`·`id`·`method`·`params`/ 同模板内重名 —— 都会在**行内当场报红**，不会等到提交后 400；
- **删除一台被别的智能体绑着的 server 会 409**（那是"先解绑"的信号，不是坏了）；⚠️ 但**无权限的人看不到这个 409** —— 他会先拿到 403（顺序是 404 → 403 → 409，免得从"被几个智能体绑着"这句话里读出信息）；
- **两台 server 的 `name` 可以重名**（展示名而已）⇒ 定位到分组靠的是 `serverId`，不是名字。
- ⚠️ **操作列里的「无编辑权限」是灰字、不是禁用按钮**（P0-2-12）：能不能改由服务端现算的 `canEdit` 决定，**不是**前端拿 `createdBy` 跟你自己的 id 比 —— 所以**管理员看别人的 server 也照样有「编辑 / 删除」**（那正是这条口径的反例守卫）。

> **⚠️ 这一节证明什么、不证明什么**：智能体侧**没有**代跑浏览器（用户 2026-09-23/24 定案）。
> 判据侧只有**无依赖纯逻辑档** `pnpm verify:mcp-ui`（**53 项**：凭据表单"只改一个 key"的请求体合并语义 /
> 未配置计数与置顶排序 / `?serverId=` 的滚动目标 / 模板编辑器增删行与校验 / server 表单"没改就不发" /
> 列表三个读数 / 确认卡倒计时文案与取消分支 / 逐个错误码→文案 —— 全是**纯函数**，**不起浏览器、不起后端、不经 vite**）
> ⇒ 它只证明"**判据与契约接对了**"。**表格长什么样、滚动有没有真的发生、按钮点得动**，
> 只在**你自己动手**的这一刻才算数。
> ⚠️ **真后端那一半**（注册的 400 文案、`PATCH` 的影响计数、`/:id/test` 恒 200、`/:id/tools` 的 502 与
> "有缓存就 200"）归「手工端测 · 命令行」**㉒/㉓** 的内联假上游，**不归本档**。
> ⚠️ 本节的门槛**尚未取证** —— 它是 P0-2-13（P0-2 包验收）的前置（⚠️ 原写 `P0-2-12`，该编号 2026-09-24 已让给「所属人」批）。

#### 【所属人】组（⭐ P0-2-12 起；编号在本节里**另起一组**）

> **为什么单独一组**：上面那⑮条用的是**无鉴权的假上游** ⇒ 它**验不到**"用所属人凭据连上游"这件事
> （假上游从不回 401）。本组的 ⑤~⑦ 要的正是这条。⚠️ **本组的①②③④和 ⑤⑥⑦是两条独立的链**，
> 可以分开跑；但**都建议开两个浏览器窗口**（一个登 `member`、一个登 `admin`）—— 权限那几条必须
> **两个身份同时在场**才验得干净。
>
> ⚠️ **前置**：同上一节（依赖服务 + 后端 1300 + 前端 5174）；假上游**仍是同一段内联脚本**（见「手工端测 · 命令行」㉒/㉓），
> 它的 **stdout 逐条打印收到的 method** —— 那就是"上游到底有没有收到请求"的取证方式。

| # | 该测的路径 | 预期 |
|---|-----------|------|
| ① | 用 **`member`（记为 A）** 建一台 server（名字如 `owner-test`） | 建好；「所属人」列显示 A 的名字 |
| ② | **换个窗口用 `admin`** 登录、进 `/mcp` | 那台 `owner-test` **在列表里**（**看**不收窄）；**操作列有「编辑 / 删除」**（⚠️ 管理员也算有权限 —— 这一条专门守"前端不许自己算 `canEdit`"） |
| ③ | 在那个窗口用 ADMIN **删掉** `owner-test` | **200**、列表里消失（门槛 1 的正向那一半） |
| ④ | 再建一台（这次**用 A 建**），然后 **A 自己**改一次名字、再自己删掉 | 两次都**成功**（⚠️ 守的是"别顺手加 `requireAdmin`"—— 只验②③ 的话，把权限写成"只有 ADMIN 能改"也能蒙过去） |
| ⑤ | ⭐ **A** 新建一台 server，**先不去填凭据**，直接点该行「测试」 | 提示里是 `ok:false` + 文案含「**所属人尚未在「我的凭据」里配齐参数**」；⚠️ **假上游终端里一行都不打印**（= 上游**零请求** —— 它压根没被连过，所以你不会拿到一句把人引向"我的令牌错了"的 401） |
| ⑥ | ⭐ **A** 去 `/settings/credentials` 把该 server 的 `token` 填上 → 回 `/mcp` 再点「测试」 | `ok:true`；工具数变成真数字；状态列「**正常**」。（这时才真的发出上游请求） |
| ⑦ | ⭐⭐ **换回 `member-B`（另一个人）的窗口**：看同一台 server 那一行 | ⚠️ **2026-10-16 起 B 看不到「测试」按钮**（该行只给「无编辑权限」）—— 连通测试用**所属人**凭据，只有所属人或管理员能点。直接打 `POST /api/mcp/servers/:id/test` ⇒ **403**（先 404 再 403：不可见的私有 server 仍是 404）。再顺手：B 改/删 A 的这台 ⇒ **403**；B 改一个**不存在**的 id ⇒ **404**（两条都要，证明 403 不是被 404 冒充的） |

**已知边界（本组）**：
- ⚠️ **本组验不到 `tools/call` 那一半的"凭据也是分人的"** —— 那一条在上一节的 ⑨~⑫ 与「手工端测 · 命令行」㉓
  的链路里（A 填了能调通、B 没填得 **424 `NEED_CREDENTIAL`** + 工具卡"去配置凭据"）。**两条合起来**才是完整口径
  （"**测试/列表看所属人，调用看自己**"）。
- ⚠️ **没有"转移所属人"的入口**（P1）：`created_by` 建完就定了，**改不了**。要换人只能删了重建
  （⚠️ 删会**连带删掉所有人的凭据**，`ON DELETE CASCADE`）—— 说这个是因为它**不是 bug、是当前边界**。
- ⚠️ **注册者离职 / 被停用 ⇒ 这台 server 的测试与工具列表就废了**（探测主语没了）。平台**没有**兜底
  （"ADMIN 用自己凭据代探"这类属 P1）；这也是为什么**测试这条路刻意不判权限** —— 至少别人还能点一下、拿到那句"所属人尚未配置"。

### 阶段一出口验收（人工 · P0-1-38 收尾；`01` §五 阶段一，7 条门槛）

> 前面六节是**逐批**的端测清单；**这一节是阶段一的收口清单** —— 把 `01` §五 要求的完整出口流程
> 串成一趟。⚠️ **2026-09-23 用户定案：由用户人工执行**，智能体不代跑（所以这里只给"怎么跑 / 看什么"，
> 不给"已通过"的结论）。**建议全程同一个浏览器窗口 + 同一个终端做下来**，别中途换。

**前置（四步，缺一条后面就会看到"不是 bug 的怪现象"）**

| # | 做什么 | 为什么 |
|---|--------|--------|
| ① | `pnpm infra:up && pnpm db:deploy && pnpm db:seed` | 依赖 + 表 + 两个种子账号（**记下 admin 的初始密码**） |
| ② | `pnpm serve:upstreams`（**前台常驻**，抄下它打印的两个 URL） | 对话与 embedding 的**假上游**；`semantic: true` 才拿得到引用卡、`deltaDelayMs=400` 才看得见流式 |
| ③ | 把 Provider 的 `baseUrl` 指到 ② 的 `CHAT_UPSTREAM_URL`（命令见「浏览器端测 · 对话」②） | 否则回答是"连不上上游" |
| ④ | 带 embedding 三项起后端 + 起前端（命令见「浏览器端测 · 对话」③④） | 否则文档走不到 `READY`、检索拿不到 query 向量 |

**R1~R7 怎么跑 / 看什么**

| # | 门槛（`01` §五 原文） | 在哪跑（本节不重复命令，指向既有段） | 看什么 |
|---|---------------------|--------------------------------|--------|
| R1 | 建号 → 登录 → 建知识库传 **3 篇 PDF** → 建 ChatBot 绑库 → 提问 → **带引用回答** | 「浏览器端测 · 管理页」②③④（建号）→「浏览器端测」首节（首登改密）→「知识库」㊳㊴㊵（建库 + 传 3 篇）→「智能体」⑪~⑲（建 CHATBOT 并勾选该库）→「对话」㉑ | 回答**逐字长出来**，且出现**引用卡**；引用卡上的文档名 = 你传的那篇 |
| R2 | **停止** → 已生成部分保留 → **可直接追问** | 「对话」㉗㉘ | 点「停止」后已长出来的内容**不清空**；紧接着追问**不再报"生成中"** |
| R3 | **刷新** → 历史含引用卡**完整恢复** | 「对话」㉓ | F5 后引用卡 / 思考块 / 收尾行都在，形态与刚收口时一致；控制台无报错 |
| R4 | 同会话并发 ⇒ `CONFLICT` | ⚠️ **单页点不出来** —— 须**开第二个标签页/窗口**进**同一个会话**再发（见下面"边界 1"） | 后来那个窗口得到**专用 toast「该会话正在生成中」** + 消息流内一张**错误卡**；先发的那条**继续正常吐字** |
| R5 | **25 轮**超长会话不报错 | 「对话」里对同一会话连着问答到 25 轮以上 | 不报错、不卡死；上下文按 `CONTEXT_ROUNDS`（默认 20 轮）截断（**旧轮次不再进 prompt，但历史仍在**） |
| R6 | 首字延迟 **< 3s**（以服务端 TTFT 日志为准） | 取数命令见下面「TTFT 怎么取」 | 每轮问答的 `ttftMs` **< 3000**（假上游下应是几十~几百 ms） |
| R7 | 全程**无手工干预数据** | 无需额外操作，跑完对着四条证据自查 | 见下面"边界 3"的四条 |

**TTFT 怎么取**（唯一打点：`chatBot.ts` 第一个 `delta` 上的 `本轮首字延迟（TTFT）`）

```bash
# 起后端时顺手把日志存一份（另开一个终端；原终端仍是你正在看的那个）
pnpm dev:backend 2>&1 | tee /tmp/backend.log
```

```bash
# 跑完 R1/R5 之后，从日志里取数。⚠️ 两种日志形态都吃：
#   infra/.env 里默认 LOG_PRETTY=true ⇒ 日志是**美化文本**（此时 jq 打不上去）；
#   把 LOG_PRETTY 置空后是 JSON。下面这条正则对两者都成立。
grep -oE 'ttftMs[": ]+[0-9]+' /tmp/backend.log | grep -oE '[0-9]+$' | sort -n \
  | awk '{a[NR]=$1} END{ if (NR==0) { print "没有取到 TTFT —— 确认这轮真的产生了首个增量帧（不是停在前置闸门）"; exit } printf "n=%d  min=%d  median=%d  max=%d\n", NR, a[1], a[int((NR+1)/2)], a[NR] }'
```

- ⚠️ `ttftMs` 的量纲是**"从本轮请求开始 → 第一个增量帧"**，**不含前端渲染时间**；它是"首字 < 3s"在服务端的**唯一**测量依据，**不能事后补**（事后补出来的数不是 TTFT）。
- ⚠️ 日志里还会带 `historyMessages` 与 `citations`，可用来核对"这一轮到底检索到几条"（R1 的旁证）。

**三条"最容易误判成 bug"的边界**

1. **R4（并发冲突）在单标签页里"点不出来"** —— 单页在 `sending`/`streaming` 期间发送按钮本就禁用 ⇒ **根本发不出去**（这才是"重复发送"真正被挡住的地方，P0-1-33）。要看到 `CONFLICT` 必须**开第二个标签页/窗口**进同一会话再发。⚠️ 这是**正确行为**，不是"防重没生效"。
2. **R6 的读数必须从后端 stdout 里取**，不要在界面上估时延；并且**必须先把 Provider 指到假上游**（真厂商几十毫秒就吐完，肉眼只看得到最后结果 = 什么也没验到）。
3. **R7 不是"我有没有手工插过库"这句话本身**（照字面写是**恒真**的，P0-1-29）。它的可执行形态是**四条只有服务端能产生的证据**：① 用自选密码登不进；② 用**服务端下发**的初始密码能进；③ 文档块正文含你上传时的特征短语，且接口报的 `chunkCount` == 表里实际行数；④ 助手消息正文 == 事件流增量拼接的结果。

> **⚠️ 这一节证明什么、不证明什么**：R1~R7 在**命令行/HTTP 层**已由 `pnpm verify:chat-package`（**24 项**，一行一组）
> 跑过一遍 —— 但它跑的是**本仓夹具假上游 + 脚本化 HTTP** ⇒ 只证明"**契约与配置接对了**"。
> 这里要的是**另一半**："在真浏览器里、由你自己点一遍，那条链是否成立"。
> 两者都成立才算阶段一出口真的过；**只有智能体那份绿不等于功能没问题**（`docs/06` §六 第 30 条）。
> ⚠️ **走查完请复位**：把 ③ 改掉的 Provider `baseUrl` 指回去（或删掉那个 Provider），种子账号若在走查中被改密，
> 按「浏览器端测」首节的复位命令重置。

### 阶段二出口验收（人工 · P0-2-13 收尾；`01` §五 阶段二，2 条门槛 + 3 条附加门槛）

> 前面「浏览器端测 · MCP」（含【所属人】组）是**逐批**的端测清单；**这一节是阶段二的收口清单** ——
> 把 `01` §五 要求的出口流程串成一趟，并补上"**包级才成立**"的三条（跨包串 / **新账号自己走一遍** / 读写投影逐字一致）。
> ⚠️ **由用户人工执行、智能体不代跑**（`docs/06` §六 第 30 条）⇒ 这里只给"怎么跑 / 看什么"，**不给"已通过"的结论**。
> 建议**全程同一个浏览器窗口 + 同一个终端**做下来，别中途换。
> ⚠️ **本批没有产出验收脚本**：`06` 原文点名的 `backend/scripts/verify-mcp-package.mjs` 属"**计划文本里的产出行**"，
> 而 `backend/scripts/**`（连同假上游夹具）已于 2026-09-24 随用户定案一起删除 ⇒ **验收脚本增补计划作废**，
> **本节这张清单就是它的人工替身**。

**前置（六步，缺一条后面就会看到"不是 bug 的怪现象"）**

| # | 做什么 | 为什么 |
|---|--------|--------|
| ① | `pnpm infra:up && pnpm db:deploy && pnpm db:seed` | 依赖 + 表 + 两个种子账号（记下 admin 的初始密码） |
| ② | 另开终端跑「手工端测 · 命令行」**㉓-⓪** 那段**内联脚本**（前台常驻），**只抄它的 `LLMURL=`** | R1/R2 需要一个"**会主动要工具的模型**"；⚠️ **真模型不会主动去调一个刚注册的工具**，没有它"提问触发工具"这一步走不到。③ 的授权假上游会替掉它里面那台假 MCP |
| ③ | ⭐ 再开一个终端跑下面这段「**需鉴权**假 MCP」（前台常驻，抄下 `AUTHMCPURL=`） | R1 的原文是"注册一个**需要 token** 的 server" ⇒ ③ 这台就是它；它的 stdout **打印收到的 `authorization` 头**，那是"凭据真的注入了"的**唯一直接取证** |
| ④ | 在 `/admin/models` 建一个 Provider 指向 ② 的 `$LLMURL`（Key 填占位串即可，假上游不看鉴权头），再建一个 `CHAT` 模型 | 模型池接口仅 ADMIN ⇒ 用 admin 做 ③④；R1 里"用户 A"可以是 admin 自己 |
| ⑤ | 起后端（**13000**）与前端（**5174**） | R1/R2 都是浏览器路径（命令见「浏览器端测 · 对话」③④）。**附加① 还要带 `EMBEDDING_*` 三项**（见下面那一小段） |
| ⑥ | 用 `/admin/users` **建一个全新账号**（MEMBER 即可），并**再开一个浏览器窗口**用另一个身份登录 | 附加② 要的是"**一个新建的账号自己走一遍**"；R2 与附加② **两个身份同时在场**才验得干净 |

```bash
# ③ 需鉴权的假 MCP server（R1 的"需要 token 的 server"）—— ⚠️ 与 ⑳-⓪ / ㉓-⓪ 一样是**内联**的，
#    仓库里不再放夹具文件。它**不校验** token（只把收到的 authorization 打印出来），
#    因为"验证令牌本身"不是本档要证明的事：本档要证明的是"**平台把所属人/调用者那份凭据带出来了**"。
node --input-type=module -e '
const http = await import("node:http");
let n = 0;
const srv = http.createServer(async (req, res) => {
  if (req.method !== "POST") { console.log(`[需鉴权MCP] ${req.method}（不计入）`); res.writeHead(200).end(); return; }
  let body = ""; for await (const c of req) body += c;
  const msg = body === "" ? null : JSON.parse(body);
  n += 1;
  console.log(`[需鉴权MCP] #${n} ${msg?.method ?? "(无 method)"} authorization=${req.headers["authorization"] ?? "(一个都没带)"}`);
  if (msg === null || msg.id === undefined) { res.writeHead(202).end(); return; }
  const result =
    msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "auth-mcp", version: "1.0.0" } }
    : msg.method === "tools/list" ? { tools: [
        { name: "echo", description: "原样回显传入的 text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
        { name: "purge", description: "会改数据（验确认流：先问、后执行）", inputSchema: { type: "object", properties: { target: { type: "string" } } } } ] }
    : msg.method === "tools/call" ? { content: [ { type: "text", text: msg.params?.name + " <- " + JSON.stringify(msg.params?.arguments ?? {}) } ] }
    : {};
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
srv.listen(0, "127.0.0.1", () => console.log("AUTHMCPURL=http://127.0.0.1:" + srv.address().port + "/mcp"));
'
#  → `AUTHMCPURL=http://127.0.0.1:<port>/mcp`
#  ⚠️ 记账口径同 ⑳-⓪：一次成功的"连接 + tools/list"固定 **3 条** POST；每次工具调用**额外 +1** 条 `tools/call`。
#  ⚠️ 模板行要写成 key = `Authorization`、注入位置 = **请求头（HEADER）** —— HEADER 注入里 `key` 就是**头名**
#     （写成 `token` 只会多出一个没人看的 `token:` 头）。`Authorization` **不在**平台保留头名单里
#     （保留的是 accept / content-type / content-length / host / mcp-session-id / mcp-protocol-version），可以占。
```

> 只有当你要跑**附加①**（跨包串）时才需要下面这一段 —— 「浏览器端测 · 对话」①③④ 里引用的
> `pnpm serve:upstreams` **已随 `backend/scripts/**` 一起删除**（README 里还有三处引用它，见本节末尾的 ⚠️）
> ⇒ 这里给它的**最小替身**（够让文档走到 `READY`、检索拿得到 query 向量）：
>
> ```bash
> node --input-type=module -e '
> const http = await import("node:http");
> const srv = http.createServer(async (req, res) => {
>   let body = ""; for await (const c of req) body += c;
>   const p = JSON.parse(body || "{}");
>   const inputs = Array.isArray(p.input) ? p.input : [p.input];
>   const vec = (s) => {
>     const v = new Array(1024).fill(0);
>     for (const ch of String(s)) v[(ch.codePointAt(0) * 31) % 1024] += 1;
>     const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
>     return v.map((x) => x / norm);
>   };
>   res.writeHead(200, { "content-type": "application/json" })
>      .end(JSON.stringify({ object: "list", data: inputs.map((s, i) => ({ object: "embedding", index: i, embedding: vec(s) })) }));
> });
> srv.listen(0, "127.0.0.1", () => console.log("EMBEDDINGURL=http://127.0.0.1:" + srv.address().port + "/v1"));
> '
> #   → 抄下 `EMBEDDINGURL=`，然后**先带这三个变量起后端、再建知识库**：
> #     EMBEDDING_MODE=api EMBEDDING_API_URL=<抄到的> EMBEDDING_API_KEY=dev-fake-key \
> #       EMBEDDING_API_MODEL=<自定义模型名> pnpm dev:backend
> #   ⚠️ 库里存的是建库那一刻的 `api:<模型名>` 快照 ⇒ 变量必须与之后检索时一致；
> #      不同值**不报错**，只会让 `citations` 一会儿有一会儿没有（那是 P0-1-20 的**降级路径**，不是 bug）。
> #   ⚠️ 它是"字符袋"向量（字面重合越多余弦越大）⇒ 只保证"含关键词的块更近"，
> #      **不含**原夹具的 thinking / deltaDelayMs / semantic 三个开关 ⇒ 走它的对话**看不到思考块**、也看不到流式的"慢"。
> ```

**R1 / R2 怎么跑 / 看什么**

| # | 门槛（`01` §五 原文） | 在哪跑（本节不重复步骤，指向既有段） | 看什么 |
|---|---------------------|--------------------------------|--------|
| R1 | 注册一个**需要 token** 的 server → 用户 A 填凭据 → 提问触发工具 → **凭据自动注入** → **确认卡** → 结果返回 | 「浏览器端测 · MCP」②（注册，endpoint 填 `$AUTHMCPURL`，模板加一行 `Authorization` / **HEADER**）→ ③（点「测试」+「工具数」）→ ④（**只填那一个 key**，值随便如 `Bearer dev-owner-token`）→ ⑦⑧（建/编智能体并勾该 server）→ ⑨（提问触发工具）→ ⑩⑪⑫（危险工具 `purge`：弹确认 → 先取消、再确认） | ① ③ 的终端里出现 `authorization=Bearer dev-owner-token` —— 这就是"**凭据自动注入**"（测试/列表走**所属人**凭据，见【所属人】组）；② 工具卡 **RUNNING → SUCCESS**、展开能看到入参出参摘要，且上游那台**恰好 +1 条 `tools/call`**；③ 危险工具 `purge` **先弹确认卡**：点「取消」⇒ 工具卡"用户已取消（未执行）"且**这一轮继续给出正文**，再触发一次点「确认」⇒ 上游计数**再 +1** |
| R2 | 用户 B **未填**凭据 → 工具标记**「需配置」**（且**不发起上游调用**） | 同节的 ⑦（建/编智能体时看 MCP 多选框）+ ④（换成 B 的身份看凭据页） | ⚠️ **两个口径都要看到，别用一个含糊的"标记了"混过去**：① **server 级** = 编辑智能体时该勾选项旁的「未配置凭据」**红点** + 「去配置凭据」链接（含义："我没配这个 server"）；② **调用级** = B 在对话里触发同一台 server 的工具 ⇒ 这一轮以 **424 `NEED_CREDENTIAL`** 收口、工具卡带「去配置凭据」（含义："这一轮工具失败、原因是需配置"）；③ 全程 **③ 的终端里一行都不该多**（= 一个上游请求都没发） |

**三条"包级才成立"的附加门槛**（`docs/06` P0-2-13 验收门槛原文）

| # | 门槛 | 怎么验 | 看什么 |
|---|------|--------|--------|
| ① | **跨包串一遍**（P0-1 的 A~F 链路 + P0-2 的 MCP 链路） | 用**同一个** ChatBot 走"知识库 RAG + MCP 工具"两件事：建库传文档（「知识库」㊳㊴㊵，⚠️ 前置要 up）⇒ 给同一个智能体**同时**绑该库**与**那台 server ⇒ 提问 | 同一轮里**引用卡与工具卡都在**：回答既引用了你传的文档、又调用了工具 —— 两条链路共存于**同一条 SSE 流**（前两节是**各自**验的，串起来才成立） |
| ② | **一个新建的账号自己走一遍** | 「管理页」②③④ 建新号 → 首登改密 → **用它自己**走一遍 R1 的 ②③④⑨：注册 server / 测试 / 填**自己**的凭据 / 触发工具 | 新号**不依赖 admin 的任何既存数据**也能走通；⚠️ 守的是"别顺手加 `requireAdmin`"（本仓**已踩过两次**：五档各自全绿也不代表新账号能走通） |
| ③ | **写入端与读取端的投影逐字对得上** | 附加① 那一轮**F5 刷新**，比对刷新前后的工具卡 | 流里的工具卡（`tool_call` 帧）与刷新后（走 `GET /messages` 的 `content.tool_calls`）**同一形状**：`callId` / `toolName` / `serverName` / `serverId` / `status` / `output` 逐字一致；⚠️ 两处**刻意**的差异只有一对：`inputSummary`（截断 200 的**摘要**）只在上流那份、`arguments`（**完整入参**）只在落库那份 —— 见「浏览器端测 · MCP」⑭ |

**逐行结论（自己填；⚠️ "部分完成 / 等价形态"**单列**、别混进 ✅）**

| 门槛 | 结论 | 备注 / 取证（哪台终端、哪一行读数） |
|------|------|-----------------------------------|
| R1 | ☐ | |
| R2 | ☐ | |
| 附加① 跨包串 | ☐ | |
| 附加② 新账号 | ☐ | |
| 附加③ 读写投影 | ☐ | |

**四条"最容易误判成 bug"的边界**

1. **"凭据注入"本档只能靠"上游打印出来的 `authorization` + 调用没被挡下"取证** —— ③ 那台假上游**不校验** token。要看"**真 401 场景**下所属人凭据是否够用"，走「浏览器端测 · MCP」**【所属人】组 ⑤⑥⑦**（那条用的是本机**真的要求鉴权**的上游）。
2. **R2 看不到确认卡** —— 缺凭据时是**在取凭据那一步就 424 收口**的，根本走不到危险判定 ⇒ 这是**正确行为**。
3. **`source=SERVER` 的确认卡（MCP 反向 `elicitation/create`）本档验不到** —— 与 ㉓/㉔ 同一条既有边界：假上游不发 elicitation。
4. **确认卡只在"平台判为危险"时出现** —— 本档里 `purge` **什么注解都不声明** ⇒ 判危险、先问后执行；`echo` 声明了 `readOnlyHint:true` ⇒ 直接执行、**不弹卡**。把 ③ 那段里的 `annotations` 删掉，整条链会变成"每调一次先弹一次确认"（那是 `docs/02` §9.9 真值表的**另一种输入**，不是 bug）。

> **⚠️ 这一节证明什么、不证明什么**：本批（P0-2-13）**没有产出验收脚本**（见开头），
> 也没有代跑浏览器 / 命令行 —— 智能体侧只做了三件**确定性**的事：把 `docs/06` 的 P0-2-13 段收口（含"脚本增补计划作废"）、
> 把本节与两份版本记录写出来、把启动信封 `step` 推到本批（`pnpm check:batch` 一致）。
> 判据侧的旁证仍是「浏览器端测 · MCP」里点名的**无依赖纯逻辑档** `pnpm verify:mcp-ui`（**53 项**，
> 跑的是纯函数、**不起浏览器、不起后端、不经 vite**）与「手工端测 · 命令行」㉓/㉔ 的**内联假上游**
> ⇒ 它们只证明"**契约与配置接对了**"，**不等于**"阶段二出口验收通过"。两条都成立才算真的过（`docs/06` §六 第 30 条）。
> ⚠️ **走查完请复位**：②③（以及附加①那台 embedding）起的假上游 Ctrl-C 收工；④ 建的 Provider / 模型、
> ② 注册的 server、⑥ 建的新号、附加① 建的知识库与文档 —— 想留就留、想清就按各页的删除入口清
> （⚠️ **删 server 会连带删掉所有人的凭据**，`ON DELETE CASCADE`）。
> ⚠️ **顺带发现的文档缺口（本批未修）**：`pnpm serve:upstreams` 在本文档里还有 **3 处**引用
> （「浏览器端测 · 对话」①、「浏览器端测 · 知识库」前置、「阶段一出口验收」前置 ②），而它
> **已随 `backend/scripts/**` 删除** ⇒ 那三处现在敲下去是 `Command not found`。本节给了它的**最小替身**
> 供本档使用；**要不要把那三处一并改掉，留给你定**（本批不动它们，免得把"阶段一收口清单"一起改了）。

### 阶段三出口验收（人工 · P0-3-13 收尾；`01` §五 阶段三，1 条门槛 → 拆成 R1~R6 + 3 条附加门槛）

> 前面那九节「沙箱…」与「产物列表与下载 / 产物预览 / TaskAgent 计量」是**逐批**的端测清单，
> 「浏览器端测 · 任务型对话页」是阶段三**唯一**的浏览器档；**这一节是阶段三的收口清单** ——
> 把 `01` §五 的一句话出口链（**建 TaskAgent → 派活「分析这份 CSV 出汇总表」→ 沙箱过程可见 →
> 下载/预览产物 → 停止 → 会话恢复**）串成一趟，并补上"**包级才成立**"的三条。
> ⚠️ **由用户人工执行、智能体不代跑**（`docs/06` §六 第 30 条）⇒ 这里只给"怎么跑 / 看什么"，**不给"已通过"的结论**。
> ⚠️ **本批没有产出验收脚本**：`06` 原文点名的包级脚本属"**计划文本里的产出行**"，而 `backend/scripts/**`
> 已于 2026-09-24 随用户定案整目录删除 ⇒ **验收脚本计划作废，本节这张清单就是它的人工替身**（与阶段一/二同一处置）。
> ⚠️ **与阶段一/二最大的不同**：这一节**自带一堆环境前置**（镜像 tag / egress 代理 / 会干活的模型），
> 缺一样就走不到后半段，而其中**代理根本不在仓库里**（见前置 ③）。⇒ 建议**先只跑 R1**（只要前置 ①②⑤⑥），
> 跑通了再补 ③④ 往后走。

**前置（六步，缺一条后面就会看到"不是 bug 的怪现象"）**

| # | 做什么 | 为什么 |
|---|--------|--------|
| ① | `pnpm infra:up && pnpm db:deploy && pnpm db:seed && pnpm db:partitions` | 依赖 + 表 + 两个种子账号（**记下 admin 的初始密码**）；⭐ `db:partitions` 是为 `usage_records`（R3 要查它） |
| ② | ⭐ `pnpm sandbox:build -- --registry https://registry.npmmirror.com`，把末尾打印的两行写回 `infra/.env`（`SANDBOX_IMAGE` / `SANDBOX_IMAGE_BASE`） | **当前是 `:5`**（P0-3-14：桥扩展注册 MCP + 内置知识库工具）。⚠️ 若 `.env` 还停在老 tag，症状最隐蔽：**后端日志一条错都没有**，只是"模型从来不调 MCP / 知识库工具" |
| ③ | ⭐ 准备一个 **egress 正向代理**，把地址填进 `SANDBOX_EGRESS_PROXY_URL` | 它是容器出公网的**唯一**出口（出口①）。⚠️ **仓库不提供生产级代理**（`子方案③` §四 3 写明"代理本身不属 P0 加固范围"），但**自 2026-09-28 起有一个开发用最小实现**（`egress-up.sh`，见下面「③ 的代理」）；留空 ⇒ `ensureSandbox()` **显式拒绝**、一发消息就是错误卡（不是"卡住不动"） |
| ④ | 让模型池**可达**：真 Provider，或一台**假 LLM**（它同样要经 ③ 被容器摸到） | 真模型**不会主动写文件**、也不会主动去调刚注册的工具 ⇒ 要么用假 LLM，要么给一句**明确到不能再明确**的提示词（同「浏览器端测 · 任务型对话页」前置 3） |
| ⑤ | 一个 `TASK_AGENT` 智能体（「智能体」页建，或 curl `POST /api/agents`） | 沙箱路径**只**由库里的 `agent.type` 分流（`resolveChatProducer`），**不加前端参数、也不信前端参数**；⚠️ 类型在库里，不在请求里 |
| ⑥ | 起后端（**13000**）与前端（**5174**） | R1~R6 大部分在浏览器里看；⚠️ 端口的唯一真相来源是 `infra/.env` |

```bash
# ③ 的代理：形状上只有两条要求
#   · **两条腿** —— 一条挂在 `doubulea-sandbox`（`Internal: true`，容器够得着它），
#     另一条挂在**能上网**的网络（默认 bridge 即可）。只有一条腿的代理，在 internal 网络上等于没有；
#   · **无鉴权**（或把凭据一并写进 SANDBOX_EGRESS_PROXY_URL）—— 注入进容器 env 的是 `HTTP_PROXY`/`HTTPS_PROXY` 的裸 URL。
#
# ✅ 本仓自带一个**开发用**最小实现（零依赖、离线可跑）：
bash infra/scripts/egress-up.sh --write-env   # 起代理 + 写进 infra/.env；白名单自动取库里 enabled 的 model_providers
bash infra/scripts/egress-down.sh             # 收工（只删代理容器，不动沙箱网络）
#   · 两条腿、**白名单**（`host` / `host:port` / `*.host`）—— 因为出口① 的定义是"只放行模型池 baseURL"，
#     而现成的 squid/tinyproxy 默认全放行，等于把 internal bridge 的设计意图作废；
#   · **空白名单 = 拒启**（不是全放行）；要加目标 `--allow api.example.com`，临时排查 `--allow-all`；
#   · ⚠️ **顺序**：`doubulea-sandbox` 由**后端启动时**的 listener 建出来 ⇒ **先 `dev-run.sh`，再 `egress-up.sh`**
#     （网不在时会直接告诉你，别手工 `docker network create` —— 后端会校验标签与 `Internal` 标志）。
#
# 手工起也行（形状一样）：随便一台 HTTP 正向代理容器，再 `docker network connect doubulea-sandbox <名字>`，
#   然后 SANDBOX_EGRESS_PROXY_URL=http://<它在沙箱网里的名字>:<port>
#
# ⚠️ macOS / OrbStack 上还有**两堵墙**（都是 P0-3-3 实测，不是推测）：
#   a. 容器**到不了 macOS 宿主**（ENETUNREACH —— bridge 网关在 OrbStack 的 Linux VM 里）
#      ⇒ 假 LLM 若跑在宿主上，得让**代理那台容器**去摸（它另一条腿在默认 bridge 上，通常
#      `host.docker.internal` 通）。⚠️ 因此那条 provider 的 base_url 要写
#      `http://host.docker.internal:<port>/v1` 而**不是** `127.0.0.1:<port>` ——
#      后者在代理容器里指的是它自己的回环（`egress-up.sh` 会跳过并告警这类 provider）。
#   b. 出口②（容器 → 后端 listener）同理够不着宿主 ⇒ 想在本机跑**附加①**，必须显式给一个中转：
#      把 `SANDBOX_BACKEND_URL` 指到那个中转、`SANDBOX_LISTEN_HOST=0.0.0.0`（详见「沙箱安全与网络」）。
#      ⚠️ 只是跑 R1~R6（不涉 MCP）的话，**不需要**这一条。

# 验证代理（三条，反例比正例重要 —— 白名单的坏法是"看起来配了、其实全通"）。
# ⚠️ 必须用本仓的 egress-probe.mjs 而不是 `fetch`：Node 的**全局 fetch 不读代理环境变量**
#    （undici 默认 dispatcher 是裸 Agent）⇒ 直接 fetch 会把"代理不工作"误报成结论。
#    沙箱里能通是因为 pi 装了 `undici.EnvHttpProxyAgent`。三条的期望值：
#      ① 放行 → OK（guji 那个 401/402 = 网络通、只是没额度/没带 key）
#      ② 白名单外的域名 → BLOCKED 403
#      ③ 不挂代理 → FAIL（证明 internal 网真的没路由 ⇒ ① 的通不是"本来就通"）
```

**R1~R6 怎么跑 / 看什么**

| # | 门槛（`01` §五 原文的一段） | 在哪跑（本节不重复命令，指向既有段） | 看什么 |
|---|---------------------------|--------------------------------|--------|
| R1 | **建 TaskAgent** | 「智能体」页新建（类型选**任务型**、绑前置 ④ 的模型）；或「沙箱派活与事件映射」②的 curl | 列表里出现它；编辑页里**类型不可改**（`02` §3.2"创建后不可改"） |
| R2 | **派活「分析这份 CSV 出汇总表」** | 「浏览器端测 · 任务型对话页」③（提示词见那节前置 3） | ⚠️ **"这份 CSV"本身没有入口**（`01` §五 留注、`子方案③` §十三 待决 4 **仍未拍板**）⇒ P0 的办法是**让模型自己在沙箱里造**（提示词写"先用 python 生成一份 20 行的 CSV 存到工作目录，再把它读出来出汇总表"），或走知识库文档。**本档验的是"这条链"，不是"用户上传一份文件让它分析"** |
| R3 | **沙箱过程可见** | 同 ③ | 消息流**逐字长出来**：思考块 → **沙箱工具卡**（RUNNING → SUCCESS，展开有入参摘要/出参）→ 正文 → **产物卡**；右侧面板同步出现同一条。⚠️ 后端日志「本轮结束」那行的 `unknownEngineEvents` / `engineAnomalies` **必须是 0**（非 0 = 映射表落后于引擎版本）。旁证（psql 连 127.0.0.1:15432 / 库 `doubulea`）：`sandboxes` 有一行 `RUNNING`、`usage_records` 多一行（见「TaskAgent 计量」②③） |
| R4 | **下载 / 预览产物** | 「浏览器端测 · 任务型对话页」⑤⑥⑦⑧ | 抽屉打开、五格式各有形态（MD/CSV/图片/PDF/HTML）；**zip 之类没有「预览」按钮、只有「下载」**（能力有无是事实，不是"暂不可用"）；两个下载入口同一条文件 |
| R5 | **停止** | 同节 ⑨ | 收口为「已停止 · 已生成的内容保留」；**面板与产物卡还在**（那一轮真的产出过）；`/usr/local/bin/docker ps -a --filter label=doubulea.role=sandbox` **变空**；`SELECT status, count(*) FROM sandboxes GROUP BY status` 里 `RUNNING` 为 0 |
| R6 | **会话恢复 = 重发一句** | 「沙箱停止」④ | 后端日志重新出现「沙箱容器已就绪」（新容器、`reused:false`）；新容器工作目录是空的（上一轮中间文件不在）**但产物照旧在**（对象存储） |

**三条"包级才成立"的附加门槛**（`docs/06` P0-3-13 验收门槛原文）

| # | 门槛 | 怎么验 | 看什么 |
|---|------|--------|--------|
| ① | **跨两个阶段串一遍**（P0-2 的 MCP 链路 × P0-3 的沙箱链路） | 给**同一个** TaskAgent 同时绑模型与一台**有工具缓存**的 MCP server，**在沙箱里**发一句会用到该工具的任务（前置另加"镜像 `:3`"，步骤见「沙箱 MCP 代理」②③④） | **沙箱工具卡与 MCP 工具卡共存于同一条 SSE 流**（两条链路各自验过，**一轮里同时在**只有包级能问）；再挑一个危险工具 ⇒ **弹确认卡**，取消/确认各走一次（口径：只有 `readOnlyHint===true` 且未声明 `destructiveHint===true` 才算安全） |
| ② | **一个新建的账号自己走一遍** | 「管理页」②③④ 建一个新 MEMBER ⇒ 首登改密 ⇒ **用它自己**建 `TASK_AGENT` 并派活（R1→R3） | 新号**不依赖 admin 的任何既存数据**也能走通；⚠️ 守的是"别顺手加 `requireAdmin`"（本仓**已踩过两次**：各档单独跑都可能全绿） |
| ③ | **写入端（流内）与读取端（刷新后）的投影逐字对得上** | R3 那一轮 **F5 刷新**，比对刷新前后的**沙箱工具卡**与**产物卡** | 工具卡：流里的 `tool_call{kind:SANDBOX}` 帧与刷新后（`GET /messages` 的 `content.tool_calls`）同一形状 —— `callId` / `toolName` / `status` / `output` 逐字一致；产物：面板（`GET /api/conversations/:id/artifacts`）与消息流里的产物段在**条数与文件名**上一致。⚠️ **一对刻意的差异**：`inputSummary`（截断 200 的**摘要**）只在上流那份、`arguments`（**完整入参**）只在落库那份 —— 别把它当 bug（`02` §5.1） |

**逐行结论（自己填；⚠️ "部分完成 / 等价形态"**单列**、别混进 ✅）**

| 门槛 | 结论 | 备注 / 取证（哪台终端、哪一行读数） |
|------|------|-----------------------------------|
| R1 建 TaskAgent | ☐ | |
| R2 派活 | ☐ | |
| R3 过程可见 | ☐ | |
| R4 下载/预览 | ☐ | |
| R5 停止 | ☐ | |
| R6 会话恢复 | ☐ | |
| 附加① 跨阶段串（沙箱卡 + MCP 卡 + 确认卡） | ☐ | 本机可能因"两堵墙"走不通 ⇒ 那样就标 ⚠️ 部分完成 |
| 附加② 新账号 | ☐ | |
| 附加③ 流内/刷新后投影 | ☐ | |

**七条"最容易误判成 bug"的边界**

1. **「这份 CSV 从哪来」仍然没有入口** —— `01` §五 的留注、`子方案③` §十三 待决 4 **至今未拍板**（需求 35 文件附件与 `files` 表都属 P1）⇒ R2 只能"让模型自己造"或绕过。这是**需求边界**，不是本档缺陷。
2. **macOS 上的两堵墙**（容器到不了宿主）：出口② 与"容器经代理摸宿主上的假 LLM"都受影响 ⇒ 本机想把附加① 走完需要显式中转；**只有 R1~R6 不需要**。
3. **`SANDBOX_EGRESS_PROXY_URL` 留空 ⇒ 一发消息就是错误卡**（`ensureSandbox` 显式拒绝，文案里会说清），**不是**"界面卡住不动"。
4. **TaskAgent 不检索知识库**：它的 `citations` **恒为空数组**（P0-3-6 起就这样，`taskAgent.ts` 里写死 `[]`）⇒ **别去等引用卡**；引用卡是 ChatBot 路径的（那属「阶段一出口验收」R1）。给 TaskAgent 绑知识库不会让它变出引用。
5. **计量是"每一轮一行"，且 ChatBot 不写那张表**（见「TaskAgent 计量」）⇒ 别拿 `usage_records` 的条数当"阶段三是否通过的分数"。
6. **停止只回收容器、不删产物**；**客户端断线不回收**（容器留给复用，30min 空闲回收兜底）—— 两者在"留不留容器"上刻意不同。
7. **"任务里调 MCP 工具"那一路另有三条边界**（改了绑定在同容器活着期间不生效 / 非危险调用中途不可中断 / 工具名被后端改成 `mcp_<别名>_<原名>`）⇒ 全在「沙箱 MCP 代理」那节的"已知边界"里。

> **⚠️ 这一节证明什么、不证明什么**：本批（P0-3-13）**没有产出验收脚本**（见开头），也**没有代跑浏览器 / 容器 / 全量回归**
> —— 智能体侧只做了四件**确定性**的事：把 `docs/06` 的 P0-3-13 段收口（含"脚本计划作废"）、把本节与**五处**版本记录写出来、
> 把两份子方案的验收清单接上本节指针、把启动信封 `step` 推到本批（`pnpm check:batch` 一致）。
> 判据侧的旁证仍是各批留下的**无依赖纯逻辑档**（`pnpm verify:artifact-panel` 19 项、`verify:artifact-preview` 26 项…，
> **跑的是纯函数、不起浏览器、不起后端、不经 vite**）与各节末尾写明的"已取证 / 仍未取证"分界
> ⇒ 它们只证明"**契约与配置接对了**"，**不等于**"阶段三出口验收通过"。两条都成立才算真的过（`docs/06` §六 第 30 条）。
> ⚠️ **走查完请复位**：③ 起的代理容器与 ④ 的假 LLM `Ctrl-C` / `docker rm` 收工；② 建的 `TASK_AGENT` 与它的会话、
> 附加② 建的新号、附加① 注册的 MCP server 与凭据 —— 想留就留、想清就按各页的删除入口清（⚠️ **删 server 会连带删掉所有人的凭据**，`ON DELETE CASCADE`）；
> 走查中被改密的种子账号按「浏览器端测」首节的复位命令重置。⚠️ **容器与具名卷**按「沙箱停止」③ 复核一遍（回收失败只 warn，残留留给对账器）。

> ⚠️ **2026-09-26 拆分**：**`手工端测 · 命令行`**（P0-1-9 起的第一族端测，curl + 内联假上游，
> 约 120KB / 1331 行）已迁至 **`归档/README-命令行端测.md`**。所覆盖批次均已 `[✓]`；
> **当前还要人工跑的**，只有上面那四节（浏览器端测 · MCP / 阶段一出口验收 / 阶段二出口验收 / 阶段三出口验收）。

## 二、文档清单

所有设计文档位于 `docs/`（施工纪律：**文档先于代码**，需求变更先改 `01`，再改 `02`/`03`，最后改 `06` 与代码）。

### 标准文档（三件套）

| 文档 | 定位 |
|------|------|
| `docs/01-整体需求与实施步骤.md` | **顶层基准**：27 项决策总表、8 模块 P0/P1/P2 需求清单、五阶段实施步骤（含依赖链与出口验收）、子方案索引 |
| `docs/02-后端设计.md` | 技术选型、架构分层、16 张表数据模型、API 全集（约 50 端点）、SSE 契约（10 事件）、ChatBot/TaskAgent 双编排器、MCP 用户级凭据机制、安全与部署 |
| `docs/03-前端设计.md` | React 18 技术栈、14 路由、对话页详设（七种消息卡片 + 输入区状态机）、SSE→UI 映射、全局交互规范、文件预览概要、工程结构 |
| `docs/04-设计评审报告.md` | 评审记录（A/B/C 三级问题与结论存档）；其修订建议已于 2026-09-20 回写至 01/02/03 |
| `docs/05-P系列计划拆分.md` | **计划视图**：把 40 项需求按 P=Plan 重排为 P0（31 项，分 3 批次）/ P1（7 项）/ P2（2 项），含验收口径与推进箭线 |
| `docs/06-实施计划.md` | **施工图**：**施工图主文件**：P0-1（38 步）/ P0-2（13 步）/ P0-3（17 步）三批的实施步骤，含路线图、开工前置核对、仓库形态（§3.0）、批次索引、施工纪律（§六）、待决事项。**每批完成后回写 §三/§四 的批次索引表**；完成态详规与版本记录在 `docs/归档/` |

### 子方案（复杂点拆分）

| 文档 | 内容 | 状态 |
|------|------|------|
| `docs/子方案/知识库流水线.md` | 解析（PDF/docx/MD/TXT）/分块/向量+中文全文（pg_bigm）双路检索（RRF）/覆盖重建/异步队列 | ✅ 已完成（2026-09-20，吸收 B1/B3/B8/B9/B11 + A2） |
| `docs/子方案/沙箱与引擎集成.md` | 引擎定案 Pi（直连 `pi --mode rpc`）/ 容器生命周期 / 事件映射 / 产物收集 / MCP 后端代理 | ✅ 已完成（2026-09-25，P0-3-0a） |
| `docs/子方案/文件预览.md` | MD/HTML/图片/CSV/PDF 五格式预览 + 安全处理（两条出口：下载 `attachment` / 预览 `inline`；**六条安全判据** + 逐格式落法） | ✅ 已完成（2026-09-26，P0-3-0b） |
| `docs/子方案/Code模式工作区.md` | **Code 模式**：人机共享工作区（共享 FS + DB 版本索引 + S3 冷备）/ agent 文件 I/O 中介 / 四层并发防护（串行 · claim · CAS · 三方合并）/ CodeMirror 6 前端 | 📝 设计讨论稿（2026-10-08） |
| `docs/子方案/沙箱多机部署.md` | **沙箱多机部署（路线 A）**：每机一实例 + 按会话路由（`SANDBOX_INSTANCE_ID` 实例身份 / `Sandbox.instanceId` 归属列 / 三处对账按本机过滤 / 队列键按实例隔离 / Redis 会话→实例目录 / 路由网关）；**R1 部署编排（后端/网关两个镜像 + 两套 compose）+ R2① 自动发现 + R3 负载感知 + R4 全局可观测 + R5 实例注册表已落地（2026-10-19）**，余网关多副本编排 / 负载感知 / 全局可观测 | 🚧 部分落地（核心 2026-10-12 · R1/R2① 2026-10-19） |

### 缺陷与踩坑归档

| 文件 | 内容 |
|------|------|
| `issue_fix/问题记录-P0-1-1-环境与链接.md` | pnpm 不读 `.npmrc`、构建白名单键名、**目录符号链接静默失败**、`clean` 自递归、tsc 产物污染源码 |
| `issue_fix/问题记录-P0-1-2-基础设施与镜像.md` | **pg_bigm 无二进制包**、tag 日期后缀、Docker 加速器 403、**PS 5.1 的 `{{}}` 与 `.ps1` 编码坑**、`psql` 多语句/临时表坑 |
| `issue_fix/问题记录-P0-1-3-配置与日志.md` | **zod `.default()` 被 `.env` 空串绕过**、`loadEnvFile` 不覆盖已有变量、pino transport 与生产装包、产物期模块路径更深、pino 保活进程 |
| `issue_fix/问题记录-macOS环境适配.md` | 启停脚本补 `.sh` + 跨平台入口、**宿主端口避让**（邻居项目占着 5432/6379/9000/9001）、macOS 特有工具差异 |

> ⚠️ **2026-09-24：这张表原有的其余 38 条已由用户删除**，且**后续不再新建 `issue_fix/` 归档**
> （验收脚本与踩坑归档一并取消）。新的踩坑知识**直接写进 `docs/02` 与 `docs/06` 的对应小节** ——
> 上面保留的四条是环境/基础设施类的，它们对新机器上手仍有价值。

> ⚠️ **每批动依赖或改基础设施前，先读对应的 `issue_fix` 记录**（施工纪律 §六·3）。
> SSE 编排协议已并入 `docs/02-后端设计.md` 第五~七节，不单独拆分。

---

## 三、核心决策速查（详见 `docs/01` 第二节完整 26 项）

| 主题 | 结论 |
|------|------|
| 对话链路 | 双链路：ChatBot = 后端 RAG 编排直连 LLM；TaskAgent = 沙箱内 ACP 引擎；SSE 事件后端归一化 |
| 组件 | 仅知识库 + MCP；插件/工作流/技能/页面均不做 |
| MCP | 2025-06-18 规范（Streamable HTTP / elicitation）；全员可注册 + **用户级凭据注入**（token 指向人）；危险工具（annotations）平台强制确认；OAuth 2.1 P1 |
| 沙箱 | 会话即容器，Docker SDK，空闲 30min 回收，并发上限 10 排队；**egress 白名单网络**（仅放行模型池出口） |
| 知识库 | PDF/docx/MD/TXT；pgvector + pg_bigm 中文全文混合检索（RRF 融合）；引用带文档名+片段；覆盖重建 |
| 模型 | 平台模型池（chat/embedding 两类）；Agent 绑定单模型不可运行时切换 |
| embedding | 双模式：本地 onnx（bge-m3 int8，默认）/ OpenAI 兼容 API，配置切换 |
| 权限 | 全员可建 Agent（创建者+admin 编删）；角色仅 ADMIN/MEMBER；账号密码登录 |

---

## 四、实施路线（详见 `docs/01` 第五节）

```
阶段一 P0 问答闭环   → 场景 A：知识问答带引用
阶段二 P0 工具闭环   → 场景 C：MCP 工具 + 用户凭据 + 确认流
阶段三 P0 任务闭环   → 场景 B：沙箱任务 + 产物交付 + 全格式预览
阶段四 P1 完善       → 复制/附件/引导问题/用量统计/任务中心
阶段五 P2 按触发启动 → stdio MCP / SSO / 长期记忆 等
```

> 此处 P = Priority（优先级）。若需按 **P = Plan（计划）** 查看拆分结果（P0 计划 31 项 / P1 计划 7 项 / P2 计划 2 项），见 `docs/05-P系列计划拆分.md`。

---

## 五、目录规划

**仓库形态（2026-09-20 定案）：单仓 + pnpm workspace，前后端平级分离**——支持前后端独立构建、独立部署；不分两个 git 仓库（理由与替代方案见 `docs/06-实施计划.md` §3.0）。

```
doubuleA/
├── README.md                      ← 本文件（仓库门面，兼文档索引与快速开始）
├── docs/                          ← 全部设计文档（P0-1-1 已迁入）
│   ├── 01-整体需求与实施步骤.md    ← 顶层基准
│   ├── 02-后端设计.md
│   ├── 03-前端设计.md
│   ├── 04-设计评审报告.md          ← 评审存档（结论已回写）
│   ├── 05-P系列计划拆分.md         ← 计划视图（P0/P1/P2）
│   ├── 06-实施计划.md              ← 施工图**主文件**（活件：路线图/§3.0/口径/纪律/待决/P0-3）
│   ├── 归档/                       ← **完成态沉淀**（2026-09-26 拆出，按需查阅）
│   │   ├── 06-P0-1-实施步骤.md      ← P0-1 38 步详规
│   │   ├── 06-P0-2-实施步骤.md      ← P0-2 13 步详规
│   │   ├── 06-版本记录.md           ← 施工流水（一批一行）
│   │   ├── README-命令行端测.md / README-浏览器端测-P0-1.md
│   │   ├── README-历史验收集.md / README-版本记录.md
│   │   └── 02-版本记录.md
│   └── 子方案/
│       ├── 知识库流水线.md         ← ✅ 已完成
│       ├── 沙箱与引擎集成.md       ← 待写（P0-2 期间）
│       └── 文件预览.md            ← 待写（P0-2 期间）
├── shared/                        ← @doubulea/shared：zod schema + 类型 + 错误码（编译期依赖）
│   └── src/                       ← errors.ts + envelope.ts（P0-1-3 ✅）+ auth.ts（P0-1-7 ✅）
│                                     + user.ts（用户管理契约，P0-1-8 ✅）
│                                     + modelProvider.ts（Provider 契约，P0-1-10 ✅）
│                                     + model.ts（模型契约 + 两套投影，P0-1-11 ✅）
│                                     （modelProvider.ts 于 P0-1-12 补「上游模型列表」契约）
├── backend/                       ← @doubulea/backend（独立构建，→ backend/dist）
│   ├── prisma/schema.prisma       ← 7 张表 + 7 个枚举（P0-1-5 ✅）
│   ├── prisma/seed.ts             ← 种子脚本：第一个 admin（首登改密态）+ member（P0-1-9 ✅）
│   ├── prisma/migrations/0001_init/ ← 首个迁移（含手写的 messages 分区 DDL）
│   ├── prisma/sql/                ← 非迁移的手工 SQL（分区续期）
│   ├── prisma.config.ts           ← Prisma CLI 配置：schema/迁移目录/seed/连接串（P0-1-5 ✅）
│   ├── generated/prisma/          ← Prisma Client 生成物（gitignore，build/typecheck 重建）
│   ├── src/
│   │   ├── index.ts               ← 启动入口 + 优雅退出（P0-1-4 ✅）
│   │   ├── app.ts                 ← Fastify 装配：CORS/bodyLimit/请求上下文钩子（P0-1-4 ✅）
│   │   ├── config.ts              ← 环境变量校验 → 强类型 config（P0-1-3 ✅）
│   │   ├── plugins/errorHandler.ts ← Zod 校验器 + 错误 → 信封（P0-1-4 ✅）
│   │   ├── plugins/session.ts     ← Cookie 会话 + requireAuth/requireAdmin + 首登改密闸门（P0-1-6/7 ✅）
│   │   ├── routes/health.ts       ← /health 探 PG/Redis/S3（P0-1-4 ✅）
│   │   ├── routes/auth.ts         ← /api/auth/* 四端点（P0-1-7 ✅）
│   │   ├── routes/users.ts        ← /api/users/* 四端点，仅 ADMIN（P0-1-8 ✅）
│   │   ├── routes/modelProviders.ts ← /api/model-providers/* 四端点，仅 ADMIN（P0-1-10 ✅）
│   │   ├── routes/models.ts       ← /api/models/* 四端点（仅 ADMIN）+ /available（登录即可）（P0-1-11 ✅）
│   │   ├── services/auth.service.ts ← 登录（含限速）/ 改密（P0-1-7 ✅）
│   │   ├── services/user.service.ts ← 列表 / 建号 / 启停改角色 / 重置密码（P0-1-8 ✅）
│   │   ├── services/model.service.ts ← Provider CRUD + Key 加密/AAD 绑定/掩码（P0-1-10 ✅）
│   │   │                              + 模型 CRUD + 三套守卫 + 两套投影（P0-1-11 ✅）
│   │   │                              + resolveChatTarget()（解密 Key → 上游目标）+ 拉上游模型列表（P0-1-12 ✅）
│   │   ├── llm/client.ts          ← OpenAI 兼容传输层：chat() / chatStream() / fetchRemoteModels()（P0-1-12 ✅）
│   │   ├── llm/upstream.ts        ← 通用上游件：看门狗/中断/脱敏/状态码映射/fetchUpstreamJson（P0-1-13 ✅）
│   │   ├── llm/embedding/         ← index.ts（工厂 + 就绪自检）+ api.ts（OpenAI 兼容 /embeddings）
│   │   │                            + local.ts（worker 客户端）+ embedding.worker.ts（线程内宿主）（P0-1-13 ✅）
│   │   └── infra/                 ← logger.ts（P0-1-3 ✅）+ pg/redis/s3.ts（P0-1-4 ✅）
│   │                                + prisma.ts（客户端单例，P0-1-5 ✅）
│   │                                + crypto.ts（AES-256-GCM + bcrypt，P0-1-6 ✅）
│   └── scripts/                   ← ⚠️ **空目录**：原有的一整套 verify-*.mjs 与假上游夹具
│                                      **2026-09-24 由用户删除**（空目录还在 ⇒ 别再往里放东西）。
│                                      验收入口改走 README 的「手工端测 · 命令行」与「浏览器端测」两族
│                                      （两族步骤已于 2026-09-26 归档，见 `docs/归档/README-*.md`）
├── frontend/                      ← @doubulea/frontend（独立构建，→ frontend/dist 纯静态）
│   ├── src/app/                   ← 路由+守卫 / 布局外壳（左侧栏图标+文字+收起、顶栏面包屑快捷导航；
│   │                                所有页面统一，含对话页）/ nav.ts 导航与面包屑单一来源 /
│   │                                crumbContext.ts 二级页细节段上报 / paths.ts（含 credentialsPath）/
│   │                                feedback.ts 错误码→文案 / theme.ts / format.ts 时间读数唯一来源 /
│   │                                confirm.ts 逐字确认判据（P0-1-36 ✅ 四处消费方共用）
│   ├── src/pages/                 ← login / agents / chat / knowledge / mcp / settings / admin
│   │                                —— `agents/` `knowledge/` `admin/` `mcp/` **各带一个零依赖纯逻辑文件**
│   │                                   （agentModel / knowledgeModel / adminModel / **mcpModel**）
│   │                                   ⚠️ P0-2-11 起 `/mcp` 与 `/settings/credentials` 是真页面，
│   │                                   界面上**再没有** `BatchPlaceholderPage`
│   ├── src/features/chat/         ← 对话域组件 + **十个零依赖纯逻辑文件**（P0-1-32~34 ✅；P0-2-11 加 confirmModel）
│   ├── src/api/                   ← 按模块请求封装（TanStack Query 底座）；client.ts 统一信封 → ApiError
│   │                                （另含 requestFormData / requestBlob / fileNameFromContentDisposition
│   │                                  三个**非 JSON 形态**通道，P0-1-35 ✅）
│   │                                + mcp.ts（MCP 六端点 hooks + `confirmConversation`，P0-2-11 ✅）
│   ├── src/stores/                ← zustand（ui 主题、chatStream 流状态）
│   ├── src/styles/                ← tokens.css 令牌唯一来源 / base.css / app.css（只放结构）
│   └── scripts/                   ← **无依赖验收档**：verify-chat-sse.mjs（P0-1-32 ✅）/
│                                    verify-knowledge-ui.mjs（P0-1-35 ✅）/ verify-admin-ui.mjs（P0-1-36 ✅）/
│                                    **verify-mcp-ui.mjs（P0-2-11 ✅）**
│                                    —— `node --import tsx` 直跑**源码**，不起浏览器/不起后端/不经 vite
│                                       （⚠️ 四档都只证明"判据与契约接对了"；且**存在 ≠ 要跑**）
├── infra/                         ← docker-compose + 自建 PG 镜像 + 启停脚本（P0-1-2 ✅）
│   ├── docker-compose.yml         ← postgres / redis / minio
│   ├── postgres/Dockerfile        ← pgvector + 源码编译 pg_bigm
│   ├── postgres/initdb/           ← 空卷首次初始化时自动建扩展
│   ├── .env.example  .env         ← 变量模板 / 本机（gitignore）
│   └── scripts/                   ← dev-up/down.{ps1,sh} + infra.mjs(跨平台入口) + pg-verify.mjs
├── package.json                   ← 仅编排，不装业务依赖
├── pnpm-workspace.yaml
├── tsconfig.base.json             ← strict 收敛 + 路径别名
├── eslint.config.mjs              ← 扁平配置（P0-1-4 ✅）
├── .editorconfig  .npmrc  .gitignore
└── .github/workflows/ci.yml       ← install→lint→typecheck→build→verify（P0-1-4 ✅）
```

---

## 六、版本记录

> ⚠️ **2026-09-26 拆分**：全部版本记录（约 163KB）已迁至 **`归档/README-版本记录.md`**。
> ⚠️ **文档口径变更仍要追加一行**（追加到那个归档文件），这是"只增不改历史结论"的落点。
