/**
 * 错误码全集与领域错误类型
 *
 * 依据：`02-后端设计.md` §四「统一响应与错误码约定」
 * 消费方：backend（errorHandler 插件映射为 HTTP + 信封）、frontend（错误码 → 文案映射层，`03` §六）
 *
 * 施工纪律第 5 条（`06` §六）：schema / 类型定义在 `shared/`，前后端共用。
 */

import { isAppMessage, type AppMessage, type AppMessagePayload } from './i18n/appMessage.js'

/** 错误码字面量全集（前后端唯一事实来源，不在别处重复定义字符串） */
export const ERROR_CODES = [
  /** 400 — 请求参数校验失败 */
  'VALIDATION',
  /** 401 — 未登录 / 会话失效 */
  'UNAUTHORIZED',
  /** 403 — 已登录但无权限 */
  'FORBIDDEN',
  /**
   * 403 — **该智能体没有开放调用**（P1-22，X4）。
   *
   * 与 `FORBIDDEN` 分开的唯一理由：外部的"去开通/找所属人"与"这条 Key 没这个 scope"是
   * **两种完全不同的处置**。开放层只在第 ④b 步（`agent.deleted_at IS NULL ∧ type=CHATBOT ∧ 可查看`）
   * 失败时用它；scope 不足仍是 `FORBIDDEN`（见 `docs/08` §5.2）。
   */
  'NOT_OPENABLE',
  /** 404 — 资源不存在 */
  'NOT_FOUND',
  /** 409 — 状态冲突（并发发送、重复创建、首登未改密等） */
  'CONFLICT',
  /** 422 — 语义不可处理：可见性闭包校验失败（公开资产引用了私有资产，P1-13） */
  'UNPROCESSABLE',
  /** 429 — 资源繁忙（并发闸打满、队列满） */
  'BUSY',
  /** 424 — 缺凭据：MCP server 需用户配置凭据但尚未配置（`02` §九） */
  'NEED_CREDENTIAL',
  /** 502 — 上游模型 / 引擎返回异常 */
  'UPSTREAM_ERROR',
  /** 504 — 上游超时 */
  'UPSTREAM_TIMEOUT',
  /** 500 — 未归类的服务端错误 */
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** 错误码 → HTTP 状态码（后端 errorHandler 使用；前端错误码映射层可参考） */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_OPENABLE: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  BUSY: 429,
  NEED_CREDENTIAL: 424,
  UPSTREAM_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  INTERNAL: 500,
}

/** 错误码 → 默认中文文案（前端文案映射层的兜底；页面可覆盖） */
export const DEFAULT_MESSAGE_BY_ERROR_CODE: Readonly<Record<ErrorCode, string>> = {
  VALIDATION: '请求参数有误',
  UNAUTHORIZED: '登录已失效，请重新登录',
  FORBIDDEN: '没有权限执行该操作',
  NOT_OPENABLE: '该智能体未开放调用（仅对话型智能体可对外开放）',
  NOT_FOUND: '资源不存在',
  CONFLICT: '操作与当前状态冲突',
  UNPROCESSABLE: '该操作会使公开资产引用到私有资产，请先处理引用',
  BUSY: '当前请求过多，请稍后重试',
  NEED_CREDENTIAL: '尚未配置所需凭据',
  UPSTREAM_ERROR: '上游服务返回异常',
  UPSTREAM_TIMEOUT: '上游服务超时',
  INTERNAL: '服务内部错误',
}

/** 领域错误：services 层抛此类型，errorHandler 统一转信封（不抛裸 Error） */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  /** 附加信息（如锁定倒计时秒数、缺失字段清单）—— 序列化进信封 `data` */
  readonly data: unknown
  /**
   * 细节消息的**结构化形态**（P1-23 收尾 ⑤）—— 随信封与 SSE 一起下发。
   *
   * `null` = 这条消息没有 key（默认文案 / 老代码路径）⇒ 前端退回 `message`。
   * 用 `appMsg(...)` 构造的消息会有它，见 `shared/src/i18n/appMessage.ts`。
   */
  readonly msgKey: AppMessagePayload | null

  constructor(code: ErrorCode, message?: string | AppMessage, data?: unknown) {
    // `appMsg(...)` 传进来时：`message` 用它构造期渲染好的中文正文（与改写前逐字一致），
    // key 单独存 —— 于是日志 / `documents.error_msg` / zh 界面全都零变化。
    const structured = isAppMessage(message) ? message : null
    const text =
      structured !== null
        ? structured.text
        : typeof message === 'string'
          ? message
          : DEFAULT_MESSAGE_BY_ERROR_CODE[code]
    super(text)
    this.name = 'AppError'
    this.code = code
    this.status = HTTP_STATUS_BY_ERROR_CODE[code]
    this.data = data
    this.msgKey =
      structured === null
        ? null
        : structured.params === undefined
          ? { key: structured.key }
          : { key: structured.key, params: structured.params }
  }

  static validation(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('VALIDATION', message, data)
  }
  static unauthorized(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('UNAUTHORIZED', message, data)
  }
  static forbidden(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('FORBIDDEN', message, data)
  }
  static notFound(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('NOT_FOUND', message, data)
  }
  static conflict(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('CONFLICT', message, data)
  }
  static unprocessable(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('UNPROCESSABLE', message, data)
  }
  static busy(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('BUSY', message, data)
  }
  static needCredential(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('NEED_CREDENTIAL', message, data)
  }
  static upstreamError(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('UPSTREAM_ERROR', message, data)
  }
  static upstreamTimeout(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('UPSTREAM_TIMEOUT', message, data)
  }
  static internal(message?: string | AppMessage, data?: unknown): AppError {
    return new AppError('INTERNAL', message, data)
  }
}

/** 类型守卫：判断任意值是否为 AppError（跨包 instanceof 边缘问题时的兜底） */
export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof AppError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      'status' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      ERROR_CODES.includes((value as { code: ErrorCode }).code))
  )
}
