/**
 * Prisma CLI 配置（P0-1-5）
 *
 * 依据：`docs/02-后端设计.md` §一（Prisma）、§三（messages 按月分区 + 待决事项 1）
 *
 * ── 为什么需要这个文件（Prisma 7 的变化）──────────────────────────────────
 * v7 起 Prisma CLI 的数据库连接、schema 位置、迁移目录、seed 脚本统一从这里读，
 * `schema.prisma` 的 `datasource.url` 已废弃。文件必须放在**本包根目录**
 * （即 `package.json` 所在处）—— Prisma 从 cwd 向上发现 `prisma.config.ts`，
 * 因此所有 `prisma` 命令都要在 `backend/` 下执行（根 `package.json` 的 `db:*` 脚本已封装）。
 *
 * ── 为什么自己加载 env，而不是 import `src/config.ts` ─────────────────────
 * 刻意**不复用** `backend/src/config.ts`：
 *   1. 迁移只需要 `DATABASE_URL` 一个变量。让它依赖 zod 全量 schema（S3 / embedding /
 *      主密钥…）意味着「只想跑个 migrate，却因为没配 S3 而失败」——CI 与临时环境都会中招。
 *   2. `src/config.ts` 是 ESM + `.js` 后缀的 TS，被 Prisma 的配置加载器（非 tsc）读进来
 *      会踩模块解析差异。
 * 代价是这里有一小段「向上找 pnpm-workspace.yaml → 加载 infra/.env」的重复逻辑；
 * 两个调试开关（`DOUBULEA_ENV_FILE` / `DOUBULEA_SKIP_ENV_FILE`）保持一致，
 * 否则排查环境问题时两套语义会互相打脸。
 *
 * ── 为什么这里**没有** tables.external（P0-1-5 实测结论，反直觉）───────────────
 * `messages` 在库里是 `PARTITION BY RANGE (created_at)` 的分区表（`02` §三 分区说明），
 * 而 Prisma 没有分区语法 —— 于是 `docs/06` P0-1-5 的坑预判担心
 * 「后续 `migrate dev` 会尝试重建分区表」。
 *
 * 实测结论：**不会，无需处理**。Prisma 7.10.0 的内省能正确识别分区关系：
 *   · `prisma migrate diff --from-config-datasource --to-schema` → `No difference detected.`
 *     （手写 SQL 建的分区父表 + 14 个月度子表，Prisma 一处都没判为"多余对象"）
 *   · 反向探针：手工建一张无关表 → 立即生成 `DROP TABLE "zzz_probe";`
 *     ⇒ 说明它**不是**"看不见多余表"，而是明确把分区子表识别成分区、主动跳过。
 *   · 给 Message 模型加一列后 `migrate dev --create-only` → 只生成
 *     `ALTER TABLE "messages" ADD COLUMN "probe_col" TEXT;`（PG 会自动下推到各分区），
 *     **没有**任何 DROP/CREATE 重建动作，也没有触发 reset 提示。
 *
 * 既然 Prisma 原生就能正确管理这张表，就没有理由再去开
 * `experimental.externalTables` + `tables.external`（Prisma 7 提供的能力，本批已验证过一遍）：
 * 那会让**将来对 Message 模型的任何结构变更都不再生成迁移**，属于"静默不一致"，
 * 比"生成一条会失败的 DDL 然后报错"危险得多。
 * 该能力留作升级 Prisma 后若分区识别行为回退时的应急开关，用法记在
 * `issue_fix/问题记录-P0-1-5-数据模型与Prisma基线.md`。
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'prisma/config'

/** 本文件所在目录（= backend/） */
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url))
/** 工作区根标志文件（与 src/config.ts 同一约定，用于跨平台定位 `infra/.env`） */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml'
const ENV_FILE_OVERRIDE = 'DOUBULEA_ENV_FILE'
const ENV_FILE_SKIP = 'DOUBULEA_SKIP_ENV_FILE'
/** 向上回溯层数上限（避免异常目录结构下无限循环） */
const MAX_ANCESTOR_HOPS = 8

/**
 * 定位 `infra/.env`：优先 `DOUBULEA_ENV_FILE` 显式指定，其次从本目录向上找
 * 含 `pnpm-workspace.yaml` 的目录。找不到就返回 undefined（CI 靠注入的环境变量跑）。
 */
function resolveEnvFile(): string | undefined {
  const skip = (process.env[ENV_FILE_SKIP] ?? '').trim().toLowerCase()
  if (skip === '1' || skip === 'true') return undefined

  const override = (process.env[ENV_FILE_OVERRIDE] ?? '').trim()
  if (override !== '') {
    const target = isAbsolute(override) ? override : resolve(process.cwd(), override)
    return existsSync(target) ? target : undefined
  }

  let dir = CONFIG_DIR
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    const candidate = resolve(dir, 'infra/.env')
    if (existsSync(candidate)) return candidate
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

// 12-factor 语义与 src/config.ts 一致：**已存在的进程环境变量不被文件覆盖**
// （`process.loadEnvFile` 的行为就是如此），故容器/CI 注入的值优先。
const envFile = resolveEnvFile()
if (envFile !== undefined) process.loadEnvFile(envFile)

const databaseUrl = (process.env.DATABASE_URL ?? '').trim()

/**
 * 哪些命令不需要数据库连接。其余命令缺 `DATABASE_URL` 时应当**大声失败**，
 * 而不是悄悄退化（否则 `migrate dev` 会拿一个空 url 去连，报出难懂的驱动错误）。
 */
const DATASOURCE_OPTIONAL_COMMANDS = new Set(['generate', 'validate', 'format', 'version', 'init'])

/** `prisma migrate dev` → 子命令 `migrate`；`prisma generate` → `generate` */
function firstCommand(): string {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  return (args[0] ?? '').trim()
}

if (databaseUrl === '' && !DATASOURCE_OPTIONAL_COMMANDS.has(firstCommand())) {
  throw new Error(
    [
      'Prisma CLI 需要 DATABASE_URL，但当前环境里没有值。',
      `  · 已加载的环境变量文件：${envFile ?? '（无）'}`,
      '  · 本机请确认 infra/.env 存在且 DATABASE_URL 非空（宿主端口见该文件注释）；',
      '  · CI/容器场景请在环境里直接注入 DATABASE_URL。',
    ].join('\n'),
  )
}

export default defineConfig({
  /** 单个 schema 文件；将来若拆多文件，改成目录路径即可 */
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    /** `prisma db seed` 的入口（脚本文件在 P0-1-9 落地；v7 起迁移不再自动跑 seed） */
    seed: 'tsx prisma/seed.ts',
  },
  // 缺 DATABASE_URL 时**整个键都不给** —— 此时仍在白名单内的命令（generate 等）
  // 不需要连接，Prisma 允许 datasource 缺省；给了空串反而会被当成非法 url 拒绝。
  ...(databaseUrl === '' ? {} : { datasource: { url: databaseUrl } }),
})
