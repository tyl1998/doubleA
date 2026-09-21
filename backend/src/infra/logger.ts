/**
 * 结构化日志（pino）+ 请求 id 贯穿（P0-1-3）
 *
 * 依据：`docs/02-后端设计.md` §十三 可观测（"pino 结构化日志：request id 贯穿（含 SSE 流）"）
 *      + §十 安全（密钥/凭据不得落明文，日志同理）
 *
 * 三件事：
 * 1. **根日志** {@link logger}：JSON 结构化；开发期自动走 pino-pretty 着色（可解析不到时降级纯 JSON）。
 * 2. **请求上下文** {@link runWithRequestContext} + {@link getLogger}：基于 AsyncLocalStorage，
 *    一次 `run` 之后，异步链路里任何模块调 `getLogger()` 都能自动带上 requestId / userId /
 *    conversationId —— SSE 长流同样适用（不需要手工层层传 logger）。
 * 3. **脱敏** {@link LOG_REDACT_PATHS}：密码、Cookie、Authorization、Provider Key、MCP 凭据值
 *    一律打码，避免"随手 log 一个对象"就把密钥写进日志文件。
 *
 * 与 config 的关系：本模块依赖 `config.logLevel/logPretty/nodeEnv`，
 * 故 **config 必须先求值**（它在校验失败时会直接终止进程，不会走到这里）。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import pino, { type Logger, type LoggerOptions } from 'pino'

import { config } from '../config.js'

const SERVICE_NAME = 'doubulea-backend'

/**
 * 脱敏路径（pino redact 语法）。
 * 覆盖：HTTP 头（Cookie/Authorization）、密码、各类 token/key、MCP 用户凭据 `values`
 * （`02` §九：凭据只在后端解密，响应对不下发 —— 日志同样不得留痕）。
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'password',
  '*.password',
  'oldPassword',
  '*.oldPassword',
  'newPassword',
  '*.newPassword',
  'passwordHash',
  '*.passwordHash',
  'password_hash',
  '*.password_hash',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'secret',
  '*.secret',
  'values',
  '*.values',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'CREDENTIAL_MASTER_KEY',
  'credentialMasterKey',
  '*.credentialMasterKey',
]

const REDACTED = '[REDACTED]'

const requireFromHere = createRequire(import.meta.url)

/**
 * 开发期着色输出。用 `require.resolve` **先探测** pino-pretty 是否存在：
 * pino 的 transport 是按模块名在运行期解析的，若生产装包（`--prod`，不含 devDependencies）
 * 却仍配置了 transport，进程会直接起不来。探测失败即静默降级为纯 JSON。
 */
function createTransport(): LoggerOptions['transport'] | undefined {
  if (!config.logPretty) return undefined
  try {
    requireFromHere.resolve('pino-pretty')
  } catch {
    return undefined
  }
  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  }
}

/** 仅创建一次（pino 的 transport 会拉起 worker 线程，重复解析没有意义） */
const transport = createTransport()

/** 根日志：所有子日志由它派生（`getLogger()` / `requestLogger()`） */
export const logger: Logger = pino({
  name: SERVICE_NAME,
  level: config.logLevel,
  base: { service: SERVICE_NAME, env: config.nodeEnv },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  serializers: { err: pino.stdSerializers.err },
  redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED },
  ...(transport === undefined ? {} : { transport }),
})

// ───────────────────────────── 请求上下文（request id 贯穿）─────────────────────────────

/** 请求级上下文：一次用户请求（含 SSE 长流）内不变的标识 */
export interface RequestContext {
  requestId: string
  userId?: string
  conversationId?: string
}

const requestStorage = new AsyncLocalStorage<RequestContext>()

/** 生成 request id（UUID v4；`02` §十三 要求贯穿整条链路） */
export function newRequestId(): string {
  return randomUUID()
}

/**
 * Fastify `genReqId` 用（P0-1-4 接线）：优先透传上游/网关给的 `x-request-id`，
 * 便于前端、后端、网关三方日志对得上；没有就新生成。
 */
export function genReqId(request: { headers?: Record<string, unknown> }): string {
  const inherited = request.headers?.['x-request-id']
  if (typeof inherited === 'string' && inherited.trim() !== '') return inherited.trim()
  return randomUUID()
}

/** 读取当前请求上下文（未在 `runWithRequestContext` 内时为 undefined） */
export function getRequestContext(): RequestContext | undefined {
  return requestStorage.getStore()
}

/**
 * 在请求上下文里执行 `fn`。AsyncLocalStorage 会跨 `await` 传递，
 * 因此编排层、服务层、SSE 流内部都可以直接 `getLogger()`。
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestStorage.run(context, fn)
}

/** 绑定上下文字段的子日志：有上下文带 `requestId/userId/conversationId`，没有则退回根日志 */
export function getLogger(): Logger {
  const context = requestStorage.getStore()
  if (context === undefined) return logger
  return logger.child({
    requestId: context.requestId,
    ...(context.userId === undefined ? {} : { userId: context.userId }),
    ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
  })
}

/** 把业务标识补进当前上下文（登录完成、会话创建后调用） */
export function enrichRequestContext(patch: Partial<Omit<RequestContext, 'requestId'>>): void {
  const context = requestStorage.getStore()
  if (context === undefined) return
  if (patch.userId !== undefined) context.userId = patch.userId
  if (patch.conversationId !== undefined) context.conversationId = patch.conversationId
}

/** Fastify `onRequest` 钩子的入参最小形状（不引 Fastify 类型，保持本模块零框架耦合） */
export interface RequestLike {
  id?: string
  method?: string
  url?: string
  ip?: string
  headers?: Record<string, unknown>
}

/**
 * 为一个 HTTP 请求构造子日志（P0-1-4 的 `onRequest` 钩子调用）。
 * 返回的 logger 已固化为该请求的 requestId + 方法/路径/IP。
 */
export function requestLogger(request: RequestLike): Logger {
  const requestId = request.id ?? genReqId(request)
  return logger.child({
    requestId,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: request.url }),
    ...(request.ip === undefined ? {} : { ip: request.ip }),
  })
}

/**
 * Fastify `onRequest` 钩子用（P0-1-4 接线）：把请求上下文装进 ALS，
 * 后续 handler / 服务层 / SSE 流内的 `getLogger()` 自动带 requestId。
 *
 * 为何用 `enterWith` 而不是 `run`：钩子在 handler 之前就返回了，只有 `enterWith`
 * 才能让上下文"留"在当前异步链上（`run` 的作用域随钩子一起结束）。
 * 代价：同一异步链上后续无关任务也会带着该上下文 —— 在 Fastify「一请求一异步链」
 * 模型下可接受；若将来发现串味，退化为「仅在 request 上挂 requestLogger，不依赖 ALS」。
 */
export function enterRequestContext(request: RequestLike): RequestContext {
  const context: RequestContext = { requestId: request.id ?? genReqId(request) }
  requestStorage.enterWith(context)
  return context
}
