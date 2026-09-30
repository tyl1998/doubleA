/**
 * 上游调用的**公共件**（P0-1-13 从 `llm/client.ts` 抽出）
 *
 * 依据：`docs/02-后端设计.md` §一（「LLM 接入 = OpenAI 兼容 client（自定义 baseURL）」）、
 *      §六 第 3 步与 §六.1（差异收敛在传输层）、§八（embedding 的 api 模式**复用同一套**
 *      "OpenAI 兼容 + 自定义 baseURL"口径）、§九/§十（密钥零下发）。
 *
 * 为什么要有这一层（P0-1-12 的教训，不是提前抽象）：第二个调用点（`llm/embedding/api.ts`）
 * 需要的是**同一套**东西 —— 看门狗超时、中断语义、上游状态码 → 502/504 的映射、
 * 上游回显的脱敏。这些在 P0-1-12 里踩过两个真 bug（两级超时各持一个 `AbortController`、
 * 中断靠读流失败不生效），**照抄一份就等于把踩过的坑再养一份**。
 * 所以抽出来给两处共用，而不是"以后可能会用到"。
 *
 * ⚠️ 这里放的是**与协议无关**的公共件：不认识 `chat`/`embeddings` 的报文形状，
 *    只认识"打一次上游请求、把失败翻译成人话、绝不下发凭据"。
 */

import { AppError } from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'

/** 错误消息里上游响应体的截断长度（够看清 `invalid api key`，又不至于把消息撑爆） */
export const UPSTREAM_BODY_SNIPPET = 500

/**
 * 一个上游端点（对话是 Provider + 模型，向量是 embedding 的 api 端点）。
 *
 * ⚠️ `apiKey` 是**明文**（已解密 / 已从配置读出），只允许在进程内存里存在：
 *   · 不要把它塞进任何响应体/日志/错误消息；
 *   · 要记日志时用 {@link describeEndpoint}，它只打名字与 `hasKey`。
 */
export interface UpstreamEndpoint {
  /** 日志与错误消息里的上游名字（Provider 名 / "EMBEDDING_API"…） */
  providerName: string
  /**
   * 出错的"主语"（对话是模型名，向量是 embedding 模型名）。
   * 缺省时消息里只写 `providerName` —— 例如 `GET /models` 这种根本没有"模型"的探测请求。
   */
  subject?: string
  /** 已归一化（去尾斜杠），拼路径不会出现 `//` */
  baseUrl: string
  /**
   * 自定义 URL：为 `true` 时 {@link baseUrl} 就是完整端点，{@link resolveUpstreamUrl}
   * 原样返回、不拼 `path`。缺省等价于 `false`（既有拼接行为）——
   * embedding 的 api 模式不设它 ⇒ 照旧拼 `/embeddings`。
   */
  customUrl?: boolean
  /** 未配置时为 `null` —— 有的自建/内网 OpenAI 兼容实现不校验凭据 */
  apiKey: string | null
  /** 额外的日志字段（如对话的 modelId/providerId）；**不参与**消息文案 */
  logFields?: Record<string, unknown>
}

/**
 * 拼上游 URL（**纯函数**，两个 fetch 调用点共用一份）。
 *
 * · 常规（`customUrl` 缺省/false）：`${baseUrl}${path}` —— baseUrl 已去尾斜杠、
 *   path 以 `/` 开头 ⇒ 不会出现 `//`。这是 P0-1-12 起的既有拼接口径。
 * · 自定义 URL（`customUrl === true`）：baseUrl **就是完整端点**，原样返回、**忽略** `path`。
 *   用于不按"`{host}/v1` + 固定后缀"规范给地址的第三方（端点已含完整路径，甚至带 query）。
 *
 * ⚠️ 自定义 URL 下 `/models` / `/embeddings` 这类"另一条路径"无法从固定后缀派生 ——
 *   它们同样只会打到这一个端点。`/models` 探测因此对自定义 URL 基本无意义（型号名手工录入），
 *   这是刻意的：一个"完整端点"本就只对应一条路径。
 */
export function resolveUpstreamUrl(
  endpoint: Pick<UpstreamEndpoint, 'baseUrl' | 'customUrl'>,
  path: string,
): string {
  return endpoint.customUrl === true ? endpoint.baseUrl : `${endpoint.baseUrl}${path}`
}

/** 只打名字与 `hasKey` 的日志形态 —— **唯一**允许用来记录 {@link UpstreamEndpoint} 的方式 */
export function describeEndpoint(endpoint: UpstreamEndpoint): Record<string, unknown> {
  const base: Record<string, unknown> = {
    providerName: endpoint.providerName,
    subject: endpoint.subject ?? null,
    baseUrl: endpoint.baseUrl,
    hasKey: endpoint.apiKey !== null,
  }
  return { ...base, ...(endpoint.logFields ?? {}) }
}

/**
 * 消息里的"上游 / 主语"拼法（`/models` 一类没有主语的请求只写上游名）。
 *
 * P0-1-37 起导出：`llm/protocol.ts` 的协议钩子也要拼同一句文案（`上游 / 模型`），
 * 复制一份就会有两处文案漂移的可能 —— 那是排查时最讨厌的一种不一致。
 * 入参刻意收窄成"只用到的那两个字段"：协议钩子手里只有 Provider 名与模型名（没有 baseUrl）。
 */
export function describeForMessage(endpoint: Pick<UpstreamEndpoint, 'providerName' | 'subject'>): string {
  return endpoint.subject === undefined
    ? endpoint.providerName
    : `${endpoint.providerName} / ${endpoint.subject}`
}

/**
 * 调用方主动中断（用户的"停止"）。
 *
 * 单独一个类而不是复用 `AppError`：语义上它**不是故障**，F 包要靠 `instanceof` 区分
 * "用户点了停止"（推 `done{STOPPED}`）与"上游挂了"（推 `error{UPSTREAM_ERROR}`）。
 */
export class LlmAbortError extends Error {
  constructor(message = '调用已被中断') {
    super(message)
    this.name = 'LlmAbortError'
  }
}

/**
 * 把凭据从任意文本里抹掉。上游 401 的响应体常回显 `Authorization`，
 * 不抹就等于借错误消息把 Key 泄露到日志与前端。
 */
export function redactSecret(text: string, secret: string | null): string {
  // 太短的"密钥"逐字替换会把正常文本打得千疮百孔（本仓的 Key 都远超这个长度）
  if (secret === null || secret.length < 4) return text
  return text.split(secret).join('****')
}

/** 上游响应片段：先脱敏再截断（**进日志/进消息**的片段一律走它） */
export function snippet(text: string, secret: string | null): string {
  const redacted = redactSecret(text, secret)
  return redacted.length > UPSTREAM_BODY_SNIPPET
    ? `${redacted.slice(0, UPSTREAM_BODY_SNIPPET)}…（已截断）`
    : redacted
}

/** 判定"这次 abort 是不是超时触发的"（AbortSignal 的 reason 在 Node 上是任意值） */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/** 判定"是不是我们自己抛的领域错误"（与 `06` P0-1-11 的教训同款：跨构建产物别用 `instanceof`） */
export function isAppError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}

/**
 * 一次调用的"看门狗"：**一个** `AbortController` + 一个**可重装**的计时器。
 *
 * 为什么是"一个控制器 + 可重装计时器"而不是两个各自独立的超时对象（踩过）：
 * `AbortController` 只有接了 `fetch` 那一个才有用。最初写成"到响应头"与"流内空闲"
 * 各持一个控制器，结果是流内空闲超时**根本没接到网络请求上** —— 计时器照常触发、
 * 标记照常置位，而 `for await (const chunk of body)` 依然纹丝不动，
 * 症状是"配置成 300ms 超时，脚本却挂到天荒地老"（验收脚本第一次就是这么卡的）。
 * 所以计时器的时长随阶段换（`arm(ms, label)`），控制器自始至终只有一个。
 */
export class Deadline {
  private timer: NodeJS.Timeout | undefined
  private readonly controller = new AbortController()
  /** 超时是否已触发 —— 用来把 `AbortError` 分成"上游太慢"（504）与"用户点停止"（不是错误） */
  private timedOut = false
  /** 当前阶段的名称（进日志与错误消息，回答"卡在哪一段"） */
  private stage = '首次响应（到响应头）'

  /** 供 `fetch` / 读流使用（调用方的信号经 {@link linkAbort} 接进来） */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get expired(): boolean {
    return this.timedOut
  }

  get currentStage(): string {
    return this.stage
  }

  /** 调用方中断（用户的"停止"）：与超时区分开，见 {@link expired} */
  markUserAbort(): void {
    this.controller.abort()
  }

  /** 装/重置计时器；`ms` 与 `label` 随阶段变（到响应头 → 流内空闲） */
  arm(ms: number, label: string): void {
    this.clear()
    this.stage = label
    this.timer = setTimeout(() => {
      this.timedOut = true
      getLogger().warn({ timeoutMs: ms, stage: label }, `上游${label}超时，主动断开`)
      this.controller.abort()
    }, ms)
    // 计时器不该吊住进程退出（验收脚本跑完要能立刻结束）
    this.timer.unref()
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

/** 把调用方的信号接到守卫上（用户在流中途点停止也生效） */
export function linkAbort(outer: AbortSignal | undefined, deadline: Deadline): () => void {
  if (outer === undefined) return () => undefined
  if (outer.aborted) {
    deadline.markUserAbort()
    return () => undefined
  }
  const onAbort = () => deadline.markUserAbort()
  outer.addEventListener('abort', onAbort, { once: true })
  return () => outer.removeEventListener('abort', onAbort)
}

/**
 * 统一的上游失败出口：把 `fetch` / 读流的各种异常翻译成 502/504，且**不泄露 Key**。
 *
 * 已经是我们自己的领域错误（{@link AppError}，如 `throwUpstreamStatus` 抛的）原样放行 ——
 * 那些消息是精心写的（带状态码与修复提示），再包一层反而丢失信息。
 */
export function toUpstreamFailure(
  error: unknown,
  deadline: Deadline,
  endpoint: UpstreamEndpoint,
  stage: string,
): never {
  if (isAppError(error)) throw error
  if (deadline.expired) {
    throw AppError.upstreamTimeout(
      `调用上游超时（${stage} · ${deadline.currentStage}）：${describeForMessage(endpoint)}。` +
        '请检查上游可用性或调大超时配置',
    )
  }
  if (isAbortError(error)) {
    // 走到这里说明不是超时也不是调用方中断（那两种在调用点已单独处理）——多半是守卫提前 abort
    throw AppError.upstreamError(`调用上游被中断（${stage}）：${describeForMessage(endpoint)}`)
  }
  const detail = error instanceof Error ? error.message : String(error)
  throw AppError.upstreamError(
    `无法连接上游（${stage}）：${endpoint.providerName}（${endpoint.baseUrl}）。原始错误：${redactSecret(detail, endpoint.apiKey)}`,
  )
}

/** 上游请求头。`json=false` 用于无请求体的 GET；Key 缺省时**不带** `Authorization` */
export function upstreamHeaders(
  endpoint: UpstreamEndpoint,
  options: { accept?: string; json?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = { accept: options.accept ?? 'application/json' }
  // 自建/内网 OpenAI 兼容实现可能完全不校验凭据 —— 缺 Key 时不带空 Bearer 更好排查
  if (options.json !== false) headers['content-type'] = 'application/json'
  if (endpoint.apiKey !== null) headers.authorization = `Bearer ${endpoint.apiKey}`
  return headers
}

/** 非 2xx 的统一处理：带上游状态码与脱敏后的响应片段，映射为 502 */
export async function throwUpstreamStatus(
  response: Response,
  endpoint: UpstreamEndpoint,
  stage: string,
): Promise<never> {
  let body: string
  try {
    body = snippet(await response.text(), endpoint.apiKey)
  } catch {
    body = '(响应体读取失败)'
  }
  const hint =
    response.status === 401 || response.status === 403
      ? '（上游拒绝了凭据，请检查该 Provider 的 API Key）'
      : response.status === 404
        ? '（404：可能是路径不对（检查 baseUrl 的版本段，如 /v1、/api/v3），也可能是**该模型/接入点不存在或无权限**（火山需用接入点 id，如 ep-…，或账号未开通该模型））'
        : response.status === 429
          ? '（上游限流）'
          : ''
  getLogger().warn(
    {
      ...describeEndpoint(endpoint),
      stage,
      // 实际请求的完整 URL（不含凭据——Key 在请求头里）：排查"路径对不对"最直接的证据
      url: response.url,
      upstreamStatus: response.status,
      upstreamBody: body,
    },
    '上游返回非 2xx',
  )
  throw AppError.upstreamError(
    `上游返回 ${response.status}${hint}：${describeForMessage(endpoint)}。响应：${body}`,
    { upstreamStatus: response.status },
  )
}

export interface UpstreamJsonRequest {
  /** 相对 `baseUrl` 的路径，如 `/chat/completions`、`/embeddings`、`/models` */
  path: string
  method?: 'GET' | 'POST'
  /** 有 body 才会写 `content-type` 并自动 `POST` 序列化 */
  body?: unknown
  accept?: string
  /**
   * 请求头**整体覆盖**（P0-1-37）。缺省 = {@link upstreamHeaders}（OpenAI 的 `Bearer` 形状）。
   *
   * 为什么是"覆盖"而不是"合并"：三协议里只有 OpenAI 系用 `Bearer`，Anthropic 要的是
   * `x-api-key` + `anthropic-version` 且**不能**带 `Authorization`（部分网关见到就 400）。
   * 合并语义下"默认头该不该发"要先知道对方是哪个协议 —— 那等于把协议知识塞回本文件，
   * 而本文件的定位恰恰是"不认识协议"（见文件头）。构造头的那一份实现在 `llm/protocol.ts`。
   */
  headers?: Record<string, string>
  /** 「到响应头 + 读 body」的总上限（报文都很小，不必分两段计时） */
  timeoutMs: number
  abortSignal?: AbortSignal
  /** 进日志与错误消息的阶段名（`chat` / `embeddings` / `get /models`） */
  stage: string
}

/**
 * 打一次上游请求并读回 JSON：把"看门狗 + 状态码映射 + JSON 解析失败"三件事收在一处。
 *
 * 非流式路径专用（流式要自己逐帧读，见 `client.ts#chatStream`）：报文都很小，
 * 所以一个计时器覆盖"到响应头 + 读 body"全程，不给 body 再开一个。
 *
 * @throws {AppError} `UPSTREAM_ERROR`(502) 非 2xx / 不是合法 JSON；`UPSTREAM_TIMEOUT`(504) 超时
 * @throws {LlmAbortError} 调用方中断
 */
export async function fetchUpstreamJson(
  endpoint: UpstreamEndpoint,
  request: UpstreamJsonRequest,
): Promise<unknown> {
  const deadline = new Deadline()
  const unlink = linkAbort(request.abortSignal, deadline)

  let response: Response
  let rawBody: string
  try {
    deadline.arm(request.timeoutMs, '首次响应（到响应头）')
    response = await fetch(resolveUpstreamUrl(endpoint, request.path), {
      method: request.method ?? 'POST',
      headers:
        request.headers ??
        upstreamHeaders(endpoint, { accept: request.accept, json: request.body !== undefined }),
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: deadline.signal,
    })
    if (!response.ok) await throwUpstreamStatus(response, endpoint, request.stage)
    rawBody = await response.text()
  } catch (error) {
    if (request.abortSignal?.aborted === true) throw new LlmAbortError('调用已被调用方中断')
    toUpstreamFailure(error, deadline, endpoint, request.stage)
  } finally {
    unlink()
    deadline.clear()
  }

  try {
    return JSON.parse(rawBody)
  } catch {
    throw AppError.upstreamError(
      `上游响应不是合法 JSON（${request.path}）：${describeForMessage(endpoint)}。响应：${snippet(rawBody, endpoint.apiKey)}`,
    )
  }
}
