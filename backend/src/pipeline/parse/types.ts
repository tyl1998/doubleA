/**
 * 解析层类型（P0-1-16；`子方案/知识库流水线.md` §4-1 + §五）
 *
 * 四个解析器（pdf/docx/md/txt）对外**只有一种输出形状**，流水线的下游
 * （P0-1-18 空文本检测与分块、P0-1-19 入库）只认这一种 —— 这是"四格式"不泄漏到下游的唯一办法。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么要 `blocks` 而不是只给一段 `text`
 * ─────────────────────────────────────────────────────────────────────
 * `子方案①` §4-2 的 hybrid 分块要"先按标题切成 Section[]，再在 Section 内按段落累积"，
 * 而 §4-3 落库时 `meta` 要带**标题层级与页码**。这两件事都要求"段落"这个粒度，
 * 且要求每段都记得自己属于哪个标题、哪一页。
 * 所以本层把"结构"一次解析到位：`blocks` 是**段落级**的，每段自带 `headingPath` / `page`。
 * 下游若只想按页/按标题聚合，从 `blocks` 现算即可（信息只会丢，不会凭空长出来）。
 *
 * `text` 是 `blocks` 以空行连接的**保序拼接**（不是另算的一份真相）：
 * 它的用途只有两个 —— 字符计数（§五 的空文本检测）与人工排查（把解析结果打出来看）。
 */

/** 支持的格式（= `UPLOAD_EXTENSIONS`，但本层不依赖 upload 侧的写法，保持独立） */
export const PARSE_FORMATS = ['pdf', 'docx', 'md', 'txt'] as const
export type ParseFormat = (typeof PARSE_FORMATS)[number]

/** 段落级结构块 */
export interface ParsedBlock {
  /** 段落正文（已 trim 首尾空白，不含尾部换行） */
  text: string
  /**
   * 该段所属的标题路径，从最外层到最内层（如 `['员工手册', '报销制度']`）。
   * 无标题结构的格式（txt、无标题的 md/docx/pdf）恒为 `[]`。
   * 标题段**自己也在路径里**（`# 报销制度` 这一段的路径就是 `['报销制度']`）——
   * 这样"这一段属于哪个标题"与"这个标题是什么"在同一个字段里，下游不必再判断段类型。
   */
  headingPath: string[]
  /** 页码（1 起）；非分页格式（md/docx/txt）恒为 `null` */
  page: number | null
}

/** 解析元数据（`子方案①` §五 的空文本检测读这里，不重新数一遍字符） */
export interface ParseMeta {
  format: ParseFormat
  /** 页数（pdf）；非分页格式为 `null` */
  pageCount: number | null
  /**
   * 正文字符数（**去空白后**计数，「§五 空文本检测」的口径）。
   * ⚠️ 用 `[...text]` 而不是 `text.length`：中文一字一长度，但 emoji 是代理对
   * （`text.length` 会算成 2），与"用户眼里的字符数"不符。
   */
  charCount: number
  /** 是否解析出标题结构（`blocks` 里存在非空 `headingPath`） */
  hasHeadings: boolean
  /** 文本编码（仅 txt 的嗅探结果有意义；其余格式恒为 `utf-8`） */
  encoding: string
}

export interface ParseResult {
  blocks: ParsedBlock[]
  /** `blocks` 以空行连接（见文件头说明） */
  text: string
  meta: ParseMeta
}

/**
 * 正文字符数（去空白；`子方案①` §五 的口径）。
 * 放在这里而不是各解析器各写一遍 —— 空文本检测若与 `meta.charCount` 算法不一致，
 * 会出现"提示 0 字符却又不判空"这类自相矛盾。
 */
export function countChars(text: string): number {
  return [...text.replace(/\s+/gu, '')].length
}

/**
 * 由 `blocks` 收口出 `text` / `meta` 的公共逻辑（四个解析器都走它，保证形状一致）。
 */
export function buildParseResult(
  format: ParseFormat,
  blocks: ParsedBlock[],
  extra: { pageCount?: number | null; encoding?: string } = {},
): ParseResult {
  const text = blocks.map((block) => block.text).join('\n\n')
  return {
    blocks,
    text,
    meta: {
      format,
      pageCount: extra.pageCount ?? null,
      charCount: countChars(text),
      hasHeadings: blocks.some((block) => block.headingPath.length > 0),
      encoding: extra.encoding ?? 'utf-8',
    },
  }
}
