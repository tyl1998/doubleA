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
 * `content` 的写入端契约（`messageContentSchema`）当前声明四段：`text` / `thinking` /
 * `citations` / `tool_calls`（**P0-2-8 定型、P0-2-11 接回**）；`attachments`（附件，属 **P1**）
 * **刻意未定型**（`shared/src/conversation.ts` 的注释："现在写进去只会是猜的形状"）。
 * 所以本文件在解包历史 `content` 时**严格按已定义的那几段取值**，其余键既不读也不删
 * （原样留在视图模型之外的原始对象里）。等 P1 把 `attachments` 的形状定下来，
 * **只需要在本文件的 {@link messageToView} 里加一行映射**，组件一行都不用改 ——
 * 这正是"先归一化"的收益所在。
 * 反过来说：**不要**为了"提前支持"而在前端猜一个形状 —— 那是自己发明契约，
 * 而后端将来写进去的形状与它不一致时，历史渲染会**安静地错**（字段名差一个字母就渲染出空白卡片）。
 *
 * ⚠️ 开场白（`03` §4.1 第一行）**不是**这个模型的成员：它是 Agent 的静态属性
 * （`agent.openingRemarks`），只在"新会话态"显示，不落库、不进消息数组。
 */

import {
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  ERROR_CODES,
  citationItemSchema,
  toolCallRecordSchema,
  type CitationItem,
  type ErrorCode,
  type MessageItem,
  type MessageModelSegment,
} from '@doubulea/shared'
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
  /**
   * 工具所属 MCP server 的 **id**（`kind=SANDBOX` 时没有这个键）。
   *
   * ⚠️ **P0-2-11 的契约增量**（`shared/src/conversation.ts#toolCallRecordSchema`）：
   * 工具卡上那条「去配置凭据」要跳 `/settings/credentials?serverId=…`，而 `serverName` 做不到
   * （它是展示名，可重名）；从 `toolName` 的 `mcp_{slug}_{tool}` 反推更不行
   * （slug 刻意不唯一 ⇒ 会指到别的 server 上）。
   */
  serverId?: string
  kind: ToolCallKind
  status: ToolCallStatus
  inputSummary: string
  output?: string
  /**
   * 失败时的错误码（`shared/src/errors.ts` 的取值域，**不是 HTTP 状态码**）。
   * ⚠️ 前端从 `output` 那句人话里认不出"这是缺凭据"，只能靠这个**结构化**的信号
   * —— 它正是"失败卡带『去配置』跳转"能成立的前提（`02` §9.3）。
   */
  errorCode?: string
}

/**
 * 这张工具卡要不要给「去配置凭据」按钮（`02` §9.3 的判据**逐字**）。
 *
 * 三个条件**缺一不可**：失败（`ERROR`）+ 错误码是 `NEED_CREDENTIAL`（424）
 * + **知道是哪台 server**（`serverId` 存在）。
 *
 * ⚠️ 第三条最容易漏，而漏了的后果很具体：`serverId` 缺失时（历史里 P0-2-11 之前落库的老记录、
 * 或 `kind=SANDBOX` 的工具）会拼出 `/settings/credentials?serverId=`（**空值**）——
 * 用户点了按钮、页面也跳过去了、就是什么都不发生（因为凭据页拿到了一个不在清单里的空 id
 * ⇒ `resolveScrollTarget` 返回 `null`）。那是"点不通的入口"的变体，而它更难查：
 * 页面确实跳转了。
 *
 * ⚠️ 拿 `serverName` 当判据同样不行：它是展示名、**可重名**，也不是那条路径接受的参数形态。
 */
export function canConfigureCredential(tool: {
  status: string
  errorCode?: string | undefined
  serverId?: string | undefined
}): boolean {
  return tool.status === 'ERROR' && tool.errorCode === 'NEED_CREDENTIAL' && (tool.serverId ?? '') !== ''
}

/**
 * 工具卡失败时的错误码 → **卡片内部那一行**的补充说明（可操作的那句）。
 *
 * ⚠️ 这**不是**第二份"错误码 → 文案"映射层（`03` §六：那一层在 `app/feedback.ts`，
 * 页面不许自己拼 toast 文案）。它只覆盖 MCP 语境下的三条真实分支，
 * 其余一律返回 `null` ⇒ 卡片只显示服务端给的原因原文，不叠加解释。
 * 这样"多一句解释"永远是有意为之，而不是某天顺手加的。
 */
export function toolErrorHint(errorCode: string | undefined): string | null {
  switch (errorCode) {
    case 'NEED_CREDENTIAL':
      return '这台 server 需要你个人的凭据。点「去配置凭据」填一次，之后这个工具就能用了。'
    case 'UPSTREAM_TIMEOUT':
      return 'MCP server 没有在规定时间内应答。它可能正忙或已失联，可以稍后重试。'
    case 'UPSTREAM_ERROR':
      return 'MCP server 返回了异常。它那边的配置或运行状态可能有问题。'
    default:
      return null
  }
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
   * 本轮生命周期的**中间态**（`status` 事件，TaskAgent 专属）。
   * 只有流式助手消息有；一旦真实内容（正文/思考/工具卡）到达就被清掉。
   */
  statusText?: string
  /**
   * `false` = 这一轮**没有产生可持久化的消息**（`done.messageId === null`，
   * 见 `shared/src/sse.ts` 文件头 ④）⇒ 刷新后它不会出现在历史里，界面要如实标注。
   * `null` / `undefined` = 还没收尾（或历史消息，它当然已持久化）。
   */
  persisted?: boolean | null
  /**
   * 这一轮**实际使用**的模型（产品优化 2026-09-29；见 `shared#messageModelSegmentSchema`）。
   * 只有历史助手消息有（流式轮次在收尾前不知道它）；重进会话时头部模型选择器据此回显。
   */
  model?: MessageModelSegment
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
    // `serverId` / `errorCode` 都是**可选**键（`kind=SANDBOX` 没有前者、非失败帧没有后者）
    // ⇒ 用"有才带上"的三态写法，别写成 `?? ''`（空串会让 `canConfigureCredential` 多走一条
    //    判断，而"没有这个键"与"有但是空"在这个契约里是两件事）
    ...(payload.serverId === undefined ? {} : { serverId: payload.serverId }),
    kind: payload.kind,
    status: payload.status,
    inputSummary: payload.inputSummary,
    ...(payload.output === undefined ? {} : { output: payload.output }),
    ...(payload.errorCode === undefined ? {} : { errorCode: payload.errorCode }),
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
 * 工具段：逐项过 `toolCallRecordSchema`（**同一个 schema**，与 `tool_call` 事件共用）。
 *
 * ⚠️ **P0-2-8 把写入端定型了，P0-2-11 在这里把它接回**（`shared/src/conversation.ts` 第 62~63 行
 * 写着"P0-2-11 只要在前端 `messageToView` 里加一段映射（那正是它留的接回点）"）。
 * 在那之前本函数返回 `[]` 是**刻意的**：形状没定就猜着解，会在字段名差一个字母时
 * **安静地渲染出一批空卡片**。
 *
 * ⚠️ `arguments`（模型给的参数 JSON 原样）**不进视图模型**：它是给排查用的留档，
 * 卡片上要显示的是 `inputSummary`（截断过、且**凭据值已抹除**）。
 * 把它带上来只会有两种下场：要么忘了脱敏直接显示（凭据泄漏），要么多写一条"这里不许显示"
 * 的规则去防自己。**不让它进来就不存在这个问题。**
 *
 * 其余各段与 {@link pickCitations} 同款处置：逐项校验、坏的一项丢弃、全坏 ⇒ 当作没有。
 */
function pickToolCalls(source: Record<string, unknown>): ToolCallView[] {
  const value = source['tool_calls']
  if (!Array.isArray(value)) return []
  const views: ToolCallView[] = []
  for (const entry of value) {
    const parsed = toolCallRecordSchema.safeParse(entry)
    if (!parsed.success) continue
    const record = parsed.data
    views.push({
      callId: record.callId,
      toolName: record.toolName,
      serverName: record.serverName,
      ...(record.serverId === undefined ? {} : { serverId: record.serverId }),
      kind: record.kind,
      status: record.status,
      inputSummary: record.inputSummary,
      ...(record.output === undefined ? {} : { output: record.output }),
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    })
  }
  return views
}

/**
 * 模型段：从 jsonb 里安全取值（与 `pickCitations` 同族 —— 逐字段收窄，坏形状 → `undefined`）。
 * 只认 `messageModelSegmentSchema` 的三个字段全是字符串的情况，其余一律"没有这一段"：
 * 历史是跨版本读的，P0-2 之前的消息没有这个段是正常态，不该渲染出半截模型选择。
 */
function pickModel(source: Record<string, unknown>): MessageModelSegment | undefined {
  const value = source['model']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { modelId, modelName, modelLabel } = value as Record<string, unknown>
  if (typeof modelId !== 'string' || typeof modelName !== 'string' || typeof modelLabel !== 'string') {
    return undefined
  }
  return { modelId, modelName, modelLabel }
}

/**
 * 错误码 → **默认中文文案**（`shared/src/errors.ts` 的 `DEFAULT_MESSAGE_BY_ERROR_CODE`）。
 *
 * ⚠️ 存在的理由是"**别再写第四张映射表**"：本仓已经有三处涉及错误码 → 文案 ——
 * `app/feedback.ts`（toast/notification 通道）、`api/client.ts#describeError`（`ApiError` → 文案）、
 * 以及 `shared` 的 `DEFAULT_MESSAGE_BY_ERROR_CODE`（唯一的事实来源）。
 * 前两者都**只接受一个错误对象**（`ApiError` / `Error`），而工具卡手上只有一个从
 * `tool_calls` 里读出来的**字符串错误码** —— 硬塞给 `describeError` 会掉进它最后那条兜底
 * （"服务内部错误"），把 `NEED_CREDENTIAL` 显示成一句完全无关的话。
 *
 * 取值域外的字符串 ⇒ `null`（卡片只显示原文，不编一句"未知错误"）。
 */
export function errorCodeLabel(errorCode: string | undefined): string | null {
  if (errorCode === undefined) return null
  if (!(ERROR_CODES as readonly string[]).includes(errorCode)) return null
  return DEFAULT_MESSAGE_BY_ERROR_CODE[errorCode as ErrorCode]
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
    // 工具卡的历史还原（P0-2-11 接回，见 `pickToolCalls`）。
    // 产物卡仍恒空：它的写入端（沙箱产物，P0-3）还没有，见文件头。
    tools: pickToolCalls(content),
    artifacts: [],
    // 本轮实际使用的模型（产品优化 2026-09-29；旧消息没有这个段 ⇒ undefined）
    model: pickModel(content),
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
