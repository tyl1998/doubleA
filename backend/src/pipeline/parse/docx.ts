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
 * 已知降级（`子方案①` §十三 待决事项 3 的同类取舍）：**表格**。mammoth 把单元格内容
 * 包在 `<p>` 里，本层照常收成段落 —— 于是表格变成"按行顺序排列的若干段"，
 * 行列对应关系丢失。P0 接受（表格结构还原不是本期目标），要还原得走 P1 的专门解析。
 */

import { AppError } from '@doubulea/shared'
import mammoth from 'mammoth'

import { getLogger } from '../../infra/logger.js'
import { buildParseResult, type ParseResult, type ParsedBlock } from './types.js'

/** mammoth 输出里的"叶子块"：标题 / 段落 / 列表项（三者的内容都直接是文本） */
const LEAF_BLOCK = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/giu

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

/** 去标签 + 解实体（`<br>` 先还原成换行，否则同一段里的分行会被粘成一句） */
function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&[a-z#0-9]+;/giu, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .trim()
}

/** mammoth 的 HTML → 段落块（标题维护层级栈） */
function htmlToBlocks(html: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  const stack: string[] = []
  for (const match of html.matchAll(LEAF_BLOCK)) {
    const tag = (match[1] ?? '').toLowerCase()
    const text = toPlainText(match[2] ?? '')
    if (text === '') continue

    if (/^h[1-6]$/u.test(tag)) {
      const level = Number(tag.slice(1))
      if (stack.length > level - 1) stack.length = level - 1
      stack[level - 1] = text
      blocks.push({ text, headingPath: [...stack], page: null })
      continue
    }
    blocks.push({ text, headingPath: [...stack], page: null })
  }
  return blocks
}

/**
 * DOCX → 解析结果。
 *
 * `mammoth.messages` 是它的**告警通道**（未识别的样式、未知元素…），不是错误 ——
 * 出现它往往意味着"文档里有些东西没能还原"，排查解析质量时要看，故记 debug 日志
 * （不在正常路径打 info：多数文档都会带几条样式告警，否则日志会被刷满）。
 */
export async function parseDocx(bytes: Buffer): Promise<ParseResult> {
  let html: string
  try {
    const result = await mammoth.convertToHtml({ buffer: bytes })
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
    throw AppError.validation(
      `无法解析 docx：文件不是有效的 Word 文档（可能已损坏，或被改名的其它格式）。${String(error)}`,
    )
  }
  return buildParseResult('docx', htmlToBlocks(html))
}
