# doubuleA

公司内部 **Agent 工作台**：问知识、派任务、接工具。全新建设、单组织内部使用、无商业化能力。

覆盖三条主链路：**知识问答**（知识库检索 + 带引用回答）、**任务执行**（Docker 沙箱内跑引擎、交付产物）、
**工具增强**（MCP 工具调用 + 用户级凭据 + 危险操作确认）。另有 Code 模式工作区、定时任务、
长期记忆、用量统计、开放平台（Agent OpenAPI）等能力。

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | TypeScript + Node 22 + Fastify 5（单体进程） |
| ORM / 数据库 | Prisma 7 + PostgreSQL（自建镜像：pgvector + pg_bigm） |
| 缓存 / 队列 / 会话 | Redis（AOF everysec） |
| 对象存储 | S3 兼容（开发期 MinIO） |
| 沙箱 | Docker 容器即会话，引擎 Pi（`pi --mode rpc`），出网经 egress 代理 |
| 前端 | React 18 + TypeScript 5 + Vite 5 |
| UI / 状态 / 路由 / 请求 | Ant Design 5；Zustand；React Router 6；TanStack Query（`api/client.ts` 统一信封 → `ApiError`） |
| 代码编辑 | CodeMirror 6（Code 模式工作区） |
| 实时通道 | SSE（事件全集契约写在 `shared/src/sse.ts`，后端归一化） |
| 契约 / 校验 | zod（`shared/` 前后端共用，编译期内联、运行期零耦合） |
| 部署 | Docker 多阶段构建 + compose；Linux/macOS/Windows 脚本 |

## 功能概览

- **对话**：聊天主页（跨智能体会话栏）+ ChatBot / TaskAgent 双编排；七种消息卡片；停止、重新生成、
  插话（`steer`）、思考分段；附件与文件预览（MD/HTML/图片/CSV/PDF）。
- **知识库**：PDF / docx / Markdown / 纯文本解析，向量 + pg_bigm 中文全文双路检索（RRF 融合），
  引用带文档名 + 原文片段；覆盖重建；图片 OCR 与图片"含义"理解（VLM）。
- **MCP**：Streamable HTTP（2025-06-18 规范）；工具网关（超量按需发现）；用户级凭据注入；
  危险工具平台强制确认；工具清单热更新。
- **任务与沙箱**：会话即容器、空闲回收、并发排队；产物收集与全格式预览；沙箱出网范围与黑白名单。
- **Code 模式**：人与 agent 共享持久工作区（宿主工作区 + DB 版本索引 + S3 冷备），文件 I/O 中介、
  CAS、撤销本轮、运行位置与环境选择（多机实例 + 运行时）。
- **平台能力**：模型池与 Provider；Agent / 知识库 / MCP 所属人与可见性（受众用户/组）；长期记忆
  （全局画像常驻 + Agent 记忆按需）；定时任务（cron + 通知 webhook）；用量统计；开放平台 APIKey。
- **运维**：多机部署（每机一实例 + 按会话粘性路由 + 负载感知）、实例管理页一键初始化。

## 仓库结构

单仓 monorepo（pnpm workspace），前后端平级分离，支持独立构建与独立部署。

```
doubuleA/
  README.md              本文件（仓库门面）
  shared/                @doubulea/shared：zod schema + 类型 + 错误码（编译期依赖）
  backend/               @doubulea/backend：Fastify + Prisma（构建 → backend/dist）
  frontend/              @doubulea/frontend：React + Vite（构建 → frontend/dist 纯静态）
  infra/                 基础设施与部署资源
    docker-compose.yml     postgres / redis / minio
    router/                后端与网关镜像 + compose（多实例扩容时用）
    frontend/              前端 nginx 静态站点镜像 + compose
    sandbox/               沙箱基础 / toolkit / 运行时镜像构建
    scripts/               构建、启停、部署、自检脚本
    .env.example           环境变量模板（唯一真相来源）
  deploy/                分发包（别人拿它 + 镜像，改一份 deploy.env 就能起）
  docs/                  设计文档与子方案（见下）
  issue_fix/             环境 / 基础设施类踩坑记录
```

## 快速开始（本地开发）

```bash
pnpm install                      # 三包一次装齐
cp infra/.env.example infra/.env  # 填 CREDENTIAL_MASTER_KEY / POSTGRES_PASSWORD / S3_SECRET
pnpm dev                          # 依赖服务 → 建表/种子 → 后端(13000) → 前端(5174)
pnpm dev:stop                     # 收掉后端 + 前端（--infra 连依赖一起停）
```

- 需要 Node 22（`.nvmrc`），`corepack enable pnpm` 后 `pnpm` 直接可用。
- 依赖服务端口冲突时改 `infra/.env`（默认 PG 5432 / Redis 6379 / MinIO 9000-9001）。
- 完整命令与排错见 [09-infra 脚本与本地开发](docs/09-infra脚本与本地开发.md)。

```bash
pnpm -r build                                # 全量构建，三包依次产出 dist
pnpm --filter @doubulea/backend  build       # 只构建后端 → backend/dist
pnpm --filter @doubulea/frontend build       # 只构建前端 → frontend/dist（纯静态）
```

跑 Code 模式 / TaskAgent 还需要沙箱镜像与出网代理（缺一界面症状各不相同）：

```bash
pnpm sandbox:build                          # 构建沙箱镜像并回写 infra/.env（内网先设 SANDBOX_NPM_REGISTRY）
bash infra/scripts/egress-up.sh --write-env # 起沙箱出网代理（必须在后端起来之后）
```

## API 地址与同源转发

前端默认走**同源相对路径 `/api`**：开发由 Vite dev server 代理（`VITE_DEV_PROXY_TARGET`）、
生产由 nginx 反代到**路由网关**，不依赖后端 CORS。`VITE_API_BASE_URL` 只在"独立域名且不反代"时
才设成绝对地址（构建期内联进 bundle，见 `frontend/src/api/client.ts`）。

## 环境变量

唯一真相来源是 `infra/.env.example`（后端 `backend/src/config.ts` 用 zod 按此清单校验，缺必填项
启动即失败）。分组：compose 端口 / 后端必填（`DATABASE_URL`、`REDIS_URL`、`S3_*`、
`CREDENTIAL_MASTER_KEY`）/ embedding 双模式 / 并发限额 / 沙箱与产物 / Code 模式工作区 / MCP /
开放平台 / 路由网关。

自检：`pnpm config:check`（只校验并打印脱敏后的生效配置）。

## 镜像与部署

```bash
pnpm backend:build-image       # 业务后端 doubulea-backend:2
pnpm gateway:build             # 路由网关 doubulea-gateway:2（只装 fastify/ioredis/zod）
pnpm frontend:build-image      # 前端静态站点 doubulea-frontend:2（nginx + dist）
pnpm router:config             # compose 组合的配置自检（不需要 daemon）
```

镜像 tag 与版本线的唯一来源是 `infra/sandbox/versions.mjs`，不要手敲 `docker build`。
多台机器部署时必须**一台构建、分发到各台**（`--save` + `docker load`，或推私有 registry）。

部署有三种形态，**别混**（它们是不同的部署问题，不是同一件事的规模档位）：

| 形态 | 是什么 | 文档 |
|---|---|---|
| **单机全套** | 一台机器跑后端 + 网关 + 前端 + PG/Redis/MinIO（`deploy.env` 的 `MODE=all`） | [部署-总览](deploy/docs/部署-总览.md)、[Linux](deploy/docs/Linux.md)、[macOS](deploy/docs/macOS.md)、[Windows](deploy/docs/Windows.md) |
| **按角色拆机器** | 前端 / 后端 / 基础服务 / 网关 各放一台，**后端仍只有一台**（A 前端 / B 后端 / C 基础服务 / D 网关） | [分角色部署](deploy/docs/分角色部署.md) |
| **多实例扩容** | **N 台后端**各起本机 Docker 沙箱，一个网关按会话粘性路由（P1-14 的"多机"） | [沙箱多机部署](docs/子方案/沙箱多机部署.md) |

> ⚠️ 常见误解：[沙箱多机部署](docs/子方案/沙箱多机部署.md) 的"多机"指的是**多台后端实例**（为了把沙箱分散到多台
> Docker 宿主），不是"把前端、后端、基础服务分开放"。只想拆角色、后端还是一台时，看
> [分角色部署](deploy/docs/分角色部署.md)。单后端下网关的粘性路由与负载感知会退化为无操作。

沙箱出网 / 运行时与依赖：[沙箱与引擎集成](docs/子方案/沙箱与引擎集成.md)、[Code 模式工作区](docs/子方案/Code模式工作区.md)。

## 文档

施工纪律：**文档先于代码**，需求变更先改 `01`，再改 `02`/`03`，最后改 `06` 与代码。

| 文档 | 定位 |
|---|---|
| [01-整体需求与实施步骤](docs/01-整体需求与实施步骤.md) | 顶层基准：决策总表、模块需求清单、五阶段实施步骤 |
| [02-后端设计](docs/02-后端设计.md) | 技术选型、架构分层、数据模型、API 全集、SSE 契约、安全与部署 |
| [03-前端设计](docs/03-前端设计.md) | 技术栈、路由清单、对话页详设、SSE→UI 映射、工程结构 |
| [04-设计评审报告](docs/04-设计评审报告.md) | 评审记录（结论已回写 01/02/03） |
| [05-P系列计划拆分](docs/05-P系列计划拆分.md) | 计划视图（P0/P1/P2） |
| [06-实施计划](docs/06-实施计划.md) | 施工图主文件：批次实施步骤、路线图、口径、施工纪律 |
| [07-第三方接入会话确认协议](docs/07-第三方接入-会话确认%28confirm%29协议.md) | 第三方接入的会话确认协议 |
| [08-开放平台智能体 OpenAPI](docs/08-开放平台-智能体OpenAPI%28APIKey%29.md) | 开放平台 APIKey 与 `/open/v1` |
| [09-infra 脚本与本地开发](docs/09-infra脚本与本地开发.md) | infra 脚本说明与本地开发完整命令 |
| [子方案](docs/子方案/) | 复杂点拆分（知识库流水线 / 沙箱与引擎集成 / 文件预览 / Code 模式工作区 / 沙箱多机部署等） |
| [归档](docs/归档/) | 完成态沉淀（历史端测步骤、版本记录） |
| [README-工程手册](docs/README-工程手册.md) | 原根 README：环境准备、端测步骤、批次验收记录（工程手册式） |