/**
 * 智能体服务（P0-1-22 / P0-1-23）
 *
 * 依据：`docs/02-后端设计.md` §4.4（`/api/agents[…/:id]` 六端点）+ §三（`agents` /
 *      `agent_components` 表与删除语义）+ `01` §3.3（功能清单 + 决策 18 权限、决策 7 组件范围）
 *      + `03` §二（路由与权限列）/ §4.2（智能体编辑页）/ §七（级联删除确认框）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的六条口径（①~⑤ 出自 P0-1-22，⑥ 是 P0-1-23 追加的组件绑定口径）
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
 *
 * **⑥ 组件绑定走「整体替换」，且只放行能验证存在的引用（P0-1-23）。**
 *    `PUT /api/agents/:id/components` 收**全量集合**（`02` §4.4："全量提交，避免增量 diff"）：
 *    增量 diff 的差集算错会表现成"点了解绑没生效"或"顺手删掉别人的绑定"，而全量替换的语义
 *    简单到可以一句话说清 —— **提交什么，库里就有什么**（包含顺手清掉手工塞进去的脏行）。
 *    三条：
 *      ① `KNOWLEDGE` 逐条查 `knowledge_bases` 存在性（`ref_id` 是多态外键、**没有 FK 兜底**，
 *         引用完整性只能由服务层负责 —— `kb.service.ts` 文件头 ④ 已把"孤儿绑定"定性为难查的坏法）；
 *      ② `MCP` 逐条查 `mcp_servers` 存在性（**P0-2-2 起**）。⚠️ P0-1-23 时这一条写的是
 *         "一律拒绝 + 文案指向 P0-2"，因为那时 `mcp_servers` 表还不存在 ⇒ 收到的 MCP 引用
 *         必然无从验证。当时的约定就是"**等 P0-2 有了表，把这条换成存在性校验、接口形态不变**"
 *         —— 本批正是那个接回点（见 {@link assertComponentRefsBindable}）；
 *      ③ **集合相同就不写库**（同一份绑定重复提交不产生任何副作用，见 {@link replaceAgentComponents}）。
 *    全程**不动 `agents.updated_at`**（它只是列表排序键，见 ⑤）。
 */

import { appMsg,
  AGENT_NAME_MAX_CHARS,
  AppError,
  audienceIsEmpty,
  assetVisibilityWhere,
  canEditAgent,
  canViewAsset,
  normalizeGuideQuestions,
  normalizeAudienceInput,
  pinnedMcpToolNamesFromConfig,
  type AgentAudience,
  type AgentComponentInput,
  type AgentComponentRef,
  type AgentItem,
  type AssetVisibility,
  type CreateAgentBody,
  type ListAgentsQuery,
  type OffsetPage,
  type RemoveAgentResult,
  type ReplaceAgentComponentsBody,
  type UpdateAgentBody,
  type UserRole,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { broadcastAgentMcpCatalogChange } from '../sandbox/catalogSync.js'
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
  visibility: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  model: { select: { modelName: true, label: true, enabled: true, provider: { select: { enabled: true } } } },
  // 模型池（对话时可选）：一次 join 出来，与 `model`（默认模型）同源。稳定顺序（modelId asc）
  // 让前端多选框/选择器不闪。
  pool: {
    orderBy: { modelId: 'asc' },
    select: {
      modelId: true,
      model: { select: { modelName: true, label: true, enabled: true, provider: { select: { enabled: true } } } },
    },
  },
  creator: { select: { username: true, nickname: true } },
  // P1-18：受众主体（仅 `visibility=SHARED` 时有行；用户/组两类）。回显与编辑用。
  audiences: { select: { subjectType: true, subjectId: true } },
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
  modelId: string | null
  createdBy: string
  visibility: AgentItem['visibility']
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  model: { modelName: string; label: string; enabled: boolean; provider: { enabled: boolean } } | null
  pool: {
    modelId: string
    model: { modelName: string; label: string; enabled: boolean; provider: { enabled: boolean } }
  }[]
  creator: { username: string; nickname: string | null }
  audiences: { subjectType: 'USER' | 'GROUP'; subjectId: string }[]
}

/** 组件绑定的查询字段（列表整页一次查、详情单条查，共用） */
const COMPONENT_SELECT = {
  agentId: true,
  componentType: true,
  refId: true,
  // P1-19：常驻工具存在这里（`{ pinnedMcpTools: [...] }`），装配与回显都要它
  config: true,
} as const

// ═════════════════════════════════════════════════════════════════════
// 投影
// ═════════════════════════════════════════════════════════════════════

/**
 * 解析调用者所属的**组 id 集合**（P1-18；`SHARED` 受众命中判据需要）。
 *
 * 一次查询（`user_group_members` 按 `userId` 取 `groupId`）。`canViewAsset` / `assetVisibilityWhere`
 * 都靠它判"viewer 是否落在某个组的受众里"。ADMIN 不必解析（它对全部资产可见），但解析也无害 ——
 * 调用方自行决定是否跳过。
 */
async function resolveViewerGroupIds(viewer: AgentViewer): Promise<string[]> {
  const rows = await getPrisma().userGroupMember.findMany({
    where: { userId: viewer.id },
    select: { groupId: true },
  })
  return rows.map((row) => row.groupId)
}

/**
 * 把若干 Agent 行的受众主体 **批量**解析成带名字的 {@link AgentAudience}（一次查用户表、一次查组表）。
 *
 * 为什么批量：列表页一页 20 条，逐条查名字就是 N+1（P0-1-22 对组件绑定已经立过同款规矩）。
 * 返回 `Map<agentId, AgentAudience>`（无受众的 Agent 不在 map 里，调用方 `?? emptyAudience()`）。
 */
async function loadAudiences(
  rows: { id: string; audiences: { subjectType: 'USER' | 'GROUP'; subjectId: string }[] }[],
): Promise<Map<string, AgentAudience>> {
  const userIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const row of rows) {
    for (const a of row.audiences) {
      if (a.subjectType === 'USER') userIds.add(a.subjectId)
      else groupIds.add(a.subjectId)
    }
  }
  if (userIds.size === 0 && groupIds.size === 0) return new Map()

  const db = getPrisma()
  const [users, groups] = await Promise.all([
    userIds.size === 0
      ? Promise.resolve([])
      : db.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, username: true, nickname: true },
        }),
    groupIds.size === 0
      ? Promise.resolve([])
      : db.userGroup.findMany({
          where: { id: { in: [...groupIds] } },
          select: { id: true, name: true },
        }),
  ])
  const userName = new Map(users.map((u) => [u.id, u.nickname ?? u.username]))
  const groupName = new Map(groups.map((g) => [g.id, g.name]))

  const out = new Map<string, AgentAudience>()
  for (const row of rows) {
    const usersList: AgentAudience['users'] = []
    const groupsList: AgentAudience['groups'] = []
    for (const a of row.audiences) {
      if (a.subjectType === 'USER') {
        const name = userName.get(a.subjectId)
        // 指向已硬删用户的孤儿行：读取端**跳过**（不因脏行 500，与 normalizeGuideQuestions 同族口径）
        if (name !== undefined) usersList.push({ id: a.subjectId, name })
      } else {
        const name = groupName.get(a.subjectId)
        if (name !== undefined) groupsList.push({ id: a.subjectId, name })
      }
    }
    out.set(row.id, { users: usersList, groups: groupsList })
  }
  return out
}

/** 空受众（非 `SHARED` / 无受众行的 Agent） */
function emptyAudience(): AgentAudience {
  return { users: [], groups: [] }
}

/**
 * 行 + 该行的组件绑定 + 受众 → 对外形态（**唯一的出口**，见文件头 ② 的"一套投影"）。
 *
 * @param viewer 当前调用者 —— `canEdit` 由 {@link canEditAgent} 现算，不查库也不缓存：
 *   它是给界面用的提示，服务端每次请求都会重新判（把"能不能"与"允不允许"混成一个字段
 *   是最典型的越权来源）。
 * @param audience 受众回显（由 {@link loadAudiences} 批量解析后传入；非 `SHARED` 传空）
 */
function toItem(
  row: AgentRow,
  components: AgentComponentRef[],
  viewer: AgentViewer,
  audience: AgentAudience,
): AgentItem {
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
    modelName: row.model?.modelName ?? null,
    modelLabel: row.model?.label ?? null,
    // 与 `GET /api/models/available` 的过滤同口径（不含 type：绑定时已锁死为 CHAT、且 modelId
    // 改绑也走同一段校验，所以库里不可能出现"绑着 EMBEDDING 模型"的智能体）。
    // **未绑定模型**（被删模型商/删模型解绑后 model 为 null）恒为 false —— 前端据此提示重新绑定。
    modelAvailable: row.model !== null && row.model.enabled && row.model.provider.enabled,
    // 模型池投影：与默认模型同口径算 available（停用的留在池里、置灰，不凭空消失）。
    // ⚠️ P1-18：Provider 无可见性 ⇒ **不按可见性过滤池**（能用这个 Agent 就能用它的池；
    // 池里的 Provider 通过"你能用的 Agent"被揭示）。
    models: row.pool.map((entry) => ({
      modelId: entry.modelId,
      modelName: entry.model.modelName,
      modelLabel: entry.model.label,
      available: entry.model.enabled && entry.model.provider.enabled,
    })),
    createdBy: row.createdBy,
    creatorName: row.creator.nickname ?? row.creator.username,
    visibility: row.visibility,
    audience,
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
    select: { componentType: true, refId: true, config: true },
    // 稳定顺序：前端把这两组分别灌进"知识库多选框 / MCP 多选框"，顺序稳定才不会闪
    orderBy: [{ componentType: 'asc' }, { refId: 'asc' }],
  })
  return rows.map((row) => toComponentRef(row))
}

/**
 * 组件行 → 读侧投影（P1-19：把 `config.pinnedMcpTools` 摊成 `pinnedToolNames`）。
 * 抽取成一处，免得"列表一次查、详情单条查"两条路径各拼一次而漂移。
 */
function toComponentRef(row: {
  componentType: AgentComponentRef['componentType']
  refId: string
  config: unknown
}): AgentComponentRef {
  // 常驻工具只对 MCP 有意义；KNOWLEDGE 行即使 config 里有键也忽略
  if (row.componentType !== 'MCP') return { componentType: row.componentType, refId: row.refId }
  const pinned = pinnedMcpToolNamesFromConfig(row.config)
  return {
    componentType: row.componentType,
    refId: row.refId,
    ...(pinned.length === 0 ? {} : { pinnedToolNames: pinned }),
  }
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
  // P1-18：列表按"对我可见"过滤（`PUBLIC` + 我的 + `SHARED` 且受众命中我；ADMIN 见全部）。软删恒排除。
  // 受众含组 ⇒ 先解析调用者的组集合，再拼 `where`（见 `assetVisibilityWhere`）。
  const groupIds = await resolveViewerGroupIds(viewer)
  const where = {
    deletedAt: null,
    ...assetVisibilityWhere({ ...viewer, groupIds }, { withAudience: true }),
  }
  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照，否则分页器会错位
  const [rows, total] = await db.$transaction([
    db.agent.findMany({
      where,
      select: AGENT_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.agent.count({ where }),
  ])

  const ids = rows.map((row) => row.id)
  const [componentRows, audiences] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db.agentComponent.findMany({
          where: { agentId: { in: ids } },
          select: COMPONENT_SELECT,
          orderBy: [{ componentType: 'asc' }, { refId: 'asc' }],
        }),
    loadAudiences(rows),
  ])
  const byAgent = new Map<string, AgentComponentRef[]>()
  for (const row of componentRows) {
    const list = byAgent.get(row.agentId) ?? []
    list.push(toComponentRef(row))
    byAgent.set(row.agentId, list)
  }

  return {
    items: rows.map((row) =>
      toItem(row, byAgent.get(row.id) ?? [], viewer, audiences.get(row.id) ?? emptyAudience()),
    ),
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
  if (row === null) throw AppError.notFound(appMsg('app.m000'))
  // P1-18：私有/指定用户 Agent 对受众外的人**404**（不泄漏存在性）—— 与列表过滤同判据（`canViewAsset`）
  const groupIds = await resolveViewerGroupIds(viewer)
  if (
    !canViewAsset(
      {
        ownerId: row.createdBy,
        visibility: row.visibility,
        deletedAt: row.deletedAt,
        ...audienceHitOf(row),
      },
      { ...viewer, groupIds },
    )
  ) {
    throw AppError.notFound(appMsg('app.m000'))
  }
  const audiences = await loadAudiences([row])
  return toItem(row, await componentsOf(id), viewer, audiences.get(row.id) ?? emptyAudience())
}

/** 从行的受众主体里抽 `canViewAsset` 需要的两个 id 集合 */
function audienceHitOf(row: { audiences: { subjectType: 'USER' | 'GROUP'; subjectId: string }[] }): {
  audienceUserIds: string[]
  audienceGroupIds: string[]
} {
  return {
    audienceUserIds: row.audiences.filter((a) => a.subjectType === 'USER').map((a) => a.subjectId),
    audienceGroupIds: row.audiences.filter((a) => a.subjectType === 'GROUP').map((a) => a.subjectId),
  }
}

/** 归一化后的受众 → `agent_audiences` 待写行（服务层唯一入口） */
function audienceRows(audience: { userIds: string[]; groupIds: string[] }): {
  subjectType: 'USER' | 'GROUP'
  subjectId: string
}[] {
  return [
    ...audience.userIds.map((id) => ({ subjectType: 'USER' as const, subjectId: id })),
    ...audience.groupIds.map((id) => ({ subjectType: 'GROUP' as const, subjectId: id })),
  ]
}

/**
 * 校验受众主体存在：用户须为 `ACTIVE`、组须存在 —— 否则 **400**（指明是哪一类不存在）。
 *
 * ⚠️ `agent_audiences.subject_id` 是**多态外键、无 FK**（同 `agent_components.ref_id`）：写进去
 * 一个不存在的 id，就是一条"永远命不中任何人"的受众行（用户界面上却显示"已选 1 个组"）。
 * 所以这里**必须先查再写**，把静默的脏行变成显式报错。
 */
async function assertAudienceSubjectsExist(audience: { userIds: string[]; groupIds: string[] }): Promise<void> {
  const db = getPrisma()
  const [users, groups] = await Promise.all([
    audience.userIds.length === 0
      ? Promise.resolve([])
      : db.user.findMany({
          where: { id: { in: audience.userIds }, status: 'ACTIVE' },
          select: { id: true },
        }),
    audience.groupIds.length === 0
      ? Promise.resolve([])
      : db.userGroup.findMany({ where: { id: { in: audience.groupIds } }, select: { id: true } }),
  ])
  const missingUsers = audience.userIds.filter((id) => !users.some((u) => u.id === id))
  if (missingUsers.length > 0) {
    throw AppError.validation(appMsg('app.m114', { p0: missingUsers.join('、') }))
  }
  const missingGroups = audience.groupIds.filter((id) => !groups.some((g) => g.id === id))
  if (missingGroups.length > 0) {
    throw AppError.validation(appMsg('app.m115', { p0: missingGroups.join('、') }))
  }
}

// ═════════════════════════════════════════════════════════════════════
// 绑定模型的可用性校验（文件头 ③）
// ═════════════════════════════════════════════════════════════════════

/**
 * 校验「这些模型现在能不能被智能体绑定」。三条与 `GET /api/models/available?type=CHAT` **同口径**。
 *
 * 一次 `findMany` 查全部（不是逐个 `await`），再逐个给**可执行的**文案：
 *   · 不存在 → 404：多半是模型被删了而前端还拿着旧的下拉数据；
 *   · 类型不符 → 409：把向量模型绑给对话智能体是"选错了"，说清楚两者不可互换；
 *   · 停用（模型或它所属 Provider）→ 409：说清楚"去哪儿能修"，因为用户的出路不同
 *     （前者在模型池里启用这个模型；后者要启用 Provider）。
 *
 * 用于建/改智能体时校验**默认模型 + 模型池**里"新引入"的每一个模型（未变的不重校，见文件头 ④）。
 *
 * @throws {AppError} `NOT_FOUND`(404) / `CONFLICT`(409)
 */
async function assertChatModelsBindable(modelIds: string[], viewer: AgentViewer): Promise<void> {
  const unique = [...new Set(modelIds)]
  if (unique.length === 0) return

  const rows = await getPrisma().model.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      modelName: true,
      type: true,
      enabled: true,
      provider: {
        select: {
          name: true,
          enabled: true,
          createdBy: true,
        },
      },
    },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))

  for (const id of unique) {
    const row = byId.get(id)
    if (row === undefined) throw AppError.notFound(appMsg('app.m116', { p0: id }))
    if (row.type !== 'CHAT') {
      throw AppError.conflict(appMsg('app.m117', { p0: row.modelName }),
      )
    }
    if (!row.enabled) {
      throw AppError.conflict(appMsg('app.m118', { p0: row.modelName }),
      )
    }
    if (!row.provider.enabled) {
      throw AppError.conflict(appMsg('app.m262', { p0: row.provider.name }),
      )
    }
    // P1-18：Provider 无可见范围、无定向分享 ⇒ 绑定时要求**我对该 Provider 有权使用**
    // （所属人 / ADMIN）。别人私有的 Provider 我绑不了（要复用请让对方把**引用它的 Agent** 分享给我）。
    const usable = viewer.role === 'ADMIN' || row.provider.createdBy === viewer.id
    if (!usable) {
      throw AppError.notFound(appMsg('app.m119', { p0: row.modelName }))
    }
  }
}

/** 两个字符串集合是否相等（与顺序无关）—— 判"模型池有没有变" */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((item) => set.has(item))
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
  // 模型池：省略 `modelIds` 时按 `[modelId]` 建池（向后兼容单模型）。默认模型恒为池成员
  // （schema 已在"同时给了两者"时校验；只给 modelId 时这里补进去）。
  const pool = [...new Set(input.modelIds ?? [input.modelId])]
  if (!pool.includes(input.modelId)) pool.push(input.modelId)
  await assertChatModelsBindable(pool, viewer)

  // P1-18：可见范围（可省 ⇒ PRIVATE 安全默认）+ 受众（仅 SHARED 允许）。
  // ⚠️ 取消可见性闭包：建为 PUBLIC/SHARED **不再**校验引用的组件是否公开（新建无组件，且组件随
  // Agent 受众可用，见 `assetAcl` 文件头 ①）。
  const visibility: AssetVisibility = input.visibility ?? 'PRIVATE'
  const audience = normalizeAudienceInput(input.audience)
  if (visibility === 'SHARED') {
    if (audienceIsEmpty(audience)) {
      throw AppError.validation(appMsg('app.m006'))
    }
    await assertAudienceSubjectsExist(audience)
  } else if (!audienceIsEmpty(audience)) {
    throw AppError.validation(appMsg('app.m017'))
  }

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
      visibility,
      // 受众一并落库（仅 SHARED；嵌套 create，agentId 由关系自动填）
      ...(visibility === 'SHARED' ? { audiences: { create: audienceRows(audience) } } : {}),
      // 模型池一并落库（嵌套 create，agentId 由关系自动填）
      pool: { create: pool.map((modelId) => ({ modelId })) },
    },
    select: AGENT_SELECT,
  })

  getLogger().info(
    {
      agentId: created.id,
      name: created.name,
      type: created.type,
      modelId: created.modelId,
      poolSize: pool.length,
      visibility,
      audienceSize: audience.userIds.length + audience.groupIds.length,
    },
    '已创建智能体',
  )
  // 刚建的必然没有组件绑定，不必再查库；受众回显按已写入的受众反查（拿到显示名）
  const audiences = await loadAudiences([created])
  return toItem(created, [], viewer, audiences.get(created.id) ?? emptyAudience())
}

// ═════════════════════════════════════════════════════════════════════
// 复制（P1-2）
// ═════════════════════════════════════════════════════════════════════

/** 复制体的名字后缀（`01` §3.3「复制 Agent」的默认命名） */
const COPY_NAME_SUFFIX = '（副本）'

/**
 * 复制体的名字：原名 + 「（副本）」；原名过长时**截断原名**，保证总长不超过 `AGENT_NAME_MAX_CHARS`。
 *
 * 只截原名不截后缀：后缀是"这是一份副本"的唯一标记，截了它反而与原件分不清。
 */
function copyNameOf(sourceName: string): string {
  const max = AGENT_NAME_MAX_CHARS - COPY_NAME_SUFFIX.length
  const base = sourceName.length > max ? sourceName.slice(0, Math.max(0, max)) : sourceName
  return `${base}${COPY_NAME_SUFFIX}`
}

/**
 * 复制智能体（`POST /api/agents/:id/copy`，**登录即可**；P1-2）。
 *
 * 「含组件绑定整份拷贝」：新行逐字沿用源的全部可配置字段（描述 / 图标 / 类型 / 系统提示词 /
 * 开场白 / 引导问题 / 默认模型 / 模型池）+ 组件绑定；**只改两处** —— `name`（加「（副本）」）
 * 与 `createdBy`（= 调用者）。复制体**归调用者**，因此他随后可自由编辑/删除它。
 *
 * 三条口径（都与"看起来该怎么做"不同，各有理由）：
 *  ① **不要求源可编辑**（`canEditAgent` 不用）：`GET /api/agents/:id` 本来就对全员开放、
 *     详情**含系统提示词** ⇒ 复制不泄露任何"看不到"的东西；而语义是"以别人建好的智能体为模板
 *     起一个自己的副本"，把权限收成 `canEdit` 会让"复制"变成"只有作者能复制"（`01` §3.3 没这条）。
 *  ② **模型与组件逐字照搬、不重新校验**：源在库里的样子就是它当下的真实状态（模型被停用/被删时
 *     外键已把它解绑或清空池行）。若照 `createAgent` 那样 `assertChatModelsBindable`，会出现
 *     "源里某个模型事后被停用 ⇒ 连复制都失败" —— 而用户要的只是"照着它拷一份"。
 *  ③ **建 agent / 落模型池 / 落组件在同一事务**：复制要么整份成功，要么一行都不建（不留半份）。
 *
 * 名称**不查重**（与 {@link createAgent} 同款：`agents` 上没有 `name` 唯一约束），
 * 多次复制得到多个「xxx（副本）」由 id 区分。
 *
 * @throws {AppError} `NOT_FOUND`(404) 源不存在或已软删
 */
export async function copyAgent(id: string, viewer: AgentViewer): Promise<AgentItem> {
  const db = getPrisma()
  const source = await db.agent.findFirst({
    where: { id, deletedAt: null },
    select: AGENT_SELECT,
  })
  if (source === null) throw AppError.notFound(appMsg('app.m000'))

  const pool = source.pool.map((entry) => entry.modelId)
  const components = await componentsOf(id)

  const created = await db.$transaction(async (tx) => {
    const agent = await tx.agent.create({
      data: {
        name: copyNameOf(source.name),
        description: source.description,
        icon: source.icon,
        type: source.type,
        systemPrompt: source.systemPrompt,
        openingRemarks: source.openingRemarks,
        // 经唯一入口归一（jsonb 可能是任何形状）后再落库
        guideQuestions: normalizeGuideQuestions(source.guideQuestions),
        modelId: source.modelId,
        createdBy: viewer.id,
        pool: { create: pool.map((modelId) => ({ modelId })) },
      },
      select: AGENT_SELECT,
    })
    if (components.length > 0) {
      await tx.agentComponent.createMany({
        data: components.map((ref) => ({
          agentId: agent.id,
          componentType: ref.componentType,
          refId: ref.refId,
          config: componentConfigOf(ref.pinnedToolNames),
        })),
      })
    }
    return agent
  })

  getLogger().info(
    {
      agentId: created.id,
      copiedFrom: id,
      name: created.name,
      poolSize: pool.length,
      componentCount: components.length,
    },
    '已复制智能体（含模型池与组件绑定）',
  )
  return toItem(created, components, viewer, emptyAudience())
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
  if (target === null) throw AppError.notFound(appMsg('app.m000'))

  // 先 404 再 403：智能体 id 本来就出现在全员可见的列表里，藏不住也不必藏
  if (!canEditAgent(target, viewer)) {
    throw AppError.forbidden(appMsg('app.m120'))
  }

  if (input.type !== undefined && input.type !== target.type) {
    throw AppError.conflict(appMsg('app.m121'))
  }

  // ── 模型池 / 默认模型的换绑（文件头 ④：只校验"新引入"的模型；未变的不重校）──
  const currentPool = target.pool.map((entry) => entry.modelId)
  const newPoolInput = input.modelIds === undefined ? undefined : [...new Set(input.modelIds)]
  const defaultChanged = input.modelId !== undefined && input.modelId !== target.modelId
  const effectiveDefault = input.modelId ?? target.modelId

  // 计算生效的池：给了 modelIds 用它，否则沿用现有池；并保证默认模型是池成员
  // （只改默认模型、没给池时，把新默认模型并入池 —— 选了新默认就意味着它该可用）。
  let effectivePool = newPoolInput ?? currentPool
  if (effectiveDefault !== null && !effectivePool.includes(effectiveDefault)) {
    effectivePool = [...effectivePool, effectiveDefault]
  }

  // 只校验"新引入"的模型：新池里的全部（整体替换）+ 换绑的新默认模型
  const toValidate = new Set<string>()
  if (newPoolInput !== undefined) newPoolInput.forEach((id) => toValidate.add(id))
  if (defaultChanged && input.modelId !== undefined) toValidate.add(input.modelId)
  await assertChatModelsBindable([...toValidate], viewer)

  const poolChanged = !sameStringSet(currentPool, effectivePool)

  // P1-18：可见范围 × 受众（合并库里现状后判定）。**取消可见性闭包** —— 改 `PUBLIC`/`SHARED`
  // 不再校验引用的组件是否公开（组件随 Agent 受众可用，见 `assetAcl` 文件头 ①）。
  const nextVisibility: AssetVisibility = input.visibility ?? target.visibility
  const currentAudience = {
    userIds: target.audiences.filter((a) => a.subjectType === 'USER').map((a) => a.subjectId),
    groupIds: target.audiences.filter((a) => a.subjectType === 'GROUP').map((a) => a.subjectId),
  }
  let nextAudience = currentAudience
  let audienceChanged = false
  if (input.audience !== undefined) {
    if (nextVisibility !== 'SHARED') {
      throw AppError.validation(appMsg('app.m017'))
    }
    const normalized = normalizeAudienceInput(input.audience)
    if (audienceIsEmpty(normalized)) {
      throw AppError.validation(appMsg('app.m006'))
    }
    await assertAudienceSubjectsExist(normalized)
    nextAudience = normalized
    audienceChanged =
      !sameStringSet(currentAudience.userIds, normalized.userIds) ||
      !sameStringSet(currentAudience.groupIds, normalized.groupIds)
  } else if (nextVisibility === 'SHARED') {
    // 改为/已是 SHARED 但本次没给受众 ⇒ 沿用现有；若现有为空则拒绝（不变量：SHARED 必须非空）
    if (audienceIsEmpty(currentAudience)) {
      throw AppError.validation(appMsg('app.m006'))
    }
  } else if (!audienceIsEmpty(currentAudience)) {
    // 改成非 SHARED ⇒ 清空受众
    audienceChanged = true
  }

  const updated = await db.$transaction(async (tx) => {
    await tx.agent.update({
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
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      },
    })
    // 受众有变化才重写（整体替换：删旧行 + 建新行）—— 没变则一行都不动
    if (audienceChanged) {
      await tx.agentAudience.deleteMany({ where: { agentId: id } })
      if (nextVisibility === 'SHARED') {
        await tx.agentAudience.createMany({
          data: audienceRows(nextAudience).map((row) => ({ agentId: id, ...row })),
          skipDuplicates: true,
        })
      }
    }
    // 池有变化才重写（整体替换：删旧行 + 建新行）—— 没变则一行都不动，避免无谓刷新 created_at
    if (poolChanged) {
      await tx.agentModel.deleteMany({ where: { agentId: id } })
      await tx.agentModel.createMany({
        data: effectivePool.map((modelId) => ({ agentId: id, modelId })),
        skipDuplicates: true,
      })
    }
    return tx.agent.findUniqueOrThrow({ where: { id }, select: AGENT_SELECT })
  })

  getLogger().info(
    {
      agentId: id,
      changed: Object.keys(input),
      poolChanged,
      poolSize: effectivePool.length,
      audienceChanged,
      visibility: nextVisibility,
    },
    '已更新智能体',
  )
  const audiences = await loadAudiences([updated])
  return toItem(updated, await componentsOf(id), viewer, audiences.get(updated.id) ?? emptyAudience())
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
 * ⚠️ 刻意**不删**会话与消息（`02` §4.4 的"只读保留"）。但**会把 `agents.model_id` 置空**
 * （P0 优化）：软删后这个智能体不该再被算作"占用着某个模型"，否则模型/Provider 会一直显示
 * "被绑定、删不掉"。置空后模型的引用计数与删除守卫自然只剩在线智能体（见
 * `model.service.ts` 的 `countBindingAgents`）。列 `model_id` 现在可空（`onDelete: SetNull`），
 * 所以这一步是合法的。
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
  if (target === null) throw AppError.notFound(appMsg('app.m000'))

  if (!canEditAgent(target, viewer)) {
    throw AppError.forbidden(appMsg('app.m122'))
  }

  const { removedComponents, finishedConversations } = await db.$transaction(async (tx) => {
    const softDeleted = await tx.agent.updateMany({
      where: { id, deletedAt: null },
      // 打软删标记的同时解绑模型（model_id 置空）：软删的智能体不该再占用模型（见文件头/上方注释）
      data: { deletedAt: new Date(), modelId: null },
    })
    // 并发窗口：查到了但打标记前被另一个请求删掉了
    if (softDeleted.count === 0) throw AppError.notFound(appMsg('app.m000'))

    // ⚠️ 这两步不能省：组件绑定是**多态外键、没有 FK 兜底**（`02` §3.1），
    //    留着它会让被绑的知识库永远删不掉（见文件头 ②）
    const removed = await tx.agentComponent.deleteMany({ where: { agentId: id } })
    // 模型池同理清空：软删的智能体不该再"占用"任何模型（默认模型已由上面的 modelId=null 解绑，
    // 池成员行也要一并删掉，否则删模型的守卫会把一个已"没了"的智能体算进引用计数）。
    await tx.agentModel.deleteMany({ where: { agentId: id } })
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

// ═════════════════════════════════════════════════════════════════════
// 转移所属人（P1-13，`子方案` §3.5）
// ═════════════════════════════════════════════════════════════════════

/**
 * 转移智能体所属人（`POST /api/agents/:id/transfer`，**所属人或 ADMIN**）。
 *
 * 口径（`子方案` §3.5）：`toUserId` 必须是 `ACTIVE` 用户；**不能转给自己**（已是所属人 ⇒ 400）；
 * **不需要接收方确认**（用户 2026-10-16 定案）。转移后 `createdBy` 改为新所属人，权限随新所属人。
 *
 * @throws {AppError} `NOT_FOUND`(404) / `FORBIDDEN`(403) / `VALIDATION`(400)
 */
export async function transferAgent(
  id: string,
  toUserId: string,
  viewer: AgentViewer,
): Promise<AgentItem> {
  const db = getPrisma()
  const target = await db.agent.findFirst({ where: { id, deletedAt: null }, select: AGENT_SELECT })
  if (target === null) throw AppError.notFound(appMsg('app.m000'))
  if (!canEditAgent(target, viewer)) {
    throw AppError.forbidden(appMsg('app.m123'))
  }
  if (toUserId === target.createdBy) {
    throw AppError.validation(appMsg('app.m124'))
  }
  const newOwner = await db.user.findUnique({
    where: { id: toUserId },
    select: { id: true, status: true },
  })
  if (newOwner === null || newOwner.status !== 'ACTIVE') {
    throw AppError.validation(appMsg('app.m011'))
  }

  const updated = await db.agent.update({
    where: { id },
    data: { createdBy: toUserId },
    select: AGENT_SELECT,
  })
  getLogger().info(
    { agentId: id, from: target.createdBy, to: toUserId },
    '已转移智能体所属人',
  )
  const audiences = await loadAudiences([updated])
  return toItem(updated, await componentsOf(id), viewer, audiences.get(updated.id) ?? emptyAudience())
}

// ═════════════════════════════════════════════════════════════════════
// 组件绑定（写侧：整体替换，P0-1-23；口径见文件头 ⑥）
// ═════════════════════════════════════════════════════════════════════

/**
 * 集合键 —— 与 `agent_components` 的 `@@unique([agentId, componentType, refId])` 同一口径。
 *
 * 拼字符串而不是嵌套 Map/Set：绑定集合的规模是个位数，可读性比"省几次字符串拼接"重要；
 * 而"两条绑定相同"这件事在**整个服务层只有这一个定义**，不会出现两处判等各自漂移。
 */
function componentKey(component: { componentType: string; refId: string }): string {
  return `${component.componentType}:${component.refId}`
}

/** 与 {@link componentsOf} 的 `orderBy` 同序（`componentType asc, refId asc`）—— 写库顺序与读取顺序一致 */
function compareComponents(
  a: { componentType: string; refId: string },
  b: { componentType: string; refId: string },
): number {
  if (a.componentType !== b.componentType) return a.componentType < b.componentType ? -1 : 1
  if (a.refId !== b.refId) return a.refId < b.refId ? -1 : 1
  return 0
}

/** 两个绑定集合是否**完全相同**（与顺序无关；条数相同且逐条能对上，**含常驻工具集合**） */
function sameComponentSet(a: AgentComponentRef[], b: AgentComponentInput[]): boolean {
  if (a.length !== b.length) return false
  const byKey = new Map(a.map((item) => [componentKey(item), toNameSet(item.pinnedToolNames)]))
  return b.every((item) => {
    const existing = byKey.get(componentKey(item))
    if (existing === undefined) return false
    return sameNameSet(existing, toNameSet(item.pinnedToolNames))
  })
}

/** `pinnedToolNames`（可缺省）→ 集合（判等与写库共用；缺省 = 空集） */
function toNameSet(names: readonly string[] | undefined): Set<string> {
  return new Set(names ?? [])
}

/** 两个字符串集合是否相等（P1-19 常驻工具判等用；与顺序无关） */
function sameNameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

/**
 * 组件绑定的 `config`（P1-19：只装常驻工具）。**空 ⇒ `undefined`**（不写该列，保持 NULL）——
 * 与 `guideQuestions` 用 `[]` 表达清空不同：这里的"没有常驻"就是"没有 config"。
 */
function componentConfigOf(
  pinnedToolNames: readonly string[] | undefined,
): { pinnedMcpTools: string[] } | undefined {
  return pinnedToolNames === undefined || pinnedToolNames.length === 0
    ? undefined
    : { pinnedMcpTools: [...pinnedToolNames] }
}

/**
 * 校验"这批引用能不能落库"。**两道，且都在写库之前**（见 {@link replaceAgentComponents} 的顺序）。
 *
 * ① **两类引用都逐条查存在性**：`ref_id` 是多态外键、**刻意没有 FK**（`02` §3.1），
 *    数据库不会拦 —— 引用完整性只能由这一层负责。查不到就整体拒绝（`02` §4.4 的坑预判：
 *    "引用不存在的 KB 必须拒绝而非静默丢弃"）：静默丢弃会让"我提交了 3 个库"变成
 *    "库里只有 2 个"而用户以为自己选上了。文案里带上具体 id，前端 `message.error` 能直接说清。
 *
 *    ⚠️ **`MCP` 分支的保质期到了（P0-2-2 接回）**：P0-1-23 时它写的是"一律 400 + 文案指向 P0-2"
 *    —— 那时 `mcp_servers` 表还不存在，收到的 MCP 引用**必然**是伪造或过期的 uuid，
 *    而放行等于往库里写"永远修不好的孤儿绑定"。本批 `mcp_servers` 落地 ⇒ 按当时的约定
 *    换成**存在性校验**，**接口形态一个字没变**（仍是 `PUT …/components` 里的一次校验、
 *    失败仍是标准的错误信封）。`verify:agents` 与 `verify:agent-package` 里那两条
 *    "含 MCP ⇒ 400 且文案指向 P0-2"的对偶断言**已同步翻转**。
 *
 * ② **一次 `Promise.all` 查两张表**（而不是两次 `await` 串行）：两条查询互不依赖，
 *    串行只是白等一个 RTT。刻意**不用 `$transaction`** —— 存在性校验不需要快照一致性
 *    （真在两次查询之间被删掉的行，会在写库时撞外键/留下引用，那是另一个量级的问题，
 *    并且 `replaceAgentComponents` 的"校验在写之前"不变式管的是它自己那次校验的时序）。
 *
 * ⚠️ 刻意**不校验**知识库的"有没有文档 / 是否可检索"，也**不校验** MCP server 的
 *    "通不通 / 有没有工具"：那是检索层与调用层的事（`02` §八 的 `vectorPathSkipped`、
 *    `tool_call{ERROR}` 负责表达），绑一个还没传文档的库、或一个暂时连不上的 server
 *    都**完全合法**（刚建好、马上要传文档 / 那个 server 只是此刻在重启）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 引用的知识库或 MCP server 不存在
 */
async function assertComponentRefsBindable(
  components: AgentComponentInput[],
  viewer: AgentViewer,
): Promise<void> {
  // 去重后再查：同一批里"同一个目标"最多查一次（payload 内的重复项已由 schema 拦掉，这里只防重复查询）
  const refIdsOf = (type: AgentComponentInput['componentType']): string[] => [
    ...new Set(components.filter((item) => item.componentType === type).map((item) => item.refId)),
  ]
  const knowledgeIds = refIdsOf('KNOWLEDGE')
  const mcpIds = refIdsOf('MCP')
  if (knowledgeIds.length === 0 && mcpIds.length === 0) return

  const db = getPrisma()
  const viewerGroupIds = await resolveViewerGroupIds(viewer)
  const [kbRows, mcpRows] = await Promise.all([
    knowledgeIds.length === 0
      ? Promise.resolve([])
      : db.knowledgeBase.findMany({
          where: { id: { in: knowledgeIds } },
          select: { id: true, name: true, createdBy: true, visibility: true },
        }),
    mcpIds.length === 0
      ? Promise.resolve([])
      : db.mcpServer.findMany({
          where: { id: { in: mcpIds } },
          select: { id: true, name: true, createdBy: true, visibility: true },
        }),
  ])

  const missingKb = knowledgeIds.filter((refId) => !kbRows.some((row) => row.id === refId))
  if (missingKb.length > 0) {
    throw AppError.notFound(appMsg('app.m125', { p0: missingKb.join('、') }))
  }
  const missingMcp = mcpIds.filter((refId) => !mcpRows.some((row) => row.id === refId))
  if (missingMcp.length > 0) {
    throw AppError.notFound(appMsg('app.m126', { p0: missingMcp.join('、') }))
  }

  // P1-18：**取消可见性闭包** —— 不再要求"公开 Agent 只能引用公开组件"。
  // 唯一保留的写时判据：**绑定时只能选"对我可见"的组件**（公开 / 我的）。这保护的是"绑的人自己"
  // （看不到的东西不该出现在他的多选框里），而不是"受众"；组件一旦被绑上，就随 Agent 受众可用
  // （想收回组件 = 从 Agent 解绑）。
  const viewerForAsset = { ...viewer, groupIds: viewerGroupIds }
  const notVisible: string[] = []
  for (const kb of kbRows) {
    if (!canViewAsset({ ownerId: kb.createdBy, visibility: kb.visibility }, viewerForAsset)) {
      notVisible.push(`知识库《${kb.name}》`)
    }
  }
  for (const mcp of mcpRows) {
    if (!canViewAsset({ ownerId: mcp.createdBy, visibility: mcp.visibility }, viewerForAsset)) {
      notVisible.push(`MCP server《${mcp.name}》`)
    }
  }
  if (notVisible.length > 0) {
    throw AppError.notFound(appMsg('app.m127', { p0: notVisible.join('、') }))
  }
}

/**
 * 整体替换组件绑定（`PUT /api/agents/:id/components`，**创建者或 ADMIN**）。
 *
 * `02` §4.4 原文："整体替换（全量提交，避免增量 diff）"。语义一句话：
 * **提交什么，库里就有什么** —— 包括"提交集合里没有的行会被删掉"，因此手工塞进库的脏行
 * （比如 P0-1-22 的验收脚本直接 `createMany` 造的那条 MCP）会在下一次保存时被清干净。
 *
 * 顺序（**每一环的位置都有理由**）：
 *   ① 查目标（`deletedAt: null`）→ 404：软删的连详情都 404，不该能改。
 *   ② 判权限（`canEditAgent`）→ 403：**先 404 再 403**，与 `PATCH` 同口径（id 本来就全员可见）。
 *   ③ **校验引用 → 再写库**：校验失败**必须**发生在 `deleteMany` 之前。
 *      反过来的实现（先删后校验）在"引用不存在"这条路上会**把原有绑定删光再报错**，
 *      用户重试时看到的是"我的绑定没了"——而请求是失败的，他没有任何理由认为它改动了什么。
 *      验收里专门有一条盯着它：校验失败后库里那几行的 `id` 必须**逐字不变**。
 *   ④ **集合相同则不写库**（`02` §4.4 的"绑定即启用"没有别的副作用要发生）：
 *      保存按钮每次都发 `PUT`（`03` §4.2 第 5 条：`PATCH` + `PUT` 串行），若每次都删了重建，
 *      `agent_components.id`（uuid7）与 `created_at` 会被无谓刷新 —— 那是"看不见的改写"，
 *      P0-1-10 已经为同类问题立过规矩（"P0-1-10 就靠「密文逐字不变」抓住了这类实现"）。
 *   ⑤ 写库在**一个事务**里（`deleteMany` + `createMany`）：中途失败不会留下"删了没建"的空绑定。
 *      `createMany({ skipDuplicates: true })`（`ON CONFLICT DO NOTHING`）只针对**并发**：
 *      两个同时到达的相同 `PUT` 会在插入时撞唯一索引，跳过即得正确结果，
 *      而不会把一次双击变成一个 500。payload 内的重复项由 schema 拦（`superRefine`），
 *      所以这里的"跳过"不会掩盖调用方的错误。
 *   ⑥ 重新读行再返回（不是复用 ① 读到的行）：响应要反映**库里现在的样子**，
 *      与详情/列表同一套投影（P0-1-21 的教训：同一份数据不许有第二种形状）。
 *
 * ⚠️ 刻意**不动 `agents.updated_at`**（文件头 ⑤ / `06` P0-1-23 坑预判）：它只是 `/api/agents`
 * 的列表排序键，而"解绑一个知识库"跟"编辑智能体"是两件事 —— 动了它，用户会看到
 * "列表自己跳了一下"。验收里有一条断言 `updated_at` **逐字不变**守着。
 *
 * @throws {AppError} `NOT_FOUND`(404) 智能体不存在或已软删 / 引用的知识库或 MCP server 不存在
 *                    / `FORBIDDEN`(403) 非创建者且非 ADMIN
 */
export async function replaceAgentComponents(
  id: string,
  input: ReplaceAgentComponentsBody,
  viewer: AgentViewer,
): Promise<AgentItem> {
  const db = getPrisma()
  const target = await db.agent.findFirst({
    where: { id, deletedAt: null },
    select: AGENT_SELECT,
  })
  if (target === null) throw AppError.notFound(appMsg('app.m000'))

  if (!canEditAgent(target, viewer)) {
    throw AppError.forbidden(appMsg('app.m128'))
  }

  // 归一化顺序：写库顺序 = 读取端 `componentsOf` 的顺序（同序让"行 id 的先后"也稳定，
  // 便于用"id 逐字不变"取证，见 ④）
  const desired = [...input.components].sort(compareComponents)

  // ③ 校验在写之前（P1-18：绑定时只允许选"对我可见"的组件；**不再**有公开/私有两类分支的闭包校验）
  await assertComponentRefsBindable(desired, viewer)

  const current = await componentsOf(id)
  if (!sameComponentSet(current, desired)) {
    await db.$transaction(async (tx) => {
      await tx.agentComponent.deleteMany({ where: { agentId: id } })
      if (desired.length > 0) {
        await tx.agentComponent.createMany({
          data: desired.map((item) => ({
            agentId: id,
            componentType: item.componentType,
            refId: item.refId,
            config: componentConfigOf(item.pinnedToolNames),
          })),
          skipDuplicates: true,
        })
      }
    })
    getLogger().info(
      { agentId: id, from: current.length, to: desired.length },
      '已整体替换智能体组件绑定',
    )
    // ★ P1-21：绑定变了 ⇒ 给**这个 Agent 名下活着的会话**重发工具清单（容器下一次派活时
    //   会看到指纹不一致、注入 `/doubulea:mcp-refresh`，于是新绑的 MCP / 知识库**不用重建会话**）。
    //   写在事务**之后**、且异步不等待（尽力而为）：广播失败只影响"要不要等下次容器重建"，
    //   而写库本身必须已经成功。
    void broadcastAgentMcpCatalogChange(id).catch((error: unknown) => {
      getLogger().warn({ err: error, agentId: id }, '工具清单广播失败（派活前仍会兜底比对）')
    })
  } else {
    // ⑤ 没有变化时不写库（这句日志是"确实没写"的可观测痕迹，验收靠行 id 取证，不靠它）
    getLogger().info({ agentId: id, count: desired.length }, '组件绑定未变化，不写库')
  }

  // ⑥ 重读（极短窗口内被并发软删的话，按"不存在"回 —— 与详情口径一致）
  const fresh = await db.agent.findFirst({ where: { id, deletedAt: null }, select: AGENT_SELECT })
  if (fresh === null) throw AppError.notFound(appMsg('app.m000'))
  const audiences = await loadAudiences([fresh])
  return toItem(fresh, await componentsOf(id), viewer, audiences.get(fresh.id) ?? emptyAudience())
}
