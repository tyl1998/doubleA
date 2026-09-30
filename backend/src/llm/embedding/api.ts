/**
 * embedding · **api 模式**（OpenAI 兼容 `POST {baseUrl}/embeddings`）
 *
 * 依据：`docs/02-后端设计.md` §八（`api`：OpenAI 兼容 POST `{base_url}/embeddings`；
 *      配置 `EMBEDDING_MODE=api` + `EMBEDDING_API_URL/KEY/MODEL`）、§六.1（差异收敛在传输层）、
 *      §十一（`EMBEDDING_DIM` 与 `chunks.embedding` 的 `vector(1024)` 必须一致）。
 * 产出要求：`06` P0-1-13 —— 「`api` 模式返回 1024 维（或按配置维度）」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的三条口径
 * ─────────────────────────────────────────────────────────────────────
 *
 * **① 报文最小化**：请求体只有 `{ model, input }`。**刻意不发** `encoding_format` /
 *    `dimensions` / `user` —— 它们各自都有"某类网关不认就 400"的记录，而本平台要的是
 *    "换任何 OpenAI 兼容实现都能跑"（与 P0-1-12 不发 `stream_options` 同一条理由）。
 *
 * **② 批是**串行**的（与 `子方案①` §4-3 的 `Promise.all(batches.map(...))` 示意**有意不同**）**：
 *    `Promise.all` 会把一份 5000 chunk 的文档变成 157 个并发请求，上游限流会当场打回，
 *    且失败后"哪一批坏了"也说不清。流水线本身已有 `PIPELINE_CONCURRENCY=2` 的任务级并发，
 *    批级再叠一层并发只有坏处。批大小取 `EMBEDDING_BATCH_SIZE`（默认 32，`子方案①` §4-3 的
 *    `chunk_embed_batch`，P0-1-15 建库时把它快照进 KB）。
 *    真要提速请换成"带上限的并发池"，**不要**裸 `Promise.all`。
 *
 * **③ 重试不在这里**：`子方案①` §4-3 的"单批失败重试 2 次（1s/3s 退避）"属于流水线的
 *    任务级策略（`06` P0-1-19：重试与"整篇文档 FAILED"是同一个决策）。provider 只做
 *    单次调用 + 明确报错，把"要不要重试"留给上层，避免两处各重试一遍（放大上游压力）。
 */

import { AppError } from '@doubulea/shared'

import { config } from '../../config.js'
import { fetchUpstreamJson, snippet, type UpstreamEndpoint } from '../upstream.js'
import type { EmbeddingImage, EmbeddingInput, EmbeddingProvider } from './index.js'

/** 该输入是否带图片 */
function hasImage(input: EmbeddingInput): boolean {
  return typeof input !== 'string' && (input.images?.length ?? 0) > 0
}

/** 图片 → `data:<mime>;base64,<...>`（多模态端点的 `image_url.url` 就吃这个形式） */
function imageDataUrl(image: EmbeddingImage): string {
  return `data:${image.mime};base64,${image.data.toString('base64')}`
}

/**
 * 一条输入 → 多模态端点的 content part 数组：
 * `[{type:'text',text}, {type:'image_url',image_url:{url}}...]`。
 */
function contentPartsOf(input: EmbeddingInput): Array<Record<string, unknown>> {
  const text = typeof input === 'string' ? input : input.text
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text }]
  if (typeof input !== 'string') {
    for (const image of input.images ?? []) {
      parts.push({ type: 'image_url', image_url: { url: imageDataUrl(image) } })
    }
  }
  return parts
}

export interface ApiEmbeddingOptions {
  /** 已归一化（去尾斜杠）的 baseUrl；服务端会自己接 `/embeddings`（除非 `customUrl=true`） */
  apiUrl: string
  apiKey: string | null
  apiModel: string
  /**
   * 期望维度。**本批起可为 `null`**：模型池里的模型不记录维度，
   * 建库时先用 `null` 探测一次（第一次 `embed()` 的返回长度即真实维度），之后即可传入已知维度做逐条校验。
   */
  dim: number | null
  batchSize: number
  /** 上游名字（进日志与错误消息）。缺省 `EMBEDDING_API`；模型池来的给 Provider 名更有用 */
  providerName?: string
  /** 自定义 URL：为 true 时 `apiUrl` 就是完整端点，不拼 `/embeddings`（见 `upstream.ts#resolveUpstreamUrl`） */
  customUrl?: boolean
  /**
   * 多模态 embedding 端点（如火山 `doubao-embedding-vision`）：打 `POST /embeddings/multimodal`，
   * `input` 为 `[{type:"text",text}]`。默认 `false` = 标准 OpenAI `POST /embeddings` + `input:[string]`。
   */
  multimodal?: boolean
  /** 覆盖"到响应头 + 读 body"的上限（测试/一次性任务用） */
  timeoutMs?: number
}

/** api 模式的默认上游名字（进日志与错误消息；未指定 providerName 时用） */
const DEFAULT_UPSTREAM_NAME = 'EMBEDDING_API'

/**
 * embedding 的落库标识（= `EmbeddingProvider.name()`）：`api:<model id>`。
 * 集中一处，供 `kb.service` 的漂移探测复用 —— 两处各拼一遍迟早会漂移。
 */
export function apiEmbeddingName(modelName: string): string {
  return `api:${modelName}`
}

/**
 * OpenAI 兼容接口的 embedding provider。
 *
 * ⚠️ `apiKey` 明文只存在于内存：任何进日志/错误消息的响应片段都由 `upstream.ts`
 * 统一脱敏（`fetchUpstreamJson` 内部走 `snippet`）。
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly #options: ApiEmbeddingOptions
  /** 已知/已推断出的维度；`null` = 尚未确定（下次 embed 后从返回长度补上） */
  #dim: number | null

  constructor(options: ApiEmbeddingOptions) {
    if (options.apiUrl.endsWith('/')) {
      throw AppError.internal(`ApiEmbeddingProvider 的 apiUrl 必须是归一化后的地址（去掉尾斜杠）：${options.apiUrl}`)
    }
    this.#options = options
    this.#dim = options.dim
  }

  /**
   * 落库标记（`子方案①` §八：`chunks.meta.embeddingName`，用于换模型检测）。
   *
   * 形状 `api:<model>`：**同一 model id 在不同 endpoint 上视为同一个模型**（OpenAI 命名惯例里
   * model id 就是身份）。
   */
  name(): string {
    return apiEmbeddingName(this.#options.apiModel)
  }

  /** 已知维度；尚未探测到时抛错（调用方应先 `embed()` 探测，或在构造时给已知维度） */
  dim(): number {
    if (this.#dim === null) {
      throw AppError.internal(`embedding 维度尚未确定（model=${this.#options.apiModel}）：请先完成一次 embedding 调用`)
    }
    return this.#dim
  }

  async embed(inputs: readonly EmbeddingInput[]): Promise<number[][]> {
    // 空输入**不发请求**（有的实现会对 `input: []` 回 400，而"没有文本"不是错误）
    if (inputs.length === 0) return []

    // 图片只能走多模态端点：模型没标多模态却收到图片 ⇒ 当场拒绝，不要把图片当文本吞掉
    // （静默降级会让"图片内容没进向量空间"变成一个事后无法解释的检索缺失）
    const multimodal = this.#options.multimodal === true
    if (!multimodal && inputs.some(hasImage)) {
      throw AppError.internal(
        `所选 embedding 模型不支持多模态，无法向量化图片（model=${this.#options.apiModel}）`,
      )
    }

    // 多模态端点（如火山 doubao-embedding-vision）一次请求只回**一个**融合向量 ⇒
    // 只能一条一条发（每次请求 1 条输入、取回 1 个向量），否则条数对不上。
    const batchSize = multimodal ? 1 : this.#options.batchSize
    const vectors: number[][] = []
    for (let start = 0; start < inputs.length; start += batchSize) {
      const batch = inputs.slice(start, start + batchSize)
      const result = await this.#embedBatch(batch, this.#dim)
      // 首次探测：拿返回的向量长度当维度（此后逐批按它校验，不再接受不同维度）
      if (this.#dim === null && result[0] !== undefined) this.#dim = result[0].length
      vectors.push(...result)
    }
    return vectors
  }

  async #embedBatch(inputs: readonly EmbeddingInput[], expectedDim: number | null): Promise<number[][]> {
    const endpoint: UpstreamEndpoint = {
      providerName: this.#options.providerName ?? DEFAULT_UPSTREAM_NAME,
      subject: this.#options.apiModel,
      baseUrl: this.#options.apiUrl,
      customUrl: this.#options.customUrl,
      apiKey: this.#options.apiKey,
    }

    // 多模态端点：路径不同 + input 是 content 分片
    //   · 无图片：仍是 `[{type:'text',text}]`（与历史逐字一致）
    //   · 有图片：`[{type:'text',text},{type:'image_url',image_url:{url:data:...}}]`
    // 标准端点：`input` 是纯文本数组（图片输入在 embed() 已拦下）
    const multimodal = this.#options.multimodal === true
    const bodyInput = multimodal
      ? contentPartsOf(inputs[0] ?? '')
      : inputs.map((input) => (typeof input === 'string' ? input : input.text))
    const payload = await fetchUpstreamJson(endpoint, {
      path: multimodal ? '/embeddings/multimodal' : '/embeddings',
      body: {
        model: this.#options.apiModel,
        input: bodyInput,
      },
      // 超时沿用 `LLM_REQUEST_TIMEOUT_MS`（同一个"到响应头 + 读 body"上限，没必要再开一个变量）
      timeoutMs: this.#options.timeoutMs ?? config.llm.requestTimeoutMs,
      stage: 'embeddings',
    })

    return readEmbeddingPayload(payload, endpoint, inputs.length, expectedDim)
  }
}

/**
 * 解析 `/embeddings` 的响应体。
 *
 * 真实存在的几种形态（都在这里收敛，调用方只拿到 `number[][]`）：
 *   · 标准 `{ data: [{ embedding: [...], index: 0 }] }`
 *   · 省略 index、只保证顺序的 `{ data: [{ embedding: [...] }] }`
 *   · `data` 里直接放数组的 `{ data: [[...]] }`
 *   · 老式/自建的 `{ embeddings: [[...]] }`（ollama 原生形态）
 *
 * ⚠️ **按 `index` 归位**不是洁癖：`data` 不保证有序是文档明说的（并发实现常乱序返回），
 *    不归位就会出现"第 3 段文本配了第 7 段的向量"——这种脏数据查起来极难（检索结果莫名偏移）。
 */
export function readEmbeddingPayload(
  payload: unknown,
  endpoint: UpstreamEndpoint,
  expectedCount: number,
  expectedDim: number | null,
): number[][] {
  if (typeof payload !== 'object' || payload === null) {
    throw AppError.upstreamError(
      `上游 embedding 响应结构异常（不是对象）：${endpoint.providerName}。响应：${snippet(JSON.stringify(payload), endpoint.apiKey)}`,
    )
  }
  const record = payload as Record<string, unknown>

  // 有的网关**用 200 返回错误**（与 chat 同款坑，见 `client.ts#readCompletionPayload`）
  if (typeof record.error === 'object' && record.error !== null) {
    const message = (record.error as { message?: unknown }).message
    throw AppError.upstreamError(
      `上游以 200 返回了错误：${endpoint.providerName} / ${endpoint.subject}。` +
        snippet(String(message ?? '(无 message)'), endpoint.apiKey),
    )
  }

  const rows = collectRows(record)
  if (rows.length === 0) {
    throw AppError.upstreamError(
      `上游 embedding 响应里没有向量（既没有 data[].embedding 也没有 embeddings）：${endpoint.providerName} / ${endpoint.subject}。` +
        `响应：${snippet(JSON.stringify(record), endpoint.apiKey)}`,
    )
  }

  // 有 index 就按 index 归位（要求它是一组 0..n-1 的排列，否则说明我们对报文的假设错了）
  const indexes = rows.map((row) => row.index)
  const allIndexed = indexes.every((index) => index !== null)
  let ordered = rows
  if (allIndexed) {
    const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const valid = sorted.every((row, position) => row.index === position)
    if (!valid) {
      throw AppError.upstreamError(
        `上游 embedding 响应的 index 不是 0..${rows.length - 1} 的排列（无法安全归位）：${endpoint.providerName} / ${endpoint.subject}`,
      )
    }
    ordered = sorted
  }

  if (ordered.length !== expectedCount) {
    throw AppError.upstreamError(
      `上游返回的向量条数与输入不符（输入 ${expectedCount} 条，返回 ${ordered.length} 条）：${endpoint.providerName} / ${endpoint.subject}。` +
        '出现这种情况说明该实现不支持批量输入，请把 EMBEDDING_BATCH_SIZE 调小到 1 试试',
    )
  }

  return ordered.map((row) => {
    const vector = row.vector
    // `expectedDim === null` = 首次探测（建库时）⇒ 不校验，把真实维度作为结果返回
    if (expectedDim !== null && vector.length !== expectedDim) {
      throw AppError.upstreamError(
        `上游返回 ${vector.length} 维向量，与期望的 ${expectedDim} 维不一致：${endpoint.providerName} / ${endpoint.subject}。` +
          '同一知识库内的向量维度必须一致 —— 请核对所选 embedding 模型是否被改动。',
      )
    }
    return vector
  })
}

/** 把三种形态的"一行"取出来：`{embedding:[]}` / `[]` / `{index}` */
function collectRows(record: Record<string, unknown>): Array<{ vector: number[]; index: number | null }> {
  const raw: unknown[] = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.embeddings)
      ? record.embeddings
      : []

  const rows: Array<{ vector: number[]; index: number | null }> = []
  for (const entry of raw) {
    if (Array.isArray(entry)) {
      rows.push({ vector: toVector(entry), index: null })
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const vector = Array.isArray(row.embedding) ? toVector(row.embedding) : null
    if (vector === null) continue
    const index = typeof row.index === 'number' && Number.isInteger(row.index) ? row.index : null
    rows.push({ vector, index })
  }

  // 多模态端点（火山 doubao-embedding-vision）返回的是**单个对象**而非数组：
  //   { "created": …, "data": { "embedding": [ … ] } }
  // 顶层直接给 `embedding` 的实现也一并兜住。
  if (rows.length === 0) {
    const single = record.data
    if (
      typeof single === 'object' &&
      single !== null &&
      !Array.isArray(single) &&
      Array.isArray((single as Record<string, unknown>).embedding)
    ) {
      rows.push({ vector: toVector((single as Record<string, unknown>).embedding as unknown[]), index: null })
    } else if (Array.isArray(record.embedding)) {
      rows.push({ vector: toVector(record.embedding), index: null })
    }
  }
  return rows
}

/** 元素必须是有限数字（NaN/Infinity 进了向量列，检索时会得到莫名其妙的结果） */
function toVector(values: unknown[]): number[] {
  const vector: number[] = []
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw AppError.upstreamError(
        `上游返回的向量里含非数字元素（${JSON.stringify(value)}）—— 该响应不可用`,
      )
    }
    vector.push(value)
  }
  return vector
}
