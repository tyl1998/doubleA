/**
 * 知识库契约（P0-1-15；`02` §4.6 + §三、`子方案①` §二/§八、`01` §3.5、`03` §4.3）
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① 权限：**登录即可（全员）**，不是 ADMIN —— 与模型池刻意相反
 * ─────────────────────────────────────────────────────────────────────
 * `03` §25 的路由权限列写得很清楚：`/admin/models`、`/admin/users` 是 **ADMIN**，
 * 而 `/knowledge`、`/knowledge/:id`、`/mcp` 是 **登录**。`02` §三 的 `knowledge_bases`
 * 也**没有 owner 列** —— 与 `mcp_servers` 同族：全员可注册、人人可见的共享资源。
 *
 * 所以这里**不做** `requireAdmin`，也**不拆**"管理列表 / 全员可选列表"两套投影
 * （那是 P0-1-11 为模型池做的补救：模型池的管理列表是 ADMIN 专属，而 `03` §4.2 的
 *  Agent 编辑页要一个"列出全部 KB"的下拉 —— 若列表本身对全员开放，就不存在这个问题，
 *  一个端点同时服务管理页与下拉，**不需要** `/available` 子路径）。
 *
 * ⚠️ 这个口径的代价要说清楚：**没有 owner 列 ⇒ 任何人都能改/删别人建的知识库**。
 *    这是文档口径的直接推论，不是实现疏漏；要收紧必须先改 `01`/`02` 加 `created_by`
 *    并定"创建者与 admin 可编删"（决策 18 对 Agent 就是这么定的），本批不自行发明权限模型。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② `retrieval_config` 的补默认值必须**收在一处**（`06` P0-1-15 的坑预判）
 * ─────────────────────────────────────────────────────────────────────
 * 它是 jsonb，而 **DB 默认值只在"INSERT 时不给该列"才生效** —— 三种场景都拿不到完整形状：
 *   · 老数据（本批之前建的库、或将来手工插的行）；
 *   · `PATCH` 只改 `{topK}` 时，库里存的就是"只有 topK"的对象（若实现写成整体覆盖而不做合并）；
 *   · 直接在库里改过、或从别的环境导入的数据。
 * 缺键时若直接读，`mode` 变 `undefined` → 检索层 `switch` 落到未定义分支 → 静默走错路。
 * 故本文件导出唯一入口 {@link normalizeRetrievalConfig}：service 读行、建库、改库三处**共用它**，
 * 不允许各路由各写一份 `??`（散落的那天就是漏字段的那天）。
 */

import { z } from 'zod'

import { offsetPageOf } from './envelope.js'

// ───────────────────────────── 取值域与默认值 ─────────────────────────────

/** 检索模式（`子方案①` §二 B9 定案的三值枚举） */
export const RETRIEVAL_MODES = ['HYBRID', 'VECTOR', 'FULLTEXT'] as const
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number]

/** 分块策略（`子方案①` §二 B8 配套：可插拔） */
export const SPLIT_STRATEGIES = ['hybrid', 'fixed'] as const
export type SplitStrategy = (typeof SPLIT_STRATEGIES)[number]

/** `retrieval_config` 的完整形状（`子方案①` §二 逐字：topK/score/mode/splitStrategy/rrfK/weights） */
export const retrievalConfigSchema = z.object({
  /** 每库返回数 */
  topK: z.number().int(),
  /** 向量路相似度下限（cosine） */
  score: z.number(),
  mode: z.enum(RETRIEVAL_MODES),
  splitStrategy: z.enum(SPLIT_STRATEGIES),
  /** RRF 平滑常数（`子方案①` §6-2） */
  rrfK: z.number().int(),
  /** 两路权重（`子方案①` §二 的 `rrf_vector_weight` / `rrf_fulltext_weight`） */
  weights: z.object({ vector: z.number(), fulltext: z.number() }),
})
export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>

/**
 * `retrieval_config` 的**规范默认值**。
 *
 * 与 `schema.prisma` 里 `retrieval_config` 的 DB 默认值是**同一个形状、同一组值**
 * （P0-1-14 落库时逐字写入）—— 两处必须一致，`verify:knowledge-bases` 有断言守着。
 *
 * 其中 `topK` / `score` / `rrfK` 三项**同时**是环境变量默认值的兜底
 * （`config.pipeline.retrievalTopK` 等）：本文件在 `shared` 里、读不到环境变量，
 * 故这里是"没有环境变量时"的规范值；**建库时由 service 用环境值覆盖这三项**
 * （`子方案①` §十一：KB 级参数建库时快照自环境默认值），`mode` / `splitStrategy` /
 * `weights` 没有对应环境变量（§十一 未列），恒定用这里的值。
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = Object.freeze({
  topK: 5,
  score: 0.3,
  mode: 'HYBRID',
  splitStrategy: 'hybrid',
  rrfK: 60,
  weights: Object.freeze({ vector: 1, fulltext: 1 }),
}) as RetrievalConfig

// ───────────────────────────── 补默认值（唯一入口） ─────────────────────────────

/** 有限数字且落在 `[min, max]` 内才采信，否则退回默认值 */
function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * jsonb（+ 一份更高优先级的局部值）→ **完整且可用**的 {@link RetrievalConfig}。**永不抛错**。
 *
 * 逐键兜底而不是整体 `??`：整体兜底只在"整个对象缺失"时生效，而后端最常见的坏数据是
 * "对象在、键缺一半"（`PATCH` 局部写入、老版本数据）。逐键兜底才能覆盖它。
 *
 * 两个参数的方向**必须记准**（这里踩过一次）：
 *   · `base` —— 优先级**低**的那份：库里的 jsonb、或环境默认值；
 *   · `patch` —— 优先级**高**的那份：调用方这次要叠上去的局部值。
 * 三个调用点的用法：
 *   · 读行 → `normalize(raw)`（只补缺键）；
 *   · 建库 → `normalize(环境默认值, 请求体)`（请求体压过环境）；
 *   · 改库 → `normalize(normalize(库里), 请求体)`（请求体压过当前值）。
 * 反了的话症状很隐蔽：接口 200、响应看着正常，**用户改的值被静默丢弃**
 * （`normalize({topK:99},{topK:7})` 返回 99）。验收里有一条正是盯这个方向的。
 *
 * 越界值（如手工改库把 `score` 写成 5）**按缺键处理**退回下一层，不做 clamp ——
 * clamp 会静默改变语义（5 → 1 看着像"用户就要 1"），而退回下一层 + 校验层拦写入口
 * 至少是可解释的。（正常写入路径由 zod 拦在 400，越界只可能来自手工改库。）
 *
 * @param raw 库里的 jsonb（`unknown`：它真的是任意 JSON）—— 优先级低
 * @param patch 本次要叠加的局部值 —— 优先级高
 */
export function normalizeRetrievalConfig(
  raw: unknown,
  patch: Partial<RetrievalConfig> = {},
): RetrievalConfig {
  const base = isRecord(raw) ? raw : {}
  const weights: Record<string, unknown> = isRecord(patch.weights) ? patch.weights : {}
  const baseWeights: Record<string, unknown> = isRecord(base.weights) ? base.weights : {}
  // `{...base, ...patch}` 是安全的：patch 里只可能"键不存在"或"值是合法数字"
  // （zod 的 `.optional()` 会剥掉未给的键，非法的挡在 400），不会出现"显式的 undefined 覆盖 base"
  const merged: Record<string, unknown> = { ...base, ...patch }

  return {
    topK: numberOr(merged.topK, DEFAULT_RETRIEVAL_CONFIG.topK, 1, 100),
    score: numberOr(merged.score, DEFAULT_RETRIEVAL_CONFIG.score, 0, 1),
    mode: oneOf(merged.mode, RETRIEVAL_MODES, DEFAULT_RETRIEVAL_CONFIG.mode),
    splitStrategy: oneOf(merged.splitStrategy, SPLIT_STRATEGIES, DEFAULT_RETRIEVAL_CONFIG.splitStrategy),
    rrfK: numberOr(merged.rrfK, DEFAULT_RETRIEVAL_CONFIG.rrfK, 1, 1000),
    weights: {
      vector: numberOr(
        weights.vector ?? baseWeights.vector,
        DEFAULT_RETRIEVAL_CONFIG.weights.vector,
        0,
        100,
      ),
      fulltext: numberOr(
        weights.fulltext ?? baseWeights.fulltext,
        DEFAULT_RETRIEVAL_CONFIG.weights.fulltext,
        0,
        100,
      ),
    },
  }
}

// ───────────────────────────── 输出投影 ─────────────────────────────

/**
 * 知识库（`GET /api/knowledge-bases` 列表项 / 详情 / 建改的响应，**一套投影**）。
 *
 * 为什么不分管理/可选两套（P0-1-11 在模型池上分过）：见文件头的 ① —— 本资源对全员开放，
 * 不存在"某身份不该看见某个字段"的问题。`agentCount` / `documentCount` 对普通用户也有用
 * （前者解释"为什么删不掉"，后者是列表页最想看的一列）。
 */
export const knowledgeBaseItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 未填写为 `null`（列可空） */
  description: z.string().nullable(),
  /**
   * 建库时**快照**的 embedding 模型标识 = `EmbeddingProvider.name()`
   * （`api:<模型名>` / `local:<目录名>`）。它是 `子方案①` §八「换模型重建路径」的判据。
   */
  embeddingModel: z.string(),
  /**
   * §八 ① 的探测：快照值与**当前** provider 的 `name()` 是否不一致（不一致 = 该库需重建）。
   *
   * 三态而不是布尔：`null` = **无法判定**（当前 embedding provider 未就绪，取不到 `name()`）。
   * 报 `false` 会是一句谎话（"没变"与"我不知道"是两件事），而 §八 明确要求
   * "探测与告警要在 P0 就位，否则换模型时会静默出错"。
   */
  embeddingModelChanged: z.boolean().nullable(),
  chunkSize: z.number().int(),
  chunkOverlap: z.number().int(),
  /** 已补全默认值的完整形状（读出来一定是 6 键齐备，见 {@link normalizeRetrievalConfig}） */
  retrievalConfig: retrievalConfigSchema,
  /** 库内文档数（列表页要显示；`documents` 是千级，`count` 代价可接受） */
  documentCount: z.number().int().min(0),
  /**
   * 有多少个 Agent 绑了这个库（`agent_components` 里 `type=KNOWLEDGE` 且 `ref_id` 指向它）。
   *
   * ⚠️ `agent_components.ref_id` 是**多态外键、刻意不建 FK**（`02` §3.1），所以删库时
   * 数据库**不会**拦你 —— 引用完整性由服务层负责：`agentCount > 0` 时拒绝删除（409），
   * 否则会留下"Agent 说绑着某库、那个库已经不存在"的孤儿绑定（检索时才炸，且查不出来）。
   */
  agentCount: z.number().int().min(0),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type KnowledgeBaseItem = z.infer<typeof knowledgeBaseItemSchema>

// ───────────────────────────── 列表 ─────────────────────────────

/** `GET /api/knowledge-bases` 查询参数（offset/limit，与 `/api/users`、`/api/models` 同口径） */
export const listKnowledgeBasesQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, 'offset 不能为负').default(0),
  limit: z.coerce.number().int().min(1, 'limit 至少为 1').max(100, 'limit 最多 100').default(20),
})
export type ListKnowledgeBasesQuery = z.infer<typeof listKnowledgeBasesQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const knowledgeBaseListResultSchema = offsetPageOf(knowledgeBaseItemSchema)
export type KnowledgeBaseListResult = z.infer<typeof knowledgeBaseListResultSchema>

// ───────────────────────────── 公共字段 ─────────────────────────────

/** 库名（列 `VARCHAR(128)`） */
const kbNameSchema = z
  .string({ required_error: '请输入知识库名称' })
  .trim()
  .min(1, '请输入知识库名称')
  .max(128, '名称最多 128 个字符')

/**
 * 描述（列是 `TEXT`，无硬上限）。
 * 2000 字是**防误操作**的上限（把整篇文档粘进描述框是最常见的脏数据），不是存储约束。
 */
const kbDescriptionSchema = z.string().trim().max(2000, '描述最多 2000 个字符')

/**
 * 分块大小（字符，非 token）。上限 8192 出自 `子方案①` §二：bge-m3 的输入上限是 8192 token，
 * 而本参数单位是**字符** —— 超过 8192 字符的实施只可能来自单位误解（把 token 当字符）。
 */
const chunkSizeSchema = z
  .number({ invalid_type_error: 'chunkSize 必须是数字' })
  .int('chunkSize 必须是整数')
  .min(1, 'chunkSize 至少为 1')
  .max(8192, 'chunkSize 最多 8192 个字符')

/** 相邻块重叠（字符）。下界 0 合法（不重叠），上界由"必须小于 chunkSize"在服务层兜（跨字段） */
const chunkOverlapSchema = z
  .number({ invalid_type_error: 'chunkOverlap 必须是数字' })
  .int('chunkOverlap 必须是整数')
  .min(0, 'chunkOverlap 不能为负')
  .max(8191, 'chunkOverlap 最多 8191')

/** 检索配置的**局部**形态：允许只给要改的键（其余按当前值/默认值补齐） */
export const retrievalConfigInputSchema = z.object({
  topK: z
    .number({ invalid_type_error: 'topK 必须是数字' })
    .int('topK 必须是整数')
    .min(1, 'topK 至少为 1')
    .max(100, 'topK 最多 100')
    .optional(),
  score: z
    .number({ invalid_type_error: 'score 必须是数字' })
    .min(0, 'score 不能小于 0')
    .max(1, 'score 不能大于 1')
    .optional(),
  mode: z
    .enum(RETRIEVAL_MODES, { errorMap: () => ({ message: `mode 只能是 ${RETRIEVAL_MODES.join('/')}` }) })
    .optional(),
  splitStrategy: z
    .enum(SPLIT_STRATEGIES, {
      errorMap: () => ({ message: `splitStrategy 只能是 ${SPLIT_STRATEGIES.join('/')}` }),
    })
    .optional(),
  rrfK: z
    .number({ invalid_type_error: 'rrfK 必须是数字' })
    .int('rrfK 必须是整数')
    .min(1, 'rrfK 至少为 1')
    .max(1000, 'rrfK 最多 1000')
    .optional(),
  /** 两路权重要么都给、要么都不给（给一半会让另一半静默取默认值，容易被当成"设了没生效"） */
  weights: z
    .object({
      vector: z.number({ invalid_type_error: 'weights.vector 必须是数字' }).min(0, 'weights.vector 不能为负').max(100, 'weights.vector 最多 100'),
      fulltext: z
        .number({ invalid_type_error: 'weights.fulltext 必须是数字' })
        .min(0, 'weights.fulltext 不能为负')
        .max(100, 'weights.fulltext 最多 100'),
    })
    .optional(),
})
export type RetrievalConfigInput = z.infer<typeof retrievalConfigInputSchema>

// ───────────────────────────── 建 ─────────────────────────────

/**
 * `POST /api/knowledge-bases` 请求体。
 *
 * **四项都可省**：`chunkSize` / `chunkOverlap` / `retrievalConfig` 省略时由服务层用
 * 环境默认值**快照**（`子方案①` §十一："KB 级参数在建库时快照自这些默认值，此后独立可改"），
 * 前端"只填个名字就建"是最常见的用法，不该逼它把 6 个键都抄一遍。
 */
export const createKnowledgeBaseBodySchema = z.object({
  name: kbNameSchema,
  /** `null` 与省略同义（都表示"没填"） */
  description: kbDescriptionSchema.nullish(),
  chunkSize: chunkSizeSchema.optional(),
  chunkOverlap: chunkOverlapSchema.optional(),
  /** 局部覆盖：只给 `{topK: 10, score: 0.5}` 也行，其余键取默认值 */
  retrievalConfig: retrievalConfigInputSchema.optional(),
})
export type CreateKnowledgeBaseBody = z.infer<typeof createKnowledgeBaseBodySchema>

// ───────────────────────────── 改 ─────────────────────────────

/**
 * `PATCH /api/knowledge-bases/:id` 请求体：**至少给一个字段**。
 *
 * · `description` 是**三态**：**不带 = 不动** / `null` = **清空** / 字符串 = 设置。
 *   必须是 `.nullable().optional()`，**不能加 `.default()`** —— 加了就会把"清空描述"
 *   与"只改个名字"合并成同一种效果（P0-1-10/11 的同款坑）。
 *
 * · `retrievalConfig` 是**局部合并**：给的键覆盖当前生效值，没给的键保持不动。
 *   若实现写成整体覆盖，"只想调个 topK"会顺手把 `mode` 打回默认值（静默改变检索行为）。
 *
 * · `embeddingModel` **不在契约里**（不可改）：它是建库时的快照、是"需重建"的判据，
 *   让它可改等于允许伪造"已跟进新模型"的状态。换模型走 `子方案①` §八 的新表切换路径。
 */
export const updateKnowledgeBaseBodySchema = z
  .object({
    name: kbNameSchema.optional(),
    /** ⚠️ 三态，见上 */
    description: kbDescriptionSchema.nullable().optional(),
    chunkSize: chunkSizeSchema.optional(),
    chunkOverlap: chunkOverlapSchema.optional(),
    retrievalConfig: retrievalConfigInputSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      // `description: null`（清空）也算"给了字段"：`null !== undefined`
      body.description !== undefined ||
      body.chunkSize !== undefined ||
      body.chunkOverlap !== undefined ||
      body.retrievalConfig !== undefined,
    { message: '至少要提供一个要修改的字段' },
  )
export type UpdateKnowledgeBaseBody = z.infer<typeof updateKnowledgeBaseBodySchema>

// ───────────────────────────── 路径参数与删除结果 ─────────────────────────────

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const knowledgeBaseIdParamsSchema = z.object({
  id: z.string().uuid('知识库 ID 不是合法 UUID'),
})
export type KnowledgeBaseIdParams = z.infer<typeof knowledgeBaseIdParamsSchema>

/**
 * `DELETE /api/knowledge-bases/:id` 的响应。
 *
 * 带上两个数量是刻意的：删库会**连带清掉**文档、chunk（外键 CASCADE）与 S3 原文件，
 * 只回一个 `ok` 会让调用方无从判断"到底删掉了多少东西"（也就无法在 UI 上给一个有信息量的提示）。
 * `deletedObjects` 是 **S3 侧真的删成功**的对象数，可能小于 `deletedDocuments`
 * （桶不存在 / 部分对象删除失败时只告警不阻塞，见服务层注释）。
 */
export const removeKnowledgeBaseResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 连带删除的文档数 */
  deletedDocuments: z.number().int().min(0),
  /** 连带删除的 S3 对象数（≤ `deletedDocuments`） */
  deletedObjects: z.number().int().min(0),
})
export type RemoveKnowledgeBaseResult = z.infer<typeof removeKnowledgeBaseResultSchema>
