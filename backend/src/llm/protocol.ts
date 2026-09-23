/**
 * 上游协议适配层 —— 三协议（OpenAI 兼容 / OpenAI Responses / Anthropic Messages）的
 * **唯一落点**（P0-1-37）
 *
 * 依据：`docs/02-后端设计.md` §6.1 的**三协议映射表**（路径 / 鉴权头 / 编解码的逐项口径）
 *      与「差异收敛清单」第 12、13 条；§一「LLM 接入 = …+ 协议可配」；§4.3 的 `protocol` 契约。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是「一个适配器对象 + 一条共用外壳」，而不是把 chatStream 抄三份
 * ─────────────────────────────────────────────────────────────────────
 * 三协议的差别只有三样：**请求打到哪个路径、带什么鉴权头、这一帧取哪个字段**。
 * 而 P0-1-12/26/32 那几批踩过的坑 —— 背压 `waitDrain`、**每一帧之前显式查一次中断信号**、
 * 末帧可能没有结尾空行、SSE 帧会被 TCP 切碎、畸形帧只跳过不丢整条回答、`200` 里藏 `{error}` ——
 * **与协议无关**。抄三份等于把每一个坑各养三套，而"修好了 A 忘了修 B"在下一次踩坑时是必然。
 * 所以外壳（读流 / 计时 / 脱敏 / 回调 / 汇总）留在 `client.ts`，本文件只交付
 * {@link ChatProtocol} 这个**钩子**，由外壳按 `target.protocol` 取用。
 *
 * ⚠️ 本文件是 §6.1「三协议映射表」的**唯一实现**：路径、头、字段名只允许在这里出现一份。
 *    要加第四个协议（如 Gemini native），加一个对象进 {@link PROTOCOLS} 即可，
 *    `client.ts` / `chatBot` / SSE 层一行都不用改。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条口径修订（写代码时才发现契约里没写清，已回写 `02` §6.1）
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① `rawFinishReason` 先归一化到 OpenAI 词表再上报。**
 *    `chatBot`（`02` §6.2 的留痕）用 `rawFinishReason !== 'stop'` 判"回答可能被截断"。
 *    Anthropic 原生是 `end_turn`、Responses 原生是 `completed` —— 照原值透出去的话，
 *    **每一条正常回答都会打一条"可能被截断"的 warn**：观察面全是噪声，等于没有观察面。
 *    所以三协议各自的结束原因在这里映射到 `stop` / `length` / `tool_calls` / `content_filter`
 *    （= OpenAI 的 `finish_reason` 词表），**未知取值原样透出**（不猜、不吞）。
 *
 * **② 未知协议名回落到 `OPENAI_COMPAT`，不抛错。**
 *    库里那一列是 PG enum，不可能有非法值；但验收脚本/手工构造的报文里可能不带 `protocol`
 *    （P0-1-37 之前的脚本全部如此）。回落让"老脚本 + 新代码"逐字保持原行为，
 *    而错误永远不会被静默吞掉 —— 回落目标是**默认协议**，也就是"没有这项配置时该怎么办"。
 */

import { AppError, DEFAULT_UPSTREAM_PROTOCOL, type UpstreamProtocol } from '@doubulea/shared'

import { describeForMessage, redactSecret, snippet, upstreamHeaders, type UpstreamEndpoint } from './upstream.js'

// ═════════════════════════════════════════════════════════════════════
// 对话侧的数据类型（P0-1-37 起家在本文；`client.ts` 原样再导出）
//
// ⚠️ 搬家的理由是**依赖方向**：这些类型要被"协议钩子"消费/产出，而钩子必须能拿到
//    `redactSecret`/`snippet`（来自 `upstream.ts`）⇒ 钩子不能反过来依赖 `client.ts`
//    （那会形成 `client → protocol → client` 的运行期环）。类型搬过来之后依赖是一条直线：
//    `client.ts → protocol.ts → upstream.ts`。调用点的 import 路径**不用改**。
// ═════════════════════════════════════════════════════════════════════

/** 对话消息（本批只到"文本进、文本出"；工具/多模态 part 由 `extraBody` 逃生口承接） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatUsage {
  tokensIn: number | null
  tokensOut: number | null
  tokensTotal: number | null
}

/** 一帧（或一整段非流式报文）解出来的增量；空串表示"这一帧没有新内容" */
export interface DecodedFrame {
  text: string
  thinking: string
  /** 见文件头口径 ①：已归一化到 OpenAI 词表的结束原因 */
  finishReason: string | null
  /** 可能只是**一半**（Anthropic 的 input/output 分两帧给）⇒ 由外壳做"非空字段合并" */
  usage: ChatUsage | null
  /** 这一帧就是"流结束信号"（`message_stop` / `response.completed`）；`[DONE]` 走 {@link ChatProtocol.isDoneSentinel} */
  done: boolean
}

/** 造一帧：只写非默认字段，省掉每个 return 都补齐六个键 */
function dec(partial: Partial<DecodedFrame> = {}): DecodedFrame {
  return { text: '', thinking: '', finishReason: null, usage: null, done: false, ...partial }
}

// ═════════════════════════════════════════════════════════════════════
// 协议钩子的形状
// ═════════════════════════════════════════════════════════════════════

/** 一次对话调用的"协议无关"输入（由 `client.ts` 从 `LlmTarget` + `ChatOptions` 组装） */
export interface ProtocolChatRequest {
  /** 上游真实型号名 */
  model: string
  /** **原样**的消息数组（含 system）—— 要不要把 system 挪到顶层由协议自己决定 */
  messages: ChatMessage[]
  stream: boolean
  maxTokens?: number
  temperature?: number
  /** 原样并入请求体的逃生口（`tools` / `top_p` 之类），协议特有字段最后仍可覆盖 */
  extraBody?: Record<string, unknown>
}

/** 解码时的上下文：只用来拼**脱敏后**的错误消息 */
export interface ProtocolDecodeContext {
  providerName: string
  /** 出错的"主语"（模型名）；缺省时消息里只写上游名 */
  subject?: string
  apiKey: string | null
}

export interface ProtocolHeadersOptions {
  accept?: string
  /** `false` 用于无请求体的 GET */
  json?: boolean
}

export interface ChatProtocol {
  readonly id: UpstreamProtocol
  /** 界面上的名字（`shared` 的 `UPSTREAM_PROTOCOL_LABELS` 是给前端看的，这里只进日志/错误消息） */
  readonly label: string
  /** 对话端点（相对 `baseUrl` 的路径） */
  readonly chatPath: string
  /** 拉模型列表的端点；三协议都是 `/models`（Anthropic 也提供，区别只在那要带 `x-api-key`） */
  readonly modelsPath: string
  /** 请求头（鉴权形状各协议不同：Bearer vs `x-api-key`） */
  headers(endpoint: UpstreamEndpoint, options?: ProtocolHeadersOptions): Record<string, string>
  /** 请求体（含"system 放哪 / 上限字段叫什么 / 有没有必填项"） */
  buildBody(request: ProtocolChatRequest): Record<string, unknown>
  /**
   * 极廉价的"结束哨兵"判定：**只有 `[DONE]` 这一种字面量**。
   * 别的协议的结束信号是可解析的 JSON 帧，交给 {@link ChatProtocol.readStreamFrame} 的 `done`。
   *
   * ⚠️ 命中哨兵**不等于**跳出读流循环（与 P0-1-12 起的行为一致）：继续把 body 读完，
   *    免得留下没排空的 socket。它只用来打一条 debug 日志。
   */
  isDoneSentinel(payload: string, event: string | null): boolean
  /** 非流式响应体 → 文本/思考/结束原因/usage；上游以 200 返回错误时**在这里抛** */
  readNonStream(payload: unknown, ctx: ProtocolDecodeContext): DecodedFrame
  /** 流式一帧（已 `JSON.parse`）→ 增量；错误帧**在这里抛** */
  readStreamFrame(chunk: unknown, event: string | null, ctx: ProtocolDecodeContext): DecodedFrame
}

// ═════════════════════════════════════════════════════════════════════
// 与协议无关的小工具（三种报文都会用到的那几个取值动作）
// ═════════════════════════════════════════════════════════════════════

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** 取字符串字段；非字符串 / 空串都归 `null` */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 有限数值才认（`NaN`/`Infinity`/字符串数字都不认） */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * `content` 的三种形态归一成字符串：字符串 / 多模态 part 数组 / `{type:'text',text}` 数组。
 * 空、缺省、别的类型都归空串 —— 调用方按"空串 = 没有增量"处理。
 */
function readTextParts(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let text = ''
  for (const part of value) {
    if (typeof part === 'string') {
      text += part
      continue
    }
    const record = asRecord(part)
    if (record === null) continue
    const value = record.text
    if (typeof value === 'string') text += value
  }
  return text
}

/** usage 的多种命名都收（`prompt_tokens` 与 `input_tokens` 并存于不同实现） */
function readUsage(raw: unknown): ChatUsage | null {
  const record = asRecord(raw)
  if (record === null) return null
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = num(record[key])
      if (value !== null) return value
    }
    return null
  }
  const tokensIn = pick('prompt_tokens', 'input_tokens')
  const tokensOut = pick('completion_tokens', 'output_tokens')
  const tokensTotal =
    pick('total_tokens') ?? (tokensIn === null || tokensOut === null ? null : tokensIn + tokensOut)
  if (tokensIn === null && tokensOut === null && tokensTotal === null) return null
  return { tokensIn, tokensOut, tokensTotal }
}

/**
 * 取 `error.message` 并抛 502。
 *
 * 三种协议各自会以 200 或"流内一帧"的形式回错误（OpenAI 兼容的 `{error:{message}}`、
 * Anthropic 的 `event: error`、Responses 的 `response.failed`），文案形状一致 ⇒ 共用一个出口。
 * **响应片段一律先脱敏**：上游 401 的 body 常回显凭据（`02` §九/§十 不变式）。
 */
function throwUpstreamErrorFrame(ctx: ProtocolDecodeContext, errorField: unknown, stage: string): never {
  const record = asRecord(errorField)
  const message = record === null ? null : str(record.message)
  const type = record === null ? null : str(record.type)
  throw AppError.upstreamError(
    `上游${stage}返回错误：${describeForMessage(ctx)}。` +
      `${redactSecret(String(message ?? '(无 message)'), ctx.apiKey)}` +
      `${type === null ? '' : `（type=${type}）`}`,
  )
}

// ═════════════════════════════════════════════════════════════════════
// ① OPENAI_COMPAT —— 默认协议，P0-1-12 起的全部行为
// ═════════════════════════════════════════════════════════════════════

const openAiCompat: ChatProtocol = {
  id: 'OPENAI_COMPAT',
  label: 'OpenAI 兼容',
  chatPath: '/chat/completions',
  modelsPath: '/models',

  // 直接委托 `upstream.ts` —— 那一份是 P0-1-12 起就在用的实现，一个字节都不重写
  headers: (endpoint, options = {}) => upstreamHeaders(endpoint, options),

  buildBody(request) {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: request.stream,
    }
    // ⚠️ `undefined` 就不带这个字段（交给上游默认），而不是写一个 `null` 上去
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    Object.assign(body, request.extraBody ?? {})
    // 刻意不写 `stream_options`（见 `02` §6.1 差异收敛清单 1）：它是 400 的常见来源
    return body
  },

  isDoneSentinel: (payload) => payload.trim() === '[DONE]',

  readNonStream(payload, ctx) {
    const record = asRecord(payload)
    if (record === null) {
      throw AppError.upstreamError(`上游响应结构异常（不是对象）：${ctx.providerName}`)
    }
    // ⚠️ 有的网关**用 200 返回错误**：不显式判它的话会取到空文本，问题被推迟到很久以后
    if (asRecord(record.error) !== null) throwUpstreamErrorFrame(ctx, record.error, '以 200 ')

    const choices = Array.isArray(record.choices) ? record.choices : []
    const choice = asRecord(choices[0])
    if (choice === null) {
      throw AppError.upstreamError(
        `上游响应里没有 choices[0]：${ctx.providerName}。原始响应：${snippet(
          JSON.stringify(record),
          ctx.apiKey,
        )}`,
      )
    }
    const message = asRecord(choice.message) ?? {}
    return dec({
      text: readTextParts(message.content),
      thinking: readTextParts(message.reasoning_content ?? message.reasoning),
      finishReason: str(choice.finish_reason),
      usage: readUsage(record.usage),
    })
  },

  readStreamFrame(chunk, _event, ctx) {
    const record = asRecord(chunk)
    if (record === null) return dec()
    if (asRecord(record.error) !== null) throwUpstreamErrorFrame(ctx, record.error, '在流中')

    let text = ''
    let thinking = ''
    let finishReason: string | null = null
    // `choices` 可能是空数组（保活帧）—— 循环自然跳过，不需要特判
    const choices = Array.isArray(record.choices) ? record.choices : []
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice)
      if (choice === null) continue
      const reason = str(choice.finish_reason)
      if (reason !== null) finishReason = reason
      const delta = asRecord(choice.delta) ?? {}
      // 首帧常常只有 `role`；思考增量有写 `reasoning_content`（DeepSeek 系）也有写 `reasoning` 的
      thinking += readTextParts(delta.reasoning_content ?? delta.reasoning)
      text += readTextParts(delta.content)
    }
    return dec({ text, thinking, finishReason, usage: readUsage(record.usage) })
  },
}

// ═════════════════════════════════════════════════════════════════════
// ② OPENAI_RESPONSES
// ═════════════════════════════════════════════════════════════════════

/**
 * Responses 的 `status` → OpenAI 词表（见文件头口径 ①）。
 * `failed` 在这里刻意不映射：它必须先被当作错误抛出去，而不是变成一个"结束原因"。
 */
function finishReasonFromResponsesStatus(status: string | null, incompleteReason: string | null): string | null {
  if (status === null) return null
  if (status === 'completed') return 'stop'
  if (status === 'incomplete') return incompleteReason === 'content_filter' ? 'content_filter' : 'length'
  return status // `in_progress` / `queued` / 未知取值：原样透出，不猜
}

/** `incomplete_details.reason` */
function incompleteReasonOf(record: Record<string, unknown>): string | null {
  return str(asRecord(record.incomplete_details)?.reason)
}

const openAiResponses: ChatProtocol = {
  id: 'OPENAI_RESPONSES',
  label: 'OpenAI Responses',
  chatPath: '/responses',
  modelsPath: '/models',

  // 鉴权形状与兼容协议相同 ⇒ 复用同一份实现
  headers: (endpoint, options = {}) => upstreamHeaders(endpoint, options),

  buildBody(request) {
    // 系统提示挪到顶层 `instructions`（`02` §6.1 映射表）；`input` 只留 user/assistant
    const instructions = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const input = request.messages
      .filter((message) => message.role !== 'system')
      // `EasyInputMessage.content` 允许裸字符串 —— 比 part 数组更"谁都认"
      .map((message) => ({ role: message.role, content: message.content }))

    const body: Record<string, unknown> = { model: request.model, input, stream: request.stream }
    if (instructions !== '') body.instructions = instructions
    // ⚠️ 字段名不一样：Responses 是 `max_output_tokens`
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    Object.assign(body, request.extraBody ?? {})
    return body
  },

  // `response.completed` 是可以 JSON.parse 的帧 ⇒ 不走哨兵，走 `readStreamFrame` 的 `done`
  isDoneSentinel: () => false,

  readNonStream(payload, ctx) {
    const record = asRecord(payload)
    if (record === null) {
      throw AppError.upstreamError(`上游响应结构异常（不是对象）：${ctx.providerName}`)
    }
    if (asRecord(record.error) !== null) throwUpstreamErrorFrame(ctx, record.error, '以 200 ')
    const status = str(record.status)
    if (status === 'failed') {
      throwUpstreamErrorFrame(ctx, record.error ?? { message: '上游报告 status=failed' }, '在响应里')
    }

    /**
     * ⚠️ 差异收敛清单第 13 条：文本**不在** `choices` 里。
     * 主路径是 `output[].content[]` 里 `type='output_text'` 的 `text`；
     * `output_text` 是各家 SDK 的便捷字段、HTTP 原生报文里不保证有 ⇒ 只作**兜底**，
     * 且只在主路径一个字都没取到时才用。
     */
    let text = ''
    let thinking = ''
    const output = Array.isArray(record.output) ? record.output : []
    for (const rawItem of output) {
      const item = asRecord(rawItem)
      if (item === null) continue
      const itemType = str(item.type)
      if (itemType === 'reasoning') {
        // 思考内容在 `summary[].text`（也有实现直接给 `content[].text` 的）
        thinking += readTextParts(item.summary) + readTextParts(item.content)
        continue
      }
      if (itemType !== null && itemType !== 'message') continue
      for (const rawPart of Array.isArray(item.content) ? item.content : []) {
        const part = asRecord(rawPart)
        if (part === null) continue
        const partType = str(part.type)
        if (partType !== null && partType !== 'output_text' && partType !== 'text') continue
        text += readTextParts(part) || str(part.text) || ''
      }
    }
    if (text === '' && thinking === '' && output.length === 0) {
      const convenience = str(record.output_text)
      if (convenience === null) {
        throw AppError.upstreamError(
          `上游响应里没有 output[]（也没有 output_text）：${ctx.providerName}。原始响应：${snippet(
            JSON.stringify(record),
            ctx.apiKey,
          )}`,
        )
      }
      text = convenience
    }

    return dec({
      text,
      thinking,
      finishReason: finishReasonFromResponsesStatus(status, incompleteReasonOf(record)),
      usage: readUsage(record.usage),
    })
  },

  readStreamFrame(chunk, _event, ctx) {
    const record = asRecord(chunk)
    if (record === null) return dec()
    const type = str(record.type)
    if (type === null) return dec()

    // 事件名就是 `type` 的全限定名（`response.output_text.delta`…），所以只看 `type` 就够
    switch (type) {
      case 'response.output_text.delta': {
        const text = str(record.delta) ?? ''
        return dec({ text })
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        return dec({ thinking: str(record.delta) ?? '' })
      }
      case 'response.completed':
      case 'response.incomplete': {
        // `response` 是整份快照：结束原因与 usage 都在它里面
        const response = asRecord(record.response) ?? record
        const status = str(response.status) ?? (type === 'response.completed' ? 'completed' : 'incomplete')
        return dec({
          finishReason: finishReasonFromResponsesStatus(status, incompleteReasonOf(response)),
          usage: readUsage(response.usage),
          done: true,
        })
      }
      case 'response.failed':
      case 'error': {
        const response = asRecord(record.response) ?? {}
        return throwUpstreamErrorFrame(
          ctx,
          response.error ?? record.error ?? { message: '上游报告响应失败' },
          '在流中',
        )
      }
      // `response.created` / `response.in_progress` / `response.output_item.*` /
      // `response.content_part.*` / `response.output_text.done` …：对"累积文本"没有增量贡献
      default:
        return dec()
    }
  },
}

// ═════════════════════════════════════════════════════════════════════
// ③ ANTHROPIC_MESSAGES
// ═════════════════════════════════════════════════════════════════════

/**
 * Anthropic 的 `anthropic-version`。刻意写成常量而不是配置项：
 * 它是**协议的一部分**（改它等于换协议），不是部署参数；要升版本就该在代码里显式改一行。
 */
export const ANTHROPIC_API_VERSION = '2023-06-01'

/**
 * Anthropic 的 `max_tokens` 是**必填**（OpenAI 可省略）—— 缺省时补这个常量。
 * 4096 的依据：官方各模型的默认输出上限量级，也是 `02` §6.1 映射表点名的值。
 * ⚠️ 它只在"调用方没给上限"时兜底，**不会**覆盖 `maxTokens`，也不会限制长回答 ——
 * 需要更长时由调用方显式传 `maxTokens`（如将来的"长文模式"）。
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

/** Anthropic 的 `stop_reason` → OpenAI 词表（见文件头口径 ①）；未知取值原样透出 */
const ANTHROPIC_FINISH_REASONS: Readonly<Record<string, string>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
}

function finishReasonFromAnthropic(stopReason: string | null): string | null {
  if (stopReason === null) return null
  return ANTHROPIC_FINISH_REASONS[stopReason] ?? stopReason
}

const anthropicMessages: ChatProtocol = {
  id: 'ANTHROPIC_MESSAGES',
  label: 'Anthropic Messages',
  chatPath: '/messages',
  modelsPath: '/models',

  /**
   * ⚠️ 这里是"**换一个鉴权头**"，不是"再加一个头"：
   * Anthropic 不认 `Authorization`，只认 `x-api-key`；多发一个 `Authorization`
   * 在部分网关上是 400（"unexpected authorization header"）。
   * ⚠️ 没配 Key 时**照样带 `anthropic-version`** —— 它是协议版本号，不是凭据。
   */
  headers: (endpoint, options = {}) => {
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
    }
    if (options.json !== false) headers['content-type'] = 'application/json'
    if (endpoint.apiKey !== null) headers['x-api-key'] = endpoint.apiKey
    return headers
  },

  buildBody(request) {
    /**
     * ⚠️ 两条硬要求（差异收敛清单第 12 条），违反都是 400，而文案不会告诉你"该挪到顶层"：
     *   · `system` **必须**在顶层 —— `messages[].role` 只认 `user`/`assistant`；
     *    · `max_tokens` **必填**。
     */
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }))

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream: request.stream,
    }
    if (system !== '') body.system = system
    if (request.temperature !== undefined) body.temperature = request.temperature
    Object.assign(body, request.extraBody ?? {})
    return body
  },

  // Anthropic 没有 `[DONE]`：结束信号是 `message_stop` 帧（走 `readStreamFrame` 的 `done`）
  isDoneSentinel: () => false,

  readNonStream(payload, ctx) {
    const record = asRecord(payload)
    if (record === null) {
      throw AppError.upstreamError(`上游响应结构异常（不是对象）：${ctx.providerName}`)
    }
    // Anthropic 的错误体是 `{type:'error', error:{type,message}}`；有的网关只给顶层 `error`
    if (str(record.type) === 'error' || asRecord(record.error) !== null) {
      throwUpstreamErrorFrame(ctx, record.error ?? record, '以 200 ')
    }

    let text = ''
    let thinking = ''
    for (const rawBlock of Array.isArray(record.content) ? record.content : []) {
      const block = asRecord(rawBlock)
      if (block === null) continue
      const blockType = str(block.type)
      if (blockType === 'text') text += str(block.text) ?? ''
      // 扩展思考块（`thinking` 开头的模型会回）；`redacted_thinking` 的内容是密文，不取
      else if (blockType === 'thinking') thinking += str(block.thinking) ?? ''
    }
    return dec({
      text,
      thinking,
      finishReason: finishReasonFromAnthropic(str(record.stop_reason)),
      usage: readUsage(record.usage),
    })
  },

  readStreamFrame(chunk, event, ctx) {
    const record = asRecord(chunk)
    if (record === null) return dec()
    // 事件名优先看 `type`（Anthropic 保证帧内有 `type`，且与 `event:` 行同值）
    const type = str(record.type) ?? event

    switch (type) {
      case 'message_start': {
        // ⚠️ 这一帧只给**一半** usage（input_tokens）；output_tokens 在 `message_delta` 里
        const message = asRecord(record.message) ?? {}
        return dec({ usage: readUsage(message.usage) })
      }
      case 'content_block_start': {
        // 有的实现会在起始帧就带上一段文本（少见但真实存在）
        const block = asRecord(record.content_block) ?? {}
        if (str(block.type) === 'text') return dec({ text: str(block.text) ?? '' })
        if (str(block.type) === 'thinking') return dec({ thinking: str(block.thinking) ?? '' })
        return dec()
      }
      case 'content_block_delta': {
        const delta = asRecord(record.delta) ?? {}
        switch (str(delta.type)) {
          // 也可能不给 `delta.type`（只给 `text`）⇒ 兜底按文本处理
          case 'text_delta':
            return dec({ text: str(delta.text) ?? '' })
          case 'thinking_delta':
            return dec({ thinking: str(delta.thinking) ?? '' })
          case 'input_json_delta':
          case 'signature_delta':
          case 'citations_delta':
            return dec() // 工具调用参数 / 思考签名 / 引用：本批不消费
          default: {
            const text = str(delta.text)
            return text === null ? dec() : dec({ text })
          }
        }
      }
      case 'message_delta': {
        // 结束原因与**另一半** usage 都在这
        const delta = asRecord(record.delta) ?? {}
        return dec({
          finishReason: finishReasonFromAnthropic(str(delta.stop_reason)),
          usage: readUsage(record.usage),
        })
      }
      case 'message_stop':
        return dec({ done: true })
      case 'ping':
        return dec() // 保活帧（同时已通过读流的 idle.arm() 重置了空闲计时，这正是要的效果）
      case 'error':
        return throwUpstreamErrorFrame(ctx, record.error ?? record, '在流中')
      default:
        return dec()
    }
  },
}

// ═════════════════════════════════════════════════════════════════════
// 查表与（唯一的）回落
// ═════════════════════════════════════════════════════════════════════

export const PROTOCOLS: Readonly<Record<UpstreamProtocol, ChatProtocol>> = {
  OPENAI_COMPAT: openAiCompat,
  OPENAI_RESPONSES: openAiResponses,
  ANTHROPIC_MESSAGES: anthropicMessages,
}

/** 全部协议的 id（顺序 = `shared` 的 `UPSTREAM_PROTOCOLS`），给验收脚本遍历用 */
export const PROTOCOL_IDS = Object.keys(PROTOCOLS) as UpstreamProtocol[]

/**
 * 取协议实现。**未知/缺省一律回落到 {@link DEFAULT_UPSTREAM_PROTOCOL}**（见文件头口径 ②）。
 *
 * @param id 目标协议；`null`/`undefined`/非法值都回落到默认协议
 */
export function protocolOf(id: UpstreamProtocol | null | undefined): ChatProtocol {
  if (id === null || id === undefined) return PROTOCOLS[DEFAULT_UPSTREAM_PROTOCOL]
  return PROTOCOLS[id] ?? PROTOCOLS[DEFAULT_UPSTREAM_PROTOCOL]
}

/**
 * 合并两半 usage（Anthropic 把一个 usage 拆在 `message_start` 与 `message_delta` 两帧）。
 *
 * 规则两条：
 *   · **非 null 的字段覆盖**（null = "这一帧没说"，不是"值是空"）；
 *   · `tokensTotal` 是**从属量**：`in` 与 `out` 都齐时用它们的和，否则才用上游明确给的。
 *
 * ⚠️ 第二条不是洁癖，是踩出来的：Anthropic 的 `message_start` 给的是**临时值**
 * `{input_tokens:12, output_tokens:1}`，真值在后面的 `message_delta`（`{output_tokens:8}`）。
 * 若让"先到先得"的 total 活下来，最终 `12 + 8 = 20` 的账会报成 `13` —— 一个**自相矛盾**的
 * usage（报表按 total 算钱，就会少算）。而 OpenAI 系一次给全、且 `total = prompt + completion`
 * 恒成立，所以"以 in+out 为准"对它们逐字等价。
 */
export function mergeUsage(previous: ChatUsage | null, incoming: ChatUsage): ChatUsage {
  const tokensIn = incoming.tokensIn ?? previous?.tokensIn ?? null
  const tokensOut = incoming.tokensOut ?? previous?.tokensOut ?? null
  const explicitTotal = incoming.tokensTotal ?? previous?.tokensTotal ?? null
  const tokensTotal =
    tokensIn !== null && tokensOut !== null ? tokensIn + tokensOut : explicitTotal
  return { tokensIn, tokensOut, tokensTotal }
}
