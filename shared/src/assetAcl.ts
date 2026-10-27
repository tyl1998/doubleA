/**
 * 资产所属人、可见范围与受众（P1-13 初版 + **P1-18 重设计**；`子方案/资产共享与用户组标签.md`）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 授权**跟着使用路径走**（P1-18 的核心定案）
 * ─────────────────────────────────────────────────────────────────────
 * 资产 = Agent / 知识库（KnowledgeBase）/ MCP Server / 模型池 Provider（其下 Model 随 Provider）。
 * 本文件是这套判据的**唯一实现**（`06` §六 的"唯一来源"纪律）：后端路由、服务层、前端（拿到
 * `createdBy`/`visibility`/`canEdit` 后各自算按钮显隐）**都读它**，不允许各写一份。
 *
 * 一句话定案：**Agent 是唯一的共享单位**。模型只能通过某个 Agent 被使用、组件（KB/MCP）也是
 * 通过 Agent 被使用 ⇒ "谁能用这个 Agent"就决定了"谁能用它的组件与模型"。因此：
 *   · **Provider 没有可见范围**（去掉 `visibility`/`provider_shares`）：**读 = 全体登录用户**
 *     （Provider/Model 即"平台模型池"，人人可见、只读）；**写（编/删/转移/建模型）= 所属人 + ADMIN**。
 *     他人能否用到它的模型，看"他能不能用引用它的那个 Agent"。
 *   · **组件（KB/MCP）不参与独立判定**：通过 Agent 被使用时，授权来自 **Agent 的受众**，
 *     与组件自身可见范围无关（**取消可见性闭包**）。只想让别人**独立发现并复用**组件时，
 *     才用组件自己的 `PUBLIC` 把它放进公共池。收回组件 = **从 Agent 解绑**。
 *   · **没有写时闭包**：把 Agent 改成 `PUBLIC`/`SHARED` 不再校验引用；公开/指定用户 Agent 引用
 *     私有组件或共享 Key 的 Provider = **自愿共享，仅提示不拦**。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 三类可见范围 + Agent 受众
 * ─────────────────────────────────────────────────────────────────────
 * | 档位 | 含义 | 适用资产 |
 * |------|------|----------|
 * | `PRIVATE`（私有） | 仅**所属人**（+ ADMIN） | Agent / 知识库 / MCP |
 * | `SHARED`（指定用户） | 所属人 + **受众**（用户/组圈定的人）+ ADMIN | **Agent / 知识库** |
 * | `PUBLIC`（公开） | 全部登录用户（+ ADMIN） | Agent / 知识库 / MCP |
 *
 * 受众 = 若干**受众主体**的**并集**：直接指定的用户 ∪ 指定组的成员。
 * `SHARED` 资产的可见性判据见 {@link canViewAsset}；列表过滤见 {@link assetVisibilityWhere}。
 * **MCP** 只接受 `PRIVATE`/`PUBLIC`（{@link KB_MCP_VISIBILITIES}），服务层/契约拒绝 `SHARED`；
 * ⚠️ 知识库 **2026-10-16 起也支持 `SHARED`**（受众表 `knowledge_base_audiences`）—— 它与 Agent 一致三档。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 权限矩阵（唯一判据）
 * ─────────────────────────────────────────────────────────────────────
 * | 操作 | 所属人 | ADMIN | 其它登录用户 |
 * |------|--------|-------|-------------|
 * | 看/列表可见（Agent/KB/MCP） | 自己的全部（含私有） | 全部 | `PUBLIC`；`SHARED` 且在受众内 |
 * | 用（对话用 Agent；KB/MCP 绑到**自己的** Agent；KB 直接检索） | 自己的全部 | 全部 | 同上 |
 * | **经某个我能用的 Agent 使用其组件/模型** | 允许 | 允许 | **允许**（授权来自该 Agent） |
 * | 编/删/改可见范围/转移 | 自己的 | 全部 | 禁止（403） |
 * | 看 Provider（含其模型） | 全部 | 全部 | 全部（平台模型池人人可见、只读） |
 * | 编/删/转移 Provider（含建模型） | 自己的 | 全部 | 禁止（403） |
 *
 * · **私有资产对他人 = 404**（不泄漏存在性）；**存在但无编删权 = 403**。
 * · **ADMIN 对资产全权**（资产是协作对象）—— 与 `mcp_credentials` 的"ADMIN 也无后门"**不同族**。
 * · **`createdBy` 即所属人**（复用列名，语义由"创建者"扩为"所属人"）。
 */

import { z } from 'zod'

import { validationMessage } from './i18n/validation.js'

import type { MessageKey } from './i18n/index.js'
import { type UserRole } from './auth.js'

// ───────────────────────────── 取值域 ─────────────────────────────

/** 可见性取值域（与 `schema.prisma` 的 `enum AssetVisibility` 逐字一致） */
export const ASSET_VISIBILITIES = ['PRIVATE', 'SHARED', 'PUBLIC'] as const
export type AssetVisibility = (typeof ASSET_VISIBILITIES)[number]

/** **MCP server** 只支持两档：`私有 / 公开`（不接受 `SHARED`）。
 *  ⚠️ 知识库 2026-10-16 起支持三档（用 {@link ASSET_VISIBILITIES}），已**不再**复用本常量。 */
export const KB_MCP_VISIBILITIES = ['PRIVATE', 'PUBLIC'] as const
export type KbMcpVisibility = (typeof KB_MCP_VISIBILITIES)[number]

/** 可见性的中文名（列表徽标 / 下拉 / 错误文案共用一处，避免各处自己拼） */
export const ASSET_VISIBILITY_LABELS: Readonly<Record<AssetVisibility, string>> = {
  PRIVATE: '私有',
  SHARED: '指定用户',
  PUBLIC: '公开',
}

/**
 * 可见性 → i18n key（P1-23：前端据此取译文；**中文那份 {@link ASSET_VISIBILITY_LABELS} 保留**
 * 给后端与其它中文消费方用，见 `子方案/界面语言切换.md` §3.5）。
 */
export const ASSET_VISIBILITY_KEY: Readonly<Record<AssetVisibility, MessageKey>> = {
  PRIVATE: 'label.visibility.PRIVATE',
  SHARED: 'label.visibility.SHARED',
  PUBLIC: 'label.visibility.PUBLIC',
}

/** 受众主体类型（与 `schema.prisma` 的 `enum AudienceSubjectType` 逐字一致） */
export const AUDIENCE_SUBJECT_TYPES = ['USER', 'GROUP'] as const
export type AudienceSubjectType = (typeof AUDIENCE_SUBJECT_TYPES)[number]

/** 管理员角色的字面量（与 `agent.ts#ADMIN_ROLE` / `mcp.ts` 同款：`shared` 里刻意各写一份） */
const ADMIN_ROLE: UserRole = 'ADMIN'

// ───────────────────────────── 判据（唯一实现） ─────────────────────────────

/** 调用者（`AuthContext['user']` 的结构子集：判权需要 id + role + 解析好的**组集合**） */
export interface AssetViewer {
  id: string
  role: UserRole
  /**
   * 调用者所属的**组 id 集合**（由服务层解析一次后传入；`canViewAsset` / `assetVisibilityWhere`
   * 靠它判 `SHARED` 的组受众命中）。省略 = 不在任何组。
   */
  groupIds?: readonly string[]
}

/** 判「看 / 用」所需的最小字段（`ownerId` = 所属人 id，即 `createdBy`） */
export interface AssetVisibilitySubject {
  ownerId: string
  visibility: AssetVisibility
  /**
   * 软删标记（**仅 agents 有**）。`null` / `undefined` = 未删除。
   * 已软删的行对谁都不"可见/可编辑"（它连详情都 404）。
   */
  deletedAt?: Date | string | null
  /**
   * 受众命中信息（**仅 `SHARED` 的 Agent 需要**，由服务层解析后传入）：直接指定的用户 id 与组 id。
   * 非 `SHARED` 资产可省略。
   */
  audienceUserIds?: readonly string[]
  audienceGroupIds?: readonly string[]
}

/** 判「编 / 删 / 转移」所需的最小字段（与可见性无关 —— 私有/公开都不改变所属人的编删权） */
export interface AssetOwnershipSubject {
  ownerId: string
  deletedAt?: Date | string | null
}

function isSoftDeleted(subject: { deletedAt?: Date | string | null }): boolean {
  return subject.deletedAt !== undefined && subject.deletedAt !== null
}

/**
 * 「这个资产对该调用者是否**可见/可用**」—— 判"看/用"的唯一实现。
 *
 * 四条（或关系）：
 *   · **ADMIN 一律可见**（资产层的后门，刻意保留）；
 *   · **所属人本人可见**（含私有）；
 *   · **`PUBLIC` 全员可见**；
 *   · **`SHARED` 命中受众**（viewer.id ∈ 指定用户，或 viewer 的组 ∩ 指定组 ≠ ∅）。
 * ⚠️ 已软删 ⇒ **一律不可见**（`agents` 软删后详情 404）。
 */
export function canViewAsset(subject: AssetVisibilitySubject, viewer: AssetViewer): boolean {
  if (isSoftDeleted(subject)) return false
  if (viewer.role === ADMIN_ROLE) return true
  if (subject.ownerId === viewer.id) return true
  if (subject.visibility === 'PUBLIC') return true
  if (subject.visibility === 'SHARED') return matchesAudience(subject, viewer)
  return false
}

/** `SHARED` 受众命中判据（并集语义：直接用户 ∪ 组内成员） —— {@link canViewAsset} 的内部分支 */
function matchesAudience(subject: AssetVisibilitySubject, viewer: AssetViewer): boolean {
  if (subject.audienceUserIds?.includes(viewer.id)) return true
  const viewerGroups = viewer.groupIds
  if (viewerGroups !== undefined && viewerGroups.length > 0 && subject.audienceGroupIds !== undefined) {
    return subject.audienceGroupIds.some((group) => viewerGroups.includes(group))
  }
  return false
}

/**
 * 「这个资产对该调用者是否**可编辑/可删除/可转移/可改可见范围**」—— 判"编/删/转移"的唯一实现。
 *
 * 两条（或关系）：**ADMIN 一律可以**、**所属人本人可以**。已软删 ⇒ 一律不可（见文件头）。
 * ⚠️ 与 {@link canViewAsset} 刻意分开：可见性**不影响**编删权（公开资产他人仍不可编删 → 403）。
 */
export function canEditAsset(subject: AssetOwnershipSubject, viewer: AssetViewer): boolean {
  if (isSoftDeleted(subject)) return false
  if (viewer.role === ADMIN_ROLE) return true
  return subject.ownerId === viewer.id
}

/**
 * 「这个资产对该调用者是否**可转移所属人**」—— 与 {@link canEditAsset} **同判据**
 * （转移是"编"的一种：仅所属人 / ADMIN）。
 *
 * 单独留一个名字是为了让调用点读起来是它要做的事（转移），而不是"编辑权限"；
 * 实现**必须**委托给 {@link canEditAsset}，不允许另写一份（否则两者迟早漂移）。
 */
export function canTransferAsset(subject: AssetOwnershipSubject, viewer: AssetViewer): boolean {
  return canEditAsset(subject, viewer)
}

/** {@link assetVisibilityWhere} 的可选参数 */
export interface AssetVisibilityWhereOptions {
  /** 所属人列名（默认 `createdBy`） */
  ownerField?: string
  /**
   * 是否并上 `SHARED` 受众分支。**Agent / 知识库为 true**（两者都有 `audiences` 关系）；
   * **MCP 无受众（两档）** ⇒ 保持 false，否则会引用不存在的关联。
   */
  withAudience?: boolean
}

/**
 * 构造"列表按对我可见过滤"的 Prisma `where` 片段（服务层**唯一**的可见性过滤来源）。
 *
 * · ADMIN ⇒ 空对象（见全部）；
 * · 其它 ⇒ `PUBLIC` / 我的 并上（`withAudience` 时）`SHARED` 且受众命中我的行：
 *   ```
 *   { OR: [
 *       { visibility: 'PUBLIC' },
 *       { [ownerField]: viewer.id },
 *       { visibility: 'SHARED', audiences: { some: { subjectType: 'USER', subjectId: viewer.id } } },
 *       // 组分支仅在 viewer 有组时并上（避免 `in: []`）
 *   ] }
 *   ```
 *
 * ⚠️ 返回的是**普通对象**（`shared` 不依赖 Prisma 类型），调用方把它展开进 `where` 即可。
 * ⚠️ Provider **不用**本函数 —— 它没有可见范围：**读 = 全体登录用户**（平台模型池，不加过滤）、
 * 写 = 所属人 + ADMIN（各写入口用 {@link canEditAsset} 逐行判）。
 */
export function assetVisibilityWhere(
  viewer: AssetViewer,
  options: AssetVisibilityWhereOptions = {},
): Record<string, unknown> {
  if (viewer.role === ADMIN_ROLE) return {}
  const ownerField = options.ownerField ?? 'createdBy'
  const or: Record<string, unknown>[] = [
    { visibility: 'PUBLIC' },
    { [ownerField]: viewer.id },
  ]
  if (options.withAudience === true) {
    or.push({
      visibility: 'SHARED',
      audiences: { some: { subjectType: 'USER', subjectId: viewer.id } },
    })
    const groupIds = viewer.groupIds ?? []
    if (groupIds.length > 0) {
      or.push({
        visibility: 'SHARED',
        audiences: { some: { subjectType: 'GROUP', subjectId: { in: [...groupIds] } } },
      })
    }
  }
  return { OR: or }
}

// ───────────────────────────── 受众（写侧契约） ─────────────────────────────

/** 受众主体的一个**引用**（读侧回显：id + 显示名） */
export const audienceSubjectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type AudienceSubjectRef = z.infer<typeof audienceSubjectRefSchema>

/** Agent 的受众（读侧回显：分 用户 / 组 两类） */
export const agentAudienceSchema = z.object({
  users: z.array(audienceSubjectRefSchema),
  groups: z.array(audienceSubjectRefSchema),
})
export type AgentAudience = z.infer<typeof agentAudienceSchema>

/**
 * Agent 受众的**写侧输入**（`visibility=SHARED` 时随 Agent 建/改一起提交）。
 *
 * · `userIds` / `groupIds` 都是可选数组，服务层用 `Set` 去重（重复项最多是前端多选了一次）；
 * · 『`SHARED` 至少一个主体非空、非 `SHARED` 不得给』这条跨字段约束由 Agent 的
 *   create/update schema 用 `superRefine` 拦（见 `agent.ts`），不在这里判（这里看不到 `visibility`）。
 */
export const agentAudienceInputSchema = z.object({
  userIds: z.array(z.string().uuid(validationMessage('validation.assetAcl.audienceUserIdNotUuid'))).optional(),
  groupIds: z.array(z.string().uuid(validationMessage('validation.assetAcl.audienceGroupIdNotUuid'))).optional(),
})
export type AgentAudienceInput = z.infer<typeof agentAudienceInputSchema>

/** 归一化受众输入（去重；缺省 → 空数组）。服务层唯一入口 */
export function normalizeAudienceInput(
  input: AgentAudienceInput | undefined,
): { userIds: string[]; groupIds: string[] } {
  return {
    userIds: [...new Set(input?.userIds ?? [])],
    groupIds: [...new Set(input?.groupIds ?? [])],
  }
}

/** 受众是否为空（`SHARED` 至少要有一个主体） */
export function audienceIsEmpty(audience: { userIds: readonly string[]; groupIds: readonly string[] }): boolean {
  return audience.userIds.length === 0 && audience.groupIds.length === 0
}

// ───────────────────────────── 转移所属人（写侧契约，四资产共用） ─────────────────────────────

/**
 * `POST /api/{asset}/:id/transfer` 请求体：`{ toUserId }`。
 *
 * 口径（`子方案` §3.5）：权限 = 仅**所属人 / ADMIN**；`toUserId` 必须是 `ACTIVE` 用户；
 * **不能转给自己**（服务层判，见各 service 的 `transferXxx`）。**不需要接收方确认**（用户 2026-10-16 定案）。
 */
export const transferAssetBodySchema = z.object({
  toUserId: z
    .string({ required_error: validationMessage('validation.assetAcl.recipientRequired') })
    .uuid(validationMessage('validation.assetAcl.recipientIdNotUuid')),
})
export type TransferAssetBody = z.infer<typeof transferAssetBodySchema>

/** 转移所属人成功的响应：回**更新后的资产**（同一套投影）。四资产各自用自己的 item schema。 */
