/**
 * 文件附件服务（**P1-4**；`01` §3.4 需求 35「文件附件：图片多模态直读；文本类后端解析注入」）
 *
 * 依据：`02` §三 的 `files` 行、§四 的 `POST /api/files/upload`、§六 第 2 步
 *      「user = content + 附件（图片→多模态 part；文本→解析后注入）」。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件是"附件"这条链路的唯一实现（上传 / 解析 / 取内容三件事）
 * ─────────────────────────────────────────────────────────────────────
 *   ① `uploadChatFile`       —— `POST /api/files/upload`：前置校验（复用 `detectFormat` 的
 *      扩展名+MIME+魔数三道）→ 落 S3 → 建 `files` 行 → 返回 `AttachmentItem`；
 *   ② `resolveChatAttachments` —— 发消息闸门调用：按 id 取行（**必须是本人的**）+ 取对象字节，
 *      图片转 base64、文本类走 `parseDocument` 解析出正文 ⇒ 交给编排层；
 *   ③ `openFileSource`       —— `GET /api/files/:id/content`：把对象流回给客户端（渲染图片用）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三条契约判断（都不是"顺手这么写"）
 * ─────────────────────────────────────────────────────────────────────
 * ① **类型由扩展名判定一次，存进 `kind` 列**（`IMAGE` / `DOCUMENT`）：渲染器（前端）与
 *    "多模态 vs 文本注入"（后端）两处都读它，**不许任何一处自己看扩展名** —— 与
 *    `previewKindOf` 同一条纪律（判据只有一处，避免"前端当图片渲染、后端却按文本注入"的分叉）。
 * ② **`mime` 以服务端按扩展名定的那一个为准**（不是客户端声明的）：它是取内容端点的
 *    `Content-Type` 的唯一来源，与 `artifacts.mime` 同款。客户端声明只用来做第三道校验。
 * ③ **文本类解析在发消息时做，不在上传时做**：上传只落对象、不解析 —— 否则"传一个 50MB 的
 *    PDF 却从没发出去"会白跑一次解析，而上传端点要的是快。解析失败的后果是那一次发送 400
 *    （用户在发送时立刻知道，而不是上传时被一个与他此刻动作无关的错误拦住）。
 */

import { randomUUID } from 'node:crypto'

import {
  AppError,
  attachmentItemSchema,
  MIME_BY_CHAT_ATTACHMENT_EXTENSION,
  isImageUploadExtension,
  type AttachmentItem,
  type ChatAttachmentExtension,
  type ChatAttachmentKind,
  type UploadExtension,
} from '@doubulea/shared'
import { z } from 'zod'

import { config } from '../config.js'
import { getLogger } from '../infra/logger.js'
import { getPrisma } from '../infra/prisma.js'
import { ensureBucket, getS3Client, isS3NoSuchKey } from '../infra/s3.js'
import {
  CHAT_ATTACHMENT_FORMAT_PROFILE,
  DEFAULT_PARSE_OPTIONS,
  detectFormat,
  parseDocument,
} from '../pipeline/parse/index.js'

/** 对话附件里**直接按 UTF-8 当文本**的格式（P1-4 补：json / csv 无结构解析，原文即内容） */
const PLAIN_TEXT_ATTACHMENT_EXTENSIONS = new Set<ChatAttachmentExtension>(['json', 'csv'])

/**
 * 一个附件**解析之后**的形态（交给编排层）。
 *
 * 两个可选载荷**按 `kind` 二选一**：`IMAGE` 带 `dataBase64`（多模态 part），
 * `DOCUMENT` 带 `text`（解析出的正文，注入到用户消息里）。
 */
export interface ChatAttachmentContext {
  fileId: string
  name: string
  size: number
  mime: string
  kind: ChatAttachmentKind
  /** 图片专属：base64（不含 `data:` 前缀；拼前缀是协议层的事） */
  dataBase64?: string
  /** 文本类专属：解析出的正文（已按上限截断） */
  text?: string
}

/** 给模型看的单篇附件正文上限（字符，按码点算）—— 与工具结果封顶同一条纪律：不设界会撑爆上下文 */
export const ATTACHMENT_TEXT_MAX_CHARS = 20_000

/** 截断标记（与工具结果同款：说清"接下来该怎么办"，而不只是"已截断"） */
export const ATTACHMENT_TEXT_TRUNCATED_MARK = '\n\n…（附件内容过长，已截断；以上是不完整的内容）'

/** 由原始文件名的扩展名取格式（上传时 `detectFormat` 已校验过，这里只在解析时回读） */
function formatOf(fileName: string): ChatAttachmentExtension {
  const base = fileName.split(/[\\/]/u).pop() ?? fileName
  const dot = base.lastIndexOf('.')
  const ext = dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
  return ext as ChatAttachmentExtension
}

/** 服务端按扩展名定的规范 MIME（`MIME_BY_CHAT_ATTACHMENT_EXTENSION` 的第一项就是规范值） */
function canonicalMime(format: ChatAttachmentExtension): string {
  return MIME_BY_CHAT_ATTACHMENT_EXTENSION[format][0] ?? 'application/octet-stream'
}

/** 按**码点**截断（`String.prototype.slice` 会劈代理对，见 `chatContext.ts#truncateChars` 同款） */
function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text
  return [...text].slice(0, max).join('')
}

/** 把 minio 的可读流收成 Buffer（解析 / base64 都需要完整字节） */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    const value: unknown = chunk
    if (Buffer.isBuffer(value)) chunks.push(value)
    else if (typeof value === 'string') chunks.push(Buffer.from(value))
    else if (value instanceof Uint8Array) chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * 上传一个对话附件（`POST /api/files/upload`）。
 *
 * 前置校验**整段复用** `pipeline/parse` 的 `detectFormat`（扩展名白名单 / `.doc` 明确拒绝 /
 * MIME 与扩展名交叉校验 / 文件头魔数）—— 附件与知识库文档是同一套"格式知识"，
 * 各写一遍必然漂移（`.doc` 被文档端点拒了、却能被附件端点收下）。
 *
 * @throws {AppError} `VALIDATION`(400) 格式不合法（含 `.doc`）/ 空文件
 */
export async function uploadChatFile(input: {
  uploaderId: string
  fileName: string
  declaredMime: string | undefined
  bytes: Buffer
}): Promise<AttachmentItem> {
  const format = detectFormat(
    { fileName: input.fileName, declaredMime: input.declaredMime, bytes: input.bytes },
    // 附件用**自己的**格式画像：额外放行 json / csv（纯文本），不动知识库文档的白名单
    CHAT_ATTACHMENT_FORMAT_PROFILE,
  )
  const kind: ChatAttachmentKind = isImageUploadExtension(format) ? 'IMAGE' : 'DOCUMENT'
  const mime = canonicalMime(format)
  const name = input.fileName || `attachment.${format}`
  const fileKey = `files/${input.uploaderId}/${randomUUID()}/source.${format}`

  await ensureBucket()
  const s3 = getS3Client()
  try {
    await s3.putObject(config.s3.bucket, fileKey, input.bytes, input.bytes.length)
  } catch (error) {
    getLogger().error({ err: error, fileKey }, '附件写入 S3 失败，已中止上传（未建行）')
    throw AppError.upstreamError('附件写入对象存储失败，请稍后重试')
  }

  const row = await getPrisma().file.create({
    data: {
      uploaderId: input.uploaderId,
      fileKey,
      name,
      size: input.bytes.length,
      mime,
      kind,
      // JS 侧显式写入（与 artifacts 同：本机 PG 会话时区非 UTC 时 `@default(now())` 会偏一个时区）
      createdAt: new Date(),
    },
    select: { id: true },
  })

  return { fileId: row.id, name, size: input.bytes.length, mime, kind }
}

/**
 * 按 id 解析本轮附件（发消息闸门调用）。
 *
 * 三条口径：
 *   · **归属是硬判据**：多一个 id、少一个 id 都 404（不是 403）—— 别人的附件对调用者
 *     与"不存在"同形，与会话族完全一致（`shared/src/conversation.ts` 文件头 ①）；
 *   · **顺序按请求里的 `fileIds`**（不是库里的顺序）：用户选附件的先后就是界面上的顺序；
 *   · **解析失败即 400**（文本类解析出 0 字符）：让用户在发送时立刻知道，而不是模型收到一段空内容。
 *
 * @throws {AppError} `NOT_FOUND`(404) 附件不存在或不属于调用者 / `VALIDATION`(400) 解析不出文本
 */
export async function resolveChatAttachments(
  fileIds: readonly string[],
  uploaderId: string,
  options: {
    /**
     * 是否把**文本类附件的原始字节**也带进上下文（base64）。
     *
     * 默认 `false`：对话链路只需要解析后的正文，base64 纯属内存浪费。
     * TaskAgent 传 `true` —— 它要**把原文件写进沙箱容器**（`/work/attachments/`）供引擎用工具处理
     * （含图片：引擎没有多模态通道，但文件本身能让 agent 用代码去处理）。
     */
    documentBytes?: boolean
  } = {},
): Promise<ChatAttachmentContext[]> {
  if (fileIds.length === 0) return []
  const db = getPrisma()
  const rows = await db.file.findMany({
    where: { id: { in: [...fileIds] }, uploaderId },
    select: { id: true, fileKey: true, name: true, size: true, mime: true, kind: true },
  })
  if (rows.length !== fileIds.length) {
    throw AppError.notFound('有附件不存在或不属于你（请重新上传后再发送）')
  }
  const byId = new Map(rows.map((row) => [row.id, row]))
  const s3 = getS3Client()
  const contexts: ChatAttachmentContext[] = []

  for (const fileId of fileIds) {
    const row = byId.get(fileId)
    if (row === undefined) throw AppError.notFound('有附件不存在或不属于你（请重新上传后再发送）')
    let bytes: Buffer
    try {
      const stat = await s3.statObject(config.s3.bucket, row.fileKey)
      bytes = await streamToBuffer(await s3.getObject(config.s3.bucket, row.fileKey))
      // `stat` 只用来提前判"对象还在不在"（getObject 对缺失键不在 await 时抛错，见 openFileSource）
      void stat
    } catch (error) {
      if (isS3NoSuchKey(error)) {
        throw AppError.notFound(`附件「${row.name}」已不在存储中，请重新上传`)
      }
      getLogger().error({ err: error, fileId, fileKey: row.fileKey }, '读取附件对象失败')
      throw AppError.upstreamError('读取附件失败，请稍后重试')
    }

    if (row.kind === 'IMAGE') {
      contexts.push({
        fileId: row.id,
        name: row.name,
        size: row.size,
        mime: row.mime,
        kind: 'IMAGE',
        dataBase64: bytes.toString('base64'),
      })
      continue
    }

    const format = formatOf(row.name)
    let rawText: string
    if (PLAIN_TEXT_ATTACHMENT_EXTENSIONS.has(format)) {
      // json / csv：无结构解析，原文即内容（上传时的三道校验已挡掉二进制改名）
      rawText = bytes.toString('utf8')
      if (rawText.trim() === '') {
        throw AppError.validation(`附件「${row.name}」是空文件，没有可读取的内容`)
      }
    } else {
      const parsed = await parseDocument(format as UploadExtension, bytes, DEFAULT_PARSE_OPTIONS)
      if (parsed.meta.charCount === 0) {
        throw AppError.validation(`附件「${row.name}」里没有可读取的文字内容（可能是扫描件或空文件）`)
      }
      rawText = parsed.text
    }
    const text =
      rawText.length <= ATTACHMENT_TEXT_MAX_CHARS
        ? rawText
        : `${truncateChars(rawText, ATTACHMENT_TEXT_MAX_CHARS - ATTACHMENT_TEXT_TRUNCATED_MARK.length)}${ATTACHMENT_TEXT_TRUNCATED_MARK}`
    contexts.push({
      fileId: row.id,
      name: row.name,
      size: row.size,
      mime: row.mime,
      kind: 'DOCUMENT',
      text,
      // 仅 TaskAgent 需要（写进容器）；对话链路不必为此背一份 base64
      ...(options.documentBytes === true ? { dataBase64: bytes.toString('base64') } : {}),
    })
  }

  return contexts
}

/** {@link openFileSource} 的产物：字节流 + 三个响应头（由路由层组装） */
export interface FileSource {
  body: NodeJS.ReadableStream
  contentType: string
  contentLength: number
  fileName: string
}

/**
 * 取一个附件的字节流（`GET /api/files/:id/content`，渲染图片用）。
 *
 * ⚠️ **先 `statObject` 再 `getObject`**（与 `document.service.ts#openDocumentSource` 同款）：
 * `getObject` 对不存在的键**不在 `await` 时抛错**（错误发生在读流时）⇒ 只调它的话响应头已经发出，
 * 客户端看到的是"下到一半断了"。先 `stat` 才能在发头前干净地回 404。
 *
 * @throws {AppError} `NOT_FOUND`(404) 附件不存在 / 不属于调用者 / 对象已丢失
 */
export async function openFileSource(params: { fileId: string; uploaderId: string }): Promise<FileSource> {
  const db = getPrisma()
  const row = await db.file.findFirst({
    where: { id: params.fileId, uploaderId: params.uploaderId },
    select: { fileKey: true, name: true, mime: true },
  })
  if (row === null) throw AppError.notFound('附件不存在')

  const s3 = getS3Client()
  let size: number
  try {
    const stat = await s3.statObject(config.s3.bucket, row.fileKey)
    size = stat.size
  } catch (error) {
    if (isS3NoSuchKey(error)) throw AppError.notFound('附件文件已不在存储中，请重新上传')
    getLogger().error({ err: error, fileId: params.fileId, fileKey: row.fileKey }, '读取附件元数据失败')
    throw AppError.upstreamError('读取附件失败，请稍后重试')
  }

  const body = await s3.getObject(config.s3.bucket, row.fileKey)
  // 文本类型补 `charset=utf-8`（与文档下载同款；图片/PDF 不加）
  const contentType = row.mime.startsWith('text/') ? `${row.mime}; charset=utf-8` : row.mime
  return { body, contentType, contentLength: size, fileName: row.name }
}

/**
 * 列出某会话里**用户上传过的全部附件**（按消息时间先后、按 `fileId` 去重）。
 *
 * 依据：附件本体一直存在 S3（`files` 表 + 对象），只是**容器是易失的** —— 沙箱重建后
 * `/work/attachments/` 被清空，而 `messages.content.attachments[]` 里仍记着"这个会话收到过
 * 哪些文件"。本函数就是这条**从 DB 反推附件清单**的读取端（与 `MemoryDocArtifact` 同一条原则：
 * 记忆内容随时可从 DB 推导 ⇒ 不挑时机、不存状态）。
 *
 * 只读 USER 消息（`attachmentItemSchema` 只在 USER 消息上落库，见 `shared/conversation.ts`）；
 * `content` 是跨版本读的 jsonb，坏段（形状对不上）**跳过而不是整份失败**（与
 * `chatContext.ts#textOfHistoryRow` 的兜底同口径）。
 */
export async function listConversationAttachments(conversationId: string): Promise<AttachmentItem[]> {
  const rows = await getPrisma().message.findMany({
    where: { conversationId, role: 'USER' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { content: true },
  })
  const seen = new Set<string>()
  const items: AttachmentItem[] = []
  for (const row of rows) {
    const raw = (row.content as { attachments?: unknown } | null)?.attachments
    const parsed = z.array(attachmentItemSchema).safeParse(raw)
    if (!parsed.success) continue
    for (const item of parsed.data) {
      if (seen.has(item.fileId)) continue
      seen.add(item.fileId)
      items.push(item)
    }
  }
  return items
}

/**
 * 取一个附件的字节流，**按会话归属**（`GET /api/sandbox/attachments/:fileId`，容器按需自取用）。
 *
 * 判据两层（与 `openArtifactSourceForConversation` 同族）：
 *   · 该 `fileId` 必须**真的出现在这个会话的消息里**（`listConversationAttachments` 一次判完）
 *     —— 容器经令牌自证身份后，只能取回**自己这个会话**收到过的附件，取不到别的会话的；
 *   · 再叠加 `files.uploader_id = 调用者`（`openFileSource` 内部判）—— 与公网端点同一口径。
 *
 * 为什么不给 `files` 表加 `conversation_id`：附件在**上传时**还没有会话（先传后发），
 * 归属的真相源是"它被挂在哪条消息上" —— 消息才是那个事实，加列只会多一份会漂移的副本。
 *
 * @throws {AppError} `NOT_FOUND`(404) 附件不存在 / 不属于这个会话 / 不属于调用者 / 对象已丢失
 */
export async function openFileSourceForConversation(params: {
  fileId: string
  conversationId: string
  uploaderId: string
}): Promise<FileSource> {
  const items = await listConversationAttachments(params.conversationId)
  if (!items.some((item) => item.fileId === params.fileId)) {
    throw AppError.notFound('附件不存在或不属于这个会话')
  }
  return openFileSource({ fileId: params.fileId, uploaderId: params.uploaderId })
}
