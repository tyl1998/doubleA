/**
 * HTTP 底座（P0-1-30）
 *
 * 依据：`docs/02-后端设计.md` §四（统一信封 `{ code, msg, data }` + 错误码语义）、
 *      `docs/03-前端设计.md` §六（`api/` 含统一错误码→文案映射层，BUSY/CONFLICT/NEED_CREDENTIAL…）、
 *      §七（反馈通道：成功 = message 轻提示；失败 = notification 含错误码）。
 *
 * 三条必须写对的规则（都不是风格问题）：
 *
 * 1. **先看 HTTP 状态、再读信封 `code`**（`shared/envelope.ts` 的契约注释）：
 *    4xx/5xx 的**响应体仍是信封形态**，只看 `response.ok` 会把"业务失败但网络成功"和
 *    "网络层就失败了"混成一类；只看 `code` 又会漏掉"响应不是信封"的情况（网关 502 HTML）。
 *
 * 2. **字段级文案在 `data.fields[{path,message}]`，不在 `msg`**（`02` §四 规则 3）：
 *    校验失败时顶层 `msg` **恒为**「请求参数校验失败」，具体在哪个输入框下写什么
 *    只能去 `fields` 里找。判据见 `docs/06` §六 那条"字段级错误文案查错了地方"。
 *
 * 3. **401 要能被上层收口**：会话失效应该把用户送回登录页，而不是让每个页面各写一遍
 *    跳转。做法是注册一个处理器（`setUnauthorizedHandler`）—— 由 app 层提供，
 *    **不在这里 import router**，否则 api 层反向依赖路由，测试与复用都会变难。
 */

import { DEFAULT_MESSAGE_BY_ERROR_CODE, OK_CODE, type Envelope, type ErrorCode } from '@doubulea/shared'

/** 服务端 `data.fields` 的一项（`02` §四 规则 3） */
export interface FieldIssue {
  /**
   * 出错的字段路径，形如 `body.oldPassword` / `querystring.limit` / `params.id`。
   * ⚠️ **`.refine()` 失败的 `path` 是空串**（`shared/auth.ts` 的字节上限那条就走这条路）
   * ⇒ 不能只按 path 定位，还要能取出"无名字段错误"。见 {@link ApiError.formMessages}。
   */
  path: string
  message: string
}

/** 网络层失败（没拿到信封）时用的伪错误码 —— 与后端 `ERROR_CODES` 刻意不重叠 */
export const NETWORK_ERROR_CODE = 'NETWORK' as const
export type ClientErrorCode = ErrorCode | typeof NETWORK_ERROR_CODE

/**
 * 统一的接口错误。**页面里不应再判断 `response.status`**：拿到的异常一定已经是
 * 「可直接展示的文案 + 可编程的错误码 + 字段级提示」。
 */
export class ApiError extends Error {
  readonly code: ClientErrorCode
  /** HTTP 状态码；网络层失败时为 0 */
  readonly status: number
  /**
   * 信封 `data` 原样带出。
   *
   * 为什么保留它而不是只留 `fields`：失败时的 `data` **不只有字段级错误** ——
   * 本仓登录被锁是 `BUSY` + `{ retryAfterSec }`（`backend/src/services/auth.service.ts`），
   * 前端要靠它做倒计时。只留 `fields` 会逼页面去重新 fetch 一遍拿 `data`。
   */
  readonly data: unknown
  readonly fields: readonly FieldIssue[]

  constructor(code: ClientErrorCode, message: string, status: number, data: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.data = data
    this.fields = readFieldIssues(data)
  }

  /** 会话失效：上层据此把人送回登录页 */
  get isUnauthorized(): boolean {
    return this.code === 'UNAUTHORIZED'
  }

  /**
   * 取某个表单字段的错误文案。
   * 服务端给的是**带前缀**的路径（`body.oldPassword`），调用方只关心自己的字段名
   * ⇒ 先精确匹配 `body.<name>`，再退到"末段相同"。
   */
  fieldMessage(name: string): string | undefined {
    const exact = this.fields.find((issue) => issue.path === `body.${name}`)
    if (exact !== undefined) return exact.message
    return this.fields.find((issue) => issue.path.endsWith(`.${name}`))?.message
  }

  /** 无名字段错误（`path === ''`，即 `.refine()` 那类跨字段校验）—— 只能显示在表单级 */
  get formMessages(): readonly string[] {
    return this.fields.filter((issue) => issue.path === '').map((issue) => issue.message)
  }
}

/** 会话失效处理器：由 app 层注册（见文件头规则 3） */
let onUnauthorized: (() => void) | undefined

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  onUnauthorized = handler
}

/**
 * 接口基址。
 * - 默认**空串 = 同源**：开发期走 vite proxy（`/api` → 后端），生产期走网关按路径分流。
 * - 需要独立域名时用 `VITE_API_BASE_URL` 在**构建期**注入（`vite.config.ts` 的约定）。
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== 'object' || value === null) return false
  // 先收敛成 `Record<string, unknown>` 再逐字段看：直接写 `'code' in value && …` 会让
  // TS 把 value 收成 `object & Record<'code', unknown> & …`，那个交叉类型反而**不能再断言**出
  // 别的字段（TS2352），而错误信息本身的畸形程度是不可控的，我们只想读、不想信。
  const candidate = value as Record<string, unknown>
  // ⚠️ `code` 的类型是 `0 | ErrorCode` —— 成功态是**数字 0**，失败态是**字符串**错误码
  //    （`shared/envelope.ts`）。只认 `typeof === 'number'` 会让**每一个失败响应**都被判成
  //    "不符合信封约定" ⇒ 401 被改写成 INTERNAL、`isUnauthorized` 永远为假 ⇒
  //    症状是**未登录时守卫永远转圈**而不是跳登录页（P0-1-30 浏览器首跑实测踩到）。
  const code = candidate['code']
  return (
    (typeof code === 'number' || typeof code === 'string') &&
    typeof candidate['msg'] === 'string' &&
    'data' in candidate
  )
}

/** 从信封的 `data` 里抽出字段级错误；形状不符时返回空数组（不因为"错误信息本身畸形"再炸一次） */
function readFieldIssues(data: unknown): FieldIssue[] {
  if (typeof data !== 'object' || data === null) return []
  const raw = (data as { fields?: unknown }).fields
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const { path, message } = item as { path?: unknown; message?: unknown }
    if (typeof message !== 'string') return []
    return [{ path: typeof path === 'string' ? path : '', message }]
  })
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 请求体对象（本仓全部是 JSON；文件上传走 FormData 的端点由各自模块处理） */
  body?: unknown
  signal?: AbortSignal
}

/**
 * 发一次请求并把信封拆开：成功返回 `data`，失败抛 {@link ApiError}。
 *
 * `credentials: 'include'` 是**必须的**：会话是 HttpOnly Cookie，不带凭据的话
 * 每个接口都会 401 —— 与开发期是否同源无关（同源时 include 也无副作用）。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    // 网络不可达 / 被 CORS 拦下 / 请求被 abort。abort 由调用方识别（`signal.aborted`），
    // 这里统一给一条"能照着做点什么"的文案（`docs/06` §六：落库的失败原因是给人看的）
    if (signal?.aborted === true) {
      throw new ApiError(NETWORK_ERROR_CODE, '请求已取消', 0)
    }
    throw new ApiError(
      NETWORK_ERROR_CODE,
      error instanceof Error && error.message !== ''
        ? `无法连接后端：${error.message}`
        : '无法连接后端，请检查网络或后端是否已启动',
      0,
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    // 拿到 2xx 却不是 JSON：网关/代理回了个 HTML（本机最典型的成因是 vite proxy 串到了别的服务）
    throw new ApiError('INTERNAL', `响应不是合法的 JSON（HTTP ${response.status}）`, response.status)
  }

  return unwrapEnvelope<T>(payload, response.status)
}

/**
 * 把**已解析的响应体**按统一信封收口：成功返回 `data`，失败抛 {@link ApiError}。
 *
 * 抽出来的唯一理由是 `POST /api/conversations/:id/chat` 要用同一套判据（见 {@link openEventStream}）：
 * 那个端点的**前置失败**（401/400/404/409/424）回的是标准 JSON 信封，**只有成功**才是事件流
 * （`shared/src/sse.ts` 文件头 ③ 的"两类失败、两个出口"）。两处各写一遍信封解析，
 * 迟早会出现"流那条路径忘了看 HTTP 状态"或"忘了收口 401"这类**只在某一条路径上**的偏差。
 */
function unwrapEnvelope<T>(payload: unknown, status: number): T {
  if (!isEnvelope(payload)) {
    throw new ApiError('INTERNAL', `响应不符合统一信封约定（HTTP ${status}）`, status)
  }
  if (payload.code === OK_CODE) return payload.data as T

  const error = new ApiError(payload.code, payload.msg, status, payload.data)
  if (error.isUnauthorized) onUnauthorized?.()
  throw error
}

/** SSE 响应的 Content-Type 前缀（`shared` 的 `SSE_CONTENT_TYPE` 带 `; charset=utf-8`） */
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream'

/**
 * 发起一个**事件流**请求（P0-1-32 的 `POST /api/conversations/:id/chat` 专用）。
 *
 * 与原生的 `EventSource` 相比，这里必须自己发请求的三个理由（`docs/03` §一）：
 *   ① 需要 **POST + JSON body**（`EventSource` 只能 GET）；
 *   ② 需要带**凭据 Cookie**（`credentials: 'include'`，同源时无副作用但语义上必须写）；
 *   ③ 需要一个能被上层 abort 的 `AbortSignal`（停止 / 卸载）。
 *
 * ⚠️ **响应可能是两种形态，判据是 HTTP 状态 + Content-Type，不是"有没有拿到流"**：
 *   · 成功 ⇒ `200 text/event-stream`，返回 `Response` 交调用方逐帧读；
 *   · 前置失败 ⇒ 4xx/5xx + **统一 JSON 信封**（未登录 / 参数非法 / 会话不是我的 / 只读 / 缺凭据）
 *     ⇒ 走 {@link unwrapEnvelope}，抛出的 `ApiError` 与普通接口**完全一致**
 *     （页面因此可以复用同一套错误提示与 401 收口）。
 *   ⚠️ 例外：**并发冲突（`CONFLICT`）是 200 + 事件流里的一帧 `error`**，不是信封 ——
 *   它照样走"流"这一路，由事件分派层收口（`shared/src/sse.ts` 文件头 ③）。
 */
export async function openEventStream(
  path: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const { body, signal } = options

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) throw new ApiError(NETWORK_ERROR_CODE, '请求已取消', 0)
    throw new ApiError(
      NETWORK_ERROR_CODE,
      error instanceof Error && error.message !== ''
        ? `无法连接后端：${error.message}`
        : '无法连接后端，请检查网络或后端是否已启动',
      0,
    )
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (response.ok && contentType.startsWith(EVENT_STREAM_CONTENT_TYPE)) return response

  // 不是事件流 ⇒ 只可能是信封（前置失败）。此处**不判断状态码**：
  // 判据是"收到了什么形状的响应"，而不是"HTTP 码看起来像成功" ——
  // 200 + JSON 也会走到这里，那时 `unwrapEnvelope` 会把它当成功信封拆开，
  // 由下面那句抛出"期望事件流"，比"把 JSON 当流去读"要早得多地失败。
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError(
      'INTERNAL',
      `期望事件流，但响应不是 JSON 也不是事件流（HTTP ${response.status}）`,
      response.status,
    )
  }
  const data = unwrapEnvelope<unknown>(payload, response.status)
  throw new ApiError(
    'INTERNAL',
    `期望事件流，但响应是统一信封（HTTP ${response.status}）`,
    response.status,
    data,
  )
}

/**
 * 错误码 → 用户可读文案的**单点收敛**（`03` §六 坑预判：不收在一处，各页面各写一遍 toast，
 * 后续改口径要全仓搜）。
 *
 * 服务端 `msg` 已经是可以直接展示的中文（`shared/envelope.ts` 的约定），**优先用它**；
 * 本函数只在"拿不到服务端文案"时兜底。**页面不得再自己拼错误文案**，要覆盖就加到
 * `OVERRIDE_BY_ERROR_CODE`，别在 JSX 里写字符串。
 */
export function describeError(error: unknown): { code: ClientErrorCode | 'UNKNOWN'; message: string } {
  // 服务端 msg 是"已经写好的中文"（`shared/envelope.ts`），这里**不再二次拼装**。
  // 页面若要按上下文换文案（如对话页的 CONFLICT「该会话正在生成中」，`03` §五），
  // 应在那句话所在的页面里显式覆盖，而不是回来改这张表 —— 否则一处改动会波及全站。
  if (error instanceof ApiError) return { code: error.code, message: error.message }
  if (error instanceof Error && error.message !== '') return { code: 'UNKNOWN', message: error.message }
  return { code: 'UNKNOWN', message: DEFAULT_MESSAGE_BY_ERROR_CODE.INTERNAL }
}
