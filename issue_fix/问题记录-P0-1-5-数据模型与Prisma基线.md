# 问题记录 — P0-1-5 数据模型第一批与 Prisma 基线

> 批次：P0-1-5（`backend/prisma` + Prisma 7 接入 + `messages` 按月分区）
> 日期：2026-09-21
> 关联：`docs/06-实施计划.md` §P0-1-5 / §六 第 20~24 条 / §七 待决事项 1（本批关闭）、
>      `docs/02-后端设计.md` §三 + §3.1（本批新增）
> 定位：本文件记录施工中踩的坑与结论。计划文件只留一行指针。

---

## 汇总（7 个坑 + 1 项反向探针结论）

| # | 问题 | 严重度 | 状态 |
|---|------|--------|------|
| 1 | **Prisma 7 的接入形态与 v6 完全不同**：generator 换代、`output` 必填、配置搬到 `prisma.config.ts`、**必须**用驱动适配器 | **高** | ✅ 已按 v7 形态落地 |
| 2 | `allowBuilds` 要**一次登记两个包**（`prisma` + `@prisma/engines`），否则 `pnpm add` 报错退出并顺手删掉 72 个包 | 中 | ✅ 已登记 |
| 3 | Prisma CLI 若复用 `src/config.ts`，会出现「只想跑 migrate 却因没配 S3 而失败」；且 `generate` 需要在不连库时也能跑（CI） | 中 | ✅ 独立加载 + 命令白名单 |
| 4 | `tables.external` 必须写**全限定名**（`public.messages`），只写表名报 `P3023` | 低 | ✅ 探针期踩到；最终**未启用**该能力（见坑 5） |
| 5 | **06 的坑预判「`migrate dev` 会重建分区表」经反向探针证实不成立** | **高（结论价值高）** | ✅ 已证伪，并据此否掉了 `experimental.externalTables` 方案 |
| 6 | 生成物放在 `src` 之外，`tsc` 是否会因它报错（strict 全家桶） | 中 | ✅ 生成码自带 `@ts-nocheck`，实测零干扰 |
| 7 | Prisma 查询日志把验收输出刷屏；且 `query` 事件的 `params` **含 bcrypt 摘要** | 中 | ✅ 按 `trace` 档门控 + 显式丢弃 `params` |

**核心结论**：Prisma 7.10.0 的内省**能正确识别 PG 分区关系** —— 反手造一张无关表立刻被 `DROP TABLE` 检出，
而 14 个月度分区子表一处都没被判为"多余对象"；给 `Message` 加列只生成
`ALTER TABLE "messages" ADD COLUMN ...`（PG 自动下推到各分区），无任何重建动作、无 reset 提示。
因此本项目**不启用** Prisma 7 提供的 `experimental.externalTables` + `tables.external`
（虽然它确实可用且正是为这类场景设计的）：一旦启用，**将来对 `Message` 的任何结构变更都不会再生成迁移**，
属于"静默不一致"，比"生成一条会失败的 DDL 然后报错"危险得多。

---

## 坑 1（最关键）— Prisma 7 的接入形态与 v6 完全不同

**现象**：按 v6 的肌肉记忆写 `generator client { provider = "prisma-client-js" }`
+ `datasource db { url = env("DATABASE_URL") }` + `new PrismaClient()`，在 v7 上是**跑不通**的。

**根因**（v7 迁移指南的三条硬变化）：

| 变化 | v6 | v7 |
|------|----|----|
| 生成器 | `prisma-client-js`（将移除） | **`prisma-client`**（Rust-free），且 `output` **必填**，不再往 `node_modules` 里生成 |
| 连接方式 | 内置连接池 | **必须**驱动适配器（PG 用 `@prisma/adapter-pg`） |
| CLI 配置 | schema 内的 `datasource.url` | **`prisma.config.ts`**（`schema` / `migrations` / `seed` / `datasource`），`url` 等字段已废弃 |
| 自动行为 | `migrate dev` 会顺带 `generate`、且会自动跑 seed | **都不再自动**（`--skip-generate`/`--skip-seed` 已移除）；`migrate diff` 的 `--from-url` 等换成 `--from-config-datasource` |

**对策**：按 v7 形态一次写对，三处关键值都要与仓库既有约定挂钩：

```prisma
generator client {
  provider               = "prisma-client"
  output                 = "../generated/prisma"
  runtime                = "nodejs"
  moduleFormat           = "esm"           // 本仓库是 "type": "module"
  generatedFileExtension = "ts"
  importFileExtension    = "js"            // tsc 编译而非打包 → 相对导入必须带 .js
}
```

`importFileExtension = "js"` 这条**必须**有：生成码内部用相对导入互相引用，本仓库按
`verbatimModuleSyntax` 一律写 `.js` 后缀、由 tsc 原样输出给 Node ESM，不写就会运行期
`ERR_MODULE_NOT_FOUND`（与 `src` 里「相对导入带 `.js`」是同一条约定）。

---

## 坑 2 — `allowBuilds` 要一次登记两个包（且失败会顺手删包）

**现象**：

```
Error: ERR_PNPM_IGNORED_BUILDS
  × adding a new package
  ╰─▶ Ignored build scripts: @prisma/engines@7.10.0, prisma@7.10.0
```

**根因**：pnpm 10+ 默认拦截依赖的 install 脚本。`prisma` 自带 **`preinstall`**
（`node scripts/preinstall-entry.js`，用于平台探测），`@prisma/engines` 自带 postinstall。

**对策**：在 `pnpm-workspace.yaml` 的 `allowBuilds` 里登记（键名规则与 esbuild 同）：

```yaml
allowBuilds:
  esbuild: true
  prisma: true
  '@prisma/engines': true
```

**顺带发现（容易误判为"依赖树坏了"）**：`pnpm add` 在 install 脚本被拦时会
**先落盘再报错**，于是依赖树处于半成品状态，下一次 `pnpm install` 的汇总行会打印
`Packages: -72`（把上一步残留的包收掉）。看起来像"装个 prisma 反而删了 72 个包"，
实际只是失败安装的收尾。补好 `allowBuilds` 再 `pnpm install` 即恢复正常（`pnpm -r typecheck` 全绿为证）。

---

## 坑 3 — Prisma CLI 不该继承应用侧的全量配置

**问题**：`backend/src/config.ts` 已经是"启动即校验全部环境变量"的 zod schema。
如果 `prisma.config.ts` 去 import 它，会同时引入两个毛病：

1. **只想跑 `migrate` 却因缺 S3 / embedding / 主密钥而失败** —— CI 与临时排查场景都会中招
   （迁移只需要 `DATABASE_URL` 一个变量）。
2. 它是 ESM + `.js` 后缀的 TS，被 Prisma 的配置加载器（不是 tsc）读进来会踩模块解析差异。

**对策**：`prisma.config.ts` 自己用 `process.loadEnvFile` 加载 `infra/.env`
（定位逻辑与 `src/config.ts` 同源：向上找 `pnpm-workspace.yaml`；两个调试开关
`DOUBULEA_ENV_FILE` / `DOUBULEA_SKIP_ENV_FILE` 也保持一致），并按命令区分是否需要连接串：

```ts
const DATASOURCE_OPTIONAL_COMMANDS = new Set(['generate', 'validate', 'format', 'version', 'init'])
if (databaseUrl === '' && !DATASOURCE_OPTIONAL_COMMANDS.has(firstCommand())) {
  throw new Error('Prisma CLI 需要 DATABASE_URL，但当前环境里没有值。 …')
}
```

这样两件事同时成立：
- **CI 的 install / typecheck / build 阶段不需要注入任何数据库变量**（实测裸环境可跑，见下方验收记录）；
- 真要连库的命令缺变量时**大声失败并说清怎么修**，而不是拿空串去连、报出难懂的驱动错误。

---

## 坑 4 — `tables.external` 必须写全限定名

**现象**（探针期踩到）：

```
Error: P3023
For the current database, `externalTables` & `externalEnums` in your prisma config
must contain only fully qualified identifiers (e.g. `schema_name.table_name`).
```

**对策**：写 `public.messages`（本项目用 PG 默认 schema，与 `DATABASE_URL` 的 `?schema=public` 一致）。
本批最终没启用这个能力（见坑 5），但结论记在这里 —— 将来若确实需要（如升级 Prisma 后分区识别行为回退），
别在"只写表名"上再花时间。

---

## 坑 5（结论价值最高）— 反向探针证伪"分区表会被 `migrate dev` 重建"

**背景**：`06` P0-1-5 的坑预判写着「Prisma 对分区表的 `migrate` 支持脆弱 → 避免后续 `migrate dev`
尝试重建」，建议把分区"藏"起来。我第一版按这个思路做了：用 Prisma 7 的
`experimental.externalTables: true` + `tables: { external: ['public.messages'] }`
把 `messages` 声明为"外部管理"（Prisma 不比对结构、不生成迁移，但照常生成 Client 类型）。
**能跑通**，而且正是 Prisma 官方为这类场景提供的机制。

但随后意识到它的副作用比想象中大：**启用之后，将来给 `Message` 加字段、加索引，Prisma 都不会再生成迁移**，
开发者会看到 `migrate dev` 报「Already in sync」而以为无事发生，实际 `schema.prisma` 与库已经不一致 ——
这属于"静默不一致"，排查成本远高于"生成一条会失败的 DDL 然后报错"。

于是做了三组**反向探针**来判断"不藏起来"到底会不会出事（结论全部指向"不会"）：

**探针 A — 造一张无关表，看 Prisma 是否真的"看不见多余表"**

```bash
psql -c 'CREATE TABLE zzz_probe(id int);'
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```
```
-- DropTable
DROP TABLE "zzz_probe";
```

⇒ 它**不是**看不见多余对象，而是**明确把 14 个 `messages_YYYY_MM` 识别成分区子表、主动跳过**
（同一份 diff 里一个分区子表都没出现）。

**探针 B — 给 `Message` 加一列，看 `migrate dev` 生成什么**

```bash
# schema.prisma 里给 Message 临时加 probeCol，然后：
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```
```
-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "probe_col" TEXT;
```

⇒ 只有一条正常 `ALTER TABLE`（PG 会自动把列变更下推到各分区），**没有任何 DROP/CREATE 重建动作**。

**探针 C — 真的让 `migrate dev` 走完整条路（含影子库 diff）**

```bash
prisma migrate dev --create-only --name probe_partition_rebuild
```
```
Prisma Migrate created the following migration without applying it 20260921032355_probe_partition_rebuild
```
生成的 SQL 与探针 B 完全一致；随后还原 schema、删掉该探针迁移，
`migrate dev` 再次运行输出 `Already in sync, no schema change or pending migration was found.`
**没有 reset 提示、没有触碰分区子表。**

**最终决定**：**不启用** `tables.external`，`messages` 照常当普通模型管理。改动点：

- `prisma.config.ts` 去掉 `experimental` 与 `tables` 两段，并把上述结论写成文件头注释；
- `schema.prisma` 与 `0001_init/migration.sql` 的注释同步改为"照常管理"口径；
- `06` §七 待决事项 1 **关闭**，并把三条探针写进关闭记录。

**留下的应急开关**：若将来升级 Prisma 后分区识别行为回退（表现为 diff 里突然出现分区子表的 DROP），
按以下三步启用外部表即可（本批已验证可用）：

```ts
// backend/prisma.config.ts
experimental: { externalTables: true },
tables: { external: ['public.messages'] },   // ⚠️ 必须全限定名（坑 4）
```
代价是要接受「Message 的结构变更全部手写」——届时把这条规则写进 `06` §六 施工纪律。

---

## 坑 6 — 生成物放在 `src` 之外，strict 全家桶会不会被它拖垮

**顾虑**：`tsconfig.base.json` 开了 `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals` +
`verbatimModuleSyntax`，而 Prisma 生成的是**一堆 `.ts` 源文件**（不是 `.d.ts`），
`skipLibCheck` 管不到它们；一旦生成码里有未使用变量，`noUnusedLocals` 就会让 `pnpm build` 红。

**实测结论**：不用担心 —— 生成码每份文件头都带 `// @ts-nocheck`
（还有 `/* eslint-disable */` 与 biome 的忽略注释），tsc 不会对它们做类型检查。
本批 `pnpm -r typecheck` / `pnpm -r build` 在引入 Prisma 后首次运行即全绿。

**顺带定的三件事**：

1. 生成物放 `backend/generated/prisma`（在 `src` 外），已 gitignore，由 `build`/`typecheck` 前置的
   `db:generate` 重建 —— **故意不用 `postinstall`**：那会把"生成失败"变成"装不上依赖"，
   而 `prisma generate` 放在 build 里失败时信息更聚焦。
2. `.gitignore` 与 TS 的 `exclude` 都要加它；**ESLint 扁平配置不读 `.gitignore`**，
   所以 `eslint.config.mjs` 的 `ignores` 也要显式加 `backend/generated/**`（否则会去解析整份生成码）。
3. 业务代码统一从 `src/infra/prisma.ts` 拿客户端与枚举，不散落 `../../generated/prisma/...` 深路径。

---

## 坑 7 — 查询日志刷屏，且 `query` 事件的 `params` 里有 bcrypt 摘要

**现象 1（噪声）**：Prisma 的 `query` 日志是**每条 SQL 一行**，第一版跟着
`config.isDevelopment` 开（本地 `LOG_LEVEL=debug`），结果 `pnpm verify:db` 的 17 行 PASS/FAIL
被上百行 pino 输出淹没。

**现象 2（安全）**：`query` 事件形如 `{ query, params, duration, target }`，
其中 `params` 是**参数值**。本系统第一张表就是 `users.password_hash` ——
`prisma.user.create()` 会把 bcrypt 摘要打进日志。`02` §十「密钥零留痕」要求日志同样不得留痕，
而 pino 的 `redact` 是按**字段名**匹配的，藏不住塞在字符串里的参数值。

**对策**：

```ts
// ① 事件形态而非 'stdout'（后者会绕开 pino 的脱敏与 requestId 上下文）
log: [
  { emit: 'event', level: 'error' },
  { emit: 'event', level: 'warn' },
  // ② 查询级日志按 trace 档门控：它的粒度就是 trace（每条 SQL 一行），
  //    跟着 development 默认的 debug 开会把开发与验收日志全淹掉
  ...(config.logLevel === 'trace' ? [{ emit: 'event', level: 'query' } as const] : []),
]
// ③ 只打 SQL 文本与耗时，**刻意丢掉 params**
instance.$on('query', (event) => {
  getLogger().trace({ durationMs: event.duration, target: event.target }, 'Prisma 查询')
})
```

要看 SQL：`LOG_LEVEL=trace pnpm dev:backend`。要看真实参数：走 `pg_stat_statements`，
别把 `params` 加回日志。

---

## 附：两条 ESLint 10 规则拦下的写法（非 Prisma 问题，记一笔）

新脚本 `verify-db.mjs` 首版被两条规则判错，属"新规则不认识旧写法"：

| 规则 | 触发写法 | 改法 |
|------|---------|------|
| `no-useless-assignment` | `let output = ''` 后被 `try` 里的赋值覆盖 | 去掉初始值 `let output` |
| `preserve-caught-error` | `throw new Error(...)` 丢掉了原 error | 加 `{ cause: error }` |

---

## 验收实测记录（2026-09-21）

### ① 迁移：从空库应用 + 从零重放（可复现）

```
$ pnpm db:migrate
Datasource "db": PostgreSQL database "doubulea", schema "public" at "127.0.0.1:15432"
Applying migration `0001_init`
Your database is now in sync with your schema.

$ prisma migrate reset --force
Applying migration `0001_init`
Database reset successful
```

### ② `\dt` —— 22 张关系（7 张业务表 + 14 个分区 + `_prisma_migrations`）

```
 Schema |        Name        |       Type
--------+--------------------+-------------------
 public | _prisma_migrations | table
 public | agent_components   | table
 public | agents             | table
 public | conversations      | table
 public | messages           | partitioned table        ← 父表
 public | messages_2026_08   | table                    ← 上个月
 public | messages_2026_09   | table
 …（2026_10 … 2027_09 共 14 个分区）
 public | model_providers    | table
 public | models             | table
 public | users              | table
```

### ③ `\d messages` —— 验收门槛「显示分区」

```
                           Partitioned table "public.messages"
     Column      |            Type             | Nullable |      Default
-----------------+-----------------------------+----------+-------------------
 id              | uuid                        | not null |
 created_at      | timestamp(3) with time zone | not null | CURRENT_TIMESTAMP
 conversation_id | uuid                        | not null |
 role            | message_role                | not null |
 content         | jsonb                       | not null |
 tokens_in       | integer                     |          |
 tokens_out      | integer                     |          |
Partition key: RANGE (created_at)
Indexes:
    "messages_pkey" PRIMARY KEY, btree (id, created_at)
    "messages_conversation_id_created_at_idx" btree (conversation_id, created_at DESC)
Foreign-key constraints:
    "messages_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      ON UPDATE CASCADE ON DELETE CASCADE
Number of partitions: 14 (Use \d+ to list them.)
```

### ④ 结构无漂移（本批的坑预判断言化）

```
$ prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma
No difference detected.          # 退出码 0；有差异时该命令以退出码 2 结束（可直接进 CI 断言）
```

### ⑤ `pnpm verify:db` —— 17 项全通过

```
══ P0-1-5 数据层验收：数据模型 / 分区 / Prisma 客户端 ══
  [PASS] Prisma Client 可实例化，7 张表的委托齐备（"类型可用"的运行时侧证据）
  [PASS] 7 个枚举取值域与 docs/02 第三节 一致
  [PASS] messages 是分区表（pg_class.relkind = "p"，不是普通表 "r"）
  [PASS] 分区子表按月命名，数量 >= 12 且覆盖当月
         messages_2026_08 messages_2026_09 … messages_2027_09
  [PASS] 主键 = (id, created_at)：分区键已在主键内（PG 硬性要求）
  [PASS] 会话分页索引建在父表上，且已被分区继承（新分区会同样继承）
  [PASS] 分区维护函数 ensure_messages_partition 幂等（重复调用不报错、不新建）
  [PASS] Prisma 视角无结构漂移（migrate diff --exit-code = 0，即 06 坑预判已排除）
  [PASS] 建链路：user → provider → model → agent → conversation（各类默认值）
  [PASS] 唯一约束生效：重复 username → P2002（而不是静默写入两条）
  [PASS] agent_components：多态 ref_id 无 FK、同绑定不可重复、同 ref 不同类型可共存
         messages_2026_09×1  messages_2026_10×1  messages_2026_11×1
  [PASS] 跨月写入 3 条消息 → 分别落到 3 个不同分区（分区路由正确）
  [PASS] Prisma 跨分区读回 3 条，且 jsonb content 原样还原
  [PASS] 复合主键 findUnique 可用（@@id([id, createdAt]) 的调用口径）
         越界月份 messages_2024_09 的报错符合预期（吵但清晰）
  [PASS] 缺分区的月份插入**立刻**报错（"不建 DEFAULT 分区"的取舍取证）
  [PASS] 删会话级联删消息（分区表上的 FK 级联生效）
  [PASS] 删 Agent 级联删组件绑定（agent_components 的 Cascade 生效）

✅ P0-1-5 数据层验收通过：17 项全通过
```

补记两条关键原始输出：

```
# 分区路由（tableoid）——3 条消息落在 3 个分区
messages_2026_09 | 1
messages_2026_10 | 1
messages_2026_11 | 1

# 缺分区时的失败模式（刻意不建 DEFAULT 分区的取证）
ERROR: Database error. Code: `23514`.
       Message: `no partition of relation "messages" found for row`
```

### ⑥ 分区续期脚本 + 裸环境兼容

```
$ pnpm db:partitions
Script executed successfully.        # 幂等，重复跑不新建

$ DATABASE_URL= DOUBULEA_SKIP_ENV_FILE=1 pnpm --filter @doubulea/backend db:generate
✔ Generated Prisma Client (7.10.0) to ./generated/prisma in 47ms      # CI 的 install/build 阶段可跑

$ DATABASE_URL= DOUBULEA_SKIP_ENV_FILE=1 pnpm --filter @doubulea/backend db:status
Error: Prisma CLI 需要 DATABASE_URL，但当前环境里没有值。
  · 已加载的环境变量文件：（无）
  · 本机请确认 infra/.env 存在且 DATABASE_URL 非空（宿主端口见该文件注释）；
  · CI/容器场景请在环境里直接注入 DATABASE_URL。
```

### ⑦ 全链路无回归

```
$ pnpm lint          → eslint .            （0 问题）
$ pnpm -r typecheck  → shared/backend/frontend 三包 Done
$ pnpm -r build      → 三包 Done（backend build 内含 prisma generate）
$ pnpm verify:app    → ✅ 12 项全通过（P0-1-4 的接口级契约未受影响）
$ pnpm config:check  → 脱敏配置正常打印，退出码 0
```

---

## 遗留与后续注意

1. **`usage_records`（P1）按月分区时照抄本批套路**：分区键入主键 + 动态窗口 + 续期脚本
   （`prisma/sql/` 再加一个文件），并在 `0003` 及以后的迁移里手写 DDL。
2. **分区续期目前靠人跑 `pnpm db:partitions`**。生产形态应挂 cron 或纳入部署流程 ——
   属于 P0-3 的部署收尾（`06` §四/P0-3 骨架），本批不引入定时任务。
3. **`DATABASE_POOL_MAX` 刻意没做成环境变量**（Prisma 池固定 `max: 10`，`pg` 默认值）：
   等压测暴露瓶颈再走「`.env.example` + `02` §十一 + `config.ts`」的正规流程。
4. **`users.username` 的大小写归一在服务层**（P0-1-7）：本批只落了大小写敏感的唯一约束，
   若 P0-1-7 忘了归一，会出现「Admin 与 admin 是两个账号」——届时在 auth.service 里统一 `trim().toLowerCase()`。
5. **P0-1-9 的 `prisma/seed.ts` 已在 `prisma.config.ts` 里登记**（`seed: 'tsx prisma/seed.ts'`），
   文件本身尚未创建；注意 v7 起 `migrate dev` / `migrate reset` **不再自动跑 seed**，
   要显式 `pnpm db:seed`（P0-1-9 落地时补该脚本）。
6. **上游版本要盯住**：`npm view` 显示 `prisma` 的 `latest` 标签已指向 **`8.0.0-rc.15`（RC）**，
   而 `@prisma/client` 的 `latest` 仍是稳定版 **`7.10.0`** —— 本批刻意把三件套（`prisma` /
   `@prisma/client` / `@prisma/adapter-pg`）一起锁在 `^7.10.0`，避免 CLI 与运行时版本错配。
   升级到 8 之前先重跑本文件坑 5 的三组探针，确认分区识别行为没变。
