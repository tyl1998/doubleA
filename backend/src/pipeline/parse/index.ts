/**
 * 文件格式判定 + 解析分发（P0-1-16）
 *
 * 依据：`docs/02-后端设计.md` §4.6（上传端点）+ `子方案/知识库流水线.md` §4-1（四格式与
 *      「上传前置校验」四道）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 「前置校验」到底校验什么：扩展名、声明 MIME、**文件头**
 * ─────────────────────────────────────────────────────────────────────
 * §4-1 列的四道是：① 扩展名白名单 ② `.doc` 直接拒绝并提示 ③ MIME 与扩展名交叉校验
 * ④ 大小 ≤ `UPLOAD_BODY_LIMIT`。①②③ 都在本文件，④ 在传输层（见 `routes/documents.ts`：
 * Fastify 的 `bodyLimit` 给出 **413**，本层不重复实现"大小"这件事，只处理"流被截断"这一结果）。
 *
 * ⚠️ **本批在 ③ 之外补了"文件头魔数"这一道，原因是 ③ 单独做不到它承诺的事**：
 * MIME 由**客户端**声明，把 `a.txt` 改名成 `a.pdf` 后浏览器会老老实实声明
 * `application/pdf` —— 于是"扩展名 .pdf、MIME application/pdf"完全自洽，
 * 交叉校验一路绿灯，"改名绕过"照样进库。真正能抓住它的是**内容**：
 * PDF 必须以 `%PDF-` 开头、docx 必须是 ZIP（`PK\x03\x04`）。
 * 这一道的失败模式是**明确的**（内容不符），不是"多一层保险"而已 ——
 * 验收里"改名的假 PDF 被拦下"这一条就是盯它（只盯 MIME 的实现在这条上必红）。
 *
 * 判定顺序与理由：
 *   ① 扩展名（先看用户说的）→ ② MIME（看客户端说的）→ ③ 文件头（看文件自己是什么）
 * 先便宜后昂贵（都不昂贵，但先给"扩展名不支持"这类最可操作的错误），
 * 且三者**并列报出**而不是"有一个不合法就够"：前两道给出的是"你能改什么"（换文件/另存为），
 * 第三道给出的是"文件本身不对"（重新导出）。文案要能区分，否则用户只会反复重试同一个文件。
 *
 * ─────────────────────────────────────────────────────────────────────
 * `application/octet-stream` 一律放行（第三道里唯一的例外）
 * ─────────────────────────────────────────────────────────────────────
 * curl / 部分客户端 / 某些代理会把 MIME 报成 `application/octet-stream`（"我不知道是什么"）。
 * 它**不是**一个矛盾声明（"我确定它是 zip"才是），所以不能据此拒绝 —— 那会把
 * `curl -F "file=@x.pdf"`（不带 `;type=`）这条最基本的上传路径堵死。
 * 真正的把关交给第三道（文件头），它不依赖任何声明。
 */

import {
  AppError,
  IMAGE_UPLOAD_EXTENSIONS,
  LEGACY_DOC_EXTENSION,
  LEGACY_DOC_HINT,
  MIME_BY_EXTENSION,
  UPLOAD_EXTENSIONS,
  isImageUploadExtension,
  type UploadExtension,
} from '@doubulea/shared'

import { parseDocx } from './docx.js'
import { parseImage } from './image.js'
import { parseMd } from './md.js'
import { parsePdf } from './pdf.js'
import { parseTxt } from './txt.js'
import { DEFAULT_PARSE_OPTIONS, type ParseOptions, type ParseResult } from './types.js'

export { parseDocx, parseImage, parseMd, parsePdf, parseTxt }
export * from './types.js'

/**
 * 取多少字节做文件头判定。4KB 是"够用且不浪费"的折中：
 * 所有首字节签名都落在文件最前面几个字节内，4KB 绰绰有余；
 * 同时，把 100MB 的上传多留 4KB 副本的代价可以忽略。
 *
 * ⚠️ 注意：这只是**签名**窗口。像 `[Content_Types].xml` 这种**包内部件**的名字
 * 未必出现在头部（见 {@link looksLikeOoxml}），不能拿这 4KB 去判定"包结构"。
 */
export const HEAD_PROBE_BYTES = 4096

/** 首字节签名（"文件头"判定的全部依据） */
interface Signature {
  /** 错误文案里的展示名 */
  label: string
  test: (head: Buffer) => boolean
  /**
   * 该内容**应该**出现的扩展名（空数组 = 任何扩展名都不该是它）。
   * `docx` 在列表里是因为它本身就是 ZIP（OOXML 容器）—— 但反过来 ZIP 也可能是
   * xlsx/pptx，所以命中 ZIP 签名时还要看里面的条目（见 {@link looksLikeOoxml}）。
   */
  extensions: readonly string[]
  /** 额外提示（只在"扩展名与内容不符"时报出） */
  hint?: string
}

const startsWith = (head: Buffer, ascii: string): boolean =>
  head.subarray(0, ascii.length).toString('latin1') === ascii

/** ZIP 尾部「中央目录结束记录（EOCD）」签名 */
const ZIP_EOCD_SIGNATURE = Buffer.from('PK\x05\x06', 'latin1')
/** ZIP 每条「中央目录条目」的开头签名 */
const ZIP_CENTRAL_DIR_SIGNATURE = Buffer.from('PK\x01\x02', 'latin1')
/** `[Content_Types].xml` 是每个 OOXML 包（docx/xlsx/pptx）必备的部件 */
const OOXML_CONTENT_TYPES = '[Content_Types].xml'

/**
 * OOXML（docx/xlsx/pptx）都是 ZIP，靠包内必须存在的 `[Content_Types].xml` 进一步确认。
 *
 * ⚠️ 这里必须看**整包**，不能只看头部 4KB：很多非 Word 工具（WPS、部分导出器、
 * 某些打包实现）会把目录条目排在包开头，`[Content_Types].xml` 反而落在很后面
 * （实测合法 docx 中该名字出现在偏移 4MB 处）。只查头部会把它们误判成"改名 zip"。
 * 做法是读 ZIP 的中央目录条目名表逐个比对，不依赖任何打包顺序；万一中央目录
 * 读不出来（ZIP64 / 自解压等少见布局），再退化为在整包字节里做子串搜索。
 */
function looksLikeOoxml(bytes: Buffer): boolean {
  const names = readZipEntryNames(bytes)
  if (names !== null) return names.includes(OOXML_CONTENT_TYPES)
  return bytes.includes(Buffer.from(OOXML_CONTENT_TYPES, 'latin1'))
}

/**
 * 读取 ZIP 中央目录里的全部条目名；读不出来返回 `null` 交给调用方退化处理。
 * 只依赖 ZIP 规范里固定的结构偏移，不引入 zip 依赖（本层只关心"是不是 OOXML"）。
 */
function readZipEntryNames(bytes: Buffer): string[] | null {
  // EOCD 是 22 字节固定结构，落在文件尾部（其后是长度 ≤ 65535 的可选注释）
  if (bytes.length < 22) return null
  const eocd = bytes.lastIndexOf(ZIP_EOCD_SIGNATURE, bytes.length - 22)
  if (eocd < 0) return null

  const total = bytes.readUInt16LE(eocd + 10)
  let offset = bytes.readUInt32LE(eocd + 16)
  const names: string[] = []

  for (let i = 0; i < total; i += 1) {
    // 单条中央目录项定长头 46 字节，其后依次是文件名 / 扩展字段 / 注释
    if (offset + 46 > bytes.length) return null
    if (!bytes.subarray(offset, offset + 4).equals(ZIP_CENTRAL_DIR_SIGNATURE)) return null
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const nameStart = offset + 46
    if (nameStart + nameLength > bytes.length) return null
    names.push(bytes.subarray(nameStart, nameStart + nameLength).toString('utf8'))
    offset = nameStart + nameLength + extraLength + commentLength
  }
  return names
}

const SIGNATURES: readonly Signature[] = [
  {
    label: 'PDF 文件',
    test: (head) => startsWith(head, '%PDF-'),
    extensions: ['pdf'],
  },
  {
    // `PK\x03\x04` = 本地文件头；`PK\x05\x06` / `PK\x07\x08` = 空档/分卷（少见但合法）
    label: 'ZIP 压缩包（docx/xlsx/pptx 同族）',
    test: (head) => startsWith(head, 'PK\x03\x04') || startsWith(head, 'PK\x05\x06') || startsWith(head, 'PK\x07\x08'),
    extensions: ['docx'],
    hint: '若这是 Excel/PPT 文件，本系统不支持',
  },
  {
    label: '旧版 Word 文档（.doc，OLE2 复合文档）',
    test: (head) =>
      head.length >= 8 &&
      head[0] === 0xd0 &&
      head[1] === 0xcf &&
      head[2] === 0x11 &&
      head[3] === 0xe0 &&
      head[4] === 0xa1 &&
      head[5] === 0xb1 &&
      head[6] === 0x1a &&
      head[7] === 0xe1,
    extensions: [],
    hint: LEGACY_DOC_HINT,
  },
  {
    label: 'RTF 文档',
    test: (head) => startsWith(head, '{\\rtf'),
    extensions: [],
    hint: LEGACY_DOC_HINT,
  },
  {
    label: '图片',
    test: (head) =>
      startsWith(head, '\x89PNG') ||
      startsWith(head, '\xff\xd8\xff') ||
      startsWith(head, 'GIF8') ||
      // ⚠️ BMP 只靠 `BM` 会把"以 BM 开头的文本"（如 "BMW ..."）误判成图片 ——
      //    BMP 头的第 6~9 字节是保留字段，恒为 0，拿它把误判率压到可忽略
      (startsWith(head, 'BM') && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) ||
      (startsWith(head, 'RIFF') && head.subarray(8, 12).toString('latin1') === 'WEBP'),
    // P0-4-x：图片作为独立文件上传时合法；内容与扩展名不符（如把 png 命名为 .pdf）仍会被拦。
    // 图片容器之间不细究（png 命名为 jpg 不报错）—— 浏览器对图片 MIME 的声明本就不可靠。
    extensions: IMAGE_UPLOAD_EXTENSIONS,
  },
]

/** 扩展名（小写，无点）；没有扩展名时返回 `null` */
function extensionOf(fileName: string): string | null {
  const base = fileName.split(/[\\/]/u).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  return base.slice(dot + 1).toLowerCase()
}

function isUploadExtension(value: string): value is UploadExtension {
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(value)
}

/** 上传探测输入（`routes/documents.ts` 从 multipart 里凑齐这三样） */
export interface FormatProbeInput {
  /** 原始文件名（用户设备上的名字，已剥掉路径） */
  fileName: string
  /** 客户端声明的 MIME（`file.mimetype`；可能为空/缺失） */
  declaredMime?: string | undefined
  /** 文件内容（用于取文件头） */
  bytes: Buffer
}

/**
 * 判定格式并做三道前置校验（扩展名 / MIME / 文件头）。不合法即抛 `AppError.validation`（400）。
 *
 * @throws {AppError} `VALIDATION`(400) —— 扩展名不支持 / `.doc` / MIME 与扩展名不符 / 内容与扩展名不符
 */
export function detectFormat(input: FormatProbeInput): UploadExtension {
  const extension = extensionOf(input.fileName)
  if (extension === null) {
    throw AppError.validation(
      `无法从文件名「${input.fileName}」识别格式（缺少扩展名）。支持的格式：${UPLOAD_EXTENSIONS.join(' / ')}`,
    )
  }

  // ① `.doc` 单独拦：它要的是"另存为 .docx"这句**可操作**的提示，
  //    混进下面那句"扩展名不支持"里等于什么都没说（决策 10 的验收要点就是这句话）
  if (extension === LEGACY_DOC_EXTENSION) {
    throw AppError.validation(`暂不支持 .doc（旧版 Word 二进制格式），${LEGACY_DOC_HINT}`)
  }
  // ② 白名单
  if (!isUploadExtension(extension)) {
    throw AppError.validation(
      `不支持的文件类型 .${extension}。支持的格式：${UPLOAD_EXTENSIONS.join(' / ')}` +
        `（.doc 请${LEGACY_DOC_HINT}）`,
    )
  }

  // ③ MIME 与扩展名交叉校验（`application/octet-stream` = "未知"，放行，理由见文件头）
  const declared = (input.declaredMime ?? '').trim().toLowerCase()
  if (declared !== '' && declared !== 'application/octet-stream') {
    const allowed = MIME_BY_EXTENSION[extension]
    if (!allowed.includes(declared)) {
      throw AppError.validation(
        `Content-Type「${input.declaredMime}」与扩展名 .${extension} 不符` +
          `（.${extension} 应为 ${allowed.join(' 或 ')}）。请确认文件没有被改名，或换用正确的上传方式。`,
      )
    }
  }

  // ④ 文件头（内容）与扩展名交叉校验 —— 唯一能抓住"改名"的一道，见文件头说明
  const head = input.bytes.subarray(0, HEAD_PROBE_BYTES)
  const matched = SIGNATURES.find((signature) => signature.test(head))
  if (matched !== undefined) {
    if (!matched.extensions.includes(extension)) {
      const hint = matched.hint === undefined ? '' : `（${matched.hint}）`
      throw AppError.validation(
        `文件内容与扩展名不符：内容是「${matched.label}」，却被命名为 .${extension}${hint}。` +
          '请确认文件没有被改名，或改用正确的文件格式。',
      )
    }
    // ZIP 签名命中 .docx：再确认它真是 OOXML 包（防"任意 zip 改名成 docx"）
    if (extension === 'docx' && !looksLikeOoxml(input.bytes)) {
      throw AppError.validation(
        '文件内容与扩展名不符：这是一个不含 OOXML 结构的压缩包，不是 Word 文档（.docx）。' +
          '请确认文件没有被改名或损坏。',
      )
    }
    return extension
  }

  // 没有任何二进制签名 ⇒ 应当是纯文本：只允许 md / txt，且不能含 NUL（NUL 是二进制内容的铁证）
  if (extension !== 'md' && extension !== 'txt') {
    throw AppError.validation(
      `文件内容与扩展名不符：.${extension} 应当是二进制格式` +
        `（${extension === 'pdf' ? 'PDF 文件头必须是 %PDF-' : 'docx 必须是 ZIP/OOXML 包'}），` +
        '而该文件看起来是纯文本。请确认文件没有被改名。',
    )
  }
  if (head.includes(0)) {
    throw AppError.validation(
      `文件内容与扩展名不符：.${extension} 是文本格式，但该文件包含二进制内容（NUL 字节）。` +
        '请确认文件没有被改名。',
    )
  }
  return extension
}

/**
 * 按格式分发到具体解析器（四个解析器对外同一形状，见 `types.ts`）。
 * 这是流水线上"格式差异"的**唯一**出口：P0-1-18 之后的下游只认 {@link ParseResult}。
 *
 * `options` 决定是否抽取图片（由流水线按文档的 `imageMode` 传下来）；默认不抽，
 * 与历史行为一致。独立图片文件（png/…）本身即内容，无论 `options` 都产出该图片。
 */
export async function parseDocument(
  format: UploadExtension,
  bytes: Buffer,
  options: ParseOptions = DEFAULT_PARSE_OPTIONS,
): Promise<ParseResult> {
  switch (format) {
    case 'pdf':
      return parsePdf(bytes, options)
    case 'docx':
      return parseDocx(bytes, options)
    case 'md':
      return parseMd(bytes, options)
    case 'txt':
      return parseTxt(bytes)
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
    case 'bmp':
      return parseImage(bytes, format)
  }
}

/** 是否是独立图片文件格式（供服务层校验"图片文件必须选解析方式"） */
export function isImageFormat(format: UploadExtension): boolean {
  return isImageUploadExtension(format)
}
