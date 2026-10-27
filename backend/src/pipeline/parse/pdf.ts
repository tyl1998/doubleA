/**
 * PDF 解析（P0-1-16；`子方案/知识库流水线.md` §4-1：unpdf，每页文本 + 页码）
 * P0-4-x 增量：可选抽取页面内嵌图片（含扫描页的整页图）。
 *
 * `unpdf` 是 pdf.js 的**服务端封装**（无 DOM 依赖，纯 JS）：`getDocumentProxy` 拿文档、
 * `extractText(pdf, { mergePages: false })` 拿**逐页文本数组**。选它而不是 pdfjs 本体，
 * 是因为本体在 Node 下要自己接 worker/cMap 的路径，而本层只做"取文本"这一件事。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两个必须记住的行为（都是实测出来的）
 * ─────────────────────────────────────────────────────────────────────
 * ① **页码是本层的产出，别丢**：`mergePages: false` 时 `text` 是 `string[]`，
 *    下标即页序 —— 这个信息一旦被合并成一整段就再也拆不回来，而 `子方案①` §4-3 的
 *    `meta.page`（引用要显示"第 N 页"）与 §五 的"混合型扫描件"识别都靠它。
 * ② **`loadingTask` 是真正的持有者，必须显式释放**：unpdf 的代理对象**没有** `destroy`
 *    （实测 `typeof pdf.destroy === 'undefined'`，只有 `cleanup`），而 pdfjs 的文档与
 *    其 worker 由 `pdf.loadingTask` 持有。不释放的话每次上传都会漏一个文档句柄 ——
 *    单次上传看不出来，跑一夜的批量上传就是内存泄漏。故这里 `finally` 里收掉。
 *
 * 空页（扫描页/空白页）产出 0 个 block，但**仍计入 `meta.pageCount`**：
 * "页数 10、解析出 3 页文字"正是 §五 说的混合型扫描件，页数与块数的差额就是那条弱提示的依据。
 *
 * ─────────────────────────────────────────────────────────────────────
 * P0-4-x：图片抽取（`unpdf#extractImages`，无需原生 canvas）
 * ─────────────────────────────────────────────────────────────────────
 * `extractImages(pdf, pageNumber)` 直接返回页内 `paintImageXObject` 的**原始像素**
 * （width/height/channels）。扫描件 PDF 的每页正文本身就是一张整页位图，故它同样能覆盖
 * "扫描件"这一最需要图片解析的场景，且**不依赖 `@napi-rs/canvas`**（那个只被
 * `renderPageAsImage` 需要，本层不用）。原始像素由 `png.ts` 编成 PNG 再往下走。
 */

import { appMsg, AppError } from '@doubulea/shared'
import { extractImages, extractText, getDocumentProxy } from 'unpdf'

import { encodePngRaw } from './png.js'
import {
  buildParseResult,
  DEFAULT_PARSE_OPTIONS,
  type ParseOptions,
  type ParseResult,
  type ParsedBlock,
  type ParsedImage,
} from './types.js'

/** 释放 pdfjs 的文档句柄（见文件头 ②） */
async function releaseDocument(pdf: unknown): Promise<void> {
  const task = (pdf as { loadingTask?: { destroy?: () => Promise<void> } }).loadingTask
  await task?.destroy?.()
}

/** 一页文本 → 段落块（按空行切；页内换行原样保留，见 `txt.ts` 的同款说明） */
function pageToBlocks(pageText: string, page: number): ParsedBlock[] {
  return pageText
    .split(/\n\s*\n/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => ({ text: chunk, headingPath: [], page }))
}

/** 小于该边长的位图大概率是图标/分隔线，OCR 与向量化都没有意义 —— 跳过 */
const MIN_IMAGE_SIDE = 8

/**
 * 第 `page` 页图片的锚点：插在**该页之后第一块**之前（即紧跟在同页文本后面）。
 * 页内没有文本时，退化为"下一处文本之前"，从而不会把所有图都堆到文末。
 */
function anchorForPage(blocks: readonly ParsedBlock[], page: number): number {
  const index = blocks.findIndex((block) => block.page !== null && block.page > page)
  return index === -1 ? blocks.length : index
}

/**
 * 抽取单页内嵌图片 → {@link ParsedImage}[]（用 PNG 无损编码）。
 *
 * 单张过大（`maxImageBytes`）或过小（图标）时**跳过**而不是让整篇失败：
 * 图片是"锦上添花"的内容，一张异常图不该让一篇正常文档变成 FAILED。
 */
async function pageImages(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  page: number,
  options: ParseOptions,
): Promise<ParsedImage[]> {
  const found = await extractImages(pdf, page)
  const images: ParsedImage[] = []
  for (const image of found) {
    const { data, width, height, channels } = image
    if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) continue
    let png: Buffer
    try {
      png = encodePngRaw(data, width, height, channels)
    } catch {
      // 通道数不是 1/3/4 之类的异常图：跳过（不影响文本与其余图片）
      continue
    }
    if (png.length > options.maxImageBytes) continue
    images.push({ data: png, mime: 'image/png', page, headingPath: [] })
  }
  return images
}

/**
 * PDF → 解析结果。
 *
 * 解析失败（加密、损坏、非 PDF 内容）一律抛 `AppError.validation`：
 * 上传前置校验按魔数拦过"根本不是 PDF"，但"是 PDF 却打不开"（扫描件的异常结构、
 * 加密文档）仍会到这里 —— 那时给用户一句能行动的话，比抛一段 pdfjs 堆栈有用。
 *
 * `options.extractImages=true` 时**逐页**抽图；抽图失败（某页结构异常）只吞掉该页的图片，
 * 文本照常产出 —— 与"一个坏对象不该毁掉整篇"同一条纪律。
 */
export async function parsePdf(
  bytes: Buffer,
  options: ParseOptions = DEFAULT_PARSE_OPTIONS,
): Promise<ParseResult> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes))
  } catch (error) {
    throw AppError.validation(appMsg('app.m079', { p0: String(error) }))
  }

  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false })
    const pages = Array.isArray(text) ? text : [text]
    const blocks = pages.flatMap((pageText, index) => pageToBlocks(pageText, index + 1))

    const images: ParsedImage[] = []
    if (options.extractImages) {
      for (let page = 1; page <= totalPages; page += 1) {
        try {
          const found = await pageImages(pdf, page, options)
          const anchor = anchorForPage(blocks, page)
          images.push(...found.map((image) => ({ ...image, anchor })))
        } catch {
          // 单页抽图失败（结构异常）不影响其余页与文本
        }
      }
    }

    return buildParseResult('pdf', blocks, { pageCount: totalPages, images })
  } finally {
    await releaseDocument(pdf)
  }
}
