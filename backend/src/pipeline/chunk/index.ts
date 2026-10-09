/**
 * 分块策略注册表（P0-1-18）
 *
 * 依据：`docs/子方案/知识库流水线.md` §4-2（`ChunkStrategy` 接口 + `hybrid`/`fixed` 两实现）
 *      + §二（`split_strategy` 是**按库可配**的参数）
 *
 * 对外只暴露三个东西：策略表、按名解析、一次性入口。流水线（`stages.ts` 的 chunk 阶段）
 * 只用最后一个 —— 它不该知道有几种策略、更不该知道默认是哪一个（默认值的口径在
 * `shared` 的 `normalizeRetrievalConfig`，那才是唯一事实来源）。
 *
 * ⚠️ 本模块**刻意不 import `config`**（也不 import logger）：它全是纯函数，
 * 于是无依赖档的验收（`verify:app`，不启 PG/Redis/MinIO）能直接断言分块契约。
 * 分块是"给定字节 → 给定块"的确定性变换，让它的验收被基础设施绑住是没必要的代价。
 */

import { SPLIT_STRATEGIES, type SplitStrategy } from '@doubulea/shared'

import type { ParsedBlock, ParsedImage, ParseResult } from '../parse/types.js'
import { fixedStrategy } from './fixed.js'
import { hybridStrategy } from './hybrid.js'
import { blockSpans, type Chunk, type ChunkImage, type ChunkOptions, type ChunkStrategy } from './strategy.js'

export type { Chunk, ChunkImage, ChunkMeta, ChunkOptions, ChunkStrategy } from './strategy.js'
export { DEFAULT_CHUNK_MIN_CHARS, SENTENCE_BOUNDARY_CHARS, isSentenceBoundary } from './strategy.js'

/** 策略表（键与 `SPLIT_STRATEGIES` 逐字对应；新增策略时两处一起改） */
const STRATEGIES: Readonly<Record<SplitStrategy, ChunkStrategy>> = {
  hybrid: hybridStrategy,
  fixed: fixedStrategy,
}

/**
 * 按名取策略。**未知值一律退 `hybrid`**（`子方案①` §二 的默认值）。
 *
 * 为什么不抛错：`split_strategy` 与 `topK`/`rrfK` 一样住在 `retrieval_config` jsonb 里，
 * 补默认值的口径已经由 `shared` 的 `normalizeRetrievalConfig` 定死（**永不抛错**、
 * 未知值退回默认）—— 这里再抛一次等于在同一件事上给两个相反的口径。真要有脏数据，
 * 现象是"分块行为回落到默认"，而不是"文档处理失败"，后者代价大得多（用户看到的是
 * "文档坏了"，会去重传一个其实没问题的文件）。
 */
export function resolveChunkStrategy(name: string): ChunkStrategy {
  const strategy = STRATEGIES[name as SplitStrategy]
  return strategy ?? hybridStrategy
}

/** 已注册的策略名（给验收与将来的管理接口用；顺序即 `SPLIT_STRATEGIES`） */
export function chunkStrategyNames(): readonly SplitStrategy[] {
  return SPLIT_STRATEGIES
}

/**
 * 一次性入口：解析结果 → 块数组。
 *
 * 三个参数里 `strategy` 放最后且可选，是为了让调用方（以及验收脚本）能"只想按默认策略切一下"
 * 时不必先 `resolveChunkStrategy(...)` 一遍。
 */
export function splitIntoChunks(
  source: ParseResult,
  options: ChunkOptions,
  strategy: string = 'hybrid',
): Chunk[] {
  return resolveChunkStrategy(strategy).split(source, options)
}

/**
 * 把抽取出的图片转成**图片分块**（`MULTIMODAL` 模式；`OCR` 模式不用它 —— 图片已变成文字块）。
 *
 * 一张图一块（一图一向量）：多模态 embedding 端点一次请求只回一个融合向量，把多张图塞进同一块
 * 会让"这一段是讲哪张图的"不可分辨，引用时也没法定位。
 *
 * `content` 是**图注**（图片前一段文字，如"订单入口"），这既是嵌文本分片、也是块预览的标识 ——
 * 比只写 `[图片] <标题路径>` 更有信息量，也不会让同章节的多张图看起来一模一样。
 * `offset` 记下图片在正文里的位置，由 `chunkStage` 归并回文本块之间（**不再**全部堆到文末）。
 */
export function buildImageChunks(images: readonly ParsedImage[], blocks: readonly ParsedBlock[]): Chunk[] {
  const spans = blockSpans(blocks)
  // 同一锚点（= 同一段后面）可能挂多张图（如连续几张截图），图注会撞车 ⇒ 记数以备加序号
  const anchorCounts = new Map<string, number>()
  for (const image of images) {
    const key = String(image.anchor ?? 'null')
    anchorCounts.set(key, (anchorCounts.get(key) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const chunks: Chunk[] = []
  for (const image of images) {
    const anchor = image.anchor ?? null
    const key = String(anchor ?? 'null')
    const total = anchorCounts.get(key) ?? 1
    const ordinal = (seen.get(key) ?? 0) + 1
    seen.set(key, ordinal)
    const caption = imageCaption(anchor, blocks)
    const where = image.headingPath.length > 0 ? image.headingPath.join(' / ') : ''
    const label = caption !== '' ? caption : where
    const suffix = total > 1 ? ` （第${ordinal}张/共${total}张）` : ''
    const base = label === '' ? `[图片]${suffix}` : `[图片] ${label}${suffix}`
    // P1-11：VLM 描述（若 describe-images 阶段产出了）并进图片块 content —— 多模态块的文本路
    // 因此从"只有图注"变成"图注 + 含义"，检索/引用能读到图上讲了什么（图片仍用于视觉向量）。
    const content = image.description !== undefined && image.description !== '' ? `${base}\n${image.description}` : base
    const chunkImage: ChunkImage = { mime: image.mime, data: image.data }
    chunks.push({
      seq: 0, // 真实 seq 由 `chunkStage` 归并后统一分配
      content,
      meta: {
        headingPath: [...image.headingPath],
        page: image.page,
        ...(image.imageKind === undefined ? {} : { imageKind: image.imageKind }),
      },
      offset: imageOffset(anchor, spans, blocks),
      images: [chunkImage],
    })
  }
  return chunks
}

/** 图注：图片前一段文字（截断、压平空白）；取不到时返回空串 */
function imageCaption(anchor: number | null, blocks: readonly ParsedBlock[]): string {
  if (anchor === null || anchor <= 0) return ''
  const previous = blocks[anchor - 1]
  if (previous === undefined) return ''
  return [...previous.text.replace(/\s+/gu, ' ').trim()].slice(0, 60).join('')
}

/** 图片块在 `parsed.text` 里的归并位置 = 图注段的结束偏移（无图注则文首/文末） */
function imageOffset(
  anchor: number | null,
  spans: readonly { start: number; end: number }[],
  blocks: readonly ParsedBlock[],
): number {
  if (anchor === null || anchor >= blocks.length) return Number.POSITIVE_INFINITY
  if (anchor <= 0) return 0
  return spans[anchor - 1]?.end ?? Number.POSITIVE_INFINITY
}
