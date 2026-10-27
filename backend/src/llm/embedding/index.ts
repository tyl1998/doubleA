/**
 * embedding · **统一入口**（双模式 provider + 工厂）
 *
 * 依据：`docs/02-后端设计.md` §八（接口只有三个方法 `embed()` / `dim()` / `name()`；
 *      `EMBEDDING_MODE=local|api` 切换；`name()` 变化 = 需重建）、§十一（`EMBEDDING_DIM` 与
 *      `chunks.embedding` 的 `vector(1024)` 必须一致）；`子方案/知识库流水线.md` §八（换模型检测）。
 * 产出要求：`06` P0-1-13 —— 「统一 `EmbeddingProvider` 接口（`02` §八：`embed()` / `dim()` /
 *      `name()`）；`EMBEDDING_MODE` 切换」、「`api` 时返回 1024 维（或按配置维度）」、
 *      「`name()` 能区分两种模式（供换模型检测）」。
 *
 * 为什么工厂是**同步**的：D 包（流水线）在 worker 里同步取用；local 模式真正的重活（起线程、
 * 加载 onnx）是**懒**的（第一次 `embed()` 才发生）。工厂只做**可执行的校验**（配置齐不齐），
 * 不齐就在取用的那一刻报错 —— 这正是 `config.ts` 里那句"硬要求下移到 P0-1-13 的 provider
 * 初始化"的落点（P0-1-3 只打 WARN，不拦启动）。
 */

import { appMsg, AppError } from '@doubulea/shared'

import { config } from '../../config.js'
import { ApiEmbeddingProvider } from './api.js'
import { LocalEmbeddingProvider, localEmbeddingProblems } from './local.js'

export { ApiEmbeddingProvider, apiEmbeddingName, readEmbeddingPayload } from './api.js'
export { LocalEmbeddingProvider, localEmbeddingProblems } from './local.js'

/** `EMBEDDING_MODE` 的两个取值（与 `config.ts#EMBEDDING_MODES` 同源） */
export type EmbeddingMode = 'local' | 'api'

/**
 * 送入 embedding 的一张图片（原始字节 + MIME；api 层负责转成 data URL content part）。
 * 只在 `MULTIMODAL` 图片模式使用。
 */
export interface EmbeddingImage {
  mime: string
  data: Buffer
}

/**
 * 一条 embedding 输入：纯文本（历史形态）或"文本 + 若干图片"。
 * 多模态端点会把文本与图片作为同一 content 的多个 part，融合成一个向量。
 */
export interface EmbeddingContent {
  text: string
  images?: readonly EmbeddingImage[]
}

export type EmbeddingInput = string | EmbeddingContent

/**
 * `02` §八 的三个方法（**只有这三个**：`embed` / `dim` / `name`）。
 *
 * `dim()` 返回的是**本项目期望的维度**（= `EMBEDDING_DIM` = `chunks.embedding` 的 `vector(N)`）：
 * 它是 D 包写 DDL/meta 的依据；上游/运行时实际返回的维度会在每次调用时逐条校验，
 * 不符立刻报错（而不是把维度不对的向量写进库 —— 那种数据事后没法分辨）。
 *
 * `embed` 接受 {@link EmbeddingInput}：纯文本调用（检索 query、普通分块）传 `string` 即可；
 * 多模态图片分块传 `{ text, images }`。**条数与顺序必须与输入逐条对应**。
 */
export interface EmbeddingProvider {
  embed(inputs: readonly EmbeddingInput[]): Promise<number[][]>
  dim(): number
  /** 落库标记（`chunks.meta.embeddingName`），换模型检测靠它 */
  name(): string
}

/** 就绪自检的结果（给启动日志 / 运维排查用；`ready=false` 时 `problems` 一定非空） */
export interface EmbeddingReadiness {
  mode: EmbeddingMode
  ready: boolean
  dim: number
  /** 就绪时的落库标记（`name()`）—— 未就绪为 `null`（此刻给不出可信的名字） */
  name: string | null
  problems: string[]
}

let cached: { mode: EmbeddingMode; provider: EmbeddingProvider } | null = null

/**
 * 取当前 `EMBEDDING_MODE` 下的 provider（**记忆化**：同一个进程里只建一次）。
 *
 * 切模式请改 `EMBEDDING_MODE` 后重启进程（配置是启动期一次读定的，这是 `02` §十一 的口径）；
 * 验收脚本要在一个进程里试两种模式时用显式构造（`new ApiEmbeddingProvider(...)` /
 * `new LocalEmbeddingProvider(...)`），或调 {@link resetEmbeddingProvider}。
 *
 * @throws {AppError} `INTERNAL`(500)：配置不齐 / 本地模型与运行时未就位（消息里给全问题清单）
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const mode = config.embedding.mode
  if (cached !== null && cached.mode === mode) return cached.provider

  const readiness = embeddingReadiness()
  if (!readiness.ready) {
    throw AppError.internal(appMsg('app.m042', { p0: mode, p1: readiness.problems.join('；') }))
  }

  const provider = buildProvider(mode)
  cached = { mode, provider }
  return provider
}

/**
 * 立刻释放缓存的 provider（若持有 worker 线程则一并释放）。
 *
 * 用途：验收脚本在同一进程里换模式/换参数重试；进程优雅退出时也可以调（不调也不会漏 ——
 * worker 是子线程，`process.exit` 会把它带走）。
 */
export async function resetEmbeddingProvider(): Promise<void> {
  const current = cached
  cached = null
  if (current?.provider instanceof LocalEmbeddingProvider) {
    await current.provider.dispose()
  }
}

/**
 * 就绪自检（不抛；启动日志想加一条、或运维自检脚本都能用它）。
 *
 * `name` 刻意**由 provider 自己给**（而不是在这里再拼一遍字符串）：两种模式的命名规则
 * 各自在 `api.ts` / `local.ts` 里，"就绪自检"与"实际用的"必须是同一个值 —— 否则换模型检测
 * （`子方案①` §八）会拿一个假名字去比对。
 */
export function embeddingReadiness(): EmbeddingReadiness {
  const { mode, dim } = config.embedding
  const problems = mode === 'api' ? apiProblems() : localProblems()
  if (problems.length > 0) {
    return { mode, ready: false, dim, name: null, problems }
  }
  return { mode, ready: true, dim, name: buildProvider(mode).name(), problems: [] }
}

/** api 模式的三项必填（与 `config.embedding.apiReady` 同一套判定） */
function apiProblems(): string[] {
  const { apiUrl, apiKey, apiModel } = config.embedding
  const missing = [
    apiUrl === undefined ? 'EMBEDDING_API_URL' : null,
    apiKey === undefined ? 'EMBEDDING_API_KEY' : null,
    apiModel === undefined ? 'EMBEDDING_API_MODEL' : null,
  ].filter((item): item is string => item !== null)
  if (missing.length === 0) return []
  return [
    `EMBEDDING_MODE=api 但缺 ${missing.join(' / ')} —— ` +
      '请在 infra/.env 补齐这三项（模板见 .env.example），或改用 EMBEDDING_MODE=local',
  ]
}

function localProblems(): string[] {
  return localEmbeddingProblems({
    modelPath: config.embedding.localModelPath,
    runtimeModule: config.embedding.localRuntimeModule ?? null,
    dim: config.embedding.dim,
    batchSize: config.embedding.batchSize,
  })
}

/**
 * 按模式建 provider。**不校验**（调用方保证已就绪）—— 校验只有一处（{@link embeddingReadiness}），
 * 免得"能不能用"有两套说法。
 */
function buildProvider(mode: EmbeddingMode): EmbeddingProvider {
  const { apiUrl, apiKey, apiModel, dim, batchSize, localModelPath, localRuntimeModule } = config.embedding
  if (mode === 'api') {
    if (apiUrl === undefined || apiModel === undefined) {
      throw AppError.internal(appMsg('app.m043'))
    }
    return new ApiEmbeddingProvider({
      apiUrl,
      // 没配 Key 时带 `null`：有的自建/内网 OpenAI 兼容实现不校验凭据（与 `listProviderRemoteModels` 同款口径）
      apiKey: apiKey ?? null,
      apiModel,
      dim,
      batchSize,
    })
  }
  return new LocalEmbeddingProvider({
    modelPath: localModelPath,
    runtimeModule: localRuntimeModule ?? null,
    dim,
    batchSize,
  })
}

// ═════════════════════════════════════════════════════════════════════
// 模型池来源的 provider（本批：知识库 embedding 改用建库时选定的模型）
// ═════════════════════════════════════════════════════════════════════

/** 模型池里一个 EMBEDDING 模型解析出的上游目标（由 `services/model.service.ts#resolveEmbeddingTarget` 组装） */
export interface PoolEmbeddingTarget {
  /** 日志/错误消息里的上游名字（用 Provider 名，比 `EMBEDDING_API` 更好排查） */
  providerName: string
  /** 已归一化（去尾斜杠）的 baseUrl */
  baseUrl: string
  /** 自定义 URL：为 true 时 baseUrl 就是完整端点，不拼 `/embeddings` */
  customUrl?: boolean
  /** 多模态 embedding 端点（`/embeddings/multimodal` + content 分片 input） */
  multimodal?: boolean
  /** 未配置为 `null`（内网免鉴权实现） */
  apiKey: string | null
  /** 上游 model id */
  apiModel: string
}

/**
 * 用模型池的 EMBEDDING 模型构造 provider（OpenAI 兼容 `/embeddings`；`multimodal` 时走多模态端点）。
 *
 * `dim` 允许为 `null`：建库时用它**探测**一次真实维度（第一次 `embed()` 的返回长度）。
 */
export function buildPoolEmbeddingProvider(
  target: PoolEmbeddingTarget,
  dim: number | null,
  batchSize: number,
): ApiEmbeddingProvider {
  return new ApiEmbeddingProvider({
    apiUrl: target.baseUrl,
    apiKey: target.apiKey,
    apiModel: target.apiModel,
    dim,
    batchSize,
    providerName: target.providerName,
    customUrl: target.customUrl,
    multimodal: target.multimodal,
  })
}

/** 探测维度用的占位文本（内容无所谓，只关心返回向量的长度） */
const DIM_PROBE_TEXT = 'dimension probe'

/**
 * 向该模型发一次极小 embedding 请求，返回其**真实维度**（建库时快照用）。
 *
 * 不齐/不可达时抛 `AppError`（消息可直接展示），让建库**快速失败**而不是等到第一篇文档入库才发现。
 */
export async function probeEmbeddingDim(
  target: PoolEmbeddingTarget,
  batchSize: number,
  timeoutMs?: number,
): Promise<number> {
  const provider = new ApiEmbeddingProvider({
    apiUrl: target.baseUrl,
    apiKey: target.apiKey,
    apiModel: target.apiModel,
    dim: null,
    batchSize,
    providerName: target.providerName,
    customUrl: target.customUrl,
    multimodal: target.multimodal,
    timeoutMs,
  })
  const [vector] = await provider.embed([DIM_PROBE_TEXT])
  if (vector === undefined) {
    throw AppError.internal(appMsg('app.m044', { p0: target.apiModel }),
    )
  }
  if (vector.length < 1 || !Number.isInteger(vector.length)) {
    throw AppError.internal(appMsg('app.m045', { p0: vector.length }))
  }
  return vector.length
}
