/**
 * LLM client —— 对话协议的**传输层**（P0-1-12 起；P0-1-37 起三协议）
 *
 * 依据：`docs/02-后端设计.md` §一（「LLM 接入 = OpenAI 兼容 client（自定义 baseURL）+
 *      **协议可配**」）、§六 第 3 步（ChatBot 走 `stream: true`，delta / thinking 持续透传）、
 *      §6.1（**三协议映射表** + 差异收敛清单）、§八（embedding 的 api 模式也复用同一套
 *      "OpenAI 兼容 + 自定义 baseURL"口径）、
 *      §4.3（`GET /api/model-providers/:id/remote-models` 拉取该配置下的上游模型）。
 * 产出要求：`06` P0-1-12 —— 「`llm/client.ts`：`baseURL` 取自 provider、Key 从 `api_key_enc`
 *      解密注入（**仅后端内存**）、支持 `stream: true` 增量回调；为 F 包的编排预留
 *      `chatStream()` 与 `chat()` 两个入口」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的四条口径（写给后来改它的人）
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① 只做传输，不碰数据库。** Provider/模型 → 上游配置的解析（含解密 Key）在
 *    `services/model.service.ts#resolveChatTarget()`；本文件只接受一个已经解析好的
 *    {@link LlmTarget}。好处：这一层可以拿一个假上游（本地 HTTP server）独立验，
 *    不需要 PG/Redis，也不会把"凭据从哪来"和"报文怎么发"搅在一起。
 *
 * **② 差异在这里收敛，不泄漏到编排层**（`06` P0-1-12 坑预判）。实测/已知的兼容性差异
 *    全部在本文件处理掉，编排层（F 包）只需要 `onDelta / onThinking / onUsage` 三个回调：
 *      · 有的实现**不发 `[DONE]`** → 流结束即结束，不依赖哨兵；
 *      · 有的实现回 **`choices: []`**（保活帧）→ 跳过；
 *      · 首帧只有 `role` 没有 `content` → 视为空增量；
 *      · DeepSeek 一类的思考增量在 **`reasoning_content`**（也有写 `reasoning` 的）→ 归到 thinking；
 *      · `delta.content` 偶尔是**数组**（多模态增量）→ 取其中的文本拼接；
 *      · **忽略 `stream: true` 的实现**（代理直接回一坨 JSON）→ 按非流式解析，只发一次 delta；
 *      · **SSE 帧会被 TCP 切碎**（`data: {"cho` + `ices":…`）→ 按行缓冲，与网络分片解耦；
 *      · 有的实现**不发末尾空行** → 流结束时把残留缓冲也当作一帧处理；
 *      · ⚠️ **刻意不发 `stream_options`**（`include_usage`）：这是踩过的最常见的 400 来源
 *        （不是所有网关都认这个字段），而 usage 只是"有就收、没有就算了"的锦上添花 ——
 *        真需要它时应先做成 Provider 级开关，而不是默认发出去。
 *    ⚠️ P0-1-37 起，上面前四条里"取哪个字段"的部分**搬到了 `./protocol.ts`**（按 Provider 的
 *      `protocol` 分流）；本文件只留"与协议无关"的那部分：读流 / 计时 / 汇总 / 脱敏 / 回调。
 *      **这条边界要守住** —— 往这里加 `if (protocol === '…')` 就是把差异又摊回了外壳。
 *    ⚠️ P0-2-8 起多了一样**跑不掉**的东西：**工具调用的分片累积**（`protocol.ts` 文件头 ③）。
 *      它留着是对的 —— "按片攒字符串"是**与协议无关**的动作（三协议的差异只是"这一帧取哪个字段"，
 *      已经由钩子归一成同一种分片）。唯一不许做的是在这里 `JSON.parse` 参数：那是编排层的事。
 *
 * **③ 超时与中断分三级，且各有去处**（不这样做的话，一个卡死的上游会永久占住
 *    ChatBot 的并发闸）：
 *      · `LLM_REQUEST_TIMEOUT_MS` —— **到响应头**的上限（连接 + TTFT）。三种路径的处置不同：
 *        流式**收到头即撤**（否则长回答会被腰斩，之后就交给下面的空闲超时）；非流式的报文
 *        很小，保持到 body 读完（"到响应头 + 读 body"的总时长），不给它单独再开一个计时器；
 *      · `LLM_STREAM_IDLE_TIMEOUT_MS` —— 流式：响应体传输期**两次数据之间的间隔**上限
 *        （每收一块重置）。没有它的话，一个"连上了但一个字也不吐"的上游会挂到天荒地老，
 *        而这种故障在真实网关里并不罕见；
 *      · 两者都映射为 `UPSTREAM_TIMEOUT`（504），文案里点明是"上游"而不是"我们"；
 *      · 调用方传入的 `abortSignal`（用户的"停止"）→ {@link LlmAbortError}，
 *        与故障区分开：**用户点停止不是错误**，F 包据此推 `done{finishReason: STOPPED}`。
 *
 * **④ 密钥零下发（`02` §九/§十 不变式）**在本层的落点：{@link LlmTarget.apiKey} 只存在于
 *    进程内存，且**任何**写进日志/错误消息的上游响应片段都要先过 `redactSecret`（在
 *    `upstream.ts` / `protocol.ts` 各自的出口里）—— 上游 401 的响应体里回显 `Authorization`
 *    是常见行为，不脱敏就等于把 Key 借错误消息漏出去。
 *
 * **⑤ 通用件已抽到 `./upstream.ts`（P0-1-13）**：看门狗 `Deadline` / 中断类 /
 *    脱敏 / 状态码映射 / `fetchUpstreamJson` 都是"与协议无关"的，embedding 的 api 模式
 *    要的是**同一套**（§六.1 的差异收敛口径对 §八 同样成立）。本文件只留"对话协议"这一层。
 */

import { AppError, type UpstreamProtocol } from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import {
  absorbToolCalls,
  createToolCallBuffer,
  mergeUsage,
  protocolOf,
  readToolCalls,
  type ChatMessage,
  type ChatToolCall,
  type ChatUsage,
  type DecodedFrame,
  type ProtocolDecodeContext,
  type ProtocolToolDefinition,
} from './protocol.js'
import {
  Deadline,
  LlmAbortError,
  describeEndpoint,
  fetchUpstreamJson,
  linkAbort,
  redactSecret,
  snippet,
  throwUpstreamStatus,
  toUpstreamFailure,
  type UpstreamEndpoint,
} from './upstream.js'

// 这两项 P0-1-12 起就是从本文件导出的（`services/model.service.ts`、F 包与验收脚本在用），
// 实现搬到 `upstream.ts` 后在这里原样再导出：**调用点不因为一次重构而改 import 路径**。
export { LlmAbortError, redactSecret }
// 同理：`ChatMessage` / `ChatUsage` 的实现（定义）P0-1-37 起搬到了 `./protocol.ts`
// （依赖方向原因，见那边的文件头），**调用点同样不用改 import 路径**。
export type { ChatMessage, ChatUsage, DecodedFrame } from './protocol.js'
// P0-2-8：工具调用的**协议无关形态**与参数解析也在这里再导出 —— 编排层（`chatBot.ts`）只
// import `llm/client.js`，不必知道 `protocol.ts` 的存在（它与 `ChatMessage` 是同一条纪律）。
export { parseToolArguments, sumUsages } from './protocol.js'
export type { ChatToolCall, ProtocolToolDefinition, ToolArgumentsParse } from './protocol.js'

// ═════════════════════════════════════════════════════════════════════
// 对外类型（F 包的编排层只依赖这几项）
// ═════════════════════════════════════════════════════════════════════

/**
 * 一次调用的**上游目标**：由 `services/model.service.ts#resolveChatTarget()` 组装。
 *
 * ⚠️ `apiKey` 是**明文**（已解密），只允许在进程内存里存在：
 *   · 不要把它塞进任何响应体/日志/错误消息；
 *   · 要记日志时用 {@link describeTarget}，它只打 id/名字，不打 Key。
 */
export interface LlmTarget {
  modelId: string
  /** 上游 model id（`gpt-4o-mini` / `bge-m3` …），不是我们要显示的别名 */
  modelName: string
  label: string
  maxContext: number | null
  supportsVision: boolean
  /**
   * 是否向上游请求"深度思考"（reasoning / thinking）。来自模型的 `supportsReasoning`。
   * `true` 时各协议在 `buildBody` 里落各自的思考参数；`false` 时不发任何思考参数（默认行为）。
   */
  supportsReasoning: boolean
  providerId: string
  providerName: string
  /**
   * 上游协议（Provider 级配置，`02` §4.3 / §6.1）。
   *
   * 可选是**刻意**的：验收脚本会手工构造 target（P0-1-37 之前的脚本全都不带这个字段），
   * 而"没给"应当等价于"用默认协议"—— 由 `protocolOf()` 一处回落（见 `protocol.ts` 文件头口径 ②），
   * 而不是让每个调用点各写一遍 `?? 'OPENAI_COMPAT'`。
   */
  protocol?: UpstreamProtocol
  /** 已归一化（去尾斜杠），拼路径不会出现 `//` */
  baseUrl: string
  /** 未配置时为 `null` —— 有的自建/内网 OpenAI 兼容实现不校验凭据 */
  apiKey: string | null
}


export interface ChatResult {
  text: string
  /**
   * **上游原值**（`stop` / `length` / `tool_calls` / `content_filter` / null）。
   *
   * 刻意不在这里归一化成 `COMPLETE|STOPPED|ERROR`：那个归一化是 SSE 层的事（`02` §5.1），
   * 而且归一化会丢掉 `length`（被 max_tokens 截断）—— 上层要靠它区分"答完了"和"被截断了"。
   */
  rawFinishReason: string | null
  usage: ChatUsage | null
  /**
   * 本次上游调用**请求**的工具（P0-2-8）。
   *
   * ⚠️ 编排层的工具循环走的是 {@link chatStream}（它要持续透传 `delta`），这里保留工具字段
   * 只是为了"非流式入口不把工具信息吃掉"—— 否则同一个上游在"忽略 `stream:true`"时会**静默**
   * 丢失工具调用（`chatStream` 的非流式兜底路径就是靠它）。当前**没有消费方**。
   */
  toolCalls: ChatToolCall[]
  /** 本次上游调用的耗时（毫秒）；TTFT 由编排层自己打点（`02` §十三） */
  durationMs: number
}

export interface ChatStreamSummary {
  text: string
  /** 见 {@link ChatResult.rawFinishReason} */
  rawFinishReason: string | null
  usage: ChatUsage | null
  /** 收到过多少个非空增量（编排层可据此判断"上游一个字都没吐"） */
  deltaCount: number
  /** 跳过的畸形帧数（网关偶发截断时非零）；有值即已打 warn */
  malformedFrames: number
  /**
   * 本次调用请求的工具（**已累积完成**，参数是原样 JSON 字符串）。
   *
   * ⚠️ 只在流结束（或 `finish_reason==='tool_calls'`）之后才有正确值 —— 见 `protocol.ts` 文件头 ③。
   */
  toolCalls: ChatToolCall[]
  /**
   * 收到分片但缺 `id`/`name`（调不了）而被丢弃的段数；非零即已打 warn。
   *
   * 它必须能出来：丢掉的症状是"模型说要调工具、界面上什么都没有"，而这条是唯一的解释。
   */
  incompleteToolCalls: number
  durationMs: number
}

export interface ChatStreamCallbacks {
  onDelta: (text: string) => void
  /** 思考增量（`reasoning_content`）；没有思考的模型不会调用 */
  onThinking?: (text: string) => void
  /** usage 一旦出现就回调（多数实现只在最后一帧给，且需要 `stream_options` —— 见文件头 ②） */
  onUsage?: (usage: ChatUsage) => void
}

export interface ChatOptions {
  /** `max_tokens`；`undefined` 就不带这个字段（交给上游默认） */
  maxTokens?: number
  temperature?: number
  /**
   * 下发给模型的工具（**OpenAI 形态**，P0-2-6 的产出）。
   *
   * `undefined` = 不带 `tools` 字段（**不是**带一个空数组：有的网关见空数组会 400）。
   * 各协议的报文投影由 `protocol.buildBody` 负责（见 `protocol.ts` 文件头 ③）。
   */
  tools?: readonly ProtocolToolDefinition[]
  /** 调用方的取消信号（用户的"停止"）→ 抛 {@link LlmAbortError} */
  abortSignal?: AbortSignal
  /** 覆盖配置的"到响应头"超时（测试/一次性任务用） */
  timeoutMs?: number
  /** 覆盖配置的"流内空闲"超时 */
  idleTimeoutMs?: number
  /**
   * 原样并入请求体的额外字段（`top_p` / 多模态 part 之类）。
   * **本层不校验它** —— 这是给 F 包留的逃生口：上游差异不该逼着改传输层。
   * ⚠️ 它在 `buildBody` 的最后被 `Object.assign` ⇒ **能覆盖**同名的协议字段（含 `tools`）。
   */
  extraBody?: Record<string, unknown>
}

/** 上游 `/models` 的一项（三种常见形态已归一化） */
export interface RemoteModel {
  id: string
  ownedBy: string | null
  created: number | null
  /**
   * 上下文长度（token），**仅部分实现返回**（OpenRouter `context_length`、vLLM `max_model_len` 等）；
   * 标准 OpenAI `/models` 不含，缺失为 `null`。用于新建模型时默认填充上下文长度。
   */
  contextLength: number | null
}

// ═════════════════════════════════════════════════════════════════════
// 内部小工具
// ═════════════════════════════════════════════════════════════════════

/**
 * 拉取上游模型列表的返回上限（超出只截 `items`，`total` 仍是真实值 —— 不做静默截断）
 */
const REMOTE_MODELS_CAP = 500

/** 只打 id/名字的日志形态 —— **唯一**允许用来记录 {@link LlmTarget} 的方式 */
export function describeTarget(target: LlmTarget): Record<string, unknown> {
  return {
    modelId: target.modelId,
    modelName: target.modelName,
    ...describeEndpoint(endpointOf(target)),
  }
}

/** `LlmTarget` → 通用上游端点（`upstream.ts` 只认识后者） */
function endpointOf(target: LlmTarget): UpstreamEndpoint {
  return {
    providerName: target.providerName,
    subject: target.modelName,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    logFields: { modelId: target.modelId, providerId: target.providerId, label: target.label },
  }
}

/**
 * 协议解码上下文。
 *
 * ⚠️ 这里**故意**带上 `apiKey`：协议钩子在拼错误消息时要把上游回显的凭据抹掉
 * （`upstream.ts#redactSecret`）。它只进"脱敏函数的入参"，绝不进消息本身 ——
 * 与 {@link describeTarget} 的区别正在于此。
 */
function decodeContextOf(target: LlmTarget): ProtocolDecodeContext {
  return { providerName: target.providerName, subject: target.modelName, apiKey: target.apiKey }
}

// ═════════════════════════════════════════════════════════════════════
// chat()：非流式
// ═════════════════════════════════════════════════════════════════════

/**
 * 一次性对话（连通测试 / **本项目验收门槛点名的「对一个真实 provider 发一次极小请求
 * （`max_tokens: 1`）」**都走它）。
 *
 * ⚠️ **工具循环不走这里**（`06` P0-2-8）：它每一轮都要把 `delta` 实时透传给用户，
 * 而本函数是"回一坨"。工具调用也走 {@link chatStream}（`LlmTarget` 那一侧没有差别）。
 *
 * @throws {AppError} `UPSTREAM_ERROR`(502) 上游非 2xx / 报文不可解析；
 *                    `UPSTREAM_TIMEOUT`(504) 到响应头或读 body 超时
 * @throws {LlmAbortError} 调用方中断（用户点停止）
 */
export async function chat(
  target: LlmTarget,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  const startedAt = Date.now()
  const protocol = protocolOf(target.protocol)
  const endpoint = endpointOf(target)

  // 报文形状（路径 / 字段名 / system 放哪 / 有没有必填项）全部由协议决定 —— 见 `./protocol.ts`
  const body = protocol.buildBody({
    model: target.modelName,
    messages,
    stream: false,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    tools: options.tools,
    requestReasoning: target.supportsReasoning,
    extraBody: options.extraBody,
  })

  // 非流式的报文很小（一次问答的 JSON），所以一个计时器覆盖"到响应头 + 读 body"全程
  const payload = await fetchUpstreamJson(endpoint, {
    path: protocol.chatPath,
    body,
    // 鉴权头的形状也随协议（Bearer vs `x-api-key`）；覆盖 `fetchUpstreamJson` 的默认头
    headers: protocol.headers(endpoint),
    timeoutMs: options.timeoutMs ?? config.llm.requestTimeoutMs,
    abortSignal: options.abortSignal,
    stage: 'chat',
  })

  const parsed = protocol.readNonStream(payload, decodeContextOf(target))
  // 走**同一个**累积器（即使非流式的分片是一次给全的）：两种入口的产出形态因此逐字一致
  const buffer = createToolCallBuffer()
  absorbToolCalls(buffer, parsed.toolCalls)
  return {
    text: parsed.text,
    // 结束原因已由协议归一化到 OpenAI 词表（`protocol.ts` 文件头口径 ①）——
    // 上层（`chatBot`）靠 `!== 'stop'` 判"可能被截断"，三协议必须是同一套词表
    rawFinishReason: parsed.finishReason,
    usage: parsed.usage,
    toolCalls: readToolCalls(buffer).calls,
    durationMs: Date.now() - startedAt,
  }
}

// 原 `readCompletionPayload` / `readDeltaText` / `readUsage` 三个函数 P0-1-37 起搬到了
// `./protocol.ts`（三协议各有一份报文形状，它们正是"哪个协议取哪个字段"的实现）。
// 本文件不再认识 `choices` / `content` / `usage` 这些字段名 —— 这正是 ② 那条边界。

// ═════════════════════════════════════════════════════════════════════
// chatStream()：SSE 增量
// ═════════════════════════════════════════════════════════════════════

/**
 * 流式对话（`02` §六 第 3 步）：每收到一个增量就回调，返回汇总。
 *
 * 返回**而不是**抛异常来表示"正常结束"：正常结束有多种形态（有/无 `[DONE]`、
 * 有/无 `finish_reason`），都归到 {@link ChatStreamSummary}；只有真故障才抛。
 *
 * 工具（P0-2-8）：`tools` 传下去，上游回的 `tool_calls` **在这里只累积、不解析**
 * （`arguments` 是逐段拼出来的，第一片就 parse 会得到空参数）⇒ 汇总里给的是**完整的**
 * {@link ChatStreamSummary.toolCalls}。工具循环（`chatBot.ts`）据此决定"再调一轮还是收尾"。
 *
 * @throws {AppError} `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT`
 * @throws {LlmAbortError} 调用方中断（用户点停止）—— 已收到的增量留在 `onDelta` 那侧，
 *         调用方自行决定是否落库（`02` §5.2「停止」推 `done{STOPPED}`）
 */
export async function chatStream(
  target: LlmTarget,
  messages: ChatMessage[],
  callbacks: ChatStreamCallbacks,
  options: ChatOptions = {},
): Promise<ChatStreamSummary> {
  const startedAt = Date.now()
  const deadline = new Deadline()
  const unlink = linkAbort(options.abortSignal, deadline)
  const headingMs = options.timeoutMs ?? config.llm.requestTimeoutMs
  /** 流内空闲的窗口：每收一块就重置（见文件头 ③） */
  const idleMs = options.idleTimeoutMs ?? config.llm.streamIdleTimeoutMs
  const endpoint = endpointOf(target)
  const protocol = protocolOf(target.protocol)
  const decodeCtx = decodeContextOf(target)
  /**
   * 工具调用的累积器（**半成品只活在这里**，见 `protocol.ts` 文件头 ③）。
   *
   * 它必须在 `buildBody` 之前就位：**非流式兜底那一路**（上游忽略 `stream:true`）
   * 也要往同一个累积器里灌，否则同一个上游会在"这次回了 JSON"时静默丢掉工具调用。
   */
  const toolBuffer = createToolCallBuffer()

  const body = protocol.buildBody({
    model: target.modelName,
    messages,
    stream: true,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    tools: options.tools,
    requestReasoning: target.supportsReasoning,
    extraBody: options.extraBody,
  })
  // ⚠️ 刻意不写 `stream_options`（见文件头 ②）：它是 400 的常见来源，而 usage 只是锦上添花

  let response: Response
  try {
    deadline.arm(headingMs, '首次响应（到响应头）')
    response = await fetch(`${target.baseUrl}${protocol.chatPath}`, {
      method: 'POST',
      headers: protocol.headers(endpoint, { accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: deadline.signal,
    })
  } catch (error) {
    deadline.clear()
    if (options.abortSignal?.aborted === true) throw new LlmAbortError('调用已被调用方中断')
    toUpstreamFailure(error, deadline, endpoint, 'chatStream')
  } finally {
    unlink()
  }

  // 响应头到手 → 撤掉"到响应头"的计时（否则长回答会被它腰斩），换到"流内空闲"
  deadline.clear()
  if (!response.ok) await throwUpstreamStatus(response, endpoint, 'chatStream')

  const contentType = response.headers.get('content-type') ?? ''
  const looksStream = contentType.includes('text/event-stream')

  // ── 兼容：声称支持流、却直接回了一坨 JSON 的实现 ──
  if (!looksStream) {
    let raw: string
    try {
      deadline.arm(idleMs, '流内空闲')
      raw = await response.text()
    } catch (error) {
      if (options.abortSignal?.aborted === true) throw new LlmAbortError('调用已被调用方中断')
      toUpstreamFailure(error, deadline, endpoint, 'chatStream')
    } finally {
      deadline.clear()
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw AppError.upstreamError(
        `上游既不是 SSE 也不是 JSON（content-type=${contentType || '(空)'}）：${target.providerName}。响应：${snippet(raw, target.apiKey)}`,
      )
    }
    getLogger().warn(
      { ...describeTarget(target), contentType },
      '上游忽略了 stream:true（回的是 JSON），已按非流式处理',
    )
    const parsed = protocol.readNonStream(payload, decodeCtx)
    if (parsed.text !== '') callbacks.onDelta(parsed.text)
    if (parsed.thinking !== '') callbacks.onThinking?.(parsed.thinking)
    if (parsed.usage !== null) callbacks.onUsage?.(parsed.usage)
    // ⚠️ 这一路也要灌累积器：上游忽略 `stream:true` 时工具调用**照样可能在报文里**
    absorbToolCalls(toolBuffer, parsed.toolCalls)
    const fallback = readToolCalls(toolBuffer)
    if (fallback.incomplete > 0) {
      logIncompleteToolCalls(target, fallback.incomplete)
    }
    return {
      text: parsed.text,
      rawFinishReason: parsed.finishReason,
      usage: parsed.usage,
      deltaCount: parsed.text === '' ? 0 : 1,
      malformedFrames: 0,
      toolCalls: fallback.calls,
      incompleteToolCalls: fallback.incomplete,
      durationMs: Date.now() - startedAt,
    }
  }

  const stream = response.body
  if (stream === null) {
    throw AppError.upstreamError(`上游声明的流式响应没有 body：${target.providerName}`)
  }

  const state: StreamState = {
    text: '',
    deltaCount: 0,
    malformedFrames: 0,
    rawFinishReason: null,
    usage: null,
  }
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let dataLines: string[] = []
  /** 当前 SSE 事件的 `event:` 名（Anthropic 用它区分帧种类；下一个空行后复位） */
  let eventName: string | null = null
  /** 见过"流结束信号"（`[DONE]` / `message_stop` / `response.completed`）—— 只用于一行 debug 日志 */
  let endSignalSeen = false

  /**
   * 每个增量之前都查一次调用方的信号。
   *
   * 只靠"abort 让网络读失败"是不够的（踩到）：一帧才几十字节，网关常把整个响应
   * 一次塞进一个 TCP 包 —— 于是 `body` 里已经缓冲好的数据会**继续**被读出来，
   * 用户的"停止"要等到缓冲耗尽才生效（表现出来就是"点了停止，回答还在往外冒"）。
   */
  const throwIfAborted = (): void => {
    if (options.abortSignal?.aborted === true) throw new LlmAbortError('调用已被调用方中断（流式）')
  }

  /** 把协议解出来的一帧并进汇总，并回调 —— **这里不认识任何协议字段名**（边界见文件头 ②） */
  const applyFrame = (frame: DecodedFrame): void => {
    if (frame.thinking !== '') callbacks.onThinking?.(frame.thinking)
    if (frame.text !== '') {
      state.text += frame.text
      state.deltaCount += 1
      callbacks.onDelta(frame.text)
    }
    if (frame.finishReason !== null) state.rawFinishReason = frame.finishReason
    if (frame.usage !== null) {
      /**
       * ⚠️ 是**合并**不是替换：Anthropic 把一个 usage 拆在 `message_start`（input_tokens）
       * 与 `message_delta`（output_tokens）两帧里 —— 直接替换会丢掉前一半。
       * 对"一次给全"的 OpenAI 系来说，合并等价于赋值。
       * ⚠️ 与"多轮相加"（{@link sumUsages}）是两件事：这里是**同一次调用的两半**。
       */
      state.usage = mergeUsage(state.usage, frame.usage)
      callbacks.onUsage?.(state.usage)
    }
    // ⚠️ **只累积，不解析**（`arguments` 此刻可能只是 `{"a":`）—— 见 `protocol.ts` 文件头 ③
    if (frame.toolCalls.length > 0) absorbToolCalls(toolBuffer, frame.toolCalls)
    if (frame.done) endSignalSeen = true
  }

  const dispatch = (): void => {
    const event = eventName
    eventName = null
    if (dataLines.length === 0) return
    throwIfAborted()
    // SSE 规范：一个事件的多个 `data:` 行用换行拼接
    const payload = dataLines.join('\n')
    dataLines = []
    if (protocol.isDoneSentinel(payload, event)) {
      endSignalSeen = true
      return
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch {
      // 上游偶发截断/心跳塞了非 JSON —— 跳过并计数，不能因为一帧坏了就丢掉整条回答
      state.malformedFrames += 1
      getLogger().warn(
        { ...describeTarget(target), payload: snippet(payload, target.apiKey) },
        '流内出现无法解析的帧（已跳过）',
      )
      return
    }
    applyFrame(protocol.readStreamFrame(chunk, event, decodeCtx))
  }

  try {
    deadline.arm(idleMs, '流内空闲')
    for await (const piece of stream) {
      deadline.arm(idleMs, '流内空闲')
      throwIfAborted()
      buffer += decoder.decode(piece as Uint8Array, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) line = line.slice(0, line.length - 1)
        if (line === '') {
          dispatch() // 空行 = 一帧结束
        } else if (line.startsWith(':')) {
          // 注释行（保活 `: ping`）—— 忽略，但它已通过 idle.arm() 重置了空闲计时，这正是要的效果
        } else if (line.startsWith('event:')) {
          // ⚠️ P0-1-37 起要收它：Anthropic 用 `event:` 区分帧种类（`message_stop` / `error`…）。
          // SSE 规范：`event:` 对**紧随其后**的那个 data 块生效 ⇒ 记下来，dispatch 后复位。
          eventName = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart())
        }
        // 其它字段（`id:` / `retry:`）本层不消费：SSE 归一化在编排层（`02` §五）
        index = buffer.indexOf('\n')
      }
    }
    // 收尾：有的实现在最后一帧后不发空行 —— 把残留按一帧处理，否则最后几个字会凭空消失
    buffer += decoder.decode()
    if (buffer !== '') {
      const tail = buffer.endsWith('\r') ? buffer.slice(0, buffer.length - 1) : buffer
      if (tail.startsWith('data:')) dataLines.push(tail.slice('data:'.length).trimStart())
      else if (tail !== '' && !tail.startsWith(':')) dataLines.push(tail)
    }
    dispatch()
  } catch (error) {
    if (options.abortSignal?.aborted === true) {
      throw new LlmAbortError('调用已被调用方中断（流式）')
    }
    toUpstreamFailure(error, deadline, endpoint, 'chatStream')
  } finally {
    deadline.clear()
  }

  if (endSignalSeen) {
    // 措辞刻意中立：`[DONE]` 只是三种协议的结束信号之一（另有 `message_stop` / `response.completed`）
    getLogger().debug({ ...describeTarget(target), protocol: protocol.id }, '上游发来了流结束信号')
  }
  const toolCalls = readToolCalls(toolBuffer)
  if (toolCalls.incomplete > 0) {
    /**
     * 到这里还缺 `id` / `name` 的分片**调不了**，只能丢。⚠️ 必须留下线索：
     * 丢掉的症状是"模型说要调工具、界面上却什么都没有"，这条 warn 是唯一的解释
     * （告警落点刻意在调用方 —— `protocol.ts` 是纯函数层，见 P0-2-6 的同款手法）。
     */
    logIncompleteToolCalls(target, toolCalls.incomplete)
  }
  return {
    text: state.text,
    rawFinishReason: state.rawFinishReason,
    usage: state.usage,
    deltaCount: state.deltaCount,
    malformedFrames: state.malformedFrames,
    toolCalls: toolCalls.calls,
    incompleteToolCalls: toolCalls.incomplete,
    durationMs: Date.now() - startedAt,
  }
}

/** {@link readToolCalls} 里"缺 id/name 的段"的统一告警口（两处调用点共用同一句文案） */
function logIncompleteToolCalls(target: LlmTarget, count: number): void {
  getLogger().warn(
    { ...describeTarget(target), incompleteToolCalls: count },
    '上游给出的工具调用缺 id 或 name（无法执行，已丢弃）—— 模型可能报了一个残缺的工具调用',
  )
}

interface StreamState {
  text: string
  deltaCount: number
  malformedFrames: number
  rawFinishReason: string | null
  usage: ChatUsage | null
}

// 原 `applyStreamChunk`（"这一帧取哪个字段"）P0-1-37 起搬到了 `./protocol.ts`，
// 本文件只剩上面的 `applyFrame` —— 它只做"并进汇总 + 回调"，不认任何协议字段名。

// ═════════════════════════════════════════════════════════════════════
// fetchRemoteModels()：拉取"该配置下的模型"
// ═════════════════════════════════════════════════════════════════════

/**
 * 拉取 Provider 上游**实际提供**的模型列表（三协议都是 `GET {baseUrl}/models`）。
 *
 * 为什么要有它（用户 2026-09-21 提出）：模型池里的 `modelName` 全靠管理员手敲，
 * 而手敲错一个字符要等到第一次发消息才以 404 暴露。这是"通用"能力 ——
 * OpenAI 兼容实现基本都提供该端点，且**不需要** Key 也能列（自建/内网实现常见）。
 *
 * 三种返回形态都收（实测过：网关各不相同）：
 *   · 标准 `{ object: 'list', data: [{ id, owned_by, created }] }`
 *   · `{ models: [{ name, model }] }`（llama.cpp / ollama 一类的兼容层）
 *   · 裸数组 `[{ id }]`
 *
 * ⚠️ P0-1-37：鉴权头**随协议**走。Anthropic 的 `/models` 同样要 `x-api-key`
 * （只是没用 `Authorization` 而已），所以这里不能再无脑套 `upstreamHeaders`。
 *
 * @throws {AppError} `UPSTREAM_ERROR`(502) 上游非 2xx（404 时文案点明"该实现可能不提供 /models"）
 *                    / `UPSTREAM_TIMEOUT`(504) 超时
 * @throws {LlmAbortError} 调用方中断
 */
export async function fetchRemoteModels(
  target: Pick<LlmTarget, 'providerName' | 'baseUrl' | 'apiKey'> & Pick<Partial<LlmTarget>, 'protocol'>,
  options: Pick<ChatOptions, 'abortSignal' | 'timeoutMs'> = {},
): Promise<{ items: RemoteModel[]; total: number; truncated: boolean }> {
  // 这个探测请求没有"某个模型"这个主语（`subject` 缺省时消息里只写上游名）
  const endpoint: UpstreamEndpoint = {
    providerName: target.providerName,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
  }
  const protocol = protocolOf(target.protocol)

  let payload: unknown
  try {
    payload = await fetchUpstreamJson(endpoint, {
      path: protocol.modelsPath,
      method: 'GET',
      headers: protocol.headers(endpoint, { json: false }),
      timeoutMs: options.timeoutMs ?? config.llm.requestTimeoutMs,
      abortSignal: options.abortSignal,
      stage: 'get /models',
    })
  } catch (error) {
    if (options.abortSignal?.aborted === true) throw new LlmAbortError('拉取上游模型列表已被中断')
    // 404 单独给文案：不是所有实现都提供列表，此时"手工录入"才是正解
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { data?: { upstreamStatus?: unknown } }).data?.upstreamStatus === 404
    ) {
      throw AppError.upstreamError(
        `上游没有 ${protocol.modelsPath} 端点（HTTP 404）：${target.providerName}。` +
          (protocol.id === 'ANTHROPIC_MESSAGES'
            ? 'Anthropic Messages 协议下该端点同样要带 x-api-key（本平台已按协议带上）；' +
              '若这是自建的兼容网关，请手工录入模型名。'
            : '该实现可能不提供模型列表（不是所有 OpenAI 兼容实现都实现它），请手工录入模型名。'),
        { upstreamStatus: 404 },
      )
    }
    throw error
  }

  const items = normalizeRemoteModels(payload)
  return {
    items: items.slice(0, REMOTE_MODELS_CAP),
    total: items.length,
    truncated: items.length > REMOTE_MODELS_CAP,
  }
}

/** 把三种形态归一化成 {@link RemoteModel}[]，并按 id 排序（两次调用结果**逐字相同**） */
export function normalizeRemoteModels(payload: unknown): RemoteModel[] {
  let list: unknown[] = []
  if (Array.isArray(payload)) {
    list = payload
  } else if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    if (Array.isArray(record.data)) list = record.data
    else if (Array.isArray(record.models)) list = record.models
  }

  const seen = new Set<string>()
  const items: RemoteModel[] = []
  for (const entry of list) {
    let id: string | null = null
    let ownedBy: string | null = null
    let created: number | null = null
    let contextLength: number | null = null
    if (typeof entry === 'string') {
      id = entry
    } else if (typeof entry === 'object' && entry !== null) {
      const row = entry as Record<string, unknown>
      for (const key of ['id', 'name', 'model']) {
        const value = row[key]
        if (typeof value === 'string' && value !== '') {
          id = value
          break
        }
      }
      const owner = row.owned_by ?? row.ownedBy ?? row.organization
      if (typeof owner === 'string' && owner !== '') ownedBy = owner
      const createdAt = row.created ?? row.created_at
      if (typeof createdAt === 'number' && Number.isFinite(createdAt)) created = createdAt
      // 上下文长度：各家字段名不一。**刻意不认 `max_tokens`**（那常指最大**输出**，不是上下文）。
      // OpenRouter=context_length；vLLM=max_model_len；另有 context_window / max_context(_length)。
      const rawContext =
        row.context_length ??
        row.context_window ??
        row.max_context_length ??
        row.max_context ??
        row.max_model_len
      if (typeof rawContext === 'number' && Number.isInteger(rawContext) && rawContext > 0) {
        contextLength = rawContext
      }
    }
    if (id === null || seen.has(id)) continue // 去重：有的网关把同一模型列两次（不同 owner）
    seen.add(id)
    items.push({ id, ownedBy, created, contextLength })
  }
  // 排序是刻意的：上游顺序不稳定时，前端列表会在两次刷新之间自己抖动（与 P0-1-11 的排序口径同因）
  return items.sort((a, b) => a.id.localeCompare(b.id))
}
