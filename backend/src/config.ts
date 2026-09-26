/**
 * 后端配置：环境变量 → 强类型 `config`（P0-1-3）
 *
 * 依据：`docs/02-后端设计.md` §十一（配置清单）+ `docs/子方案/知识库流水线.md` §二（参数总表增量）
 * 真相来源：`infra/.env.example`（模板）/ `infra/.env`（本机，gitignore）
 *
 * 三条约定：
 * 1. **启动即校验**：模块被 import 时就完成校验；缺必填项/格式非法 → stderr 打印
 *    「缺哪几项 + 怎么修」并 `exit 1`（不进入半可用状态）。
 * 2. **进程环境优先**：先按需加载 `infra/.env`，但**不覆盖**已存在的环境变量
 *    （Node `process.loadEnvFile` 行为）—— 容器/CI 注入的值永远压过本机文件。
 * 3. **密钥不出日志**：`credentialMasterKey` 以解码后的 Buffer 持有；打印配置一律走
 *    {@link describeConfig}（只报「是否已设置」，绝不回显明文）。
 *
 * 加载顺序提示：本模块必须**先于** `infra/logger.ts` 求值（logger 依赖 config 的日志级别），
 * 校验失败时 logger 尚不存在，故失败报告走 `console.error`（唯一例外，见 §失败报告）。
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

/** 本文件所在目录（源码期 `backend/src`；构建后 `backend/dist/backend/src`）—— 用于向上找工作区根 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
/** 工作区根标志文件（`06` §3.0：单仓 + pnpm workspace） */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml'
/** 默认环境变量文件（相对工作区根） */
const DEFAULT_ENV_FILE = 'infra/.env'
/** 向上回溯层数上限（源码/产物两级 + 余量，避免异常目录结构下无限循环） */
const MAX_ANCESTOR_HOPS = 8
/** 允许的环境变量文件路径覆写 / 跳过开关（供 CI、验收脚本与容器使用） */
const ENV_FILE_OVERRIDE = 'DOUBULEA_ENV_FILE'
const ENV_FILE_SKIP = 'DOUBULEA_SKIP_ENV_FILE'

// ───────────────────────────── 日志级别 / 枚举类型 ─────────────────────────────

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const NODE_ENVS = ['development', 'test', 'production'] as const
export type NodeEnv = (typeof NODE_ENVS)[number]

export const EMBEDDING_MODES = ['local', 'api'] as const
export type EmbeddingMode = (typeof EMBEDDING_MODES)[number]

// ───────────────────────────── 环境变量文件定位与加载 ─────────────────────────────

/** `infra/.env` 的定位结果（`--check-config` 与启动日志都会带上，便于排查） */
export interface EnvFileInfo {
  /** 实际加载的文件绝对路径；未加载任何文件时为 undefined */
  path: string | undefined
  /** 人类可读说明：为什么加载 / 为什么没加载 */
  note: string
}

/** 从 `from` 向上查找工作区根（含 `pnpm-workspace.yaml` 的目录） */
export function findWorkspaceRoot(from: string = MODULE_DIR): string | undefined {
  let dir = from
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 定位要加载的环境变量文件（不加载，只解析）。
 * 优先级：`DOUBULEA_ENV_FILE` 显式指定 > 工作区根 `infra/.env` > cwd 及上级的 `infra/.env`。
 * 注意：源码期与产物期的 `MODULE_DIR` 深浅不同，故一律用「向上找标志文件」而非相对层数。
 */
export function resolveEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  from: string = MODULE_DIR,
): EnvFileInfo {
  const skip = (env[ENV_FILE_SKIP] ?? '').trim().toLowerCase()
  if (skip === '1' || skip === 'true') {
    return { path: undefined, note: `${ENV_FILE_SKIP}=1 —— 只读进程环境，未加载任何文件` }
  }

  const override = (env[ENV_FILE_OVERRIDE] ?? '').trim()
  if (override !== '') {
    const target = isAbsolute(override) ? override : resolve(process.cwd(), override)
    return existsSync(target)
      ? { path: target, note: `${ENV_FILE_OVERRIDE} 显式指定` }
      : { path: undefined, note: `${ENV_FILE_OVERRIDE} 指向的文件不存在：${target}` }
  }

  const candidates: string[] = []
  const root = findWorkspaceRoot(from)
  if (root !== undefined) candidates.push(resolve(root, DEFAULT_ENV_FILE))
  candidates.push(resolve(process.cwd(), DEFAULT_ENV_FILE))
  candidates.push(resolve(process.cwd(), '..', DEFAULT_ENV_FILE))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, note: '自动发现（工作区根/cwd）' }
  }
  return {
    path: undefined,
    note: `未找到 ${DEFAULT_ENV_FILE}（已尝试：${candidates.join(' / ')}）—— 直接使用进程环境变量`,
  }
}

/**
 * 加载环境变量文件到 `process.env`。
 * 语义：**已存在的变量不被覆盖**（容器/CI/shell 传入的值优先），与 12-factor 一致。
 */
export function loadEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  from: string = MODULE_DIR,
): EnvFileInfo {
  const info = resolveEnvFile(env, from)
  if (info.path !== undefined) process.loadEnvFile(info.path)
  return info
}

// ───────────────────────────── zod 基元（空串 = 未设置）─────────────────────────────

/** `.env` 里 `KEY=` 会得到空字符串 —— 一律按「未设置」处理，才能触发必填/默认值语义 */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

/**
 * 「有默认值」的变量：未设置**与空串**都走默认值。
 *
 * ⚠️ 为什么不直接 `.default()`：zod 的默认值只在**最外层输入为 undefined** 时短路，
 * 而 `.env` 里的 `KEY=` 是空字符串（不是 undefined）—— 会被 preprocess 变成 undefined
 * 再喂给内层 schema，于是绕过默认值并报 "Required"。本函数把「空 → 默认值」前置收口。
 *
 * 注意 `fallback` 的类型是**输入类型**（`z.input`）：默认值会原样喂给内层 schema，
 * 由它自己校验/变换（如字节数要再走一次 "100MB" → bytes 的解析）。
 */
function defaultedVar<T extends z.ZodTypeAny>(schema: T, fallback: z.input<T>): z.ZodType<z.output<T>> {
  return z.preprocess((value) => emptyToUndefined(value) ?? fallback, schema)
}

/** 必填文本；缺省消息指名道姓，便于失败报告直接可用 */
const requiredText = (label: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string({ required_error: `${label} 未设置（必填）` })
      .trim()
      .min(1, `${label} 不能为空`),
  )

/** 可选文本（空串 → undefined，不落空字符串） */
const optionalText = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional())

/** 逗号分隔的来源列表（CORS 白名单） */
const splitList = (raw: string): string[] =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

/**
 * CORS 来源白名单（`CORS_ORIGINS`，逗号分隔，如 `http://localhost:5174,https://ops.internal`）。
 *
 * ⚠️ 刻意**不允许 `*`**：本服务用 Cookie 会话（`02` §十），`Access-Control-Allow-Origin: *`
 * 与 `credentials` 无法共存，浏览器会直接拒绝；且「反射任意来源 + 带凭据」是实质性的越权面。
 * 未设置时（开发期）由 app.ts 反射请求 Origin，生产未设置则启动告警（见下方 warnings）。
 */
const corsOriginsVar = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      for (const origin of splitList(value)) {
        if (origin === '*') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'CORS_ORIGINS 不能含 *（与 Cookie 凭据冲突）；请逐个列出来源，如 http://localhost:5174',
          })
          continue
        }
        try {
          const parsed = new URL(origin)
          if (parsed.origin !== origin) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${origin} 不是「来源」写法（须为 scheme://host[:port]，不带路径），实际解析为 ${parsed.origin}`,
            })
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${origin} 不是合法来源（示例：http://localhost:5174）`,
          })
        }
      }
    })
    .transform(splitList)
    .optional(),
)

/** 必填连接串 + 协议白名单（避免把 redis:// 填进 DATABASE_URL 这类低级错） */
const requiredUrl = (label: string, schemes: readonly string[]) => {
  const allowed = schemes.map((scheme) => `${scheme}://`).join(' 或 ')
  return requiredText(label).refine(
    (value) => {
      try {
        return schemes.includes(new URL(value).protocol.replace(':', '').toLowerCase())
      } catch {
        return false
      }
    },
    { message: `${label} 不是合法连接串（须以 ${allowed} 开头）` },
  )
}

/** 可选 URL（出现时必须合法） */
const optionalUrl = (label: string, schemes: readonly string[]) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .refine(
        (value) => {
          try {
            return schemes.includes(new URL(value).protocol.replace(':', '').toLowerCase())
          } catch {
            return false
          }
        },
        { message: `${label} 不是合法 URL（须以 ${schemes.map((s) => `${s}://`).join(' 或 ')} 开头）` },
      )
      .optional(),
  )

/** 整型变量：未设置/空串 → 默认值 */
const intVar = (label: string, fallback: number, options: { min?: number; max?: number } = {}) => {
  const min = options.min ?? 1
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  return defaultedVar(
    z
      .coerce.number({ invalid_type_error: `${label} 必须是数字` })
      .int(`${label} 必须是整数`)
      .min(min, `${label} 不能小于 ${min}`)
      .max(max, `${label} 不能大于 ${max}`),
    fallback,
  )
}

/**
 * 正浮点数变量：未设置/空串 → 默认值。
 * 与 `intVar` 的唯一区别是**不要求整数** —— 沙箱的 CPU 限额就是「1.5 核」这种量。
 * （别为了用它把 `intVar` 放宽成 `number`：`CHUNK_SIZE_DEFAULT` 那类"必须是整数"的口径
 *  正是靠 `.int()` 守着的。）
 */
const floatVar = (label: string, fallback: number, options: { min?: number; max?: number } = {}) => {
  const min = options.min ?? 0.01
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  return defaultedVar(
    z
      .coerce.number({ invalid_type_error: `${label} 必须是数字` })
      .min(min, `${label} 不能小于 ${min}`)
      .max(max, `${label} 不能大于 ${max}`),
    fallback,
  )
}

/** 0–1 之间的小数（相似度阈值等） */
const ratioVar = (label: string, fallback: number) =>
  defaultedVar(
    z
      .coerce.number({ invalid_type_error: `${label} 必须是数字` })
      .min(0, `${label} 不能小于 0`)
      .max(1, `${label} 不能大于 1`),
    fallback,
  )

/** 布尔变量（1/0/true/false/yes/no）；未设置/空串 → undefined（由调用方决定默认） */
const optionalBoolVar = (label: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(['1', '0', 'true', 'false', 'yes', 'no'], {
        errorMap: () => ({ message: `${label} 只能是 1/0/true/false/yes/no` }),
      })
      .transform((value) => value === '1' || value === 'true' || value === 'yes')
      .optional(),
  )

/**
 * 字节数：接受 `100MB` / `512KB` / `104857600` 三种写法。
 * 依据：`02` §十一 `UPLOAD_BODY_LIMIT`（默认 100MB）。
 */
const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
}

export function parseByteSize(input: string | number): number | undefined {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined
  }
  const matched = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(input.trim())
  if (matched === null) return undefined
  const value = Number(matched[1])
  const unit = (matched[2] ?? 'b').toLowerCase()
  const factor = BYTE_UNITS[unit]
  if (factor === undefined || !Number.isFinite(value)) return undefined
  return Math.floor(value * factor)
}

/** 字节数变量：保留原始写法（回显用）+ 解析成数值（bodyLimit 用） */
const byteSizeVar = (label: string, fallback: string) =>
  defaultedVar(
    z.string().trim().transform((raw, ctx) => {
      const bytes = parseByteSize(raw)
      if (bytes === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} 无法解析（示例：100MB / 512KB / 104857600）`,
        })
        return z.NEVER
      }
      return { raw, bytes }
    }),
    fallback,
  )

/**
 * 凭据加密主密钥（`02` §九/§十）：**必须 32 字节的 base64**。
 * 校验三件事：能解码成 32 字节、是规范 base64（防手抖塞进乱码）、能解码。
 * 失败消息里直接给生成命令 —— 坑预判里点名的「要给出怎么生成」。
 */
const credentialMasterKeyVar = z.preprocess(
  emptyToUndefined,
  z
    .string({ required_error: 'CREDENTIAL_MASTER_KEY 未设置（必填）' })
    .trim()
    .superRefine((value, ctx) => {
      const decoded = Buffer.from(value, 'base64')
      if (decoded.length === 32 && decoded.toString('base64') === value) return
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `必须是 32 字节的 base64（当前解码后 ${decoded.length} 字节）；` +
          '生成：openssl rand -base64 32',
      })
    }),
)

// ───────────────────────────── 环境变量 schema（键名 = 变量名）─────────────────────────────

/**
 * 键名刻意保持环境变量的原样（SCREAMING_SNAKE），因为：
 * ① 失败报告要把 zod issue 的 `path[0]` 直接当变量名打印；
 * ② 与 `infra/.env.example` 逐行可对照，新增变量时不易漏。
 */
const envSchema = z
  .object({
    // ── 运行期 ──
    NODE_ENV: defaultedVar(
      z.enum(NODE_ENVS, { errorMap: () => ({ message: `NODE_ENV 只能是 ${NODE_ENVS.join('/')}` }) }),
      'development',
    ),
    BACKEND_PORT: intVar('BACKEND_PORT', 3000, { min: 1, max: 65535 }),
    LOG_LEVEL: defaultedVar(
      z.enum(LOG_LEVELS, { errorMap: () => ({ message: `LOG_LEVEL 只能是 ${LOG_LEVELS.join('/')}` }) }),
      'info',
    ),
    LOG_PRETTY: optionalBoolVar('LOG_PRETTY'),
    /** CORS 来源白名单（P0-1-4 起生效）；留空 = 开发期反射请求 Origin */
    CORS_ORIGINS: corsOriginsVar,
    /** /health 单项依赖探活超时（P0-1-4；坑预判：PG 挂起不能让探活永不返回） */
    HEALTH_TIMEOUT_MS: intVar('HEALTH_TIMEOUT_MS', 2000, { min: 100, max: 60_000 }),

    // ── 外部依赖（必填）──
    DATABASE_URL: requiredUrl('DATABASE_URL', ['postgresql', 'postgres']),
    REDIS_URL: requiredUrl('REDIS_URL', ['redis', 'rediss']),
    S3_ENDPOINT: requiredUrl('S3_ENDPOINT', ['http', 'https']),
    S3_KEY: requiredText('S3_KEY'),
    S3_SECRET: requiredText('S3_SECRET'),
    S3_BUCKET: requiredText('S3_BUCKET'),
    CREDENTIAL_MASTER_KEY: credentialMasterKeyVar,

    // ── 会话与安全（P0-1-6；`02` §十）──
    /**
     * 会话有效期（小时）。命中后按**半衰期滑动续期**（见 `infra/redis.ts` 的 readSession），
     * 因此「活跃用户不会被踢下线、闲置用户按此上限过期」。
     */
    SESSION_TTL_HOURS: intVar('SESSION_TTL_HOURS', 12, { min: 1, max: 720 }),
    /**
     * 「每请求校验 `user.status`」的缓存窗口（秒）。`02` §十 点名 60s ——
     * 窗口内的状态变更由**写侧的主动失效**兜住（`plugins/session.ts#invalidateUserSnapshot`），
     * 缓存只兜底非本机写入（直接在库里改状态）的场景。
     */
    USER_STATUS_CACHE_TTL_SEC: intVar('USER_STATUS_CACHE_TTL_SEC', 60, { min: 1, max: 600 }),
    /** 会话 Cookie 是否加 `Secure`；未设置时跟随 `NODE_ENV=production` */
    SESSION_COOKIE_SECURE: optionalBoolVar('SESSION_COOKIE_SECURE'),

    // ── embedding 双模式（决策 26 / `02` §八）──
    EMBEDDING_MODE: defaultedVar(
      z.enum(EMBEDDING_MODES, { errorMap: () => ({ message: `EMBEDDING_MODE 只能是 ${EMBEDDING_MODES.join('/')}` }) }),
      'local',
    ),
    EMBEDDING_API_URL: optionalUrl('EMBEDDING_API_URL', ['http', 'https']),
    EMBEDDING_API_KEY: optionalText,
    EMBEDDING_API_MODEL: optionalText,
    LOCAL_EMBEDDING_MODEL_PATH: defaultedVar(z.string().trim().min(1), '/models/bge-m3-int8'),
    /**
     * 本地推理**运行时**模块（P0-1-13）：导出 `createEmbedder({ modelPath, dim })`，
     * 契约见 `02` §八。默认空 = local 模式尚未就绪（待决事项 2：bge-m3 交付物形态未定）。
     */
    LOCAL_EMBEDDING_RUNTIME_MODULE: optionalText,
    /**
     * 一次 embedding 请求塞多少条文本（`子方案①` §4-3 的 `chunk_embed_batch`）。
     * P0-1-15 建库时把它连同 chunk_size 一起**快照**进 KB 的入库参数。
     */
    EMBEDDING_BATCH_SIZE: intVar('EMBEDDING_BATCH_SIZE', 32, { min: 1, max: 512 }),
    EMBEDDING_DIM: intVar('EMBEDDING_DIM', 1024, { min: 1 }),

    // ── 并发与限额（`02` §十一）──
    CHATBOT_CONCURRENCY: intVar('CHATBOT_CONCURRENCY', 50),
    SANDBOX_CONCURRENCY: intVar('SANDBOX_CONCURRENCY', 10),
    SANDBOX_IDLE_TTL_MIN: intVar('SANDBOX_IDLE_TTL_MIN', 30),
    PIPELINE_CONCURRENCY: intVar('PIPELINE_CONCURRENCY', 2),
    UPLOAD_BODY_LIMIT: byteSizeVar('UPLOAD_BODY_LIMIT', '100MB'),
    SSE_PING_INTERVAL_SEC: intVar('SSE_PING_INTERVAL_SEC', 20),
    CONTEXT_ROUNDS: intVar('CONTEXT_ROUNDS', 20),
    TOOL_LOOP_LIMIT: intVar('TOOL_LOOP_LIMIT', 10),
    /**
     * ⚠️ **P0 不生效但保留登记**（`子方案④` §三 2 / §二）：下载形态由签名 URL 改为**后端流式代理**
     * （决定性理由是 HTML/SVG 的 CSP 隔离头只有我方响应头加得上）⇒ "签名 URL 时效"无处可用。
     * 保留它的唯一理由是 P1 若改回签名 URL，这一项**自动生效**（届时还需 `S3_PUBLIC_ENDPOINT`）。
     * **不要**因为"这一项没用"就把它从 `.env` 删掉 —— 删了等于把 P1 的开关也删了。
     */
    ARTIFACT_URL_TTL_MIN: intVar('ARTIFACT_URL_TTL_MIN', 30),

    // ── 沙箱与产物（P0-3-1 首次落地；参数总表 = `子方案/沙箱与引擎集成.md` §二）──
    /**
     * ⚠️ **除 `SANDBOX_IDLE_TTL_MIN` 外，本段全部是「登记但不消费」**（P0-3-1 只做镜像预构建）：
     * 消费方分别是 P0-3-2（容器与配额）、P0-3-3（网络出口）、P0-3-7（产物扫描与保留期）。
     * 一次登记完是刻意的 —— 每批回来改一次 zod schema 会让"缺哪一项"这类失败报告反复变形
     * （同一手法见 MCP 段与 `SANDBOX_IMAGE`）。
     */
    /** 最终镜像 = **toolkit 层**（`子方案③` §五 1）；值由 `pnpm sandbox:build` 打印 */
    SANDBOX_IMAGE: optionalText,
    /** base 层镜像（Node + pin 版 pi + 桥扩展）；toolkit 层 `FROM` 它 */
    SANDBOX_IMAGE_BASE: optionalText,
    /** 单容器内存上限（MB）。**主限额** —— 10 并发的真实瓶颈是内存，不是核（§二） */
    SANDBOX_MEM_LIMIT_MB: intVar('SANDBOX_MEM_LIMIT_MB', 2048, { min: 128, max: 65_536 }),
    /** 单容器 CPU 上限（核）。为辅：只防单容器跑飞拖垮宿主 ⇒ 可以是 1.5 这样的小数 */
    SANDBOX_CPU_LIMIT: floatVar('SANDBOX_CPU_LIMIT', 1.5, { min: 0.1, max: 64 }),
    /** 单容器进程数上限。防 fork 炸弹，但 pandas / node 都要开子进程 ⇒ 别给小（§二） */
    SANDBOX_PIDS_LIMIT: intVar('SANDBOX_PIDS_LIMIT', 512, { min: 16, max: 65_536 }),
    /**
     * work 卷上限（MB，落成 `--storage-opt size=`）。
     * ⚠️ 需要 overlay2 + xfs + pquota 才生效；**本机是否生效属待决事项 2**（P0-3-3 实测），
     * 不生效时的降级方案是"定期 `du` 巡检 + 超限告警"，**不假装有配额**（§九 1）。
     */
    SANDBOX_WORK_VOLUME_MB: intVar('SANDBOX_WORK_VOLUME_MB', 1024, { min: 64, max: 1_048_576 }),
    /** 容器 `/tmp`（tmpfs，`nosuid,nodev,noexec`）。只放小临时文件，大产物落 work 卷 */
    SANDBOX_TMPFS_MB: intVar('SANDBOX_TMPFS_MB', 64, { min: 1, max: 65_536 }),
    /**
     * 沙箱代理 listener 的端口（**内网**，只有沙箱专用 bridge 可达；与 `BACKEND_PORT` 分开）。
     * ⚠️ P0 的 `BACKEND_PORT` 是 13000 ⇒ 这里取 13001，不要顺手写成 13000。
     */
    SANDBOX_CALLBACK_PORT: intVar('SANDBOX_CALLBACK_PORT', 13001, { min: 1, max: 65_535 }),
    /** per-container token 长度（字符）。43 = `randomBytes(32)` 的 base64url，与会话令牌同规格 */
    SANDBOX_TOKEN_LEN: intVar('SANDBOX_TOKEN_LEN', 43, { min: 16, max: 256 }),
    /**
     * 容器侧调代理的超时（秒）。
     * ⚠️ **必须 > `MCP_CONFIRM_TIMEOUT_SEC`**（否则用户在确认卡上点时容器已经放弃）——
     * 这条跨字段约束写在下面的 `superRefine` 里，不靠注释提醒。
     */
    SANDBOX_PROXY_TIMEOUT_SEC: intVar('SANDBOX_PROXY_TIMEOUT_SEC', 180, { min: 1, max: 3600 }),
    /**
     * 沙箱出公网的 egress 代理（只放行模型池 baseURL，§四 3 出口①）。
     *
     * ✅ **P0-3-3 定案：落成「HTTP 代理 + 容器环境变量」，值就是本项**（不再走 iptables 白名单方案）。
     * 依据是一次源码级实测：pi 把 `undici.EnvHttpProxyAgent` 装成全局 dispatcher
     * （包内 `dist/core/http-dispatcher.js`），该 agent **自己读 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`**；
     * pi 的设置项 `httpProxy` 只是"`process.env.HTTP_PROXY ??= <值>`"（即**环境变量优先**）
     * ⇒ 我们**不必**往只读 agent-dir 里烤一个固定值（`子方案③` §十三 待决 7 就此关闭）。
     *
     * ⚠️ **仍然保持"可选"**：不在启动期收紧成必填（那会让每一台没配代理的机器上 `pnpm config:check`
     * 都红，却证不出任何东西），而是在**用它的那一刻**显式失败 —— `sandbox/manager.ts#ensureSandbox`
     * 见不到它就回 `NOT_CONFIGURED` 并说明后果（同 P0-2 的 `resolveChatTarget()` 没 Key ⇒ 424）。
     */
    SANDBOX_EGRESS_PROXY_URL: optionalUrl('SANDBOX_EGRESS_PROXY_URL', ['http', 'https']),
    /**
     * **容器眼里**"后端沙箱代理"的地址（`子方案③` §四 3 出口②；P0-3-3 落地）。
     *
     * 默认（不设）= 由专用 bridge 的**网关地址**（从 Docker 里读出来，`sandbox/network.ts`）
     * + `SANDBOX_CALLBACK_PORT` 拼出 —— 那是"后端与 Docker 同宿主"的部署形态（= 生产）。
     * **不做 DNS 猜测、不做兜底**（`06` §六 27）。
     *
     * ⚠️ 显式覆盖只为一类部署：**Docker 跑在虚拟机里**（macOS 上的 OrbStack / Docker Desktop）
     * ⇒ 容器**到不了**跑在 macOS 上的后端（P0-3-3 实测 `ENETUNREACH`：bridge 网关是那台 VM，
     * 不是 macOS）⇒ 那时把它指到一个与沙箱网络双宿的中转地址。生产用不到它。
     */
    SANDBOX_BACKEND_URL: optionalUrl('SANDBOX_BACKEND_URL', ['http']),
    /**
     * 沙箱代理 listener 的**绑定地址**（`02` §4.10；P0-3-3 定案 = 独立 Fastify 实例）。
     *
     * 默认（不设）= 专用 bridge 的网关地址 ⇒ **只有该 bridge 内的容器可达**，
     * 于是"容器能调后端"不会扩成"容器能调到业务 API 的同一台 listener"（暴露面收敛是刻意的）。
     *
     * ⚠️ 覆盖成 `0.0.0.0` 是为上面 `SANDBOX_BACKEND_URL` 说的那类部署
     * （后端不在 Docker 宿主上时，中转容器得连得上它）。
     */
    SANDBOX_LISTEN_HOST: optionalText,
    /**
     * 沙箱**排队队列**的 Redis 键（P0-3-2）。
     *
     * 与 `PIPELINE_QUEUE_KEY` 同一条推理、同一个理由：`REDIS_URL` 是共享资源，
     * 而队列是**被消费**的资源 ⇒ 两个进程用同一个键时"谁取走"是随机的，
     * 症状不是报错而是"验收时好时坏"。可换键 = 可隔离消费方。
     */
    SANDBOX_QUEUE_KEY: defaultedVar(z.string().trim().min(1), 'sandbox:queue'),
    /**
     * 排队项的存活时长（秒，P0-3-2）。**两个语义共用一个数，是刻意的**：
     *   ① 它是"这条排队项什么时候算孤儿"（对应它的那条 SSE 流已经断了）；
     *   ② 它是**等待预算** —— 等这么久还拿不到名额就报超时（而不是无限挂着）。
     * 两者合一是因为"等了 X 秒还在等"与"这条项已经没人要了"在行为上应当是同一条线；
     * 分开设两个数只会造出"已经没人等、但它还占着位置"的中间态。
     */
    SANDBOX_QUEUE_TTL_SEC: intVar('SANDBOX_QUEUE_TTL_SEC', 600, { min: 10, max: 86_400 }),
    /**
     * 周期对账（孤儿回收 + 空闲回收）的间隔（秒，P0-3-2）。
     * 定成配置项的理由与所有"窗口类"参数相同：**要能注入小值才验得了一条"等它回收"的断言**，
     * 而 60 秒的默认值是"人工操作也有机会看到结果"与"不空转"之间的折中。
     */
    SANDBOX_REAP_INTERVAL_SEC: intVar('SANDBOX_REAP_INTERVAL_SEC', 60, { min: 5, max: 3600 }),
    /**
     * `CREATING` 行/容器的宽限期（秒，P0-3-2）。
     *
     * 为什么必须有：对账器会把"账本里没有活体行的容器"判成孤儿，而**创建过程中**的那一两秒
     * 恰恰是这个形态（行是 `CREATING`、容器刚起来）。没有宽限期，一轮刚好踩在中间的对账
     * 就会把一次正常创建打成孤儿 —— 症状是"偶尔有一轮任务容器起来就被删"。
     * ⚠️ 它**必须大于对账间隔**（否则"宽限期"比"检查周期"还短，等于没有），这条跨字段约束
     * 写在下面的 `superRefine` 里。
     */
    SANDBOX_CREATE_GRACE_SEC: intVar('SANDBOX_CREATE_GRACE_SEC', 120, { min: 10, max: 3600 }),
    /** 产物单文件上限（MB）；超出记**告警并跳过**（不是静默丢，§十一 2） */
    ARTIFACT_MAX_FILE_MB: intVar('ARTIFACT_MAX_FILE_MB', 50, { min: 1, max: 4096 }),
    /** 单轮产物扫描的文件数上限；超出即截断并告警（防引擎写一万个小文件打爆上传） */
    ARTIFACT_SCAN_MAX_FILES: intVar('ARTIFACT_SCAN_MAX_FILES', 200, { min: 1, max: 100_000 }),
    /**
     * 产物**文件**在对象存储的保留期（天）。
     * ⚠️ 与 `ARTIFACT_URL_TTL_MIN`（下载**链接** 30 分钟）是**两件事**：前者是文件的寿命、
     * 后者是链接的时效。不定这个数，产物就是一个只涨不跌的口子（§十一 4）。
     */
    ARTIFACT_RETENTION_DAYS: intVar('ARTIFACT_RETENTION_DAYS', 7, { min: 1, max: 3650 }),

    // ── LLM 调用（P0-1-12；`02` §六 + §十一）──
    /**
     * 「到响应头」的上限（连接 + TTFT）。流式路径**收到头就撤**（之后交给 LLM_STREAM_IDLE_TIMEOUT_MS），
     * 非流式路径则覆盖"发请求 + 读 body"全程 —— 报文很小，不必再开一个计时器。
     *
     * 上限 10 分钟：再长就等于没有超时（F 包的 SSE 与网关的 `proxy_read_timeout` 都在分钟级，
     * 这里放任不管不会让任何一条链路变好，只会让"上游挂了"变成"界面一直转圈"）。
     */
    LLM_REQUEST_TIMEOUT_MS: intVar('LLM_REQUEST_TIMEOUT_MS', 30_000, { min: 500, max: 600_000 }),
    /**
     * 流式响应体传输期「两次数据之间的间隔」上限。每收到一块即重置。
     *
     * 比上面大得多是刻意的：思考型模型（o 系列 / reasoner）在首字之后常有**长静默期**，
     * 但静默期也是有心跳的（多数实现会发空 delta 或 `: keep-alive` 注释行，那也算"收到数据"）；
     * 真出现 2 分钟一个字节都没有，基本可以断定是连接死了。
     */
    LLM_STREAM_IDLE_TIMEOUT_MS: intVar('LLM_STREAM_IDLE_TIMEOUT_MS', 120_000, { min: 1_000, max: 3_600_000 }),

    // ── MCP（P0-2-1 起；`02` §4.7 / `06` §四 4.3）──
    /**
     * MCP 单次请求的上限（毫秒）：「到响应头」与 `tools/call` 的等待共用它。
     *
     * 为什么比 `LLM_REQUEST_TIMEOUT_MS`(30s) 小：MCP 工具调用是**一问一答**的短事务
     * （拉列表、调工具），而对话是一整段流式生成。给 20s 是"够慢的服务端也别把界面吊住"。
     * ⚠️ 交付验收要靠**注入小值**来验超时分支（`06` P0-2-1 验收门槛 3），所以它必须是配置项。
     */
    MCP_REQUEST_TIMEOUT_MS: intVar('MCP_REQUEST_TIMEOUT_MS', 20_000, { min: 200, max: 600_000 }),
    /**
     * 危险工具调用等用户确认的上限（秒），超时按**取消**处理（P0-2-10 消费）。
     *
     * ⚠️ 现在是**登记但不消费**（P0-2-1 只做客户端底座）；写在这里是为了把三个 MCP 配置一次落位，
     * 免得 P0-2-10 再回来改 schema（`SANDBOX_IMAGE` / `TOOL_LOOP_LIMIT` 都是同一手法）。
     * `01` §3.6 的验收要点「取消后流程可继续」必须能注入一个小值才验得了。
     */
    MCP_CONFIRM_TIMEOUT_SEC: intVar('MCP_CONFIRM_TIMEOUT_SEC', 120, { min: 1, max: 3600 }),
    /**
     * 单个 MCP server 进 function 列表的工具数上限（P0-2-6 消费；超限**截断并告警**）。
     *
     * 同样"登记但不消费"。定 64 的理由：一个 server 的工具全塞进上下文会挤掉对话本身，
     * 而模型对几十个工具的挑选准确率也会掉。
     */
    MCP_TOOL_LIMIT: intVar('MCP_TOOL_LIMIT', 64, { min: 1, max: 512 }),

    // ── 知识库流水线（子方案① §二 参数总表）──
    CHUNK_SIZE_DEFAULT: intVar('CHUNK_SIZE_DEFAULT', 512),
    CHUNK_OVERLAP_DEFAULT: intVar('CHUNK_OVERLAP_DEFAULT', 64, { min: 0 }),
    EMPTY_TEXT_THRESHOLD: intVar('EMPTY_TEXT_THRESHOLD', 50, { min: 0 }),
    RRF_K: intVar('RRF_K', 60),
    RETRIEVAL_TOPK_DEFAULT: intVar('RETRIEVAL_TOPK_DEFAULT', 5),
    RETRIEVAL_SCORE_DEFAULT: ratioVar('RETRIEVAL_SCORE_DEFAULT', 0.3),
    CANDIDATE_POOL_FACTOR: intVar('CANDIDATE_POOL_FACTOR', 3),
    /**
     * 流水线队列的 Redis 键（P0-1-17）。
     *
     * 为什么值得给一个环境变量：`REDIS_URL` 是**共享**资源（本机一份；内网还可能给多套部署
     * 共用一个实例），而队列是**被消费**的资源 —— 两个进程用同一个键时，谁把 job 取走是随机的。
     * 后果不是"报错"而是"看起来玄学"：验收脚本刚投的 job 被隔壁 dev server 的 worker 吃了，
     * 于是断言时有时无。改一个键就能把消费方隔离开（验收脚本正是这么用的）。
     */
    PIPELINE_QUEUE_KEY: defaultedVar(z.string().trim().min(1), 'pipeline:jobs'),
  })
  .superRefine((env, ctx) => {
    if (env.CHUNK_OVERLAP_DEFAULT >= env.CHUNK_SIZE_DEFAULT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP_DEFAULT'],
        message: `必须小于 CHUNK_SIZE_DEFAULT（当前 ${env.CHUNK_OVERLAP_DEFAULT} >= ${env.CHUNK_SIZE_DEFAULT}），否则分块会退化`,
      })
    }
    // 沙箱代理超时必须**罩住**确认等待（`子方案③` §二 在 `SANDBOX_PROXY_TIMEOUT_SEC` 那一行
    // 点名的约束）。反过来的症状很难联想：用户在确认卡上点"确认"时，容器早就放弃那次 fetch 了
    // ⇒ 后端把工具调完了，任务却已经收到超时错误 —— 表现为"点了确认也没用"。
    if (env.SANDBOX_PROXY_TIMEOUT_SEC <= env.MCP_CONFIRM_TIMEOUT_SEC) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SANDBOX_PROXY_TIMEOUT_SEC'],
        message:
          `必须大于 MCP_CONFIRM_TIMEOUT_SEC（当前 ${env.SANDBOX_PROXY_TIMEOUT_SEC} <= ${env.MCP_CONFIRM_TIMEOUT_SEC}）：` +
          '否则用户在确认卡上操作时，容器侧的 fetch 已经超时放弃了',
      })
    }
    // 沙箱对账的宽限期必须**罩住**一轮对账间隔（P0-3-2）：反过来的话，"正在创建"的容器
    // 熬不过下一次检查 ⇒ 一次正常创建会被对账器判成孤儿删掉（症状是"偶尔起来就被删"，
    // 且因为要两个配置凑巧错配才复现，最难查）。
    if (env.SANDBOX_CREATE_GRACE_SEC <= env.SANDBOX_REAP_INTERVAL_SEC) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SANDBOX_CREATE_GRACE_SEC'],
        message:
          `必须大于 SANDBOX_REAP_INTERVAL_SEC（当前 ${env.SANDBOX_CREATE_GRACE_SEC} <= ${env.SANDBOX_REAP_INTERVAL_SEC}）：` +
          '宽限期若短于检查周期，正在创建的沙箱会被对账器判成孤儿',
      })
    }
  })

type EnvVars = z.infer<typeof envSchema>

// ───────────────────────────── 应用配置视图 ─────────────────────────────

/**
 * 应用配置：**按用途分组**（而非变量名平铺），业务代码只依赖这里。
 * 需要环境变量原始名时看 `infra/.env.example`，两者一一对应。
 */
export interface AppConfig {
  nodeEnv: NodeEnv
  isDevelopment: boolean
  isProduction: boolean
  isTest: boolean
  /** HTTP 监听端口（`BACKEND_PORT`）。⚠️ macOS 本机 3000 被别的项目占用，见 `infra/.env` 注释 */
  port: number
  logLevel: LogLevel
  /** 开发期是否用 pino-pretty 着色输出（`LOG_PRETTY`，默认跟随 NODE_ENV） */
  logPretty: boolean
  /** CORS 来源白名单（`CORS_ORIGINS`）；空数组 = 未配置，由 app.ts 反射请求 Origin（仅开发期可接受） */
  corsOrigins: string[]

  db: { url: string }
  redis: { url: string }
  s3: { endpoint: string; key: string; secret: string; bucket: string }
  /** 凭据/Provider Key 加密主密钥（已解码的 32 字节；不进日志，见 `describeConfig`） */
  credentialMasterKey: Buffer

  /** 会话（P0-1-6；`02` §十） */
  session: {
    /** 会话有效期（秒，由 `SESSION_TTL_HOURS` 换算；Redis 键上就是它） */
    ttlSeconds: number
    /** 「每请求校验 user.status」的缓存窗口（秒） */
    statusCacheTtlSec: number
    /** Cookie 是否加 `Secure`（HTTPS-only）。生产默认 true —— 明文 HTTP 上置 false 要自己认风险 */
    cookieSecure: boolean
  }

  embedding: {
    mode: EmbeddingMode
    apiUrl: string | undefined
    apiKey: string | undefined
    apiModel: string | undefined
    localModelPath: string
    /** `mode=local` 时的推理运行时模块（P0-1-13）；未配置即 local 模式未就绪 */
    localRuntimeModule: string | undefined
    /** 一次请求的文本条数（`子方案①` §4-3 的 `chunk_embed_batch`） */
    batchSize: number
    dim: number
    /** `mode=api` 且三项齐备 —— 假时由 P0-1-13 的 provider 初始化硬报错 */
    apiReady: boolean
  }

  concurrency: { chatbot: number; sandbox: number; pipeline: number }
  /**
   * 沙箱（P0-3；参数总表 = `子方案③` §二）。
   * ⚠️ 消费进度：`idleTtlMin` / `limits` / `image` / `queueKey` / `queueTtlSec` / `reapIntervalSec`
   * / `createGraceSec` 自 **P0-3-2** 起有消费方（`backend/src/sandbox/`）；
   * `egressProxyUrl` / `backendUrl` / `listenHost` / `limits` 的网络·限额半边自 **P0-3-3** 起有消费方；
   * `callbackPort` / `tokenLen` / `proxyTimeoutSec` 的消费方是 P0-3-9b（listener 的端点本体）。
   */
  sandbox: {
    /** 空闲回收（分钟）。判据是**最后一次引擎事件的时间**，不是 CPU 占用 */
    idleTtlMin: number
    /** 最终镜像（= toolkit 层）；值来自 `pnpm sandbox:build` 的打印 */
    image: string | undefined
    /** base 层镜像（toolkit 的 `FROM`） */
    imageBase: string | undefined
    /** 沙箱代理 listener 端口（内网） */
    callbackPort: number
    /** per-container token 长度（字符） */
    tokenLen: number
    /** 容器侧调代理的超时（秒）；恒 > `mcp.confirmTimeoutSec`（schema 里守着） */
    proxyTimeoutSec: number
    /**
     * 沙箱出公网的 egress 代理（§四 3 出口①）。未定时 `ensureSandbox()` 会**显式拒绝**建容器
     * （内部网络上没有它 ⇒ 引擎必然调不到模型池）。
     */
    egressProxyUrl: string | undefined
    /** 容器眼里的后端沙箱代理地址；未定时由专用 bridge 的网关地址 + `callbackPort` 算出（P0-3-3） */
    backendUrl: string | undefined
    /** 沙箱代理 listener 的绑定地址；未定时绑专用 bridge 的网关地址（P0-3-3） */
    listenHost: string | undefined
    /** 沙箱排队队列的 Redis 键（P0-3-2） */
    queueKey: string
    /** 排队项存活时长（秒）= 孤儿判定窗口 = 等待预算（P0-3-2） */
    queueTtlSec: number
    /** 周期对账间隔（秒，P0-3-2）；恒 < `createGraceSec`（schema 里守着） */
    reapIntervalSec: number
    /** `CREATING` 行的宽限期（秒，P0-3-2）；恒 > `reapIntervalSec` */
    createGraceSec: number
    /** 单容器限额。`cpu` 是浮点（1.5 核），其余是整数 */
    limits: { memMb: number; cpu: number; pids: number; workVolumeMb: number; tmpfsMb: number }
  }
  /** LLM 调用（P0-1-12；`backend/src/llm/client.ts` 是唯一消费方） */
  llm: {
    /** 「到响应头」上限（毫秒）。流式收到头即撤，非流式覆盖全程 */
    requestTimeoutMs: number
    /** 流式响应体「两次数据之间的间隔」上限（毫秒） */
    streamIdleTimeoutMs: number
  }
  /**
   * MCP 客户端（P0-2-1）。三个值都来自环境变量，见 `infra/.env.example` 的 MCP 段。
   * ⚠️ 三个**都已接线**：`requestTimeoutMs` 自 P0-2-1、`toolLimit` 自 P0-2-6、
   *    `confirmTimeoutSec` 自 **P0-2-10**（消费方 `orchestrator/sse.ts#awaitConfirm`，
   *    以及 `shared/src/sse.ts#sseConfirmPayloadSchema.expiresAt` 那个倒计时起点）。
   */
  mcp: {
    /** 单次请求上限（毫秒）：到响应头 / `tools/call` 的等待 */
    requestTimeoutMs: number
    /** 危险调用的确认等待上限（秒）；超时按取消（P0-2-10） */
    confirmTimeoutSec: number
    /** 单个 server 进 function 列表的工具数上限；超限截断并告警（P0-2-6） */
    toolLimit: number
  }
  limits: {
    uploadBodyLimitRaw: string
    uploadBodyLimitBytes: number
    ssePingIntervalSec: number
    contextRounds: number
    toolLoopLimit: number
    artifactUrlTtlMin: number
    /** 产物单文件上限（MB）；超出告警跳过（P0-3-7） */
    artifactMaxFileMb: number
    /** 单轮产物扫描文件数上限（P0-3-7） */
    artifactScanMaxFiles: number
    /** 产物**文件**保留期（天）；与 `artifactUrlTtlMin`（链接时效）是两件事（P0-3-7） */
    artifactRetentionDays: number
    /** /health 单项依赖探活超时（毫秒） */
    healthProbeTimeoutMs: number
  }
  /** 知识库流水线默认值（建库时快照，此后按库独立可改）+ 队列（P0-1-17） */
  pipeline: {
    chunkSize: number
    chunkOverlap: number
    emptyTextThreshold: number
    rrfK: number
    retrievalTopK: number
    retrievalScore: number
    candidatePoolFactor: number
    /** 流水线队列的 Redis 键（见 `PIPELINE_QUEUE_KEY` 的注释：可换键 = 可隔离消费方） */
    queueKey: string
  }

  /** 非致命告警：配置「能用但可能不对」，启动时打 warn（不阻塞开工） */
  warnings: string[]
}

// ───────────────────────────── 校验失败报告 ─────────────────────────────

/** 单条配置问题（键名 + 中文说明），供 CLI 报告与验收脚本断言 */
export interface ConfigIssue {
  key: string
  message: string
}

/** 校验失败：一次性带上**全部**问题（不是遇到第一个就退出） */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[]

  constructor(issues: ConfigIssue[]) {
    super(`配置校验失败（${issues.length} 项）：${issues.map((issue) => issue.key).join(', ')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/** 变量 → 「去哪儿找答案」提示（只给必填项，避免报告变成噪声） */
const ENV_VAR_HINTS: Readonly<Record<string, string>> = {
  DATABASE_URL:
    'PostgreSQL 连接串，示例 postgresql://doubulea:<pwd>@127.0.0.1:<POSTGRES_PORT>/doubulea?schema=public（宿主端口见 infra/.env）',
  REDIS_URL: 'Redis 连接串，示例 redis://127.0.0.1:<REDIS_PORT>',
  S3_ENDPOINT: '对象存储端点，示例 http://127.0.0.1:<MINIO_API_PORT>',
  S3_KEY: 'MinIO/S3 访问密钥（= .env 的 MINIO_ROOT_USER）',
  S3_SECRET: 'MinIO/S3 私钥（= .env 的 MINIO_ROOT_PASSWORD）',
  S3_BUCKET: '桶名，示例 doubulea（不存在时由后端首次使用时创建）',
  CREDENTIAL_MASTER_KEY:
    '32 字节 base64。生成：openssl rand -base64 32 或 node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
}

function collectIssues(error: z.ZodError): ConfigIssue[] {
  const issues = new Map<string, ConfigIssue>()
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(整体配置)'
    // 同一变量可能同时触发「类型错 + 最小值」两条，保留首条即可（消息已足够具体）
    if (!issues.has(key)) issues.set(key, { key, message: issue.message })
  }
  return [...issues.values()]
}

/** 生成失败报告（写入 stderr；此时 logger 尚未建立，故用 console —— 本文件唯一例外） */
export function formatConfigFailure(error: unknown, envFile: EnvFileInfo): string {
  const lines: string[] = []
  const issues = error instanceof ConfigError ? error.issues : []

  if (issues.length === 0) {
    lines.push('✖ 配置加载异常（非校验失败，请把这行连同堆栈一起上报）', '', `  ${String(error)}`, '')
    return lines.join('\n')
  }

  lines.push(`✖ 后端启动中止：配置校验未通过（共 ${issues.length} 项）`, '')
  lines.push(`  环境变量文件：${envFile.path ?? '（未加载任何文件）'}`)
  lines.push(`  加载说明    ：${envFile.note}`)
  lines.push('  模板与说明  ：infra/.env.example')
  lines.push('')
  lines.push('  缺失 / 非法项：')
  for (const issue of issues) {
    lines.push(`    · ${issue.key}`)
    lines.push(`        ${issue.message}`)
    const hint = ENV_VAR_HINTS[issue.key]
    if (hint !== undefined) lines.push(`        提示：${hint}`)
  }
  lines.push('')
  lines.push('  修好上述变量后重新启动即可。此行由 backend/src/config.ts 输出（启动前校验）。')
  return lines.join('\n')
}

// ───────────────────────────── 纯函数：校验 + 构造 ─────────────────────────────

/** 校验环境变量并产出 {@link AppConfig}；失败抛 {@link ConfigError}（不 exit，便于测试与工具复用） */
export function buildConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) throw new ConfigError(collectIssues(parsed.error))

  const vars: EnvVars = parsed.data
  const isDevelopment = vars.NODE_ENV === 'development'
  const warnings: string[] = []
  const corsOrigins = vars.CORS_ORIGINS ?? []

  if (corsOrigins.length === 0 && vars.NODE_ENV === 'production') {
    warnings.push(
      'CORS_ORIGINS 未设置：生产环境会反射任意请求 Origin（等于放开所有站点带 Cookie 调本服务），' +
        '请显式列出前端来源，如 CORS_ORIGINS=https://ops.internal',
    )
  }

  const apiReady =
    vars.EMBEDDING_MODE === 'api' &&
    vars.EMBEDDING_API_URL !== undefined &&
    vars.EMBEDDING_API_KEY !== undefined &&
    vars.EMBEDDING_API_MODEL !== undefined

  if (vars.EMBEDDING_MODE === 'api' && !apiReady) {
    const missing = (['EMBEDDING_API_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_API_MODEL'] as const).filter(
      (key) => vars[key] === undefined,
    )
    warnings.push(
      `EMBEDDING_MODE=api 但未设置 ${missing.join(' / ')} —— 入库/检索会在 P0-1-13 初始化 embedding provider 时硬报错。` +
        '（P0-1-3 不拦截：按待决事项 2「先跑 api 模式打通链路」放行，避免阻塞后续批次开工。）',
    )
  }
  if (vars.EMBEDDING_MODE === 'local' && !existsSync(vars.LOCAL_EMBEDDING_MODEL_PATH)) {
    warnings.push(
      `EMBEDDING_MODE=local 但模型目录不存在：${vars.LOCAL_EMBEDDING_MODEL_PATH}` +
        '（待决事项 2：bge-m3 int8 文件获取渠道未定，P0-1-13 补验）',
    )
  }
  if (vars.EMBEDDING_MODE === 'local' && vars.LOCAL_EMBEDDING_RUNTIME_MODULE === undefined) {
    warnings.push(
      'EMBEDDING_MODE=local 但未设置 LOCAL_EMBEDDING_RUNTIME_MODULE（本地推理运行时模块）—— ' +
        '入库/检索会在 P0-1-13 初始化 embedding provider 时硬报错。' +
        '运行时契约见 docs/02 §八；只想先把链路跑通用 EMBEDDING_MODE=api。',
    )
  }
  if (vars.EMBEDDING_DIM !== 1024) {
    warnings.push(
      `EMBEDDING_DIM=${vars.EMBEDDING_DIM} 与 chunks.embedding 的 vector(1024) 不一致（子方案① §4-4），` +
        '换维度须走「新建 chunks_v2 → 双写 → 切检索 → 弃旧表」路径',
    )
  }
  if (vars.NODE_ENV === 'production' && vars.CREDENTIAL_MASTER_KEY.length < 44) {
    warnings.push('生产环境主密钥长度异常（应恒为 44 字符的 base64）')
  }

  // 会话 Cookie 的 Secure 位：默认跟随 NODE_ENV，但**允许显式关掉** ——
  // 内网生产形态常是「HTTP 直连 + 网关」，此时 Secure 会让浏览器直接丢掉 Cookie（表现为「登录成功却立刻未登录」），
  // 比明文传输更难排查。故给出口子，但生产关掉时必须告警（`02` §十：会话是 HttpOnly Cookie）。
  const cookieSecure = vars.SESSION_COOKIE_SECURE ?? vars.NODE_ENV === 'production'
  if (vars.NODE_ENV === 'production' && !cookieSecure) {
    warnings.push(
      'SESSION_COOKIE_SECURE=false：生产环境会话 Cookie 会在明文 HTTP 上传输（可被同网段嗅探）。' +
        '请改用 HTTPS，或明确接受内网 HTTP 的风险。',
    )
  }

  return {
    nodeEnv: vars.NODE_ENV,
    isDevelopment,
    isProduction: vars.NODE_ENV === 'production',
    isTest: vars.NODE_ENV === 'test',
    port: vars.BACKEND_PORT,
    logLevel: vars.LOG_LEVEL,
    logPretty: vars.LOG_PRETTY ?? isDevelopment,
    corsOrigins,

    db: { url: vars.DATABASE_URL },
    redis: { url: vars.REDIS_URL },
    s3: {
      endpoint: vars.S3_ENDPOINT,
      key: vars.S3_KEY,
      secret: vars.S3_SECRET,
      bucket: vars.S3_BUCKET,
    },
    credentialMasterKey: Buffer.from(vars.CREDENTIAL_MASTER_KEY, 'base64'),

    session: {
      ttlSeconds: vars.SESSION_TTL_HOURS * 3600,
      statusCacheTtlSec: vars.USER_STATUS_CACHE_TTL_SEC,
      cookieSecure,
    },

    embedding: {
      mode: vars.EMBEDDING_MODE,
      apiUrl: vars.EMBEDDING_API_URL,
      apiKey: vars.EMBEDDING_API_KEY,
      apiModel: vars.EMBEDDING_API_MODEL,
      localModelPath: vars.LOCAL_EMBEDDING_MODEL_PATH,
      localRuntimeModule: vars.LOCAL_EMBEDDING_RUNTIME_MODULE,
      batchSize: vars.EMBEDDING_BATCH_SIZE,
      dim: vars.EMBEDDING_DIM,
      apiReady,
    },

    concurrency: {
      chatbot: vars.CHATBOT_CONCURRENCY,
      sandbox: vars.SANDBOX_CONCURRENCY,
      pipeline: vars.PIPELINE_CONCURRENCY,
    },
    sandbox: {
      idleTtlMin: vars.SANDBOX_IDLE_TTL_MIN,
      image: vars.SANDBOX_IMAGE,
      imageBase: vars.SANDBOX_IMAGE_BASE,
      callbackPort: vars.SANDBOX_CALLBACK_PORT,
      tokenLen: vars.SANDBOX_TOKEN_LEN,
      proxyTimeoutSec: vars.SANDBOX_PROXY_TIMEOUT_SEC,
      egressProxyUrl: vars.SANDBOX_EGRESS_PROXY_URL,
      backendUrl: vars.SANDBOX_BACKEND_URL,
      listenHost: vars.SANDBOX_LISTEN_HOST,
      queueKey: vars.SANDBOX_QUEUE_KEY,
      queueTtlSec: vars.SANDBOX_QUEUE_TTL_SEC,
      reapIntervalSec: vars.SANDBOX_REAP_INTERVAL_SEC,
      createGraceSec: vars.SANDBOX_CREATE_GRACE_SEC,
      limits: {
        memMb: vars.SANDBOX_MEM_LIMIT_MB,
        cpu: vars.SANDBOX_CPU_LIMIT,
        pids: vars.SANDBOX_PIDS_LIMIT,
        workVolumeMb: vars.SANDBOX_WORK_VOLUME_MB,
        tmpfsMb: vars.SANDBOX_TMPFS_MB,
      },
    },
    llm: {
      requestTimeoutMs: vars.LLM_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: vars.LLM_STREAM_IDLE_TIMEOUT_MS,
    },
    mcp: {
      requestTimeoutMs: vars.MCP_REQUEST_TIMEOUT_MS,
      confirmTimeoutSec: vars.MCP_CONFIRM_TIMEOUT_SEC,
      toolLimit: vars.MCP_TOOL_LIMIT,
    },
    limits: {
      uploadBodyLimitRaw: vars.UPLOAD_BODY_LIMIT.raw,
      uploadBodyLimitBytes: vars.UPLOAD_BODY_LIMIT.bytes,
      ssePingIntervalSec: vars.SSE_PING_INTERVAL_SEC,
      contextRounds: vars.CONTEXT_ROUNDS,
      toolLoopLimit: vars.TOOL_LOOP_LIMIT,
      artifactUrlTtlMin: vars.ARTIFACT_URL_TTL_MIN,
      artifactMaxFileMb: vars.ARTIFACT_MAX_FILE_MB,
      artifactScanMaxFiles: vars.ARTIFACT_SCAN_MAX_FILES,
      artifactRetentionDays: vars.ARTIFACT_RETENTION_DAYS,
      healthProbeTimeoutMs: vars.HEALTH_TIMEOUT_MS,
    },
    pipeline: {
      chunkSize: vars.CHUNK_SIZE_DEFAULT,
      chunkOverlap: vars.CHUNK_OVERLAP_DEFAULT,
      emptyTextThreshold: vars.EMPTY_TEXT_THRESHOLD,
      rrfK: vars.RRF_K,
      retrievalTopK: vars.RETRIEVAL_TOPK_DEFAULT,
      retrievalScore: vars.RETRIEVAL_SCORE_DEFAULT,
      candidatePoolFactor: vars.CANDIDATE_POOL_FACTOR,
      queueKey: vars.PIPELINE_QUEUE_KEY,
    },

    warnings,
  }
}

/**
 * 脱敏后的配置摘要（**唯一允许用于打印的形态**）。
 * 密钥类只报「是否已设置 + 长度」，其余原样 —— `02` §十 不变式：密钥零下发，日志同理。
 */
export function describeConfig(value: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: value.nodeEnv,
    port: value.port,
    logLevel: value.logLevel,
    logPretty: value.logPretty,
    corsOrigins: value.corsOrigins.length > 0 ? value.corsOrigins : '（未设置：开发期反射请求 Origin）',
    db: { url: maskUrl(value.db.url) },
    redis: { url: maskUrl(value.redis.url) },
    s3: {
      endpoint: value.s3.endpoint,
      bucket: value.s3.bucket,
      key: `${value.s3.key.length} 字符`,
      secret: `${value.s3.secret.length} 字符`,
    },
    credentialMasterKey: `已设置（${value.credentialMasterKey.length} 字节）`,
    session: {
      ttlHours: value.session.ttlSeconds / 3600,
      statusCacheTtlSec: value.session.statusCacheTtlSec,
      cookieSecure: value.session.cookieSecure,
    },
    embedding: {
      mode: value.embedding.mode,
      apiUrl: value.embedding.apiUrl ?? null,
      apiKey: value.embedding.apiKey === undefined ? null : '已设置',
      apiModel: value.embedding.apiModel ?? null,
      apiReady: value.embedding.apiReady,
      localModelPath: value.embedding.localModelPath,
      localRuntimeModule: value.embedding.localRuntimeModule ?? null,
      batchSize: value.embedding.batchSize,
      dim: value.embedding.dim,
    },
    concurrency: value.concurrency,
    sandbox: {
      idleTtlMin: value.sandbox.idleTtlMin,
      image: value.sandbox.image ?? null,
      imageBase: value.sandbox.imageBase ?? null,
      // egress 代理是**地址**，不脱敏（不含凭据）；未配置就如实报 null（P0-3-3 定案前它本来可以空着）
      egressProxyUrl: value.sandbox.egressProxyUrl ?? null,
      backendUrl: value.sandbox.backendUrl ?? null,
      listenHost: value.sandbox.listenHost ?? null,
      callbackPort: value.sandbox.callbackPort,
      tokenLen: value.sandbox.tokenLen,
      proxyTimeoutSec: value.sandbox.proxyTimeoutSec,
      // P0-3-2 起有消费方的四个（队列键不脱敏：它是 Redis 键名，不含凭据）
      queueKey: value.sandbox.queueKey,
      queueTtlSec: value.sandbox.queueTtlSec,
      reapIntervalSec: value.sandbox.reapIntervalSec,
      createGraceSec: value.sandbox.createGraceSec,
      limits: value.sandbox.limits,
    },
    llm: value.llm,
    mcp: value.mcp,
    limits: {
      uploadBodyLimit: `${value.limits.uploadBodyLimitRaw}（${value.limits.uploadBodyLimitBytes} 字节）`,
      ssePingIntervalSec: value.limits.ssePingIntervalSec,
      contextRounds: value.limits.contextRounds,
      toolLoopLimit: value.limits.toolLoopLimit,
      artifactUrlTtlMin: value.limits.artifactUrlTtlMin,
      artifactMaxFileMb: value.limits.artifactMaxFileMb,
      artifactScanMaxFiles: value.limits.artifactScanMaxFiles,
      artifactRetentionDays: value.limits.artifactRetentionDays,
      healthProbeTimeoutMs: value.limits.healthProbeTimeoutMs,
    },
    pipeline: value.pipeline,
    warnings: value.warnings,
  }
}

/** 连接串里的密码换成 `***`（日志可读，又不泄露口令） */
function maskUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.password !== '') url.password = '***'
    return url.toString()
  } catch {
    return '(无法解析)'
  }
}

// ───────────────────────────── 启动即校验（模块级单例）─────────────────────────────

/** 实际加载的环境变量文件（启动日志与 `--check-config` 都会带上） */
export const envFile: EnvFileInfo = loadEnvFile()

function bootstrap(): AppConfig {
  try {
    return buildConfig(process.env)
  } catch (error) {
    // ⚠️ 此处必须在 logger 之前拿到话事权：logger 自身依赖 config.logLevel，
    //    所以失败报告只能用 stderr（console.error）。这是本文件唯一的 console 用法。
    // eslint-disable-next-line no-console
    console.error(formatConfigFailure(error, envFile))
    process.exit(1)
  }
}

/** 强类型配置单例 —— 被 import 即完成校验，失败则进程已退出（`06` P0-1-3 验收门槛） */
export const config: AppConfig = bootstrap()
