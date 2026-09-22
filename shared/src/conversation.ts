/**
 * 会话契约（P0-1-25；`02` §4.5 + §三 + §5.2、`01` §3.3 功能表第 9 条、`03` §4.1）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 会话是**私有资源**：`conversations.user_id` 是 owner 列
 * ─────────────────────────────────────────────────────────────────────
 * 判据与其余三族一致 —— 看 `02` §三 里**有没有 owner 列**（`shared/src/agent.ts` 文件头 ① 那张表）：
 *   · `knowledge_bases` 没有 ⇒ 登录即可；`agents.created_by` 有 ⇒ 创建者 + ADMIN；
 *   · **`conversations.user_id` 有 ⇒ 只有本人**，且**连 ADMIN 也不开后门**：
 *     `01`/`02`/`03` 都没有一处说管理员要能看别人的聊天记录，给它开一个口子是**自己发明权限**，
 *     而且方向是"读别人的私密对话"。
 * 别人的会话对调用者一律 **404（不是 403）**：会话 id 不出现在任何对他人可见的列表里，藏得住；
 * 而 403 等于**确认"这个 id 有效"**，比 404 多给了信息。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 列表项带 `agentName` / `agentType` **快照**（因为 Agent 会被软删）
 * ─────────────────────────────────────────────────────────────────────
 * `02` §4.4：软删 Agent 时「会话转只读**保留**」—— 于是存在"会话还在、但它的 Agent 已经查不到"
 * 的合法状态（`GET /api/agents/:id` 对软删的 Agent 是 404，见 `agent.service.ts`）。
 * 会话列表（`03` §4.1 的侧栏）与对话页头部要靠这两个字段显示，故它们是**join 出来的快照**、
 * 与 `agentItemSchema` 那套投影无关，也**不受 `deleted_at` 过滤**。
 * 它们只读不回写：改名/删除都作用在会话自身。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ `last_message_at` 可空，且"新会话必须排最前" ⇒ 排序要显式 `nulls: 'first'`
 * ─────────────────────────────────────────────────────────────────────
 * 该列的语义是"**最后一条消息落库的时刻**"（`06` P0-1-25 坑预判：维护点在消息**落库**时，
 * 而不是在"发起请求"时 —— 否则点了停止的会话仍算活跃）。于是刚建的会话是 `null`，
 * 而它必须出现在侧栏顶部（否则用户"新建了会话却看不见"）。PG 的 `DESC` 默认就是 NULLS FIRST，
 * 但**不能靠默认值**：那是"看着对、换库/换 ORM 版本就变"的一类。服务层显式写
 * `{ lastMessageAt: { sort: 'desc', nulls: 'first' } }`，本文件把顺序口径写在这里备查。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 「只读」= 不能再产生消息；**不等于"什么都不能改"**
 * ─────────────────────────────────────────────────────────────────────
 * {@link isConversationReadOnly} 只回答一件事：**这个会话还能不能追加消息**（判据的消费方是
 * P0-1-26 的 `POST /:id/chat` 闸门与 P0-1-34 的输入区禁用）。改名与删除**刻意不按 status 拦**：
 * 用户需要能清理自己的历史，而"改个标题"跟"产生消息"是两回事 —— 顺手加一条
 * `status === 'ACTIVE'` 才放行，就是把"删除一个已结束会话"变成做不到的事（P0-1-11 的教训：
 * 自己发明约束会把合法操作挡在门外）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⑤ `streaming` 是**派生**字段，不单独存
 * ─────────────────────────────────────────────────────────────────────
 * `02` §5.2 的会话互斥锁 `chat.active:{id}` 与"是否在流"**必须是同一件事**：分成两个键/两个字段，
 * 就一定会有"锁在但快照说不在"（或反过来）的矛盾态，而两种读法都能在某些页面显得正常。
 * 故本文件只定义 Redis 里**快照的值**（{@link conversationActiveSnapshotSchema}，不含 `streaming`），
 * 响应里由键**是否存在**派生出 `streaming`（{@link conversationActiveSchema}）。
 * ⚠️ 写侧归 **P0-1-26**（`orchestrator/sse.ts` 在流开始时写、结束时删）；本批只实现读侧，
 * 所以现在**恒为 `{streaming:false}`** —— 这一条在 `docs/06` P0-1-25 里明写，并作为验收断言。
 */

import { z } from 'zod'

import { AGENT_TYPES } from './agent.js'
import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 取值域与判据 ─────────────────────────────

/** 会话状态（`schema.prisma` 的 `enum ConversationStatus`；`02` §三） */
export const CONVERSATION_STATUSES = ['ACTIVE', 'FINISHED'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

/**
 * 「这个会话是否只读」—— **唯一的判据**，不让各处比较字面量（见文件头 ④）。
 *
 * 写成函数而不是让调用方写 `status === 'FINISHED'`：这条语义与"哪种状态意味着不可写"
 * 会一起演化（P0-1 阶段只有两种状态、且 `FINISHED` 只由"Agent 被软删"产生；
 * 将来若有"用户主动结束会话"，判据仍应是同一个函数）。
 * 与 `isDocumentSearchable`（P0-1-21）同款做法。
 */
export function isConversationReadOnly(status: ConversationStatus): boolean {
  return status !== 'ACTIVE'
}

/**
 * 没被命名过的会话在界面上的回落文案（`topic` 是 `null`）。
 *
 * 放 `shared` 的理由与 `DOCUMENT_PARSING_HINT`（P0-1-21）相同：这是**界面判据**，
 * 前端多个出口（侧栏、对话页头部、删除确认框）都要一致 —— 各处各写一份，
 * 改口径时就得全仓搜。
 * ⚠️ P0-1 阶段**没有自动命名**（`01`/`02`/`03` 都没要求），`topic` 只可能由"重命名"产生。
 */
export const CONVERSATION_UNTITLED_HINT = '新会话'

// ───────────────────────────── 列表 / 详情投影 ─────────────────────────────

/**
 * 一条会话（**列表端点唯一的投影**）。
 *
 * `lastMessageAt` 为 `null` 表示"还没有消息"（见文件头 ③）；前端据此决定是否显示"新会话"提示，
 * 不要用 `createdAt` 去猜（覆盖重建类的操作会让两者不同步 —— 这里是"消息落库"这一个触发源）。
 */
export const conversationItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** Agent 名**快照**（Agent 可能已软删，见文件头 ②） */
  agentName: z.string(),
  /** Agent 类型**快照**（对话页头部的类型标签要用；软删后 `GET /api/agents/:id` 是 404） */
  agentType: z.enum(AGENT_TYPES),
  /** `null` = 还没命名过（界面回落 {@link CONVERSATION_UNTITLED_HINT}） */
  topic: z.string().nullable(),
  status: z.enum(CONVERSATION_STATUSES),
  /** 最后一条消息**落库**的时刻；`null` = 还没有消息 */
  lastMessageAt: z.string().nullable(),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ConversationItem = z.infer<typeof conversationItemSchema>

// ───────────────────────────── 列表 ─────────────────────────────

/**
 * 会话列表查询参数（offset/limit，与其余列表同口径）。
 *
 * **不做 `status` 过滤**：`02` §4.4 的"只读保留"要求已结束（`FINISHED`）的会话**照样看得见**
 * —— 给一个"只看活跃"的开关，会让"Agent 被删之后我的历史去哪了"变成一个要靠猜的问题。
 */
export const listConversationsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const conversationListResultSchema = offsetPageOf(conversationItemSchema)
export type ConversationListResult = z.infer<typeof conversationListResultSchema>

// ───────────────────────────── 建 ─────────────────────────────

/**
 * `POST /api/conversations` 请求体（`02` §4.5：`{agentId}` → 新会话）。
 *
 * **只有 `agentId`**：`topic` 不在建会话时给（`03` §4.1 的流程是"首条消息发送时才创建会话"，
 * 那时还没有任何可以拿来做标题的东西）。会话的初值是 `topic = null` + `lastMessageAt = null`。
 *
 * 服务层会校验 Agent **存在且未软删**（软删的建不了新会话 —— 那是给一个已经作废的智能体
 * 开一个新的对话入口）。**刻意不校验模型的可用性**：那是"发消息"的前置（P0-1-26/27 的
 * 424 `NEED_CREDENTIAL` / 409），绑一个模型被停用的 Agent 仍然可以进对话页看历史。
 */
export const createConversationBodySchema = z.object({
  agentId: z
    .string({ required_error: '请选择智能体' })
    .uuid('智能体 ID 不是合法 UUID'),
})
export type CreateConversationBody = z.infer<typeof createConversationBodySchema>

// ───────────────────────────── 路径参数与改名 ─────────────────────────────

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const conversationIdParamsSchema = z.object({
  id: z.string().uuid('会话 ID 不是合法 UUID'),
})
export type ConversationIdParams = z.infer<typeof conversationIdParamsSchema>

/**
 * `PATCH /api/conversations/:id` 请求体：重命名（`02` §4.5、`03` §4.1 的行内编辑）。
 *
 * **不是"三态"**：只收非空字符串，**`null` 一律拒绝**（`.string()` 会把 `null` 判成类型错）。
 * 理由：`null` 的含义是"回到没命名过"，而"没命名"是建会话那一刻的瞬态 ——
 * `03` §4.1 的侧栏没有"清空标题"的交互，允许它只会多出第二种恢复未命名状态的方式
 * （与 `updateAgentBodySchema` 里"`guideQuestions` 的两种清空写法并存"是同一类隐患）。
 * 与 `systemPrompt` 那类**多行文本**不同，标题是**单行显示名**，故照样 `trim()`。
 */
export const renameConversationBodySchema = z.object({
  topic: z
    .string({
      required_error: '请输入会话标题',
      invalid_type_error: '会话标题必须是字符串（不支持传 null 清空，见本 schema 的注释）',
    })
    .trim()
    .min(1, '会话标题不能为空')
    .max(255, '会话标题最多 255 个字符'),
})
export type RenameConversationBody = z.infer<typeof renameConversationBodySchema>

/**
 * `DELETE /api/conversations/:id` 的响应。
 *
 * `deletedMessages` 是**删前数出来的**（删完就数不出来了，与 P0-1-19 的 `deletedChunks` 同款）。
 * 带上它是 `03` §七 的硬要求：**会话删除是"级联删除"**（"Modal + 红色危险按钮 + 明示影响范围"），
 * 确认框要说清"将删除 N 条消息"；只回一个 `ok` 的话界面给不出任何有信息量的提示。
 */
export const removeConversationResultSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  topic: z.string().nullable(),
  /** 连带删掉的消息数（`messages` 由外键 `CASCADE` 连带清除） */
  deletedMessages: z.number().int().min(0),
})
export type RemoveConversationResult = z.infer<typeof removeConversationResultSchema>

// ───────────────────────────── 活跃流状态（`/:id/active`） ─────────────────────────────

/**
 * 活跃流**快照**（Redis `chat.active:{conversationId}` 的值形态，**不含 `streaming`**，见文件头 ⑤）。
 *
 * 三个字段都是「断线重连要恢复的进度视图」（`02` §5.2、`03` §4.1 的输入区状态机）：
 *   · `queuedPosition` —— 沙箱并发满时的排队位次（`02` §5.1 的 `queued` 事件，**1 = 下一个**）；
 *   · `currentTool` —— **工具名**而不是整张工具卡片：重连时界面只需要"它在干什么"，
 *     完整的卡片结构由历史消息与事件流提供（`02` §5.2 的"事件即真相、历史读库"）；
 *   · `startedAt` —— 流的开始时刻（ISO 8601），界面可以据此显示已用时。
 */
export const conversationActiveSnapshotSchema = z.object({
  queuedPosition: z.number().int().min(1).nullable(),
  currentTool: z.string().nullable(),
  startedAt: z.string().nullable(),
})
export type ConversationActiveSnapshot = z.infer<typeof conversationActiveSnapshotSchema>

/**
 * `GET /api/conversations/:id/active` 的响应：快照 + **派生**的 `streaming`。
 * 无流时（Redis 里没有那个键）恒为 `{streaming: false, queuedPosition: null, currentTool: null, startedAt: null}`
 * —— 这正是 `06` P0-1-25 的验收原文。
 */
export const conversationActiveSchema = conversationActiveSnapshotSchema.extend({
  streaming: z.boolean(),
})
export type ConversationActive = z.infer<typeof conversationActiveSchema>

/** 无流时的快照（四处字段全是 `null`） */
export const EMPTY_ACTIVE_SNAPSHOT: ConversationActiveSnapshot = Object.freeze({
  queuedPosition: null,
  currentTool: null,
  startedAt: null,
})

/**
 * Redis 里的原始字符串 → **一定可用**的快照。**永不抛错**（`normalizeGuideQuestions` 同族）。
 *
 * 为什么读取端也要兜一层：这个值的写侧是编排层（P0-1-26），而 `/active` 是**断线重连**路径 ——
 * 恰恰是最不能 500 的地方（用户已经断过线了，再给一个 500 会让他连"重新对齐历史"这个动作都做不了）。
 * 于是：JSON 解析失败 / 不是对象 / 字段类型不对 / 日期不可解析 ⇒ 逐字段降级为 `null`，
 * 而不是整条失败。⚠️ 只做**类型收敛与 trim**，不做任何"猜测"（例如不去猜 `position: 0` 是"没排队"）。
 *
 * ⚠️ **它不负责判断"有没有流"**：键存在就说明有流（见文件头 ⑤），值坏只影响细节展示。
 * 调用方要把"值解析不出来"记一条 warn —— 那是写侧出错的可观测痕迹，不该被静默吞掉。
 */
export function parseActiveSnapshot(raw: string | null | undefined): ConversationActiveSnapshot {
  const empty = (): ConversationActiveSnapshot => ({ ...EMPTY_ACTIVE_SNAPSHOT })
  if (raw === null || raw === undefined || raw.trim() === '') return empty()

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return empty()
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return empty()

  const record = decoded as Record<string, unknown>
  const { queuedPosition, currentTool, startedAt } = record
  return {
    queuedPosition:
      typeof queuedPosition === 'number' && Number.isInteger(queuedPosition) && queuedPosition >= 1
        ? queuedPosition
        : null,
    currentTool:
      typeof currentTool === 'string' && currentTool.trim() !== '' ? currentTool.trim() : null,
    startedAt:
      typeof startedAt === 'string' && !Number.isNaN(Date.parse(startedAt)) ? startedAt : null,
  }
}

// ───────────────────────────── 消息落库形态（P0-1-27 写入端 / P0-1-28 读取端）─────────────────────────────

/**
 * 一条**引用**（`items[]` 的元素）。
 *
 * ⚠️ 这份形状被**两个出口**共用，故必须只定义一次：
 *   · SSE 的 `citations` 事件（`shared/src/sse.ts` 的 `sseCitationsPayloadSchema`，本轮现算现发）；
 *   · `messages.content.citations`（jsonb，落库后由历史接口读出来重绘引用卡）。
 * 两处各写一份的后果很具体：**流里出现的引用卡与刷新后恢复出来的引用卡长得不一样**
 * （`03` §五 要求"单一渲染路径"），而且没有编译期错误、只有肉眼能发现。
 *
 * `score` 是**融合分**（`rrfScore`）而不是任何一路的原始分：`§九` 的口径是"对外只给融合分"
 * （两路量纲不可比，把 `vectorScore` 与 `bigm_similarity` 混在一张卡上会让数字无法解释）。
 */
export const citationItemSchema = z.object({
  docName: z.string(),
  snippet: z.string(),
  score: z.number(),
})
export type CitationItem = z.infer<typeof citationItemSchema>

/**
 * 一条消息的 `content`（jsonb）—— **写入与读取的唯一形态**（`02` §三：`content(jsonb)`）。
 *
 * 设计口径（三条，都是"改了就会让历史读不出来"的）：
 *   · **`text` 必填**（可以是空串）：它是历史重建时唯一进入 LLM 上下文的部分
 *     （`orchestrator/chatContext.ts#selectHistoryMessages`）—— 缺了它，多轮对话就断了。
 *   · `thinking` / `citations` **可选而非默认 `[]`/`''`**：省掉这个键表示"这一段本来就没有"，
 *     与"它有但是空的"在界面上是两件事（思考折叠区该不该出现、引用区该不该出现）。
 *   · `tool_calls` / `attachments` **本版本刻意不定型**：工具属 **P0-2**（MCP）、附件属 **P1**
 *     （`files` 表），现在写进去只会是"猜的形状"，而 `02` §三 已写明"结构一经写入**不改语义**"。
 *     ⚠️ 故本 schema 是 **passthrough** 之外的严格形状：将来加字段时要**同时**回到这里加，
 *     否则 P0-1-28 的读取端会把它当未知字段丢掉（历史渲染缺一块，且不报错）。
 */
export const messageContentSchema = z.object({
  text: z.string(),
  thinking: z.string().optional(),
  citations: z.array(citationItemSchema).optional(),
})
export type MessageContent = z.infer<typeof messageContentSchema>
