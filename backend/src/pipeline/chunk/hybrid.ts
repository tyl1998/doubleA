/**
 * `hybrid` 分块策略（默认；P0-1-18）
 *
 * 依据：`docs/子方案/知识库流水线.md` §4-2（`hybrid` —— 保结构、控长度）。四步：
 * ```
 * 1. 若文本含标题结构 → 先按标题切成 Section[]        （splitIntoSections）
 * 2. 每个 Section 内累积到 chunk_size → 回退到最近的句末边界（cutPoint）
 *    尾块 < chunk_min → 并入前块                        （segmentSection）
 * 3. 相邻块加 chunk_overlap 重叠                       （split 的前缀拼接）
 * 4. 每块记 meta：{ headingPath, page }                （metaOf ∘ locateBlock）
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────
 * ① Section 按"**连续**同名标题"切，不是按标题路径分组
 * ─────────────────────────────────────────────────────────────────────
 * 同一份文档里出现两个 `## 考勤`（中间隔着 `## 报销`）是常态。若按 `headingPath` 做 Map 分组，
 * 两段考勤会被合并到同一个 Section —— 结果是**chunk 的顺序与原文顺序不一致**
 * （第二段考勤的内容被排到报销前面）。而顺序错乱在检索层几乎无法发现：命中的片段读起来通顺，
 * 只是位置不对。故这里只比较"与上一段是否同名"，不同名就开新 Section。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ② 小文档特例：**全文** ≤ chunk_size 不切块（§4-2 的第三条）
 * ─────────────────────────────────────────────────────────────────────
 * 判在"全文"而不是"每个 Section"：一份 200 字、带 3 个标题的通知，若按 Section 判就会变成
 * 3 块（每块 60 余字），而文档要的是"整体切不动就整块留"（`docs/06` 的验收：传 200 字短通知
 * → **恰好 1 个 chunk**）。反过来，全文超过 chunk_size 时 Section 仍按"能装下就整块装"处理
 * —— 这正是 hybrid 与 fixed 的区别所在（保结构）。
 */

import type { ParseResult, ParsedBlock } from '../parse/types.js'
import {
  blockSpans,
  isSentenceBoundary,
  locateBlock,
  metaOf,
  tailByCodePoint,
  type Chunk,
  type ChunkOptions,
  type ChunkStrategy,
} from './strategy.js'

/** 标题相同的**连续**段落构成一个 Section（见文件头 ①） */
interface Section {
  /** 在 `parsed.text` 的**码点**坐标系里的起点（块 meta 的反查要用它，见 `strategy.ts` 不变式 ③） */
  start: number
  text: string
}

/** Section 内的一段候选块：`start` 是 **Section 内**偏移，`text` 是该段文本 */
interface Segment {
  start: number
  text: string
}

export const hybridStrategy: ChunkStrategy = {
  name: 'hybrid',

  split(source: ParseResult, options: ChunkOptions): Chunk[] {
    const chars = [...source.text]
    if (chars.length === 0) return []

    // 小文档特例（§4-2 第三条；见文件头 ②）
    if (chars.length <= options.chunkSize) {
      return [
        {
          seq: 0,
          content: source.text,
          meta: metaOf(locateBlock(blockSpans(source.blocks), 0)),
        },
      ]
    }

    const spans = blockSpans(source.blocks)
    const chunks: Chunk[] = []
    for (const section of splitIntoSections(source.blocks)) {
      const segments = segmentSection(section, options)
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]
        if (segment === undefined) continue
        // 重叠只发生在**同一个 Section 内**：跨 Section 的重叠会把两段不相干的内容缝在一起
        // （一个 Section 的结尾 + 另一个 Section 的开头），检索命中后读起来是语义断裂的。
        const prefix =
          index === 0 ? '' : tailByCodePoint(segments[index - 1]?.text ?? '', options.chunkOverlap)
        chunks.push({
          seq: chunks.length,
          content: prefix + segment.text,
          // ⚠️ 反查用的是 **Section 起点 + 段内偏移**（不含重叠前缀）：
          //    重叠前缀来自上一块，用它定位会把这一块的页码说成上一块所在的页。
          meta: metaOf(locateBlock(spans, section.start + segment.start)),
        })
      }
    }
    return chunks
  },
}

/** 按"连续同名标题"切成 Section（见文件头 ①），并算出各自在 `parsed.text` 里的起点 */
function splitIntoSections(blocks: readonly ParsedBlock[]): Section[] {
  const drafts: Array<{ key: string; start: number; parts: string[] }> = []
  let cursor = 0

  for (const block of blocks) {
    const key = JSON.stringify(block.headingPath)
    const last = drafts[drafts.length - 1]
    if (last === undefined || last.key !== key) {
      drafts.push({ key, start: cursor, parts: [] })
    }
    const target = drafts[drafts.length - 1]
    // `target` 一定存在（上面刚 push 过或本来就非空）
    if (target !== undefined) target.parts.push(block.text)
    cursor += [...block.text].length + 2
  }

  return drafts.map((draft) => ({ start: draft.start, text: draft.parts.join('\n\n') }))
}

/**
 * 把一个 Section 切成若干候选块（§4-2 第 2、3 步）。
 *
 * 循环条件写 `剩余 > chunkSize`（而不是 `>=`）：等于时"正好装满"，再切一刀只会得到一个
 * 空尾块。收尾那一块（剩余 ≤ chunkSize）无条件收下，再按 `chunkMin` 决定要不要并入前块。
 */
function segmentSection(section: Section, options: ChunkOptions): Segment[] {
  const chars = [...section.text]
  if (chars.length <= options.chunkSize) return [{ start: 0, text: section.text }]

  const segments: Segment[] = []
  let start = 0
  while (chars.length - start > options.chunkSize) {
    const cut = cutPoint(chars, start, options)
    segments.push({ start, text: chars.slice(start, cut).join('') })
    start = cut
  }
  segments.push({ start, text: chars.slice(start).join('') })

  // 尾块合并：`< chunk_min` 的碎块并进前块（§4-2 第 2 条后半）。
  // 代价说清楚：合并后前块会**越过 chunk_size**（最多 chunkSize + chunkMin + overlap）
  // —— 这是刻意的取舍，宁可贵一点也不要"最后挂着一个 3 个字的块"。
  const last = segments[segments.length - 1]
  const previous = segments.length >= 2 ? segments[segments.length - 2] : undefined
  if (last !== undefined && previous !== undefined && [...last.text].length < options.chunkMin) {
    segments.pop()
    previous.text += last.text
  }
  return segments
}

/**
 * 从 `start` 起该切在哪（返回切点，**不含**）。
 *
 * 先看"整块能装多少"（`limit`），再往前找最近的句末边界；找不到就硬切在 `limit`
 * （§4-2："回退到最近的句末边界"，隐含的意思就是"没有边界时只能硬切"）。
 *
 * `floor` 是搜索的下界（`chunk_min`）：若最近的边界在 `chunk_min` 之前，说明这一大段
 * 几乎没有句读（长表格转文本、无标点的 OCR 残留），此时"回退"会切出一个几十字的碎块 ——
 * 不如按长度硬切。复用 `chunk_min` 而不是另发明一个阈值，是因为它本来就是"碎块"的判据。
 */
function cutPoint(chars: readonly string[], start: number, options: ChunkOptions): number {
  const limit = Math.min(start + options.chunkSize, chars.length)
  const floor = Math.max(start, Math.min(start + options.chunkMin, limit - 1))
  for (let index = limit - 1; index >= floor; index -= 1) {
    const char = chars[index]
    if (char !== undefined && isSentenceBoundary(char)) return index + 1
  }
  return limit
}
