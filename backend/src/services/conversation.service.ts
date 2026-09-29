/**
 * 会话服务（P0-1-25）
 *
 * 依据：`docs/02-后端设计.md` §4.5（`/api/conversations` 与 `/api/agents/:id/conversations`）
 *      + §三（`conversations` / `messages` 表与索引）+ §5.1/§5.2（活跃流锁与断线重连）
 *      + `01` §3.3 功能表第 9 条（新建/列表/删除/重命名，按最近活跃排序）
 *      + `03` §4.1（会话侧栏与输入区状态机）/ §七（**会话删除是级联删除**）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的六条口径
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① 会话是私有资源：只有创建者本人能看/改/删。判据就是"这一行是不是你的"。**
 *    三族资源的口径**刻意各不相同**（判据 = `02` §三 有没有 owner 列，见 `shared/src/agent.ts`
 *    文件头 ① 那张表）：模型池 = ADMIN、知识库 = 登录即可、智能体 = 创建者 + ADMIN 行级，
 *    而**会话 = 仅本人**。`01`/`02`/`03` 都没有一处说管理员要能看别人的聊天记录 ——
 *    给 ADMIN 开一个口子就是**自己发明权限**，而且方向是"读别人的私密对话"。
 *
 *    实现上刻意**不看角色**：本文件所有查询一律带 `userId: viewer.id`，{@link ConversationViewer}
 *    更是**只有 `id` 一个字段**（连 `role` 都不给）—— 于是"顺手写一个 role 分支"这件事
 *    在类型层面就写不出来。对别人的会话一律 **404**（不是 403）：会话 id 不出现在任何对他人
 *    可见的列表里，藏得住；而 403 等于**确认这个 id 有效**。
 *
 * **② `last_message_at` 的维护点是"消息落库时"，不是"发起请求时"。**
 *    `06` P0-1-25 的坑预判原文说的就是这个。差别在用户看得到的地方：在"发起请求"时更新，
 *    那么一个**点了停止**（或上游报错、或断线）的会话仍然会被算成"刚刚活跃"、被顶到侧栏最前，
 *    而它其实一条新消息都没有。故唯一写入口是 {@link touchConversation}（P0-1-27 在**落库那个
 *    事务里**调它），本文件不提供任何"手工改活跃时间"的端点。
 *
 * **③ 排序 `last_message_at desc` 且**新会话（`null`）必须排最前**。**
 *    该列可空（见 `schema.prisma`），PG 的 `DESC` 默认就是 `NULLS FIRST`，但**显式写出来**
 *    （`{ sort: 'desc', nulls: 'first' }`）：靠默认值等于把顺序语义寄存在数据库的实现细节上，
 *    而这一条错了的症状是"新建了会话却在侧栏看不见它"（用户的第一反应是"新建没成功"）。
 *    `null` 之间再按 `createdAt desc`、`id desc` 兜底 —— 确定性是分页的刚需（P0-1-20 的教训）。
 *
 * **④ 删会话是"级联删除"，响应要带真的删了多少条消息。**
 *    `02` §三 的 `messages → conversations` 是 `ON DELETE CASCADE` ⇒ 一条 `delete` 就够；
 *    但 `03` §七 要求会话删除走「Modal + 红色危险按钮 + **明示影响范围**」步，
 *    所以必须把消息数**在同一个事务里数出来**再删（跨语句数会出现"数了 5 条、实际删了 6 条"，
 *    与 P0-1-19 的 `deletedChunks` 同款；用事务是为了消掉这个 TOCTOU）。
 *
 * **⑤ 「只读」= 不能再产生消息；改名与删除**刻意不按 status 拦**。**
 *    {@link isConversationReadOnly} 的消费方是 P0-1-26 的 `POST /:id/chat` 闸门（见
 *    {@link assertConversationSendable}）与 P0-1-34 的输入区禁用。**改名与删除不查 `status`**：
 *    用户需要能清理自己的历史，而"改个标题"跟"产生消息"是两回事 —— 顺手加一条
 *    `status === 'ACTIVE'` 才放行，就把"删除一个已结束会话"变成做不到的事
 *    （P0-1-11 的教训：自己发明约束会把合法操作挡在门外）。
 *
 * **⑥ 没有"会话级的 S3 对象"（P0-1 阶段的诚实边界）。**
 *    `06` P0-1-25 的内容里写了"删除（异步清理 S3）"。但这一阶段**确实没有**属于会话的对象：
 *    产物在 `artifacts` 表（P0-3 的 TaskAgent 才用）、附件在 `files` 表（P1），
 *    两者**都还不存在**。故 {@link collectConversationObjectKeys} 现在返回空数组，
 *    {@link removeConversationObjects} 拿到空数组时**连桶都不探**（与 `kb.service.ts` 的
 *    "没有文档就不碰 S3"同款 —— 验收脚本因此不需要 MinIO 也能跑）。
 *    接回方式写在那两个函数上：P0-3 建了 `artifacts` 之后，只需在**收集**那一处加一句查询，
 *    删除路径本身不用改。⚠️ 现在写一段"先假定键在哪里"的代码，只会在 P0-3 变成需要重写的猜测。
 *
 * **⑦ 消息历史（P0-1-28）的游标是"行 id"，不是时间戳；且排序必须与上下文窗口同源。**
 *    `messages.created_at` 是毫秒精度，而**同一轮问答的两条消息在同一个事务里写入**
 *    （`chatBot.ts#persistRoundQuietly`：用户消息 + 助手消息 + `touchConversation` 一个事务）
 *    —— PG 的 `now()` 取的是**事务开始时刻** ⇒ 这两条的 `created_at` **必然相同**。
 *    用时间戳当游标就会漏掉同毫秒的另一条（"翻页漏一条"只在长会话里偶发，最难查）。
 *    故游标是**一个具体行的 id**，服务端拿它的 `(created_at, id)` 做**字典序**比较
 *    （`(a,b) < (c,d)` ⟺ `a < c` 或 `a = c 且 b < d`），这正是
 *    {@link MESSAGE_CHRONO_ORDER} 那个总序下的"更早"。
 *    ⚠️ 两个消费方（本文件的 {@link listMessages} 与 P0-1-27 的"最近 N 轮"）**共用同一个排序常量**
 *    ⇒ "模型看到的最近几轮"与"用户在界面上看到的最近几条"不可能对不上。
 *
 * ⚠️ 各批**刻意不做**的（属后续批次，不要顺手补）：
 *   · `/api/conversations/:id/artifacts` → **P0-3**（`artifacts` 表）。
 * ⚠️ P0-1-26 起**已落地**（不再是"刻意不做"）：`POST /:id/chat`（SSE，闸门见
 *   {@link assertConversationSendable}）与 `POST /:id/stop`（停止信号）。
 * ⚠️ P0-1-28 起**已落地**：`GET /:id/messages`（{@link listMessages}，游标分页）。
 * ⚠️ P0-2-10 起**已落地**：`POST /:id/confirm`（确认应答；它的**判据不在本文件** —— 见下一段）——
 *   于是 `02` §4.5 那张表的九条路由**全部有出口**，本文头部这句"仍缺一条"的旧注记已删除。
 *
 * ⚠️ `/confirm` 的判据**刻意不落在本服务层**：它读的 `pendingConfirmId` 是 `/active` 快照的
 *   一个字段（{@link getConversationActive}，四个字段之一），而匹配与写入在
 *   `orchestrator/sse.ts#answerConfirm`（那里同时是"这个会话的流到底在等哪个 id"的唯一真相源）。
 *   若在这里再判一次"该不该应用这条应答"，就出现了第二个实现 —— 而两者只要有一天不一致，
 *   症状是"确认点了没反应"，且**两处各自看都是对的**。
 */

import {
  AppError,
  EMPTY_ACTIVE_SNAPSHOT,
  isConversationReadOnly,
  parseActiveSnapshot,
  type AgentType,
  type ConversationActive,
  type ConversationItem,
  type ConversationListResult,
  type CreateConversationBody,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type MessageItem,
  type MessagePageResult,
  type RecallConversationResult,
  type RemoveConversationResult,
  type RenameConversationBody,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma, type PrismaClientInstance } from '../infra/prisma.js'
import { chatActiveKey, getRedis } from '../infra/redis.js'
import { getS3Client } from '../infra/s3.js'
import type { LlmTarget } from '../llm/client.js'
import { resolveChatTarget } from './model.service.js'

/**
 * 调用者 —— **只有 `id`，刻意没有 `role`**（见文件头 ①）。
 *
 * 与 `AgentViewer`（`{ id, role }`）的差别不是省事：那个资源要按角色判权，这个资源**不该按角色判**
 * —— 少一个字段，就越权实现无处落脚。
 */
export interface ConversationViewer {
  id: string
}

/** 会话行的查询字段（列表 / 建 / 改名共用；`agent` 是**快照** join，见 `shared/src/conversation.ts` 文件头 ②） */
const CONVERSATION_SELECT = {
  id: true,
  agentId: true,
  topic: true,
  status: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  agent: { select: { name: true, type: true } },
} as const

/** {@link CONVERSATION_SELECT} 的产物形态（手写出来给 {@link toItem} 收窄用） */
interface ConversationRow {
  id: string
  agentId: string
  topic: string | null
  status: ConversationItem['status']
  lastMessageAt: Date | null
  createdAt: Date
  updatedAt: Date
  agent: { name: string; type: ConversationItem['agentType'] }
}

// ═════════════════════════════════════════════════════════════════════
// 投影
// ═════════════════════════════════════════════════════════════════════

/** 行 → 对外形态（**唯一的出口**，列表/建/改名共用，见 P0-1-21 的"同一份数据不许有第二种形状"） */
function toItem(row: ConversationRow): ConversationItem {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agent.name,
    agentType: row.agent.type,
    topic: row.topic,
    status: row.status,
    // 列可空 ⇒ 对外也是 `null`（**不要**回落成 `createdAt`：那会让"还没消息"与"刚发了消息"
    // 在界面上无法区分，而"最后活跃时间"正是侧栏唯一要显示的东西）
    lastMessageAt: row.lastMessageAt === null ? null : row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ═════════════════════════════════════════════════════════════════════
// 列表（某 Agent 的会话）
// ═════════════════════════════════════════════════════════════════════

/**
 * 某 Agent 下**我**的会话列表（`GET /api/agents/:id/conversations`，`02` §4.5）。
 *
 * 两处容易做错的地方：
 *
 * ① **不过滤 `agents.deleted_at`**。软删 Agent 时它的会话是「只读**保留**」（`02` §4.4）
 *    —— 历史要看得见。若这里顺手加一个 `agent: { deletedAt: null }` 的关联过滤，
 *    用户会看到"智能体被删后我的历史一起消失了"，而数据库里它们明明还在
 *    （P0-1-24 门槛④ 的"会话仍在（只读）"就是靠这个端点做端点级取证的，见
 *    `verify-agent-package.mjs` 的 R4）。
 *    ⚠️ 但**"Agent 不存在"仍然要 404**（`{items: []}` 会让前端分不清"这个智能体没了"
 *    与"我还没聊过" —— 与文档列表的回 404 而不是空列表同款，P0-1-21）。
 *
 * ② **带上 `userId` 过滤**：见文件头 ①，这是本资源的权限全部落点。
 *
 * @throws {AppError} `NOT_FOUND`(404) 智能体不存在（软删的算存在）
 */
export async function listConversationsForAgent(
  agentId: string,
  query: ListConversationsQuery,
  viewer: ConversationViewer,
): Promise<ConversationListResult> {
  const db = getPrisma()

  // 不带 `deletedAt` 过滤（见 ①）；用 findUnique 而不是 findFirst 是刻意的：
  // 这里**没有**第二个过滤条件，写 findFirst 会让人以为"还有个条件被省略了"。
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (agent === null) throw AppError.notFound('智能体不存在')

  const where = { agentId, userId: viewer.id } as const
  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照（与 `listAgents` 同款）
  const [rows, total] = await db.$transaction([
    db.conversation.findMany({
      where,
      select: CONVERSATION_SELECT,
      // 见文件头 ③：`nulls: 'first'` 必须显式写
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.conversation.count({ where }),
  ])

  return {
    items: rows.map((row) => toItem(row as ConversationRow)),
    total,
    offset: query.offset,
    limit: query.limit,
  }
}

// ═════════════════════════════════════════════════════════════════════
// 建
// ═════════════════════════════════════════════════════════════════════

/**
 * 建会话（`POST /api/conversations`，`02` §4.5：`{agentId}` → 新会话）。
 *
 * `userId` 取**会话里的用户**，不接受请求体传入：它直接决定"谁能看这条会话"（文件头 ①），
 * 让它可被构造等于把访问控制交给调用方（与 `createAgent` 的 `createdBy` 同款）。
 *
 * 校验**只有一条**：Agent 存在**且未软删**（软删的不能再开新会话 —— 那是给一个已作废的智能体
 * 开一个新的对话入口，而它的详情页本身就是 404）。
 * ⚠️ 刻意**不校验** Agent 绑定模型是否可用 / Provider 有没有配 Key：那些是"发消息"的前置
 * （P0-1-26/27 的 424 / 409），而"进对话页看历史、把标题改一下"是随时都该能做的事 ——
 * 顺手加校验会让"模型停用后连自己的历史都进不去"。
 *
 * `topic` / `lastMessageAt` 都留 `null`（契约定案：`02` §4.5 的 body 只有 `agentId`，
 * 且 `03` §4.1 的标题只可能来自"重命名"或后续批次 —— 本批**没有自动命名**）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 智能体不存在或已软删
 */
export async function createConversation(
  input: CreateConversationBody,
  viewer: ConversationViewer,
): Promise<ConversationItem> {
  const db = getPrisma()
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, deletedAt: null },
    select: { id: true },
  })
  if (agent === null) throw AppError.notFound('智能体不存在')

  const created = await db.conversation.create({
    data: { agentId: input.agentId, userId: viewer.id },
    select: CONVERSATION_SELECT,
  })

  getLogger().info(
    { conversationId: created.id, agentId: input.agentId, userId: viewer.id },
    '已创建会话',
  )
  return toItem(created as ConversationRow)
}

// ═════════════════════════════════════════════════════════════════════
// 我的一条会话（改名 / 删除 / 活跃态共用的一段查询）
// ═════════════════════════════════════════════════════════════════════

/**
 * 取"我的一条会话"，取不到就 404。
 *
 * 刻意把 `userId` 放进 `where` 而不是"先查出来再判权限"：
 * 别人的会话与不存在的 id **返回完全一样的 404**（文件头 ①），从代码结构上就不存在
 * "忘了判权限"或"判了但顺序写错"的空间 —— 这也是本文件**没有** `canEditXxx` 这类判据函数的原因
 * （它只有"是不是你的"这一种答案，落在 `where` 里比落在一个布尔函数里更难写错）。
 */
async function findMyConversation(
  id: string,
  viewer: ConversationViewer,
): Promise<ConversationRow & { messageCount: number }> {
  const row = await getPrisma().conversation.findFirst({
    where: { id, userId: viewer.id },
    select: { ...CONVERSATION_SELECT, _count: { select: { messages: true } } },
  })
  if (row === null) throw AppError.notFound('会话不存在')
  const { _count, ...rest } = row
  return { ...(rest as ConversationRow), messageCount: _count.messages }
}

// ═════════════════════════════════════════════════════════════════════
// 改名
// ═════════════════════════════════════════════════════════════════════

/**
 * 重命名（`PATCH /api/conversations/:id`；`02` §4.5、`03` §4.1 的行内编辑）。
 *
 * `topic` **不是三态**：契约只收非空字符串（`shared` 的 `renameConversationBodySchema` 有理由）。
 *
 * ⚠️ **不按 `status` 拦**（文件头 ⑤）：已结束（`FINISHED`）的会话照样能改名。
 *
 * @throws {AppError} `NOT_FOUND`(404) 不存在或不是我的
 */
export async function renameConversation(
  id: string,
  input: RenameConversationBody,
  viewer: ConversationViewer,
): Promise<ConversationItem> {
  const target = await findMyConversation(id, viewer)

  // `update` 而不是 `updateMany`：这里不需要 CAS（改名没有并发语义要求，后写覆盖先写就是期望行为）。
  // 用 `id` 定位是安全的 —— 上一行已经确认过它属于我。
  const updated = await getPrisma().conversation.update({
    where: { id },
    data: { topic: input.topic },
    select: CONVERSATION_SELECT,
  })

  getLogger().info({ conversationId: id, from: target.topic, to: input.topic }, '已重命名会话')
  return toItem(updated as ConversationRow)
}

// ═════════════════════════════════════════════════════════════════════
// 删
// ═════════════════════════════════════════════════════════════════════

/**
 * 删会话（`DELETE /api/conversations/:id`）。
 *
 * 顺序与"为什么要数消息"见文件头 ④。三步：
 *   ① 事务内**数消息 + 删会话行**（`messages` 由外键 `CASCADE` 连带清除）；
 *   ② 清掉这个会话的**活跃流锁**（`chat.active:{id}`，见 {@link chatActiveKey}）—— 只告警；
 *   ③ 清 S3 对象 —— P0-1 阶段恒为空，见文件头 ⑥（拿到空数组时**连桶都不探**）。
 *
 * ②③ 都放在"数据库已经删掉"之后、且**失败只告警**：与删库/删文档同一条铁律 ——
 * "行没了、文件还在"只是泄漏一点存储，"行还在、文件没了"才是查不出来的坏数据。
 *
 * ⚠️ **不按 `status` 拦**（文件头 ⑤）：已结束的会话照样能删（用户要能清理历史）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 不存在或不是我的
 */
export async function removeConversation(
  id: string,
  viewer: ConversationViewer,
): Promise<RemoveConversationResult> {
  const target = await findMyConversation(id, viewer)
  const db = getPrisma()

  // ① 数 + 删在同一个事务里（TOCTOU：并发落库的消息会让"数出来的"少于"实际删掉的"）
  const deletedMessages = await db.$transaction(async (tx) => {
    const counted = await tx.message.count({ where: { conversationId: id } })
    await tx.conversation.delete({ where: { id } })
    return counted
  })

  // ② 活跃流锁：不删它会留到 TTL 过期（无害，但 Redis 里会积一批指向已删会话的键，
  //    而 `/active` 对已删会话是 404 ⇒ 没人能发现它们是垃圾）
  try {
    await getRedis().del(chatActiveKey(id))
  } catch (error) {
    getLogger().warn({ err: error, conversationId: id }, '活跃流锁清理失败（会话已删除，键会自行过期）')
  }

  // ③ S3：P0-1 阶段必然为空数组（文件头 ⑥）
  const objectKeys = await collectConversationObjectKeys(id)
  const deletedObjects = await removeConversationObjects(objectKeys)

  getLogger().info(
    { conversationId: id, agentId: target.agentId, deletedMessages, deletedObjects },
    '已删除会话',
  )
  return { id, agentId: target.agentId, topic: target.topic, deletedMessages }
}

/**
 * 这个会话名下的对象存储键。**P0-1 阶段恒为空数组**（文件头 ⑥）。
 *
 * 为什么保留这个函数而不是把 S3 那一段整个删掉：`06` P0-1-25 的需求原文里有"删除（异步清理 S3）"，
 * 而今天**没有**任何属于会话的对象 —— 产物（`artifacts`，P0-3）与附件（`files`，P1）两张表
 * 都还不存在。把"该收哪些键"这件事收在**一个**函数里，P0-3 就只需在这里加一句：
 *
 * ```ts
 * const rows = await db.artifact.findMany({ where: { conversationId }, select: { fileKey: true } })
 * return rows.map((row) => row.fileKey)
 * ```
 *
 * 删除路径（{@link removeConversation}）**不用改**。⚠️ 现在写一段"先假定键长什么样"的代码，
 * 只会在 P0-3 变成需要重写的猜测（P0-1-14 的坑预判被证伪，就是这种"先假设"的代价）。
 */
async function collectConversationObjectKeys(conversationId: string): Promise<string[]> {
  void conversationId
  return []
}

/**
 * 清掉这些键。**失败只告警、不抛**（与 `kb.service.ts` 的 `removeDocumentObjects` 同款）。
 *
 * ⚠️ **空数组直接返回、连桶都不探**：`infra/s3.ts` 的探活注释说明了桶是"首次上传时按需创建"的，
 * 一个从没上传过任何东西的部署里桶根本不存在；探一次桶会白跑一个请求，而
 * "建库就删库"那条路上的 `NoSuchBucket` 还得单独分支。空输入 ⇒ 什么都不做，是唯一不需要分支的写法。
 */
async function removeConversationObjects(objectKeys: string[]): Promise<number> {
  if (objectKeys.length === 0) return 0
  const bucket = config.s3.bucket
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) {
      getLogger().warn({ bucket, count: objectKeys.length }, 'S3 桶不存在，跳过会话产物清理（无对象可删）')
      return 0
    }
    // `Quiet: true` ⇒ 响应里**只回失败的条目**，故"总数 - 失败数"才是真实值
    const results = await s3.removeObjects(bucket, objectKeys)
    const failed = results.filter((item) => item != null && item.Error != null)
    if (failed.length > 0) {
      getLogger().warn(
        { bucket, failed: failed.length, sample: failed.slice(0, 3) },
        'S3 会话产物部分删除失败（数据库记录已删除，残留对象需人工清理）',
      )
    }
    return objectKeys.length - failed.length
  } catch (error) {
    getLogger().warn(
      { err: error, bucket, count: objectKeys.length },
      'S3 会话产物清理失败（数据库记录已删除，残留对象需人工清理）',
    )
    return 0
  }
}

// ═════════════════════════════════════════════════════════════════════
// 撤回最新一轮（产品优化 2026-09-29）
// ═════════════════════════════════════════════════════════════════════

/** 从助手消息的 `content.artifacts` 段里安全地取出产物 id（`content` 是 jsonb、形状由写入版本决定） */
function artifactIdsOfContent(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const artifacts = (raw as Record<string, unknown>)['artifacts']
  if (!Array.isArray(artifacts)) return []
  const ids: string[] = []
  for (const entry of artifacts) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as { artifactId?: unknown }).artifactId
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}

/**
 * 撤回**最新一轮**（`POST /api/conversations/:id/recall`）。
 *
 * 只允许"最新一轮"（而不是任意一轮）：多轮对话里模型看到的上下文依赖前面的消息，
 * 改中间任何一轮都会让后面的回答建立在被改写的历史上 —— 产品口径是"只能对最新的一轮
 * 撤回 / 修改重发"（产品反馈 2026-09-29）。
 *
 * 一轮 = 最后一条 `USER` 消息 + 它之后落库的全部消息（本仓一轮是 USER + ASSISTANT 两条、
 * 在**同一个事务**里写入；"之后"在正常路径上就是那一条 ASSISTANT）。
 *
 * 三处刻意：
 *   · **不按 `status` 拦**（与删除同族，文件头 ⑤）：用户要能撤回自己的历史，
 *     与 Agent 是否被软删无关；
 *   · **TaskAgent 那一轮的产物一并删**（行 + S3 对象）：产物面板与消息历史是同一条时间线，
 *     撤了轮却让产物留在面板上，会造出"这一轮不存在了、文件却还在"的半截状态。
 *     对象删除失败只告警（行已删，残留对象属可人工清理的泄漏，与 `removeConversation` 同款）；
 *   · **撤回后整轮删干净**（没有消息了）⇒ 把 `topic` / `lastMessageAt` 重置回 `null`：
 *     "标题由首条消息推导"（{@link deriveConversationTopic}）的前提是"有首条消息"，
 *     空会话回到"新会话"态。
 *
 * @throws {AppError} `NOT_FOUND`(404) 会话不存在或不是我的
 */
export async function recallLastRound(
  id: string,
  viewer: ConversationViewer,
): Promise<RecallConversationResult> {
  const target = await findMyConversation(id, viewer)
  const db = getPrisma()

  // 事务外要用的 S3 对象键：`$transaction` 的回闭里写入、事务提交后再删对象
  let objectKeys: string[] = []

  const result = await db.$transaction(async (tx) => {
    // ① 最新一轮的起点 = 最后一条 USER 消息（`MESSAGE_CHRONO_ORDER` 是"新 → 旧"）
    const lastUser = await tx.message.findFirst({
      where: { conversationId: id, role: 'USER' },
      orderBy: [...MESSAGE_CHRONO_ORDER],
    })
    if (lastUser === null) {
      // 一个消息都没有的会话：撤回无可撤回（界面上也不该出现这个按钮，这里是兜底）
      return { id, agentId: target.agentId, deletedMessages: 0, deletedArtifacts: 0 }
    }

    // ② 该轮的全部消息 = 那条 USER + 它之后的一切（二元组字典序，与 `listMessages` 同款比较）
    const doomed = await tx.message.findMany({
      where: {
        conversationId: id,
        OR: [
          { id: lastUser.id },
          { createdAt: { gt: lastUser.createdAt } },
          { createdAt: lastUser.createdAt, id: { gt: lastUser.id } },
        ],
      },
      select: { id: true, role: true, content: true },
      orderBy: [...MESSAGE_CHRONO_ORDER],
    })

    // ③ 数 + 删消息（同一个事务：先数后删，跨语句数会出现"数了 2 条、删了 3 条"）
    const deletedMessages = await tx.message.deleteMany({
      where: { id: { in: doomed.map((row) => row.id) } },
    })

    // ④ TaskAgent 那一轮的产物：行与消息同一个事务删，S3 对象在事务外尽力删
    const artifactIds = doomed
      .filter((row) => row.role === 'ASSISTANT')
      .flatMap((row) => artifactIdsOfContent(row.content))
    let deletedArtifacts = 0
    if (artifactIds.length > 0) {
      const rows = await tx.artifact.findMany({
        where: { id: { in: artifactIds } },
        select: { id: true, fileKey: true },
      })
      objectKeys.push(...rows.map((row) => row.fileKey))
      if (rows.length > 0) {
        deletedArtifacts = (await tx.artifact.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })).count
      }
    }

    // ⑤ 重算活跃时间与标题：还有消息 ⇒ `lastMessageAt` 指到最后一条；没有 ⇒ 回到"新会话"态
    const remaining = await tx.message.findFirst({
      where: { conversationId: id },
      orderBy: [...MESSAGE_CHRONO_ORDER],
      select: { createdAt: true },
    })
    await tx.conversation.update({
      where: { id },
      data: {
        lastMessageAt: remaining === null ? null : remaining.createdAt,
        ...(remaining === null ? { topic: null } : {}),
      },
    })

    return { id, agentId: target.agentId, deletedMessages: deletedMessages.count, deletedArtifacts }
  })

  // S3 对象清理放在事务外（失败只告警，不把"删消息"这件事拖垮）
  if (objectKeys.length > 0) await removeConversationObjects(objectKeys)
  getLogger().info({ conversationId: id, ...result }, '已撤回最新一轮')
  return result
}

// ═════════════════════════════════════════════════════════════════════
// 活跃流状态（`GET /:id/active`）
// ═════════════════════════════════════════════════════════════════════

/**
 * 活跃流状态（`02` §4.5 / §5.2：断线重连先查它拿"在流/排队位次/当前工具"，再拉历史补齐）。
 *
 * 数据源 = Redis `chat.active:{id}`（见 `infra/redis.ts#chatActiveKey`）：
 *   · **键在 ⇒ `streaming: true`**（`streaming` 是**派生**的，不单独存 —— 见 `shared` 文件头 ⑤）；
 *   · 值里的细节走 `parseActiveSnapshot`（永不抛错），解析不出来只 warn。
 *
 * ③ 两处刻意：
 *   · **先查库再查 Redis**：不是我的会话/不存在的会话一律 **404**，而不是回一个"没有流"的
 *     `{streaming:false}` —— 后者会让前端把"会话被删了"当成"当前没在生成"（用户会盯着一个
 *     永远不会有回复的页面）。**写侧归 P0-1-26**，所以本批恒为 `{streaming:false}`（`06` 的验收原文）。
 *   · **不为 Redis 故障做特殊兜底**：`requireAuth` 已经保证这一刻 Redis 是通的
 *     （`02` §十：Redis 故障 → 500 不放行），在这里再包一层只会掩盖真实故障。
 *
 * @throws {AppError} `NOT_FOUND`(404) 不存在或不是我的
 */
export async function getConversationActive(
  id: string,
  viewer: ConversationViewer,
): Promise<ConversationActive> {
  await findMyConversation(id, viewer)

  const raw = await getRedis().get(chatActiveKey(id))
  if (raw === null) return { streaming: false, ...EMPTY_ACTIVE_SNAPSHOT }

  const snapshot = parseActiveSnapshot(raw)
  if (snapshot.currentTool === null && snapshot.queuedPosition === null && snapshot.startedAt === null) {
    // "键在、值坏" 是**写侧**出错的可观测痕迹（P0-1-26 的 bug），不该被静默吞掉；
    // 但对读侧不构成失败：锁确实在，只是细节丢了。
    getLogger().warn({ conversationId: id }, '活跃流快照无法解析，已降级为仅有 streaming=true')
  }
  return { streaming: true, ...snapshot }
}

// ═════════════════════════════════════════════════════════════════════
// 消息历史（`GET /:id/messages`，P0-1-28）
// ═════════════════════════════════════════════════════════════════════

/**
 * 消息的**时间口径**（唯一实现）：**新 → 旧**，`id` 只做 tie-break。
 *
 * `id desc` 不是装饰：`messages.created_at` 是毫秒精度，而同一轮问答的两条消息在**同一个事务**
 * 里写入（`chatBot.ts#persistRoundQuietly`）⇒ PG 的 `now()` 是事务开始时刻 ⇒ 它们的
 * `created_at` **逐字相同**。没有第二排序键，这两条之间的顺序就是不确定的，
 * 而"不确定"在分页上等于"可能漏一条、又可能重复一条"—— 且只在长会话里偶发。
 *
 * ⚠️ **两个消费方共用它**（判据："同一条序列被两处分别排序，就一定会漂"）：
 *   · 本文件的 {@link listMessages}（历史分页）；
 *   · `orchestrator/chatBot.ts` 的"最近 N 轮"（上下文窗口）。
 * 漂了的症状很具体：**模型看到的最近几轮与界面上显示的最近几条不是同一批**
 * （用户说"你刚才明明说过"，而模型那边是另一段对话）。
 */
export const MESSAGE_CHRONO_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const

/**
 * {@link toMessagePage} 的入参行 —— 只要求它真正读的四列（少给一列是编译错误，多给无所谓）。
 */
export interface MessageRowForPage {
  id: string
  role: MessageItem['role']
  content: unknown
  createdAt: Date
}

/**
 * 原始行 → 一页（**纯函数**，`verify:app` 的无依赖档直接断言它）。
 *
 * 为什么把"取页"这件事从 DB 查询里拆出来："不重不漏"这条验收的**全部**正确性都在这几行里
 * （多取一条判断 `hasMore`、反转成正序、`nextCursor` 指向本页第一条），而它在真库上
 * 只表现为"某次翻页少/多一条"—— 一个 SQL 写对的实现配一个错的取页逻辑，照样能顺利跑完。
 *
 * 入参约定（调用方负责）：`rows` 已按 {@link MESSAGE_CHRONO_ORDER} 排好（**新 → 旧**），
 * 且**多取了 1 条**（`take: limit + 1`）—— 多出来的那条只用来说明"还有更早的"。
 *
 * ⚠️ `content` **原样透出**，**绝不**过 `messageContentSchema`：那个 schema 会把未声明的键
 * 静默剥掉（P0-2 的 `tool_calls` 会因此在"刷新后重放历史"时消失且不报错）。
 * 本函数是读取端唯一一处"能把它过滤掉"的机会，故把这条写在这里。
 */
export function toMessagePage(rows: MessageRowForPage[], limit: number): MessagePageResult {
  const size = Math.max(0, Math.trunc(limit))
  const page = rows.slice(0, size)
  // `page.length > 0` 是给退化输入（size = 0）兜底的：那种情况下"还有更多"没有意义，
  // 而且会让 `nextCursor` 与 `hasMore` 这对同真同假的字段自相矛盾。
  const hasMore = page.length > 0 && rows.length > page.length
  const items = page
    .slice()
    // 对外是**正序**（旧 → 新）：对话流"新消息追加在末尾"（`03` §五），历史与流式渲染必须
    // 落在同一个数据结构上（单一渲染路径）—— 把这一反转收在服务端，前端就不必在两处
    // 各写一次 reverse（"一处正一处反"的 bug 只在翻第二页时才显形）。
    .reverse()
    .map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    }))
  return {
    items,
    hasMore,
    // 本页**最旧**那条的 id（正序之后就是第一条）= "再往前一页"的游标。
    // 与 `hasMore` 同真同假：没有更多了就给 `null`，而不是给一个"用不上的游标"
    // （前端只能靠 `hasMore` 判断，多给一个值等于给它多一个可能写错的分支）。
    nextCursor: hasMore ? (items[0]?.id ?? null) : null,
  }
}

/**
 * 消息历史（`GET /api/conversations/:id/messages`；`02` §4.5 / §四 的游标分页）。
 *
 * 三条口径：
 *
 * ① **权限复用"取我的一条会话"**（{@link findMyConversation}）：别人的会话与不存在的 id
 *    一律 **404**（文件头 ①）。刻意**不**在这里另写一段 `where: { userId }` ——
 *    所有权判据一旦有第二个实现，就会漂（P0-1-21 的"同一份数据不许有第二种形状"同款）。
 *    ⚠️ 代价是它顺带多做一次 `_count(messages)`（P0-1-25 留下的、目前**没有消费方**的字段）。
 *    一次历史拉取多一条只读子查询，比"给所有权判据开第二个实现"划算得多；等它在
 *    `/active` 轮询路径上真的成为瓶颈，再把这一个字段摘掉即可（纯减法，不涉及契约）。
 *    也刻意**不查 `status`**：`FINISHED` 只表示"不能再产生消息"，**历史照样要看得见**
 *    （文件头 ⑤，`02` §4.4 的"只读保留"）。
 *
 * ② **游标必须属于这个会话**（`where` 里带 `conversationId`）。少了这一条，
 *    拿**别人会话**的消息 id 当游标就会命中，等于用一个可猜的 id 探出"另一条会话的某条消息
 *    发生在什么时刻"（以及分页会从那个位置开始 —— 虽然内容仍被本会话的过滤挡住）。
 *    游标查不到时回 **400**（而不是"当成没有游标"）：后者会让前端把**最新一页又拿一遍**，
 *    在界面上表现为消息**重复**，而用户只会觉得"翻页坏了"。
 *    会话本身不存在/不是我的仍是 **404**（先查库，见 ①）—— 两者的主语不同，
 *    与 §4.5 ⑧ 的"两类失败、两个出口"是同一条判断。
 *
 * ③ **`take: limit + 1`**：多取的那一条不返回，只用来判"还有没有更早的" ——
 *    这样不必为"还剩多少"再跑一次 `count`（在按月分区的表上就是再扫一遍）。
 *    分页单位是**消息行**，不是 `content` 里的段 ⇒ "单条消息的结构被截断"在形态上不可能发生
 *    （`06` P0-1-28 的坑预判，见落地要点）。
 *
 * 刻意**不打日志**：这是对话页每次进入/每次翻页都会打的只读请求，打一行 INFO 会让
 * 日志里真正的事件（TTFT、落库、失败）淹掉。
 *
 * @throws {AppError} `NOT_FOUND`(404) 会话不存在或不是我的；`VALIDATION`(400) beforeId 无效
 */
export async function listMessages(
  id: string,
  query: ListMessagesQuery,
  viewer: ConversationViewer,
): Promise<MessagePageResult> {
  const target = await findMyConversation(id, viewer)
  const db = getPrisma()

  let before: { id: string; createdAt: Date } | null = null
  if (query.beforeId !== undefined) {
    before = await db.message.findFirst({
      where: { id: query.beforeId, conversationId: target.id },
      select: { id: true, createdAt: true },
    })
    if (before === null) throw AppError.validation('beforeId 不是该会话的消息（游标无效）')
  }

  /**
   * 游标的比较是**二元组的字典序**：`(created_at, id) < (游标)`，展开就是
   * `created_at < 游标时刻` **或** `created_at = 游标时刻 且 id < 游标 id`。
   * 少了后一半就正好丢掉"同一毫秒的另一条"（文件头 ⑦ 说的那两条）。
   *
   * ⚠️ 第一页（无游标）只按 `conversationId` 过滤 ⇒ PG 会扫到每个月的分区（分区键是
   * `created_at`，没有时间下界就裁不掉）。这是分区表的固有代价，不是写错了：
   * 每个分区上都有 `(conversation_id, created_at desc)` 索引，`LIMIT 21` 走的是
   * "各分区各取前 21 条再归并"，代价与分区数成正比、与表大小无关。
   * 验收里有一条墙钟断言盯着它，真变慢时会先在那里红（P0-1-20 的同款做法）。
   */
  const rows = await db.message.findMany({
    where:
      before === null
        ? { conversationId: target.id }
        : {
            conversationId: target.id,
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          },
    select: { id: true, role: true, content: true, createdAt: true },
    orderBy: [...MESSAGE_CHRONO_ORDER],
    take: query.limit + 1,
  })

  return toMessagePage(rows, query.limit)
}

// ═════════════════════════════════════════════════════════════════════
// 发消息的闸门（P0-1-26）
// ═════════════════════════════════════════════════════════════════════

/**
 * 一次「可发送」的会话上下文：闸门通过后的产物，交给 SSE 出口层。
 *
 * `target` 里带**明文 API Key**（`resolveChatTarget` 解出来的）⇒ 与 `LlmTarget` 一条纪律：
 * 只许在进程内存里流转，进日志一律用 `describeTarget()`。
 */
export interface ChatSendContext {
  conversationId: string
  agentId: string
  target: LlmTarget
  /**
   * 智能体类型（**P0-3-6 起**）—— `routes/conversations.ts` 用它决定派哪个编排循环
   * （`orchestrator/index.ts#resolveChatProducer(agentType)`：`CHATBOT` 走后端 RAG 编排，
   * `TASK_AGENT` 走沙箱里的 pi 引擎）。
   *
   * ⚠️ **判据只能来自库里的 `agents.type`**，不能来自请求体 —— 请求体里根本没有这个字段
   * （`chatRequestBodySchema` 只有 `content` 与 `attachmentFileIds`），客户端无从指定
   * "我要走哪条链路"。它在本函数的 `select` 里顺带取出来（同一个 `agent` 关系），零额外往返。
   */
  agentType: AgentType
}

/**
 * 发消息的前置闸门（`POST /:id/chat` 的第一步，**在写出任何 SSE 帧之前**跑完）。
 *
 * 四道判据，**顺序即用户看到什么**：
 *   ① 会话存在**且是我的** → 否则 **404**（口径与其余会话端点完全一致：别人的会话与不存在的
 *      id 回同一个 404，见文件头 ①）；
 *   ② **不是只读** → 否则 **409**。「只读」= `FINISHED`，当前唯一的来源是"Agent 被软删"
 *      （`02` §4.4：会话转只读**保留**）—— 这正是 P0-1-24 门槛④ 里"写不进去"那一半的落点
 *      （读得到由会话列表端点取证、写不进去由本函数取证）；
 *   ③ 绑定模型**能用** → 404 模型不存在 / 409 已停用（模型或其 Provider）/ 424 缺 Key。
 *      **整段复用 `services/model.service.ts#resolveChatTarget()`**（唯一实现）：
 *      P0-1-22 建 Agent 时**刻意不复用它**（那个场景不该逼管理员先配 Key），而"发消息"正是
 *      它被设计出来的场景 —— 两边各自实现一遍必然漂移。
 *      ⚠️ 这些错误原样透出（含 `NOT_FOUND`）：与智能体换绑模型时同一套口径（那里也是 404），
 *      不在这里另立一套。
 *   ③′ **本轮指定模型**（模型池特性）：请求体给了 `modelId` 且不等于默认模型时，必须是该智能体
 *      **模型池的成员**（`agent_models`）→ 否则 **409**（防止绕过智能体的模型白名单）。
 *      成员校验通过后，用它替代默认模型解析上游目标；未指定则走默认模型（`agents.model_id`）。
 *   ④ **会话互斥**（活跃流锁）**不在这里**：它是 Redis 上的一个原子操作，属 SSE 出口层
 *      （`orchestrator/sse.ts#acquireConversationLock`），失败了走 **409 `CONFLICT`**。
 *      ⚠️ 那一处**不查库**：加锁必须是一次 `SET NX`，而"用户的"判据已经由 ①② 保证了。
 *
 * ⚠️ **刻意不做**：并发闸（`CHATBOT_CONCURRENCY`，满则 429 `BUSY`）。它是**进程级**的信号量，
 * 属 P0-1-27 的编排层 —— 放在这条路由上会让"打开一个流"与"占用一个编排名额"变成两件事
 * （本批的流不消耗编排资源，占名额反而会把名额表变成假的）。
 *
 * @param requestedModelId 本轮请求指定的模型（`chatRequestBodySchema.modelId`）。省略/undefined
 *   ⇒ 走该智能体的默认模型；给了则必须是模型池成员（见 ③′）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 会话/模型不存在（或不是我的）/ `CONFLICT`(409) 会话只读/模型不可用/所选模型不在池中
 *                    / `NEED_CREDENTIAL`(424) Provider 未配 Key
 */
export async function assertConversationSendable(
  id: string,
  viewer: ConversationViewer,
  requestedModelId?: string,
): Promise<ChatSendContext> {
  const db = getPrisma()
  const row = await db.conversation.findFirst({
    where: { id, userId: viewer.id },
    select: { id: true, agentId: true, status: true, agent: { select: { modelId: true, type: true } } },
  })
  if (row === null) throw AppError.notFound('会话不存在')

  if (isConversationReadOnly(row.status)) {
    throw AppError.conflict('该会话已结束，不能再发送消息')
  }

  // ③′ 解析"这一轮到底用哪个模型"：默认走 agent.model_id；请求指定了别的就必须是池成员。
  let chosenModelId = row.agent.modelId
  if (requestedModelId !== undefined && requestedModelId !== row.agent.modelId) {
    const member = await db.agentModel.findUnique({
      where: { agentId_modelId: { agentId: row.agentId, modelId: requestedModelId } },
      select: { modelId: true },
    })
    if (member === null) {
      throw AppError.conflict('所选模型不在该智能体的模型池中，请重新选择模型')
    }
    chosenModelId = requestedModelId
  }

  const target = await resolveChatTarget(chosenModelId)
  return { conversationId: row.id, agentId: row.agentId, target, agentType: row.agent.type }
}

// ═════════════════════════════════════════════════════════════════════
// 给 P0-1-27 用：把会话标成"刚刚有消息"
// ═════════════════════════════════════════════════════════════════════

/**
 * 事务内可用的 Prisma 子集（`$transaction(async (tx) => …)` 的 `tx` 结构上满足它）。
 *
 * 只取 `conversation` 一个委托：本函数不该顺手写别的表，"能写整库"的入参只会诱使调用方
 * 在这里多塞几件事（而它是被**别人的**事务调用的）。
 */
export type ConversationTouchClient = Pick<PrismaClientInstance, 'conversation'>

/**
 * 把 `last_message_at` 推到 `at`（**只前进、不后退**）。P0-1-27 在"整条消息落库"那个事务里调它。
 *
 * 为什么单独抽出来给下一批用：`06` P0-1-25 的坑预判点名的就是这个时点（文件头 ②），
 * 而它**没有 HTTP 出口**能验 —— 本批没有写消息的端点，P0-1-27 之前唯一能证明它对的，
 * 就是把它做成一个可以单独调用的函数（验收脚本直接调，见 `verify-conversations.mjs` 的 G 组）。
 * 让下一批各自实现一遍，等于把同一条口径复制成两份。
 *
 * **"只前进不后退"用 CAS 表达**（`OR: [null, { lt: at }]`）而不是"先读再比"：
 * ① 先读再写在两处并发落库时会同时通过判断、后到的旧值把新值盖回去（时间倒流，
 *    会话在侧栏里"掉下去"）；② 单语句形式天然幂等 —— 重投同一个 job（P0-1-17 的可重放入口）
 * 不会把时间戳改坏。
 *
 * ⚠️ 刻意**不做**"顺手把 `status` 改回 `ACTIVE`"：`FINISHED` 是"Agent 被软删"留下的只读标记
 * （`02` §4.4），而"能不能再发消息"由 P0-1-26 的闸门判 —— 在这里复活状态会让"只读保留"
 * 悄悄失效。同理**也不碰 `updated_at` 之外的任何列**。
 *
 * @returns 真的被改了就是 `true`（时间戳没前进 / 会话已不存在都是 `false`）
 */
export async function touchConversation(
  db: ConversationTouchClient,
  conversationId: string,
  at: Date,
): Promise<boolean> {
  const result = await db.conversation.updateMany({
    where: {
      id: conversationId,
      OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }],
    },
    data: { lastMessageAt: at },
  })
  return result.count > 0
}
