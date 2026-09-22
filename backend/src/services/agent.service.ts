/**
 * 智能体服务（P0-1-22）
 *
 * 依据：`docs/02-后端设计.md` §4.4（`/api/agents[…/:id]` 五端点）+ §三（`agents` /
 *      `agent_components` 表与删除语义）+ `01` §3.3（功能清单 + 决策 18 权限）
 *      + `03` §二（路由与权限列）/ §4.2（智能体编辑页）/ §七（级联删除确认框）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的五条口径
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① 权限是「全员可建可看可用；创建者 + ADMIN 可编删」，判据只有一处。**
 *    与它容易混淆的两个邻居**都不一样**：模型池 = 全程 ADMIN；知识库 = 登录即可（无 owner 列）。
 *    `01` 决策 18 与 `agents.created_by` 列一起把这条钉死了，判据落在
 *    `shared` 的 {@link canEditAgent}（服务端与验收脚本共用，避免"两份实现各自漂移"）。
 *    路由侧**只用 `requireAuth`**：本资源不是 `(A)` 端点，编删的收窄发生在**行级**而不是路由级。
 *
 * **② 「删除」是软删，且是同一事务里的三件事。**
 *    `02` §4.4 原文：「删除（**软删**：会话转只读保留、组件绑定解除）」。三件事缺一不可：
 *      ① `deleted_at = now()`；② 删掉这个 Agent 的 `agent_components` 行；③ 它的会话
 *      `status → FINISHED`（只读保留）。
 *    只做 ① 的后果最隐蔽：`kb.service.ts` 的删库守卫数的是 `agent_components`，
 *    于是**那个知识库从此删不掉**（界面提示"正被 1 个 Agent 绑定"，而那个 Agent 已经"没了"）。
 *    这也是"必须先删 DB 再删 S3"（P0-1-15）同族的教训：**连带关系不在一张表里时，
 *    一定要显式写明并一次做完**。
 *
 * **③ 绑定模型必须「存在 + `type=CHAT` + 模型与 Provider 都启用」。**
 *    这是 `01` §3.2 验收要点「无效模型创建 Agent 时不可选」在**写入侧**的对应物
 *    （可选列表 `GET /api/models/available?type=CHAT` 管的是"选的时候"，但**绕过界面的
 *    直接调用必须同样被拦**）。三条校验与那个列表的过滤条件**逐条对应**，
 *    验收里有一条"列表里出现过的模型都能建成功、不在列表里的一律被拒"的一致性断言守着。
 *
 *    ⚠️ **刻意不复用 `model.service.ts` 的 `resolveChatTarget()`**：那个函数是"**调用上游**"的前置
 *    （要求 Provider 已配 Key，否则 424 `NEED_CREDENTIAL`），而"绑定"是配置动作 ——
 *    把一个还没配 Key 的模型绑到 Agent 上完全合法（Key 可以稍后补），拿 424 拦住等于
 *    逼管理员先配 Key 才能建智能体（而连通性测试正是"配完 Key 才做"的事）。
 *
 * **④ 校验只在 `modelId` **变了** 的时候做。**
 *    `03` §4.2 的保存是**整表单提交**（`PATCH` 里带着 `modelId`）。若"传了 `modelId` 就校验"，
 *    那么当绑定的模型事后被停用时，用户连**改个名字**都保存不了（每次提交都会撞上 409），
 *    而他能想到的出路（换模型）反而是唯一能走通的那条 —— 症状是"这个智能体改不动了"。
 *    所以：同值放行（幂等），只有**换绑**才重新校验。
 *
 * **⑤ 列表排序是 `updatedAt desc`（且与其余三个列表相反）。**
 *    `schema.prisma` 里 `agents` 的 `@@index([deletedAt, updatedAt(sort: Desc)])` 注释已写明
 *    "服务列表排序"，本文件按它落地。P0-1-21 在**文档**列表上刻意不用 `updatedAt`
 *    （覆盖重建会让那篇文档在翻页时跳位置），两处的差别来自**触发源不同**：
 *    文档的 `updated_at` 会被**后台流水线**改（用户没动手），而智能体的 `updated_at`
 *    只被**用户自己的编辑**改 —— 刚编辑完的排在最前面正是期望行为。
 *    P0-1-23 的组件整体替换只写 `agent_components`、**不动** `agents.updated_at`，
 *    所以"解绑即生效"不会顺手把某个智能体弹到列表顶部。
 */

import {
  AppError,
  canEditAgent,
  normalizeGuideQuestions,
  type AgentComponentRef,
  type AgentItem,
  type CreateAgentBody,
  type ListAgentsQuery,
  type OffsetPage,
  type RemoveAgentResult,
  type UpdateAgentBody,
  type UserRole,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'

/**
 * 调用者（`AuthContext['user']` 的**结构子集**）。
 *
 * 刻意不 import `plugins/session.js` 的 `AuthContext`：服务层依赖插件会把依赖方向倒过来
 * （插件本来就依赖服务/基础设施），而这里真正需要的只有 `id` + `role` 两个字段 ——
 * 结构类型让路由可以**直接**把 `auth.user` 传进来，不必多写一层映射。
 */
export interface AgentViewer {
  id: string
  role: UserRole
}

/**
 * 查询字段白名单（列表 / 详情 / 建 / 改共用一份）。
 *
 * ⚠️ `deletedAt` 必须查出来：{@link canEditAgent} 要用它判"已软删的一律不可编辑"。
 * 它**不出现在**出参里（`AgentItem` 没有这个字段）—— 软删的行根本查不到（见下），
 * 查出来只是为了把判据变成可复核的输入而不是"调用方保证"。
 *
 * `model` / `creator` 两个关联是刻意的：列表页要显示"绑的是哪个模型 / 谁建的"，
 * 让每次列表都回库 join 一次，比让前端为每一行各打一次接口好得多。
 */
const AGENT_SELECT = {
  id: true,
  name: true,
  description: true,
  icon: true,
  type: true,
  systemPrompt: true,
  openingRemarks: true,
  guideQuestions: true,
  modelId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  model: { select: { modelName: true, label: true, enabled: true, provider: { select: { enabled: true } } } },
  creator: { select: { username: true, nickname: true } },
} as const

/** {@link AGENT_SELECT} 的产物形态（手写出来给 {@link toItem} 收窄用） */
interface AgentRow {
  id: string
  name: string
  description: string | null
  icon: string | null
  type: AgentItem['type']
  systemPrompt: string | null
  openingRemarks: string | null
  guideQuestions: unknown
  modelId: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  model: { modelName: string; label: string; enabled: boolean; provider: { enabled: boolean } }
  creator: { username: string; nickname: string | null }
}

/** 组件绑定的查询字段（列表整页一次查、详情单条查，共用） */
const COMPONENT_SELECT = {
  agentId: true,
  componentType: true,
  refId: true,
} as const

// ═════════════════════════════════════════════════════════════════════
// 投影
// ═════════════════════════════════════════════════════════════════════

/**
 * 行 + 该行的组件绑定 → 对外形态（**唯一的出口**，见文件头 ② 的"一套投影"）。
 *
 * @param viewer 当前调用者 —— `canEdit` 由 {@link canEditAgent} 现算，不查库也不缓存：
 *   它是给界面用的提示，服务端每次请求都会重新判（把"能不能"与"允不允许"混成一个字段
 *   是最典型的越权来源）。
 */
function toItem(row: AgentRow, components: AgentComponentRef[], viewer: AgentViewer): AgentItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    type: row.type,
    systemPrompt: row.systemPrompt,
    openingRemarks: row.openingRemarks,
    // 读取端一律过唯一入口（jsonb 可能是任何形状，见 shared 的 normalizeGuideQuestions）
    guideQuestions: normalizeGuideQuestions(row.guideQuestions),
    modelId: row.modelId,
    modelName: row.model.modelName,
    modelLabel: row.model.label,
    // 与 `GET /api/models/available` 的过滤同口径（不含 type：绑定时已锁死为 CHAT、且 modelId
    // 改绑也走同一段校验，所以库里不可能出现"绑着 EMBEDDING 模型"的智能体）
    modelAvailable: row.model.enabled && row.model.provider.enabled,
    createdBy: row.createdBy,
    creatorName: row.creator.nickname ?? row.creator.username,
    canEdit: canEditAgent(row, viewer),
    components,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 取单个 Agent 的组件绑定（详情 / 建 / 改用） */
async function componentsOf(agentId: string): Promise<AgentComponentRef[]> {
  const rows = await getPrisma().agentComponent.findMany({
    where: { agentId },
    select: { componentType: true, refId: true },
    // 稳定顺序：前端把这两组分别灌进"知识库多选框 / MCP 多选框"，顺序稳定才不会闪
    orderBy: [{ componentType: 'asc' }, { refId: 'asc' }],
  })
  return rows.map((row) => ({ componentType: row.componentType, refId: row.refId }))
}

// ═════════════════════════════════════════════════════════════════════
// 列表 / 详情
// ═════════════════════════════════════════════════════════════════════

/**
 * 智能体列表（`GET /api/agents`，**全员**，含 `canEdit` 标记）。
 *
 * 排序见文件头 ⑤。`deletedAt: null` 是**所有**查询的默认过滤（`02` §4.4 软删口径）——
 * 这一条如果漏了，软删的智能体会重新出现在首页上，而它对应的详情又是 404，
 * 点进去就是一个死链。
 *
 * 组件绑定用**一次 `findMany` 覆盖整页**再在内存里分组（不是每行一次查询）：
 * 一页 20 条就是 20 次往返，而这里是 1 次。
 */
export async function listAgents(
  query: ListAgentsQuery,
  viewer: AgentViewer,
): Promise<OffsetPage<AgentItem>> {
  const db = getPrisma()
  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照，否则分页器会错位
  const [rows, total] = await db.$transaction([
    db.agent.findMany({
      where: { deletedAt: null },
      select: AGENT_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.agent.count({ where: { deletedAt: null } }),
  ])

  const ids = rows.map((row) => row.id)
  const componentRows =
    ids.length === 0
      ? []
      : await db.agentComponent.findMany({
          where: { agentId: { in: ids } },
          select: COMPONENT_SELECT,
          orderBy: [{ componentType: 'asc' }, { refId: 'asc' }],
        })
  const byAgent = new Map<string, AgentComponentRef[]>()
  for (const row of componentRows) {
    const list = byAgent.get(row.agentId) ?? []
    list.push({ componentType: row.componentType, refId: row.refId })
    byAgent.set(row.agentId, list)
  }

  return {
    items: rows.map((row) => toItem(row, byAgent.get(row.id) ?? [], viewer)),
    total,
    offset: query.offset,
    limit: query.limit,
  }
}

/**
 * 智能体详情（`GET /api/agents/:id`，**全员**，含组件绑定）。
 *
 * 软删的一律 404（见文件头 ②）：给它一个"看起来还能改"的详情页，等于诱导用户去改一条
 * 已作废的记录。历史会话那边显示智能体名靠的是 **join 出来的快照**（`conversations` 的列表
 * 端点自取 `agents.name`，不走本投影、不受 `deleted_at` 过滤）—— 两件事互不冲突。
 *
 * @throws {AppError} `NOT_FOUND`(404)
 */
export async function getAgent(id: string, viewer: AgentViewer): Promise<AgentItem> {
  const db = getPrisma()
  const row = await db.agent.findFirst({
    where: { id, deletedAt: null },
    select: AGENT_SELECT,
  })
  if (row === null) throw AppError.notFound('智能体不存在')
  return toItem(row, await componentsOf(id), viewer)
}

// ═════════════════════════════════════════════════════════════════════
// 绑定模型的可用性校验（文件头 ③）
// ═════════════════════════════════════════════════════════════════════

/**
 * 校验「这个模型现在能不能被智能体绑定」。三条与 `GET /api/models/available?type=CHAT` **同口径**。
 *
 * 三种失败各给**可执行的**文案（而不是甩一个"参数不合法"）：
 *   · 不存在 → 404：多半是模型被删了而前端还拿着旧的下拉数据；
 *   · 类型不符 → 409：把向量模型绑给对话智能体是"选错了"，说清楚两者不可互换；
 *   · 停用（模型或它所属 Provider）→ 409：说清楚"去哪儿能修"，因为用户的出路不同
 *     （前者在模型池里启用这个模型；后者要启用 Provider）。
 *
 * @throws {AppError} `NOT_FOUND`(404) / `CONFLICT`(409)
 */
async function assertChatModelBindable(modelId: string): Promise<void> {
  const db = getPrisma()
  const row = await db.model.findUnique({
    where: { id: modelId },
    select: {
      modelName: true,
      type: true,
      enabled: true,
      provider: { select: { name: true, enabled: true } },
    },
  })
  if (row === null) throw AppError.notFound('模型不存在')

  if (row.type !== 'CHAT') {
    throw AppError.conflict(
      `该模型是向量模型（EMBEDDING），不能绑定到智能体：${row.modelName}。请选择对话模型`,
    )
  }
  if (!row.enabled) {
    throw AppError.conflict(
      `模型已停用，不能绑定：${row.modelName}。请在模型池管理页启用它，或改用其他模型`,
    )
  }
  if (!row.provider.enabled) {
    throw AppError.conflict(
      `该模型所属的 Provider「${row.provider.name}」已停用，不能绑定。` +
        '请启用该 Provider，或改用其他模型',
    )
  }
}

// ═════════════════════════════════════════════════════════════════════
// 建
// ═════════════════════════════════════════════════════════════════════

/**
 * 建智能体（`POST /api/agents`，**全员**）。
 *
 * 顺序有意为之：**先校验模型再落库** —— 否则会先写一行再回滚，"失败也要过一次序列"，
 * 而且并发下会短暂出现一条没有可用模型的记录。
 *
 * `createdBy` 取**会话里的用户**，不接受请求体传入（哪怕将来前端想"代建"）：
 * 创建者直接决定编删权限（`01` 决策 18），让它可被构造等于把权限交给调用方。
 *
 * 名称**不查重**：`agents` 上没有 `name` 唯一约束（`02` §三 未定），同名的两个智能体靠 id 区分。
 * 需要唯一性时应当**先加约束再改代码**，而不是在服务层造一条"看起来唯一、并发下不唯一"的规则
 * （与 `createModelProvider` 同款结论）。
 *
 * @throws {AppError} `NOT_FOUND`(404) / `CONFLICT`(409) 见 {@link assertChatModelBindable}
 */
export async function createAgent(
  input: CreateAgentBody,
  viewer: AgentViewer,
): Promise<AgentItem> {
  const db = getPrisma()
  await assertChatModelBindable(input.modelId)

  const created = await db.agent.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      icon: input.icon ?? null,
      type: input.type,
      systemPrompt: input.systemPrompt ?? null,
      openingRemarks: input.openingRemarks ?? null,
      // 省略时给 `[]`：DB 默认值也是 `[]`，但"新智能体没有引导问题"属于契约，不该藏在迁移里
      // （显式写出来还避免了"Prisma 把 jsonb 的 undefined 当成不写这一列"的歧义）
      guideQuestions: input.guideQuestions ?? [],
      modelId: input.modelId,
      createdBy: viewer.id,
    },
    select: AGENT_SELECT,
  })

  getLogger().info(
    { agentId: created.id, name: created.name, type: created.type, modelId: created.modelId },
    '已创建智能体',
  )
  // 刚建的必然没有组件绑定，不必再查库
  return toItem(created, [], viewer)
}

// ═════════════════════════════════════════════════════════════════════
// 改
// ═════════════════════════════════════════════════════════════════════

/**
 * 改智能体（`PATCH /api/agents/:id`，**创建者或 ADMIN**）。
 *
 * 三条规则，都写在契约里（`shared/src/agent.ts` 的 `updateAgentBodySchema`）而不是这里猜：
 *   · 四个文本字段走**三态**（不带 = 不动 / `null` = 清空 / 值 = 设置）；
 *   · `guideQuestions` 用 `[]` 表达清空（`undefined` = 不动）；
 *   · `type` **可传但不可改**（不同值 → 409）：放进 schema 是为了把静默 no-op 变成显式报错，
 *     传同值放行（前端整表单提交时"没改"不该失败）。
 *
 * 换绑模型只在 **`modelId` 真的变了**时校验（文件头 ④）。
 *
 * 查目标用 `findFirst({ id, deletedAt: null })` 而不是 `findUnique({ id })`：
 * 软删的必须也 404，否则"删除过的东西还能被 PATCH 回来一半"（改完还是查不到，用户一头雾水）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 不存在或已软删 / `FORBIDDEN`(403) 非创建者且非 ADMIN
 *                    / `CONFLICT`(409) 改 type 或换绑的模型不可用
 */
export async function updateAgent(
  id: string,
  input: UpdateAgentBody,
  viewer: AgentViewer,
): Promise<AgentItem> {
  const db = getPrisma()
  const target = await db.agent.findFirst({
    where: { id, deletedAt: null },
    select: AGENT_SELECT,
  })
  if (target === null) throw AppError.notFound('智能体不存在')

  // 先 404 再 403：智能体 id 本来就出现在全员可见的列表里，藏不住也不必藏
  if (!canEditAgent(target, viewer)) {
    throw AppError.forbidden('只有该智能体的创建者或管理员可以修改它')
  }

  if (input.type !== undefined && input.type !== target.type) {
    throw AppError.conflict('智能体类型创建后不可修改。请新建一个智能体')
  }

  if (input.modelId !== undefined && input.modelId !== target.modelId) {
    await assertChatModelBindable(input.modelId)
  }

  const updated = await db.agent.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      // `null` 是"清空"，`undefined` 是"不动" —— 必须用 `!== undefined` 判，不能真值判断
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.icon === undefined ? {} : { icon: input.icon }),
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
      ...(input.openingRemarks === undefined ? {} : { openingRemarks: input.openingRemarks }),
      ...(input.guideQuestions === undefined ? {} : { guideQuestions: input.guideQuestions }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    },
    select: AGENT_SELECT,
  })

  getLogger().info({ agentId: id, changed: Object.keys(input) }, '已更新智能体')
  return toItem(updated, await componentsOf(id), viewer)
}

// ═════════════════════════════════════════════════════════════════════
// 删（软删：三件事一个事务，文件头 ②）
// ═════════════════════════════════════════════════════════════════════

/**
 * 删智能体（`DELETE /api/agents/:id`，**创建者或 ADMIN**）。**软删**，三件事一个事务。
 *
 * 顺序：先 CAS 打软删标记（`where { id, deletedAt: null }`），再解绑组件、再把会话转只读。
 * 把软删放第一步有两个好处：
 *   ① 并发双击删除时，第二条请求的 `count === 0` → 直接 404（此时还没改任何别的东西，
 *      抛错回滚等于什么都没发生，语义干净）；
 *   ② 之后的"解绑 + 转只读"都作用在"已经删除的"那份数据上，不存在"删到一半"的可见中间态。
 *
 * `finishedConversations` 数的是**真的被改的**行（`updateMany` 的 `count`，只含 `ACTIVE`）：
 * 如果一律用 `_count.conversations`，一个已经有 10 个 FINISHED 会话的智能体会回报
 * "影响 10 个会话"，而这次删除其实一个都没改 —— 界面上的级联提示（`03` §七）会吓到用户。
 *
 * ⚠️ 刻意**不删**会话与消息（`02` §4.4 的"只读保留"），也**不删** `agents.model_id` 的引用
 * —— 后者是 `ON DELETE RESTRICT`，软删的 Agent 照样占着那个模型（P0-1-11 的
 * `ModelItem.agentCount` 与删除守卫都是按这个口径数的，刻意不按 `deletedAt` 过滤）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 不存在或**已经**软删 / `FORBIDDEN`(403) 权限不足
 */
export async function removeAgent(
  id: string,
  viewer: AgentViewer,
): Promise<RemoveAgentResult> {
  const db = getPrisma()
  const target = await db.agent.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true, createdBy: true, deletedAt: true },
  })
  if (target === null) throw AppError.notFound('智能体不存在')

  if (!canEditAgent(target, viewer)) {
    throw AppError.forbidden('只有该智能体的创建者或管理员可以删除它')
  }

  const { removedComponents, finishedConversations } = await db.$transaction(async (tx) => {
    const softDeleted = await tx.agent.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    // 并发窗口：查到了但打标记前被另一个请求删掉了
    if (softDeleted.count === 0) throw AppError.notFound('智能体不存在')

    // ⚠️ 这两步不能省：组件绑定是**多态外键、没有 FK 兜底**（`02` §3.1），
    //    留着它会让被绑的知识库永远删不掉（见文件头 ②）
    const removed = await tx.agentComponent.deleteMany({ where: { agentId: id } })
    const finished = await tx.conversation.updateMany({
      where: { agentId: id, status: 'ACTIVE' },
      data: { status: 'FINISHED' },
    })
    return { removedComponents: removed.count, finishedConversations: finished.count }
  })

  getLogger().info(
    { agentId: id, name: target.name, removedComponents, finishedConversations },
    '已删除智能体（软删：组件解绑、会话转只读保留）',
  )
  return { id: target.id, name: target.name, removedComponents, finishedConversations }
}
