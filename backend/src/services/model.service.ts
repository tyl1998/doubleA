/**
 * 模型池服务（P0-1-10 Provider + P0-1-11 模型）
 *
 * 依据：`docs/02-后端设计.md` §4.3（`/api/model-providers` 与 `/api/models` 的 CRUD）
 *      + §十 安全设计「凭据/Provider Key：AES-256-GCM，主密钥仅环境变量注入」
 *      + `01` §3.2 需求 1。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的四条核心口径
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① Key 有进无出。** `api_key_enc` 这一列**只在本文件被读**，且读出来只用于两件事：
 *    ① 生成掩码（`apiKeyPreview`）；② 将来（P0-1-12 的 LLM client）解密后调上游。
 *    任何出参都不带它 —— {@link toItem} 是唯一的出口，它压根没有这个字段。
 *
 * **② 密文绑定到记录（AAD）。** 加密用 {@link providerKeyAad}（`model-providers:{id}.api_key_enc`）
 *    作为附加认证数据。这样「把 A 的密文粘到 B 的 `api_key_enc` 上」会解密失败 ——
 *    对"有人能写库但不能读主密钥"（SQL 注入、误操作、备份还原串号）这类场景是一道实际防线；
 *    代价是**改 id 就得重新加密**（本系统不改 id，可接受）。
 *    ⚠️ 也正因为 AAD 里含 `id`，**加密必须发生在拿到 id 之后** —— 见 {@link createModelProvider}
 *    的事务写法（不能"先加密再 create"，那时 id 还没生成）。
 *
 * **③ 解密失败不掀桌。** 主密钥换了/密文坏了时，列表接口**不能整页 500**（否则管理员连
 *    "哪个 Provider 的 Key 坏了"都看不到）。{@link toItem} 把预览降级成 `****` 并告警，
 *    `hasKey` 仍为 true —— 语义准确：Key 还在，只是这个进程解不开。
 *
 * **④ 两个"删不掉/改不动"要先查再说人话。** `agents.model_id` 是 `ON DELETE RESTRICT`，
 *    直接删 Provider 会级联删 `models`、撞上 Agent 的外键约束后抛 Prisma `P2003`（500）。
 *    更糟的是"改 type"：`model_providers.type` 与 `models.type` 冗余，改了 Provider 类型而
 *    不管模型，会留下"CHAT 的 Provider 挂着 EMBEDDING 的模型"这种自相矛盾的数据。
 *    两条都在服务层**前置检查**并给出可执行的 409 文案（`06` P0-1-10 落地要点）。
 *    P0-1-11 又在**模型**这一侧补了同族的三条守卫（同款思路：先查、说人话、别让 500 说话）：
 *    删除时有 Agent 引用 / 改 type 时有 Agent 引用 / 试图把模型迁到别的 Provider。
 */


import {
  AppError,
  maskApiKey,
  type CreateModelBody,
  type CreateModelProviderBody,
  type ListAvailableModelsQuery,
  type ListModelProvidersQuery,
  type ListModelsQuery,
  type ModelItem,
  type ModelOption,
  type ModelProviderItem,
  type OffsetPage,
  type RemoteModelListResult,
  type UpdateModelBody,
  type UpdateModelProviderBody,
} from '@doubulea/shared'

import { decryptSecret, encryptSecret } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { describeTarget, fetchRemoteModels, type LlmTarget } from '../llm/client.js'

/**
 * 查询字段白名单（列表 / 建 / 改共用一份）。
 * 与 `user.service.ts` 的 `USER_LIST_SELECT` 同理：新增列只有"确实该下发"的才会被加进来。
 *
 * `apiKeyEnc` 必须选出来（要算掩码），但它**只能**经过 {@link toItem} 变成
 * `hasKey` + `apiKeyPreview`，绝不出现在返回值里。
 */
const PROVIDER_SELECT = {
  id: true,
  name: true,
  baseUrl: true,
  apiKeyEnc: true,
  type: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { models: true } },
} as const

/** {@link PROVIDER_SELECT} 的产物形态（手写出来给 {@link toItem} 收窄用） */
interface ProviderRow {
  id: string
  name: string
  baseUrl: string
  apiKeyEnc: string | null
  type: ModelProviderItem['type']
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  _count: { models: number }
}

/**
 * Key 密文的 AAD 上下文：**改了这里的公式，库里已有密文就全部解不开**。
 * 集中成一处是为了让"写"与"读"不可能用错（将来 LLM client 解密时必须复用本函数）。
 */
export function providerKeyAad(providerId: string): string {
  return `model-providers:${providerId}.api_key_enc`
}

/**
 * 行 → 对外形态（**唯一的出口**）。
 *
 * 掩码来自"解密后取首尾"而不是"存一段明文的尾巴"：既不多存一份敏感数据（那等于把 key
 * 的尾巴明文落库），又顺带证明了密文确实解得开。
 */
function toItem(row: ProviderRow): ModelProviderItem {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    type: row.type,
    enabled: row.enabled,
    hasKey: row.apiKeyEnc !== null,
    apiKeyPreview: row.apiKeyEnc === null ? null : buildPreview(row.apiKeyEnc, row.id),
    modelCount: row._count.models,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 解密 + 掩码；解不开时降级成 `****` 并留一条 warn（见文件头口径 ③） */
function buildPreview(apiKeyEnc: string, providerId: string): string {
  try {
    return maskApiKey(decryptSecret(apiKeyEnc, providerKeyAad(providerId)))
  } catch (error) {
    getLogger().warn(
      { providerId, err: error },
      'Provider Key 解密失败，掩码降级为 ****（密文可能被篡改、或主密钥已更换）',
    )
    return '****'
  }
}

/** Prisma 已知错误码判定（鸭子类型，理由同 `user.service.ts`：跨构建产物的 `instanceof` 不可靠） */
function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

/**
 * Provider 列表（`02` §4.3）。
 *
 * 排序按 `createdAt asc, id asc`：Provider 数量极少（通常个位数），按录入顺序展示最符合
 * 管理员的心智（谁先配的谁在上）；`id` 作为第二排序键保证分页**稳定**（与 `user.service.ts` 同款要求）。
 */
export async function listModelProviders(
  query: ListModelProvidersQuery,
): Promise<OffsetPage<ModelProviderItem>> {
  const db = getPrisma()
  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照，否则分页器会错位
  const [rows, total] = await db.$transaction([
    db.modelProvider.findMany({
      select: PROVIDER_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.modelProvider.count(),
  ])
  return { items: rows.map(toItem), total, offset: query.offset, limit: query.limit }
}

/**
 * 建 Provider（`02` §4.3）：`apiKey` 若给了，**立即加密落库**（明文不出本函数）。
 *
 * 为什么用事务（而不是"先 create 再 update"两条独立语句）：AAD 需要 `id`，而 `id` 是
 * Prisma 在 create 时按 `uuid(7)` 生成的 —— 也就是说**只能先落一行拿到 id，才能加密**。
 * 两条独立语句中间若失败（进程被杀、约束冲突），库里会留下一个"建好了但 Key 没写进去"的
 * Provider，而调用方看到的是失败并会重试 → 又建一个。放进事务后要么全成要么全无。
 *
 * 名称**不查重**：`model_providers` 上没有 `name` 唯一约束（`02` §三 未定），
 * 同名的两个 Provider 靠 id 区分，不影响正确性 —— 需要唯一性时应当先加约束再改代码，
 * 而不是在服务层造一条"看起来唯一、并发下不唯一"的规则。
 */
export async function createModelProvider(input: CreateModelProviderBody): Promise<ModelProviderItem> {
  const db = getPrisma()
  const apiKey = input.apiKey ?? undefined

  const created = await db.$transaction(async (tx) => {
    const row = await tx.modelProvider.create({
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        type: input.type,
        // 显式写出 enabled：DB 默认也是 true，但"新 Provider 默认启用"属于契约，不该藏在迁移里
        enabled: input.enabled ?? true,
        apiKeyEnc: null,
      },
      select: PROVIDER_SELECT,
    })
    if (apiKey === undefined) return row
    return tx.modelProvider.update({
      where: { id: row.id },
      data: { apiKeyEnc: encryptSecret(apiKey, providerKeyAad(row.id)) },
      select: PROVIDER_SELECT,
    })
  })

  getLogger().info(
    { providerId: created.id, name: created.name, type: created.type, hasKey: apiKey !== undefined },
    '已创建模型 Provider（Key 已加密落库，明文不再出现）',
  )
  return toItem(created)
}

/**
 * 改 Provider（`02` §4.3）：`apiKey` 的**三态**语义见 `shared/src/modelProvider.ts` 的表。
 *
 * 另一条守卫：**有模型时不允许改 `type`**。`model_providers.type` 与 `models.type` 是冗余的
 * （`02` §三），改了 Provider 类型而模型类型不动，会留下自相矛盾的数据；而级联改所有模型的
 * `type` 又会静默改变"已绑定的 Agent 用的是哪类模型"。两条都不好，故**拒绝并要求先处理模型** ——
 * 显式报错比静默改数据强。
 *
 * @throws {AppError} `NOT_FOUND`(404) 目标不存在 / `CONFLICT`(409) 有模型时改 type
 */
export async function updateModelProvider(
  id: string,
  input: UpdateModelProviderBody,
): Promise<ModelProviderItem> {
  const db = getPrisma()
  const target = await db.modelProvider.findUnique({
    where: { id },
    select: { id: true, type: true, _count: { select: { models: true } } },
  })
  if (target === null) throw AppError.notFound('Provider 不存在')

  if (input.type !== undefined && input.type !== target.type && target._count.models > 0) {
    throw AppError.conflict(
      `该 Provider 下已有 ${target._count.models} 个模型，不能改类型（模型类型与 Provider 类型必须一致）。` +
        '请先删除或迁走这些模型',
    )
  }

  // 三态落点：undefined = 不带这一列（Prisma 视作"不动"）；null = 显式清空；string = 写入密文
  const apiKeyData =
    input.apiKey === undefined
      ? {}
      : { apiKeyEnc: input.apiKey === null ? null : encryptSecret(input.apiKey, providerKeyAad(id)) }

  let updated: ProviderRow
  try {
    updated = await db.modelProvider.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...apiKeyData,
      },
      select: PROVIDER_SELECT,
    })
  } catch (error) {
    // 极小的竞态窗口：查到了但更新前被删了
    if (hasPrismaCode(error, 'P2025')) throw AppError.notFound('Provider 不存在')
    throw error
  }

  getLogger().info(
    {
      providerId: id,
      // 只记"改了什么类别"，**不记 Key 本身**（`02` §十 密钥零留痕）
      keyAction: input.apiKey === undefined ? 'untouched' : input.apiKey === null ? 'cleared' : 'replaced',
      enabled: input.enabled,
      type: input.type,
    },
    '已更新模型 Provider',
  )
  return toItem(updated)
}

/**
 * 删 Provider（`02` §4.3）。`models.provider_id` 是 `ON DELETE CASCADE`，但
 * `agents.model_id` 是 `ON DELETE RESTRICT`（`02` §三 的删除语义）—— 也就是说
 * **只要 Provider 下有一个模型被 Agent 引用着，级联删除就会撞上外键约束抛 `P2003`**。
 *
 * 所以在删之前先数一遍"被 Agent 引用的模型"，命中就 409 并给数字。
 * 顺带说明：Agent 是**软删**（`agents.deleted_at`），软删的 Agent 仍然占着外键 ——
 * 计数刻意不按 `deletedAt` 过滤，否则会出现"提示说能删、删下去却 500"。
 *
 * @throws {AppError} `NOT_FOUND`(404) 目标不存在 / `CONFLICT`(409) 有模型正被 Agent 使用
 */
export async function removeModelProvider(id: string): Promise<{ id: string; name: string }> {
  const db = getPrisma()
  const target = await db.modelProvider.findUnique({
    where: { id },
    select: { id: true, name: true },
  })
  if (target === null) throw AppError.notFound('Provider 不存在')

  const referencedModels = await db.model.count({
    where: { providerId: id, agents: { some: {} } },
  })
  if (referencedModels > 0) {
    throw AppError.conflict(
      `该 Provider 下有 ${referencedModels} 个模型正被 Agent 使用，无法删除。请先删除或改绑这些 Agent`,
    )
  }

  try {
    // 无论有没有模型都走同一句：schema 的级联会连带删掉它下面的 models（此时已确认无人引用）
    await db.modelProvider.delete({ where: { id } })
  } catch (error) {
    if (hasPrismaCode(error, 'P2025')) throw AppError.notFound('Provider 不存在')
    // `P2003` = 外键约束失败：理论上已被上面的检查拦住，留作并发兜底（换成可读文案而不是 500）
    if (hasPrismaCode(error, 'P2003')) {
      throw AppError.conflict('该 Provider 下的模型正被其他数据引用，无法删除')
    }
    throw error
  }

  getLogger().info({ providerId: id, name: target.name }, '已删除模型 Provider（其下模型级联删除）')
  return { id: target.id, name: target.name }
}

// ═════════════════════════════════════════════════════════════════════
// 模型（P0-1-11，`02` §4.3 后半）
// ═════════════════════════════════════════════════════════════════════

/**
 * 管理列表的查询字段（`GET /api/models`，仅 ADMIN）。
 *
 * 带出 `provider.name` / `provider.enabled` 是为了列表能直接显示"哪个 Provider 下的、
 * 它还启用着吗"—— 管理页最常见的一句疑问就是"这个模型配了怎么不生效"，
 * 答案十有八九是 Provider 被停用了，让管理员为此多点一次接口不值得。
 */
const MODEL_MANAGE_SELECT = {
  id: true,
  providerId: true,
  modelName: true,
  label: true,
  type: true,
  maxContext: true,
  supportsVision: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  provider: { select: { name: true, enabled: true } },
  _count: { select: { agents: true } },
} as const

/** {@link MODEL_MANAGE_SELECT} 的产物形态 */
interface ModelRow {
  id: string
  providerId: string
  modelName: string
  label: string
  type: ModelItem['type']
  maxContext: number | null
  supportsVision: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  provider: { name: string; enabled: boolean }
  _count: { agents: number }
}

/** 可选列表的查询字段（`GET /api/models/available`）：只要下拉需要的，管理字段一律不带 */
const MODEL_OPTION_SELECT = {
  id: true,
  providerId: true,
  modelName: true,
  label: true,
  type: true,
  maxContext: true,
  supportsVision: true,
  provider: { select: { name: true } },
} as const

/** {@link MODEL_OPTION_SELECT} 的产物形态 */
interface ModelOptionRow {
  id: string
  providerId: string
  modelName: string
  label: string
  type: ModelOption['type']
  maxContext: number | null
  supportsVision: boolean
  provider: { name: string }
}

function toModelItem(row: ModelRow): ModelItem {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: row.provider.name,
    providerEnabled: row.provider.enabled,
    modelName: row.modelName,
    label: row.label,
    type: row.type,
    maxContext: row.maxContext,
    supportsVision: row.supportsVision,
    enabled: row.enabled,
    agentCount: row._count.agents,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toModelOption(row: ModelOptionRow): ModelOption {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: row.provider.name,
    modelName: row.modelName,
    label: row.label,
    type: row.type,
    maxContext: row.maxContext,
    supportsVision: row.supportsVision,
  }
}

/**
 * 模型列表（`GET /api/models`，仅 ADMIN）。
 *
 * 排序 `createdAt asc, id asc`：与 Provider 列表同一口径（按录入顺序展示最直观，
 * `id` 兜底保证分页稳定）。模型条数比 Provider 多，但管理页自己会按 `providerName` 分组，
 * 故不在这里做"按 Provider 名排序"——排序键与索引无关地多一层，反而更难解释分页结果。
 */
export async function listModels(query: ListModelsQuery): Promise<OffsetPage<ModelItem>> {
  const db = getPrisma()
  const where = {
    ...(query.type === undefined ? {} : { type: query.type }),
    ...(query.providerId === undefined ? {} : { providerId: query.providerId }),
    ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
  }
  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照，否则分页器会错位
  const [rows, total] = await db.$transaction([
    db.model.findMany({
      where,
      select: MODEL_MANAGE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.model.count({ where }),
  ])
  return { items: rows.map(toModelItem), total, offset: query.offset, limit: query.limit }
}

/**
 * 全员可选模型列表（`GET /api/models/available`，登录即可，`03` §4.2 的模型下拉）。
 *
 * 三个过滤条件缺一不可（`01` §3.2 验收要点「无效模型创建 Agent 时不可选」）：
 *   ① `models.enabled = true` —— 这一个就是门槛原文；
 *   ② `provider.enabled = true` —— "Provider 被停用"是同一个"用不了"的另一种形态。
 *      只查 ① 会给出一个"选了它能建 Agent、但一发消息就失败"的模型，比不显示更坑；
 *   ③ `type = ?`（**必填**，见 `shared/src/model.ts` 的注释）：对话模型与向量模型不可互换。
 *
 * 排序 `providerId asc, modelName asc, id asc`：`providerId` 是 uuid7（时间有序），
 * 所以它等价于"按 Provider 的录入顺序"—— 既天然形成分组，又不必 join 出 Provider 名来排序
 * （按关联字段排序会让执行计划依赖 join 顺序，交给前端按 `providerName` 分组更简单可控）。
 */
export async function listAvailableModels(query: ListAvailableModelsQuery): Promise<ModelOption[]> {
  const db = getPrisma()
  const rows = await db.model.findMany({
    where: { type: query.type, enabled: true, provider: { enabled: true } },
    select: MODEL_OPTION_SELECT,
    orderBy: [{ providerId: 'asc' }, { modelName: 'asc' }, { id: 'asc' }],
  })
  return rows.map(toModelOption)
}

/**
 * 建模型（`POST /api/models`，仅 ADMIN）。
 *
 * 两条守卫按"先查再说人话"排：
 *   ① Provider 必须存在 —— 不存在时若直接 create，会撞 `models_provider_id_fkey` 抛 `P2003`（500）；
 *   ② `(providerId, modelName, type)` 唯一（`schema.prisma` 的 `@@unique`）——
 *      先查一遍给出可读文案，再 `catch P2002` 兜住并发窗口（`user.service.ts` 同款双保险）。
 *
 * ⚠️ 刻意**不校验**「`type` 必须等于 Provider 的 `type`」：`schema.prisma` 的
 *    `@@unique([providerId, modelName, type])` 注释已明确"同一型号名可能既提供 chat
 *    又提供 embedding（如 bge 系列的兼容端点）"是**合法**的。这里加一条"必须一致"
 *    会把那种合法配置挡在门外，属于自己发明约束。
 */
export async function createModel(input: CreateModelBody): Promise<ModelItem> {
  const db = getPrisma()

  const provider = await db.modelProvider.findUnique({
    where: { id: input.providerId },
    select: { id: true },
  })
  if (provider === null) throw AppError.notFound('Provider 不存在')

  const duplicated = await db.model.findFirst({
    where: { providerId: input.providerId, modelName: input.modelName, type: input.type },
    select: { id: true },
  })
  if (duplicated !== null) {
    throw AppError.conflict(`该 Provider 下已存在同型号同类型的模型：${input.modelName}`)
  }

  let created: ModelRow
  try {
    created = await db.model.create({
      data: {
        providerId: input.providerId,
        modelName: input.modelName,
        label: input.label,
        type: input.type,
        // `maxContext` 可缺省：`null` 与缺省同义（未填写）
        maxContext: input.maxContext ?? null,
        // 显式写出两个默认值：DB 默认也是 false/true，但"新模型默认启用、默认不支持图片"
        // 属于契约，不该藏在迁移里（与 createModelProvider 同款理由）
        supportsVision: input.supportsVision ?? false,
        enabled: input.enabled ?? true,
      },
      select: MODEL_MANAGE_SELECT,
    })
  } catch (error) {
    // 并发窗口：上面的 findFirst 与这里的 create 之间有人插了同一条
    if (hasPrismaCode(error, 'P2002')) {
      throw AppError.conflict(`该 Provider 下已存在同型号同类型的模型：${input.modelName}`)
    }
    // Provider 在两次查询之间被删了（`@@unique` 之外的另一条并发路径）
    if (hasPrismaCode(error, 'P2003')) throw AppError.notFound('Provider 不存在')
    throw error
  }

  getLogger().info(
    { modelId: created.id, providerId: input.providerId, modelName: input.modelName, type: input.type },
    '已创建模型',
  )
  return toModelItem(created)
}

/**
 * 改模型（`PATCH /api/models/:id`，仅 ADMIN）。
 *
 * 三条守卫（`06` P0-1-11 的落地要点）：
 *
 * ① **不能迁移到别的 Provider**（`providerId` 不同 → 409）。传同值放行（幂等：前端整表单提交时
 *    "没改"不该失败）。理由：迁移会静默改变"已绑定 Agent 走的是哪个上游"，而且没人会预期
 *    改一个下拉就把请求打到另一个厂商；真要迁移，应当新建一条再改绑 Agent —— 每一步都可见。
 *    （契约里**保留**这个字段正是为了能显式报错：不写进 schema 的话，zod 会把多余的键剥掉，
 *    调用方以为自己迁移成功了，实际什么都没发生。）
 *
 * ② **被 Agent 引用时不能改 `type`** → 409。CHAT 与 EMBEDDING 不可互换，改了等于让已上线的
 *    智能体静默换一类模型（对话直接坏掉，而且是下一次发消息才暴露）。同值放行。
 *
 * ③ **唯一冲突** → 409（先查 + `catch P2002`，与建模型同一套双保险）。
 *
 * `maxContext` 走三态（缺省不动 / `null` 清空 / 数字设置），与 Provider 的 `apiKey` 同款口径 ——
 * 合并成一个 `.default(null)` 的话，"改个别名"会把上下文长度顺手抹掉。
 *
 * @throws {AppError} `NOT_FOUND`(404) 模型不存在 / `CONFLICT`(409) 三条守卫
 */
export async function updateModel(id: string, input: UpdateModelBody): Promise<ModelItem> {
  const db = getPrisma()
  const target = await db.model.findUnique({
    where: { id },
    select: {
      id: true,
      providerId: true,
      modelName: true,
      type: true,
      _count: { select: { agents: true } },
    },
  })
  if (target === null) throw AppError.notFound('模型不存在')

  if (input.providerId !== undefined && input.providerId !== target.providerId) {
    throw AppError.conflict(
      '模型不能迁移到其他 Provider。请在该 Provider 下新建一条，并改绑使用它的 Agent',
    )
  }

  const nextType = input.type ?? target.type
  if (input.type !== undefined && input.type !== target.type && target._count.agents > 0) {
    throw AppError.conflict(
      `该模型已被 ${target._count.agents} 个 Agent 使用，不能改类型（对话模型与向量模型不可互换）。` +
        '请先删除或改绑这些 Agent',
    )
  }

  const nextModelName = input.modelName ?? target.modelName
  if (nextModelName !== target.modelName || nextType !== target.type) {
    const duplicated = await db.model.findFirst({
      where: { providerId: target.providerId, modelName: nextModelName, type: nextType, id: { not: id } },
      select: { id: true },
    })
    if (duplicated !== null) {
      throw AppError.conflict(`该 Provider 下已存在同型号同类型的模型：${nextModelName}`)
    }
  }

  let updated: ModelRow
  try {
    updated = await db.model.update({
      where: { id },
      data: {
        ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.type === undefined ? {} : { type: input.type }),
        // 三态落点：undefined = 不带这一列（不动）；null = 显式清空；number = 设置
        ...(input.maxContext === undefined ? {} : { maxContext: input.maxContext }),
        ...(input.supportsVision === undefined ? {} : { supportsVision: input.supportsVision }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
      select: MODEL_MANAGE_SELECT,
    })
  } catch (error) {
    if (hasPrismaCode(error, 'P2025')) throw AppError.notFound('模型不存在')
    if (hasPrismaCode(error, 'P2002')) {
      throw AppError.conflict(`该 Provider 下已存在同型号同类型的模型：${nextModelName}`)
    }
    throw error
  }

  getLogger().info(
    { modelId: id, providerId: target.providerId, changed: Object.keys(input) },
    '已更新模型',
  )
  return toModelItem(updated)
}

/**
 * 删模型（`DELETE /api/models/:id`，仅 ADMIN）。
 *
 * `agents.model_id` 是 `ON DELETE RESTRICT`，所以在删之前先数一遍引用并给 409 + 数字
 * （而不是撞外键抛 500）。计数口径与 `ModelItem.agentCount` 一致：**含软删的 Agent** ——
 * `agents.deleted_at` 非空的记录照样占着外键，按 `deletedAt` 过滤会出现
 * "界面上显示 0 个引用、删下去却 500"。
 *
 * @throws {AppError} `NOT_FOUND`(404) 模型不存在 / `CONFLICT`(409) 正被 Agent 使用
 */
export async function removeModel(id: string): Promise<{ id: string; modelName: string }> {
  const db = getPrisma()
  const target = await db.model.findUnique({
    where: { id },
    select: { id: true, modelName: true },
  })
  if (target === null) throw AppError.notFound('模型不存在')

  const referencedAgents = await db.agent.count({ where: { modelId: id } })
  if (referencedAgents > 0) {
    throw AppError.conflict(
      `该模型正被 ${referencedAgents} 个 Agent 使用，无法删除。请先删除或改绑这些 Agent`,
    )
  }

  try {
    await db.model.delete({ where: { id } })
  } catch (error) {
    if (hasPrismaCode(error, 'P2025')) throw AppError.notFound('模型不存在')
    // `P2003` = 外键约束失败：理论上已被上面的检查拦住，留作并发兜底（换成可读文案而不是 500）
    if (hasPrismaCode(error, 'P2003')) {
      throw AppError.conflict('该模型正被其他数据引用，无法删除')
    }
    throw error
  }

  getLogger().info({ modelId: id, modelName: target.modelName }, '已删除模型')
  return { id: target.id, modelName: target.modelName }
}

// ═════════════════════════════════════════════════════════════════════
// 上游解析与探测（P0-1-12：LLM client 的两个后端入口）
// ═════════════════════════════════════════════════════════════════════

/**
 * Provider 行 → 已解密的上游凭据。
 *
 * **单点**：`api_key_enc` 的明文只在这里出现一次，调用方拿到的是
 * {@link LlmTarget.apiKey}（仅内存）。与 {@link providerKeyAad} 一样，
 * 把"怎么解密、失败怎么办"收在一处，避免将来有第二个人再写一遍（写错就是 401 排查半天）。
 */
async function readProviderCredential(providerId: string): Promise<{ providerName: string; baseUrl: string; apiKey: string | null }> {
  const db = getPrisma()
  const row = await db.modelProvider.findUnique({
    where: { id: providerId },
    select: { name: true, baseUrl: true, apiKeyEnc: true },
  })
  if (row === null) throw AppError.notFound('Provider 不存在')
  if (row.apiKeyEnc === null) return { providerName: row.name, baseUrl: row.baseUrl, apiKey: null }
  try {
    return {
      providerName: row.name,
      baseUrl: row.baseUrl,
      apiKey: decryptSecret(row.apiKeyEnc, providerKeyAad(providerId)),
    }
  } catch (error) {
    // 与列表页的降级不同：这里**不能**降级成"没配 Key" —— 那会让调用方以为"换个能用的
    // Provider 就行"，而真相是"这一条的密文坏了/主密钥换了"。要显式说清楚该怎么修。
    getLogger().warn({ providerId, err: error }, 'Provider Key 解密失败（无法解析上游目标）')
    throw AppError.internal(
      `该 Provider 的 API Key 无法解密（密文可能已损坏，或 CREDENTIAL_MASTER_KEY 已更换）。` +
        '请在模型池管理页重新设置这一项的 Key',
    )
  }
}

/**
 * 解析「一个模型 → 可调用的上游目标」（P0-1-12 的对外接口，F 包的编排层用它）。
 *
 * 四道前置校验，全部按"先查再说人话"排（`06` P0-1-6 起的纪律：不许把 500 抛给用户）：
 *   ① 模型存在 → 否则 404；
 *   ② `type = CHAT` → 否则 409。向量模型与对话模型不可互换（`02` §4.3 同款结论），
 *      把 EMBEDDING 模型塞给对话编排只会在上游得到一个 404/400；
 *   ③ 模型与 Provider 都**启用**着 → 否则 409。「停用」是这个平台的语义（`01` §3.2 的
 *      「无效模型创建 Agent 时不可选」管的是**选的时候**），而"能选到、但发消息就失败"
 *      更难排查 —— 所以调用点也要把话说清楚，而不是把 400 甩给上游；
 *   ④ Provider 配了 Key → 否则 **424 `NEED_CREDENTIAL`**（`02` §四 的 `NEED_CREDENTIAL`
 *      正是"缺凭据"的语义，MCP 用户级凭据用的是同一个码）。⚠️ 这里只对**这个接口**
 *      要求 Key：自建/内网 OpenAI 兼容实现常常不校验凭据，那种情况由部署方自己决定 ——
 *      见 {@link listProviderRemoteModels} 的宽松口径。
 *
 * @throws {AppError} 见上（404 / 409 / 424 / 500）
 */
export async function resolveChatTarget(modelId: string): Promise<LlmTarget> {
  const db = getPrisma()
  const row = await db.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      modelName: true,
      label: true,
      type: true,
      enabled: true,
      maxContext: true,
      supportsVision: true,
      providerId: true,
      provider: { select: { name: true, baseUrl: true, enabled: true } },
    },
  })
  if (row === null) throw AppError.notFound('模型不存在')

  if (row.type !== 'CHAT') {
    throw AppError.conflict(`该模型是向量模型（EMBEDDING），不能用于对话：${row.modelName}`)
  }
  if (!row.enabled) {
    throw AppError.conflict(`模型已停用，无法调用：${row.modelName}。请在模型池管理页启用它或改用其他模型`)
  }
  if (!row.provider.enabled) {
    throw AppError.conflict(
      `该模型所属的 Provider「${row.provider.name}」已停用，无法调用。请启用该 Provider 或改用其他模型`,
    )
  }

  const credential = await readProviderCredential(row.providerId)
  if (credential.apiKey === null) {
    throw AppError.needCredential(
      `Provider「${row.provider.name}」尚未配置 API Key，无法调用模型。请在模型池管理页为它设置 Key`,
    )
  }

  const target: LlmTarget = {
    modelId: row.id,
    modelName: row.modelName,
    label: row.label,
    maxContext: row.maxContext,
    supportsVision: row.supportsVision,
    providerId: row.providerId,
    providerName: row.provider.name,
    baseUrl: row.provider.baseUrl,
    apiKey: credential.apiKey,
  }
  // 记日志一律走 describeTarget（只打 id/名字/hasKey），**绝不整体序列化 target**（里面是明文 Key）
  getLogger().debug(describeTarget(target), '已解析上游模型目标')
  return target
}

/**
 * 拉取 Provider 上游实际提供的模型列表（`GET /api/model-providers/:id/remote-models`，仅 ADMIN）。
 *
 * 用途：管理页在"加模型"时列出上游真实有的型号，避免手敲 model id 敲错一个字符
 * （错的代价是"第一次发消息才 404"）。
 *
 * 两条与 {@link resolveChatTarget} **刻意不同**的口径：
 *   ① **不要求 Provider 启用**：这正是用来诊断"这个 Provider 还能不能连上"的动作，
 *      停用了反而更需要探（比如换 Key 后先探一次再启用）；
 *   ② **不要求配 Key**：`GET /models` 在许多自建/内网实现上是免鉴权的，本地 vLLM /
 *      llama.cpp / ollama 的兼容层都属此类。没配就不带 `Authorization` 头去探，
 *      能不能成由上游决定 —— 这样"用不了"与"不支持列表"能被区分开。
 *
 * @throws {AppError} `NOT_FOUND`(404) Provider 不存在 / `INTERNAL`(500) Key 解密失败
 *                    / `UPSTREAM_ERROR`(502)、`UPSTREAM_TIMEOUT`(504) 见 `llm/client.ts`
 */
export async function listProviderRemoteModels(providerId: string): Promise<RemoteModelListResult> {
  const credential = await readProviderCredential(providerId)
  const result = await fetchRemoteModels(credential)
  getLogger().info(
    { providerId, providerName: credential.providerName, total: result.total, truncated: result.truncated, hasKey: credential.apiKey !== null },
    '已拉取上游模型列表',
  )
  return {
    providerId,
    providerName: credential.providerName,
    baseUrl: credential.baseUrl,
    total: result.total,
    truncated: result.truncated,
    items: result.items,
  }
}
