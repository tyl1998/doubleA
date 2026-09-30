/**
 * 独立图片文件解析（P0-4-x；用户直接上传 png/jpg/…）
 *
 * 与"文档内嵌图"共用同一个产出形状 {@link ParsedImage}：一张图片就是全部内容，
 * 没有文本块（`OCR` 模式下由流水线的 OCR 阶段把它转成文字块；`MULTIMODAL` 模式下
 * 由图片分块直接向量化）。`meta.charCount` 于是为 0 —— 空文本检测必须把"有图片"
 * 也算作有效内容，否则纯图片文档会被误判为"疑似扫描件"。
 *
 * MIME 以**文件头魔数**为准（与上传前置校验同一套判据），取不到时回落扩展名。
 */

import { buildParseResult, type ParseFormat, type ParseResult, type ParsedImage } from './types.js'

/** 按魔数识别图片 MIME；识别不出时用扩展名兜底 */
export function detectImageMime(bytes: Buffer, fallbackExtension: string): string {
  const startsWith = (ascii: string): boolean =>
    bytes.subarray(0, ascii.length).toString('latin1') === ascii
  if (startsWith('\x89PNG')) return 'image/png'
  if (startsWith('\xff\xd8\xff')) return 'image/jpeg'
  if (startsWith('GIF8')) return 'image/gif'
  if (startsWith('BM')) return 'image/bmp'
  if (startsWith('RIFF') && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'

  const byExtension: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
  }
  return byExtension[fallbackExtension] ?? 'application/octet-stream'
}

/** 图片文件 → 解析结果（单个 {@link ParsedImage}，无文本块） */
export function parseImage(bytes: Buffer, format: ParseFormat): ParseResult {
  const image: ParsedImage = {
    data: bytes,
    mime: detectImageMime(bytes, format),
    page: null,
    headingPath: [],
    // 独立图片文件就是全部内容，锚在最前（块为 0 → 插在首位）
    anchor: 0,
  }
  return buildParseResult(format, [], { images: [image] })
}
