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
 * ✅ 那个写侧已在 P0-1-26 落地（`streaming` 从此是真值）；**P0-2-10 又给快照加了第四个字段
 * `pendingConfirmId`**（正在等待应答的确认 id，见其注释）—— 它同样**不是**"给界面看的进度"，
 * 而是 `/confirm` 端点判断"这个迟到的答复该不该被接受"的**唯一**来源。
 * ─────────────────────────────────────────────────────────────────────
 * ⑥ 消息历史（P0-1-28）：**读取端不解释 `content`**，原样透出
 * ─────────────────────────────────────────────────────────────────────
 * `messageItemSchema.content` 刻意是 `z.unknown()`（**不是** `messageContentSchema`）：
 * 那个 schema 会把未声明的键**静默剥掉**（见其注释）—— 用它过滤一遍，P0-2 写进去的 `tool_calls`
 * 就会在"刷新后重放历史"时凭空消失，而**没有任何报错**（`01` §3.4「完整还原」要求的正是
 * "工具卡 / 引用卡都能还原"）。服务端的职责只有一条：**把那一列原封不动地交出去**。
 * 前端渲染时再按已知的三段取值（未知段原样留着）。
 * ✅ **P0-2-8 起 `tool_calls` 已定型**（{@link toolCallRecordSchema}）：这条"原样透出"的口径
 * 因此**不用改**，P0-2-11 只要在前端 `messageToView` 里加一段映射（那正是它留的接回点）。
 */

import { z } from 'zod'

import { AGENT_TYPES } from './agent.js'
import { cursorPageOf, offsetPageOf } from './envelope.js'
import { ERROR_CODES } from './errors.js'

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
 * ⚠️ 产品优化（2026-09-29）后 `topic` 会在**首条用户消息落库时**被自动命名
 * （{@link deriveConversationTopic}），所以这个回落文案只剩两种处境：
 * "刚建好、还没发消息"的会话，以及"自动命名前的极短窗口"。
 */
export const CONVERSATION_UNTITLED_HINT = '新会话'

/**
 * 会话标题的长度上限（`P0-1-34` 起**前后端同源**）。
 *
 * 字面值 `255` 原本只写在 {@link renameConversationBodySchema} 里，而 P0-1-34 的侧栏行内编辑
 * 也要用它（`maxLength` + 本地的"是否可保存"判据）。前端再抄一份数字的后果不是"多写一个常量"，
 * 而是**两处会各自演化**（`docs/06` §六 第 ⑰ 条："同一口径在两处各写一遍，必有一处先腐烂"）。
 * 落地形态与 `PASSWORD_*` / `MESSAGE_PAGE_LIMIT_*` 同款：常量放 `shared`，schema 与界面都引它。
 */
export const CONVERSATION_TOPIC_MAX_CHARS = 255

/**
 * 从**首条用户消息**推导会话标题（产品优化 2026-09-29：发起会话后标题不该停在「新会话」）。
 *
 * 三条口径：
 *   · `trim()` + 把连续空白（含换行）压成单个空格 —— 标题是**单行显示名**，多行正文直接
 *     放进侧栏会把布局撑破，而"标题里保留换行"没有任何展示价值；
 *   · 按**码点**截断到 {@link CONVERSATION_TOPIC_MAX_CHARS} —— 与 `renameConversationBodySchema`
 *     的 `.max()` 同口径（zod 的 `.max()` 也是按码点，`String.prototype.slice` 会劈代理对）；
 *   · 返回空串 = 首条消息"没内容可当标题"（理论上不会发生：`POST /:id/chat` 的正文已被
 *     schema `trim().min(1)` 拦过）。调用方把空串当"不命名"处理（写入口用 CAS 也天然安全）。
 */
export function deriveConversationTopic(firstUserText: string): string {
  const collapsed = firstUserText.trim().replace(/\s+/g, ' ')
  const chars = [...collapsed]
  return chars.length > CONVERSATION_TOPIC_MAX_CHARS ? chars.slice(0, CONVERSATION_TOPIC_MAX_CHARS).join('') : collapsed
}

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
    .max(CONVERSATION_TOPIC_MAX_CHARS, `会话标题最多 ${CONVERSATION_TOPIC_MAX_CHARS} 个字符`),
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

/**
 * `POST /api/conversations/:id/recall` 的响应（产品优化 2026-09-29：撤回最新一轮）。
 *
 * 带上三个数（与删除同族）：界面要能说出"删掉了什么"。`deletedMessages` / `deletedArtifacts`
 * 都是**同一个事务里数出来**的（`messages` 由外键 CASCADE 时数不出来，必须先数后删）。
 */
export const recallConversationResultSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** 删掉的消息数（撤回的那一轮；本仓一轮 = USER + ASSISTANT 两条，同事务写入） */
  deletedMessages: z.number().int().min(0),
  /** 连带删掉的产物行数（TaskAgent 那一轮的产出文件；ChatBot 恒为 0） */
  deletedArtifacts: z.number().int().min(0),
})
export type RecallConversationResult = z.infer<typeof recallConversationResultSchema>

// ───────────────────────────── 活跃流状态（`/:id/active`） ─────────────────────────────

/**
 * 活跃流**快照**（Redis `chat.active:{conversationId}` 的值形态，**不含 `streaming`**，见文件头 ⑤）。
 *
 * 四个字段都是「断线重连要恢复的进度视图」（`02` §5.2、`03` §4.1 的输入区状态机）：
 *   · `queuedPosition` —— 沙箱并发满时的排队位次（`02` §5.1 的 `queued` 事件，**1 = 下一个**）；
 *   · `currentTool` —— **工具名**而不是整张工具卡片：重连时界面只需要"它在干什么"，
 *     完整的卡片结构由历史消息与事件流提供（`02` §5.2 的"事件即真相、历史读库"）；
 *   · `startedAt` —— 流的开始时刻（ISO 8601），界面可以据此显示已用时。
 *   · `pendingConfirmId` —— **正在等待用户应答的那个确认**的 id（P0-2-10 的契约增量，`02` §9.10）。
 *     它**不是**"给界面看的进度"，而是 `/confirm` 端点**唯一**的判据来源：应答要能回答
 *     "我答的是不是当前这个问题"（`confirmConversationResultSchema.applied`）——
 *     没有它，任何迟到的点击都会被当成当前答案写进去，症状是"**确认卡一闪而过**"
 *     （`06` P0-2-10 坑预判 2）。顺带它也让重连的客户端知道"有一个提问在等我"。
 *     `null` = 当前没有待答的确认（绝大多数时刻）。
 */
export const conversationActiveSnapshotSchema = z.object({
  queuedPosition: z.number().int().min(1).nullable(),
  currentTool: z.string().nullable(),
  startedAt: z.string().nullable(),
  pendingConfirmId: z.string().nullable(),
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
  pendingConfirmId: null,
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
  const { queuedPosition, currentTool, startedAt, pendingConfirmId } = record
  return {
    queuedPosition:
      typeof queuedPosition === 'number' && Number.isInteger(queuedPosition) && queuedPosition >= 1
        ? queuedPosition
        : null,
    currentTool:
      typeof currentTool === 'string' && currentTool.trim() !== '' ? currentTool.trim() : null,
    startedAt:
      typeof startedAt === 'string' && !Number.isNaN(Date.parse(startedAt)) ? startedAt : null,
    // ⚠️ **这一行不加就会有"静默失效"的后果**（P0-2-10）：读取端是本函数、写入端是
    // `orchestrator/sse.ts` 的 `updateSnapshot` —— 漏掉它，`/confirm` 会永远读到 `null`
    // ⇒ 所有应答都变成 `applied:false`（"确认卡点了没反应"），而没有任何报错。
    // 与 `currentTool` 同款：非空字符串才算，其余（含缺失键的旧快照）一律 `null`。
    pendingConfirmId:
      typeof pendingConfirmId === 'string' && pendingConfirmId.trim() !== ''
        ? pendingConfirmId.trim()
        : null,
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
 *
 * ⚠️ **`snippet` 放的是"给模型看的正文"**（2026-09-30 起是**整块原文**，不是命中窗口）：
 * 引用卡与编排层注入模型的「知识库检索结果」必须是同一份文本（卡片的意义 = 用户核对模型看到了
 * 什么）。字段名沿用 `snippet` 只为兼容已落库的历史 jsonb（老行里存的是旧窗口；它是个字符串，
 * 新旧都能读，卡片照常渲染）。
 */
export const citationItemSchema = z.object({
  docName: z.string(),
  snippet: z.string(),
  score: z.number(),
})
export type CitationItem = z.infer<typeof citationItemSchema>

// ───────────────────────────── 工具调用（P0-2-8）─────────────────────────────

/**
 * 工具来源（`02` §5.1 的 `tool_call.kind`）：ChatBot 的 MCP 工具 / TaskAgent 的沙箱工具 /
 * **平台内置工具**（2026-09-30 新增）。
 *
 * ⚠️ **P0-2-8 起家在本文**（P0-1-26 时定义在 `sse.ts`）。搬家的理由：同一套取值域现在要出现在
 * **落库**（`messages.content.tool_calls[].kind`）与**事件**（`tool_call` 的 payload）两处，
 * 而"两处各写一份字面量"必然有一处先腐烂。`sse.ts` 改成 `import`（前端从包根 import，**无感**）。
 *
 * ⚠️ `BUILTIN`（产品反馈 2026-09-30）：由**平台自己实现**、不经任何外部系统的工具，当前只有
 * 「知识库检索」（`knowledge_search`）。单独取值而不是复用 `MCP` 的理由：它没有 MCP server
 * （`serverName` 是"知识库"、`serverId` 连键都没有）、也永远不走凭据/危险确认流 ——
 * 混进 `MCP` 会让前端卡片摆出「去配置凭据」那种对它无意义的入口。
 */
export const TOOL_CALL_KINDS = ['MCP', 'SANDBOX', 'BUILTIN'] as const
export type ToolCallKind = (typeof TOOL_CALL_KINDS)[number]

/** 工具调用状态机（`RUNNING` → `SUCCESS` / `ERROR`）；`02` §5.1 */
export const TOOL_CALL_STATUSES = ['RUNNING', 'SUCCESS', 'ERROR'] as const
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number]

/**
 * 一次工具调用的**持久化记录**（`messages.content.tool_calls[]`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么它是"卡片"这件事的唯一形状（`sseToolCallPayloadSchema` 由它 `.omit()` 派生）
 * ─────────────────────────────────────────────────────────────────────
 * 同一张工具卡有**两个来源**（`03` §六 的"单一渲染路径"）：流里的 `tool_call` 事件、
 * 刷新后从 `GET /:id/messages` 的 jsonb 里恢复。两者字段一旦分叉，症状是"流里有的卡片、
 * 刷新之后少一块"，而**没有任何报错**（P0-1-28 的文件头 ⑥ 就是为这件事写的）。
 * ⇒ 事件 payload = **记录去掉 `arguments`**（完整入参只留档、不上线）—— 派生而不是各写一份，
 * 于是"加字段忘了同步"这件事**结构上不可能发生**（同 `conversationActiveSchema` 的手法）。
 *
 * `arguments` **不在事件里**、只在库里（`06` P0-2-8 的原文："完整入参留在库里"）：
 * 卡片要的是**摘要**（`inputSummary`），完整入参是排查"模型为什么这么调"的唯一线索。
 */
export const toolCallRecordSchema = z.object({
  /** 上游给的调用 id（同一 id 的多次推送 = 状态机流转；前端按它 upsert） */
  callId: z.string().min(1),
  /** **下发给模型的那个名字**（`mcp_{slug}_{tool}`，不是 MCP 侧的原始工具名） */
  toolName: z.string().min(1),
  /** 工具来自哪个系统（`kind=SANDBOX` 时为空串）—— 展示用 */
  serverName: z.string(),
  /**
   * 工具所属 MCP server 的 **id**（`kind=SANDBOX` 时没有这个键）。
   *
   * ⚠️ **P0-2-11 的契约增量**，理由只有一条：`02` §9.3 要求"缺凭据 ⇒ 工具卡带『去配置』跳转"，
   * 而那个跳转的落点是 `/mcp/credentials?serverId=…`（`03` §4.2 / §4.5 的 `?serverId=` 定位）。
   * {@link serverName} **做不到**这件事：它是展示名（可重名、也不是那条路径的参数形态）。
   * 从 `toolName` 反推更不行 —— `mcp_{slug}_{tool}` 那段 slug **刻意不唯一**（`shared/src/mcp.ts`
   * 文件头 ③），反推会指到别的 server 上，而症状是"点了去配置、落在另一台 server 的分组上"。
   *
   * ⚠️ 它是 `optional` 而**不是** nullable：`kind=SANDBOX`（P0-3）的工具压根不属于任何 server，
   * "没有这个键"与"有但是空"是两件事（同 `output` / `errorCode` 的口径）。
   */
  serverId: z.string().optional(),
  kind: z.enum(TOOL_CALL_KINDS),
  status: z.enum(TOOL_CALL_STATUSES),
  /** 给用户看的**参数摘要**（截断过；凭据值已抹除，见 `chatContext#summarizeToolInput`） */
  inputSummary: z.string(),
  /** 结果文本（`RUNNING` 时没有；与回填给模型的**是同一份**，见 `chatContext#truncateToolResult`） */
  output: z.string().optional(),
  /**
   * 失败时的错误码（`shared/src/errors.ts` 的取值域），**不是 HTTP 状态码**。
   *
   * 为什么非要它：`02` §9.3 要求"无凭据 ⇒ `tool_call{ERROR}` → 前端卡片带**『去配置』跳转**"
   * ——`output` 是一句人话，前端从里面认不出"这是缺凭据"，只能靠一个**结构化**的信号。
   */
  errorCode: z.enum(ERROR_CODES).optional(),
  /** 模型给出的参数 **JSON 原样**（含不合法 JSON 的原样）；卡片不显示，留档排查用 */
  arguments: z.string().optional(),
})
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>

/**
 * 一轮回答使用的模型（产品优化 2026-09-29：重新进入会话时，头部模型选择器要回显"上次用的模型"）。
 *
 * 三个字段与 `agentModelOptionSchema` 同一份语义（`modelId` = 池成员 id，也是对话页模型选择器的
 * value；`modelName` / `modelLabel` 是展示名）。记录进 `messages.content.model` 段：
 * 历史还原时前端拿 `modelId` 去当前模型池里找 —— 模型被删除/停用时池里没有它 ⇒ 界面回落到
 * 默认模型（判据在前端 `ChatPage`，本 schema 只负责"写进去的形状"）。
 *
 * ⚠️ 它记的是"这一轮**实际用了**哪个模型"，不是"默认模型是哪个"：用户在对话页选了池里的
 * 非默认模型后，重进会话要靠它回显，而不是又落回默认。
 */
export const messageModelSegmentSchema = z.object({
  modelId: z.string(),
  /** 上游型号名（`gpt-4o-mini`…，不是界面别名） */
  modelName: z.string(),
  /** 模型别名（界面上给业务同学看的名字） */
  modelLabel: z.string(),
})
export type MessageModelSegment = z.infer<typeof messageModelSegmentSchema>

// ───────────────────── 产物（P0-3-7 定型）─────────────────────

/**
 * 一条**产出文件**的记录（P0-3-7 定型；`02` §三 的 `artifacts` 行 ↔ 消息 `content.artifacts` 段
 * ↔ SSE `artifact` 事件三处共用的形状 —— 与 `toolCallRecordSchema` / `citationItemSchema` 同一条纪律：
 * 同一张卡既由 `artifact` 事件现画、又由 `messages.content.artifacts` 在刷新后重画、
 * 还要对得上 `artifacts` 表那行，**三处各写一份必先分叉一处**，所以只定义这一次）。
 *
 * · `artifactId` = `artifacts` 行的**主键**（`uuid(7)`，Prisma 侧生成）—— 下载/预览（P0-3-9）
 *   的路由参数就是它，不是 `fileKey`（对象键是实现细节，不出现在契约里）；
 * · `fileName` = 容器内**相对 `/work` 的路径**（产物可能在子目录里，如 `out/report.csv`
 *   —— 那**就是**它给用户看的名字，不拆成"目录 + 文件名"两段，前端少一次拼接）；
 * · `size` / `mime` = 扫描时（P0-3-7）由**后端**按扩展名定的那一组 —— `mime` 是产物
 *   `Content-Type` 的**唯一来源**（`子方案④` §四：既不是 S3 对象的 `ContentType`、
 *   也不是扩展名的运行时再判）。
 */
export const artifactItemSchema = z.object({
  artifactId: z.string().min(1),
  fileName: z.string(),
  size: z.number().int().min(0),
  mime: z.string(),
})
export type ArtifactItem = z.infer<typeof artifactItemSchema>

// ───────────────────── 产物列表与下载（P0-3-9）──────────────────────

/** 产物列表一页最多几条（与其余列表的上限一致） */
export const ARTIFACT_PAGE_LIMIT_MAX = 100
/** 不传 `limit` 时的默认条数（与其余列表的"默认 20"对齐） */
export const ARTIFACT_PAGE_LIMIT_DEFAULT = 20

/**
 * `GET /api/conversations/:id/artifacts` 的查询参数（`02` §四：除消息外的列表一律 offset/limit）。
 *
 * ⚠️ **不用游标**：产物不是"对话流"，面板要的是"这个会话产出过哪些文件"（可按时间倒序翻页），
 * 而消息那种"向历史深处滚动"的语义在这里不存在 —— 硬套游标只会让"回到第二页"变成一次
 * 需要额外 `count` 的操作（见 `envelope.ts#cursorPageOf` 的理由）。
 */
export const listArtifactsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'limit 至少为 1')
    .max(ARTIFACT_PAGE_LIMIT_MAX, `limit 最多 ${ARTIFACT_PAGE_LIMIT_MAX}`)
    .default(ARTIFACT_PAGE_LIMIT_DEFAULT),
})
export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>

/**
 * 「会话产物」列表（`GET /api/artifacts`）的查询参数（**会话产物**：跨会话汇总本人全部产物）。
 *
 * 与产物列表**逐字同款**（offset/limit、同样的上限与默认值）—— 只给它一个独立的名字，
 * 让"会话产物"这个跨会话端点有自己可读的契约；两个 schema 是**同一个对象**，改一处分页口径
 * 两边同时变（`docs/06` §六 第 ⑰ 条：同一口径两处各写一遍，必有一处先腐烂）。
 */
export const listMyArtifactsQuerySchema = listArtifactsQuerySchema
export type ListMyArtifactsQuery = ListArtifactsQuery

/**
 * 列表里的一条产物 = {@link artifactItemSchema} + `createdAt`。
 *
 * **刻意由 `artifactItemSchema` `.extend()` 派生**：这张卡有三个来源（流里 `artifact` 事件、
 * 刷新后 `messages.content.artifacts`、本列表），前两个**没有** `createdAt`（事件是现发、
 * 消息的产物段在落库时定型于 P0-3-7），只有本列表能给出"什么时候产出的"。
 * 派生而不是各写一份 ⇒ 加字段时不会出现"列表里多一列、卡片上少一块"。
 *
 * **刻意不带的两列**：
 *   · `fileKey`（S3 对象键）—— 它是存储层实现细节，**不出现在任何对外契约里**
 *     （`02` §三；下载/预览的路由参数是 `artifactId`）；
 *   · `previewReady` —— P0-3-7 起恒为 `false`，它的语义属 **P0-3-10**（`02` §三 明写"消费者属
 *     P0-3-10"）。在本批把它放进契约等于**替下一批定语义**，且界面上会多出一个永远为假的开关。
 */
export const artifactListItemSchema = artifactItemSchema.extend({
  /** ISO 8601（JS 侧显式写入的 `created_at`，见 `artifacts.ts` 的时区注释） */
  createdAt: z.string(),
})
export type ArtifactListItem = z.infer<typeof artifactListItemSchema>

/** 产物列表响应 = `{ items, total, offset, limit }`（`shared/src/envelope.ts#offsetPageOf`） */
export const artifactListResultSchema = offsetPageOf(artifactListItemSchema)
export type ArtifactListResult = z.infer<typeof artifactListResultSchema>

/** 路径参数（`/api/artifacts/:id/...` 的 `:id` = `artifacts` 行主键，`uuid(7)`） */
export const artifactIdParamsSchema = z.object({
  id: z.string().uuid('产物 ID 不是合法 UUID'),
})
export type ArtifactIdParams = z.infer<typeof artifactIdParamsSchema>

// ───────────────────── 产物预览（P0-3-10）─────────────────────

/**
 * 预览的**五种形态**（`子方案④` §四 2 / §五）。
 *
 * `none` 不是一个错误态，而是"这个格式没有在线预览"这个**事实**（zip / docx / 未知类型）⇒
 * 界面上表现为**没有「预览」按钮**、只给下载，而不是"按钮置灰"（`03` §4.5 同款口径：
 * 能力有无是事实，不是"暂不可用"）。
 */
export const PREVIEW_KINDS = ['html', 'image', 'pdf', 'text', 'none'] as const
export type PreviewKind = (typeof PREVIEW_KINDS)[number]

/**
 * 图片 / PDF **直连渲染**（`<img>` / `<iframe>`）的体积闸门（10 MiB）。
 *
 * ⚠️ 放 `shared` 而不是 env：前端要**在发起请求之前**就知道"这个不值得内联"，
 * 否则要么白拉 50MB、要么前端自己抄一个数（`子方案④` §二）。
 */
export const ARTIFACT_PREVIEW_MAX_INLINE_BYTES = 10 * 1024 * 1024

/** MD / CSV / 文本类**取回文本**的体积闸门（2 MiB）—— 文本要进 JS 字符串并参与解析，比内联更紧 */
export const ARTIFACT_PREVIEW_MAX_TEXT_BYTES = 2 * 1024 * 1024

/**
 * 预览形态的**唯一判据**：`previewKindOf(mime)`。
 *
 * 两个消费者、一个函数（`子方案④` §五 1）：
 *   · **前端**用它决定"用哪个渲染器 / 有没有预览入口"；
 *   · **后端**用它决定 `GET /api/artifacts/:id/content` 上哪一组响应头（隔离头尤其）。
 * ⇒ 不可能出现"前端当图片渲染、后端却按 HTML 加隔离"的分叉 —— 那种分叉**没有任何一层会报错**。
 *
 * 三条实现口径：
 *   ① **只认 `artifacts.mime`，不看 `file_name` 的扩展名**（引擎可以把 `evil.html` 命名成 `x.png`，
 *      而 `mime` 是后端扫描时定的那一个）；
 *   ② ★ **`image/svg+xml` 归 `html` 那一族**：SVG 是**能带 `<script>` 的文档** —— `<img>` 上下文里
 *      脚本不执行（安全），但"在新标签页打开"就会以**我们站点的源**执行 ⇒ 它与 HTML 同级，走
 *      iframe + 双隔离，代价只是"SVG 不在 `<img>` 里直出"，观感完全一样；
 *   ③ **名单刻意保守**（与 `artifactMimeOf` 同款）：只认 `子方案④` §四 2 表里列出来的那些，
 *      其余（含 `text/x-python` / `text/javascript` / `text/yaml` 这类"其实也能当文本看"的类型）
 *      一律 `none` ⇒ 只给下载。**要扩就在这一处扩**，扩了前后端同时生效。
 *
 * `mime` 可能带参数（如 `text/html; charset=utf-8`）⇒ 先取 `;` 之前那一段再比；
 * 非字符串（`null` / `undefined`）与空串一律 `none`（**不抛错**：它只是决定"有没有预览入口"）。
 */
export function previewKindOf(mime: string | null | undefined): PreviewKind {
  if (typeof mime !== 'string') return 'none'
  const raw = mime.trim().toLowerCase()
  const semicolon = raw.indexOf(';')
  const base = (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim()
  if (base === '') return 'none'

  // ⚠️ `svg` 必须排在 `image/*` 之前（它是 `image/*` 的子集，却归 html 那一族）
  if (base === 'text/html' || base === 'application/xhtml+xml' || base === 'image/svg+xml') return 'html'
  if (base === 'application/pdf') return 'pdf'
  if (
    base === 'text/markdown' ||
    base === 'text/csv' ||
    base === 'text/tab-separated-values' ||
    base === 'text/plain' ||
    base === 'application/json'
  ) {
    return 'text'
  }
  if (base.startsWith('image/')) return 'image'
  return 'none'
}

// ───────────────────── 附件（P1-4 定型）─────────────────────

/**
 * 一次对话最多携带几个附件（**前后端同源**：`chatRequestBodySchema` 的上限与输入区的
 * "还能不能再选"都用它，避免两处各写一个数字）。
 */
export const CHAT_ATTACHMENT_MAX_COUNT = 5

/**
 * 附件的**两种处置**（`01` §3.4 需求 35 的原文："图片多模态直读；文本类后端解析注入"）。
 *
 *   · `IMAGE` —— 图片（png/jpg/jpeg/webp/gif/bmp）：转 base64 作为多模态 part 直读，
 *     要求所选模型 `supportsVision=true`（否则服务层 409 拦下）；
 *   · `DOCUMENT` —— 文本类（txt/md/pdf/docx）：后端解析出正文后**注入**到本轮用户消息里。
 *
 * 刻意只有两种而不是"按 MIME 细分"：它决定的是**走哪条链路**（多模态 vs 文本注入），
 * 而卡片渲染上两者本就是"缩略图"与"文件条"两种形态。
 */
export const CHAT_ATTACHMENT_KINDS = ['IMAGE', 'DOCUMENT'] as const
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number]

/**
 * 一个附件（`POST /api/files/upload` 的响应 ↔ `messages.content.attachments[]` 落库段
 * ↔ 前端消息气泡的渲染输入，三处共用的**唯一形状**；与 `artifactItemSchema` 同一条纪律）。
 *
 * · `fileId` = `files` 行主键，取内容端点的路径参数就是它（对象键是存储层细节、不出现在契约里）；
 * · `kind` 由**服务端**在上传时按扩展名判定一次（前端拿它决定渲染成缩略图还是文件条，
 *   **不自己看扩展名**——与 `previewKindOf` 同款：判据只有一处）。
 */
export const attachmentItemSchema = z.object({
  fileId: z.string().min(1),
  /** 用户上传时的原始文件名（展示用） */
  name: z.string(),
  size: z.number().int().min(0),
  mime: z.string(),
  kind: z.enum(CHAT_ATTACHMENT_KINDS),
})
export type AttachmentItem = z.infer<typeof attachmentItemSchema>

/** 路径参数（`/api/files/:id/content` 的 `:id` = `files` 行主键，`uuid(7)`） */
export const fileIdParamsSchema = z.object({
  id: z.string().uuid('附件 ID 不是合法 UUID'),
})
export type FileIdParams = z.infer<typeof fileIdParamsSchema>

/**
 * 一条消息的 `content`（jsonb）—— **写入与读取的唯一形态**（`02` §三：`content(jsonb)`）。
 *
 * 设计口径（三条，都是"改了就会让历史读不出来"的）：
 *   · **`text` 必填**（可以是空串）：它是历史重建时唯一进入 LLM 上下文的部分
 *     （`orchestrator/chatContext.ts#selectHistoryMessages`）—— 缺了它，多轮对话就断了。
 *   · `thinking` / `citations` / `tool_calls` / `artifacts` **可选而非默认 `[]`/`''`**：省掉这个键表示"这一段本来就没有"，
 *     与"它有但是空的"在界面上是两件事（思考折叠区 / 引用区 / 工具区该不该出现）。
 *   · `attachments` 已在 **P1-4** 定型（见 {@link attachmentItemSchema}）：只出现在 USER 消息上，
 *     `files` 表 + 上传端点 + 前端渲染三处都落地。`tool_calls` 已在 **P0-2-8** 定型
 *     （见 {@link toolCallRecordSchema}）、`artifacts` 已在 **P0-3-7** 定型（见 {@link artifactItemSchema}）
 *     —— 定型的判据是"写入端与读取端都已落地"，
 *     不是"字段想清楚了"（P0-1-27 当时留着它，正是因为那时**没有写入端**）。
 *     ⚠️ 本 schema **不是 `passthrough` 也**不是 `.strict()` —— 未声明的键会被 Zod **静默剥掉**
 *     （不报错）。**读取端刻意不用它**（`messageItemSchema.content` 是 `z.unknown()`，原样透出，
 *     见文件头 ⑥）⇒ 将来加段不必回头改这里，也不会有"刷新之后卡片少了一块"的风险。
 *     本 schema 的用途因此收窄为：**写入端**（`chatBot.ts#buildAssistantContent`）的形态约束。
 */
export const messageContentSchema = z.object({
  text: z.string(),
  thinking: z.string().optional(),
  citations: z.array(citationItemSchema).optional(),
  tool_calls: z.array(toolCallRecordSchema).optional(),
  /** 本轮产出文件（P0-3-7；TaskAgent 专属 —— ChatBot 恒省略这个键） */
  artifacts: z.array(artifactItemSchema).optional(),
  /** 本轮用户消息携带的附件（**P1-4 定型**；只出现在 USER 消息上，见 {@link attachmentItemSchema}） */
  attachments: z.array(attachmentItemSchema).optional(),
  /** 本轮实际使用的模型（产品优化 2026-09-29；ChatBot 写入，见 {@link messageModelSegmentSchema}） */
  model: messageModelSegmentSchema.optional(),
})
export type MessageContent = z.infer<typeof messageContentSchema>

// ───────────────────────────── 消息历史（P0-1-28）─────────────────────────────

/**
 * 消息角色（`schema.prisma` 的 `enum MessageRole`，取值**逐字一致**）。
 *
 * 用 DB 的原值（大写）而不是 LLM 入参口径的小写：这是**存储层的取值域**，
 * 与 `CONVERSATION_STATUSES` / `DOCUMENT_STATUSES` / `COMPONENT_TYPES` 同一写法。
 * 小写映射发生在"组装上游请求"那一处（`orchestrator/chatContext.ts#selectHistoryMessages`），
 * 别把它漏到这里来 —— 两处各有一份小写映射，就会出现"历史渲染出的角色"与
 * "接口返回的角色"对不上的那种**没有编译期错误**的偏差。
 */
export const MESSAGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

/** 一页最多几条（与其余列表的上限一致；`02` §四 只定了 messages 用游标，没定上下限） */
export const MESSAGE_PAGE_LIMIT_MAX = 100
/** 不传 `limit` 时的默认条数（与其余列表的"默认 20"对齐） */
export const MESSAGE_PAGE_LIMIT_DEFAULT = 20

/**
 * `GET /api/conversations/:id/messages` 的查询参数（`02` §四：messages 用**游标**分页）。
 *
 * `beforeId` **不传 = 取最新一页**（对话页首次进入的形态）；传了就取"比它更早"的一页。
 * ⚠️ 它是 **id 而不是时间戳**：`created_at` 是毫秒精度，而同一轮问答的用户消息与助手消息
 * **在同一个事务里写入** ⇒ `created_at` 完全可能相同（`now()` 取的是事务开始时刻），
 * 用时间戳当游标会漏掉同毫秒的另一条。故游标必须是一个**具体行的 id**，
 * 服务端再拿它的 `(created_at, id)` 去做字典序比较（见 `backend` 的 `listMessages`）。
 *
 * `limit` **不设默认之外的"全量"取值**：上限 100 是为了让"一次拉太多导致首屏卡住"
 * 这件事有一个确定的上界（前端要全量就自己翻页）。
 */
export const listMessagesQuerySchema = z.object({
  beforeId: z.string().uuid('beforeId 不是合法 UUID').optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'limit 至少为 1')
    .max(MESSAGE_PAGE_LIMIT_MAX, `limit 最多 ${MESSAGE_PAGE_LIMIT_MAX}`)
    .default(MESSAGE_PAGE_LIMIT_DEFAULT),
})
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>

/**
 * 一条历史消息（`GET /api/conversations/:id/messages` 的最小投影）。
 *
 * **`content` 原样透出**（`z.unknown()`）—— 这是本端点最重要的一条契约，理由见文件头 ⑥：
 * `03` §五 要求"历史还原与事件流同一套渲染组件"（单一渲染路径），而事件流里的
 * `tool_call` / `citations` / `attachments` 最终都要落到 `content` 的各个段上。
 * 服务端一旦"按已知的三段过滤一遍"，那些段就在**刷新之后**消失（流里看得见、历史里没有），
 * 且没有任何报错 —— 前端只能靠肉眼发现。
 *
 * **刻意不带的列**：`conversationId`（同一个请求里的消息必然属于同一个会话，带上只是冗余）、
 * `tokensIn`/`tokensOut`（用量统计属 **P1**，届时会有专门的端点；这里多带两列等于
 * "悄悄扩大契约"，而 P0-1-22 起每个投影都有一条**键集合**断言在守这件事）。
 */
export const messageItemSchema = z.object({
  id: z.string(),
  role: z.enum(MESSAGE_ROLES),
  /**
   * jsonb 原文（`{ text, thinking?, citations?, …未知段 }`），服务端**不解释**，见文件头 ⑥。
   *
   * ⚠️ 用 `z.custom` 而不是 `z.unknown()`：`z.unknown()` **连 `undefined` 都接受**，而 `undefined`
   * 会被 `JSON.stringify` 直接丢掉整个键 ⇒ 客户端拿到的是"这个字段不存在"。
   * 列是 `NOT NULL`、服务端也恒有值，所以这一条在正常路径上永远不会触发；
   * 它守的是"某天有人改成条件 select（如只在有引用时带 content）"这种**静默变窄**。
   * （顺带：`z.unknown().refine(...)` 会把推断出的类型收成 `{} | null`，那就不叫"原样透出"了。）
   */
  content: z.custom<unknown>((value) => value !== undefined, {
    message: 'content 必须存在（jsonb 列是 NOT NULL；`undefined` 会在序列化时丢掉这一列）',
  }),
  /** ISO 8601 */
  createdAt: z.string(),
})
export type MessageItem = z.infer<typeof messageItemSchema>

/**
 * 消息分页响应 = `{ items, nextCursor, hasMore }`（`shared/src/envelope.ts#cursorPageOf`）。
 *
 * ⚠️ **`items` 是时间正序（旧 → 新）**，而 `nextCursor` 指向的是**更早**的那一页
 * （= 本页**第一条**的 id）。这两句话必须一起看，否则会得到"翻页翻反了"的实现：
 *
 *   · 正序的理由是 `03` §五 的渲染语义 —— 对话流是"新消息追加在末尾"，历史与流式必须落在
 *     **同一个数据结构**上（单一渲染路径）；服务端把它摆正，前端就不必在两处各写一次
 *     `reverse`（那种"一处正、一处反"的 bug 只在"翻第二页"时才显形）。
 *   · `nextCursor` 指向更早那一页，因为对话页的翻页永远是**向历史深处走**（没有"更新的一页"
 *     这个概念 —— 新的内容走 SSE 事件流，不走分页）。
 *
 * `nextCursor === null` ⟺ `hasMore === false`（已到最早一条）。两者**刻意都给**：
 * `hasMore` 是"要不要继续加载"的直接判据（前端只需它），`nextCursor` 是"用什么去加载"
 * —— 少给一个，客户端就得自己从 `items` 里推（而 `items` 为空时推不出来）。
 */
export const messagePageResultSchema = cursorPageOf(messageItemSchema)
export type MessagePageResult = z.infer<typeof messagePageResultSchema>
