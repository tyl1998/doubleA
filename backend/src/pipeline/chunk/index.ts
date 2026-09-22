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

import type { ParseResult } from '../parse/types.js'
import { fixedStrategy } from './fixed.js'
import { hybridStrategy } from './hybrid.js'
import type { Chunk, ChunkOptions, ChunkStrategy } from './strategy.js'

export type { Chunk, ChunkMeta, ChunkOptions, ChunkStrategy } from './strategy.js'
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
