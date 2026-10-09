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
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 工具调用（P0-2-8）：三处差异全部收在本文件，外壳只做"累积"
 * ─────────────────────────────────────────────────────────────────────
 * 工具循环（`06` P0-2-8）最容易被写成"只在 OpenAI 兼容协议下能跑" —— 因为差异有**三处**，
 * 而每一处都不会报错、只会"调不动工具"或"调了个空工具"：
 *
 *   · **流式分片必须累积**（`06` 坑预判 1）：OpenAI 的 `delta.tool_calls[]` 是
 *     `index` + `id` + `function.name` + `function.arguments` **逐段**到达的，`arguments`
 *     本身还是**不完整的 JSON**；Anthropic 是 `content_block_start`（给 id/name）+
 *     若干 `content_block_delta`（`input_json_delta.partial_json`）；Responses 是
 *     `response.output_item.added` + 若干 `response.function_call_arguments.delta`。
 *     ⇒ 本文件把三者归一成同一种**分片**（{@link ToolCallChunk}），累积器
 *     （{@link absorbToolCalls} / {@link readToolCalls}）也是同一份。**绝不在第一片 parse**。
 *     ⚠️ 累积器**不能只按 `index` 归段**：mimo（xiaomi）并行调用时每个调用都发 `index: 0`
 *     （违反 OpenAI 规范），照 index 拼会把多次调用揉成非法 JSON —— 详见 {@link ToolCallBuffer}。
 *     ⚠️ 还有更野的一手：mimo 会把参数的一部分**从 `content` 通道**以原生 XML
 *     （`<tool_call><function=…><parameter=…>`）吐出，害得 `arguments` 只剩半截。恢复见
 *     {@link parseTextToolCalls}（在 `client.ts` 收尾处调用）。
 *   · **工具结果回填的消息形态不同**（坑预判 2）：OpenAI 是 `role:'tool'` + `tool_call_id`；
 *     Anthropic 是**用户消息里的 `tool_result` 块**；Responses 是顶层
 *     `{type:'function_call_output', call_id}`。⇒ 全在各自的 `buildBody` 里映射，
 *     编排层只产出**协议无关**的 {@link ChatMessage}（`role:'tool'` + `toolCallId`）。
 *   · **`tools` 定义本身的形状不同**：OpenAI `{type:'function',function:{…}}`、
 *     Responses `{type:'function',name,description,parameters}`、Anthropic `{name,input_schema}`。
 *     P0-2-6 的转换产出的是 OpenAI 形态，故另外两家要在这里**再投影一次**。
 *
 * ⚠️ **加第四个协议时，这三处都必须在新对象里实现**（`docs/02` §6.1 差异收敛清单 16~18 条）——
 *    漏掉任何一处都表现为"这个协议下模型不会用工具"，而**日志里什么都不会说**。
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

/**
 * 一次工具调用**请求**（累积完成后的形态）。
 *
 * `arguments` 刻意保留**上游原样的 JSON 字符串**（而不是解析好的对象）：
 *   · OpenAI 系要求把它**原样回传**（`function.arguments` 是字符串）；
 *   · 落库（`messages.content.tool_calls[].arguments`）要的是"模型到底给了什么"，原样才有排查价值；
 *   · 解析只发生在真正要执行的那一刻（`client.ts` / `chatBot.ts` 用 {@link parseToolArguments}）——
 *     解析失败要能**说清是哪一串坏了**，先解析再回传就把这串丢了。
 */
export interface ChatToolCall {
  id: string
  /** **下发给模型的名字**（`mcp_{slug}_{tool}`），不是 MCP 侧的原始工具名 */
  name: string
  /** 参数 JSON 的**原始字符串**（可能不合法 —— 模型偶尔给半截 JSON） */
  arguments: string
}

/**
 * 流式里的一片工具调用增量（**永远不是完整的**，见文件头 ③）。
 *
 * 三协议都归一到这里：OpenAI 的 `delta.tool_calls[].index/id/function.name/function.arguments`、
 * Anthropic 的 `content_block_start`(+`input_json_delta`)、Responses 的
 * `response.output_item.added`(+`response.function_call_arguments.delta`)。
 */
export interface ToolCallChunk {
  /** 上游给的段序号（同名工具的多次调用靠它分开）；缺省时按 `0` 处理 */
  index: number
  id?: string
  name?: string
  /** 参数 JSON 的**片段**（可能是 `{"a":` 这种半截）—— ⚠️ 绝不能在这里 `JSON.parse` */
  argumentsDelta?: string
  /**
   * **整体**参数（只在"还没收到过任何 `argumentsDelta`"时生效）。
   *
   * 存在的唯一理由：Responses 的 `response.output_item.done` / `function_call_arguments.done`
   * 给的是**完整**参数，而同一轮里前面的 delta 已经拼过了 —— 把它当 delta 追加会**翻倍**，
   * 丢掉又会在"只发 done 不发 delta"的网关上**一个参数都没有**。故另开一条通道。
   */
  argumentsReplace?: string
}

/**
 * 一段**多模态内容**（P1-4）—— 协议无关的形态，三协议各映射到自己的字段名
 * （OpenAI `image_url` / Anthropic `image.source` / Responses `input_image`）。
 *
 * 只有 user 消息可能带它（本轮附件里的图片）；system / assistant / tool 一律是纯字符串。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string }

/** 消息内容：纯文本（绝大多数）或**内容块数组**（带图片的多模态用户消息） */
export type ChatMessageContent = string | ChatContentPart[]

/** 对话消息 —— **协议无关**的形态（各协议怎么落到报文里由 `buildBody` 负责，见文件头 ③） */
export type ChatMessage =
  | {
      role: 'system' | 'user' | 'assistant'
      content: ChatMessageContent
      /** 助手这一轮**请求调用**的工具（`finish_reason=tool_calls` 时才有） */
      toolCalls?: ChatToolCall[]
    }
  | {
      /** 工具执行结果 —— OpenAI/Responses/Anthropic 各有一种落法（文件头 ③） */
      role: 'tool'
      content: string
      /** 对应哪一个调用（= 上游给的 `id`） */
      toolCallId: string
      /** 工具自报失败（只映射到 Anthropic 的 `is_error`；另两家没有这个字段） */
      isError?: boolean
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
  /** 这一帧带来的工具调用**分片**（见文件头 ③；累积归外壳，本层只负责取字段） */
  toolCalls: ToolCallChunk[]
}

/** 造一帧：只写非默认字段，省掉每个 return 都补齐六个键 */
function dec(partial: Partial<DecodedFrame> = {}): DecodedFrame {
  return { text: '', thinking: '', finishReason: null, usage: null, done: false, toolCalls: [], ...partial }
}

// ═════════════════════════════════════════════════════════════════════
// 协议钩子的形状
// ═════════════════════════════════════════════════════════════════════

/**
 * 工具定义（**OpenAI 形态**，即 `mcp/toolSchema.ts#toOpenAiTools` 的产出）。
 *
 * ⚠️ 刻意**不复用 `mcp/toolSchema.ts` 的 `OpenAiFunctionTool`**（与 {@link McpFetch} 那条同款纪律，
 * 也见 `mcp/client.ts` 的注释）：那会让 LLM 层依赖 MCP 层，而这一层要能在**没有 MCP** 的情况下
 * 被理解与断言。形状**逐字相同** ⇒ 赋值是结构性成立的，不需要 `as`。
 */
export interface ProtocolToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema，**object 根**（P0-2-6 已保证） */
    parameters: Record<string, unknown>
  }
}

/** 一次对话调用的"协议无关"输入（由 `client.ts` 从 `LlmTarget` + `ChatOptions` 组装） */
export interface ProtocolChatRequest {
  /** 上游真实型号名 */
  model: string
  /** **原样**的消息数组（含 system 与 tool 结果）—— 要不要把 system 挪到顶层由协议自己决定 */
  messages: ChatMessage[]
  stream: boolean
  maxTokens?: number
  temperature?: number
  /** 下发给模型的工具（OpenAI 形态；形状投影由各协议自己做，见文件头 ③）。缺省 = 不带 `tools` */
  tools?: readonly ProtocolToolDefinition[]
  /**
   * 是否请求"深度思考"（reasoning / thinking）。来自模型的 `supportsReasoning`。
   * `true` 时各协议在 `buildBody` 里落各自的思考参数（兼容：`reasoning_effort`；
   * Responses：`reasoning.effort`；Anthropic：`thinking`）。缺省/`false` = 不发任何思考参数。
   */
  requestReasoning?: boolean
  /** 原样并入请求体的逃生口（`top_p` 之类），协议特有字段最后仍可覆盖 */
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
  /**
   * 请求体（含"system 放哪 / 上限字段叫什么 / 有没有必填项"）。
   *
   * ⚠️ **工具相关的三件事都必须在这里映射**（见文件头 ③）：`request.tools` 的投影、
   * `role:'tool'` 消息的落法、带 `toolCalls` 的助手消息的落法。
   */
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
// 工具调用：累积器 + 参数解析 + 多轮用量累加（三协议共用，见文件头 ③）
// ═════════════════════════════════════════════════════════════════════

/**
 * 一段**正在累积**的工具调用（`id` / `name` 可能还没到，`args` 可能是半截 JSON）。
 *
 * 刻意不在这里暴露出去：它是"半成品"，而半成品一旦被别处拿到，就一定会有人去 parse 它。
 */
interface ToolCallSegment {
  id: string | null
  name: string | null
  args: string
}

/**
 * 累积器。**半成品只活在 `client.ts` 的一个局部变量里**（它不认识工具、也不解析参数）。
 *
 * 用 `Map` 而不是数组：段的到达顺序**不保证**（网关可能把 index=1 的片先发出来），
 * 而 `Map` 既保插入序、又按键去重 —— 输出顺序因此是"上游给的顺序"，
 * 与 `06` 坑预判 4 的"一次多个 `tool_calls` 按顺序执行"对得上。
 *
 * ⚠️ **不能只按上游 `index` 归段**（2026-10-08 实测并修复）：mimo（xiaomi）在**并行**工具调用时
 * **每个调用都发 `index: 0`**（只有首片带新 `id`），照 OpenAI 规范应递增 index。若按 index 归段，
 * 多个调用的 `arguments` 分片会被拼进同一段 ⇒ 得到 `{"a":1}{"a":2}` 这种非法 JSON
 * （症状：`工具调用失败：模型给出的参数不是合法 JSON`，且模型反复重试烧光轮数）。
 * 因此这里改为**以"新 id"作为一次调用的边界**归段，`index` 只作为"无 id 的后续分片"的兜底索引。
 */
export interface ToolCallBuffer {
  /** 段键（**本模块自增分配**，不再等于上游 index）→ 段 */
  readonly segments: Map<number, ToolCallSegment>
  /** 已见过的调用 `id` → 段键（重复出现的 id 归到同一次调用） */
  readonly idToKey: Map<string, number>
  /**
   * 上游 `index` → **最近一次**以该 index 打开的段的键。无 id 的后续分片按它归位：
   *   · 标准 OpenAI/Responses/Anthropic：每个调用的 index 唯一 ⇒ 精确命中自己的段；
   *   · mimo 并行调用：所有调用 index 都是 0 ⇒ 命中的是**最近打开**的那次（正确）。
   */
  readonly indexToKey: Map<number, number>
  /** 段键自增分配器 */
  nextKey: number
}

export function createToolCallBuffer(): ToolCallBuffer {
  return { segments: new Map(), idToKey: new Map(), indexToKey: new Map(), nextKey: 0 }
}

/** 把一帧带来的分片并进累积器（**只做字符串拼接，不解析**） */
export function absorbToolCalls(buffer: ToolCallBuffer, chunks: readonly ToolCallChunk[]): void {
  for (const chunk of chunks) {
    // 空串按"这一片没带"处理（有的网关会先发一个 `id: ""` 的占位片，覆盖会把真 id 冲掉）
    const incomingId = chunk.id !== undefined && chunk.id !== '' ? chunk.id : null

    // ── 决定这一段并进哪个 key ──
    let key: number
    if (incomingId !== null) {
      const known = buffer.idToKey.get(incomingId)
      if (known !== undefined) {
        key = known
      } else {
        /**
         * **新 id = 新一次调用**（见接口注释：不能用 chunk.index —— mimo 并行调用 index 恒为 0）。
         *
         * 分配新键前做两件防御（针对"不走标准协议"的上游，标准三家首片必带 id，用不到）：
         *   · **收养**：该 index 上若已有一段"无主段"（参数先到、id 后到）⇒ 认领它，别把参数丢了；
         *   · **跳过已占用键**：自增键绝不覆盖任何现有段（否则会静默吞掉另一个调用的参数）。
         */
        const mapped = buffer.indexToKey.get(chunk.index)
        const raw = buffer.segments.get(chunk.index)
        if (mapped === undefined && raw !== undefined && raw.id === null) {
          key = chunk.index
        } else {
          key = buffer.nextKey
          while (buffer.segments.has(key)) key += 1
          buffer.nextKey = key + 1
        }
        buffer.idToKey.set(incomingId, key)
      }
      buffer.indexToKey.set(chunk.index, key)
    } else {
      // 无 id 的后续分片：按上游 index 找"最近以该 index 打开的段"，找不到再退回 index 本身
      key = buffer.indexToKey.get(chunk.index) ?? chunk.index
    }

    const segment = buffer.segments.get(key) ?? { id: null, name: null, args: '' }
    if (incomingId !== null) segment.id = incomingId
    if (chunk.name !== undefined && chunk.name !== '') segment.name = chunk.name
    if (chunk.argumentsDelta !== undefined) segment.args += chunk.argumentsDelta
    // 见 {@link ToolCallChunk.argumentsReplace}：只补"一片 delta 都没收到"的空档
    if (chunk.argumentsReplace !== undefined && segment.args === '') segment.args = chunk.argumentsReplace
    buffer.segments.set(key, segment)
  }
}

/** {@link readToolCalls} 的产出 */
export interface ToolCallSnapshot {
  /** 可以执行的调用（`id` + `name` 都齐了） */
  calls: ChatToolCall[]
  /**
   * 收到了分片、但缺 `id` 或 `name` 的段数 —— **它调不了**，只能丢。
   *
   * 为什么要报数而不是静默丢：丢掉的症状是"模型说要调工具，界面上却什么都没有"，
   * 而这条是唯一能解释它的线索。**告警落点在调用方**（本模块不 import 日志，同 P0-2-6 的手法）。
   */
  incomplete: number
}

/** 读累积结果（**在 `finish_reason==='tool_calls'` 或流结束之后才调**，见文件头 ③） */
export function readToolCalls(buffer: ToolCallBuffer): ToolCallSnapshot {
  const calls: ChatToolCall[] = []
  let incomplete = 0
  for (const segment of buffer.segments.values()) {
    if (segment.id === null || segment.name === null) {
      incomplete += 1
      continue
    }
    calls.push({ id: segment.id, name: segment.name, arguments: segment.args })
  }
  return { calls, incomplete }
}

/** {@link parseToolArguments} 的产出（判别联合：失败时带**给人看的原因**） */
export type ToolArgumentsParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string }

/**
 * 解析模型给的参数 JSON —— **唯一实现**（编排层真的要用，Anthropic 那次**投影**也要用）。
 *
 * 三条口径：
 *   · **空串按 `{}`**（不是失败）：没有任何参数的工具，多数网关给的 `arguments` 就是 `""`；
 *     判成失败会让"调一个无参工具"永远失败，而这是最常见的一类工具；
 *   · **解析失败 / 不是对象都算失败**，且 `reason` 是给**用户与模型**看的中文（会被回填给模型，
 *     它据此改一次就可能成功）—— 不在这里抛错：一条坏参数只该让**这一次调用**失败，见 P0-2-8 门槛 2；
 *   · ⚠️ **不猜测**（不截断、不补全、不去里面捞一个像样的子串）：猜出来的参数会让工具**静默做错事**，
 *     比"模型收到一条错误说明、再试一次"坏得多（同 `mcp/toolSchema.ts` 文件头的判断）。
 */
export function parseToolArguments(raw: string): ToolArgumentsParse {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: '模型给出的参数不是合法 JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '模型给出的参数不是 JSON 对象' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/** {@link parseTextToolCalls} 的产出：从正文里捞出来的调用（**还没有 id**，由调用方补） */
export interface TextToolCall {
  name: string
  arguments: string
}

/** 正文里的 mimo 原生调用块 */
const TEXT_TOOL_CALL_BLOCK = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call\s*>/gi
/** 块内的 `<function=NAME>…</function>` */
const TEXT_FUNCTION_BLOCK = /<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function\s*>/i
/** 函数内的 `<parameter=KEY>VALUE</parameter>`（可重复） */
const TEXT_PARAMETER_BLOCK = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter\s*>/gi

/** 常见 XML 实体解码（mimo 的参数值是纯文本，正常不会用到，做一层保险） */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 把 XML 里的文本值还原成标量：`true`/`false`/`null`/数字 还原类型，其余保持字符串 */
function coerceXmlScalar(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return raw
}

/**
 * 从**正文文本**里解析工具调用 —— 专治 mimo（xiaomi）的一个协议缺陷（2026-10-08 实测）。
 *
 * 缺陷是什么：mimo 在**流式**下发工具调用时，会把一部分参数**从 `content` 通道**以
 * `<tool_call><function=NAME><parameter=KEY>VALUE</parameter>…</function></tool_call>` 的
 * 原生 XML 形式吐出来，而 `delta.tool_calls[].function.arguments` **只有前半截**
 * （实测参数值恰好落在 content 里）。结果：`tool_calls` 通道拼出来的 `arguments` 是
 * `{"name": "…", "parentId": ` 这种**截断的非法 JSON**，而**完整内容其实在正文里**。
 *
 * 所以恢复办法是：**正文里的 XML 才是这次调用的完整信息来源**，按它重建 `{name, arguments}`。
 * 只对本格式生效 —— 标准 OpenAI/Responses/Anthropic 不会把调用写进正文，解析结果为空、不影响。
 *
 * ⚠️ 值与键都按纯文本读；值做标量还原（数字/布尔/null），其余按字符串。**不猜测缺失字段**：
 * 正文里没有的键就是没有，与 {@link parseToolArguments} 的"不猜"纪律一致。
 */
export function parseTextToolCalls(text: string): TextToolCall[] {
  const calls: TextToolCall[] = []
  if (!text.includes('<tool_call')) return calls
  TEXT_TOOL_CALL_BLOCK.lastIndex = 0
  let block: RegExpExecArray | null
  while ((block = TEXT_TOOL_CALL_BLOCK.exec(text)) !== null) {
    const fn = TEXT_FUNCTION_BLOCK.exec(block[1] ?? '')
    if (fn === null) continue
    const name = (fn[1] ?? '').trim()
    if (name === '') continue
    const args: Record<string, unknown> = {}
    TEXT_PARAMETER_BLOCK.lastIndex = 0
    let param: RegExpExecArray | null
    while ((param = TEXT_PARAMETER_BLOCK.exec(fn[2] ?? '')) !== null) {
      const key = (param[1] ?? '').trim()
      if (key === '') continue
      args[key] = coerceXmlScalar(decodeXmlEntities(param[2] ?? ''))
    }
    calls.push({ name, arguments: JSON.stringify(args) })
  }
  return calls
}

/**
 * **多轮之间**的用量累加（工具循环里一次问答要调好几轮上游）。
 *
 * ⚠️ 与 {@link mergeUsage} 是**两种不同的合并口径**，别混用：
 *   · `mergeUsage` = "**同一次**调用的两半"（Anthropic 分帧给）⇒ 非空字段**覆盖**；
 *   · 本函数 = "**这一轮问答的若干次**调用" ⇒ 非空字段**相加**。
 * 任一字段有一个 `null`（某次上游没给）⇒ 结果该字段为 `null`：**加起来不等于知道**
 * （与 `schema.prisma` 的 `tokens_*` 可空同款口径：不知道就不编一个 0）。
 * 三字段关系恒满足 `total = in + out`（只在两者都齐时才算，否则 `null`）。
 */
export function sumUsages(a: ChatUsage | null, b: ChatUsage | null): ChatUsage | null {
  if (a === null) return b
  if (b === null) return a
  const add = (left: number | null, right: number | null): number | null =>
    left === null || right === null ? null : left + right
  const tokensIn = add(a.tokensIn, b.tokensIn)
  const tokensOut = add(a.tokensOut, b.tokensOut)
  return {
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn === null || tokensOut === null ? null : tokensIn + tokensOut,
  }
}

// ═════════════════════════════════════════════════════════════════════
// ① OPENAI_COMPAT —— 默认协议，P0-1-12 起的全部行为
// ═════════════════════════════════════════════════════════════════════

/**
 * 助手消息的 `tool_calls`（OpenAI 形态；`arguments` **原样字符串**，不解析）。
 *
 * `type: 'function'` 是必填：少了它有的网关直接 400（"Invalid type for tool_calls"）。
 */
function toOpenAiToolCalls(toolCalls: readonly ChatToolCall[]): Record<string, unknown>[] {
  return toolCalls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }))
}

/**
 * 协议无关的 {@link ChatMessage} → OpenAI 报文里的消息。
 *
 * 两处**必须**映射（而不是把消息对象原样透出去）：
 *   · 工具结果 ⇒ `role:'tool'` + `tool_call_id`（OpenAI 的字段名，不是 `toolCallId`）；
 *   · 助手的 `toolCalls` ⇒ `tool_calls[]`，且 **`content` 给 `null` 而不是空串**
 *     （带 `tool_calls` 时空串会让一部分网关 400；`null` 是规范允许的形态）。
 * ⚠️ 原样透出还有第二个坏处：`toolCallId` / `isError` 这些**我们自己的字段名**会漏到线上。
 */
/** 内容为空判定（字符串空串 / 空块数组都算空）—— 三协议共用 */
function isEmptyContent(content: ChatMessageContent): boolean {
  if (typeof content === 'string') return content === ''
  return content.length === 0
}

/** 图片 data URL（OpenAI / Responses 的 `image_url` 都收这种形态） */
function toDataUrl(part: Extract<ChatContentPart, { type: 'image' }>): string {
  return `data:${part.mimeType};base64,${part.dataBase64}`
}

/** 协议无关内容 → OpenAI 的 `content`（字符串原样；块数组映射 `text` / `image_url`） */
function toOpenAiContent(content: ChatMessageContent): unknown {
  if (typeof content === 'string') return content
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: toDataUrl(part) } },
  )
}

/** 协议无关内容 → Responses 的 `content`（块数组用 `input_text` / `input_image`） */
function toResponsesContent(content: ChatMessageContent): unknown {
  if (typeof content === 'string') return content
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : { type: 'input_image', image_url: toDataUrl(part) },
  )
}

/** 协议无关内容 → Anthropic 的块数组（`text` / `image.source`） */
function toAnthropicBlocks(content: ChatMessageContent): AnthropicBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.dataBase64 } },
  )
}

function toOpenAiMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
      continue
    }
    const row: Record<string, unknown> = { role: message.role, content: toOpenAiContent(message.content) }
    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      row.tool_calls = toOpenAiToolCalls(message.toolCalls)
      if (isEmptyContent(message.content)) row.content = null
    }
    out.push(row)
  }
  return out
}

/** 流的 `choices[].delta.tool_calls[]`：**分片**，`index` 由上游给（缺省归 0） */
function readOpenAiToolCallDeltas(raw: unknown): ToolCallChunk[] {
  if (!Array.isArray(raw)) return []
  const chunks: ToolCallChunk[] = []
  for (const entry of raw) {
    const row = asRecord(entry)
    if (row === null) continue
    const fn = asRecord(row.function) ?? {}
    chunks.push({
      index: num(row.index) ?? 0,
      id: str(row.id) ?? undefined,
      name: str(fn.name) ?? undefined,
      argumentsDelta: str(fn.arguments) ?? undefined,
    })
  }
  return chunks
}

/** 非流式的 `message.tool_calls[]`：**完整**，且没有 `index`（数组位置就是段序号） */
function readOpenAiToolCalls(raw: unknown): ToolCallChunk[] {
  if (!Array.isArray(raw)) return []
  const chunks: ToolCallChunk[] = []
  raw.forEach((entry, index) => {
    const row = asRecord(entry)
    if (row === null) return
    const fn = asRecord(row.function) ?? {}
    chunks.push({
      index,
      id: str(row.id) ?? undefined,
      name: str(fn.name) ?? undefined,
      argumentsDelta: str(fn.arguments) ?? undefined,
    })
  })
  return chunks
}

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
      messages: toOpenAiMessages(request.messages),
      stream: request.stream,
    }
    // ⚠️ `undefined` 就不带这个字段（交给上游默认），而不是写一个 `null` 上去
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    // 本协议的 `tools` 就是 OpenAI 形态 ⇒ 原样（另两家的投影在各自己的分支里）
    if (request.tools !== undefined) body.tools = request.tools
    // 深度思考：OpenAI（及多数兼容网关）用 `reasoning_effort`。管理员在模型上显式勾了
    // supportsReasoning 才发 —— 若上游不认这个字段会 400，届时把开关关掉即可（配置期可回退）。
    if (request.requestReasoning === true) body.reasoning_effort = REASONING_EFFORT_DEFAULT
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
      toolCalls: readOpenAiToolCalls(message.tool_calls),
    })
  },

  readStreamFrame(chunk, _event, ctx) {
    const record = asRecord(chunk)
    if (record === null) return dec()
    if (asRecord(record.error) !== null) throwUpstreamErrorFrame(ctx, record.error, '在流中')

    let text = ''
    let thinking = ''
    let finishReason: string | null = null
    const toolCalls: ToolCallChunk[] = []
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
      // ⚠️ 只**累积分片**，不在这里 parse（`arguments` 此刻可能只是 `{"a":`，见文件头 ③）
      toolCalls.push(...readOpenAiToolCallDeltas(delta.tool_calls))
    }
    return dec({ text, thinking, finishReason, usage: readUsage(record.usage), toolCalls })
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

/**
 * Responses 的 `input` —— ⚠️ 与其他两家最大的不同：**"工具活动"是与消息同级的 item**
 * （不是挂在消息上的一个字段），故一次助手工具调用会展开成"一条 assistant 消息 + N 条
 * `function_call` item"，工具结果则是 `function_call_output`（见文件头 ③）。
 *
 * `call_id` 而不是 `item.id`：前者是与 `function_call_output` 配对的那个键
 * （在 Responses 里 item 自己的 `id` 与 `call_id` 是**两个**东西）。
 * ⚠️ `item` 的完整形态（是否要带 `status`）**未对着真上游验过**（本仓没有 Responses 的假上游）
 * —— 这里只写**规范里最小的那组字段**，待有一家可达的 Responses 实现时再补。
 */
function toResponsesInput(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system') continue // 顶层 `instructions`（见 buildBody）
    if (message.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
      continue
    }
    // 带 `tool_calls` 而正文为空是常态（模型直接给调用、不回一句话）⇒ 空正文不占一个 item
    if (!isEmptyContent(message.content)) {
      out.push({ role: message.role, content: toResponsesContent(message.content) })
    }
    for (const call of message.toolCalls ?? []) {
      out.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
    }
  }
  return out
}

/** OpenAI 形态的工具 → Responses 的工具（**字段位置不同**：`name`/`parameters` 在顶层） */
function toResponsesTools(tools: readonly ProtocolToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

/**
 * Responses 的 `output[]` 里 `type='function_call'` 的 item → 分片（**完整**形态，故走 `argumentsDelta`）。
 *
 * `index` 取**数组位置**：非流式里这些 item 是一次给全的，没有"段序号"这回事；
 * 反正到了执行那一步，顺序由这里定。
 */
function readResponsesToolCalls(rawOutput: unknown): ToolCallChunk[] {
  if (!Array.isArray(rawOutput)) return []
  const chunks: ToolCallChunk[] = []
  rawOutput.forEach((rawItem, index) => {
    const item = asRecord(rawItem)
    if (item === null || str(item.type) !== 'function_call') return
    chunks.push({
      index,
      // `call_id` 才是与 `function_call_output` 配对的键；`item.id` 是另一个东西（见 `toResponsesInput`）
      id: str(item.call_id) ?? str(item.id) ?? undefined,
      name: str(item.name) ?? undefined,
      argumentsDelta: str(item.arguments) ?? undefined,
    })
  })
  return chunks
}

const openAiResponses: ChatProtocol = {
  id: 'OPENAI_RESPONSES',
  label: 'OpenAI Responses',
  chatPath: '/responses',
  modelsPath: '/models',

  // 鉴权形状与兼容协议相同 ⇒ 复用同一份实现
  headers: (endpoint, options = {}) => upstreamHeaders(endpoint, options),

  buildBody(request) {
    // 系统提示挪到顶层 `instructions`（`02` §6.1 映射表）；`input` 只留 user/assistant/工具活动
    const instructions = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
    const input = toResponsesInput(request.messages)

    const body: Record<string, unknown> = { model: request.model, input, stream: request.stream }
    if (instructions !== '') body.instructions = instructions
    // ⚠️ 字段名不一样：Responses 是 `max_output_tokens`
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.tools !== undefined) body.tools = toResponsesTools(request.tools)
    // 深度思考：Responses 用 `reasoning.effort`（推理模型才认；勾了 supportsReasoning 才发）
    if (request.requestReasoning === true) body.reasoning = { effort: REASONING_EFFORT_DEFAULT }
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
      toolCalls: readResponsesToolCalls(output),
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
      // ── 工具调用（P0-2-8）──
      // `output_item.added` 给 id/name，`function_call_arguments.delta` 给参数**分片**；
      // 两个 `.done` 给的是**完整**参数 ⇒ 走 `argumentsReplace`（当 delta 追加会翻倍，见该字段的注释）
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = asRecord(record.item)
        // ⚠️ 只认 `function_call`：`message` / `reasoning` / `web_search_call` 之类与工具循环无关
        if (item === null || str(item.type) !== 'function_call') return dec()
        const chunk: ToolCallChunk = {
          index: num(record.output_index) ?? 0,
          id: str(item.call_id) ?? str(item.id) ?? undefined,
          name: str(item.name) ?? undefined,
        }
        if (type === 'response.output_item.done') {
          const args = str(item.arguments)
          if (args !== null && args !== '') chunk.argumentsReplace = args
        }
        return dec({ toolCalls: [chunk] })
      }
      case 'response.function_call_arguments.delta': {
        return dec({
          toolCalls: [{ index: num(record.output_index) ?? 0, argumentsDelta: str(record.delta) ?? '' }],
        })
      }
      case 'response.function_call_arguments.done': {
        const args = str(record.arguments)
        const chunk: ToolCallChunk = { index: num(record.output_index) ?? 0 }
        if (args !== null && args !== '') chunk.argumentsReplace = args
        return dec({ toolCalls: [chunk] })
      }
      // `response.created` / `response.in_progress` / `response.content_part.*` /
      // `response.output_text.done` …：对"累积文本"没有增量贡献
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

/**
 * 深度思考的默认力度（三协议共用的默认口径，模型池优化）。
 *
 * `supportsReasoning` 只是一个"是否请求思考"的布尔开关，本平台不暴露"力度"这一维度，
 * 所以统一取 `medium`（各家的中庸档）。需要其它力度时走 `extraBody`（它在 buildBody 末尾
 * 覆盖，见各协议实现）。
 */
export const REASONING_EFFORT_DEFAULT = 'medium'

/**
 * Anthropic 扩展思考的预算 token（`thinking.budget_tokens`）。
 *
 * ⚠️ 两条硬约束（Anthropic API）：`max_tokens` 必须 **大于** `budget_tokens`；开启思考时
 * **不能带 `temperature`**（只允许 1 或不带）。两者都在 Anthropic 的 `buildBody` 里兜。
 */
export const ANTHROPIC_THINKING_BUDGET_TOKENS = 2048

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

/** Anthropic 的一个 content block（我们只产出 `text` / `tool_use` / `tool_result` 三种） */
type AnthropicBlock = Record<string, unknown>

/**
 * 参数 → Anthropic 的 `tool_use.input`（**必须是对象**，不是字符串 —— 这是唯一需要解析的地方）。
 *
 * ⚠️ 解不出来时给 `{}`，而**不是**在"给一个猜出来的参数"与"整条请求失败"之间选一个更坏的：
 *   · 这个调用**不会**被执行 —— 编排层已经用 `tool_call{ERROR}`（"参数不是合法 JSON"）
 *     把结论给了用户，并把同一句话作为 `tool_result` 回填给模型；
 *   · Anthropic 这一侧只需要看到一个**形状合法**的 `tool_use`，紧跟着的 `tool_result`
 *     （内容是那句错误说明）不会让模型误以为"参数是空的"。
 *   · 反过来"猜"（截断/补全）会让工具**静默做错事** —— 见 {@link parseToolArguments} 的口径 ③。
 */
function toolInputOf(raw: string): Record<string, unknown> {
  const parsed = parseToolArguments(raw)
  return parsed.ok ? parsed.value : {}
}

/**
 * 协议无关的 {@link ChatMessage} → Anthropic 的 `messages`。
 *
 * ⚠️ 与其他两家最大的不同在**工具结果**：Anthropic **没有 `role:'tool'`** —— 结果是**用户消息里**
 * 的 `tool_result` 块（差异收敛清单 17）。两条连带后果：
 *   · 同一轮的多个结果必须**合成一条** user 消息（一条一个 user 会让角色不交替 ⇒ 400）；
 *   · 于是"相邻同角色合并"必须一并处理：用户连发两条、或某一轮**被停止**（只留用户消息、
 *     没有助手消息）时，历史里就是 USER,USER —— Anthropic 要求角色交替，不合并会被拒。
 *     ⚠️ 这条在**多轮**里必然发生（不是理论情况），所以合并是按角色**通用**做的，不是只合工具结果。
 *
 * `content` 一律用**块数组**（不用裸字符串）：一条规则比"有时字符串、有时数组"少一类边界，
 * 而 Anthropic 两种都收。
 */
function toAnthropicMessages(
  messages: readonly ChatMessage[],
): { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] {
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = []
  /** 追加一段块；与上一条同角色就并进去（见本函数注释） */
  const append = (role: 'user' | 'assistant', blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return
    const previous = out[out.length - 1]
    if (previous !== undefined && previous.role === role) {
      // 就地改：`out` 与这些数组都是本函数刚造的，没有别名
      previous.content.push(...blocks)
      return
    }
    out.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (message.role === 'system') continue // 顶层 `system`（见 buildBody）
    if (message.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      }
      // `is_error` 只有 Anthropic 有（另两家没有对应字段）⇒ 协议无关层带着它过来
      if (message.isError === true) block.is_error = true
      append('user', [block])
      continue
    }
    // 正文与"工具调用请求"可以同时存在（模型先说一句、再调工具）；两者都空则不占一条消息
    append(message.role, toAnthropicBlocks(message.content))
    const toolCalls = message.toolCalls
    if (toolCalls === undefined || toolCalls.length === 0) continue
    append(
      'assistant',
      toolCalls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: toolInputOf(call.arguments),
      })),
    )
  }
  return out
}

/** OpenAI 形态的工具 → Anthropic 的工具（`input_schema` 而不是 `parameters`；**没有** `type` 字段） */
function toAnthropicTools(tools: readonly ProtocolToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }))
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
    const messages = toAnthropicMessages(request.messages)

    // 深度思考（扩展思考）：勾了 supportsReasoning 才开。两条硬约束在这里兜（见常量注释）：
    //  · `max_tokens` 必须 > `budget_tokens` ⇒ 思考开时给 max_tokens 兜一个下限；
    //  · 开思考时不能带 `temperature`（只允许 1 或不带）⇒ 思考开时不透传 temperature。
    const thinking = request.requestReasoning === true
    const maxTokens = request.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: thinking
        ? Math.max(maxTokens, ANTHROPIC_THINKING_BUDGET_TOKENS + ANTHROPIC_DEFAULT_MAX_TOKENS)
        : maxTokens,
      stream: request.stream,
    }
    if (system !== '') body.system = system
    if (!thinking && request.temperature !== undefined) body.temperature = request.temperature
    if (request.tools !== undefined) body.tools = toAnthropicTools(request.tools)
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET_TOKENS }
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
    const toolCalls: ToolCallChunk[] = []
    for (const rawBlock of Array.isArray(record.content) ? record.content : []) {
      const block = asRecord(rawBlock)
      if (block === null) continue
      const blockType = str(block.type)
      if (blockType === 'text') text += str(block.text) ?? ''
      // 扩展思考块（`thinking` 开头的模型会回）；`redacted_thinking` 的内容是密文，不取
      else if (blockType === 'thinking') thinking += str(block.thinking) ?? ''
      else if (blockType === 'tool_use') {
        // 非流式里 `input` 已经是**对象** ⇒ 序列化回字符串，与流式路径**同一种分片形态**
        toolCalls.push({
          index: toolCalls.length,
          id: str(block.id) ?? undefined,
          name: str(block.name) ?? undefined,
          argumentsDelta: block.input === undefined ? '{}' : JSON.stringify(block.input),
        })
      }
    }
    return dec({
      text,
      thinking,
      finishReason: finishReasonFromAnthropic(str(record.stop_reason)),
      usage: readUsage(record.usage),
      toolCalls,
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
        if (str(block.type) === 'tool_use') {
          // 起始帧只给 id/name（参数在后面的 `input_json_delta` 里逐段来）
          return dec({
            toolCalls: [
              {
                index: num(record.index) ?? 0,
                id: str(block.id) ?? undefined,
                name: str(block.name) ?? undefined,
              },
            ],
          })
        }
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
            // 工具参数**片段**（`partial_json` 可能是 `{"a":` 这种半截）⇒ 只累积，不解析
            return dec({
              toolCalls: [{ index: num(record.index) ?? 0, argumentsDelta: str(delta.partial_json) ?? '' }],
            })
          case 'signature_delta':
          case 'citations_delta':
            return dec() // 思考签名 / 引用：本批不消费
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
 *
 * ⚠️ **别拿它去合"多轮"的用量**（工具循环里一次问答会调好几轮上游）—— 那是 {@link sumUsages}，
 * 口径是**相加**而不是覆盖。两者混用会把"三轮的用量"报成"最后一轮的"。
 */
export function mergeUsage(previous: ChatUsage | null, incoming: ChatUsage): ChatUsage {
  const tokensIn = incoming.tokensIn ?? previous?.tokensIn ?? null
  const tokensOut = incoming.tokensOut ?? previous?.tokensOut ?? null
  const explicitTotal = incoming.tokensTotal ?? previous?.tokensTotal ?? null
  const tokensTotal =
    tokensIn !== null && tokensOut !== null ? tokensIn + tokensOut : explicitTotal
  return { tokensIn, tokensOut, tokensTotal }
}
