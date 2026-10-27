/**
 * DOCX 解析（P0-1-16；`子方案/知识库流水线.md` §4-1：mammoth，纯文本 + 标题层级）
 *
 * `mammoth` 的定位是"把 Word 的**语义**（标题/列表/强调）转出来，而不是还原排版"，
 * 这与本层的需要完全一致（我们要标题层级，不要字号字体）。它只吃 `.docx`（OOXML），
 * `.doc`（OLE2 二进制）由上传前置校验拦掉 —— 本函数**不做** .doc 的兜底，
 * 因为 mammoth 对 .doc 只会抛一句与"另存为 .docx"无关的错，对用户毫无帮助。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么走 `convertToHtml` 而不是 `extractRawText`
 * ─────────────────────────────────────────────────────────────────────
 * `extractRawText` 丢掉全部结构（标题退化成普通段落），而 `子方案①` §4-2 的 hybrid
 * 分块**要按标题切 Section**、§4-3 的 `meta` 要记标题路径 —— 丢了标题，这两个下游直接失效。
 * mammoth 的 HTML 里标题是 `<h1>`..`<h6>`、段落是 `<p>`、列表项是 `<li>`，行级结构清晰，
 * 用一个"取叶子块"的正则扫一遍就够（**不引 HTML 解析器**：mammoth 的输出由它自己生成，
 * 形状可控；引一个 DOM 实现只为扫三种标签不划算）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 表格：识别 `<table>` 并收成**一个结构化块**（不再是"每格一段"）
 * ─────────────────────────────────────────────────────────────────────
 * mammoth 把单元格内容包在 `<p>` 里，若照旧用"只认 h/p/li"的叶子扫描，表格会退化成
 * "按行顺序排列的若干段"、行列对应关系全丢。故本层改用**一个带表格分支的合并正则**：
 * 先在整个 HTML 上按文档顺序匹配，`<table>` 分支吞掉整张表（内部的 `<p>` 因此不会再被单独命中），
 * 其余分支照旧收叶子块。
 *
 * 表内解析成二维网格（`<tr>` × `<td>/<th>`），并处理 mammoth 会输出的 `colspan`/`rowspan`
 * （见 `document-to-html.js` 的 `convertTableCell`）：跨行单元格会**按行补回**到后续行，
 * 跨列单元格占位后其右侧列置空 —— 于是列不会错位。网格再由 `renderTableMarkdown` 序列化成
 * Markdown 管道表，作为 `kind='table'` 的块交给下游（分块层把它当原子单元）。
 *
 * ⚠️ 已知边界：**嵌套表格**（表内还有表）会把外层表的匹配提前收在第一个 `</table>` 处 ——
 * 嵌套表在 Word 里很少见，且退化后果只是"内层多出一个文本块"，不影响外层数据。
 */

import { appMsg, AppError } from '@doubulea/shared'
import mammoth from 'mammoth'

import { getLogger } from '../../infra/logger.js'
import { renderTableMarkdown } from './table.js'
import {
  buildParseResult,
  DEFAULT_PARSE_OPTIONS,
  normalizeHeadingPath,
  type ParseOptions,
  type ParseResult,
  type ParsedBlock,
  type ParsedImage,
} from './types.js'

/**
 * 文档顺序扫描（两分支，表在前）：
 *   分支 1 `<table>…</table>`（group1 = 表内 HTML）—— 吞掉整张表；
 *   分支 2 叶子块 `h1-6|p|li`（group2 = 标签名，group3 = 内容）。
 * 表分支放前面：表占位处的 `<p>` 被表分支一次吞掉，不会再被叶子分支单独命中。
 */
const ELEMENT = /<table\b[^>]*>([\s\S]*?)<\/table>|<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\2>/giu
/** 表内的一行 / 一个单元格（`<td>` 或 `<th>`） */
const TABLE_ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu
const TABLE_CELL = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/giu

/**
 * 图片占位符的 `src` 前缀。`convertImage` 给每张图返回 `doubulea-img-<n>`，
 * 于是 mammoth 的 HTML 里会在**图片原本的位置**留下 `<img src="doubulea-img-n" />` ——
 * 我们据此还原"这张图在正文的哪个位置"（图片字节本身由回调另存）。
 */
const IMAGE_SRC_PREFIX = 'doubulea-img-'
/** 从一段 HTML 里依次取出图片占位符的序号 */
const IMAGE_TOKEN = /doubulea-img-(\d+)/gu

/** HTML 实体（mammoth 只产出这几种；`&amp;` 与 `&quot;` 最常见） */
const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
}

/**
 * 去标签 + 解实体（`<br>` 先还原成换行，否则同一段里的分行会被粘成一句）。
 *
 * ⚠️ **导出的原因**：HTML 单语言解析链（`.doc` 实为 HTML/MIME 导出件，P1-12）要复用
 * 同一套"去标签 + 解实体"口径 —— 两处各写一遍必然分叉（例如 `&nbsp;` 一处解成空格、
 * 一处原样保留），故由本模块出口（与 `md` 复用 `txt#decodeTextBuffer` 同一条纪律）。
 */
export function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&[a-z#0-9]+;/giu, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .trim()
}

/** 图片在 `blocks` 里的锚点（见 {@link ParsedImage.anchor}） */
interface ImageAnchor {
  /** 插在 `blocks[anchor]` 之前 */
  anchor: number
  headingPath: string[]
}

/**
 * mammoth 的 HTML → 段落块（标题维护层级栈）+ **图片锚点表**。
 *
 * 关键点：
 * · **表格**先于叶子块识别：`<table>` 分支吞掉整张表并产出 `kind='table'` 的单块；
 * · **图片就地取材**：扫到含 `<img>` 的元素时，记下"此刻已产出多少块"作为锚点，并带上当前
 *   标题栈 —— 下游（OCR / 图片分块）据此把图注插回原位，而不是统统堆到文末。
 */
function htmlToBlocks(html: string): { blocks: ParsedBlock[]; imageAnchors: Map<number, ImageAnchor> } {
  const blocks: ParsedBlock[] = []
  const imageAnchors = new Map<number, ImageAnchor>()
  const stack: string[] = []

  for (const match of html.matchAll(ELEMENT)) {
    const tableHtml = match[1]
    // ── 表格分支：整张表收成一个块；表内图片锚在"表块之前"（此时 blocks.length 即表块插入位）──
    if (tableHtml !== undefined) {
      for (const token of tableHtml.matchAll(IMAGE_TOKEN)) {
        imageAnchors.set(Number(token[1]), { anchor: blocks.length, headingPath: normalizeHeadingPath(stack) })
      }
      const markdown = renderTableMarkdown(parseTableGrid(tableHtml))
      if (markdown !== '') {
        blocks.push({ text: markdown, headingPath: normalizeHeadingPath(stack), page: null, kind: 'table' })
      }
      continue
    }

    // ── 叶子块分支：标题 / 段落 / 列表项 ──
    const tag = (match[2] ?? '').toLowerCase()
    const inner = match[3] ?? ''
    const imageIndexes = [...inner.matchAll(IMAGE_TOKEN)].map((token) => Number(token[1]))
    const text = toPlainText(inner)
    if (text === '' && imageIndexes.length === 0) continue

    if (text !== '' && /^h[1-6]$/u.test(tag)) {
      const level = Number(tag.slice(1))
      if (stack.length > level - 1) stack.length = level - 1
      stack[level - 1] = text
    }
    // 空文本段落（纯图片段）不产出块，但图片仍要锚在这里（夹在前后块之间）
    if (text !== '') blocks.push({ text, headingPath: normalizeHeadingPath(stack), page: null })
    for (const index of imageIndexes) {
      imageAnchors.set(index, { anchor: blocks.length, headingPath: normalizeHeadingPath(stack) })
    }
  }
  return { blocks, imageAnchors }
}

/** 取单元格的 `colspan`/`rowspan` 属性值（缺省 / 非法值一律回落 1） */
function spanOf(attrs: string, name: 'colspan' | 'rowspan'): number {
  const matched = new RegExp(`${name}\\s*=\\s*"?\\s*(\\d+)`, 'iu').exec(attrs)
  const value = matched === null ? 1 : Number(matched[1])
  return Number.isInteger(value) && value >= 1 ? value : 1
}

/**
 * `<table>` 内的 HTML → 二维网格（单元格内容已拍平成单行文本）。
 *
 * `rowspans` 记录"仍向下占据某列的合并单元格"：每跨过一行就把它们补回该列并递减，
 * 于是后续行的自身单元格**不会**因为上一行的跨行格而整体左移（列错位是这类解析最隐蔽的错）。
 * `colspan` 则占位后把其右侧列置空（合并格的文本只在首列出现一次）。
 *
 * ⚠️ **导出供 HTML 单语言链路复用**（`.doc` 实为 HTML/MIME 导出件，P1-12）：导出件里的
 * `<table>` 与 docx 同形，表格网格口径只该有一份（同 {@link toPlainText}）。
 */
export function parseTableGrid(html: string): string[][] {
  const rows: string[][] = []
  const rowspans = new Map<number, { remaining: number; text: string }>()

  for (const rowMatch of html.matchAll(TABLE_ROW)) {
    const rowHtml = rowMatch[1] ?? ''
    const cells: string[] = []
    let col = 0

    /** 把当前列上的跨行单元格补回本行并推进列（每个跨行格每行只消耗一次） */
    const consumeRowspans = (): void => {
      while (rowspans.has(col)) {
        const span = rowspans.get(col)
        if (span === undefined) break
        cells[col] = span.text
        span.remaining -= 1
        if (span.remaining <= 0) rowspans.delete(col)
        col += 1
      }
    }

    for (const cellMatch of rowHtml.matchAll(TABLE_CELL)) {
      consumeRowspans()
      const attrs = cellMatch[2] ?? ''
      const inner = cellMatch[3] ?? ''
      const text = toPlainText(inner).replace(/\s*\n\s*/gu, ' ').trim()
      const colspan = spanOf(attrs, 'colspan')
      const rowspan = spanOf(attrs, 'rowspan')
      for (let i = 0; i < colspan; i += 1) {
        cells[col] = i === 0 ? text : ''
        if (rowspan > 1) rowspans.set(col, { remaining: rowspan - 1, text })
        col += 1
      }
    }
    // 行尾可能仍挂着跨行单元格（本行没有自己的 td 覆盖到那里）
    consumeRowspans()
    rows.push(cells)
  }
  return rows
}

/**
 * DOCX → 解析结果。
 *
 * `mammoth.messages` 是它的**告警通道**（未识别的样式、未知元素…），不是错误 ——
 * 出现它往往意味着"文档里有些东西没能还原"，排查解析质量时要看，故记 debug 日志
 * （不在正常路径打 info：多数文档都会带几条样式告警，否则日志会被刷满）。
 */
export async function parseDocx(
  bytes: Buffer,
  options: ParseOptions = DEFAULT_PARSE_OPTIONS,
): Promise<ParseResult> {
  let html: string
  /** 图片字节，按 mammoth 回调顺序（= 文档内顺序）以序号为键 */
  const byIndex = new Map<number, { data: Buffer; mime: string }>()
  let counter = 0
  try {
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
      options.extractImages
        ? {
            // 每张图：① 存下字节；② 返回 `doubulea-img-<n>` 作为 `src`，
            //    使图片在 HTML 里**保留原位占位**（由 `htmlToBlocks` 还原锚点）。
            //    占位符不会被渲染成真实图片（我们不要正文里出现图），只是位置标记。
            convertImage: mammoth.images.imgElement(async (image) => {
              const index = counter
              counter += 1
              try {
                const buffer = await image.readAsBuffer()
                byIndex.set(index, { data: buffer, mime: image.contentType || 'application/octet-stream' })
              } catch {
                // 单张图读失败不影响文档解析
              }
              return { src: `${IMAGE_SRC_PREFIX}${index}` }
            }),
          }
        : undefined,
    )
    html = result.value
    if (result.messages.length > 0) {
      getLogger().debug(
        { messages: result.messages.slice(0, 5), total: result.messages.length },
        'docx 解析告警（mammoth messages）',
      )
    }
  } catch (error) {
    // 走到这里基本只有一种原因：文件不是合法 OOXML（改名、损坏、或被截断）。
    // 魔数校验已在上传时拦过"不是 ZIP"，但"是 ZIP 却不是 docx"（如 xlsx 改名）仍会到这里，
    // 故文案要覆盖这种可能，而不是笼统的"解析失败"。
    throw AppError.validation(appMsg('app.m075', { p0: String(error) }),
    )
  }

  const { blocks, imageAnchors } = htmlToBlocks(html)
  const images: ParsedImage[] = []
  for (const index of [...byIndex.keys()].sort((a, b) => a - b)) {
    const collected = byIndex.get(index)
    if (collected === undefined || collected.data.length > options.maxImageBytes) continue
    const anchor = imageAnchors.get(index)
    images.push({
      data: collected.data,
      mime: collected.mime,
      page: null,
      // 图注继承"图片所在位置"的标题栈；取不到时退回文末
      headingPath: anchor?.headingPath ?? [],
      anchor: anchor?.anchor ?? blocks.length,
    })
  }
  return buildParseResult('docx', blocks, { images })
}
