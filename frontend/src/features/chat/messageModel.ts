/**
 * 对话消息的**视图模型**（P0-1-32，单一渲染路径的落点）
 *
 * 依据：`docs/03-前端设计.md` §五（事件 → UI 映射表 + "历史还原：`GET /messages` 的结构化 jsonb
 *      直接映射为上述卡片，与事件流同一套渲染组件，**单一渲染路径**"）、§4.1（消息流渲染规则
 *      那张表：开场白 / 助手文本 / 思考过程 / 工具卡片 / 引用卡 / 产物卡 / 确认卡）、§六
 *      （"流式渲染与历史渲染同一套组件（避免两套实现漂移）"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 这个文件存在的唯一理由：把**两个来源**归一成**一个形状**
 * ─────────────────────────────────────────────────────────────────────
 *   · **历史**：`GET /api/conversations/:id/messages` 的 `MessageItem[]`
 *     （`content` 是 jsonb，服务端**原样透出**，见 `shared/src/conversation.ts` 文件头 ⑥）；
 *   · **流式**：SSE 的 `delta` / `thinking` / `tool_call` / `citations` / `artifact` 事件
 *     （见 `roundReducer.ts` 的归约态）。
 * 若让 `MessageList` 分别接两种输入，就会出现"流里有的卡片、刷新之后没有"或"同一张卡两种样子"
 * —— 那是 `03` §六 明令避免的漂移，而且**没有编译期错误**、只有肉眼能发现。
 * 归一之后，`MessageList` 只认识 {@link ChatMessageView}：**换来源不改组件**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 历史里只读**已定义**的段，未定义的段原样留着（不猜形状）
 * ─────────────────────────────────────────────────────────────────────
 * `content` 的写入端契约（`messageContentSchema`）当前只声明三段：`text` / `thinking` / `citations`
 * —— `tool_calls`（工具，属 **P0-2**）与 `attachments`（附件，属 **P1**）**刻意未定型**
 * （`shared/src/conversation.ts` 的注释："现在写进去只会是猜的形状"）。
 * 所以本文件在解包历史 `content` 时**严格按这三段取值**，其余键既不读也不删（原样留在视图模型之外的
 * 原始对象里）。等 P0-2/P0-3 把 `tool_calls` / `artifacts` 的形状定下来，
 * **只需要在本文件的 {@link messageToView} 里加两行映射**，组件一行都不用改 —— 这正是
 * "先归一化"的收益所在。
 * 反过来说：**不要**为了"提前支持"而在前端猜一个 `tool_calls` 形状 —— 那是自己发明契约，
 * 而后端将来写进去的形状与它不一致时，历史渲染会**安静地错**（字段名差一个字母就渲染出空白卡片）。
 *
 * ⚠️ 开场白（`03` §4.1 第一行）**不是**这个模型的成员：它是 Agent 的静态属性
 * （`agent.openingRemarks`），只在"新会话态"显示，不落库、不进消息数组。
 */

import { citationItemSchema, type CitationItem, type MessageItem } from '@doubulea/shared'
import type {
  ChatFinishReason,
  SseArtifactPayload,
  SseDonePayload,
  SseToolCallPayload,
  ToolCallKind,
  ToolCallStatus,
} from '@doubulea/shared'

/** 工具卡片的视图状态（`sseToolCallPayloadSchema` 的直译，`output` 在 `RUNNING` 时缺省） */
export interface ToolCallView {
  callId: string
  toolName: string
  /** 工具来自哪个系统（`kind=SANDBOX` 时为空串） */
  serverName: string
  kind: ToolCallKind
  status: ToolCallStatus
  inputSummary: string
  output?: string
}

/** 产物卡的视图状态（`sseArtifactPayloadSchema` 的直译） */
export interface ArtifactView {
  artifactId: string
  fileName: string
  size: number
  mime: string
}

/**
 * 一条消息在界面上的全部内容（**历史与流式共用**）。
 *
 * `status` 的四态对应四种收尾：`complete`（正常）/ `streaming`（在写）/ `stopped`（用户停止）/
 * `error`（流内 `error` 事件或网络层失败）。历史消息恒为 `complete`。
 */
export interface ChatMessageView {
  /** React key。历史用真实消息 id；流式用 `stream:` 前缀（见 `roundReducer.ts`） */
  key: string
  role: 'USER' | 'ASSISTANT' | 'SYSTEM'
  /** 正文（助手走 Markdown；用户气泡是纯文本） */
  text: string
  /** 思考过程（空串 = 这一段本来就没有 ⇒ 不渲染折叠块） */
  thinking: string
  /** `null` = 本轮没有引用（未命中知识库时后端**不发** `citations` 事件，见 P0-1-29 决策 12） */
  citations: readonly CitationItem[] | null
  tools: readonly ToolCallView[]
  artifacts: readonly ArtifactView[]
  /** ISO 8601；流式消息没有（它在落库前不存在） */
  createdAt: string | null
  status: 'complete' | 'streaming' | 'stopped' | 'error'
  /** 收尾原因（只有流式助手消息有；历史消息不存这个字段） */
  finishReason?: ChatFinishReason
  /** token 用量（只有流式助手消息有，`done` 事件的 `usage`） */
  usage?: SseDonePayload['usage']
  /** 流内错误卡的内容（`status === 'error'` 时才有） */
  error?: { code: string; message: string }
  /**
   * `false` = 这一轮**没有产生可持久化的消息**（`done.messageId === null`，
   * 见 `shared/src/sse.ts` 文件头 ④）⇒ 刷新后它不会出现在历史里，界面要如实标注。
   * `null` / `undefined` = 还没收尾（或历史消息，它当然已持久化）。
   */
  persisted?: boolean | null
  /**
   * `true` = **纯文本**渲染（不解析 Markdown）。
   *
   * `03` §4.1 对**开场白**单独写了一条："Agent 开场白纯文本气泡（不解析 markdown）"
   * —— 开场白是后台配置里的一段人话，按 Markdown 解析会把用户随手写的 `*` / `#`
   * 变成斜体与标题（配置者的本意肯定是原样显示）。其余助手消息恒为 Markdown。
   */
  plain?: boolean
}

/** 从 `tool_call` 事件构造工具卡；同一 `callId` 的后续推送由归约层做 upsert */
export function toolViewFromEvent(payload: SseToolCallPayload): ToolCallView {
  return {
    callId: payload.callId,
    toolName: payload.toolName,
    serverName: payload.serverName,
    kind: payload.kind,
    status: payload.status,
    inputSummary: payload.inputSummary,
    ...(payload.output === undefined ? {} : { output: payload.output }),
  }
}

/** 从 `artifact` 事件构造产物卡 */
export function artifactViewFromEvent(payload: SseArtifactPayload): ArtifactView {
  return {
    artifactId: payload.artifactId,
    fileName: payload.fileName,
    size: payload.size,
    mime: payload.mime,
  }
}

/**
 * 从 jsonb 里安全取值：`unknown` → 期望类型，取不到就给"没有这一段"。
 *
 * 为什么不直接 `content as {text: string}`：`content` 的类型是 `unknown`（**刻意**，见
 * `shared/src/conversation.ts` 文件头 ⑥），而它来自数据库 —— P0-2 之后会有更多写入方。
 * 一次强转会把"某天某段变成了别的形状"变成**运行期崩溃**，而这条路径恰恰是"刷新页面"，
 * 用户看到的会是整页白屏。逐字段收窄的代价只是几行，收益是"坏的一段不渲染，其余的照旧"。
 */
function pickString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/** 引用段：逐项过 `citationItemSchema`（**同一个 schema**，与 `citations` 事件共用） */
function pickCitations(source: Record<string, unknown>): CitationItem[] | null {
  const value = source['citations']
  if (!Array.isArray(value)) return null
  const items: CitationItem[] = []
  for (const entry of value) {
    const parsed = citationItemSchema.safeParse(entry)
    if (parsed.success) items.push(parsed.data)
  }
  // 全部不合法 ⇒ 当作"没有引用"，而不是渲染一张空引用卡
  return items.length === 0 ? null : items
}

/**
 * 历史消息 → 视图模型。
 *
 * `SYSTEM` 角色：本仓不写入 SYSTEM 消息（`MESSAGE_ROLES` 有它是因为 DB 的取值域，
 * 而写入端只产生 USER/ASSISTANT）。这里照样映射（不丢数据），由渲染层决定要不要显示 ——
 * 在映射层过滤会让"某天真的出现一条 SYSTEM 消息"变成悄悄消失。
 */
export function messageToView(item: MessageItem): ChatMessageView {
  const raw = item.content
  const content: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  return {
    key: item.id,
    role: item.role,
    text: pickString(content, 'text'),
    thinking: pickString(content, 'thinking'),
    citations: pickCitations(content),
    // ⚠️ 工具卡 / 产物卡的**历史还原**要等它们的写入端形状定下来（P0-2 / P0-3），
    //    见文件头。此处恒空，不是"忘了做"。
    tools: [],
    artifacts: [],
    createdAt: item.createdAt,
    status: 'complete',
  }
}

/**
 * 助手消息是否"什么都还没有"（正文 / 思考 / 卡片全空）。
 *
 * 三种情形会走到这里，界面文案各不相同（由渲染层决定），故只做判据、不给文案：
 *   · 流刚建立（等第一个 delta）；
 *   · 停止时一个字都没生成（`done{STOPPED, messageId:null}`）；
 *   · 上游一个字都没吐就结束了。
 *
 * ⚠️ **有引用但没有正文**（绑了知识库、检索跑在 LLM 之前、上游一个字都没吐的那一轮，
 * 见 P0-1-29 的坑 2）**不算空** —— 那张引用卡是真产出，界面必须把它画出来。
 */
export function isAssistantEmpty(view: ChatMessageView): boolean {
  return (
    view.text === '' &&
    view.thinking === '' &&
    view.tools.length === 0 &&
    view.artifacts.length === 0 &&
    view.citations === null
  )
}

/** 历史列表 → 视图列表（保持服务端给的时间正序，见 `messagePageResultSchema` 的注释） */
export function messagesToViews(items: readonly MessageItem[]): ChatMessageView[] {
  return items.map(messageToView)
}

/**
 * 开场白 → 视图（`03` §4.1 第一行："会话首条用户消息前，Agent 开场白纯文本气泡；
 * **新会话态展示（无 conversationId 进入时即展示，首条消息发送时才创建会话）**"）。
 *
 * ⚠️ 它是**Agent 的静态属性**（`agent.openingRemarks`），不是消息：不落库、不进消息数组、
 * 不计入条数。做成 `ChatMessageView` 只是为了让消息流用同一套组件渲染它
 * （`plain: true` 让它走纯文本分支）—— 而不是"假装它是一条历史消息"。
 *
 * `openingRemarks` 为空（Agent 没配开场白）⇒ 返回 `null`，由调用方决定显示什么空态。
 */
export function openingView(openingRemarks: string | null | undefined): ChatMessageView | null {
  if (openingRemarks === null || openingRemarks === undefined || openingRemarks.trim() === '') {
    return null
  }
  return {
    key: 'opening',
    role: 'ASSISTANT',
    text: openingRemarks,
    thinking: '',
    citations: null,
    tools: [],
    artifacts: [],
    createdAt: null,
    status: 'complete',
    plain: true,
  }
}
