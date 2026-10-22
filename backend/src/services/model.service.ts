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
 *    删除在服务层**前置检查**并给出可执行的 409 文案（`06` P0-1-10 落地要点）。
 *    P0-1-11 又在**模型**这一侧补了同族的三条守卫（同款思路：先查、说人话、别让 500 说话）：
 *    删除时有 Agent 引用 / 改 type 时有 Agent 引用 / 试图把模型迁到别的 Provider。
 *    ⚠️ 2026-10-22 起**删掉了**"有模型时不许改 Provider 的 `type`"这条 —— `type` 已降级为
 *    "默认类型"，改它不动任何模型数据（见 ⑥）。
 *
 * **⑤ `protocol`（P0-1-37）在服务层的落点。**
 *    · **创建**：`protocol` 缺省 = `DEFAULT_UPSTREAM_PROTOCOL`（默认值只在这一处补，
 *      `shared` 的 schema 刻意不用 `.default()` —— 见那边的注释）；
 *    · **改 Provider 的协议**：见 ⑥ 的那条约束（"该 Provider 下有向量模型 ⇒ 只能兼容协议"）。
 *
 * **⑥ 2026-10-22：Provider 不再有 `type`（整列删除），`models.type` 是模型自己的用途。**
 *    起因：同一个 baseUrl（one-api / new-api / vLLM 那类网关）**往往同时**提供对话与向量模型，
 *    只是模型名不同；而"类型跟随 Provider"的硬约束逼着管理员把**同一个上游配两遍**
 *    （`api_key_enc` 存两份密文、AAD 按 providerId 绑定 ⇒ 密文不可互换 ⇒ 轮换要改两处、漏一处就
 *    一半模型静默 401）。改造后 Provider 只是"上游终点"（baseUrl + Key + protocol），
 *    那列 `type` 失去全部语义（连"新建模型的默认类型"都不值得占一列），故整列删除。
 *    遗留约束全部转移到**模型侧**：
 *    · **建/改模型**：`type=EMBEDDING` 时该 Provider 的协议必须是 OpenAI 兼容
 *      （{@link embeddingModelAllowedOnProtocol}）：embedding 只有 `/embeddings` 一条路；
 *    · **改 Provider 协议**：该 Provider 下有 EMBEDDING 模型时，协议只能是默认值
 *      （{@link vectorModelRequiresCompatProtocol}）。
 *    判据是纯函数、收在 `shared/src/modelProvider.ts` 一处，服务层只看"有没有向量模型"这个事实。
 */


import {
  AppError,
  assetVisibilityWhere,
  canEditAsset,
  DEFAULT_UPSTREAM_PROTOCOL,
  EMBEDDING_MODEL_PROTOCOL_CONFLICT_MESSAGE,
  embeddingModelAllowedOnProtocol,
  maskApiKey,
  VECTOR_MODEL_PROTOCOL_CONFLICT_MESSAGE,
  vectorModelRequiresCompatProtocol,
  type AssetViewer,
  type CreateModelBody,
  type CreateModelProviderBody,
  type ListAvailableModelsQuery,
  type ListModelProvidersQuery,
  type ListModelsQuery,
  type ModelItem,
  type ModelOption,
  type ModelProviderItem,
  type MyProviderCredentialEntry,
  type OffsetPage,
  type ProbeChatResult,
  type ProviderBoundModelsResult,
  type ProviderUserCredentialItem,
  type RemoteModelListResult,
  type RemoveModelProviderResult,
  type UpdateModelBody,
  type UpdateModelProviderBody,
  type UpstreamProtocol,
} from '@doubulea/shared'

import { config } from '../config.js'
import { decryptSecret, encryptSecret } from '../infra/crypto.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { chat, describeTarget, fetchRemoteModels, type LlmTarget } from '../llm/client.js'
import { probeEmbeddingDim } from '../llm/embedding/index.js'
import { protocolOf } from '../llm/protocol.js'
import { resolveUpstreamUrl } from '../llm/upstream.js'
import { groupIdsOfUser } from './userGroup.service.js'

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
  customUrl: true,
  apiKeyEnc: true,
  protocol: true,
  enabled: true,
  // P1-18：凭据模式（共享 Key / 各自 Key）
  credentialMode: true,
  createdBy: true,
  creator: { select: { username: true, nickname: true } },
  createdAt: true,
  updatedAt: true,
  _count: { select: { models: true } },
} as const

/** {@link PROVIDER_SELECT} 的产物形态（手写出来给 {@link toItem} 收窄用） */
interface ProviderRow {
  id: string
  name: string
  baseUrl: string
  customUrl: boolean
  apiKeyEnc: string | null
  protocol: UpstreamProtocol
  enabled: boolean
  credentialMode: ModelProviderItem['credentialMode']
  createdBy: string
  creator: { username: string; nickname: string | null }
  createdAt: Date
  updatedAt: Date
  _count: { models: number }
}

/**
 * Provider 列表的「可见性」口径（**唯一实现**，2026-10-16 修订）。
 *
 * **读 = 全体登录用户；写 = 所属人 + ADMIN**。
 *
 * 为什么读要放开：Provider/Model 就是**平台模型池**（`01` §3.2「平台模型池（admin 维护）」）——
 * 管理员建好后，**任何登录用户都要能在模型池页看到、并在建 Agent 时选到这些模型**。
 * P1-18 初版把它收成「所属人 + ADMIN」，结果：DB 里 Provider 全归 ADMIN 时，MEMBER 打开模型池是
 * **空页**、建 Agent 的模型下拉也是空的（既看不到、也选不到平台模型）—— 与"平台模型池"直接冲突。
 *
 * ⚠️ 放开的是**读**：`canEdit = 所属人 + ADMIN`（见 {@link toItem} / 各写入口的 `canEditAsset`）
 * 仍逐行下发，非所属人看到的行只读（无编辑 / 删除 / 建模型 / 转移入口）。
 * ⚠️ 这**不是**"能不能用它的模型"的判据：模型只能通过 Agent 被使用，所以"用谁的模型"由
 * **Agent 可见范围**决定（见 `agent.service.ts` / `shared/src/assetAcl.ts` 文件头 ①）。
 */

/**
 * Key 密文的 AAD 上下文：**改了这里的公式，库里已有密文就全部解不开**。
 * 集中成一处是为了让"写"与"读"不可能用错（将来 LLM client 解密时必须复用本函数）。
 */
export function providerKeyAad(providerId: string): string {
  return `model-providers:${providerId}.api_key_enc`
}

/**
 * P1-18：**用户级凭据**密文的 AAD 上下文（与 {@link providerKeyAad} **分开**）。
 *
 * 用 `userId:providerId` 两个维度绑定：把 A 用户的密文粘到 B 用户（或另一个 Provider）上会解密失败。
 * 改了公式 = 库里已存的用户级密文全部解不开（同 {@link providerKeyAad} 的纪律）。
 */
export function providerUserKeyAad(userId: string, providerId: string): string {
  return `user:provider:${userId}:${providerId}`
}

/**
 * 行 → 对外形态（**唯一的出口**）。
 *
 * 掩码来自"解密后取首尾"而不是"存一段明文的尾巴"：既不多存一份敏感数据（那等于把 key
 * 的尾巴明文落库），又顺带证明了密文确实解得开。
 *
 * ⚠️ `hasEmbeddingModel` 是**派生读数**（`models` 子表里有没有 `type=EMBEDDING`），
 * 不在 {@link ProviderRow} 上 —— 它由调用方查出来传进来（与 `userHasKey` 同款），
 * 因为列表那儿要用一条 `distinct` 查询批量取、单条那儿用 `count`，两种取法不该塞进一个断言里。
 */
function toItem(
  row: ProviderRow,
  viewer: AssetViewer,
  userHasKey: boolean,
  hasEmbeddingModel: boolean,
): ModelProviderItem {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    customUrl: row.customUrl,
    protocol: row.protocol,
    hasEmbeddingModel,
    enabled: row.enabled,
    hasKey: row.apiKeyEnc !== null,
    apiKeyPreview: row.apiKeyEnc === null ? null : buildPreview(row.apiKeyEnc, row.id),
    credentialMode: row.credentialMode,
    userHasKey,
    modelCount: row._count.models,
    createdBy: row.createdBy,
    creatorName: row.creator.nickname ?? row.creator.username,
    canEdit: canEditAsset({ ownerId: row.createdBy }, viewer),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 某个 Provider 下**是否存在 EMBEDDING 模型**（单条查询；`toItem` 的第四个入参）。
 *
 * 用途见 `ModelProviderItem.hasEmbeddingModel`：向量模型把该 Provider 的协议钉死在 OpenAI 兼容。
 * 单条路径（建 / 改 / 转移）用它；列表路径用 {@link embeddingModelProviderIds}（一条 `distinct`）。
 */
async function hasEmbeddingModelOf(providerId: string): Promise<boolean> {
  const row = await getPrisma().model.findFirst({
    where: { providerId, type: 'EMBEDDING' },
    select: { id: true },
  })
  return row !== null
}

/** 一批 Provider 里**挂着向量模型的那些 id**（列表用的一条查询，避免逐条 N+1） */
async function embeddingModelProviderIds(providerIds: readonly string[]): Promise<Set<string>> {
  if (providerIds.length === 0) return new Set()
  const rows = await getPrisma().model.findMany({
    where: { providerId: { in: [...providerIds] }, type: 'EMBEDDING' },
    select: { providerId: true },
    distinct: ['providerId'],
  })
  return new Set(rows.map((row) => row.providerId))
}

/** P1-18：调用者是否已为某个 Provider 配置了**自己的** Key（列表/详情渲染"我的 Key"用） */
async function viewerHasProviderKey(providerId: string, viewerId: string): Promise<boolean> {
  const row = await getPrisma().providerUserCredential.findUnique({
    where: { providerId_userId: { providerId, userId: viewerId } },
    select: { id: true },
  })
  return row !== null
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
 *
 * ⚠️ 2026-10-16 修订：**读 = 全体登录用户**（平台模型池人人可见、只读），不再按所属人过滤。
 * 每行仍带 `canEdit`（所属人 + ADMIN）供前端门禁编 / 删 / 转移；见文件头口径说明。
 */
export async function listModelProviders(
  query: ListModelProvidersQuery,
  viewer: AssetViewer,
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
  // P1-18：一次查出"我在这批 Provider 里配了 Key 的"（`userHasKey` 投影），避免逐条 N+1
  const ids = rows.map((row) => row.id)
  const mine =
    ids.length === 0
      ? []
      : await db.providerUserCredential.findMany({
          where: { userId: viewer.id, providerId: { in: ids } },
          select: { providerId: true },
        })
  const hasKeySet = new Set(mine.map((row) => row.providerId))
  // 2026-10-22：一次查出"这批 Provider 里哪些挂着向量模型"（`hasEmbeddingModel` 投影），同样避免 N+1
  const embeddingSet = await embeddingModelProviderIds(ids)
  return {
    items: rows.map((row) => toItem(row, viewer, hasKeySet.has(row.id), embeddingSet.has(row.id))),
    total,
    offset: query.offset,
    limit: query.limit,
  }
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
export async function createModelProvider(
  input: CreateModelProviderBody,
  viewer: AssetViewer,
): Promise<ModelProviderItem> {
  const db = getPrisma()
  const apiKey = input.apiKey ?? undefined
  // 默认值**只在这一处补**（`shared` 的 create schema 里 `protocol` 是 optional，故意不用
  // `.default()` —— 用了会让 `z.infer` 与 `z.input` 分叉，`06` P0-1-11 踩过）
  const protocol = input.protocol ?? DEFAULT_UPSTREAM_PROTOCOL

  const created = await db.$transaction(async (tx) => {
    const row = await tx.modelProvider.create({
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        // 默认 false ⇒ 既有拼接行为（默认值只在服务层补一处，理由同 protocol）
        customUrl: input.customUrl ?? false,
        // 显式写出 protocol/enabled：DB 默认也是这两值，但"新 Provider 默认走兼容协议、默认启用"
        // 属于契约，不该藏在迁移里
        protocol,
        enabled: input.enabled ?? true,
        apiKeyEnc: null,
        credentialMode: input.credentialMode ?? 'SHARED',
        createdBy: viewer.id,
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
    {
      providerId: created.id,
      name: created.name,
      protocol: created.protocol,
      credentialMode: created.credentialMode,
      hasKey: apiKey !== undefined,
    },
    '已创建模型 Provider（Key 已加密落库，明文不再出现）',
  )
  // 新建的 Provider 下**必然还没有任何模型** ⇒ `hasEmbeddingModel` 恒 false
  return toItem(created, viewer, false, false)
}

/**
 * 改 Provider（`02` §4.3）：`apiKey` 的**三态**语义见 `shared/src/modelProvider.ts` 的表。
 *
 * ⚠️ 2026-10-22：**没有"改类型"这条路了**（`type` 列整列删除）。原先那条"有模型就不许改 type
 * → 409"随方案A一起废除 —— Provider 现在只是"上游终点"（baseUrl + Key + protocol）。
 * 见 `docs/子方案/Provider与模型类型解耦.md`。
 *
 * **`protocol` 的守卫只有一条**（P0-1-37 立、2026-10-22 改口径）：**该 Provider 下存在
 * EMBEDDING 模型**时，协议只能是默认值（判据 = `shared` 的 `vectorModelRequiresCompatProtocol`，
 * 只有一份）—— embedding 只有 `/embeddings` 一条路，配个 Anthropic 协议只会造出"一建就失败
 * 的向量模型"。⚠️ 「只改 protocol」这条路在 schema 里判不了（那里看不到库里的模型），
 * 所以必须在这里判。其余刻意**不加**守卫：改 protocol 不动任何数据形状，填错了就该能改回来。
 *
 * @throws {AppError} `NOT_FOUND`(404) 目标不存在
 *                    / `VALIDATION`(400) 该 Provider 有向量模型而协议非兼容（字段级指向 `body.protocol`）
 */
export async function updateModelProvider(
  id: string,
  input: UpdateModelProviderBody,
  viewer: AssetViewer,
): Promise<ModelProviderItem> {
  const db = getPrisma()
  const target = await db.modelProvider.findUnique({
    where: { id },
    select: {
      id: true,
      protocol: true,
      createdBy: true,
    },
  })
  if (target === null) throw AppError.notFound('Provider 不存在')

  // P1-13：编 = 仅所属人 / ADMIN（系统级 Provider 的 owner 是 ADMIN ⇒ 非 ADMIN 恒 false）
  if (!canEditAsset({ ownerId: target.createdBy }, viewer)) {
    throw AppError.forbidden('只有该 Provider 的所属人或管理员可以修改它')
  }

  const hasEmbeddingModel = await hasEmbeddingModelOf(id)

  /**
   * 合并后判一次（协议可能只在库里、也可能只在请求里）。判据 = **该 Provider 下有没有向量模型**
   * —— 这是唯一与"这条 Provider 能配什么协议"有关的事实（Provider 已无 `type` 列）。
   */
  if (!vectorModelRequiresCompatProtocol(hasEmbeddingModel, input.protocol ?? target.protocol)) {
    throw AppError.validation(VECTOR_MODEL_PROTOCOL_CONFLICT_MESSAGE, {
      fields: [{ path: 'body.protocol', message: VECTOR_MODEL_PROTOCOL_CONFLICT_MESSAGE }],
    })
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
        ...(input.customUrl === undefined ? {} : { customUrl: input.customUrl }),
        ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.credentialMode === undefined ? {} : { credentialMode: input.credentialMode }),
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
      protocol: input.protocol,
      credentialMode: input.credentialMode,
    },
    '已更新模型 Provider',
  )
  return toItem(updated, viewer, await viewerHasProviderKey(id, viewer.id), hasEmbeddingModel)
}

/**
 * 删 Provider 前列出"其下**被在线智能体绑定或被知识库用作向量模型**的模型"
 * （`GET /api/model-providers/:id/bound-models`）。
 *
 * 供删除弹窗如实展示"删了会解绑哪些模型、影响多少智能体 / 多少知识库"（需求 3）。
 * 只算 `deletedAt: null` 的在线智能体（软删的本就已解绑，不该再计入吓唬管理员）。
 * ⚠️ 知识库侧（`knowledge_bases.embedding_model_id`）2026-10-22 补：级联删掉的向量模型会
 * 让那些库的引用被 `ON DELETE SET NULL` 静默清空，故一并计数（否则管理员完全看不到）。
 *
 * @throws {AppError} `NOT_FOUND`(404) Provider 不存在
 */
export async function getProviderBoundModels(
  id: string,
  _viewer: AssetViewer,
): Promise<ProviderBoundModelsResult> {
  const db = getPrisma()
  const provider = await db.modelProvider.findUnique({
    where: { id },
    select: { id: true },
  })
  if (provider === null) throw AppError.notFound('Provider 不存在')
  // 2026-10-16 修订：Provider 读 = 全体登录用户（平台模型池）⇒ 不再按所属人拦；只有"不存在"才 404。

  const models = await db.model.findMany({
    where: { providerId: id },
    select: {
      id: true,
      label: true,
      modelName: true,
      _count: {
        select: {
          agents: { where: { deletedAt: null } },
          // 有多少知识库把它当向量 / 图片描述模型用（级联删除时会静默清空这些引用）
          knowledgeBases: true,
          captionKnowledgeBases: true,
          // 平台会话标题模型是否选中了它（单例配置，至多 1 条）
          titleModelConfigs: true,
        },
      },
    },
    orderBy: [{ label: 'asc' }],
  })

  const bound = models
    .filter(
      (m) =>
        m._count.agents > 0 ||
        m._count.knowledgeBases > 0 ||
        m._count.captionKnowledgeBases > 0 ||
        m._count.titleModelConfigs > 0,
    )
    .map((m) => ({
      modelId: m.id,
      label: m.label,
      modelName: m.modelName,
      agentCount: m._count.agents,
      knowledgeBaseCount: m._count.knowledgeBases,
      captionKnowledgeBaseCount: m._count.captionKnowledgeBases,
      usedAsTitleModel: m._count.titleModelConfigs > 0,
    }))
  // 每个在线智能体只绑一个模型 ⇒ 各模型的计数之和即受影响智能体总数（无重复计数）
  const agentTotal = bound.reduce((sum, m) => sum + m.agentCount, 0)
  // 每个知识库至多各绑一个向量模型 + 一个图片描述模型：用"去重后的知识库并集"数更准（一个库可能同时
  // 用了同一 Provider 下的向量模型与图片描述模型），故这里直接查一次库数而非把两个计数相加。
  const knowledgeBaseTotal = await db.knowledgeBase.count({
    where: {
      OR: [
        { embeddingModelRef: { providerId: id } },
        { captionModelRef: { providerId: id } },
      ],
    },
  })
  const clearsTitleModel = bound.some((m) => m.usedAsTitleModel)

  return { providerId: id, models: bound, agentTotal, knowledgeBaseTotal, clearsTitleModel }
}

/**
 * 删 Provider（`02` §4.3；需求 3：自动解绑）。`models.provider_id` 是 `ON DELETE CASCADE`，
 * `agents.model_id` 是 `ON DELETE SET NULL` —— 于是删 Provider 会连带删掉其下**全部模型**，
 * 引用这些模型的**在线**智能体被 DB 自动解绑（`model_id` 置空）、变为"未绑定模型"。
 *
 * ⚠️ 2026-10-22 补：若其下有**向量模型**被知识库引用，级联删模型会让那些库的
 * `knowledge_bases.embedding_model_id` 被 `ON DELETE SET NULL` **静默清空**（库还在、但无法
 * 入库/检索）。删除前数出来、在返回值里回报（{@link RemoveModelProviderResult.clearedKnowledgeBases}），
 * 与 `unboundAgents` 同款 —— 不拦，但必须让人看见。**注意：这里刻意不 409**（级联删除是该接口
 * 的既定语义），拦的是**单删模型**那条路（见 {@link removeModel}）。
 *
 * 不再像旧版那样因"有模型被引用"而 409 拦截：现在删除照常进行，只是把受影响的模型数与
 * 被解绑的在线智能体数如实回报给界面（弹窗已提前用 {@link getProviderBoundModels} 列出清单）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 目标不存在
 */
export async function removeModelProvider(
  id: string,
  viewer: AssetViewer,
): Promise<RemoveModelProviderResult> {
  const db = getPrisma()
  const target = await db.modelProvider.findUnique({
    where: { id },
    select: { id: true, name: true, createdBy: true, _count: { select: { models: true } } },
  })
  if (target === null) throw AppError.notFound('Provider 不存在')
  // P1-13：删 = 仅所属人 / ADMIN（系统级 Provider 只有 ADMIN 能删）
  if (!canEditAsset({ ownerId: target.createdBy }, viewer)) {
    throw AppError.forbidden('只有该 Provider 的所属人或管理员可以删除它')
  }

  // 删除前数一遍"会被自动解绑的在线智能体"（删除后 SetNull 已生效，就数不到了）
  const unboundAgents = await db.agent.count({
    where: { deletedAt: null, model: { providerId: id } },
  })
  /**
   * 删除前数一遍"向量 / 图片描述模型会被清空的知识库"（2026-10-22 补）。
   *
   * ⚠️ 这条**必须显式数**：级联删掉其下模型后，那些用其中某个模型当向量 / 图片描述的知识库的
   * 对应列会被 `ON DELETE SET NULL` 静默清空（库还在、但无法入库/检索、图片描述入库 409），
   * 删除后**再查就查不到了** —— 与 `unboundAgents` 同一个理由。一个库可能同时用了向量与图片描述
   * 两个模型 ⇒ 用 `OR` 去重计数（而不是把两路相加）。
   */
  const clearedKnowledgeBases = await db.knowledgeBase.count({
    where: {
      OR: [
        { embeddingModelRef: { providerId: id } },
        { captionModelRef: { providerId: id } },
      ],
    },
  })
  /** 平台会话标题模型是否会被这次删除清空（单例配置的 `modelId` 落在这个 Provider 的模型下） */
  const clearedTitleModel =
    (await db.titleModelConfig.count({ where: { model: { providerId: id } } })) > 0
  const deletedModels = target._count.models

  try {
    // 级联：其下 models 随 Provider 删除，引用这些模型的 agent 由 ON DELETE SET NULL 自动解绑
    await db.modelProvider.delete({ where: { id } })
  } catch (error) {
    if (hasPrismaCode(error, 'P2025')) throw AppError.notFound('Provider 不存在')
    throw error
  }

  getLogger().info(
    { providerId: id, name: target.name, deletedModels, unboundAgents, clearedKnowledgeBases, clearedTitleModel },
    '已删除模型 Provider（其下模型级联删除，引用它们的在线智能体已自动解绑）',
  )
  return {
    id: target.id,
    name: target.name,
    deletedModels,
    unboundAgents,
    clearedKnowledgeBases,
    clearedTitleModel,
  }
}

// ═════════════════════════════════════════════════════════════════════
// Provider 用户级凭据（P1-18 · 子批 C；"各自 Key" 模式的「我的 Key」）
// ═════════════════════════════════════════════════════════════════════

/**
 * 读"我的 Key"状态（`GET /api/model-providers/:id/my-credential`）。
 *
 * ⚠️ 与 Provider 共享 Key 同一条不变式：**只有布尔 + 掩码**（`apiKeyPreview` 由解密后取首尾生成，
 * 顺带证明密文解得开）。**凭据是个人隐私** —— 任何人（含 ADMIN）都读不到别人的这一行。
 */
async function readMyCredentialItem(providerId: string, userId: string): Promise<ProviderUserCredentialItem> {
  const row = await getPrisma().providerUserCredential.findUnique({
    where: { providerId_userId: { providerId, userId } },
    select: { apiKeyEnc: true },
  })
  if (row === null) return { hasKey: false, apiKeyPreview: null }
  try {
    return {
      hasKey: true,
      apiKeyPreview: maskApiKey(decryptSecret(row.apiKeyEnc, providerUserKeyAad(userId, providerId))),
    }
  } catch (error) {
    // 与 Provider 掩码降级同款：解不开不掀桌（`hasKey` 仍为 true = Key 还在，只是本进程解不开）
    getLogger().warn({ providerId, userId, err: error }, '用户级 Provider Key 解密失败，掩码降级为 ****')
    return { hasKey: true, apiKeyPreview: '****' }
  }
}

/** 确认 Provider 存在（`my-credential` 三条端点的共同前置；不存在 ⇒ 404） */
async function assertProviderExists(providerId: string): Promise<void> {
  const row = await getPrisma().modelProvider.findUnique({ where: { id: providerId }, select: { id: true } })
  if (row === null) throw AppError.notFound('Provider 不存在')
}

/**
 * 读"我的 Key"（`GET /:id/my-credential`，**登录即可**）。
 * 任何登录用户都能读**自己**的状态（凭据是个人隐私，ADMIN 无后门）。
 */
export async function getMyProviderCredential(
  providerId: string,
  viewer: AssetViewer,
): Promise<ProviderUserCredentialItem> {
  await assertProviderExists(providerId)
  return readMyCredentialItem(providerId, viewer.id)
}

/**
 * 写入/替换"我的 Key"（`PUT /:id/my-credential`，**登录即可**）。
 *
 * 与可见范围**正交**：可见范围管"谁能用"，凭据模式管"用谁的 Key"。`credentialMode=PER_USER` 时，
 * 调用链会取**调用者**的这一行；缺则在调用时 **424 `NEED_CREDENTIAL`**。
 */
export async function setMyProviderCredential(
  providerId: string,
  apiKey: string,
  viewer: AssetViewer,
): Promise<ProviderUserCredentialItem> {
  await assertProviderExists(providerId)
  const enc = encryptSecret(apiKey, providerUserKeyAad(viewer.id, providerId))
  await getPrisma().providerUserCredential.upsert({
    where: { providerId_userId: { providerId, userId: viewer.id } },
    create: { providerId, userId: viewer.id, apiKeyEnc: enc },
    update: { apiKeyEnc: enc },
  })
  getLogger().info({ providerId, userId: viewer.id }, '已设置用户级 Provider Key（密文，明文不再出现）')
  return readMyCredentialItem(providerId, viewer.id)
}

/** 清空"我的 Key"（`DELETE /:id/my-credential`，**登录即可**）。幂等：本来没配 ⇒ 什么都不做。 */
export async function deleteMyProviderCredential(
  providerId: string,
  viewer: AssetViewer,
): Promise<ProviderUserCredentialItem> {
  await assertProviderExists(providerId)
  await getPrisma().providerUserCredential.deleteMany({ where: { providerId, userId: viewer.id } })
  getLogger().info({ providerId, userId: viewer.id }, '已清空用户级 Provider Key')
  return readMyCredentialItem(providerId, viewer.id)
}

/**
 * `GET /api/model-providers/my-credentials` —— **「我的凭据」页的 Provider 凭据清单**。
 *
 * ⚠️ 2026-10-16 修订（用户定案）：**只列"我自己的"凭据** —— 别人的配置不该出现在我的凭据里。
 *   · **我作为所属人**的 Provider（任何模式）都列 —— **共享 Key 只给所属人看**（别人看不到 admin 配的共享 Key）。
 *   · **全部启用的「各自 Key」（`PER_USER`）Provider** 都列（**含未配置**）—— 平台模型池人人可见，
 *     任何使用者都可能要给它配自己的 Key；只按"我能用的 Agent"倒推会让**还没有 Agent 的使用者**
 *     看到"去我的凭据配"却在那里找不到入口（2026-10-16 修的 bug）。
 *   · 与我无关的 `SHARED` Provider **一律不列**。
 *
 * 两种模式的 `hasKey`/`apiKeyPreview` 主语：
 *   · `PER_USER`：**我**的 Key 状态（可就地配置）。
 *   · `SHARED`  ：Provider **共享 Key** 的状态与掩码（**只读**，改它去模型池编辑表单；只有所属人看得到）。
 *
 * ⚠️ 与 Provider 投影同一条不变式：只有布尔 + 掩码（`apiKeyPreview` 由解密后取首尾生成），**无明文**。
 */
export async function listMyProviderCredentials(viewer: AssetViewer): Promise<MyProviderCredentialEntry[]> {
  const db = getPrisma()

  // ① 我可见的 Agent → 模型 → `PER_USER` Provider：这些是"我可能要配自己 Key"的（含未配置）
  const groupIds = await groupIdsOfUser(viewer.id)
  const agents = await db.agent.findMany({
    where: { deletedAt: null, ...assetVisibilityWhere({ ...viewer, groupIds }, { withAudience: true }) },
    select: { modelId: true, pool: { select: { modelId: true } } },
  })
  const modelIds = new Set<string>()
  for (const agent of agents) {
    if (agent.modelId !== null) modelIds.add(agent.modelId)
    for (const entry of agent.pool) modelIds.add(entry.modelId)
  }
  const perUserFromAgents = new Set<string>()
  if (modelIds.size > 0) {
    const models = await db.model.findMany({
      where: { id: { in: [...modelIds] } },
      select: { providerId: true, provider: { select: { credentialMode: true } } },
    })
    for (const row of models) {
      if (row.provider.credentialMode === 'PER_USER') perUserFromAgents.add(row.providerId)
    }
  }

  // ② 要展示的 Provider：
  //   · **我所属人**的（任何模式）—— 共享 Key 只给所属人看；
  //   · **全部启用的「各自 Key」Provider** —— 平台模型池人人可见（2026-10-16 修订），任何使用者
  //     都可能需要给它配自己的 Key ⇒ 一律给配置入口（含未配置）。否则会出现死路：成员在模型池
  //     看到该 Provider、被提示"去我的凭据配置"，而「我的凭据」里根本没有它（bug 2026-10-16）。
  //   · 我能用的 Agent 引用到的 `PER_USER`（可能其 Provider 已停用，仍列出以便发现）。
  const rows = await db.modelProvider.findMany({
    where: {
      OR: [
        { createdBy: viewer.id },
        { credentialMode: 'PER_USER', enabled: true },
        ...(perUserFromAgents.size > 0 ? [{ id: { in: [...perUserFromAgents] } }] : []),
      ],
    },
    select: { id: true, name: true, credentialMode: true, apiKeyEnc: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  if (rows.length === 0) return []

  // ③ 我的 Key 状态（只有 `PER_USER` 行才查；只布尔 + 掩码）
  const perUserIds = rows.filter((row) => row.credentialMode === 'PER_USER').map((row) => row.id)
  const mine =
    perUserIds.length === 0
      ? []
      : await db.providerUserCredential.findMany({
          where: { providerId: { in: perUserIds }, userId: viewer.id },
          select: { providerId: true, apiKeyEnc: true },
        })
  const encByProvider = new Map(mine.map((row) => [row.providerId, row.apiKeyEnc]))

  return rows.map((row): MyProviderCredentialEntry => {
    // 共享 Key：读数来自 Provider 自己的密文（**只读**；能出现在这里 ⇒ 我是所属人）
    if (row.credentialMode === 'SHARED') {
      return {
        providerId: row.id,
        providerName: row.name,
        credentialMode: 'SHARED',
        hasKey: row.apiKeyEnc !== null,
        apiKeyPreview: row.apiKeyEnc === null ? null : buildPreview(row.apiKeyEnc, row.id),
      }
    }
    const enc = encByProvider.get(row.id)
    if (enc === undefined) {
      return { providerId: row.id, providerName: row.name, credentialMode: 'PER_USER', hasKey: false, apiKeyPreview: null }
    }
    try {
      return {
        providerId: row.id,
        providerName: row.name,
        credentialMode: 'PER_USER',
        hasKey: true,
        apiKeyPreview: maskApiKey(decryptSecret(enc, providerUserKeyAad(viewer.id, row.id))),
      }
    } catch (error) {
      getLogger().warn({ providerId: row.id, userId: viewer.id, err: error }, '用户级 Provider Key 解密失败，掩码降级为 ****')
      return { providerId: row.id, providerName: row.name, credentialMode: 'PER_USER', hasKey: true, apiKeyPreview: '****' }
    }
  })
}

/**
 * 转移 Provider 所属人（`POST /api/model-providers/:id/transfer`，**所属人 / ADMIN**）。
 * 口径同 `agent.service.ts#transferAgent`（P1-18 起 Provider **无分享**，故无随行数据要处理）。
 */
export async function transferModelProvider(
  id: string,
  toUserId: string,
  viewer: AssetViewer,
): Promise<ModelProviderItem> {
  const db = getPrisma()
  const target = await db.modelProvider.findUnique({
    where: { id },
    select: { id: true, createdBy: true },
  })
  if (target === null) throw AppError.notFound('Provider 不存在')
  if (!canEditAsset({ ownerId: target.createdBy }, viewer)) {
    throw AppError.forbidden('只有该 Provider 的所属人或管理员可以转移它')
  }
  if (toUserId === target.createdBy) {
    throw AppError.validation('接收人已经是该 Provider 的所属人，无需转移')
  }
  const newOwner = await db.user.findUnique({
    where: { id: toUserId },
    select: { id: true, status: true },
  })
  if (newOwner === null || newOwner.status !== 'ACTIVE') {
    throw AppError.validation('接收人不存在或不是有效（ACTIVE）用户')
  }
  const updated = await db.modelProvider.update({
    where: { id },
    data: { createdBy: toUserId },
    select: PROVIDER_SELECT,
  })
  getLogger().info({ providerId: id, from: target.createdBy, to: toUserId }, '已转移 Provider 所属人')
  return toItem(updated, viewer, await viewerHasProviderKey(id, viewer.id), await hasEmbeddingModelOf(id))
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
  embeddingDim: true,
  embeddingMultimodal: true,
  supportsVision: true,
  supportsReasoning: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  provider: {
    select: {
      name: true,
      baseUrl: true,
      enabled: true,
      createdBy: true,
      creator: { select: { username: true, nickname: true } },
    },
  },
  // 只算**在线**智能体（未软删）：软删的智能体删除时已把 model_id 置空、不再占用模型；
  // 但为兼容历史软删行（迁移前置空逻辑上线前留下的），这里显式过滤 deletedAt: null，
  // 保证"删了智能体、模型就不再显示被绑定"（删智能体自动解绑）。
  _count: {
    select: {
      agents: { where: { deletedAt: null } },
      // 有多少知识库把它当 embedding 用（编辑被引用的向量模型时要提示这些库需重建）
      knowledgeBases: true,
      // 2026-10-22 同族补漏：有多少知识库把它当**图片描述（VLM）**用（`caption_model_id`）
      captionKnowledgeBases: true,
      // 2026-10-22 同族补漏：平台**会话标题**模型是否选中了它（`title_model_config.model_id`，单行）
      titleModelConfigs: true,
    },
  },
} as const

/** {@link MODEL_MANAGE_SELECT} 的产物形态 */
interface ModelRow {
  id: string
  providerId: string
  modelName: string
  label: string
  type: ModelItem['type']
  maxContext: number | null
  embeddingDim: number | null
  embeddingMultimodal: boolean
  supportsVision: boolean
  supportsReasoning: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  provider: { name: string; baseUrl: string; enabled: boolean; createdBy: string; creator: { username: string; nickname: string | null } }
  _count: { agents: number; knowledgeBases: number; captionKnowledgeBases: number; titleModelConfigs: number }
}

/** 可选列表的查询字段（`GET /api/models/available`）：只要下拉需要的，管理字段一律不带 */
const MODEL_OPTION_SELECT = {
  id: true,
  providerId: true,
  modelName: true,
  label: true,
  type: true,
  maxContext: true,
  embeddingDim: true,
  supportsVision: true,
  supportsReasoning: true,
  provider: { select: { name: true, credentialMode: true } },
} as const

/** {@link MODEL_OPTION_SELECT} 的产物形态 */
interface ModelOptionRow {
  id: string
  providerId: string
  modelName: string
  label: string
  type: ModelOption['type']
  maxContext: number | null
  embeddingDim: number | null
  supportsVision: boolean
  supportsReasoning: boolean
  provider: { name: string; credentialMode: ModelOption['providerCredentialMode'] }
}

function toModelItem(row: ModelRow, viewer: AssetViewer): ModelItem {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: row.provider.name,
    providerBaseUrl: row.provider.baseUrl,
    providerEnabled: row.provider.enabled,
    modelName: row.modelName,
    label: row.label,
    type: row.type,
    maxContext: row.maxContext,
    embeddingDim: row.embeddingDim,
    embeddingMultimodal: row.embeddingMultimodal,
    supportsVision: row.supportsVision,
    supportsReasoning: row.supportsReasoning,
    enabled: row.enabled,
    agentCount: row._count.agents,
    knowledgeBaseCount: row._count.knowledgeBases,
    captionKnowledgeBaseCount: row._count.captionKnowledgeBases,
    usedAsTitleModel: row._count.titleModelConfigs > 0,
    providerOwnerId: row.provider.createdBy,
    providerOwnerName: row.provider.creator.nickname ?? row.provider.creator.username,
    // P1-13：模型随 Provider 编删 ⇒ 编删权随 Provider（所属人或 ADMIN）
    canEdit: canEditAsset({ ownerId: row.provider.createdBy }, viewer),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toModelOption(row: ModelOptionRow, myProviderKeyIds: ReadonlySet<string>): ModelOption {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: row.provider.name,
    modelName: row.modelName,
    label: row.label,
    type: row.type,
    maxContext: row.maxContext,
    embeddingDim: row.embeddingDim,
    supportsVision: row.supportsVision,
    supportsReasoning: row.supportsReasoning,
    // P1-18：把"凭据模式 + 我有没有自己的 Key"随模型下发 —— 智能体表单据此就地提示
    // "选了它但还没配 Key，去「我的凭据」"。`providerUserHasKey` 只有布尔，凭据无明文。
    providerCredentialMode: row.provider.credentialMode,
    providerUserHasKey: myProviderKeyIds.has(row.providerId),
  }
}

/**
 * 模型列表（`GET /api/models`，登录即可）。
 *
 * 排序 `createdAt asc, id asc`：与 Provider 列表同一口径（按录入顺序展示最直观，
 * `id` 兜底保证分页稳定）。模型条数比 Provider 多，但管理页自己会按 `providerName` 分组，
 * 故不在这里做"按 Provider 名排序"——排序键与索引无关地多一层，反而更难解释分页结果。
 *
 * ⚠️ 2026-10-16 修订：**读 = 全体登录用户**（平台模型池人人可见、只读），不再按所属 Provider 过滤；
 * 每行仍带 `canEdit`（所属 Provider 的所属人 + ADMIN）供前端门禁编 / 删。
 */
export async function listModels(query: ListModelsQuery, viewer: AssetViewer): Promise<OffsetPage<ModelItem>> {
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
  return { items: rows.map((row) => toModelItem(row, viewer)), total, offset: query.offset, limit: query.limit }
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
 *
 * ⚠️ 2026-10-16 修订：**不再按 Provider 所属人过滤**（平台模型池共享）。`viewer` 仅用于
 * 回填"我在哪些 PER_USER Provider 上已配 Key"（`providerUserHasKey`），不参与可见性。
 */
export async function listAvailableModels(
  query: ListAvailableModelsQuery,
  viewer: AssetViewer,
): Promise<ModelOption[]> {
  const db = getPrisma()
  const rows = await db.model.findMany({
    where: {
      type: query.type,
      enabled: true,
      // 2026-10-16 修订：可选列表**不再按 Provider 所属人过滤** —— 平台模型池是共享的，
      // 任何登录用户建 Agent 时都要能选到管理员建的模型（P1-18 初版按"所属人 + ADMIN"过滤，
      // 会让 MEMBER 的下拉直接为空）。`provider.enabled` 这条门槛保留（停用 Provider 的模型选了也会失败）。
      provider: { enabled: true },
    },
    select: MODEL_OPTION_SELECT,
    orderBy: [{ providerId: 'asc' }, { modelName: 'asc' }, { id: 'asc' }],
  })
  // P1-18：一次查出"我在哪些 PER_USER Provider 上已配了自己的 Key"（只有布尔用得上）。
  // 只为结果里出现的 PER_USER Provider 查（空集就不发这条查询）。
  const perUserProviderIds = [...new Set(
    rows.filter((row) => row.provider.credentialMode === 'PER_USER').map((row) => row.providerId),
  )]
  const myKeyIds = new Set<string>()
  if (perUserProviderIds.length > 0) {
    const mine = await db.providerUserCredential.findMany({
      where: { userId: viewer.id, providerId: { in: perUserProviderIds } },
      select: { providerId: true },
    })
    for (const entry of mine) myKeyIds.add(entry.providerId)
  }
  return rows.map((row) => toModelOption(row, myKeyIds))
}

/**
 * 探测某 Provider 下某型号的 **embedding 维度**（建/改**向量模型**时用）。
 *
 * 用 `readProviderCredential` 拿到 baseUrl/customUrl/key 后发一次极小 `/embeddings` 请求。
 * 失败即抛（由调用方翻成可展示的错误）—— 向量模型没有维度就没法用于知识库，宁可建的时候失败。
 */
async function probeDimForProvider(
  providerId: string,
  modelName: string,
  multimodal: boolean,
  subjectUserId: string | null,
): Promise<number> {
  const credential = await readProviderCredential(providerId, subjectUserId)
  return probeEmbeddingDim(
    {
      providerName: credential.providerName,
      baseUrl: credential.baseUrl,
      customUrl: credential.customUrl,
      multimodal,
      apiKey: credential.apiKey,
      apiModel: modelName,
    },
    config.embedding.batchSize,
  )
}

/**
 * **尽力**探测维度：失败返回 `null` 并告警，**不阻断**模型的创建/修改。
 *
 * 为什么不像知识库那样硬失败：不是所有 embedding 端点都能按标准 OpenAI 形状探测
 * （多模态/特殊实现会在 `/embeddings` 上 400），而"登记一个向量模型"不该被探测卡住。
 * 探测不到的，由管理员在模型编辑里**手动填写维度**。
 */
async function tryProbeDimForProvider(
  providerId: string,
  modelName: string,
  multimodal: boolean,
  subjectUserId: string | null,
): Promise<number | null> {
  try {
    return await probeDimForProvider(providerId, modelName, multimodal, subjectUserId)
  } catch (error) {
    getLogger().warn(
      { providerId, modelName, multimodal, err: error },
      '向量模型维度探测失败（不阻断保存）；可在模型编辑里手动填写维度',
    )
    return null
  }
}

/**
 * 建模型（`POST /api/models`，登录 + 行级：该 Provider 所属人 / ADMIN）。
 *
 * 四条守卫按"先查再说人话"排：
 *   ① Provider 必须存在 —— 不存在时若直接 create，会撞 `models_provider_id_fkey` 抛 `P2003`（500）；
 *   ② **向量模型只能建在兼容协议的 Provider 上**（2026-10-22 起，取代原先的"类型跟随 Provider"）：
 *      `type=EMBEDDING` 时该 Provider 的 `protocol` 必须是 OpenAI 兼容（embedding 只有
 *      `/embeddings` 一条路）。Provider 上**已无** `type` 列 ⇒ 类型是模型自己的用途，
 *      同一个 Provider（同一个 baseUrl + 同一把 Key）下可以同时挂对话与向量模型；
 *   ③ **向量模型探测维度**：`type=EMBEDDING` 时向上游探测输出维度并落库（对话模型恒 null）；
 *   ④ `(providerId, modelName, type)` 唯一（`schema.prisma` 的 `@@unique`）——
 *      先查一遍给出可读文案，再 `catch P2002` 兜住并发窗口（`user.service.ts` 同款双保险）。
 */
export async function createModel(input: CreateModelBody, viewer: AssetViewer): Promise<ModelItem> {
  const db = getPrisma()

  const provider = await db.modelProvider.findUnique({
    where: { id: input.providerId },
    select: { id: true, protocol: true, createdBy: true },
  })
  if (provider === null) throw AppError.notFound('Provider 不存在')
  // P1-13：模型随 Provider 编删 —— 只有 Provider 的所属人 / ADMIN 能在其下建模型
  if (!canEditAsset({ ownerId: provider.createdBy }, viewer)) {
    throw AppError.forbidden('只有该 Provider 的所属人或管理员可以在其下创建模型')
  }

  // ② 向量模型 × 上游协议：拦在建之前，给出可读的字段级 400（判据与"改 Provider 协议"共用一份）
  if (input.type === 'EMBEDDING' && !embeddingModelAllowedOnProtocol(provider.protocol)) {
    throw AppError.validation(EMBEDDING_MODEL_PROTOCOL_CONFLICT_MESSAGE, {
      fields: [{ path: 'body.type', message: EMBEDDING_MODEL_PROTOCOL_CONFLICT_MESSAGE }],
    })
  }

  const duplicated = await db.model.findFirst({
    where: { providerId: input.providerId, modelName: input.modelName, type: input.type },
    select: { id: true },
  })
  if (duplicated !== null) {
    throw AppError.conflict(`该 Provider 下已存在同型号同类型的模型：${input.modelName}`)
  }

  // ③ 向量模型：维度优先用请求里显式给的；否则**尽力**探测一次（探测失败不阻断保存，留空由管理员补填）
  const isEmbedding = input.type === 'EMBEDDING'
  const embeddingMultimodal = isEmbedding ? input.embeddingMultimodal ?? false : false
  let embeddingDim: number | null = null
  if (isEmbedding) {
    embeddingDim =
      input.embeddingDim ?? (await tryProbeDimForProvider(input.providerId, input.modelName, embeddingMultimodal, viewer.id))
  }

  let created: ModelRow
  try {
    created = await db.model.create({
      data: {
        providerId: input.providerId,
        modelName: input.modelName,
        label: input.label,
        type: input.type,
        // 向量模型不写对话侧字段（上下文/图片/思考），对话模型按输入写
        maxContext: isEmbedding ? null : input.maxContext ?? null,
        embeddingDim,
        embeddingMultimodal,
        // 显式写出两个默认值：DB 默认也是 false/true，但"新模型默认启用、默认不支持图片"
        // 属于契约，不该藏在迁移里（与 createModelProvider 同款理由）
        supportsVision: isEmbedding ? false : input.supportsVision ?? false,
        supportsReasoning: isEmbedding ? false : input.supportsReasoning ?? false,
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
  return toModelItem(created, viewer)
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
 * ④ **改成向量模型时所属 Provider 的协议必须兼容**（2026-10-22 起）→ 400（字段级指向 `body.type`）。
 *    与建模型共用 `embeddingModelAllowedOnProtocol`；`type` **不再**要求等于 Provider 的 `type`。
 *
 * `maxContext` 走三态（缺省不动 / `null` 清空 / 数字设置），与 Provider 的 `apiKey` 同款口径 ——
 * 合并成一个 `.default(null)` 的话，"改个别名"会把上下文长度顺手抹掉。
 *
 * @throws {AppError} `NOT_FOUND`(404) 模型不存在 / `CONFLICT`(409) 三条守卫
 *                    / `VALIDATION`(400) 改成向量而 Provider 协议非兼容
 */
export async function updateModel(id: string, input: UpdateModelBody, viewer: AssetViewer): Promise<ModelItem> {
  const db = getPrisma()
  const target = await db.model.findUnique({
    where: { id },
    select: {
      id: true,
      providerId: true,
      modelName: true,
      type: true,
      embeddingDim: true,
      embeddingMultimodal: true,
      provider: { select: { createdBy: true, protocol: true } },
      _count: { select: { agents: true } },
    },
  })
  if (target === null) throw AppError.notFound('模型不存在')
  // P1-13：模型随 Provider 编删 —— 仅 Provider 的所属人 / ADMIN
  if (!canEditAsset({ ownerId: target.provider.createdBy }, viewer)) {
    throw AppError.forbidden('只有该模型所属 Provider 的所属人或管理员可以修改它')
  }

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

  /**
   * 2026-10-22：改成（或本来就是）向量模型时，所属 Provider 的协议必须兼容 —— 与建模型同一判据。
   * ⚠️ 只判 `nextType === 'EMBEDDING'`：这是"这条模型能不能是向量"的判据，与 `input.type` 是否
   * 带了无关（PATCH 只改别名、库里本来就是向量 ⇒ 也该拦在一个不兼容的 Provider 上吗？
   * 会的场景只有"Provider 协议先被改成非兼容"——而那条路已被 `updateModelProvider` 拦住，
   * 所以这里只可能命中"这次要把这条改成向量"）。
   */
  if (nextType === 'EMBEDDING' && !embeddingModelAllowedOnProtocol(target.provider.protocol)) {
    throw AppError.validation(EMBEDDING_MODEL_PROTOCOL_CONFLICT_MESSAGE, {
      fields: [{ path: 'body.type', message: EMBEDDING_MODEL_PROTOCOL_CONFLICT_MESSAGE }],
    })
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

  const nextIsEmbedding = nextType === 'EMBEDDING'
  const nextMultimodal = nextIsEmbedding ? input.embeddingMultimodal ?? target.embeddingMultimodal : false
  // 向量模型：维度优先用请求里显式给的；改名/维度缺失/切换了端点形状时尽力重探（失败留空，不阻断）
  let embeddingDimData: { embeddingDim?: number | null } = {}
  if (nextIsEmbedding) {
    if (input.embeddingDim !== undefined) {
      embeddingDimData = { embeddingDim: input.embeddingDim }
    } else if (
      nextModelName !== target.modelName ||
      target.embeddingDim === null ||
      input.embeddingMultimodal !== undefined
    ) {
      embeddingDimData = {
        embeddingDim: await tryProbeDimForProvider(target.providerId, nextModelName, nextMultimodal, viewer.id),
      }
    }
  } else if (target.type === 'EMBEDDING') {
    embeddingDimData = { embeddingDim: null }
  }

  let updated: ModelRow
  try {
    updated = await db.model.update({
      where: { id },
      data: {
        ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.type === undefined ? {} : { type: input.type }),
        // 向量模型不写对话侧字段（上下文/图片/思考）；对话模型按输入走三态
        ...(nextIsEmbedding
          ? { maxContext: null, supportsVision: false, supportsReasoning: false, embeddingMultimodal: nextMultimodal }
          : {
              // 三态落点：undefined = 不带这一列（不动）；null = 显式清空；number = 设置
              ...(input.maxContext === undefined ? {} : { maxContext: input.maxContext }),
              ...(input.supportsVision === undefined ? {} : { supportsVision: input.supportsVision }),
              ...(input.supportsReasoning === undefined ? {} : { supportsReasoning: input.supportsReasoning }),
              ...(target.type === 'EMBEDDING' ? { embeddingMultimodal: false } : {}),
            }),
        ...embeddingDimData,
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
  return toModelItem(updated, viewer)
}

/**
 * 删模型（`DELETE /api/models/:id`，仅 ADMIN）。
 *
 * `agents.model_id` 现在是 `ON DELETE SET NULL`：即便有智能体引用，删模型也会把它们自动解绑
 * （不会撞外键）。但对**在线**智能体来说，"悄悄把模型删了、它下次发消息才发现没模型"体验很差，
 * 所以仍在删之前数一遍**在线**引用并给 409 + 数字（软删的智能体不算 —— 它们本就已解绑/将被 SetNull）。
 *
 * ⚠️ 引用口径有**五处**，缺一即漏检（前三条 2026-10-22 补，后两条 2026-10-22 同族补漏）：
 * ① 作为智能体的**默认模型**（`agents.model_id`）；② 作为其**模型池成员**（`agent_models`，
 * `ON DELETE CASCADE` ⇒ 删了会静默移出池）；③ 作为**知识库的向量模型**
 * （`knowledge_bases.embedding_model_id`，`ON DELETE SET NULL` ⇒ 删了会静默清空该库的绑定，
 * **该库此后无法入库/检索**，而库本身看起来还在）；④ 作为**知识库的图片描述模型**
 * （`knowledge_bases.caption_model_id`，同款 `SetNull` ⇒ 静默清空后"图片描述"入库 409）；
 * ⑤ 作为**平台会话标题模型**（`title_model_config.model_id`，单例，同款 `SetNull` ⇒ 静默清空后
 * 标题退回确定性截断）。五条都在删之前拦一道并给可读的 409 —— 否则"删个模型，好几个智能体 /
 * 知识库 / 平台配置悄悄出问题"没人知道。
 *
 * @throws {AppError} `NOT_FOUND`(404) 模型不存在 / `CONFLICT`(409) 正被在线 Agent、知识库或平台配置使用
 */
export async function removeModel(id: string, viewer: AssetViewer): Promise<{ id: string; modelName: string }> {
  const db = getPrisma()
  const target = await db.model.findUnique({
    where: { id },
    select: { id: true, modelName: true, provider: { select: { createdBy: true } } },
  })
  if (target === null) throw AppError.notFound('模型不存在')
  // P1-13：模型随 Provider 编删 —— 仅 Provider 的所属人 / ADMIN
  if (!canEditAsset({ ownerId: target.provider.createdBy }, viewer)) {
    throw AppError.forbidden('只有该模型所属 Provider 的所属人或管理员可以删除它')
  }

  // 默认模型引用 或 模型池成员引用，任一命中即算"在被在线智能体使用"
  const referencedAgents = await db.agent.count({
    where: { deletedAt: null, OR: [{ modelId: id }, { pool: { some: { modelId: id } } }] },
  })
  if (referencedAgents > 0) {
    throw AppError.conflict(
      `该模型正被 ${referencedAgents} 个智能体使用（默认模型或模型池），无法删除。请先删除或改绑这些智能体`,
    )
  }

  /**
   * ③ 知识库把它当向量模型用（`knowledge_bases.embedding_model_id`）。
   * ⚠️ 这条**最隐蔽**：FK 是 `ON DELETE SET NULL` ⇒ 不拦的话删除照样成功，只是**静默**把那些库的
   * `embedding_model_id` 清成 `NULL` —— 库还在、但再也入库/检索不了。所以必须显式拦。
   */
  const referencedKnowledgeBases = await db.knowledgeBase.count({ where: { embeddingModelId: id } })
  if (referencedKnowledgeBases > 0) {
    throw AppError.conflict(
      `该模型正被 ${referencedKnowledgeBases} 个知识库用作向量模型，无法删除。请先到这些知识库改用别的向量模型（换模型后旧向量需重建）`,
    )
  }

  /**
   * ④ 知识库把它当**图片描述（VLM）**模型用（`knowledge_bases.caption_model_id`，2026-10-22 补）。
   * 同款 `ON DELETE SET NULL` ⇒ 不拦会静默清空这些库的图片描述模型（此后"图片描述"入库 409）。
   */
  const captionKnowledgeBases = await db.knowledgeBase.count({ where: { captionModelId: id } })
  if (captionKnowledgeBases > 0) {
    throw AppError.conflict(
      `该模型正被 ${captionKnowledgeBases} 个知识库用作图片描述模型，无法删除。请先到这些知识库改用别的图片描述模型`,
    )
  }

  /**
   * ⑤ 平台把它选为**会话标题生成模型**（`title_model_config.model_id`，单例；2026-10-22 补）。
   * 同款 `ON DELETE SET NULL` ⇒ 不拦会静默清空平台标题模型（会话标题退回确定性截断）。
   */
  const titleModelConfigs = await db.titleModelConfig.count({ where: { modelId: id } })
  if (titleModelConfigs > 0) {
    throw AppError.conflict(
      '该模型正被平台用作会话标题生成模型，无法删除。请先到「系统设置 · 会话标题模型」改用别的模型',
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
async function readProviderCredential(
  providerId: string,
  subjectUserId: string | null,
): Promise<{ providerName: string; baseUrl: string; customUrl: boolean; apiKey: string | null; protocol: UpstreamProtocol }> {
  const db = getPrisma()
  const row = await db.modelProvider.findUnique({
    where: { id: providerId },
    select: {
      name: true,
      baseUrl: true,
      customUrl: true,
      apiKeyEnc: true,
      protocol: true,
      credentialMode: true,
    },
  })
  if (row === null) throw AppError.notFound('Provider 不存在')
  const base = {
    providerName: row.name,
    baseUrl: row.baseUrl,
    customUrl: row.customUrl,
    protocol: row.protocol,
  }

  // P1-18：**各自 Key** 模式 ⇒ 取**调用者自己的** Key；缺 ⇒ 424 `NEED_CREDENTIAL`
  if (row.credentialMode === 'PER_USER') {
    if (subjectUserId === null) {
      throw AppError.needCredential(
        `Provider「${row.name}」使用「各自 Key」模式，但当前上下文无法确定调用者。请重新发起请求`,
      )
    }
    const cred = await db.providerUserCredential.findUnique({
      where: { providerId_userId: { providerId, userId: subjectUserId } },
      select: { apiKeyEnc: true },
    })
    if (cred === null) {
      throw AppError.needCredential(
        `Provider「${row.name}」使用「各自 Key」模式，你还没有配置自己的 API Key。` +
          '请在「我的凭据」页（或个人模型池里的「我的 Key」）为它配置后重试',
      )
    }
    try {
      return { ...base, apiKey: decryptSecret(cred.apiKeyEnc, providerUserKeyAad(subjectUserId, providerId)) }
    } catch (error) {
      getLogger().warn({ providerId, subjectUserId, err: error }, '用户级 Provider Key 解密失败（无法解析上游目标）')
      throw AppError.internal(
        `你在 Provider「${row.name}」上的 API Key 无法解密（密文可能已损坏，或 CREDENTIAL_MASTER_KEY 已更换）。` +
          '请重新设置你的 Key',
      )
    }
  }

  // `SHARED`（默认）⇒ 用 Provider 自己的 Key
  if (row.apiKeyEnc === null) {
    return { ...base, apiKey: null }
  }
  try {
    return { ...base, apiKey: decryptSecret(row.apiKeyEnc, providerKeyAad(providerId)) }
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
 *   ⓪ **`modelId` 非空** → 否则 409。列 `agents.model_id` 现在可空（删模型商/删模型会
 *      把引用它的智能体自动解绑成 `null`）；一个未绑定模型的智能体不能对话，
 *      给一句"去重新绑定"的可读 409，而不是让 `findUnique(null)` 抛类型错/500；
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
 * @throws {AppError} 见上（409 未绑定 / 404 / 409 / 424 / 500）
 */
export async function resolveChatTarget(
  modelId: string | null,
  subjectUserId: string | null = null,
): Promise<LlmTarget> {
  if (modelId === null) {
    throw AppError.conflict(
      '该智能体未绑定模型（可能因所属模型商/模型被删除而自动解绑）。请在智能体编辑页重新绑定一个模型后再对话',
    )
  }
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
      supportsReasoning: true,
      providerId: true,
      provider: { select: { name: true, baseUrl: true, customUrl: true, enabled: true, protocol: true } },
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

  const credential = await readProviderCredential(row.providerId, subjectUserId)
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
    supportsReasoning: row.supportsReasoning,
    providerId: row.providerId,
    providerName: row.provider.name,
    // 上游协议来自 **Provider**（不是模型）：同一 Provider 下所有模型走同一种协议
    // （`02` §4.3：`protocol` 定义在 `model_providers` 上）
    protocol: row.provider.protocol,
    baseUrl: row.provider.baseUrl,
    customUrl: row.provider.customUrl,
    apiKey: credential.apiKey,
  }
  // 记日志一律走 describeTarget（只打 id/名字/hasKey），**绝不整体序列化 target**（里面是明文 Key）
  getLogger().debug(describeTarget(target), '已解析上游模型目标')
  return target
}

/**
 * 解析「一个 **EMBEDDING** 模型 → 可用于知识库的向量化上游目标」。
 *
 * 与 {@link resolveChatTarget} 同族，但有三处刻意不同：
 *   ① 断言 `type = EMBEDDING`（对话模型不能当 embedding 用）；
 *   ② **不要求配 Key**（内网嵌入式实现常免鉴权，缺 Key 照走，成不成由上游决定）；
 *   ③ 返回的是构造 `ApiEmbeddingProvider` 所需的字段，而不是 {@link LlmTarget}。
 *
 * @throws {AppError} `CONFLICT`(409) 未绑定 / 类型不符 / 模型或 Provider 停用；`NOT_FOUND`(404)；`INTERNAL`(500) Key 解不开
 */
export async function resolveEmbeddingTarget(
  modelId: string | null,
  subjectUserId: string | null = null,
): Promise<{
  modelId: string
  modelName: string
  label: string
  /** 建模型时探测好的维度；`null` = 未记录（本功能上线前的向量模型，调用方需现场探测兜底） */
  embeddingDim: number | null
  /** 是否走多模态 embedding 端点（`/embeddings/multimodal` + content 分片 input） */
  embeddingMultimodal: boolean
  providerName: string
  baseUrl: string
  customUrl: boolean
  apiKey: string | null
}> {
  if (modelId === null) {
    throw AppError.conflict(
      '该知识库未绑定 embedding 模型（可能因建库时未选择、或所选模型已被删除）。请重建知识库并重新选择 embedding 模型',
    )
  }
  const db = getPrisma()
  const row = await db.model.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      modelName: true,
      label: true,
      type: true,
      enabled: true,
      embeddingDim: true,
      embeddingMultimodal: true,
      providerId: true,
      provider: { select: { name: true, enabled: true } },
    },
  })
  if (row === null) throw AppError.notFound('embedding 模型不存在')
  if (row.type !== 'EMBEDDING') {
    throw AppError.conflict(`所选模型不是向量模型（EMBEDDING），不能用于知识库：${row.modelName}`)
  }
  if (!row.enabled) throw AppError.conflict(`所选 embedding 模型已停用：${row.modelName}`)
  if (!row.provider.enabled) {
    throw AppError.conflict(`所选 embedding 模型所属的 Provider「${row.provider.name}」已停用`)
  }

  const credential = await readProviderCredential(row.providerId, subjectUserId)
  return {
    modelId: row.id,
    modelName: row.modelName,
    label: row.label,
    embeddingDim: row.embeddingDim,
    embeddingMultimodal: row.embeddingMultimodal,
    providerName: row.provider.name,
    baseUrl: credential.baseUrl,
    customUrl: credential.customUrl,
    apiKey: credential.apiKey,
  }
}

/**
 * 按**表单值**试探一个向量模型的维度（`POST /api/models/probe-embedding`，仅 ADMIN）。
 *
 * **不落库、不改状态**：让管理员在建/改**向量模型**时**当场**看到维度或真实报错
 * （不必翻后端日志、也不必先保存）。失败时抛上游原文（`UPSTREAM_ERROR`），界面直接展示。
 *
 * @throws {AppError} `NOT_FOUND`(404) Provider 不存在 / `CONFLICT`(409) Provider 已停用 /
 *   `UPSTREAM_ERROR`(502) 探测失败（消息含请求 URL 与上游响应）
 */
export async function probeModelEmbedding(
  input: {
    providerId: string
    modelName: string
    embeddingMultimodal?: boolean
  },
  viewer: AssetViewer,
): Promise<{ dim: number; providerName: string; modelName: string; url: string }> {
  const db = getPrisma()
  const provider = await db.modelProvider.findUnique({
    where: { id: input.providerId },
    select: { id: true, enabled: true, createdBy: true },
  })
  if (provider === null) throw AppError.notFound('Provider 不存在')
  if (!canEditAsset({ ownerId: provider.createdBy }, viewer)) {
    throw AppError.forbidden('只有该 Provider 的所属人或管理员可以探测它')
  }
  if (!provider.enabled) throw AppError.conflict('该 Provider 已停用，无法探测；请先启用它')

  const credential = await readProviderCredential(input.providerId, viewer.id)
  const multimodal = input.embeddingMultimodal === true
  const dim = await probeEmbeddingDim(
    {
      providerName: credential.providerName,
      baseUrl: credential.baseUrl,
      customUrl: credential.customUrl,
      multimodal,
      apiKey: credential.apiKey,
      apiModel: input.modelName,
    },
    config.embedding.batchSize,
  )
  return {
    dim,
    providerName: credential.providerName,
    modelName: input.modelName,
    url: resolveUpstreamUrl(
      { baseUrl: credential.baseUrl, customUrl: credential.customUrl },
      multimodal ? '/embeddings/multimodal' : '/embeddings',
    ),
  }
}

/**
 * 按**表单值**测试一个对话模型能不能用（`POST /api/models/probe-chat`，仅 ADMIN；P1-1）。
 *
 * **不落库、不改状态**：让管理员在建/改**对话模型**时**当场**验证
 * `baseUrl` / Key / 协议 / 型号名这一整条链路 —— 走的是与真实对话**同一个** `chat()`
 * （`llm/client.ts`），只是把 `max_tokens` 压到 `1`、消息压到一条 `ping`。
 * 用真实链路而不是另写一个"探活"的好处：**协议差异（路径 / 鉴权头 / 必填字段）自动被验证到**，
 * 不会出现"探测说通、一发消息就 400"。
 *
 * ⚠️ 与 {@link resolveChatTarget} 的区别：那条要求"模型已落库 + 已启用 + Provider 配了 Key"
 * （它服务的是真实对话）；探测服务的是**还没保存的表单值** ⇒ 只校验 Provider 存在且启用，
 * **不要求 Key**（自建/内网实现常免鉴权，让上游自己回答"通不通"）。也不请求深度思考
 * （探测不该因为一个思考参数把上游打 400）。
 *
 * @throws {AppError} `NOT_FOUND`(404) Provider 不存在 / `CONFLICT`(409) Provider 已停用 /
 *   `UPSTREAM_ERROR`(502) 上游非 2xx 或报文不可解析 / `UPSTREAM_TIMEOUT`(504) 超时
 *   （消息含请求 URL 与上游原文，界面直接展示）
 */
export async function probeModelChat(
  input: {
    providerId: string
    modelName: string
  },
  viewer: AssetViewer,
): Promise<ProbeChatResult> {
  const db = getPrisma()
  const provider = await db.modelProvider.findUnique({
    where: { id: input.providerId },
    select: { id: true, enabled: true, createdBy: true },
  })
  if (provider === null) throw AppError.notFound('Provider 不存在')
  if (!canEditAsset({ ownerId: provider.createdBy }, viewer)) {
    throw AppError.forbidden('只有该 Provider 的所属人或管理员可以测试它')
  }
  if (!provider.enabled) throw AppError.conflict('该 Provider 已停用，无法测试；请先启用它')

  const credential = await readProviderCredential(input.providerId, viewer.id)
  // 手工组装一个"未落库"的目标：`modelId` 给空串（日志里用 label 区分），其余字段与
  // `resolveChatTarget` 的产物同形，只是能力位一律取保守值（探测不做多模态/思考）。
  const target: LlmTarget = {
    modelId: '',
    modelName: input.modelName,
    label: input.modelName,
    maxContext: null,
    supportsVision: false,
    supportsReasoning: false,
    providerId: input.providerId,
    providerName: credential.providerName,
    protocol: credential.protocol,
    baseUrl: credential.baseUrl,
    customUrl: credential.customUrl,
    apiKey: credential.apiKey,
  }

  const result = await chat(target, [{ role: 'user', content: 'ping' }], { maxTokens: 1 })
  return {
    providerName: credential.providerName,
    modelName: input.modelName,
    // 路径随协议变（`/chat/completions` / `/responses` / `/messages`）—— 从协议钩子取，不在这里写死
    url: resolveUpstreamUrl(
      { baseUrl: credential.baseUrl, customUrl: credential.customUrl },
      protocolOf(credential.protocol).chatPath,
    ),
    reply: result.text,
    finishReason: result.rawFinishReason,
    durationMs: result.durationMs,
  }
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
 *      llama.cpp / ollama 的兼容层都属此类。没配就不带鉴权头去探，
 *      能不能成由上游决定 —— 这样"用不了"与"不支持列表"能被区分开。
 *      ⚠️ P0-1-37：Anthropic 协议下该端点要的是 `x-api-key`（且不能带 `Authorization`），
 *      所以头由 `llm/protocol.ts` 按 `credential.protocol` 出，这里不再自己拼。
 *
 * @throws {AppError} `NOT_FOUND`(404) Provider 不存在 / `INTERNAL`(500) Key 解密失败
 *                    / `UPSTREAM_ERROR`(502)、`UPSTREAM_TIMEOUT`(504) 见 `llm/client.ts`
 */
export async function listProviderRemoteModels(
  providerId: string,
  viewer: AssetViewer,
): Promise<RemoteModelListResult> {
  const db = getPrisma()
  const provider = await db.modelProvider.findUnique({
    where: { id: providerId },
    select: { id: true, createdBy: true },
  })
  if (provider === null) throw AppError.notFound('Provider 不存在')
  // P1-13：探测用的是**该 Provider 的 Key** ⇒ 仅所属人 / ADMIN
  if (!canEditAsset({ ownerId: provider.createdBy }, viewer)) {
    throw AppError.forbidden('只有该 Provider 的所属人或管理员可以拉取它的上游模型')
  }
  const credential = await readProviderCredential(providerId, viewer.id)
  const result = await fetchRemoteModels(credential)
  getLogger().info(
    {
      providerId,
      providerName: credential.providerName,
      protocol: credential.protocol,
      total: result.total,
      truncated: result.truncated,
      hasKey: credential.apiKey !== null,
    },
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
