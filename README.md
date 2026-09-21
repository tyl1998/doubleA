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

### 静态检查与验收（P0-1-4 起；数据层从 P0-1-5 起；会话从 P0-1-6 起；认证从 P0-1-7 起；用户管理从 P0-1-8 起；端到端从 P0-1-9 起；模型池从 P0-1-10 起）

```bash
pnpm lint              # ESLint（扁平配置；业务代码禁 console，必须走 pino）
pnpm -r typecheck      # tsc strict（三包）
pnpm -r build          # 三包依次产出 dist
pnpm verify:app        # 接口级验收：用 app.inject 打请求，**不占端口、不启 docker**（38 项）
pnpm verify:db         # 数据层验收：库结构 + Prisma 客户端，**需要真实 PG**（17 项）
pnpm verify:session    # 会话验收：Cookie/Redis 会话/停用即失效，**需要真实 PG + Redis**（13 项）
pnpm verify:auth       # 认证接口验收：登录/改密/限速/首登闸门，**需要真实 PG + Redis**（21 项）
pnpm verify:users      # 用户管理验收：权限/建号/启停改角色/重置密码，**需要真实 PG + Redis**（17 项）
pnpm verify:e2e        # 端到端验收：起真实进程 + 真实 HTTP 跑六条门槛，**需要真实 PG + Redis**（17 项）
pnpm verify:model-providers  # 模型池 Provider 验收：Key 加密/读脱敏/三态/删除守卫，**需要真实 PG + Redis**（18 项）
```

> `pnpm verify:app` 会在构建产物上跑：/health 三项探活、Zod 校验失败的字段明细、领域错误、
> 未知异常不泄露内部信息、404 兜底、413/415、CORS 预检、requestId 透传，以及
> P0-1-6 的密文往返/篡改检出、bcrypt 形态、初始密码生成、未登录出口，P0-1-7 的
> `/api/auth/*` 注册与 schema 字段明细、首登闸门不误拦匿名请求，P0-1-7/8/10 的
> shared 契约纯函数（认证 / 用户管理 / 模型池三套 schema，含 `maskApiKey` 的边界与
> **Provider 输出形态的键级自检**：不得出现 `apiKey` 或任何带 `enc` 的键）。
> 无依赖环境（如 CI）加 `EXPECT_DEGRADED=1`，额外断言"依赖不可达时探活逐项降级"
> 与"会话存储不可用时鉴权**失败关闭**（500，绝不放行）"。
>
> `pnpm verify:session` / `verify:auth` / `verify:users` / `verify:e2e` / `verify:model-providers`
> 是**必须**先起依赖 + 迁移的五档
> （`pnpm infra:up && pnpm db:deploy`），因为验的正是"真实 Redis/PG 上的行为"：
> 会话基础设施（Cookie 属性、`session:{sid}` 的 TTL 与滑动续期、停用/删号失效路径）；
> 四个认证端点（含**登录限速第 6 次 429**、**首登强制改密闸门 403**、以及
> "不泄露账号是否存在"的**耗时**取证）；用户管理四端点（含**建号 → 初始密码登录 → 首登改密**链路、
> **停用后该用户已有会话下一个请求就 401**、**不能停用/降级/重置自己**）；
> 端到端（`docs/06` P0-1-9 的**六条门槛**：种子脚本 3 条 + 门槛 1~6 + 登出 + 自清理复核）；
> 模型池 Provider（**Key 不回显明文**的三层取证：响应层搜不到明文/密文、存储层是
> `v1.<iv>.<tag>.<ct>` 且能用 AAD 解回原文、绑定层换 id 即解不开；外加 PATCH 三态与两条 409 守卫）。
> 五个脚本都自造临时数据并在收尾时删净（含 Redis 键），跑完还会**断言**残留为零，不会污染开发库。
> 看细节日志：`LOG_LEVEL=debug pnpm verify:users`。
>
> ⭐ `pnpm verify:e2e` 与前四个的关键区别：**它自己 spawn 一个真实后端进程**（默认端口 **13099**，
> 不占你正在看的 13000），用真实 TCP + `fetch` 走一遍，并**手写 Cookie 罐**（不使用任何测试后门）。
> 换句话说 —— 它能跑通，就意味着**你照着下面的 curl 敲也能跑通**。端口被占时换一个：
> `E2E_PORT=13098 pnpm verify:e2e`。

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

**已知边界（别当 bug）**：① 目前只有 `/api/auth/*` 与 `/api/users` 两组接口，**没有 MEMBER 可用的业务接口**
（`/api/agents` 是 E 包）—— 所以"改密后能正常用"用 403 文案的变化来验（改密前是闸门、改密后是权限）；
② 浏览器里的登录页/强制改密跳转是 **P0-1-30** 的事，本里程碑只到命令行；
③ **端测完请复位**（走查会把 admin 的密码改掉）：
`SEED_RESET_PASSWORD=1 pnpm db:seed` 把两个种子账号打回首登态并恢复成你指定的密码。

> 想一条命令跑完上面全部 + 六条门槛的自动版：`pnpm verify:e2e`（它自己起进程、自己造号、跑完删净）。

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
| `issue_fix/问题记录-P0-1-5-数据模型与Prisma基线.md` | **Prisma 7 的接入形态完全变了**（`prisma-client` generator + `output` 必填 + `prisma.config.ts` + 驱动适配器）、`allowBuilds` 要一次登记两个包、Prisma CLI 不该继承应用侧全量配置、**反向探针**证伪"分区表会被 `migrate dev` 重建"、`migrate diff` 的 `--exit-code` 用法、查询日志按 `trace` 门控且必须丢掉 `params` |
| `issue_fix/问题记录-P0-1-6-密码与会话基础设施.md` | **bcrypt 对非法摘要 compare 立刻返回 false（等时比较会失效）**、bcrypt 静默截断 72 字节、原生 bcrypt 的 `allowBuilds`（但自带 prebuilds 不需编译器）、`@fastify/cookie` 是 `export =` 形态取不到类型名、会话令牌不需要签名、`decorateRequest` 必须直接调用、Cookie 属性不一致导致登出失效、"鉴权失败自毁会话"与"缓存窗口"的取舍 |
| `issue_fix/问题记录-P0-1-7-认证接口.md` | **「不泄露账号是否存在」必须看耗时**（光对齐文案不够）、停用账号的报错时机（密码错 vs 密码对）、限速的三个顺序细节（判定在前 / 锁不续期 / 成功即清）、首登闸门挂根级 `preHandler` 且不依附 `requireAuth`、改密后必须主动失效快照缓存、**Prisma 函数型默认值不在 DB 层**（手工 INSERT 要给 id 与 updated_at）、verify 脚本要先构建 `shared` |
| `issue_fix/问题记录-P0-1-8-用户管理接口.md` | **「响应体不含密码」的检查要分两层**（值/哈希 vs 键名，混在一起会让正确实现被判失败）、**重置密码必须清登录失败计数**、Prisma 唯一冲突要"先查 + catch"且用错误码而不是 `instanceof`、分页的稳定排序与 `total` 同快照、**「不能操作自己」放服务层**及其边界（含重置自己）、首登闸门会拦住首登态的 admin 调 `/api/users`、建号返回 200 而非 201 |
| `issue_fix/问题记录-macOS环境适配.md` | 启停脚本补 `.sh` + 跨平台入口、**宿主端口被另一项目占用→改 `.env` 避让**、**bash 3.2 把中文并进变量名**、corepack 取 pnpm |
| `issue_fix/问题记录-P0-1-10-模型池Provider管理.md` | **AAD 绑定到 `id` 会让加密依赖 `id`** → 建 Provider 必须用事务（先落行拿 id 再加密），否则失败重试会留下"建好了但没 Key"的行、而且调用方还会再建一个；**解密失败不能掀桌**（预览降级 `****`，否则主密钥一换列表整页 500，连"哪个 Key 坏了"都看不到）；三态的实现落点（`.nullable().optional()` **不加 default**）；**最强验收是"密文逐字不变"**（能抓出"每次 PATCH 都重写 Key"）；`ON DELETE RESTRICT` 让"删 Provider"必须前置检查、且**软删的 Agent 仍占外键**；`baseUrl` 去尾斜杠 + 只允许 http(s)（SSRF 面）；改 type 与硬删的取舍；`maskApiKey` 的断言别拿"字符集不相交"去写（分隔符会误报） |
| `issue_fix/问题记录-P0-1-9-认证与用户验收.md` | **种子脚本的「幂等」是安全属性**（默认绝不覆盖密码，否则改过密码的人下次 seed 后登录不上）、种子脚本的 console 是交付通道而非日志（需 ESLint 例外）、`prisma/seed.ts` 会被编译进 dist 的两面性、**「端到端」的关键是换掉传输层**（spawn 真实进程 + 真实 HTTP）、子进程端口先探再用、`UID` 是 shell 只读变量、`fetch` 要多条 `Set-Cookie` 必须用 `getSetCookie()`、**「跑完干净」要写成断言**、门槛 3 的「业务 API」本仓还没有（用 403 文案区分闸门 vs 权限）、手工走查会留下不可用状态（收尾必须 seed 复位） |

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
│                                     + modelProvider.ts（模型池契约，P0-1-10 ✅）
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
│   │   ├── services/auth.service.ts ← 登录（含限速）/ 改密（P0-1-7 ✅）
│   │   ├── services/user.service.ts ← 列表 / 建号 / 启停改角色 / 重置密码（P0-1-8 ✅）
│   │   ├── services/model.service.ts ← Provider CRUD + Key 加密/AAD 绑定/掩码（P0-1-10 ✅）
│   │   └── infra/                 ← logger.ts（P0-1-3 ✅）+ pg/redis/s3.ts（P0-1-4 ✅）
│   │                                + prisma.ts（客户端单例，P0-1-5 ✅）
│   │                                + crypto.ts（AES-256-GCM + bcrypt，P0-1-6 ✅）
│   └── scripts/                   ← verify-app.mjs（不占端口）+ verify-db.mjs（真实 PG）
│                                     + verify-session.mjs / verify-auth.mjs / verify-users.mjs（真实 PG+Redis）
│                                     + verify-model-providers.mjs（真实 PG+Redis）+ verify-e2e.mjs（自起进程）
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
