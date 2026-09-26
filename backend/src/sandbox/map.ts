/**
 * 引擎事件映射（P0-3-6）—— 「容器里的 pi 说了什么」→「我们往外发什么」
 *
 * 依据：`docs/子方案/沙箱与引擎集成.md` §六 3（**事件映射表** —— 本文件就是它）、§六 4 坑 2、
 *      `docs/02-后端设计.md` §七 第 3 步（引擎 tool 事件 → `tool_call{kind:SANDBOX}`；
 *      增量 → delta/thinking；session stats → usage）、
 *      pi 包内 `docs/json.md`（**引擎事件全集的权威**，与 `docs/message-types.md` 的 Usage/ToolCall 形状）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这一层在链路里的位置：桥的**唯一**消费者
 * ═══════════════════════════════════════════════════════════════════════
 * `bridge.ts#onEvent` 把引擎事件扇出来 → **本文件**把每一条翻成 0~n 条我方 SSE 事件
 * （事件全集见 `shared/src/sse.ts`）→ `orchestrator/taskAgent.ts` 负责"发出去 + 记下来"。
 * ⚠️ 它**不认识** DB / Redis / SSE 连接 / docker：只做"形状翻译"，因此可以**不连任何依赖**地逐条核查
 * （`map.ts` 唯一的运行期 import 是 `chatContext.ts` 的两个纯函数 —— 那个文件自己也不 import 运行期模块）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ★ 可解释性（P0-3-5 决定五传下来的口径）
 * ═══════════════════════════════════════════════════════════════════════
 * "能进事件流的每一条都必须可解释"。本文件的落法是 {@link EngineEventMapping.known}：
 *   · `known: true`  = 这条引擎事件在**映射表**里有条目（含"认识但刻意不发"那一类）；
 *   · `known: false` = 引擎发了我们没写过的事件（版本漂移）。
 * 两者都**不会**进事件流 —— 区别只在"编排层要不要留痕"。
 * 另有一条 {@link EngineEventMapping.anomaly}：**认识这条事件、但它的载荷用不了**
 * （缺必填字段等）—— 这一类必须留一条 warn，否则症状是"引擎明明干活了、界面上什么都没有，
 * 而日志里也什么都没有"（本仓最难查的一类）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 四类**刻意不发**（每一条都有反例，别顺手补上）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① **`agent_end`** —— `子方案③` §六 4 坑 2：它之后还可能跟自动重试 / 溢出恢复 / 上下文压缩 /
 *      跟进动作，拿它当收尾会**提前落库**（症状："回答少了一截，但历史里看着是完整的"）。
 *      真正的收尾判据是 `agent_settled`，而且它由 `bridge.ts#runTurn` 直接消费 —— **不到本层**。
 *   ② **`message_update` 的 `toolcall_*` 子类型** —— 它是"模型**打算**调这个工具"，
 *      而卡片表达的是"这个工具**正在跑**"（`tool_execution_*`）。两处都发会造出**两张卡**，
 *      且它们的 `callId` 相同 ⇒ 前端按 id upsert 时状态来回跳。
 *   ③ **`tool_execution_update`（`partialResult`）** —— 卡片的取值域是"一进一出"的三态
 *      （`RUNNING` → `SUCCESS`/`ERROR`，见 `shared#toolCallRecordSchema`），没有"中间进度"这一态。
 *   ④ **会话内部状态类**（`queue_update` / `thinking_level_changed` / `session_info_changed` /
 *      `entry_appended`）—— 界面上没有对应的卡。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 三件**不属于本层**的事（别在这里找）
 * ═══════════════════════════════════════════════════════════════════════
 *   · **extension UI**（引擎主动问用户）是**另一条 RPC 子协议**，不是 `AgentSessionEvent`
 *     （pi `docs/json.md` 的 "RPC-only events" 一节明写），因此**不经过本文件**；它的落点是
 *     **P0-3-6b** 的跨请求提问原语（`子方案③` §八：活跃通道注册表 + `askConversation()`）。
 *   · **`kind: 'MCP'` 的工具卡** —— 容器侧看到的就是一次普通工具执行（MCP 走 §七 的后端代理），
 *     因此 alias 反查 `serverId` 是 **P0-3-9b** 的事；本层发出的 `kind` **恒为 `SANDBOX`**。
 *   · **stderr** —— 引擎的抱怨不进 SSE（`子方案③` §六 3 末行），它由 `bridge.ts` 直接收进日志（脱敏）。
 */

import type { ConversationActiveSnapshot, SseEvent, SseToolCallPayload, ToolCallRecord } from '@doubulea/shared'

import { summarizeToolInput, truncateToolResult } from '../orchestrator/chatContext.js'
import type { PiSessionEvent } from './bridge.js'

// ───────────────────────────── 常量 ─────────────────────────────

/**
 * 容器侧工具的 `kind` **恒为它**。
 *
 * `kind` 的另一个取值 `MCP` 只属于"经 §七 代理调出去的那种卡"（P0-3-9b 在代理端点里把
 * alias 反查成 `serverId` 时才发）—— 容器内的 bash/read/write/edit 与将来任何容器内工具
 * 都是 `SANDBOX`。写成常量而不是在每处写字面量：这个值同时进 SSE 帧与落库记录。
 */
const SANDBOX_TOOL_KIND = 'SANDBOX'

/**
 * `kind=SANDBOX` 的工具**不属于任何 MCP server** ⇒ `serverName` 是空串。
 *
 * ⚠️ 空串而不是省略：`shared#toolCallRecordSchema.serverName` 是 `z.string()`（必填），
 * 同一条记录里的 `serverId` 才是 `optional` 且**在 SANDBOX 时连键都没有**
 * （那一条的区别是 P0-2-11 定的："没有这个键"与"有但是空"是两件事）。
 */
const SANDBOX_TOOL_SERVER_NAME = ''

/**
 * `callId → {inputSummary, arguments}` 记忆的**防呆上界**。
 *
 * 为什么需要：`tool_execution_end` **不带 `args`**（pi `docs/json.md` 的字段表里只有
 * `toolCallId` / `toolName` / `result` / `isError`），而同一张卡的两帧必须是**同一份**
 * `inputSummary`（前端按 `callId` upsert，空串会把 start 那帧的摘要抹掉）⇒ 必须记住 start。
 * 正常路径下"记一条、在 end 处删一条"，上界只在**工具执行中途被打断**（end 永不到来）时兜底；
 * 桥与容器同寿命（`bridge.ts` 的"复用容器"），没有上界的 Map 会随轮数缓慢长。
 */
export const TOOL_SUMMARY_MEMO_LIMIT = 200

/**
 * 工具**失败**但 `result` 里一个文本块都没有时的占位文案。
 *
 * 为什么不复用 `truncateToolResult` 对空串的那句（"工具执行成功，但没有返回内容"）：
 * 那句在失败路径上是**假话**（`01` §3.6「失败错误可见」要的正是"如实"）。
 */
export const TOOL_RESULT_NO_ERROR_DETAIL = '（工具执行失败，但没有返回原因）'

/**
 * 引擎事件名 → 我们**认识**（= 映射表里有条目，含"刻意不发"）。
 *
 * 来源 = pi `docs/json.md` 的各张表逐行，外加 `session`（JSON 模式的首行 session header；
 * RPC 模式**不发**它 —— 列在这里表示"我们知道有这个东西"，出现即漂移但不算"不认识"）。
 *
 * ⚠️ **不含 `response`**：引擎对命令的应答由 `bridge.ts` 按 `id` 配对消化，
 * **不会**派发到本层（它刻意与上游 `rpc-client.js` 不同，见 `bridge.ts#resolvePending`）。
 */
const KNOWN_ENGINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  // session header（JSON 模式才发）
  'session',
  // agent / turn
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_start',
  'turn_end',
  // message
  'message_start',
  'message_update',
  'message_end',
  // tool
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  // 队列与状态
  'queue_update',
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
  // 压缩
  'compaction_start',
  'compaction_end',
  // 重试
  'auto_retry_start',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  // RPC 专属
  'bash_execution_update',
  'extension_error',
])

/**
 * `message_update.assistantMessageEvent.type` 的取值域（pi `docs/json.md` 的 "Reconstruct
 * streaming messages" 表逐行）。
 *
 * 同样含"认识但不发"的五个：`start` / `text_start` / `text_end` / `thinking_start` /
 * `thinking_end` / `toolcall_start` / `toolcall_delta` / `toolcall_end` / `done` / `error`。
 * ⚠️ 其中 `done` / `error` 是**provider 流级**的完成/错误，正常轮次里会被 pi 翻译成
 * `message_start` / `message_end` 而**不会**以 `message_update` 的形式出现 —— 出现即意味着
 * 是"调用方自己构造的会话事件"（pi 文档原话），那时"不认识"是准确的结论吗？不是：
 * 我们**认识**这两个名字，只是不映射 ⇒ 仍算 `known: true`，由"刻意不发"那张表覆盖。
 */
const KNOWN_ASSISTANT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'start',
  'text_start',
  'text_delta',
  'text_end',
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  'error',
])

/** 引擎事件名 → 增量类型（`message_update` 的顶层判别） */
const ENGINE_MESSAGE_UPDATE = 'message_update'
const ENGINE_TOOL_EXECUTION_START = 'tool_execution_start'
const ENGINE_TOOL_EXECUTION_END = 'tool_execution_end'

/** `message_update.assistantMessageEvent` 里我们真的要用的两个子类型 */
const ASSISTANT_TEXT_DELTA = 'text_delta'
const ASSISTANT_THINKING_DELTA = 'thinking_delta'

// ───────────────────────────── 形状 ─────────────────────────────

/**
 * 从引擎 usage 里取出来的那两项（= `done.usage` 的形状）。
 *
 * ⚠️ **刻意只有两项**：`shared#sseDonePayloadSchema` 的 `usage` 就只投影 `tokensIn` / `tokensOut`，
 * 而引擎给的 `cacheRead` / `cacheWrite` / `cost` 要展示得先有一次契约变更（属 P1 的用量统计）。
 * 引擎的 `reasoning` **已经含在 `output` 里**（pi `docs/message-types.md` 原话："do not add it again"）。
 */
export interface EngineUsage {
  tokensIn: number | null
  tokensOut: number | null
}

/** 一条引擎事件翻出来的全部东西 */
export interface EngineEventMapping {
  /** 要发出去的我方事件（按顺序；0 条 = 这条引擎事件不上线） */
  events: SseEvent[]
  /** 这条事件携带的**累积**用量；`null` = 没带（只有 `message_update` 会带，见 `readEngineUsage`） */
  usage: EngineUsage | null
  /** 这一条对 `/active` 快照的影响（只含该改的键）—— 断线重连的人靠它知道"现在在跑什么" */
  snapshot?: Partial<ConversationActiveSnapshot>
  /**
   * 这一条要不要进**落库**的工具记录。
   *
   * 它与 {@link events} 里那张卡**差一个字段**：`arguments`（模型给出的参数 JSON 原样）。
   * SSE 帧刻意不带它（`shared#sseToolCallPayloadSchema` 是 `.omit({arguments:true})` 派生的），
   * 而"模型到底传了什么"只有完整入参能回答 ⇒ 两处都要有、形状必须是同一个 schema。
   */
  toolRecord?: ToolCallRecord
  /** 映射表里有没有它（见文件头"可解释性"） */
  known: boolean
  /** 认识、但**载荷用不了**（缺必填字段等）⇒ 编排层记一条 warn */
  anomaly?: string
}

/** 映射器（见 {@link createEngineEventMapper}：它有一小块 `callId → 摘要` 的记忆） */
export interface EngineEventMapper {
  map(event: PiSessionEvent): EngineEventMapping
}

// ───────────────────────────── 纯函数：可核查的那一半 ─────────────────────────────

/** 这个引擎事件名在映射表里吗（见 {@link KNOWN_ENGINE_EVENT_TYPES}） */
export function isKnownEngineEventType(type: string): boolean {
  return KNOWN_ENGINE_EVENT_TYPES.has(type)
}

/**
 * 引擎的 usage 对象 → 我们要的那两项（**不认识就返回 `null`，不编一个 0**）。
 *
 * 口径三条：
 *   · 引擎的 `usage` 是 **latest cumulative**（pi `docs/json.md`："The top-level `usage` is the
 *     latest cumulative provider-reported usage"）⇒ 调用方**覆盖**而不是相加（与 ChatBot 那边
 *     `sumUsages` 的"多轮相加"是两件事：那边一轮里调了好几次上游）。
 *   · 字段名是 `input` / `output`（不是 `tokensIn` / `tokensOut`）—— 翻译**只在这一处**。
 *   · 两个数都取不到 ⇒ `null`（`done.usage` 的 `null` 语义是"没有上游调用或上游不给"，
 *     与"给了一个 0"是两件事，见 `shared/src/sse.ts` 文件头 ④）。
 */
export function readEngineUsage(raw: unknown): EngineUsage | null {
  const record = asRecord(raw)
  if (record === null) return null
  const tokensIn = nonNegativeIntOf(record.input)
  const tokensOut = nonNegativeIntOf(record.output)
  if (tokensIn === null && tokensOut === null) return null
  return { tokensIn, tokensOut }
}

/**
 * 造一个映射器。
 *
 * 之所以是**工厂**而不是一个裸的纯函数：`tool_execution_end` 不带 `args`
 * （见 {@link TOOL_SUMMARY_MEMO_LIMIT}），所以"同一张卡的两帧用同一份摘要"这件事需要
 * 一小块记忆。**记忆只有那一块**，映射规则本身仍然是逐条可核查的（喂一串事件、比结果）。
 *
 * ⚠️ 记忆的键是 `callId`（引擎给的，全局唯一）⇒ 一个映射器可以安全地跨多轮复用；
 * 调用方（`taskAgent.ts`）在一轮结束时**丢弃整个映射器**，于是"跨轮的残留"在结构上不存在。
 */
export function createEngineEventMapper(): EngineEventMapper {
  /** `callId → 卡片那一行摘要 + 完整入参`（end 帧要用回它） */
  const memo = new Map<string, { inputSummary: string; args: string }>()

  function remember(callId: string, entry: { inputSummary: string; args: string }): void {
    // 先删后插：让 `Map` 的插入顺序表达"最近用过"，下面按它淘汰最旧的一条
    memo.delete(callId)
    memo.set(callId, entry)
    while (memo.size > TOOL_SUMMARY_MEMO_LIMIT) {
      const oldest = memo.keys().next()
      if (oldest.done === true) break
      memo.delete(oldest.value)
    }
  }

  function mapMessageUpdate(event: PiSessionEvent): EngineEventMapping {
    const usage = readEngineUsage(event.usage)
    const inner = asRecord(event.assistantMessageEvent)
    const innerType = inner === null ? null : stringOf(inner.type)

    if (innerType === ASSISTANT_TEXT_DELTA) {
      return { events: [deltaEvent(stringOf(inner?.delta) ?? '')], usage, known: true }
    }
    if (innerType === ASSISTANT_THINKING_DELTA) {
      return { events: [thinkingEvent(stringOf(inner?.delta) ?? '')], usage, known: true }
    }
    /**
     * 其余子类型：`*_start` / `*_end` / `toolcall_*` / provider 级的 `done`·`error`。
     *
     * ⚠️ **不发**不是"漏了"：
     *   · `text_start` / `text_end` / `thinking_end` 的载荷是"这一块的权威最终内容"，
     *     而我们的落库与展示**都是增量累积**出来的（见 `taskAgent.ts`）—— 再发一遍会**重影**；
     *   · `toolcall_*` 见文件头 ②。
     * ⚠️ 但 usage **要照收**：`message_update` 是它唯一的载体，而 provider 级的
     * `done` / `error` 帧同样带着它（最后那一帧的 usage 才是最完整的）。
     */
    return {
      events: [],
      usage,
      known: innerType !== null && KNOWN_ASSISTANT_EVENT_TYPES.has(innerType),
    }
  }

  function mapToolExecutionStart(event: PiSessionEvent): EngineEventMapping {
    const callId = stringOf(event.toolCallId)
    const toolName = stringOf(event.toolName)
    if (callId === null || toolName === null) {
      return {
        events: [],
        usage: null,
        known: true,
        anomaly: `tool_execution_start 缺少 ${callId === null ? 'toolCallId' : 'toolName'}（无法造卡片）`,
      }
    }

    const args = asRecord(event.args) ?? {}
    const inputSummary = summarizeToolInput(args)
    // 完整入参落进记忆：`tool_execution_end` 要用它补 `arguments`（那一条事件不带 `args`）
    const serialized = serializeArgs(args)
    remember(callId, { inputSummary, args: serialized })

    const payload: SseToolCallPayload = {
      callId,
      toolName,
      serverName: SANDBOX_TOOL_SERVER_NAME,
      kind: SANDBOX_TOOL_KIND,
      status: 'RUNNING',
      inputSummary,
    }
    return {
      events: [{ name: 'tool_call', data: payload }],
      usage: null,
      // `currentTool` 是断线重连时"现在在跑什么"的唯一来源（`02` §5.2）
      snapshot: { currentTool: toolName },
      toolRecord: { ...payload, arguments: serialized },
      known: true,
    }
  }

  function mapToolExecutionEnd(event: PiSessionEvent): EngineEventMapping {
    const callId = stringOf(event.toolCallId)
    const toolName = stringOf(event.toolName)
    if (callId === null || toolName === null) {
      return {
        events: [],
        usage: null,
        known: true,
        anomaly: `tool_execution_end 缺少 ${callId === null ? 'toolCallId' : 'toolName'}（无法结卡片）`,
      }
    }

    const remembered = memo.get(callId)
    memo.delete(callId) // 用完即删（start 没来过时无所谓：这里得到的 undefined 会退化成空摘要）

    const isError = event.isError === true
    const resultText = toolResultText(event.result)
    const output = truncateToolResult(
      resultText.trim() === '' && isError ? TOOL_RESULT_NO_ERROR_DETAIL : resultText,
    )

    const payload: SseToolCallPayload = {
      callId,
      toolName,
      serverName: SANDBOX_TOOL_SERVER_NAME,
      kind: SANDBOX_TOOL_KIND,
      status: isError ? 'ERROR' : 'SUCCESS',
      // 摘要取**记忆**里的那一份：end 事件自己没有 `args`，而前端按 `callId` upsert
      // ⇒ 这里给空串会把 start 那帧已经显示出来的摘要抹掉（卡片上"参数"那一行突然空了）
      inputSummary: remembered?.inputSummary ?? '',
      output,
    }
    return {
      events: [{ name: 'tool_call', data: payload }],
      usage: null,
      // 工具段结束 ⇒ 清掉 `currentTool`（一个会话的工具是顺序跑的，`02` §7 的编排口径）
      snapshot: { currentTool: null },
      toolRecord: {
        ...payload,
        // `arguments` 是 `optional`：记忆没命中（start 那条我们没看见）时**不带这个键**
        ...(remembered === undefined ? {} : { arguments: remembered.args }),
      },
      known: true,
    }
  }

  return {
    map(event: PiSessionEvent): EngineEventMapping {
      switch (event.type) {
        case ENGINE_MESSAGE_UPDATE:
          return mapMessageUpdate(event)
        case ENGINE_TOOL_EXECUTION_START:
          return mapToolExecutionStart(event)
        case ENGINE_TOOL_EXECUTION_END:
          return mapToolExecutionEnd(event)
        default:
          // 认识但刻意不发（`agent_end` / `turn_*` / `message_*` / `compaction_*` …）
          // 与"完全不认识"（版本漂移）在这里合流 —— 区别只有 `known` 这一个布尔
          return { events: [], usage: null, known: isKnownEngineEventType(event.type) }
      }
    },
  }
}

// ───────────────────────────── 内部小工具 ─────────────────────────────

function deltaEvent(text: string): SseEvent {
  return { name: 'delta', data: { text } }
}

function thinkingEvent(text: string): SseEvent {
  return { name: 'thinking', data: { text } }
}

/** 收敛成"普通对象"（数组与 `null` 都不算；与 `chatContext#textOfHistoryRow` 同款口径） */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 收敛成"非空字符串"（`''` 与缺字段都算没有） */
function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 收敛成"非负整数"（引擎理论上只给非负整数；给别的就当没有，别把它带进契约） */
function nonNegativeIntOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

/**
 * 参数对象 → 落库那一列的字符串（`toolCallRecordSchema.arguments`）。
 *
 * ⚠️ **不抛错**：`arguments` 只在落库那一份上出现，而它"序列化不出来"绝不该让一次工具调用
 * 把整轮对话变成失败（同 `chatContext#summarizeToolInput` 的取舍）。
 */
function serializeArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? '{}'
  } catch {
    return '（参数无法序列化）'
  }
}

/**
 * `tool_execution_end.result` → 卡片上那一行文本。
 *
 * 形状是 `ToolResultMessage` 的"内容块"部分（pi `docs/message-types.md`）：
 * `{ content: (TextContent | ImageContent)[], details?, … }`。
 * 三条口径：
 *   · **只取 `type: 'text'` 的块**（`ImageContent` 的 base64 塞进卡片毫无意义，属 P1 的图片预览）；
 *   · 多个文本块用换行拼（工具常常"正文 + 摘要"两段）；
 *   · **取不到就给空串**，由调用方按 `isError` 决定用什么占位文案（见 `TOOL_RESULT_NO_ERROR_DETAIL`）。
 */
function toolResultText(result: unknown): string {
  const record = asRecord(result)
  const content = record?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const blockRecord = asRecord(block)
    if (blockRecord === null) continue
    if (stringOf(blockRecord.type) !== 'text') continue
    const text = blockRecord.text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}
