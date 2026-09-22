# doubuleA — 内部 Agent 工作台

> 公司内部 Agent 平台：**问知识、派任务、接工具**。
> 全新建设，单组织内部使用，无商业化能力。
>
> 本仓库是**单仓 monorepo**（pnpm workspace），同时承载设计文档与全部工程代码。技术底座：TypeScript 单体后端 + React 前端 + PostgreSQL(pgvector + pg_bigm) + Redis + 对象存储 + Docker 沙箱。

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

### 静态检查与验收（P0-1-4 起；数据层从 P0-1-5 起；会话从 P0-1-6 起；认证从 P0-1-7 起；用户管理从 P0-1-8 起；端到端从 P0-1-9 起；模型池从 P0-1-10/11/12 起；embedding 从 P0-1-13 起；知识库数据层从 P0-1-14 起；知识库 CRUD 从 P0-1-15 起；文档上传从 P0-1-16 起；异步队列与 worker 从 P0-1-17 起；空文本检测与分块从 P0-1-18 起；入库与覆盖重建从 P0-1-19 起；双路检索与 RRF 从 P0-1-20 起；列表/下载与包验收从 P0-1-21 起；Agent CRUD 从 P0-1-22 起）

```bash
pnpm lint              # ESLint（扁平配置；业务代码禁 console，必须走 pino）
pnpm -r typecheck      # tsc strict（三包）
pnpm -r build          # 三包依次产出 dist
pnpm verify:app        # 接口级验收：用 app.inject 打请求，**不占端口、不启 docker**（85 项；CI 加 EXPECT_DEGRADED=1 为 86 项）
pnpm verify:embedding  # embedding 双模式验收：真 HTTP 假上游 + stub 推理运行时，**不占端口、不启 docker**（27 项）
pnpm verify:db         # 数据层验收：库结构 + Prisma 客户端，**需要真实 PG**（17 项）
pnpm verify:session    # 会话验收：Cookie/Redis 会话/停用即失效，**需要真实 PG + Redis**（13 项）
pnpm verify:auth       # 认证接口验收：登录/改密/限速/首登闸门，**需要真实 PG + Redis**（21 项）
pnpm verify:users      # 用户管理验收：权限/建号/启停改角色/重置密码，**需要真实 PG + Redis**（17 项）
pnpm verify:e2e        # 端到端验收：起真实进程 + 真实 HTTP 跑六条门槛，**需要真实 PG + Redis**（17 项）
pnpm verify:model-providers  # 模型池 Provider 验收：Key 加密/读脱敏/三态/删除守卫，**需要真实 PG + Redis**（18 项）
pnpm verify:models     # 模型管理验收：两套投影/可选列表过滤/六条守卫，**需要真实 PG + Redis**（17 项）
pnpm verify:llm        # LLM client 验收：起真 HTTP 假上游，报文/流式边界/超时中断/上游模型列表，**需要真实 PG + Redis**（22 项）
pnpm verify:knowledge  # 知识库数据层验收：扩展/算子类/两条特殊索引/migrate diff 无漂移/EXPLAIN 命中，**只需真实 PG**（23 项）
pnpm verify:knowledge-bases  # 知识库 CRUD 验收：建库快照/局部合并/级联+S3/全员权限，**需要真实 PG + Redis + MinIO**（19 项）
pnpm verify:documents  # 文档端点验收：四道前置校验/文件头魔数/四格式解析/上传即入队/按库判重/**列表分页与排序/下载字节流与两个头**，**需要真实 PG + Redis + MinIO**（44 项）
pnpm verify:pipeline   # 流水线验收：队列语义/状态机/幂等四道/并发闸门/失败可重试/入队原子性/扫描件与分块，**需要真实 PG + Redis + MinIO**（29 项）
pnpm verify:ingest     # 入库验收：真 embedding（假上游）/chunk 落库与向量/id 版本位/覆盖重建/内容未变化/失败重试/删除文档，**需要真实 PG + Redis + MinIO**（23 项）
pnpm verify:retrieval  # 检索验收：三模式/六列分数/**与独立 SQL 逐条等价**/RRF 数值反算/引用片段三分支/阈值与候选池/降级路径，**需要真实 PG + Redis + MinIO**（27 项）
pnpm verify:kb-package # **包级验收**：逐行跑 `子方案①` §十二 的 8 行（CRUD/四格式/扫描件/重试/重建/检索/引用/性能），**需要真实 PG + Redis + MinIO**（11 项）
pnpm verify:agents     # Agent 验收：两种类型 CRUD/`canEdit` 三方向/绑定模型四态/三态字段/软删三件套，**需要真实 PG + Redis（不需要 MinIO）**（26 项）
pnpm check:batch       # 批次标识自检：`docs/06` 最后一个 `[✓]` 的批次号 vs `index.ts` 启动信封的 step（不一致即 exit 1）
```

> `pnpm verify:app` 会在构建产物上跑：/health 三项探活、Zod 校验失败的字段明细、领域错误、
> 未知异常不泄露内部信息、404 兜底、413/415、CORS 预检、requestId 透传，以及
> P0-1-6 的密文往返/篡改检出、bcrypt 形态、初始密码生成、未登录出口，P0-1-7 的
> `/api/auth/*` 注册与 schema 字段明细、首登闸门不误拦匿名请求，P0-1-7/8/10/11 的
> shared 契约纯函数（认证 / 用户管理 / 模型池四套 schema，含 `maskApiKey` 的边界、
> **Provider 输出形态的键级自检**：不得出现 `apiKey` 或任何带 `enc` 的键，
> 以及**模型两套投影的键集合互不串味**：可选项不得含 `enabled`/`agentCount`/时间戳）。
> P0-1-11 另有一条**路由分流**断言：`GET /api/models` 与 `GET /api/models/available`
> 各自是真路由、且 `GET /api/models/:id` **不存在**（同路径两个 GET 会让 Fastify 在
> 启动期就抛 `FST_ERR_DUPLICATED_ROUTE`）；P0-1-12 补上
> `GET /api/model-providers/:id/remote-models` 的注册与鉴权，以及**上游模型列表契约**的
> 取值域与"键集合里不存在任何凭据名"。P0-1-16 补上文档上传路由（**只有这一条** ——
> 列表/下载端点属后续批次，**刻意不提前注册**）与**前置校验的纯函数矩阵**：扩展名白名单、
> `.doc` 专拦（文案必须含「请另存为 .docx 后重传」）、MIME 交叉校验、以及**文件头魔数**
> —— 包括"改名成 `.pdf` 的文本""普通 zip 改名成 `.docx`""OLE2 改名""含 NUL 的 `.txt`"
> 四条反面用例（只做 MIME 交叉校验的实现在这几条上必红）。P0-1-17 补上**文档状态机契约**
> （`DOCUMENT_STATUS_TRANSITIONS` + `canTransitionDocumentStatus`）：5 条合法迁移逐条断言，
> 并钉死三条**非法**迁移 —— `READY→FAILED`、`READY→READY`、`FAILED→READY`。
> 前两条挡住"陈旧的队列任务把一份已就绪的文档改写坏"，第三条要求重试必须**经过可见的
> `PARSING` 中间态**（否则列表里看不出"正在重试"）。
> 无依赖环境（如 CI）加 `EXPECT_DEGRADED=1`，额外断言"依赖不可达时探活逐项降级"
> 与"会话存储不可用时鉴权**失败关闭**（500，绝不放行）"。
>
> `pnpm verify:session` / `verify:auth` / `verify:users` / `verify:e2e` / `verify:model-providers`
> / `verify:models` / `verify:llm` / `verify:knowledge-bases` / `verify:documents` / `verify:pipeline`
> / `verify:ingest` / `verify:retrieval` / `verify:kb-package` / `verify:agents` 是**必须**先起依赖 + 迁移的**十四档**
> （`pnpm infra:up && pnpm db:deploy`），因为验的正是"真实 Redis/PG 上的行为"：
> 会话基础设施（Cookie 属性、`session:{sid}` 的 TTL 与滑动续期、停用/删号失效路径）；
> 四个认证端点（含**登录限速第 6 次 429**、**首登强制改密闸门 403**、以及
> "不泄露账号是否存在"的**耗时**取证）；用户管理四端点（含**建号 → 初始密码登录 → 首登改密**链路、
> **停用后该用户已有会话下一个请求就 401**、**不能停用/降级/重置自己**）；
> 端到端（`docs/06` P0-1-9 的**六条门槛**：种子脚本 3 条 + 门槛 1~6 + 登出 + 自清理复核）；
> 模型池 Provider（**Key 不回显明文**的三层取证：响应层搜不到明文/密文、存储层是
> `v1.<iv>.<tag>.<ct>` 且能用 AAD 解回原文、绑定层换 id 即解不开；外加 PATCH 三态与两条 409 守卫）；
> 模型管理（**两套投影**：管理列表看得见停用项、可选列表只含"能用的"；`?type=` 过滤、
> **Provider 停用后模型也不可选**、`maxContext` 三态与六条守卫，其中"删被引用的模型"特意用了
> **软删的 Agent** —— 它照样占 RESTRICT 外键）；
> LLM client（**起一个真 HTTP 的假上游**按 OpenAI 协议应答 —— 验收不依赖外部厂商；
> 断言"Key 被解密后真的注进了 `Authorization`""**默认没有发 `stream_options`**"、
> SSE 分片/无 `[DONE]`/末帧无空行/思考增量/畸形帧等边界、两级超时、以及"用户点停止 ≠ 故障"）。
> 文档上传（P0-1-16）在**接口层**验四道前置校验与 413/406（413 靠**注入 8KB 的
> `UPLOAD_BODY_LIMIT`** —— 脚本内先写 `process.env` 再动态 `import`，因为配置在模块加载期
> 只读一次；`pnpm --filter` 那条路会吞掉参数，所以不用命令行开关），在**解析层**真跑四个夹具
> 生成的文件（PDF 页码、docx 标题路径、MD 的 ATX 标题与"围栏里的 `#` 不算标题"、GBK 编码
> 嗅探），在**存储层**断言"S3 字节与上传内容逐字节相等"、**同库判重命中不新建行**、
> **跨库同内容不判重**、以及**走 API 删库后 DB 与 S3 双清**（用 `listObjectsV2` 按前缀复核残留）。
> 异步流水线（P0-1-17 起，P0-1-18 扩到 `verify:pipeline`）分九组：A **纯函数**（队列键可按 `PIPELINE_QUEUE_KEY` 注入、
> job 编解码、非法载荷**返回 `undefined` 而不是抛**、状态机矩阵）；B **队列语义**（LPUSH 后深度 +1、
> BRPOP 取出、**超时返回 `undefined`**、垃圾载荷被丢弃，以及一条关键断言 —— **阻塞读不占用共享连接**：
> 故意留一个挂起的 `BRPOP`，同时用共享连接 `PING` 必须 < 500ms 返回）；C **端到端四格式**
> （上传后恒 `PARSING` 且**入队一条**，启 worker 后四个文档全部转 `READY`、`error_msg` 清空）；
> D **幂等四道**（同一文档并发投递 3 次只处理一次；对已是 `READY` 的文档再投递**一个字节都不写**
> —— 断言 `updated_at` 不变，这是"治不了的那道闸"的取证方式；陈旧 `contentHash` 与文档已删各自被跳过）；
> E **并发闸门**（8 个各睡 200ms 的任务，`peakInFlight` 必须 = `PIPELINE_CONCURRENCY`=2，
> 总耗时 ≥ 4 波 —— 只测"峰值 ≤ 2"的实现把闸门写成了串行也能过，所以同时测下界）；
> F **失败与重试**（删掉 S3 对象 → `FAILED` + `error_msg` 有人话；把对象放回并**重新入队 → `READY`**
> 且 `error_msg` 清空；再换成"内容与扩展名不符"的文件 → 又 `FAILED`）；G **入队原子性**
> （**子进程 A/B 控制**：真 Redis 子进程上传成功；`REDIS_URL=redis://127.0.0.1:1` 的子进程上传**必须失败
> 且回滚** —— DB 行与 S3 对象都不留，否则文档会永远卡在 `PARSING` 且没人消费）；
> H **空文本检测 + 分块**（P0-1-18：空白 PDF → `FAILED` 且 `error_msg` 含「疑似扫描件」、原文件**仍保留**；
> 阈值边界 —— 有效字符**恰好等于**阈值通过、少一个即失败，用例按**当前阈值**生成；以及"④ 拦在 ⑤ 之前"
> 的顺序取证 —— 重跑阶段数组时 `ctx.chunks === undefined`。另一半把**存储里的真字节**再喂给同一条
> `load-source → parse → detect-empty-text → chunk`：验 200 字短通知恰好 **1 块**、结构清晰 docx 切 **2 块**
> 且首块边界落在句末、重叠前缀逐字相等于前块末尾；P0-1-19 起它还多验一条**HTTP 层看不到**的事 ——
> **重跑一遍是"整次替换"而不是追加**（库里仍是 2 行，不是 4 行））；
> I **收尾**（删库后 DB 与 S3 双清、注入的队列键删净。本组是 P0-1-17 的 "H 组"，P0-1-18 在它前面插了新组故顺延）。
> ⚠️ 它验不到的东西：文档列表/下载端点（P0-1-21）⇒ 进度仍只能查库
> （但 `chunk_count` 已是真的，`psql` 一眼能看出"入库了几块"）。
> 它**跑得起来的前提**之一：P0-1-19 起 ⑥ 会真的调用 embedding，故脚本自己起了一个
> **假 embedding 上游**（第四档口径）—— 本机 `.env` 的三项是空的，不接上所有"走到 READY"的用例都会红。
> `pnpm verify:app`（无依赖档）里另有三段纯函数契约：**分块策略**（小文档特例、句末回退、
> **每块都是原文的逐字子串**、重叠与块长上界、尾块合并、定长滑窗、**按码点切不劈开代理对**、
> PDF 页码 meta、同名标题不相邻时顺序保持、未知策略回落）、**三条新端点的契约**
> （路由注册、`deduplicated` ≠ `unchanged` 不串味、重试/删除形状、提示常量）与
> **检索的规则本身**（P0-1-20：query 预处理、引用窗口、RRF 融合公式）——
> 它们刻意不 import `config`，所以能进 CI。
>
> `pnpm verify:retrieval` 是 **P0-1-20** 的双路检索验收（需要 PG + Redis + **MinIO**，自起
> **假 embedding 上游**、且用 `semantic: true` 的"词面重叠型"向量，好让"含关键词的那一块"
> 在向量路里真的排第一）。五组用例：① **A 组·三模式** —— `FULLTEXT` 单独跑中文 query 非空
> （证明 pg_bigm 生效）、`VECTOR` 里含关键词的块**严格更近**、`HYBRID` 里"两路都第 1"的块排第一，
> 且**向量路/全文路的名次与分数都跟"独立跑一遍同形状 SQL"逐条相等**（只断言"非空 + 有六列"时，
> 一个"按 seq 排序"的假实现照样全绿）；② RRF 的 `rrfScore` 用返回的两路名次**逐条反算**、
> `finalRank` 连续且降序、`topK` 截断；③ 引用片段三条分支（命中居中 ±80 完整窗口 / 命中贴边在 0 裁剪 /
> 字面未命中取块首）且**每一条都是它那块正文的逐字子串**；④ **B 组·生效配置**（相似度下限只作用于
> 向量路、`topK`/`mode` 覆盖**不落库**、参数回显来自该库快照与环境特征值 77/5）；⑤ **C 组·降级路径**
> （模型变更 ⇒ `HYBRID` 跳向量路 + 告警 / `VECTOR` 409；embedding 未就绪 ⇒ 同样降级 / `VECTOR` 500，
> 用**子进程注入空配置**验）；另加 D 组权限（MEMBER 可检索）与 E 组清场。
> 性能一条：`elapsedMs` 与墙钟都要求 < 500ms（本机实测 3ms / 4ms）。
>
> `pnpm verify:documents` 的 **F 组（列表）与 G 组（下载）** 是 P0-1-21 补的：F 组验分页三件套、
> **`createdAt desc` 的"最新在前"**（刚上传的那篇必须在第一条）、列表项与上传响应**同一套投影**（键集合
> 逐字对照）、跨库不串、以及"`PARSING` = 更新中，暂不参与检索"这条**用户可见**的判据；G 组验
> **下载字节与上传逐字节相等**、`Content-Type` 按扩展名唯一确定、`Content-Disposition` 能还原中文名、
> **对象丢失 → 404 且不动数据库**、幽灵/跨库 docId 与未登录一律拒绝，并用 **MEMBER** 账号守门。
> `verify:app` 的第 23 节则把两条规则做成**纯函数断言**（`Content-Disposition` 的双写与**头注入防护**、
> 下载类型表与上传白名单的跨表一致性）—— 那些错误不会让接口 400，只会让下载下来的名字乱码。
>
> `pnpm verify:kb-package` 是 **P0-1-21 的包级验收**：**一行一组**逐行跑 `子方案①` §十二 的 8 行
> （R1 CRUD 级联删 / R2 四格式 READY + 扫描件 FAILED + `.doc` 拦截 / R3 FAILED→retry→READY /
> R4 覆盖重建 + **用真检索端点验"只返回 v2"**（新词命中、旧词查不到）/ R5 双路得分 + 融合排名 /
> R6 片段 ⊆ 原文 / R7 性能 / R8 `FULLTEXT` 单跑非空），每行打印结论。它**不重复**各档的细粒度断言，
> 只跑"串起来之后还成不成立"的证据。
>
> `pnpm verify:agents` 是 **P0-1-22** 的 Agent 验收（需要 PG + Redis，**不需要 MinIO** —— 它不上传文档；
> 但要注入一组 `EMBEDDING_*`，因为 E 组要建一个**真知识库**来验"解绑之后才删得掉"，建库要取
> embedding 快照 —— 那是**纯配置计算**，不发网络请求）。七组：**A 组**枚举同源 + 两种类型都能建 +
> `type`/`modelId` 必填 + 列表**对全员开放**且 `canEdit` **三个方向都对**；**B 组**绑定模型的可用性
> 校验（绑 **disabled 模型被拒** 是本批验收门槛；另含向量模型 / Provider 停用 / 不存在的模型三条，
> 以及**"可选列表里出现过的模型都能建成功、不在列表里的一律被拒"的一致性断言**；还有一条
> **"模型事后被停用 → 仍能改名"**，守"换绑才校验"这条幂等规则）；**C 组**权限 —— 用 **MEMBER**
> 跑建/改/删（若有人"顺手"给智能体也加 `requireAdmin` 立刻红），反向是 **ADMIN 改别人的 Agent 必须成功**
> （只验"普通用户 403"的话，一个"仅创建者"的实现会全绿）；**D 组**四个文本字段的三态
> （不带=不动 / `null`=清空 / 值=设置，**逐字段回库里核对**）、`guideQuestions` 四种边界、
> `type` 不可改（不同值 409、同值 200）；**E 组**软删三件套 —— 最要紧的一条是
> **「绑 KB 的 Agent 让该 KB 删不掉（409）→ 软删这个 Agent → 同一个 KB 立刻能删（200）」**，
> 只打标记的实现会让那条 409 **永久卡住**；外加"详情 404 但行还在""软删后不出现在列表"
> "已软删的一律 404（不是 403）""**软删的 Agent 仍占模型引用计数**"（跨批次口径一致性）；
> **F 组**路由表（五条在，`PUT …/components` 与 `POST …/copy` **必须 404**）；**G 组**纯函数
> （`canEditAgent` 矩阵、`normalizeGuideQuestions` 永不抛错、输出键集合里**没有**内部列）。

> `pnpm verify:ingest` 是 **P0-1-19** 的入库验收（需要 PG + Redis + **MinIO**，同样自起**假 embedding 上游**）。
> 七组用例：① **A 组·入库** —— `chunk_count` 与 `chunks` 表**逐行一致**、每行都有向量、维度 1024、
> `meta` 三键齐备、⚠️ **id 的版本位必须是 `7`**（`uuid(7)` 只有 Prisma 的 `@default` 一个实现，
> 手搓会静默降级成 v4 —— 这是唯一抓得住它的断言）、并在上游侧取证"只发 `model`/`input` 且不超批大小"；
> ② **B 组·覆盖重建** —— 文档 id **不变**、旧 chunk id **一个不剩**、全库**无孤儿**、
> 内容真的是 v2、旧 S3 对象被删；"检索会返回 v2"用**向量近邻 SQL**（`ORDER BY embedding <=> $1`）
> 做了数据层等价取证（检索端点属 P0-1-20）；
> ③ **C 组·内容未变化** —— `unchanged=true`，且三个"没做"逐个取证（**chunk 行 id 逐字不变**、
> 文档 `updated_at` 不变、对象数不变、队列深度 0 —— 只断言"内容还在"是验不出"重写了一遍"的）；
> ④ **D 组·失败重试** —— 上游 500 → `FAILED` 且原因是「文本向量化失败（已重试 2 次）」、
> 修好后 `POST /retry` → 响应立刻 `PARSING` → `READY`、`READY` 再 retry → **409**；
> ⑤ **E 组·删除文档** —— `deletedChunks` 数对 + 行/chunk/对象三清、重复删 404；
> ⑥ **F 组·边界与权限** —— **重建不能绕过前置校验**（`.doc` / 改名 / 空文件）、未登录 401、
> **MEMBER 全通**（守门断言用最低权限账号）；⑦ **G 组·清场**。
> 各脚本都自造临时数据并在收尾时删净（含 Redis 键），跑完还会**断言**残留为零，不会污染开发库。
> 看细节日志：`LOG_LEVEL=debug pnpm verify:users`。
>
> `pnpm verify:embedding` **与上一条相反：它不需要任何依赖**（本批没有新增 HTTP 路由、provider 也不碰库），
> 因此可以跟 `verify:app` 一起进 CI。三组用例：① **api 模式**对着真 HTTP 假上游验报文（批 32、
> 只发 `model`/`input` 不发 `encoding_format` 之类）与五种异常（条数不符/维度不符/`index` 不是排列/
> 非数字/401 脱敏/超时）；② **local 模式**注入一个**临时 stub 运行时**，用线程内回报的 `threadId`
> 证明"推理真的不在主线程跑"、批 32、维度与条数校验、出错后线程仍可用、`dispose()` 后能重建；
> ③ **工厂接线**用**子进程注入环境变量**跑，验 `EMBEDDING_MODE` 切换真的接到了对的 provider 上
> （与 `infra/.env` 当前状态解耦）。⚠️ **它验不到的东西**：local 的**推理与精度**（模型文件未就位，
> 见 `docs/06` §七 待决事项 2）与"单条 < 500ms"的性能门槛 —— 这两条要等运行时模块到位后补验。
>
> ⭐ `pnpm verify:e2e` 与前四个的关键区别：**它自己 spawn 一个真实后端进程**（默认端口 **13099**，
> 不占你正在看的 13000），用真实 TCP + `fetch` 走一遍，并**手写 Cookie 罐**（不使用任何测试后门）。
> 换句话说 —— 它能跑通，就意味着**你照着下面的 curl 敲也能跑通**。端口被占时换一个：
> `E2E_PORT=13098 pnpm verify:e2e`。
>
> `pnpm verify:knowledge-bases` 是 **P0-1-15** 的知识库 CRUD 验收（需要 PG + Redis + **MinIO**，
> 因为验的就是"删库时 S3 原文件真的消失"）。四组用例：
> ① **A 组** CRUD —— 用**注入的一组特征环境默认值**（chunk 256/32、topK 8 / score 0.42 / rrfK 77）
> 证明建库参数是**从环境快照**而不是硬编码；`retrievalConfig` 是**局部合并**（只调 `topK` 不会把
> `mode` 打回默认值）；`description` **三态**；跨字段守卫按**生效值**算；以及一条本批最该钉死的
> 断言 —— ⚠️ **权限是「登录即可」不是 ADMIN**（用 **MEMBER** 账号跑"建/改/删"三连；若有人给这些
> 路由挂上 `requireAdmin`，它会立刻红）；
> ② **B 组**删库 —— `documents`/`chunks` 走外键级联、**S3 原文件真的消失且回报真实个数**、
> **被 Agent 绑定时 409 且库与内容一个都没被删**（`agent_components.ref_id` 是多态引用、**没有外键
> 兜底**，数据库不会替你拦）；
> ③ **C 组**补默认值 —— 老数据存 `{}` / 只剩一半键 / 键值越界，读接口仍返回**完整且合法**的形状，
> 外加一条**跨包一致性**断言（`schema.prisma` 手写的 DB 默认值 vs `shared` 的规范默认值）；
> ④ **D 组** embedding 未就绪（**子进程注入环境变量**，因为配置在模块加载期读且进程内只算一次）——
> **写**（建库）→ 500 且**不留半成品**；**读** → 照常可用、`embeddingModelChanged` 降级为 `null`。

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

### 起前端（⚠️ 目前只有骨架页，**没有登录页**）

```bash
# 必须显式带代理目标：vite.config.ts 里 /api 的默认值是 localhost:3000，
# 那是**别的项目**的 node（本机 3000 被占，本项目后端在 13000）→ 不传会静默串到陌生服务
VITE_DEV_PROXY_TARGET=http://127.0.0.1:13000 pnpm dev:frontend
# → http://localhost:5174/（vite 配的 5173 被别的项目占，会自动顺延到 5174）
```

`frontend/src/main.tsx` 现在还是 **P0-1-1 的占位实现**（只渲染一行「doubulea-frontend / 当前阶段：P0-1-1 骨架」），
用于验证三包构建链路与 `shared` 的解析。**真正的登录页 / 强制改密跳转 / 路由守卫 / 全局布局是 P0-1-30 的产出**
（`docs/03-前端设计.md`）—— 在那之前，浏览器里看不到任何业务界面，端测请走上面的命令行路径。

> 验证代理有没有串对：`curl -s --noproxy '*' http://localhost:5174/api/auth/me` —— 应得到**本项目的**
> 401 信封 `{"code":"UNAUTHORIZED",...}`；若返 404/502 或别的响应，就是代理打到陌生服务上了。
> （代理只匹配 `/api`，所以 `/health` 经 5174 得到的是 SPA 回退的 HTML，属预期。）

### 手工端测（⭐ 第一个可端测里程碑：P0-1-9 起）

**前置**：`pnpm infra:up && pnpm db:deploy && pnpm db:seed`（拿到 admin 的初始密码），然后
`pnpm dev:backend` 起后端。地址 **`http://127.0.0.1:13000`**（本机 3000 被别的项目占，见 `docs/06` §七 待决事项 6）；
macOS/Linux 走系统代理时 **curl 必须加 `--noproxy '*'`**，否则会被代理拦成 502。

```bash
BASE=http://127.0.0.1:13000

# ① 用初始密码登录（用户名大小写不敏感）→ data.mustChangePassword=true
curl -s --noproxy '*' -c /tmp/jar -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"admin","password":"<初始密码>"}' | jq .

# ② 首登态访问业务接口 → 403「首次登录必须修改密码后才能使用其他功能」
curl -s --noproxy '*' -b /tmp/jar $BASE/api/users | jq .

# ③ 改密 → 200 且 mustChangePassword 转 false（旧密码写错会得到 400 + body.oldPassword 明细）
curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"oldPassword":"<初始密码>","newPassword":"<你的新密码>"}' | jq .

# ④ 建号 → data.initialPassword 只出现这一次
curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/users \
  -H 'content-type: application/json' -d '{"username":"alice","nickname":"爱丽丝"}' | jq .

# ⑤ 用 ④ 拿到的初始密码登录 alice → 同样是首登态（必须改密）；改密后 403 的理由变成「仅限管理员」
# ⑥ 停用 alice → 她**手里已有的会话下一个请求就 401**（无需等 60s）
curl -s --noproxy '*' -b /tmp/jar -X PATCH $BASE/api/users/<alice-id> \
  -H 'content-type: application/json' -d '{"status":"DISABLED"}' | jq .

# ⑦ 连打 6 次错密码 → 第 6 次 429「账号已锁定，请 10 分钟后重试」
for i in 1 2 3 4 5 6; do curl -s --noproxy '*' -o /tmp/b.json -w "%{http_code} " \
  -X POST $BASE/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"member","password":"nope"}'; jq -r .msg /tmp/b.json; done
```

**该看到什么**：① 200 + `mustChangePassword: true`；② 403（闸门文案）；③ 200 + `mustChangePassword: false`；
④ 200 + `initialPassword`（18 字符、无易混字符）；⑥ 401 + 「账号已停用」；⑦ 前 5 次 401 通用文案、第 6 次 429。

#### 附：模型池（P0-1-10 Provider / P0-1-11 模型）

```bash
# ⓪ 先拿一个"非首登态"的 MEMBER 会话（种子账号 member 也是首登态，会被闸门拦 —— 需先自助改密）
curl -s --noproxy '*' -c /tmp/member.jar -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"member","password":"<member的初始密码>"}' > /dev/null
curl -s --noproxy '*' -b /tmp/member.jar -X POST $BASE/api/auth/password \
  -H 'content-type: application/json' \
  -d '{"oldPassword":"<member的初始密码>","newPassword":"<member的新密码>"}' | jq .

# ① 建一个带 Key 的 Provider → 响应里只有掩码，**没有明文**
curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/model-providers \
  -H 'content-type: application/json' \
  -d '{"name":"OpenAI","baseUrl":"https://api.openai.com/v1","type":"CHAT","apiKey":"sk-proj-abcdefghijklmnop"}' | jq .
#  → apiKeyPreview 形如 "sk-****mnop"，hasKey:true（明文只进不出）

# ② 在它下面建一个模型
curl -s --noproxy '*' -b /tmp/jar -X POST $BASE/api/models \
  -H 'content-type: application/json' \
  -d '{"providerId":"<①的id>","modelName":"gpt-4o-mini","label":"小钢炮","type":"CHAT","maxContext":128000}' | jq .

# ③ 全员可选列表（MEMBER 会话也能读；用 ADMIN 会话打同一地址，结果必须一模一样）
curl -s --noproxy '*' -b /tmp/member.jar "$BASE/api/models/available?type=CHAT" | jq .
#  → 只含 enabled 且 Provider 也 enabled 的模型；缺 ?type= 会得到 400（type 必填）

# ④ 停用那个模型 → 立刻从 ③ 消失，但管理列表里还看得见（两套投影的差别）
curl -s --noproxy '*' -b /tmp/jar -X PATCH $BASE/api/models/<②的id> \
  -H 'content-type: application/json' -d '{"enabled":false}' | jq .
curl -s --noproxy '*' -b /tmp/jar "$BASE/api/models?limit=100" | jq '.data.items[] | {modelName, enabled}'

# ⑤ 拉取"这个 Provider 上游实际有哪些模型"（P0-1-12）—— 省得手敲 modelName 敲错
#    ⚠️ 这一条会**真的出网**打到 baseUrl；想在本机零成本验，可先建一个指向本地服务的 Provider：
#       # 起一个假上游：node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({object:'list',data:[{id:'demo-model',owned_by:'local',created:1}]}))}).listen(18080)"
#       # 然后 POST /api/model-providers {"name":"本地假上游","baseUrl":"http://127.0.0.1:18080/v1","type":"CHAT"}
#    再打：
curl -s --noproxy '*' -b /tmp/jar "$BASE/api/model-providers/<①的id>/remote-models" | jq .
#  → { providerId, providerName, baseUrl, total, truncated, items:[{id, ownedBy, created}] }
#    只读探测、不落库（库里模型条数一条都不变）；上游 401/超时会得到 502/504 + 可读文案，
#    且**错误消息里不会出现你的 Key**（上游把 Authorization 回显进 body 时也照样被抹掉）。

# ⑥ embedding 双模式自检（P0-1-13）—— 没有 HTTP 端点（入库/检索是 D 包的事），
#    所以这里验的是"配置接对了没有、就绪了没有"：
pnpm config:check | grep -A8 '"embedding"'
#  → 看 mode / dim / batchSize / localRuntimeModule / apiReady
#    维度必须与 chunks.embedding 的 vector(1024) 一致（不一致会打 WARN）
node --input-type=module -e "const m=await import('./backend/dist/backend/src/llm/embedding/index.js');console.log(m.embeddingReadiness())"
#  → { mode:'api'|'local', ready:true|false, dim:1024, name:'api:<模型>'|'local:<目录名>'|null, problems:[…] }
#    ready=false 时 problems 就是"缺什么"的人话清单（同一句话会在 getEmbeddingProvider() 抛出来）
#  → api 模式：填好 EMBEDDING_API_URL/KEY/MODEL 三项即 ready；
#    local 模式：除了模型目录，还要 LOCAL_EMBEDDING_RUNTIME_MODULE（推理运行时，见 docs/02 §八）

# ⑦ 知识库数据层自检（P0-1-14）—— 没有 HTTP 端点（CRUD 是 P0-1-15 的事），
#    所以这里验的是"库结构对不对"：两扩展启用没有、两条特殊索引在不在、migrate 会不会把它们删掉：
psql "$(grep -E '^DATABASE_URL=' infra/.env | cut -d= -f2- | tr -d '"')" -c '\d+ chunks'
#  → 必须看到这两行（缺任一行都是 bug，见 issue_fix/问题记录-P0-1-14-知识库数据模型.md）：
#      "idx_chunks_embedding" hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE kb_id IS NOT NULL
#      "idx_chunks_bigram" gin (content gin_bigm_ops)
pnpm verify:knowledge
#  → 23 项全通过；其中「结构无漂移：migrate diff --exit-code = 0」是关键的一条 ——
#    它证明上面两条手写索引不会被下一次 `migrate dev` 生成 DROP INDEX（P0-1-14 实测踩到过的坑）。

# ⑧ 知识库 CRUD（P0-1-15）—— 第一个**业务资源**接口。先确认 embedding 就绪（建库要快照 provider 名）：
pnpm verify:embedding                     # 只看它有没有 ready=true 的结论行
#  → 若 ready=false，填好 EMBEDDING_API_URL/KEY/MODEL 再往下（否则建库会 500，这是刻意的）

# 用 MEMBER 账号走一遍 —— 知识库是**登录即可**，不是 ADMIN（与模型池相反）：
curl --noproxy '*' -c /tmp/kb.jar -X POST http://127.0.0.1:13000/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"verify-kb-member","password":"…"}'
#  → 首登会 403 要求改密，先走 /api/auth/change-password 再登一次（见上面 ② 的步骤）

curl --noproxy '*' -b /tmp/kb.jar -X POST http://127.0.0.1:13000/api/knowledge-bases \
  -H 'content-type: application/json' -d '{"name":"我的知识库"}'
#  → 201/200，**省略的参数全部快照自 `infra/.env` 的环境默认值**（不是硬编码）：
#      chunkSize / chunkOverlap / retrievalConfig{topK,score,mode,splitStrategy,rrfK,weights}
#      以及 embeddingModel（= 当前 provider 的 name()，如 api:<模型名>）+ embeddingModelChanged

curl --noproxy '*' -b /tmp/kb.jar -X PATCH http://127.0.0.1:13000/api/knowledge-bases/<id> \
  -H 'content-type: application/json' -d '{"retrievalConfig":{"topK":12}}'
#  → 200；**只调 topK 不会把 mode 打回默认值**（局部合并，不是整体覆盖）。
#     试试 `{"description":null}`（清空）与不传 description（保持不动）—— 三态。

curl --noproxy '*' -b /tmp/kb.jar -X DELETE http://127.0.0.1:13000/api/knowledge-bases/<id>
#  → 200 { id, name, deletedDocuments, deletedObjects }；再 GET 该 id 应 404。
#     若这个库被某个 Agent 绑定 → **409 且什么都不删**（`agent_components.ref_id` 是多态引用、没有外键兜底）。

pnpm verify:knowledge-bases
#  → 19 项全通过（需要 PG + Redis + **MinIO**，因为验的是"删库时 S3 原文件真的消失"）。

# ⑨ 文档上传（P0-1-16）—— 四格式进门前的**四道前置校验**。先有库（用 ⑧ 建的那个 <id>）：
curl --noproxy '*' -b /tmp/kb.jar -F 'file=@./员工手册.pdf' \
  http://127.0.0.1:13000/api/knowledge-bases/<id>/documents
#  → 200 { document:{ id, kbId, fileName, status:"PARSING", chunkCount:0, errorMsg:null, … },
#           deduplicated:false }
#     status 是**响应那一刻**的值，恒为 PARSING —— 解析是异步的，交给队列（P0-1-17）。
#     **worker 现在已经就位**：随后端进程启动，几秒内会把记录推成 READY（见下面 ⑩）。
#     但"传完就能检索"仍**不成立** —— 分块/向量化是 P0-1-18/19、检索是 P0-1-20。
#     同一个文件再传一次 → 200 且 deduplicated=true、**document.id 与上次相同**（不新建行，
#     且**不重复入队**）。

# 反例三条：都是 400，但**文案不同** —— 区别在于"用户能不能自己解决"
curl --noproxy '*' -b /tmp/kb.jar -F 'file=@./老合同.doc' \
  http://127.0.0.1:13000/api/knowledge-bases/<id>/documents
#  → 400「暂不支持 .doc（旧版 Word 二进制格式），请另存为 .docx 后重传」
cp ./某张截图.png ./笔记.txt      # 改名：扩展名说 txt、内容还是 PNG
curl --noproxy '*' -b /tmp/kb.jar -F 'file=@./笔记.txt' \
  http://127.0.0.1:13000/api/knowledge-bases/<id>/documents
#  → 400「文件内容与扩展名不符：内容是「图片」，却被命名为 .txt」
#     ⭐ 改名绕过靠**文件头**抓，不靠 MIME —— 改名后浏览器照样声明 text/plain，
#        单靠"扩展名 × MIME"交叉校验这条路是**一路绿灯**的。
curl --noproxy '*' -b /tmp/kb.jar -F 'file=@./大于100MB.pdf' \
  http://127.0.0.1:13000/api/knowledge-bases/<id>/documents
#  → 413（超 `UPLOAD_BODY_LIMIT`，默认 100MB）；漏掉 -F 用 JSON 发 → 406

pnpm verify:documents
#  → 32 项全通过（需要 PG + Redis + **MinIO**）。⚠️ 它自己把 `UPLOAD_BODY_LIMIT` 注成 8KB，
#    否则超限那条只能"假装通过"（造一个 100MB 的文件会把脚本拖死）。

# ⑩ 异步流水线（P0-1-17 起；P0-1-18 补 ④⑤；P0-1-19 补 ⑥⑦）—— 上传之后**谁**把它从 PARSING 推到 READY。
#    worker 跟随后端进程启动（`pnpm dev:backend` / `pnpm start:backend` 都带它），
#    并发默认 2（`PIPELINE_CONCURRENCY`），任务队列是 Redis List（键 `PIPELINE_QUEUE_KEY`，默认 `pipeline:jobs`）。
#    阶段序列现在是六步：load-source → parse → detect-empty-text → chunk → embed → index。
#    ⚠️ **还没有列表端点**（P0-1-21），所以进度现在只能查库看：
psql "$(grep -E '^DATABASE_URL=' infra/.env | cut -d= -f2- | tr -d '"')" \
  -c "select id, file_name, status, chunk_count, error_msg from documents order by created_at desc limit 5"
#  → 刚传完是 PARSING；**几秒内变成 READY**，error_msg 为 null，chunk_count 是**真数**
#     （P0-1-19 起 = chunks 表里这篇的行数 ⇒ **READY 就是"可检索"**；检索端点本身是 P0-1-20）。
#     想看块的内容：`select seq, left(content, 40), (embedding is not null) as has_vec
#     from chunks where doc_id='<id>' order by seq;`
#  → 一直停在 PARSING：worker 没起来，看后端启动日志里有没有 worker 那行；
#    变 FAILED 时 error_msg 就是原因（人话，例：S3 对象不见了 → "原文件读取失败…"）。
#
#    ⚠️ 现在有三类失败原因会在 error_msg 里出现（都能在库里直接看到）：
#      · 扫描件 / 空白文档 —— 解析出的有效字符 < `EMPTY_TEXT_THRESHOLD`（默认 50）⇒
#        含「疑似扫描件」（**注意：太短的正常文档也会命中这条门槛**，比如一张只有标题的 txt）。
#      · 文件内容与扩展名不符（改过名、对象被替换）⇒ 含「文件内容与扩展名不符」。
#      · **向量化失败** ⇒ 含「文本向量化失败（已重试 2 次）」。⚠️ P0-1-19 起流水线会真的调
#        embedding，而本机 `infra/.env` 的 `EMBEDDING_*` 三项是空的 ⇒ **手动端测前必须先配好**
#        （`EMBEDDING_MODE=api` 填 URL/KEY/MODEL，或走 local 并配好运行时模块），
#        否则每篇文档都会卡在 ⑥ 变成 FAILED —— 这不是 bug，是"没接上 embedding"。

# ⚠️ 手动重试 / 覆盖重建 / 删除现在**都有 HTTP 入口**了（P0-1-19）；
#    界面上的按钮（列表页的"重建/重试/删除"）才是 P0-1-21 的事。
#    ⑪ 覆盖重建 / 重试 / 删除文档（P0-1-19）—— 三条端点的 curl 与预期
curl -sS --noproxy '*' -b "$COOKIE" -X POST \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC/retry"
#  → 200 {document:{... status:"PARSING", errorMsg:null}}；⚠️ 已是 READY 时回 **409**「无需重试」
#    （没有东西可重试；回 200 会让界面以为在重新处理）

curl -sS --noproxy '*' -b "$COOKIE" -F "file=@./报销制度-v2.txt" \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC/reupload"
#  → 200 {document:{id 不变, status:"PARSING", chunkCount:0}, unchanged:false}
#    ✅ 文档 id 不变（不新建行）；旧 chunk 立刻清掉（检索空窗是 §七 的刻意取舍）
#  → 再传**一模一样**的内容 → 200 且 **unchanged:true**（「内容未变化，已跳过」）：
#    不落新对象、不删旧 chunk、不入队 —— 三个"没做"

curl -sS --noproxy '*' -b "$COOKIE" -X DELETE \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC"
#  → 200 {id, fileName, deletedChunks:N}；DB 行 + 其 chunk（级联）+ S3 原文件都清掉
#  → 再删一次 → 404（不是 500，也不是静默成功）

# ⑫ 双路检索 / RRF 融合（P0-1-20）—— D 包这条链路的终点：上传 → READY → **检索得到**
#    前置：库里有 `READY` 的文档（⑨⑩ 做完），且 `EMBEDDING_*` 已配好（检索要算 query 向量）
curl -sS --noproxy '*' -b "$COOKIE" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:13000/api/knowledge-bases/$KB/search" \
  -d '{"query":"出差住宿标准"}' | jq .
#  → 200 {code:0, msg:"ok", data:{items:[{…六列分数…, rrfScore, finalRank}], mode:"HYBRID", topK, rrfK,
#          candidatePool, elapsedMs, vectorPathSkipped:false, warnings:[]}}
#    · items 里每一条都带：vectorScore/vectorRank、fulltextScore/fulltextRank（**没命中的那一路是 null**）、
#      rrfScore（= RRF 融合分）、finalRank；`snippet` 是命中位置前后各 80 字符的**原文**（可直接核对）
#    · 同一句话加上 `"mode":"FULLTEXT"` / `"mode":"VECTOR"` 可以分别只跑单路（试查页就靠它）
#    · 加 `"topK":1` 只返回一条；**这两个覆盖项不会写进库配置**（库的检索口径不受影响）

curl -sS --noproxy '*' -b "$COOKIE" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:13000/api/knowledge-bases/$KB/search" \
  -d '{"query":"请问出差住宿标准是多少？","mode":"FULLTEXT"}' | jq '.data.items[0].fulltextRank,.data.items[0].snippet'
#  → 全文路 1 与原文片段：证明①**标点与"请问/是多少"这类脚手架被剥掉了**（否则字面匹配必空）、
#    ② pg_bigm 中文 bigram 真的生效（⚠️ 若这里恒为空，先看 `pnpm verify:knowledge` 的索引断言）
#    ⚠️ 全文路是**字面子串**匹配 ⇒ 只适合短查询。一句长问句（哪怕截断到 64 字符）几乎不可能连续
#       出现在正文里，那是**预期行为**不是 bug；长问句请用 HYBRID/VECTOR。

pnpm verify:retrieval
#  → 27 项全通过（需要 PG + Redis + MinIO；脚本自己起"词面重叠型"的假 embedding 上游）。
#    它额外钉死两件事：**两条路的名次/分数与独立 SQL 逐条相等**（证明分数不是编出来的）、
#    **RRF 的数值可以用返回的两路名次反算出来**（证明融合就是那个公式）。

# ⑬ 文档列表 / 下载原始文件（P0-1-21）—— 流水线进度的可视出口 + 取回原件核对
curl -sS --noproxy '*' -b "$COOKIE" \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents?limit=20" \
  | jq '.data | {total, items: [.items[] | {fileName, status, chunkCount}]}'
#  → {total, items:[{fileName,status,chunkCount},…]}：每篇的状态一眼可见
#    · `PARSING` 必须显示「更新中，暂不参与检索」（shared 的 `DOCUMENT_PARSING_HINT`）——
#      `§七` 的"先删后建"有一段检索空窗，这期间搜不到它**不是 bug**；
#    · **最新上传的在第一条**（排序 `createdAt desc`，与 `/api/users` 等相反，理由见 `docs/02` §4.6）；
#    · 库不存在 → 404（不是空列表）；`limit` 上限 100。

curl -sS --noproxy '*' -b "$COOKIE" -D /tmp/dl-headers -o /tmp/orig.txt \
  "http://127.0.0.1:13000/api/knowledge-bases/$KB/documents/$DOC/download"
grep -iE 'content-type|content-length|content-disposition' /tmp/dl-headers
#  → content-type: text/plain; charset=utf-8（按扩展名唯一确定，文本类型带 charset）
#    content-disposition: attachment; filename="…"; filename*=UTF-8''%E6%8A%A5%E9%94%80…（中文名靠后一段）
#    ✅ 取回来的字节与上传的**逐字节相等**（`cmp -s /tmp/orig.txt <你上传的文件>`）
#  → 行还在但对象丢了（存储被清）→ 404「原始文件已不在存储中…请重新上传」（**不是** 500、也不动数据库）
#  ⚠️ 这是本仓唯一**不返回 JSON 信封**的端点：成功时是字节流，失败时才是信封 —— 客户端要按状态码分支。

# ⑭ 智能体 CRUD（P0-1-22）—— 包 E 起步：列表 / 建 / 详情 / 改 / 软删 + 权限
#    前置：需要一个**可用的对话模型**（启用了的 `type=CHAT` 模型，用 ①② 建的那个或库里已有的）；
#    本机 `.env` 没配 embedding 也不影响这一组（智能体不碰流水线）。
MODEL=$(curl -sS --noproxy '*' -b "$COOKIE" \
  "http://127.0.0.1:13000/api/models/available?type=CHAT" | jq -r '.data[0].id')

# ⑭-a 建一个 ChatBot（字段全覆盖：图标 / 系统提示词 / 开场白 / 引导问题）
curl -sS --noproxy '*' -b "$COOKIE" -X POST http://127.0.0.1:13000/api/agents \
  -H 'content-type: application/json' -d "{
    \"name\":\"报销小助手\",\"type\":\"CHATBOT\",\"modelId\":\"$MODEL\",
    \"description\":\"回答报销制度问题\",\"icon\":\"🧾\",
    \"systemPrompt\":\"你是报销制度助手，只依据知识库回答。\",
    \"openingRemarks\":\"你好，问我报销的事吧。\",
    \"guideQuestions\":[\"差旅费怎么报？\",\"发票丢了怎么办？\"] }" \
  | jq '.data | {id, name, type, modelLabel, modelAvailable, canEdit, guideQuestions}'
#  → canEdit:true（自己建的）、modelAvailable:true、guideQuestions 是**数组**（列默认 []）

# ⑭-b 列表：**对全员开放**，每项带 canEdit（自己真 / 他人假 / ADMIN 真）
curl -sS --noproxy '*' -b "$COOKIE" 'http://127.0.0.1:13000/api/agents?limit=20' \
  | jq '.data | {total, items: [.items[] | {name, type, canEdit}]}'
#  → 刚建的排**第一条**（排序 `updatedAt desc`；与 `/api/users` 等的 asc 相反，理由见 `docs/02` §4.4）

# ⑭-c 绑定一个**停用的**模型 → 409（四种失败各有可执行的文案，见 `docs/02` §4.4「契约增量 · Agent」④）
#      · 不存在 → 404 ｜ 是 EMBEDDING 模型 → 409 ｜ 模型停用 → 409 ｜ 所属 Provider 停用 → 409

# ⑭-d 三态：只改名字（不带 description）→ description **原样不动**；显式传 null → 清空
curl -sS --noproxy '*' -b "$COOKIE" -X PATCH http://127.0.0.1:13000/api/agents/<agent-id> \
  -H 'content-type: application/json' -d '{"name":"报销助手 v2"}' | jq '.data | {name, description}'
#  → description 还是"回答报销制度问题"（**不是**被清空）—— `.nullable().optional()` 且**没加** `.default()`

# ⑭-e 改 type → 409「智能体类型创建后不可修改」（可传但不可改；传同值 200，幂等）
# ⑭-f 删除（**软删**）：返回两个连带数字；随后详情/编辑/再删一律 404（**不是** 403）
curl -sS --noproxy '*' -b "$COOKIE" -X DELETE http://127.0.0.1:13000/api/agents/<agent-id> \
  | jq '.data'   # → {id, name, removedComponents, finishedConversations}
#  → 会话没被删（只转 FINISHED「只读保留」）、组件绑定已解除（否则**绑过的知识库会永远删不掉**）

# ⑭-g 权限守门（用 MEMBER 会话）：改**别人**的智能体 → 403；改**自己**的 → 200
curl -sS --noproxy '*' -b /tmp/member.jar -X PATCH \
  http://127.0.0.1:13000/api/agents/<别人的 agent-id> \
  -H 'content-type: application/json' -d '{"name":"偷改"}' | jq .msg
#  → 「只有该智能体的创建者或管理员可以修改它」；用 admin 的会话改**同一个** id 必须 200
#    （只验"普通用户 403"的话，一个"仅创建者"的实现会全绿 —— 所以两个方向都要亲手试一次）

pnpm verify:kb-package
#  → 11 项全通过（包 D 收口）：一行一组逐行跑 `子方案①` §十二 的 8 行，每行打印结论。

pnpm verify:pipeline
#  → 29 项全通过（需要 PG + Redis + MinIO）。它用**随机队列键**（`verify:pipeline:jobs:<rand>`）
#    跑，不碰你开发队列里的任务，收尾会删掉该键并断言残留为零。
#    ⚠️ 它和 ⑪ ⑫ 都会自己起一个**假 embedding 上游**（本机 .env 的三项是空的也能跑）。

pnpm verify:ingest
#  → 23 项全通过（同样需要 PG + Redis + MinIO）。这一档专验"入库之后的形态"：
#    chunk 真的落库且都有向量、id 版本位是 7、覆盖重建换内容不换 id、重试能救回 FAILED、删除三清。
```

**已知边界（别当 bug）**：① 接口只有五组：`/api/auth/*`、`/api/users`（仅 ADMIN）、模型池
（`/api/model-providers`、`/api/models` 仅 ADMIN + `/api/models/available` 全员 + P0-1-12 新增的
`GET /api/model-providers/:id/remote-models` 仅 ADMIN）、**知识库 `/api/knowledge-bases`（P0-1-15，
登录即可，不是 ADMIN；P0-1-16 加了它下面的 `POST .../documents` 上传、P0-1-19 加了
`reupload`/`retry`/`DELETE`、P0-1-20 加了 `POST .../search`）**、**智能体 `/api/agents`（P0-1-22，
登录即可"建与看"，编/删收窄到创建者 + ADMIN）**。
**"MEMBER 能用的业务接口"现在有三处**：`/api/models/available`、整个 `/api/knowledge-bases/*`、
以及 `/api/agents` 的列表/详情/创建 —— 三者**权限口径刻意各不相同**（模型池全程 ADMIN；
知识库**没有 owner 列**故登录即可读写；智能体有 `created_by` 列故编删按行判定）。
照抄邻居必错，本仓已因此踩过两次"顺手加 `requireAdmin`"。
② 浏览器里的登录页/强制改密跳转是 **P0-1-30** 的事，本里程碑只到命令行；
**文档上传专项边界（P0-1-16）**：本批能验的是"进门校验"与"解析器本身"（`pnpm verify:documents`
的 A/C/D 组真跑四个夹具文件）；`.doc` 是刻意拒收（提示另存为 `.docx`），不是没做完；
**异步流水线专项边界（P0-1-17 起；P0-1-18 补 ④⑤、P0-1-19 补 ⑥⑦）**：八步齐全后 `READY` 的语义
才是**"可检索"**（`chunks` 表有这篇的行、每行都有向量、`chunk_count` 与之一致）；
**检索（P0-1-20）与列表/下载（P0-1-21）都已落地** ⇒ 建了哪些文档、每篇什么状态、内容对不对，
用 ⑫⑬ 的 curl 就能全程看清，不必再查库（`psql` 仍是排查时的旁证）；
**列表/下载专项边界（P0-1-21）**：排序是 `createdAt desc`（**最新在前**，与 `/api/users` 等相反）；
**库不存在回 404 而不是空列表**（"库没了"与"库里没文档"是两件事）；
**下载成功时不是 JSON**（是字节流，失败才是信封），`Content-Type` 按扩展名唯一确定、
`Content-Disposition` 用 RFC 5986/5987 双写（中文名靠 `filename*`）；
**"行还在但对象丢了"是 404 + 另一句文案**且不动数据库 —— 遇到它请重新上传该文档；
**智能体专项边界（P0-1-22）**：
· **组件绑定目前只有"读"**：详情/列表会回显 `components`（`{componentType, refId}`，**刻意不带目标名**
—— `mcp_servers` 表要到 P0-2 才建），而**写侧**（`PUT /api/agents/:id/components` 整体替换）是
**P0-1-23**，现在打它会 404（不是坏了）；`POST /api/agents/:id/copy` 是 **P1**，同样 404；
· **删除是软删**：`DELETE` 之后**详情/编辑/再删一律 404**（不是 403、也不是"还能改回来"）——
留一个"看起来还能改"的页面等于诱导用户去改一条作废记录。会话**不删**、只转 `FINISHED` 只读保留；
· **软删的智能体仍占模型的引用计数**（`ModelItem.agentCount` 刻意不按 `deletedAt` 过滤）⇒
"删了智能体为什么模型还删不掉"是**预期行为**（它要的是 `ON DELETE RESTRICT`）；
· **改类型不行**：`type` 可传但不可改（不同值 409、**传同值 200**，因为前端是整表单提交）；
· **绑定的模型事后被停用不影响改名**：只有**换绑**才重新校验可用性 —— 否则连改名字都会撞 409，
会表现成"这个智能体改不动了"。此时列表/详情靠 **`modelAvailable: false`** 提示；
· **名称不查重**（`agents` 上没有 `name` 唯一约束）：同名的两个智能体靠 id 区分，这是刻意的 ——
需要唯一性时应当**先加约束再改代码**，而不是在服务层造一条"看起来唯一、并发下不唯一"的规则；
**检索专项边界（P0-1-20）**：
· **全文路只适合短查询** —— 它是 `content LIKE '%词%'` 的**字面子串**匹配，自然语言长问句（哪怕截断到
64 字符）几乎不可能连续出现在正文里，`mode=FULLTEXT` 因此可能返回空。**这是预期行为**（长问句请用
`HYBRID`/`VECTOR`），不是索引坏了 —— 索引本身由 `pnpm verify:knowledge` 的 EXPLAIN 断言守着；
· **手工跑 ⑫ 需要配好 `EMBEDDING_*`**（要算 query 向量）：本机 `.env` 三项为空时 `HYBRID` 会
**降级为纯全文检索并给 warning**（不报 500），`mode=VECTOR` 则明确报 500；想看完整三模式，
直接跑 `pnpm verify:retrieval`（脚本自起假上游，零配置）；
· **库里没有向量就搜不到**（空库 / 全失败 / 正在 `PARSING`）⇒ `items: []` 是"真的没有"，不报错；
· **换了 embedding 模型**（库快照的 `embedding_model` ≠ 当前 provider）时：`HYBRID` 跳过向量路并告警、
`VECTOR` 回 **409**（"请等待重建完成"）—— 这是 `子方案①` §八 的降级路径，P0 只到"探测 + 告警"，
真正的重新向量化（`chunks_v2` 换表）是 P1；
· 返回的 `snippet` **不加工、不加省略号**（省略号由前端按需加）—— 这样它一定是原文的子串，可逐字核对；
· `rrfScore` 的数值只有配上同时返回的 `rrfK` 才可比（不同库的 `rrfK` 可以不同）；
worker 是**进程内**的（`PIPELINE_CONCURRENCY=2`，不是独立进程）—— 所以 worker 崩了后端一起崩，
"失败可重试"就是为 List 队列**没有 ack**（worker 崩在中途任务就丢了）兜底的；
**⚠️ 手动端测前必须先配好 embedding**（P0-1-19 起流水线真的会调它，而本机 `infra/.env` 的三项是空的）——
不配的话每篇文档都会在 ⑥ 变成 `FAILED`（`error_msg` 是「文本向量化失败（已重试 2 次）…」）；
**内容门槛（P0-1-18 起）**：有效字符 < `EMPTY_TEXT_THRESHOLD`（默认 50）的文档会直接判 `FAILED`
（「疑似扫描件或空白文档」）—— 扫描件终于不再"假装 READY"，但**太短的正常文档也会被拦**
（一张只有标题的 txt、一个 20 字的 docx）；这是刻意的一致性取舍（"内容太少没法检索"），
要改就调那个环境变量，别改代码；
**覆盖重建的"检索空窗"是刻意的**（`子方案①` §七）：重建时旧 chunk **立即**清掉、新内容重建完才回来，
窗口 = 一次流水线耗时 —— 期间该文档搜不到，**不报错**。所以列表页必须把 `PARSING` 显式显示成
「更新中，暂不参与检索」（这条已写进 P0-1-21 的坑预判，是**必做**项而非常规提示）；
**分块与检索参数改了不会自动重建**：`chunkSize`/`chunkOverlap`/`retrievalConfig` 只对**之后**处理
的文档生效（`子方案①` §十一 的刻意取舍），已入库的文档要手动触发重建；
**`retry` 对 `READY` 回 409**（没有东西可重试），它**不是**"重新跑一遍"的入口 —— 想换内容请用覆盖重建；
③ **LLM client 目前没有对外调用入口**（`chat()` / `chatStream()` 是给 F 包编排用的），
所以"模型通不通"这一层现在还只能用 `remote-models` 探一下（P1 的 `POST /api/models/:id/test` 未做）；
④ **embedding 同样没有对外端点**（入库/检索是 D 包的事），上面 ⑥ 的两条自检能告诉你"配置齐不齐、
就绪没就绪"；**local 模式的推理还跑不了**（`LOCAL_EMBEDDING_RUNTIME_MODULE` 为空 =
`docs/06` §七 待决事项 2 未关闭），要试就先走 `EMBEDDING_MODE=api`；
⑤ **端测完请复位**（走查会把 admin 的密码改掉、也会往模型池留下你建的 Provider，删掉即可）：
`SEED_RESET_PASSWORD=1 pnpm db:seed` 把两个种子账号打回首登态并恢复成你指定的密码。

> 想一条命令跑完上面全部 + 六条门槛的自动版：`pnpm verify:e2e`（它自己起进程、自己造号、跑完删净）；
> LLM client 那部分（含假上游）的自动版：`pnpm verify:llm`；
> embedding 双模式（含 stub 推理运行时，**不需要起 docker**）：`pnpm verify:embedding`；
> 知识库数据层（只连 PG，**不需要 Redis**）：`pnpm verify:knowledge`；
> 知识库 CRUD（含"删库时 S3 原文件真的消失"，所以要 MinIO）：`pnpm verify:knowledge-bases`；
> 文档上传（四道前置校验 + 四格式解析 + 按库判重 + 删库双清，同样要 MinIO）：`pnpm verify:documents`；
> 异步流水线（队列语义 + 状态机 + 幂等四道 + 并发闸门 + 失败重试 + 入队原子性 + 扫描件与分块，同样要 MinIO）：
> `pnpm verify:pipeline`；**入库之后**的形态（chunk 落库/向量/id 版本位/覆盖重建/内容未变化/重试/删除）：
> `pnpm verify:ingest`；**检索**（三模式 + 六列分数 + 与独立 SQL 等价 + RRF 反算 + 引用片段 + 降级路径）：
> `pnpm verify:retrieval`；分块策略、三条新端点与**检索的纯函数规则**都在 `pnpm verify:app` 里
> （不需要任何依赖，可进 CI）。

> 进程支持 SIGINT/SIGTERM 优雅退出：**先停 worker**（等手上的任务收尾，最多 5s）→ 停止接流 →
> 关闭 PG/Redis 连接 → flush 日志 → 退出（10s 兜底强退）。

---

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
| `docs/06-实施计划.md` | **施工图**：把 P0-1 的 7 个包拆为 36 个可独立开工/验证/回滚的步骤，每步含内容·产出文件路径·前置依赖·验收门槛·坑预判；含 P0-2/P0-3 骨架、开工前置核对、仓库形态、施工纪律。**每批完成后回写状态列** |

### 子方案（复杂点拆分）

| 文档 | 内容 | 状态 |
|------|------|------|
| `docs/子方案/知识库流水线.md` | 解析（PDF/docx/MD/TXT）/分块/向量+中文全文（pg_bigm）双路检索（RRF）/覆盖重建/异步队列 | ✅ 已完成（2026-09-20，吸收 B1/B3/B8/B9/B11 + A2） |
| `docs/子方案/沙箱与引擎集成.md` | 容器生命周期（会话即容器）/ACP 事件映射/产物收集 | ⏳ 待写（需在 P0-2 期间完成） |
| `docs/子方案/文件预览.md` | MD/HTML/图片/CSV/PDF 五格式预览 + 安全处理 | ⏳ 待写（需在 P0-2 期间完成） |

### 缺陷与踩坑归档

| 文件 | 内容 |
|------|------|
| `issue_fix/问题记录-P0-1-1-环境与链接.md` | pnpm 不读 `.npmrc`、构建白名单键名、**目录符号链接静默失败**、`clean` 自递归、tsc 产物污染源码 |
| `issue_fix/问题记录-P0-1-2-基础设施与镜像.md` | **pg_bigm 无二进制包**、tag 日期后缀、Docker 加速器 403、**PS 5.1 的 `{{}}` 与 `.ps1` 编码坑**、`psql` 多语句/临时表坑 |
| `issue_fix/问题记录-P0-1-3-配置与日志.md` | **zod `.default()` 被 `.env` 空串绕过**、`loadEnvFile` 不覆盖已有变量、pino transport 与生产装包、产物期模块路径更深、pino 保活进程 |
| `issue_fix/问题记录-P0-1-4-Fastify骨架与健康检查.md` | **错误处理自身崩溃把真实错误掩成 500**、Fastify v5 的 `loggerInstance` 类型参数化与 `logController` 换废弃选项、框架错误状态码被压成 400、Fastify 校验短路语义、ioredis 只报「重试上限」不报 `ECONNREFUSED`、`pnpm --filter` 吞掉脚本参数 |
| `issue_fix/问题记录-P0-1-5-数据模型与Prisma基线.md` | **Prisma 7 的接入形态完全变了**（`prisma-client` generator + `output` 必填 + `prisma.config.ts` + 驱动适配器）、`allowBuilds` 要一次登记两个包、Prisma CLI 不该继承应用侧全量配置、**反向探针**证伪"分区表会被 `migrate dev` 重建"、`migrate diff` 的 `--exit-code` 用法、查询日志按 `trace` 门控且必须丢掉 `params` |
| `issue_fix/问题记录-P0-1-6-密码与会话基础设施.md` | **bcrypt 对非法摘要 compare 立刻返回 false（等时比较会失效）**、bcrypt 静默截断 72 字节、原生 bcrypt 的 `allowBuilds`（但自带 prebuilds 不需编译器）、`@fastify/cookie` 是 `export =` 形态取不到类型名、会话令牌不需要签名、`decorateRequest` 必须直接调用、Cookie 属性不一致导致登出失效、"鉴权失败自毁会话"与"缓存窗口"的取舍 |
| `issue_fix/问题记录-P0-1-7-认证接口.md` | **「不泄露账号是否存在」必须看耗时**（光对齐文案不够）、停用账号的报错时机（密码错 vs 密码对）、限速的三个顺序细节（判定在前 / 锁不续期 / 成功即清）、首登闸门挂根级 `preHandler` 且不依附 `requireAuth`、改密后必须主动失效快照缓存、**Prisma 函数型默认值不在 DB 层**（手工 INSERT 要给 id 与 updated_at）、verify 脚本要先构建 `shared` |
| `issue_fix/问题记录-P0-1-8-用户管理接口.md` | **「响应体不含密码」的检查要分两层**（值/哈希 vs 键名，混在一起会让正确实现被判失败）、**重置密码必须清登录失败计数**、Prisma 唯一冲突要"先查 + catch"且用错误码而不是 `instanceof`、分页的稳定排序与 `total` 同快照、**「不能操作自己」放服务层**及其边界（含重置自己）、首登闸门会拦住首登态的 admin 调 `/api/users`、建号返回 200 而非 201 |
| `issue_fix/问题记录-macOS环境适配.md` | 启停脚本补 `.sh` + 跨平台入口、**宿主端口被另一项目占用→改 `.env` 避让**、**bash 3.2 把中文并进变量名**、corepack 取 pnpm |
| `issue_fix/问题记录-P0-1-11-模型管理.md` | **`06` 的坑预判只对了一半**（同路径两个 GET 是**注册期** `FST_ERR_DUPLICATED_ROUTE`，而静态段优先根本不是问题 → 真正的约束是"必须拆路径"）、**两套投影要按"用途"而不是按"角色"分**（按角色会让 ADMIN 的模型下拉看到停用模型，违反自家验收门槛）、zod v3 的 **`required_error` 与 `errorMap` 互斥且在模块加载期抛错**（typecheck 查不出来）、`available` 的 `type` 必填（否则 CHAT 模型会静默流进向量库）、**Provider 停用 ⇒ 其模型也不可选**（只筛 `models.enabled` 会给出"能建 Agent 一发消息就失败"的模型）、`providerId` 放进 PATCH 契约是为了把静默 no-op 变成显式 409、`model_name` 拒内部空白（上游 model id 不含空格）、`@@unique` 含 `type` ⇒ 同名不同 type 必须放行、清理段用 `deleteMany` 而不是 `delete`（空删会往日志丢 P2025 把断言冲掉） |
| `issue_fix/问题记录-P0-1-10-模型池Provider管理.md` | **AAD 绑定到 `id` 会让加密依赖 `id`** → 建 Provider 必须用事务（先落行拿 id 再加密），否则失败重试会留下"建好了但没 Key"的行、而且调用方还会再建一个；**解密失败不能掀桌**（预览降级 `****`，否则主密钥一换列表整页 500，连"哪个 Key 坏了"都看不到）；三态的实现落点（`.nullable().optional()` **不加 default**）；**最强验收是"密文逐字不变"**（能抓出"每次 PATCH 都重写 Key"）；`ON DELETE RESTRICT` 让"删 Provider"必须前置检查、且**软删的 Agent 仍占外键**；`baseUrl` 去尾斜杠 + 只允许 http(s)（SSRF 面）；改 type 与硬删的取舍；`maskApiKey` 的断言别拿"字符集不相交"去写（分隔符会误报） |
| `issue_fix/问题记录-P0-1-9-认证与用户验收.md` | **种子脚本的「幂等」是安全属性**（默认绝不覆盖密码，否则改过密码的人下次 seed 后登录不上）、种子脚本的 console 是交付通道而非日志（需 ESLint 例外）、`prisma/seed.ts` 会被编译进 dist 的两面性、**「端到端」的关键是换掉传输层**（spawn 真实进程 + 真实 HTTP）、子进程端口先探再用、`UID` 是 shell 只读变量、`fetch` 要多条 `Set-Cookie` 必须用 `getSetCookie()`、**「跑完干净」要写成断言**、门槛 3 的「业务 API」本仓还没有（用 403 文案区分闸门 vs 权限）、手工走查会留下不可用状态（收尾必须 seed 复位） |
| `issue_fix/问题记录-P0-1-12-LLM-client封装.md` | **两个实现 bug 都是跑验收才抓出来的**：① "到响应头"与"流内空闲"各建一个 `AbortController` ⇒ 空闲超时**根本没接到 `fetch` 上**（计时器照常触发、读流纹丝不动，脚本挂死被 SIGTERM）；② 中断只靠"abort 让读流失败" ⇒ 响应已在同一个 TCP 包里缓冲好时**点了停止回答还在往外冒**（必须在每帧之前显式查信号）。另有：`stream_options` 默认不能发（400 的常见来源）、末帧可能没有结尾空行（残留缓冲也要当一帧）、SSE 帧会被 TCP 切碎、`200` 里藏 `{error}`、`rawFinishReason` 不在传输层归一化、**上游 401 的 body 会回显 `Authorization` ⇒ 任何进日志/错误消息的片段都要先脱敏**、把"真实 provider"换成**本地真 HTTP 假上游**（验收不依赖外部厂商）、拉模型列表的两种"不"（不要求启用、不要求配 Key）与上游 404 的可执行文案 |
| `issue_fix/问题记录-P0-1-13-embedding双模式.md` | **两个实现问题也都是跑验收才抓出来的**：① worker 无脑继承 `process.execArgv` ⇒ 父进程若是 `node --input-type=module -e …` 起的（验收脚本的子进程就是），worker 一启动就崩（`.ts` 入口才该继承，`.js` 传 `[]`）；② 用 `spawnSync` 起子进程验"工厂接线" ⇒ 把父进程事件循环钉住，跑在父进程里的假上游无法应答，症状是"地址配对了却报 30s 超时"（改异步 `spawn`）。另有：**先抽 `llm/upstream.ts` 再写第二个上游调用点**（否则 P0-1-12 的两个坑要养两份，且 `verify:llm` 22 项证明了抽取未改行为）、`worker_threads` 隔离要用**线程内回报的 `threadId`** 取证、local 的推理运行时（含分词）**走注入**而不是写死 `onnxruntime-node`（交付物形态未定；且本批因此零新增依赖）、`dim()` 恒返回配置维度而实际维度逐条校验、**批串行**（不裸 `Promise.all`）、`index` 归位与"必须是 `0..n-1` 的排列"、`input: []` 不发请求、就绪判定两级（config 只 WARN / 取用时硬报错） |
| `issue_fix/问题记录-P0-1-14-知识库数据模型.md` | **本批最大的坑不在 `06` 的坑预判里**：**手写 DDL 会被 Prisma 判成"多余对象"并生成 `DROP INDEX`** ⇒ 下一批动 schema 时两条检索索引被静默删除、检索退化成全表扫描（P0-2 加表时必炸）。⚠️ **P0-1-5 的"Prisma 会跳过分区表"结论不能外推** —— 分区子表它跳过，**认不出的索引它照删**，两类对象机制不同。两处置法：**GIN 在 schema 里声明**（`type: Gin` + `ops: raw("gin_bigm_ops")` + `map`，三个参数都不可省）；**HNSW 藏进"部分索引"**（Prisma 7 无 `Hnsw` 类型、无 `WITH (m,ef_construction)` 位置；实测**普通 btree 与表达式索引都会被 DROP，唯独带 `WHERE` 的部分索引它一条 diff 都不出**），恒真谓词 `WHERE kb_id IS NOT NULL` ⇒ 内容等价全量 HNSW 且被 `kb_id = $2` / `= ANY(...)` 蕴含。失效是**静默的** ⇒ 三条守门断言（`migrate diff --exit-code`=0 / `indpred` 未变 / 两条路 `EXPLAIN` 命中）。**`06` 点名的 GIN 坑预判经实测部分不成立**：`USING gin (content)` **不是静默建错算子类，而是直接报错** `data type text has no default operator class for access method "gin"`（实测 `text` 装 pg_bigm 后仍无默认 GIN 算子类，`gin_bigm_ops` 的 `opcdefault=false`）⇒ 真风险是"报错文案不点破该写哪个算子类，易误读成 pg_bigm 没编进镜像"。另有：`Unsupported("vector(1024)")?` 的**可空是硬要求**（不可空则 Prisma `create` 建不了行）、主键统一 `uuid(7)` **改掉 `子方案①` §4-4 的 `bigserial`**（判据是 `agent_components.ref_id` 要指得过来；代价是 P0-1-19 手写 INSERT 得自带 id 数组）、`embedding_model` 定 NOT NULL 及其副作用、`retrieval_config` 的 **DB 默认值写完整形状**、`documents` **刻意不加** `UNIQUE(kb_id, content_hash)`（会把"已跳过"的业务语义变成 409）、**`EXPLAIN` 验索引用法要关掉更便宜的退路**（小表上 PG 选 kb_id 索引+排序是**理性**的；「现身」证明可用、「没现身」不构成反证） |
| `issue_fix/问题记录-P0-1-15-知识库CRUD+检索配置.md` | **本批唯一的真 bug 是纯函数的参数方向写反**：`normalizeRetrievalConfig(raw, patch)` 内部把 `patch` 当成了"兜底"、`raw` 当成了"真相" ⇒ **`raw` 赢**，与调用方意图（建库时请求体叠在环境默认值上、改库时叠在当前值上）相反，**建库与改库两处都静默丢弃用户输入**；`lint`/`typecheck`/`build` **全绿**（类型完全正确），只有"把返回值逐字段比对"的纯函数断言抓得到 —— 教训是**方向敏感的纯函数必须两个方向各来一条断言**（谁赢 + 只有一边有的键谁留）。另有：**权限口径与模型池相反，知识库是「登录即可」不是 ADMIN**（依据 `03` §25 权限列 + `knowledge_bases` 无 owner 列；守门断言特意用 **MEMBER** 账号跑"建/改/删"三连，"ADMIN 能建"在加了 `requireAdmin` 后**依然通过**，验不出问题）、**字段级错误断言查错了地方**（顶层 `msg` 恒为「请求参数校验失败」，详情在 `data.fields[].message`，且 `.refine()` 的文案 path 为空串；本批连踩两次）、**`description` 三态**（`.nullable().optional()` 不加 default）、**跨字段守卫按生效值算**（只改一半时另一半拿库里的现值比）、**`agent_components.ref_id` 是多态引用、没有 DB 外键** ⇒ 删库必须自己查绑定并 409（"先删了才发现要拦"是常见写法错误）、**`removeObjects` 在 `Quiet: true` 下只返回失败列表**（删除数 = 总数 − 失败数）、**S3 清理失败只 warn 不抛**（DB 行已删，抛错会让用户以为没删成功）、**embedding 未就绪时写 500 不留半成品 / 读降级为 `embeddingModelChanged=null`**（读接口不该因环境缺配置整体不可用）、**"建库快照环境默认值"要靠注入特征值证明**（写死 5/0.3/60 的实现在那条上必红）、DB 默认值与 shared 规范默认值是**两处手写**⇒验收要有跨包一致性断言 |
| `issue_fix/问题记录-P0-1-16-文档上传+四格式解析+前置校验.md` | **本批两个真问题都不在坑预判里**：① **`.gitignore` 的编译残留防护把手写的类型声明一起吞了**（`**/src/**/*.d.ts` 本是 P0-1-1 为防「tsc 把产物写回源码目录」加的，而 `mammoth` 需要一份**手写**的 `backend/src/types/mammoth.d.ts` ⇒ 本机全绿、**只有 CI / 新克隆才报 `TS7016`**，是反馈最晚的一类失败）⇒ 按既有 `!**/src/**/*.d.mts` 惯例加 `!backend/src/types/**/*.d.ts`；**可复用检查**：新增任何非 `.ts` 源文件后 `git status` 必须看得见它（`git check-ignore -v <path>`）；② **`crypto.randomUUID({ version: 7 })` 在 Node 22.22 上静默返回 v4**（不抛错、形态合法，只是版本位是 4；`@types/node@22.20.4` 的 `RandomUUIDOptions` 恰好没有 `version` 字段 ⇒ 类型强转**替运行时说了谎**）⇒ 处置是**彻底不手搓 uuid7**：`documents.create` 不带 `id`、S3 键中段用普通 `randomUUID()`（v4，与 docId 无关）。**「改名绕过」只能靠文件头魔数拦**：MIME 是**客户端声明**，`a.txt` 改名成 `a.pdf` 后浏览器照样声明 `application/pdf`，"扩展名 × MIME"交叉校验**一路绿灯**（文档只要求到这一道）；两个易漏子分支 —— **任意 zip 改名成 `.docx` 能过 ZIP 签名**（须再确认包内含 `[Content_Types].xml`）、**BMP 只认 `BM` 会把 "BMW …" 判成图片**（补验第 6~9 保留位恒 0）；`application/octet-stream` 一律**放行**（"不知道"不是"矛盾声明"，否则 `curl -F` 这条基本路径被堵死）。**坑预判订正**：TXT 嗅探必须做但**不需要 iconv**（Node ICU 自带 `gbk`），真正的前提是严格 UTF-8 必须带 **`fatal: true`**（不带它 GBK 被**静默**解成 U+FFFD，"嗅探"永远嗅不出东西）。另有：`mammoth` **无类型也无 `@types`** ⇒ 手写 `d.ts`，且用 `convertToHtml` 而非 `extractRawText`（后者丢 `headingPath`，那是 P0-1-18 的输入）；`unpdf` **没有 `destroy()`**（真释放点是 `loadingTask.destroy()`），`mergePages:false` 才有页码，**空白页 0 块但页数照记**（否则"扫描件"与"空文件"分不开）；**两处 bodyLimit 别混成一个**（全局 JSON 收回 1MB、`UPLOAD_BODY_LIMIT` 只挂上传路由）；multipart 用 `fastify-plugin` ⇒ 装饰器落**根实例**、错误码要在 `errorHandler` 显式登记（413 不许被压成 400）；**判重按库**（跨库同内容不判重）+ **DB 写失败补偿删 S3**（S3 先写 DB 后写）；**上传刻意不同步解析** ⇒ 本批**不是可端测里程碑**（`PARSING` 没有下游，列表端点属 P0-1-21）；验收脚本的"注入小值"手法：`process.env` 先写再动态 `import`（配置在模块加载期只读一次），取 8KB 是因为 docx 夹具本身约 2.9KB |
| `issue_fix/问题记录-P0-1-19-入库+覆盖重建+失败重试.md` | **本批最值钱的一条是"写入语句换了形态"**：`§4-4` 草稿写的 `INSERT ... SELECT unnest(...)` 要求"自带 id 数组"，而 `chunks.id` 的口径是 `uuid(7)`、P0-1-16 又已定案 **不手搓 uuid7** ⇒ 该值只有 Prisma 的 `@default` 一个实现 ⇒ 实际落地为「Prisma 建行（拿 id）+ 手写 `UPDATE ... unnest` 回填向量」（同一事务、每批 200 行）。**`uuid(7)` 这件事会静默降级**（手搓出来的仍是合法 uuid，只是版本位是 4）⇒ 验收里有一条 **"id 的版本位必须是 7"** 专门守它，那是唯一抓得住的东西。**第二条是"文档漏了一列"**：`§七` 的 `UPDATE` 列清单里没有 `file_name`，而它在本仓还承担下载端点的 `Content-Disposition` 文件名 —— 旧名留着就会"列表显示旧名、下载得到新内容"，且用户没有别的入口改名 ⇒ 本批补上并回写文档。**第三条是"两类入口的补偿能力不对称"**：上传时入队失败能整次回滚（行是它刚建的），**重建做不到**（旧 chunk 删了就回不来）⇒ 重建只能如实报告并指向 `POST .../retry`，**不伪装成"什么都没变"**；这也是 `retry` 必须**放行 `PARSING`** 的原因（它是"worker 崩了/入队丢了"的恢复入口，若因"看起来正在处理"就 409，卡住的文档将没有出路），而 `READY` 上 retry 回 **409**。**"跳过"类断言的写法**：`content_hash` 相同时的三个"没做"，要用**删得掉证据**的方式取证 —— chunk 行 `id` 逐字不变（重写过就会换新 id）、`updated_at` 不变、对象数不变、队列深度 0；只断言"内容还在"验不出"重写了一遍"。**embedding 的重试粒度**：provider 的 `embed()` 内部自己切批、看到的永远是"一次调用"，故 `§4-3` 的"**单批**失败重试 2 次"必须由流水线侧先按 `EMBEDDING_BATCH_SIZE` 切好再喂，重试边界才与"批"对齐；一批仍失败 ⇒ **整篇 FAILED**（跳过这批会留下"有块没向量"的坏数据，而那些 chunk 在检索里永远排不上号、界面上却一切正常）。**顺带踩到自己记过的坑**：新验收脚本的夹具一开始只有 48 个有效字符，被 P0-1-18 的空文本门槛判成"疑似扫描件"，导致 16 条断言连环假失败 —— **给流水线加内容门槛之后，任何"要让文档走到 READY"的夹具都必须先过门槛**，这条已写进批次施工技能 |
| `issue_fix/问题记录-P0-1-17-异步队列+状态机+worker骨架.md` | **「List 队列没有 ack」是本批全部设计的起点**：`BRPOP` **取出即消失**，worker 崩在中途任务就永久丢失 ⇒ 可靠性落点不在"不丢"，而在"**幂等**（重复投递无害）+ **可重放**（状态机允许 `FAILED`/`PARSING → PARSING`）"。另有：**`BRPOP` 独占整条 Redis 连接** ⇒ 队列空时阻塞读会把会话与健康检查一起钉住，必须走 `createRedisConnection()` 的**专用连接**，且关闭用 `disconnect()` 而非 `quit()`（`quit` 要等挂起的 `BRPOP` 返回，优雅退出会白等满 5s）；**幂等是四道不是一道**（在途去重 / 文档已删 / `contentHash` 不匹配 / 已是 `READY`），四道全命中时必须**一个字节都不写** ⇒ 断言方式是 **`updated_at` 不变**（"没写"看得见，而"写了但值相同"会被漏掉）；**状态迁移写成 CAS**（`updateMany({ where: { id, status: from } })`）⇒ 靠"影响行数"分辨而不是"先查再写"（后者在两个 worker 都读到旧态时会把违法的迁移写进去），非法迁移**只 `warn` 不写**；**`READY → FAILED` 刻意非法**（陈旧的队列任务会把一份已就绪的文档改写坏）、**`FAILED → READY` 刻意非法**（重试必须经过可见的 `PARSING`，否则列表里看不出"正在重试"）；**上传即入队的原子性**（入队失败要连 DB 行带 S3 对象一起回滚，否则文档永远卡 `PARSING` 且没人消费）—— 取证靠**子进程 A/B 控制**（`REDIS_URL=redis://127.0.0.1:1` 的子进程**必须失败且回滚**；真 Redis 的子进程**必须成功**）而不是把父进程的连接打断；**worker 生命周期挂 `index.ts` 而非 `buildApp()`**（否则 `app.inject` 那套接口级验收会被迫连 Redis）；**队列键可配**（`PIPELINE_QUEUE_KEY`）⇒ 共享 Redis 上隔离消费方，验收脚本因此不碰开发队列；**并发闸门要同时测峰值与总耗时**（只测"峰值 ≤ 2"的实现，把它写成串行也能过） |
| `issue_fix/问题记录-P0-1-18-空文本检测+分块.md` | **本批的两个真问题都不在坑预判里**：① **PDF 夹具的单行文本必须折行** —— 单条超长 `Tj` 会超出 `MediaBox`（612pt），而 pdf.js **只提取页面框内的文本** ⇒ 内容被**静默截断**（实测 561 字的单行只析出 85 字、且截在半个单词上），拿它去断言"分块边界/阈值"会得到假数据（不是实现问题，但会让人查错地方）；② **新增的空文本门槛把两处旧夹具"判死"了** —— P0-1-17 留下的 `verify-pipeline` 夹具（docx 20 字、txt 29 字、F 组 PDF 43 字）在 50 字阈值下会被判「疑似扫描件」，让"四篇全 READY"和"重投救回"**假失败**（这是**刻意的行为变化**，不是回归；处置是把夹具写长并在此留档，否则下一个人会以为夹具本来就该这么长）。**分块上最容易静默做错的四条**：切片的单位必须是**码点**（`text.slice()` 会**劈开代理对**，产出非法字符串且**本层毫无报错**，下游 embedding 才炸 ⇒ 全流程建在 `[...text]` 上，验收用 600 个 emoji 逐码点断言）；Section 必须按"**连续**同名标题"切（按 `headingPath` 分组会让 chunk **顺序与原文不一致**，而这在检索层几乎发现不了 —— 片段读起来通顺、只是位置不对）；**每块必须是原文的逐字子串**（重叠取前块尾部而不是新造句子，这是 P0-1-20"引用与原文一致"的前提）；**页码 meta 取"块起点所在段"**（一个 Section 可能跨页 PDF，"整块用 Section 首页"会把页码全说成第 1 页）。**另一处刻意的实现-文档偏离**：`ChunkStrategy.split` 收 `ParseResult` 而不是 `(text, meta)` —— 标题层级只在 `blocks` 里，只给 `text` 会让 hybrid 退化成 fixed。**口径定案**：`chunk_min`（50）是**代码常量**（§十一 的配置表里没有它，加环境变量属于自己发明契约）；空文本检测失败文案里的数字**取实测阈值**（写死 50 会让管理员调阈值后用户按错数字重传）；判据是 `<` 而**恰好等于阈值通过**（验收用例按**当前阈值**生成）；**④ 必须排在 ⑤ 之前**，用产物的缺席取证（`ctx.chunks === undefined` 而 `ctx.parsed !== undefined`）。**⚠️ 本批只"算"不"存"**：`chunk_count` 刻意仍是 0（`schema.prisma` 对它的定义是"**已入库**的 chunk 数"，提前写会造出"说有 N 块却搜不到"的假象，P0-1-19 还得回头改） |
| `issue_fix/问题记录-P0-1-20-双路检索+RRF融合.md` | **本批跑出来的两个"假失败"其实都是断言自己写错**：① `VECTOR` 用例里写了"每条的 `vectorScore > 0`"，而**正交向量的余弦相似度恰好是 0**（合法取值）⇒ 改成"含关键词的那一块必须**严格更近**"（这才是想验的东西）；② "长 query 截断到 64 字符后仍应命中"的**前提本身是错的** —— 截断只保证 LIKE 的模式不长，**不保证**那 64 个字符连续出现在正文里（自然语言问句几乎必然不连续）⇒ 改成"从原文里取 64 字子串当 query + 加长后缀"，并用一次**不截断的独立 SQL 复算**证明"命中只能来自那次截断"。**真问题与设计订正**：③ **RRF 示例数值文档写错了**（0.0323 → 实测 **0.0320**）⇒ 已订正并写成断言（文档与代码从此互为守门）；④ **`§6-1` 的"去停用词"必须收窄**（只剥句首/句尾的提问脚手架）—— LIKE 要连续子串，删掉中间的"的"会把"报销的标准"变成"报销标准"，**降低**命中率；⑤ **`%`/`_` 是 LIKE 的通配符**，必须在 query 预处理阶段剔掉，否则"字面包含"会静默变成模式匹配（判别式：正文里同时有 `5` 和 `0`、但两者永不相邻，用 `5%0` 去搜 —— 两种实现的期望值不同，断言才有判别力）；⑥ **`score` 阈值只作用于向量路且过滤放在候选池之后**（距离单调 ⇒ 两种顺序等价，少传一份 20KB 的向量字面量）；⑦ **`ORDER BY embedding <=> $1, id` 会让 HNSW 退化** ⇒ 二级 tie-break 必须在 JS 侧做（否则 P0-1-14 的索引取证白做）；⑧ `§八` 的降级路径本批就位（`HYBRID` 跳向量路 + 告警 / `VECTOR` 409 / `FULLTEXT` 不受影响，两种原因分开报）；⑨ 顺手加了 `pnpm check:batch` —— `step` 这条"每批手改一次"的纪律**在 P0-1-19 又漏了一次**（第 4 次），能交给机器的就别留给记性 |
| `issue_fix/问题记录-P0-1-21-知识库包验收.md` | **本批的"坑"主要不在实现里，而在"包级验收"这件事本身**：① **前面每档都绿，不等于串起来还成立** —— R4 的"检索返回 v2"在 P0-1-19 只能靠 `<=>` SQL 做**等价取证**（当时检索端点还没落地），本批用真端点重验，并且把断言从"正文含 v2"改成**"新关键词命中重建后的块 + v1 的旧词查不到"**（前者在"新旧两份都留着"的坏数据上照样通过）；② **`getObject` 对不存在的键不在 `await` 时抛错**（错误发生在**读流**时）⇒ 只调它的话响应头已经发出、客户端看到"下到一半断了"；必须先 `statObject` 才能在发头前干净地回 404（顺带拿 `Content-Length`，而两者之间仍有 TOCTOU 窗口，那时**只能断流**，不假装能回 JSON）；③ **下载是本仓唯一不套 `ok()` 信封的端点**（成功是字节流、失败才是信封），这条必须显式写进注释与 README，否则下一个照抄别的路由的人会把它包进信封；④ **`Content-Disposition` 是纯函数但错误静默**：中文名要靠 `filename*`（否则另存为 `____.pdf`）、CR/LF 不删就是**响应头注入**、RFC 5987 里 `'`/`(`/`)`/`*` 这四个字符 `encodeURIComponent` **不转义但规范不认** ⇒ 五组边界断言全在无依赖档；⑤ **列表排序刻意反序**（`createdAt desc`）与"库不存在回 404 而不是空列表"两条都是**产品口径**，写进 `02` §4.6 而不是只留在代码里 |
| `issue_fix/问题记录-P0-1-22-Agent-CRUD.md` | **本批的坑集中在"三处写反了会静默出错"的口径上**：① **权限判据 `USER_ROLES[0]`** 把语义藏在数组顺序里（重排即**静默**把管理员判成别人）⇒ 改成带类型标注的字面量 `const ADMIN_ROLE: UserRole = 'ADMIN'`（删掉 `ADMIN` 时**编译报错**）；② **`.refine()` 的校验失败 `path` 是空串** ⇒ 那条错误是"表单级"而非"字段级"，前端挂不到输入框上，验收只能遍历 `message` 找（要逐字段高亮就得改用 `superRefine` + `addIssue({path})`）；③ **Fastify 的 schema 校验跑在 `preHandler` 之前** ⇒ 验"未登录 401"必须给**语法合法**的载荷（空 body 会先拿 400，把"鉴权挂没挂上"验成假的）。**两条最隐蔽的实现口径**：④ **软删只打标记会让绑过的知识库永远删不掉**（删库守卫数的是 `agent_components`，而界面上那个 Agent 已经"没了"）⇒ 三件事一个事务 + 一条链取证（绑 KB → 删 KB 409 → 软删 Agent → 同一 KB 删得掉 200）；⑤ **绑定模型不能复用 `resolveChatTarget()`**（它带 424 `NEED_CREDENTIAL`，会逼管理员**先配 Key 才能建智能体**）⇒ 只三条校验 + 与可选列表的一致性断言。"换绑才校验"与"`type` 可传不可改"两条是同一族（**不会报错、只会静默做错事**，故全部落进 `verify-agents` 而不只是注释） |

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
│   ├── 06-实施计划.md              ← 施工图（P0-1 拆 36 步，含状态回写）
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
│   └── scripts/                   ← verify-app.mjs（不占端口）+ verify-db.mjs（真实 PG）
│                                     + verify-session.mjs / verify-auth.mjs / verify-users.mjs（真实 PG+Redis）
│                                     + verify-model-providers.mjs / verify-models.mjs（真实 PG+Redis）
│                                     + verify-llm.mjs（真 HTTP 假上游 + 真实 PG+Redis）
│                                     + verify-embedding.mjs（真 HTTP 假上游 + stub 运行时，**无依赖**）
│                                     + verify-knowledge.mjs（**只需真实 PG**：扩展/特殊索引/migrate diff）
│                                     + verify-e2e.mjs（自起真实进程）
├── frontend/                      ← @doubulea/frontend（独立构建，→ frontend/dist 纯静态）
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

| 日期 | 变更人 | 摘要 |
|------|--------|------|
| 2026-09-20 | — | 文档集自原工作区迁入，重编号为 01/02/03；交叉引用同步更新 |
| 2026-09-20 | — | 评审回写（04-评审报告结论并入）：沙箱网络定 egress 白名单；知识库格式收窄为 docx、检索定 pg_bigm+RRF；MCP OAuth 降 P1、危险工具平台强制确认；新增决策 27（重新生成 P1）；01/02/03 各节修订（详见各文档版本记录） |
| 2026-09-20 | — | 新增 `05-P系列计划拆分.md`：按 P=Plan 语义重排 40 项需求为 P0（31 项，3 批次）/ P1（7 项）/ P2（2 项）；文档清单、目录规划、实施路线同步 |
| 2026-09-20 | — | 子方案①《知识库流水线》完成撰写（吸收 B1/B3/B8/B9/B11 + A2）；文档清单与目录规划同步 |
| 2026-09-20 | — | 新增 `06-实施计划.md`：按施工图粒度把 P0-1 拆为 36 步（含产出文件路径/前置/验收/坑预判），补 P0-2/P0-3 骨架、开工前置核对、仓库形态、施工纪律；文档清单与目录规划同步 |
| 2026-09-20 | — | 仓库形态定案：单仓 + pnpm workspace、前后端**平级分离**（`shared`/`backend`/`frontend`/`infra`/`docs`），支持独立构建独立部署；不分仓的决策与理由存 `docs/06` §3.0；本文目录规划同步 |
| 2026-09-20 | — | **P0-1-1 完成**：落地 workspace 骨架（三包平级 + 独立 scripts/tsconfig + 根编排 package.json）、`tsconfig.base.json`、`.editorconfig`/`.npmrc`；文档迁入 `docs/`（根保留本 README 作门面），本文重写为「门面 + 快速开始 + 文档索引」 |
| 2026-09-21 | — | **P0-1-2 完成**：`infra/` 基础设施落地 —— compose（postgres/redis/minio）+ **自建 PG 镜像（pgvector + 源码编译 pg_bigm）** + `.env.example` + PowerShell 起停脚本 + `pg-verify.mjs` 自动验收（12/12 通过，`bigm_similarity` 实测 0.4）。快速开始补「起依赖服务」小节与端口表；目录规划补 `infra/` 明细；文档索引新增缺陷归档表 |
| 2026-09-21 | — | **macOS 环境适配（非计划内批次）**：补 `infra/scripts/dev-*.sh` + 跨平台入口 `infra.mjs`（根脚本不再硬编码 `powershell`）；宿主端口整组后移避让另一项目；新增缺陷归档 `issue_fix/问题记录-macOS环境适配.md`；本文快速开始改为双平台口径 |
| 2026-09-21 | — | **P0-1-3 完成**：`backend/src/config.ts`（zod 启动即校验、缺项列清单并 exit 1、自动加载 `infra/.env` 且进程环境优先）+ `backend/src/infra/logger.ts`（pino + requestId 经 AsyncLocalStorage 贯穿 + 敏感字段脱敏）+ `shared` 补 `toErrorEnvelope`/`toHttpStatus`。新增 `pnpm config:check` 自检命令与「后端配置自检」小节；`infra/.env` 的 `BACKEND_PORT` 本机避让 13000；新增缺陷归档 `issue_fix/问题记录-P0-1-3-配置与日志.md` |
| 2026-09-21 | — | **P0-1-4 完成（包 A 收口）**：Fastify 骨架（含 Zod 校验器与统一错误信封）、`/health` 三依赖探活（恒 200 + 逐项降级 + 超时）、启动与优雅退出；新增 `pnpm lint`（ESLint 扁平配置）、`pnpm verify:app`（12 项接口级验收脚本）、`.github/workflows/ci.yml`（install→lint→typecheck→build→verify）。快速开始补「静态检查与接口级验收」「起后端 + 健康检查」两节；`infra/.env.example` 新增 `CORS_ORIGINS` / `HEALTH_TIMEOUT_MS`；新增缺陷归档 `issue_fix/问题记录-P0-1-4-Fastify骨架与健康检查.md` |
| 2026-09-21 | — | **P0-1-4 补**：修正本地开发启动路径 —— `pnpm dev:backend` 由「只编译不起服务」的 `tsc --watch` 改为 `tsx watch`（直接跑 TS 源码、改文件自动重启、Ctrl-C 优雅退出），原脚本改名 `watch:types`，新增 `pnpm start:backend` 跑产物；快速开始「起后端」一节改为「开发态 / 产物态」两条命令 |
| 2026-09-21 | — | **P0-1-5 完成**：数据模型第一批 + Prisma 基线 —— `backend/prisma/schema.prisma`（7 张表 + 7 个枚举）、`prisma/migrations/0001_init/`（**手写 `messages` 按月分区** + 分区维护函数）、`prisma.config.ts`（v7 的 CLI 唯一配置入口）、`src/infra/prisma.ts`（`@prisma/adapter-pg` 单例）、`scripts/verify-db.mjs`（**17 项全通过**）。快速开始新增「数据模型与迁移」小节与 `db:*` 命令；`pnpm-workspace.yaml` 的 `allowBuilds` 补 `prisma`/`@prisma/engines`；新增缺陷归档 `issue_fix/问题记录-P0-1-5-数据模型与Prisma基线.md` |
| 2026-09-21 | — | **P0-1-6 完成**：密码与会话基础设施 —— `src/infra/crypto.ts`（**AES-256-GCM 版本化信封 + AAD 上下文 + bcrypt cost 12** + 初始密码生成 + 等时比较用的 `DUMMY_PASSWORD_HASH`）、`src/infra/redis.ts`（`session:{sid}` 半衰期滑动续期 + `auth-user:{userId}` 状态快照缓存 + 主动失效）、`src/plugins/session.ts`（HttpOnly/SameSite=Lax Cookie + `requireAuth`/`requireAdmin` + 每请求校验 `user.status`）。`pnpm verify:app` 扩到 **25 项**（CI 无依赖模式 26 项），新增 **`pnpm verify:session`（13 项，需 PG+Redis）**；`infra/.env.example` 新增 `SESSION_TTL_HOURS` / `USER_STATUS_CACHE_TTL_SEC` / `SESSION_COOKIE_SECURE`；`allowBuilds` 补 `bcrypt`；新增缺陷归档 `issue_fix/问题记录-P0-1-6-密码与会话基础设施.md` |
| 2026-09-21 | — | **P0-1-7 完成**：认证接口 —— `src/routes/auth.ts` + `src/services/auth.service.ts`（login/logout/me/password）、`shared/src/auth.ts`（用户名归一化 + 密码策略 + 三个 zod schema，前端表单校验共用）、**首登强制改密闸门**（根级 `preHandler`，白名单四条显式列出）、**登录限速**（Redis 计数 5 次/10 分钟，第 6 次 429 + `retryAfterSec`）。`pnpm verify:app` 扩到 **30 项**（CI 模式 31 项），新增 **`pnpm verify:auth`（21 项，需 PG+Redis）**；「不泄露账号是否存在」加**耗时**断言（235ms vs 236ms）；**零新增依赖、零新增环境变量**；快速开始补「认证四端点的 curl 跑法」与"还没有建号入口"的提示；新增缺陷归档 `issue_fix/问题记录-P0-1-7-认证接口.md` |
| 2026-09-21 | — | **P0-1-8 完成**：用户管理接口（admin）—— `src/routes/users.ts` + `src/services/user.service.ts`（列表 / 建号 / 启停改角色 / 重置密码，全部仅 ADMIN）、`shared/src/user.ts`（`UserListItem` + 四个 schema）、`envelope.ts` 补 `OffsetPage`/`offsetPageOf`。`pnpm verify:app` 扩到 **33 项**（CI 模式 34 项），新增 **`pnpm verify:users`（17 项，需 PG+Redis）**；**建号 → 初始密码登录 → 首登强制改密**链路与**停用后已有会话下一个请求就 401** 都真机走通；**不能停用/降级/重置自己**（409）；重置密码连带"失效快照 + 清登录失败计数"；零新增依赖与环境变量；快速开始补"怎么拿到第一个账号"；新增缺陷归档 `issue_fix/问题记录-P0-1-8-用户管理接口.md` |
| 2026-09-21 | — | **P0-1-9 完成（包 B 收口）—— 🎯 第一个「人工端测」里程碑达成**：`backend/prisma/seed.ts`（**幂等种子脚本**：第一个 admin（首登改密态）+ member；默认绝不覆盖密码，`SEED_RESET_PASSWORD=1` 才重置；初始密码只打印一次）、`backend/scripts/verify-e2e.mjs`（**自己 spawn 真实后端进程 + 真实 HTTP + 手写 Cookie 罐**，默认端口 13099，跑完自清理并断言残留为零）、新增 `pnpm db:seed` 与 `pnpm verify:e2e`。**验收**：`verify:e2e` **17 项全通过**（六条门槛逐条取证）+ **真机 curl 14 步走查**（首登闸门 → 改密 → 建号 → 初始密码登录 → 停用即失效 → 第 6 次 429 → MEMBER 403 → 登出），`verify:app` 33/34 项、`verify:session` 13、`verify:auth` 21、`verify:users` 17、`verify:db` 17 **全部未回归**；**零新增依赖**；种子变量以注释块进 `infra/.env.example` 的 `[G]` 段（不进 AppConfig）；README 新增「手工端测」小节（可照抄的 curl 步骤 + 该看到什么 + 已知边界 + 跑完复位）；新增缺陷归档 `issue_fix/问题记录-P0-1-9-认证与用户验收.md` |
| 2026-09-21 | — | **P0-1-9 补（文档/注释，用户端测时发现）**：① `backend/src/index.ts` 启动信封的 `step` **连漏三批**没跟（P0-1-7/8/9 都报「P0-1-6」）→ 改为 `P0-1-9 认证与用户验收` + 写"每批必改"注释，并把这条写进 `docs/06` §六 **第 26 条施工纪律**；② 新增 README「**起前端**」小节：明确前端现在**只有 P0-1-1 占位页、没有登录页**，给出启动命令（`VITE_DEV_PROXY_TARGET=http://127.0.0.1:13000 pnpm dev:frontend` → 5174）与"怎么验证代理没串到陌生服务"；③ `vite.config.ts` 给 `/api` 代理的默认值（`localhost:3000` = 别人项目的 node）加显式警告注释；④ `docs/06` §七 待决事项 6 补同上口径 |
| 2026-09-21 | — | **P0-1-10 完成（包 C 起步）**：模型池 Provider 管理 —— `shared/src/modelProvider.ts`（`MODEL_TYPES` / `maskApiKey` / 三段 schema）、`backend/src/services/model.service.ts`（**Key 写入即 AES-256-GCM 加密、AAD 绑定到 `id`**；读接口只出口 `hasKey` + `apiKeyPreview` 掩码；PATCH 三态；删除与改 type 的两条 409 守卫）、`backend/src/routes/modelProviders.ts` + `app.ts` 接线。`pnpm verify:app` 扩到 **38 项**（CI 模式 39 项），新增 **`pnpm verify:model-providers`（18 项，需 PG+Redis）**；`verify:db`/`session`/`auth`/`users`/`e2e` 全部未回归；**零新增依赖、零新增环境变量**；`docs/02` 新增 **§10.2 Provider Key 存储口径**；新增缺陷归档 `issue_fix/问题记录-P0-1-10-模型池Provider管理.md` |
| 2026-09-21 | — | **P0-1-11 完成（包 C 继续）**：模型管理 —— `shared/src/model.ts`（`ModelItem`/`ModelOption` **两套投影** + 四段 schema）、`backend/src/services/model.service.ts`（模型 CRUD + 三条守卫）、`backend/src/routes/models.ts`（`GET /api/models` 仅 ADMIN + `GET /api/models/available` 登录即可 + POST/PATCH/DELETE）+ `app.ts` 接线。`pnpm verify:app` 扩到 **42 项**（CI 模式 43 项），新增 **`pnpm verify:models`（17 项，需 PG+Redis）**；`verify:db/session/auth/users/model-providers/e2e` 全部未回归；**零新增依赖、零新增环境变量**；路由表订正：`GET /api/models?type=CHAT` → `GET /api/models/available?type=CHAT`（`03` §116 同步）；新增缺陷归档 `issue_fix/问题记录-P0-1-11-模型管理.md` |
| 2026-09-21 | — | **P0-1-12 完成（包 C 继续）**：LLM client 封装 —— `backend/src/llm/client.ts`（OpenAI 兼容**传输层**：`chat()` / `chatStream()` / `fetchRemoteModels()`；**零新增依赖**，手写 SSE 解析）、`services/model.service.ts` 补 `resolveChatTarget()`（四道前置校验 + 解密 Key 注入）与 `listProviderRemoteModels()`、`routes/modelProviders.ts` 补 **`GET /api/model-providers/:id/remote-models`**（用户追加需求：**拉取该配置下的上游模型**，通用 `GET {baseUrl}/models`，只读探测不落库）、`shared/src/modelProvider.ts` 补上游模型列表契约；**新增 2 个环境变量**（`LLM_REQUEST_TIMEOUT_MS` / `LLM_STREAM_IDLE_TIMEOUT_MS`，已同步 `.env.example`/`.env`/`02` §十一）；`02` 新增 **§6.1 LLM client 实现口径**（差异收敛清单 11 条 + 两条实现纪律）与 §4.3 契约增量。`pnpm verify:app` 扩到 **44 项**（CI 模式 45 项），新增 **`pnpm verify:llm`（22 项：起真 HTTP 假上游，upstream 侧取证 Key 注入 / **未发 `stream_options`** / SSE 分片 / 无 `[DONE]` / 末帧无空行 / 思考增量 / 畸形帧 / 两级超时 / 「点停止 ≠ 故障」）**；`verify:db(17)/session(13)/auth(21)/users(17)/model-providers(18)/models(17)/e2e(17)` **全部未回归**；README 快速开始补「静态检查与验收」的 `verify:llm` 一行与手工端测的 ⑤ 拉取上游模型；新增缺陷归档 `issue_fix/问题记录-P0-1-12-LLM-client封装.md` |
| 2026-09-21 | — | **P0-1-13 完成（包 C 收口 ✅）**：embedding 双模式 provider —— `backend/src/llm/embedding/{index,api,local,embedding.worker}.ts`（api 走 OpenAI 兼容 `/embeddings`；local 走 `worker_threads` 真隔离 + 懒加载；两种模式都批 `EMBEDDING_BATCH_SIZE`=32）；**通用上游件抽出** `backend/src/llm/upstream.ts`（看门狗/中断/脱敏/状态码映射/`fetchUpstreamJson`）并让 `client.ts` 复用 —— 第二次做上游调用不再把 P0-1-12 的两个坑再养一遍（`verify:llm` 22 项逐项仍通过即是证据）。**local 的推理运行时（含分词）走注入**（`LOCAL_EMBEDDING_RUNTIME_MODULE`，契约见 `02` §八）：交付物形态未定（`06` §七 待决事项 2）写死等于赌，且本批因此**零新增依赖**。**新增 2 个环境变量**（`EMBEDDING_BATCH_SIZE` / `LOCAL_EMBEDDING_RUNTIME_MODULE`），`02` 新增 §8.1 实现口径 + §十一 同步；README 手工端测新增 ⑥ embedding 自检两步。**验收**：新增 **`pnpm verify:embedding`（27 项，⚠️ 不需要 PG/Redis，可进 CI）**；既有 9 档（`app 44 / db 17 / session 13 / auth 21 / users 17 / model-providers 18 / models 17 / llm 22 / e2e 17`）**全部未回归**；**两个实现问题也是跑验收才抓出来的**（worker 继承 `--input-type` 崩 / `spawnSync` 钉死父进程事件循环）；新增缺陷归档 `issue_fix/问题记录-P0-1-13-embedding双模式.md` |
| 2026-09-21 | — | **P0-1-14 完成（包 D 起步）**：知识库数据模型 + 扩展 —— `backend/prisma/schema.prisma`（**+3 表 +1 枚举**：`knowledge_bases`/`documents`/`chunks` + `document_status`，共 **10 表/8 枚举**）、`backend/prisma/migrations/0002_knowledge/migration.sql`（**手写 `CREATE EXTENSION vector/pg_bigm`** + HNSW（`vector_cosine_ops`, m=16, ef_construction=64）+ `gin (content gin_bigm_ops)`）、`backend/scripts/verify-knowledge.mjs` + `pnpm verify:knowledge`。⚠️ **本批最大的坑不在 `06` 的坑预判里**：**手写 DDL 会被 Prisma 判成"多余对象"并生成 `DROP INDEX`**（下一批动 schema 时两条检索索引被静默删掉 ⇒ 检索退化成全表扫描）；**P0-1-5 的"Prisma 会跳过分区表"结论不能外推**（分区子表它跳过、认不出的索引它照删）。两处置法：**GIN 在 schema 里声明**（`type: Gin` + `ops: raw("gin_bigm_ops")` + `map`）、**HNSW 藏进"部分索引"**（实测：普通 btree 与表达式索引都会被 DROP，唯独带 `WHERE` 的部分索引它不看），恒真谓词 `WHERE kb_id IS NOT NULL` ⇒ 内容等价全量 HNSW 且被 `kb_id = $2`/`= ANY(...)` 蕴含；失效**静默** ⇒ 三条守门断言（`migrate diff --exit-code`=0 / `indpred` 未变 / 两条路 `EXPLAIN` 命中）。**`06` 点名的 GIN 坑预判经实测部分不成立**：`USING gin (content)` 不是"静默建错算子类"而是**直接报错** `data type text has no default operator class for access method "gin"`（`text` 装 pg_bigm 后仍无默认 GIN 算子类）。另：主键统一 `uuid(7)` **改掉 `子方案①` §4-4 的 `bigserial`**（两文档对同一 DDL 口径不一致 = 文档腐烂，已消掉其一）、`Unsupported("vector(1024)")?` 的**可空是硬要求**、`embedding_model` 定 NOT NULL（及其"本机 .env 状态下令 P0-1-15 建库失败"的刻意副作用）、`retrieval_config` 的 **DB 默认值写完整形状**、`documents` **刻意不加** `UNIQUE(kb_id, content_hash)`。**验收**：新增 **`pnpm verify:knowledge`（23 项，⚠️ 只需 PG，不需要 Redis/S3）**；既有 10 档（`app 44 / db 17 / session 13 / auth 21 / users 17 / model-providers 18 / models 17 / llm 22 / embedding 27 / e2e 17`）**全部未回归**；README 手工端测新增 ⑦ 知识库数据层自检两步；新增缺陷归档 `issue_fix/问题记录-P0-1-14-知识库数据模型.md` |
| 2026-09-21 | — | **P0-1-15 完成（包 D 继续）**：知识库 CRUD + 检索配置 —— `shared/src/knowledgeBase.ts`（`RETRIEVAL_MODES`/`SPLIT_STRATEGIES` + 冻结的 `DEFAULT_RETRIEVAL_CONFIG` + **唯一兜底点 `normalizeRetrievalConfig()`** + item/列表/查询/建/改/删六段 schema）、`backend/src/services/kb.service.ts`、`backend/src/routes/knowledgeBases.ts`（五路由，**只挂 `requireAuth`** —— 知识库是**登录即可**，与模型池的 ADMIN 相反）。**本批唯一的真 bug 是 `normalizeRetrievalConfig` 的参数方向写反**（`raw` 压住 `patch` ⇒ 建库与改库两处都**静默丢弃用户输入**；`lint`/`typecheck`/`build` 全绿，只有纯函数断言抓得到），已订正为 patch 优先并**逐键**合并 `weights`。**新增 `pnpm verify:knowledge-bases`（19 项，需 PG + Redis + MinIO）**：A 组 CRUD（注入特征默认值 256/32、topK 8 / score 0.42 / rrfK 77 证明是**快照**而非硬编码；`retrievalConfig` **局部合并**；`description` 三态；跨字段守卫按**生效值**算；⚠️ **MEMBER 能建/改/删**）、B 组级联删 chunks 与 S3 真消失 + **被 Agent 绑定 → 409 且一个都没删**、C 组老数据 `{}`/半键/越界值仍返回完整合法形状（含 DB 默认值与 shared 规范默认值的**跨包一致性**断言）、D 组**子进程注入环境变量**验 embedding 未就绪的两面。**既有 11 档（46/23/17/13/21/17/18/17/22/27/17）全部未回归**，lint + 三包 typecheck/build 全绿；README 手工端测新增 ⑧ 知识库 CRUD 五步、验收表新增 `verify:knowledge-bases`、已知边界订正（**"MEMBER 能用的业务接口"从"只有 `/api/models/available`"扩为两处**）；新增缺陷归档 `issue_fix/问题记录-P0-1-15-知识库CRUD+检索配置.md` |
| 2026-09-21 | — | **P0-1-16 完成（包 D 继续）**：文档上传 + 四格式解析 + 前置校验 —— `shared/src/document.ts`（`UPLOAD_EXTENSIONS` / `LEGACY_DOC_HINT` / `UPLOAD_FILE_FIELD='file'` / `MIME_BY_EXTENSION` + `documentItemSchema`/`uploadDocumentResultSchema`/`documentParamsSchema`）、`backend/src/pipeline/parse/{types,txt,md,docx,pdf,index}.ts`（四个解析器对外同一形状 `ParseResult`：`text` + `blocks[{text,headingPath,page}]` + `meta{format,pageCount,charCount,hasHeadings,encoding}`；`detectFormat` 三道路由侧校验 + `parseDocument` 分发）、`backend/src/services/document.service.ts`（KB 存在性 → 探测 → **按库** `content_hash` 判重 → S3 落盘 → 建 `PARSING` 行；DB 失败补偿删 S3）、`backend/src/routes/documents.ts`（**只此一条路由**，route-level `bodyLimit`）、`backend/src/types/mammoth.d.ts`（该包无类型也无 `@types`）、`backend/scripts/{fixtures/documents.mjs,verify-documents.mjs}`；`app.ts` 挂 `@fastify/multipart`（`fastify-plugin` ⇒ 装饰器落根实例）+ **全局 JSON bodyLimit 收回到 1MB**、`errorHandler.ts` 登记六个 multipart 错误码、`infra/s3.ts` 补 `ensureBucket`。**⚠️ 本批两个真问题都不在坑预判里**：① `.gitignore` 第 19 行的 `**/src/**/*.d.ts`（P0-1-1 为防 tsc 产物污染源码加的）把**手写**的 `backend/src/types/mammoth.d.ts` 一起吞了 —— 本机全绿、**只有 CI / 新克隆才会 `TS7016`**（反馈最晚的一类失败）⇒ 按既有 `!**/src/**/*.d.mts` 惯例加 `!backend/src/types/**/*.d.ts`，并把「该目录只放手写声明」写成约定；**可复用检查**：新增任何非 `.ts` 源文件后 `git status` 必须看得见它（`git check-ignore -v <path>`）。② `crypto.randomUUID({ version: 7 })` 在 Node 22.22.2 上**静默返回 v4**（不抛错、形态合法，只是版本位是 `4`；`@types/node@22.20.4` 的 `RandomUUIDOptions` 恰好**没有 `version` 字段** ⇒ 当初靠 `as` 强转绕过，类型系统**替运行时说了谎**）⇒ 处置是**彻底放弃手搓 uuid7**：`documents.create` 不带 `id`（`@default(uuid(7))` 是唯一事实来源）、S3 键中段用普通 `randomUUID()`（v4，**与 docId 无关**）。**对文档口径的增量**：MIME 是**客户端声明** ⇒ 单靠"扩展名 × MIME"交叉校验**抓不到改名**（`a.txt`→`a.pdf` 后浏览器照样声明 `application/pdf`，一路绿灯），故在四道之外补了**文件头魔数**比对（`%PDF-` / ZIP 且包内含 `[Content_Types].xml` / OLE2 / RTF / 图片 / 文本禁 NUL），并修掉两个易漏子分支（**任意 zip 改名成 `.docx`**、**BMP 只认 `BM` 会把 "BMW …" 判成图片**）；`application/octet-stream` 一律**放行**（它是"不知道"不是"矛盾声明"，否则 `curl -F` 这条基本路径被堵死）。**坑预判订正**：TXT 嗅探必须做但**不需要 iconv**（Node ICU 自带 `gbk`；本批**零新增环境变量**、`allowBuilds` 无需改动），真正的前提是严格 UTF-8 必须带 **`fatal: true`**（不带它 GBK 被**静默**解成 U+FFFD，"嗅探"永远嗅不出东西）。**契约定案**：只接受**一个**文件字段 `file`；响应 `{document, deduplicated}`；`.doc` 专拦并给「请另存为 .docx 后重传」。**验收**：新增 **`pnpm verify:documents`（30 项，需 PG + Redis + MinIO）**（A 纯函数矩阵 / B 同一批校验挂路由的 401·404·400·406·413 / C 四格式模块级真跑 / D 落库与 S3 逐字节取证 + 按库判重 + MEMBER 可上传 / E 走 API 删库后 DB 与 S3 双清），`verify:app` **46 → 49 项**；既有 12 档（49/23/17/13/21/17/18/17/22/27/19/17）**全部未回归**，lint + 三包 typecheck/build 全绿；`docs/02` §4.6 补「上传端点请求形态与前置校验（P0-1-16 定案）」、§十四 补七个批次断档的回写补记；README 手工端测新增 ⑨ 文档上传（含四条反例 curl）与专项边界；新增缺陷归档 `issue_fix/问题记录-P0-1-16-文档上传+四格式解析+前置校验.md` |
| 2026-09-21 | — | **P0-1-17 完成（包 D 继续）**：异步队列 + 状态机 + worker 骨架 —— `shared/src/document.ts` 补**状态机契约**（`DOCUMENT_STATUS_TRANSITIONS` + `canTransitionDocumentStatus`；⚠️ **刻意禁止 `READY→FAILED`**，否则一个陈旧的队列任务就能把已就绪的文档改写坏；**也禁止 `FAILED→READY`**，重试必须经过可见的 `PARSING`）、`backend/src/pipeline/queue.ts`（Redis List 队列：`LPUSH`/`BRPOP`、job 形状 `{docId,kbId,contentHash,mode}` 带 zod 校验、`parsePipelineJob` 对垃圾载荷**返回 `undefined` 而不抛**，⚠️ **`BRPOP` 独占连接** ⇒ 用 `createRedisConnection()` 的**专用连接**、关闭走 `disconnect()`）、`backend/src/pipeline/worker.ts`（**进程内 worker**：`PIPELINE_CONCURRENCY` 默认 2 的信号量闸门、**幂等四道**、CAS 状态迁移、失败落 `error_msg`）、`backend/src/pipeline/stages.ts`（stage 数组：读 S3 → 重跑 `detectFormat`+`parseDocument`，证明解析是**真跑**不是桩）、`backend/src/infra/redis.ts` 抽出 `createRedisConnection(role)`、`backend/src/services/document.service.ts` **上传后入队**（入队失败 → `rollbackRegistration()` 连 DB 行带 S3 对象一起回滚，否则文档永远卡 `PARSING` 且没人消费）、`backend/src/index.ts` worker 生命周期（`listen` 后 `startPipelineWorker()`；`shutdown()` 里**先 `stopPipelineWorker()`** 再关连接，等手上的任务最多 5s）。**新增 1 个环境变量** `PIPELINE_QUEUE_KEY`（默认 `pipeline:jobs`；共享 Redis ⇒ **可换键 = 可隔离消费方**，验收脚本因此各用随机键）。**⚠️ 本批的设计起点是"List 队列没有 ack"**：`BRPOP` 取出即消失，worker 崩在中途任务就丢 ⇒ 可靠性不靠"不丢"，靠**幂等（重复投递无害）+ 可重放**；四道幂等全命中时**一个字节都不写**（断言 `updated_at` 不变 —— "写了但值相同"会被漏掉）、**非法迁移只 `warn` 不写**（用 `updateMany` 的影响行数分辨，而不是"先查再写"那种有竞态的写法）。**worker 挂 `index.ts` 不挂 `buildApp()`**（否则 `app.inject` 那套验收会被迫连 Redis）。**验收**：新增 **`pnpm verify:pipeline`（24 项，需 PG + Redis + MinIO）**（A 纯函数 / B 队列语义含"**阻塞读不占用共享连接**" / C 端到端四格式全转 `READY` / D 幂等四道 / E 并发闸门**同时测峰值与总耗时** / F 失败→重试→救回 / G **入队原子性子进程 A/B**（死 Redis 必须回滚、真 Redis 必须成功）/ H 收尾双清），`verify:documents` **30 → 32 项**（补"新建一条文档就多一条任务"与"判重命中不入队"）、`verify:app` **49 → 50 项**（补状态机契约段）；既有 13 档（`db 17 / session 13 / auth 21 / users 17 / model-providers 18 / models 17 / llm 22 / embedding 27 / knowledge 23 / knowledge-bases 19 / e2e 17` + 上面两档新计数）**全部未回归**，`lint` + 三包 `typecheck`/`build` 全绿；`docs/02` §二 补 worker 口径、§4.6 上传补第四步"入队"、§十一 补 `PIPELINE_QUEUE_KEY`；`docs/子方案/知识库流水线.md` 补 job 形状与幂等/失败口径；README 手工端测新增 ⑩ 异步流水线（含查库看状态的 psql）；新增缺陷归档 `issue_fix/问题记录-P0-1-17-异步队列+状态机+worker骨架.md`。⚠️ **本批不是可端测里程碑**：`READY` = "解析完成"，`chunk_count` 仍为 0（分块 P0-1-18、向量化 P0-1-19、检索 P0-1-20），且**没有列表端点**（P0-1-21）⇒ 进度只能查库 |
| 2026-09-22 | — | **P0-1-18 完成（包 D 继续）**：空文本检测 + 分块（可插拔策略）—— `backend/src/pipeline/chunk/{strategy,hybrid,fixed,index}.ts`（`ChunkStrategy` 接口 + **纯函数**实现：`hybrid` 默认 = 按"连续同名标题"切 Section → 段内回退到句末边界 → 尾块合并 → 同 Section 内 64 字符重叠；`fixed` = 定长滑窗、不做边界回退）、`backend/src/pipeline/stages.ts` 插入 **④ `detect-empty-text`** 与 **⑤ `chunk`**（并导出 `buildEmptyTextMessage()` 供验收逐字断言）、`backend/src/pipeline/worker.ts` 的 `JOB_DOCUMENT_SELECT` 一次联表带出 KB 的分块参数（`chunkSize`/`chunkOverlap`/`splitStrategy`，后者经 `normalizeRetrievalConfig` 补默认值）。**零新增依赖、零新增环境变量**（分块参数与阈值都是 P0-1-15 已有的）。**三条最值得记的**：① **④ 必须排在 ⑤ 之前**（否则扫描件先白切一遍再判失败），用**产物的缺席**取证；失败文案里的数字**取实测阈值**（阈值可配）；**失败不删原文件**（用户要能下载核对）。② **一切切片建在 `[...text]` 的码点数组上** —— `chunk_size` 的单位是字符（B8），用 `text.slice()` 会**劈开代理对**（`'😀'.length === 2`）产出非法字符串且**本层毫无报错**（下游 embedding 才炸）。③ **⚠️ 只"算"不"存"**：块已切出（`ctx.chunks`）但**刻意不写 `chunk_count`**、更不写 `chunks` 表（⑥⑦ 属 P0-1-19）—— 那一列的定义是"**已入库**的 chunk 数"，提前写会造出"接口说这篇有 12 块、检索却什么都搜不到"的假象；停在 0 是为了把"`READY` = 解析与分块都过了、但仍不可检索"这个中间态**暴露出来**（块数进日志，仍可观测）。**验收**：`verify:app` **50 → 60 项**（新增整段"分块策略契约"：小文档特例恰好 1 块、句末回退（首块长度 < chunk_size 且末字符是句末边界）、**每块都是原文的逐字子串**、重叠 64 与块长上界、尾块合并与 `fixed` 对照、定长滑窗块长序列、**按码点切不劈开代理对**、PDF 页码 meta、同名标题不相邻时顺序保持、未知策略回落），`verify:pipeline` **24 → 29 项**（新增 **H 组**：扫描件 → `FAILED` 且含「疑似扫描件」+ 原文件仍保留、**阈值边界**（恰好达标通过 / 少一字符失败，按当前阈值生成用例）、**真字节重跑阶段数组**验分块边界与重叠、200 字短通知恰好 1 块；原"清场"组顺延为 **I 组**）；既有 13 档（60/17/13/21/17/18/17/22/27/23/32/19/17）**全部未回归**，lint + 三包 typecheck/build 全绿；`docs/06`（状态 + 11 条落地要点 + 坑预判取证 + P0-1-19 前置回写 + D 包 **5/8**）、`docs/02` §二·§十四、`子方案①` §4-2/§五/§十四 同步。**⚠️ 两处旧夹具因新门槛被加长**（`verify-pipeline` 的 docx 20→~80、txt 29→~70、F 组 PDF 43→~70 字）—— 有效字符 < 50 现在会判"疑似扫描件"，旧夹具会让"四篇全 READY"与"重投救回"假失败；这是刻意的行为变化，不是回归。**⚠️ 边界**：`chunk_count` 仍为 0、`chunks` 表仍为空 ⇒ **依然不可检索**，本批**仍不是可端测里程碑**。归档：`issue_fix/问题记录-P0-1-18-空文本检测+分块.md` |
| 2026-09-22 | — | **P0-1-19 完成（包 D 继续）**：入库 + 覆盖重建 + 失败重试 —— `backend/src/pipeline/index/writer.ts`（`embedChunks()` 按 `EMBEDDING_BATCH_SIZE` 切批 + **单批失败重试 2 次**（退避 1s/3s）+ 条数不符即中止；`writeChunks()` 事务内 `DELETE WHERE doc_id` → `createManyAndReturn` → 手写 `UPDATE ... FROM unnest(...)` 回填向量，每批 200 行）、`backend/src/pipeline/stages.ts` 加 **⑥ `embed` / ⑦ `index`**（阶段数组至此八步齐全，`READY` 才等于"可检索"）、`shared/src/document.ts` 补三条响应契约与 `REUPLOAD_UNCHANGED_HINT`、`backend/src/services/document.service.ts` 补 `reuploadDocument` / `retryDocument` / `deleteDocument`、`backend/src/routes/documents.ts` 挂三条新端点（全部只需登录）。**四条最值得记的**：① **写入语句刻意偏离 `§4-4` 草稿** —— `INSERT ... SELECT unnest(...)` 要求"自带 id 数组"，而 `chunks.id` 是 `uuid(7)` 且已定案**不手搓 uuid7** ⇒ 改成「Prisma 建行（拿 id）+ 手写 `UPDATE ... unnest` 回填向量」（同一事务），验收里有一条 **"id 的版本位必须是 7"** 专守（手搓的 uuid 并不会报错，只是版本位变成 4，**静默**）；② **`file_name` 也一并更新**（`§七` 列清单漏了它）—— 它还承担下载端点的 `Content-Disposition`，旧名留着就会"列表显示旧名、下载得到新内容"；③ **重建的入队失败无法整次回滚**（旧 chunk 删了就回不来）⇒ 如实报告 + 指向 `POST .../retry`，**不伪装成"什么都没变"**；`retry` 因此必须**放行 `PARSING`**（"worker 崩了 / 入队丢了"的恢复入口），`READY` 上则回 **409**；④ **embedding 的重试粒度是"批"** —— provider 自己会切批、只看到"一次调用"，故由流水线侧先切好再喂；一批仍失败 ⇒ **整篇 FAILED**（跳过会留下"有块没向量"的坏数据，检索里永远排不上号而界面正常）。**覆盖重建的三个"没做"**（内容相同时：不落对象、不删 chunk、不入队）用**删得掉证据**的方式取证（chunk 行 id 逐字不变 + `updated_at` 不变 + 对象数不变 + 队列深度 0）—— 只断言"内容还在"验不出"重写了一遍"。**坑预判取证**：`§七` 的"先删后建 ⇒ 检索空窗"**成立**（窗口 = 一次流水线耗时），缓解落成"响应立刻 `PARSING` + `chunkCount` 归 0"，并把「列表页必须显示『更新中，暂不参与检索』」写进 **P0-1-21 的坑预判**（必做）。**验收**：新增 **`pnpm verify:ingest`（23 项，需 PG + Redis + MinIO，自起假 embedding 上游）**——A 入库真跑（`chunk_count` 与表逐行一致、每行有向量、维度 1024、meta 三键、**id 版本位 = 7**、上游侧取证只发 `model`/`input`）／B 覆盖重建（id 不变、旧 chunk id 一个不剩、全库无孤儿、内容是 v2、**`<=>` 近邻命中 v2 那块**作为"检索返回 v2"的数据层等价取证、旧对象被删）／C 内容未变化／D 失败重试（上游 500 → 「文本向量化失败（已重试 2 次）」→ 修好 → retry → READY → 再 retry 409；跨库 docId 404）／E 删除文档（`deletedChunks` + 三清 + 重复删 404）／F 边界与权限（**重建不能绕过前置校验**、未登录 401、**MEMBER 全通**）／G 清场双清；`verify:pipeline` **29 项**（阶段序列断言改六步、`chunkCount===0` 改成"与 `chunks` 表逐行一致"、新增"重跑是替换不是追加"、接入假 embedding 上游）、`verify:app` **60 → 64 项**（三条新路由 + `deduplicated` ≠ `unchanged` 不串味 + 重试/删除契约 + 提示常量）；既有 14 档**全部未回归**，lint + 三包 typecheck/build 全绿；`docs/06`（P0-1-19 状态 + 11 条落地要点 + 坑预判取证 + **P0-1-21 坑预判回写** + D 包 **6/8**）、`docs/02` §二·§4.6·§十四、`子方案①` §4-3/§4-4/§七/§十四 同步。**⚠️ 边界**：`READY` 现在等于**可检索**（库里有带向量的 chunk），但**检索端点本身**是 P0-1-20、列表/下载端点是 P0-1-21 ⇒ 本批**仍不是可端测里程碑**（不过 `chunk_count` 已是真数，`psql` 一眼能看出入库了几块）。归档：`issue_fix/问题记录-P0-1-19-入库+覆盖重建+失败重试.md` |
| 2026-09-22 | — | **P0-1-20 完成（包 D 继续）**：双路检索 + RRF 融合 —— `backend/src/services/retrieval.ts`（新增：向量路 `1 - (embedding <=> $1)`（候选池 `topK × CANDIDATE_POOL_FACTOR`、**相似度下限只作用于这一路且过滤在池之后**）+ 全文路 `content LIKE '%词%'` + `bigm_similarity`（query 预处理：剔标点（**含 `%`/`_` 两个 LIKE 通配符**）→ **只剥句首/句尾**的提问脚手架 → 按码点截断 64 → `< 2` 字整条跳过并告警）+ `mode` 三值分流 + **RRF 融合**（`w = 1/(rrfK + rank)` 两路相加、缺失记 0、同分按 `chunkId` 升序）+ 引用对象构造（`docName` / `snippet` ±80 字符**不加工**窗口 / `rrfScore`）+ **`§八` 的降级路径**（模型变更 / embedding 未就绪 ⇒ `HYBRID` 跳向量路 + `warnings` 与 `vectorPathSkipped`、`VECTOR` 报 409 或 500、`FULLTEXT` 不受影响）；纯函数 `normalizeFulltextQuery` / `buildSnippet` / `fuseRrf` / `rrfScoreOf` **导出**以便无依赖档断言）、`backend/src/routes/knowledgeBases.ts`（挂 `POST /:id/search`，**登录即可**）、`shared/src/knowledgeBase.ts`（新增 `FULLTEXT_QUERY_MAX_CHARS`/`FULLTEXT_QUERY_MIN_CHARS`/`SNIPPET_WINDOW_CHARS` + 三条提示常量 + `searchKnowledgeBaseBodySchema`/`retrievalHitSchema`/`searchKnowledgeBaseResultSchema`）。**零新增依赖、零新增环境变量**（`RRF_K`/`CANDIDATE_POOL_FACTOR`/`RETRIEVAL_*` 都是 P0-1-15 已登记的）。**四条最值得记的**：① **"两路各自与独立 SQL 等价"是唯一能证明分数不是编出来的手段** —— 验收把端点返回的名次/分数跟独立复算同形状 SQL 的结果**逐条对照**（只断言"非空 + 有六列"时，一个"按 seq 排序"的假实现照样全绿）；② **RRF 的数值可以用返回的两路名次逐条反算**（`1/(k+rv) + 1/(k+rf)`，缺失记 0）；③ **`%`/`_` 必须在预处理阶段剔掉**，否则"字面包含"静默变成模式匹配（验收用"正文里有 `5` 和 `0` 但永不相邻"的夹具做判别 —— 两种实现的期望值不同，断言才有判别力）；④ **`§6-1` 的"去停用词"收窄为"只剥首尾脚手架"**（LIKE 要连续子串，删中间的"的"会**降低**命中率）。**两处文档订正**：`§6-2` 的 RRF 示例数值 0.0323 → **实测 0.0320**（并写成断言，文档与代码互为守门）、`§六` 的响应示例改成实际契约（`chunkId` 是 uuid(7)、补 `page`/`headingPath`/`rrfK`/`candidatePool`/`vectorPathSkipped`/`warnings`、`snippet` 不加工）。**验收**：新增 **`pnpm verify:retrieval`（27 项，需 PG + Redis + MinIO，自起 `semantic: true` 的词面重叠型假 embedding 上游）** —— A 三模式与六列（`FULLTEXT` 单独跑中文 query 非空、`VECTOR` 里含关键词的块**严格更近**、`HYBRID` 里两路都第 1 的块排第一、与独立 SQL 逐条等价、RRF 反算、`finalRank` 连续、引用片段三分支且都是原文子串、**`elapsedMs` 与墙钟都 < 500ms**（实测 3ms/4ms））／B 生效配置（阈值只作用于向量路、`topK`/`mode` 覆盖**不落库**、参数回显分别为该库快照 77 与环境特征值 5）／C 降级路径（模型变更 ⇒ 降级 + 告警 / `VECTOR` 409；未就绪 ⇒ 降级 / `VECTOR` 500，**子进程注入空配置**）／D 权限（MEMBER 可检索）+ 边界（空库、纯标点、跨库隔离、不存在 404）／E 清场；`verify:app` **64 → 72 项**（新增"检索契约与 RRF 纯函数"整段）；**既有 14 档全部未回归**（`retrieval 27`＋`embedding 27 / db 17 / session 13 / auth 21 / users 17 / model-providers 18 / models 17 / llm 22 / knowledge 23 / documents 32 / pipeline 29 / ingest 23 / knowledge-bases 19 / e2e 17`），lint + 三包 typecheck/build 全绿；`docs/06`（状态 + 11 条落地要点 + 坑预判取证 + P0-1-21 前置与坑预判回写 + D 包 **7/8**）、`docs/02` §4.6（检索端点契约表）·§十四、`子方案①` §6-1/§6-2/§六/§八/§十四 同步；**顺手补 `pnpm check:batch`**（`infra/scripts/check-batch-marker.mjs`：比对 `docs/06` 最后一个 `[✓]` 的批次号与 `index.ts` 启动信封的 `step` —— 这条"每批手改一次"的纪律**在 P0-1-19 又漏了一次**（第 4 次），能交给机器的就别留给记性）。**⚠️ 边界**：**这仍不是浏览器可端测的里程碑**（列表/下载端点是 P0-1-21、界面是 P0-1-30），但 **API 级已经"上传 → 入库 → 检索"整条打通**：`curl POST .../search` 现在能真的拿回带双路分数与 RRF 名次的片段；手工跑需要先配好 `EMBEDDING_*`（本机 .env 三项为空 ⇒ `HYBRID` 会降级为纯全文并告警），零配置的完整跑法是 `pnpm verify:retrieval`。归档：`issue_fix/问题记录-P0-1-20-双路检索+RRF融合.md` |
| 2026-09-22 | — | **P0-1-21 完成（包 D 收口 ✅）**：知识库包验收 —— 补 `documents` **列表**与**下载原始文件**两条端点（`listDocuments` / `openDocumentSource` / 纯函数 `buildContentDisposition` / `downloadContentType`），并逐行跑通 `子方案①` §十二 的 8 行。**四条最值得记的**：① **列表排序刻意与其余三个列表相反**（文档用 `createdAt desc`：刚传的那篇要在第一条，否则用户以为上传没成功；**不按 `updatedAt`** —— 覆盖重建会让它在翻页时"跳到最前面"）；② **库不存在回 404 而不是空列表**（"库没了"与"库里没文档"是两件事，前端要跳的地方都不一样）；③ **必须先 `statObject` 再 `getObject`** —— 后者对不存在的键**不在 `await` 时抛错**（错误发生在读流时）⇒ 只调它的话响应头已经发出、客户端看到"下到一半断了"；先 stat 才能在发头前干净地回 404（顺带拿 `Content-Length`）；④ **`Content-Disposition` 的头注入防护**（CR/LF 删除、引号/反斜杠/路径分隔符替换、RFC 5987 里 `'`/`(`/`)`/`*` 还得自己编码 —— `encodeURIComponent` 会放过它们）+ **下载类型表与上传白名单的跨表一致性断言**。两条界面规则收进 `shared`：`DOCUMENT_PARSING_HINT`（"更新中，暂不参与检索" —— `§七` 的检索空窗不能不说）与 `isDocumentSearchable`（`READY ⟺ 可检索`，且 `PARSING ≠ FAILED`）。**验收**：新增 **`pnpm verify:kb-package`（11 项，需 PG + Redis + MinIO）** —— **一行一组逐行跑 §十二 的 8 行**（其中 R4"检索返回 v2"改用**真检索端点**验：新关键词命中**重建后**的块、**v1 的旧词查不到**，比"正文含 v2"强得多；R2 的 `PARSING→READY` 改用**列表端点**观察）；`verify:documents` **32 → 44 项**（F 组列表：分页/最新在前/键集合/跨库隔离/三态提示；G 组下载：**字节逐字相等**/Content-Type/中文名还原/对象丢失 404/幽灵与跨库与未登录/MEMBER 守门）、`verify:app` **72 → 79 项**（第 23 节：两条路由 + 列表 schema + 同一套投影 + 三态判据 + `Content-Disposition` 五组边界 + 跨表一致性）；**既有 15 档全部未回归**，lint + 三包 typecheck/build 全绿；`docs/06`（状态 + 8 条落地要点 + 坑预判取证 + **D 包 8/8**）、`docs/02` §4.6（列表/下载契约表）·§十四、`子方案①` §十二（**8 行逐行验收结论表**）·§十四、README（验收表、手工端测 ⑬、已知边界、索引、版本记录）同步。**⚠️ 边界**：`§七` 待决事项 7 的第二个端测点（**P0-1-30 浏览器首站**）与知识库界面（P0-1-35）都还没做 ⇒ 本批之后**命令行可跑完整条链路**（建库 → 上传 → 列表 → 检索 → 下载），浏览器里仍是占位页；单条 embedding 的真实推理时延仍卡在 `LOCAL_EMBEDDING_RUNTIME_MODULE`（`06` §七 待决事项 2）。归档：`issue_fix/问题记录-P0-1-21-知识库包验收.md` |
| 2026-09-22 | — | **P0-1-22 完成（包 E 起步 1/3）**：Agent CRUD —— `shared/src/agent.ts`（`AGENT_TYPES`/`COMPONENT_TYPES` + **权限判据唯一实现 `canEditAgent`** + **读取端唯一兜底点 `normalizeGuideQuestions`** + **唯一一套 `AgentItem` 投影** + 五段 schema）、`backend/src/services/agent.service.ts`（列表/建/详情/改/软删 + 绑定模型三条校验 + **软删三件套**）、`backend/src/routes/agents.ts`（五条路由，**只用 `requireAuth`**）、`backend/scripts/verify-agents.mjs`（新增）、`verify-app.mjs` 第 24 节。**零新增依赖、零新增环境变量**。**三条最值得记的**：① **权限是"全员可建可看可用；创建者 + ADMIN 可编删"**（`01` §3.3 决策 18）—— 与知识库（无 owner 列、登录即可）和模型池（全程 ADMIN）**三族口径各不相同**，照抄邻居必错（本仓已踩过两次"顺手加 `requireAdmin`"）；判据只有一处实现，**路由侧不用 `requireAdmin`**（否则"创建者本人也改不了自己的东西"），验收用 **MEMBER** 跑建/改/删 + **ADMIN 改他人必须 200** 的反向守卫；判据里管理员取**字面量**而非 `USER_ROLES[0]`（后者重排即静默改判）。② **软删是"三件事一个事务"**（打 `deleted_at` + 删 `agent_components` + 会话转 `FINISHED` 只读保留），**先 CAS 打标记**再解绑；**只打标记的实现会让绑过的知识库永远删不掉**（删库守卫数 `agent_components`），故用一条链取证：**「绑 KB → 删 KB 409 → 软删 Agent → 同一 KB 删得掉 200」**。③ **绑定模型刻意不复用 `resolveChatTarget()`** —— 它带 424 `NEED_CREDENTIAL`（"调用上游"的前置），拿来校"绑定"会**逼管理员先配 Key 才能建智能体**；本批只三条（存在 + `type=CHAT` + 模型与 Provider 都启用），与 `GET /api/models/available` **逐条对应**并加一致性断言。另两条**静默口径**：**换绑才校验**（否则模型被停用后连改名都 409，症状是"这个智能体改不动了"，此时靠新增的 `modelAvailable` 字段提示）与 **`type` 可传不可改**（放进 schema 正是为了把静默 no-op 变成显式 409）。**验收**：新增 **`pnpm verify:agents`（26 项；需 PG + Redis、**不需要 MinIO**，注入 `EMBEDDING_*` 以便建真 KB 取快照）** —— A 投影/两种类型/`canEdit` **三方向** + 列表 `updatedAt desc`、B 绑定模型**四态**（门槛：绑 disabled 模型被拒）+ 与可选列表一致性 + "模型停用后仍能改名"、C 权限双向（MEMBER 与 ADMIN 各跑一遍）、D 四个文本字段三态 + `guideQuestions` 四边界 + `type` 不可改、E 软删三件套 + "已软删一律 404（不是 403）" + **跨批次引用计数口径**、F 路由表（P0-1-23 与 P1 的三条**必须 404**）、G 纯函数；`verify:app` **79 → 85 项**（CI 86 项）；**既有 17 档全部未回归**（含会碰 `agent_components` 的 `verify:pipeline` 与 `verify:knowledge-bases`），lint + 三包 typecheck/build 全绿；`docs/06`（状态 + 10 条落地要点 + 坑预判取证 + **P0-1-23 坑预判回写** + E 包 **1/3**）、`docs/02` §4.4（**契约增量 · Agent** 八条：三族权限对照表、投影与 `canEdit`/`modelAvailable`、软删三件套、绑定校验四态表、换绑幂等、请求体口径、读取端兜底点、**五个列表的排序口径对照表**）·§十四、README（验收表、`verify:agents` 说明段、手工端测 **⑭**、已知边界"智能体专项"、缺陷索引、本行）同步。**⚠️ 边界**：组件绑定的**写侧**（`PUT /api/agents/:id/components`）是 **P0-1-23**、`POST /api/agents/:id/copy` 是 **P1**、Agent 界面是 **P0-1-31** ⇒ 本批**仍不是可端测里程碑**（浏览器首站仍是 P0-1-30）。归档：`issue_fix/问题记录-P0-1-22-Agent-CRUD.md` |
