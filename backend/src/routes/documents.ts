/**
 * 文档路由（P0-1-16 起；P0-1-17/19 在此增补）
 *
 * 依据：`docs/02-后端设计.md` §4.6（知识库文档端点表）+ `子方案/知识库流水线.md` §4-1/§七
 *
 * 本文件现有四条端点（**全部只需登录**，与知识库同口径）：
 *   `POST   /api/knowledge-bases/:id/documents`                    上传（multipart，字段名 `file`）
 *   `POST   /api/knowledge-bases/:id/documents/:docId/reupload`    覆盖重建（multipart，同上）
 *   `POST   /api/knowledge-bases/:id/documents/:docId/retry`       失败重试（无请求体）
 *   `DELETE /api/knowledge-bases/:id/documents/:docId`             删除（清 chunk + 原文件）
 * 其余端点按计划分批：`GET` 列表与 `download` 属 P0-1-21，`search` 属 P0-1-20。
 * **不提前实现**：列表要分页三态口径、下载要流式与 `Content-Disposition`，猜出来的契约会先错一遍。
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
  ok,
  type DocumentParams,
  type KnowledgeBaseIdParams,
} from '@doubulea/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { config } from '../config.js'
import {
  deleteDocument,
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

/** 从 multipart 请求里取出唯一那个文件（上传与覆盖重建共用，见文件头） */
async function readUploadedFile(request: FastifyRequest): Promise<{
  fileName: string
  declaredMime: string | undefined
  bytes: Buffer
}> {
  const file = await request.file()
  if (file === undefined) {
    throw AppError.validation('没有收到文件：请用 multipart/form-data 上传，文件字段名为 file')
  }
  if (file.file.truncated) {
    // 正常路径下 @fastify/multipart 已经抛了 413；这条是"若将来关掉 throwFileSizeLimit"的兜底
    // ⚠️ `truncated` 在**流**上（`file.file`）而不是 `MultipartFile` 本身 —— 类型里只有流有这个字段
    throw fileTooLarge(file.filename)
  }

  const bytes = await file.toBuffer()
  if (bytes.length === 0) {
    throw AppError.validation(`上传的文件是空的（0 字节）：${file.filename || '未命名文件'}`)
  }
  return {
    // `filename` 可能含路径（老式浏览器会把客户端全路径塞进来），服务层只按扩展名判定，
    // 原样存库供展示 —— 路径拼接交给前端（显示时只取 basename）
    fileName: file.filename,
    declaredMime: file.mimetype,
    bytes,
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
}
