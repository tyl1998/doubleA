/**
 * HTML / MHTML（网页导出件）解析（P1-12）
 *
 * 依据：`子方案/图片OCR与图片理解.md` §六·补、`05-P系列计划拆分.md` §三 / §三·补 P1-12。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 为什么会有这个解析器：扩展名 `doc` ≠ OLE2 二进制
 * ─────────────────────────────────────────────────────────────────────
 * 存量 `.doc` 里很大一部分是 **HTML / MIME（MHTML）导出件** —— Confluence 导出、
 * Word「另存为网页」、邮件导出……它们既不是 OLE2 二进制，`mammoth` / `word-extractor`
 * 之流也对它们无效。过去 `detectFormat` 一见 `.doc` 就拒（`parse/index.ts`），把这些
 * **本可正常抽文本**的文件误杀了（实测样例是 Confluence MHTML，8.3k 字正文可读）。
 *
 * 本模块只做"内容已被判定为 HTML/MIME 之后"的事：把网页结构抽成与其它格式同一形状的
 * `ParseResult`（标题层级 + 段落/表格块 + 图片）。**它不决定"要不要解析"** —— 那是
 * `detectFormat` 按内容嗅探的职责（真 OLE2 仍拒、给"请另存为 .docx"）。故本解析器**只在
 * `.doc` 嗅探到 HTML/MIME 时**被调用（`html` 不是可上传扩展名，见 `types.ts#PARSE_FORMATS`）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两条入口：裸 HTML 与 MHTML
 * ─────────────────────────────────────────────────────────────────────
 *   · 裸 HTML（`<!doctype html>` / `<html`）：直接就是标记文本 → 抽块；
 *   · MHTML（顶层是 MIME 头 + `multipart/related`）：先按 boundary 拆 part —— 取
 *     `text/html` 那一段（按 `Content-Transfer-Encoding` 解 base64 / quoted-printable）
 *     作为正文，并按 `Content-Id`/`Content-Location` 登记同包的 `image/*` part 供 `<img>` 回取。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 抽块口径（与 md/docx **同族**，不引 HTML 解析器）
 * ─────────────────────────────────────────────────────────────────────
 * 导出件的 HTML 由机器生成、形状可控，引一个 DOM 实现只为"取标题/段落/表格/图片"不划算
 * （与 `docx.ts` 同一取舍）。做法：
 *   ① `<table>` 先整体替换成哨兵 → 表内 `<p>` 不再被误当段落；表用 `docx#parseTableGrid`
 *      的同一套网格口径（合并单元格列不错位）序列化成 Markdown 管道表（`kind='table'`）；
 *   ② `<img>` 替换成带序号的哨兵 → 记录它在 `blocks` 里的锚点（图注/描述插回原位）；
 *   ③ `<h1..h6>` 替换成带层级哨兵 → 维护标题栈（标题段自己也在自己的 `headingPath` 里）；
 *   ④ 其余**块级标签**（p/div/li/tr/br…）一律换算行符 → 每行 = 一个段落块；
 *   ⑤ 去标签 + 解实体（含数字实体），空行丢弃。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 图片：data URI / MHTML 内嵌 part / 远程 http(s)（P1-12 补齐）
 * ─────────────────────────────────────────────────────────────────────
 * `<img src>` 有三种来源，逐类回取（与 md 链路同款口径，data URI/远程抓取**复用 `md.ts`**）：
 *   · `data:image/...;base64,...` → 就地解码；
 *   · `cid:<id>` / 相對 URL → 回查 MHTML 同包 `image/*` part（按 `Content-Id` /
 *     `Content-Location` / 相对 html part 的 `Content-Location` 解析 / 文件名兜底）；
 *   · `http(s):` 外链 → `fetchRemoteImage`（8s 超时、体积上限、`image/*` 校验；失败吞掉）。
 * ⚠️ 单张失败/取不到**只跳过该图、不让整篇 FAILED**（图只是内容的一部分，与 md 同款）。
 * ⚠️ **不做**"从 `data-image-src` 取远程内网高清源"（`子方案` §五·补 2，**2026-10-08 定案不做**：
 * 那是需鉴权的内网 Confluence 附件 URL，收益不抵复杂度）—— 本模块只做"把导出件里**自带**的图取出来"。
 */

import { appMsg, AppError } from '@doubulea/shared'

import { parseTableGrid, toPlainText } from './docx.js'
import { decodeDataUri, fetchRemoteImage } from './md.js'
import { renderTableMarkdown } from './table.js'
import { decodeTextBuffer } from './txt.js'
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
 * 块级标签：它们的前后边界就是"段落边界"。`<br>` 单独处理（它是行内换行）。
 * 表相关标签（table/thead/tbody/tr/td…）不列在此：表已被整体替换成哨兵，其内部不会再被扫到。
 */
const BLOCK_TAGS =
  'p|div|section|article|header|footer|main|aside|nav|ul|ol|li|dl|dt|dd|blockquote|pre|figure|figcaption|form|fieldset|hr|address'

/** 标题哨兵：`\uE000HEAD<level>\uE000<title>`（`\uE000` 不会出现在正常文本里） */
const HEADING_SENTINEL = /^\uE000HEAD([1-6])\uE000([\s\S]*)$/u
/** 表格哨兵：`\uE000TABLE<index>\uE000` */
const TABLE_SENTINEL = /^\uE000TABLE(\d+)\uE000$/u
/** 图片哨兵：`\uE000IMG<index>\uE000`（可出现在一行中的任意位置） */
const IMAGE_TOKEN = /\uE000IMG(\d+)\uE000/gu

/** 具名实体（覆盖导出件常见的一批；未知实体原样保留，不猜测） */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
}

/** 解实体：具名 + 十进制/十六进制数字实体（`String.fromCodePoint` 覆盖代理对以外的码点） */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/giu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      return Number.isInteger(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 去标签：`<br>` 先还原成换行，其余标签一律抹掉（不保留属性/注释） */
function stripTags(html: string): string {
  return html.replace(/<br\s*\/?>/giu, '\n').replace(/<[^>]*>/gu, '')
}

/** 取标签里的单个属性值（`src="..."` / `src='...'` / `src=...` 三种写法） */
function extractAttr(tag: string, name: string): string | undefined {
  const matched = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(tag)
  return matched?.[1] ?? matched?.[2] ?? matched?.[3]
}

/** 转义正则里的特殊字符（MIME boundary 进了正则） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 取图片定位串的文件名部分（去 query/hash，取最后一段，小写）——作 MHTML part 的兜底键 */
function imageBasename(locator: string): string {
  const path = locator.split(/[?#]/u)[0] ?? locator
  const segment = path.split('/').pop() ?? path
  return segment.toLowerCase()
}

/** 解析一段 MIME 头（支持折行续行）；键一律小写 */
function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>()
  let current: string | undefined
  for (const line of block.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line) && current !== undefined) {
      headers.set(current, `${headers.get(current) ?? ''} ${line.trim()}`)
      continue
    }
    const matched = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s?(.*)$/u.exec(line)
    if (matched === null) continue
    current = matched[1]?.toLowerCase()
    if (current !== undefined) headers.set(current, (matched[2] ?? '').trim())
  }
  return headers
}

/** quoted-printable 解码成**字节**（先吃软换行 `=` + 换行，再把 `=XX` 还原成字节） */
function decodeQuotedPrintableBytes(input: string): Buffer {
  const withoutSoftBreaks = input.replace(/=(?:\r\n|\r|\n)/gu, '')
  const bytes: number[] = []
  for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
    const char = withoutSoftBreaks[i] ?? ''
    if (char === '=' && i + 2 < withoutSoftBreaks.length) {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff)
  }
  return Buffer.from(bytes)
}

/** 按 `Content-Transfer-Encoding` 把 part 正文解成字节（二进制 part 用；文本 part 另有 utf8 收口） */
function decodeTransferBytes(body: string, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/gu, ''), 'base64')
    case 'quoted-printable':
      return decodeQuotedPrintableBytes(body)
    default:
      return Buffer.from(body, 'latin1')
  }
}

/** 取 MIME 头的 `charset` 参数（小写）；没有则 `undefined` */
function charsetOf(contentType: string): string | undefined {
  const matched = /charset\s*=\s*"?([^";]+)"?/iu.exec(contentType)
  return matched?.[1]?.trim().toLowerCase()
}

/**
 * 按 part 的 `charset` 解字节为文本。
 *
 * ⚠️ **Word「另存为网页」的 MHTML 用 `charset="unicode"` = UTF-16LE**（本模块的第一号真实样例
 * `2026-09+URP-广发积分兑换券核销.doc` 即是），且 UTF-16LE 的 ASCII 字节（`3C 00 0A 00`）
 * **本身就是合法 UTF-8**（NUL 合法）⇒ 只靠"严格 UTF-8 试解"会把整篇判成 utf-8、留下满屏 NUL。
 * 故这里**先认 MIME 声明的 charset**，再回落到 `decodeTextBuffer` 的 BOM/嗅探。
 */
function decodeTextBytes(bytes: Buffer, charset: string | undefined): string {
  if (charset === 'unicode' || charset === 'utf-16' || charset === 'utf-16le') {
    const body = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes
    return new TextDecoder('utf-16le').decode(body)
  }
  if (charset === 'utf-16be') {
    const body = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? bytes.subarray(2) : bytes
    return new TextDecoder('utf-16be').decode(body)
  }
  return decodeTextBuffer(bytes).text
}

/** 按 `Content-Transfer-Encoding` 把 part 正文解成文本（HTML part 用；传输编码先还原成字节，再认 charset） */
function decodeTransferText(body: string, encoding: string, charset: string | undefined): string {
  switch (encoding.trim().toLowerCase()) {
    case 'base64':
      return decodeTextBytes(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/gu, ''), 'base64'), charset)
    case 'quoted-printable':
      return decodeTextBytes(decodeQuotedPrintableBytes(body), charset)
    default:
      // 7bit/8bit/无编码：body 已是（整文件解码后的）文本，不再二次转编码
      return body
  }
}

/** MHTML 拆包结果：正文 HTML + html part 的基址（相对 URL 解析用）+ 同包图片表 */
export interface MhtmlParts {
  html: string
  baseLocation: string | undefined
  /** 键：Content-Id / Content-Location（原样与小写）/ 文件名（小写）→ 图片字节 */
  images: Map<string, { data: Buffer; mime: string }>
}

/** 把一张图片按多种键登记进 `images`（同一份字节可被多个键命中） */
function registerImage(
  images: Map<string, { data: Buffer; mime: string }>,
  headers: Map<string, string>,
  image: { data: Buffer; mime: string },
): void {
  const contentId = headers.get('content-id')?.replace(/^</u, '').replace(/>$/u, '').trim()
  const location = headers.get('content-location')?.trim()
  for (const key of [contentId, location]) {
    if (key === undefined || key === '') continue
    images.set(key, image)
    images.set(key.toLowerCase(), image)
  }
  if (location !== undefined && location !== '') images.set(imageBasename(location), image)
  if (contentId !== undefined && contentId !== '') images.set(imageBasename(contentId), image)
}

/**
 * 解析 MHTML：拆 part、取 `text/html` 正文、登记 `image/*` part。不是 multipart 或
 * 找不到 HTML part 时返回 `undefined`（调用方按"裸 HTML"处理）。
 */
export function parseMhtml(text: string): MhtmlParts | undefined {
  const separator = text.search(/\r?\n\r?\n/u)
  if (separator < 0) return undefined
  const headers = parseHeaders(text.slice(0, separator))
  const contentType = headers.get('content-type') ?? ''
  if (!/multipart\//iu.test(contentType)) return undefined

  const boundaryMatch = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (boundary === undefined || boundary === '') return undefined

  const body = text.slice(separator).replace(/^\r?\n/u, '')
  const parts = body.split(new RegExp(`--${escapeRegExp(boundary)}`, 'gu'))
  const images = new Map<string, { data: Buffer; mime: string }>()
  let html: string | undefined
  let baseLocation: string | undefined

  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r?\n/u, '')
    const partSeparator = part.search(/\r?\n\r?\n/u)
    if (partSeparator < 0) continue
    const partHeaders = parseHeaders(part.slice(0, partSeparator))
    const partType = (partHeaders.get('content-type') ?? '').toLowerCase()
    const encodedBody = part.slice(partSeparator).replace(/^\r?\n/u, '')
    const transfer = partHeaders.get('content-transfer-encoding') ?? ''

    if (partType.includes('text/html')) {
      const decoded = decodeTransferText(encodedBody, transfer, charsetOf(partType))
      if (html === undefined && decoded.trim() !== '') {
        html = decoded
        const location = partHeaders.get('content-location')?.trim()
        baseLocation = location === '' ? undefined : location
      }
      continue
    }
    if (/^image\//iu.test(partType)) {
      const mime = partType.split(';')[0]?.trim() ?? 'application/octet-stream'
      registerImage(images, partHeaders, { data: decodeTransferBytes(encodedBody, transfer), mime })
    }
  }

  if (html === undefined) return undefined
  return { html, baseLocation, images }
}

/** 从 MHTML 文本里取出 `text/html` part 的正文（保留导出，供自证脚本使用） */
export function extractMhtmlHtml(text: string): string | undefined {
  return parseMhtml(text)?.html
}

/** 在 `blocks` 里的图片锚点（`src` = 原始 `<img src>`，anchor = 插在 `blocks[anchor]` 之前） */
export interface HtmlImageRef {
  src: string
  anchor: number
  headingPath: string[]
}

/**
 * HTML 标记 → 段落块 + 图片锚点（标题维护层级栈；表格收成 `kind='table'` 的原子块）。口径见文件头。
 */
export function htmlToBlocks(html: string): { blocks: ParsedBlock[]; imageRefs: HtmlImageRef[] } {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')

  // ① 表格 → 哨兵（表内结构由 parseTableGrid/renderTableMarkdown 收口；表内图片随表一并丢弃）
  const tables: string[] = []
  const withTables = cleaned.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/giu, (tableHtml) => {
    const markdown = renderTableMarkdown(parseTableGrid(tableHtml))
    const index = tables.length
    tables.push(markdown)
    return `\n\uE000TABLE${index}\uE000\n`
  })

  // ② 图片 → 哨兵（记录 src；锚点在逐行处理时确定）
  const imageSrcs: string[] = []
  const withImages = withTables.replace(/<img\b[^>]*>/giu, (tag) => {
    const raw = extractAttr(tag, 'src')
    const index = imageSrcs.length
    imageSrcs.push(raw === undefined ? '' : decodeEntities(raw))
    return `\uE000IMG${index}\uE000`
  })

  // ③ 标题 → 带层级哨兵（内容先拍平单行）
  const withHeadings = withImages.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu,
    (_match, level: string, inner: string) =>
      `\n\uE000HEAD${level}\uE000${toPlainText(inner).replace(/\s+/gu, ' ').trim()}\n`,
  )

  // ④ 块级标签 → 换行；⑤ 去标签 + 解实体
  const blockTag = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'giu')
  const text = decodeEntities(stripTags(withHeadings.replace(blockTag, '\n')))

  const blocks: ParsedBlock[] = []
  const imageRefs: HtmlImageRef[] = []
  const stack: string[] = []
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/[ \t\u00a0]+/gu, ' ').trim()
    if (line === '') continue

    const heading = HEADING_SENTINEL.exec(line)
    if (heading !== null) {
      const level = Number(heading[1])
      const title = (heading[2] ?? '').trim()
      if (title === '') continue
      // 层级跳变时补齐/截断栈（与 md/docx 同一套口径）
      if (stack.length > level - 1) stack.length = level - 1
      stack[level - 1] = title
      blocks.push({ text: title, headingPath: normalizeHeadingPath(stack), page: null })
      continue
    }

    const table = TABLE_SENTINEL.exec(line)
    if (table !== null) {
      const markdown = tables[Number(table[1])] ?? ''
      if (markdown.trim() !== '') {
        blocks.push({ text: markdown, headingPath: normalizeHeadingPath(stack), page: null, kind: 'table' })
      }
      continue
    }

    // 行内图片哨兵：先落正文块，再把图片锚在该块之后（与 md 的"图在段后"同口径）
    const tokens = [...line.matchAll(IMAGE_TOKEN)]
    if (tokens.length > 0) {
      const remaining = line.replace(IMAGE_TOKEN, '').replace(/[ \t]+/gu, ' ').trim()
      if (remaining !== '') {
        blocks.push({ text: remaining, headingPath: normalizeHeadingPath(stack), page: null })
      }
      for (const token of tokens) {
        const src = imageSrcs[Number(token[1])] ?? ''
        if (src !== '') {
          imageRefs.push({ src, anchor: blocks.length, headingPath: normalizeHeadingPath(stack) })
        }
      }
      continue
    }

    blocks.push({ text: line, headingPath: normalizeHeadingPath(stack), page: null })
  }
  return { blocks, imageRefs }
}

/**
 * 把一个 `<img src>` 回取成图片字节：data URI → 就地解；cid/相对/绝对 URL → 回查 MHTML 同包
 * part；http(s) → 远程抓取。取不到返回 `undefined`（调用方跳过，不使整篇 FAILED）。
 */
async function resolveImage(
  src: string,
  mhtml: MhtmlParts | undefined,
  maxBytes: number,
): Promise<{ data: Buffer; mime: string } | undefined> {
  if (src === '') return undefined
  if (src.startsWith('data:')) return decodeDataUri(src)

  if (mhtml !== undefined) {
    const candidates: string[] = []
    if (src.startsWith('cid:')) candidates.push(src.slice(4))
    candidates.push(src, src.toLowerCase())
    if (mhtml.baseLocation !== undefined) {
      try {
        candidates.push(new URL(src, mhtml.baseLocation).href)
      } catch {
        // 相对 URL 无法解析：忽略，继续用文件名兜底
      }
    }
    candidates.push(imageBasename(src))
    for (const key of candidates) {
      const hit = mhtml.images.get(key)
      if (hit !== undefined) return hit
    }
  }

  if (/^https?:/iu.test(src)) return fetchRemoteImage(src, maxBytes)
  return undefined
}

/**
 * HTML / MHTML → 解析结果（P1-12）。编码沿用与 txt/md 同一套嗅探（`decodeTextBuffer`）。
 *
 * `options.extractImages` 为真时抽取 `<img>`（data URI / MHTML part / 远程 http(s)）；
 * 单张失败只跳过。⚠️ 抽不出任何文字时抛 `AppError.validation`（可展示文案）——它会被
 * worker 记成文档 FAILED 的原因，而不是静默产出空文档。
 */
export async function parseHtml(bytes: Buffer, options: ParseOptions = DEFAULT_PARSE_OPTIONS): Promise<ParseResult> {
  const { text, encoding } = decodeTextBuffer(bytes)
  const mhtml = parseMhtml(text)
  const html = mhtml?.html ?? text
  const { blocks, imageRefs } = htmlToBlocks(html)
  if (blocks.length === 0) {
    throw AppError.validation(appMsg('app.m076'),
    )
  }

  const images: ParsedImage[] = []
  if (options.extractImages) {
    for (const ref of imageRefs) {
      const resolved = await resolveImage(ref.src, mhtml, options.maxImageBytes)
      if (resolved === undefined || resolved.data.length === 0) continue
      if (resolved.data.length > options.maxImageBytes) continue
      images.push({
        data: resolved.data,
        mime: resolved.mime,
        page: null,
        headingPath: ref.headingPath,
        anchor: ref.anchor,
      })
    }
  }
  return buildParseResult('html', blocks, { encoding, images })
}
