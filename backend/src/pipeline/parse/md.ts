/**
 * Markdown 解析（P0-1-16；`子方案/知识库流水线.md` §4-1：MD 原生，按 `#` 层级记录标题）
 *
 * 为什么"原生"（不引 markdown 解析库）：本层要的不是渲染，而是**结构 + 正文**，
 * 而 md 的标题/段落/代码围栏/表格这四件事用行级正则就够 —— 引一个 AST 库会顺手带来
 * 内联 HTML、脚注等一大堆与本项目无关的语义，且"到底什么算一个段落"会变成
 * 那个库的口径而不是我们的（下游 hybrid 分块要靠这个粒度）。
 *
 * 四条明确的口径（都是"选了就要写下来"的取舍）：
 *   · 只认 **ATX 标题**（`# 一级`…`###### 六级`）；setext 标题（下划线式）不做 ——
 *     它与分隔线 `---` 在行级无法可靠区分，误判会把分隔线吃成标题。
 *   · **代码围栏内的 `#` 不是标题**（``` / ~~~，可缩进）：这是 md 解析最常见的假阳性来源。
 *     围栏内容仍然收成一个 block（它是内容，只是不参与标题层级）。
 *   · 连续非空行算**一个段落**（内部换行保留）：md 的软换行是排版行为，不是语义分隔。
 *   · **GFM 表格**（表头行 + 分隔行 + 数据行）原样收成一个 `kind='table'` 块，供分块层
 *     当原子单元；判定要求"下一行是分隔行"，避免正文里孤立的 `|` 被误判成表格。
 */

import { decodeTextBuffer } from './txt.js'
import { getLogger } from '../../infra/logger.js'
import {
  buildParseResult,
  DEFAULT_PARSE_OPTIONS,
  normalizeHeadingPath,
  type ParseOptions,
  type ParseResult,
  type ParsedBlock,
  type ParsedImage,
} from './types.js'

/** 代码围栏起始/结束（``` 或 ~~~，允许缩进与语言标记） */
const FENCE = /^\s*(`{3,}|~{3,})/u
/** ATX 标题：1~6 个 `#` + 空格 + 标题；允许结尾的闭合 `#` */
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u
/** Markdown 图片语法 `![alt](url "title")`（只取 url；title 可选） */
const IMAGE_LINK = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/gu

/**
 * 表格行判据（GFM）：一行里含 `|` 且非空。**单看它不足以成表** —— 正文里偶然出现 `|`
 * 也满足它，故真正判定要求"下一行是分隔行"（见 {@link parseMd} 的 lookahead）。
 */
function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim() !== ''
}

/** 分隔行：`| --- | :---: |` 这类（每格只由 `-` 与可选的 `:` 构成，且至少一个 `-`） */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.includes('-')) return false
  const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|')
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/u.test(cell))
}

/** 外链图片抓取的超时（毫秒） */
const REMOTE_IMAGE_TIMEOUT_MS = 8000

/**
 * `data:image/...;base64,...` → 原始字节；不是 data URI 时返回 `undefined`。
 *
 * ⚠️ **导出供 HTML 链路复用**（`.doc` 实为 HTML/MIME 导出件，P1-12）：导出件里的
 * `data:` 图与 md 里的是同一种东西，解码口径只该有一份（同 {@link fetchRemoteImage}）。
 */
export function decodeDataUri(url: string): { data: Buffer; mime: string } | undefined {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/su.exec(url)
  if (match === null) return undefined
  const mime = match[1] ?? 'application/octet-stream'
  const payload = match[3] ?? ''
  try {
    const data = match[2] === ';base64' ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'binary')
    return { data, mime }
  } catch {
    return undefined
  }
}

/**
 * 抓取外链图片（`http(s)`）。**只做最小必要的防护**：8 秒超时、体积上限、
 * `Content-Type` 必须是 `image/*`。任何失败都**吞掉并返回 `undefined`** ——
 * 外网图取不到不该让一篇 md 解析失败（它只是内容的一部分）。
 */
export async function fetchRemoteImage(url: string, maxBytes: number): Promise<{ data: Buffer; mime: string } | undefined> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS)
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) return undefined
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
    if (!mime.startsWith('image/')) return undefined
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) return undefined
    return { data: buffer, mime }
  } catch (error) {
    getLogger().debug({ err: error, url }, 'md 外链图片抓取失败（已跳过）')
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 图片在正文里的位置（锚点 = 插在 `blocks[anchor]` 之前）+ 所属标题 */
interface MdImageAnchor {
  url: string
  anchor: number
  headingPath: string[]
}

/** 按锚点表抓取图片（data URI 与 http(s) 外链；相对路径无法解析，跳过） */
async function collectImages(
  anchors: readonly MdImageAnchor[],
  options: ParseOptions,
): Promise<ParsedImage[]> {
  const images: ParsedImage[] = []
  for (const anchor of anchors) {
    const decoded = decodeDataUri(anchor.url) ?? (await fetchRemoteImage(anchor.url, options.maxImageBytes))
    if (decoded === undefined || decoded.data.length === 0) continue
    if (decoded.data.length > options.maxImageBytes) continue
    images.push({
      data: decoded.data,
      mime: decoded.mime,
      page: null,
      headingPath: normalizeHeadingPath(anchor.headingPath),
      anchor: anchor.anchor,
    })
  }
  return images
}

export async function parseMd(
  bytes: Buffer,
  options: ParseOptions = DEFAULT_PARSE_OPTIONS,
): Promise<ParseResult> {
  const { text, encoding } = decodeTextBuffer(bytes)
  const blocks: ParsedBlock[] = []
  /** 标题栈（`stack[level-1]` = 第 level 级标题） */
  const stack: string[] = []
  /** 图片位置表（段落 flush 时落锚，见下） */
  const imageAnchors: MdImageAnchor[] = []

  let paragraph: string[] = []
  /** 当前段落里出现的图片 url（段落 flush 时转成锚点） */
  let pendingImageUrls: string[] = []
  let fence: string | null = null
  let fenced: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ text: paragraph.join('\n').trim(), headingPath: normalizeHeadingPath(stack), page: null })
    }
    paragraph = []
    // 图片锚在**本段之后**，并继承本段的标题栈（图注就不会跑到文末、也不会丢章节）
    if (pendingImageUrls.length > 0) {
      const headingPath = normalizeHeadingPath(stack)
      for (const url of pendingImageUrls) {
        imageAnchors.push({ url, anchor: blocks.length, headingPath })
      }
      pendingImageUrls = []
    }
  }
  const flushFence = (): void => {
    // 未闭合的围栏（文件被截断）也照常收成一块 —— 宁可有内容，不要静默丢掉半篇
    const content = fenced.join('\n').trim()
    if (content !== '') blocks.push({ text: content, headingPath: normalizeHeadingPath(stack), page: null })
    fenced = []
    fence = null
  }

  const lines = text.split(/\r\n|\r|\n/u)
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (fence !== null) {
      const marker = FENCE.exec(line)
      if (marker !== null && marker[1]?.[0] === fence[0]) {
        flushFence()
      } else {
        fenced.push(line)
      }
      index += 1
      continue
    }

    const marker = FENCE.exec(line)
    if (marker !== null) {
      flushParagraph()
      fence = marker[1] ?? '```'
      index += 1
      continue
    }

    // 表格：仅当"本行是表格行且下一行是分隔行"时成表（lookahead 避免正文里的孤立 `|` 误判）。
    // 整张表**原样**收成一个 `kind='table'` 块 —— 原文已是 Markdown 管道表，保留最忠实。
    if (isTableRow(line) && isTableDelimiter(lines[index + 1] ?? '')) {
      flushParagraph()
      let end = index + 2
      while (end < lines.length && isTableRow(lines[end] ?? '')) end += 1
      const table = lines
        .slice(index, end)
        .map((raw) => raw.trim())
        .join('\n')
      if (table.trim() !== '') {
        blocks.push({ text: table, headingPath: normalizeHeadingPath(stack), page: null, kind: 'table' })
      }
      index = end
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flushParagraph()
      const level = heading[1]?.length ?? 1
      const title = (heading[2] ?? '').trim()
      // 层级跳变（如 `#` 后直接 `###`）时补齐栈：截到 level-1 再写第 level 层
      if (stack.length > level - 1) stack.length = level - 1
      if (title !== '') stack[level - 1] = title
      // 标题段自己也在自己的路径里（见 `types.ts` 的 `headingPath` 说明）
      if (title !== '') blocks.push({ text: title, headingPath: normalizeHeadingPath(stack), page: null })
      index += 1
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }
    for (const match of line.matchAll(IMAGE_LINK)) {
      const url = match[1]
      if (url !== undefined) pendingImageUrls.push(url)
    }
    paragraph.push(line.trim())
    index += 1
  }

  flushParagraph()
  if (fence !== null) flushFence()

  const images = options.extractImages ? await collectImages(imageAnchors, options) : []
  return buildParseResult('md', blocks, { encoding, images })
}
