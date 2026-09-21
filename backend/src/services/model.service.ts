/**
 * 模型池服务 · Provider 部分（P0-1-10，`(A)` 仅 ADMIN）
 *
 * 依据：`docs/02-后端设计.md` §4.3（`/api/model-providers` CRUD）+ §十 安全设计
 *      「凭据/Provider Key：AES-256-GCM，主密钥仅环境变量注入」+ `01` §3.2 需求 1。
 *
 * P0-1-11（模型管理）会往本文件加 `Model` 那一半的 CRUD；本批只做 Provider。
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
 */

import {
  AppError,
  maskApiKey,
  type CreateModelProviderBody,
  type ListModelProvidersQuery,
  type ModelProviderItem,
  type OffsetPage,
  type UpdateModelProviderBody,
} from '@doubulea/shared'

import { decryptSecret, encryptSecret } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'

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
