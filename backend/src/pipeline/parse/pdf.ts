/**
 * PDF 解析（P0-1-16；`子方案/知识库流水线.md` §4-1：unpdf，每页文本 + 页码）
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
 */

import { AppError } from '@doubulea/shared'
import { extractText, getDocumentProxy } from 'unpdf'

import { buildParseResult, type ParseResult, type ParsedBlock } from './types.js'

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

/**
 * PDF → 解析结果。
 *
 * 解析失败（加密、损坏、非 PDF 内容）一律抛 `AppError.validation`：
 * 上传前置校验按魔数拦过"根本不是 PDF"，但"是 PDF 却打不开"（扫描件的异常结构、
 * 加密文档）仍会到这里 —— 那时给用户一句能行动的话，比抛一段 pdfjs 堆栈有用。
 */
export async function parsePdf(bytes: Buffer): Promise<ParseResult> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes))
  } catch (error) {
    throw AppError.validation(`无法打开 PDF：文件已损坏或被加密（${String(error)}）`)
  }

  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false })
    const pages = Array.isArray(text) ? text : [text]
    const blocks = pages.flatMap((pageText, index) => pageToBlocks(pageText, index + 1))
    return buildParseResult('pdf', blocks, { pageCount: totalPages })
  } finally {
    await releaseDocument(pdf)
  }
}
