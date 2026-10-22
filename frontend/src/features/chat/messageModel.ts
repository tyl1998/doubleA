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
 *   · **流式**：SSE 的 `delta` / `thinking`（分段） / `tool_call` / `citations` / `artifact` / `steer` 事件
 *     （见 `roundReducer.ts` 的归约态）。
 * 若让 `MessageList` 分别接两种输入，就会出现"流里有的卡片、刷新之后没有"或"同一张卡两种样子"
 * —— 那是 `03` §六 明令避免的漂移，而且**没有编译期错误**、只有肉眼能发现。
 * 归一之后，`MessageList` 只认识 {@link ChatMessageView}：**换来源不改组件**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠️ 历史里只读**已定义**的段，未定义的段原样留着（不猜形状）
 * ─────────────────────────────────────────────────────────────────────
 * `content` 的写入端契约（`messageContentSchema`）当前声明的段：`text` / `thinking`（**遗留单段，只读**）
 * / `thinking_segments`（**2026-10-21 定型，一轮多段**）/ `citations` / `tool_calls`
 * （**P0-2-8 定型、P0-2-11 接回**）/ `attachments`（**P1-4 定型**）/ `steers`（**2026-10-21 定型**）。
 * 本文件在解包历史 `content` 时**严格按已定义的那几段取值**，其余键既不读也不删
 * （原样留在视图模型之外的原始对象里）。附件正是这条纪律的收益兑现：P1-4 定型后
 * **只在本文件的 {@link messageToView} 里加了一行映射**（`pickAttachments`），渲染组件一行都不用改。
 * 反过来说：**不要**为了"提前支持"而在前端猜一个形状 —— 那是自己发明契约，
 * 而契约的形状与它不一致时，历史渲染会**安静地错**（字段名差一个字母就渲染出空白卡片）。
 *
 * ⚠️ 开场白（`03` §4.1 第一行）**不是**这个模型的成员：它是 Agent 的静态属性
 * （`agent.openingRemarks`），只在"新会话态"显示，不落库、不进消息数组。
 */

import {
  DEFAULT_MESSAGE_BY_ERROR_CODE,
  ERROR_CODES,
  attachmentItemSchema,
  citationItemSchema,
  steerRecordSchema,
  thinkingSegmentSchema,
  toolCallRecordSchema,
  type ChatAttachmentKind,
  type CitationItem,
  type ErrorCode,
  type MessageItem,
  type MessageModelSegment,
  type SteerRecord,
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
  /** 工具卡在助手正文中的 UTF-16 字符偏移；旧消息缺省时按正文前渲染。 */
  textOffset?: number
  /**
   * 本轮**内联时间线**上的出现序号（2026-10-21；与思考段的 `seq` 共用同一序列）。
   * 偏移相同时靠它定先后 —— 例如"思考 A 之后紧接着一次工具调用"（两者偏移相同）。
   */
  seq?: number
  output?: string
  /**
   * 工具**执行中**的实时输出快照（`tool_output` 事件；**覆盖**语义）。
   *
   * ⚠️ **天生易失、只存在于流式**：它不在 `toolCallRecordSchema` 里（历史永远没有这个字段），
   * 也不落库、不进上下文（见 `shared#sseToolOutputPayloadSchema` 与 `map.ts` 文件头）。
   * 终态帧（`tool_call{SUCCESS/ERROR}`）到达后它就不再是唯一来源 —— 卡片优先显示权威的
   * `output`（见 `ToolCard`）。
   */
  liveOutput?: string
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
 * 附件条的视图状态（**P1-4**；`shared#attachmentItemSchema` 的直译）。
 *
 * `kind` 由**服务端**在上传时判定（`IMAGE` / `DOCUMENT`）—— 前端据此决定渲染缩略图还是文件条，
 * **不自己看扩展名**（与"预览形态判据只有一处"同款纪律）。
 */
export interface AttachmentView {
  fileId: string
  name: string
  size: number
  mime: string
  kind: ChatAttachmentKind
}

/**
 * 一条消息在界面上的全部内容（**历史与流式共用**）。
 *
 * `status` 的四态对应四种收尾：`complete`（正常）/ `streaming`（在写）/ `stopped`（用户停止）/
 * `error`（流内 `error` 事件或网络层失败）。历史消息恒为 `complete`。
 */
/**
 * 一段思考（2026-10-21）：与工具卡**同一条内联时间线**。
 *
 * `textOffset` = 这一段开始时正文写到第几个字符；`seq` = 本轮内联序号（思考段与工具卡共用）。
 * 两者一起决定它插在正文/卡片的哪个位置（见 `AssistantMarkdown#orderedInlineEntries`）。
 * 旧消息（只有 `thinking` 字符串）没有位置 ⇒ 按 `(0, 0)` 处理（渲染在正文之上，历史口径）。
 */
export interface ThinkingSegmentView {
  text: string
  textOffset?: number
  seq?: number
}

export interface ChatMessageView {
  /** React key。历史用真实消息 id；流式用 `stream:` 前缀（见 `roundReducer.ts`） */
  key: string
  role: 'USER' | 'ASSISTANT' | 'SYSTEM'
  /** 正文（助手走 Markdown；用户气泡是纯文本） */
  text: string
  /**
   * 思考过程**分段**（2026-10-21）：一段 = 一次模型请求里的推理（工具调用之后重新推理是新的一段）。
   * 空数组 = 本轮本来就没有思考 ⇒ 不渲染任何折叠块（`03` §4.1 的"可选而非默认"口径）。
   * 渲染上每段是**各自独立**的折叠块（见 `AssistantMessage`）。
   */
  thinkingSegments: readonly ThinkingSegmentView[]
  /** `null` = 本轮没有引用（未命中知识库时后端**不发** `citations` 事件，见 P0-1-29 决策 12） */
  citations: readonly CitationItem[] | null
  tools: readonly ToolCallView[]
  artifacts: readonly ArtifactView[]
  /**
   * 本轮用户消息携带的附件（**P1-4**）：历史从 `content.attachments` 恢复、流式由本地状态带出。
   * 只出现在 USER 消息上（助手消息恒空数组）。
   */
  attachments: readonly AttachmentView[]
  /** ISO 8601；流式消息没有（它在落库前不存在） */
  createdAt: string | null
  status: 'complete' | 'streaming' | 'stopped' | 'error'
  /** 收尾原因（只有流式助手消息有；历史消息不存这个字段） */
  finishReason?: ChatFinishReason
  /** token 用量：流式来自 `done` 事件的 `usage`、历史来自消息行 `tokensIn/Out`（P1-7） */
  usage?: SseDonePayload['usage']
  /** 流内错误卡的内容（`status === 'error'` 时才有） */
  error?: { code: string; message: string }
  /**
   * 本轮生命周期的**中间态**（`status` 事件；TaskAgent 与 ChatBot 都会发）。
   * 只有流式助手消息有；一旦真实内容（正文/思考/工具卡）到达就被清掉。
   */
  statusText?: string
  /**
   * 本轮开始的时刻（ISO 8601；只在**流式**助手消息上有，给"已用时 Ns"计时器用）。
   * 历史消息没有它（历史用 `createdAt`），故计时器只在流式中出现。
   */
  startedAt?: string
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
  /**
   * `true` = 这条 USER 气泡是**本轮中途插话**（2026-10-21；`content.steers` / `steer` 事件）。
   *
   * 存在的理由有两条：
   *   · 渲染上要和真·用户消息区分开（气泡头部标「插话」、末尾带投递状态）；
   *   · **语义上不是"一轮的起点"** —— `recallable` / `regenerable` / `dropLastRound` 的
   *     "最后一轮"判据必须跳过它（否则撤回/重新生成会瞄到一条插话上）。
   */
  steer?: boolean
  /**
   * 插话的稳定标识（服务端入队时生成；`steer` / `steer_queue` / 取消端点同源）——
   * 「取回编辑」靠它定位要撤哪一条。**只在 `steer === true` 时有值**。
   */
  steerId?: string
  /**
   * 插话的投递状态（**只在流式侧有意义**）：`queued` = 引擎还没读到（可「取回编辑」）；
   * `delivered` = 已被读走。历史消息没有这个字段（那一轮已经结束，状态没有意义）。
   */
  steerState?: 'queued' | 'delivered'
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
    ...(payload.textOffset === undefined ? {} : { textOffset: payload.textOffset }),
    // ⚠️ `seq` 必须带（2026-10-21 漏过一处）：内联时间线靠它定"同偏移时谁先谁后"。
    //    丢掉它 ⇒ 工具卡退化成"按数组下标"排序，而思考段用的是全局 seq ⇒ 流式中就能看到
    //    「思考 A → 工具卡」在下一轮变成「工具卡 → 思考 A」这种跳变（用户报的现象）。
    ...(payload.seq === undefined ? {} : { seq: payload.seq }),
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
  // ⚠️ **按 `callId` upsert（后者覆盖前者）**：库里同一张卡是有**两条**记录的 —— `RUNNING`
  //   那条（`tool_execution_start`）与 `SUCCESS`/`ERROR` 那条（`tool_execution_end`；
  //   `persist.ts` 原样落库，见 `taskAgent.ts` 落库前的说明）。流式侧本来就按 `callId` upsert，
  //   历史侧若不去重就会把同一张卡渲染两遍（产品反馈 2026-10-14 的截图里 8 次调用显示成 16 张）。
  //   用 `Map` 保序 + 覆盖 = "最后一条生效"，与流式侧同一口径。
  const byCallId = new Map<string, ToolCallView>()
  for (const entry of value) {
    const parsed = toolCallRecordSchema.safeParse(entry)
    if (!parsed.success) continue
    const record = parsed.data
    byCallId.set(record.callId, {
      callId: record.callId,
      toolName: record.toolName,
      serverName: record.serverName,
      ...(record.serverId === undefined ? {} : { serverId: record.serverId }),
      kind: record.kind,
      status: record.status,
      inputSummary: record.inputSummary,
      ...(record.textOffset === undefined ? {} : { textOffset: record.textOffset }),
      ...(record.seq === undefined ? {} : { seq: record.seq }),
      ...(record.output === undefined ? {} : { output: record.output }),
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    })
  }
  return [...byCallId.values()]
}

/**
 * 附件段（**P1-4**）：逐项过 `attachmentItemSchema`（**同一个 schema**，与上传响应共用）。
 * 坏的一项丢弃、全坏 ⇒ 空数组（与 `pickCitations` / `pickToolCalls` 同款处置）。
 */
function pickAttachments(source: Record<string, unknown>): AttachmentView[] {
  const value = source['attachments']
  if (!Array.isArray(value)) return []
  const items: AttachmentView[] = []
  for (const entry of value) {
    const parsed = attachmentItemSchema.safeParse(entry)
    if (parsed.success) items.push(parsed.data)
  }
  return items
}

/**
 * 插话段（2026-10-21）：逐项过 `steerRecordSchema`（与写入口同一个 schema）。
 * 坏的一项丢弃；全坏 ⇒ 空数组（与 `pickAttachments` 同款处置）。
 */
function pickSteers(source: Record<string, unknown>): SteerRecord[] {
  const value = source['steers']
  if (!Array.isArray(value)) return []
  const items: SteerRecord[] = []
  for (const entry of value) {
    const parsed = steerRecordSchema.safeParse(entry)
    if (parsed.success) items.push(parsed.data)
  }
  return items
}

/**
 * 插话段 → 视图（排在助手消息**之后**，与流式侧 `roundToViews` 同一顺序）。
 *
 * ⚠️ 历史侧不显示投递状态（`steerState` 缺省）：「这一轮已经结束」之后，"是否被模型读到"
 * 对用户没有意义，显示一个永远停在「已投递」的角标只会增加噪音。
 */
function steerViewsOf(item: MessageItem, steers: readonly SteerRecord[]): ChatMessageView[] {
  return steers.map((steer) => ({
    key: `${item.id}:steer:${steer.id}`,
    role: 'USER' as const,
    text: steer.message,
    thinkingSegments: [],
    citations: null,
    tools: [],
    artifacts: [],
    attachments: [],
    createdAt: steer.at,
    status: 'complete' as const,
    steer: true as const,
    steerId: steer.id,
  }))
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
 * 历史助手消息的上报 token → 视图的 `usage`（**P1-7**）。
 *
 * 落库那份一直在 `messages.tokens_in/out` 列上（`persist.ts` 写入），P1-7 起读取端透出
 * ⇒ "每一轮用了多少 token"**刷新之后仍然看得见**（流式那一份来自 `done.usage`）。
 * 两列都为空（用户消息、或上游没上报）⇒ 返回 `null`，收尾行就不显示 token（不编 0）。
 *
 * 逐字段收窄（同 {@link pickModel}）：历史是跨版本读的，老消息 / 测试夹具可能没有这两列。
 */
function usageOf(item: MessageItem): ChatMessageView['usage'] {
  const tokensIn = typeof item.tokensIn === 'number' ? item.tokensIn : null
  const tokensOut = typeof item.tokensOut === 'number' ? item.tokensOut : null
  if (tokensIn === null && tokensOut === null) return null
  return { tokensIn, tokensOut }
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
    thinkingSegments: pickThinkingSegments(content),
    citations: pickCitations(content),
    // 工具卡的历史还原（P0-2-11 接回，见 `pickToolCalls`）。
    // 产物卡仍恒空：它的写入端（沙箱产物，P0-3）还没有，见文件头。
    tools: pickToolCalls(content),
    artifacts: [],
    // 附件（P1-4）：USER 消息的 `content.attachments` 段
    attachments: pickAttachments(content),
    // 本轮实际使用的模型（产品优化 2026-09-29；旧消息没有这个段 ⇒ undefined）
    model: pickModel(content),
    createdAt: item.createdAt,
    status: 'complete',
    // 每轮 token（P1-7）：来自消息行本身（不是 content 段），刷新后收尾行据此显示
    usage: usageOf(item),
  }
}

/**
 * 思考段（2026-10-21）：历史取 `thinking_segments` 数组（`{text, textOffset, seq}`），
 * 旧消息回落单段 `thinking` 字符串（位置按 `(0,0)` —— 渲染在正文之上，与当时一致）。
 */
function pickThinkingSegments(source: Record<string, unknown>): ThinkingSegmentView[] {
  const value = source['thinking_segments']
  if (Array.isArray(value)) {
    const segments: ThinkingSegmentView[] = []
    for (const entry of value) {
      const parsed = thinkingSegmentSchema.safeParse(entry)
      if (parsed.success && parsed.data.text !== '') {
        segments.push({
          text: parsed.data.text,
          ...(parsed.data.textOffset === undefined ? {} : { textOffset: parsed.data.textOffset }),
          ...(parsed.data.seq === undefined ? {} : { seq: parsed.data.seq }),
        })
      }
    }
    if (segments.length > 0) return segments
  }
  const legacy = pickString(source, 'thinking')
  return legacy === '' ? [] : [{ text: legacy }]
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
    view.thinkingSegments.length === 0 &&
    view.tools.length === 0 &&
    view.artifacts.length === 0 &&
    view.citations === null
  )
}

/**
 * 历史列表 → 视图列表（保持服务端给的时间正序，见 `messagePageResultSchema` 的注释）。
 *
 * ⚠️ 助手消息的 `content.steers` 会**再展开出几条 USER 视图**（排在它之后）—— 插话在
 * 界面上的位置与流式侧一致（本轮末尾），而它挂在助手消息上是为了"一轮一起落库"
 * （见 `shared#steerRecordSchema`）。
 */
export function messagesToViews(items: readonly MessageItem[]): ChatMessageView[] {
  const views: ChatMessageView[] = []
  for (const item of items) {
    views.push(messageToView(item))
    if (item.role !== 'ASSISTANT') continue
    const raw = item.content
    const content: Record<string, unknown> =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    const steers = pickSteers(content)
    if (steers.length > 0) views.push(...steerViewsOf(item, steers))
  }
  return views
}

/**
 * 收起**最新一轮**（从最后一条 `USER` 消息起、到数组末尾），供"重新生成"期间的渲染使用（**P1-3**）。
 *
 * 为什么需要它：重新生成的后端语义是"撤掉上一轮 + 重跑同一段正文"（`POST /:id/regenerate`），
 * 而前端在流式期间会同时持有**两份**同一轮的数据 —— 历史里那条**正在被替换**的旧轮次，
 * 与 store 里这一轮新的流式轮次。不收起旧的就会渲染出**重复的用户气泡与两份回答**，
 * 而用户点的是"替换"。
 *
 * 判据与页面里的 `recallable` 同源（"最新一轮 = 最后一条 USER + 其后的一切"），
 * 且与后端 `recallLastRound` 的取轮口径**逐字一致**（`conversation.service.ts`）——
 * 三处的"一轮"必须是同一个定义。
 *
 * 找不到 `USER` 消息（空历史 / 只有 SYSTEM）⇒ 原样返回（无可收起）。
 */
export function dropLastRound(views: readonly ChatMessageView[]): ChatMessageView[] {
  for (let index = views.length - 1; index >= 0; index--) {
    // ⚠️ 跳过插话气泡（`steer`）：它们不是"一轮的起点"，否则重新生成会把它们当成用户消息留下
    if (views[index]?.role === 'USER' && views[index]?.steer !== true) return views.slice(0, index)
  }
  return [...views]
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
    thinkingSegments: [],
    citations: null,
    tools: [],
    artifacts: [],
    attachments: [],
    createdAt: null,
    status: 'complete',
    plain: true,
  }
}
