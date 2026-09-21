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
    ARTIFACT_URL_TTL_MIN: intVar('ARTIFACT_URL_TTL_MIN', 30),
    SANDBOX_IMAGE: optionalText,

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
  sandbox: { idleTtlMin: number; image: string | undefined }
  /** LLM 调用（P0-1-12；`backend/src/llm/client.ts` 是唯一消费方） */
  llm: {
    /** 「到响应头」上限（毫秒）。流式收到头即撤，非流式覆盖全程 */
    requestTimeoutMs: number
    /** 流式响应体「两次数据之间的间隔」上限（毫秒） */
    streamIdleTimeoutMs: number
  }
  limits: {
    uploadBodyLimitRaw: string
    uploadBodyLimitBytes: number
    ssePingIntervalSec: number
    contextRounds: number
    toolLoopLimit: number
    artifactUrlTtlMin: number
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
    sandbox: { idleTtlMin: vars.SANDBOX_IDLE_TTL_MIN, image: vars.SANDBOX_IMAGE },
    llm: {
      requestTimeoutMs: vars.LLM_REQUEST_TIMEOUT_MS,
      streamIdleTimeoutMs: vars.LLM_STREAM_IDLE_TIMEOUT_MS,
    },
    limits: {
      uploadBodyLimitRaw: vars.UPLOAD_BODY_LIMIT.raw,
      uploadBodyLimitBytes: vars.UPLOAD_BODY_LIMIT.bytes,
      ssePingIntervalSec: vars.SSE_PING_INTERVAL_SEC,
      contextRounds: vars.CONTEXT_ROUNDS,
      toolLoopLimit: vars.TOOL_LOOP_LIMIT,
      artifactUrlTtlMin: vars.ARTIFACT_URL_TTL_MIN,
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
    sandbox: { idleTtlMin: value.sandbox.idleTtlMin, image: value.sandbox.image ?? null },
    llm: value.llm,
    limits: {
      uploadBodyLimit: `${value.limits.uploadBodyLimitRaw}（${value.limits.uploadBodyLimitBytes} 字节）`,
      ssePingIntervalSec: value.limits.ssePingIntervalSec,
      contextRounds: value.limits.contextRounds,
      toolLoopLimit: value.limits.toolLoopLimit,
      artifactUrlTtlMin: value.limits.artifactUrlTtlMin,
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
