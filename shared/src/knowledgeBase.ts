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

import { validationMessage } from './i18n/validation.js'

import {
  ASSET_VISIBILITIES,
  agentAudienceInputSchema,
  agentAudienceSchema,
  audienceIsEmpty,
} from './assetAcl.js'
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
   * **当前**选定模型的 `EmbeddingProvider.name()`（`api:<模型名>`）—— `embeddingModelId` 指向的模型
   * **此刻**的名字；模型被删 / 未绑定 / Provider 停用时为 `null`。
   *
   * 与 {@link embeddingModel} 的区别（P1-5 补）：后者是"**库里已有向量由谁产出**"的快照，换模型或
   * 在模型池改名后**刻意不变**，要等整库重建完成才刷新。两者不同 = {@link embeddingModelChanged}，
   * 详情页据此把标题显示成 `旧 → 新`，避免"模型都改了、界面还显示旧名"的困惑。
   */
  embeddingModelCurrent: z.string().nullable(),
  /** 建库时**选定**的模型 id（模型池里 `type=EMBEDDING` 的模型）；老库为 `null` */
  embeddingModelId: z.string().nullable(),
  /**
   * 图片"含义"理解（VLM 描述，P1-11）选定的 vision 对话模型 id（模型池里 `type=CHAT` 的模型）；
   * 未配置为 `null`（= 该库不产出图片描述）。
   */
  captionModelId: z.string().nullable(),
  /**
   * 该描述模型的**当前**名字（`Model.label`）；未配置 / 模型被删 / Provider 停用时为 `null`。
   * 仅供界面展示（"这个库用哪个模型读图"）。
   */
  captionModelName: z.string().nullable(),
  /**
   * 该库所选 embedding 模型是否**支持多模态**（`Model.embeddingMultimodal`）。
   *
   * 上传文档时若选"图片向量化（多模态）"，前端据此**提前**禁用/提示（后端仍会再校验一次，
   * 见 `MULTIMODAL_MODEL_REQUIRED_HINT`）；`embeddingModelId` 为空（老库）时恒为 `false`。
   */
  embeddingMultimodal: z.boolean(),
  /** 该库向量维度快照（建库时探测写入）；老库为 `null` */
  embeddingDim: z.number().int().nullable(),
  /**
   * §八 ① 的探测：快照值与**当前** provider 的 `name()` 是否不一致（不一致 = 该库需重建）。
   *
   * 三态而不是布尔：`null` = **无法判定**（当前 embedding provider 未就绪，取不到 `name()`）。
   * 报 `false` 会是一句谎话（"没变"与"我不知道"是两件事），而 §八 明确要求
   * "探测与告警要在 P0 就位，否则换模型时会静默出错"。
   */
  embeddingModelChanged: z.boolean().nullable(),
  /**
   * 该库是否**必须整库重建**才能继续向量处理（P1-5 的强制闸门）。
   *
   * 比 {@link embeddingModelChanged} 更严：除"模型被删/停用/改名"外，还覆盖**型号没变但维度变了**
   * （`选模型的 embeddingDim` 与库快照不一致）。为 `true` 时后端会把该库的**入库 / 重试 / 覆盖重传**
   * 一律 **409** 拒绝 —— 否则单篇入库会写出与旧 chunk 不同维度的向量、把库变成"半迁移"
   * （旧文档被向量路按维度过滤、只剩全文），这才是真正该被挡住的操作。
   *
   * 详情页据此显示常驻告警 + 唯一的「重建整库索引」入口；重建成功（维度/名字快照刷新）后转 `false`。
   */
  needsRebuild: z.boolean(),
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
  /**
   * P1-13：**所属人**（新增 `created_by` 列，存量回填最早的 ADMIN）。判据的唯一主体：
   * 编/删/改可见性/转移 = 所属人 + ADMIN。字段名沿用 `createdBy`/`creatorName`（与 Agent/MCP 统一）。
   */
  createdBy: z.string(),
  /** 所属人显示名（昵称优先、回落用户名） */
  creatorName: z.string(),
  /** P1-18.x：可见范围（**三档**：私有 / 指定用户 / 公开，2026-10-16 起与 Agent 一致） */
  visibility: z.enum(ASSET_VISIBILITIES),
  /**
   * P1-18.x：**受众**（`visibility=SHARED` 时给出：用户 ∪ 组）。非 `SHARED` 时恒为空数组。
   * 回显用（建/改页面据此恢复选择）。
   */
  audience: agentAudienceSchema,
  /** P1-13：当前调用者是否可编删（服务端按 `canEditAsset` 算好，前端**不自己拼**） */
  canEdit: z.boolean(),
  /** ISO 8601 */
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type KnowledgeBaseItem = z.infer<typeof knowledgeBaseItemSchema>

// ───────────────────────────── 列表 ─────────────────────────────

/** `GET /api/knowledge-bases` 查询参数（offset/limit，与 `/api/users`、`/api/models` 同口径） */
export const listKnowledgeBasesQuerySchema = z.object({
  offset: z.coerce.number().int().min(0, validationMessage('validation.common.offsetNotNegative')).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1, validationMessage('validation.common.limitMin'))
    .max(100, validationMessage('validation.common.limitMax'))
    .default(20),
})
export type ListKnowledgeBasesQuery = z.infer<typeof listKnowledgeBasesQuerySchema>

/** 列表响应：`{ items, total, offset, limit }` */
export const knowledgeBaseListResultSchema = offsetPageOf(knowledgeBaseItemSchema)
export type KnowledgeBaseListResult = z.infer<typeof knowledgeBaseListResultSchema>

// ───────────────────────────── 公共字段 ─────────────────────────────

/** 库名（列 `VARCHAR(128)`） */
const kbNameSchema = z
  .string({ required_error: validationMessage('validation.knowledgeBase.nameRequired') })
  .trim()
  .min(1, validationMessage('validation.knowledgeBase.nameRequired'))
  .max(128, validationMessage('validation.knowledgeBase.nameTooLong', { max: 128 }))

/**
 * 描述（列是 `TEXT`，无硬上限）。
 * 2000 字是**防误操作**的上限（把整篇文档粘进描述框是最常见的脏数据），不是存储约束。
 */
const kbDescriptionSchema = z
  .string()
  .trim()
  .max(2000, validationMessage('validation.knowledgeBase.descriptionTooLong', { max: 2000 }))

/**
 * 分块大小（字符，非 token）。上限 8192 出自 `子方案①` §二：bge-m3 的输入上限是 8192 token，
 * 而本参数单位是**字符** —— 超过 8192 字符的实施只可能来自单位误解（把 token 当字符）。
 */
const chunkSizeSchema = z
  .number({ invalid_type_error: validationMessage('validation.knowledgeBase.chunkSizeNotNumber') })
  .int(validationMessage('validation.knowledgeBase.chunkSizeNotInteger'))
  .min(1, validationMessage('validation.knowledgeBase.chunkSizeMin', { min: 1 }))
  .max(8192, validationMessage('validation.knowledgeBase.chunkSizeMax', { max: 8192 }))

/** 相邻块重叠（字符）。下界 0 合法（不重叠），上界由"必须小于 chunkSize"在服务层兜（跨字段） */
const chunkOverlapSchema = z
  .number({ invalid_type_error: validationMessage('validation.knowledgeBase.chunkOverlapNotNumber') })
  .int(validationMessage('validation.knowledgeBase.chunkOverlapNotInteger'))
  .min(0, validationMessage('validation.knowledgeBase.chunkOverlapMin', { min: 0 }))
  .max(8191, validationMessage('validation.knowledgeBase.chunkOverlapMax', { max: 8191 }))

/** 检索配置的**局部**形态：允许只给要改的键（其余按当前值/默认值补齐） */
export const retrievalConfigInputSchema = z.object({
  topK: z
    .number({ invalid_type_error: validationMessage('validation.knowledgeBase.topKNotNumber') })
    .int(validationMessage('validation.knowledgeBase.topKNotInteger'))
    .min(1, validationMessage('validation.knowledgeBase.topKMin', { min: 1 }))
    .max(100, validationMessage('validation.knowledgeBase.topKMax', { max: 100 }))
    .optional(),
  score: z
    .number({ invalid_type_error: validationMessage('validation.knowledgeBase.scoreNotNumber') })
    .min(0, validationMessage('validation.knowledgeBase.scoreMin', { min: 0 }))
    .max(1, validationMessage('validation.knowledgeBase.scoreMax', { max: 1 }))
    .optional(),
  mode: z
    .enum(RETRIEVAL_MODES, {
      errorMap: () => ({
        message: validationMessage('validation.knowledgeBase.modeAllowed', { allowed: RETRIEVAL_MODES.join('/') }),
      }),
    })
    .optional(),
  splitStrategy: z
    .enum(SPLIT_STRATEGIES, {
      errorMap: () => ({
        message: validationMessage('validation.knowledgeBase.splitStrategyAllowed', {
          allowed: SPLIT_STRATEGIES.join('/'),
        }),
      }),
    })
    .optional(),
  rrfK: z
    .number({ invalid_type_error: validationMessage('validation.knowledgeBase.rrfKNotNumber') })
    .int(validationMessage('validation.knowledgeBase.rrfKNotInteger'))
    .min(1, validationMessage('validation.knowledgeBase.rrfKMin', { min: 1 }))
    .max(1000, validationMessage('validation.knowledgeBase.rrfKMax', { max: 1000 }))
    .optional(),
  /** 两路权重要么都给、要么都不给（给一半会让另一半静默取默认值，容易被当成"设了没生效"） */
  weights: z
    .object({
      vector: z
        .number({ invalid_type_error: validationMessage('validation.knowledgeBase.weightVectorNotNumber') })
        .min(0, validationMessage('validation.knowledgeBase.weightVectorMin', { min: 0 }))
        .max(100, validationMessage('validation.knowledgeBase.weightVectorMax', { max: 100 })),
      fulltext: z
        .number({ invalid_type_error: validationMessage('validation.knowledgeBase.weightFulltextNotNumber') })
        .min(0, validationMessage('validation.knowledgeBase.weightFulltextMin', { min: 0 }))
        .max(100, validationMessage('validation.knowledgeBase.weightFulltextMax', { max: 100 })),
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
  /**
   * **必填**：该库使用的 embedding 模型（模型池里 `type=EMBEDDING` 的模型 id）。
   *
   * 取代了旧的环境变量方案（`EMBEDDING_MODE` / `EMBEDDING_API_*`）：建库时选定、
   * 后端据此**探测维度**并快照，此后入库与检索都用它。不可后改（换模型需重建）。
   */
  embeddingModelId: z
    .string({ required_error: validationMessage('validation.knowledgeBase.embeddingModelRequired') })
    .uuid(validationMessage('validation.knowledgeBase.embeddingModelIdNotUuid')),
  /**
   * 可选：图片"含义"理解（VLM 描述）用的 vision 对话模型 id（P1-11）。
   * `null` 与省略同义（都表示"不启用图片描述"）。设置时后端会校验它是 `CHAT` 且 `supportsVision`。
   */
  captionModelId: z.string().uuid(validationMessage('validation.knowledgeBase.captionModelIdNotUuid')).nullish(),
  chunkSize: chunkSizeSchema.optional(),
  chunkOverlap: chunkOverlapSchema.optional(),
  /** 局部覆盖：只给 `{topK: 10, score: 0.5}` 也行，其余键取默认值 */
  retrievalConfig: retrievalConfigInputSchema.optional(),
  /**
   * P1-18.x：可见范围（**三档**：私有 / 指定用户 / 公开）。**可省** ⇒ 服务层按 `PRIVATE`（安全默认）。
   * ⚠️ 2026-10-16 起知识库也开放「指定用户」（与 Agent 一致）；取消可见性闭包后，
   * 公开/指定用户库不再有"引用模型必须公开"的写时校验。
   */
  visibility: z
    .enum(ASSET_VISIBILITIES, {
      errorMap: () => ({
        message: validationMessage('validation.knowledgeBase.visibilityAllowed', {
          allowed: ASSET_VISIBILITIES.join('/'),
        }),
      }),
    })
    .optional(),
  /** P1-18.x：受众（仅 `visibility=SHARED` 允许给；`SHARED` 时至少一个主体非空） */
  audience: agentAudienceInputSchema.optional(),
})
  .superRefine((body, ctx) => {
    // P1-18.x：可见范围 × 受众（建库时缺省即 PRIVATE ⇒ 不允许带 audience）
    const visibility = body.visibility ?? 'PRIVATE'
    if (visibility === 'SHARED') {
      if (body.audience === undefined || audienceIsEmpty(normalizeAudienceForCheck(body.audience))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['audience'],
          message: validationMessage('validation.audience.required'),
        })
      }
    } else if (body.audience !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audience'],
        message: validationMessage('validation.audience.notAllowed'),
      })
    }
  })
export type CreateKnowledgeBaseBody = z.infer<typeof createKnowledgeBaseBodySchema>

/** 受众输入 → 是否为空（superRefine 用；与 `agent.ts` 同款，不引服务层的 normalize） */
function normalizeAudienceForCheck(audience: { userIds?: string[]; groupIds?: string[] }): {
  userIds: string[]
  groupIds: string[]
} {
  return { userIds: audience.userIds ?? [], groupIds: audience.groupIds ?? [] }
}

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
 * · `embeddingModelId`（P1-5 起**可改**）：更换该库选定的向量模型。
 *   ⚠️ **不改 `embeddingModel` 这个"向量来源"快照** —— 服务层只换 `embeddingModelId` +
 *   重探 `embeddingDim`，于是 `embeddingModelChanged` 变为 `true`（= 旧 chunk 不是新模型产的，
 *   该库需重建）。要恢复向量检索必须随后调 `POST /:id/rebuild` 全库重跑；
 *   `chunks.embedding` 自 `20260930140000_kb_embedding_model` 起是**无固定维度**的 `vector`、
 *   维度按行记在 `chunks.embedding_dim`，故换到**任意维度**的模型都不需要新建向量表。
 */
export const updateKnowledgeBaseBodySchema = z
  .object({
    name: kbNameSchema.optional(),
    /** ⚠️ 三态，见上 */
    description: kbDescriptionSchema.nullable().optional(),
    chunkSize: chunkSizeSchema.optional(),
    chunkOverlap: chunkOverlapSchema.optional(),
    retrievalConfig: retrievalConfigInputSchema.optional(),
    /** 更换该库的向量模型（`models` 里 `type=EMBEDDING` 的 id）；换完需重建索引 */
    embeddingModelId: z.string().uuid(validationMessage('validation.knowledgeBase.embeddingModelIdNotUuid')).optional(),
    /**
     * 图片描述模型（P1-11）**三态**：**不带 = 不动** / `null` = **清除（不启用图片描述）** /
     * uuid = 设置。设置时后端校验它是 `CHAT` 且 `supportsVision`（{@link CAPTION_MODEL_MUST_SUPPORT_VISION_HINT}）。
     */
    captionModelId: z
      .string()
      .uuid(validationMessage('validation.knowledgeBase.captionModelIdNotUuid'))
      .nullable()
      .optional(),
    /** P1-18.x：可见范围（三档：私有 / 指定用户 / 公开） */
    visibility: z
      .enum(ASSET_VISIBILITIES, {
        errorMap: () => ({
          message: validationMessage('validation.knowledgeBase.visibilityAllowed', {
            allowed: ASSET_VISIBILITIES.join('/'),
          }),
        }),
      })
      .optional(),
    /** P1-18.x：受众（整体替换；`visibility≠SHARED` 时不得给） */
    audience: agentAudienceInputSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      // `description: null`（清空）也算"给了字段"：`null !== undefined`
      body.description !== undefined ||
      body.chunkSize !== undefined ||
      body.chunkOverlap !== undefined ||
      body.retrievalConfig !== undefined ||
      body.embeddingModelId !== undefined ||
      body.captionModelId !== undefined ||
      body.visibility !== undefined ||
      body.audience !== undefined,
    { message: validationMessage('validation.common.atLeastOneField') },
  )
  .superRefine((body, ctx) => {
    // P1-18.x：同请求内 visibility × audience 的**局部**一致性（合并库里现状后的最终判定在服务层）
    if (body.visibility !== undefined && body.visibility !== 'SHARED' && body.audience !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audience'],
        message: validationMessage('validation.audience.notAllowed'),
      })
    }
    if (
      body.visibility === 'SHARED' &&
      body.audience !== undefined &&
      audienceIsEmpty(normalizeAudienceForCheck(body.audience))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['audience'],
        message: validationMessage('validation.audience.required'),
      })
    }
  })
export type UpdateKnowledgeBaseBody = z.infer<typeof updateKnowledgeBaseBodySchema>

// ───────────────────────────── 路径参数与删除结果 ─────────────────────────────

/** 路径参数（`:id` 是 uuid(7) 字符串） */
export const knowledgeBaseIdParamsSchema = z.object({
  id: z.string().uuid(validationMessage('validation.knowledgeBase.idNotUuid')),
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
  /**
   * 连带**自动解绑**的智能体数（`agent_components` 里指向本库的 `KNOWLEDGE` 组件，删除后为零）。
   *
   * 删库**不再因为"被智能体绑定"而 409**（2026-10-08 需求）：绑定随删除一起解除，
   * 界面在确认弹窗里据此明示"会解绑 N 个智能体"，成功提示里也可以带上。
   */
  unboundAgents: z.number().int().min(0),
})
export type RemoveKnowledgeBaseResult = z.infer<typeof removeKnowledgeBaseResultSchema>

// ───────────────────────────── 整库重建（P1-5）─────────────────────────────

/**
 * 整库重建期间检索**仍然可用**的提示（P1-5）。
 *
 * `01` §3.5 的验收原文是"重建期间可检索旧库**或**明确提示停机"。本批选的是**前者**：
 * 重建**刻意不清旧 chunk**（不同于覆盖重建的"先删后建"），旧向量在逐篇重跑完成前一直可被检索，
 * 所以库里没有检索空窗。这句话要显式说出来，否则用户看到一批文档变「解析中」会以为
 * "现在搜不到了"（`DOCUMENT_PARSING_HINT` 说的是**这一篇**暂不参与检索，整库重建正好相反）。
 */
export const REBUILD_SEARCHABLE_HINT =
  '重建期间旧索引仍然可用：检索命中的是重建完成前的内容，逐篇重跑完成后自动切换为新的向量'

/**
 * 更换知识库向量模型时必须重建的提示（P1-5）。
 *
 * 换了 `embeddingModelId` 之后，库里已有的 chunk 仍是**旧模型**产出的向量：同维度时它们是
 * 无意义的相似度、不同维度时直接被 `embedding_dim` 收窄过滤掉 ⇒ 都必须整库重建才能恢复向量检索。
 * （全文检索不受影响 —— 它不碰 embedding。）
 */
export const EMBEDDING_MODEL_CHANGE_REBUILD_HINT =
  '更换向量模型后需要重建整库索引才能恢复向量检索（旧向量与当前模型不在同一空间）；重建前全文检索仍可用'

/**
 * 图片描述模型必须**支持视觉**的提示（P1-11）。
 *
 * 它由后端在建/改知识库时对 `captionModelId` 校验抛出（`400`）：所选模型若不是 `type=CHAT`
 * 或未勾选 `supportsVision`，图片描述阶段会把它当普通文本模型用、必然失败或产出无意义结果，
 * 故**在保存那一刻就拦掉**、并指向模型池里那个开关。
 */
export const CAPTION_MODEL_MUST_SUPPORT_VISION_HINT =
  '图片描述模型必须是「对话」类型且支持视觉的模型：请到「模型池」编辑该模型，勾选「支持图片」（supportsVision）后再选它'

/**
 * 知识库处于 {@link knowledgeBaseItemSchema} 的 `needsRebuild` 状态时，拒绝单篇入库操作（P1-5）的错误文案。
 *
 * 由后端 `uploadDocument` / `reuploadDocument` / `retryDocument` 在**入队前**抛出（`409`）——
 * 这几个动作一次只向量化一篇，会让库出现"新旧维度/模型混合"的半迁移状态、且向量检索会出问题，
 * 必须整库重建。详情页在 `needsRebuild` 时把这三个入口禁用，并给出「重建整库索引」按钮，与本文案一致。
 */
export const KNOWLEDGE_BASE_NEEDS_REBUILD_HINT =
  '该知识库的向量模型已变更（已有向量与当前模型不一致），必须整库重建索引后才能继续入库 / 重试 / 覆盖重传；请在知识库详情页点「重建整库索引」'

/**
 * `POST /api/knowledge-bases/:id/rebuild` 的响应（P1-5）。
 *
 * `total` 是重建**受理的全部文档数**（该库当前文档总数），`enqueued` 是**成功入队**的篇数。
 * 两者不等的唯一原因是 Redis 队列不可用（入队抛错）—— `failed = total - enqueued` 如实回给界面，
 * 而不是把"部分入队失败"伪装成整体成功。⚠️ 与上传端点的"入队失败即整次回滚"不同：
 * 重建不改对象、不改内容，失败的那几篇停在 `PARSING`，**逐篇点「重试」即可恢复**（不丢数据）。
 */
export const rebuildKnowledgeBaseResultSchema = z.object({
  id: z.string(),
  /** 该库被受理重建的文档总数 */
  total: z.number().int().min(0),
  /** 成功入队（交给流水线）的篇数 */
  enqueued: z.number().int().min(0),
  /** 入队失败的篇数（= `total - enqueued`；> 0 时界面应提示逐篇重试） */
  failed: z.number().int().min(0),
})
export type RebuildKnowledgeBaseResult = z.infer<typeof rebuildKnowledgeBaseResultSchema>

// ───────────────────────────── 检索（P0-1-20）─────────────────────────────

/**
 * 全文路查询的**最大长度**（`子方案①` §6-1："长 query 截断到 64 字符"）。
 *
 * 为什么是字符而不是 token：全文路是 `content LIKE '%<子串>%'` 的字面匹配 ——
 * 子串越长越不可能字面命中。64 字符已经是"一整句话"的量级，再长的 query
 * 本来就该由向量路负责（语义相似），继续字面匹配只会颗粒无收。
 */
export const FULLTEXT_QUERY_MAX_CHARS = 64

/**
 * 全文路查询的**最小有效长度**（`子方案①` §十三 待决事项 2 定案：`< 2` 字时全文路自动跳过）。
 *
 * 理由：pg_bigm 用 2-gram 建倒排索引，**1 个字符**既构不成一个 bigram、也几乎没有区分度
 * （"的"能命中半个库）。此时不是"可能不准"，而是"必然是无意义的召回" ——
 * 跳过它并**明确告诉调用方**（`FULLTEXT_PATH_SKIPPED_TOO_SHORT`），比返回一屏垃圾好。
 */
export const FULLTEXT_QUERY_MIN_CHARS = 2

/**
 * 引用片段的窗口半径（`子方案①` §九："命中位置前后各取 **80 字符**窗口的原文"）。
 *
 * ⚠️ 单位是**字符（码点）**，不是 `String.length` —— 与 P0-1-18 的分块同一口径：
 * 用 `slice()` 取窗口会**劈开代理对**，产出非法字符串且本层毫无报错。
 */
export const SNIPPET_WINDOW_CHARS = 80

/**
 * 向量路被跳过时的提示之一：**库里的向量与当前模型不是同一个模型产的**。
 *
 * 对应 `子方案①` §八 的降级路径（"探测与告警要在 P0 就位，否则换模型时会静默出错"）：
 * 快照的 `embedding_model` 与当前 provider 的 `name()` 不一致 ⇒ 库里的向量与"将要算出来的
 * query 向量"不在同一个语义空间，比出来的距离**没有意义**。此时**不报 500**，
 * 而是跳过向量路并附上这条警告（`HYBRID` 退化成纯全文检索）。
 */
export const VECTOR_PATH_SKIPPED_MODEL_CHANGED =
  '该知识库使用的 embedding 模型已变更，向量路已跳过（该库需重建后才能参与向量检索）'

/**
 * 向量路被跳过时的提示之二：**服务端 embedding 未就绪**（配置缺项 / 本地模型未就位）。
 *
 * 与上一条区分开：这条是"我们这台机器还没配好"（运维要修），
 * 上一条是"这个库需要重建"（业务要处理）。合成一条会让用户去重做一个治不好的动作。
 */
export const VECTOR_PATH_SKIPPED_NOT_READY = '服务端 embedding 未就绪，向量路已跳过（请先完成 embedding 配置）'

/** 全文路被跳过时的提示：有效字符不足（见 {@link FULLTEXT_QUERY_MIN_CHARS}） */
export const FULLTEXT_PATH_SKIPPED_TOO_SHORT = `检索内容不足 ${FULLTEXT_QUERY_MIN_CHARS} 个有效字符，全文路已跳过`

/**
 * `POST /api/knowledge-bases/:id/search` 请求体（**检索测试页**用，`03` §4.3）。
 *
 * `mode` / `topK` 可在**单次请求里覆盖**（不必先 PATCH 知识库）：检索测试页的价值就在于
 * "拿同一个 query 试三种模式、看双路得分"，若每次都要改库配置再改回来，页面就没法用了
 * （而且会**污染**该库的真实检索配置）。省略时取该库快照的 `retrieval_config`。
 *
 * `score` / `rrfK` / `weights` **刻意不可覆盖**：它们是"这个库的检索口径"，
 * 属于配置而不是试查参数 —— 让试查页能改阈值，等于让一次点击就改掉别人的召回率
 * （页面看到的结果与线上不一致，比看不到更坏）。
 */
export const searchKnowledgeBaseBodySchema = z.object({
  query: z
    .string({ required_error: validationMessage('validation.knowledgeBase.queryRequired') })
    .trim()
    .min(1, validationMessage('validation.knowledgeBase.queryRequired'))
    /**
     * 上限 1000 字符：query 最终要变成一次 embedding 调用（`bge-m3` 输入上限 8192 token，
     * 1000 字符远在其内），也是防误操作的门槛（把整篇文章粘进搜索框）。
     */
    .max(1000, validationMessage('validation.knowledgeBase.queryTooLong', { max: 1000 })),
  topK: z
    .number({ invalid_type_error: validationMessage('validation.knowledgeBase.topKNotNumber') })
    .int(validationMessage('validation.knowledgeBase.topKNotInteger'))
    .min(1, validationMessage('validation.knowledgeBase.topKMin', { min: 1 }))
    .max(100, validationMessage('validation.knowledgeBase.topKMax', { max: 100 }))
    .optional(),
  mode: z
    .enum(RETRIEVAL_MODES, {
      errorMap: () => ({
        message: validationMessage('validation.knowledgeBase.modeAllowed', { allowed: RETRIEVAL_MODES.join('/') }),
      }),
    })
    .optional(),
})
export type SearchKnowledgeBaseBody = z.infer<typeof searchKnowledgeBaseBodySchema>

/**
 * 一条检索结果（**同时是"检索测试页"的一行，也是引用卡的来源**，`子方案①` §六·§九）。
 *
 * ⚠️ 两条口径要一起读：
 *   · 双路原始分（`vectorScore` / `fulltextScore`）**只在本端点出口** ——
 *     §九 说"对外只给融合分"，那是指**引用卡**（F 包的 `citations` 事件）；
 *     检索测试页的价值恰恰是"看到每一路各自的判断"（`03` §4.3 的结果表就带这两列）。
 *   · `rrfScore` 就是 §九 的 `score`（引用对象的融合分），`snippet` 就是 §九 的 `snippet`。
 *
 * `null` 的语义是**"这一路没命中"**（而不是"分数为 0"）：RRF 的规则是"缺失即无贡献"，
 * 前端要据此把该列显示成 `—`（显示 0 会让人以为"两路都算了，只是很低"）。
 */
export const retrievalHitSchema = z.object({
  /** `chunks.id`（uuid(7)） */
  chunkId: z.string(),
  docId: z.string(),
  /** 文档名（= `documents.file_name`）：引用卡要显示"来自哪一篇" */
  docName: z.string(),
  /** 块在该文档内的序号（从 0 开始） */
  seq: z.number().int(),
  /** `meta.page`：PDF 才有页码，其余为 `null`（`子方案①` §十三 待决事项 1：P0 只给页码） */
  page: z.number().int().nullable(),
  /** `meta.headingPath`：块所属的标题层级（引用卡显示"在哪一节"） */
  headingPath: z.array(z.string()),
  /**
   * **整块原文**（不加工、不截断）—— 编排层把它整块喂给模型，引用卡也展示它
   * （"卡片里显示的 = 模型看到的"）。
   *
   * ⚠️ 与 {@link snippet} 的分工：`snippet` 是**命中窗口**（最多 `2×SNIPPET_WINDOW_CHARS`
   * 加命中词），只服务**检索测试页**那种"一屏看多条"的紧凑表格；把窗口当资料喂给模型会让
   * 长枚举/规则列表被腰斩（实测：6 条防呆规则被切在「（3）当日：星礼包中的」）。所以资料走
   * `content`、定位走 `snippet`，两个消费方各不相同。
   */
  content: z.string(),
  /** 命中片段（原文窗口，**不加工**，见 {@link SNIPPET_WINDOW_CHARS}）—— 只给检索测试页用 */
  snippet: z.string(),
  /** 向量路原始相似度 `1 - (embedding <=> query)`；该路未命中为 `null` */
  vectorScore: z.number().nullable(),
  /** 向量路名次（从 1 开始）；该路未命中为 `null` */
  vectorRank: z.number().int().nullable(),
  /** 全文路 `bigm_similarity`；该路未命中为 `null` */
  fulltextScore: z.number().nullable(),
  fulltextRank: z.number().int().nullable(),
  /** RRF 融合分（`子方案①` §6-2 的公式） */
  rrfScore: z.number(),
  /** 融合后的名次（从 1 开始）—— `03` §4.3 的"融合排名"列 */
  finalRank: z.number().int(),
})
export type RetrievalHit = z.infer<typeof retrievalHitSchema>

/**
 * `POST /api/knowledge-bases/:id/search` 响应。
 *
 * `mode` / `topK` / `rrfK` / `candidatePool` 回显**生效值**（请求可覆盖前两个）：
 * 试查页要能一眼看出"这次用的是哪套口径"（`rrfScore` 的具体数值只有配上 `rrfK` 才可解释）。
 */
export const searchKnowledgeBaseResultSchema = z.object({
  items: z.array(retrievalHitSchema),
  /** 本次**生效**的检索模式（请求体给了就是它） */
  mode: z.enum(RETRIEVAL_MODES),
  /** 本次**生效**的返回条数上限 */
  topK: z.number().int(),
  /** 本次**生效**的 RRF 平滑常数（`子方案①` §6-2） */
  rrfK: z.number().int(),
  /** 每路的候选池大小 = `topK × CANDIDATE_POOL_FACTOR`（融合后再截断到 `topK`） */
  candidatePool: z.number().int(),
  /** 端到端耗时（毫秒，含 query 的 embedding 调用与两次 SQL） */
  elapsedMs: z.number().int().min(0),
  /**
   * 向量路是否**没有运行**（`HYBRID` 下模型变更 / embedding 未就绪时降级；`FULLTEXT` 下恒为 `true`）。
   *
   * 给机器看的布尔：界面据此挂"本次只走了全文检索"的横幅。
   * 原因文案在 `warnings` 里 —— 用字符串让前端去匹配文案是最脆的一种契约。
   */
  vectorPathSkipped: z.boolean(),
  /** 人读的警告（已降级的原因、全文路被跳过的原因）；空数组 = 一切正常 */
  warnings: z.array(z.string()),
})
export type SearchKnowledgeBaseResult = z.infer<typeof searchKnowledgeBaseResultSchema>
