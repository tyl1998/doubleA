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

import type { ErrorCode } from './errors.js'

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
