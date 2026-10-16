/**
 * 文档路由（P0-1-16 起；P0-1-17/19 在此增补）
 *
 * 依据：`docs/02-后端设计.md` §4.6（知识库文档端点表）+ `子方案/知识库流水线.md` §4-1/§七
 *
 * 本文件现有七条端点（**全部只需登录**，与知识库同口径）：
 *   `POST   /api/knowledge-bases/:id/documents`                    上传（multipart，字段名 `file`）
 *   `GET    /api/knowledge-bases/:id/documents`                    列表（分页；流水线进度的可视出口）
 *   `POST   /api/knowledge-bases/:id/documents/:docId/reupload`    覆盖重建（multipart，同上）
 *   `POST   /api/knowledge-bases/:id/documents/:docId/retry`       失败重试（无请求体）
 *   `PATCH  /api/knowledge-bases/:id/documents/:docId`             重命名（只改展示名，不碰内容）
 *   `GET    /api/knowledge-bases/:id/documents/:docId/download`    下载原始文件（**返回字节流**）
 *   `GET    /api/knowledge-bases/:id/documents/:docId/chunks`      片段预览（分页；按 `seq` 升序）
 *   `DELETE /api/knowledge-bases/:id/documents/:docId`             删除（清 chunk + 原文件）
 * 至此 `02` §4.6 的文档端点表全部落地（`search` 属 P0-1-20，已挂）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 权限与知识库同口径：**登录即可**，不是 ADMIN
 * ─────────────────────────────────────────────────────────────────────
 * `03` §25 的 `/knowledge` 权限列是「登录」，文档挂在知识库下，权限必须一致 ——
 * "能建库但不能传文档"是一种自相矛盾的能力边界。`documents` 表同样没有 owner 列。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两处与"默认值"有关的刻意选择
 * ─────────────────────────────────────────────────────────────────────
 * · **路由级 `bodyLimit`**：`app.ts` 的全局上限已收回到 JSON 的 1MB，只有两个收文件的端点
 *   （上传、覆盖重建）放宽到 `UPLOAD_BODY_LIMIT`。四道前置校验里的"大小 ≤ UPLOAD_BODY_LIMIT"
 *   就落在这里（超出 → Fastify 或 multipart 插件抛 413，错误处理保留原状态码，见 `errorHandler.ts`）。
 * · **`:docId` 用 `documentParamsSchema`**（两个 UUID），`:id`-only 的端点用知识库的 schema：
 *   用错会让 zod 因缺少另一半而 400。
 *
 * ⚠️ **覆盖重建与上传共用同一段"取文件"逻辑**（{@link readUploadedFile}）：两边的前置处理
 *    必须逐字一致，否则重建会变成绕过校验的后门（"上传拒了 `.doc`，重建却能塞进去"）。
 */

import {
  AppError,
  documentParamsSchema,
  knowledgeBaseIdParamsSchema,
  listDocumentChunksQuerySchema,
  listDocumentsQuerySchema,
  renameDocumentBodySchema,
  IMAGE_RECOGNITIONS,
  ok,
  UPLOAD_IMAGE_RECOGNIZE_FIELD,
  UPLOAD_IMAGE_VECTORIZE_FIELD,
  type DocumentImageOptions,
  type DocumentParams,
  type ImageRecognition,
  type KnowledgeBaseIdParams,
  type ListDocumentChunksQuery,
  type ListDocumentsQuery,
  type RenameDocumentBody,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import { listDocumentChunks } from '../services/chunk.service.js'
import {
  buildContentDisposition,
  deleteDocument,
  listDocuments,
  openDocumentSource,
  renameDocument,
  retryDocument,
  reuploadDocument,
  uploadDocument,
} from '../services/document.service.js'

/** 构造 413（保留 Fastify 世界的状态码：`errorHandler` 对框架错误优先用 `statusCode`） */
function fileTooLarge(fileName: string | undefined): Error {
  const error = new Error(
    `文件超过上传上限（${config.limits.uploadBodyLimitRaw}）：${fileName ?? '未命名文件'}`,
  )
  Object.assign(error, { statusCode: 413, code: 'FST_REQ_FILE_TOO_LARGE' })
  return error
}

/** 解析 multipart 里的布尔字段（`true`/`false`/`1`/`0`；缺省/空串 = `false`；非法值 400） */
function parseBoolField(raw: string | undefined, label: string): boolean {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'false' || value === '0') return false
  if (value === 'true' || value === '1') return true
  throw AppError.validation(`${label} 只能是 true / false，收到「${raw}」`)
}

/** 解析 multipart 里的识别方式字段（缺省/空 = `NONE`；非法值 400） */
function parseRecognition(raw: string | undefined): ImageRecognition {
  const value = (raw ?? '').trim().toUpperCase()
  if (value === '') return 'NONE'
  if ((IMAGE_RECOGNITIONS as readonly string[]).includes(value)) return value as ImageRecognition
  throw AppError.validation(`imageRecognize 只能是 ${IMAGE_RECOGNITIONS.join(' / ')}，收到「${raw}」`)
}

/**
 * 从 multipart 请求里取出唯一那个文件 + 图片选项（上传与覆盖重建共用，见文件头）。
 *
 * 用 `request.parts()` 逐项消费而不是 `request.file()`：图片选项字段与文件字段的**顺序**
 * 由客户端决定（前端先选选项、后放文件，curl 则相反），`request.file()` 只能拿到它之前
 * 出现的字段。逐项消费与顺序无关。
 */
async function readUploadedFile(request: FastifyRequest): Promise<{
  fileName: string
  declaredMime: string | undefined
  bytes: Buffer
} & DocumentImageOptions> {
  let file: { fileName: string; declaredMime: string | undefined; bytes: Buffer } | undefined
  let recognizeRaw: string | undefined
  let vectorizeRaw: string | undefined

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const bytes = await part.toBuffer()
      // 正常路径下 @fastify/multipart 已经抛了 413；这条是"若将来关掉 throwFileSizeLimit"的兜底
      // ⚠️ `truncated` 在**流**上（`part.file`）而不是 `MultipartFile` 本身 —— 类型里只有流有这个字段
      if (part.file.truncated) throw fileTooLarge(part.filename)
      if (file !== undefined) {
        throw AppError.validation('一次只能上传一个文件：请只保留一个待上传文件，字段名为 file')
      }
      file = { fileName: part.filename, declaredMime: part.mimetype, bytes }
      continue
    }
    if (part.fieldname === UPLOAD_IMAGE_RECOGNIZE_FIELD) recognizeRaw = String(part.value)
    else if (part.fieldname === UPLOAD_IMAGE_VECTORIZE_FIELD) vectorizeRaw = String(part.value)
  }

  if (file === undefined) {
    throw AppError.validation('没有收到文件：请用 multipart/form-data 上传，文件字段名为 file')
  }
  if (file.bytes.length === 0) {
    throw AppError.validation(`上传的文件是空的（0 字节）：${file.fileName || '未命名文件'}`)
  }
  return {
    // `fileName` 可能含路径（老式浏览器会把客户端全路径塞进来），服务层只按扩展名判定，
    // 原样存库供展示 —— 路径拼接交给前端（显示时只取 basename）
    ...file,
    imageRecognize: parseRecognition(recognizeRaw),
    imageVectorize: parseBoolField(vectorizeRaw, UPLOAD_IMAGE_VECTORIZE_FIELD),
  }
}

export function registerDocumentRoutes(app: FastifyInstance): void {
  /**
   * 上传（登录即可）。成功返回 `{ document, deduplicated }`，`document.status` 恒为 `PARSING`
   * —— 真正的解析由 P0-1-17 的 worker 异步完成（见 `document.service.ts` 文件头）。
   */
  app.post<{ Params: KnowledgeBaseIdParams }>(
    '/api/knowledge-bases/:id/documents',
    {
      preHandler: app.requireAuth,
      // 只有收文件的端点放宽到 UPLOAD_BODY_LIMIT（app.ts 的全局值是 JSON 的 1MB）
      bodyLimit: config.limits.uploadBodyLimitBytes,
      schema: { params: knowledgeBaseIdParamsSchema },
    },
    async (request) => {
      const file = await readUploadedFile(request)
      return ok(await uploadDocument({ kbId: request.params.id, ...file }))
    },
  )

  /**
   * 覆盖重建（`子方案①` §七）。成功返回 `{ document, unchanged }`。
   *
   * `unchanged: true` 表示**这一篇**的内容与库里完全一致 ⇒ 没落对象、没删 chunk、没入队
   * （`REUPLOAD_UNCHANGED_HINT` 是给界面用的同一句文案）。`false` 时文档回到 `PARSING`，
   * 旧 chunk 已清 —— 列表页应显示"更新中，暂不参与检索"。
   */
  app.post<{ Params: DocumentParams }>(
    '/api/knowledge-bases/:id/documents/:docId/reupload',
    {
      preHandler: app.requireAuth,
      bodyLimit: config.limits.uploadBodyLimitBytes,
      schema: { params: documentParamsSchema },
    },
    async (request) => {
      const file = await readUploadedFile(request)
      const result = await reuploadDocument({
        kbId: request.params.id,
        docId: request.params.docId,
        ...file,
      })
      return ok(result)
    },
  )

  /**
   * 失败重试（`子方案①` §三）：重新入队，**不做同步处理**。
   * `READY` 的文档会拿到 409（没有东西可重试），`PARSING` 放行（这是"卡住了"的恢复入口）。
   */
  app.post<{ Params: DocumentParams }>(
    '/api/knowledge-bases/:id/documents/:docId/retry',
    {
      preHandler: app.requireAuth,
      schema: { params: documentParamsSchema },
    },
    async (request) =>
      ok(
        await retryDocument({ kbId: request.params.id, docId: request.params.docId }),
      ),
  )

  /**
   * 重命名（2026-10-16，登录即可）：只改展示名（`documents.file_name`），不碰内容。
   * 扩展名必须保持不变（服务层判 400 —— 下载类型按扩展名推，内容却没变）。
   */
  app.patch<{ Params: DocumentParams; Body: RenameDocumentBody }>(
    '/api/knowledge-bases/:id/documents/:docId',
    {
      preHandler: app.requireAuth,
      schema: { params: documentParamsSchema, body: renameDocumentBodySchema },
    },
    async (request) =>
      ok(
        await renameDocument({
          kbId: request.params.id,
          docId: request.params.docId,
          fileName: request.body.fileName,
        }),
      ),
  )

  /**
   * 删除文档：DB 行 + 其 chunk（外键 CASCADE）+ S3 原文件都清掉，返回删除数量。
   * 与删库同款：**先 DB 后 S3**，S3 失败只告警（见 `document.service.ts` 的 `deleteDocument`）。
   */
  app.delete<{ Params: DocumentParams }>(
    '/api/knowledge-bases/:id/documents/:docId',
    {
      preHandler: app.requireAuth,
      schema: { params: documentParamsSchema },
    },
    async (request) =>
      ok(
        await deleteDocument({ kbId: request.params.id, docId: request.params.docId }),
      ),
  )

  /**
   * 文档列表（登录即可；`03` §4.3 的文档表格：文件名 / 状态 / chunk 数 / 更新时间 / 操作）。
   *
   * 这是流水线进度的**唯一可视出口**（前四批只能查库）：`status` + `chunkCount` + `errorMsg`
   * 就是列表页要的全部信息。两条界面规则写在 `shared`（前后端共用）：
   * · `PARSING` 必须显示 `DOCUMENT_PARSING_HINT`（"更新中，暂不参与检索"）——
   *   `§七` 的"先删后建"有一段检索空窗，不提示的话用户会以为"文档在、就是搜不到"是 bug；
   * · 能不能被检索到用 `isDocumentSearchable(status)` 判（`READY ⟺ 可检索`）。
   */
  app.get<{ Params: KnowledgeBaseIdParams; Querystring: ListDocumentsQuery }>(
    '/api/knowledge-bases/:id/documents',
    { preHandler: app.requireAuth, schema: { params: knowledgeBaseIdParamsSchema, querystring: listDocumentsQuerySchema } },
    async (request) =>
      ok(await listDocuments({ kbId: request.params.id, ...request.query })),
  )

  /**
   * 片段预览（登录即可）：按 `seq` 升序分页列出该文档的块原文（`03` §4.3 的「查看片段」）。
   *
   * 只读、不返回 `embedding`（理由见 `chunk.service.ts` 文件头）。`docId` 不属于该知识库时
   * 与其余 `:docId` 端点一致地 404 —— 避免"知道 id 就能看任何库的正文"。
   */
  app.get<{ Params: DocumentParams; Querystring: ListDocumentChunksQuery }>(
    '/api/knowledge-bases/:id/documents/:docId/chunks',
    {
      preHandler: app.requireAuth,
      schema: { params: documentParamsSchema, querystring: listDocumentChunksQuerySchema },
    },
    async (request) =>
      ok(
        await listDocumentChunks({
          kbId: request.params.id,
          docId: request.params.docId,
          ...request.query,
        }),
      ),
  )

  /**
   * 下载原始文件（登录即可；`03` §4.3 的"下载原始文件"操作）。
   *
   * ⚠️ **本仓唯一一个不返回 JSON 信封的端点**：成功时回的是**字节流**（`reply.send(stream)`），
   * 失败时**仍然**是标准信封（404/500 都是 JSON）—— 客户端要按状态码分支，而不是永远 `json()`。
   *
   * 三个头部都由服务层给：`Content-Type`（按扩展名唯一确定）、`Content-Length`（`statObject` 拿的）、
   * `Content-Disposition`（RFC 6266/5987 双写，中文名靠 `filename*`）。
   */
  app.get<{ Params: DocumentParams }>(
    '/api/knowledge-bases/:id/documents/:docId/download',
    { preHandler: app.requireAuth, schema: { params: documentParamsSchema } },
    async (request, reply) => {
      const source = await openDocumentSource({
        kbId: request.params.id,
        docId: request.params.docId,
      })
      return reply
        .header('content-type', source.contentType)
        .header('content-length', String(source.contentLength))
        .header('content-disposition', buildContentDisposition(source.fileName))
        .send(source.body)
    },
  )
}
