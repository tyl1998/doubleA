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

### 静态检查与接口级验收（P0-1-4 起；数据层从 P0-1-5 起）

```bash
pnpm lint              # ESLint（扁平配置；业务代码禁 console，必须走 pino）
pnpm -r typecheck      # tsc strict（三包）
pnpm -r build          # 三包依次产出 dist
pnpm verify:app        # 接口级验收：用 app.inject 打请求，不占端口、不启 docker（12 项）
pnpm verify:db         # 数据层验收：库结构 + Prisma 客户端，**需要真实 PG**（17 项）
```

> `pnpm verify:app` 会在构建产物上跑：/health 三项探活、Zod 校验失败的字段明细、
> 领域错误、未知异常不泄露内部信息、404 兜底、413/415、CORS 预检、requestId 透传。
> 无依赖环境（如 CI）加 `EXPECT_DEGRADED=1`，断言三项探活全部降级。

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

# 3) 数据层验收（需要真实 PG，17 项断言；CI 里跑的是不需要依赖的 verify:app）
pnpm verify:db

# 附：messages 按月分区的续期（幂等；建议每月或每季跑一次）
pnpm db:partitions
```

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
| 其余 `/api/**` | P0-1-6 起逐个落地（当前访问未注册路由会得到统一信封 404）；数据模型（P0-1-5 ✅）已就位 |

> 进程支持 SIGINT/SIGTERM 优雅退出：停止接流 → 关闭 PG/Redis 连接 → flush 日志 → 退出（10s 兜底强退）。

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
| `issue_fix/问题记录-macOS环境适配.md` | 启停脚本补 `.sh` + 跨平台入口、**宿主端口被另一项目占用→改 `.env` 避让**、**bash 3.2 把中文并进变量名**、corepack 取 pnpm |
| `issue_fix/问题记录-P0-1-5-数据模型与Prisma基线.md` | **Prisma 7 的接入形态完全变了**（`prisma-client` generator + `output` 必填 + `prisma.config.ts` + 驱动适配器）、`allowBuilds` 要一次登记两个包、Prisma CLI 不该继承应用侧全量配置、**反向探针**证伪"分区表会被 `migrate dev` 重建"、`migrate diff` 的 `--exit-code` 用法、查询日志按 `trace` 门控且必须丢掉 `params` |

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
├── backend/                       ← @doubulea/backend（独立构建，→ backend/dist）
│   ├── prisma/schema.prisma       ← 7 张表 + 7 个枚举（P0-1-5 ✅）
│   ├── prisma/migrations/0001_init/ ← 首个迁移（含手写的 messages 分区 DDL）
│   ├── prisma/sql/                ← 非迁移的手工 SQL（分区续期）
│   ├── prisma.config.ts           ← Prisma CLI 配置：schema/迁移目录/seed/连接串（P0-1-5 ✅）
│   ├── generated/prisma/          ← Prisma Client 生成物（gitignore，build/typecheck 重建）
│   ├── src/
│   │   ├── index.ts               ← 启动入口 + 优雅退出（P0-1-4 ✅）
│   │   ├── app.ts                 ← Fastify 装配：CORS/bodyLimit/请求上下文钩子（P0-1-4 ✅）
│   │   ├── config.ts              ← 环境变量校验 → 强类型 config（P0-1-3 ✅）
│   │   ├── plugins/errorHandler.ts ← Zod 校验器 + 错误 → 信封（P0-1-4 ✅）
│   │   ├── routes/health.ts       ← /health 探 PG/Redis/S3（P0-1-4 ✅）
│   │   └── infra/                 ← logger.ts（P0-1-3 ✅）+ pg/redis/s3.ts（P0-1-4 ✅）
│   │                                + prisma.ts（客户端单例，P0-1-5 ✅）
│   └── scripts/                   ← verify-app.mjs（不占端口）+ verify-db.mjs（需真实 PG）
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
