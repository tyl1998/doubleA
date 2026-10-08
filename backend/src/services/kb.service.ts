/**
 * 知识库服务（P0-1-15）
 *
 * 依据：`docs/02-后端设计.md` §4.6（`/api/knowledge-bases[…/:id]` CRUD）+ §三（`knowledge_bases`
 *      表）+ `子方案/知识库流水线.md` §二（参数总表 / 补默认值）、§七（覆盖重建）、§八（换模型重建）、
 *      §十一（配置增量：KB 级参数建库时**快照**自环境默认值）+ `01` §3.5 + `03` §4.3。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的五条口径
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① 权限是"登录即可"（全员），不是 ADMIN。** 见 `shared/src/knowledgeBase.ts` 文件头 ①。
 *    路由只用 `requireAuth`。代价（任何登录用户都能改/删任意库）是文档口径的直接推论
 *    —— `knowledge_bases` 没有 owner 列、`03` 的 `/knowledge` 权限列写的是「登录」。
 *
 * **② `embedding_model` 是**快照**，且**取不到就拒绝建库**（不是留空）。
 *    它是 `子方案①` §八「换模型重建路径」的判据：入库/检索时比对"这库里存的向量是哪个模型产的"。
 *    取不到当前 provider 名 ⇒ 这个库将来**不可能完成入库** ⇒ 早失败比留下一堆永远 PARSING 的库好。
 *    （P0-1-14 已把这一条写进 `docs/06` P0-1-15 的前置；本机 `.env` 现状就会触发它，是刻意的。）
 *
 * **③ `retrieval_config` 的补默认值只有一处：`shared` 的 `normalizeRetrievalConfig()`。**
 *    本文件读行、建库、改库三条路径都调它，**绝不**在这里再写一遍 `??`
 *    （`06` P0-1-15 的坑预判：散落各路由的那天就是漏字段的那天）。
 *    建库/改库时把当前的（环境兜过底的）完整配置当 `base`、请求体当 `patch` 传进去 ——
 *    实现"建库时快照环境值、此后独立可改"，且**改一半不会把另一半打回默认**
 *    （`normalizeRetrievalConfig` 的第二参数优先级更高，方向反了会静默丢弃用户输入）。
 *
 * **④ 删库要先拦"被 Agent 绑着"的库。** `agent_components.ref_id` 是**多态外键、刻意不建 FK**
 *    （`02` §3.1），所以数据库**不会**拦你 —— 引用完整性由服务层负责。放任删除会留下
 *    "Agent 说绑着某库、那库已经不存在"的孤儿绑定，症状是检索时才炸且查不出来。
 *    口径与 P0-1-11 的"删模型"一致：**先查、给数字、409 说人话**，不让 500 或者静默孤儿说话。
 *
 * **⑤ 删库的顺序是「先 DB 后 S3」，且 S3 失败只告警不阻塞。**
 *    反过来（先删 S3）一旦 DB 删除失败，就得到"库还在、文件没了"—— 比"文件还在、库没了"坏得多
 *    （前者用户看得见且会重试，后者只是泄漏一点存储）。所以 DB 删成功即视为业务成功，
 *    S3 那一步的失败记 warn + 如实回报删除个数。
 */

import {
  AppError,
  DEFAULT_RETRIEVAL_CONFIG,
  normalizeRetrievalConfig,
  type CreateKnowledgeBaseBody,
  type KnowledgeBaseItem,
  type ListKnowledgeBasesQuery,
  type OffsetPage,
  type RebuildKnowledgeBaseResult,
  type RemoveKnowledgeBaseResult,
  type RetrievalConfig,
  type UpdateKnowledgeBaseBody,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { getS3Client } from '../infra/s3.js'
import { apiEmbeddingName, probeEmbeddingDim } from '../llm/embedding/index.js'
import { enqueuePipelineJob } from '../pipeline/queue.js'
import { resolveEmbeddingTarget } from './model.service.js'

/**
 * 查询字段白名单（列表 / 建 / 改共用一份）。
 *
 * `description` 是 `TEXT`（可能很大），列表页也确实要显示它 —— 但 `take` 一条大字段
 * 乘以 20 条就可能变成几百 KB 的响应。本项目的描述是用户手填的短说明（**契约上限 2000 字符**），
 * 不会出现"整篇文章塞描述"，故列表直接带出，不做"列表不带、详情才带"的拆分。
 */
const KB_SELECT = {
  id: true,
  name: true,
  description: true,
  embeddingModel: true,
  embeddingModelId: true,
  embeddingDim: true,
  chunkSize: true,
  chunkOverlap: true,
  retrievalConfig: true,
  createdAt: true,
  updatedAt: true,
  // 漂移探测：该库**选定模型**是否还在 / 启用（模型被删时关系为 null）
  embeddingModelRef: {
    select: {
      modelName: true,
      enabled: true,
      // 是否支持多模态（上传文档选"多模态向量化"时前端据此提示/禁用）
      embeddingMultimodal: true,
      provider: { select: { enabled: true } },
    },
  },
} as const

type KnowledgeBaseRow = {
  id: string
  name: string
  description: string | null
  embeddingModel: string
  embeddingModelId: string | null
  embeddingDim: number | null
  chunkSize: number
  chunkOverlap: number
  retrievalConfig: unknown
  createdAt: Date
  updatedAt: Date
  embeddingModelRef: {
    modelName: string
    enabled: boolean
    embeddingMultimodal: boolean
    provider: { enabled: boolean }
  } | null
}

/** Prisma 错误码鸭式判断（`instanceof` 跨包会失效，见 `user.service.ts` 同款） */
function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  )
}

// ═════════════════════════════════════════════════════════════════════
// embedding 漂移探测（`子方案①` §八 ① 的"探测与告警要在 P0 就位"）
// ═════════════════════════════════════════════════════════════════════

/**
 * §八 ① 的探测：该库**选定模型**是否仍可用于向量化（任一命中即"需重建/处理"）：
 *   · 模型已被删（关系为 `null`）；
 *   · 模型或其 Provider 被停用；
 *   · 模型的上游型号名变了（库内快照 `embeddingModel` 与当前 `api:<modelName>` 不一致）。
 */
function embeddingModelChanged(row: KnowledgeBaseRow): boolean {
  const ref = row.embeddingModelRef
  if (ref === null) return true
  if (!ref.enabled || !ref.provider.enabled) return true
  return row.embeddingModel !== apiEmbeddingName(ref.modelName)
}

// ═════════════════════════════════════════════════════════════════════
// 快照：环境默认值 → KB 级参数（`子方案①` §十一）
// ═════════════════════════════════════════════════════════════════════

/**
 * 建库时的运行期默认值。
 *
 * 三个来源合成一份 `retrievalConfig`，缺一不可：
 *   · `topK` / `score` / `rrfK` ← **环境变量**（`RETRIEVAL_TOPK_DEFAULT` / `RETRIEVAL_SCORE_DEFAULT` /
 *     `RRF_K`）。这正是 §十一 说的"KB 级参数建库时快照自这些默认值，此后独立可改"。
 *   · `mode` / `splitStrategy` / `weights` ← `shared` 的规范默认值（§十一 **没有**为它们定义环境变量）。
 *     （`normalizeRetrievalConfig(base, patch)` 的第二个参数优先级更高，正好用来"把环境值叠到规范默认值上"。）
 * `chunkSize` / `chunkOverlap` 同理走 `CHUNK_SIZE_DEFAULT` / `CHUNK_OVERLAP_DEFAULT`。
 *
 * ⚠️ 刻意**不**把 `EMPTY_TEXT_THRESHOLD` / `CANDIDATE_POOL_FACTOR` 收进来：它们是**流水线**参数
 * （解析后的空文本判定、候选池放大倍数），不是"这个库的检索配置"，且 §十一 的表里也没有为
 * 它们定义 KB 级承载位置。`子方案①` §二 第 44 行那句"`empty_text_threshold` 收进
 * retrieval_config"与本节的"完整形状"（6 键）自相矛盾，本批按**完整形状**执行并已回写订正
 * （见 issue_fix 的"口径订正"段）。
 */
function snapshotDefaults(): {
  chunkSize: number
  chunkOverlap: number
  retrievalConfig: RetrievalConfig
} {
  const pipeline = config.pipeline
  return {
    chunkSize: pipeline.chunkSize,
    chunkOverlap: pipeline.chunkOverlap,
    retrievalConfig: normalizeRetrievalConfig(DEFAULT_RETRIEVAL_CONFIG, {
      topK: pipeline.retrievalTopK,
      score: pipeline.retrievalScore,
      rrfK: pipeline.rrfK,
    }),
  }
}

// ═════════════════════════════════════════════════════════════════════
// 投影
// ═════════════════════════════════════════════════════════════════════

function toItem(
  row: KnowledgeBaseRow,
  counts: { documentCount: number; agentCount: number },
): KnowledgeBaseItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    embeddingModel: row.embeddingModel,
    embeddingModelId: row.embeddingModelId,
    embeddingDim: row.embeddingDim,
    embeddingMultimodal: row.embeddingModelRef?.embeddingMultimodal ?? false,
    embeddingModelChanged: embeddingModelChanged(row),
    chunkSize: row.chunkSize,
    chunkOverlap: row.chunkOverlap,
    // ⚠️ 唯一入口：库里可能是 `{}` 或缺键（老数据 / 局部写入 / 手工改库）
    retrievalConfig: normalizeRetrievalConfig(row.retrievalConfig),
    documentCount: counts.documentCount,
    agentCount: counts.agentCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 单个库的两个计数（详情 / 建 / 改 用；列表走一次 `_count` 聚合，不逐行查） */
async function countsOf(id: string): Promise<{ documentCount: number; agentCount: number }> {
  const db = getPrisma()
  const [documentCount, agentCount] = await db.$transaction([
    db.document.count({ where: { kbId: id } }),
    db.agentComponent.count({ where: { componentType: 'KNOWLEDGE', refId: id } }),
  ])
  return { documentCount, agentCount }
}

// ═════════════════════════════════════════════════════════════════════
// 列表 / 详情
// ═════════════════════════════════════════════════════════════════════

/**
 * 知识库列表（`GET /api/knowledge-bases`，登录即可）。
 *
 * 排序 `createdAt asc, id asc`：与 `/api/users`、`/api/models` 同一口径 —— 按录入顺序展示
 * 最直观，`id` 兜底保证 offset 分页稳定（uuid7 时间有序，但只靠它排序会在同毫秒插入时抖动）。
 *
 * `_count.documents` 与 `_count` 不覆盖 `agent_components`（它是多态引用，没有 Prisma 关系），
 * 故 agent 计数用一次 `groupBy` 单独取 —— 避免 N+1（列表 20 条就 20 次 count）。
 */
export async function listKnowledgeBases(
  query: ListKnowledgeBasesQuery,
): Promise<OffsetPage<KnowledgeBaseItem>> {
  const db = getPrisma()

  // 两次查询放进一个事务：`total` 与当页数据必须来自同一快照，否则分页器会错位
  const [rows, total] = await db.$transaction([
    db.knowledgeBase.findMany({
      select: { ...KB_SELECT, _count: { select: { documents: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: query.offset,
      take: query.limit,
    }),
    db.knowledgeBase.count(),
  ])

  // 一次 groupBy 拿到整页的 agent 引用数（`component_type=KNOWLEDGE` 才可能指向知识库）
  const ids = rows.map((row) => row.id)
  const agentCounts =
    ids.length === 0
      ? []
      : await db.agentComponent.groupBy({
          by: ['refId'],
          where: { componentType: 'KNOWLEDGE', refId: { in: ids } },
          _count: { _all: true },
        })
  const agentCountByRef = new Map(agentCounts.map((row) => [row.refId, row._count._all]))

  return {
    items: rows.map((row) =>
      toItem(row, { documentCount: row._count.documents, agentCount: agentCountByRef.get(row.id) ?? 0 }),
    ),
    total,
    offset: query.offset,
    limit: query.limit,
  }
}

/**
 * 知识库详情（`GET /api/knowledge-bases/:id`，登录即可）。
 *
 * @throws {AppError} `NOT_FOUND`(404)
 */
export async function getKnowledgeBase(id: string): Promise<KnowledgeBaseItem> {
  const db = getPrisma()
  const row = await db.knowledgeBase.findUnique({ where: { id }, select: KB_SELECT })
  if (row === null) throw AppError.notFound('知识库不存在')
  return toItem(row, await countsOf(id))
}

// ═════════════════════════════════════════════════════════════════════
// 建
// ═════════════════════════════════════════════════════════════════════

/** 一个 embedding 模型 → 建库/换模型要写进 `knowledge_bases` 的三元组 */
interface EmbeddingSnapshot {
  /** `EmbeddingProvider.name()`（`api:<模型名>`）——"当前向量来源"的判据 */
  embeddingModel: string
  embeddingModelId: string
  embeddingDim: number
}

/**
 * 解析"这个 embedding 模型建库/换模型时该快照成什么"（建库与换模型**共用**的唯一实现）。
 *
 * 三步：① `resolveEmbeddingTarget` 校验模型存在、是 `EMBEDDING` 类型、模型与 Provider 都启用；
 * ② 维度优先用**建模型时探测好的** `models.embedding_dim`，缺失（本功能上线前建的向量模型）
 *    才现场 `probeEmbeddingDim` 兜底；③ 名字取 `apiEmbeddingName(modelName)`。
 *
 * ⚠️ 维度快照是换模型能否安全重建的前提：`chunks.embedding` 无固定维度、按\
 *    `chunks.embedding_dim` 逐行收窄（见 `20260930140000_kb_embedding_model` 迁移），
 *    所以任何维度都能换，但**探测不出维度就不让换**（否则入库会写出一批维度未知的向量）。
 *
 * @throws {AppError} 模型不可用（`resolveEmbeddingTarget`） / `VALIDATION`(400) 维度探测失败
 */
async function resolveEmbeddingSnapshot(modelId: string): Promise<EmbeddingSnapshot> {
  const target = await resolveEmbeddingTarget(modelId)
  let embeddingDim = target.embeddingDim
  if (embeddingDim === null) {
    try {
      embeddingDim = await probeEmbeddingDim(
        {
          providerName: target.providerName,
          baseUrl: target.baseUrl,
          customUrl: target.customUrl,
          multimodal: target.embeddingMultimodal,
          apiKey: target.apiKey,
          apiModel: target.modelName,
        },
        config.embedding.batchSize,
      )
    } catch (error) {
      const reason = error instanceof AppError ? error.message : String(error)
      throw AppError.validation(
        `无法确定 embedding 模型「${target.label}」的维度：${reason}。` +
          '请在「模型池」编辑该向量模型并手动填写它的输出维度后重试（不是所有 embedding 端点都能被自动探测）',
      )
    }
  }
  return {
    embeddingModel: apiEmbeddingName(target.modelName),
    embeddingModelId: target.modelId,
    embeddingDim,
  }
}

/**
 * 建库（`POST /api/knowledge-bases`，登录即可）。
 *
 * 流程：取 embedding 快照（取不到直接 500，见文件头 ②）→ 快照环境默认值 →
 * 用请求体覆盖 → 校验跨字段约束 → 落库。
 *
 * **`chunk_overlap < chunk_size` 在服务层校验而不是 zod**：两者可只给其一
 * （省略的那个取环境默认值），zod 看不到"省略的那个会变成多少" —— 只有这里能算。
 * （`config.ts` 对两个**环境变量**做过同样的校验，那是"默认值自身合法"的另一层。）
 */
export async function createKnowledgeBase(
  input: CreateKnowledgeBaseBody,
): Promise<KnowledgeBaseItem> {
  const db = getPrisma()
  const defaults = snapshotDefaults()

  // 解析建库时**选定**的 embedding 模型 → `{ embeddingModel, embeddingModelId, embeddingDim }`
  const snapshot = await resolveEmbeddingSnapshot(input.embeddingModelId)
  const { embeddingModel, embeddingDim } = snapshot

  const chunkSize = input.chunkSize ?? defaults.chunkSize
  const chunkOverlap = input.chunkOverlap ?? defaults.chunkOverlap
  assertChunkWindow(chunkSize, chunkOverlap)

  // 局部覆盖：请求体只给 topK/score 也行，其余键取（环境兜过底的）默认值
  const retrievalConfig = normalizeRetrievalConfig(defaults.retrievalConfig, input.retrievalConfig)

  const created = await db.knowledgeBase.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      embeddingModel,
      embeddingModelId: snapshot.embeddingModelId,
      embeddingDim,
      chunkSize,
      chunkOverlap,
      retrievalConfig,
    },
    select: KB_SELECT,
  })

  getLogger().info(
    { kbId: created.id, name: created.name, embeddingModel, embeddingDim, chunkSize, chunkOverlap },
    '已创建知识库',
  )
  // 刚建的库必然 0 文档 0 引用，不必再查库（也避免"建完立刻查"这一对多余的往返）
  return toItem(created, { documentCount: 0, agentCount: 0 })
}

/**
 * 跨字段约束：重叠必须小于块大小（`config.ts` 对默认值同款；此处按**生效值**校验）。
 * 相等或更大时，分块会在原地打转（每块前进「size - overlap」个字符 → ≤ 0），
 * 症状是入库卡死或产出无限块 —— 必须在写库前拦掉。
 */
function assertChunkWindow(chunkSize: number, chunkOverlap: number): void {
  if (chunkOverlap >= chunkSize) {
    throw AppError.validation(
      `chunkOverlap（${chunkOverlap}）必须小于 chunkSize（${chunkSize}），否则分块无法前进`,
    )
  }
}

// ═════════════════════════════════════════════════════════════════════
// 改
// ═════════════════════════════════════════════════════════════════════

/**
 * 改库（`PATCH /api/knowledge-bases/:id`，登录即可）。
 *
 * 四个"局部改动"的语义都在这里收口（契约侧的注释解释了为什么）：
 * · `description` 三态：不带 = 不动 / `null` = 清空 / 字符串 = 设置；
 * · `chunkSize` / `chunkOverlap` 只给一个时，另一个保持**当前值**（然后一起过跨字段校验）；
 * · `retrievalConfig` 与**当前生效值**合并（先 `normalize` 出完整形状再覆盖），
 *   所以"只调 topK"不会把 `mode` 打回默认值；
 * · `embeddingModelId`（P1-5）：换库选定的向量模型。
 *
 * ⚠️ 改 `chunk_size` / `chunk_overlap` / `retrieval_config` **不会**自动重建已入库文档
 *    （`子方案①` §十一："改 KB 参数不自动重建已入库文档（需手动触发，避免意外大规模重跑）"）。
 *    这就是为什么这里**不做**"改了就重跑"——静默重跑一个百万 chunk 的库是最糟的行为。
 *
 * ⚠️ **换模型（`embeddingModelId`）同样不在这里自动重跑**，但语义与上面不同：换完之后旧 chunk
 *    仍是旧模型产的向量 ⇒ 我们**只换 `embeddingModelId` + 重探 `embeddingDim`，刻意不动
 *    `embeddingModel` 那个"向量来源"快照** ⇒ `embeddingModelChanged` 立刻变 `true`、详情页
 *    出现"需重建"告警（前端保存后也会直接引导触发 `POST /:id/rebuild`）。检索侧不会崩：
 *    不同维度时旧 chunk 被 `embedding_dim` 收窄过滤（向量路空、全文路照常），同维度时
 *    相似度无意义但全文路可用 —— 都由那条告警覆盖。
 *
 * @throws {AppError} `NOT_FOUND`(404) / `VALIDATION`(400) 跨字段不合法 / 换模型时模型不可用
 *   （`resolveEmbeddingSnapshot`：停用/删除/维度探测失败）
 */
export async function updateKnowledgeBase(
  id: string,
  input: UpdateKnowledgeBaseBody,
): Promise<KnowledgeBaseItem> {
  const db = getPrisma()
  const current = await db.knowledgeBase.findUnique({ where: { id }, select: KB_SELECT })
  if (current === null) throw AppError.notFound('知识库不存在')

  const chunkSize = input.chunkSize ?? current.chunkSize
  const chunkOverlap = input.chunkOverlap ?? current.chunkOverlap
  assertChunkWindow(chunkSize, chunkOverlap)

  // 以**当前生效值**为底（已 normalize 成完整形状），再叠请求体给的键
  const retrievalConfig = normalizeRetrievalConfig(
    normalizeRetrievalConfig(current.retrievalConfig),
    input.retrievalConfig,
  )

  // 换模型：只换"选哪个模型 + 维度快照"，**不动 embeddingModel**（见文件头 ⚠️）。同一个 id 不重探。
  // ⚠️ 例外：**空库**没有任何旧向量可重建 ⇒ 快照直接跟进，否则会留下一条"需重建"的假告警。
  let embeddingPatch: { embeddingModelId?: string; embeddingDim?: number; embeddingModel?: string } = {}
  if (input.embeddingModelId !== undefined && input.embeddingModelId !== current.embeddingModelId) {
    const snapshot = await resolveEmbeddingSnapshot(input.embeddingModelId)
    const documentCount = await db.document.count({ where: { kbId: id } })
    embeddingPatch = {
      embeddingModelId: snapshot.embeddingModelId,
      embeddingDim: snapshot.embeddingDim,
      ...(documentCount === 0 ? { embeddingModel: snapshot.embeddingModel } : {}),
    }
  }

  const updated = await db.knowledgeBase.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      // `null` 是"清空"，`undefined` 是"不动" —— 必须用 `!== undefined` 判，不能真值判断
      ...(input.description === undefined ? {} : { description: input.description }),
      chunkSize,
      chunkOverlap,
      retrievalConfig,
      ...embeddingPatch,
    },
    select: KB_SELECT,
  })

  getLogger().info({ kbId: id, changed: Object.keys(input) }, '已更新知识库')
  return toItem(updated, await countsOf(id))
}

// ═════════════════════════════════════════════════════════════════════
// 整库重建（P1-5，`01` §3.5 需求 36）
// ═════════════════════════════════════════════════════════════════════

/**
 * 整库重建（`POST /api/knowledge-bases/:id/rebuild`，登录即可）。
 *
 * 把**该库当前全部文档**逐篇按 `mode: REBUILD` 重新入队，由既有流水线用该库**当前选定**的
 * embedding 模型重新解析 → 分块 → 向量化 → 入库。用途是 `子方案①` §八 的"换模型后整库重建"：
 * 库里存的旧向量与当前模型的 query 向量不在同一语义空间时（`embeddingModelChanged=true`），
 * 重建把它们拉回同一个空间。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条与"覆盖重建"刻意相反的取舍
 * ─────────────────────────────────────────────────────────────────────
 * **① 先把文档翻成 `PARSING`，否则整库空跑。** worker 的幂等第 ④ 道是"已是 `READY` ⇒ 跳过"
 *    （`worker.ts`），而整库重建面对的多半正是 `READY` 的存量文档 —— 不翻状态就投 `REBUILD`
 *    job，worker 会逐篇跳过，接口回 200 却什么都没发生（最难查的一类）。故这里用一次
 *    `updateMany` 把全库翻到 `PARSING`（`READY → PARSING` 是合法迁移，见状态机表）。
 *
 * **② 刻意不清旧 chunk**（与覆盖重建的"先删后建"相反）。旧向量留到该篇重跑完成、
 *    writer 在**一个事务里**先删后插（`pipeline/index/writer.ts`）才被替换 ⇒ 重建窗口内
 *    检索照常命中旧内容，**没有检索空窗**（`01` §3.5 的"重建期间可检索旧库"）。
 *    代价是重建期间命中的是旧内容 —— 由 `shared` 的 `REBUILD_SEARCHABLE_HINT` 明说，不静默。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 入队失败：如实回报，不假装整次成功
 * ─────────────────────────────────────────────────────────────────────
 * 与上传"入队失败即回滚整行"不同：重建没有可回滚的登记（行是既有文档），失败的那几篇停在
 * `PARSING`，逐篇点「重试」即可恢复（`retryDocument` 对 `PARSING` 放行）。故逐篇收集成功/失败，
 * 全部失败才抛 500；部分失败把 `failed` 数量如实回给界面。
 *
 * ⚠️ **不需要 chunks_v2 新表切换**：`chunks.embedding` 自 `20260930140000_kb_embedding_model`
 *    起是**无固定维度**的 `vector`，维度按行记在 `chunks.embedding_dim` ⇒ 换到任意维度的模型
 *    都能就地重建（旧表的 `子方案①` §八 双写/切表设计已被该迁移取代）。本函数只要求目标模型
 *    **现在可用**（否则投一批注定 FAILED 的 job）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 库不存在 / `CONFLICT`(409) 库无文档、未记录
 *   embedding 模型/维度（早期建的库）、或目标模型不可用（停用/删除） /
 *   `INTERNAL`(500) 全部入队失败（队列不可用）
 */
export async function rebuildKnowledgeBase(id: string): Promise<RebuildKnowledgeBaseResult> {
  const db = getPrisma()
  const logger = getLogger()

  const kb = await db.knowledgeBase.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      embeddingModel: true,
      embeddingModelId: true,
      embeddingDim: true,
      documents: { select: { id: true, contentHash: true } },
    },
  })
  if (kb === null) throw AppError.notFound('知识库不存在')

  // 入库/检索都离不开"这个库选定的模型 + 维度快照"（worker 用它们构造 provider）。
  // 老库可能缺其一 ⇒ 早失败并给可操作文案，而不是投一批注定 FAILED 的 job
  if (kb.embeddingModelId === null || kb.embeddingDim === null) {
    throw AppError.conflict(
      '该知识库未记录 embedding 模型或维度（多为本功能上线前建的老库），无法整库重建；请重建该知识库并重新选择 embedding 模型',
    )
  }
  if (kb.documents.length === 0) {
    throw AppError.conflict('该知识库还没有文档，无需重建索引')
  }

  // ① 目标模型**现在就必须可用**：不存在 / 类型不符 / 模型或 Provider 停用都在这里 409
  //    （`resolveEmbeddingTarget` 的既有判据）。不先探这一下，下面翻 PARSING + 入队只会
  //    得到一整批注定 FAILED 的 job —— 用户看到的是"全库失败"，而根因其实一句话就能说清。
  //    ⚠️ **任意维度都能重建**：`chunks.embedding` 自 `20260930140000_kb_embedding_model`
  //    起是无固定维度的 `vector`、维度按行记在 `embedding_dim`，故这里不比对维度，
  //    也不需要 chunks_v2 新表切换（那套设计已被该迁移取代）。
  const target = await resolveEmbeddingTarget(kb.embeddingModelId)

  // ② 全库翻到 PARSING（理由见文件头 ①）—— 保留 chunkCount，不删旧 chunk（文件头 ②）
  await db.document.updateMany({
    where: { kbId: id },
    data: { status: 'PARSING', errorMsg: null },
  })

  // ③ 逐篇入队。单篇失败不中断其余（部分成功比整体放弃更接近用户预期）
  let enqueued = 0
  for (const doc of kb.documents) {
    try {
      await enqueuePipelineJob({
        docId: doc.id,
        kbId: id,
        contentHash: doc.contentHash,
        mode: 'REBUILD',
      })
      enqueued += 1
    } catch (error) {
      logger.error({ err: error, kbId: id, docId: doc.id }, '整库重建：单篇文档入队失败（该篇停在 PARSING，可重试）')
    }
  }
  const failed = kb.documents.length - enqueued

  if (enqueued === 0) {
    throw AppError.internal('任务入队失败（队列不可用），整库重建未被受理，请稍后重试')
  }

  // ④ 快照跟进：重建后库里的向量就由**当前**模型产出 ⇒ 把 `embedding_model` 快照刷成当前名字，
  //    否则 `embeddingModelChanged` 会一直为 `true`（它比的是快照 vs 当前模型名），
  //    界面那条"需重建"告警永不消失。维度用的是 `knowledgeBase.embeddingDim`（换模型时已更新）。
  const embeddingModel = apiEmbeddingName(target.modelName)
  if (embeddingModel !== kb.embeddingModel) {
    await db.knowledgeBase.update({ where: { id }, data: { embeddingModel } })
  }

  logger.info(
    { kbId: id, name: kb.name, total: kb.documents.length, enqueued, failed, embeddingModel },
    '整库重建已受理（全库翻 PARSING 并批量入队，旧索引在逐篇完成前仍可检索）',
  )
  return { id, total: kb.documents.length, enqueued, failed }
}

// ═════════════════════════════════════════════════════════════════════
// 删
// ═════════════════════════════════════════════════════════════════════

/**
 * 删库（`DELETE /api/knowledge-bases/:id`，登录即可）。
 *
 * `documents` / `chunks` 由外键 `CASCADE` 连带清除（P0-1-14 的验收已取证：
 * 删 `knowledge_base` → `documents` 与 `chunks` 全清）。**S3 原文件不在数据库管辖内**，
 * 由本函数在删行**之后**清（顺序理由见文件头 ⑤）。
 *
 * @throws {AppError} `NOT_FOUND`(404) 库不存在 / `CONFLICT`(409) 正被 Agent 绑定
 */
export async function removeKnowledgeBase(id: string): Promise<RemoveKnowledgeBaseResult> {
  const db = getPrisma()
  const target = await db.knowledgeBase.findUnique({
    where: { id },
    select: { id: true, name: true, documents: { select: { fileKey: true } } },
  })
  if (target === null) throw AppError.notFound('知识库不存在')

  // ⚠️ 多态引用没有外键兜底（`02` §3.1），必须自己拦 —— 否则留下孤儿绑定，检索时才炸
  const boundAgents = await db.agentComponent.count({
    where: { componentType: 'KNOWLEDGE', refId: id },
  })
  if (boundAgents > 0) {
    throw AppError.conflict(
      `该知识库正被 ${boundAgents} 个 Agent 绑定，无法删除。请先在那些 Agent 里解绑`,
    )
  }

  const fileKeys = target.documents.map((doc) => doc.fileKey)

  try {
    // 一条语句删库：documents / chunks 由外键 CASCADE 连带清除
    await db.knowledgeBase.delete({ where: { id } })
  } catch (error) {
    if (hasPrismaCode(error, 'P2025')) throw AppError.notFound('知识库不存在')
    throw error
  }

  const deletedObjects = await removeDocumentObjects(fileKeys)

  getLogger().info(
    { kbId: id, name: target.name, deletedDocuments: fileKeys.length, deletedObjects },
    '已删除知识库',
  )
  return { id, name: target.name, deletedDocuments: fileKeys.length, deletedObjects }
}

/**
 * 清掉这些文档的原始文件。**失败只告警、不抛**（文件头 ⑤）。
 *
 * 「桶不存在」要单独分支：`infra/s3.ts` 的探活注释说明了桶是**首次上传时按需创建**的
 * （P0-1-16），所以"建了库就删库、从没上传过"这条路上桶根本不存在 ——
 * 那时 `removeObjects` 会抛 `NoSuchBucket`，而那**不是**错误（本来就没有对象可删）。
 *
 * 返回**真的删掉**的个数：`removeObjects` 用 `Quiet: true`，响应里**只回失败的条目**
 * （minio 的 `RemoveObjectsResponse` 形如 `{ Error?: {...} }`），故 `总数 - 失败数` 才是真实值。
 */
async function removeDocumentObjects(fileKeys: string[]): Promise<number> {
  if (fileKeys.length === 0) return 0
  const bucket = config.s3.bucket
  const logger = getLogger()
  try {
    const s3 = getS3Client()
    if (!(await s3.bucketExists(bucket))) {
      logger.warn({ bucket, count: fileKeys.length }, 'S3 桶不存在，跳过原文件清理（无对象可删）')
      return 0
    }
    const results = await s3.removeObjects(bucket, fileKeys)
    const failed = results.filter((item) => item != null && item.Error != null)
    if (failed.length > 0) {
      logger.warn(
        { bucket, failed: failed.length, sample: failed.slice(0, 3) },
        'S3 原文件部分删除失败（数据库记录已删除，残留对象需人工清理）',
      )
    }
    return fileKeys.length - failed.length
  } catch (error) {
    logger.warn(
      { err: error, bucket, count: fileKeys.length },
      'S3 原文件清理失败（数据库记录已删除，残留对象需人工清理）',
    )
    return 0
  }
}
