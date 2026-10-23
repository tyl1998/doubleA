/**
 * 开放平台 Key 管理服务（**P1-22**；`docs/08-开放平台-智能体OpenAPI(APIKey).md` §8「管理面」）
 *
 * 依据：`docs/08` §4.1（表）/ §8（三条管理端点与权限）/ R1・R2・R3（谁能给自己签、ADMIN 的代建）
 *      + `shared/src/openApi.ts`（契约与派生判据）+ `shared/src/assetAcl.ts`（能不能看见这个 Agent）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 判权：**"这把 Key 是不是我的" + "这个智能体我能不能看见"**（2026-10-22 改按人）
 * ─────────────────────────────────────────────────────────────────────
 * 管理面**按人**组织（入口在「我的凭据」），因为 Key 的主语是「人 × 智能体」：
 *   · **列表** `/api/open-keys`：只看**自己名下**的（`user_id = 我`）。别人给我看过什么智能体、
 *     他们自己签了什么 Key —— 不是我该看见的东西（也省掉"这把 Key 是谁的"这类困惑）。
 *     ADMIN 也**没有**越权列举（代建出来的 Key 归目标用户，但列表仍是"我名下的"；需要排查时走库/日志）。
 *   · **签发** `POST /api/open-keys`：`agentId` 在请求体里。判据 = `canViewAsset(agent, 我)`
 *     （所属人 / ADMIN / `SHARED` 受众是"受众给自己签"，R3 —— 这正是允许的）+ 目标用户是我
 *     （ADMIN 可显式 `userId` 代建，R2）。
 *   · **吊销** `DELETE /api/open-keys/:keyId`：Key 是**我的**（或我是 ADMIN）；别人的 Key 一律 404
 *     （不泄漏存在性）。
 *   · **编辑** `PUT /api/open-keys/:keyId`（2026-10-22 追加）：判据与吊销相同（Key 是**我的**，
 *     或 ADMIN；别人的 404）；**不**复判"绑的 Agent 我还能不能看见"（理由同吊销：改自己的东西
 *     不该因为别人转移/收窄了可见范围而失败）；已吊销 ⇒ 409（终态不可编辑，反悔 = 重签）。
 *
 * ⚠️ 为什么不挂在智能体上（`/api/agents/:id/open-keys`，2026-10-22 前的形态）：那个路径读起来像
 * "这个智能体的 Key"，而实际语义是"**我的**、给这个智能体的 Key"—— 编辑页上出现它会让
 * 其他受众以为"点一下就能用"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 明文只在**创建**那一刻返回一次，库里只有 sha256；**元数据可编辑，值与归属不可变**
 * ─────────────────────────────────────────────────────────────────────
 * `generateOpenApiKeyPlaintext`（`plugins/openAuth.ts`）生成 → 立刻 `sha256` → 落库 → 明文随响应返回。
 * 之后任何出口（列表/详情/编辑/吊销）都拿不到它。
 *
 * ⚠️ 编辑（2026-10-22 追加，用户定案）：**能改的是策略字段**（name / scopes / expiresAt / 限额 /
 * 自动审批 —— 都是明文存的），**不能改的是身份**（明文值、`agentId`、`userId`）——
 * 值只有哈希谈不上改；换关联智能体等于换会话池，走"吊销 + 重签"。
 * 早期口径"改 scope 也是吊销 + 新建"自此作废：轮换只该发生在**值**上，不该逼用户为了续个期
 * 把外部系统里嵌的 Key 全部换一遍。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ "吊销 / 改配置"必须**主动删缓存键**，否则最长 60s 内旧结论仍有效
 * ─────────────────────────────────────────────────────────────────────
 * 鉴权链第 ③ 步缓存的是 `open:key:{sha256}`（`plugins/openAuth.ts`）。吊销只改库不删键的后果
 * 很具体：客户点了"吊销"、以为立刻断了，而外部还能再调 60 秒 —— `docs/08` §4.4 把这一条写成
 * "吊销立即 401"，实现就是这里那次 `DEL`。
 */

import {
  AppError,
  canViewAsset,
  isConversationReadOnly,
  openApiKeyStatusOf,
  type AssetVisibility,
  type CreateOpenApiKeyBody,
  type CreateOpenApiKeyResult,
  type ListOpenApiKeysResult,
  type OpenApiKeyItem,
  type RevokeOpenApiKeyResult,
  type UpdateOpenApiKeyBody,
  type UserRole,
} from '@doubulea/shared'

import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ensureRedisConnected, openApiKeyCacheKey } from '../infra/redis.js'
import { generateOpenApiKeyPlaintext, hashOpenApiKey } from '../plugins/openAuth.js'
import { groupIdsOfUser } from './userGroup.service.js'

/** 管理面的调用者（内部 Cookie 会话；与 `AgentViewer` 同形） */
export interface OpenKeyViewer {
  id: string
  role: UserRole
}

/** 管理面关心的 Agent 字段（行级判权的输入） */
const AGENT_ACL_SELECT = {
  id: true,
  createdBy: true,
  visibility: true,
  deletedAt: true,
  audiences: { select: { subjectType: true, subjectId: true } },
} as const

type AgentAclRow = {
  id: string
  createdBy: string
  visibility: AssetVisibility
  deletedAt: Date | null
  audiences: { subjectType: 'USER' | 'GROUP'; subjectId: string }[]
}

/** 读一个 Agent 的判权字段；**软删的 Agent 也读出来**（400/404 的结论不同，见 {@link assertAgentVisible}） */
async function readAgentAcl(agentId: string): Promise<AgentAclRow | null> {
  return getPrisma().agent.findUnique({ where: { id: agentId }, select: AGENT_ACL_SELECT })
}

/** `canViewAsset` 的入参（受众解析成两个 id 列表） */
async function viewerOf(viewer: OpenKeyViewer): Promise<{ id: string; role: UserRole; groupIds: string[] }> {
  return { id: viewer.id, role: viewer.role, groupIds: await groupIdsOfUser(viewer.id) }
}

/**
 * Agent 存在且我能看见（否则 404 —— 与资产族同口径：**不泄漏存在性**）。
 * 软删的 Agent：对它来说"派发 Key"没有意义（外部调不到），按 404 处理。
 */
async function assertAgentVisible(agentId: string, viewer: OpenKeyViewer): Promise<AgentAclRow> {
  const agent = await readAgentAcl(agentId)
  if (agent === null || agent.deletedAt !== null) throw AppError.notFound('智能体不存在')
  const resolved = await viewerOf(viewer)
  const visible = canViewAsset(
    {
      ownerId: agent.createdBy,
      visibility: agent.visibility,
      deletedAt: agent.deletedAt,
      audienceUserIds: agent.audiences.filter((a) => a.subjectType === 'USER').map((a) => a.subjectId),
      audienceGroupIds: agent.audiences.filter((a) => a.subjectType === 'GROUP').map((a) => a.subjectId),
    },
    resolved,
  )
  if (!visible) throw AppError.notFound('智能体不存在')
  return agent
}

/** 库里那一行 → 对外投影（**永不含明文**；`status` 现算，不用缓存） */
function toItem(row: {
  id: string
  agentId: string
  userId: string
  name: string
  keyPrefix: string
  keySuffix: string
  scopes: string[]
  expiresAt: Date | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  allowAutoApprove: boolean
  confirmTimeoutSec: number | null
  maxConcurrency: number | null
  rateLimitPerMin: number | null
  dailyTokenLimit: number | null
  createdBy: string
  createdAt: Date
  user: { username: string; nickname: string | null }
  agent: { name: string; type: 'CHATBOT' | 'TASK_AGENT' }
}): OpenApiKeyItem {
  return {
    id: row.id,
    agentId: row.agentId,
    // 关联的智能体名/类型：列表要能回答"这把 Key 是给谁签的"，以及"它现在能不能调通"（非 CHATBOT ⇒ 403）
    agentName: row.agent.name,
    agentType: row.agent.type,
    userId: row.userId,
    userName: row.user.nickname ?? row.user.username,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keySuffix: row.keySuffix,
    scopes: row.scopes.filter((scope): scope is OpenApiKeyItem['scopes'][number] =>
      scope === 'chat' || scope === 'conversation:read' || scope === 'conversation:write',
    ),
    status: openApiKeyStatusOf(row),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    allowAutoApprove: row.allowAutoApprove,
    confirmTimeoutSec: row.confirmTimeoutSec,
    maxConcurrency: row.maxConcurrency,
    rateLimitPerMin: row.rateLimitPerMin,
    dailyTokenLimit: row.dailyTokenLimit,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

const KEY_SELECT = {
  id: true,
  agentId: true,
  userId: true,
  name: true,
  keyPrefix: true,
  keySuffix: true,
  scopes: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  allowAutoApprove: true,
  confirmTimeoutSec: true,
  maxConcurrency: true,
  rateLimitPerMin: true,
  dailyTokenLimit: true,
  createdBy: true,
  createdAt: true,
  user: { select: { username: true, nickname: true } },
  agent: { select: { name: true, type: true } },
} as const

/**
 * 列表：**我名下的 Key**（可按 `agentId` 过滤），含已过期/已吊销。
 *
 * 为什么默认连失效的一起列：界面要能回答"外部为什么进不来"—— 看不到那把已吊销的 Key，
 * 就只能靠猜。`includeInactive=false` 是给"这个智能体我现在还有没有有效入口"这类窄查询留的口。
 *
 * 排序 `createdAt desc, id desc`：最近签的在最上面（轮换 Key 的典型动作）；
 * 副键 `id` 保证确定性（同一毫秒签两把时顺序不会抖）。
 */
export async function listOpenApiKeys(
  query: { agentId?: string; includeInactive: boolean },
  viewer: OpenKeyViewer,
): Promise<ListOpenApiKeysResult> {
  const rows = await getPrisma().apiKey.findMany({
    where: {
      // **只列自己的**：ADMIN 也不越权（见文件头 ①）
      userId: viewer.id,
      ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
      ...(query.includeInactive ? {} : { revokedAt: null }),
    },
    select: KEY_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  // `includeInactive=false` 时"过期"这一种失效是**派生**的（库里没标记），所以在这里再滤一次
  const items = rows.map(toItem)
  return { items: query.includeInactive ? items : items.filter((item) => item.status === 'ACTIVE') }
}

/**
 * 签发。
 *
 * 三处刻意：
 *   · `userId` 的落点见文件头 ①（ADMIN 可代建；MEMBER 传了也忽略）；
 *   · `scopes` 缺省 = **全选**（§6.3「默认全选」）；显式 `[]` 会被 schema 的 `.min(1)` 拦掉 ——
 *     "一把没有 scope 的 Key"与"停用"看不出区别，不提供这个形态；
 *   · `expiresAt` 必须是**未来时刻**（过去时刻等于签一把立刻失效的 Key —— 那是操作失误，
 *     400 比"签出来就不能用"更早暴露问题）。
 *
 * ⚠️ **不校验 Agent 是不是 CHATBOT**：`docs/08` Q9 的结论是"外部调不通"（403 `NOT_OPENABLE`），
 * 而不是"签不出来" —— 让所属人先把 Key 备好、等放开 TaskAgent 时直接可用，比事后补签更顺。
 */
export async function createOpenApiKey(
  body: CreateOpenApiKeyBody,
  viewer: OpenKeyViewer,
): Promise<CreateOpenApiKeyResult> {
  // `agentId` 从**体里**来（2026-10-22：管理面按人组织，见文件头 ①）。
  // 204 判据只有一处：`assertAgentVisible`（看不见 ⇒ 404，与资产族同口径）。
  const agentId = body.agentId
  await assertAgentVisible(agentId, viewer)

  // R1 / R2 / R3：**只有 ADMIN 能指定别人的 userId**（R2 的代建）；其余人 `userId` 恒为自己。
  // ⇒ 不存在的空子："MEMBER 给自己的 Key 挂到别人的 Agent 上"在结构上不可能（目标用户就是他自己，
  // 而"能不能看到这个 Agent"已由 assertAgentVisible 判过 —— 受众给自己签 Key 正是 R3 允许的那条）。
  const targetUserId =
    viewer.role === 'ADMIN' && body.userId !== undefined ? body.userId : viewer.id
  if (targetUserId !== viewer.id) {
    const target = await getPrisma().user.findUnique({ where: { id: targetUserId }, select: { id: true } })
    if (target === null) throw AppError.validation('userId 指向的用户不存在')
  }
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null ? null : new Date(body.expiresAt)
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    throw AppError.validation('过期时间不是合法的时间')
  }
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw AppError.validation('过期时间必须晚于当前时刻')
  }

  const plaintext = generateOpenApiKeyPlaintext()
  const keyHash = hashOpenApiKey(plaintext)
  const created = await getPrisma().apiKey.create({
    data: {
      agentId,
      userId: targetUserId,
      name: body.name,
      keyPrefix: plaintext.slice(0, plaintext.indexOf('_') + 1 + 8),
      keyHash,
      keySuffix: plaintext.slice(-4),
      scopes: body.scopes === undefined ? ['chat', 'conversation:read', 'conversation:write'] : body.scopes,
      expiresAt,
      allowAutoApprove: body.allowAutoApprove ?? true,
      confirmTimeoutSec: body.confirmTimeoutSec ?? null,
      maxConcurrency: body.maxConcurrency ?? null,
      rateLimitPerMin: body.rateLimitPerMin ?? null,
      dailyTokenLimit: body.dailyTokenLimit ?? null,
      createdBy: viewer.id,
    },
    select: KEY_SELECT,
  })

  getLogger().info(
    { openKeyId: created.id, agentId, userId: targetUserId, createdBy: viewer.id, scopes: created.scopes },
    '已签发开放平台 API Key（明文只在本响应中出现一次）',
  )
  return { ...toItem(created), plaintext }
}

/**
 * 吊销（**幂等**：重复吊销回 `revoked:true`，不把 404/409 当成用户的错）。
 *
 * 判据：Key 是**我的**（或我是 ADMIN）。别人的 Key 一律 404 —— 不泄漏"有这么一把 Key"。
 * ⚠️ 不再校验"这个 Key 绑的 Agent 我还能不能看见"：吊销自己的东西不该因为别人转移/收窄了
 * 可见范围而失败（那是"我更该能把它停掉"而不是"我不能动"）。
 *
 * ★ **必须删缓存键**：见文件头 ③。
 */
export async function revokeOpenApiKey(
  keyId: string,
  viewer: OpenKeyViewer,
): Promise<RevokeOpenApiKeyResult> {
  const db = getPrisma()
  const row = await db.apiKey.findFirst({
    where: { id: keyId },
    select: { id: true, agentId: true, userId: true, keyHash: true, revokedAt: true },
  })
  if (row === null) throw AppError.notFound('API Key 不存在')
  if (row.userId !== viewer.id && viewer.role !== 'ADMIN') throw AppError.notFound('API Key 不存在')

  if (row.revokedAt === null) {
    await db.apiKey.update({ where: { id: row.id }, data: { revokedAt: new Date() } })
    getLogger().info(
      { openKeyId: row.id, agentId: row.agentId, by: viewer.id },
      '已吊销开放平台 API Key',
    )
  }
  // 吊销与"重复吊销"都要删 —— 键可能被上一次的旧快照重新写回来（TTL 内），删一次最省心
  await dropOpenKeyCache(row.keyHash)
  return { id: row.id, revoked: true }
}

/**
 * 编辑元数据（**合并语义**：体里缺省的字段保持原值；2026-10-22 追加，见文件头 ②）。
 *
 * 判据与吊销同族（文件头 ①）：别人的 Key 一律 404；**已吊销 ⇒ 409**（终态不可编辑 ——
 * 能改的策略字段对一把已死的 Key 没有意义，"反悔"只能重签；409 而不是 404，因为 Key 存在，
 * 是**状态**不对）。`expiresAt` 的未来时刻校验与签发同口径 —— 把已过期的 Key 续到未来即重新启用。
 *
 * ★ **必须删缓存键**：改的恰恰是快照里的字段（scopes / 限额 / 自动审批）—— 不删的话，
 * 外部最长 `OPEN_API_KEY_CACHE_TTL_SEC` 内仍按**旧策略**被放行/拒绝。
 */
export async function updateOpenApiKey(
  keyId: string,
  body: UpdateOpenApiKeyBody,
  viewer: OpenKeyViewer,
): Promise<OpenApiKeyItem> {
  const db = getPrisma()
  const row = await db.apiKey.findFirst({
    where: { id: keyId },
    select: { id: true, userId: true, keyHash: true, revokedAt: true },
  })
  if (row === null) throw AppError.notFound('API Key 不存在')
  if (row.userId !== viewer.id && viewer.role !== 'ADMIN') throw AppError.notFound('API Key 不存在')
  if (row.revokedAt !== null) throw AppError.conflict('Key 已吊销，不能编辑；请重新签发一把')

  // `expiresAt: null` = 显式改为"不过期"；非 null 必须是未来时刻（与签发同口径）
  let expiresAt: Date | null | undefined
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) {
      expiresAt = null
    } else {
      const parsed = new Date(body.expiresAt)
      if (Number.isNaN(parsed.getTime())) throw AppError.validation('过期时间不是合法的时间')
      if (parsed.getTime() <= Date.now()) throw AppError.validation('过期时间必须晚于当前时刻')
      expiresAt = parsed
    }
  }

  const data = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.scopes !== undefined ? { scopes: body.scopes } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(body.allowAutoApprove !== undefined ? { allowAutoApprove: body.allowAutoApprove } : {}),
    ...(body.confirmTimeoutSec !== undefined ? { confirmTimeoutSec: body.confirmTimeoutSec } : {}),
    ...(body.maxConcurrency !== undefined ? { maxConcurrency: body.maxConcurrency } : {}),
    ...(body.rateLimitPerMin !== undefined ? { rateLimitPerMin: body.rateLimitPerMin } : {}),
    ...(body.dailyTokenLimit !== undefined ? { dailyTokenLimit: body.dailyTokenLimit } : {}),
  }
  const updated = await db.apiKey.update({ where: { id: row.id }, data, select: KEY_SELECT })

  await dropOpenKeyCache(row.keyHash)
  getLogger().info(
    { openKeyId: updated.id, agentId: updated.agentId, by: viewer.id, changed: Object.keys(data) },
    '已编辑开放平台 API Key（明文与关联智能体不可变）',
  )
  return toItem(updated)
}

/** 删缓存键（失败只 warn：缓存 TTL 到期后结论一样，只是迟了最多 TTL 秒） */
export async function dropOpenKeyCache(keyHash: string): Promise<void> {
  try {
    const redis = await ensureRedisConnected()
    await redis.del(openApiKeyCacheKey(keyHash))
  } catch (error) {
    getLogger().warn({ err: error }, '删除开放 Key 缓存键失败（吊销最迟在 TTL 后生效）')
  }
}

/**
 * 一条会话能不能在**外部**继续写（`readOnly` 的判据在 `shared#isConversationReadOnly`，一处）。
 * 开放层用它把"只读"提前成一个 409 信封（而不是等到 SSE 里才失败）—— 与内部 `/chat` 闸门同口径。
 */
export function isOpenConversationReadOnly(status: string): boolean {
  return isConversationReadOnly(status as Parameters<typeof isConversationReadOnly>[0])
}
