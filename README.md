# doubuleA — 内部 Agent 工作台

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
| 环境准备 / 起依赖 / 起后端 / 起前端 / 常用命令 | 本文 **§一** |
| **浏览器端测 · MCP**（阶段二唯一浏览器端测点，**待人工取证**） | 本文 **§一** |
| **阶段一出口验收（人工）** / **阶段二出口验收（人工）** | 本文 **§一**（**未验，待人工执行**） |
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
| base 镜像 | `doubulea/sandbox-base:2`（P0-3-4 起；`:1` 是上一版，缺 `gen-models.mjs` 那一步） |
| toolkit 镜像（**= 最终镜像**，`SANDBOX_IMAGE` 指它） | `doubulea/sandbox-toolkit:2` |
| pin 的引擎 | `@earendil-works/pi-coding-agent@0.87.1`（Node ≥ 22.19.0，镜像内实为 22.23.3） |
| 镜像内用户 | `agent`（uid 10001，**非 root**）；可写点只有 `/work`（卷）与 `/tmp`（P0-3-3 起是 tmpfs） |
| pi 配置 | **只读种子**烤进 `/opt/pi/agent`（`PI_AGENT_SEED`，对 agent 只读）；入口 `entrypoint.sh` 把它 `cp -an` **播种**到可写的 `/tmp/pi-agent`（`PI_CODING_AGENT_DIR`）后再 `exec pi`。⚠️ 必须两步：pi 读 `settings.json` 会**先在同目录加锁**，只读目录上加不上锁 ⇒ 整份 settings 被判 invalid 并**静默忽略**。里面**没有 `auth.json`**（Key 走容器环境变量）；**P0-3-4 起播种后多一步 `gen-models.mjs`** ⇒ 运行期生成 `models.json`，而它的 `apiKey` 只是 `${DOUBULEA_LLM_API_KEY}` **引用**（见「沙箱 LLM 注入」一节） |
| 依赖自检 | 构建末步跑 `toolkit/selfcheck.sh`，缺一个依赖就让 **build 失败** |

```bash
# 在活容器里重跑依赖自检（排障时先跑它，能把"镜像问题"与"用法问题"分开）
docker run --rm --entrypoint /opt/sandbox-selfcheck.sh doubulea/sandbox-toolkit:2
# 手 run 一个"能说话"的容器（默认 CMD 就是 --mode rpc）
docker run --rm -i -v doubulea-sandbox-smoke:/work doubulea/sandbox-toolkit:2 --help
```

> ⚠️ **为什么 toolkit 必须构建期预烘焙**：egress 白名单只放行模型池 ⇒ 容器内 `pip install pandas` /
> `npm i` **必然失败**，而阶段三的验收场景「分析这份 CSV 出汇总表」恰恰要 pandas（`子方案③` §五 2）。
> 新增依赖 = 重建 toolkit 层 + 改 `versions.mjs` 里的层版本号，**不是运行时补**。
> ⚠️ **本步不是可端测里程碑**：容器生命周期**已落地**（P0-3-2，见下一节）、两条网络出口（P0-3-3）、
> 模型 Key 注入（P0-3-4，见后面「沙箱 LLM 注入」一节）都已落地，但**引擎桥还没接**（P0-3-5/6）
> ⇒ **现在还不能派活**；最早可端测的点仍是 **P0-3-11**。

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
#    需先起依赖：pnpm dev:infra（或 infra 下的 compose）
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
> **没有任何 HTTP / SSE 面**（谁派活、事件怎么映射成前端的卡，是 P0-3-6）⇒ **最早可端测的点仍是 P0-3-11**。

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

### 起前端（P0-1-30 起：登录页 + 强制改密 + 路由守卫 + 全局布局；P0-1-31/32 起：智能体列表、对话页；P0-1-35 起：知识库列表 + 详情页 + 检索测试；P0-1-36 起：用户管理 + 模型池管理页；**P0-1-37 起：模型池 Provider 可选上游协议（OpenAI 兼容 / OpenAI Responses / Anthropic 原生 Messages）—— 表单多「上游协议」下拉、Provider 表多「上游协议」列，`EMBEDDING` 类型不给选非兼容协议**；**P0-2-11 起：MCP 管理页 + 我的凭据页 —— `/mcp`、`/mcp/credentials` 两条占位页换成真页面，`03` §二 的 P0 十条路由至此全部落地、界面里再没有 `BatchPlaceholderPage`**）

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
| ① | 左侧导航点「MCP」 | 是**真列表页**（不再是"属哪个批次"的占位说明）；顶部一条 Alert 说明**任何登录用户都可以注册 / 测试 / 调用**，但**只有「所属人」或管理员能编辑 / 删除**；连通测试与工具列表用的是**所属人**的凭据，调用工具注入的是**你自己**的凭据；右上角有「我的凭据」入口，带**未配置数量**徽标 |
| ② | 点「注册 server」：填名称 + endpoint（假上游的 URL）+ 在**模板编辑器**里加一行（`token` / 说明 / 注入位置选 **请求头（HEADER）**）→ 保存 | 提示「已注册…」；列表出现该行。⚠️ **工具数列此时显示 `—`**（**没测过 = 说不出来**，不是 `0`）；状态列写「**未测试**」（不是「异常」）。**「所属人」列显示你自己的名字**（昵称优先、没设昵称就是用户名）。⚠️ **警告：`test.ok` 恒 `false`**，因为此时你还没填凭据 —— 回包里那句「所属人尚未在「我的凭据」里配齐参数」是**预期行为**（见下面的【所属人】组）。 |
| ③ | 点该行「测试」→ 再点「工具数」那一列 | 测试成功给一条提示（⚠️ **`/:id/test` 恒 200**，连不上是**结论**不是报错）；工具数变成真数字；工具清单弹窗列出 `echo` / `boom` / `purge` 等，底部标「**刚刚拉取**」；**关掉再点开** ⇒ 标「**来自缓存**」；点「重新拉取」⇒ 又是「刚刚拉取」 |
| ④ | 点「我的凭据」 | 未配置的 server **置顶**并红字列出缺哪些参数；**只填 `token` 一个 key** → 「保存该 server 的凭据」⇒ 成功 |
| ⑤ | ⭐ 回 `/mcp`，编辑该 server，**再加一行** `site`（注入位置选 **查询参数（QUERY）**）→ 保存 | 保存成功后弹一句影响提示，含「新增的参数：site（需要在「我的凭据」里填）」并**必须**带「**已填的值不会被自动清理**」；⚠️ **不许出现「已清理」「已删除」**（那是承诺，系统只提示不清理） |
| ⑥ | ⭐ 回凭据页 | 已存的 `token` 显示「**已配置 ✓**」+ **一个空输入框**（占位符「留空 = 不变」）；⚠️ **空框是对的、不是丢了**（凭据永不下发、连掩码都不给）。**这次只填 `site` 保存** ⇒ 再回来：**`token` 与 `site` 两个都显示已配置** —— 这就是"**只填一个 key 保存、再回来另一个 key 仍在**" |
| ⑦ | 建/编智能体，看第 4 区的 MCP 多选框 | 是真多选框（不再是一句空态说明）；勾选后保存成功。若当前用户**没配**该 server 的凭据，勾选项旁有「未配置凭据」红点 + 「去配置凭据」链接 |
| ⑧ | 点⑦那个「去配置凭据」 | 跳到 `/mcp/credentials?serverId=…`，页面**自动滚到该 server 的分组**并**高亮闪一下**（不是停在页面顶部） |
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
| ⑥ | ⭐ **A** 去 `/mcp/credentials` 把该 server 的 `token` 填上 → 回 `/mcp` 再点「测试」 | `ok:true`；工具数变成真数字；状态列「**正常**」。（这时才真的发出上游请求） |
| ⑦ | ⭐⭐ **换回 `member-B`（另一个人）的窗口**：**他自己不填任何凭据**，去点同一台 server 的「测试」 | **仍然 `ok:true`**（工具数照旧）—— 这就是"**探测主语是所属人、不是点按钮的人**"的实证。再顺手：B 改/删 A 的这台 ⇒ **403**；B 改一个**不存在**的 id ⇒ **404**（两条都要，证明 403 不是被 404 冒充的） |

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

> ⚠️ **2026-09-26 拆分**：**`手工端测 · 命令行`**（P0-1-9 起的第一族端测，curl + 内联假上游，
> 约 120KB / 1331 行）已迁至 **`归档/README-命令行端测.md`**。所覆盖批次均已 `[✓]`；
> **当前还要人工跑的**，只有上面那三节（浏览器端测 · MCP / 阶段一出口验收 / 阶段二出口验收）。

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
│   ├── src/app/                   ← 路由+守卫 / 布局外壳（含专注布局与「工作台」下拉）/
│   │                                nav.ts 导航单一来源 / paths.ts（含 mcpCredentialsPath）/
│   │                                feedback.ts 错误码→文案 / theme.ts / format.ts 时间读数唯一来源 /
│   │                                confirm.ts 逐字确认判据（P0-1-36 ✅ 四处消费方共用）
│   ├── src/pages/                 ← login / agents / chat / knowledge / mcp / settings / admin
│   │                                —— `agents/` `knowledge/` `admin/` `mcp/` **各带一个零依赖纯逻辑文件**
│   │                                   （agentModel / knowledgeModel / adminModel / **mcpModel**）
│   │                                   ⚠️ P0-2-11 起 `/mcp` 与 `/mcp/credentials` 是真页面，
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
