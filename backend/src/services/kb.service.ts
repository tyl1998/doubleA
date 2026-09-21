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
  type RemoveKnowledgeBaseResult,
  type RetrievalConfig,
  type UpdateKnowledgeBaseBody,
} from '@doubulea/shared'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { getS3Client } from '../infra/s3.js'
import { embeddingReadiness, getEmbeddingProvider } from '../llm/embedding/index.js'

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
  chunkSize: true,
  chunkOverlap: true,
  retrievalConfig: true,
  createdAt: true,
  updatedAt: true,
} as const

type KnowledgeBaseRow = {
  id: string
  name: string
  description: string | null
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  retrievalConfig: unknown
  createdAt: Date
  updatedAt: Date
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
// embedding 快照与漂移探测（`子方案①` §八 ① 的"探测与告警要在 P0 就位"）
// ═════════════════════════════════════════════════════════════════════

/**
 * 当前 embedding provider 的标识 —— **建库时快照用**，取不到就拒绝建库（见文件头 ②）。
 *
 * 包装 `getEmbeddingProvider()` 而不是自己拼名字：`name()` 由 provider 自己给
 * （P0-1-13 定案），"自检里的名字"与"实际落库的名字"必须是同一个值，
 * 否则 §八 的换模型探测直接失效。
 */
function requireEmbeddingModelName(): string {
  try {
    return getEmbeddingProvider().name()
  } catch (error) {
    // 沿用 P0-1-13 的错误码（INTERNAL）—— "服务端配置不齐"是同一类问题，
    // 换成两套说法只会让排查的人多跳一次。这里补上"建库"的上下文与出路。
    const reason = error instanceof AppError ? error.message : String(error)
    throw AppError.internal(
      `无法创建知识库：服务端 embedding 未就绪，取不到 embedding_model 快照。${reason}`,
    )
  }
}

/**
 * 当前 provider 的标识；**未就绪时返回 `null`**（供 §八 的漂移探测用，绝不抛错）。
 *
 * 为什么不能直接 `getEmbeddingProvider()`：那会在列表接口里抛 500 ——
 * 一个库都列不出来（连"哪个库需要重建"都看不到），而 provider 没配好是**运维要先修的事**，
 * 不该让只读接口不可用。故探测走 `embeddingReadiness()`（纯配置计算，不抛）。
 */
function currentEmbeddingNameOrNull(): string | null {
  return embeddingReadiness().name
}

/**
 * §八 ① 的探测：`kb.embeddingModel` 与当前 provider 名不一致 ⇒ 该库需重建。
 * `null` = 无法判定（provider 未就绪）。见 shared 契约里 `embeddingModelChanged` 的三态说明。
 */
function detectEmbeddingModelChanged(snapshot: string, current: string | null): boolean | null {
  if (current === null) return null
  return snapshot !== current
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
  currentEmbeddingName: string | null,
): KnowledgeBaseItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    embeddingModel: row.embeddingModel,
    embeddingModelChanged: detectEmbeddingModelChanged(row.embeddingModel, currentEmbeddingName),
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
  const currentEmbeddingName = currentEmbeddingNameOrNull()

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
      toItem(row, { documentCount: row._count.documents, agentCount: agentCountByRef.get(row.id) ?? 0 }, currentEmbeddingName),
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
  return toItem(row, await countsOf(id), currentEmbeddingNameOrNull())
}

// ═════════════════════════════════════════════════════════════════════
// 建
// ═════════════════════════════════════════════════════════════════════

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

  // ⚠️ 顺序有意为之：先把 embedding 快照拿到手，再谈其他 —— 这样"没配 embedding"时
  //    不会先做一堆无用功（也保证日志里失败原因始终是同一条）。
  const embeddingModel = requireEmbeddingModelName()

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
      chunkSize,
      chunkOverlap,
      retrievalConfig,
    },
    select: KB_SELECT,
  })

  getLogger().info(
    { kbId: created.id, name: created.name, embeddingModel, chunkSize, chunkOverlap },
    '已创建知识库',
  )
  // 刚建的库必然 0 文档 0 引用，不必再查库（也避免"建完立刻查"这一对多余的往返）
  return toItem(created, { documentCount: 0, agentCount: 0 }, currentEmbeddingNameOrNull())
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
 * 三个"局部改动"的语义都在这里收口（契约侧的注释解释了为什么）：
 * · `description` 三态：不带 = 不动 / `null` = 清空 / 字符串 = 设置；
 * · `chunkSize` / `chunkOverlap` 只给一个时，另一个保持**当前值**（然后一起过跨字段校验）；
 * · `retrievalConfig` 与**当前生效值**合并（先 `normalize` 出完整形状再覆盖），
 *   所以"只调 topK"不会把 `mode` 打回默认值。
 *
 * ⚠️ 改 `chunk_size` / `chunk_overlap` / `retrieval_config` **不会**自动重建已入库文档
 *    （`子方案①` §十一："改 KB 参数不自动重建已入库文档（需手动触发，避免意外大规模重跑）"）。
 *    这就是为什么这里**不做**"改了就重跑"——静默重跑一个百万 chunk 的库是最糟的行为。
 *
 * @throws {AppError} `NOT_FOUND`(404) / `VALIDATION`(400) 跨字段不合法
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

  const updated = await db.knowledgeBase.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      // `null` 是"清空"，`undefined` 是"不动" —— 必须用 `!== undefined` 判，不能真值判断
      ...(input.description === undefined ? {} : { description: input.description }),
      chunkSize,
      chunkOverlap,
      retrievalConfig,
    },
    select: KB_SELECT,
  })

  getLogger().info({ kbId: id, changed: Object.keys(input) }, '已更新知识库')
  return toItem(updated, await countsOf(id), currentEmbeddingNameOrNull())
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
