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
import { validationMessage } from './i18n/validation.js'

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
 * 会话的 **Code 模式运行时**（P1-17a；`子方案/Code模式工作区.md` §五之二 2）。
 *
 * ★ **取值 = 后端探测/构建出来的运行时"变体 id"**（如 `node22-python310`），**不是写死的枚举**：
 *   可用运行时由后端**扫本机镜像探测**（有就提供），用户选了本机没有的组合 ⇒ 后端**按需构建**
 *   （2026-10-14 用户定案）。⇒ 契约里 `runtime` 是一个**自由字符串**，编译期不约束取值。
 *   组件目录 / 变体规范化 / 接口 schema 都在 `shared/src/runtime.ts`（单一来源）。
 * ⚠️ 未知 id（本机没有对应镜像）**不报错**：`ensureSandbox` 建容器时回退 `SANDBOX_IMAGE`（toolkit）
 *   并留一条 warn —— 比"选了却起不来"好，而且可观测。
 */
export const SANDBOX_RUNTIME_ID_MAX_LEN = 64

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
  /**
   * Code 模式运行时（P1-17a）—— 后端从本机镜像探测出的**运行时 id**（自由字符串）。
   * 非 Code 会话也会回带它（它是一个普通列）；界面只在 Code 会话里展示选择器。
   */
  runtime: z.string(),
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
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(100, validationMessage('validation.common.limitMax'))
    .default(20),
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
    .string({ required_error: validationMessage('validation.conversation.agentRequired') })
    .uuid(validationMessage('validation.conversation.agentIdNotUuid')),
  /**
   * Code 模式运行时（P1-17a；可选）。不给 = 用 Prisma 默认**空串**（= 空环境）。
   * ⚠️ 只在 Code 会话有意义 —— 运行时镜像只在派活建容器时才选；非 Code 会话从不建容器。
   */
  runtime: z.string().min(1).max(SANDBOX_RUNTIME_ID_MAX_LEN).optional(),
})
export type CreateConversationBody = z.infer<typeof createConversationBodySchema>

// ───────────────────────────── 路径参数与改名 ─────────────────────────────

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const conversationIdParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.conversation.idNotUuid')),
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
      required_error: validationMessage('validation.conversation.topicRequired'),
      invalid_type_error: validationMessage('validation.conversation.topicNotString'),
    })
    .trim()
    .min(1, validationMessage('validation.conversation.topicEmpty'))
    .max(
      CONVERSATION_TOPIC_MAX_CHARS,
      validationMessage('validation.conversation.topicTooLong', { max: CONVERSATION_TOPIC_MAX_CHARS }),
    ),
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

/**
 * `POST /api/conversations/:id/auto-approve` 的请求体 —— **会话级自动审批开关**。
 *
 * 打开后，本会话内危险的 MCP 工具（以及服务端反向 elicitation）**不再逐次弹确认卡**，
 * 由编排层直接按"确认"放行（`orchestrator/sse.ts#awaitConfirm` 读这个开关后短路）。
 *
 * ⚠️ 它是**会话级、运行时**的开关（存 Redis，不落库）：只影响这一个会话、且是安全默认
 * ——键缺失/读取失败一律回到"要确认"，绝不会因为读不到而放行。
 */
export const setConversationAutoApproveBodySchema = z.object({
  enabled: z.boolean({
    required_error: validationMessage('validation.conversation.autoApproveEnabledMissing'),
    invalid_type_error: validationMessage('validation.conversation.enabledNotBoolean'),
  }),
})
export type SetConversationAutoApproveBody = z.infer<typeof setConversationAutoApproveBodySchema>

/**
 * `POST /api/conversations/:id/auto-approve` 的响应。
 *
 * 回带 `autoApprove`（= 落定后的值），调用方据此对齐本地开关状态 —— 与 `/stop` 的
 * `signaled` 同款："把请求原样确认一遍"，而不是让客户端自己猜服务端是否真的写进去了。
 */
export const setConversationAutoApproveResultSchema = z.object({
  id: z.string(),
  autoApprove: z.boolean(),
})
export type SetConversationAutoApproveResult = z.infer<typeof setConversationAutoApproveResultSchema>

/**
 * 打开 / 关闭**会话级 Code 模式**（P1-9 · P3）的请求体。
 * 与自动审批同款（一个布尔），故复用同一形状（`enabled`）。
 */
export const setConversationCodeModeBodySchema = z.object({
  enabled: z.boolean({
    required_error: validationMessage('validation.conversation.codeModeEnabledMissing'),
    invalid_type_error: validationMessage('validation.conversation.enabledNotBoolean'),
  }),
})
export type SetConversationCodeModeBody = z.infer<typeof setConversationCodeModeBodySchema>

/** `POST /api/conversations/:id/code-mode` 的响应（回带落定值） */
export const setConversationCodeModeResultSchema = z.object({
  id: z.string(),
  codeMode: z.boolean(),
})
export type SetConversationCodeModeResult = z.infer<typeof setConversationCodeModeResultSchema>

/**
 * 设置**会话运行时**（P1-17a）的请求体。
 * ⚠️ 与 `code-mode` 同款（改一个会话级设置 + 回带落定值）—— 取值是**后端探测出的运行时 id**
 *    （自由字符串，不是枚举）：前端只提交它从 `GET /api/sandbox/runtimes` 拿到的 id。
 * ⚠️ **空串是合法值**（产品反馈 2026-10-14）：表示**空环境**（只带基础工具链、不额外装语言运行时），
 *    也是"用户不选任何环境"的默认落点 —— 后端 `ensureSandbox` 找不到该 runtime 时回退 `SANDBOX_IMAGE`。
 */
export const setConversationRuntimeBodySchema = z.object({
  runtime: z
    .string({ required_error: validationMessage('validation.conversation.runtimeMissing') })
    .max(
      SANDBOX_RUNTIME_ID_MAX_LEN,
      validationMessage('validation.conversation.runtimeTooLong', { max: SANDBOX_RUNTIME_ID_MAX_LEN }),
    ),
})
export type SetConversationRuntimeBody = z.infer<typeof setConversationRuntimeBodySchema>

/**
 * `POST /api/conversations/:id/instance` 的请求体（P1-14 多机：**用户点名**会话跑在哪台实例上）。
 *
 * `instanceId: null` = 清掉"用户点名"意图之外的说明：**不删已有 owner**（那是运行期事实），
 * 只是把"用户的显式选择"置空（= 交还给自动落点）。真正换机要由原实例回收，见后端实现。
 */
export const setConversationInstanceBodySchema = z.object({
  instanceId: z
    .string({ required_error: validationMessage('validation.conversation.instanceIdMissing') })
    .trim()
    .min(1, validationMessage('validation.conversation.instanceIdEmpty'))
    .max(64, validationMessage('validation.conversation.instanceIdTooLong'))
    .nullable(),
  /**
   * 自动落点时**必须满足的运行时**（P1-14 × P1-17a）：后端据此挑一台"有该环境、否则能构建该环境"
   * 的实例，并让 owner 指向它；`''`（空环境）恒满足。省略 = 只看在线 + 当前负载（不做能力过滤）。
   *
   * ⚠️ 只对 `instanceId: null`（自动）有意义：点名实例时用户已经指定了机器，不再替它挑。
   */
  runtime: z.string().max(120).optional(),
})
export type SetConversationInstanceBody = z.infer<typeof setConversationInstanceBodySchema>

/** `POST /api/conversations/:id/instance` 的响应（回带落定值 = 目录里此刻的 owner） */
export const setConversationInstanceResultSchema = z.object({
  id: z.string(),
  /** 目录里此刻的 owner（`null` = 还没有 owner，下一次派活时按 P2C 落点） */
  instanceId: z.string().nullable(),
  /**
   * `pinned` = 本次由用户点名写入 / `already` = 本来就在这台 /
   * `auto` = 交还自动且**原实例仍满足**（未改动目录）/ `auto-reselected` = 自动重选了落点（原实例不满足）
   */
  action: z.enum(['pinned', 'already', 'auto', 'auto-reselected']),
  /** `auto-reselected` 时给出的原因（给用户看的） */
  hint: z.string().nullable().optional(),
})
export type SetConversationInstanceResult = z.infer<typeof setConversationInstanceResultSchema>

/** `POST /api/conversations/:id/runtime` 的响应（回带落定值） */
export const setConversationRuntimeResultSchema = z.object({
  id: z.string(),
  runtime: z.string(),
})
export type SetConversationRuntimeResult = z.infer<typeof setConversationRuntimeResultSchema>

/**
 * `GET /api/conversations/:id/instance` 的响应 —— 会话**此刻**落在哪台实例（P1-14 · 落点对齐）。
 *
 * ⚠️ 这是**唯一**能回答"这条会话实际在哪"的地方：前端此前只知道"我点过谁"
 *    （`ChatPage#preferredInstanceId`），新会话的首轮落点由网关选的，界面上看不见
 *    ⇒ 出现"选的是 a、实际跑在 jiaxie"却无人能发现的错位。
 */
export const getConversationInstanceResultSchema = z.object({
  id: z.string(),
  /** 目录（`sandbox:owner:*`）里的 owner；`null` = 还没钉机（下一轮派活时由网关选） */
  instanceId: z.string().nullable(),
  /**
   * 该实例此刻在注册表里的自检结论：
   * `false` = 明确未就绪；`null` = 未上报（老版本 / 非 taskAgent 档位）或该实例离线。
   */
  ready: z.boolean().nullable(),
})
export type GetConversationInstanceResult = z.infer<typeof getConversationInstanceResultSchema>

// ───────────────────────────── 活跃流状态（`/:id/active`） ─────────────────────────────

/**
 * 一轮的发起方（见 {@link conversationActiveSnapshotSchema.startedBy}）。
 *
 *   · `UI`        —— 平台界面（`POST /api/conversations/:id/{chat,regenerate}`）；
 *   · `OPEN_API`  —— 开放层（`POST /open/v1/conversations/:id/{chat,regenerate}`，第三方调用者）；
 *   · `SCHEDULED` —— 定时任务的后台运行（`orchestrator/scheduledRun.ts`，无 HTTP 客户端）。
 *
 * `null` = 旧快照 / 值坏（读侧降级，前端按"来源不明"处理）—— **不要**回落到 `UI`：
 * 那会把"不知道"说成"你在这个窗口里发起的"，正是本条修的那个 bug 的另一种形态。
 */
export const CONVERSATION_RUN_ORIGINS = ['UI', 'OPEN_API', 'SCHEDULED'] as const
export type ConversationRunOrigin = (typeof CONVERSATION_RUN_ORIGINS)[number]

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
  /**
   * 这一轮**是谁发起的**（`chat.active:{id}` 锁值里的一格，2026-10-22 契约增量）。
   *
   * 为什么需要它：帧总线（`orchestrator/frameBus.ts`）把**所有**来路的帧广播给所有订阅者 ——
   * 交互式 `/chat`、开放层 `/open/v1/**`、以及定时任务的后台运行都是同一种帧、不带来源。
   * 于是一个"不是本页发起"的页面只能猜：`useConversationWatch` 曾把占位文案写死成
   * "（定时任务正在运行…）"，结果**外部 Open API 调用的会话在聊天页里也显示成定时任务执行中**。
   * 来源必须由**发起方**记在锁里，读侧（`/active` 与观察流）才能如实说"是谁在跑"。
   *
   * ⚠️ 取值只为"说清是谁"服务，不参与任何权限/计费判据（那些各有自己的来源字段）。
   */
  startedBy: z.enum(CONVERSATION_RUN_ORIGINS).nullable(),
})

export type ConversationActiveSnapshot = z.infer<typeof conversationActiveSnapshotSchema>

/**
 * `GET /api/conversations/:id/active` 的响应：快照 + **派生**的 `streaming` + `autoApprove`。
 * 无流时（Redis 里没有那个键）恒为 `{streaming: false, queuedPosition: null, currentTool: null, startedAt: null}`
 * —— 这正是 `06` P0-1-25 的验收原文。
 *
 * ⚠️ `autoApprove`（会话级自动审批开关）**不是**活跃流快照的一部分（它存在另一个键
 * `chat.autoapprove:{id}`、与"有没有流在跑"无关），由 {@link getConversationActive} 一起读出来
 * —— 于是对话页只需这一个只读端点就能同时拿到进度与开关当前值。
 */
export const conversationActiveSchema = conversationActiveSnapshotSchema.extend({
  streaming: z.boolean(),
  autoApprove: z.boolean(),
  /**
   * 会话级「不记入记忆」开关（**P1-8 契约增量**）：与 `autoApprove` 同款 —— 对话页只需这一个
   * 只读端点，就能同时拿到活跃进度、自动审批开关、以及本会话的记忆豁免状态（会话头 `⋯` 菜单要用）。
   */
  memoryExcluded: z.boolean(),
  /**
   * 会话级 **Code 模式** 开关（**P1-9 契约增量**）：true = 工作区走人机共享可编辑形态
   * （派活时给容器注入 `DOUBULEA_WORKSPACE_MEDIATION=1`）。与 `memoryExcluded` 同款 ——
   * 由同一个 `/active` 端点回带，前端据此决定是否显示工作区面板。
   */
  codeMode: z.boolean(),
  /**
   * 会话**运行时**（**P1-17a 契约增量**）：与 `codeMode` 同款 —— 由同一个 `/active` 端点回带，
   * 前端据此在 Code 会话里回显/切换运行时（不必额外读一次会话详情）。
   * 值是后端探测/构建出的运行时**变体 id**（自由字符串，见 `shared/src/runtime.ts`）。
   */
  runtime: z.string(),
})
export type ConversationActive = z.infer<typeof conversationActiveSchema>

/** 无流时的快照（五个字段全是 `null`） */
export const EMPTY_ACTIVE_SNAPSHOT: ConversationActiveSnapshot = Object.freeze({
  queuedPosition: null,
  currentTool: null,
  startedAt: null,
  pendingConfirmId: null,
  startedBy: null,
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
  const { queuedPosition, currentTool, startedAt, pendingConfirmId, startedBy } = record
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
    // 发起方（2026-10-22）：只认取值域内的字符串；旧快照 / 值坏一律 `null`（= 来源不明）。
    // ⚠️ **不许**回落成 `'UI'` —— 读侧要靠"不知道"与"本页发起"区分开（见字段注释）。
    startedBy:
      typeof startedBy === 'string' &&
      (CONVERSATION_RUN_ORIGINS as readonly string[]).includes(startedBy)
        ? (startedBy as ConversationRunOrigin)
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
  /**
   * 工具卡在助手正文中的位置（正文 UTF-16 字符偏移）。
   * 省略时兼容旧消息，前端按历史口径将其放在正文前。
   */
  textOffset: z.number().int().min(0).optional(),
  /**
   * 本轮**内联时间线**上的出现序号（2026-10-21；与 `thinkingSegmentSchema.seq` **共用同一序列**）。
   *
   * 与 {@link textOffset} 的分工：偏移决定"插在哪段正文之间"，序号决定"**同一偏移**时谁先谁后"。
   * 典型场景 = 思考 A 之后紧接着一次工具调用（此时正文还没动，两者偏移相同）——
   * 没有 `seq` 就只能按数组顺序碰运气（用户报的就是"思考 B 跑到工具卡前面"）。
   * 省略 = 旧消息（前端回落到"偏移相同则工具卡在前"的历史口径）。
   */
  seq: z.number().int().min(0).optional(),
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
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(ARTIFACT_PAGE_LIMIT_MAX, validationMessage('validation.conversation.artifactLimitMax', { max: ARTIFACT_PAGE_LIMIT_MAX }))
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
  /**
   * 预计被清理的时刻（ISO 8601）。2026-10-28 引入；**2026-10-29 起可为 `null`**。
   *
   * ★ 用户原话：「会话产物我们能加一个剩余多少天的提示吗？」—— 产物是**会过期的**，
   *   而界面此前只说"什么时候产出的"，不说"什么时候会没"。这里把到期的绝对时刻交给前端，
   *   剩余天数由前端按本地时钟算（与工作区保留期提示同一口径，见 `retentionDaysLeft`）。
   *
   * 建行时 = `createdAt + ARTIFACT_RETENTION_DAYS`（默认 7 天）；用户可「延期几天 / 延期到某日 /
   * 永久保存」（见 {@link artifactExtendBodySchema}）。
   * **`null` = 永久保存**（清理器不扫它）。
   *
   * 由服务端给：保留期是 env（`ARTIFACT_RETENTION_DAYS`），前端不得猜一个数。
   */
  expiresAt: z.string().nullable(),
})
export type ArtifactListItem = z.infer<typeof artifactListItemSchema>

/** 产物列表响应 = `{ items, total, offset, limit }`（`shared/src/envelope.ts#offsetPageOf`） */
export const artifactListResultSchema = offsetPageOf(artifactListItemSchema)
export type ArtifactListResult = z.infer<typeof artifactListResultSchema>

/**
 * 产物延期（`POST /api/artifacts/:id/extend`，2026-10-29）。
 *
 * 三种口径（用户定案「延期几天 / 延期到某日 / 永久保存」）：
 *   · `DAYS`：在**当前到期时刻与现在中较晚的那个**上再加 N 天（1 ~ 365）；
 *   · `UNTIL`：延到某个**绝对时刻**（ISO 8601，带时区）。前端把用户选的日期按**本地时区**
 *     折算成当天 23:59:59.999 再 `toISOString()` —— 服务端不猜时区（"延到 12 月 1 日"的
 *     意思是"12 月 1 日这一整天都还在"）。
 *   · `FOREVER`：永久保存（`expires_at = NULL`，清理器不再碰它）。
 *
 * ⚠️ 延期**只能往后推**：目标早于当前到期时刻、或对已永久保存的产物延期 ⇒ 422（理由由服务层给）。
 */
export const ARTIFACT_EXTEND_MODES = ['DAYS', 'UNTIL', 'FOREVER'] as const
export type ArtifactExtendMode = (typeof ARTIFACT_EXTEND_MODES)[number]

export const artifactExtendBodySchema = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('DAYS'),
      days: z
        .number({
          required_error: validationMessage('validation.artifact.extendDaysRequired'),
          invalid_type_error: validationMessage('validation.artifact.extendDaysInvalid'),
        })
        .int(validationMessage('validation.artifact.extendDaysInvalid'))
        .min(1, validationMessage('validation.artifact.extendDaysRange'))
        .max(365, validationMessage('validation.artifact.extendDaysRange')),
    }),
    z.object({
      mode: z.literal('UNTIL'),
      until: z
        .string({ required_error: validationMessage('validation.artifact.extendUntilRequired') })
        .datetime({ offset: true, message: validationMessage('validation.artifact.extendUntilInvalid') }),
    }),
    z.object({ mode: z.literal('FOREVER') }),
  ])
export type ArtifactExtendBody = z.infer<typeof artifactExtendBodySchema>

/** 延期结果 = 更新后的那一条（前端据此就地刷新到期读数） */
export const artifactExtendResultSchema = artifactListItemSchema
export type ArtifactExtendResult = z.infer<typeof artifactExtendResultSchema>

/** 路径参数（`/api/artifacts/:id/...` 的 `:id` = `artifacts` 行主键，`uuid(7)`） */
export const artifactIdParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.conversation.artifactIdNotUuid')),
})
export type ArtifactIdParams = z.infer<typeof artifactIdParamsSchema>

// ───────────────────── 产物批量删除（会话产物页）─────────────────────

/**
 * 一次批量删除最多几个产物。
 *
 * ⚠️ **刻意与 `ARTIFACT_PAGE_LIMIT_MAX` 相等**：批量删除的选择面就是「会话产物」页的
 * **当前页**（前端只在当页勾选），一页最多 `ARTIFACT_PAGE_LIMIT_MAX` 条 ⇒ 上限取它即可。
 * 不给一个更大的额度，是因为那会引出"跨页选中后翻页，选择还在不在"这个凭空的问题。
 * 服务端仍**独立校验**：客户端能把 `limit` 调小，但**不能**靠请求体绕过这个上限。
 */
export const ARTIFACT_BATCH_DELETE_MAX = ARTIFACT_PAGE_LIMIT_MAX

/**
 * `POST /api/artifacts/batch-delete` 的请求体（**会话产物页的批量删除**）。
 *
 * ⚠️ **用 POST 而不是 `DELETE /api/artifacts`（带 body）**：带 body 的 `DELETE` 会被一部分
 * 代理 / 客户端丢掉 body（RFC 未禁止，但实践里不可靠），而本端点的**全部信息都在 body 里**
 * ⇒ 丢掉 body 就是一次"删了 0 个却报成功"的静默失败。用 POST + 明确的 `/batch-delete`
 * 动作段，与 `/api/conversations/:id/recall` 那类"动作端点"同款。
 *
 * 归属判据仍在服务层（`userId = me`）：**ids 里混进别人的产物只会被忽略**（不是 404）——
 * 批量操作里"一个 id 越权就整批失败"会让一次正常的删除被一条脏数据卡死；服务层按
 * `id ∈ ids AND user_id = me` 过滤，真正删掉的条数由响应里的 `deleted` 如实回报。
 */
export const batchDeleteArtifactsBodySchema = z.object({
  ids: z
    .array(z.string().uuid(validationMessage('validation.conversation.artifactIdNotUuid')))
    .min(1, validationMessage('validation.conversation.artifactsRequired'))
    .max(
      ARTIFACT_BATCH_DELETE_MAX,
      validationMessage('validation.conversation.artifactBatchMax', { max: ARTIFACT_BATCH_DELETE_MAX }),
    ),
})
export type BatchDeleteArtifactsBody = z.infer<typeof batchDeleteArtifactsBodySchema>

/**
 * 批量删除的结果（**真删除**：S3 对象与 `artifacts` 行一并移除，见服务层）。
 *
 * `deleted` = **实际删掉的行数**（不是请求里的 id 个数）：ids 里混进"不是我的"或
 * "已经不存在"的会被如实扣掉 —— 界面据此说"已删除 N 个"，而不是照着勾选数报一个假数。
 */
export const batchDeleteArtifactsResultSchema = z.object({
  deleted: z.number().int().min(0),
})
export type BatchDeleteArtifactsResult = z.infer<typeof batchDeleteArtifactsResultSchema>

// ───────────────────── 产物预览（P0-3-10）─────────────────────

/**
 * 预览的**七种形态**（`子方案④` §四 2 / §五）。
 *
 * `none` 不是一个错误态，而是"这个格式没有在线预览"这个**事实**（zip / 未知类型）⇒
 * 界面上表现为**没有「预览」按钮**、只给下载，而不是"按钮置灰"（`03` §4.5 同款口径：
 * 能力有无是事实，不是"暂不可用"）。
 *
 * ⚠️ `docx` / `xlsx` 自 **P1-16** 起是独立形态：它们**不是** `html` —— 原始字节是二进制 OOXML，
 * 不能当 `html` 直出（`/content` 对它们仍按"字节代理"上 `octet-stream` + `attachment`）。
 * 前端对它们走**渲染出口** `GET /api/artifacts/:id/render`（服务端转成净化 HTML：
 * docx → mammoth、xlsx → 手写零依赖读取器），渲染结果才带 HTML 那套 `text/html` + CSP `sandbox` 头
 * （见 `routes/artifacts.ts`）。
 */
export const PREVIEW_KINDS = ['html', 'image', 'pdf', 'docx', 'xlsx', 'text', 'none'] as const
export type PreviewKind = (typeof PREVIEW_KINDS)[number]

/**
 * DOCX（Word OOXML）的 mime —— **本仓内唯一字面量**（`ARTIFACT_MIME_BY_EXTENSION` 与
 * `previewKindOf` 都引用它，避免两处各写一个长串而分叉）。
 */
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * XLSX（Excel OOXML）的 mime —— 同上，唯一字面量。
 */
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

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
 *   ③ **文本/代码：任何 `text/*` 都算 `text`**（`text/html` 除外，它归 `html`）—— 与工作区
 *      `isWorkspaceTextMime` **同款口径**（`text/x-java` / `text/x-go` / `text/css` / `text/x-sql` /
 *      `text/x-markdown`… 自动命中），另把"其实是文本但不是 `text/*`"的 `application/json` /
 *      `application/xml` / `application/x-yaml` 显式列出。⇒ 产物只要**扩展名在后端 mime 表里**、
 *      且定出来是 `text/*`，就能源码预览（后端一律回 `text/plain; charset=utf-8`，不会被当 HTML 渲染）。
 *      ⚠️ **仍然不看扩展名**：判据只有 `mime`；能到本函数的 mime 是后端扫描时按扩展名定的那一个。
 *      **要扩覆盖面只改后端那张扩展名表**（`artifactMimeOf`），本函数已对新 `text/*` 自动生效。
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
  // DOCX：二进制 OOXML，走**渲染出口**（服务端 mammoth → HTML），不是 `html` 的"直出字节"
  if (base === DOCX_MIME) return 'docx'
  // XLSX：同样是二进制 OOXML，走**渲染出口**（服务端手写零依赖读取器 → HTML 表格）
  if (base === XLSX_MIME) return 'xlsx'
  // 文本 / 代码：**任何 `text/*`**（`text/html` 已在上面归 `html`）都按源码预览 —— 与工作区
  // `isWorkspaceTextMime` 同款口径（`text/x-java`、`text/x-go`、`text/css`、`text/x-sql`… 自动命中）；
  // 再把几个"其实是文本但不是 `text/*`"的显式列出。后端一律回 `text/plain; charset=utf-8`（安全）。
  if (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'application/x-yaml'
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
  id: z.string().uuid(validationMessage('validation.conversation.fileIdNotUuid')),
})
export type FileIdParams = z.infer<typeof fileIdParamsSchema>

/**
 * 一条**本轮中途插话**（`steer`）的落库形态（2026-10-21）。
 *
 * 落点 = **助手消息**的 `content.steers[]`（插话语义上属于"这一轮"，而一轮的落库行就是那条助手消息；
 * 用户消息行只有一条、且早于插话发生）。渲染时它排在助手气泡**之后**（与流式侧
 * `roundToViews` 的顺序一致 —— 同一轮"我说了什么、它答了什么、我中途补了什么"可读）。
 *
 * · `id` = 服务端入队时生成的稳定标识（与 `steer` 事件帧、取消端点同源）；
 * · `message` = 插话正文原文；`at` = 入队时刻（ISO 8601）；
 * · `textOffset`（2026-10-29 可空）= **投递时**助手正文已经写到第几个字符 —— 渲染时插话气泡
 *   插在这里，「agent 在插话之后回复的内容」自然排在它下面（见前端 `interjectionViews`）。
 *   省键 = 投递时正文还没开始（或旧数据）⇒ 气泡排在助手消息之后。
 *
 * ⚠️ 只落**真的投递过**的插话（被撤回且未投递的不在此列）；"是否已被模型读走"不落库
 * （历史视图不显示投递状态 —— 那一轮已经结束，状态没有意义）。
 */
export const steerRecordSchema = z.object({
  id: z.string().min(1),
  message: z.string(),
  at: z.string(),
  textOffset: z.number().int().nonnegative().optional(),
})
export type SteerRecord = z.infer<typeof steerRecordSchema>

/**
 * 一条消息的 `content`（jsonb）—— **写入与读取的唯一形态**（`02` §三：`content(jsonb)`）。
 *
 * 设计口径（三条，都是"改了就会让历史读不出来"的）：
 *   · **`text` 必填**（可以是空串）：它是历史重建时唯一进入 LLM 上下文的部分
 *     （`orchestrator/chatContext.ts#selectHistoryMessages`）—— 缺了它，多轮对话就断了。
 *   · `thinking_segments` / `citations` / `tool_calls` / `artifacts` **可选而非默认 `[]`/`''`**：省掉这个键表示"这一段本来就没有"，
 *     与"它有但是空的"在界面上是两件事（思考折叠区 / 引用区 / 工具区该不该出现）。
 *     （`thinking` 是它的**遗留单段形态**，只读兼容，见字段注释。）
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
/**
 * 一段思考在**内联时间线**上的位置（2026-10-21）。
 *
 * 一轮里模型可能请求多次，正文、思考段、工具卡在同一轮里交替出现；三者要按发生顺序插进
 * 同一条流里，靠的就是这一对 `(textOffset, seq)`：
 *   · `textOffset` = 这一段开始时**正文写到第几个字符**（与 `toolCallRecordSchema.textOffset` 同口径）；
 *   · `seq` = 本轮内联条目的**出现序号**（思考段与工具卡**共用一个递增序列**）——
 *     同偏移时的先后只靠它（典型：思考 A 与紧随其后的工具卡偏移相同，A 必须先出）。
 *
 * 落库后刷新仍按同一顺序渲染（读取端 `messageModel` 把两族条目合成一条时间线）。
 */
export const thinkingSegmentSchema = z.object({
  text: z.string(),
  // ⚠️ 可省：旧消息 / 手工构造的数据可能没有位置信息 ⇒ 渲染端按 `(0, 0)` 兜底
  textOffset: z.number().int().nonnegative().optional(),
  seq: z.number().int().nonnegative().optional(),
})
export type ThinkingSegment = z.infer<typeof thinkingSegmentSchema>

export const messageContentSchema = z.object({
  text: z.string(),
  /**
   * ⚠️ **遗留字段（只读兼容）**：P0-1-29 起的"一整段思考"。2026-10-21 起新写入只写
   * {@link thinking_segments}（一轮多段）—— 读取端（`messageModel`）两条路都认：
   * 数组走分段、字符串当"单段"。**不要**再往这里写新数据。
   */
  thinking: z.string().optional(),
  /**
   * 本轮思考的**分段**（2026-10-21 定型；每段一次模型请求里的推理，顺序 = 发生顺序）。
   * 省键 = 本轮没有思考。为什么是数组：一轮里模型可能请求多次（工具调用后重新推理），
   * 每一段在界面上是**各自独立的折叠块**，且**与工具卡同一条内联时间线**（见
   * {@link thinkingSegmentSchema} —— 用户要求"思考 B 应排在工具卡之后"）。
   */
  thinking_segments: z.array(thinkingSegmentSchema).optional(),
  citations: z.array(citationItemSchema).optional(),
  tool_calls: z.array(toolCallRecordSchema).optional(),
  /** 本轮产出文件（P0-3-7；TaskAgent 专属 —— ChatBot 恒省略这个键） */
  artifacts: z.array(artifactItemSchema).optional(),
  /** 本轮用户消息携带的附件（**P1-4 定型**；只出现在 USER 消息上，见 {@link attachmentItemSchema}） */
  attachments: z.array(attachmentItemSchema).optional(),
  /**
   * 本轮**中途插话**（2026-10-21 定型；只出现在 ASSISTANT 消息上，见 {@link steerRecordSchema}）。
   * 省键 = 本轮没有插话。
   */
  steers: z.array(steerRecordSchema).optional(),
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
  beforeId: z.string().uuid(validationMessage('validation.conversation.beforeIdNotUuid')).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(MESSAGE_PAGE_LIMIT_MAX, validationMessage('validation.conversation.messageLimitMax', { max: MESSAGE_PAGE_LIMIT_MAX }))
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
 * **刻意不带的列**：`conversationId`（同一个请求里的消息必然属于同一个会话，带上只是冗余）。
 *
 * ⚠️ **P1-7 契约增量：补上 `tokensIn` / `tokensOut`**（P0-1-28 当时写着"用量统计属 P1"）。
 * 目的：让"每一轮用了多少 token"在**刷新之后**仍然看得见（流式那一份来自 `done.usage`，
 * 落库那份在 `messages.tokens_in/out` 列上，一直写着、只是读取端没透出）。两列可空：
 * 上游在流式阶段不报 usage 时就是 `null`（"不知道"），界面据此显示 `—` 而不是 `0`。
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
    message: validationMessage('validation.conversation.contentRequired'),
  }),
  /** ISO 8601 */
  createdAt: z.string(),
  /** 本轮**助手消息**的上报输入 token；`null` = 没上报（不是 0）。用户消息恒 `null`（P1-7） */
  tokensIn: z.number().int().min(0).nullable(),
  /** 本轮**助手消息**的上报输出 token；`null` = 没上报（不是 0）。用户消息恒 `null`（P1-7） */
  tokensOut: z.number().int().min(0).nullable(),
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
