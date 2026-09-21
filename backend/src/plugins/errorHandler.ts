/**
 * 统一错误处理插件（P0-1-4）
 *
 * 依据：`docs/02-后端设计.md` §四（`{code,msg,data}` 信封）、§十（不泄内部细节）、
 *      施工纪律第 5 条（zod schema 定义在 `shared/`，前后端共用）
 *
 * 这个插件把两件事绑在一起（它们本就是同一份契约的两半）：
 * 1. **Zod 校验器接线**（{@link zodValidatorCompiler}）：路由 `schema.*` 写的是 zod schema 而非
 *    JSON Schema，故必须换掉 Fastify 默认的 ajv 编译器；校验失败时把 `ZodError` 收敛成
 *    {@link RequestValidationError}（带字段级明细）。
 * 2. **错误 → 信封出口**（{@link installErrorHandler}）：领域错误（`AppError`）、Fastify 自身错误
 *    （404 / 415 / 413…）、未知异常，全部收敛为 `{code,msg,data}` + 对应 HTTP 状态码。
 *
 * 分层原则（不在别处重复）：错误码 ↔ HTTP 状态的映射、`AppError` → 信封的规则都在
 * `shared/src/errors.ts` / `shared/src/envelope.ts`；本文件只负责**把 Fastify 世界的错误
 * 翻译成 shared 世界的 `AppError`**，翻译完就交给 `toErrorEnvelope` / `toHttpStatus`。
 */

import {
  AppError,
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  type Envelope,
  type ErrorCode,
  isAppError,
  toErrorEnvelope,
  toHttpStatus,
} from '@doubulea/shared'
import type { FastifyInstance, FastifySchemaCompiler } from 'fastify'
import type { FastifySchemaValidationError } from 'fastify'
import { ZodError, type ZodSchema } from 'zod'

import { getLogger } from '../infra/logger.js'

/** 字段级错误明细：进信封 `data.fields`，前端据此定位到具体输入框（`03` §六 错误码映射层） */
export interface FieldIssue {
  /** 出错位置（请求部位 + 路径，如 `body.username` / `querystring.limit`） */
  path: string
  message: string
}

/** 请求参数校验失败 —— 唯一一个由本插件（而非业务层）抛出的 `AppError` 子类 */
export class RequestValidationError extends AppError {
  readonly fields: FieldIssue[]

  constructor(fields: FieldIssue[], message = '请求参数校验失败') {
    super('VALIDATION', message, { fields })
    this.name = 'RequestValidationError'
    this.fields = fields
  }
}

/** zod issue → 前端可消费的字段明细（`path` 为空时退回请求部位名） */
function zodToFieldIssues(error: ZodError, dataVar: string): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: [dataVar, ...issue.path.map((segment) => String(segment))].filter((part) => part !== '').join('.'),
    message: issue.message,
  }))
}

/** Fastify/ajv 形态的校验错误 → 同一套字段明细（第三方插件用 JSON Schema 时的兜底） */
function fastifyToFieldIssues(errors: FastifySchemaValidationError[], dataVar: string): FieldIssue[] {
  return errors.map((issue) => ({
    path: [dataVar, issue.instancePath.replace(/^\//, '').replace(/\//g, '.')]
      .filter((part) => part !== '')
      .join('.'),
    message: issue.message ?? `${issue.keyword} 校验未通过`,
  }))
}

/**
 * Zod 校验器：替换 Fastify 的 ajv 编译器。
 *
 * 返回值形状（`{ value }` / `{ error }`）来自 Fastify 的 `FastifyValidationResult`：
 * 成功时 `value` 会**写回** `request[paramName]`（因此 `z.coerce` / `.transform` 的产物
 * 对 handler 可见）；失败时 `error` 会被 Fastify 补上 `statusCode=400`（已是 400 则不覆盖）。
 * 刻意**同时**把错误做成 `AppError`（带 code='VALIDATION'）—— Fastify 的 `||=` 语义不会覆盖
 * 已有的 code，故错误处理里 `isAppError` 一路就能认出来，不依赖 jest/vitest 式的错误类比较。
 */
export const zodValidatorCompiler: FastifySchemaCompiler<ZodSchema> = (routeSchema) => {
  const schema = routeSchema.schema
  // Fastify 的 `httpPart` 就是校验部位（body/querystring/params/headers），用它拼字段路径前缀
  const dataVar = routeSchema.httpPart ?? 'body'
  return (data: unknown) => {
    const result = schema.safeParse(data)
    if (result.success) return { value: result.data }
    return { error: new RequestValidationError(zodToFieldIssues(result.error, dataVar)) }
  }
}

/** Fastify 自带错误码 → 更具体的中文文案（比通用文案有用得多，且都是固定串、不泄内部信息） */
const MESSAGE_BY_FASTIFY_CODE: Readonly<Record<string, string>> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'Content-Type 不支持（JSON 接口需 application/json）',
  FST_ERR_CTP_EMPTY_JSON_BODY: '请求体为空：JSON 接口不接受空 body',
  FST_ERR_CTP_INVALID_JSON_BODY: '请求体不是合法 JSON',
  FST_ERR_CTP_BODY_TOO_LARGE: '请求体超过上限',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'Content-Length 与实际请求体长度不一致',
  FST_ERR_MAX_PARAM_LENGTH: 'URL 参数过长',
  FST_ERR_BAD_URL: 'URL 格式非法',
  FST_ERR_NOT_FOUND: '接口不存在',
  FST_ERR_HANDLER_TIMEOUT: '处理超时（服务端已放弃本次请求）',
  // @fastify/multipart（P0-1-16）：这四个都是 413，且**都是固定文案**
  // —— 插件自带的英文 message 会带上限数值/字段名，翻译成固定中文更好读、也不会漏内部细节
  FST_REQ_FILE_TOO_LARGE: '文件超过上传上限',
  FST_FILES_LIMIT: '一次只能上传一个文件',
  FST_FIELDS_LIMIT: '表单字段过多',
  FST_PARTS_LIMIT: '表单分段过多',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'Content-Type 不是合法的 multipart/form-data',
  FST_MP_PREMATURE_CLOSE: '上传中断：连接在文件传完之前被关闭，请重试',
}

/** HTTP 状态码 → 错误码（仅用于 Fastify 抛出的「框架级」错误；领域错误自带错误码） */
const CODE_BY_HTTP_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'VALIDATION',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'VALIDATION',
  406: 'VALIDATION',
  409: 'CONFLICT',
  413: 'VALIDATION',
  415: 'VALIDATION',
  422: 'VALIDATION',
  424: 'NEED_CREDENTIAL',
  429: 'BUSY',
  502: 'UPSTREAM_ERROR',
  504: 'UPSTREAM_TIMEOUT',
}

/** Fastify 世界的错误 → shared 世界的 `AppError`（翻译不出来的统一按 500 处理） */
function toAppError(error: unknown): AppError {
  // ① 明确是 zod 校验失败（我们的编译器产出：本身已经是 AppError，这里只补上下文）
  if (error instanceof RequestValidationError) return error
  // ② 其它来源的校验错误（第三方插件返回 JSON Schema 形态的 errors）
  if (typeof error === 'object' && error !== null && 'validation' in error) {
    const { validation, validationContext } = error as {
      validation?: FastifySchemaValidationError[]
      validationContext?: string
    }
    if (Array.isArray(validation) && validation.length > 0) {
      return new RequestValidationError(fastifyToFieldIssues(validation, validationContext ?? 'body'))
    }
  }
  // ③ 领域错误：原样带走（业务层是唯一的真相来源）
  if (isAppError(error)) return error
  // ④ 框架级错误：按 HTTP 状态码归类
  if (typeof error === 'object' && error !== null) {
    const { statusCode, code } = error as { statusCode?: number; code?: unknown }
    const status = typeof statusCode === 'number' ? statusCode : undefined
    const fastifyCode = typeof code === 'string' ? code : undefined
    const errorCode: ErrorCode =
      (status === undefined ? undefined : CODE_BY_HTTP_STATUS[status]) ??
      (status !== undefined && status >= 500 ? 'INTERNAL' : undefined) ??
      'INTERNAL'
    // ⚠️ 只有「框架级错误码 + 白名单文案」才回显具体原因：
    //    未知错误的 message 可能夹带 SQL 片段/文件路径/堆栈（`02` §十 不透传内部细节）
    const known = fastifyCode === undefined ? undefined : MESSAGE_BY_FASTIFY_CODE[fastifyCode]
    return new AppError(errorCode, known ?? DEFAULT_MESSAGE_BY_ERROR_CODE[errorCode])
  }
  return new AppError('INTERNAL', DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL)
}

/**
 * 框架错误自带的 HTTP 状态码（只认 4xx/5xx 的整数）。
 *
 * 为什么要它：错误码 → 状态码的映射表只有 10 个错误码，而 Fastify 能抛出的状态码更细
 * （415 不支持的媒体类型、413 请求体过大、408 请求超时…）。把 415 压成 400 会丢掉客户端的
 * 处理依据（比如前端按 413 提示「文件太大」）。故：**框架错误的状态码优先**，
 * 领域错误（没有 statusCode）才按错误码映射。
 */
function frameworkStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const raw = (error as { statusCode?: unknown }).statusCode
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 400 || raw > 599) return undefined
  return raw
}

/**
 * 安装校验器 + 错误处理 + 404 兜底（在 `app.ts` 里于路由注册前调用）。
 * 采用「直接调用」而非 `app.register(plugin)`：`setErrorHandler` 受 Fastify 封装边界限制，
 * 经 register 装进去只对该插件作用域生效，根作用域的路由会漏掉 —— 这类错很隐蔽。
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setValidatorCompiler(zodValidatorCompiler)

  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error)
    const envelope: Envelope<unknown> = toErrorEnvelope(appError)
    const status = frameworkStatusCode(error) ?? toHttpStatus(appError)
    const logger = getLogger()
    // 只有 zod 校验失败才带字段明细；`data` 可能是 null（如非校验类的 VALIDATION），
    // 故一律走实例判断 —— 曾经这里直接读 `envelope.data.fields` 导致错误处理自身崩成 500
    const fields = appError instanceof RequestValidationError ? appError.fields : undefined

    if (status >= 500) {
      // 5xx 才记完整错误（含堆栈）：定位问题靠它，响应体里只有通用文案
      logger.error({ err: error, status, code: appError.code }, `${request.method} ${request.url} 处理失败`)
    } else if (appError.code === 'VALIDATION') {
      // 表单校验失败是「预期内」的调用方错误，info 级留痕即可，不污染 warn
      logger.info({ status, code: appError.code, fields }, `${request.method} ${request.url} 参数校验未通过`)
    } else {
      logger.warn({ err: error, status, code: appError.code }, `${request.method} ${request.url} 被拒绝`)
    }

    void reply.status(status).send(envelope)
  })

  // 404 也走信封（默认 Fastify 404 返回的是 `{statusCode,error,message}`，前端解析器会懵）
  app.setNotFoundHandler((request, reply) => {
    const appError = AppError.notFound(`接口不存在：${request.method} ${request.url}`)
    void reply.status(toHttpStatus(appError)).send(toErrorEnvelope(appError))
  })
}
