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
  LEGACY_DOC_EXTENSION,
  LEGACY_DOC_HINT,
  MIME_BY_EXTENSION,
  UPLOAD_EXTENSIONS,
  type UploadExtension,
} from '@doubulea/shared'

import { parseDocx } from './docx.js'
import { parseMd } from './md.js'
import { parsePdf } from './pdf.js'
import { parseTxt } from './txt.js'
import type { ParseResult } from './types.js'

export { parseDocx, parseMd, parsePdf, parseTxt }
export * from './types.js'

/**
 * 取多少字节做文件头判定。4KB 是"够用且不浪费"的折中：
 * 最长的签名是 ZIP 的 `PK\x03\x04` + 首个条目名（`[Content_Types].xml` 出现在第 30 字节附近），
 * 4KB 之内必然看到；同时，把 100MB 的上传多留 4KB 副本的代价可以忽略。
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

/** OOXML（docx/xlsx/pptx）都是 ZIP，靠包内必须存在的 `[Content_Types].xml` 进一步确认 */
function looksLikeOoxml(head: Buffer): boolean {
  return head.includes(Buffer.from('[Content_Types].xml', 'latin1'))
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
    extensions: [],
    hint: '本系统暂不支持图片型文档，请上传可复制文本的文件',
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
    if (extension === 'docx' && !looksLikeOoxml(head)) {
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
 */
export async function parseDocument(format: UploadExtension, bytes: Buffer): Promise<ParseResult> {
  switch (format) {
    case 'pdf':
      return parsePdf(bytes)
    case 'docx':
      return parseDocx(bytes)
    case 'md':
      return parseMd(bytes)
    case 'txt':
      return parseTxt(bytes)
  }
}
