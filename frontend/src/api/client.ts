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

/**
 * 拼一个**可直接放进 `src` / 打开**的完整接口地址（P1-4 的附件缩略图用）。
 *
 * ⚠️ 只给"浏览器自己发请求"的场景（`<img src>`）：它**走不了** {@link request} 那套信封解析，
 * 所以只适用于"成功即字节流、失败体面降级"的端点（附件取内容的失败由 `onError` 兜底）。
 * 常规接口一律走 {@link request} / {@link requestFormData}，别用它绕开错误处理。
 */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`
}

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
  options: { body?: unknown; signal?: AbortSignal; method?: 'POST' | 'GET' } = {},
): Promise<Response> {
  const { body, signal, method = 'POST' } = options

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
 * 发起一次 **multipart 上传**（P0-1-35 的知识库文档上传/覆盖重建专用）。
 *
 * 为什么不复用 {@link request}：那个函数的 body 一律 `JSON.stringify` + `content-type: application/json`。
 * 文件必须走 `FormData`，而 **`content-type` 绝对不能让调用方（或我们）手工设置** ——
 * 它要带着 `boundary=…`，浏览器会自己填；写死了就会得到一个"服务端说不是 multipart"的 400，
 * 看起来像后端不认这个端点。
 *
 * 响应仍是**统一信封**（`{document, deduplicated}` / `{document, unchanged}`），
 * 所以信封解析照旧走 {@link unwrapEnvelope} —— 上传端点的失败（400 扩展名/MIME/魔数不符、
 * 413 超限、404 知识库不存在）都是标准信封，与普通接口**完全一致**。
 *
 * ⚠️ 本仓的 upload 端点**只接受一个文件字段** `UPLOAD_FILE_FIELD`（`shared/src/document.ts`）：
 * 多文件不是"多传几个"，而是 **413**（`routes/documents.ts` 的 `bodyLimit` 与 multipart 插件的
 * 口径）。所以界面上是**单文件选择**，由 `pages/knowledge/knowledgeModel.ts` 的
 * `screenPickedFiles` 在发请求**之前**拦下多选/`.doc`/不支持的扩展名。
 */
export async function requestFormData<T>(
  path: string,
  formData: FormData,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal } = options

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      // ⚠️ **不设 `content-type`**（见上）
      body: formData,
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

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError('INTERNAL', `响应不是合法的 JSON（HTTP ${response.status}）`, response.status)
  }

  return unwrapEnvelope<T>(payload, response.status)
}

/** 一次二进制下载的结果 */
export interface DownloadedFile {
  blob: Blob
  /**
   * 服务端 `Content-Disposition` 里给的文件名；**解析不出时为 `null`**
   * （调用方据此退回"用文档自己的 `fileName`"—— 那是同一份数据的另一个出口）。
   */
  fileName: string | null
}

/**
 * 从 `Content-Disposition` 里取文件名（RFC 6266 / 5987）。
 *
 * 后端是**双写**的（`buildContentDisposition`）：`filename="<ASCII 回落>"` +
 * `filename*=UTF-8''<百分号编码>`，中文名只在后者里。所以取法必须**先看 `filename*`**，
 * 否则中文文档下载下来会得到一个被问号替换的乱码名 —— 而它看起来像"浏览器的问题"。
 *
 * 解析不出（缺头 / 畸形）时返回 `null`，**不抛错**：文件名不是下载的必要条件
 * （调用方有 `document.fileName` 可用，见 {@link DownloadedFile.fileName}）。
 */
export function fileNameFromContentDisposition(header: string | null): string | null {
  if (header === null || header === '') return null

  // ① `filename*=UTF-8''%E8%BF%90%E7%BB%B4.md`（带语言标签时形如 `UTF-8'zh-CN'…`）
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)
  if (extended !== null) {
    const raw = extended[1]?.trim() ?? ''
    const parts = raw.split("'")
    // `charset'lang'value` 三段；缺少引号说明头是畸形的（**不猜**，退回下一路）
    if (parts.length >= 3) {
      const encoded = parts.slice(2).join("'")
      try {
        const decoded = decodeURIComponent(encoded)
        if (decoded !== '') return decoded
      } catch {
        // 百分号编码坏了 —— 继续看 `filename=`
      }
    }
  }

  // ② `filename="运维手册.md"`（ASCII 回落；也可能是未加引号的 token）
  const plain = /filename\s*=\s*([^;]+)/i.exec(header)
  if (plain === null) return null
  const value = (plain[1] ?? '').trim().replace(/^"(.*)"$/u, '$1').replace(/\\(.)/gu, '$1')
  return value === '' ? null : value
}

/**
 * 下载一个**字节流**端点（P0-1-35 的"下载原始文件"）。
 *
 * ⚠️ 这是本仓**唯一**不套统一信封的端点（`docs/02` §4.6 的下载行）：**成功是字节流、
 * 失败才是信封**。所以判据是**响应的形状**而不是状态码 —— 与 {@link openEventStream} 同一路数：
 * 先看 `content-type` 是不是 JSON，是就按信封收口（能拿到可展示的服务端文案），
 * 不是才当文件收下。
 *
 * 为什么不直接 `window.open(url)`（那样也能带上 Cookie）：① 失败时浏览器会**渲染那段 JSON**，
 * 用户看到一页乱码而不知道是"文件已经不在了"；② 拿不到响应头里的文件名，中文名只能靠 URL 猜。
 * 走 fetch + Blob 才能把失败变成一句人话。
 */
export async function requestBlob(path: string, options: { signal?: AbortSignal } = {}): Promise<DownloadedFile> {
  const { signal } = options

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
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
  if (contentType.includes('application/json')) {
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new ApiError('INTERNAL', `响应不是合法的 JSON（HTTP ${response.status}）`, response.status)
    }
    // 信封里的失败会在这里抛出去；成功信封（理论上不会出现）会被下面那句拦下
    const data = unwrapEnvelope<unknown>(payload, response.status)
    throw new ApiError('INTERNAL', `期望文件字节流，但响应是统一信封（HTTP ${response.status}）`, response.status, data)
  }

  if (!response.ok) {
    // 非 JSON 且非 2xx：网关回了个 HTML（本机最典型的成因是 vite proxy 串到了别的服务）
    throw new ApiError('INTERNAL', `下载失败：响应不是 JSON 信封也不是文件（HTTP ${response.status}）`, response.status)
  }

  return {
    blob: await response.blob(),
    fileName: fileNameFromContentDisposition(response.headers.get('content-disposition')),
  }
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
