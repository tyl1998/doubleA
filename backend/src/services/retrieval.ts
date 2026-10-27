/**
 * 检索服务：双路检索 + RRF 融合 + 引用对象构造（P0-1-20）
 *
 * 依据：`docs/子方案/知识库流水线.md` §6-1（双路 SQL 与查询预处理）、§6-2（RRF 定案）、
 *      §八（换模型检测与**降级路径**："探测与告警要在 P0 就位，否则换模型时会静默出错"）、
 *      §九（引用格式）、§十三 待决事项 1/2；`docs/02-后端设计.md` §4.6（`POST /:id/search`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的三条口径
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① 两路分数不可比，所以只比排名（RRF）。** cosine 相似度与 bigram 相似度量纲、分布都不同，
 *    任何"分数归一化再加权"的做法都要先假设分数分布（而它会随 query 长度与库内容剧烈变化）
 *    ⇒ 按 §6-2 的定案只用名次：`w_v/(k+rank_v) + w_f/(k+rank_f)`，**缺失的一路记 0**
 *    （"缺失即无贡献"，不惩罚也不补位）。
 *
 * **② 全文路的 query 预处理**：去标点（**全部**，含 `%` / `_` —— 它们是 LIKE 的通配符，
 *    留着会把"字面匹配"悄悄变成"模式匹配"）、剥掉**句首/句尾**的疑问词与虚词、截断到 64 字符、
 *    有效字符 < 2 时**整条路跳过**（§十三 待决事项 2）。
 *    ⚠️ **刻意不删中间的停用词**（对 `§6-1` 草稿"去停用词"的收窄，理由见
 *    {@link normalizeFulltextQuery} 的注释）—— LIKE 要求**连续子串**，删掉中间字符
 *    会把"报销的标准"变成"报销标准"从而**降低**命中率，与初衷相反。
 *
 * **③ 向量路在"库的 embedding 模型 ≠ 当前模型"时**跳过并告警，而不是报 500
 *    （§八 的降级路径）：库里存的向量与将要算出来的 query 向量不在同一语义空间，
 *    比出来的距离没有意义。`HYBRID` 退化成纯全文检索（附警告），`VECTOR` 明确报错
 *    （它没有可退的路 —— 返回空数组会让人以为"库里没有相关内容"）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么纯函数都 export
 * ─────────────────────────────────────────────────────────────────────
 * {@link normalizeFulltextQuery} / {@link buildSnippet} / {@link fuseRrf} 是**规则本身**：
 * 它们的错误不会被 `lint`/`typecheck`/`build` 拦下，也不会让接口 400 —— 症状是"结果不对但界面正常"
 * （命中少了几条、片段截错位置、融合排名看着随机）。故它们必须能被**无依赖档**
 * （`verify:app`，可进 CI）直接断言，这也正是 P0-1-18 把分块做成纯函数的同一条理由。
 */

import { appMsg,
  AppError,
  FULLTEXT_PATH_SKIPPED_TOO_SHORT,
  FULLTEXT_QUERY_MAX_CHARS,
  FULLTEXT_QUERY_MIN_CHARS,
  SNIPPET_WINDOW_CHARS,
  VECTOR_PATH_SKIPPED_MODEL_CHANGED,
  normalizeRetrievalConfig,
  type RetrievalConfig,
  type RetrievalHit,
  type RetrievalMode,
  type SearchKnowledgeBaseResult,
} from '@doubulea/shared'

import { config } from '../config.js'
import { Prisma } from '../../generated/prisma/client.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { buildPoolEmbeddingProvider, type EmbeddingProvider } from '../llm/embedding/index.js'
import { resolveEmbeddingTarget } from './model.service.js'

// ═════════════════════════════════════════════════════════════════════
// 纯函数①：全文路 query 预处理
// ═════════════════════════════════════════════════════════════════════

/**
 * 标点 / 符号 / 控制符 / 空白 —— 全文路 query 里一律剔除。
 *
 * ⚠️ 这里顺手解决了一个**注入语义**问题：`%` 与 `_` 都是 `\p{P}` 成员，
 * 而全文路的 SQL 是 `content LIKE '%' || $1 || '%'` —— 若 needle 里留着 `%`，
 * 一次"字面包含"查询就变成了模式匹配（`100%` 会命中所有含 `100` 的块）。
 * 剔除标点之后这个风险**不存在**，不需要再做一次转义（多一层转义就多一处会漏的地方）。
 */
const NON_MEANINGFUL_CHARS = /[\p{P}\p{S}\p{C}\s]/gu

/**
 * 句首/句尾的"提问脚手架"（**按长度降序**，长词先剥）。
 *
 * 为什么只剥首尾、不删中间：`子方案①` §6-1 的原话是"query 去停用词、去标点后作为 LIKE 子串"，
 * 但 **LIKE 要的是连续子串** —— 把中间的"的"删掉，"报销的标准"会变成"报销标准"，
 * 而正文里写的是"报销的标准"，于是**本来能命中的反而命中不了**。
 * 提问脚手架（"请问…是多少"）恰恰只出现在两端，剥掉它等于把自然语言问句收缩成核心词组，
 * 这才是"去停用词"在**字面匹配**场景下真正想要的效果。
 *
 * 保守是刻意的：不剥"不/没/非"这类否定词（"不含税"剥成"含税"是**语义反转**，
 * 比召回率低严重得多）。
 */
const EDGE_NOISE_WORDS: readonly string[] = [
  '请帮我查一下',
  '帮我查一下',
  '请问一下',
  '请帮我',
  '帮我查',
  '查一下',
  '告诉我',
  '介绍一下',
  '有没有',
  '是不是',
  '能不能',
  '什么是',
  '是什么',
  '什么样',
  '是多少',
  '是哪些',
  '有哪些',
  '为什么',
  '怎么办',
  '关于',
  '对于',
  '请问',
  '请',
  '帮我',
  '介绍',
  '一下',
  '怎么',
  '怎样',
  '如何',
  '哪些',
  '哪个',
  '哪里',
  '多少',
  '是否',
  '可以',
  '能否',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '嘛',
  '的',
  '了',
  '是',
  '有',
]

export interface NormalizedFulltextQuery {
  /** 预处理后的查询子串（已截断到 {@link FULLTEXT_QUERY_MAX_CHARS} 个字符） */
  text: string
  /** 有效字符不足 ⇒ 全文路应当**整条跳过**（`子方案①` §十三 待决事项 2） */
  skipped: boolean
}

/**
 * 自然语言 query → 可直接喂给 `content LIKE '%' || $1 || '%'` 的子串。**永不抛错**。
 *
 * 三步（顺序有意义）：
 *   ① 剔除非表意字符（标点/符号/空白）；② 反复剥掉**两端**的提问脚手架；
 *   ③ 按**码点**截断到 {@link FULLTEXT_QUERY_MAX_CHARS}。
 * 截断放在最后：先截断会把"请问…"这类前缀留在里面，剥完反而不够 64 字符可用了。
 *
 * ⚠️ 截断与长度判定一律走 `[...text]`（码点）：`text.slice()` 会**劈开代理对**
 * 产出非法字符串，而这一层毫无报错（P0-1-18 的同款教训）。
 */
export function normalizeFulltextQuery(raw: string): NormalizedFulltextQuery {
  let text = raw.replace(NON_MEANINGFUL_CHARS, '')
  // 剥首尾脚手架：一次可能剥出新的可剥项（"请问一下…是什么"），故循环到稳定；
  // 上限 8 轮是纯粹的防御（每轮都会变短，正常一两轮就停）。
  // ⚠️ 判等与切片一律走**码点数组**（与全文路"长度单位是字符"的口径一致）；
  //    "剥到与噪声词等长"时**不剥**（否则单字 query "的" 会被剥成空串，
  //    那属于"没有有效内容"，应该由下面的 `< 2 字跳过` 判定接管，而不是在这里静默变成空）。
  for (let round = 0; round < 8; round += 1) {
    const cps = [...text]
    let stripped = false
    for (const word of EDGE_NOISE_WORDS) {
      const wordCps = [...word]
      if (cps.length <= wordCps.length) continue
      if (cps.slice(0, wordCps.length).join('') === word) {
        text = cps.slice(wordCps.length).join('')
        stripped = true
        break
      }
      if (cps.slice(cps.length - wordCps.length).join('') === word) {
        text = cps.slice(0, cps.length - wordCps.length).join('')
        stripped = true
        break
      }
    }
    if (!stripped) break
  }
  const cps = [...text]
  text = cps.length > FULLTEXT_QUERY_MAX_CHARS ? cps.slice(0, FULLTEXT_QUERY_MAX_CHARS).join('') : text
  return { text, skipped: [...text].length < FULLTEXT_QUERY_MIN_CHARS }
}

// ═════════════════════════════════════════════════════════════════════
// 纯函数②：引用片段
// ═════════════════════════════════════════════════════════════════════

/** 在码点数组里找子串的首次出现位置（返回码点下标；找不到为 `-1`） */
function indexOfCodePoints(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer
    }
    return start
  }
  return -1
}

/**
 * 命中片段：**命中位置前后各取 `window` 个字符**的原文窗口（`子方案①` §九 决策 12）。
 *
 * 三条刻意的选择：
 *   · **不加工、不加省略号**：§六 的示例 JSON 里写了 `"……出差住宿标准为……"`，但 §九 明确
 *     "不加工、不摘要"，而 P0-1-20 的验收有一条"片段与原文一致可核对" —— 加了省略号的字符串
 *     **不再是原文的子串**，那条验收就永远做不成。省略号属于**展示**，交给前端按需加。
 *   · **码点窗口**：`[...content].slice()`，否则会劈开代理对（同 chunk 模块的口径）。
 *   · **字面未命中时取块首**（向量路命中、但没有字面出现）：此时没有"命中位置"可取，
 *     块首是唯一稳定的选择 —— 取块中会让人以为命中的是那一段。
 */
export function buildSnippet(
  content: string,
  needle: string,
  window: number = SNIPPET_WINDOW_CHARS,
): string {
  const contentCps = [...content]
  const needleCps = [...needle]
  const at = indexOfCodePoints(contentCps, needleCps)
  if (at < 0) return contentCps.slice(0, window * 2).join('')
  const start = Math.max(0, at - window)
  const end = Math.min(contentCps.length, at + needleCps.length + window)
  return contentCps.slice(start, end).join('')
}

// ═════════════════════════════════════════════════════════════════════
// 纯函数③：RRF 融合
// ═════════════════════════════════════════════════════════════════════

export interface RrfWeights {
  vector: number
  fulltext: number
}

export interface FusedHit {
  chunkId: string
  /** 该块在向量路的名次（1 起）；未命中为 `null` */
  vectorRank: number | null
  /** 该块在全文路的名次（1 起）；未命中为 `null` */
  fulltextRank: number | null
  rrfScore: number
}

/**
 * RRF 单项打分（`子方案①` §6-2）：`w_v / (k + rank_v) + w_f / (k + rank_f)`。
 *
 * **缺失的一路记 0**（而不是补一个"最后一名"或除以某个惩罚系数）：
 * 补位会让"只在单路命中"的块凭空获得另一路的贡献，"缺失即无贡献"是 RRF 的定义。
 */
export function rrfScoreOf(input: {
  vectorRank: number | null
  fulltextRank: number | null
  rrfK: number
  weights: RrfWeights
}): number {
  let score = 0
  if (input.vectorRank !== null) score += input.weights.vector / (input.rrfK + input.vectorRank)
  if (input.fulltextRank !== null) score += input.weights.fulltext / (input.rrfK + input.fulltextRank)
  return score
}

/**
 * 两路**有序 id 列表** → 融合排序（不截断，截断由调用方做）。
 *
 * 排序：`rrfScore` 降序，同分按 `chunkId` 升序。
 * 二级排序是**纯粹为了确定性**（文档没有规定）—— 同分顺序随实现细节浮动时，
 * "同一个 query 两次调用给出不同顺序"会让验收、分页、问题复现全部失去意义。
 * `chunkId` 是 uuid(7)、**时间有序**，所以它等价于"先入库的优先"，不引入任何业务偏好。
 */
export function fuseRrf(input: {
  vector: readonly string[]
  fulltext: readonly string[]
  rrfK: number
  weights: RrfWeights
}): FusedHit[] {
  const vectorRankById = new Map(input.vector.map((id, index) => [id, index + 1]))
  const fulltextRankById = new Map(input.fulltext.map((id, index) => [id, index + 1]))
  const ids = [...new Set([...input.vector, ...input.fulltext])]

  return ids
    .map((chunkId) => {
      const vectorRank = vectorRankById.get(chunkId) ?? null
      const fulltextRank = fulltextRankById.get(chunkId) ?? null
      return {
        chunkId,
        vectorRank,
        fulltextRank,
        rrfScore: rrfScoreOf({ vectorRank, fulltextRank, rrfK: input.rrfK, weights: input.weights }),
      }
    })
    .sort((a, b) => b.rrfScore - a.rrfScore || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0))
}

// ═════════════════════════════════════════════════════════════════════
// 向量路的可用性（§八 的降级路径）
// ═════════════════════════════════════════════════════════════════════

type VectorUnavailableKind = 'MODEL_CHANGED' | 'NOT_READY'

interface VectorUnavailable {
  kind: VectorUnavailableKind
  /** 面向用户的提示（与 `shared` 的常量同源，`HYBRID` 下直接进 `warnings`） */
  message: string
}

/**
 * 本次检索能不能走向量路？能则返回该库**选定模型**构造的 provider，不能则给出**可展示的原因**。
 *
 * 与旧实现的关键差异：不再比对进程级环境变量（那套已停用），而是看**该库自己的
 * `embedding_model_id`** —— 没绑定（老库）/模型被删/模型或 Provider 停用/维度缺失，
 * 都归到 `MODEL_CHANGED`（业务动作：重建或启用），并附上具体原因。
 */
async function resolveVectorProvider(kb: {
  embeddingModelId: string | null
  embeddingDim: number | null
  /** P1-18：embedding 上游凭据的主语 = 库所属人（`PER_USER` 的 Provider 取他的 Key） */
  createdBy: string
}): Promise<{ provider: EmbeddingProvider } | VectorUnavailable> {
  if (kb.embeddingModelId === null || kb.embeddingDim === null) {
    return {
      kind: 'MODEL_CHANGED',
      message: `${VECTOR_PATH_SKIPPED_MODEL_CHANGED}（该库未绑定 embedding 模型或缺少维度快照，需重建）`,
    }
  }
  try {
    const target = await resolveEmbeddingTarget(kb.embeddingModelId, kb.createdBy)
    return {
      provider: buildPoolEmbeddingProvider(
        {
          providerName: target.providerName,
          baseUrl: target.baseUrl,
          customUrl: target.customUrl,
          multimodal: target.embeddingMultimodal,
          apiKey: target.apiKey,
          apiModel: target.modelName,
        },
        kb.embeddingDim,
        config.embedding.batchSize,
      ),
    }
  } catch (error) {
    const reason = error instanceof AppError ? error.message : String(error)
    return { kind: 'MODEL_CHANGED', message: `${VECTOR_PATH_SKIPPED_MODEL_CHANGED}（${reason}）` }
  }
}

// ═════════════════════════════════════════════════════════════════════
// 两条 SQL
// ═════════════════════════════════════════════════════════════════════

interface RankedRow {
  id: string
  score: number
}

/**
 * `doc_id` 过滤的 SQL 片段（可选）。没有指定文档时返回 `Prisma.empty`（一段空 SQL）——
 * 于是"有没有文档过滤"**共用同一条语句**，不必写两份（两份 SQL 迟早漂移一处）。
 */
function docFilterSql(docIds: readonly string[] | undefined): Prisma.Sql {
  return docIds === undefined || docIds.length === 0
    ? Prisma.empty
    : Prisma.sql`AND doc_id = ANY(${docIds}::uuid[])`
}

/**
 * 向量路（`§6-1`）：`1 - (embedding <=> $1)` 升序取候选池。
 *
 * 三处实现口径：
 *   · `kb_id = ANY($2::uuid[])` 保持 `§6-1` 的形状（F 包要一次查多个库），本批传一个元素的数组；
 *   · 相似度下限（`retrieval_config.score`）的过滤放在**池之后**：距离单调 ⇒
 *     "最近的 N 条里过线的" 与 "过线的里面最近的 N 条" 是同一个集合，
 *     而这样能少传一份 20KB 的向量文本（1024 维的 `[0.1,0.2,…]` 字面量）；
 *   · **不加第二排序键**（`ORDER BY embedding <=> $1, id` 会让 HNSW 退化 ——
 *     HNSW 只支持单键距离排序，加了第二键就变成"索引扫描 + 显式排序"，P0-1-14 的索引取证白做）。
 *     tie-break 移到 JS 的稳定排序里（见 {@link searchKnowledgeBase}）。
 */
async function vectorSearch(
  kbIds: readonly string[],
  vectorLiteral: string,
  dim: number,
  pool: number,
  minScore: number,
  docIds?: readonly string[],
): Promise<RankedRow[]> {
  const rows = await getPrisma().$queryRaw<RankedRow[]>`
    SELECT t.id::text AS id, t.score
    FROM (
      SELECT id, (1 - (embedding <=> ${vectorLiteral}::vector))::float8 AS score
      FROM chunks
      WHERE kb_id = ANY(${kbIds}::uuid[]) ${docFilterSql(docIds)} AND embedding IS NOT NULL AND embedding_dim = ${dim}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${pool}
    ) AS t
    WHERE t.score >= ${minScore}
  `
  return stableOrder(rows)
}

/**
 * 全文路（`§6-1`）：`content LIKE '%词%'` + `bigm_similarity` 排序。
 *
 * `LIKE` 而不是 `to_tsvector`：PG 内置 parser 按空格/标点切词，中文整句会**成为一个 token**
 * （`子方案①` §4-4 的 A2 结论）；pg_bigm 的 2-gram 倒排索引才能让 `LIKE '%词%'` 走上索引。
 * 代价是"字面包含"对同义改写无能为力 —— 那部分由向量路补足，这正是双路存在的理由。
 *
 * 参数里的 needle 由 {@link normalizeFulltextQuery} 保证**不含** `%` / `_`（LIKE 通配符）。
 */
async function fulltextSearch(
  kbIds: readonly string[],
  needle: string,
  pool: number,
  docIds?: readonly string[],
): Promise<RankedRow[]> {
  const rows = await getPrisma().$queryRaw<RankedRow[]>`
    SELECT t.id::text AS id, t.score
    FROM (
      SELECT id, bigm_similarity(content, ${needle})::float8 AS score
      FROM chunks
      WHERE kb_id = ANY(${kbIds}::uuid[]) ${docFilterSql(docIds)} AND content LIKE '%' || ${needle} || '%'
      ORDER BY score DESC
      LIMIT ${pool}
    ) AS t
  `
  return stableOrder(rows)
}

/**
 * 稳定排序：主键 `score` 降/升序（调用方已按 SQL 语义定好方向）+ 副键 `id` 升序。
 *
 * 为什么不在 SQL 里加第二排序键：见 {@link vectorSearch} 的第 3 条（HNSW 会退化）。
 * 这里只对**已经取回来的候选池**排序，不影响索引计划。
 */
function stableOrder(rows: readonly RankedRow[], descending = true): RankedRow[] {
  return [...rows].sort((a, b) => {
    const delta = descending ? b.score - a.score : a.score - b.score
    if (delta !== 0) return delta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

// ═════════════════════════════════════════════════════════════════════
// 检索主流程
// ═════════════════════════════════════════════════════════════════════

export interface SearchKnowledgeBaseInput {
  kbId: string
  query: string
  /** 单次请求覆盖该库的 `topK`（检索测试页用） */
  topK?: number
  /** 单次请求覆盖该库的 `mode`（检索测试页用） */
  mode?: RetrievalMode
  /**
   * 只在**指定的文档**里检索（可选；`knowledge_search` 工具的 `doc` 参数用它）。
   * 空/未给 = 不限制（在该库全部文档里检索）。逐路 SQL 里加 `AND doc_id = ANY(...)`
   * （见 {@link docFilterSql}）—— 与 `kb_id` 过滤同一个位置，不改变召回/排序语义。
   */
  docIds?: readonly string[]
}

interface ChunkRow {
  id: string
  doc_id: string
  seq: number
  content: string
  meta: string
  file_name: string
}

/**
 * 检索一个知识库（`POST /api/knowledge-bases/:id/search`，登录即可）。
 *
 * 流程：读库（404 / 取生效配置）→ 向量路（可用时）→ 全文路（有效时）→ RRF 融合 →
 * 截断 → 补齐文档名/片段 → 组装。
 *
 * @throws {AppError} `NOT_FOUND`(404) 库不存在；
 *   `CONFLICT`(409) `mode=VECTOR` 但库的 embedding 模型已变更（§八 无路可退）；
 *   `INTERNAL`(500) `mode=VECTOR` 但服务端 embedding 未就绪（配置问题）
 */
export async function searchKnowledgeBase(
  input: SearchKnowledgeBaseInput,
): Promise<SearchKnowledgeBaseResult> {
  const startedAt = process.hrtime.bigint()
  const db = getPrisma()
  const kb = await db.knowledgeBase.findUnique({
    where: { id: input.kbId },
    select: { id: true, embeddingModel: true, embeddingModelId: true, embeddingDim: true, retrievalConfig: true, createdBy: true },
  })
  if (kb === null) throw AppError.notFound(appMsg('app.m003'))

  // 生效配置：库里的 jsonb 补全默认值（唯一入口），再叠本次请求的覆盖
  const kbConfig: RetrievalConfig = normalizeRetrievalConfig(kb.retrievalConfig)
  const mode: RetrievalMode = input.mode ?? kbConfig.mode
  const topK = input.topK ?? kbConfig.topK
  // 候选池放大（`§6-1`）：融合需要足够的双路候选，直接各取 topK 会让 RRF 退化成"机械交替"
  const candidatePool = Math.max(topK * config.pipeline.candidatePoolFactor, topK)

  const kbIds = [input.kbId]
  const warnings: string[] = []

  // ── 向量路 ──
  let vectorRanked: string[] = []
  let vectorScores = new Map<string, number>()
  let vectorPathSkipped = mode === 'FULLTEXT'
  if (mode !== 'FULLTEXT') {
    const resolved = await resolveVectorProvider(kb)
    if ('provider' in resolved) {
      const [vector] = await resolved.provider.embed([input.query])
      if (vector === undefined) {
        // provider 的契约保证"条数相符"，走到这里说明契约被破坏了：宁可整次失败，
        // 也不要拿一个 undefined 去拼 SQL（那会变成 SQL 语法错误，排查方向完全不同）
        throw AppError.internal(appMsg('app.m218'))
      }
      const literal = `[${vector.join(',')}]`
      const rows = await vectorSearch(kbIds, literal, kb.embeddingDim ?? vector.length, candidatePool, kbConfig.score, input.docIds)
      vectorRanked = rows.map((row) => row.id)
      vectorScores = new Map(rows.map((row) => [row.id, row.score]))
    } else if (mode === 'VECTOR') {
      // VECTOR 模式没有可退的路：返回空数组会被读成"库里没有相关内容"（一句假话）。
      throw resolved.kind === 'MODEL_CHANGED'
        ? AppError.conflict(appMsg('app.m219', { p0: resolved.message }))
        : AppError.internal(resolved.message)
    } else {
      vectorPathSkipped = true
      warnings.push(`${resolved.message}，本次已降级为全文检索`)
    }
  }

  // ── 全文路 ──
  const fulltextQuery = normalizeFulltextQuery(input.query)
  let fulltextRanked: string[] = []
  let fulltextScores = new Map<string, number>()
  if (mode !== 'VECTOR') {
    if (fulltextQuery.skipped) {
      warnings.push(FULLTEXT_PATH_SKIPPED_TOO_SHORT)
    } else {
      const rows = await fulltextSearch(kbIds, fulltextQuery.text, candidatePool, input.docIds)
      fulltextRanked = rows.map((row) => row.id)
      fulltextScores = new Map(rows.map((row) => [row.id, row.score]))
    }
  }

  // ── 融合 + 截断 ──
  const fused = fuseRrf({
    vector: vectorRanked,
    fulltext: fulltextRanked,
    rrfK: kbConfig.rrfK,
    weights: kbConfig.weights,
  }).slice(0, topK)

  // ── 补齐（一条 SQL 拿本次结果要用的全部字段；不逐条查，也不多取全库）──
  const hitIds = fused.map((hit) => hit.chunkId)
  const rows =
    hitIds.length === 0
      ? []
      : await db.$queryRaw<ChunkRow[]>`
          SELECT c.id::text AS id, c.doc_id::text AS doc_id, c.seq, c.content, c.meta::text AS meta,
                 d.file_name
          FROM chunks c
          JOIN documents d ON d.id = c.doc_id
          WHERE c.id = ANY(${hitIds}::uuid[])
        `
  const rowById = new Map(rows.map((row) => [row.id, row]))

  const items: RetrievalHit[] = []
  for (const hit of fused) {
    const row = rowById.get(hit.chunkId)
    // 极窄的窗口：这块 chunk 在两条 SQL 之间被删了（覆盖重建/删文档）。跳过它而不是让整个
    // 请求 500 —— 检索是只读操作，宁可少一条结果（`finalRank` 由下面的下标重新编号，保持连续）。
    if (row === undefined) continue
    const meta = parseChunkMeta(row.meta)
    items.push({
      chunkId: row.id,
      docId: row.doc_id,
      docName: row.file_name,
      seq: row.seq,
      page: meta.page,
      headingPath: meta.headingPath,
      // 整块原文（给模型与引用卡）与命中窗口（只给检索测试页）—— 分工见 `retrievalHitSchema`
      content: row.content,
      snippet: buildSnippet(row.content, fulltextQuery.skipped ? '' : fulltextQuery.text),
      vectorScore: vectorScores.get(row.id) ?? null,
      vectorRank: hit.vectorRank,
      fulltextScore: fulltextScores.get(row.id) ?? null,
      fulltextRank: hit.fulltextRank,
      rrfScore: hit.rrfScore,
      finalRank: items.length + 1,
    })
  }

  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n)
  getLogger().info(
    {
      kbId: input.kbId,
      mode,
      topK,
      rrfK: kbConfig.rrfK,
      candidatePool,
      vectorHits: vectorRanked.length,
      fulltextHits: fulltextRanked.length,
      returned: items.length,
      vectorPathSkipped,
      elapsedMs,
    },
    '知识库检索完成',
  )

  return {
    items,
    mode,
    topK,
    rrfK: kbConfig.rrfK,
    candidatePool,
    elapsedMs,
    vectorPathSkipped,
    warnings,
  }
}

/**
 * `chunks.meta` 的读取口径（唯一入口；导出给 `chunk.service.ts` 的片段预览复用）。
 *
 * 它是 jsonb，历史行可能缺键（P0-1-18 起写入，但手工插的行不会）⇒ 逐键兜底，
 * 且 `page` 只认**有限数字**（`JSON.parse` 出来的可能是字符串或 null）。
 * 形状见 `子方案①` §4-4：`{ headingPath, page, embeddingName }`。
 *
 * ⚠️ 入参是 `unknown` 而不是 `string`：检索层用手写 SQL，拿到的 jsonb 是**文本**；
 * 片段预览用 Prisma `findMany`，拿到的是**已解析的对象** —— 两种形状都从这里收口，
 * 否则"缺键怎么兜底"会有第二份实现，迟早先腐烂一处。
 */
export function parseChunkMeta(raw: unknown): { headingPath: string[]; page: number | null } {
  // `meta` 的两个来源形状不同：手写 SQL（检索层）回的是 **jsonb 文本**，Prisma 的
  // `findMany`（chunk 预览）回的是**已解析的对象**。这里两种都收，避免同一个兜底口径写两遍。
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { headingPath: [], page: null }
    }
  }
  if (typeof value !== 'object' || value === null) return { headingPath: [], page: null }
  const record = value as { headingPath?: unknown; page?: unknown }
  const headingPath = Array.isArray(record.headingPath)
    ? record.headingPath.filter((item): item is string => typeof item === 'string')
    : []
  const page =
    typeof record.page === 'number' && Number.isFinite(record.page) && Number.isInteger(record.page)
      ? record.page
      : null
  return { headingPath, page }
}
