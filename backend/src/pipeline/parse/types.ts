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

/**
 * 支持的格式（= `UPLOAD_EXTENSIONS`，但本层不依赖 upload 侧的写法，保持独立）。
 *
 * ⚠️ **`html` 不是上传白名单里的扩展名**：它只由 `detectFormat` 对**扩展名为 `.doc`、
 * 内容实为 HTML / MIME（MHTML）导出件**的按内容嗅探产出（P1-12）。也就是说 `.doc`
 * 仍是唯一入口，`html` 是"这份 `.doc` 到底是什么"的解析结论，不是新增的可上传格式。
 */
export const PARSE_FORMATS = [
  'pdf',
  'docx',
  'md',
  'txt',
  'html',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
] as const
export type ParseFormat = (typeof PARSE_FORMATS)[number]

/** 解析选项（由流水线按文档的图片开关传下来；默认不抽图，见 {@link DEFAULT_PARSE_OPTIONS}） */
export interface ParseOptions {
  /** 是否抽取文档内图片（文档三个图片开关任一为真时为 true） */
  extractImages: boolean
  /** 单张图片上限（字节）；超过则跳过该图并告警，不因一张大图拖垮整篇 */
  maxImageBytes: number
}

/** 默认解析选项：不抽图（与历史行为一致） */
export const DEFAULT_PARSE_OPTIONS: ParseOptions = Object.freeze({
  extractImages: false,
  maxImageBytes: 10 * 1024 * 1024,
})

/**
 * 抽取出的图片（文档内嵌图 / 扫描页 / 独立图片文件 / MD 外链图统一此形状）。
 *
 * ⚠️ `data` 是**内存里的原始字节**（不落 S3）—— 图片只在一次流水线内经手：
 * `MULTIMODAL` 时转 base64 直接向量化，`OCR` 时先转文字后再不需要原图。
 * 重建时重新从原文件抽取即可，故**不持久化图片**（省一份存储与一套生命周期）。
 */
export interface ParsedImage {
  data: Buffer
  /** 图片 MIME（用于 base64 data URL 前缀；也用于 OCR 输入） */
  mime: string
  /** 所属页码（PDF 才有；其余为 `null`） */
  page: number | null
  /** 所属标题路径（docx/md 能定位到；PDF 为 `[]`） */
  headingPath: string[]
  /**
   * 在 `blocks` 中的**插入位置**：插在 `blocks[anchor]` **之前**（= 图片前已产出的块数）。
   *
   * ⚠️ 这是"图注文字不能跑到文末"的关键：图片天然嵌在正文中间，若不记位置，
   * OCR 文本只能追加到 `blocks` 末尾 —— 于是"订单入口"那张图的文字跑到全文最后，
   * 与它所属的章节彻底脱节（实测 chunk 偏差很大）。
   * `null`/缺省 = 位置未知，调用方按"追加到末尾"处理。
   */
  anchor?: number | null
  /**
   * VLM 描述（P1-11，轨道二）—— 由 `describe-images` 阶段写入，`null`/缺省 = 未产出。
   *
   * ⚠️ 这是**能力增量**、不是解析层的产物：解析器**一律不写它**。OCR 模式下它会被
   * `ocrImagesStage` 追加进对应的 OCR 文本块；`MULTIMODAL` 模式下由 `buildImageChunks`
   * 并进图片块的 `content`（图注 + 描述）。
   */
  description?: string
  /**
   * 图片类型（`flowchart` / `chart` / `diagram` / `photo` / `text` / `unknown`）——
   * 由 VLM 判定，落 `chunks.meta.imageKind`（便于检索过滤 / 前端区分渲染）。
   */
  imageKind?: string
  /**
   * 低清防护：短边过小、**未做识别**的图片标记为 `true`。
   *   · VLM 侧（`IMAGE_CAPTION_MIN_PX`，P1-11）：不产出图结构描述（避免幻觉）；
   *   · OCR 侧（`IMAGE_OCR_MIN_PX`）：不跑本地 OCR（低清只会是噪声）。
   * 它只影响"要不要识别"，**不影响图注、也不影响图片向量化**（向量化与识别正交）。
   */
  unreliable?: boolean
}

/**
 * 段落级结构块的种类。
 *
 * · `text`（缺省）：普通段落/标题/列表项。
 * · `table`：一张表格的**结构化序列化**（Markdown 管道表）。分块层据此把它当**原子单元**处理
 *   —— 不参与句末回退、不从行中间切开（见 `chunk/strategy.ts` 的 `atomicUnits`）。
 */
export type ParsedBlockKind = 'text' | 'table'

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
  /**
   * 块种类（可省，缺省视为 `text`）。表格块由 docx/md 解析器产出，`text` 是它序列化后的
   * Markdown 管道表；分块层读它做原子切分。
   */
  kind?: ParsedBlockKind
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
  /** 抽取出的图片（不抽图时为空数组；`子方案` 文档图片解析） */
  images: ParsedImage[]
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
 * 标题路径清洗：剔除非字符串与空串。
 *
 * ⚠️ 必须有它：docx/md 用"层级栈"维护标题路径，遇到**等级跳变**（第一个标题就是 2 级、
 * 或 `#` 后直接 `###`）时低层槽位是**空洞**，`[...stack]` 会带出 `undefined`。
 * 而 `chunks.meta` 是 jsonb，Prisma 写入时对数组里的 `undefined` 会直接抛
 * `Can not use undefined value within array`（实测），整篇文档 FAILED。
 * 所以标题路径在**出解析层之前**就保证"只含非空字符串"。
 */
export function normalizeHeadingPath(path: readonly unknown[]): string[] {
  return path.filter((item): item is string => typeof item === 'string' && item !== '')
}

/**
 * 由 `blocks` 收口出 `text` / `meta` 的公共逻辑（四个解析器都走它，保证形状一致）。
 */
export function buildParseResult(
  format: ParseFormat,
  blocks: ParsedBlock[],
  extra: { pageCount?: number | null; encoding?: string; images?: ParsedImage[] } = {},
): ParseResult {
  // 收口处再清洗一道标题路径：任何解析器（含将来新增的）漏了空洞都在这里被兜住
  const cleanBlocks = blocks.map((block) => ({
    ...block,
    headingPath: normalizeHeadingPath(block.headingPath),
  }))
  const text = cleanBlocks.map((block) => block.text).join('\n\n')
  return {
    blocks: cleanBlocks,
    images: extra.images ?? [],
    text,
    meta: {
      format,
      pageCount: extra.pageCount ?? null,
      charCount: countChars(text),
      hasHeadings: cleanBlocks.some((block) => block.headingPath.length > 0),
      encoding: extra.encoding ?? 'utf-8',
    },
  }
}
