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
 *
 * ─────────────────────────────────────────────────────────────────────
 * ③ 只含标题、没有正文的 Section **向前并入下一节**（不单独成块）
 * ─────────────────────────────────────────────────────────────────────
 * 父标题下面直接挂子标题（或标题与正文之间空一行）时，解析出的 blocks 里会有一个"只有标题
 * 文本、没有任何正文段"的 Section。它若单独成块，就得到一个几字长的碎片块 —— 而它与正文在
 * 字面上最接近查询词（`实体星礼包单独售卖` 这种），**向量与全文两路都会把它排在前面**，
 * 于是 `topK` 被标题占满、真正有内容的块全部落选（实测：25 块里 9 块是纯标题，问「有哪些内容」
 * 时 topK=5 全是标题，模型只看到标题 ⇒ 答不出内容却仍发出引用卡）。
 * 处置：把这种 Section 的标题文本**前插**到下一节，让"父标题"和它的内容待在同一个块里。
 * `headingPath` 本就带父标题（`types.ts` 的 `headingPath` 说明），所以这只影响块文本、不影响 meta。
 *
 * ─────────────────────────────────────────────────────────────────────
 * ④ 表格块（`kind='table'`）是**原子单元**
 * ─────────────────────────────────────────────────────────────────────
 * 表格的语义全在行列对应关系里，切在行中间等于把它毁掉。故本策略在每个 Section 内先把
 * 连续的普通块合成"文本单元"、每个表块各自成"表单元"：文本单元照旧按句末回退切、相邻片可
 * 重叠；表单元整块保留，超过 `chunk_size` 时按行切并**重复表头**（`parse/table.ts` 的
 * `splitTableText`），且**不与相邻文本块重叠** —— 避免把无关文字缝进表格。
 */

import type { ParseResult, ParsedBlock, ParsedBlockKind } from '../parse/types.js'
import { splitTableText } from '../parse/table.js'
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

/** Section 内的一个块：`start` 是**全局码点**偏移（`parsed.text` 坐标系） */
interface SectionBlock {
  start: number
  text: string
  kind: ParsedBlockKind
}

/** 标题相同的**连续**段落构成一个 Section（见文件头 ①） */
interface Section {
  /** 首块在 `parsed.text` 的**码点**坐标系里的起点（块 meta 的反查要用它，见 `strategy.ts` 不变式 ③） */
  start: number
  text: string
  /** 是否含**正文段**（不只是标题）—— 只含标题的 Section 会被前插合并（见文件头 ③） */
  hasBody: boolean
  /** 本节按顺序的块（含表块）；分段时据它把表当原子单元（见文件头 ④） */
  blocks: SectionBlock[]
}

/** 一段候选块：`start` 是**全局码点**偏移（`parsed.text` 坐标系） */
interface Segment {
  start: number
  text: string
  kind: ParsedBlockKind
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
          offset: 0,
        },
      ]
    }

    const spans = blockSpans(source.blocks)
    const chunks: Chunk[] = []
    for (const section of mergeHeadingOnlySections(splitIntoSections(source.blocks))) {
      const segments = segmentSection(section, options)
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]
        if (segment === undefined) continue
        const previous = segments[index - 1]
        // 重叠只发生在**相邻的两个文本片**之间：表格片不与任何东西重叠（避免把无关文字缝进表格），
        // 也不跨 Section（跨 Section 的重叠会把两段不相干内容缝在一起，命中后语义断裂）。
        const prefix =
          previous === undefined || previous.kind === 'table' || segment.kind === 'table'
            ? ''
            : tailByCodePoint(previous.text, options.chunkOverlap)
        // 块起点偏移（不含重叠前缀）：既是 meta 反查的依据，也用于把图片块插回原位
        chunks.push({
          seq: chunks.length,
          content: prefix + segment.text,
          // ⚠️ 反查用的是**段起点**（不含重叠前缀）：重叠前缀来自上一块，
          //    用它定位会把这一块的页码说成上一块所在的页。
          meta: metaOf(locateBlock(spans, segment.start)),
          offset: segment.start,
        })
      }
    }
    return chunks
  },
}

/** 按"连续同名标题"切成 Section（见文件头 ①），并算出各自在 `parsed.text` 里的起点 */
function splitIntoSections(blocks: readonly ParsedBlock[]): Section[] {
  const drafts: Array<{
    key: string
    start: number
    parts: string[]
    hasBody: boolean
    blocks: SectionBlock[]
  }> = []
  let cursor = 0

  for (const block of blocks) {
    const key = JSON.stringify(block.headingPath)
    let target = drafts[drafts.length - 1]
    if (target === undefined || target.key !== key) {
      target = { key, start: cursor, parts: [], hasBody: false, blocks: [] }
      drafts.push(target)
    }
    target.parts.push(block.text)
    target.blocks.push({ start: cursor, text: block.text, kind: block.kind ?? 'text' })
    if (!isHeadingBlock(block)) target.hasBody = true
    cursor += [...block.text].length + 2
  }

  return drafts.map((draft) => ({
    start: draft.start,
    text: draft.parts.join('\n\n'),
    hasBody: draft.hasBody,
    blocks: draft.blocks,
  }))
}

/**
 * 这一段是不是**标题段**。
 *
 * 判据来自解析层的构造口径（`parse/types.ts` 的 `headingPath` 说明）：**标题段自己也在
 * 自己的路径里**（`# 报销制度` 这一段的 `headingPath` 末位就是 `报销制度`，且 `text` 就是它）。
 * 于是"标题段" ⟺ 有标题路径且文本恰为该路径的最内层。正文段即便挂在标题下，文本也不等于标题。
 *
 * ⚠️ 唯一的假阳性是"正文段恰好逐字等于它所属的标题"（如标题「概述」下第一句也是「概述」）——
 * 概率极低，且最坏后果只是把这个短段并入下一节（内容不丢，只是挪了位置）。
 */
function isHeadingBlock(block: ParsedBlock): boolean {
  return block.headingPath.length > 0 && block.text === block.headingPath[block.headingPath.length - 1]
}

/**
 * 把"只含标题、没有正文"的 Section **前插**合并到下一节（见文件头 ③）。
 *
 * 连续多个纯标题 Section（父标题 → 子标题 → …）会**累积**后一起并进后面第一个有正文的节，
 * 于是"父标题链 + 正文"落在同一个块里。合并后以**最靠前那个标题的起点**为 `start`
 * （文本里标题确实在那个位置，`locateBlock` 才能反查到正确的块）。
 *
 * 收尾的纯标题（文档以标题结束）没有"下一节"可并 ⇒ 追加到前一个已合并的节；
 * 整篇都是标题（没有任何正文）时保持原样，交给上游的低质内容判断，不在这里吞掉。
 */
function mergeHeadingOnlySections(sections: readonly Section[]): Section[] {
  const merged: Section[] = []
  /** 待前插的纯标题文本（'' = 没有）与它们的块 */
  let carryText = ''
  let carryStart = 0
  let carryBlocks: SectionBlock[] = []

  const mergedText = (text: string): string => (carryText === '' ? text : `${carryText}\n\n${text}`)
  const mergedStart = (start: number): number => (carryText === '' ? start : Math.min(carryStart, start))
  const mergedBlocks = (blocks: SectionBlock[]): SectionBlock[] => [...carryBlocks, ...blocks]

  for (const section of sections) {
    if (!section.hasBody) {
      if (carryText === '') carryStart = section.start
      carryText = mergedText(section.text)
      carryBlocks = [...carryBlocks, ...section.blocks]
      continue
    }
    merged.push({
      start: mergedStart(section.start),
      text: mergedText(section.text),
      hasBody: true,
      blocks: mergedBlocks(section.blocks),
    })
    carryText = ''
    carryBlocks = []
  }

  if (carryText !== '') {
    const last = merged[merged.length - 1]
    if (last === undefined) {
      // 整篇只有标题：不合并掉（保留原样，交给上游按它本来的样子处理）
      return sections.map((section) => ({ ...section }))
    }
    last.text = `${last.text}\n\n${carryText}`
    last.blocks = [...last.blocks, ...carryBlocks]
  }
  return merged
}

/**
 * 把一个 Section 切成若干候选块（§4-2 第 2、3 步）。
 *
 * 先按"原子单元"分解（见文件头 ④）：连续的普通块 → 文本单元（按字符切、可重叠）；
 * 每个表块 → 表单元（整块保留，超长按行切并重复表头）。
 */
function segmentSection(section: Section, options: ChunkOptions): Segment[] {
  const segments: Segment[] = []
  for (const unit of sectionUnits(section)) {
    if (unit.kind === 'table') {
      for (const piece of splitTableText(unit.text, options.chunkSize)) {
        segments.push({ start: unit.start, text: piece, kind: 'table' })
      }
      continue
    }
    segments.push(...segmentText(unit, options))
  }
  return segments
}

/** Section 内的原子单元：连续普通块合成文本单元；每个表块各自成表单元 */
interface Unit {
  kind: ParsedBlockKind
  start: number
  text: string
}

function sectionUnits(section: Section): Unit[] {
  const units: Unit[] = []
  let parts: string[] = []
  let unitStart = section.start
  const flush = (): void => {
    if (parts.length > 0) {
      units.push({ kind: 'text', start: unitStart, text: parts.join('\n\n') })
      parts = []
    }
  }
  for (const block of section.blocks) {
    if (block.kind === 'table') {
      flush()
      units.push({ kind: 'table', start: block.start, text: block.text })
    } else {
      if (parts.length === 0) unitStart = block.start
      parts.push(block.text)
    }
  }
  flush()
  return units
}

/**
 * 文本单元按字符切（§4-2 第 2、3 步）。
 *
 * 循环条件写 `剩余 > chunkSize`（而不是 `>=`）：等于时"正好装满"，再切一刀只会得到一个
 * 空尾块。收尾那一块（剩余 ≤ chunkSize）无条件收下，再按 `chunkMin` 决定要不要并入前块。
 */
function segmentText(unit: Unit, options: ChunkOptions): Segment[] {
  const chars = [...unit.text]
  if (chars.length === 0) return []
  if (chars.length <= options.chunkSize) return [{ start: unit.start, text: unit.text, kind: 'text' }]

  const segments: Segment[] = []
  let start = 0
  while (chars.length - start > options.chunkSize) {
    const cut = cutPoint(chars, start, options)
    segments.push({ start: unit.start + start, text: chars.slice(start, cut).join(''), kind: 'text' })
    start = cut
  }
  segments.push({ start: unit.start + start, text: chars.slice(start).join(''), kind: 'text' })

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
