/**
 * 文件附件路由（**P1-4**）
 *
 * 依据：`02` §四（`POST /api/files/upload` → 附件）、§三 的 `files` 行、`01` §3.4 需求 35。
 *
 * 两条端点（**都是登录即可，但取内容仍是"仅本人"**）：
 *   `POST /api/files/upload`        上传附件（multipart，字段名 `file`）→ `AttachmentItem`
 *   `GET  /api/files/:id/content`   取附件字节流（渲染图片用）
 *
 * ─────────────────────────────────────────────────────────────────────
 * 两处与文档上传/下载**刻意不同**
 * ─────────────────────────────────────────────────────────────────────
 * · 上传响应是**富形状**（`{fileId, name, size, mime, kind}`）而不是 `02` 草稿里的 `{fileId, url}`：
 *   前端要拿 `kind` 选渲染器、拿 `name`/`size` 画文件条，而"url"在本仓不是一个稳定契约
 *   （取内容是**带归属校验的代理端点**，不是签名 URL —— 与产物预览同款判断）。
 * · 取内容是**仅本人**（`files.uploader_id = 调用者`）：与会话/产物同族。附件挂在**我的**会话的
 *   消息上，别人既看不到会话也不该取到里面的文件。
 *
 * 「每批手改一次」的标识在 `src/index.ts` 的启动信封 `step`，别忘了同步。
 */

import { appMsg, AppError, attachmentItemSchema, fileIdParamsSchema, ok, UPLOAD_FILE_FIELD } from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { config } from '../config.js'
import { requireAuthContext } from '../plugins/session.js'
import { buildContentDisposition } from '../services/document.service.js'
import { openFileSource, uploadChatFile } from '../services/file.service.js'

/** 构造 413（保留 Fastify 世界的状态码，与文档上传同款） */
function fileTooLarge(fileName: string | undefined): Error {
  const error = new Error(`文件超过上传上限（${config.limits.uploadBodyLimitRaw}）：${fileName ?? '未命名文件'}`)
  Object.assign(error, { statusCode: 413, code: 'FST_REQ_FILE_TOO_LARGE' })
  return error
}

export function registerFileRoutes(app: FastifyInstance): void {
  /**
   * 上传一个对话附件（登录即可）。成功返回 `AttachmentItem`。
   *
   * 字段名 `file`（与知识库文档上传`共用`UPLOAD_FILE_FIELD`）：附件只有**一个**文件字段、
   * 多文件按 413 处理（multipart 插件的 `files: 1`）—— 与"一次最多 5 个附件"不矛盾：
   * 那是**发送时**携带的 id 个数，上传仍是**一个一个传**（前端逐个调本端点）。
   */
  app.post(
    '/api/files/upload',
    {
      preHandler: app.requireAuth,
      bodyLimit: config.limits.uploadBodyLimitBytes,
    },
    async (request) => {
      const viewer = requireAuthContext(request)
      let file: { fileName: string; declaredMime: string | undefined; bytes: Buffer } | undefined
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue
        const bytes = await part.toBuffer()
        if (part.file.truncated) throw fileTooLarge(part.filename)
        if (file !== undefined) {
          throw AppError.validation(appMsg('app.m101', { p0: UPLOAD_FILE_FIELD }))
        }
        file = { fileName: part.filename, declaredMime: part.mimetype, bytes }
      }
      if (file === undefined) {
        throw AppError.validation(appMsg('app.m020', { p0: UPLOAD_FILE_FIELD }))
      }
      if (file.bytes.length === 0) {
        throw AppError.validation(appMsg('app.m010', { p0: file.fileName || '未命名文件' }))
      }
      const item = await uploadChatFile({ uploaderId: viewer.user.id, ...file })
      // 响应体在本路由**再校验一次**（与其余路由"响应也过 schema"的口径一致）
      return ok(attachmentItemSchema.parse(item))
    },
  )

  /**
   * 取附件字节流（渲染图片用；**仅本人**）。
   *
   * ⚠️ **本仓又一条不套 JSON 信封的端点**（成功是字节流、失败才是信封）—— 客户端按**响应形状**
   * 分支，不能永远 `json()`。响应头由服务层给：`Content-Type`（按 `files.mime` 一处定）、
   * `Content-Length`（`statObject` 拿的）、`Content-Disposition: inline`（附件是**内联渲染**，
   * 不是下载出口）。
   */
  app.get<{ Params: { id: string } }>(
    '/api/files/:id/content',
    { preHandler: app.requireAuth, schema: { params: fileIdParamsSchema } },
    async (request, reply) => {
      const viewer = requireAuthContext(request)
      const source = await openFileSource({ fileId: request.params.id, uploaderId: viewer.user.id })
      return reply
        .header('content-type', source.contentType)
        .header('content-length', String(source.contentLength))
        .header('content-disposition', buildContentDisposition(source.fileName, { disposition: 'inline' }))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(source.body)
    },
  )
}
