/**
 * `fixed` 分块策略（P0-1-18）
 *
 * 依据：`docs/子方案/知识库流水线.md` §4-2 末段："纯定长滑窗，用于结构混乱的文本
 * （如 OCR 残留、长表格转文本）：直接按 512 字符切，64 重叠，**不做边界回退**"。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么它必须"笨"
 * ─────────────────────────────────────────────────────────────────────
 * 这一档的存在意义就是**不依赖任何结构假设**：OCR 残留里没有可信的标题、句号常被识别成
 * `,` 或 `口`，长表格转文本后一行就是一条记录（在行中间切开反而更连贯）。若给它加"回退到
 * 句末"的聪明逻辑，遇到上述文本会退化成"整篇只切一刀"（找不到句末边界 ⇒ 一直硬切）
 * 或"每块只有几十字"。故这里**只有** `chunk_size` 与 `chunk_overlap` 两个参数，
 * 连 `chunk_min` 的尾块合并都不做（§4-2 只把它写进 hybrid 的第 2 步）。
 *
 * ⚠️ 代价：最后一块常常很短（`长度 % (chunkSize - overlap)` 的余数）。这是本档的固有形态，
 * 不是 bug —— 想避免请用 `hybrid`（它是默认值，`子方案①` §二 的 `split_strategy=hybrid`）。
 */

import type { ParseResult } from '../parse/types.js'
import {
  blockSpans,
  locateBlock,
  metaOf,
  type Chunk,
  type ChunkOptions,
  type ChunkStrategy,
} from './strategy.js'

export const fixedStrategy: ChunkStrategy = {
  name: 'fixed',

  split(source: ParseResult, options: ChunkOptions): Chunk[] {
    const chars = [...source.text]
    if (chars.length === 0) return []

    const size = Math.max(1, options.chunkSize)
    // 步长 = 块长 - 重叠 ⇒ 相邻两块正好重叠 `chunkOverlap` 个字符。
    // ⚠️ `overlap >= size` 会让步长 ≤ 0 ⇒ **死循环**（内存涨到 OOM 才报错，很难联想）。
    //    KB 侧有跨字段校验（`CHUNK_OVERLAP_DEFAULT < CHUNK_SIZE_DEFAULT`、契约也有），
    //    但本函数是纯函数、可能被直接调用（验收就在直接调），故这里再兜一道。
    const step = Math.max(1, size - Math.max(0, options.chunkOverlap))
    const spans = blockSpans(source.blocks)

    const chunks: Chunk[] = []
    for (let start = 0; start < chars.length; start += step) {
      chunks.push({
        seq: chunks.length,
        content: chars.slice(start, start + size).join(''),
        meta: metaOf(locateBlock(spans, start)),
      })
      // 已经取到结尾（或越过）就停：否则会再产出一个纯重叠的尾块
      if (start + size >= chars.length) break
    }
    return chunks
  },
}
