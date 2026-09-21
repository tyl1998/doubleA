/**
 * 统一响应信封
 *
 * 依据：`02-后端设计.md` §四 —— 所有 HTTP 响应（含错误）统一形态 `{ code, msg, data }`。
 * 例外：SSE 流（`02` §五）与文件下载流不走信封。
 *
 * 约定：
 * - `code` 为 0 表示成功；非 0 时等于 `ErrorCode` 对应的字符串错误码。
 *   为兼容「数字 0 / 字符串错误码」两种消费习惯，成功态用字面量 `0`。
 * - `msg` 恒为可直接展示给用户的中文文案（前端不再二次拼装）。
 * - `data` 成功时为业务数据；失败时可为 `null` 或附加信息（如缺失字段清单）。
 */

import { z } from 'zod'

import {
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  HTTP_STATUS_BY_ERROR_CODE,
  isAppError,
  type ErrorCode,
} from './errors.js'

/** 成功码字面量 */
export const OK_CODE = 0 as const

/** 统一响应信封 */
export interface Envelope<T = unknown> {
  code: typeof OK_CODE | ErrorCode
  msg: string
  data: T
}

/** 成功响应 */
export interface SuccessEnvelope<T = unknown> extends Envelope<T> {
  code: typeof OK_CODE
  msg: 'ok'
  data: T
}

/** 失败响应 */
export interface ErrorEnvelope extends Envelope<unknown> {
  code: ErrorCode
}

/** 构造成功信封 */
export function ok<T>(data: T, msg: 'ok' = 'ok'): SuccessEnvelope<T> {
  return { code: OK_CODE, msg, data }
}

/** 构造失败信封 */
export function fail(code: ErrorCode, msg: string, data: unknown = null): ErrorEnvelope {
  return { code, msg, data }
}

/**
 * 判断是否为成功信封（前端 api 层拦截器使用）。
 * 注意：后端 HTTP 状态码与信封 `code` 并存 —— 4xx/5xx 响应体仍是信封形态，
 * 前端应「先看 HTTP 状态、再读信封 code」双层校验。
 */
export function isSuccessEnvelope(value: unknown): value is SuccessEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code: unknown }).code === OK_CODE
  )
}

/**
 * 游标分页响应参数（`02` §四 约定：`beforeId` / `limit`）。
 * 用于 `GET /api/conversations/:id/messages` 等列表端点。
 */
export interface CursorPage<T> {
  items: T[]
  /** 下一页游标；为 null 表示已到末尾 */
  nextCursor: string | null
  /** 是否还有更多（前端据此决定是否继续加载） */
  hasMore: boolean
}

/**
 * offset/limit 分页响应（`02` §四：除消息外的列表一律用这个，默认 20）。
 * 与 {@link CursorPage} 并存：消息表是分区表、且要按时间倒序滚动加载，游标更合适；
 * 用户/模型/知识库这类小列表直接给 `total` 更方便做分页器。
 */
export interface OffsetPage<T> {
  items: T[]
  /** 满足条件的总条数（不受本页 limit 影响） */
  total: number
  offset: number
  limit: number
}

/**
 * offset/limit 分页的 zod schema 工厂（`shared` 里各处列表响应共用一份形状）。
 * 用法：`offsetPageOf(userListItemSchema)` → `{ items, total, offset, limit }` 的 schema + 类型。
 */
export function offsetPageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
  })
}

/**
 * 任意错误 → 失败信封（后端 errorHandler 与前端拦截器共用同一条收敛规则）。
 *
 * 语义：
 * - 领域错误（{@link AppError}）：原样带出 `code/msg/data`（msg 已是可直接展示的中文）；
 * - 非领域错误：一律收敛为 `INTERNAL` + 通用文案，**不透传原始 message**
 *   —— 避免把 SQL 片段、堆栈、密钥等内部细节回给客户端（`02` §十）。
 *   原始错误请在后端侧用日志记（`infra/logger.ts` 的 err 序列化）。
 */
export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (isAppError(error)) return fail(error.code, error.message, error.data ?? null)
  return fail('INTERNAL', DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL, null)
}

/**
 * 任意错误 → HTTP 状态码（errorHandler 插件用）：
 * 领域错误查 {@link HTTP_STATUS_BY_ERROR_CODE}，其余 500。
 */
export function toHttpStatus(error: unknown): number {
  return isAppError(error) ? error.status : HTTP_STATUS_BY_ERROR_CODE.INTERNAL
}
