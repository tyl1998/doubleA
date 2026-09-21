/**
 * 文档路由（P0-1-16；P0-1-17/19/21 在此增补）
 *
 * 依据：`docs/02-后端设计.md` §4.6（知识库文档端点表）+ `子方案/知识库流水线.md` §4-1/§七
 *
 * 本批只落**上传**一个端点：
 *   `POST /api/knowledge-bases/:id/documents`   multipart（字段名 `file`），触发异步流水线
 * 其余端点按计划分批：`reupload` / `retry` / `delete` 属 P0-1-19，`GET` 列表与 `download`
 * 属 P0-1-21，`search` 属 P0-1-20。**不提前实现**：它们各自要依赖的队列/检索/文件流
 * 都还没到位，先写出来只能是一份猜的契约。
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
 * · **路由级 `bodyLimit`**：`app.ts` 的全局上限已收回到 JSON 的 1MB，只有上传路由放宽到
 *   `UPLOAD_BODY_LIMIT`。四道前置校验里的"大小 ≤ UPLOAD_BODY_LIMIT"就落在这里
 *   （超出 → Fastify 或 multipart 插件抛 413，错误处理保留原状态码，见 `errorHandler.ts`）。
 * · **`schema.params` 用知识库的 id schema**（不是文档的 `documentParamsSchema`）：
 *   本端点只有 `:id`，用两段式的 schema 会让 zod 因缺少 `docId` 而 400。
 */

import {
  AppError,
  knowledgeBaseIdParamsSchema,
  ok,
  type KnowledgeBaseIdParams,
} from '@doubulea/shared'
import type { FastifyInstance } from 'fastify'

import { config } from '../config.js'
import { uploadDocument } from '../services/document.service.js'

/** 构造 413（保留 Fastify 世界的状态码：`errorHandler` 对框架错误优先用 `statusCode`） */
function fileTooLarge(fileName: string | undefined): Error {
  const error = new Error(
    `文件超过上传上限（${config.limits.uploadBodyLimitRaw}）：${fileName ?? '未命名文件'}`,
  )
  Object.assign(error, { statusCode: 413, code: 'FST_REQ_FILE_TOO_LARGE' })
  return error
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
      // 只有这一个端点放宽到 UPLOAD_BODY_LIMIT（app.ts 的全局值是 JSON 的 1MB）
      bodyLimit: config.limits.uploadBodyLimitBytes,
      schema: { params: knowledgeBaseIdParamsSchema },
    },
    async (request) => {
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

      const result = await uploadDocument({
        kbId: request.params.id,
        // `filename` 可能含路径（老式浏览器会把客户端全路径塞进来），服务层只按扩展名判定，
        // 原样存库供展示 —— 路径拼接交给前端（显示时只取 basename）
        fileName: file.filename,
        declaredMime: file.mimetype,
        bytes,
      })
      return ok(result)
    },
  )
}
