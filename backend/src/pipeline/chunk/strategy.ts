/**
 * 分块策略契约（P0-1-18）
 *
 * 依据：`docs/子方案/知识库流水线.md` §4-2（分块 · 策略可插拔 · B8 配套）+ §二（参数总表）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么是"可插拔策略"而不是一个函数
 * ─────────────────────────────────────────────────────────────────────
 * §二 的 `split_strategy` 是**按库可配**的（`hybrid` | `fixed`），而两种切法面对的文本
 * 完全不同：`hybrid` 要标题与段落（保结构），`fixed` 只认字符（结构混乱的 OCR 残留、
 * 长表格转文本，§4-2 末段）。硬塞进一个函数的结果是"到处 `if (strategy === 'fixed')`"，
 * 而新增第三种策略时每个分支都要再改一遍。
 * 接口只有两个方法（`name()` / `split()`），够用且不预设策略怎么实现。
 *
 * ⚠️ 与 §4-2 的**一处刻意偏离**：文档写的签名是 `split(text, meta, opt)`，本仓传的是整个
 * {@link ParseResult}（`{blocks, text, meta}`）。理由：`hybrid` 的标题层级只在 `blocks` 里，
 * 而 `text` 是 `blocks` 的派生（`parse/types.ts` 文件头）—— 只给 `text` 会让 hybrid 退化成
 * fixed（拿不到标题、也拿不到页码）。少传一个参数换来"策略能被正确实现"，这个方向不会错。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条贯穿本模块的不变式（验收逐条断言，见 `verify-app.mjs` / `verify-pipeline.mjs`）
 * ─────────────────────────────────────────────────────────────────────
 * ① **单位是字符（码点），不是 token、也不是 UTF-16 长度**（§二 B8 定案）。
 *    故本模块把所有切片都建在 `[...text]` 的码点数组上 —— emoji 不会被从中劈开
 *    （`text.length` 会把它算成 2，`slice()` 于是可能只取到半个代理对，
 *     产出非法字符串且**没有任何报错**）。这是唯一一处"用了慢写法"的地方，刻意。
 * ② **每一块都是 `parsed.text` 的逐字子串**。整条链上只做"取连续区间"，从不拼接
 *    新内容（重叠也是取前一块的尾部，不是新造的句子）⇒ P0-1-20 的"引用片段与原文逐字一致"
 *    在本层就已成立，不必等检索层去补救。
 * ③ **块的 `headingPath` / `page` 取自"该块起点落在哪个段"**，不是"该块属于哪个 Section"：
 *    一个 Section 可能跨页（PDF），此时"整块都用 Section 首页"会把页码全部说成第 1 页。
 */

import type { SplitStrategy } from '@doubulea/shared'

import type { ParseResult, ParsedBlock } from '../parse/types.js'

/** 块内结构元数据 —— 落 `chunks.meta`（§4-2 第 4 条、§4-4）。`seq` 不在这里：它是独立列。 */
export interface ChunkMeta {
  /** 该块起点所属的标题路径（`parse/types.ts` 的口径：从最外层到最内层） */
  headingPath: string[]
  /** 页码（1 起）；非分页格式为 `null` */
  page: number | null
}

/** 随块一起向量化的一张图片（`MULTIMODAL` 模式；由 embedding 层转成 content part） */
export interface ChunkImage {
  mime: string
  data: Buffer
}

/** 一个待入库的块（P0-1-19 把它写进 `chunks`：`content` → 文本、`meta` → jsonb、`seq` → 列） */
export interface Chunk {
  /** 文档内序号（0 起；`schema.prisma` 的 `Chunk.seq`） */
  seq: number
  content: string
  meta: ChunkMeta
  /**
   * 块起点在 `parsed.text` 里的**码点偏移**（内部字段，**不落库**）。
   *
   * 存在的唯一理由：`MULTIMODAL` 模式下图片块要按原位置插回文本块之间（否则图片块全排在文末，
   * 与它所属的章节脱节）。有了它，`chunkStage` 就能按偏移把"文本块 + 图片块"归并成一个有序序列。
   */
  offset?: number
  /**
   * 与文本一起向量化的图片（`MULTIMODAL` 图片模式）。纯文本块不带该字段。
   * ⚠️ 不落库（图片不持久化，重建时从原文件重抽）；只在本轮 embedding 里用。
   */
  images?: ChunkImage[]
}

/** 分块参数（KB 级，建库时快照自环境默认值 —— §十一） */
export interface ChunkOptions {
  /** `chunk_size`：目标块长（字符） */
  chunkSize: number
  /** `chunk_overlap`：相邻块重叠（字符） */
  chunkOverlap: number
  /** `chunk_min`：低于它的尾块并入前块（字符） */
  chunkMin: number
}

export interface ChunkStrategy {
  name: SplitStrategy
  split: (source: ParseResult, options: ChunkOptions) => Chunk[]
}

/**
 * §二 的 `chunk_min`（默认 50）。
 *
 * ⚠️ 为什么是**代码常量**而不是环境变量或 KB 列：`子方案①` §十一 的"本方案新增"配置表里
 * **没有** `CHUNK_MIN_DEFAULT`，`knowledge_bases` 也没有对应列 —— 即文档刻意只让它以
 * "参数总表里的一个数"存在。凭空加一个环境变量属于自己发明契约（本项目明令禁止），
 * 故这里落成有名字的常量并导出，让验收能直接断言它。
 * 要让它可配，先改 §二/§十一（加变量）与 `schema.prisma`（加列），再回来改这里。
 */
export const DEFAULT_CHUNK_MIN_CHARS = 50

/**
 * 句末边界（§4-2 第 2 条点名 `。！？.!?`）。
 *
 * 比文档多一个 `\n`：段落末尾本身就是最自然的切点，而 `blocks` 之间就是以 `\n\n` 连接的
 * （`parse/types.ts` 的 `buildParseResult`）—— 少了它，"一段正好超长"的文档会在
 * 段落中间切开（`。` 在 480、下一个 `。` 在 1200 时，只能退化成硬切）。
 * ASCII 的 `.` 会命中 `1.0` 这类数字，切在那里无害（块是给检索用的，不是给人读的排版）。
 */
export const SENTENCE_BOUNDARY_CHARS: readonly string[] = ['。', '！', '？', '!', '?', '.', '\n']

/** 是否句末边界（`hybrid` 的"回退到最近的句末"用它） */
export function isSentenceBoundary(char: string): boolean {
  return SENTENCE_BOUNDARY_CHARS.includes(char)
}

/** 按**码点**取尾部 `count` 个字符（`count <= 0` 或不足时返回全串）—— 重叠段用它 */
export function tailByCodePoint(text: string, count: number): string {
  if (count <= 0) return ''
  const chars = [...text]
  if (chars.length <= count) return text
  return chars.slice(chars.length - count).join('')
}

/**
 * 段在 `parsed.text` 里的**码点**区间，外加它自己的结构元数据。
 * 之所以要它：块的 meta（标题路径 / 页码）必须由"块的起点落在哪一段"反查出来
 * （不变式 ③），而 `blocks` 本身不带偏移。
 */
export interface BlockSpan {
  /** 起始偏移（码点，0 起） */
  start: number
  /** 结束偏移（不含；= 该段正文的末尾，**不含**段间分隔符） */
  end: number
  headingPath: string[]
  page: number | null
}

/**
 * 算出每个段在 `parsed.text` 里的偏移。
 *
 * ⚠️ 分隔符（`\n\n`）算在**前一段**的地盘上（即 `locateBlock` 对落在分隔符里的偏移
 * 返回前一段）：留在后一段就变成"下一块从空行开始"，而空行属于上一段更符合直觉，
 * 也让"段末的 「。」"这类断言不会被分隔符干扰。
 */
export function blockSpans(blocks: readonly ParsedBlock[]): BlockSpan[] {
  const spans: BlockSpan[] = []
  let cursor = 0
  for (const block of blocks) {
    const length = [...block.text].length
    spans.push({ start: cursor, end: cursor + length, headingPath: block.headingPath, page: block.page })
    // 段间距（`buildParseResult` 的 `join('\n\n')`）：2 个码点
    cursor += length + 2
  }
  return spans
}

/**
 * 反查"偏移 `offset` 落在哪一段"（返回最后一段其 `start <= offset`）。
 * 越界（`offset` 超出全串）时返回最后一段 —— 宁可给个近似的 meta 也不要 `undefined`
 * （块永远有 meta 是 `chunks.meta` 那一列的默认值承诺）。
 */
export function locateBlock(spans: readonly BlockSpan[], offset: number): BlockSpan | undefined {
  let found: BlockSpan | undefined
  for (const span of spans) {
    if (span.start > offset) break
    found = span
  }
  return found ?? spans[0]
}

/** 由一段的元数据造块内 meta（统一口径：`headingPath` 拷贝一份，避免下游改到源数据） */
export function metaOf(span: BlockSpan | undefined): ChunkMeta {
  return { headingPath: span === undefined ? [] : [...span.headingPath], page: span?.page ?? null }
}
